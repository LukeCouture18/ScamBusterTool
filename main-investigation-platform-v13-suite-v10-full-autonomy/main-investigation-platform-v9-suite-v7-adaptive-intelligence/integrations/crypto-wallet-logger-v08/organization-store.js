(root => {
  "use strict";

  const BUILT_IN_LABELS = ["NEW", "REVIEW", "VERIFIED", "IGNORE"];
  const MAX_EVENTS = 10_000;
  const MAX_SIGHTINGS_PER_WALLET = 120;

  function unique(values, limit = 100) {
    return [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, limit);
  }

  function normalizeAddress(address) {
    const value = String(address || "").trim();
    return /^0x/i.test(value) || /^(bc1|ltc1)/i.test(value) ? value.toLowerCase() : value;
  }

  function walletKey(domain, address) {
    return `${String(domain || "").toLowerCase()}|${normalizeAddress(address)}`;
  }

  function tokenFromNetwork(network = "") {
    const explicit = String(network).match(/^(USDT|USDC|DAI|WBTC|LINK|UNI|SHIB)\b/i)?.[1];
    if (explicit) return explicit.toUpperCase();
    if (/Bitcoin/i.test(network)) return "BTC";
    if (/Ethereum \(ETH\)/i.test(network)) return "ETH";
    if (/TRON/i.test(network)) return "TRX";
    if (/XRP/i.test(network)) return "XRP";
    if (/Solana/i.test(network)) return "SOL";
    if (/Litecoin/i.test(network)) return "LTC";
    if (/Dogecoin/i.test(network)) return "DOGE";
    if (/BNB/i.test(network)) return "BNB";
    return "";
  }

  function networkKey(network = "") {
    const value = String(network).toUpperCase();
    if (/TRC[- ]?20|TRON/.test(value)) return "TRC20";
    if (/ERC[- ]?20|ETHEREUM|EVM/.test(value)) return "ERC20";
    if (/BEP[- ]?20|BSC|BNB SMART/.test(value)) return "BEP20";
    if (/BITCOIN|BTC/.test(value)) return "BTC";
    if (/SOLANA|SPL/.test(value)) return "SOLANA";
    if (/XRP/.test(value)) return "XRP";
    if (/LITECOIN|LTC/.test(value)) return "LTC";
    if (/DOGECOIN|DOGE/.test(value)) return "DOGE";
    return value.replace(/[^A-Z0-9]/g, "");
  }

  function cleanLabels(labels) {
    return unique(labels, 30).map(label => label.slice(0, 32));
  }

  function emptyState(data = {}) {
    return {
      websiteRecords: Array.isArray(data.websiteRecords) ? data.websiteRecords.map(record => ({ notes: "", labels: [], pageUrls: [], walletIds: [], depositRecordIds: [], networks: [], tokens: [], ...record })) : [],
      depositRecords: Array.isArray(data.depositRecords) ? data.depositRecords.map(record => ({ notes: "", labels: [], detectionMethods: [], evidenceItems: [], evidenceTags: [], depositLabels: [], ...record })) : [],
      evidenceEvents: Array.isArray(data.evidenceEvents) ? data.evidenceEvents : [],
      settings: { customLabels: [], ...data.settings }
    };
  }

  function websiteFor(state, domain, now, makeId) {
    let website = state.websiteRecords.find(record => record.domain === domain);
    if (!website) {
      website = {
        id: makeId(), domain, pageUrls: [], walletIds: [], depositRecordIds: [], networks: [], tokens: [],
        firstSeenAt: now, lastSeenAt: now, notes: "", labels: ["NEW"]
      };
      state.websiteRecords.unshift(website);
    }
    website.lastSeenAt = now;
    return website;
  }

  function addPage(website, page, now, isDeposit = false) {
    const url = page.topPageUrl || page.url;
    if (!url) return null;
    let entry = website.pageUrls.find(item => item.url === url);
    if (!entry) {
      entry = { url, title: page.pageTitle || page.title || "", firstSeenAt: now, lastSeenAt: now, scanCount: 1, isDepositPage: Boolean(isDeposit) };
      website.pageUrls.push(entry);
    } else {
      entry.lastSeenAt = now;
      entry.scanCount = Math.max(1, Number(entry.scanCount) || 1) + 1;
      entry.isDepositPage ||= Boolean(isDeposit);
      if (!entry.title && (page.pageTitle || page.title)) entry.title = page.pageTitle || page.title;
    }
    return entry;
  }

  function eventKey(event) {
    return [event.domain, event.walletId || "", event.depositRecordId || "", event.type, event.pageUrl || "", event.value || ""].join("|");
  }

  function addEvent(state, event, now, makeId) {
    const key = eventKey(event);
    const existing = state.evidenceEvents.find(item => item.eventKey === key);
    if (existing) {
      existing.lastObservedAt = now;
      existing.occurrenceCount = (Number(existing.occurrenceCount) || 1) + 1;
      return existing;
    }
    const created = { id: makeId(), eventKey: key, timestamp: now, lastObservedAt: now, occurrenceCount: 1, ...event };
    state.evidenceEvents.push(created);
    if (state.evidenceEvents.length > MAX_EVENTS) state.evidenceEvents.splice(0, state.evidenceEvents.length - MAX_EVENTS);
    return created;
  }

  function interfaceKey(domain, pageUrl, token, network, walletId = "") {
    return [domain, pageUrl, String(token || "").toUpperCase(), networkKey(network), walletId || ""].join("|");
  }

  function depositFor(state, data, now, makeId) {
    const exactKey = interfaceKey(data.domain, data.pageUrl, data.token, data.network, data.walletId);
    let record = state.depositRecords.find(item => item.recordKey === exactKey);
    if (!record && data.walletId) {
      const emptyKey = interfaceKey(data.domain, data.pageUrl, data.token, data.network, "");
      record = state.depositRecords.find(item => item.recordKey === emptyKey && !item.walletId);
      if (record) {
        record.walletId = data.walletId;
        record.wallet = data.wallet;
        record.recordKey = exactKey;
      }
      if (!record) {
        record = state.depositRecords.find(item => item.domain === data.domain && item.pageUrl === data.pageUrl && !item.walletId && (!item.token || !data.token || item.token.toUpperCase() === data.token.toUpperCase()) && (!item.network || !data.network || networkKey(item.network) === networkKey(data.network)));
        if (record) {
          record.walletId = data.walletId;
          record.wallet = data.wallet;
          record.token ||= data.token || "";
          if (String(data.network || "").length > String(record.network || "").length) record.network = data.network;
          record.recordKey = exactKey;
        }
      }
    }
    if (!record) {
      record = {
        id: makeId(), recordKey: exactKey, domain: data.domain, pageUrl: data.pageUrl, pageTitle: data.pageTitle || "",
        token: data.token || "", network: data.network || "", walletId: data.walletId || null, wallet: data.wallet || null,
        depositLabels: [], nearbyEvidence: "", evidenceItems: [], evidenceTags: [], detectionMethods: [], qrMatch: false,
        confidence: data.confidence || "review", firstSeenAt: now, lastSeenAt: now, seenCount: 0, notes: "", labels: ["NEW"],
        interfaceId: data.interfaceId || "", selectedToken: data.selectedToken || "", selectedNetwork: data.selectedNetwork || "", uncertainReason: data.uncertainReason || ""
      };
      state.depositRecords.unshift(record);
    }
    record.lastSeenAt = now;
    record.seenCount = (Number(record.seenCount) || 0) + 1;
    if (!record.token && data.token) record.token = data.token;
    if (String(data.network || "").length > String(record.network || "").length) record.network = data.network;
    if (data.pageTitle && !record.pageTitle) record.pageTitle = data.pageTitle;
    if (data.wallet && !record.wallet) record.wallet = data.wallet;
    record.depositLabels = unique([...(record.depositLabels || []), ...(data.depositLabels || [])], 20);
    record.evidenceItems = unique([...(record.evidenceItems || []), ...(data.evidenceItems || [])], 30);
    record.evidenceTags = unique([...(record.evidenceTags || []), ...(data.evidenceTags || [])], 30);
    record.detectionMethods = unique([...(record.detectionMethods || []), ...(data.detectionMethods || [])], 20);
    record.qrMatch ||= Boolean(data.qrMatch);
    if (data.interfaceId) record.interfaceId = data.interfaceId;
    if (data.selectedToken) record.selectedToken = data.selectedToken;
    if (data.selectedNetwork) record.selectedNetwork = data.selectedNetwork;
    if (data.uncertainReason && !record.uncertainReason) record.uncertainReason = data.uncertainReason;
    if (String(data.nearbyEvidence || "").length > String(record.nearbyEvidence || "").length) record.nearbyEvidence = String(data.nearbyEvidence).slice(0, 1200);
    const confidenceRank = { review: 1, medium: 2, high: 3 };
    if ((confidenceRank[data.confidence] || 0) > (confidenceRank[record.confidence] || 0)) record.confidence = data.confidence;
    return record;
  }

  function applyPageScan(data, page, now = new Date().toISOString(), makeId = () => crypto.randomUUID()) {
    const state = emptyState(data);
    const website = websiteFor(state, page.domain, now, makeId);
    const priorPage = website.pageUrls.some(item => item.url === (page.topPageUrl || page.url));
    addPage(website, page, now, false);
    if (!priorPage) addEvent(state, { domain: page.domain, type: "PAGE_OBSERVED", label: "Page observed", pageUrl: page.topPageUrl || page.url }, now, makeId);
    return state;
  }

  function applyDepositInterfaces(data, page, interfaces, now = new Date().toISOString(), makeId = () => crypto.randomUUID()) {
    const state = emptyState(data);
    const website = websiteFor(state, page.domain, now, makeId);
    addPage(website, page, now, true);
    for (const item of interfaces || []) {
      const record = depositFor(state, {
        domain: page.domain, pageUrl: page.topPageUrl || page.url, pageTitle: page.pageTitle || "",
        token: item.token, network: item.network, depositLabels: item.depositLabels, nearbyEvidence: item.nearbyEvidence,
        evidenceItems: item.evidenceItems, evidenceTags: item.evidenceTags, detectionMethods: item.detectionMethods,
        confidence: item.confidence || "review", qrMatch: item.qrMatch,
        interfaceId: item.sectionIdentity || item.interfaceId || "", selectedToken: item.selectedToken,
        selectedNetwork: item.selectedNetwork, uncertainReason: item.uncertainReason
      }, now, makeId);
      if (!website.depositRecordIds.includes(record.id)) website.depositRecordIds.push(record.id);
      website.tokens = unique([...website.tokens, record.token]);
      website.networks = unique([...website.networks, record.network]);
      addEvent(state, { domain: page.domain, depositRecordId: record.id, type: "DEPOSIT_INTERFACE", label: "Deposit/payment section detected", pageUrl: record.pageUrl }, now, makeId);
      if (record.token) addEvent(state, { domain: page.domain, depositRecordId: record.id, type: "TOKEN_OBSERVED", label: `Selected token observed: ${record.token}`, value: record.token, pageUrl: record.pageUrl }, now, makeId);
      if (record.network) addEvent(state, { domain: page.domain, depositRecordId: record.id, type: "NETWORK_OBSERVED", label: `Selected network observed: ${record.network}`, value: record.network, pageUrl: record.pageUrl }, now, makeId);
      if (item.changedFrom) addEvent(state, { domain: page.domain, depositRecordId: record.id, type: "OPTION_CHANGED", label: "Deposit option changed", value: JSON.stringify(item.changedFrom), pageUrl: record.pageUrl }, now, makeId);
    }
    return state;
  }

  function labelsFromEvidence(items) {
    return unique((items || []).map(item => String(item).match(/^Label:\s*(.+)$/i)?.[1]).filter(Boolean), 20);
  }

  function applyWalletSightings(data, page, wallets, walletRecords, now = new Date().toISOString(), makeId = () => crypto.randomUUID()) {
    const state = emptyState(data);
    const website = websiteFor(state, page.domain, now, makeId);
    for (const incoming of wallets || []) {
      const wallet = walletRecords.find(record => walletKey(record.domain, record.address) === walletKey(page.domain, incoming.address));
      if (!wallet) continue;
      if (!website.walletIds.includes(wallet.id)) website.walletIds.push(wallet.id);
      website.networks = unique([...website.networks, incoming.network]);
      const token = tokenFromNetwork(incoming.network);
      website.tokens = unique([...website.tokens, token]);
      const methods = unique(incoming.detectionMethods?.length ? incoming.detectionMethods : [incoming.evidenceSource || "page"]);
      const qrMatch = methods.includes("deposit-qr") || (incoming.evidenceItems || []).some(item => /QR code/i.test(item));
      // v0.9: the context classifier decides; withdrawal/example/history/contract contexts never create deposit records.
      const contextClass = incoming.observation?.context?.class || incoming.contextClass || "";
      const isDeposit = contextClass ? contextClass === "deposit" : (incoming.evidenceItems || []).some(item => /deposit|payment|address|QR|copy/i.test(item)) || /deposit|payment|receiv|wallet address/i.test(incoming.context || "");
      addPage(website, page, now, isDeposit);
      const sightingKey = [page.topPageUrl, networkKey(incoming.network), token].join("|");
      wallet.sightings ||= [];
      let sighting = wallet.sightings.find(item => item.sightingKey === sightingKey);
      if (!sighting) {
        sighting = { sightingKey, pageUrl: page.topPageUrl, sourcePageUrl: page.sourcePageUrl, pageTitle: page.pageTitle || "", network: incoming.network, token, confidence: incoming.confidence, context: incoming.context || "", evidenceItems: [], evidenceTags: [], detectionMethods: [], qrMatch: false, firstSeenAt: now, lastSeenAt: now, seenCount: 0, sourceUrls: [], contextClass: "", contextConfidence: 0, detectionMethod: "" };
        wallet.sightings.unshift(sighting);
        if (wallet.sightings.length > MAX_SIGHTINGS_PER_WALLET) wallet.sightings.length = MAX_SIGHTINGS_PER_WALLET;
      }
      sighting.lastSeenAt = now;
      sighting.seenCount = (Number(sighting.seenCount) || 0) + 1;
      sighting.sourceUrls = unique([...(sighting.sourceUrls || []), page.topPageUrl, page.sourcePageUrl], 40);
      sighting.evidenceItems = unique([...(sighting.evidenceItems || []), ...(incoming.evidenceItems || [])], 30);
      sighting.evidenceTags = unique([...(sighting.evidenceTags || []), ...(incoming.evidenceTags || [])], 30);
      sighting.detectionMethods = unique([...(sighting.detectionMethods || []), ...methods], 20);
      sighting.qrMatch ||= qrMatch;
      if (contextClass && (Number(incoming.observation?.context?.confidence ?? incoming.contextConfidence) || 0) >= (Number(sighting.contextConfidence) || 0)) {
        sighting.contextClass = contextClass;
        sighting.contextConfidence = Number(incoming.observation?.context?.confidence ?? incoming.contextConfidence) || 0;
        sighting.detectionMethod = incoming.observation?.detection?.method || incoming.evidenceSource || "";
      }
      if (String(incoming.context || "").length > String(sighting.context || "").length) sighting.context = String(incoming.context).slice(0, 1200);
      if (isDeposit) {
        const deposit = depositFor(state, { domain: page.domain, pageUrl: page.topPageUrl, pageTitle: page.pageTitle, token, network: incoming.network, walletId: wallet.id, wallet: wallet.address, depositLabels: labelsFromEvidence(incoming.evidenceItems), nearbyEvidence: incoming.context, evidenceItems: incoming.evidenceItems, evidenceTags: incoming.evidenceTags, detectionMethods: methods, qrMatch, confidence: incoming.confidence, uncertainReason: incoming.uncertainReason }, now, makeId);
        if (!website.depositRecordIds.includes(deposit.id)) website.depositRecordIds.push(deposit.id);
        addEvent(state, { domain: page.domain, walletId: wallet.id, depositRecordId: deposit.id, type: "WALLET_DETECTED", label: `Wallet detected: ${wallet.address}`, value: normalizeAddress(wallet.address), pageUrl: page.topPageUrl }, now, makeId);
        if (qrMatch) addEvent(state, { domain: page.domain, walletId: wallet.id, depositRecordId: deposit.id, type: "QR_MATCH", label: "Matching wallet QR detected", value: normalizeAddress(wallet.address), pageUrl: page.topPageUrl }, now, makeId);
      } else {
        addEvent(state, { domain: page.domain, walletId: wallet.id, type: "WALLET_DETECTED", label: `Wallet detected: ${wallet.address}`, value: normalizeAddress(wallet.address), pageUrl: page.topPageUrl }, now, makeId);
      }
    }
    return state;
  }

  function updateAnnotation(data, targetType, targetId, notes, labels) {
    const state = emptyState(data);
    const collection = targetType === "website" ? state.websiteRecords : targetType === "wallet" ? data.walletRecords : state.depositRecords;
    const record = collection?.find(item => item.id === targetId);
    if (!record) throw new Error("Annotation target not found.");
    record.notes = String(notes || "").slice(0, 5000);
    record.labels = cleanLabels(labels);
    state.settings.customLabels = unique([...(state.settings.customLabels || []), ...record.labels.filter(label => !BUILT_IN_LABELS.includes(label))], 100);
    return state;
  }

  function websiteSummary(website, walletRecords, depositRecords) {
    const wallets = walletRecords.filter(record => website.walletIds.includes(record.id));
    const deposits = depositRecords.filter(record => website.depositRecordIds.includes(record.id));
    return {
      domain: website.domain,
      pagesObserved: website.pageUrls.length,
      depositPages: new Set(deposits.map(record => record.pageUrl)).size,
      wallets: wallets.length,
      highConfidence: wallets.filter(record => record.confidence === "high").length,
      needsReview: wallets.filter(record => record.confidence === "review").length,
      totalDetections: wallets.reduce((sum, record) => sum + (Number(record.seenCount) || 1), 0),
      networks: unique([...website.networks, ...wallets.map(record => record.network)]),
      tokens: unique([...website.tokens, ...deposits.map(record => record.token)])
    };
  }

  function migrate(data, walletRecords, now = new Date().toISOString(), makeId = () => crypto.randomUUID()) {
    let state = emptyState(data);
    for (const wallet of walletRecords || []) {
      const website = websiteFor(state, wallet.domain, wallet.lastSeenAt || now, makeId);
      if (!website.walletIds.includes(wallet.id)) website.walletIds.push(wallet.id);
      website.networks = unique([...website.networks, wallet.network]);
      website.tokens = unique([...website.tokens, tokenFromNetwork(wallet.network)]);
      for (const page of wallet.pageUrls || []) addPage(website, { topPageUrl: page.url, pageTitle: wallet.pageTitle }, page.lastSeenAt || wallet.lastSeenAt || now, /deposit|payment|fund/i.test(page.url));
      if (!wallet.notes) wallet.notes = "";
      if (!Array.isArray(wallet.labels)) wallet.labels = [];
      if (!Array.isArray(wallet.sightings)) wallet.sightings = [];
    }
    return state;
  }

  root.WalletOrganizationStore = { BUILT_IN_LABELS, emptyState, migrate, applyPageScan, applyDepositInterfaces, applyWalletSightings, updateAnnotation, websiteSummary, tokenFromNetwork, networkKey, walletKey, cleanLabels };
  if (typeof module !== "undefined" && module.exports) module.exports = root.WalletOrganizationStore;
})(globalThis);
