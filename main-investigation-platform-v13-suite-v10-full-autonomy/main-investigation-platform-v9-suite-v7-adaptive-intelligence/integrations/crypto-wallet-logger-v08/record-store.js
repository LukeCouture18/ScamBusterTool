(root => {
  "use strict";

  // Canonical identity normalisation (V4 contract): EVM and bech32 lowercase, base58 case preserved.
  function normalizedAddress(address) {
    const value = String(address || "").trim();
    return /^0x/i.test(value) || /^(bc1|ltc1)/i.test(value) ? value.toLowerCase() : value;
  }

  function contextRank(record) {
    if (!record?.contextClass) return -1;
    if (root.WalletCore?.contextRank) return root.WalletCore.contextRank({ class: record.contextClass, confidence: record.contextConfidence });
    return Number(record.contextConfidence) || 0;
  }

  function contextFields(wallet) {
    const observation = wallet.observation || {};
    const context = observation.context || {};
    if (!context.class && !wallet.contextClass) return {};
    return {
      family: observation.family || wallet.family || "",
      contextClass: context.class || wallet.contextClass,
      contextConfidence: Number(context.confidence ?? wallet.contextConfidence) || 0,
      contextCues: Array.isArray(context.cues) ? context.cues.slice(0, 16) : [],
      negativeCues: Array.isArray(context.negativeCues) ? context.negativeCues.slice(0, 16) : [],
      contextSection: String(context.section || "").slice(0, 240),
      detectionMethod: observation.detection?.method || wallet.evidenceSource || "",
      networkHint: observation.networkHint || null,
      formatCheck: observation.formatCheck || "",
      candidateNetworks: Array.isArray(observation.candidateNetworks) ? observation.candidateNetworks : []
    };
  }

  function recordKey(record) {
    return `${String(record.domain || "").toLowerCase()}|${normalizedAddress(record.address)}`;
  }

  function fallbackClassificationScore(network, confidence) {
    const base = { review: 100, medium: 200, high: 300 }[confidence] || 0;
    const specific = /uncertain|possible/i.test(network || "") ? 0 : 25;
    const tokenSpecific = /USDT|USDC|DAI|WBTC|LINK|UNI|SHIB/i.test(network || "") ? 10 : 0;
    return base + specific + tokenSpecific;
  }

  function withEvidenceRating(record) {
    if (!root.WalletEvidenceScore?.calculate) return record;
    return { ...record, evidenceRating: root.WalletEvidenceScore.calculate(record) };
  }

  function migrateRecord(record) {
    const foundAt = record.foundAt || new Date().toISOString();
    const pageUrls = Array.isArray(record.pageUrls) ? record.pageUrls.map(page => typeof page === "string" ? { url: page, firstSeenAt: foundAt, lastSeenAt: foundAt, seenCount: 1 } : { ...page }) : [];
    if (record.pageUrl && !pageUrls.some(page => page.url === record.pageUrl)) {
      pageUrls.push({ url: record.pageUrl, firstSeenAt: foundAt, lastSeenAt: record.lastSeenAt || foundAt, seenCount: record.seenCount || 1 });
    }
    return withEvidenceRating({
      ...record,
      seenCount: Math.max(1, Number(record.seenCount) || 1),
      pageUrls,
      lastPageUrl: record.lastPageUrl || record.pageUrl || pageUrls.at(-1)?.url || "",
      evidencePageUrl: record.evidencePageUrl || record.pageUrl || pageUrls[0]?.url || "",
      classificationScore: Number(record.classificationScore) || fallbackClassificationScore(record.network, record.confidence),
      contextScore: Number(record.contextScore) || 0,
      evidenceScore: Number(record.evidenceScore) || Number(record.contextScore) || 0,
      evidenceTags: Array.isArray(record.evidenceTags) ? record.evidenceTags : [],
      evidenceItems: Array.isArray(record.evidenceItems) ? record.evidenceItems : [],
      detectionMethods: Array.isArray(record.detectionMethods) ? record.detectionMethods : [record.evidenceSource || "legacy"],
      notes: String(record.notes || "").slice(0, 5000),
      labels: Array.isArray(record.labels) ? [...new Set(record.labels.map(String))].slice(0, 30) : [],
      sightings: Array.isArray(record.sightings) ? record.sightings : [],
      verification: record.verification || null,
      evidenceSource: record.evidenceSource || "legacy",
      foundAt,
      lastSeenAt: record.lastSeenAt || foundAt
    });
  }

  function addPageSighting(record, url, now) {
    if (!/^https?:/i.test(url || "")) return;
    const existing = record.pageUrls.find(page => page.url === url);
    if (existing) {
      existing.lastSeenAt = now;
      existing.seenCount = (Number(existing.seenCount) || 1) + 1;
    } else {
      record.pageUrls.push({ url, firstSeenAt: now, lastSeenAt: now, seenCount: 1 });
    }
  }

  function strongerEvidence(incoming, existing) {
    const incomingScore = Number(incoming.evidenceScore) || Number(incoming.contextScore) || 0;
    const existingScore = Number(existing.evidenceScore) || Number(existing.contextScore) || 0;
    if (incomingScore !== existingScore) return incomingScore > existingScore;
    const incomingContext = String(incoming.context || "");
    const existingContext = String(existing.context || "");
    if (incomingContext.length !== existingContext.length) return incomingContext.length > existingContext.length;
    const incomingEvidenceCount = (incoming.evidenceTags?.length || 0) + (incoming.evidenceItems?.length || 0);
    const existingEvidenceCount = (existing.evidenceTags?.length || 0) + (existing.evidenceItems?.length || 0);
    return incomingEvidenceCount > existingEvidenceCount;
  }

  function mergeSightings(records, page, wallets, now = new Date().toISOString(), makeId = () => crypto.randomUUID()) {
    const walletRecords = (records || []).map(migrateRecord);
    const byKey = new Map(walletRecords.map((record, index) => [recordKey(record), index]));
    const newIds = [];
    let saved = 0;
    let updated = 0;

    for (const wallet of wallets || []) {
      if (!wallet?.address || !wallet?.network) continue;
      const incomingClassificationScore = Number(wallet.classificationScore) || fallbackClassificationScore(wallet.network, wallet.confidence);
      const draft = {
        id: makeId(),
        address: wallet.address,
        domain: page.domain,
        pageUrl: page.topPageUrl,
        lastPageUrl: page.topPageUrl,
        evidencePageUrl: page.topPageUrl,
        pageUrls: [],
        pageTitle: String(page.pageTitle || "").slice(0, 300),
        network: wallet.network,
        confidence: wallet.confidence || "review",
        classificationScore: incomingClassificationScore,
        context: String(wallet.context || "").slice(0, 600),
        contextScore: Number(wallet.contextScore) || 0,
        evidenceScore: Number(wallet.evidenceScore) || Number(wallet.contextScore) || 0,
        evidenceTags: Array.isArray(wallet.evidenceTags) ? wallet.evidenceTags.slice(0, 16) : [],
        evidenceItems: Array.isArray(wallet.evidenceItems) ? wallet.evidenceItems.slice(0, 16) : [],
        detectionMethods: Array.isArray(wallet.detectionMethods) ? wallet.detectionMethods.slice(0, 12) : [wallet.evidenceSource || "page"],
        evidenceSource: wallet.evidenceSource || "page",
        foundAt: now,
        lastSeenAt: now,
        seenCount: 1,
        ...contextFields(wallet)
      };
      if (draft.contextClass) draft.contextClasses = [draft.contextClass];
      addPageSighting(draft, page.topPageUrl, now);
      if (page.sourcePageUrl !== page.topPageUrl) addPageSighting(draft, page.sourcePageUrl, now);

      const key = recordKey(draft);
      const existingIndex = byKey.get(key);
      if (existingIndex === undefined) {
        draft.evidenceRating = root.WalletEvidenceScore?.calculate?.(draft) || null;
        walletRecords.unshift(draft);
        for (const [knownKey, index] of byKey) byKey.set(knownKey, index + 1);
        byKey.set(key, 0);
        newIds.push(draft.id);
        saved += 1;
        continue;
      }

      const existing = walletRecords[existingIndex];
      existing.seenCount = (Number(existing.seenCount) || 1) + 1;
      existing.lastSeenAt = now;
      existing.lastPageUrl = page.topPageUrl;
      addPageSighting(existing, page.topPageUrl, now);
      if (page.sourcePageUrl !== page.topPageUrl) addPageSighting(existing, page.sourcePageUrl, now);

      const replaceEvidence = strongerEvidence(draft, existing);
      if (incomingClassificationScore > existing.classificationScore) {
        existing.network = draft.network;
        existing.confidence = draft.confidence;
        existing.classificationScore = incomingClassificationScore;
        existing.classificationPageUrl = page.topPageUrl;
      }
      existing.evidenceTags = [...new Set([...(existing.evidenceTags || []), ...draft.evidenceTags])].slice(0, 16);
      existing.evidenceItems = [...new Set([...(existing.evidenceItems || []), ...draft.evidenceItems])].slice(0, 16);
      existing.detectionMethods = [...new Set([...(existing.detectionMethods || []), ...draft.detectionMethods])].slice(0, 12);
      if (replaceEvidence) {
        existing.context = draft.context;
        existing.contextScore = draft.contextScore;
        existing.evidenceScore = draft.evidenceScore;
        existing.evidenceTags = [...new Set([...(existing.evidenceTags || []), ...draft.evidenceTags])].slice(0, 16);
        existing.evidenceItems = [...new Set([...(existing.evidenceItems || []), ...draft.evidenceItems])].slice(0, 16);
        existing.evidenceSource = draft.evidenceSource;
        existing.evidencePageUrl = page.topPageUrl;
      }
      if (draft.contextClass) {
        existing.contextClasses = [...new Set([...(existing.contextClasses || (existing.contextClass ? [existing.contextClass] : [])), draft.contextClass])];
        if (contextRank(draft) > contextRank(existing)) {
          for (const key of ["family", "contextClass", "contextConfidence", "contextCues", "negativeCues", "contextSection", "detectionMethod", "formatCheck", "candidateNetworks"]) existing[key] = draft[key];
          existing.contextPageUrl = page.topPageUrl;
        }
        if (draft.networkHint?.network && !existing.networkHint?.network) existing.networkHint = draft.networkHint;
        else if (!existing.networkHint && draft.networkHint) existing.networkHint = draft.networkHint;
        if (draft.formatCheck === "checksum_valid" && existing.formatCheck !== "checksum_valid" && draft.address !== existing.address) { existing.address = draft.address; existing.formatCheck = draft.formatCheck; }
      }
      if (!existing.pageTitle && draft.pageTitle) existing.pageTitle = draft.pageTitle;
      existing.evidenceRating = root.WalletEvidenceScore?.calculate?.(existing) || existing.evidenceRating || null;
      updated += 1;
    }

    return { records: walletRecords, saved, updated, newIds };
  }

  const api = { normalizedAddress, recordKey, fallbackClassificationScore, migrateRecord, mergeSightings, withEvidenceRating, contextFields };
  root.WalletRecordStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
