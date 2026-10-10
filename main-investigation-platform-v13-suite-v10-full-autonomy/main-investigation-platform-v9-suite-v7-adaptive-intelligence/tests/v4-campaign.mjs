// Main Platform v4 campaigns, end to end through the real route handlers, the
// real campaign orchestrator, the real v3 investigator and the real module job
// lifecycle. Synthetic data and scripted/adversarial model providers only; no
// network.
//
// Proves, against real platform code paths:
//   A  campaigns coordinate multiple real investigations; one highly connected
//      site outranks twenty near-identical kit mirrors, which are suppressed;
//      new module evidence reprioritizes pending work; provenance survives
//   B  hypotheses are supported, disproved, and later weakened by a person's
//      contradicting decision; a module's unverifiable claims do not count
//   C  a Reviewer rejection prevents the work (deterministic and model-added)
//   D  campaign budgets stop expansion; raising the budget resumes
//   E  discovery saturation stops low-value pivots
//   F  a human checkpoint pauses only the affected investigation
//   G  campaigns survive a crash/restart mid-step without duplicate work
//   H  provider failures recover safely; the deterministic path needs no model
//   I  adversarial model output and forged inputs are rejected
//   J  learning: real outcomes move priorities; AI self-evaluation does not
import { importFrom, localPath, runPythonJson } from "./lib/portable.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

globalThis.__TEST_ENV = { DB: d1, MODULE_API_KEYS: JSON.stringify({ site_finder: "finder-key", site_investigator: "investigator-key", crypto_wallet_logger: "logger-key", wallet_investigator: "wallet-key" }), AI_PROVIDER: "rules" };
const work = await mkdtemp(join(tmpdir(), "mip-v4-campaign-"));
const routes = ["app/api/v1/modules/[module]/register/route.ts", "app/api/v1/ingest/[module]/route.ts", "app/api/v1/modules/[module]/jobs/claim/route.ts", "app/api/v1/modules/[module]/jobs/[id]/route.ts",
  "app/api/v1/inbox/[id]/decision/route.ts", "app/api/v1/inbox/settings/route.ts", "app/api/v1/agent/settings/route.ts",
  "app/api/v1/campaigns/route.ts", "app/api/v1/campaigns/[id]/route.ts", "app/api/v1/campaigns/[id]/control/route.ts", "app/api/v1/campaigns/[id]/budget/route.ts",
  "app/api/v1/campaigns/[id]/graph/route.ts", "app/api/v1/campaigns/[id]/advanced/route.ts", "app/api/v1/campaigns/[id]/tasks/route.ts",
  "lib/campaign/campaign.ts", "lib/campaign/graph.ts", "lib/campaign/hypotheses.ts", "lib/campaign/experience.ts", "lib/campaign/reviewer.ts", "lib/campaign/roles.ts", "lib/campaign/priority.ts",
  "lib/agent/runner.ts", "lib/ai/models.ts", "lib/jobs.ts"];
let failures = 0; const pass = (name) => console.log(`  PASS  ${name}`); const fail = (name, e) => { failures++; console.log(`  FAIL  ${name}: ${e instanceof Error ? e.stack : e}`); };

try {
  await build({ entryPoints: routes, bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: ".", plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=globalThis.__TEST_ENV", loader: "js" })); } }] });
  const L = (p) => importFrom(work, p);
  const register = await L("app/api/v1/modules/[module]/register/route.js"), ingest = await L("app/api/v1/ingest/[module]/route.js"), claim = await L("app/api/v1/modules/[module]/jobs/claim/route.js"), update = await L("app/api/v1/modules/[module]/jobs/[id]/route.js");
  const inboxDecision = await L("app/api/v1/inbox/[id]/decision/route.js"), inboxSettings = await L("app/api/v1/inbox/settings/route.js"), agentSettings = await L("app/api/v1/agent/settings/route.js");
  const campaignsRoute = await L("app/api/v1/campaigns/route.js"), campaignRoute = await L("app/api/v1/campaigns/[id]/route.js"), controlRoute = await L("app/api/v1/campaigns/[id]/control/route.js"), budgetRoute = await L("app/api/v1/campaigns/[id]/budget/route.js");
  const graphRoute = await L("app/api/v1/campaigns/[id]/graph/route.js"), advancedRoute = await L("app/api/v1/campaigns/[id]/advanced/route.js"), tasksRoute = await L("app/api/v1/campaigns/[id]/tasks/route.js");
  const campaign = await L("lib/campaign/campaign.js"), graph = await L("lib/campaign/graph.js"), hyps = await L("lib/campaign/hypotheses.js"), experience = await L("lib/campaign/experience.js"), reviewer = await L("lib/campaign/reviewer.js"), roles = await L("lib/campaign/roles.js");
  const runner = await L("lib/agent/runner.js"); const models = await L("lib/ai/models.js"); const jobs = await L("lib/jobs.js");

  const req = (path, data, key, method = "POST") => new Request("http://127.0.0.1" + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const P = (o) => ({ params: Promise.resolve(o) });

  // Scripted model provider: tests push replies; an empty queue behaves like an unreachable provider.
  const scripted = { queue: [], calls: 0, name: "scripted", configured: () => true, model: (c) => `scripted-${c}`,
    async complete() { scripted.calls++; const next = scripted.queue.shift(); if (next === undefined) throw new Error("no scripted reply (model unavailable)");
      if (next instanceof Error) throw next; return { text: typeof next === "string" ? next : JSON.stringify(next), model: "scripted-fast", promptTokens: 30, completionTokens: 20 }; } };
  models.registerProvider(scripted);
  const useModel = (on) => { globalThis.__TEST_ENV.AI_PROVIDER = on ? "scripted" : "rules"; };

  for (const [m, key, caps] of [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]])
    assert.equal((await register.POST(req(`/api/v1/modules/${m}/register`, { module_version: "4.0.0-test", schema_version: "3.0", capabilities: caps, supported_event_types: [] }, key), P({ module: m }))).status, 200);
  // Campaigns, not the inbox, drive module work here.
  await inboxSettings.PATCH(req("/api/v1/inbox/settings", { investigate_on_useful: false, find_related_on_useful: false }, undefined, "PATCH"));
  await agentSettings.PATCH(req("/api/v1/agent/settings", { auto_start_on_useful: false }, undefined, "PATCH"));

  // ---------------------------------------------------------------- world
  // A real Site Finder v2 inbox batch is the template; each synthetic site is a
  // copy with its own domain, kit cluster, public indicator keys and wallets.
  const template = runPythonJson(localPath("./finder-v2-batches.py", import.meta.url)).batches[0];
  const tDomain = template.records.sites[0].canonical_key, tHash = template.records.sites[0].external_id.split(":").pop();
  const md5 = (s) => createHash("md5").update(s).digest("hex");
  // The platform rate-limits each module per minute. These scenarios compress hours of
  // module traffic into seconds, so each simulated scheduler minute starts a new window.
  const nextMinute = () => sql.exec("DELETE FROM rate_limit_windows");
  async function site(domain, { cluster, keys = [], wallets = [], score = 0.9 } = {}) {
    if (Number(one("SELECT COALESCE(MAX(request_count),0) n FROM rate_limit_windows").n ?? 0) > 60) nextMinute();
    const text = JSON.stringify(template.records).split(tDomain).join(domain).split(tHash).join(md5(domain));
    const records = JSON.parse(text);
    Object.assign(records.sites[0].inbox, { cluster_key: cluster ?? `c:${domain}`, keys, wallets, worth_checking: score, related_domains: [] });
    records.sites[0].confidence = score; records.sites[0].triage.confidence = score;
    const r = await ingest.POST(req("/api/v1/ingest/site_finder", { schema_version: "3.0", batch_id: `v4:${domain}:${md5(JSON.stringify(keys) + cluster)}`, sent_at: new Date().toISOString(), records }, "finder-key"), P({ module: "site_finder" }));
    assert.equal(r.status, 202, await r.clone().text());
    const c = one("SELECT * FROM inbox_candidates WHERE canonical_domain=?", domain);
    assert.ok(c && c.investigation_id, `candidate ${domain} ingested with an investigation`);
    return c;
  }

  // Module workers. Site Investigator behaviour is planned per domain.
  const siPlan = new Map();                                   // domain -> {wallet, loginWall}
  const siTemplate = runPythonJson(localPath("./site-bridge-synthetic.py", import.meta.url), { env: { MIP_BATCH_JSON: "1" } }).batch;
  const siWallet = siTemplate.records.wallets[0].address;
  async function runSiteInvestigator() {
    const r = await claim.POST(req("/api/v1/modules/site_investigator/jobs/claim", {}, "investigator-key"), P({ module: "site_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    const inv = one("SELECT i.external_id, c.canonical_domain FROM investigations i LEFT JOIN inbox_candidates c ON c.investigation_id=i.id WHERE i.id=?", job.investigation_id);
    const plan = siPlan.get(inv.canonical_domain) ?? { wallet: null };
    const text = JSON.stringify(siTemplate).split("synthetic.example").join(inv.canonical_domain).split("_synthetic").join(`_${md5(inv.canonical_domain + job.id).slice(0, 10)}`)
      .split(siWallet).join(plan.wallet ?? siWallet);
    const batch = JSON.parse(text); batch.origin_job_id = job.id; batch.batch_id = `si:${job.id}`; batch.sent_at = new Date().toISOString();
    for (const rows of Object.values(batch.records)) for (const row of rows) row.investigation_id = inv.external_id;
    if (!plan.wallet) { batch.records.wallets = []; batch.records.relationships = []; batch.records.deposit_options = []; batch.records.evidence = batch.records.evidence.filter(e => !String(e.evidence_type).includes("wallet")); }
    if (plan.loginWall) batch.records.evidence.push({ investigation_id: inv.external_id, external_id: `login:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public",
      title: "Sign in", context_text: JSON.stringify({ title: "Members area", kind: "login", important_text: "Please sign in to continue to your deposit dashboard. Login required." }), confidence: 0.9, entity: { entity_type: "site", canonical_key: inv.canonical_domain } });
    const ing = await ingest.POST(req("/api/v1/ingest/site_investigator", batch, "investigator-key"), P({ module: "site_investigator" }));
    assert.equal(ing.status, 202, await ing.clone().text());
    await update.PATCH(req(`/api/v1/modules/site_investigator/jobs/${job.id}`, { action: "complete", result: { batch_id: batch.batch_id } }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }));
    return { job, domain: inv.canonical_domain };
  }
  async function runWalletInvestigator() {
    const r = await claim.POST(req("/api/v1/modules/wallet_investigator/jobs/claim", {}, "wallet-key"), P({ module: "wallet_investigator" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    await update.PATCH(req(`/api/v1/modules/wallet_investigator/jobs/${job.id}`, { action: "complete", result: { risk: "high" } }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id }));
    return job;
  }
  // Site Finder worker. `finderPlan(payload)` decides what a pivot finds: new sites to ingest and the job result.
  let finderPlan = async () => ({ sites: [], result: { new_candidates: [], saturated: false } });
  const finderJobs = [];
  async function runSiteFinder() {
    const r = await claim.POST(req("/api/v1/modules/site_finder/jobs/claim", {}, "finder-key"), P({ module: "site_finder" }));
    if (r.status !== 200) return null; const job = (await r.json()).job; if (!job) return null;
    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    finderJobs.push({ id: job.id, type: job.job_type, payload });
    const out = payload.pivot ? await finderPlan(payload) : { sites: [], result: { found: 0 } };
    for (const s of out.sites ?? []) await site(s.domain, s);
    await update.PATCH(req(`/api/v1/modules/site_finder/jobs/${job.id}`, { action: "complete", result: out.result }, "finder-key", "PATCH"), P({ module: "site_finder", id: job.id }));
    return job;
  }
  async function workAll() {
    let n = 0;
    for (let i = 0; i < 30; i++) { const a = await runSiteInvestigator(), b = await runWalletInvestigator(), c = await runSiteFinder(); if (!a && !b && !c) break; n++; }
    for (const r of all("SELECT id FROM agent_runs WHERE status='RUNNING' AND started_by LIKE 'campaign:%'")) await runner.tick(r.id);
    return n;
  }
  // Drives modules, the per-site investigators and campaign ticks until the campaign stops or `rounds` pass.
  async function drive(cid, rounds = 25, { until } = {}) {
    for (let i = 0; i < rounds; i++) {
      nextMinute();
      const s = one("SELECT status FROM campaigns WHERE id=?", cid).status;
      if (s !== "RUNNING") return s;
      await campaign.tickCampaign(cid);
      await workAll();
      if (until && until()) return one("SELECT status FROM campaigns WHERE id=?", cid).status;
    }
    return one("SELECT status FROM campaigns WHERE id=?", cid).status;
  }
  const opp = (cid, fingerprint) => one("SELECT * FROM opportunities WHERE campaign_id=? AND fingerprint=?", cid, fingerprint);
  const factors = (o) => JSON.parse(o.factors);
  const start = async (seed, budgets = {}, extra = {}) => {
    const r = await campaignsRoute.POST(req("/api/v1/campaigns", { seed_domain: seed, budgets, ...extra }));
    assert.equal(r.status, 201, await r.clone().text());
    return (await r.json()).id;
  };

  // ======================================================================
  // A. Coordination, priority, duplicates, reprioritization, provenance
  // ======================================================================
  await (async () => {
    const T = "favtmpl", tmplA = "fav-a|tmpl-a", ipSeed = "198.51.100.7";
    await site("alpha-seed.test", { cluster: "kit:alpha", keys: [[T, tmplA], ["ip", ipSeed], ["favicon", "fav-a"]] });
    // Twenty mirrors of the seed's page template on their own hosts. Site Finder did not cluster them
    // (different names and IPs), so the v2 inbox's same-cluster mirror rule does not catch them.
    for (let i = 1; i <= 20; i++) await site(`alpha-mirror${i}.test`, { keys: [[T, tmplA], ["ip", `203.0.113.${i}`], ["favicon", "fav-a"]], score: 0.93 });
    // One highly connected site: same host as the seed, and a wallet it shares with another site, plus its own name-server set.
    await site("hub-exchange.test", { keys: [["ip", ipSeed], ["ns", "ns1.hubdns.test|ns2.hubdns.test"]], wallets: ["TWalletHubShared0000000000000000001"], score: 0.8 });
    await site("hub-partner.test", { keys: [["ns", "ns1.hubdns.test|ns2.hubdns.test"], ["service", "tawk:hubchat"]], wallets: ["TWalletHubShared0000000000000000001"], score: 0.75 });
    // A pending site linked to the others only by a chat service now; its public wallet will matter later.
    await site("late-riser.test", { keys: [["service", "tawk:hubchat"]], wallets: ["TWalletLateRiser00000000000000000009"], score: 0.6 });
    await site("unrelated.test", { keys: [["ip", "192.0.2.200"]], score: 0.99 });
    siPlan.set("alpha-seed.test", { wallet: "TWalletLateRiser00000000000000000009" });   // the seed turns out to show late-riser's wallet
    siPlan.set("hub-exchange.test", { wallet: "TWalletHubShared0000000000000000001" });
    siPlan.set("hub-partner.test", { wallet: "TWalletHubShared0000000000000000001" });

    const cid = await start("alpha-seed.test", { max_parallel: 1, max_investigations: 6, max_discovery_requests: 0 });
    await campaign.tickCampaign(cid);                      // second hop of association
    const members = all("SELECT domain,state FROM campaign_members WHERE campaign_id=?", cid).map(m => m.domain);
    for (const d of ["alpha-seed.test", "alpha-mirror7.test", "hub-exchange.test", "hub-partner.test", "late-riser.test"]) assert.ok(members.includes(d), `${d} associated by an observable link`);
    assert.ok(!members.includes("unrelated.test"), "a site with no observable link is not associated, however high its score");
    // Every association carries a reason that names the observable link, never ownership.
    for (const m of all("SELECT reason FROM campaign_members WHERE campaign_id=? AND role='member'", cid)) assert.match(m.reason, /same kit|shares/);
    assert.equal(all("SELECT reason FROM campaign_members WHERE campaign_id=? AND (reason LIKE '%owner%' OR reason LIKE '%operated by%')", cid).length, 0);

    // One highly connected site outranks twenty near-identical mirrors, which collapse to one representative.
    const hub = opp(cid, "investigate:hub-exchange.test");
    const mirrors = all("SELECT * FROM opportunities WHERE campaign_id=? AND target_key LIKE 'alpha-mirror%'", cid);
    assert.equal(mirrors.length, 20);
    assert.ok(mirrors.every(m => Number(m.priority) < Number(hub.priority)), `hub ${hub.priority} outranks every mirror (best mirror ${Math.max(...mirrors.map(m => m.priority))})`);
    assert.ok(factors(hub).relationship > factors(mirrors[0]).relationship || factors(hub).dup_prob < factors(mirrors[0]).dup_prob);
    const suppressed = mirrors.filter(m => m.status === "suppressed");
    assert.ok(suppressed.length >= 19, `near-identical mirrors suppressed (${suppressed.length}/20)`);
    assert.ok(suppressed.every(m => /Near-identical/.test(m.reason)), "suppression explains itself");

    // Reprioritization from new evidence: record late-riser's priority, let the investigations run.
    const before = Number(opp(cid, "investigate:late-riser.test").priority);
    const status = await drive(cid, 30, { until: () => one("SELECT state FROM campaign_members WHERE campaign_id=? AND domain='alpha-seed.test'", cid).state === "done" });
    assert.equal(status, "RUNNING");
    await campaign.tickCampaign(cid);
    const lr = opp(cid, "investigate:late-riser.test");
    // Late-riser must not have been started before the evidence arrived; after it, its priority rose.
    const lrRun = lr.run_id ? one("SELECT started_at FROM agent_runs WHERE id=?", lr.run_id) : null;
    assert.ok(!lrRun || lr.status !== "open");
    const lrFactors = factors(lr);
    assert.ok(Number(lr.priority) > before || lr.status !== "open", `new wallet evidence on the seed raised late-riser (${before} -> ${lr.priority})`);
    assert.equal(lrFactors.proven_link, 1, "late-riser now shows a wallet observed on a confirmed site");
    const reprio = `${before} -> ${lr.priority} (${lr.status})`;
    const walletEdge = one("SELECT * FROM campaign_edges WHERE campaign_id=? AND src_key='alpha-seed.test' AND dst_type='wallet' AND source_table='investigation_entities'", cid);
    assert.ok(walletEdge, "the Site Investigator's wallet observation became a provenance-bearing edge");

    const end = await drive(cid, 40);
    assert.ok(["COMPLETE", "BUDGET_EXHAUSTED"].includes(end), `campaign ends on its own (${end}): ${JSON.stringify({ c: one("SELECT headline,why,used_investigations,max_investigations FROM campaigns WHERE id=?", cid), members: all("SELECT domain,state FROM campaign_members WHERE campaign_id=? AND state NOT IN ('suppressed')", cid), ops: all("SELECT kind,target_key,status,reason FROM opportunities WHERE campaign_id=? AND status IN ('open','executing')", cid), runs: all("SELECT status,headline,max_module_calls,used_module_calls,max_actions,used_actions,max_model_calls,used_model_calls,max_discovery_expansions FROM agent_runs WHERE started_by=?", `campaign:${cid}`), steps: all("SELECT s.capability,s.validation,s.outcome,s.rationale FROM agent_steps s JOIN agent_runs r ON r.id=s.run_id WHERE r.started_by=? AND r.status='WAITING_FOR_MODULE'", `campaign:${cid}`) })}`);
    // Coordinated real investigations, each exactly once; no mirror investigated.
    const runs = all("SELECT investigation_id,COUNT(*) n FROM agent_runs WHERE started_by=? GROUP BY investigation_id", `campaign:${cid}`);
    assert.ok(runs.length >= 3, `the campaign ran several real investigations (${runs.length})`);
    assert.ok(runs.every(r => r.n === 1), "no investigation ran twice");
    const investigated = all("SELECT o.target_key FROM opportunities o WHERE o.campaign_id=? AND o.status='done' AND o.kind='investigate_candidate'", cid).map(r => r.target_key);
    assert.ok(investigated.includes("hub-exchange.test"));
    assert.ok(investigated.filter(d => d.startsWith("alpha-mirror")).length <= 1, `at most one mirror investigated (${investigated.filter(d => d.startsWith("alpha-mirror")).length})`);
    for (const r of all("SELECT investigation_id,COUNT(*) n FROM jobs WHERE job_type='INVESTIGATE_SITE' GROUP BY investigation_id")) assert.equal(r.n, 1, "one site investigation per site");
    // The hub was investigated before any mirror.
    const order = all("SELECT o.target_key FROM opportunities o JOIN agent_runs r ON r.id=o.run_id WHERE o.campaign_id=? ORDER BY r.started_at, r.rowid", cid).map(r => r.target_key);
    const firstMirror = order.findIndex(d => d.startsWith("alpha-mirror"));
    assert.ok(firstMirror === -1 || order.indexOf("hub-exchange.test") < firstMirror, `hub before mirrors: ${order.join(", ")}`);

    // Provenance survives the whole campaign.
    for (const e of all("SELECT * FROM campaign_edges WHERE campaign_id=?", cid)) {
      assert.ok(["observed", "deterministic"].includes(e.basis), "edge basis is observed or deterministic");
      assert.ok(one(`SELECT 1 FROM ${e.source_table} WHERE id=?`, e.source_ref), `edge ${e.id} cites a real ${e.source_table} row`);
      assert.notEqual(e.src_type, "hypothesis"); assert.notEqual(e.dst_type, "hypothesis");
    }
    assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE source_module='platform'").n, 0, "the campaign layer wrote no evidence");
    // Views: simple overview, graph, advanced.
    const view = await (await campaignRoute.GET(req("/x"), P({ id: cid }))).json();
    assert.ok(view.doing && view.progress.sites >= 5 && Array.isArray(view.findings) && Array.isArray(view.budget));
    assert.ok(!("opportunities" in view) && !("traces" in view), "the default view does not expose scoring tables or traces");
    const g = await (await graphRoute.GET(req("/x"), P({ id: cid }))).json();
    assert.ok(g.edges.length > 5 && g.edges.every(e => e.provenance && e.basis) && /ownership/.test(g.note));
    const adv = await (await advancedRoute.GET(req("/x"), P({ id: cid }))).json();
    assert.ok(adv.opportunities.length && adv.traces.some(t => t.role === "reviewer") && adv.traces.some(t => t.role === "researcher") && adv.economics.investigations >= 3);
    assert.ok(adv.economics.cost_per_useful_investigation !== undefined && adv.economics.useful_evidence_per_action !== undefined);
    pass(`A coordination: linked sites found, hub outranks 20 mirrors (${suppressed.length} suppressed), module evidence reprioritized late-riser ${reprio}, ${runs.length} real investigations each run once, provenance intact`);
  })().catch(e => fail("A coordination", e));

  // ======================================================================
  // B. Hypotheses: supported, disproved, contradicted by a person
  // ======================================================================
  await (async () => {
    await site("beta-seed.test", { keys: [["ip", "198.51.100.40"], ["san", "beta-seed.test|beta-two.test"]], score: 0.9 });
    await site("beta-two.test", { keys: [["ip", "198.51.100.40"], ["san", "beta-seed.test|beta-two.test"]], score: 0.85 });
    const cid = await start("beta-seed.test", { max_parallel: 3, max_discovery_requests: 4, max_investigations: 2 });
    const created = all("SELECT * FROM hypotheses WHERE campaign_id=?", cid);
    assert.ok(created.some(h => h.test_target === "ip:198.51.100.40") && created.some(h => h.test_target.startsWith("san:")), "hypotheses from repeated observed indicators");
    for (const h of created) {
      assert.ok(["proposed", "testing"].includes(h.status)); assert.equal(Number(h.confidence), 0.5, "no confidence before a test result");
      assert.ok(JSON.parse(h.observation_refs).every(ref => one("SELECT 1 FROM campaign_edges WHERE id=?", ref)), "each observation cites real edges");
    }
    assert.equal(one("SELECT COUNT(*) n FROM campaign_edges WHERE src_type='hypothesis' OR dst_type='hypothesis'").n, 0, "hypotheses never become edges");
    // Site Finder: the IP pivot finds a real new site on that IP; the SAN pivot finds nothing but
    // claims a domain it never delivered (an unverifiable claim).
    finderPlan = async (p) => p.pivot.kind === "ip"
      ? { sites: [{ domain: "beta-three.test", keys: [["ip", "198.51.100.40"]], score: 0.8 }], result: { new_candidates: ["beta-three.test"], saturated: false } }
      : { sites: [], result: { new_candidates: ["never-delivered.test"], saturated: false } };
    await drive(cid, 30, { until: () => all("SELECT 1 FROM hypotheses WHERE campaign_id=? AND status IN ('supported','disproved')", cid).length >= 2 });
    const ip = one("SELECT * FROM hypotheses WHERE campaign_id=? AND test_target='ip:198.51.100.40'", cid);
    const san = one("SELECT * FROM hypotheses WHERE campaign_id=? AND test_target LIKE 'san:%'", cid);
    assert.equal(ip.status, "supported", `ip hypothesis ${ip.status} ${ip.confidence}`);
    assert.equal(san.status, "disproved", `san hypothesis ${san.status} ${san.confidence}`);
    const sanHist = JSON.parse(san.history).pop();
    assert.match(sanHist.reason, /none observably share/, "an unverifiable claim does not count as support");
    assert.ok(one("SELECT 1 FROM campaign_members WHERE campaign_id=? AND domain='beta-three.test'", cid), "the verified new site joins the campaign");
    assert.ok(!one("SELECT 1 FROM campaign_members WHERE campaign_id=? AND domain='never-delivered.test'", cid));
    // A person then says the new site is not a scam: the supported hypothesis loses confidence.
    const c3 = one("SELECT id FROM inbox_candidates WHERE canonical_domain='beta-three.test'");
    assert.equal((await inboxDecision.POST(req(`/api/v1/inbox/${c3.id}/decision`, { decision: "skip", reason: "not_a_scam" }), P({ id: c3.id }))).status, 200);
    if (one("SELECT status FROM campaigns WHERE id=?", cid).status !== "RUNNING") await campaign.control(cid, "resume");
    await campaign.tickCampaign(cid);
    const after = one("SELECT * FROM hypotheses WHERE id=?", ip.id);
    assert.ok(Number(after.confidence) < Number(ip.confidence), `contradicted by a person: ${ip.confidence} -> ${after.confidence}`);
    assert.notEqual(after.status, "supported");
    assert.equal(JSON.parse(after.history).pop().basis, "human");
    // Pivot jobs are typed, bounded Site Finder requests carrying the context Finder learns under.
    const pj = finderJobs.filter(j => j.payload.campaign_id === cid);
    assert.ok(pj.length >= 2 && pj.every(j => j.type === "FIND_RELATED_SITES" && /type=/.test(j.payload.context) && j.payload.hypothesis_id && j.payload.requested <= 10 && j.payload.automation_policy));
    // Experience recorded for both pivots with observed basis and real job refs.
    const exp = all("SELECT * FROM experience WHERE campaign_id=? AND action LIKE 'pivot:%'", cid);
    assert.ok(exp.length >= 2 && exp.every(e => e.basis === "observed" && one("SELECT 1 FROM jobs WHERE id=?", e.source_ref)));
    pass("B hypotheses: ip supported by a verified site, san disproved (unverifiable claim ignored), person's skip weakens the supported one");
  })().catch(e => fail("B hypotheses", e));

  // ======================================================================
  // C. Reviewer rejection prevents work
  // ======================================================================
  await (async () => {
    await site("gamma-seed.test", { keys: [["ip", "198.51.100.60"]] });
    const pre = await site("gamma-already.test", { keys: [["ip", "198.51.100.60"]] });
    await site("gamma-model.test", { keys: [["ip", "198.51.100.60"], ["favicon", "gamma-fav"]] });
    // Someone already queued a site investigation for gamma-already outside the campaign.
    const ent = one("SELECT entity_id FROM inbox_candidates WHERE id=?", pre.id).entity_id;
    await jobs.enqueueJob({ job_type: "INVESTIGATE_SITE", investigation_id: pre.investigation_id, target_entity_id: ent, target_module: "site_investigator", created_by_module: "platform", payload: {}, trigger_reason: "manual" });
    const jobsBefore = one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=?", pre.investigation_id).n;
    const cid = await start("gamma-seed.test", { max_parallel: 3, max_discovery_requests: 0 });
    await campaign.tickCampaign(cid);
    const o = opp(cid, "investigate:gamma-already.test");
    assert.equal(o.status, "rejected", `already-attempted work is rejected (${o.status}: ${o.reason})`);
    const rev = JSON.parse(o.result).review;
    assert.equal(rev.verdict, "reject"); assert.ok(rev.checks.find(c => c.question === "attempted" && !c.pass));
    assert.deepEqual(rev.checks.map(c => c.question).sort(), ["attempted", "budget", "cheaper", "evidence", "repetitive", "wrong", "yield"].sort(), "all six questions plus budget asked");
    assert.ok(!one("SELECT 1 FROM agent_runs WHERE investigation_id=? AND started_by=?", pre.investigation_id, `campaign:${cid}`), "no run was started for rejected work");
    assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=?", pre.investigation_id).n, jobsBefore, "no module job was created for rejected work");

    // A model reviewer can add a rejection; it can never approve what the deterministic Reviewer rejected.
    useModel(true);
    await d1.prepare("INSERT INTO agent_settings(key,value) VALUES('campaign_model_reviewer','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
    await site("delta-seed.test", { keys: [["ip", "198.51.100.61"]] });
    await site("delta-two.test", { keys: [["ip", "198.51.100.61"]] });
    scripted.queue.length = 0;
    // Planner near-tie reply (ignored if not a close call), strategist reply, then the critic rejects everything it sees.
    const reject = { reject: true, code: "low_yield" };
    scripted.queue.push({ hypotheses: [] }, reject, reject, reject, reject, reject, reject);
    const cid2 = await start("delta-seed.test", { max_parallel: 2, max_discovery_requests: 0 });
    const rejected = all("SELECT * FROM opportunities WHERE campaign_id=? AND status='rejected'", cid2);
    assert.ok(rejected.length >= 1 && rejected.every(r => /model reviewer: low_yield/.test(JSON.stringify(JSON.parse(r.result).review.reasons))), "model-added rejections recorded");
    assert.equal(one("SELECT COUNT(*) n FROM agent_runs WHERE started_by=?", `campaign:${cid2}`).n, 0, "model rejection prevented the investigations");
    await d1.prepare("UPDATE agent_settings SET value='false' WHERE key='campaign_model_reviewer'").run();
    useModel(false); scripted.queue.length = 0;
    pass("C reviewer: already-attempted work rejected with all six checks, no run or job created; model critique can only add rejections");
  })().catch(e => fail("C reviewer", e));

  // ======================================================================
  // D. Budgets stop expansion; raising the budget resumes
  // ======================================================================
  await (async () => {
    await site("eps-seed.test", { keys: [["ip", "198.51.100.80"]] });
    for (let i = 1; i <= 4; i++) await site(`eps-${i}.test`, { keys: [["ip", "198.51.100.80"], ["favicon", `eps-fav-${i}`]], wallets: [`TWalletEps${i}000000000000000000000000`] });
    const cid = await start("eps-seed.test", { max_parallel: 3, max_investigations: 2, max_discovery_requests: 0 });
    const status = await drive(cid, 30);
    assert.equal(status, "BUDGET_EXHAUSTED", `stops at the investigation budget (${status})`);
    assert.equal(one("SELECT COUNT(*) n FROM agent_runs WHERE started_by=?", `campaign:${cid}`).n, 2, "exactly two investigations");
    assert.equal(one("SELECT used_investigations n FROM campaigns WHERE id=?", cid).n, 2);
    const bad = await budgetRoute.PATCH(req("/x", { max_investigations: -1 }, undefined, "PATCH"), P({ id: cid }));
    assert.equal(bad.status, 400, "a negative budget is refused");
    const r = await budgetRoute.PATCH(req("/x", { max_investigations: 3 }, undefined, "PATCH"), P({ id: cid }));
    assert.equal(r.status, 200); assert.equal((await r.json()).status, "RUNNING", "raising the budget resumes the campaign");
    await drive(cid, 20);
    assert.equal(one("SELECT COUNT(*) n FROM agent_runs WHERE started_by=?", `campaign:${cid}`).n, 3, "one more investigation after the raise, no more");
    pass("D budgets: expansion stops at 2 investigations (BUDGET_EXHAUSTED), invalid budget refused, raise to 3 resumes exactly one more");
  })().catch(e => fail("D budgets", e));

  // ======================================================================
  // E. Discovery saturation stops low-value pivots
  // ======================================================================
  await (async () => {
    // Three independent shared hosting IPs -> three ip hypotheses of the same type.
    await site("zeta-seed.test", { keys: [["ip", "198.51.100.101"], ["ip", "198.51.100.102"], ["ip", "198.51.100.103"]] });
    await site("zeta-two.test", { keys: [["ip", "198.51.100.101"], ["ip", "198.51.100.102"], ["ip", "198.51.100.103"]] });
    finderPlan = async () => ({ sites: [], result: { new_candidates: [], saturated: false } });
    const before = finderJobs.length;
    const cid = await start("zeta-seed.test", { max_parallel: 3, max_discovery_requests: 8, max_investigations: 2 });
    await drive(cid, 30);
    const ipJobs = finderJobs.slice(before).filter(j => j.payload.campaign_id === cid && j.payload.pivot?.kind === "ip");
    assert.ok(ipJobs.length >= 1 && ipJobs.length <= 2, `unproductive ip pivots stop after the saturation window (${ipJobs.length} ran)`);
    const leftover = all("SELECT o.status,o.reason FROM opportunities o JOIN hypotheses h ON h.id=o.hypothesis_id WHERE o.campaign_id=? AND h.test_target LIKE 'ip:%' AND o.status NOT IN ('done')", cid);
    assert.ok(leftover.length >= 1 && leftover.every(o => ["saturated", "rejected"].includes(o.status)), `remaining ip pivots are saturated/rejected: ${JSON.stringify(leftover)}`);
    assert.ok(leftover.some(o => /saturated|disproved/.test(o.reason)));
    pass(`E saturation: ${ipJobs.length} unproductive ip pivot(s) ran, the rest were stopped as saturated`);
  })().catch(e => fail("E saturation", e));

  // ======================================================================
  // F. A human checkpoint pauses only the affected work
  // ======================================================================
  await (async () => {
    await site("eta-seed.test", { keys: [["ip", "198.51.100.120"]] });
    await site("eta-login.test", { keys: [["ip", "198.51.100.120"], ["favicon", "eta-l"]], wallets: ["TWalletEtaLogin00000000000000000001"] });
    await site("eta-open1.test", { keys: [["ip", "198.51.100.120"], ["favicon", "eta-1"]], wallets: ["TWalletEtaOpen100000000000000000001"] });
    await site("eta-open2.test", { keys: [["ip", "198.51.100.120"], ["favicon", "eta-2"]], wallets: ["TWalletEtaOpen200000000000000000001"] });
    siPlan.set("eta-login.test", { wallet: null, loginWall: true });
    siPlan.set("eta-open1.test", { wallet: "TWalletEtaOpen100000000000000000001" });
    siPlan.set("eta-open2.test", { wallet: "TWalletEtaOpen200000000000000000001" });
    const cid = await start("eta-seed.test", { max_parallel: 2, max_discovery_requests: 0 });
    await drive(cid, 25, { until: () => one("SELECT state FROM campaign_members WHERE campaign_id=? AND domain='eta-login.test'", cid).state === "waiting_human" });
    assert.equal(one("SELECT state FROM campaign_members WHERE campaign_id=? AND domain='eta-login.test'", cid).state, "waiting_human");
    assert.equal(one("SELECT status FROM campaigns WHERE id=?", cid).status, "RUNNING", "the campaign keeps running");
    await drive(cid, 25, { until: () => all("SELECT 1 FROM campaign_members WHERE campaign_id=? AND domain IN ('eta-open1.test','eta-open2.test') AND state='done'", cid).length === 2 });
    assert.equal(all("SELECT 1 FROM campaign_members WHERE campaign_id=? AND domain IN ('eta-open1.test','eta-open2.test') AND state='done'", cid).length, 2, "other sites were investigated while one waited for a person");
    const tasks = (await (await tasksRoute.GET(req("/x"), P({ id: cid }))).json()).tasks;
    assert.ok(tasks.some(t => t.type === "checkpoint" && t.kind === "login" && t.domain === "eta-login.test" && /yourself|never|own/i.test(t.instructions)), "the login task is listed for a person");
    // The person signs in; CryptoWalletLogger records a wallet behind the login. The run resumes.
    const inv = one("SELECT i.external_id,i.id FROM investigations i JOIN inbox_candidates c ON c.investigation_id=i.id WHERE c.canonical_domain='eta-login.test'");
    const batch = { schema_version: "3.0", batch_id: `logger:eta:${cid}`, sent_at: new Date().toISOString(), records: { evidence: [{ investigation_id: inv.external_id, external_id: `logger:eta:${cid}`, evidence_type: "wallet_display", evidence_class: "observed_website", observation_scope: "authenticated", title: "Deposit address behind login", context_text: JSON.stringify({ wallet: "0x" + "cd".repeat(20) }), confidence: 0.9, entity: { entity_type: "wallet", canonical_key: "0x" + "cd".repeat(20), network: "ethereum" } }] } };
    assert.equal((await ingest.POST(req("/api/v1/ingest/crypto_wallet_logger", batch, "logger-key"), P({ module: "crypto_wallet_logger" }))).status, 202);
    assert.notEqual(one("SELECT status FROM agent_runs WHERE investigation_id=?", inv.id).status, "WAITING_FOR_HUMAN", "new evidence resumed the paused investigation");
    await drive(cid, 10);
    assert.notEqual(one("SELECT state FROM campaign_members WHERE campaign_id=? AND domain='eta-login.test'", cid).state, "waiting_human");
    pass("F checkpoint: login wall pauses one site, two others complete meanwhile, person's evidence resumes it");
  })().catch(e => fail("F checkpoint", e));

  // ======================================================================
  // G. Crash / restart without duplicate work
  // ======================================================================
  await (async () => {
    await site("theta-seed.test", { keys: [["ip", "198.51.100.140"]] });
    const t2 = await site("theta-two.test", { keys: [["ip", "198.51.100.140"], ["favicon", "theta"]], wallets: ["TWalletTheta0000000000000000000001"] });
    const cid = await campaign.createCampaign({ seed_domain: "theta-seed.test", budgets: { max_parallel: 3, max_discovery_requests: 0 } });
    const id = cid.id;
    // 1) a tick crashed while holding the lease: the lease expires and another worker continues.
    await d1.prepare("UPDATE campaigns SET lease_owner='dead-worker',lease_until=? WHERE id=?").bind(new Date(Date.now() + 60000).toISOString(), id).run();
    const blocked = await campaign.tickCampaign(id, "worker-2");
    assert.equal(blocked.executed.length, 0, "a live lease blocks a second worker");
    await d1.prepare("UPDATE campaigns SET lease_until=? WHERE id=?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    // 2) the dead worker had already started theta-two's investigation but crashed before recording it.
    const orphan = await runner.startRun(t2.investigation_id, `campaign:${id}`);
    const r = await campaign.tickCampaign(id, "worker-2");
    assert.equal(r.status, "RUNNING");
    assert.equal(one("SELECT COUNT(*) n FROM agent_runs WHERE investigation_id=?", t2.investigation_id).n, 1, "the half-started investigation was adopted, not duplicated");
    assert.equal(opp(id, "investigate:theta-two.test").run_id, orphan.id);
    assert.equal(opp(id, "investigate:theta-two.test").status, "executing");
    // 3) a whole "process restart": everything is re-read from the tables.
    const status = await drive(id, 30);
    assert.ok(["COMPLETE", "BUDGET_EXHAUSTED"].includes(status), status);
    for (const row of all("SELECT investigation_id,COUNT(*) n FROM agent_runs WHERE started_by=? GROUP BY investigation_id", `campaign:${id}`)) assert.equal(row.n, 1);
    pass("G restart: expired lease taken over, half-started investigation adopted without duplication, campaign completes");
  })().catch(e => fail("G restart", e));

  // ======================================================================
  // H. Provider failures and deterministic fallback
  // ======================================================================
  await (async () => {
    useModel(true); scripted.queue.length = 0;
    await site("iota-seed.test", { keys: [["ip", "198.51.100.160"]] });
    for (let i = 1; i <= 3; i++) await site(`iota-${i}.test`, { keys: [["ip", "198.51.100.160"], ["favicon", `iota-${i}`]], wallets: [`TWalletIota${i}00000000000000000000001`] });
    // Timeouts, garbage, and truncated JSON; then nothing (unreachable).
    scripted.queue.push(new Error("timeout"), "not json at all", "{\"opportunity_id\": ", new Error("503"));
    const cid = await start("iota-seed.test", { max_parallel: 2, max_discovery_requests: 0 });
    const status = await drive(cid, 30);
    assert.ok(["COMPLETE", "BUDGET_EXHAUSTED"].includes(status), `campaign completes despite provider failures (${status})`);
    assert.ok(one("SELECT COUNT(*) n FROM agent_runs WHERE started_by=?", `campaign:${cid}`).n >= 3);
    const proposals = all("SELECT body FROM campaign_artifacts WHERE campaign_id=? AND kind='proposal'", cid).map(r => JSON.parse(r.body));
    assert.ok(proposals.every(p => p.chosen_by === "deterministic"), "failed model replies never chose work");
    assert.ok(one("SELECT COUNT(*) n FROM campaign_costs WHERE campaign_id=? AND kind='model_call'", cid).n >= 1, "failed calls are still counted as cost");
    useModel(false);
    // Deterministic-only campaign: no provider at all.
    await site("kappa-seed.test", { keys: [["ip", "198.51.100.170"]] });
    await site("kappa-2.test", { keys: [["ip", "198.51.100.170"], ["favicon", "k2"]], wallets: ["TWalletKappa200000000000000000001"] });
    const calls = scripted.calls;
    const cid2 = await start("kappa-seed.test", { max_parallel: 2, max_discovery_requests: 0 });
    const s2 = await drive(cid2, 30);
    assert.ok(["COMPLETE", "BUDGET_EXHAUSTED"].includes(s2)); assert.equal(scripted.calls, calls, "no model was called");
    assert.equal(one("SELECT used_model_calls n FROM campaigns WHERE id=?", cid2).n, 0);
    pass("H providers: timeouts/garbage/truncated replies fall back safely and are costed; a model-free campaign completes");
  })().catch(e => fail("H providers", e));

  // ======================================================================
  // I. Adversarial model output and forged inputs
  // ======================================================================
  await (async () => {
    useModel(true); scripted.queue.length = 0;
    await site("lambda-seed.test", { keys: [["ip", "198.51.100.180"], ["favicon", "lam"]], wallets: ["TWalletLambdaShared000000000000001"] });
    await site("lambda-2.test", { keys: [["ip", "198.51.100.180"], ["favicon", "lam"]], wallets: ["TWalletLambdaShared000000000000001"] });
    await site("lambda-3.test", { keys: [["ip", "198.51.100.180"], ["favicon", "lam3"]] });
    const c = await campaign.createCampaign({ seed_domain: "lambda-seed.test", budgets: { max_parallel: 1, max_discovery_requests: 0, max_model_calls: 6 } });
    const cid = c.id;
    await campaign.tickCampaign(cid);
    const edges = all("SELECT * FROM campaign_edges WHERE campaign_id=?", cid);
    const ipEdges = edges.filter(e => e.dst_key === "ip:198.51.100.180").map(e => e.id);
    const walletEdges = edges.filter(e => e.dst_type === "wallet").map(e => e.id);
    const edgeCount = edges.length;
    // Invented / unsupported hypotheses from a "model".
    const attempts = [
      ["nonexistent evidence", { observation_refs: ["edge-that-does-not-exist", "another-fake"], statement: "These sites are run by one operator.", test_target: "ip:198.51.100.180" }, /not an edge/],
      ["contradicts observed evidence", { observation_refs: ipEdges, statement: "They share a wallet we have not observed.", test_target: "wallet:0xnotobserved" }, /not the indicator/],
      ["invalid capability as target", { observation_refs: ipEdges, statement: "Try the admin panel with common passwords.", test_target: "password:admin" }, /not a supported passive pivot/],
      ["links/markup in text", { observation_refs: ipEdges, statement: "See https://evil.example for proof of this.", test_target: "ip:198.51.100.180" }, /plain text/],
      ["smuggled extra field", { observation_refs: ipEdges, statement: "Related sites may exist on this host.", test_target: "ip:198.51.100.180", new_edge: { src: "a", dst: "b" } }, /Unrecognized|unrecognized|new_edge/],
      ["single-site pattern", { observation_refs: ipEdges.slice(0, 1), statement: "Related sites may exist on this host.", test_target: "ip:198.51.100.180" }, /two sites/],
    ];
    for (const [label, raw, why] of attempts) {
      const r = await hyps.proposeHypothesis(cid, raw, "model");
      assert.equal(r.ok, false, `${label} rejected`); assert.match(r.reasons.join(" "), why, `${label}: ${r.reasons.join("; ")}`);
    }
    // A duplicate of an existing (deterministic) hypothesis is not accepted twice.
    const dup = await hyps.proposeHypothesis(cid, { observation_refs: ipEdges, statement: "Other sites may share this hosting IP.", test_target: "ip:198.51.100.180" }, "model");
    assert.equal(dup.ok, false);
    assert.equal(one("SELECT COUNT(*) n FROM hypotheses WHERE campaign_id=? AND proposed_by='model'", cid).n, 0);
    // Invented relationships cannot enter the graph through the only writer.
    const inv = one("SELECT id FROM inbox_candidates WHERE canonical_domain='lambda-3.test'").id;
    for (const [label, e, code] of [
      ["ai basis", { srcType: "site", srcKey: "lambda-3.test", dstType: "site", dstKey: "lambda-seed.test", kind: "observed_relationship", basis: "ai_inference", sourceTable: "inbox_candidates", sourceRef: inv }, /BASIS/],
      ["fake source row", { srcType: "site", srcKey: "lambda-3.test", dstType: "wallet", dstKey: "0xinvented", kind: "displays_wallet", basis: "observed", sourceTable: "evidence", sourceRef: "no-such-evidence" }, /ROW_MISSING/],
      ["unlisted source table", { srcType: "site", srcKey: "lambda-3.test", dstType: "site", dstKey: "x.test", kind: "observed_relationship", basis: "observed", sourceTable: "agent_inferences", sourceRef: "x" }, /SOURCE_NOT_ALLOWED/],
      ["hypothesis as edge", { srcType: "hypothesis", srcKey: "h", dstType: "site", dstKey: "x.test", kind: "observed_relationship", basis: "deterministic", sourceTable: "inbox_candidates", sourceRef: inv }, /HYPOTHESIS/],
    ]) await assert.rejects(graph.addEdge(cid, e), code, label);
    // Model planner tries an invalid capability, then a non-offered id, then a done/executing (repeated) opportunity.
    const open = all("SELECT * FROM opportunities WHERE campaign_id=? AND status='open' ORDER BY priority DESC", cid);
    const done = one("SELECT id FROM opportunities WHERE campaign_id=? AND status IN ('executing','done')", cid);
    const fake = [{ ...open[0], priority: 0.5 }, { ...(open[1] ?? open[0]), id: "second", priority: 0.49 }];
    scripted.queue.push({ capability: "site.exploit", arguments: {} }, { opportunity_id: "not-offered", rationale: "x" }, { opportunity_id: done?.id ?? "x", rationale: "repeat it" });
    for (let i = 0; i < 3; i++) { const ch = await roles.planChoice(cid, fake); assert.equal(ch.chosenBy, "deterministic"); assert.equal(ch.op.id, fake[0].id); }
    // Model budget cannot be exceeded: max_model_calls=6; queue more replies than the budget allows.
    for (let i = 0; i < 20; i++) scripted.queue.push({ opportunity_id: fake[1].id, rationale: "ok" });
    let modelChoices = 0; for (let i = 0; i < 20; i++) if ((await roles.planChoice(cid, fake)).chosenBy === "model") modelChoices++;
    const used = one("SELECT used_model_calls n FROM campaigns WHERE id=?", cid).n;
    assert.ok(used <= 6, `model budget respected (${used}/6)`); assert.ok(modelChoices <= 6 - 3);
    // Reviewer refuses a repeat of done/executing work even if something asks for it.
    if (done) { const r = await reviewer.review(one("SELECT * FROM campaigns WHERE id=?", cid), one("SELECT * FROM opportunities WHERE id=?", done.id), []); assert.notEqual(r.verdict, "approve"); }
    // Forged experience cannot move learning.
    await assert.rejects(experience.recordExperience({ campaignId: cid, context: "x", action: "pivot:ip", expected: 0.5, actual: 99, cost: 0, useful: 1, basis: "observed", sourceRef: "forged-job" }), /UNVERIFIED/);
    await assert.rejects(experience.recordExperience({ campaignId: cid, context: "x", action: "pivot:ip", expected: 0.5, actual: 1, cost: 0, useful: 1, basis: "human", sourceRef: "forged-decision" }), /UNVERIFIED/);
    assert.equal(all("SELECT * FROM campaign_edges WHERE campaign_id=?", cid).length, edgeCount, "no adversarial input added an edge");
    // Artifacts are typed: a free-form command cannot be written as a role artifact.
    await assert.rejects(roles.writeArtifact(cid, 1, "proposal", { command: "run whatever" }), /ARTIFACT_INVALID/);
    assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type NOT IN ('INVESTIGATE_SITE','ANALYZE_WALLET','FIND_RELATED_SITES','DISCOVER_SITES','RECHECK_SITE','LOG_WALLET_ACTIVITY')").n, 0, "no invented job type exists");
    useModel(false); scripted.queue.length = 0;
    pass("I adversarial: fake refs, contradicting target, bad capability, links, smuggled fields, forged edges/experience, non-offered and repeated choices and budget overruns all rejected");
  })().catch(e => fail("I adversarial", e));

  // ======================================================================
  // J. Learning: real outcomes move priorities; AI self-evaluation does not
  // ======================================================================
  await (async () => {
    const p0 = await experience.prior("pivot:favicon", "hot=0|type=favicon");
    for (let i = 0; i < 50; i++) await experience.recordExperience({ campaignId: null, context: "hot=0|type=favicon", action: "pivot:favicon", expected: 0.5, actual: 5, cost: 1, useful: 1, basis: "ai_self", sourceRef: `self-${i}` });
    const p1 = await experience.prior("pivot:favicon", "hot=0|type=favicon");
    assert.equal(p1.value, p0.value, "AI self-evaluation carries zero weight");
    // Observed outcomes (real, verifiable job rows) move the prior, bounded.
    const refs = all("SELECT id FROM jobs LIMIT 40").map(r => r.id);
    for (const ref of refs) await experience.recordExperience({ campaignId: null, context: "hot=0|type=favicon", action: "pivot:favicon", expected: 0.5, actual: 0, cost: 1, useful: 0, basis: "observed", sourceRef: ref });
    const p2 = await experience.prior("pivot:favicon", "hot=0|type=favicon");
    assert.ok(p2.value < p0.value, `observed failures lower the prior (${p0.value} -> ${p2.value})`);
    assert.ok(p2.value >= experience.PRIOR_MIN, "but never below the exploration floor");
    pass(`J learning: ai_self ignored (${p0.value}), observed outcomes move the prior to ${p2.value.toFixed(3)} and stop at the floor`);
  })().catch(e => fail("J learning", e));
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures) { console.log(`\n${failures} v4 campaign scenario(s) FAILED`); process.exit(1); }
console.log("\nAll v4 campaign scenarios passed.");
