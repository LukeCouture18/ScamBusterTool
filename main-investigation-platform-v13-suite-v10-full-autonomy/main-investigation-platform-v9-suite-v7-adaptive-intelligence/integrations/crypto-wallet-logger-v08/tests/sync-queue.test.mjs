import {createRequire} from "node:module";
const loadModule=createRequire(import.meta.url);
"use strict";
// Tests for main-platform-sync.js (queue drain + wallet.observation envelope) with an in-memory chrome.storage.
import test from "node:test";
import assert from "node:assert/strict";

function installFakeChrome(settings) {
  const data = { settings };
  const tick = () => new Promise(resolve => setTimeout(resolve, 1));
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          await tick();
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter(key => key in data).map(key => [key, JSON.parse(JSON.stringify(data[key]))]));
        },
        async set(values) { await tick(); Object.assign(data, JSON.parse(JSON.stringify(values))); }
      }
    },
    alarms: { created: [], create(name, info) { this.created.push([name, info]); } }
  };
  return data;
}

function loadSync() {
  globalThis.WalletCore = loadModule("../wallet-core.js");
  delete loadModule.cache[loadModule.resolve("../main-platform-sync.js")];
  return loadModule("../main-platform-sync.js");
}

const waitFor = async (predicate, timeout = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("item enqueued while a delivery is in flight is delivered in the same drain and never lost", async () => {
  const data = installFakeChrome({ mainPlatform: { enabled: true, endpoint: "http://capture.test/events", apiKey: "k" } });
  const sync = loadSync();
  const delivered = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!delivered.length) await firstGate; // hold the first POST open
    delivered.push({ body, headers: init.headers });
    return { ok: true, status: 200 };
  };
  await sync.enqueue("deposit_option.observed", { token: "USDT", network: "TRC20", timestamp: "2026-01-01T00:00:00Z" });
  await new Promise(resolve => setTimeout(resolve, 20)); // first POST is now in flight
  await sync.enqueue("deposit_option.observed", { token: "USDT", network: "ERC20", timestamp: "2026-01-01T00:00:01Z" });
  releaseFirst();
  await waitFor(() => delivered.length === 2 && (data.mainPlatformSyncQueue || []).length === 0);
  assert.deepEqual(delivered.map(item => item.body.payload.network), ["TRC20", "ERC20"]);
  assert.equal(delivered[0].headers["Idempotency-Key"], delivered[0].body.id);
  assert.equal(delivered[0].headers.Authorization, "Bearer k");
  assert.equal(delivered[0].body.sourceVersion, "0.9.0");
  assert.equal(delivered[0].body.schemaVersion, "1.0.0");
  await sync.drain(); // let this module instance go idle before the next test swaps globals
});

test("many concurrent enqueues: every item delivered exactly once, queue empty", async () => {
  const data = installFakeChrome({ mainPlatform: { enabled: true, endpoint: "http://capture.test/events" } });
  const sync = loadSync();
  const seen = [];
  globalThis.fetch = async (url, init) => { await new Promise(resolve => setTimeout(resolve, Math.random() * 5)); seen.push(JSON.parse(init.body).id); return { ok: true, status: 202 }; };
  await Promise.all(Array.from({ length: 25 }, (_, index) => sync.enqueue("deposit_option.observed", { index })));
  await waitFor(() => seen.length >= 25 && (data.mainPlatformSyncQueue || []).length === 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  await sync.drain();
});

test("identical replays dedupe; permanent rejections do not block the queue; offline backs off", async () => {
  const data = installFakeChrome({ mainPlatform: { enabled: true, endpoint: "http://capture.test/events" } });
  const sync = loadSync();
  const statuses = [422, 200];
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(JSON.parse(init.body).payload.n); const status = statuses.shift() ?? 200; return { ok: status < 300, status }; };
  const first = await sync.enqueue("deposit_option.observed", { n: 1 });
  const replay = await sync.enqueue("deposit_option.observed", { n: 1, timestamp: "different time" });
  assert.equal(replay.id, first.id, "timestamps do not change the envelope id");
  await sync.enqueue("deposit_option.observed", { n: 2 });
  await waitFor(() => (data.mainPlatformSyncQueue || []).length === 0 && seen.length >= 2);
  assert.deepEqual(seen.slice(0, 2), [1, 2]);
  assert.equal(data.mainPlatformSyncRejected.length, 1);

  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await sync.enqueue("deposit_option.observed", { n: 3 });
  // An observer can arrive after the drain changes offline to waiting for its
  // scheduled retry. Verify the durable failure and backoff, not a transient label.
  await new Promise(resolve => setTimeout(resolve, 100));
  await waitFor(() => data.mainPlatformSyncStatus?.lastError === "ECONNREFUSED" && data.mainPlatformSyncQueue?.[0]?.attempts === 1);
  assert.ok(["offline", "waiting"].includes(data.mainPlatformSyncStatus.state));
  assert.equal(data.mainPlatformSyncStatus.pending, 1);
  assert.equal(data.mainPlatformSyncQueue[0].attempts, 1);
  assert.equal(data.mainPlatformSyncQueue.length, 1);
  assert.ok(data.mainPlatformSyncQueue[0].nextAttemptAt > Date.now());
  assert.equal(chrome.alarms.created.at(-1)[0], "mainPlatformSyncRetry");
  await sync.drain();
});

test("wallet.observation envelope and payload follow contract §1", async () => {
  installFakeChrome({ mainPlatform: { enabled: true, endpoint: "http://capture.test/events" } });
  const sync = loadSync();
  const core = globalThis.WalletCore;
  const bodies = [];
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  const page = { domain: "site.test", topPageUrl: "http://site.test/deposit", sourcePageUrl: "http://site.test/frame", pageTitle: "Deposit" };
  const observation = {
    address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", family: "tron", candidateNetworks: ["tron"], networkHint: { network: "tron", token: "USDT", source: "selected-option" }, formatCheck: "checksum_valid",
    context: { class: "deposit", confidence: 0.9, cues: ["deposit (heading)"], negativeCues: [], section: "Deposit USDT", snippet: "Deposit address TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj" },
    detection: { method: "text", methods: ["text"], afterInteraction: false }, evidence: { domPath: "html>body>p" }
  };
  const payload = sync.observationPayload(observation, page, { firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", seenCount: 1 });
  assert.equal(payload.observationId, core.sha256Hex("tron|TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj|http://site.test/deposit|text|deposit"));
  assert.deepEqual(Object.keys(payload).sort(), ["address", "candidateNetworks", "context", "detection", "evidence", "family", "firstSeen", "formatCheck", "lastSeen", "networkHint", "observationId", "page", "provenance", "seenCount"].sort());
  assert.deepEqual(payload.page, { domain: "site.test", url: "http://site.test/deposit", frameUrl: "http://site.test/frame", title: "Deposit" });
  assert.deepEqual(payload.provenance, { sensor: "CryptoWalletLogger", version: "0.9.0", passive: true });
  await sync.enqueue("wallet.observation", payload);
  const later = { ...payload, lastSeen: "2026-01-02T00:00:00.000Z", seenCount: 5 };
  const replay = await sync.enqueue("wallet.observation", later);
  assert.equal(replay.duplicate || bodies.length === 1, true, "seenCount/lastSeen changes alone do not create a new event");
  await waitFor(() => bodies.length >= 1);
  assert.equal(bodies[0].type, "wallet.observation");
  assert.equal(bodies[0].schemaVersion, "2.0.0");
  assert.equal(bodies[0].source, "CryptoWalletLogger");
  const improved = { ...payload, context: { ...payload.context, confidence: 0.95 } };
  const result = await sync.enqueue("wallet.observation", improved);
  assert.equal(result.queued, true, "improved context is sent again with the same observationId");
  await waitFor(() => bodies.length >= 2);
  assert.equal(bodies[1].payload.observationId, bodies[0].payload.observationId);
  assert.notEqual(bodies[1].id, bodies[0].id);
});
