(root => {
  "use strict";

  const METHOD_LABELS = {
    "page": "Page text",
    "page-fallback": "Page text",
    "near-address": "Nearby text",
    "deposit-section": "Deposit/payment section",
    "address-field": "Input/read-only field",
    "modal-section": "Modal/popup",
    "shadow-section": "Open Shadow DOM",
    "copy-address": "Copy-address control",
    "deposit-qr": "QR code",
    // v0.9 detection methods (wallet.observation v2)
    "text": "Page text",
    "input": "Input/read-only field",
    "attribute": "Element attribute",
    "copy-control": "Copy-address control",
    "clipboard": "Copied to clipboard",
    "qr": "QR code",
    "shadow-dom": "Shadow DOM",
    "script-config": "Page script/config data",
    "network-response": "Network response",
    "uri-link": "Payment URI link",
    "modal": "Modal/popup",
    "dynamic": "Dynamically inserted content"
  };

  function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
  }

  function normalizeMethods(record) {
    const items = (record.evidenceItems || []).join("\n");
    const inferred = [];
    if (/input or read-only field/i.test(items)) inferred.push("address-field");
    if (/copy-address control/i.test(items)) inferred.push("copy-address");
    if (/modal or popup/i.test(items)) inferred.push("modal-section");
    if (/Shadow DOM/i.test(items)) inferred.push("shadow-section");
    if (/deposit\/payment section/i.test(items)) inferred.push("deposit-section");
    if (/deposit QR code/i.test(items)) inferred.push("deposit-qr");
    const raw = unique([...(record.detectionMethods || []), record.evidenceSource, ...inferred]);
    return unique(raw.map(method => METHOD_LABELS[method] || method));
  }

  function calculate(record) {
    const items = record.evidenceItems || [];
    const tags = record.evidenceTags || [];
    const methods = normalizeMethods(record);
    const text = [...items, ...tags, record.context || ""].join("\n");
    const reasons = [];
    const add = (label, points) => reasons.push({ label, points });

    add("Valid wallet format or checksum", 20);
    const contextClass = record.contextClass || "";
    if (contextClass === "deposit" || (!contextClass && (/deposit\/payment section|inside deposit|payment\/deposit label/i.test(text) || methods.includes("Deposit/payment section")))) add("Found in a deposit/payment section", 14);
    if (/selected token|selected coin|selected asset/i.test(text)) add("Selected token identified", 9);
    if (/selected network|selected chain/i.test(text)) add("Selected network identified", 10);
    if (/label:\s.*address|deposit address|receiving address|wallet address/i.test(text)) add("Address label present", 9);
    if (/copy-address control/i.test(text) || methods.includes("Copy-address control") || methods.includes("Copied to clipboard")) add("Copy-address control nearby", 6);
    if (/deposit QR code|QR payload/i.test(text) || methods.includes("QR code")) add(methods.length > 1 ? "Matching wallet QR code" : "Wallet address decoded from QR", methods.length > 1 ? 12 : 8);
    if (methods.length > 1) add(`Detected through ${methods.length} methods`, 8);
    if (record.verification?.status === "ACTIVE") add("Public blockchain activity found", 7);
    const seenCount = Math.max(1, Number(record.seenCount) || 1);
    if (seenCount > 1) add(`Seen ${seenCount} times`, Math.min(5, seenCount - 1));

    if (contextClass && contextClass !== "deposit" && contextClass !== "unknown") add(`Context classified as ${contextClass.replace("_", " ")} (not a deposit)`, -15);
    return {
      score: Math.max(0, Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0))),
      reasons,
      methods,
      updatedAt: new Date().toISOString(),
      note: "Evidence score measures detection strength, not legitimacy or maliciousness."
    };
  }

  root.WalletEvidenceScore = { calculate, normalizeMethods, METHOD_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.WalletEvidenceScore;
})(globalThis);
