import test from "node:test";
import assert from "node:assert/strict";

// Mirrors the small pure policy used by platform.ts without importing Cloudflare's runtime-only module.
function selectModuleKey(config, module, legacy, allowLegacy) {
  let keys;
  try { keys = JSON.parse(config ?? "{}"); } catch { throw new Error("AUTH_CONFIG_INVALID"); }
  return keys[module]?.trim() || (allowLegacy ? legacy?.trim() : "") || "";
}

test("module credentials are isolated", () => {
  const config = JSON.stringify({ site_finder: "sf-secret", site_investigator: "si-secret" });
  assert.equal(selectModuleKey(config, "site_finder", "legacy", false), "sf-secret");
  assert.equal(selectModuleKey(config, "site_investigator", "legacy", false), "si-secret");
  assert.notEqual(selectModuleKey(config, "site_finder", "legacy", false), selectModuleKey(config, "site_investigator", "legacy", false));
});

test("authentication fails closed and legacy fallback is opt-in", () => {
  assert.equal(selectModuleKey("{}", "site_finder", "legacy", false), "");
  assert.equal(selectModuleKey("{}", "site_finder", "legacy", true), "legacy");
  assert.throws(() => selectModuleKey("not-json", "site_finder", "legacy", false), /AUTH_CONFIG_INVALID/);
});
