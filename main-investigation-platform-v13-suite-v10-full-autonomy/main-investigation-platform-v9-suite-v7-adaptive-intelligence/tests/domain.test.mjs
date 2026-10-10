import test from "node:test";
import assert from "node:assert/strict";
import { canTransitionJob, jobDedupeKey, normalizeCanonicalKey, retryDelaySeconds, schemaCompatibility } from "../lib/domain.mjs";

test("domain resolution deduplicates equivalent sites", () => {
  assert.equal(normalizeCanonicalKey("site", { url: "HTTPS://WWW.Example.com/" }), "example.com");
  assert.equal(normalizeCanonicalKey("site", { canonical_key: "example.com" }), "example.com");
});
test("wallet and token identity is network scoped", () => {
  assert.notEqual(normalizeCanonicalKey("wallet", { address: "0xABC", network: "ethereum" }), normalizeCanonicalKey("wallet", { address: "0xABC", network: "polygon" }));
  assert.notEqual(normalizeCanonicalKey("token", { address: "0xABC", network: "ethereum" }), normalizeCanonicalKey("token", { address: "0xABC", network: "base" }));
});
test("job keys prevent active duplicate work", () => assert.equal(jobDedupeKey("ANALYZE_WALLET", "i1", "w1", "wallet_investigator"), jobDedupeKey("ANALYZE_WALLET", "i1", "w1", "wallet_investigator")));
test("job transition policy rejects processing loops", () => { assert.equal(canTransitionJob("pending", "running"), true); assert.equal(canTransitionJob("completed", "running"), false); assert.equal(canTransitionJob("running", "retrying"), true); });
test("retry backoff is exponential and capped", () => { assert.equal(retryDelaySeconds(1), 15); assert.equal(retryDelaySeconds(3), 60); assert.equal(retryDelaySeconds(20), 3600); });
test("schema major versions are checked", () => { assert.equal(schemaCompatibility("1.4").compatible, true); assert.equal(schemaCompatibility("2.0").compatible, true); assert.equal(schemaCompatibility("3.0").compatible, true); assert.equal(schemaCompatibility("4.0").compatible, false); });
test("a wallet key that already names its network is not prefixed twice", () => {
  // Site Finder sends "tron:<address>", Site Investigator and Wallet Logger send the bare address.
  const fromFinder = normalizeCanonicalKey("wallet", { canonical_key: "tron:TKokvBRjdUZ5ZuxBJNZX2K1oYpKMbEfxGM", network: "TRON" });
  const fromInvestigator = normalizeCanonicalKey("wallet", { canonical_key: "TKokvBRjdUZ5ZuxBJNZX2K1oYpKMbEfxGM", network: "tron" });
  assert.equal(fromFinder, fromInvestigator);
  assert.equal(fromFinder, "tron:tkokvbrjduz5zuxbjnzx2k1oypkmbefxgm");
});
