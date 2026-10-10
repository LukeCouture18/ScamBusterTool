(root => {
  "use strict";

  /*
   * Main Platform synchronisation queue (v0.9).
   *
   * Transport is unchanged from v0.8: POST <endpoint>, Idempotency-Key = envelope id, optional Bearer token, envelope
   * {id, type, schemaVersion, occurredAt, source:"CryptoWalletLogger", sourceVersion, payload}.
   *
   * v0.9 fixes:
   *  - every read-modify-write of the stored queue runs under one mutex, so an enqueue during a drain can no longer be
   *    overwritten by the drain's stale snapshot (v0.8 lost or stranded such items);
   *  - the drain is a loop that re-reads the queue after every delivery and runs again if drain() was requested while it
   *    was busy, so an item enqueued mid-drain is delivered in the same drain instead of waiting for the next enqueue;
   *  - permanently rejected events (HTTP 400/409/413/415/422) move to a capped dead-letter list instead of blocking the
   *    head of the queue forever.
   */

  const QUEUE_KEY = "mainPlatformSyncQueue";
  const STATUS_KEY = "mainPlatformSyncStatus";
  const REJECTED_KEY = "mainPlatformSyncRejected";
  const SOURCE_VERSION = "0.9.0";
  const SCHEMA_VERSIONS = { "wallet.observation": "2.0.0" };
  const PERMANENT_REJECTIONS = new Set([400, 409, 413, 415, 422]);

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  }

  async function sha256Hex(text) {
    if (root.WalletCore?.sha256Hex) return root.WalletCore.sha256Hex(text);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Envelope id: hash of type + payload without timestamps/counters, so identical replays dedupe at Main. */
  async function eventId(type, payload) {
    const comparable = { ...payload };
    delete comparable.timestamp;
    delete comparable.firstSeen;
    delete comparable.lastSeen;
    delete comparable.seenCount;
    return sha256Hex(JSON.stringify(stable({ type, payload: comparable })));
  }

  async function configuration() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings?.mainPlatform || {};
  }

  let lock = Promise.resolve();
  function withLock(task) {
    const run = lock.then(task, task);
    lock = run.catch(() => undefined);
    return run;
  }

  async function readQueue() {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  }

  async function updateStatus(values) {
    const stored = await chrome.storage.local.get(STATUS_KEY);
    await chrome.storage.local.set({ [STATUS_KEY]: { state: "offline", lastAttemptAt: null, lastSuccessAt: null, lastError: "", pending: 0, ...(stored[STATUS_KEY] || {}), ...values } });
  }

  async function enqueue(type, payload) {
    const config = await configuration();
    if (!config.enabled || !config.endpoint) return { queued: false };
    const id = await eventId(type, payload);
    const result = await withLock(async () => {
      const queue = await readQueue();
      if (queue.some(item => item.id === id)) return { queued: false, duplicate: true, id };
      queue.push({ id, type, schemaVersion: SCHEMA_VERSIONS[type] || "1.0.0", occurredAt: payload.timestamp || payload.lastSeen || new Date().toISOString(), payload, attempts: 0, nextAttemptAt: 0 });
      try { await chrome.storage.local.set({ [QUEUE_KEY]: queue }); }
      catch (error) { await updateStatus({ state: "storage_error", pending: queue.length, lastError: `Sync event could not be saved: ${error.message || error}` }); throw error; }
      return { queued: true, id };
    });
    void drain();
    return result;
  }

  let draining = null;
  let drainRequested = false;
  let forceRequested = false;

  function drain(force = false) {
    drainRequested = true;
    forceRequested ||= force;
    if (!draining) {
      draining = drainLoop().finally(() => {
        draining = null;
        if (drainRequested) void drain(); // requested between the loop's last check and this callback
      });
    }
    return draining;
  }

  async function drainLoop() {
    while (drainRequested) {
      drainRequested = false;
      const force = forceRequested;
      forceRequested = false;
      const config = await configuration();
      if (!config.enabled || !config.endpoint) { await updateStatus({ state: "disabled" }); return; }
      for (;;) {
        const queue = await withLock(readQueue);
        const now = Date.now();
        const item = queue.find(entry => force || !entry.nextAttemptAt || entry.nextAttemptAt <= now);
        if (!item) { await updateStatus({ state: queue.length ? "waiting" : "connected", pending: queue.length }); break; }
        await updateStatus({ state: "syncing", lastAttemptAt: new Date().toISOString(), pending: queue.length, lastError: "" });
        let response = null;
        let failure = null;
        try {
          response = await fetch(config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": item.id, ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify({ id: item.id, type: item.type, schemaVersion: item.schemaVersion, occurredAt: item.occurredAt, source: "CryptoWalletLogger", sourceVersion: SOURCE_VERSION, payload: item.payload })
          });
          if (!response.ok) failure = new Error(`HTTP ${response.status}`);
        } catch (error) { failure = error; }

        if (!failure || PERMANENT_REJECTIONS.has(response?.status)) {
          const remaining = await withLock(async () => {
            const latest = await readQueue();
            const next = latest.filter(entry => entry.id !== item.id);
            await chrome.storage.local.set({ [QUEUE_KEY]: next });
            if (failure) {
              const stored = await chrome.storage.local.get(REJECTED_KEY);
              const rejected = Array.isArray(stored[REJECTED_KEY]) ? stored[REJECTED_KEY] : [];
              rejected.push({ ...item, rejectedAt: new Date().toISOString(), status: response.status });
              await chrome.storage.local.set({ [REJECTED_KEY]: rejected.slice(-200) });
            }
            return next.length;
          });
          await updateStatus(failure
            ? { state: "connected", pending: remaining, lastError: `Event ${item.type} rejected by Main Platform (${failure.message}).` }
            : { state: "connected", lastSuccessAt: new Date().toISOString(), pending: remaining, lastError: "" });
          continue;
        }

        const pending = await withLock(async () => {
          const latest = await readQueue();
          const entry = latest.find(candidate => candidate.id === item.id);
          if (entry) {
            entry.attempts = (Number(entry.attempts) || 0) + 1;
            entry.nextAttemptAt = Date.now() + Math.min(30 * 60_000, 1000 * 2 ** Math.min(entry.attempts, 10));
            await chrome.storage.local.set({ [QUEUE_KEY]: latest });
            chrome.alarms?.create("mainPlatformSyncRetry", { delayInMinutes: Math.max(1, Math.ceil((entry.nextAttemptAt - Date.now()) / 60_000)) });
          }
          return latest.length;
        });
        await updateStatus({ state: "offline", pending, lastError: String(failure.message || failure).slice(0, 300) });
        return; // endpoint unreachable: stop until the retry alarm or the next enqueue
      }
    }
  }

  /** v0.8 event (kept for optional legacy compatibility; see settings.mainPlatform.legacyWalletEvents). */
  function walletEvent(wallet, page, timestamp) {
    return { walletId: wallet.id, wallet: wallet.address, domain: page.domain, sourceUrl: page.topPageUrl, sourceFrameUrl: page.sourcePageUrl, pageTitle: page.pageTitle, network: wallet.network, token: root.WalletOrganizationStore?.tokenFromNetwork(wallet.network) || "", confidence: wallet.confidence, context: wallet.context, evidenceItems: wallet.evidenceItems || [], evidenceTags: wallet.evidenceTags || [], detectionMethods: wallet.detectionMethods || [], firstSeen: wallet.foundAt, lastSeen: wallet.lastSeenAt, timestamp, provenance: { sensor: "CryptoWalletLogger", passive: true } };
  }

  /**
   * wallet.observation payload v2 (V4_CONTRACT.md §1).
   * observation: the content script's partial payload; page: {domain, topPageUrl, sourcePageUrl, pageTitle};
   * timing: {firstSeen, lastSeen, seenCount}.
   */
  function observationPayload(observation, page, timing) {
    const core = root.WalletCore;
    const context = observation.context || {};
    const detection = observation.detection || {};
    const family = observation.family;
    return {
      observationId: core.observationId(family, observation.address, page.topPageUrl, detection.method, context.class),
      address: observation.address,
      family,
      candidateNetworks: Array.isArray(observation.candidateNetworks) ? observation.candidateNetworks : [...(core.FAMILY_NETWORKS[family] || [])],
      networkHint: observation.networkHint || null,
      formatCheck: observation.formatCheck,
      context: {
        class: context.class,
        confidence: context.confidence,
        cues: context.cues || [],
        negativeCues: context.negativeCues || [],
        section: context.section || "",
        snippet: String(context.snippet || "").slice(0, 600)
      },
      detection: { method: detection.method, methods: detection.methods || [detection.method], afterInteraction: Boolean(detection.afterInteraction) },
      page: { domain: page.domain, url: page.topPageUrl, frameUrl: page.sourcePageUrl, title: page.pageTitle || "" },
      evidence: observation.evidence || {},
      firstSeen: timing.firstSeen,
      lastSeen: timing.lastSeen,
      seenCount: timing.seenCount,
      provenance: { sensor: "CryptoWalletLogger", version: SOURCE_VERSION, passive: true }
    };
  }

  const api = { enqueue, drain, walletEvent, observationPayload, eventId, QUEUE_KEY, STATUS_KEY, REJECTED_KEY, SOURCE_VERSION };
  root.MainPlatformSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
