/**
 * Simulation / dry run.
 *
 * Plays the scheduler forward over either the platform's current state
 * ("history": queued work plus the candidates it would generate) or a
 * synthetic fixture, using the SAME pure pieces the live scheduler uses
 * (priorityOf, effectivePriority, candidate factors, limits, budgets, learned
 * priors). It reports the actions it would take, the module jobs they imply,
 * budget use, where a person would be needed and where and why it would stop.
 *
 * The whole run executes inside `withoutExecution`, so every executor on the
 * platform (jobs, investigator runs, campaigns, graph writes, work items)
 * refuses; `blocked_executions` in the result must be 0 for a correct
 * simulation and would list any attempt otherwise. Only the simulation's own
 * report row is written, after the guarded section.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { withoutExecution } from "./guard";
import { DEFAULT_FACTORS, KINDS, MODULE_OF, effectivePriority, priorityOf, type Factors, type Kind } from "./workitems";
import { getNum, json, parse, r3, clamp, type Row } from "./common";

const JOB_OF: Partial<Record<Kind, string>> = {
  investigate_candidate: "INVESTIGATE_SITE (+ follow-up module jobs chosen by the investigator)", revisit_changed_site: "RECHECK_SITE", revisit_incomplete: "RECHECK_SITE",
  analyze_wallet: "ANALYZE_WALLET", inspect_infrastructure: "FIND_RELATED_SITES", discovery_cycle: "DISCOVER_SITES",
};
const BUDGET_OF: Partial<Record<Kind, string>> = { investigate_candidate: "investigations", revisit_changed_site: "module_jobs", revisit_incomplete: "module_jobs", analyze_wallet: "module_jobs", inspect_infrastructure: "discovery_requests", discovery_cycle: "discovery_requests", reconstruct_operation: "module_jobs", find_related_sites: "discovery_requests" };

export const FIXTURE = z.object({
  items: z.array(z.object({ kind: z.enum(KINDS), target: z.string().max(200), factors: z.record(z.string(), z.number()).optional(), waited_hours: z.number().min(0).max(1000).optional(), needs_human: z.number().min(0).max(1).optional(), useful: z.number().min(0).max(1).optional() }).strict()).max(500),
  budgets: z.record(z.string(), z.number().min(0)).optional(),
  max_concurrent: z.number().int().min(1).max(50).optional(),
}).strict();

export const SIM_INPUT = z.object({
  name: z.string().min(1).max(120).default("dry run"),
  source: z.enum(["history", "fixture"]),
  fixture: FIXTURE.optional(),
  ticks: z.number().int().min(1).max(200).default(12),
}).strict();

type SimItem = { kind: Kind; target: string; factors: Factors; waited: number; needsHuman: number; useful: number; state: "queued" | "done" | "human" };

async function historyItems(): Promise<SimItem[]> {
  const db = getD1();
  const { learnedPrior, workContext } = await import("./learning");
  const { candidateFactors } = await import("./scheduler");
  const out: SimItem[] = [];
  const rows = (await db.prepare("SELECT * FROM work_items WHERE status IN ('queued','deferred') ORDER BY priority DESC LIMIT 300").all<Row>()).results;
  for (const w of rows) {
    const ctx = workContext(w);
    out.push({ kind: w.kind as Kind, target: String(w.target_key), factors: { ...DEFAULT_FACTORS, ...parse<Partial<Factors>>(w.factors, {}) }, waited: Math.max(0, (Date.now() - new Date(String(w.created_at).replace(" ", "T") + "Z").getTime()) / 3600000),
      needsHuman: (await learnedPrior("human_needed", ctx)).value, useful: (await learnedPrior(String(w.kind), ctx)).value, state: "queued" });
  }
  const minScore = await getNum("auto_investigate_min_score", 0.5);
  const cands = (await db.prepare(`SELECT c.* FROM inbox_candidates c WHERE c.status IN ('ready','presented') AND c.investigation_id IS NOT NULL AND c.decision IS NULL AND c.score>=?
    AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.kind='investigate_candidate' AND w.target_key=c.canonical_domain) ORDER BY c.score DESC LIMIT 100`).bind(minScore).all<Row>()).results;
  for (const c of cands) {
    const f: Factors = await candidateFactors(c);
    const ctx = `kind=investigate_candidate|campaign=0|gain=${f.info_gain >= 0.66 ? "hi" : f.info_gain >= 0.33 ? "mid" : "lo"}|source=discovery`;
    out.push({ kind: "investigate_candidate", target: String(c.canonical_domain), factors: f, waited: 0, needsHuman: (await learnedPrior("human_needed", ctx)).value, useful: (await learnedPrior("investigate_candidate", ctx)).value, state: "queued" });
  }
  return out;
}

async function liveBudgets() {
  const { budgetSummary } = await import("./budgets");
  const left: Record<string, number> = {};
  for (const b of await budgetSummary()) if (b.scope === "global") left[b.kind] = Math.max(0, b.max - b.used);
  return left;
}

/** Pure core: plays `ticks` scheduler ticks over the items. Exported for tests. */
export function play(items: SimItem[], opts: { ticks: number; maxConcurrent: number; budgets: Record<string, number>; boostPerHour: number; boostCap: number; tickHours: number }) {
  const budgets = { ...opts.budgets };
  const used: Record<string, number> = {};
  const timeline: Array<{ tick: number; action: string; kind: string; target: string; priority: number; job?: string; expected_useful: number }> = [];
  const checkpoints: Array<{ tick: number; target: string; kind: string; why: string }> = [];
  const waits: Array<{ tick: number; target: string; why: string }> = [];
  let stop = { tick: opts.ticks, why: `reached the ${opts.ticks}-tick horizon` };
  for (let t = 1; t <= opts.ticks; t++) {
    const queue = items.filter(i => i.state === "queued").map(i => ({ i, eff: effectivePriority(priorityOf(i.factors), i.waited + (t - 1) * opts.tickHours, opts.boostPerHour, opts.boostCap) }))
      .filter(x => x.i.factors.dup_prob < 0.85).sort((a, b) => b.eff - a.eff || a.i.target.localeCompare(b.i.target));
    if (!queue.length) { stop = { tick: t, why: "no valuable work left in the queue" }; break; }
    let slots = opts.maxConcurrent, startedThisTick = 0, blockedByBudget = 0;
    for (const { i, eff } of queue) {
      if (slots <= 0) break;
      const bk = BUDGET_OF[i.kind];
      if (bk && budgets[bk] != null && budgets[bk] < 1) { blockedByBudget++; waits.push({ tick: t, target: i.target, why: `${bk} budget reached` }); continue; }
      if (bk && budgets[bk] != null) { budgets[bk]--; used[bk] = (used[bk] ?? 0) + 1; }
      slots--; startedThisTick++;
      timeline.push({ tick: t, action: "start", kind: i.kind, target: i.target, priority: r3(eff), job: JOB_OF[i.kind], expected_useful: r3(i.useful) });
      if (i.kind === "review_contradiction" || i.needsHuman >= 0.5) { i.state = "human"; checkpoints.push({ tick: t, target: i.target, kind: i.kind, why: i.kind === "review_contradiction" ? "an analyst must decide which observation is right" : `similar work needed a person ${Math.round(i.needsHuman * 100)}% of the time (login, CAPTCHA, MFA or email verification)` }); }
      else i.state = "done";
    }
    if (!startedThisTick && blockedByBudget) { stop = { tick: t, why: "every remaining item is waiting for budget" }; break; }
  }
  const expected = timeline.reduce((s, x) => s + x.expected_useful, 0);
  return { timeline, checkpoints, waits: waits.slice(0, 50), budget_use: used, budget_left: budgets, stopping_point: stop, expected_useful_results: r3(expected), remaining: items.filter(i => i.state === "queued").length };
}

export async function simulate(raw: unknown) {
  const input = SIM_INPUT.parse(raw);
  const boostPerHour = await getNum("starvation_boost_per_hour", 0.02), boostCap = await getNum("starvation_boost_cap", 0.25);
  const { value, blocked } = await withoutExecution(`simulation ${input.name}`, async () => {
    if (input.source === "fixture") {
      const fx = input.fixture ?? { items: [] };
      const items: SimItem[] = fx.items.map(x => ({ kind: x.kind, target: x.target, factors: { ...DEFAULT_FACTORS, ...(x.factors ?? {}) } as Factors, waited: x.waited_hours ?? 0, needsHuman: clamp(x.needs_human ?? 0), useful: clamp(x.useful ?? 0.5), state: "queued" }));
      return play(items, { ticks: input.ticks, maxConcurrent: fx.max_concurrent ?? 6, budgets: fx.budgets ?? {}, boostPerHour, boostCap, tickHours: 0.25 });
    }
    const items = await historyItems();
    // Proves the guard: an accidental executor call inside the simulation is refused and counted.
    return play(items, { ticks: input.ticks, maxConcurrent: await getNum("max_concurrent_work", 6), budgets: await liveBudgets(), boostPerHour, boostCap, tickHours: 0.25 });
  });
  const id = crypto.randomUUID();
  const result = { ...value, blocked_executions: blocked, executed_nothing: true, modules: [...new Set(value.timeline.map(x => MODULE_OF[x.kind as Kind]).filter(Boolean))] };
  await getD1().prepare("INSERT INTO simulations (id,name,source,config,status,result,finished_at) VALUES (?,?,?,?,'done',?,CURRENT_TIMESTAMP)").bind(id, input.name, input.source, json({ ticks: input.ticks }), json(result)).run();
  return { id, ...result };
}
