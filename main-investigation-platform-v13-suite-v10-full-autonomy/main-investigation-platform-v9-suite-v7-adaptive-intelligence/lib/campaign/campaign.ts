/**
 * Campaign orchestration: Discover -> Prioritize -> Investigate -> Evaluate ->
 * Learn -> Reprioritize, one leased tick at a time.
 *
 * A tick runs the roles in a fixed order and each writes a typed artifact:
 *   Analyst     evaluates finished work against observed data (runs, pivots,
 *               human decisions): hypotheses, experience, costs, member states
 *   Researcher  associates new members through observable links; summarises the graph
 *   Strategist  proposes disprovable hypotheses (deterministic; a model may add, validated)
 *   Planner     picks the best open opportunity (deterministic; a model may choose
 *               among near-ties by id)
 *   Reviewer    challenges the pick; a rejection prevents it
 *   Executor    runs approved work through existing v3 machinery only:
 *               the v3 investigator (startRun/tick) or a typed Site Finder job
 *
 * AI proposes. The deterministic platform validates. Existing modules execute.
 * Evidence proves. Nothing here writes evidence, relationships or provenance;
 * the campaign graph is derived from observed rows (graph.ts).
 *
 * Human checkpoints stay per investigation: a v3 run that needs a person moves
 * its member to `waiting_human` and frees the slot, so only that work pauses.
 *
 * Crash safety: every tick is leased; each opportunity moves open -> executing
 * with its run/job id recorded in the same step, and re-scoring never touches
 * executing rows. A restart re-reads state from the tables and continues.
 */
import { getD1, json, now } from "../platform";
import { enqueueJob } from "../jobs";
import { timeline } from "../orchestrator";
import { AUTOMATION_POLICY } from "../agent/capabilities";
import { associate, graphSummary, seedCampaign, domainOf } from "./graph";
import { deterministicHypotheses, evaluatePivot, applyHumanContradictions, splitTarget } from "./hypotheses";
import { prioritize, contextFor } from "./priority";
import { review } from "./reviewer";
import { recordExperience } from "./experience";
import { planChoice, modelHypotheses, modelCritique, writeArtifact } from "./roles";
import { selectProvider } from "../ai/models";
import { assertExecutionAllowed } from "../ops/guard";

type Row = Record<string, unknown>;
export type CampaignStatus = "RUNNING" | "PAUSED" | "STOPPED" | "COMPLETE" | "BUDGET_EXHAUSTED";
export const BUDGET_FIELDS = ["max_investigations", "max_parallel", "max_discovery_requests", "max_module_jobs", "max_model_calls", "max_model_tokens", "max_duration_seconds"] as const;
export type Budgets = Partial<Record<(typeof BUDGET_FIELDS)[number], number>>;
const BUDGET_LIMITS: Record<(typeof BUDGET_FIELDS)[number], [number, number]> = { max_investigations: [0, 500], max_parallel: [1, 20], max_discovery_requests: [0, 100], max_module_jobs: [0, 2000], max_model_calls: [0, 2000], max_model_tokens: [0, 5_000_000], max_duration_seconds: [60, 30 * 86400] };
const TICK_SECONDS = 60, MAX_PICKS_PER_TICK = 8;
function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }
const ts = (v: unknown) => new Date(String(v).replace(" ", "T") + (/[Z]$|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z")).getTime();

async function load(id: string) { return getD1().prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<Row>(); }

export function cleanBudgets(input: unknown): Budgets {
  const out: Budgets = {}; const src = (input && typeof input === "object" ? input : {}) as Row;
  for (const k of BUDGET_FIELDS) if (src[k] !== undefined) {
    const n = Math.floor(Number(src[k])); const [lo, hi] = BUDGET_LIMITS[k];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`BUDGET_INVALID:${k}`);
    out[k] = n;
  }
  return out;
}

export async function createCampaign(input: { seed_domain: string; title?: string; budgets?: Budgets; auto_associate?: boolean; started_by?: string }) {
  assertExecutionAllowed("campaign.create");
  const db = getD1(); const budgets = cleanBudgets(input.budgets ?? {});
  const seed = domainOf(input.seed_domain);
  if (!seed) throw new Error("SEED_REQUIRED");
  if (!(await db.prepare("SELECT 1 FROM inbox_candidates WHERE canonical_domain=?").bind(seed).first())) throw new Error("SEED_NOT_FOUND");
  const id = crypto.randomUUID();
  const duration = budgets.max_duration_seconds ?? 86400;
  const cols = Object.keys(budgets); const vals = Object.values(budgets);
  await db.prepare(`INSERT INTO campaigns (id,title,status,headline,auto_associate,deadline_at${cols.map(c => `,${c}`).join("")}) VALUES (?,?,'RUNNING',?,?,?${cols.map(() => ",?").join("")})`)
    .bind(id, (input.title ?? `Campaign around ${seed}`).slice(0, 200), "Mapping related sites…", input.auto_associate === false ? 0 : 1, new Date(Date.now() + duration * 1000).toISOString(), ...vals).run();
  await seedCampaign(id, seed);
  await timelineFor(id, "campaign.started", `Campaign started around ${seed}`, `Started by ${input.started_by ?? "analyst"}.`);
  return load(id);
}

async function timelineFor(campaignId: string, eventType: string, title: string, detail = "") {
  const seed = await getD1().prepare("SELECT c.investigation_id FROM campaign_members m JOIN inbox_candidates c ON c.canonical_domain=m.domain WHERE m.campaign_id=? AND m.role='seed'").bind(campaignId).first<Row>();
  try { await timeline({ investigationId: seed?.investigation_id ? String(seed.investigation_id) : null, sourceModule: "platform", eventType, title, detail, data: { campaign_id: campaignId } }); } catch { /* timeline is informational */ }
}

/** Human controls. Pause/stop also pause/stop the campaign's own investigator runs; nothing else. */
export async function control(id: string, action: "pause" | "resume" | "stop") {
  const db = getD1(); const c = await load(id);
  if (!c) throw new Error("CAMPAIGN_NOT_FOUND");
  const owner = `campaign:${id}`;
  if (action === "pause") {
    if (c.status !== "RUNNING") return c;
    await db.batch([
      db.prepare("UPDATE campaigns SET status='PAUSED',headline='Paused by you',lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id),
      db.prepare("UPDATE agent_runs SET status='PAUSED',updated_at=CURRENT_TIMESTAMP WHERE started_by=? AND status IN ('RUNNING','WAITING_FOR_MODULE')").bind(owner),
    ]);
  } else if (action === "resume") {
    if (!["PAUSED", "BUDGET_EXHAUSTED"].includes(String(c.status))) return c;
    await db.batch([
      db.prepare("UPDATE campaigns SET status='RUNNING',stop_reason=NULL,finished_at=NULL,headline='Resuming…',next_tick_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id),
      db.prepare("UPDATE agent_runs SET status='RUNNING',next_run_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE started_by=? AND status='PAUSED'").bind(owner),
    ]);
  } else {
    if (["STOPPED", "COMPLETE"].includes(String(c.status))) return c;
    await db.batch([
      db.prepare("UPDATE campaigns SET status='STOPPED',stop_reason='Stopped by you',headline='Stopped by you',finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id),
      db.prepare("UPDATE agent_runs SET status='STOPPED',stop_reason='Campaign stopped',finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE started_by=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED')").bind(owner),
      db.prepare("UPDATE jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE status IN ('pending','awaiting-approval') AND job_type='FIND_RELATED_SITES' AND instr(payload, ?) > 0").bind(`"campaign_id":"${id}"`),
      db.prepare("UPDATE opportunities SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND status IN ('open','executing')").bind(id),
    ]);
  }
  await timelineFor(id, `campaign.${action}`, `Campaign ${action === "stop" ? "stopped" : action === "pause" ? "paused" : "resumed"}`);
  return load(id);
}

export async function setBudget(id: string, input: unknown) {
  const b = cleanBudgets(input); const c = await load(id);
  if (!c) throw new Error("CAMPAIGN_NOT_FOUND");
  const cols = Object.keys(b);
  if (!cols.length) return c;
  const extra = b.max_duration_seconds ? ",deadline_at=?" : "";
  const deadline = b.max_duration_seconds ? [new Date(ts(c.created_at) + b.max_duration_seconds * 1000).toISOString()] : [];
  await getD1().prepare(`UPDATE campaigns SET ${cols.map(k => `${k}=?`).join(",")}${extra},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(b), ...deadline, id).run();
  // Raising a spent budget lets the campaign continue; it never restarts a stopped one.
  if (c.status === "BUDGET_EXHAUSTED") await control(id, "resume");
  return load(id);
}

/** Sets a campaign's next tick to now when something it depends on changed. */
export async function wakeCampaigns(opts: { investigationId?: string | null; campaignId?: string | null; domain?: string | null }) {
  const db = getD1();
  // A person's decision on a site is new information: it wakes running campaigns and re-opens
  // completed ones for re-evaluation (they complete again at once if nothing changed).
  if (opts.domain) await db.prepare("UPDATE campaigns SET status=CASE WHEN status='COMPLETE' THEN 'RUNNING' ELSE status END,finished_at=CASE WHEN status='COMPLETE' THEN NULL ELSE finished_at END,next_tick_at=CURRENT_TIMESTAMP WHERE status IN ('RUNNING','COMPLETE') AND id IN (SELECT campaign_id FROM campaign_members WHERE domain=?)").bind(domainOf(opts.domain)).run();
  if (opts.campaignId) await db.prepare("UPDATE campaigns SET next_tick_at=CURRENT_TIMESTAMP WHERE id=? AND status='RUNNING'").bind(opts.campaignId).run();
  if (opts.investigationId) await db.prepare("UPDATE campaigns SET next_tick_at=CURRENT_TIMESTAMP WHERE status='RUNNING' AND id IN (SELECT m.campaign_id FROM campaign_members m LEFT JOIN investigations i ON i.id=m.investigation_id WHERE m.investigation_id=? OR i.external_id=?)").bind(opts.investigationId, opts.investigationId).run();
}

/**
 * Crash recovery: work that was started but whose opportunity was not yet
 * marked executing (the process died between the two writes) is adopted, never
 * started a second time and never rejected as "already attempted".
 */
async function recoverOrphans(cid: string) {
  const db = getD1(); let adopted = 0;
  for (const op of (await db.prepare("SELECT o.id,o.investigation_id,r.id run_id FROM opportunities o JOIN agent_runs r ON r.investigation_id=o.investigation_id AND r.started_by=? WHERE o.campaign_id=? AND o.kind='investigate_candidate' AND o.status='open'").bind(`campaign:${cid}`, cid).all<Row>()).results) {
    const r = await db.prepare("UPDATE opportunities SET status='executing',run_id=?,result=json_object('context','investigate','recovered',1),updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(op.run_id, op.id).run();
    if (r.meta?.changes) { adopted++; await db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'investigation',1,0,NULL,?)").bind(crypto.randomUUID(), cid, String(op.run_id)).run(); }
  }
  for (const op of (await db.prepare("SELECT o.id,j.id job_id FROM opportunities o JOIN jobs j ON j.job_type='FIND_RELATED_SITES' AND instr(j.payload, '\"opportunity_id\":\"' || o.id || '\"') > 0 WHERE o.campaign_id=? AND o.kind='test_hypothesis' AND o.status='open'").bind(cid).all<Row>()).results) {
    const known = (await db.prepare("SELECT domain FROM campaign_members WHERE campaign_id=?").bind(cid).all<{ domain: string }>()).results.map(m => m.domain);
    const r = await db.prepare("UPDATE opportunities SET status='executing',job_id=?,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(op.job_id, json({ context: "pivot", known, recovered: 1 }), op.id).run();
    if (r.meta?.changes) { adopted++; await db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'discovery_request',1,0,'site_finder',?)").bind(crypto.randomUUID(), cid, String(op.job_id)).run(); }
  }
  return adopted;
}

/** Analyst: evaluate everything that finished since the last tick. */
async function analyst(c: Row, tickNo: number) {
  const db = getD1(); const cid = String(c.id);
  let runsFinished = 0, pivots = 0, hypChanged = 0, exp = 0;
  const tryExp = async (e: Parameters<typeof recordExperience>[0]) => { try { if (await recordExperience(e)) exp++; } catch { /* unverifiable experience is refused, by design */ } };

  for (const op of (await db.prepare("SELECT * FROM opportunities WHERE campaign_id=? AND status='executing'").bind(cid).all<Row>()).results) {
    const r = parse<Row>(op.result, {});
    if (op.kind === "investigate_candidate" && op.run_id) {
      const run = await db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(op.run_id).first<Row>();
      const status = String(run?.status ?? "FAILED");
      if (status === "WAITING_FOR_HUMAN") { await db.prepare("UPDATE campaign_members SET state='waiting_human',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain=?").bind(cid, op.target_key).run(); continue; }
      if (["RUNNING", "WAITING_FOR_MODULE", "PAUSED"].includes(status)) { await db.prepare("UPDATE campaign_members SET state='investigating',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain=? AND state<>'investigating'").bind(cid, op.target_key).run(); continue; }
      const inv = String(op.investigation_id);
      const meaningful = Number((await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator')").bind(inv).first<{ n: number }>())?.n ?? 0);
      const wallets = Number((await db.prepare("SELECT COUNT(DISTINCT ie.entity_id) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator')").bind(inv).first<{ n: number }>())?.n ?? 0);
      const dead = await db.prepare("SELECT 1 FROM finder_outcomes WHERE investigation_id=? AND outcome='dead_site'").bind(inv).first();
      const useful = dead ? 0 : wallets > 0 ? 1 : meaningful > 0 ? 0.5 : 0;
      await db.batch([
        db.prepare("UPDATE opportunities SET status='done',result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json({ ...r, run_status: status, meaningful_evidence: meaningful, wallets, dead: Boolean(dead), useful }), op.id),
        db.prepare("UPDATE campaign_members SET state='done',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain=?").bind(cid, op.target_key),
      ]);
      await tryExp({ campaignId: cid, context: String(r.context ?? "investigate"), action: "investigate_candidate", expected: Number(parse<Row>(op.factors, {}).info_gain ?? 0.5), actual: wallets + meaningful, cost: Number(run?.used_module_calls ?? 0) + 1, useful, basis: "observed", sourceRef: String(op.run_id) });
      runsFinished++;
    } else if (op.kind === "test_hypothesis" && op.job_id) {
      const job = await db.prepare("SELECT * FROM jobs WHERE id=?").bind(op.job_id).first<Row>();
      if (!job || !["completed", "failed", "cancelled", "needs-review"].includes(String(job.status))) continue;
      const known = new Set(parse<string[]>(r.known, []));
      const ev = await evaluatePivot(String(op.hypothesis_id), job, known);
      pivots++; if (ev && ev.status !== "proposed") hypChanged++;
      const verified = ev?.verified ?? [];
      for (const d of verified) {
        const cand = await db.prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(d).first<Row>();
        if (cand) await db.prepare("INSERT OR IGNORE INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,'member','pending',?)")
          .bind(crypto.randomUUID(), cid, cand.investigation_id ?? null, cand.id, d, `found by testing: ${String(op.target_key).slice(0, 120)}`).run();
      }
      await db.prepare("UPDATE opportunities SET status='done',result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json({ ...r, known: undefined, job_status: job.status, verified, verified_count: verified.length, claimed: ev?.claimed ?? 0, saturated: ev?.saturated ?? false, hypothesis_status: ev?.status ?? null }), op.id).run();
      if (job.status === "completed") await tryExp({ campaignId: cid, context: String(r.context ?? "pivot"), action: `pivot:${splitTarget(String(op.target_key)).type}`, expected: Number(parse<Row>(op.factors, {}).info_gain ?? 0.5), actual: verified.length, cost: 1, useful: Math.min(1, verified.length / 2), basis: "observed", sourceRef: String(op.job_id) });
    }
  }
  // Human decisions on members outrank everything the system concluded.
  for (const d of (await db.prepare("SELECT d.id,d.decision,d.reason,d.canonical_domain,m.state,o.result,o.run_id FROM inbox_decisions d JOIN campaign_members m ON m.domain=d.canonical_domain AND m.campaign_id=? LEFT JOIN opportunities o ON o.campaign_id=m.campaign_id AND o.fingerprint='investigate:' || m.domain").bind(cid).all<Row>()).results) {
    if (d.decision === "skip" && d.state === "pending") {
      await db.batch([
        db.prepare("UPDATE campaign_members SET state='suppressed',reason=?,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain=?").bind(`You skipped it${d.reason ? ` (${d.reason})` : ""}.`, cid, d.canonical_domain),
        db.prepare("UPDATE opportunities SET status='suppressed',reason='You skipped this site.',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND fingerprint=? AND status='open'").bind(cid, `investigate:${d.canonical_domain}`),
      ]);
    }
    if (d.run_id) await tryExp({ campaignId: cid, context: String(parse<Row>(d.result, {}).context ?? "investigate"), action: "investigate_candidate", expected: 0.5, actual: d.decision === "useful" ? 1 : 0, cost: 0, useful: d.decision === "useful" ? 1 : 0, basis: "human", sourceRef: String(d.id) });
  }
  hypChanged += await applyHumanContradictions(cid);
  const waiting = Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=? AND state='waiting_human'").bind(cid).first<{ n: number }>())?.n ?? 0);
  await writeArtifact(cid, tickNo, "analysis", { runs_finished: runsFinished, pivots_evaluated: pivots, hypotheses_changed: hypChanged, experience_recorded: exp, members_waiting_human: waiting });
}

/** Cost accounting from the authoritative tables; `used_*` counters are recomputed, never trusted. */
async function syncCosts(cid: string) {
  const db = getD1(); const owner = `campaign:${cid}`;
  await db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) SELECT lower(hex(randomblob(16))),?,'module_job',1,0,j.target_module,j.id FROM jobs j JOIN agent_runs r ON r.investigation_id=j.investigation_id WHERE r.started_by=? AND j.created_at>=r.started_at AND j.job_type IN ('INVESTIGATE_SITE','ANALYZE_WALLET','RECHECK_SITE')").bind(cid, owner).run();
  await db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) SELECT lower(hex(randomblob(16))),?,'model_call',1,mc.prompt_tokens+mc.completion_tokens,mc.provider || ':' || mc.model || ':investigator',mc.id FROM agent_model_calls mc JOIN agent_runs r ON r.id=mc.run_id WHERE r.started_by=?").bind(cid, owner).run();
  const t = await db.prepare("SELECT SUM(CASE WHEN kind='module_job' THEN units ELSE 0 END) jobs,SUM(CASE WHEN kind='model_call' THEN units ELSE 0 END) calls,SUM(CASE WHEN kind='model_call' THEN tokens ELSE 0 END) tokens,SUM(CASE WHEN kind='discovery_request' THEN units ELSE 0 END) disc,SUM(CASE WHEN kind='investigation' THEN units ELSE 0 END) inv FROM campaign_costs WHERE campaign_id=?").bind(cid).first<Row>();
  await db.prepare("UPDATE campaigns SET used_module_jobs=?,used_model_calls=?,used_model_tokens=?,used_discovery_requests=?,used_investigations=? WHERE id=?")
    .bind(Number(t?.jobs ?? 0), Number(t?.calls ?? 0), Number(t?.tokens ?? 0), Number(t?.disc ?? 0), Number(t?.inv ?? 0), cid).run();
}

async function setting(key: string, fallback: string) {
  try { return (await getD1().prepare("SELECT value FROM agent_settings WHERE key=?").bind(key).first<{ value: string }>())?.value ?? fallback; } catch { return fallback; }
}

/** What a newly started investigation may spend: the campaign's unreserved remainder, split across free slots. */
async function runAllowance(c: Row) {
  const db = getD1(); const owner = `campaign:${c.id}`;
  const reserved = await db.prepare("SELECT COALESCE(SUM(MAX(0,max_model_calls-used_model_calls)),0) calls, COALESCE(SUM(MAX(0,max_model_tokens-used_model_tokens)),0) tokens, COALESCE(SUM(MAX(0,max_module_calls-used_module_calls)),0) jobs FROM agent_runs WHERE started_by=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED')").bind(owner).first<Row>();
  const active = Number((await db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE started_by=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED')").bind(owner).first<{ n: number }>())?.n ?? 0);
  const slots = Math.max(1, Number(c.max_parallel) - active);
  const left = (max: string, used: string, r: string) => Math.max(0, Math.floor((Number(c[max]) - Number(c[used]) - Number(reserved?.[r] ?? 0)) / slots));
  return { calls: left("max_model_calls", "used_model_calls", "calls"), tokens: left("max_model_tokens", "used_model_tokens", "tokens"), jobs: left("max_module_jobs", "used_module_jobs", "jobs") };
}

/** Executor: runs one approved opportunity through existing machinery. */
async function execute(c: Row, op: Row, context: string): Promise<string> {
  assertExecutionAllowed(`campaign.execute:${String(op.kind)}`);
  const db = getD1(); const cid = String(c.id);
  if (op.kind === "investigate_candidate") {
    const { startRun, tick } = await import("../agent/runner");
    const run = await startRun(String(op.investigation_id), `campaign:${cid}`);
    if (!run) { await db.prepare("UPDATE opportunities SET status='blocked',reason='Investigation record not found.',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(op.id).run(); return ""; }
    // Discovery is coordinated at campaign level; the per-site investigator does not expand on its own.
    // The run's own model and module budgets are carved out of what the campaign has left, so the
    // campaign's budgets bound everything its investigations do.
    const share = await runAllowance(c);
    await db.batch([
      db.prepare("UPDATE agent_runs SET max_discovery_expansions=0,max_model_calls=MIN(max_model_calls,?),max_model_tokens=MIN(max_model_tokens,?),max_module_calls=MIN(max_module_calls,?) WHERE id=? AND started_by=?").bind(share.calls, share.tokens, share.jobs, run.id, `campaign:${cid}`),
      db.prepare("UPDATE opportunities SET status='executing',run_id=?,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(run.id, json({ context }), op.id),
      db.prepare("UPDATE campaign_members SET state='investigating',investigation_id=COALESCE(investigation_id,?),updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain=?").bind(op.investigation_id, cid, op.target_key),
      db.prepare("UPDATE inbox_candidates SET status='campaign',progress_state='campaign_investigating',updated_at=CURRENT_TIMESTAMP WHERE canonical_domain=? AND status IN ('ready','presented','suppressed')").bind(op.target_key),
      db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'investigation',1,0,NULL,?)").bind(crypto.randomUUID(), cid, String(run.id)),
      db.prepare("UPDATE campaigns SET used_investigations=used_investigations+1 WHERE id=?").bind(cid),
    ]);
    const { spend } = await import("../ops/budgets");
    await spend("investigations", 1, `run:${run.id}`, ["module:site_investigator"]);
    if (run.status === "RUNNING") await tick(String(run.id));
    return `Investigating ${op.target_key}`;
  }
  if (op.kind === "test_hypothesis") {
    const h = await db.prepare("SELECT * FROM hypotheses WHERE id=?").bind(op.hypothesis_id).first<Row>();
    const { type, value } = splitTarget(String(op.target_key));
    const known = (await db.prepare("SELECT domain FROM campaign_members WHERE campaign_id=?").bind(cid).all<{ domain: string }>()).results.map(m => m.domain);
    const q = await enqueueJob({ job_type: "FIND_RELATED_SITES", investigation_id: null, target_module: "site_finder", created_by_module: "platform", priority: 55,
      trigger_reason: `Campaign hypothesis test: ${String(h?.statement ?? "").slice(0, 160)}`, dedupe_scope: `campaign:${cid}:${op.target_key}`,
      payload: { pivot: { kind: type, value }, campaign_id: cid, hypothesis_id: op.hypothesis_id, opportunity_id: op.id, context, exclude: known.slice(0, 100), requested: 10, reason: "campaign_hypothesis_test", automation_policy: AUTOMATION_POLICY } });
    const jobId = String((q.job as Row).id);
    await db.batch([
      db.prepare("UPDATE opportunities SET status='executing',job_id=?,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(jobId, json({ context, known }), op.id),
      db.prepare("UPDATE hypotheses SET status='testing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='proposed'").bind(op.hypothesis_id),
      db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'discovery_request',1,0,'site_finder',?)").bind(crypto.randomUUID(), cid, jobId),
      db.prepare("UPDATE campaigns SET used_discovery_requests=used_discovery_requests+1 WHERE id=?").bind(cid),
    ]);
    const { spend } = await import("../ops/budgets");
    await spend("discovery_requests", 1, `job:${jobId}`, ["module:site_finder"]);
    const label = type === "kit" ? "kit/template" : type === "wallet" ? "wallet" : type;
    return `Checking whether more sites share this ${label}`;
  }
  return "";
}

/** One leased campaign tick. */
export async function tickCampaign(id: string, owner = crypto.randomUUID()): Promise<{ status: CampaignStatus; headline: string; executed: string[] }> {
  const db = getD1();
  const lease = new Date(Date.now() + 120000).toISOString();
  const claimed = await db.prepare("UPDATE campaigns SET lease_owner=?,lease_until=?,ticks=ticks+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='RUNNING' AND (lease_until IS NULL OR lease_until<?)").bind(owner, lease, id, now()).run();
  let c = await load(id);
  if (!c) throw new Error("CAMPAIGN_NOT_FOUND");
  if ((claimed.meta?.changes ?? 0) !== 1) return { status: c.status as CampaignStatus, headline: String(c.headline), executed: [] };
  const cid = id, tickNo = Number(c.ticks);
  const executed: string[] = [];
  const finish = async (status: CampaignStatus, headline: string, why = "") => {
    await db.prepare("UPDATE campaigns SET status=?,stop_reason=?,headline=?,why=?,finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind(status, headline, headline, why, cid, owner).run();
    await timelineFor(cid, `campaign.${status.toLowerCase()}`, headline, why);
    return { status, headline, executed };
  };
  try {
    // Analyst first: everything that finished changes what is worth doing next.
    await recoverOrphans(cid);
    await analyst(c, tickNo);
    await syncCosts(cid);
    c = (await load(cid))!;
    if (ts(c.deadline_at) < Date.now()) return await finish("BUDGET_EXHAUSTED", "Time budget reached.", "The campaign's duration budget ran out; raise it to continue.");

    // Researcher.
    const before = Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=?").bind(cid).first<{ n: number }>())?.n ?? 0);
    if (Number(c.auto_associate)) await associate(cid);
    const members = Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=?").bind(cid).first<{ n: number }>())?.n ?? 0);
    const { summary, edges } = await graphSummary(cid);
    const lastBrief = await db.prepare("SELECT body FROM campaign_artifacts WHERE campaign_id=? AND kind='brief' ORDER BY tick DESC, created_at DESC LIMIT 1").bind(cid).first<Row>();
    const grew = !lastBrief || Number(parse<Row>(lastBrief.body, {}).edges ?? 0) !== edges.length;
    await writeArtifact(cid, tickNo, "brief", { members, edges: edges.length, new_members: members - before, repeated_indicators: summary.repeated_indicators.length, recurring_wallets: summary.recurring_wallets.length, convergence: summary.convergence.length, unexplored_hubs: summary.unexplored_hubs.map(h => h.key).slice(0, 10), isolated_claims: summary.isolated_claims.length });

    // Discovery Strategist.
    const created = await deterministicHypotheses(cid, summary);
    let mp = { proposed: 0, rejected: [] as string[], created: [] as string[] };
    if (grew && selectProvider().provider && (await setting("campaign_model_strategist", "true")) === "true") mp = await modelHypotheses(cid, summary);
    await writeArtifact(cid, tickNo, "pivots", { created: [...created, ...mp.created], model_proposed: mp.proposed, model_rejected: mp.rejected });

    // Priority engine, then Planner -> Reviewer -> Executor while capacity remains.
    await prioritize(c, summary, edges);
    await recoverOrphans(cid);                        // work started before a crash is adopted, not re-reviewed
    let queue = (await db.prepare("SELECT * FROM opportunities WHERE campaign_id=? AND status='open' ORDER BY priority DESC, created_at ASC, id ASC").bind(cid).all<Row>()).results;
    const active = async () => Number((await db.prepare("SELECT (SELECT COUNT(*) FROM campaign_members WHERE campaign_id=? AND state='investigating') + (SELECT COUNT(*) FROM opportunities WHERE campaign_id=? AND kind='test_hypothesis' AND status='executing') n").bind(cid, cid).first<{ n: number }>())?.n ?? 0);
    let capacity = Number(c.max_parallel) - await active();
    let picks = 0, usedModelPlanner = false, lastWhy = "";
    const modelCritic = (await setting("campaign_model_reviewer", "false")) === "true";
    while (capacity > 0 && queue.length && picks < MAX_PICKS_PER_TICK) {
      picks++;
      c = (await load(cid))!;
      const choice = usedModelPlanner ? { op: queue[0], chosenBy: "deterministic" as const, note: undefined } : await planChoice(cid, queue);
      usedModelPlanner = true;                           // at most one planner model call per tick
      const op = choice.op;
      await writeArtifact(cid, tickNo, "proposal", { opportunity_id: String(op.id), kind: String(op.kind), target: String(op.target_key), priority: Number(op.priority), chosen_by: choice.chosenBy, alternatives: queue.slice(0, 4).filter(o => o.id !== op.id).map(o => String(o.id)), ...(choice.note ? { model_note: choice.note } : {}) });
      const rev = await review(c, op, queue);
      let modelAdded: string | undefined;
      if (rev.verdict === "approve" && modelCritic) {
        const code = await modelCritique(cid, op, rev.checks);
        if (code) { rev.verdict = "reject"; rev.reasons.push(`model reviewer: ${code}`); modelAdded = code; }
      }
      await writeArtifact(cid, tickNo, "review", { opportunity_id: rev.opportunity_id, verdict: rev.verdict, reasons: rev.reasons, checks: rev.checks, ...(modelAdded ? { model_added: modelAdded } : {}) });
      queue = queue.filter(o => o.id !== op.id);
      if (rev.verdict === "reject") {
        await db.prepare("UPDATE opportunities SET status='rejected',reason=?,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(`Reviewer: ${rev.reasons[0] ?? "rejected"}`.slice(0, 400), json({ review: rev }), op.id).run();
        continue;
      }
      if (rev.verdict === "defer") {
        await db.prepare("UPDATE opportunities SET result=json_set(CASE WHEN json_valid(result) THEN result ELSE '{}' END,'$.deferred',?),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(rev.reasons.join("; ").slice(0, 300), op.id).run();
        continue;
      }
      const f = parse<Row>(op.factors, {});
      const context = op.kind === "test_hypothesis"
        ? contextFor("pivot", { type: splitTarget(String(op.target_key)).type, hot: summary.convergence.length > 0 || summary.recurring_wallets.length > 0, big: Number(f.relationship ?? 0) >= 0.5 })
        : contextFor("investigate", { kit: String(op.reason).includes("kit") || Number(f.dup_prob ?? 0) >= 0.3, wallet: Number(f.info_gain ?? 0) >= 0.5, hub: Number(f.relationship ?? 0) >= 0.5 });
      const headline = await execute(c, op, context);
      if (headline) { executed.push(headline); lastWhy = String(op.reason); capacity--; }
    }

    // Status, headline and why, written by software from state.
    await syncCosts(cid);
    c = (await load(cid))!;
    const nActive = await active();
    const waitingHuman = Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=? AND state='waiting_human'").bind(cid).first<{ n: number }>())?.n ?? 0);
    const open = (await db.prepare("SELECT factors,kind FROM opportunities WHERE campaign_id=? AND status='open'").bind(cid).all<Row>()).results;
    if (!nActive && !executed.length) {
      if (!open.length && !waitingHuman) return await finish("COMPLETE", "No more valuable safe work in this campaign.", "Every remaining lead was investigated, found to be a duplicate, saturated, or rejected by review.");
      if (open.length && open.every(o => !Number(parse<Row>(o.factors, {}).budget_ok)) && !waitingHuman) return await finish("BUDGET_EXHAUSTED", "Campaign budget reached.", `${open.length} lead(s) remain; raise the budget to continue.`);
    }
    const headline = executed[0] ?? (waitingHuman && !nActive ? `Waiting for you on ${waitingHuman} site${waitingHuman === 1 ? "" : "s"}` : nActive ? `Waiting for ${nActive} piece${nActive === 1 ? "" : "s"} of module work` : "Re-evaluating leads");
    const why = lastWhy || String(c.why ?? "");
    await db.prepare("UPDATE campaigns SET headline=?,why=?,next_tick_at=datetime('now', ?),lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind(headline, why, `+${TICK_SECONDS} seconds`, cid, owner).run();
    return { status: "RUNNING", headline, executed };
  } catch (error) {
    // Never leave a campaign leased after an error; the next tick retries from table state.
    await db.prepare("UPDATE campaigns SET lease_owner=NULL,lease_until=NULL,headline=?,next_tick_at=datetime('now','+60 seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind("Recovering from an error; will retry.", cid, owner).run();
    throw error;
  }
}

/** Called by worker.scheduled: ticks due campaigns, oldest first. */
export async function tickDueCampaigns(limit = 5) {
  const due = await getD1().prepare("SELECT id FROM campaigns WHERE status='RUNNING' AND next_tick_at<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<?) ORDER BY next_tick_at LIMIT ?").bind(now(), limit).all<{ id: string }>();
  let ticked = 0;
  for (const r of due.results) { try { await tickCampaign(r.id); ticked++; } catch (error) { console.error("campaign tick failed", r.id, error instanceof Error ? error.message : error); } }
  return { ticked };
}
