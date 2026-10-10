(root => {
  "use strict";

  const SCHEMA = "wallet-investigator-import";
  const SCHEMA_VERSION = "1.1.0";

  function evidenceRecord(wallet, website, deposit, sighting = null) {
    const source = sighting || deposit || wallet;
    const methods = [...new Set([...(source.detectionMethods || []), ...(wallet.detectionMethods || []), wallet.evidenceSource].filter(Boolean))];
    const evidenceItems = source.evidenceItems || wallet.evidenceItems || [];
    return {
      recordId: `${wallet.id}:${deposit?.id || sighting?.sightingKey || "primary"}`,
      sourceWalletId: wallet.id,
      depositRecordId: deposit?.id || null,
      wallet: wallet.address,
      network: source.network || wallet.network,
      token: source.token || WalletOrganizationStore.tokenFromNetwork(source.network || wallet.network),
      domain: wallet.domain,
      sourceUrl: source.pageUrl || wallet.evidencePageUrl || wallet.pageUrl || "",
      pageTitle: source.pageTitle || wallet.pageTitle || "",
      context: source.nearbyEvidence || source.context || wallet.context || "",
      confidence: source.confidence || wallet.confidence,
      detectionMethods: methods,
      firstSeen: source.firstSeenAt || wallet.foundAt,
      lastSeen: source.lastSeenAt || wallet.lastSeenAt || wallet.foundAt,
      pagesSeen: wallet.pageUrls || source.sourceUrls || [],
      sourceEvidence: { website: wallet.domain, pageTitle: source.pageTitle || wallet.pageTitle || "", context: source.nearbyEvidence || source.context || wallet.context || "" },
      depositEvidence: {
        labels: deposit?.depositLabels || [],
        evidenceItems: [...evidenceItems],
        evidenceTags: [...(source.evidenceTags || wallet.evidenceTags || [])]
      },
      qrEvidence: {
        matched: Boolean(source.qrMatch || evidenceItems.some(item => /QR code/i.test(item))),
        evidence: evidenceItems.filter(item => /QR/i.test(item))
      },
      notes: { website: website?.notes || "", wallet: wallet.notes || "", deposit: deposit?.notes || "" },
      labels: { website: website?.labels || [], wallet: wallet.labels || [], deposit: deposit?.labels || [] }
    };
  }

  function build(data, exportedAt = new Date().toISOString()) {
    const wallets = data.walletRecords || [];
    const websites = data.websiteRecords || [];
    const deposits = data.depositRecords || [];
    const records = [];
    for (const wallet of wallets) {
      const website = websites.find(record => record.domain === wallet.domain);
      const relatedDeposits = deposits.filter(record => record.walletId === wallet.id || (record.domain === wallet.domain && record.wallet === wallet.address));
      if (relatedDeposits.length) {
        for (const deposit of relatedDeposits) records.push(evidenceRecord(wallet, website, deposit));
      } else if (wallet.sightings?.length) {
        for (const sighting of wallet.sightings) records.push(evidenceRecord(wallet, website, null, sighting));
      } else records.push(evidenceRecord(wallet, website, null));
    }
    return {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      sourceApplication: "CryptoWalletLogger",
      sourceVersion: "0.9.0",
      exportedAt,
      evidencePolicy: "Original captured evidence is exported without reclassification.",
      records
    };
  }

  function csvCell(value) {
    const text = Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function toCsv(exportPayload) {
    const fields = ["wallet", "network", "token", "domain", "sourceUrl", "pageTitle", "context", "confidence", "detectionMethods", "firstSeen", "lastSeen", "pagesSeen", "sourceEvidence", "depositEvidence", "qrEvidence", "notes", "labels", "recordId", "sourceWalletId", "depositRecordId"];
    return `\ufeff${[fields.join(","), ...(exportPayload.records || []).map(record => fields.map(field => csvCell(record[field])).join(","))].join("\r\n")}`;
  }

  root.WalletIntegrationExport = { SCHEMA, SCHEMA_VERSION, build, toCsv };
  if (typeof module !== "undefined" && module.exports) module.exports = root.WalletIntegrationExport;
})(globalThis);
