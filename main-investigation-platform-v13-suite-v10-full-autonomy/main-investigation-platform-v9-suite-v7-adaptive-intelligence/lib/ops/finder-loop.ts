/**
 * Investigation Mode -> Discovery Mode.
 *
 * When a site investigation completes, the public artifacts it recorded (analytics accounts,
 * messenger handles, page title, private name servers) go back to Site Finder as a bounded
 * FIND_RELATED_SITES request, so Finder can open a pursuit branch for each and look for new sites
 * that reuse them. The loop is bounded three ways:
 *   - one request per investigated site ever (work item fingerprint), so a re-investigation does
 *     not start the same hunt again;
 *   - only for sites Site Finder brought in (an inbox candidate exists), not for every site Main holds;
 *   - Site Finder carries the discovery depth across the loop and stops at its depth limit.
 * Main's scheduler still decides when it runs, within the discovery budget.
 */
import { getD1 } from "../platform";
import { proposeWork } from "./workitems";
import { sanitizeArtifacts } from "./hunter";
import { parse, type Row } from "./common";

function analytics(id: string) {
  const v = id.trim();
  if (/^G-/i.test(v)) return `ga4:${v.toLowerCase()}`;
  if (/^UA-/i.test(v)) return `ua:${v.toLowerCase()}`;
  if (/^GTM-/i.test(v)) return `gtm:${v.toLowerCase()}`;
  return "";
}

/** Artifacts of one investigated site, from the evidence the investigation recorded. */
export async function investigationArtifacts(investigationId: string, domain: string) {
  const db = getD1();
  const rows = (await db.prepare(`SELECT evidence_type,context_text FROM evidence WHERE investigation_id=? AND source_module='site_investigator'
      AND evidence_type IN ('analytics_ids','socials','page_text','dns') ORDER BY captured_at DESC LIMIT 60`).bind(investigationId).all<Row>()).results;
  const out: Array<{ kind: string; value: string }> = [];
  for (const r of rows) {
    const v = parse<unknown>(r.context_text, null);
    const type = String(r.evidence_type);
    if (type === "analytics_ids" && Array.isArray(v)) for (const id of v) { const a = analytics(String(id)); if (a) out.push({ kind: "analytics", value: a }); }
    else if (type === "socials" && Array.isArray(v)) for (const u of v) { const m = String(u).match(/(?:t\.me|telegram\.me|wa\.me)\/([A-Za-z0-9_+]{4,40})/i); if (m) out.push({ kind: "contact", value: m[1].toLowerCase() }); }
    else if (type === "page_text" && v && typeof v === "object") { const t = String((v as Row).title ?? "").replace(new RegExp(domain.replace(/[.]/g, "\\."), "ig"), "").replace(/^[\s|\-·:]+|[\s|\-·:]+$/g, ""); if (t.length >= 6) out.push({ kind: "title", value: t.toLowerCase() }); }
    else if (type === "dns" && v && typeof v === "object") for (const ns of ((v as Row).ns ?? (v as Row).nameservers ?? []) as unknown[]) out.push({ kind: "ns", value: String(ns).toLowerCase().replace(/\.$/, "") });
  }
  return sanitizeArtifacts(out);
}

/** Called when the investigation module completes a site job. Never throws. */
export async function investigationToFinder(job: Row) {
  try {
    if (!["INVESTIGATE_SITE", "RECHECK_SITE"].includes(String(job.job_type)) || !job.investigation_id) return null;
    const db = getD1();
    const cand = await db.prepare("SELECT canonical_domain FROM inbox_candidates WHERE investigation_id=? AND source_module='site_finder' LIMIT 1").bind(job.investigation_id).first<Row>();
    if (!cand) return null;
    const domain = String(cand.canonical_domain);
    const artifacts = await investigationArtifacts(String(job.investigation_id), domain);
    if (!artifacts.length) return null;
    const w = await proposeWork({ kind: "find_related_sites", targetType: "domain", targetKey: domain, fingerprint: `find_related:investigation:${domain}`, source: "discovery",
      reason: `The investigation of ${domain} recorded ${artifacts.length} public artifact${artifacts.length > 1 ? "s" : ""}; look for other sites that reuse them.`,
      investigationId: String(job.investigation_id), factors: { info_gain: 0.7, evidence_strength: 0.6, novelty: 0.7, open_gaps: 0.6, cost: 0.3, freshness: 1 } });
    if (w.outcome === "created") await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status IN ('queued','deferred')")
      .bind(JSON.stringify({ seeds: [domain], artifacts, reason: "investigation_artifacts", source: "investigation" }), w.id).run();
    return w;
  } catch { return null; }
}
