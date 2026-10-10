(root => {
  "use strict";

  const SCHEMA = "crypto-wallet-logger-backup";
  const SCHEMA_VERSION = 1;

  function build(data, exportedAt = new Date().toISOString()) {
    return {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      appVersion: "0.9.0",
      exportedAt,
      data: {
        walletRecords: data.walletRecords || [],
        websiteRecords: data.websiteRecords || [],
        depositRecords: data.depositRecords || [],
        evidenceEvents: data.evidenceEvents || [],
        settings: data.settings || {}
      }
    };
  }

  function requireArray(value, name, max) {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
    if (value.length > max) throw new Error(`${name} exceeds the supported backup limit.`);
    if (value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`${name} contains an invalid record.`);
  }

  function uniqueIds(records, name) {
    const ids = records.map(record => record.id);
    if (ids.some(id => typeof id !== "string" || !id)) throw new Error(`${name} contains a missing record ID.`);
    if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate record IDs.`);
  }

  function validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Backup must be a JSON object.");
    if (payload.schema !== SCHEMA) throw new Error("This is not a CryptoWalletLogger backup.");
    if (payload.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported backup schema version: ${payload.schemaVersion}.`);
    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Backup data is missing.");
    requireArray(data.walletRecords, "walletRecords", 50_000);
    requireArray(data.websiteRecords, "websiteRecords", 20_000);
    requireArray(data.depositRecords, "depositRecords", 100_000);
    requireArray(data.evidenceEvents, "evidenceEvents", 200_000);
    uniqueIds(data.walletRecords, "walletRecords");
    uniqueIds(data.websiteRecords, "websiteRecords");
    uniqueIds(data.depositRecords, "depositRecords");
    for (const wallet of data.walletRecords) {
      if (typeof wallet.address !== "string" || !wallet.address || typeof wallet.domain !== "string" || !wallet.domain) throw new Error("A wallet record is missing its address or domain.");
    }
    for (const website of data.websiteRecords) if (typeof website.domain !== "string" || !website.domain) throw new Error("A website record is missing its domain.");
    if (data.settings != null && (typeof data.settings !== "object" || Array.isArray(data.settings))) throw new Error("settings must be an object.");
    return JSON.parse(JSON.stringify({
      walletRecords: data.walletRecords,
      websiteRecords: data.websiteRecords,
      depositRecords: data.depositRecords,
      evidenceEvents: data.evidenceEvents,
      settings: data.settings || {}
    }));
  }

  root.WalletBackup = { SCHEMA, SCHEMA_VERSION, build, validate };
  if (typeof module !== "undefined" && module.exports) module.exports = root.WalletBackup;
})(globalThis);
