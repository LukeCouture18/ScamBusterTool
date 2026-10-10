// Main Platform v5 "Autonomous Investigation Operations", end to end through the
// real route handlers, the real scheduler, executor, temporal/gap/contradiction
// engines, the real v3 investigator, v4 campaigns and the real module job
// lifecycle. Synthetic data and scripted/adversarial model providers only; no network.
//
// Acceptance gate (numbers refer to the v5 request's list):
//   A  continuous operation: candidates -> work items -> investigations -> outcomes; learning recorded
//   B  no duplicate scheduled work (lease, fingerprints, one job per item) even with concurrent ticks
//   C  crash recovery: an interrupted tick is adopted, never duplicated; continuous discovery survives restart
//   D  prioritization changes with evidence (duplicate probability, learned outcomes)
//   E  temporal: changes create the right opportunities; unchanged observations create nothing
//   F  evidence gaps drive actions; resolved gaps stop work
//   G  contradictions trigger review (a human task), resolution is recorded
//   H  campaign formation requires graph support; merge/split keep provenance and lineage
//   I  concurrent campaigns run without state leakage
//   J  model routing (tiering, fallback, telemetry) and deterministic fallback without a model
//   K  invalid AI actions and hallucinated evidence stay blocked
//   L  budgets are enforced (global/module/provider) and work waits instead of being dropped
//   M  human checkpoints: waiting_human, one notification, automatic resume
//   N  pause / resume
//   O  experiments stay bounded
//   P  replay and simulation cannot execute anything
//   Q  commands compile into typed intents and cannot bypass policy
//   R  notifications are deduplicated and routine work never notifies; failed work is kept
//   S  operator routes and read models
import { importFrom, localPath, runPythonJson } from "./lib/portable.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
const migrations = new URL("../drizzle/", import.meta.url);
for (const name of (await readdir(migrations)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(await readFile(new URL(name, migrations), "utf8"));
const d1 = { prepare(statement) { let params = []; return { bind(...v) { params = v; return this; }, async run() { const r = sql.prepare(statement).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, async first() { return sql.prepare(statement).get(...params) ?? null; }, async all() { return { results: sql.prepare(statement).all(...params) }; } }; }, async batch(q) { sql.exec("BEGIN"); try { const out = []; for (const s of q) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
const one = (q, ...a) => sql.prepare(q).get(...a);
const all = (q, ...a) => sql.prepare(q).all(...a);
const n = (q, ...a) => Number(Object.values(one(q, ...a) ?? { n: 0 })[0] ?? 0);

globalThis.__TEST_ENV = { DB: d1, MODULE_API_KEYS: JSON.stringify({ site_finder: "finder-key", site_investigator: "investigator-key", crypto_wallet_logger: "logger-key", wallet_investigator: "wallet-key" }), AI_PROVIDER: "rules" };
const work = await mkdtemp(join(tmpdir(), "mip-v5-ops-"));
const dumpUi = process.argv.includes("--dump-ui") ? process.argv[process.argv.indexOf("--dump-ui") + 1] : null;
const OPS_ROUTES = ["overview", "queue", "work/[id]", "control", "tick", "intel/graph", "intel/node/[id]", "intel/wallets", "tasks", "contradictions/[id]", "notifications", "commands", "decisions/[id]", "decisions/[id]/replay", "simulations", "experiments", "experiments/[id]", "budgets", "advanced", "campaigns/[id]", "investigations", "discovery", "history", "gaps"];
const routes = ["app/api/v1/modules/[module]/register/route.ts", "app/api/v1/modules/[module]/heartbeat/route.ts", "app/api/v1/ingest/[module]/route.ts", "app/api/v1/modules/[module]/jobs/claim/route.ts", "app/api/v1/modules/[module]/jobs/[id]/route.ts",
  "app/api/v1/inbox/[id]/decision/route.ts", "app/api/v1/inbox/settings/route.ts", "app/api/v1/agent/settings/route.ts", "app/api/v1/campaigns/route.ts", "app/api/v1/investigations/[id]/checkpoints/[cid]/route.ts",
  ...OPS_ROUTES.map(r => `app/api/v1/ops/${r}/route.ts`),
  "lib/ops/scheduler.ts", "lib/ops/workitems.ts", "lib/ops/temporal.ts", "lib/ops/gaps.ts", "lib/ops/contradictions.ts", "lib/ops/formation.ts", "lib/ops/intel.ts", "lib/ops/experiments.ts", "lib/ops/budgets.ts",
  "lib/ops/guard.ts", "lib/ops/decisions.ts", "lib/ops/commands.ts", "lib/ops/simulation.ts", "lib/ops/notifications.ts", "lib/ops/confidence.ts", "lib/ops/health.ts", "lib/ops/learning.ts", "lib/ops/team.ts", "lib/ops/common.ts", "lib/ops/view.ts",
  "lib/campaign/campaign.ts", "lib/campaign/graph.ts", "lib/campaign/view.ts", "lib/campaign/experience.ts", "lib/agent/runner.ts", "lib/ai/models.ts", "lib/ai/router.ts", "lib/jobs.ts"];
let failures = 0; const results = []; const taskSnapshots = [];
const scenario = async (name, fn) => { try { const note = await fn(); results.push({ name, ok: true, note: note ?? "" }); console.log(`  PASS  ${name}${note ? ` — ${note}` : ""}`); } catch (e) { failures++; results.push({ name, ok: false, error: String(e?.message ?? e) }); console.log(`  FAIL  ${name}: ${e instanceof Error ? e.stack : e}`); } };

try {
  await build({ entryPoints: routes, bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: ".", plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=globalThis.__TEST_ENV", loader: "js" })); } }] });
  const L = (p) => importFrom(work, p);
  const R = {}; for (const r of OPS_ROUTES) R[r] = await L(`app/api/v1/ops/${r}/route.js`);
  const register = await L("app/api/v1/modules/[module]/register/route.js"), hbRoute = await L("app/api/v1/modules/[module]/heartbeat/route.js"), ingest = await L("app/api/v1/ingest/[module]/route.js"), claim = await L("app/api/v1/modules/[module]/jobs/claim/route.js"), update = await L("app/api/v1/modules/[module]/jobs/[id]/route.js");
  const inboxDecision = await L("app/api/v1/inbox/[id]/decision/route.js"), inboxSettings = await L("app/api/v1/inbox/settings/route.js"), agentSettings = await L("app/api/v1/agent/settings/route.js"), campaignsRoute = await L("app/api/v1/campaigns/route.js");
  const cpRoute = await L("app/api/v1/investigations/[id]/checkpoints/[cid]/route.js");
  const S = await L("lib/ops/scheduler.js"), W = await L("lib/ops/workitems.js"), TMP = await L("lib/ops/temporal.js"), G = await L("lib/ops/gaps.js"), C = await L("lib/ops/contradictions.js"), F = await L("lib/ops/formation.js"), I = await L("lib/ops/intel.js");
  const X = await L("lib/ops/experiments.js"), B = await L("lib/ops/budgets.js"), GU = await L("lib/ops/guard.js"), D = await L("lib/ops/decisions.js"), CMD = await L("lib/ops/commands.js"), SIM = await L("lib/ops/simulation.js"), NT = await L("lib/ops/notifications.js");
  const CONF = await L("lib/ops/confidence.js"), H = await L("lib/ops/health.js"), LEARN = await L("lib/ops/learning.js"), TEAM = await L("lib/ops/team.js"), COMMON = await L("lib/ops/common.js"), VIEW = await L("lib/ops/view.js");
  const campaign = await L("lib/campaign/campaign.js"), runner = await L("lib/agent/runner.js"), models = await L("lib/ai/models.js"), router = await L("lib/ai/router.js"), jobs = await L("lib/jobs.js");

  const req = (path, data, key, method = "POST") => new Request("http://127.0.0.1" + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const P = (o) => ({ params: Promise.resolve(o) });
  const md5 = (s) => createHash("md5").update(s).digest("hex");

  // Two scripted providers so routing can fall back from one to the other.
  const mkProvider = (name) => { const p = { queue: [], calls: 0, name, configured: () => true, model: (c) => `${name}-${c}`,
    async complete(r) { p.calls++; p.last = r; const next = p.queue.shift(); if (next === undefined) throw new Error(`${name}: no scripted reply (unavailable)`);
      if (next instanceof Error) throw next; return { text: typeof next === "string" ? next : JSON.stringify(next), model: `${name}-${r.modelClass}`, promptTokens: 40, completionTokens: 20 }; } }; return p; };
  const alpha = mkProvider("alpha"), beta = mkProvider("beta");
  models.registerProvider(alpha); models.registerProvider(beta);
  const configureFixtureModels = (chain) => { globalThis.__TEST_ENV.AI_PROVIDER = chain[0] ?? "rules"; globalThis.__TEST_ENV.AI_FALLBACK_PROVIDERS = chain.slice(1).join(","); };

  const MODS = [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]];
  for (const [m, key, caps] of MODS) assert.equal((await register.POST(req(`/api/v1/modules/${m}/register`, { module_version: "5.0.0-test", schema_version: "3.0", capabilities: caps, supported_event_types: [] }, key), P({ module: m }))).status, 200);
  const offline = new Set();
  const heartbeat = async () => { for (const [m, key, caps] of MODS) if (!offline.has(m)) assert.equal((await hbRoute.POST(req("/x", { module_version: "5.0.0-test", schema_version: "3.0", status: "idle", capabilities: caps }, key), P({ module: m }))).status, 200); };
  await inboxSettings.PATCH(req("/api/v1/inbox/settings", { investigate_on_useful: false, find_related_on_useful: false }, undefined, "PATCH"));
  await agentSettings.PATCH(req("/api/v1/agent/settings", { auto_start_on_useful: false }, undefined, "PATCH"));
  const nextMinute = () => sql.exec("DELETE FROM rate_limit_windows");

  // ---------------------------------------------------------------- world
  const template = runPythonJson(localPath("./finder-v2-batches.py", import.meta.url)).batches[0];
  const tDomain = template.records.sites[0].canonical_key, tHash = template.records.sites[0].external_id.split(":").pop();
  let batchSeq = 0;
  async function site(domain, { cluster, keys = [], wallets = [], score = 0.9, extra = {} } = {}) {
    if (Number(one("SELECT COALESCE(MAX(request_count),0) n FROM rate_limit_windows").n ?? 0) > 60) nextMinute();
    const records = JSON.parse(JSON.stringify(template.records).split(tDomain).join(domain).split(tHash).join(md5(domain)));
    Object.assign(records.sites[0].inbox, { cluster_key: cluster ?? `c:${domain}`, keys, wallets, worth_checking: score, related_domains: [], ...extra });
    records.sites[0].confidence = score; records.sites[0].triage.confidence = score;
    const r = await ingest.POST(req("/api/v1/ingest/site_finder", { schema_version: "3.0", batch_id: `v5:${domain}:${++batchSeq}`, sent_at: new Date().toISOString(), records }, "finder-key"), P({ module: "site_finder" }));
    assert.equal(r.status, 202, await r.clone().text());
    return one("SELECT * FROM inbox_candidates WHERE canonical_domain=?", domain);
  }
  const siPlan = new Map();
  const siTemplate = runPythonJson(localPath("./site-bridge-synthetic.py", import.meta.url), { env: { MIP_BATCH_JSON: "1" } }).batch;
  const siWallet = siTemplate.records.wallets[0].address;
  const moduleJobs = [];
  async function runSiteInvestigator() {
    const r = await claim.POST(req("/api/v1/modules/site_investigator/jobs/claim", {}, "investigator-key"), P({ module: "site_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    moduleJobs.push(job);
    const inv = one("SELECT i.external_id, c.canonical_domain FROM investigations i LEFT JOIN inbox_candidates c ON c.investigation_id=i.id WHERE i.id=?", job.investigation_id);
    const plan = siPlan.get(inv.canonical_domain) ?? { wallet: null };
    if (plan.fail) { const st = (await update.PATCH(req(`/api/v1/modules/site_investigator/jobs/${job.id}`, { action: "fail", error: plan.fail, retry: false }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }))).status; assert.equal(st, 200); return { job }; }
    const text = JSON.stringify(siTemplate).split("synthetic.example").join(inv.canonical_domain).split("_synthetic").join(`_${md5(inv.canonical_domain + job.id).slice(0, 10)}`).split(siWallet).join(plan.wallet ?? siWallet);
    const batch = JSON.parse(text); batch.origin_job_id = job.id; batch.batch_id = `si:${job.id}`; batch.sent_at = new Date().toISOString();
    for (const rows of Object.values(batch.records)) for (const row of rows) row.investigation_id = inv.external_id;
    if (!plan.wallet) {
      batch.records.wallets = []; batch.records.relationships = []; batch.records.deposit_options = []; batch.records.evidence = batch.records.evidence.filter(e => !String(e.evidence_type).includes("wallet"));
      // The site loaded but showed no deposit destination: an ordinary page observation.
      batch.records.evidence.push({ investigation_id: inv.external_id, external_id: `page:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public",
        title: "Landing page", context_text: JSON.stringify({ title: "Welcome", kind: "landing", important_text: "Invest today. Plans from 100 USDT." }), confidence: 0.8, entity: { entity_type: "site", canonical_key: inv.canonical_domain } });
    }
    if (plan.loginWall) batch.records.evidence.push({ investigation_id: inv.external_id, external_id: `login:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public",
      title: "Sign in", context_text: JSON.stringify({ title: "Members area", kind: "login", important_text: "Please sign in to continue to your deposit dashboard. Login required." }), confidence: 0.9, entity: { entity_type: "site", canonical_key: inv.canonical_domain } });
    const ing = await ingest.POST(req("/api/v1/ingest/site_investigator", batch, "investigator-key"), P({ module: "site_investigator" }));
    assert.equal(ing.status, 202, await ing.clone().text());
    await update.PATCH(req(`/api/v1/modules/site_investigator/jobs/${job.id}`, { action: "complete", result: { batch_id: batch.batch_id } }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }));
    return { job, domain: inv.canonical_domain };
  }
  let walletFail = false;
  async function runWalletInvestigator() {
    const r = await claim.POST(req("/api/v1/modules/wallet_investigator/jobs/claim", {}, "wallet-key"), P({ module: "wallet_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    moduleJobs.push(job);
    if (walletFail) { const st = (await update.PATCH(req(`/api/v1/modules/wallet_investigator/jobs/${job.id}`, { action: "fail", error: "chain API unavailable", retry: false }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id }))).status; assert.equal(st, 200); return job; }
    await update.PATCH(req(`/api/v1/modules/wallet_investigator/jobs/${job.id}`, { action: "complete", result: { risk: "high" } }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id }));
    return job;
  }
  let finderPlan = async () => ({ sites: [], result: { new_candidates: [], saturated: true } });
  let discoverPlan = async () => ({ sites: [], result: { delivered: 0 } });
  async function runSiteFinder() {
    const r = await claim.POST(req("/api/v1/modules/site_finder/jobs/claim", {}, "finder-key"), P({ module: "site_finder" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    moduleJobs.push(job);
    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    const out = job.job_type === "DISCOVER_SITES" ? await discoverPlan(payload) : await finderPlan(payload);
    for (const s of out.sites ?? []) await site(s.domain, s);
    await update.PATCH(req(`/api/v1/modules/site_finder/jobs/${job.id}`, { action: "complete", result: out.result }, "finder-key", "PATCH"), P({ module: "site_finder", id: job.id }));
    return job;
  }
  async function workAll() {
    for (let i = 0; i < 40; i++) {
      const a = offline.has("site_investigator") ? null : await runSiteInvestigator(), b = offline.has("wallet_investigator") ? null : await runWalletInvestigator(), c = offline.has("site_finder") ? null : await runSiteFinder();
      for (const r of all("SELECT id FROM agent_runs WHERE status='RUNNING' AND (started_by LIKE 'ops:%' OR started_by LIKE 'campaign:%')")) await runner.tick(r.id);
      if (!a && !b && !c) break;
    }
  }
  const tick = async (opts = {}) => { nextMinute(); await heartbeat(); await COMMON.setState("last_refresh_at", ""); return S.schedulerTick(opts); };
  async function cycle(rounds = 6, stop) { let last; for (let i = 0; i < rounds; i++) { last = await tick(); await workAll(); if (stop && stop()) break; } return last; }
  const wi = (kind, key) => one("SELECT * FROM work_items WHERE kind=? AND target_key=?", kind, key);
  const setState = COMMON.setState;
  const reset = async () => { await setState("scheduler_paused", false); await setState("discovery_paused", false); await setState("discovery_min_priority", 0); configureFixtureModels([]); offline.clear(); };
  const quiesce = async () => { // stop earlier scenarios' leftovers from competing for slots
    sql.exec("UPDATE work_items SET status='cancelled',finished_at=CURRENT_TIMESTAMP WHERE status IN ('queued','deferred','suppressed')");
  };
  // Discovery supply is not what most scenarios test.
  await setState("discovery_target_ready", 0);

  // ======================================================================
  await scenario("A continuous operation: candidates become typed work, real investigations run once, outcomes are learned from observed results", async () => {
    await reset();
    siPlan.set("a-one.test", { wallet: "TWalletAOne000000000000000000000001" });
    siPlan.set("a-two.test", { wallet: null });
    await site("a-one.test", { keys: [["ip", "198.51.100.11"]], wallets: ["TWalletAOne000000000000000000000001"], score: 0.9 });
    await site("a-two.test", { keys: [["ip", "198.51.100.12"]], score: 0.8 });
    await site("a-low.test", { keys: [["ip", "198.51.100.13"]], score: 0.2 });
    const t1 = await tick();
    assert.ok(t1.tick_id && !t1.skipped);
    for (const d of ["a-one.test", "a-two.test"]) assert.ok(wi("investigate_candidate", d), `${d} became a typed work item`);
    assert.equal(wi("investigate_candidate", "a-low.test"), undefined, "a low-scoring candidate below the auto-investigate floor is not queued");
    const w1 = wi("investigate_candidate", "a-one.test");
    assert.ok(["running", "done"].includes(w1.status), `started: ${w1.status}`);
    assert.match(w1.reason, /Site Finder surfaced it|no module has observed the site yet/, "every item says why it exists");
    await cycle(8, () => wi("investigate_candidate", "a-one.test").status === "done" && wi("investigate_candidate", "a-two.test").status === "done");
    const d1 = wi("investigate_candidate", "a-one.test"), d2 = wi("investigate_candidate", "a-two.test");
    assert.equal(d1.status, "done"); assert.equal(d2.status, "done");
    assert.ok(JSON.parse(d1.result).useful >= 1, "a site that showed a wallet was useful");
    assert.ok(JSON.parse(d2.result).useful < 1, "a site without a deposit destination is less useful");
    // Exactly one v3 run and one INVESTIGATE_SITE job per investigated site.
    for (const d of ["a-one.test", "a-two.test"]) {
      const inv = one("SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?", d).investigation_id;
      assert.equal(n("SELECT COUNT(*) n FROM agent_runs WHERE investigation_id=?", inv), 1, `${d}: one investigator run`);
      assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'", inv), 1, `${d}: one site job`);
    }
    // Outcomes were learned with provenance to the work item's event; never from AI self-evaluation.
    const exp = all("SELECT * FROM experience WHERE action='investigate_candidate'");
    assert.ok(exp.length >= 2 && exp.every(e => e.basis === "observed"), "observed outcomes recorded");
    assert.ok(exp.every(e => one("SELECT 1 x FROM work_item_events WHERE id=?", e.source_ref)), "each outcome cites the work item event it came from");
    // The global graph and temporal facets were built from the same observations.
    assert.ok(n("SELECT COUNT(*) n FROM intel_nodes WHERE node_type='domain' AND node_key='a-one.test'") === 1);
    assert.equal(JSON.parse(one("SELECT value FROM entity_facets WHERE subject_key='a-one.test' AND facet='status'").value), "live");
    return `${exp.length} observed outcomes, ${moduleJobs.length} module jobs`;
  });

  // ======================================================================
  await scenario("B no duplicate scheduled work: concurrent ticks share one lease, fingerprints collapse re-proposals, one job per work item", async () => {
    await reset(); await quiesce();
    await site("b-one.test", { keys: [["ip", "198.51.100.21"]], score: 0.85 });
    await site("b-two.test", { keys: [["ip", "198.51.100.22"]], score: 0.84 });
    nextMinute(); await heartbeat(); await setState("last_refresh_at", "");
    const [x, y] = await Promise.all([S.schedulerTick({ owner: "worker-1" }), S.schedulerTick({ owner: "worker-2" })]);
    assert.ok(Boolean(x.skipped) !== Boolean(y.skipped), `exactly one tick ran (${x.skipped ?? "ran"} / ${y.skipped ?? "ran"})`);
    for (let i = 0; i < 3; i++) await W.proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: "b-one.test", source: "discovery", reason: "re-proposed" });
    assert.equal(n("SELECT COUNT(*) n FROM work_items WHERE kind='investigate_candidate' AND target_key='b-one.test'"), 1, "re-proposing is idempotent");
    await cycle(6, () => wi("investigate_candidate", "b-two.test")?.status === "done");
    await tick(); await tick();
    const dupJobs = all("SELECT json_extract(payload,'$.work_item_id') w,COUNT(*) c FROM jobs WHERE json_extract(payload,'$.work_item_id') IS NOT NULL GROUP BY w HAVING c>1");
    assert.deepEqual(dupJobs, [], "no work item ever produced two module jobs");
    const dupRuns = all("SELECT started_by,COUNT(*) c FROM agent_runs WHERE started_by LIKE 'ops:%' GROUP BY started_by HAVING c>1");
    assert.deepEqual(dupRuns, [], "no work item ever started two investigator runs");
    assert.equal(n("SELECT COUNT(*) n FROM (SELECT fingerprint FROM work_items GROUP BY fingerprint HAVING COUNT(*)>1)"), 0);
  });

  // ======================================================================
  await scenario("C crash recovery: an interrupted tick is adopted without duplication; continuous discovery survives a restart", async () => {
    await reset(); await quiesce();
    await setState("discovery_target_ready", 50);
    discoverPlan = async () => ({ sites: [{ domain: "c-found1.test", keys: [["ip", "198.51.100.31"]], score: 0.3 }, { domain: "c-found2.test", keys: [["ip", "198.51.100.32"]], score: 0.3 }], result: { delivered: 2 } });
    // Tick 1 plans and starts a discovery cycle, i.e. enqueues exactly one DISCOVER_SITES job.
    await tick();
    const cyc = one("SELECT * FROM work_items WHERE kind='discovery_cycle' ORDER BY created_at DESC LIMIT 1");
    assert.ok(cyc, "a discovery cycle was scheduled"); assert.equal(cyc.status, "running");
    const jobId = cyc.job_id;
    // Crash: the worker died after the job was created but before the work item recorded it.
    sql.prepare("UPDATE work_items SET job_id=NULL,lease_owner='dead-worker',lease_until=? WHERE id=?").run(new Date(Date.now() - 60000).toISOString(), cyc.id);
    // A stale scheduler lease from the dead worker must not block the next one forever.
    sql.prepare("UPDATE ops_state SET value=? WHERE key='scheduler_lease'").run(JSON.stringify({ owner: "dead-worker", until: new Date(Date.now() - 1000).toISOString() }));
    const t = await tick();
    assert.ok(!t.skipped, "an expired scheduler lease is taken over");
    assert.equal(t.recovered.adopted, 1, "the orphaned work item adopted its existing job");
    assert.equal(one("SELECT job_id FROM work_items WHERE id=?", cyc.id).job_id, jobId, "no second job");
    assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND json_extract(payload,'$.work_item_id')=?", cyc.id), 1);
    await workAll(); await tick();
    assert.equal(one("SELECT status FROM work_items WHERE id=?", cyc.id).status, "done", "the recovered cycle finished");
    assert.ok(one("SELECT 1 x FROM inbox_candidates WHERE canonical_domain='c-found2.test'"), "its discoveries arrived");
    // A crash before any job existed requeues with backoff instead of losing the work.
    const orphan = await W.proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: "no-such-entity", source: "scheduler", reason: "orphan test" });
    sql.prepare("UPDATE work_items SET status='running',attempts=1,lease_owner='dead',lease_until=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), orphan.id);
    await H.recover("test");
    const o = one("SELECT status,not_before,last_error FROM work_items WHERE id=?", orphan.id);
    assert.equal(o.status, "queued"); assert.ok(o.not_before > new Date().toISOString(), "requeued with backoff"); assert.match(o.last_error, /recovered/);
    await setState("discovery_target_ready", 0);
    discoverPlan = async () => ({ sites: [], result: { delivered: 0 } });
  });

  // ======================================================================
  await scenario("D prioritization changes with evidence: a sibling proving the same wallets raises duplicate probability; learned outcomes move priors", async () => {
    await reset(); await quiesce();
    await setState("scheduler_paused", true);                  // score without starting anything
    await site("d-first.test", { cluster: "kit:d", keys: [["ip", "198.51.100.41"]], wallets: ["TWalletDShared00000000000000000001"], score: 0.8 });
    await site("d-second.test", { cluster: "kit:d", keys: [["ip", "198.51.100.42"]], wallets: ["TWalletDShared00000000000000000001"], score: 0.8 });
    const c2 = one("SELECT * FROM inbox_candidates WHERE canonical_domain='d-second.test'");
    const before = S.candidateFactors ? await S.candidateFactors(c2) : null;
    // Evidence arrives: the first site is investigated and shows the shared wallet.
    sql.exec("UPDATE inbox_candidates SET status='completed' WHERE canonical_domain='d-first.test'");
    const after = await S.candidateFactors(one("SELECT * FROM inbox_candidates WHERE canonical_domain='d-second.test'"));
    assert.ok(after.dup_prob > before.dup_prob, `duplicate probability ${before.dup_prob} -> ${after.dup_prob}`);
    const pb = W.priorityOf({ ...before }), pa = W.priorityOf({ ...after });
    assert.ok(pa < pb, `priority falls ${pb} -> ${pa}`);
    // Learned outcomes: a context whose investigations kept being useless lowers previous_outcomes.
    const ctx = "kind=investigate_candidate|campaign=0|gain=hi|source=discovery";
    const p0 = (await LEARN.learnedPrior("investigate_candidate", ctx)).value;
    for (let i = 0; i < 12; i++) {
      const w = await W.proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: `d-useless${i}.test`, source: "discovery", reason: "x" });
      const e = await W.workEvent(w.id, "done");
      await LEARN.recordWorkOutcome({ id: w.id, kind: "investigate_candidate", factors: JSON.stringify({ info_gain: 0.9 }), source: "discovery", campaign_id: null }, { useful: 0, actual: 0, cost: 2, basis: "observed", eventId: e });
    }
    const p1 = (await LEARN.learnedPrior("investigate_candidate", ctx)).value;
    assert.ok(p1 < p0, `learned prior falls with observed useless outcomes ${p0.toFixed(3)} -> ${p1.toFixed(3)}`);
    // AI self-evaluation does not move it.
    const EXP = await L("lib/campaign/experience.js");
    for (let i = 0; i < 10; i++) await EXP.recordExperience({ campaignId: null, context: ctx, action: "investigate_candidate", expected: 0.5, actual: 1, cost: 0, useful: 1, basis: "ai_self", sourceRef: `ai-says-${i}` }).catch(() => null);
    assert.ok(Math.abs((await LEARN.learnedPrior("investigate_candidate", ctx)).value - p1) < 0.005, "a model grading its own work never moves the prior (only time decay does)");
    sql.exec("UPDATE work_items SET status='cancelled' WHERE target_key LIKE 'd-useless%'");
    await setState("scheduler_paused", false);
    return `dup ${before.dup_prob}->${after.dup_prob}, prior ${p0.toFixed(2)}->${p1.toFixed(2)}`;
  });

  // ======================================================================
  await scenario("E temporal: unchanged observations create nothing; real changes create the right opportunities; disappearance cancels work", async () => {
    await reset(); await quiesce();
    const cand = await site("e-site.test", { keys: [["ip", "198.51.100.51"], ["ns", "ns1.e.test"]], score: 0.3 });
    const facetCount = () => n("SELECT COUNT(*) n FROM entity_snapshots WHERE subject_key='e-site.test'");
    const changes = () => n("SELECT COUNT(*) n FROM entity_changes WHERE subject_key='e-site.test'");
    const items = () => n("SELECT COUNT(*) n FROM work_items WHERE target_key IN ('e-site.test','198.51.100.99')");
    const s0 = facetCount(), c0 = changes(), w0 = items();
    // The same observation ten more times: freshness only.
    for (let i = 0; i < 10; i++) await TMP.observeFacet({ subjectType: "domain", subjectKey: "e-site.test", facet: "ip", value: ["198.51.100.51"], sourceTable: "inbox_candidates", sourceRef: cand.id });
    assert.equal(facetCount(), s0, "no new snapshots"); assert.equal(changes(), c0, "no change records"); assert.equal(items(), w0, "no work");
    assert.ok(Number(one("SELECT observations FROM entity_facets WHERE subject_key='e-site.test' AND facet='ip'").observations) >= 10);
    // Hosting moves: a change record, the old hosting link deactivated, and a passive pivot on the new host.
    await I.syncGlobalGraph(500);
    const r = await TMP.observeFacet({ subjectType: "domain", subjectKey: "e-site.test", facet: "ip", value: ["198.51.100.99"], sourceTable: "inbox_candidates", sourceRef: cand.id, observedAt: new Date(Date.now() + 2 * 3600e3).toISOString() });
    assert.equal(r.outcome, "changed"); assert.equal(r.changeKind, "infrastructure_changed");
    assert.ok(wi("inspect_infrastructure", "198.51.100.99"), "new infrastructure becomes an inspect_infrastructure opportunity");
    assert.equal(one("SELECT work_item_id FROM entity_changes WHERE id=?", r.changeId).work_item_id, wi("inspect_infrastructure", "198.51.100.99").id, "the change records the opportunity it created");
    const oldEdge = one("SELECT e.active FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node JOIN intel_nodes x ON x.id=e.dst_node WHERE d.node_key='e-site.test' AND x.node_key='198.51.100.51'");
    assert.equal(Number(oldEdge?.active ?? 0), 0, "the old hosting link no longer counts as a relationship");
    // An investigated site whose deposit page appears: a revisit, and a useful-discovery notification.
    siPlan.set("e-live.test", { wallet: null });
    await site("e-live.test", { keys: [["ip", "198.51.100.52"]], score: 0.9 });
    await cycle(6, () => wi("investigate_candidate", "e-live.test")?.status === "done");
    const r2 = await TMP.observeFacet({ subjectType: "domain", subjectKey: "e-live.test", facet: "deposit_page", value: true, sourceTable: "evidence", sourceRef: "x", observedAt: new Date(Date.now() + 3 * 3600e3).toISOString() });
    assert.equal(r2.changeKind, "deposit_appeared", JSON.stringify({ r2, item: wi("investigate_candidate", "e-live.test"), facets: all("SELECT facet,value FROM entity_facets WHERE subject_key='e-live.test'"), jobs: all("SELECT job_type,status,last_error,result FROM jobs WHERE investigation_id=?", wi("investigate_candidate", "e-live.test").investigation_id), ev: all("SELECT evidence_type,source_module FROM evidence WHERE investigation_id=?", wi("investigate_candidate", "e-live.test").investigation_id), steps: all("SELECT s.kind,s.state,s.capability,s.outcome,s.rationale,s.rejection_reasons FROM agent_steps s WHERE s.run_id=?", wi("investigate_candidate", "e-live.test").run_id), run: one("SELECT * FROM agent_runs WHERE id=?", wi("investigate_candidate", "e-live.test").run_id) }));
    const rv = wi("revisit_changed_site", "e-live.test");
    assert.ok(rv && rv.status === "queued", "deposit page appeared -> revisit queued");
    assert.equal(n("SELECT COUNT(*) n FROM ops_notifications WHERE dedupe_key='change:e-live.test:deposit_appeared'"), 1);
    // The site disappears: queued work on it is cancelled and open gaps become inaccessible.
    await TMP.observeFacet({ subjectType: "domain", subjectKey: "e-live.test", facet: "status", value: "dead", sourceTable: "evidence", sourceRef: "y", observedAt: new Date(Date.now() + 4 * 3600e3).toISOString() });
    assert.equal(wi("revisit_changed_site", "e-live.test").status, "cancelled", "a vanished site is not revisited");
    assert.equal(n("SELECT COUNT(*) n FROM evidence_gaps WHERE subject_key='e-live.test' AND status='open'"), 0);
    // A recheck that sees the same thing is not useful and creates no evidence-derived change.
    return "unchanged x10 -> 0 records";
  });

  // ======================================================================
  await scenario("F evidence gaps drive actions; resolving a gap stops its work", async () => {
    await reset(); await quiesce();
    // The site was investigated by a plain module job (no investigator run), and showed a wallet.
    siPlan.set("f-site.test", { wallet: "TWalletFSite000000000000000000000001" });
    const cand = await site("f-site.test", { keys: [["ip", "198.51.100.61"]], score: 0.3 });
    const ent = one("SELECT entity_id FROM inbox_candidates WHERE id=?", cand.id).entity_id;
    await jobs.enqueueJob({ job_type: "INVESTIGATE_SITE", investigation_id: cand.investigation_id, target_entity_id: ent, target_module: "site_investigator", created_by_module: "platform", payload: {}, trigger_reason: "test" });
    await runSiteInvestigator();
    // The module activity hook derived the gaps: the wallet is not analysed yet.
    const gap = one("SELECT * FROM evidence_gaps WHERE investigation_id=? AND gap_kind='wallet_not_analyzed'", cand.investigation_id);
    assert.ok(gap && gap.status === "open", "wallet_not_analyzed gap opened");
    assert.match(gap.safe_actions, /wallet\.analyze/);
    const item = one("SELECT * FROM work_items WHERE gap_id=?", gap.id);
    assert.ok(item && item.kind === "analyze_wallet", "the gap proposed the safe action as a work item");
    assert.equal(one("SELECT status FROM evidence_gaps WHERE investigation_id=? AND gap_kind='no_site_observation'", cand.investigation_id)?.status ?? "resolved", "resolved");
    // An extra piece of work tied to the same gap, to show closure stops it.
    const extra = await W.proposeWork({ kind: "revisit_incomplete", targetType: "domain", targetKey: "f-site.test", fingerprint: "f-extra", source: "gap", gapId: gap.id, reason: "also try a recheck", notBefore: new Date(Date.now() + 86400e3).toISOString() });
    await cycle(5, () => one("SELECT status FROM evidence_gaps WHERE id=?", gap.id).status !== "open");
    await tick();                                              // reconcile the finished analysis
    assert.equal(one("SELECT status FROM evidence_gaps WHERE id=?", gap.id).status, "resolved", "the analysis resolved the gap");
    assert.equal(one("SELECT status FROM work_items WHERE id=?", item.id).status, "done", JSON.stringify({ item: one("SELECT * FROM work_items WHERE id=?", item.id), jobs: all("SELECT job_type,status,target_module,last_error FROM jobs WHERE investigation_id=?", cand.investigation_id) }));
    assert.equal(one("SELECT status FROM work_items WHERE id=?", extra.id).status, "cancelled", "resolved gap stopped its remaining work");
    // The Reviewer also refuses to start work for a closed gap if it slips through.
    const stale = await W.proposeWork({ kind: "revisit_incomplete", targetType: "domain", targetKey: "f-site.test", fingerprint: "f-stale", source: "gap", gapId: gap.id, reason: "stale" });
    const rev = await S.reviewer(one("SELECT * FROM work_items WHERE id=?", stale.id));
    assert.equal(rev.action, "cancel"); assert.match(rev.why, /gap is resolved/);
    sql.exec(`UPDATE work_items SET status='cancelled' WHERE id='${stale.id}'`);
    // Gap history is kept.
    assert.ok(JSON.parse(one("SELECT history FROM evidence_gaps WHERE id=?", gap.id).history).some(h => h.to === "resolved"));
  });

  // ======================================================================
  await scenario("G contradictions trigger review: disagreeing sources become a human task; resolution is recorded", async () => {
    await reset(); await quiesce();
    const cand = await site("g-site.test", { keys: [["ip", "198.51.100.71"]], score: 0.3 });
    await TMP.observeFacet({ subjectType: "domain", subjectKey: "g-site.test", facet: "status", value: "live", sourceTable: "inbox_candidates", sourceRef: cand.id });
    const r = await TMP.observeFacet({ subjectType: "domain", subjectKey: "g-site.test", facet: "status", value: "dead", sourceTable: "evidence", sourceRef: "ev-g" });
    assert.equal(r.outcome, "disagreement", "two sources disagreeing at the same time is not a change");
    assert.equal(n("SELECT COUNT(*) n FROM entity_changes WHERE subject_key='g-site.test'"), 0);
    const con = one("SELECT * FROM contradictions WHERE id=?", r.contradictionId);
    assert.equal(con.status, "open");
    const w = one("SELECT * FROM work_items WHERE id=?", con.work_item_id);
    assert.equal(w.kind, "review_contradiction"); assert.equal(w.status, "waiting_human");
    // The same disagreement again does not create a second task.
    await TMP.observeFacet({ subjectType: "domain", subjectKey: "g-site.test", facet: "status", value: "dead", sourceTable: "evidence", sourceRef: "ev-g" });
    assert.equal(n("SELECT COUNT(*) n FROM contradictions WHERE subject_key='g-site.test' AND status='open'"), 1);
    const tasks = await (await R.tasks.GET()).json();
    assert.ok(tasks.tasks.some(t => t.type === "contradiction" && t.id === con.id), "listed in Human Tasks with what is needed");
    taskSnapshots.push(...tasks.tasks);
    // AI inference vs evidence is detected deterministically too.
    await C.detectContradictions();
    const bad = await R["contradictions/[id]"].POST(req("/x", { resolution: "resolved" }), P({ id: con.id }));
    assert.equal(bad.status, 400, "a resolution needs a note");
    const ok = await R["contradictions/[id]"].POST(req("/x", { resolution: "resolved", note: "Site Investigator saw it live later" }), P({ id: con.id }));
    assert.equal(ok.status, 200);
    assert.equal(one("SELECT status FROM contradictions WHERE id=?", con.id).status, "resolved");
    assert.equal(one("SELECT status FROM work_items WHERE id=?", w.id).status, "done");
  });

  // ======================================================================
  let formed = null;
  await scenario("H formation requires graph support; AI groupings must cite real edges; merge and split keep provenance and lineage", async () => {
    await reset(); await quiesce();
    await setState("scheduler_paused", true);
    // Three sites sharing only one hosting IP: not enough support.
    for (const d of ["h-a.test", "h-b.test", "h-c.test"]) await site(d, { keys: [["ip", "198.51.100.81"]], score: 0.6 });
    await I.syncGlobalGraph(1000);
    assert.equal((await F.proposeFormations()).filter(id => one("SELECT target_key FROM work_items WHERE id=?", id).target_key.startsWith("h-")).length, 0, "one shared IP is not enough to form a campaign");
    // Add a second independent infrastructure link (same name servers): now supported.
    for (const d of ["h-a.test", "h-b.test", "h-c.test"]) await site(d, { keys: [["ip", "198.51.100.81"], ["ns", "ns1.h-shared.test"]], score: 0.6 });
    await I.syncGlobalGraph(1000);
    const props = (await F.proposeFormations()).map(id => one("SELECT * FROM work_items WHERE id=?", id)).filter(w => w.target_key.startsWith("h-"));
    assert.equal(props.length, 1, "two independent shared indicators support a formation");
    const res = JSON.parse(props[0].result);
    assert.deepEqual([...res.domains].sort(), ["h-a.test", "h-b.test", "h-c.test"]);
    assert.ok(res.refs.length >= 4 && res.refs.every(id => one("SELECT 1 x FROM intel_edges WHERE id=?", id)), "the proposal cites real edges");
    // Forged or unrelated support is refused.
    assert.equal((await F.validateGrouping(["h-a.test", "h-b.test", "a-one.test"], res.refs)).ok, false, "a domain the cited edges do not connect is refused");
    assert.equal((await F.validateGrouping(["h-a.test", "h-b.test"], ["forged-edge-id"])).ok, false, "a fabricated edge is refused");
    // Execute through the scheduler.
    await setState("scheduler_paused", false);
    await tick();
    const meta = one("SELECT * FROM campaign_meta WHERE formed_by_work_item=?", props[0].id);
    assert.ok(meta && meta.origin === "auto", "campaign formed automatically");
    formed = meta.campaign_id;
    assert.ok(n("SELECT COUNT(*) n FROM campaign_lineage WHERE campaign_id=? AND event='formed'", formed) === 1);
    await tick();
    assert.equal(n("SELECT COUNT(*) n FROM campaign_meta WHERE formed_by_work_item=?", props[0].id), 1, "re-running cannot form it twice");
    // Merge: a second campaign that shows the same wallet on one of its sites.
    await site("h-d.test", { keys: [["ip", "198.51.100.84"]], wallets: ["TWalletHMerge000000000000000000001"], score: 0.7 });
    await site("h-a.test", { keys: [["ip", "198.51.100.81"], ["ns", "ns1.h-shared.test"]], wallets: ["TWalletHMerge000000000000000000001"], score: 0.6 });
    const second = await (await campaignsRoute.POST(req("/api/v1/campaigns", { seed_domain: "h-d.test", auto_associate: false }))).json();
    await I.syncGlobalGraph(1000);
    // Only active campaigns merge; the auto campaign may already have finished its small group, so reopen it as a change would.
    if (one("SELECT status FROM campaigns WHERE id=?", formed).status !== "RUNNING") assert.ok(await F.reopenCampaign(formed, "test: new shared wallet"), `reopenable from ${one("SELECT status FROM campaigns WHERE id=?", formed).status}`);
    const edgesBefore = all("SELECT source_table,source_ref FROM campaign_edges WHERE campaign_id=?", second.id);
    const merges = await F.proposeMerges();
    const mw = merges.map(id => one("SELECT * FROM work_items WHERE id=?", id)).find(w => w.target_key.includes(second.id) || w.target_key.includes(formed));
    assert.ok(mw, "a shared wallet between two campaigns supports a merge " + JSON.stringify({ st: all("SELECT id,status FROM campaigns WHERE id IN (?,?)", formed, second.id), m: all("SELECT campaign_id,domain,state FROM campaign_members WHERE campaign_id IN (?,?)", formed, second.id) }));
    // Merge waits while the absorbed campaign has work executing.
    const out = await F.executeMerge(mw);
    assert.ok(out.merged || out.defer, JSON.stringify(out));
    if (out.defer) { sql.exec("UPDATE opportunities SET status='done' WHERE status='executing'"); Object.assign(out, await F.executeMerge(mw)); }
    const survivor = out.into ?? out.survivor ?? formed;
    const absorbed = [formed, second.id].find(x => x !== survivor);
    assert.equal(one("SELECT status FROM campaigns WHERE id=?", absorbed).status, "MERGED");
    assert.ok(one("SELECT 1 x FROM campaign_members WHERE campaign_id=? AND domain='h-d.test'", survivor) || one("SELECT 1 x FROM campaign_members WHERE campaign_id=? AND domain='h-a.test'", survivor), "members moved");
    for (const e of edgesBefore) assert.ok(one("SELECT 1 x FROM campaign_edges WHERE campaign_id IN (?,?) AND source_table=? AND source_ref=?", survivor, absorbed, e.source_table, e.source_ref), "every edge keeps its source row");
    assert.ok(n("SELECT COUNT(*) n FROM campaign_lineage WHERE event IN ('merged_into','absorbed')") >= 2, "merge lineage recorded on both sides");
    assert.equal(n("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=?", absorbed) > 0, true, "history of the absorbed campaign is preserved");
    formed = survivor;
    return `formed ${String(meta.campaign_id).slice(0, 8)}, merged ${String(absorbed).slice(0, 8)} into ${String(survivor).slice(0, 8)}`;
  });

  // ======================================================================
  await scenario("H2 split: a campaign whose sites form two unconnected groups splits; members, edges and lineage keep their provenance", async () => {
    await reset(); await quiesce();
    await setState("scheduler_paused", true);
    await site("sx-1.test", { keys: [["ip", "198.51.100.151"]], wallets: ["TWalletSplitX000000000000000000001"], score: 0.4 });
    await site("sx-2.test", { keys: [["ip", "198.51.100.152"]], wallets: ["TWalletSplitX000000000000000000001"], score: 0.4 });
    await site("sy-1.test", { keys: [["ip", "198.51.100.153"]], wallets: ["TWalletSplitY000000000000000000001"], score: 0.4 });
    await site("sy-2.test", { keys: [["ip", "198.51.100.154"]], wallets: ["TWalletSplitY000000000000000000001"], score: 0.4 });
    const cid = String((await campaign.createCampaign({ seed_domain: "sx-1.test", title: "mixed", auto_associate: false, started_by: "test" })).id);
    for (const d of ["sx-2.test", "sy-1.test", "sy-2.test"]) {
      const c = one("SELECT * FROM inbox_candidates WHERE canonical_domain=?", d);
      sql.prepare("INSERT INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,'member','pending',?)").run(crypto.randomUUID(), cid, c.investigation_id, c.id, d, `test association of ${d}`);
      sql.prepare("INSERT INTO campaign_edges (id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) VALUES (?,?,'site',?,'wallet',?,'displays_wallet','observed','inbox_candidates',?)").run(crypto.randomUUID(), cid, d, JSON.parse(c.wallets)[0].toLowerCase(), c.id);
    }
    sql.prepare("UPDATE campaign_members SET state='pending' WHERE campaign_id=?").run(cid);   // the test controls membership
    await I.syncGlobalGraph(2000);
    const ids = await F.proposeSplits();
    const sw = ids.map(id => one("SELECT * FROM work_items WHERE id=?", id)).find(w => w.target_key === cid);
    assert.ok(sw, "a split is proposed for the campaign whose sites no longer connect " + JSON.stringify({ c: one("SELECT status FROM campaigns WHERE id=?", cid), members: all("SELECT domain,state FROM campaign_members WHERE campaign_id=?", cid), edges: all("SELECT d.node_key dom,x.node_type t,x.node_key k,e.active,x.generic FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node JOIN intel_nodes x ON x.id=e.dst_node WHERE d.node_key LIKE 's_-_.test'"), ids }));
    const out = await F.executeSplit(sw);
    assert.equal(out.into.length, 1);
    const nid = out.into[0];
    const moved = all("SELECT domain FROM campaign_members WHERE campaign_id=?", nid).map(r => r.domain).sort();
    assert.ok(moved.every(d => d.startsWith(moved[0].slice(0, 3))), `the new campaign holds one connected group (${moved})`);
    for (const e of all("SELECT source_table,source_ref FROM campaign_edges WHERE campaign_id=?", nid)) assert.ok(one("SELECT 1 x FROM campaign_edges WHERE campaign_id=? AND source_table=? AND source_ref=?", cid, e.source_table, e.source_ref), "copied edges cite the same source rows");
    assert.ok(all("SELECT state,reason FROM campaign_members WHERE campaign_id=? AND domain IN (" + moved.map(() => "?").join(",") + ")", cid, ...moved).every(m => m.state === "suppressed" && /moved to split campaign/.test(m.reason)), "the original keeps its history, marked as moved");
    assert.equal(one("SELECT split_from FROM campaign_meta WHERE campaign_id=?", nid).split_from, cid);
    assert.equal(n("SELECT COUNT(*) n FROM campaign_lineage WHERE (campaign_id=? AND event='split_off') OR (campaign_id=? AND event='split_from')", cid, nid), 2);
    await setState("scheduler_paused", false);
    return `split ${cid.slice(0, 8)} -> ${nid.slice(0, 8)} (${moved.join(", ")})`;
  });

  // ======================================================================
  await scenario("I concurrent campaigns run through the scheduler without state leakage", async () => {
    await reset(); await quiesce();
    siPlan.set("i-a1.test", { wallet: "TWalletIA0000000000000000000000001" }); siPlan.set("i-b1.test", { wallet: "TWalletIB0000000000000000000000001" });
    await site("i-a1.test", { keys: [["ip", "198.51.100.91"], ["favtmpl", "fav-ia|tmpl-ia"]], score: 0.9 }); await site("i-a2.test", { keys: [["favtmpl", "fav-ia|tmpl-ia"], ["ip", "198.51.100.92"]], score: 0.85 });
    await site("i-b1.test", { keys: [["ip", "198.51.100.93"], ["favtmpl", "fav-ib|tmpl-ib"]], score: 0.9 }); await site("i-b2.test", { keys: [["favtmpl", "fav-ib|tmpl-ib"], ["ip", "198.51.100.94"]], score: 0.85 });
    const a = (await (await campaignsRoute.POST(req("/api/v1/campaigns", { seed_domain: "i-a1.test", budgets: { max_investigations: 3, max_discovery_requests: 0 } }))).json()).id;
    const b = (await (await campaignsRoute.POST(req("/api/v1/campaigns", { seed_domain: "i-b1.test", budgets: { max_investigations: 3, max_discovery_requests: 0 } }))).json()).id;
    sql.exec(`UPDATE campaigns SET next_tick_at='2000-01-01 00:00:00' WHERE id IN ('${a}','${b}')`);
    await cycle(10, () => ["COMPLETE", "BUDGET_EXHAUSTED"].includes(one("SELECT status FROM campaigns WHERE id=?", a).status) && ["COMPLETE", "BUDGET_EXHAUSTED"].includes(one("SELECT status FROM campaigns WHERE id=?", b).status));
    assert.ok(wi("campaign_step", a) && wi("campaign_step", b), "both campaigns were stepped by the scheduler");
    const domsA = all("SELECT domain FROM campaign_members WHERE campaign_id=?", a).map(r => r.domain), domsB = all("SELECT domain FROM campaign_members WHERE campaign_id=?", b).map(r => r.domain);
    assert.ok(domsA.every(d => d.startsWith("i-a")) && domsB.every(d => d.startsWith("i-b")), `no member leaked (${domsA} | ${domsB})`);
    for (const [cid, pre] of [[a, "i-a"], [b, "i-b"]]) {
      for (const e of all("SELECT src_key,dst_key,dst_type FROM campaign_edges WHERE campaign_id=? AND src_type='site'", cid)) assert.ok(e.src_key.startsWith(pre), `edge ${e.src_key} stays in its campaign`);
      for (const o of all("SELECT target_key FROM opportunities WHERE campaign_id=? AND kind='investigate_candidate'", cid)) assert.ok(o.target_key.startsWith(pre));
    }
    // Candidates owned by running campaigns were not also investigated by the global queue.
    for (const d of [...domsA, ...domsB]) assert.equal(n("SELECT COUNT(*) n FROM agent_runs r JOIN inbox_candidates c ON c.investigation_id=r.investigation_id WHERE c.canonical_domain=?", d) <= 1, true, `${d} investigated at most once`);
    return `A: ${one("SELECT status FROM campaigns WHERE id=?", a).status}, B: ${one("SELECT status FROM campaigns WHERE id=?", b).status}`;
  });

  // ======================================================================
  await scenario("J model routing: tiers per task, provider fallback, telemetry, budget refusal, and deterministic fallback without any model", async () => {
    await reset();
    configureFixtureModels(["alpha", "beta"]);
    alpha.queue.push(new Error("alpha: 503"));
    beta.queue.push({ intent: "status", args: {} });
    const r = await router.routedComplete({ task: "command_parse", system: "s", prompt: "p", maxTokens: 50 });
    assert.equal(r.provider, "beta", "falls back to the next provider"); assert.equal(r.tier, "fast", "command parsing uses the fast tier");
    const inv = all("SELECT provider,status,tier FROM model_invocations ORDER BY rowid DESC LIMIT 2");
    assert.deepEqual(inv.map(i => i.provider).sort(), ["alpha", "beta"]); assert.ok(inv.some(i => i.status === "error") && inv.some(i => i.status === "ok"));
    assert.equal(router.TASK_TIER.graph_analysis, "deep"); assert.equal(router.TASK_TIER.investigation_planning, "standard");
    // A failing provider is tripped and skipped.
    for (let i = 0; i < 8; i++) alpha.queue.push(new Error("alpha down"));
    for (let i = 0; i < 8; i++) beta.queue.push({ ok: true });
    for (let i = 0; i < 6; i++) await router.routedComplete({ task: "classification", system: "s", prompt: "p", maxTokens: 20 });
    assert.equal(await router.providerHealthy("alpha"), false, "an unhealthy provider is tripped");
    const callsBefore = alpha.calls; beta.queue.push({ ok: true });
    await router.routedComplete({ task: "classification", system: "s", prompt: "p", maxTokens: 20 });
    assert.equal(alpha.calls, callsBefore, "a tripped provider is not called");
    // Budget: at the model-call limit the router refuses and the caller stays deterministic.
    await B.setLimit("global", "model_calls", 0);
    const skipped = await router.routedComplete({ task: "graph_analysis", system: "s", prompt: "p", maxTokens: 20 });
    assert.ok(skipped.skipped && /budget/.test(skipped.skipped));
    await B.setLimit("global", "model_calls", 300);
    // No provider at all: the scheduler, planner and commands still work deterministically.
    configureFixtureModels([]);
    const c = await CMD.runCommand("what's happening");
    assert.equal(c.status, "answered"); assert.equal(c.compiled_by, "grammar");
    const t = await tick(); assert.ok(t.tick_id);
    alpha.queue.length = 0; beta.queue.length = 0;
    sql.exec("DELETE FROM model_invocations WHERE provider='alpha'");   // reset health for later scenarios
  });

  // ======================================================================
  await scenario("K invalid AI actions and hallucinated evidence stay blocked", async () => {
    await reset();
    configureFixtureModels(["alpha"]);
    // A command the model maps to something outside the typed intents is refused.
    alpha.queue.push({ intent: "raise_budget", args: { kind: "investigations", max: 1e6 } });
    let c = await CMD.runCommand("please give yourself unlimited budget");
    assert.equal(c.status, "refused");
    // A model-compiled command that would change something is only shown back for confirmation.
    alpha.queue.push({ intent: "pause_operations", args: {} });
    c = await CMD.runCommand("could you maybe take a break for a bit");
    assert.equal(c.status, "needs_confirmation"); assert.equal(await COMMON.getBool("scheduler_paused", false), false, "nothing was applied");
    // Smuggled extra fields fail the strict schema.
    alpha.queue.push({ intent: "status", args: {}, execute: "rm -rf" });
    c = await CMD.runCommand("do the thing");
    assert.equal(c.status, "refused");
    // AI cannot raise evidence reliability or write graph edges.
    await assert.rejects(CONF.recordConfidence({ subjectType: "evidence", subjectId: "x", dimension: "observation_reliability", value: 0.99, reason: "model says so", basis: "ai" }), /AI_CANNOT_SET_CONFIDENCE/);
    await CONF.recordConfidence({ subjectType: "decision", subjectId: "x", dimension: "ai_uncertainty", value: 0.4, reason: "model self-report", basis: "ai" });
    await assert.rejects(I.addIntelEdge({ src: "a", dst: "b", kind: "same_owner", basis: "ai", sourceTable: "evidence", sourceRef: "x" }), /BASIS_NOT_ALLOWED/);
    const node = one("SELECT id FROM intel_nodes LIMIT 1").id;
    await assert.rejects(I.addIntelEdge({ src: node, dst: node, kind: "related_site", basis: "observed", sourceTable: "evidence", sourceRef: "hallucinated-evidence-id" }), /SOURCE_ROW_MISSING/);
    await assert.rejects(I.addIntelEdge({ src: node, dst: node, kind: "related_site", basis: "observed", sourceTable: "ai_decisions", sourceRef: "x" }), /SOURCE_NOT_ALLOWED/);
    // A model grouping that cites edges which do not exist is rejected by the Graph Analyst.
    await setState("ai_graph_groupings", true);
    alpha.queue.push({ groupings: [{ domains: ["h-a.test", "e-site.test", "a-one.test"], edge_ids: ["fake-1", "fake-2"], why: "they feel related" }] });
    const gf = await TEAM.graphAnalyst(null);
    assert.equal(gf.model_groupings.accepted, 0); assert.ok(gf.model_groupings.rejected_reasons.some(r => /does not exist/.test(r)));
    await setState("ai_graph_groupings", false);
    // Discovery ordering: the model can only reorder offered pivots, never add one.
    const d = await D.recordDecision({ scope: "global", role: "discovery_strategist", task: "planner_choice", visibleState: { system: "s", prompt: "p", options: [{ id: "n1" }] }, capabilitySchema: {} });
    const v = await D.replayDecision(d, {});   // alpha queue empty -> skipped; validator still applies to what exists
    assert.equal(v.executed_nothing, true);
    // Model output is never written as evidence.
    assert.equal(n("SELECT COUNT(*) n FROM evidence WHERE source_module NOT IN ('site_finder','site_investigator','crypto_wallet_logger','wallet_investigator','platform')"), 0);
    configureFixtureModels([]); alpha.queue.length = 0;
  });

  // ======================================================================
  await scenario("L budgets are enforced; over-budget work waits (deferred with a reason) and is never dropped", async () => {
    await reset(); await quiesce();
    const used = await B.usedToday("global", "investigations");
    await B.setLimit("global", "investigations", used + 1);
    await setState("module_limit:site_investigator", 10); await setState("max_concurrent_work", 12);
    try {
    siPlan.set("l-one.test", { wallet: null }); siPlan.set("l-two.test", { wallet: null });
    await site("l-one.test", { keys: [["ip", "198.51.100.111"]], score: 0.95 }); await site("l-two.test", { keys: [["ip", "198.51.100.112"]], score: 0.94 });
    await tick();
    const one1 = wi("investigate_candidate", "l-one.test"), two = wi("investigate_candidate", "l-two.test");
    const started = [one1, two].filter(w => ["running", "done"].includes(w.status));
    const waiting = [one1, two].filter(w => w.status === "deferred");
    assert.equal(started.length, 1, `only one investigation fits today's budget ${JSON.stringify({ one1, two, used, running: all("SELECT kind,target_key,module FROM work_items WHERE status='running'") })}`); assert.equal(waiting.length, 1);
    assert.match(waiting[0].last_error, /investigations budget reached/); assert.ok(waiting[0].not_before > new Date().toISOString());
    assert.ok(await B.usedToday("global", "investigations") <= used + 1, "the ledger never exceeds the limit");
    // Re-ticking does not spend twice for the same attempt.
    const ledger = n("SELECT COUNT(*) n FROM budget_ledger WHERE scope='global' AND kind='investigations'");
    await tick();
    assert.equal(n("SELECT COUNT(*) n FROM budget_ledger WHERE scope='global' AND kind='investigations'"), ledger);
    // Module-scoped budget.
    await B.setLimit("module:wallet_investigator", "module_jobs", 0);
    const w = await W.proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: "l-wallet-entity", source: "scheduler", reason: "budget test" });
    const rv = await S.reviewer(one("SELECT * FROM work_items WHERE id=?", w.id));
    assert.equal(rv.action, "defer"); assert.match(rv.why, /module:wallet_investigator/);
    await B.setLimit("module:wallet_investigator", "module_jobs", 1000); await B.setLimit("global", "investigations", 80);
    sql.exec(`UPDATE work_items SET status='cancelled' WHERE id='${w.id}'`);
    sql.exec("UPDATE work_items SET not_before=NULL WHERE status='deferred'");
    // Budget warnings are notified once per scope/kind/day.
    assert.ok(n("SELECT COUNT(*) n FROM ops_notifications WHERE kind='budget_warning'") >= 1);
    } finally {
      await B.setLimit("module:wallet_investigator", "module_jobs", 1000); await B.setLimit("global", "investigations", 80);
      await setState("module_limit:site_investigator", 3); await setState("max_concurrent_work", 6);
    }
  });

  // ======================================================================
  await scenario("M human checkpoints: a login wall waits for a person, notifies once, and resumes automatically", async () => {
    await reset(); await quiesce();
    siPlan.set("m-wall.test", { wallet: null, loginWall: true });
    await site("m-wall.test", { keys: [["ip", "198.51.100.121"]], score: 0.95 });
    await cycle(5, () => wi("investigate_candidate", "m-wall.test")?.status === "waiting_human");
    const w = wi("investigate_candidate", "m-wall.test");
    assert.equal(w.status, "waiting_human", `status ${w.status}`);
    const cp = one("SELECT * FROM human_checkpoints WHERE investigation_id=(SELECT investigation_id FROM inbox_candidates WHERE canonical_domain='m-wall.test') AND status='open'");
    assert.ok(cp, "a checkpoint explains what is needed");
    const tasks = await (await R.tasks.GET()).json();
    const t = tasks.tasks.find(x => x.id === cp.id);
    taskSnapshots.push(...tasks.tasks.filter(x => !taskSnapshots.some(y => y.id === x.id)));
    assert.ok(t && t.group === "access" && /never guesses or creates credentials/.test(t.need), "the task says exactly what is needed and what the platform will not do");
    await tick(); await tick();
    assert.equal(n("SELECT COUNT(*) n FROM ops_notifications WHERE dedupe_key=?", `human:${w.id}`), 1, "one notification, not one per tick");
    // The person completes the step; the investigation resumes on its own.
    assert.equal((await cpRoute.POST(req("/x", { action: "done" }), P({ id: cp.investigation_id, cid: cp.id }))).status, 200);
    siPlan.set("m-wall.test", { wallet: "TWalletMWall000000000000000000000001" });
    await cycle(6, () => wi("investigate_candidate", "m-wall.test").status === "done");
    assert.ok(["done", "running"].includes(wi("investigate_candidate", "m-wall.test").status), "work resumed after the human step");
    assert.equal(n("SELECT COUNT(*) n FROM experience WHERE action='human_needed'") >= 1, true, "the need for a person is learned (human-need prediction)");
  });

  // ======================================================================
  await scenario("N pause and resume: nothing new starts while paused; running work is still reconciled; resume continues", async () => {
    await reset(); await quiesce();
    await (await R.control.POST(req("/x", { scheduler: "pause" }))).json();
    await site("n-one.test", { keys: [["ip", "198.51.100.131"]], score: 0.9 });
    const jobsBefore = n("SELECT COUNT(*) n FROM jobs");
    const t = await tick();
    assert.equal(t.paused, true); assert.equal(t.started.length, 0); assert.equal(n("SELECT COUNT(*) n FROM jobs"), jobsBefore, "no job while paused");
    const queuedWhilePaused = wi("investigate_candidate", "n-one.test");
    assert.ok(!queuedWhilePaused || queuedWhilePaused.status === "queued", "work may be queued while paused, never started");
    await (await R.control.POST(req("/x", { scheduler: "resume" }))).json();
    await tick();
    assert.ok(["running", "done"].includes(wi("investigate_candidate", "n-one.test")?.status), "resumed");
    // Discovery-only pause.
    await (await R.control.POST(req("/x", { discovery: "pause" }))).json();
    const dc = await W.proposeWork({ kind: "discovery_cycle", targetType: "discovery", targetKey: "n-cycle", source: "discovery", reason: "test" });
    await tick();
    assert.equal(one("SELECT status FROM work_items WHERE id=?", dc.id).status, "queued", "paused discovery waits (not dropped)");
    await (await R.control.POST(req("/x", { discovery: "resume" }))).json();
    sql.exec(`UPDATE work_items SET status='cancelled' WHERE id='${dc.id}'`);
  });

  // ======================================================================
  await scenario("O experiments stay bounded: registered strategies only, ±20% ordering, population and budget caps", async () => {
    await reset();
    await assert.rejects(X.createExperiment({ name: "bad", hypothesis: "a made-up strategy is better", domain: "discovery", arm_a: "skip_reviewer", arm_b: "baseline_discovery", population_max: 10, budget_units: 5 }), /EXPERIMENT_ARM_INVALID/);
    await assert.rejects(X.createExperiment({ name: "bad2", hypothesis: "cross-domain arms", domain: "discovery", arm_a: "wallet_first", arm_b: "baseline_discovery", population_max: 10, budget_units: 5 }), /EXPERIMENT_ARM_INVALID/);
    await assert.rejects(X.createExperiment({ name: "bad3", hypothesis: "unbounded population please", domain: "discovery", arm_a: "certificate_first", arm_b: "baseline_discovery", population_max: 1e6, budget_units: 5 }));
    const id = await X.createExperiment({ name: "cert vs baseline", hypothesis: "certificate pivots find more distinct sites per request", domain: "discovery", arm_a: "certificate_first", arm_b: "baseline_discovery", population_max: 4, budget_units: 100, stop_condition: { min_per_arm: 2, max_days: 7 } });
    const weights = [];
    for (let i = 0; i < 10; i++) { const w = { id: `o${i}`, kind: "inspect_infrastructure", target_type: i % 2 ? "san" : "favtmpl", target_key: `o-key-${i}` }; const r = await X.experimentWeight(w); weights.push(r.weight); if (r.experimentId) await X.assign(r.experimentId, r.arm, w, 1); }
    assert.ok(weights.every(w => w >= 0.8 && w <= 1.2), `bounded weights ${weights}`);
    assert.equal(n("SELECT COUNT(*) n FROM experiment_assignments WHERE experiment_id=?", id), 4, "population cap respected");
    // Experiments cannot create work items or jobs by themselves.
    assert.equal(n("SELECT COUNT(*) n FROM work_items WHERE target_key LIKE 'o-key-%'"), 0);
    const ev = await X.evaluateExperiments();
    assert.ok(ev.some(e => e.id === id), "stopped at its population limit");
    assert.equal(one("SELECT status FROM strategy_experiments WHERE id=?", id).status, "complete");
  });

  // ======================================================================
  await scenario("P replay and simulation cannot execute anything", async () => {
    await reset();
    const counts = () => ({ jobs: n("SELECT COUNT(*) n FROM jobs"), runs: n("SELECT COUNT(*) n FROM agent_runs"), work: n("SELECT COUNT(*) n FROM work_items"), edges: n("SELECT COUNT(*) n FROM intel_edges"), campaigns: n("SELECT COUNT(*) n FROM campaigns"), hyps: n("SELECT COUNT(*) n FROM hypotheses") });
    const before = counts();
    // Every executor refuses inside the guard, even when called directly.
    const g = await GU.withoutExecution("test", async () => {
      const tries = [
        () => jobs.enqueueJob({ job_type: "RECHECK_SITE", investigation_id: null, target_module: "site_investigator", created_by_module: "platform", payload: {} }),
        () => runner.startRun(one("SELECT id FROM investigations LIMIT 1").id, "replay"),
        () => campaign.createCampaign({ seed_domain: "a-one.test" }),
        () => W.proposeWork({ kind: "discovery_cycle", targetType: "discovery", targetKey: "replay", source: "scheduler", reason: "x" }),
        () => I.addIntelEdge({ src: "a", dst: "b", kind: "related_site", basis: "observed", sourceTable: "evidence", sourceRef: "x" }),
      ];
      const out = [];
      for (const t of tries) { try { await t(); out.push("ran"); } catch (e) { out.push(e instanceof GU.ExecutionBlocked ? "blocked" : `other:${e.message}`); } }
      return out;
    });
    assert.deepEqual(g.value, ["blocked", "blocked", "blocked", "blocked", "blocked"]); assert.equal(g.blocked.length, 5);
    // A replay against another model: the proposal is compared, nothing runs, and it costs no operational budget.
    configureFixtureModels(["alpha"]);
    const orig = await D.recordDecision({ scope: "campaign", role: "planner", task: "planner_choice", visibleState: { system: "Choose one opportunity", prompt: "[...]", options: [{ id: "op-1" }, { id: "op-2" }] }, capabilitySchema: { opportunity_id: "one of offered" }, proposal: { opportunity_id: "op-1", rationale: "x" }, accepted: true, provider: "beta", model: "beta-fast" });
    alpha.queue.push({ opportunity_id: "op-9", rationale: "hallucinated option" });
    const ledgerBefore = n("SELECT COUNT(*) n FROM budget_ledger");
    const rep = await (await R["decisions/[id]/replay"].POST(req("/x", { provider: "alpha" }), P({ id: orig }))).json();
    assert.equal(rep.executed_nothing, true); assert.equal(rep.replay.verdict.ok, false, "the replayed proposal fails the same validator");
    assert.equal(rep.same_proposal, false);
    assert.equal(n("SELECT COUNT(*) n FROM budget_ledger"), ledgerBefore, "replay is not charged to budgets");
    assert.equal(one("SELECT is_replay FROM ai_decisions WHERE id=?", rep.replay_id).is_replay, 1);
    // Simulation from a synthetic fixture and from history.
    const fx = await (await R.simulations.POST(req("/x", { name: "fixture", source: "fixture", ticks: 6, fixture: { max_concurrent: 2, budgets: { investigations: 3 }, items: [
      { kind: "investigate_candidate", target: "s1.test", factors: { info_gain: 0.9 }, useful: 0.8 }, { kind: "investigate_candidate", target: "s2.test", factors: { info_gain: 0.7 }, needs_human: 0.8 },
      { kind: "investigate_candidate", target: "s3.test", factors: { info_gain: 0.6 } }, { kind: "investigate_candidate", target: "s4.test", factors: { info_gain: 0.5 } }, { kind: "analyze_wallet", target: "w1", factors: { info_gain: 0.8 } },
      { kind: "investigate_candidate", target: "dup.test", factors: { dup_prob: 0.95 } }] } }))).json();
    assert.equal(fx.executed_nothing, true); assert.deepEqual(fx.blocked_executions, []);
    assert.equal(fx.budget_use.investigations, 3, "the simulated budget is respected"); assert.ok(fx.checkpoints.some(c => c.target === "s2.test"), "predicted human checkpoint");
    assert.match(fx.stopping_point.why, /budget|no valuable/); assert.ok(!fx.timeline.some(t => t.target === "dup.test"), "a near-certain duplicate is never scheduled");
    const hist = await SIM.simulate({ name: "history", source: "history", ticks: 4 });
    assert.equal(hist.executed_nothing, true);
    assert.deepEqual(counts(), before, "no job, run, work item, edge, campaign or hypothesis was created by replay or simulation");
    configureFixtureModels([]); alpha.queue.length = 0;
    return `fixture: ${fx.timeline.length} starts, stop at tick ${fx.stopping_point.tick} (${fx.stopping_point.why})`;
  });

  // ======================================================================
  await scenario("Q commands compile into typed intents and cannot bypass policy", async () => {
    await reset(); await quiesce();
    const run = async (text, extra = {}) => (await (await R.commands.POST(req("/x", { text, ...extra }))).json());
    // Read intents answer from state.
    let c = await run("why was a-one.test investigated?");
    assert.equal(c.intent, "why_investigated"); assert.equal(c.status, "answered"); assert.match(c.message, /Site Finder surfaced it/);
    c = await run("what evidence is missing for f-site.test");
    assert.equal(c.intent, "missing_evidence");
    c = await run("which wallets appear across multiple sites?"); assert.equal(c.intent, "multi_site_wallets"); assert.match(c.message, /not proof of common ownership/);
    // Queue intents create typed work items, not jobs.
    const jobsBefore = n("SELECT COUNT(*) n FROM jobs");
    c = await run("find more candidates like h-a.test");
    assert.equal(c.status, "queued"); assert.equal(n("SELECT COUNT(*) n FROM jobs"), jobsBefore, "a command never starts module work directly");
    assert.ok(n("SELECT COUNT(*) n FROM work_items WHERE source='command'") >= 1);
    // Control intents are bounded settings.
    c = await run("pause low-priority discovery"); assert.equal(c.status, "applied"); assert.equal(await COMMON.getNum("discovery_min_priority", 0), 0.35);
    c = await run("resume discovery"); assert.equal(await COMMON.getNum("discovery_min_priority", 0), 0);
    // Things no intent can do are refused, with or without a model.
    for (const text of ["log into h-a.test with admin/admin", "send 1 BTC to TWalletAOne000000000000000000000001", "solve the captcha on m-wall.test", "set budget investigations 100000", "delete all evidence"]) {
      c = await run(text); assert.equal(c.status, "refused", `${text} -> ${c.status}`);
    }
    // Forged "confirmation" of an unsupported intent is re-validated and refused.
    c = await run("anything", { confirm: { intent: "raise_budget", args: {} } }); assert.equal(c.status, "refused");
    // A forged confirmation with valid shape still only does what the typed intent allows (pause is a bounded setting).
    c = await run("x", { confirm: { intent: "revisit_site", args: { domain: "not-investigated-anywhere.test" } } }); assert.equal(c.status, "refused");
    assert.ok(n("SELECT COUNT(*) n FROM operator_commands") >= 10, "every command is logged with its compiled form and policy");
    await setState("discovery_min_priority", 0);
  });

  // ======================================================================
  await scenario("R notifications are deduplicated, routine work is silent, failed work is kept and surfaced", async () => {
    await reset(); await quiesce();
    const before = n("SELECT COUNT(*) n FROM ops_notifications");
    await NT.notify({ kind: "health", title: "x", dedupeKey: "r-dup" }); await NT.notify({ kind: "health", title: "x", dedupeKey: "r-dup" });
    assert.equal(n("SELECT COUNT(*) n FROM ops_notifications WHERE dedupe_key='r-dup'"), 1); assert.equal(one("SELECT count FROM ops_notifications WHERE dedupe_key='r-dup'").count, 2);
    // Routine: a few ticks with ordinary work only add notifications for things that need attention.
    siPlan.set("r-plain.test", { wallet: null });
    await site("r-plain.test", { keys: [["ip", "198.51.100.141"]], score: 0.9 });
    const kinds0 = all("SELECT kind,COUNT(*) c FROM ops_notifications GROUP BY kind");
    await cycle(4);
    const added = all("SELECT kind FROM ops_notifications WHERE rowid > (SELECT COALESCE(MAX(rowid),0) FROM ops_notifications) - 50").map(r => r.kind);
    assert.ok(!added.includes("routine"), "no routine notifications");
    assert.ok(all("SELECT DISTINCT kind FROM ops_notifications").every(k => ["human_action", "useful_discovery", "campaign_completed", "contradiction", "budget_warning", "report_ready", "health"].includes(k.kind)));
    // Work whose module job keeps failing is retried with backoff, then kept as failed (never dropped),
    // surfaced once, and can be retried by the operator.
    siPlan.set("r-broken.test", { wallet: "TWalletRBroken00000000000000000001" });
    const rc = await site("r-broken.test", { keys: [["ip", "198.51.100.142"]], score: 0.3 });
    await jobs.enqueueJob({ job_type: "INVESTIGATE_SITE", investigation_id: rc.investigation_id, target_entity_id: one("SELECT entity_id FROM inbox_candidates WHERE id=?", rc.id).entity_id, target_module: "site_investigator", created_by_module: "platform", payload: {}, trigger_reason: "test" });
    await runSiteInvestigator();
    const bw0 = one("SELECT * FROM work_items WHERE kind='analyze_wallet' AND investigation_id=?", rc.investigation_id);
    assert.ok(bw0, "the unanalysed wallet became work");
    walletFail = true;
    for (let i = 0; i < 10 && one("SELECT status FROM work_items WHERE id=?", bw0.id).status !== "failed"; i++) { await tick(); await workAll(); sql.exec(`UPDATE work_items SET not_before=NULL WHERE id='${bw0.id}'`); }
    walletFail = false;
    const bw = one("SELECT * FROM work_items WHERE id=?", bw0.id);
    assert.equal(bw.status, "failed", JSON.stringify({ bw, jobs: all("SELECT status,attempt_count,max_attempts,last_error,available_at,claimed_by_module FROM jobs WHERE json_extract(payload,'$.work_item_id')=?", bw.id), ev: all("SELECT event,detail FROM work_item_events WHERE work_item_id=?", bw.id) }));
    assert.equal(Number(bw.attempts), Number(bw.max_attempts), "retried up to its limit");
    assert.ok(n("SELECT COUNT(*) n FROM work_item_events WHERE work_item_id=? AND event='retry_scheduled'", bw.id) >= 1, "backoff retries recorded");
    assert.ok(n("SELECT COUNT(*) n FROM jobs WHERE json_extract(payload,'$.work_item_id')=?", bw.id) === Number(bw.max_attempts), "one job per attempt, never more");
    assert.equal(n("SELECT COUNT(*) n FROM ops_notifications WHERE dedupe_key='failed:analyze_wallet'"), 1, "one notification");
    const h = await H.healthSnapshot(); assert.ok(h.failed_work.some(f => f.id === bw.id), "visible in operations health");
    const retry = await R.queue.POST(req("/x", { id: bw.id, action: "retry" }));
    assert.equal(retry.status, 200); assert.equal(one("SELECT status FROM work_items WHERE id=?", bw.id).status, "queued");
    await cycle(3, () => one("SELECT status FROM work_items WHERE id=?", bw.id).status === "done"); await tick();
    assert.equal(one("SELECT status FROM work_items WHERE id=?", bw.id).status, "done", "an operator retry after recovery completes");
    return `${n("SELECT COUNT(*) n FROM ops_notifications") - before} notifications over the scenario`;
  });

  // ======================================================================
  await scenario("S operator routes and read models: operations, queue, tasks, graph with filters, node detail, workspace, budgets, advanced", async () => {
    await reset();
    await I.syncGlobalGraph(2000);
    const ov = await (await R.overview.GET()).json();
    for (const k of ["state", "headline", "running", "next", "campaigns", "discoveries", "findings", "human_tasks", "throughput", "budgets", "ai_activity"]) assert.ok(k in ov, `overview.${k}`);
    const q = await (await R.queue.GET(req("/api/v1/ops/queue?status=done", undefined, undefined, "GET"))).json();
    assert.ok(q.items.length && q.items.every(i => i.status === "done"));
    assert.equal((await R.queue.GET(req("/api/v1/ops/queue?status=exploded", undefined, undefined, "GET"))).status, 400);
    const g = await (await R["intel/graph"].GET(req("/api/v1/ops/intel/graph?types=domain,wallet,ip&limit=60", undefined, undefined, "GET"))).json();
    assert.ok(g.nodes.length > 0 && g.nodes.length <= 60, "bounded subgraph"); assert.ok(g.edges.every(e => e.provenance && ["observed", "deterministic"].includes(e.basis)), "every link cites its source");
    assert.ok(!g.nodes.some(nd => nd.generic), "generic hosting excluded by default");
    const focus = await (await R["intel/graph"].GET(req("/api/v1/ops/intel/graph?focus=domain:a-one.test&depth=1", undefined, undefined, "GET"))).json();
    assert.ok(focus.nodes.some(nd => nd.key === "a-one.test"));
    const nodeId = focus.nodes.find(nd => nd.key === "a-one.test").id;
    const nd = await (await R["intel/node/[id]"].GET(req("/x", undefined, undefined, "GET"), P({ id: nodeId }))).json();
    assert.ok(nd.links.length && nd.history, "node detail with links and history");
    if (formed) { const ws = await (await R["campaigns/[id]"].GET(req("/x", undefined, undefined, "GET"), P({ id: formed }))).json(); assert.ok("goal" in ws && Array.isArray(ws.timeline) && Array.isArray(ws.gaps)); }
    const adv = await (await R.advanced.GET()).json(); assert.ok(adv.health && adv.routing && adv.scheduler);
    assert.equal((await R.budgets.POST(req("/x", { scope: "global; DROP TABLE jobs", kind: "investigations", max: 5 }))).status, 400, "budget scope is validated");
    const inv = await (await R.investigations.GET()).json(); assert.ok(inv.investigations.length > 0);
    const disc = await (await R.discovery.GET()).json(); assert.ok(disc.totals);
    if (dumpUi) {
      const campaignId = formed ?? one("SELECT id FROM campaigns ORDER BY created_at LIMIT 1")?.id;
      const CV = await L("lib/campaign/view.js");
      await writeFile(dumpUi, JSON.stringify({ overview: ov, queue: await VIEW.queueView({}), tasks: { tasks: taskSnapshots, counts: { access: taskSnapshots.filter(t => t.group === "access").length, review: taskSnapshots.filter(t => t.group === "review").length, approval: taskSnapshots.filter(t => t.group === "approval").length } }, investigations: { investigations: await VIEW.investigationsView() }, discovery: disc,
        graph: g, node: nd, wallets: { wallets: await I.multiSiteWallets(20), note: "A wallet shown on several sites is a reason to look at them together, not proof they share an owner." },
        workspace: campaignId ? await VIEW.campaignWorkspace(campaignId) : null, advanced: adv, notifications: { notifications: await NT.listNotifications("open") }, campaigns: { campaigns: (CV ? await CV.listCampaigns() : []) } }, null, 2));
    }
  });
} finally {
  await rm(work, { recursive: true, force: true });
}
if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: failures === 0, scenarios: results }));
if (failures) { console.log(`\n${failures} v5 scenario(s) failed.`); process.exit(1); }
console.log(`\nAll ${results.length} v5 operations scenarios passed.`);
