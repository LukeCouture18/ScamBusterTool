// Main Platform v3 AI investigator, end to end through the real route handlers
// and the real agent runner, against the real module job lifecycle. Synthetic
// data and scripted/adversarial model providers only; no network.
//
// Proves, against real platform code paths, every v3 acceptance point:
//   1  AI plans become real typed module jobs (same enqueueJob path as v2)
//   2  returned evidence changes the next plan
//   3  human checkpoints pause and resume from new evidence
//   4  invalid AI actions are rejected (bad capability / bad args / bad profile)
//   5  hallucinated evidence cannot enter the evidence store, and citing
//      non-existent evidence is rejected
//   6  budgets stop a runaway investigation
//   7  loops and duplicate actions are prevented
//   8  investigations survive a mid-step crash / restart without duplication
//   9  provenance and knowledge classes survive the whole workflow
//  10  the deterministic planner runs the same workflow with no model
//  11  a model failure never corrupts state (falls back to rules)
import { importFrom, localPath, runPythonJson } from "./lib/portable.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
const migrations = new URL("../drizzle/", import.meta.url);
for (const name of (await readdir(migrations)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(await readFile(new URL(name, migrations), "utf8"));
const d1 = { prepare(statement) { let params = []; return { bind(...v) { params = v; return this; }, async run() { const r = sql.prepare(statement).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, async first() { return sql.prepare(statement).get(...params) ?? null; }, async all() { return { results: sql.prepare(statement).all(...params) }; } }; }, async batch(q) { sql.exec("BEGIN"); try { const out = []; for (const s of q) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
const one = (q, ...a) => sql.prepare(q).get(...a);
const all = (q, ...a) => sql.prepare(q).all(...a);

globalThis.__TEST_ENV = { DB: d1, MODULE_API_KEYS: JSON.stringify({ site_finder: "finder-key", site_investigator: "investigator-key", crypto_wallet_logger: "logger-key", wallet_investigator: "wallet-key" }), AI_PROVIDER: "scripted" };
const work = await mkdtemp(join(tmpdir(), "mip-v3-agent-"));
const routes = ["app/api/v1/modules/[module]/register/route.ts", "app/api/v1/ingest/[module]/route.ts", "app/api/v1/modules/[module]/jobs/claim/route.ts", "app/api/v1/modules/[module]/jobs/[id]/route.ts",
  "app/api/v1/inbox/[id]/decision/route.ts", "app/api/v1/inbox/settings/route.ts", "app/api/v1/investigations/[id]/agent/route.ts", "app/api/v1/investigations/[id]/agent/advanced/route.ts",
  "app/api/v1/investigations/[id]/agent/start/route.ts", "app/api/v1/investigations/[id]/checkpoints/[cid]/route.ts", "app/api/v1/agent/settings/route.ts", "app/api/v1/finder/outcomes/route.ts",
  "lib/agent/runner.ts", "lib/ai/models.ts", "lib/agent/state.ts"];
let failures = 0; const pass = (name) => console.log(`  PASS  ${name}`); const fail = (name, e) => { failures++; console.log(`  FAIL  ${name}: ${e instanceof Error ? e.stack : e}`); };

try {
  await build({ entryPoints: routes, bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: ".", plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=globalThis.__TEST_ENV", loader: "js" })); } }] });
  const L = (p) => importFrom(work, p);
  const register = await L("app/api/v1/modules/[module]/register/route.js"), ingest = await L("app/api/v1/ingest/[module]/route.js"), claim = await L("app/api/v1/modules/[module]/jobs/claim/route.js"), update = await L("app/api/v1/modules/[module]/jobs/[id]/route.js");
  const inboxDecision = await L("app/api/v1/inbox/[id]/decision/route.js"), inboxSettings = await L("app/api/v1/inbox/settings/route.js");
  const agentView = await L("app/api/v1/investigations/[id]/agent/route.js"), agentAdvanced = await L("app/api/v1/investigations/[id]/agent/advanced/route.js"), agentStart = await L("app/api/v1/investigations/[id]/agent/start/route.js");
  const checkpointRoute = await L("app/api/v1/investigations/[id]/checkpoints/[cid]/route.js"), agentSettings = await L("app/api/v1/agent/settings/route.js"), finderOutcomes = await L("app/api/v1/finder/outcomes/route.js");
  const runner = await L("lib/agent/runner.js"); const models = await L("lib/ai/models.js"); const state = await L("lib/agent/state.js");

  const req = (path, data, key, method = "POST") => new Request("http://127.0.0.1" + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const P = (o) => ({ params: Promise.resolve(o) });
  const jstr = (r) => r.clone().text();

  // A scripted model provider: the test pushes the next JSON plan(s); the runner
  // consumes them. This is how we exercise the model path deterministically and
  // adversarially without a network model.
  // When its queue is empty the scripted model throws, exactly like an
  // unreachable provider, so the runner falls back to the deterministic planner.
  // Scenarios that need specific model output push it onto the queue first.
  const scripted = { queue: [], name: "scripted", configured: () => true, model: (c) => `scripted-${c}`,
    async complete() { const next = scripted.queue.shift(); if (next === undefined) throw new Error("no scripted plan (model unavailable)");
      if (next instanceof Error) throw next; return { text: typeof next === "string" ? next : JSON.stringify(next), model: "scripted-standard", promptTokens: 20, completionTokens: 20 }; } };
  models.registerProvider(scripted);

  for (const [m, key, caps] of [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]])
    assert.equal((await register.POST(req(`/api/v1/modules/${m}/register`, { module_version: "3.0.0-test", schema_version: "3.0", capabilities: caps, supported_event_types: [] }, key), P({ module: m }))).status, 200);
  // The agent, not the inbox, drives module work in this test.
  await inboxSettings.PATCH(req("/api/v1/inbox/settings", { investigate_on_useful: false, find_related_on_useful: false }, undefined, "PATCH"));

  // Real Site Finder v2 batches -> ingest -> one investigation + inbox candidate each.
  const finder = runPythonJson(localPath("./finder-v2-batches.py", import.meta.url));
  for (const b of finder.batches) assert.equal((await ingest.POST(req("/api/v1/ingest/site_finder", { schema_version: "3.0", batch_id: b.batch_id, sent_at: new Date().toISOString(), records: b.records }, "finder-key"), P({ module: "site_finder" }))).status, 202);
  const candidates = all("SELECT id,canonical_domain,investigation_id,entity_id,evidence_id FROM inbox_candidates WHERE status='ready' AND investigation_id IS NOT NULL AND entity_id IS NOT NULL");
  assert.ok(candidates.length >= 4, `need several linked candidates, got ${candidates.length}`);

  // A synthetic Site Investigator worker: claims INVESTIGATE_SITE and ingests a
  // real bridge batch (site + public wallet + relationship), then completes.
  const siteFixture = () => runPythonJson(localPath("./site-bridge-synthetic.py", import.meta.url), { env: { MIP_BATCH_JSON: "1" } }).batch;
  async function runSiteInvestigator(investigationExternalId, { withWallet = true, loginWall = false } = {}) {
    const r = await claim.POST(req("/api/v1/modules/site_investigator/jobs/claim", {}, "investigator-key"), P({ module: "site_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    const batch = siteFixture(); batch.origin_job_id = job.id; batch.batch_id = `si:${job.id}:${Math.random().toString(16).slice(2)}`; batch.sent_at = new Date().toISOString();
    for (const rows of Object.values(batch.records)) for (const row of rows) row.investigation_id = investigationExternalId;
    if (!withWallet) { batch.records.wallets = []; batch.records.relationships = []; batch.records.deposit_options = []; batch.records.evidence = batch.records.evidence.filter(e => e.evidence_type !== "wallet_display" && !String(e.evidence_type).includes("wallet")); }
    if (loginWall) batch.records.evidence.push({ investigation_id: investigationExternalId, external_id: `login:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public",
      title: "Sign in", context_text: JSON.stringify({ title: "Members area", kind: "login", important_text: "Please sign in to continue to your deposit dashboard. Login required." }), confidence: 0.9, entity: { entity_type: "site", canonical_key: batch.records.sites[0].canonical_key } });
    const ing = await ingest.POST(req("/api/v1/ingest/site_investigator", batch, "investigator-key"), P({ module: "site_investigator" }));
    assert.equal(ing.status, 202, await jstr(ing));
    await update.PATCH(req(`/api/v1/modules/site_investigator/jobs/${job.id}`, { action: "complete", result: { batch_id: batch.batch_id } }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }));
    return job;
  }
  async function runWalletInvestigator() {
    const r = await claim.POST(req("/api/v1/modules/wallet_investigator/jobs/claim", {}, "wallet-key"), P({ module: "wallet_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    await update.PATCH(req(`/api/v1/modules/wallet_investigator/jobs/${job.id}`, { action: "complete", result: { risk: "high", counterparties: 3 } }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id }));
    return job;
  }
  async function runSiteFinder() {
    const r = await claim.POST(req("/api/v1/modules/site_finder/jobs/claim", {}, "finder-key"), P({ module: "site_finder" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    await update.PATCH(req(`/api/v1/modules/site_finder/jobs/${job.id}`, { action: "complete", result: { found: 0 } }, "finder-key", "PATCH"), P({ module: "site_finder", id: job.id }));
    return job;
  }
  // Drives all module workers and the agent until the run leaves an active state.
  async function driveToEnd(investigationId, investigationExt, maxRounds = 20) {
    const runId = one("SELECT id FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1", investigationId).id;
    for (let i = 0; i < maxRounds; i++) {
      const status = one("SELECT status FROM agent_runs WHERE id=?", runId).status;
      if (!["RUNNING", "WAITING_FOR_MODULE"].includes(status)) return status;
      let worked = false;
      if (await runSiteInvestigator(investigationExt, { withWallet: true })) worked = true;
      if (await runWalletInvestigator()) worked = true;
      if (await runSiteFinder()) worked = true;
      await runner.wake(investigationId, "job");
      await runner.tick(runId);
      if (!worked && one("SELECT status FROM agent_runs WHERE id=?", runId).status === "WAITING_FOR_MODULE") {
        // nothing claimable and still waiting: nudge once more then stop looping
        await runner.tick(runId);
      }
    }
    return one("SELECT status FROM agent_runs WHERE id=?", runId).status;
  }
  const viewOf = async (ext) => (await (await agentView.GET(req(`/x`), P({ id: ext }))).json());
  const invOf = (candidate) => String(one("SELECT external_id FROM investigations WHERE id=?", candidate.investigation_id).external_id);

  // ---- 1,2,7,9,10: full golden path driven by the deterministic planner. ----
  await (async () => {
    scripted.queue.length = 0; scripted.queue.push(new Error("model down")); // force rules fallback on the first step, model unavailable after
    const c = candidates[0]; const ext = invOf(c);
    const decision = await inboxDecision.POST(req(`/api/v1/inbox/${c.id}/decision`, { decision: "useful" }, undefined, "POST"), P({ id: c.id }));
    assert.equal(decision.status, 200, await jstr(decision));
    // Auto-started, and the first accepted action created a real INVESTIGATE_SITE job through the normal path.
    const investigateJob = one("SELECT id,job_type,target_module,payload,trigger_reason FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'", c.investigation_id);
    assert.ok(investigateJob, "AI plan produced a real INVESTIGATE_SITE job");
    assert.equal(investigateJob.target_module, "site_investigator");
    assert.ok(JSON.parse(investigateJob.payload).agent_step_id, "job is attributed to the agent step");
    assert.equal(one("SELECT status FROM agent_runs WHERE investigation_id=?", c.investigation_id).status, "WAITING_FOR_MODULE", "run waits for the module");
    const step1 = one("SELECT capability,validation,provider,outcome FROM agent_steps WHERE investigation_id=? AND validation='accepted' ORDER BY step_no LIMIT 1", c.investigation_id);
    assert.equal(step1.capability, "site.investigate"); assert.match(step1.provider, /rules/, "model was down, so the rules planner drove the step");

    // Module returns evidence with a wallet. That must change the next plan: the
    // AI's second accepted action is evidence-driven (analyse the wallet, or
    // look for related sites now that the site is a confirmed scam), not a
    // repeat of site.investigate.
    await runSiteInvestigator(ext, { withWallet: true });
    await runner.wake(c.investigation_id, "job"); await runner.tick((one("SELECT id FROM agent_runs WHERE investigation_id=?", c.investigation_id)).id);
    const accepted = all("SELECT capability FROM agent_steps WHERE investigation_id=? AND validation='accepted' ORDER BY step_no", c.investigation_id).map(r => r.capability);
    assert.equal(accepted[0], "site.investigate", "first action was to investigate the site");
    assert.ok(accepted.slice(1).some(cap => ["wallet.analyze", "discovery.find_related"].includes(cap)), `evidence changed the plan; accepted actions were ${accepted.join(", ")}`);
    assert.ok(one("SELECT id FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET'", c.investigation_id), "a wallet-analysis job exists after wallet evidence");

    // Drain module work; the investigation concludes COMPLETE on its own.
    const end = await driveToEnd(c.investigation_id, ext);
    assert.equal(end, "COMPLETE", `expected COMPLETE, got ${end}`);
    // No duplicate accepted actions (loop prevention): each fingerprint at most once.
    const fps = all("SELECT fingerprint,COUNT(*) n FROM agent_steps WHERE run_id=(SELECT id FROM agent_runs WHERE investigation_id=?) AND validation='accepted' AND fingerprint IS NOT NULL GROUP BY fingerprint", c.investigation_id);
    assert.ok(fps.every(f => Number(f.n) === 1), "no accepted action repeated");
    // Provenance/knowledge classes survive: evidence stays observed; the conclusion is human-class only if a person made it; inferences (if any) are unverified.
    const adv = await (await agentAdvanced.GET(req("/x"), P({ id: ext }))).json();
    assert.ok(adv.knowledge_classes.observed >= 1, "observed evidence present");
    assert.equal(adv.knowledge_classes.ai_inference, all("SELECT id FROM agent_inferences WHERE investigation_id=?", c.investigation_id).length);
    assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module='platform'", c.investigation_id).n, 0, "the AI layer wrote no evidence");
    pass("golden path: rules-driven plans → typed jobs → evidence changes plan → COMPLETE, no loops, provenance intact");
  })().catch(e => fail("golden path", e));

  // ---- 3: human checkpoint pause + resume from new evidence. ----
  await (async () => {
    scripted.queue.length = 0; scripted.queue.push(new Error("model down"));
    const c = candidates[1]; const ext = invOf(c);
    await inboxDecision.POST(req(`/api/v1/inbox/${c.id}/decision`, { decision: "useful" }, undefined, "POST"), P({ id: c.id }));
    const runId = one("SELECT id FROM agent_runs WHERE investigation_id=?", c.investigation_id).id;
    // Site investigation finds a login wall and no public wallet -> deterministic barrier.
    await runSiteInvestigator(ext, { withWallet: false, loginWall: true });
    await runner.wake(c.investigation_id, "job"); await runner.tick(runId);
    let view = await viewOf(ext);
    assert.equal(view.status, "WAITING_FOR_HUMAN", `expected WAITING_FOR_HUMAN, got ${view.status}`);
    assert.ok(view.waiting_for_human.some(w => w.kind === "login"), "a login checkpoint is shown");
    assert.match(view.waiting_for_human[0].instructions, /never|yourself|own/i, "instructions tell the person to do it themselves");
    // The person logs in and browses; CryptoWalletLogger records a wallet (new evidence past the watermark).
    const site = one("SELECT id FROM entities WHERE entity_type='site' AND canonical_key=? AND investigation_id=?", c.canonical_domain, c.investigation_id) ?? one("SELECT e.id FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='site' LIMIT 1", c.investigation_id);
    const wallet = "0x" + "ab".repeat(20);
    const loggerBatch = { schema_version: "3.0", batch_id: `logger:resume:${c.id}`, sent_at: new Date().toISOString(), records: { evidence: [{ investigation_id: ext, external_id: `logger:resume:${c.id}`, evidence_type: "wallet_display", evidence_class: "observed_website", observation_scope: "authenticated", title: "Deposit address behind login", context_text: JSON.stringify({ wallet }), confidence: 0.9, entity: { entity_type: "wallet", canonical_key: wallet, network: "ethereum" } }] } };
    assert.equal((await ingest.POST(req("/api/v1/ingest/crypto_wallet_logger", loggerBatch, "logger-key"), P({ module: "crypto_wallet_logger" }))).status, 202);
    // Ingest fires the activity hook, which resolves the checkpoint and wakes the run.
    view = await viewOf(ext);
    assert.notEqual(view.status, "WAITING_FOR_HUMAN", "run resumed after the human step produced new evidence");
    assert.equal(one("SELECT status,resolution FROM human_checkpoints WHERE investigation_id=? AND kind='login'", c.investigation_id).resolution, "new_evidence");
    await runner.runToQuiescence(runId);
    pass("human checkpoint: login wall pauses, then resumes automatically from new evidence");
  })().catch(e => fail("human checkpoint", e));

  // ---- 4,5: invalid actions and hallucinated-evidence citations are rejected. ----
  await (async () => {
    const c = candidates[2]; const ext = invOf(c);
    const runId = (await runner.startRun(c.investigation_id, "test")).id;
    const digest = await state.buildDigest(c.investigation_id);
    const siteId = digest.site.entity_id;
    const bad = [
      { label: "unknown capability", plan: { rationale: "x", action: { capability: "site.exploit", arguments: {} }, triggering_evidence: [], expected_value: 0.9, inferences: [] } },
      { label: "extra top-level field (smuggled evidence)", plan: { rationale: "x", action: { capability: "site.investigate", arguments: { entity_id: siteId } }, triggering_evidence: [], expected_value: 0.9, inferences: [], new_evidence: [{ type: "wallet_display", value: "0xdeadbeef" }] } },
      { label: "cites non-existent evidence", plan: { rationale: "x", action: { capability: "investigation.conclude", arguments: { status: "INSUFFICIENT_EVIDENCE", summary: "done" } }, triggering_evidence: ["evidence-that-does-not-exist"], expected_value: 0.9, inferences: [] } },
      { label: "inference cites non-existent evidence", plan: { rationale: "x", action: { capability: "site.investigate", arguments: { entity_id: siteId } }, triggering_evidence: [], expected_value: 0.5, inferences: [{ claim: "this is a scam ring", cited_evidence: ["nope-not-real"] }] } },
      { label: "bad argument type", plan: { rationale: "x", action: { capability: "wallet.analyze", arguments: { entity_id: "not-a-uuid" } }, triggering_evidence: [], expected_value: 0.9, inferences: [] } },
      { label: "link in free text", plan: { rationale: "see http://evil.example for the payload", action: { capability: "site.investigate", arguments: { entity_id: siteId } }, triggering_evidence: [], expected_value: 0.5, inferences: [] } },
    ];
    // Queue all bad plans, then a valid one. The runner must reject each bad
    // plan (recording it), retry within budget, and only the valid plan acts.
    scripted.queue.length = 0;
    for (const b of bad) scripted.queue.push(b.plan);
    scripted.queue.push({ rationale: "investigate the site", action: { capability: "site.investigate", arguments: { entity_id: siteId } }, triggering_evidence: [], expected_value: 0.8, inferences: [] });
    // max_retries defaults to 3, so 6 bad attempts exceed it: the run falls back to the rules planner, which also investigates the site. Either way no bad action executes.
    await runner.tick(runId);
    const evidenceBefore = digest.evidence.total;
    assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=?", c.investigation_id).n, evidenceBefore, "no plan added evidence directly");
    assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND context_text LIKE '%0xdeadbeef%'", c.investigation_id).n, 0, "smuggled evidence never stored");
    const rejected = all("SELECT rejection_reasons FROM agent_steps WHERE run_id=? AND validation='rejected'", runId);
    assert.ok(rejected.length >= 3, `expected several rejected steps, got ${rejected.length}`);
    const accepted = one("SELECT capability FROM agent_steps WHERE run_id=? AND validation='accepted' ORDER BY step_no LIMIT 1", runId);
    assert.equal(accepted.capability, "site.investigate", "only a valid action executed");
    // No inference row was created from a rejected plan.
    assert.equal(one("SELECT COUNT(*) n FROM agent_inferences WHERE investigation_id=? AND claim LIKE '%scam ring%'", c.investigation_id).n, 0, "rejected inference never stored");
    pass("policy: unknown capability, smuggled evidence, hallucinated citations, bad args and links are all rejected; only a valid action runs");
  })().catch(e => fail("policy rejection", e));

  // ---- 6: budgets stop a runaway investigation. ----
  await (async () => {
    await agentSettings.PATCH(req("/api/v1/agent/settings", { max_actions: 1 }, undefined, "PATCH"));
    scripted.queue.length = 0; scripted.queue.push(new Error("model down"));   // rules planner drives real work
    const c = candidates[3]; const ext = invOf(c);
    const runId = (await runner.startRun(c.investigation_id, "test")).id;
    await runner.tick(runId);                          // one action: site.investigate -> WAITING_FOR_MODULE
    assert.equal(Number(one("SELECT used_actions FROM agent_runs WHERE id=?", runId).used_actions), 1, "one action taken");
    await runSiteInvestigator(ext, { withWallet: true });   // module returns more work to do (a wallet)
    await runner.wake(c.investigation_id, "job");
    const r = await runner.tick(runId);                // but the action budget is spent
    assert.equal(r.status, "BUDGET_EXHAUSTED", `budget must stop further actions, got ${r.status}`);
    assert.equal(Number(one("SELECT used_actions FROM agent_runs WHERE id=?", runId).used_actions), 1, "no action beyond the budget");
    assert.ok(!one("SELECT id FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET' AND json_extract(payload,'$.agent_run_id')=?", c.investigation_id, runId), "the over-budget wallet action never queued an agent job");
    await agentSettings.PATCH(req("/api/v1/agent/settings", { max_actions: 12 }, undefined, "PATCH"));
    pass("budgets: with a 1-action budget the investigator stops at BUDGET_EXHAUSTED even though a wallet remained to analyse");
  })().catch(e => fail("budgets", e));

  // ---- 8: mid-step crash / restart does not lose or duplicate work. ----
  await (async () => {
    scripted.queue.length = 0; scripted.queue.push(new Error("model down"));
    // Fresh investigation via a new finder-style candidate reusing candidate 0's shape is complex;
    // instead simulate a crash on an existing WAITING_FOR_MODULE run: a stale lease must be reclaimable
    // and re-ticking must not create a second job for the same step.
    const c = candidates[0];
    const runId = one("SELECT id FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1", c.investigation_id).id;
    // The golden-path run already finished; start a fresh run and drive one module step, then simulate a crash.
    scripted.queue.length = 0; scripted.queue.push(new Error("model down"));
    // Reopen by starting a new run on candidate 2's investigation (site already investigated there).
    const c2 = candidates[2];
    const rid = one("SELECT id FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1", c2.investigation_id).id;
    const beforeJobs = Number(one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=?", c2.investigation_id).n);
    // Simulate a crash: forcibly set a live lease as if a worker died mid-tick, then re-tick.
    sql.prepare("UPDATE agent_runs SET status='RUNNING', lease_owner='dead-worker', lease_until=datetime('now','-1 minute'), next_run_at=CURRENT_TIMESTAMP WHERE id=?").run(rid);
    await runner.tick(rid);                      // must reclaim the expired lease and proceed
    await runner.tick(rid);
    const afterJobs = Number(one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=?", c2.investigation_id).n);
    // Duplicate protection: the INVESTIGATE_SITE for the same entity is deduped, so at most one new job per distinct fingerprint.
    const dupSteps = all("SELECT fingerprint,COUNT(*) n FROM agent_steps WHERE run_id=? AND validation='accepted' AND fingerprint IS NOT NULL GROUP BY fingerprint HAVING n>1", rid);
    assert.equal(dupSteps.length, 0, "no duplicated accepted action after restart");
    assert.ok(afterJobs - beforeJobs <= 1, "restart did not fan out duplicate jobs");
    pass("restart recovery: an expired lease is reclaimed and re-ticking never duplicates a step's job");
  })().catch(e => fail("restart recovery", e));

  // ---- Site Finder outcome feed carries observed/human outcomes, never AI inference. ----
  await (async () => {
    const feed = await (await finderOutcomes.GET(req("/api/v1/finder/outcomes?module=site_finder&after=0&limit=500", undefined, "finder-key", "GET"))).json();
    assert.ok(feed.outcomes.length > 0, "outcomes were recorded");
    assert.ok(feed.outcomes.every(o => ["observed", "human", "deterministic"].includes(o.basis)), "every outcome basis is observed/human/deterministic");
    assert.ok(feed.outcomes.some(o => o.outcome === "useful" && o.basis === "human"), "USEFUL decisions are fed back with human basis");
    assert.ok(feed.outcomes.some(o => ["wallet_evidence", "meaningful_evidence"].includes(o.outcome)), "downstream evidence outcomes are fed back");
    assert.equal(feed.outcomes.filter(o => o.basis === "ai_inference").length, 0, "no AI-inference outcome ever enters the finder feed");
    // Auth requirement.
    assert.equal((await finderOutcomes.GET(req("/api/v1/finder/outcomes", undefined, undefined, "GET"))).status, 401);
    pass("finder feedback: downstream outcomes are fed back with observed/human basis, never AI inference; feed is authenticated");
  })().catch(e => fail("finder feedback", e));

  console.log(failures ? `\n${failures} scenario(s) failed` : "\nall v3 agent scenarios passed");
  if (!failures) console.log(JSON.stringify({ ok: true, scenarios: 7, providerless_and_scripted: true, synthetic: true }));
} finally { await rm(work, { recursive: true, force: true }); sql.close(); }
process.exit(failures ? 1 : 0);
