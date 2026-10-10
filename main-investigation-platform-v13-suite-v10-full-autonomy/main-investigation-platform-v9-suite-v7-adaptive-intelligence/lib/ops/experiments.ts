/**
 * Controlled strategy experiments (bounded A/B).
 *
 * An experiment compares two registered strategies on real work. It has an
 * explicit hypothesis, a bounded population, a budget, a metric (useful results
 * per unit of cost, measured from observed outcomes), a stop condition and a
 * recorded result.
 *
 * A strategy can only re-weight the ORDER of work the platform would do anyway,
 * within ±20%. It cannot create work, choose a capability, skip the Reviewer,
 * raise a budget or touch any safety policy: every assigned item still goes
 * through the same scheduler, limits and executors as everything else.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { clamp, json, parse, r3, type Row } from "./common";

/** The only strategies an experiment may use: bounded ordering multipliers by work kind / target type. */
export const STRATEGIES: Record<string, { domain: "discovery" | "investigation"; describe: string; weight: (w: Row) => number }> = {
  certificate_first: { domain: "discovery", describe: "Prefer certificate-name pivots", weight: w => (w.target_type === "san" || w.target_type === "certificate" ? 1.2 : w.target_type === "template" || w.target_type === "favtmpl" ? 0.85 : 1) },
  template_first: { domain: "discovery", describe: "Prefer template/fingerprint pivots", weight: w => (w.target_type === "favtmpl" || w.target_type === "template" || w.target_type === "kit" ? 1.2 : w.target_type === "san" ? 0.85 : 1) },
  infrastructure_first: { domain: "discovery", describe: "Prefer hosting/name-server pivots", weight: w => (["ip", "ns", "nameserver"].includes(String(w.target_type)) ? 1.2 : 1) },
  wallet_first: { domain: "investigation", describe: "Prefer wallet analysis over site revisits", weight: w => (w.kind === "analyze_wallet" ? 1.2 : w.kind === "revisit_changed_site" ? 0.85 : 1) },
  revisit_first: { domain: "investigation", describe: "Prefer revisiting changed sites", weight: w => (w.kind === "revisit_changed_site" || w.kind === "revisit_incomplete" ? 1.2 : 1) },
  baseline: { domain: "investigation", describe: "No re-weighting", weight: () => 1 },
  baseline_discovery: { domain: "discovery", describe: "No re-weighting", weight: () => 1 },
};
const DOMAIN_KINDS: Record<string, string[]> = {
  discovery: ["inspect_infrastructure", "discovery_cycle", "expand_campaign"],
  investigation: ["investigate_candidate", "revisit_changed_site", "revisit_incomplete", "analyze_wallet"],
};
export const MAX_POPULATION = 500, MIN_ARM_N = 5;

export const EXPERIMENT_INPUT = z.object({
  name: z.string().min(3).max(120), hypothesis: z.string().min(10).max(400), domain: z.enum(["discovery", "investigation"]),
  arm_a: z.string(), arm_b: z.string(), population_max: z.number().int().min(4).max(MAX_POPULATION), budget_units: z.number().min(1).max(10000),
  stop_condition: z.object({ min_per_arm: z.number().int().min(2).max(250).default(10), max_days: z.number().min(1).max(60).default(14) }).strict().default({ min_per_arm: 10, max_days: 14 }),
}).strict();

export async function createExperiment(raw: unknown) {
  const e = EXPERIMENT_INPUT.parse(raw);
  for (const arm of [e.arm_a, e.arm_b]) if (!STRATEGIES[arm] || STRATEGIES[arm].domain !== e.domain) throw new Error(`EXPERIMENT_ARM_INVALID:${arm}`);
  if (e.arm_a === e.arm_b) throw new Error("EXPERIMENT_ARMS_IDENTICAL");
  const id = crypto.randomUUID();
  await getD1().prepare("INSERT INTO strategy_experiments (id,name,hypothesis,domain,arm_a,arm_b,population_max,budget_units,metric,stop_condition,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,'running',CURRENT_TIMESTAMP)")
    .bind(id, e.name, e.hypothesis, e.domain, e.arm_a, e.arm_b, e.population_max, e.budget_units, "useful_per_cost", json(e.stop_condition)).run();
  return id;
}

function arm(subject: string) { let h = 0; for (const ch of subject) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 2 === 0 ? "a" : "b"; }

/**
 * The ordering multiplier (0.8–1.2) a running experiment applies to a work item,
 * and the assignment it would record. Pure apart from reading the experiment.
 */
export async function experimentWeight(w: Row): Promise<{ weight: number; experimentId?: string; arm?: string }> {
  const db = getD1();
  const exps = (await db.prepare("SELECT * FROM strategy_experiments WHERE status='running'").all<Row>()).results;
  for (const e of exps) {
    if (!DOMAIN_KINDS[String(e.domain)]?.includes(String(w.kind))) continue;
    const existing = await db.prepare("SELECT arm FROM experiment_assignments WHERE experiment_id=? AND subject_key=?").bind(e.id, `${w.kind}:${w.target_key}`).first<Row>();
    const count = Number((await db.prepare("SELECT COUNT(*) n FROM experiment_assignments WHERE experiment_id=?").bind(e.id).first<Row>())?.n ?? 0);
    if (!existing && (count >= Number(e.population_max) || Number(e.used_units) >= Number(e.budget_units))) continue;
    const a = existing ? String(existing.arm) : arm(`${e.id}:${w.kind}:${w.target_key}`);
    const strat = STRATEGIES[String(a === "a" ? e.arm_a : e.arm_b)];
    return { weight: clamp(strat?.weight(w) ?? 1, 0.8, 1.2), experimentId: String(e.id), arm: a };
  }
  return { weight: 1 };
}

/** Records that an item ran under an arm (called by the scheduler when it starts the item). */
export async function assign(experimentId: string, armName: string, w: Row, cost: number) {
  const db = getD1();
  await db.prepare("INSERT OR IGNORE INTO experiment_assignments (id,experiment_id,arm,subject_key,work_item_id) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), experimentId, armName, `${w.kind}:${w.target_key}`, w.id).run();
  await db.prepare("UPDATE strategy_experiments SET used_units=used_units+? WHERE id=?").bind(cost, experimentId).run();
  await db.prepare("UPDATE work_items SET experiment_id=?,experiment_arm=? WHERE id=?").bind(experimentId, armName, w.id).run();
}

/** Evaluates running experiments; stops those that met their stop condition, population or budget. */
export async function evaluateExperiments() {
  const db = getD1(); const out: Row[] = [];
  for (const e of (await db.prepare("SELECT * FROM strategy_experiments WHERE status='running'").all<Row>()).results) {
    const res = await summarize(String(e.id));
    const stop = parse<Row>(e.stop_condition, {});
    const n = Number((await db.prepare("SELECT COUNT(*) n FROM experiment_assignments WHERE experiment_id=?").bind(e.id).first<Row>())?.n ?? 0);
    const ageDays = (Date.now() - new Date(String(e.started_at).replace(" ", "T") + "Z").getTime()) / 86400000;
    const enough = res.a.n >= Number(stop.min_per_arm ?? 10) && res.b.n >= Number(stop.min_per_arm ?? 10);
    const why = enough ? "both arms reached the minimum sample" : n >= Number(e.population_max) ? "population limit reached" : Number(e.used_units) >= Number(e.budget_units) ? "budget spent" : ageDays >= Number(stop.max_days ?? 14) ? "time limit reached" : null;
    if (why) {
      await db.prepare("UPDATE strategy_experiments SET status='complete',result=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").bind(json({ ...res, stopped_because: why }), e.id).run();
      out.push({ id: e.id, stopped: why });
    } else await db.prepare("UPDATE strategy_experiments SET result=? WHERE id=?").bind(json(res), e.id).run();
  }
  return out;
}

/** Per-arm useful-per-cost with a normal-approximation 95% interval on the difference. */
export async function summarize(experimentId: string) {
  const rows = (await getD1().prepare("SELECT arm,outcome,cost FROM experiment_assignments WHERE experiment_id=? AND outcome IS NOT NULL").bind(experimentId).all<Row>()).results;
  const stat = (a: string) => {
    const xs = rows.filter(r => r.arm === a).map(r => Number(r.outcome) / Math.max(0.1, Number(r.cost ?? 1)));
    const n = xs.length, mean = n ? xs.reduce((s, x) => s + x, 0) / n : 0;
    const v = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
    return { n, mean: r3(mean), var: v };
  };
  const a = stat("a"), b = stat("b");
  const se = Math.sqrt((a.n ? a.var / a.n : 0) + (b.n ? b.var / b.n : 0));
  const diff = r3(a.mean - b.mean);
  const conclusive = a.n >= MIN_ARM_N && b.n >= MIN_ARM_N && se > 0 && Math.abs(diff) > 1.96 * se;
  return { a: { n: a.n, useful_per_cost: a.mean }, b: { n: b.n, useful_per_cost: b.mean }, difference: diff, ci95: [r3(diff - 1.96 * se), r3(diff + 1.96 * se)],
    verdict: conclusive ? (diff > 0 ? "arm A better" : "arm B better") : "no clear difference" };
}

export async function stopExperiment(id: string) {
  const res = await summarize(id);
  const r = await getD1().prepare("UPDATE strategy_experiments SET status='stopped',result=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'").bind(json({ ...res, stopped_because: "stopped by a person" }), id).run();
  return (r.meta?.changes ?? 0) === 1;
}
