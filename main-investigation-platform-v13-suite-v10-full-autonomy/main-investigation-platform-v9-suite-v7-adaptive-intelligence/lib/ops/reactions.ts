/**
 * What a meaningful change does. A change never becomes evidence by itself; it
 * creates (or re-scores) the work that will observe the new state, re-opens a
 * campaign that had gone quiet, closes gaps that no longer make sense, marks
 * links that no longer hold, and flags facts that changed after they were
 * reported.
 */
import { getD1 } from "../platform";
import { proposeWork, cancelWork } from "./workitems";
import { learnedPrior } from "./learning";
import { json, parse, type Row } from "./common";

export type Change = { id: string; subjectType: string; subjectKey: string; facet: string; kind: string; significance: number; from: unknown; to: unknown; sourceTable: string; sourceRef: string };
const REVISIT_KINDS = new Set(["site_returned", "deposit_appeared", "wallet_changed", "related_domain_appeared", "status_changed"]);

export async function onChange(ch: Change) {
  if (ch.subjectType !== "domain") return;
  const db = getD1();
  const domain = ch.subjectKey;
  const cand = await db.prepare("SELECT id,investigation_id,score FROM inbox_candidates WHERE canonical_domain=?").bind(domain).first<Row>();
  const campaigns = (await db.prepare("SELECT m.campaign_id,c.status FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=?").bind(domain).all<Row>()).results;
  const inActive = campaigns.some(c => ["RUNNING", "PAUSED"].includes(String(c.status)));
  let workItemId: string | null = null;

  if (REVISIT_KINDS.has(ch.kind) && ch.significance >= 0.5 && cand?.investigation_id) {
    const prior = await learnedPrior("revisit_changed_site", `change=${ch.kind}`);
    const hours = Number((await db.prepare("SELECT value FROM ops_state WHERE key='revisit_cooldown_hours'").first<Row>())?.value ?? 24);
    const last = await db.prepare("SELECT finished_at FROM work_items WHERE fingerprint=?").bind(`revisit_changed_site:domain:${domain}`).first<Row>();
    const cooldownUntil = last?.finished_at ? new Date(new Date(String(last.finished_at).replace(" ", "T") + "Z").getTime() + hours * 3600000) : null;
    const w = await proposeWork({ kind: "revisit_changed_site", targetType: "domain", targetKey: domain, source: "change", reopen: true,
      reason: `${domain}: ${ch.kind.replace(/_/g, " ")} — observe the new state`,
      notBefore: cooldownUntil && cooldownUntil.getTime() > Date.now() && ch.significance < 0.85 ? cooldownUntil.toISOString() : null,
      investigationId: String(cand.investigation_id), campaignId: campaigns[0] ? String(campaigns[0].campaign_id) : null,
      factors: { info_gain: ch.significance, novelty: 0.4, evidence_strength: Number(cand.score ?? 0.5), campaign_relevance: inActive ? 0.8 : campaigns.length ? 0.4 : 0.1, previous_outcomes: prior.value, freshness: 1, cost: 0.3, open_gaps: 0.3 } });
    workItemId = w.id;
  } else if (REVISIT_KINDS.has(ch.kind) && cand && !cand.investigation_id) {
    // A candidate never investigated: the change is a reason to investigate it now.
    const w = await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: domain, source: "change", reason: `${domain}: ${ch.kind.replace(/_/g, " ")}`,
      factors: { info_gain: ch.significance, novelty: 0.7, evidence_strength: Number(cand.score ?? 0.5), freshness: 1, cost: 0.3 } });
    workItemId = w.id;
  }

  if (ch.kind === "site_disappeared") {
    // Work that needs the site up is pointless now; gaps about it become inaccessible.
    const queued = (await db.prepare("SELECT id FROM work_items WHERE target_key=? AND kind IN ('investigate_candidate','revisit_changed_site','revisit_incomplete') AND status IN ('queued','deferred')").bind(domain).all<Row>()).results;
    for (const q of queued) await cancelWork({ id: String(q.id) }, "site disappeared");
    await db.prepare("UPDATE evidence_gaps SET status='inaccessible',resolution='site disappeared',updated_at=CURRENT_TIMESTAMP WHERE subject_key=? AND status='open'").bind(domain).run();
    const { checkInactive } = await import("./formation");
    for (const c of campaigns) await checkInactive(String(c.campaign_id));
  }

  if (ch.kind === "infrastructure_changed" || ch.kind === "certificate_changed") {
    const { deactivateFacetEdges } = await import("./intel");
    await deactivateFacetEdges(domain, ch.facet, ch.from);
    const values = Array.isArray(ch.to) ? ch.to.map(String) : [];
    for (const v of values.slice(0, 3)) {
      const kind = ch.facet === "ip" ? "ip" : ch.facet === "nameservers" ? "ns" : "san";
      const w = await proposeWork({ kind: "inspect_infrastructure", targetType: kind, targetKey: v, source: "change",
        reason: `${domain} moved to new ${ch.facet === "ip" ? "hosting" : ch.facet}: look passively for other sites on it`,
        campaignId: campaigns[0] ? String(campaigns[0].campaign_id) : null,
        factors: { info_gain: 0.55, novelty: 0.8, evidence_strength: 0.5, campaign_relevance: inActive ? 0.7 : 0.2, freshness: 1, cost: 0.35 } });
      workItemId = workItemId ?? w.id;
    }
  }

  // Reopen quiet campaigns when their sites change meaningfully.
  if (ch.significance >= 0.7) {
    const { reopenCampaign } = await import("./formation");
    for (const c of campaigns) if (["INACTIVE", "COMPLETE"].includes(String(c.status))) await reopenCampaign(String(c.campaign_id), `${domain}: ${ch.kind.replace(/_/g, " ")}`);
  }

  // A fact that was reported changed: flag it rather than silently accept the new value.
  if (["wallet_changed", "site_disappeared"].includes(ch.kind) && cand?.investigation_id) {
    const reported = await db.prepare("SELECT id,status FROM report_candidates WHERE investigation_id=? AND status NOT IN ('rejected','cancelled') ORDER BY created_at DESC LIMIT 1").bind(cand.investigation_id).first<Row>();
    if (reported) {
      const { recordContradiction } = await import("./contradictions");
      await recordContradiction({ kind: "known_fact_changed", subjectType: "domain", subjectKey: domain, aRef: `report_candidates:${reported.id}`, bRef: `entity_changes:${ch.id}`,
        aValue: json(ch.from), bValue: json(ch.to), detail: `${domain}: ${ch.facet} changed after a report was prepared (${ch.kind.replace(/_/g, " ")})`, importance: 0.85 });
    }
  }

  if (ch.kind === "deposit_appeared" || (ch.kind === "wallet_changed" && ch.significance >= 0.9)) {
    const { notify } = await import("./notifications");
    await notify({ kind: "useful_discovery", severity: "info", title: `${domain}: ${ch.kind === "deposit_appeared" ? "deposit page appeared" : "new wallet shown"}`,
      body: "A site changed in a way that usually produces new evidence. It has been queued for a revisit.", link: `/intelligence?focus=domain:${encodeURIComponent(domain)}`, dedupeKey: `change:${domain}:${ch.kind}` });
  }
  if (workItemId) await db.prepare("UPDATE entity_changes SET work_item_id=? WHERE id=?").bind(workItemId, ch.id).run();
  return workItemId;
}

export function changeSummary(c: Row) {
  const from = parse<unknown>(c.from_value, null), to = parse<unknown>(c.to_value, null);
  return `${String(c.subject_key)}: ${String(c.change_kind).replace(/_/g, " ")} (${JSON.stringify(from)?.slice(0, 60)} → ${JSON.stringify(to)?.slice(0, 60)})`;
}
