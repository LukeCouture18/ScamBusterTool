export const JOB_STATUSES = ["pending", "running", "completed", "failed", "retrying", "paused", "cancelled", "needs-review", "awaiting-approval"];
export const JOB_TYPES = ["DISCOVER_SITES", "INVESTIGATE_SITE", "FIND_RELATED_SITES", "RECHECK_SITE", "OBSERVE_SITE", "LOG_WALLET_ACTIVITY", "ANALYZE_WALLET", "REFRESH_WALLET", "REVIEW_EVIDENCE", "PREPARE_REPORT", "HUNT_OPERATION"];
export const EVIDENCE_CLASSES = ["observed_website", "blockchain_fact", "derived_observation", "analyst_note"];

export function normalizeCanonicalKey(type, record) {
  const raw = record.canonical_key ?? record.url ?? record.address ?? record.tx_hash ?? record.external_id;
  let key = String(raw).trim().toLowerCase().replace(/\/$/, "");
  if (type === "site" || type === "related_site") {
    try { key = new URL(key.includes("://") ? key : `https://${key}`).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  }
  if (type === "page" || type === "deposit_page") {
    try { const url = new URL(key); url.hash = ""; key = url.toString().replace(/\/$/, ""); } catch {}
  }
  if (["wallet", "token", "transaction", "counterparty"].includes(type)) {
    const network = String(record.network ?? record.chain ?? record.chain_id ?? "unknown").trim().toLowerCase();
    // Some modules (Site Finder) already send "network:address"; never prefix twice, or the same
    // wallet reported by two tools would become two entities.
    key = key.startsWith(`${network}:`) ? key : `${network}:${key}`;
  }
  return key;
}

export function observationKey(module, type, externalId) { return `${module}:${type}:${externalId}`; }
export function jobDedupeKey(jobType, investigationId, targetEntityId, targetModule) { return [jobType, investigationId ?? "global", targetEntityId ?? "none", targetModule].join(":"); }
export function retryDelaySeconds(attempt, base = 15, cap = 3600) { return Math.min(cap, base * (2 ** Math.max(0, attempt - 1))); }
export function canTransitionJob(from, to) {
  const allowed = { pending:["running","paused","cancelled","awaiting-approval"], "awaiting-approval":["pending","cancelled"], running:["completed","failed","retrying","paused","needs-review","cancelled"], retrying:["running","paused","failed","cancelled"], paused:["pending","retrying","cancelled"], failed:["retrying","cancelled"], "needs-review":["pending","running","completed","cancelled"], completed:[], cancelled:[] };
  return Boolean(allowed[from]?.includes(to));
}
export function schemaCompatibility(version) { const major = Number(String(version ?? "0").split(".")[0]); return { compatible: major >= 1 && major <= 3, supported: "1.x (v4 adapter), 2.x (v5), 3.x (v6)" }; }
