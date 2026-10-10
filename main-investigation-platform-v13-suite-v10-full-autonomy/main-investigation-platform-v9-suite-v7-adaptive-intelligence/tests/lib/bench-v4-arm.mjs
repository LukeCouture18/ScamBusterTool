// One arm of the v3-vs-v4 benchmark (see tests/bench-v4.mjs). Runs in its own
// process with its own in-memory database; prints one "RESULT {json}" line.
import { importFrom, localPath, runPythonJson } from "./portable.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const md5 = (s) => createHash("md5").update(s).digest("hex");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The ground-truth world for one seed. */
export function makeWorld(seed) {
  const r = rng(seed * 7919 + 13); const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const sites = new Map(); let n = 0;
  const wallet = (tag) => `T${md5(`${seed}:${tag}:${n++}`).slice(0, 33)}`;
  const CDN = "104.16.0.1";
  const operator = (op, kits, nsShared) => {
    const ns = `ns1.${op}-dns.test|ns2.${op}-dns.test`;
    const opWallet = wallet(`${op}-op`);
    kits.forEach((size, k) => {
      const kit = `${op}${k}`, tmpl = `fav-${kit}|tmpl-${kit}`, ips = [`198.18.${seed}.${10 + k * 2}`, `198.18.${seed}.${11 + k * 2}`], pool = [wallet(kit), wallet(kit)];
      for (let i = 0; i < size; i++) {
        const domain = `${kit}-${i}-s${seed}.test`;
        const w = i === 0 ? opWallet : r() < 0.7 ? pick(pool) : wallet(`${kit}-u`);
        const state = i === 0 ? "live" : r() < 0.15 ? "dead" : r() < 0.18 ? "login" : "live";
        const ip = r() < 0.12 ? CDN : pick(ips);
        sites.set(domain, { domain, scam: true, op, kit, tmpl, ip, ns: nsShared || k === 0 ? ns : `ns1.${kit}.test|ns2.${kit}.test`, wallet: w, state,
          inInbox: i === 0 && k === 0 ? true : r() < 0.5, finderCluster: r() < 0.5 ? `kit:${kit}` : null, finderSeesWallet: state === "live" && r() < 0.5, score: 0.75 + r() * 0.23 });
      }
    });
  };
  operator("alpha", [8, 6, 4], true);
  operator("bravo", [5], false);
  operator("charlie", [4], false);
  for (let i = 0; i < 28; i++) {                              // legitimate sites on a big CDN: generic hosting
    const domain = `shop${i}-s${seed}.test`;
    sites.set(domain, { domain, scam: false, op: null, kit: null, tmpl: `fav-shop${i}|tmpl-shop${i}`, ip: CDN, ns: "ns1.cdn.test|ns2.cdn.test", wallet: null, state: "live",
      inInbox: true, finderCluster: null, finderSeesWallet: false, score: 0.45 + r() * 0.4 });
  }
  const seedSite = [...sites.values()].find(s => s.kit === "alpha0" && s.inInbox && s.state === "live").domain;
  return { sites, seedSite, CDN };
}

export async function runArm(arm, seed, budget, discovery = 8) {
  const world = makeWorld(seed);
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../../drizzle/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(await readFile(new URL(name, migrations), "utf8"));
  const d1 = { prepare(statement) { let params = []; return { bind(...v) { params = v; return this; }, async run() { const r = sql.prepare(statement).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, async first() { return sql.prepare(statement).get(...params) ?? null; }, async all() { return { results: sql.prepare(statement).all(...params) }; } }; }, async batch(q) { sql.exec("BEGIN"); try { const out = []; for (const s of q) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  const one = (q, ...a) => sql.prepare(q).get(...a), all = (q, ...a) => sql.prepare(q).all(...a);
  globalThis.__TEST_ENV = { DB: d1, MODULE_API_KEYS: JSON.stringify({ site_finder: "finder-key", site_investigator: "investigator-key", crypto_wallet_logger: "logger-key", wallet_investigator: "wallet-key" }), AI_PROVIDER: "rules" };
  const work = await mkdtemp(join(tmpdir(), "mip-bench-v4-"));
  const started = Date.now();
  try {
    const root = localPath("../../", import.meta.url);
    const routes = ["app/api/v1/modules/[module]/register/route.ts", "app/api/v1/ingest/[module]/route.ts", "app/api/v1/modules/[module]/jobs/claim/route.ts", "app/api/v1/modules/[module]/jobs/[id]/route.ts",
      "app/api/v1/inbox/[id]/decision/route.ts", "app/api/v1/inbox/settings/route.ts", "app/api/v1/inbox/next/route.ts", "app/api/v1/agent/settings/route.ts", "app/api/v1/modules/[module]/heartbeat/route.ts", "lib/campaign/campaign.ts", "lib/campaign/view.ts", "lib/agent/runner.ts"].map(p => join(root, p));
    await build({ entryPoints: routes, bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: root, logLevel: "silent", plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=globalThis.__TEST_ENV", loader: "js" })); } }] });
    const L = (p) => importFrom(work, p);
    const register = await L("app/api/v1/modules/[module]/register/route.js"), ingest = await L("app/api/v1/ingest/[module]/route.js"), claim = await L("app/api/v1/modules/[module]/jobs/claim/route.js"), update = await L("app/api/v1/modules/[module]/jobs/[id]/route.js");
    const inboxDecision = await L("app/api/v1/inbox/[id]/decision/route.js"), inboxSettings = await L("app/api/v1/inbox/settings/route.js"), inboxNext = await L("app/api/v1/inbox/next/route.js"), agentSettings = await L("app/api/v1/agent/settings/route.js");
    const campaign = await L("lib/campaign/campaign.js"), view = await L("lib/campaign/view.js"), runner = await L("lib/agent/runner.js");
    const req = (path, data, key, method = "POST") => new Request("http://127.0.0.1" + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const P = (o) => ({ params: Promise.resolve(o) });
        const heartbeat = async () => { for (const [m, key, caps] of [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]])
      assert.equal((await register.POST(req(`/api/v1/modules/${m}/register`, { module_version: "bench", schema_version: "3.0", capabilities: caps, supported_event_types: [] }, key), P({ module: m }))).status, 200); };
    await heartbeat();
    await inboxSettings.PATCH(req("/x", { investigate_on_useful: false, find_related_on_useful: false, target_depth: 0 }, undefined, "PATCH"));
    await agentSettings.PATCH(req("/x", { auto_start_on_useful: arm === "v3" }, undefined, "PATCH"));
    const nextMinute = () => sql.exec("DELETE FROM rate_limit_windows");
    // Workers report "idle" on their periodic heartbeat, which is what makes a module selectable again after a failed job.
    const hbRoute = await L("app/api/v1/modules/[module]/heartbeat/route.js");
    const beat = async () => { for (const [m, key, caps] of [["site_finder", "finder-key", ["site:discover", "site:relate"]], ["site_investigator", "investigator-key", ["site:investigate"]], ["crypto_wallet_logger", "logger-key", ["wallet:log"]], ["wallet_investigator", "wallet-key", ["wallet:analyze"]]])
      assert.equal((await hbRoute.POST(req("/x", { module_version: "bench", schema_version: "3.0", status: "idle", capabilities: caps }, key), P({ module: m }))).status, 200); };

    const template = runPythonJson(localPath("./finder-v2-batches.py", new URL("../", import.meta.url))).batches[0];
    const tDomain = template.records.sites[0].canonical_key, tHash = template.records.sites[0].external_id.split(":").pop();
    const siTemplate = runPythonJson(localPath("./site-bridge-synthetic.py", new URL("../", import.meta.url)), { env: { MIP_BATCH_JSON: "1" } }).batch;
    const siWallet = siTemplate.records.wallets[0].address;
    const ingested = new Set();
    async function surface(domain) {
      const s = world.sites.get(domain); if (!s || ingested.has(domain)) return false;
      nextMinute();
      const records = JSON.parse(JSON.stringify(template.records).split(tDomain).join(domain).split(tHash).join(md5(domain)));
      const keys = [["favtmpl", s.tmpl], ["favicon", s.tmpl.split("|")[0]], ["ip", s.ip], ["ns", s.ns]];
      Object.assign(records.sites[0].inbox, { cluster_key: s.finderCluster ?? `c:${domain}`, keys, wallets: s.finderSeesWallet ? [s.wallet] : [], worth_checking: Number(s.score.toFixed(3)), related_domains: [] });
      records.sites[0].confidence = s.score; records.sites[0].triage.confidence = s.score;
      const res = await ingest.POST(req("/api/v1/ingest/site_finder", { schema_version: "3.0", batch_id: `b:${domain}`, sent_at: new Date().toISOString(), records }, "finder-key"), P({ module: "site_finder" }));
      assert.equal(res.status, 202, await res.clone().text());
      ingested.add(domain); return true;
    }
    for (const s of world.sites.values()) if (s.inInbox) await surface(s.domain);

    // ---------------- module workers answering from ground truth
    const revealedOrder = [];                       // [{domain, wallet}] in the order modules revealed wallets
    const log = { si_jobs: 0, wi_jobs: 0, finder_jobs: 0, finder_zero: 0, finder_new_scam: 0, checkpoints: 0 };
    async function si() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "investigator-key"), P({ module: "site_investigator" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false; log.si_jobs++;
      const inv = one("SELECT i.external_id, c.canonical_domain d FROM investigations i JOIN inbox_candidates c ON c.investigation_id=i.id WHERE i.id=?", job.investigation_id);
      const s = world.sites.get(inv.d);
      if (s.state === "dead") { await update.PATCH(req("/x", { action: "fail", error: "DNS resolution failed: name or service not known", retry: false }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id })); return true; }
      const batch = JSON.parse(JSON.stringify(siTemplate).split("synthetic.example").join(s.domain).split("_synthetic").join(`_${md5(s.domain + job.id).slice(0, 10)}`).split(siWallet).join(s.wallet ?? siWallet));
      batch.origin_job_id = job.id; batch.batch_id = `si:${job.id}`; batch.sent_at = new Date().toISOString();
      for (const rows of Object.values(batch.records)) for (const row of rows) row.investigation_id = inv.external_id;
      if (s.state !== "live" || !s.wallet) { batch.records.wallets = []; batch.records.relationships = []; batch.records.deposit_options = []; batch.records.evidence = batch.records.evidence.filter(e => !String(e.evidence_type).includes("wallet")); }
      if (s.state === "login") batch.records.evidence.push({ investigation_id: inv.external_id, external_id: `login:${job.id}`, evidence_type: "page_text", evidence_class: "observed_website", observation_scope: "public", title: "Sign in",
        context_text: JSON.stringify({ title: "Members area", kind: "login", important_text: "Please sign in to continue to your deposit dashboard. Login required." }), confidence: 0.9, entity: { entity_type: "site", canonical_key: s.domain } });
      assert.equal((await ingest.POST(req("/x", batch, "investigator-key"), P({ module: "site_investigator" }))).status, 202);
      await update.PATCH(req("/x", { action: "complete", result: {} }, "investigator-key", "PATCH"), P({ module: "site_investigator", id: job.id }));
      if (s.state === "live" && s.wallet) revealedOrder.push({ domain: s.domain, wallet: s.wallet });
      return true;
    }
    async function wi() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "wallet-key"), P({ module: "wallet_investigator" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false; log.wi_jobs++;
      await update.PATCH(req("/x", { action: "complete", result: { risk: "high" } }, "wallet-key", "PATCH"), P({ module: "wallet_investigator", id: job.id })); return true;
    }
    const r2 = rng(seed * 104729 + (arm === "v3" ? 1 : 2));
    const P_FIND = { ip: 0.9, ns: 0.9, favtmpl: 0.6, favicon: 0.6, kit: 0.6, wallet: 0.4, san: 0.7, service: 0.5 };
    let noiseN = 0;
    async function finder() {
      nextMinute();
      const r = await claim.POST(req("/x", {}, "finder-key"), P({ module: "site_finder" })); if (r.status !== 200) return false;
      const job = (await r.json()).job; if (!job) return false; log.finder_jobs++;
      const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
      const found = [];
      if (payload.pivot) {                          // v4 contextual pivot: passive, indicator-specific
        const { kind, value } = payload.pivot;
        const matches = [...world.sites.values()].filter(s => !ingested.has(s.domain) && (kind === "ip" ? s.ip === value : kind === "ns" ? s.ns === value : kind === "favtmpl" ? s.tmpl === value : kind === "favicon" ? s.tmpl.startsWith(value + "|") : kind === "kit" ? `kit:${s.kit}` === value : kind === "wallet" ? (s.wallet ?? "").toLowerCase() === value : false));
        if (!(kind === "ip" && value === world.CDN)) for (const s of matches) if (found.length < 4 && r2() < (P_FIND[kind] ?? 0.3)) found.push(s.domain);
      } else if (job.job_type === "FIND_RELATED_SITES") { // v3 classic related round, seeded with one site
        const seedSite = world.sites.get(String(payload.canonical_key ?? "").toLowerCase());
        const kin = [...world.sites.values()].filter(s => !ingested.has(s.domain) && seedSite && s.kit === seedSite.kit);
        for (const s of kin) if (found.length < 3 && r2() < 0.5) found.push(s.domain);
        if (r2() < 0.5) { const d = `lookalike${noiseN++}-s${seed}-${arm}.test`; world.sites.set(d, { domain: d, scam: false, op: null, kit: null, tmpl: `fav-${d}|t`, ip: `203.0.113.${noiseN}`, ns: "ns1.parking.test|ns2.parking.test", wallet: null, state: r2() < 0.5 ? "dead" : "live", inInbox: false, finderCluster: null, finderSeesWallet: false, score: 0.7 + r2() * 0.1 }); found.push(d); }
      }
      for (const d of found) { await surface(d); if (world.sites.get(d).scam) log.finder_new_scam++; }
      if (!found.length) log.finder_zero++;
      await update.PATCH(req("/x", { action: "complete", result: { new_candidates: found, saturated: false } }, "finder-key", "PATCH"), P({ module: "site_finder", id: job.id }));
      return true;
    }
    // A person does what a checkpoint asks: signs in normally; CryptoWalletLogger records the wallet behind the login.
    async function resolveCheckpoints() {
      for (const c of all("SELECT h.id,h.investigation_id,i.external_id,cand.canonical_domain d FROM human_checkpoints h JOIN investigations i ON i.id=h.investigation_id JOIN inbox_candidates cand ON cand.investigation_id=h.investigation_id WHERE h.status='open'")) {
        const s = world.sites.get(c.d); log.checkpoints++;
        const b = { schema_version: "3.0", batch_id: `logger:${c.id}`, sent_at: new Date().toISOString(), records: { evidence: [{ investigation_id: c.external_id, external_id: `logger:${c.id}`, evidence_type: "wallet_display", evidence_class: "observed_website", observation_scope: "authenticated", title: "Deposit address behind login", context_text: JSON.stringify({ wallet: s.wallet }), confidence: 0.9, entity: { entity_type: "wallet", canonical_key: s.wallet, network: "tron" } }] } };
        nextMinute();
        assert.equal((await ingest.POST(req("/x", b, "logger-key"), P({ module: "crypto_wallet_logger" }))).status, 202);
        revealedOrder.push({ domain: s.domain, wallet: s.wallet });
      }
    }
    let ticks = 0;
    async function workAll() {
      nextMinute(); await beat();
      for (const r of all("SELECT investigation_id FROM agent_runs WHERE status='WAITING_FOR_MODULE'")) await runner.wake(r.investigation_id, "job");
      for (let i = 0; i < 40; i++) { const a = await si(), b = await wi(), c = await finder(); if (!a && !b && !c) break; }
      await resolveCheckpoints();
      for (const r of all("SELECT id FROM agent_runs WHERE status='RUNNING'")) { await runner.tick(r.id); ticks++; }
    }

    let decisions = 0;
    if (arm === "v3") {
      // A person works the inbox top-down; Useful starts the v3 investigator. Low-scoring cards are skipped.
      for (let guard = 0; guard < 400; guard++) {
        const investigations = one("SELECT COUNT(*) n FROM agent_runs").n;
        if (investigations >= budget) break;
        nextMinute();
        const next = await (await inboxNext.GET(req("/api/v1/inbox/next", undefined, undefined, "GET"))).json();
        if (!next.item) { await workAll(); if (!(await (await inboxNext.GET(req("/api/v1/inbox/next", undefined, undefined, "GET"))).json()).item) break; continue; }
        const useful = next.item.score >= 0.7;
        decisions++;
        await inboxDecision.POST(req("/x", useful ? { decision: "useful" } : { decision: "skip", reason: "not_useful" }), P({ id: next.item.id }));
        if (useful) for (let i = 0; i < 12; i++) { await workAll(); if (!one("SELECT COUNT(*) n FROM agent_runs WHERE status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN')").n) break; }
      }
      for (let i = 0; i < 20; i++) await workAll();
    } else {
      const c = await campaign.createCampaign({ seed_domain: world.seedSite, budgets: { max_investigations: budget, max_parallel: 3, max_discovery_requests: discovery } });
      for (let i = 0; i < 120; i++) {
        const s = one("SELECT status FROM campaigns WHERE id=?", c.id).status; if (s !== "RUNNING") break;
        await campaign.tickCampaign(c.id); ticks++;
        await workAll();
      }
      for (let i = 0; i < 10; i++) await workAll();
      globalThis.__cid = c.id;
    }

    // ---------------- metrics from ground truth
    const investigated = all("SELECT DISTINCT c.canonical_domain d FROM jobs j JOIN inbox_candidates c ON c.investigation_id=j.investigation_id WHERE j.job_type='INVESTIGATE_SITE'").map(r => r.d);
    const seen = new Set(); const usefulUnique = new Set();
    for (const r of revealedOrder) { if (!seen.has(r.wallet)) { usefulUnique.add(r.domain); seen.add(r.wallet); } }
    const truth = (d) => world.sites.get(d);
    const liveScam = investigated.filter(d => truth(d)?.scam && truth(d).state !== "dead");
    const dup = liveScam.filter(d => !usefulUnique.has(d));
    const dead = investigated.filter(d => truth(d)?.state === "dead");
    const nonScam = investigated.filter(d => !truth(d)?.scam);
    const moduleJobs = one("SELECT COUNT(*) n FROM jobs WHERE target_module IN ('site_investigator','wallet_investigator','site_finder')").n;
    const wasteJobs = one(`SELECT COUNT(*) n FROM jobs j JOIN inbox_candidates c ON c.investigation_id=j.investigation_id WHERE j.job_type IN ('INVESTIGATE_SITE','ANALYZE_WALLET','RECHECK_SITE') AND c.canonical_domain IN (${[...dup, ...dead, ...nonScam].map(() => "?").join(",") || "''"})`, ...dup, ...dead, ...nonScam).n;
    const usefulEvidence = one(`SELECT COUNT(*) n FROM evidence e JOIN inbox_candidates c ON c.investigation_id=e.investigation_id WHERE e.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator') AND c.canonical_domain IN (${[...usefulUnique].map(() => "?").join(",") || "''"})`, ...usefulUnique).n;
    const hyps = arm === "v4" ? all("SELECT status,COUNT(*) n FROM hypotheses GROUP BY status") : [];
    const hc = (s) => Number(hyps.find(h => h.status === s)?.n ?? 0);
    const alphaFound = [...world.sites.values()].filter(s => s.op === "alpha" && s.state !== "dead");
    const discoveryRequests = log.finder_jobs;
    const out = {
      investigations: investigated.length,
      useful_unique_investigations: usefulUnique.size,
      unique_wallets_revealed: seen.size,
      useful_evidence_items: usefulEvidence,
      useful_evidence_per_module_job: Number((usefulEvidence / Math.max(1, moduleJobs)).toFixed(3)),
      duplicate_investigations: dup.length,
      dead_or_non_scam_investigations: dead.length + nonScam.length,
      module_jobs: moduleJobs,
      actions_per_useful_investigation: Number((moduleJobs / Math.max(1, usefulUnique.size)).toFixed(2)),
      wasted_module_jobs: wasteJobs,
      human_interventions: decisions + log.checkpoints,
      inbox_decisions: decisions, checkpoints_resolved: log.checkpoints,
      discovery_requests: discoveryRequests,
      discovery_new_scam_sites: log.finder_new_scam,
      discovery_zero_yield: log.finder_zero,
      target_operator_coverage: Number((new Set([...usefulUnique].filter(d => truth(d)?.op === "alpha")).size / Math.max(1, new Set(alphaFound.map(s => s.wallet)).size)).toFixed(3)),
      hypotheses_supported: hc("supported"), hypotheses_disproved: hc("disproved"),
      model_calls: one("SELECT COUNT(*) n FROM agent_model_calls").n + (arm === "v4" ? one("SELECT COUNT(*) n FROM campaign_costs WHERE kind='model_call'").n : 0),
      platform_ticks: ticks,
      wall_ms: Date.now() - started,
    };
    if (arm === "v3") out.diagnostic = { inbox: all("SELECT status,COUNT(*) n FROM inbox_candidates GROUP BY status"), runs: all("SELECT status,headline,used_actions,COUNT(*) n FROM agent_runs GROUP BY status,headline"), jobs: all("SELECT job_type,status,COUNT(*) n FROM jobs GROUP BY job_type,status"), steps: all("SELECT capability,validation,outcome,COUNT(*) n FROM agent_steps GROUP BY 1,2,3"), decisions: all("SELECT decision,COUNT(*) n FROM inbox_decisions GROUP BY decision") };
    if (arm === "v4") out.diagnostic = { status: one("SELECT status,stop_reason FROM campaigns"), ops: all("SELECT kind,status,COUNT(*) n FROM opportunities GROUP BY kind,status"), rejected: all("SELECT target_key,reason FROM opportunities WHERE status='rejected' LIMIT 12"), members: one("SELECT COUNT(*) n FROM campaign_members").n };
    console.log("RESULT " + JSON.stringify(out));
  } finally { await rm(work, { recursive: true, force: true }); }
}
