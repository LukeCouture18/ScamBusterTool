// One arm of the v4-vs-v5 benchmark (see tests/bench-v5.mjs). Runs in its own
// process with its own in-memory database; prints one "RESULT {json}" line.
//
// Both arms run the SAME world (tests/lib/bench-v4-arm.mjs makeWorld plus the
// temporal dynamics below), the SAME seeds, the SAME simulated days and ticks,
// and the SAME investigation / discovery / module-job budgets, through the REAL
// platform code. Module and Site Finder answers are a deterministic function of
// (seed, request, site), so the same request gets the same answer in both arms.
import { importFrom, localPath, runPythonJson } from "./portable.mjs";
import { makeWorld } from "./bench-v4-arm.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const md5 = (s) => createHash("md5").update(s).digest("hex");
const h01 = (...parts) => parseInt(md5(parts.join("|")).slice(0, 8), 16) / 0xffffffff;
export const DAYS = 5, TICKS_PER_DAY = 8;

/** Temporal dynamics for one simulated day. Deterministic in (seed, day); independent of the arm. */
function advanceWorld(world, seed, day) {
  const changed = new Set(), born = [];
  for (const s of [...world.sites.values()].sort((a, b) => a.domain.localeCompare(b.domain))) {
    if (!s.scam) continue;
    const r = (tag) => h01(seed, day, s.domain, tag);
    if (s.state === "login" && r("open") < 0.25) { s.state = "live"; s.finderSeesWallet = r("pub") < 0.6; changed.add(s.domain); }
    else if (s.state === "live" && r("die") < 0.08) { s.state = "dead"; changed.add(s.domain); }
    else if (s.state === "dead" && r("back") < 0.3) { s.state = "live"; changed.add(s.domain); }
    if (s.state === "live" && r("rotate") < 0.12) { s.wallet = `T${md5(`${seed}:${day}:${s.domain}:rot`).slice(0, 33)}`; if (s.finderSeesWallet) changed.add(s.domain); }
  }
  const kits = new Map(); for (const s of world.sites.values()) if (s.kit && !kits.has(s.kit)) kits.set(s.kit, s);
  for (const [kit, proto] of kits) if (h01(seed, day, kit, "birth") < 0.4) {
    const domain = `${kit}-n${day}-s${seed}.test`;
    const w = h01(seed, day, kit, "neww") < 0.5 ? `T${md5(`${seed}:${day}:${kit}:born`).slice(0, 33)}` : proto.wallet;
    world.sites.set(domain, { ...proto, domain, wallet: w, state: "live", inInbox: false, finderCluster: proto.finderCluster, finderSeesWallet: h01(seed, day, domain, "pub") < 0.5, score: 0.75 + h01(seed, domain, "score") * 0.2, born: day });
    born.push(domain);
  }
  return { changed, born };
}

export async function runArm(arm, seed, budget, discovery = 8) {
  const world = makeWorld(seed);
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../../drizzle/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(await readFile(new URL(name, migrations), "utf8"));
  const d1 = { prepare(statement) { let params = []; return { bind(...v) { params = v; return this; }, async run() { const r = sql.prepare(statement).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, async first() { return sql.prepare(statement).get(...params) ?? null; }, async all() { return { results: sql.prepare(statement).all(...params) }; } }; }, async batch(q) { sql.exec("BEGIN"); try { const out = []; for (const s of q) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  const one = (q, ...a) => sql.prepare(q).get(...a), all = (q, ...a) => sql.prepare(q).all(...a);
  globalThis.__TEST_ENV = { DB: d1, MODULE_API_KEYS: JSON.stringify({ site_finder: "finder-key", site_investigator: "investigator-key", crypto_wallet_logger: "logger-key", wallet_investigator: "wallet-key" }), AI_PROVIDER: "rules" };
  const work = await mkdtemp(join(tmpdir(), "mip-bench-v5-"));
  const started = Date.now();
  try {
    const root = localPath("../../", import.meta.url);
    const routes = ["app/api/v1/modules/[module]/register/route.ts", "app/api/v1/ingest/[module]/route.ts", "app/api/v1/modules/[module]/jobs/claim/route.ts", "app/api/v1/modules/[module]/jobs/[id]/route.ts",
      "app/api/v1/inbox/settings/route.ts", "app/api/v1/agent/settings/route.ts", "app/api/v1/modules/[module]/heartbeat/route.ts", "lib/campaign/campaign.ts", "lib/agent/runner.ts", "lib/ops/scheduler.ts", "lib/ops/common.ts", "lib/ops/budgets.ts", "lib/ops/contradictions.ts", "lib/ops/view.ts", "lib/ops/intel.ts", "lib/ops/notifications.ts", "lib/campaign/view.ts"].map(p => join(root, p));
    await build({ entryPoints: routes, bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: root, logLevel: "silent", plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=globalThis.__TEST_ENV", loader: "js" })); } }] });
    const L = (p) => importFrom(work, p);
    const register = await L("app/api/v1/modules/[module]/register/route.js"), ingest = await L("app/api/v1/ingest/[module]/route.js"), claim = await L("app/api/v1/modules/[module]/jobs/claim/route.js"), update = await L("app/api/v1/modules/[module]/jobs/[id]/route.js");
    const inboxSettings = await L("app/api/v1/inbox/settings/route.js"), agentSettings = await L("app/api/v1/agent/settings/route.js"), hbRoute = await L("app/api/v1/modules/[module]/heartbeat/route.js");
    const campaign = await L("lib/campaign/campaign.js"), runner = await L("lib/agent/runner.js"), scheduler = await L("lib/ops/scheduler.js"), common = await L("lib/ops/common.js"), budgets = await L("lib/ops/budgets.js"), contradictions = await L("lib/ops/contradictions.js");
    const req = (path, data, key, method = "POST") => new Request("http://127.0.0.1" + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const P = (o) => ({ params: Promise.resolve(o) });
    const MODS = [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]];
    for (const [m, key, caps] of MODS) assert.equal((await register.POST(req(`/x`, { module_version: "bench", schema_version: "3.0", capabilities: caps, supported_event_types: [] }, key), P({ module: m }))).status, 200);
    const beat = async () => { for (const [m, key, caps] of MODS) assert.equal((await hbRoute.POST(req("/x", { module_version: "bench", schema_version: "3.0", status: "idle", capabilities: caps }, key), P({ module: m }))).status, 200); };
    await inboxSettings.PATCH(req("/x", { investigate_on_useful: false, find_related_on_useful: false, target_depth: 0 }, undefined, "PATCH"));
    await agentSettings.PATCH(req("/x", { auto_start_on_useful: false }, undefined, "PATCH"));
    const nextMinute = () => sql.exec("DELETE FROM rate_limit_windows");
    // Identical budgets in both arms: the v4 campaign's own budgets, and the same numbers as v5 platform budgets.
    await budgets.setLimit("global", "investigations", budget); await budgets.setLimit("global", "discovery_requests", discovery); await budgets.setLimit("global", "module_jobs", 60);
    // The benchmark compresses days into seconds. Two settings that are expressed in wall-clock time are
    // scaled accordingly (documented in V5_OPERATIONS_BENCHMARK_REPORT.md): sources observing "within an
    // hour" of each other would otherwise always look simultaneous, and a 24h revisit cooldown would span the run.
    await common.setState("disagreement_window_seconds", 0); await common.setState("revisit_cooldown_hours", 0);
    if (arm === "v4") await common.setState("scheduler_paused", true);   // v4 has no autonomous scheduler

    const template = runPythonJson(localPath("./finder-v2-batches.py", new URL("../", import.meta.url))).batches[0];
    const tDomain = template.records.sites[0].canonical_key, tHash = template.records.sites[0].external_id.split(":").pop();
    const siTemplate = runPythonJson(localPath("./site-bridge-synthetic.py", new URL("../", import.meta.url)), { env: { MIP_BATCH_JSON: "1" } }).batch;
    const siWallet = siTemplate.records.wallets[0].address;
    const ingested = new Set(); const rev = new Map();
    // Site Finder: first delivery, and (its continuous watch) re-delivery when a surfaced site changes. Same in both arms.
    async function surface(domain, { redeliver = false } = {}) {
      const s = world.sites.get(domain); if (!s || (ingested.has(domain) && !redeliver)) return false;
      nextMinute();
      const v = (rev.get(domain) ?? 0) + 1; rev.set(domain, v);
      const records = JSON.parse(JSON.stringify(template.records).split(tDomain).join(domain).split(tHash).join(md5(domain)));
      const keys = [["favtmpl", s.tmpl], ["favicon", s.tmpl.split("|")[0]], ["ip", s.ip], ["ns", s.ns]];
      Object.assign(records.sites[0].inbox, { cluster_key: s.finderCluster ?? `c:${domain}`, keys, wallets: s.finderSeesWallet && s.state === "live" ? [s.wallet] : [], worth_checking: Number(s.score.toFixed(3)), related_domains: [],
        ...(v > 1 ? { site_status: s.state === "dead" ? "dead" : "live" } : {}) });
      records.sites[0].confidence = s.score; records.sites[0].triage.confidence = s.score;
      const res = await ingest.POST(req("/x", { schema_version: "3.0", batch_id: `b:${domain}:${v}`, sent_at: new Date().toISOString(), records }, "finder-key"), P({ module: "site_finder" }));
      assert.equal(res.status, 202, await res.clone().text());
      ingested.add(domain); return true;
    }
    for (const s of world.sites.values()) if (s.inInbox) await surface(s.domain);

    let tickNo = 0;
    const revealed = [];                       // {domain, wallet, tick, via}
    const walletsSeen = new Set();
    const log = { si_jobs: 0, recheck_jobs: 0, recheck_new_wallet: 0, wi_jobs: 0, finder_jobs: 0, finder_zero: 0, finder_new_scam: 0, checkpoints: 0, reviews: 0, dead_or_nonscam_at_job: 0, changes: 0, changes_reobserved: 0 };
    const changeAt = new Map();                // domain -> tick of the latest world change (for investigated sites)
    const reveal = (domain, wallet, via) => { const fresh = !walletsSeen.has(wallet); if (fresh) { walletsSeen.add(wallet); revealed.push({ domain, wallet, tick: tickNo, via }); } return fresh; };
    async function si() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "investigator-key"), P({ module: "site_investigator" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false;
      const recheck = job.job_type === "RECHECK_SITE"; if (recheck) log.recheck_jobs++; else log.si_jobs++;
      const inv = one("SELECT i.external_id, c.canonical_domain d FROM investigations i JOIN inbox_candidates c ON c.investigation_id=i.id WHERE i.id=?", job.investigation_id);
      const s = world.sites.get(inv.d);
      if (changeAt.has(s.domain)) { log.changes_reobserved++; changeAt.delete(s.domain); }
      if (s.state === "dead" || !s.scam) log.dead_or_nonscam_at_job++;
      if (s.state === "dead") { await update.PATCH(req("/x", { action: "fail", error: "DNS resolution failed: name or service not known", retry: false }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id })); return true; }
      const batch = JSON.parse(JSON.stringify(siTemplate).split("synthetic.example").join(s.domain).split("_synthetic").join(`_${md5(s.domain + job.id).slice(0, 10)}`).split(siWallet).join(s.wallet ?? siWallet));
      batch.origin_job_id = job.id; batch.batch_id = `si:${job.id}`; batch.sent_at = new Date().toISOString();
      for (const rows of Object.values(batch.records)) for (const row of rows) row.investigation_id = inv.external_id;
      if (s.state !== "live" || !s.wallet) {
        batch.records.wallets = []; batch.records.relationships = []; batch.records.deposit_options = []; batch.records.evidence = batch.records.evidence.filter(e => !String(e.evidence_type).includes("wallet"));
        batch.records.evidence.push({ investigation_id: inv.external_id, external_id: `page:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public", title: "Landing page",
          context_text: JSON.stringify({ title: "Welcome", kind: s.state === "login" ? "login" : "landing", important_text: s.state === "login" ? "Please sign in to continue to your deposit dashboard. Login required." : "Welcome." }), confidence: 0.8, entity: { entity_type: "site", canonical_key: s.domain } });
      }
      assert.equal((await ingest.POST(req("/x", batch, "investigator-key"), P({ module: "site_investigator" }))).status, 202);
      await update.PATCH(req("/x", { action: "complete", result: {} }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }));
      if (s.state === "live" && s.wallet && s.scam) { const fresh = reveal(s.domain, s.wallet, recheck ? "recheck" : "investigate"); if (recheck && fresh) log.recheck_new_wallet++; }
      return true;
    }
    async function wi() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "wallet-key"), P({ module: "wallet_investigator" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false; log.wi_jobs++;
      await update.PATCH(req("/x", { action: "complete", result: { risk: "high" } }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id })); return true;
    }
    const P_FIND = { ip: 0.9, ns: 0.9, favtmpl: 0.6, favicon: 0.6, kit: 0.6, wallet: 0.4, san: 0.7, service: 0.5, nameserver: 0.9, template: 0.6 };
    let noiseN = 0;
    async function finder() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "finder-key"), P({ module: "site_finder" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false; log.finder_jobs++;
      const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
      const found = [];
      const eligible = (s) => !ingested.has(s.domain);
      if (payload.pivot) {
        const { kind, value } = payload.pivot;
        const k = kind === "nameserver" ? "ns" : kind === "template" ? "favtmpl" : kind;
        const matches = [...world.sites.values()].filter(s => eligible(s) && (k === "ip" ? s.ip === value : k === "ns" ? s.ns === value || s.ns.split("|").includes(value) : k === "favtmpl" ? s.tmpl === value : k === "favicon" ? s.tmpl.startsWith(value + "|") : k === "kit" ? `kit:${s.kit}` === value : k === "wallet" ? (s.wallet ?? "").toLowerCase() === String(value).toLowerCase() : false));
        if (!(k === "ip" && value === world.CDN)) for (const s of matches.sort((a, b) => a.domain.localeCompare(b.domain))) if (found.length < 4 && h01(seed, "pivot", k, value, s.domain) < (P_FIND[k] ?? 0.3)) found.push(s.domain);
      } else if (job.job_type === "DISCOVER_SITES") {  // a continuous-discovery cycle: new registrations from public sources
        const pool = [...world.sites.values()].filter(eligible).sort((a, b) => a.domain.localeCompare(b.domain));
        for (const s of pool) if (found.length < 4 && h01(seed, "cycle", tickNo >> 3, s.domain) < 0.35) found.push(s.domain);
        if (h01(seed, "cycle-noise", tickNo) < 0.5) { const d = `newreg${noiseN++}-s${seed}-${tickNo}.test`; world.sites.set(d, { domain: d, scam: false, op: null, kit: null, tmpl: `fav-${d}|t`, ip: `203.0.113.${noiseN % 250}`, ns: "ns1.parking.test|ns2.parking.test", wallet: null, state: h01(seed, d, "st") < 0.5 ? "dead" : "live", inInbox: false, finderCluster: null, finderSeesWallet: false, score: 0.55 + h01(seed, d, "sc") * 0.2 }); found.push(d); }
      }
      for (const d of found) { await surface(d); if (world.sites.get(d).scam) log.finder_new_scam++; }
      if (!found.length) log.finder_zero++;
      await update.PATCH(req("/x", { action: "complete", result: { new_candidates: found, saturated: !found.length, delivered: found.length } }, "finder-key", "PATCH"), P({ module: "site_finder", id: job.id }));
      return true;
    }
    // A person does what a checkpoint asks (signs in normally; CryptoWalletLogger records the wallet), and reviews contradictions.
    async function person() {
      for (const c of all("SELECT h.id,h.investigation_id,i.external_id,cand.canonical_domain d FROM human_checkpoints h JOIN investigations i ON i.id=h.investigation_id JOIN inbox_candidates cand ON cand.investigation_id=h.investigation_id WHERE h.status='open'")) {
        const s = world.sites.get(c.d); log.checkpoints++;
        nextMinute();
        const b = { schema_version: "3.0", batch_id: `logger:${c.id}`, sent_at: new Date().toISOString(), records: { evidence: [{ investigation_id: c.external_id, external_id: `logger:${c.id}`, evidence_type: "wallet_display", evidence_class: "observed_website", observation_scope: "authenticated", title: "Deposit address behind login", context_text: JSON.stringify({ wallet: s.wallet }), confidence: 0.9, entity: { entity_type: "wallet", canonical_key: s.wallet, network: "tron" } }] } };
        assert.equal((await ingest.POST(req("/x", b, "logger-key"), P({ module: "crypto_wallet_logger" }))).status, 202);
        if (s.wallet) reveal(s.domain, s.wallet, "checkpoint");
      }
      for (const c of all("SELECT id FROM contradictions WHERE status='open'")) { log.reviews++; await contradictions.resolveContradiction(c.id, "resolved", "reviewed in benchmark"); }
    }
    let ticks = 0;
    async function workAll() {
      nextMinute(); await beat();
      for (const r of all("SELECT investigation_id FROM agent_runs WHERE status='WAITING_FOR_MODULE'")) await runner.wake(r.investigation_id, "job");
      for (let i = 0; i < 40; i++) { const a = await si(), b = await wi(), c = await finder(); if (!a && !b && !c) break; }
      await person();
      for (const r of all("SELECT id FROM agent_runs WHERE status='RUNNING'")) await runner.tick(r.id);
    }

    // Screenshot fixture for the Operator Workspace: real read models at one moment of the run.
    async function dumpUi(path) {
      const VIEW = await L("lib/ops/view.js"), INTEL = await L("lib/ops/intel.js"), NT = await L("lib/ops/notifications.js"), CV = await L("lib/campaign/view.js");
      const graph = await INTEL.graphQuery({ types: ["domain", "wallet", "ip", "nameserver", "certificate", "template"], limit: 90 });
      const focusNode = graph.nodes.find(nd => nd.type === "domain" && revealed.some(r => r.domain === nd.key)) ?? graph.nodes[0];
      const auto = one("SELECT campaign_id FROM campaign_meta WHERE origin='auto' ORDER BY updated_at LIMIT 1")?.campaign_id ?? one("SELECT id FROM campaigns LIMIT 1")?.id;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, JSON.stringify({ overview: await VIEW.operationsOverview(), queue: await VIEW.queueView({}), tasks: await VIEW.humanTasks(), investigations: { investigations: await VIEW.investigationsView() },
        discovery: await VIEW.discoveryView(), graph, node: focusNode ? await INTEL.nodeDetail(focusNode.id) : null, wallets: { wallets: await INTEL.multiSiteWallets(20), note: "A wallet shown on several sites is a reason to look at them together, not proof they share an owner." },
        workspace: auto ? await VIEW.campaignWorkspace(auto) : null, cview: auto ? await CV.campaignOverview(auto) : null, cgraph: auto ? await CV.campaignGraph(auto) : null, cadvanced: auto ? await CV.campaignAdvanced(auto) : null,
        advanced: await VIEW.advancedTelemetry(), notifications: { notifications: await NT.listNotifications("open") }, campaigns: { campaigns: await CV.listCampaigns() } }, null, 1));
    }
    let humanStarts = 0, cid = null;
    if (arm === "v4") { const c = await campaign.createCampaign({ seed_domain: world.seedSite, budgets: { max_investigations: budget, max_parallel: 3, max_discovery_requests: discovery, max_module_jobs: 60 } }); cid = c.id; humanStarts = 1; }
    for (let day = 0; day < DAYS; day++) {
      if (day > 0) {
        const { changed, born } = advanceWorld(world, seed, day);
        for (const d of changed) if (ingested.has(d)) { log.changes++; if (one("SELECT 1 x FROM jobs j JOIN inbox_candidates c ON c.investigation_id=j.investigation_id WHERE c.canonical_domain=? AND j.job_type='INVESTIGATE_SITE'", d)) changeAt.set(d, tickNo); await surface(d, { redeliver: true }); }
        for (const d of born) if (h01(seed, day, d, "surface") < 0.5) await surface(d);   // Finder's baseline supply
      }
      for (let t = 0; t < TICKS_PER_DAY; t++) {
        tickNo++; ticks++;
        if (arm === "v4") { const s = one("SELECT status FROM campaigns WHERE id=?", cid).status; if (s === "RUNNING") await campaign.tickCampaign(cid); }
        else { await common.setState("last_refresh_at", ""); await scheduler.schedulerTick({ owner: `bench:${tickNo}` }); }
        if (process.env.BENCH_DUMP_UI && arm === "v5" && tickNo === Number(process.env.BENCH_DUMP_TICK ?? 20)) await dumpUi(process.env.BENCH_DUMP_UI);
        await workAll();
      }
    }
    for (let i = 0; i < 4; i++) await workAll();

    // ---------------- metrics from ground truth
    const truth = (d) => world.sites.get(d);
    const investigated = all("SELECT DISTINCT c.canonical_domain d FROM jobs j JOIN inbox_candidates c ON c.investigation_id=j.investigation_id WHERE j.job_type='INVESTIGATE_SITE'").map(r => r.d);
    const usefulSites = new Set(revealed.map(r => r.domain));
    const dup = investigated.filter(d => truth(d)?.scam && !usefulSites.has(d) && truth(d).state !== "dead");
    const nonScam = investigated.filter(d => !truth(d)?.scam);
    const moduleJobs = one("SELECT COUNT(*) n FROM jobs WHERE target_module IN ('site_investigator','wallet_investigator','site_finder')").n;
    const wasteJobs = one(`SELECT COUNT(*) n FROM jobs j JOIN inbox_candidates c ON c.investigation_id=j.investigation_id WHERE j.job_type IN ('INVESTIGATE_SITE','ANALYZE_WALLET') AND c.canonical_domain IN (${[...dup, ...nonScam].map(() => "?").join(",") || "''"})`, ...dup, ...nonScam).n
      + (log.recheck_jobs - log.recheck_new_wallet) + log.finder_zero;
    const usefulEvidence = one(`SELECT COUNT(*) n FROM evidence e JOIN inbox_candidates c ON c.investigation_id=e.investigation_id WHERE e.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator') AND c.canonical_domain IN (${[...usefulSites].map(() => "?").join(",") || "''"})`, ...usefulSites).n;
    const inv = Number(one("SELECT COUNT(*) n FROM agent_runs").n);
    const campaigns = all("SELECT status,COUNT(*) n FROM campaigns GROUP BY status");
    const workStarted = arm === "v5" ? Number(one("SELECT COUNT(*) n FROM work_item_events WHERE event='started'").n) : Number(one("SELECT COUNT(*) n FROM opportunities WHERE status IN ('executing','done')").n);
    const reports = Number(one("SELECT COUNT(*) n FROM report_candidates").n);
    const modelCalls = Number(one("SELECT COUNT(*) n FROM model_invocations WHERE is_replay=0").n) + Number(one("SELECT COUNT(*) n FROM agent_model_calls").n);
    const out = {
      investigations: investigated.length,
      investigator_runs: inv,
      useful_unique_results: revealed.length,
      unique_wallets_revealed: walletsSeen.size,
      useful_sites: usefulSites.size,
      useful_evidence_items: usefulEvidence,
      duplicate_investigations: dup.length,
      duplicate_rate: Number((dup.length / Math.max(1, investigated.length)).toFixed(3)),
      dead_or_low_value_jobs: log.dead_or_nonscam_at_job,
      non_scam_investigations: nonScam.length,
      module_jobs: moduleJobs,
      wasted_jobs: wasteJobs,
      actions_per_useful_result: Number((moduleJobs / Math.max(1, revealed.length)).toFixed(2)),
      human_interventions: humanStarts + log.checkpoints + log.reviews,
      human_starts: humanStarts, checkpoints_resolved: log.checkpoints, contradiction_reviews: log.reviews, report_approvals_requested: reports,
      discovery_requests: log.finder_jobs, discovery_new_scam_sites: log.finder_new_scam,
      saturation: Number((log.finder_zero / Math.max(1, log.finder_jobs)).toFixed(3)),
      time_to_first_useful_tick: revealed.length ? revealed[0].tick : DAYS * TICKS_PER_DAY,
      mean_tick_of_useful: revealed.length ? Number((revealed.reduce((s, r) => s + r.tick, 0) / revealed.length).toFixed(1)) : DAYS * TICKS_PER_DAY,
      useful_after_day1: revealed.filter(r => r.tick > TICKS_PER_DAY).length,
      model_calls: modelCalls, model_tokens: 0, model_cost_usd: 0,
      campaigns_completed: Number(campaigns.find(c => c.status === "COMPLETE")?.n ?? 0), campaigns_total: campaigns.reduce((s, c) => s + Number(c.n), 0),
      revisits: log.recheck_jobs, useful_revisits: log.recheck_new_wallet, useful_revisit_rate: log.recheck_jobs ? Number((log.recheck_new_wallet / log.recheck_jobs).toFixed(3)) : 0,
      world_changes_on_surfaced_sites: log.changes, changes_reobserved_by_modules: log.changes_reobserved,
      work_started: workStarted, useful_per_started_work: Number((revealed.length / Math.max(1, workStarted)).toFixed(3)),
      useful_per_tick: Number((revealed.length / Math.max(1, ticks)).toFixed(3)),
      wall_ms: Date.now() - started,
    };
    out.diagnostic = arm === "v5"
      ? { work: all("SELECT kind,status,COUNT(*) n FROM work_items GROUP BY kind,status"), campaigns, contradictions: all("SELECT kind,detail FROM contradictions"), budget: all("SELECT kind,SUM(units) u FROM budget_ledger WHERE scope='global' GROUP BY kind"), via: Object.fromEntries(["investigate", "recheck", "checkpoint"].map(v => [v, revealed.filter(r => r.via === v).length])) }
      : { campaign: one("SELECT status,stop_reason FROM campaigns WHERE id=?", cid), ops: all("SELECT kind,status,COUNT(*) n FROM opportunities GROUP BY kind,status"), via: Object.fromEntries(["investigate", "recheck", "checkpoint"].map(v => [v, revealed.filter(r => r.via === v).length])) };
    console.log("RESULT " + JSON.stringify(out));
  } finally { await rm(work, { recursive: true, force: true }); }
}
