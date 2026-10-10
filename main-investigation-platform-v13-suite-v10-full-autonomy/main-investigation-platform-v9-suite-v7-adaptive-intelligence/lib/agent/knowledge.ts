/**
 * Knowledge classes. Every item the investigator reasons over carries one:
 *
 *   observed            captured from a real site/wallet by a module (evidence rows)
 *   deterministic       software analysis over observations (derived evidence,
 *                       platform resolution, capability outputs)
 *   external_metadata   registries and public infrastructure data (DNS, TLS, RDAP, CT)
 *   ai_inference        model output; lives only in agent_inferences, never in evidence
 *   human               analyst decisions and conclusions
 *
 * The mapping is fixed here in code. Nothing a model returns can move an item
 * between classes.
 */
export type KnowledgeClass = "observed" | "deterministic" | "external_metadata" | "ai_inference" | "human";

export const EXTERNAL_METADATA_TYPES = new Set(["dns", "tls_certificate", "rdap", "ip_rdap", "certificate_transparency", "whois", "nameservers"]);
/** Evidence types that record a failed attempt, not an observation. */
export const isErrorType = (type: string) => /(^|_)error$/.test(type) || type === "page_fetch_error";

export function knowledgeClass(row: { evidence_class?: unknown; evidence_type?: unknown; source_module?: unknown }): KnowledgeClass {
  const cls = String(row.evidence_class ?? ""), type = String(row.evidence_type ?? "");
  if (cls === "analyst_note" || row.source_module === "platform" && type.startsWith("analyst")) return "human";
  if (EXTERNAL_METADATA_TYPES.has(type)) return "external_metadata";
  if (cls === "derived_observation" || type === "public_triage") return "deterministic";
  return "observed";
}

/**
 * Evidence that moves an investigation forward: observed, not an error, not
 * registry metadata, and captured by a module that looks at the site or wallet.
 */
export function isMeaningful(row: { evidence_class?: unknown; evidence_type?: unknown; source_module?: unknown }) {
  const type = String(row.evidence_type ?? "");
  return knowledgeClass(row) === "observed" && !isErrorType(type) && !["site_finder", "platform", "form_submitter"].includes(String(row.source_module));
}

export function isWalletEvidence(row: { evidence_type?: unknown; source_module?: unknown; evidence_class?: unknown }) {
  const type = String(row.evidence_type ?? "");
  return isMeaningful(row) && (type === "wallet_display" || type.includes("wallet") || row.source_module === "crypto_wallet_logger" || String(row.evidence_class) === "blockchain_fact");
}
