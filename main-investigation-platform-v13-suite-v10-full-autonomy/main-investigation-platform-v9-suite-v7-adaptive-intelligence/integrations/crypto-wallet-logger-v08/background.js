"use strict";

importScripts("wallet-core.js", "evidence-score.js", "record-store.js", "organization-store.js", "blockchain-verifier.js", "backup.js", "main-platform-sync.js", "account-vault.js", "account-mail.js", "account-fill.js", "account-privacy.js");

const privateVault=new LoggerAccounts.Vault(chrome.storage.local);
const privateMail=new LoggerMail.Mail(privateVault);
const storageReady=Promise.all([chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}),chrome.storage.session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'})]);
function trustedAccountSender(sender){return sender.id===chrome.runtime.id&&['accounts.html','popup.html'].some(p=>sender.url===chrome.runtime.getURL(p));}
async function accountAction(message){
  await storageReady;
  const input=message.input??{};
  if(message.action==='list')return privateVault.list();
  if(message.action==='unlock')return privateVault.unlock(String(input.master??''));
  if(message.action==='lock'){privateVault.lock();return {locked:true};}
  if(message.action==='prepare')return privateVault.prepare(input);
  if(message.action==='details')return privateVault.account(input.id);
  if(message.action==='edit')return privateVault.edit(input.id,input);
  if(message.action==='mail_create')return privateMail.create(input.id);
  if(message.action==='mail_poll')return privateMail.poll(input.id);
  if(message.action==='login_completed')return privateVault.update(input.id,{status:'login completed',lastSuccessfulLogin:new Date().toISOString()});
  if(message.action==='tabs'){const a=privateVault.account(input.id),tabs=await chrome.tabs.query({});return {tabs:tabs.filter(t=>{try{return new URL(t.url).origin===a.origin;}catch{return false;}}).map(t=>({id:t.id,domain:a.domain}))};}
  if(message.action==='fill'){
    const tabs=input.tabId?[await chrome.tabs.get(Number(input.tabId))]:await chrome.tabs.query({active:true,currentWindow:true});
    if(tabs.length!==1||!tabs[0].id)throw Error('Select one active account tab.');
    const tab=await chrome.tabs.get(tabs[0].id),credentials=privateVault.credentials(input.id,tab.url);
    const result=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:loggerFillAccount,args:[credentials.origin,credentials,String(input.mode)]});
    return result.find(r=>r.frameId===0)?.result??{filled:0,reason:'Top frame unavailable.'};
  }
  throw Error('Unsupported account action.');
}
async function sanitizedCapture(message,sender,fn){await storageReady;const safe=await LoggerPrivacy.capture(privateVault,message,sender);return fn(safe.message,safe.sender);}
const STORAGE_KEY = "walletRecords";
const LOCAL_KEYS = ["walletRecords", "websiteRecords", "depositRecords", "evidenceEvents", "settings", "mainPlatformSyncQueue", "mainPlatformSyncStatus"];
const OBSERVATION_INDEX_KEY = "observationIndex";
const MAX_OBSERVATION_INDEX = 4000;
const SESSION_KEY = "walletSessionStats";
let operationQueue = Promise.resolve();
const verificationJobs = new Map();

function pageDetails(message, sender) {
  const topPageUrl = sender.tab?.url || message.page?.url || "";
  if (!/^https?:/i.test(topPageUrl)) return null;
  const isTopFrame = !sender.frameId;
  return {
    topPageUrl,
    sourcePageUrl: message.page?.url || topPageUrl,
    domain: new URL(topPageUrl).hostname,
    pageTitle: (isTopFrame ? message.page?.title : sender.tab?.title) || message.page?.title || ""
  };
}

/**
 * Per-observation bookkeeping (firstSeen/lastSeen/seenCount + last sent content fingerprint). An observation is
 * (re)queued only when its content changed, so replays of the same page view are not re-sent; identical content that
 * is sent again would carry the same envelope id anyway (Idempotency-Key) and dedupe at Main.
 */
async function recordObservations(page, wallets, now) {
  const stored = await chrome.storage.local.get([OBSERVATION_INDEX_KEY, "settings"]);
  const index = stored[OBSERVATION_INDEX_KEY] && typeof stored[OBSERVATION_INDEX_KEY] === "object" ? stored[OBSERVATION_INDEX_KEY] : {};
  const toSend = [];
  for (const incoming of wallets || []) {
    const observation = incoming?.observation;
    if (!observation || !WalletCore.FAMILIES.includes(observation.family) || !WalletCore.CONTEXT_CLASSES.includes(observation.context?.class) || !WalletCore.METHODS.includes(observation.detection?.method)) continue;
    const identified = WalletCore.identify(observation.address, { allowInvalidChecksum: true });
    if (!identified || identified.family !== observation.family) continue;
    const draft = MainPlatformSync.observationPayload(observation, page, { firstSeen: now, lastSeen: now, seenCount: 1 });
    const previous = index[draft.observationId];
    draft.firstSeen = previous?.firstSeen || now;
    draft.seenCount = (Number(previous?.seenCount) || 0) + 1;
    const fingerprint = WalletCore.observationFingerprint(draft);
    index[draft.observationId] = { firstSeen: draft.firstSeen, lastSeen: now, seenCount: draft.seenCount, fingerprint, identity: identified.identity };
    if (previous?.fingerprint !== fingerprint) toSend.push(draft);
  }
  const keys = Object.keys(index);
  if (keys.length > MAX_OBSERVATION_INDEX) {
    keys.sort((a, b) => String(index[a].lastSeen).localeCompare(String(index[b].lastSeen)));
    for (const key of keys.slice(0, keys.length - MAX_OBSERVATION_INDEX)) delete index[key];
  }
  await chrome.storage.local.set({ [OBSERVATION_INDEX_KEY]: index });
  for (const payload of toSend) await MainPlatformSync.enqueue("wallet.observation", payload);
  return toSend.length;
}

async function updateSessionStats(page, newWalletIds = []) {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const stats = stored[SESSION_KEY] || { startedAt: new Date().toISOString(), domains: {} };
  const domainStats = stats.domains[page.domain] || { pages: [], newWalletIds: [], lastScanAt: null };
  if (!domainStats.pages.includes(page.topPageUrl)) domainStats.pages.push(page.topPageUrl);
  for (const id of newWalletIds) if (!domainStats.newWalletIds.includes(id)) domainStats.newWalletIds.push(id);
  domainStats.lastScanAt = new Date().toISOString();
  stats.domains[page.domain] = domainStats;
  await chrome.storage.session.set({ [SESSION_KEY]: stats });
}

async function saveWallets(message, sender) {
  const page = pageDetails(message, sender);
  if (!page) return { saved: 0, updated: 0 };
  const now = new Date().toISOString();
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  const merged = WalletRecordStore.mergeSightings(stored[STORAGE_KEY] || [], page, message.wallets, now);
  let organization = WalletOrganizationStore.migrate(stored, merged.records, now);
  organization = WalletOrganizationStore.applyWalletSightings(organization, page, message.wallets, merged.records, now);
  await saveState({ [STORAGE_KEY]: merged.records, ...organization });
  await recordObservations(page, message.wallets, now);
  // v0.8 event types stay accepted by Main; they are only sent when explicitly enabled for older Main deployments.
  if (stored.settings?.mainPlatform?.legacyWalletEvents) {
    for (const incoming of message.wallets || []) {
      const record = merged.records.find(item => item.domain === page.domain && WalletRecordStore.normalizedAddress(item.address) === WalletRecordStore.normalizedAddress(incoming.address));
      if (!record) continue;
      const legacy = { ...incoming };
      delete legacy.observation;
      const payload = MainPlatformSync.walletEvent({ ...record, ...legacy, id: record.id, foundAt: record.foundAt, lastSeenAt: now }, page, now);
      await MainPlatformSync.enqueue("wallet.observed", payload);
      await MainPlatformSync.enqueue("evidence.added", { recordType: "wallet", recordId: record.id, domain: page.domain, sourceUrl: page.topPageUrl, pageTitle: page.pageTitle, context: incoming.context || "", evidenceItems: incoming.evidenceItems || [], evidenceTags: incoming.evidenceTags || [], detectionMethods: incoming.detectionMethods || [], confidence: incoming.confidence, timestamp: now, provenance: { sensor: "CryptoWalletLogger", passive: true } });
    }
  }
  await updateSessionStats(page, merged.newIds);
  return { saved: merged.saved, updated: merged.updated, newIds: merged.newIds };
}

async function reportScan(message, sender) {
  const page = pageDetails(message, sender);
  if (!page) return { recorded: false };
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  const organization = WalletOrganizationStore.applyPageScan(WalletOrganizationStore.migrate(stored, stored[STORAGE_KEY] || []), page);
  await saveState(organization);
  await updateSessionStats(page);
  return { recorded: true };
}

async function reportDepositInterfaces(message, sender) {
  const page = pageDetails(message, sender);
  if (!page) return { recorded: 0 };
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  const organization = WalletOrganizationStore.applyDepositInterfaces(WalletOrganizationStore.migrate(stored, stored[STORAGE_KEY] || []), page, message.interfaces || []);
  await saveState(organization);
  for (const item of message.interfaces || []) {
    const timestamp = new Date().toISOString();
    const evidence = { domain: page.domain, sourceUrl: page.topPageUrl, sourceFrameUrl: page.sourcePageUrl, pageTitle: page.pageTitle, token: item.token || "", network: item.network || "", canonicalNetwork: item.canonicalNetwork || "", wallet: item.wallet || "", contextClass: item.contextClass || "", selectedToken: item.selectedToken || "", selectedNetwork: item.selectedNetwork || "", confidence: item.confidence || "review", uncertainReason: item.uncertainReason || "", depositLabels: item.depositLabels || [], context: item.nearbyEvidence || "", evidenceItems: item.evidenceItems || [], detectionMethods: item.detectionMethods || [], qrMatch: Boolean(item.qrMatch), sectionIdentity: item.sectionIdentity || "", timestamp, provenance: { sensor: "CryptoWalletLogger", version: "0.9.0", passive: true } };
    await MainPlatformSync.enqueue("deposit_option.observed", evidence);
    await MainPlatformSync.enqueue("evidence.added", { ...evidence, recordType: "deposit_option" });
  }
  return { recorded: message.interfaces?.length || 0 };
}

function enqueue(task, sendResponse) {
  const job = runQueued(task);
  job.then(sendResponse).catch(error => sendResponse({ error: error.message }));
}

function runQueued(task) {
  const job = operationQueue.then(task);
  operationQueue = job.catch(() => undefined);
  return job;
}

/**
 * Writes organisation state without clobbering settings. Organisation snapshots carry a copy of `settings` (for custom
 * labels); writing that copy back would silently undo a settings change made meanwhile, e.g. Main's address saved on
 * the settings page while a page was being scanned, which turned sync off. Only custom labels are merged in.
 */
async function saveState(values) {
  if (values && values.settings) {
    const { settings: snapshot, ...rest } = values;
    const current = (await chrome.storage.local.get("settings")).settings || {};
    const customLabels = [...new Set([...(current.customLabels || []), ...((snapshot && snapshot.customLabels) || [])])];
    values = { ...rest, settings: { ...current, customLabels } };
  }
  await chrome.storage.local.set(values);
}

async function migrateStoredRecords() {
  return runQueued(async () => {
    const stored = await chrome.storage.local.get(LOCAL_KEYS);
    const original = stored[STORAGE_KEY] || [];
    const records = original.map(WalletRecordStore.migrateRecord);
    const organization = WalletOrganizationStore.migrate(stored, records);
    await saveState({ [STORAGE_KEY]: records, ...organization });
  });
}

async function updateAnnotation(message) {
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  const labels = WalletOrganizationStore.cleanLabels(message.labels || []);
  if (message.targetType === "wallet") {
    const records = (stored.walletRecords || []).map(WalletRecordStore.migrateRecord);
    const record = records.find(item => item.id === message.targetId);
    if (!record) throw new Error("Wallet record not found.");
    record.notes = String(message.notes || "").slice(0, 5000);
    record.labels = labels;
    const organization = WalletOrganizationStore.migrate(stored, records);
    organization.settings.customLabels = [...new Set([...(organization.settings.customLabels || []), ...labels.filter(label => !WalletOrganizationStore.BUILT_IN_LABELS.includes(label))])].slice(0, 100);
    await saveState({ walletRecords: records, ...organization });
  } else {
    const organization = WalletOrganizationStore.updateAnnotation(stored, message.targetType, message.targetId, message.notes, labels);
    await saveState(organization);
  }
  return { updated: true };
}

async function restoreBackup(message) {
  const restored = WalletBackup.validate(message.backup);
  const records = restored.walletRecords.map(WalletRecordStore.migrateRecord);
  const organization = WalletOrganizationStore.migrate(restored, records);
  await saveState({ walletRecords: records, ...organization });
  await chrome.storage.session.remove(SESSION_KEY);
  return { restored: true, wallets: records.length, websites: organization.websiteRecords.length, deposits: organization.depositRecords.length };
}

function refreshWebsiteLinks(website, wallets, deposits) {
  website.walletIds = (website.walletIds || []).filter(id => wallets.some(wallet => wallet.id === id && wallet.domain === website.domain));
  website.depositRecordIds = (website.depositRecordIds || []).filter(id => deposits.some(deposit => deposit.id === id && deposit.domain === website.domain));
  website.networks = [...new Set([
    ...wallets.filter(wallet => website.walletIds.includes(wallet.id)).map(wallet => wallet.network),
    ...deposits.filter(deposit => website.depositRecordIds.includes(deposit.id)).map(deposit => deposit.network)
  ].filter(Boolean))];
  website.tokens = [...new Set([
    ...wallets.filter(wallet => website.walletIds.includes(wallet.id)).map(wallet => WalletOrganizationStore.tokenFromNetwork(wallet.network)),
    ...deposits.filter(deposit => website.depositRecordIds.includes(deposit.id)).map(deposit => deposit.token)
  ].filter(Boolean))];
  return website;
}

async function deleteRecord(message) {
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  let wallets = (stored.walletRecords || []).map(WalletRecordStore.migrateRecord);
  let deposits = [...(stored.depositRecords || [])];
  let events = [...(stored.evidenceEvents || [])];
  let websites = [...(stored.websiteRecords || [])];

  if (message.targetType === "wallet") {
    if (!wallets.some(record => record.id === message.targetId)) throw new Error("Wallet record not found.");
    const depositIds = new Set(deposits.filter(record => record.walletId === message.targetId).map(record => record.id));
    wallets = wallets.filter(record => record.id !== message.targetId);
    deposits = deposits.filter(record => !depositIds.has(record.id));
    events = events.filter(event => event.walletId !== message.targetId && !depositIds.has(event.depositRecordId));
  } else if (message.targetType === "deposit") {
    if (!deposits.some(record => record.id === message.targetId)) throw new Error("Deposit record not found.");
    deposits = deposits.filter(record => record.id !== message.targetId);
    events = events.filter(event => event.depositRecordId !== message.targetId);
  } else {
    throw new Error("Unsupported delete target.");
  }

  websites = websites.map(website => refreshWebsiteLinks({ ...website }, wallets, deposits));
  await chrome.storage.local.set({ walletRecords: wallets, websiteRecords: websites, depositRecords: deposits, evidenceEvents: events });
  return { deleted: true };
}

async function clearAllData() {
  const empty = WalletOrganizationStore.emptyState();
  await chrome.storage.local.set({ walletRecords: [], ...empty, mainPlatformSyncQueue: [], mainPlatformSyncRejected: [], observationIndex: {}, mainPlatformSyncStatus: { state: "disabled", pending: 0 } });
  await chrome.storage.session.remove(SESSION_KEY);
  return { cleared: true };
}

async function verifyWallet(recordId, force = false) {
  if (verificationJobs.has(recordId)) return verificationJobs.get(recordId);
  const job = (async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const record = (stored[STORAGE_KEY] || []).find(item => item.id === recordId);
    if (!record) throw new Error("Wallet record not found.");
    if (!force && BlockchainVerifier.cacheFresh(record.verification)) return { verification: record.verification, cached: true };

    const verification = await BlockchainVerifier.verify(record);
    await runQueued(async () => {
      const latest = await chrome.storage.local.get(STORAGE_KEY);
      const records = (latest[STORAGE_KEY] || []).map(WalletRecordStore.migrateRecord);
      const index = records.findIndex(item => item.id === recordId);
      if (index < 0) return;
      records[index].verification = verification;
      records[index].evidenceRating = WalletEvidenceScore.calculate(records[index]);
      await chrome.storage.local.set({ [STORAGE_KEY]: records });
    });
    return { verification, cached: false };
  })().finally(() => verificationJobs.delete(recordId));
  verificationJobs.set(recordId, job);
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message?.type==='PRIVATE_ACCOUNT'){
    if(!trustedAccountSender(sender)){sendResponse({error:'Private account workspace requires a trusted extension page.'});return false;}
    enqueue(()=>accountAction(message),sendResponse);return true;
  }
  if(sender.id!==chrome.runtime.id)return false;
  if (message?.type === "SAVE_WALLETS") {
    enqueue(() => sanitizedCapture(message,sender,saveWallets), sendResponse);
    return true;
  }
  if (message?.type === "REPORT_SCAN") {
    enqueue(() => sanitizedCapture(message,sender,reportScan), sendResponse);
    return true;
  }
  if (message?.type === "REPORT_DEPOSIT_INTERFACES") {
    enqueue(() => sanitizedCapture(message,sender,reportDepositInterfaces), sendResponse);
    return true;
  }
  if (message?.type === "VERIFY_WALLET" && sender.id === chrome.runtime.id) {
    verifyWallet(message.recordId, Boolean(message.force)).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "UPDATE_ANNOTATION" && sender.id === chrome.runtime.id) {
    enqueue(async () => {const values=await privateVault.privateValues(),clean=LoggerPrivacy.sanitize(message,values);clean.notes=LoggerPrivacy.scrub(String(message.notes??'').slice(0,5000),values);return updateAnnotation(clean);}, sendResponse);
    return true;
  }
  if (message?.type === "RESTORE_BACKUP" && sender.id === chrome.runtime.id) {
    enqueue(() => restoreBackup(message), sendResponse);
    return true;
  }
  if (message?.type === "DELETE_RECORD" && sender.id === chrome.runtime.id) {
    enqueue(() => deleteRecord(message), sendResponse);
    return true;
  }
  if (message?.type === "CLEAR_ALL_DATA" && sender.id === chrome.runtime.id) {
    enqueue(clearAllData, sendResponse);
    return true;
  }
  if (message?.type === "SYNC_MAIN_PLATFORM" && sender.id === chrome.runtime.id) {
    MainPlatformSync.drain(true).then(() => sendResponse({ synced: true })).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => { migrateStoredRecords().catch(() => undefined); MainPlatformSync.drain().catch(() => undefined); });
chrome.runtime.onStartup.addListener(() => { migrateStoredRecords().catch(() => undefined); MainPlatformSync.drain().catch(() => undefined); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "mainPlatformSyncRetry") MainPlatformSync.drain().catch(() => undefined); });
