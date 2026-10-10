/**
 * The deterministic planner: the same investigation logic as a model, expressed
 * as ordered rules over the digest. It emits the exact plan shape a model must
 * emit, so it flows through the identical policy and executor. It is used when
 * no model is configured, when the model's output is rejected or its retries
 * run out, and as the evaluation baseline. It is never presented as AI.
 *
 * Order of preference: resolve a barrier -> investigate the site -> analyse an
 * observed wallet -> one related-site expansion when the site looks worth it ->
 * conclude. It never proposes an action the policy would reject.
 */
import type { Digest } from "./state";
import type { Plan } from "./policy";
import { completionOptions } from "./capabilities";

export function rulesPlan(d: Digest, run: Record<string, unknown>): Plan {
  const n = (k: string) => Number(run[k] ?? 0);
  const evidenceFor = (ids: string[]) => ids.filter(Boolean).slice(0, 8);
  const plan = (rationale: string, capability: string, args: Record<string, unknown>, triggering: string[] = [], value = 0.6): Plan =>
    ({ rationale, action: { capability, arguments: args }, triggering_evidence: evidenceFor(triggering), expected_value: value, inferences: [] });

  // 1. A detected human barrier: pause for the person.
  const barrier = d.barriers.find(b => !d.checkpoints.some(c => c.kind === b.kind && c.status !== "cancelled"));
  if (barrier) return plan(`Observed a ${barrier.kind} barrier; a person has to complete it.`, "human.request", { kind: barrier.kind }, barrier.evidence_ids, 0.8);

  // 2. Investigate the site, if not yet done and not dead.
  if (d.site && !d.progress.site_investigated && !d.progress.site_investigation_failed && !d.dead.dead && !d.in_flight.some(j => j.type === "INVESTIGATE_SITE"))
    return plan("The site has not been investigated yet; examine its public pages.", "site.investigate", { entity_id: d.site.entity_id }, [], 0.8);

  // 3. Analyse an observed wallet that has not been analysed.
  const wallet = d.wallets.find(w => !w.analyzed && !["pending", "running", "retrying", "failed", "needs-review", "awaiting-approval"].includes(w.analysis));
  if (wallet && n("used_module_calls") < n("max_module_calls"))
    return plan("A wallet was observed on the site but not analysed; request blockchain analysis.", "wallet.analyze", { entity_id: wallet.entity_id }, [], 0.75);

  // 4. If the site is a confirmed scam with wallets and we have budget, one related-site expansion.
  if (d.site && d.progress.site_investigated && d.wallets.length > 0 && !d.progress.related_requested && n("used_discovery_expansions") < n("max_discovery_expansions"))
    return plan("The site is a confirmed crypto scam with wallets; look once for related sites.", "discovery.find_related", { entity_id: d.site.entity_id, max_candidates: 5 }, [], 0.5);

  // 5. Nothing left to do: conclude with whatever the gate allows.
  const options = completionOptions(d);
  if (options.includes("COMPLETE")) return plan("The site was investigated and every observed wallet analysed.", "investigation.conclude", { status: "COMPLETE", summary: `Investigated ${d.site?.domain ?? "the site"}: ${d.evidence.meaningful} meaningful evidence item(s), ${d.wallets.length} wallet(s), ${d.progress.wallets_analyzed} analysed.` }, [], 0.9);
  if (options.includes("INSUFFICIENT_EVIDENCE")) return plan(d.dead.dead ? "The site is dead; no evidence to collect." : "No further action has meaningful expected value.", "investigation.conclude", { status: "INSUFFICIENT_EVIDENCE", summary: d.dead.dead ? d.dead.reason : `Investigated ${d.site?.domain ?? "the site"}; little useful evidence and nothing more worth doing.` }, [], 0.9);

  // 6. Blocked only by in-flight work or an open checkpoint: wait.
  return plan("Waiting for outstanding module work or a human step before deciding.", "investigation.conclude", { status: "INSUFFICIENT_EVIDENCE", summary: "Nothing to do right now." }, [], 0.1);
}
