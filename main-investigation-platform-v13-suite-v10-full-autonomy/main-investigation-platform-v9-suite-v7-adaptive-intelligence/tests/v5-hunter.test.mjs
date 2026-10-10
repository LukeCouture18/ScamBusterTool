// Platform v5 · Operations + Operation Hunter v2.0: the coordination layer on Main's side.
//
//   - migration 0012 is additive; the schema gate requires it
//   - operation_hunter is a module; HUNT_OPERATION a job type; reconstruct_operation a work kind
//   - a Hunter snapshot is stored idempotently; demo operations never create work
//   - proposals become Main's own typed work (never executed directly), deduplicated
//   - Hunter's site observations go through the temporal layer (a real change is a change,
//     the same value again is nothing, a simultaneous different source is a contradiction)
//   - significant Hunter contradictions become human tasks
//   - reconstruction is only proposed while Hunter is registered; the executor routes it as a
//     HUNT_OPERATION job carrying the automation policy; reconciliation judges usefulness by members
import { importFrom } from "./lib/portable.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("../drizzle/", import.meta.url);
const names = (await readdir(root)).filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort();
const scripts = await Promise.all(names.map(n => readFile(new URL(n, root), "utf8")));
const h12 = names.indexOf("0012_operation_hunter.sql");
const work = await mkdtemp(join(tmpdir(), "mip-v5-hunter-"));
await build({ entryPoints: ["lib/ops/hunter.ts", "lib/ops/executor.ts", "lib/ops/workitems.ts", "lib/schema-ready.ts", "lib/platform.ts", "lib/domain.mjs", "app/api/v1/operations/sync/route.ts", "app/api/v1/operations/[id]/requests/route.ts", "app/api/v1/operations/reconstruct/route.ts"],
  bundle: true, splitting: true, format: "esm", platform: "node", outdir: work, outbase: ".", logLevel: "error",
  plugins: [{ name: "env", setup(p) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "m" })); p.onLoad({ filter: /.*/, namespace: "m" }, () => ({ contents: "export const env=new Proxy({},{get:(_,k)=>globalThis.__TEST_ENV[k]})", loader: "js" })); } }] });
const L = (p) => importFrom(work, p);

function database(upTo = scripts.length) {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  for (let i = 0; i < upTo; i++) sql.exec(scripts[i]);
  const d1 = { prepare(statement) { let params = []; return { bind(...v) { params = v; return this; }, async run() { const r = sql.prepare(statement).run(...params); return { meta: { changes: Number(r.changes) } }; }, async first() { return sql.prepare(statement).get(...params) ?? null; }, async all() { return { results: sql.prepare(statement).all(...params) }; } }; }, async batch(q) { sql.exec("BEGIN"); try { const out = []; for (const s of q) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  globalThis.__TEST_ENV = { DB: d1, AI_PROVIDER: "rules", MODULE_API_KEYS: JSON.stringify({ operation_hunter: "hunter-key", site_investigator: "si-key", wallet_investigator: "wi-key" }) };
  return { sql, one: (q, ...a) => sql.prepare(q).get(...a), all: (q, ...a) => sql.prepare(q).all(...a), n: (q, ...a) => Number(Object.values(sql.prepare(q).get(...a) ?? { n: 0 })[0] ?? 0) };
}
const req = (path, body, key) => new Request("http://127.0.0.1" + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: JSON.stringify(body) });
const P = (o) => ({ params: Promise.resolve(o) });

function snapshot(over = {}) {
  return {
    schema_version: "2.0",
    operation: { external_id: "op-h1", code: "OP-H1", name: "Claim portal ring", status: "ACTIVE", is_demo: false, seed: "claim-a.test", investigation_id: "inv-h", headline: "3 sites linked to one operator", narrative: "", confidence: 0.82, depth_score: 70, revision: 5, hunter_version: "2.0.0",
      top_findings: [{ key: "k1", kind: "operator_indicator", title: "Same analytics ID on 3 sites", why: "…", uncertainty: "…", does_not_prove: "…", next_step: "…" }, { key: "k2", kind: "money_flow", title: "Funds converge" }, { key: "k3", kind: "lifecycle", title: "Rotating" }], ...(over.operation ?? {}) },
    model: { status: "rotating", status_reason: "1 site went dark and 1 reserve domain is ready.", counts: { members: 3, live: 2, dark: 1 }, forecast: { status: "due" }, explanations: [{ key: "who", leading: "One operator runs these sites", margin: 6 }], unknowns: ["Where the money ends up"], version: 4, last_change: "1 site went dark" },
    members: [{ entity_type: "site", canonical_key: "claim-a.test", role: "seed", probability: 1, state: "live" }, { entity_type: "site", canonical_key: "claim-b.test", role: "member", probability: 0.97, state: "live", why: "Uses the same analytics account" }, { entity_type: "site", canonical_key: "claim-c.test", role: "member", probability: 0.9, state: "dark" }, { entity_type: "wallet", canonical_key: "0xabc0000000000000000000000000000000000001", role: "collection", probability: 1 }],
    proposals: [
      { key: "investigate_site:claim-b.test", kind: "investigate_site", target_type: "domain", target_key: "claim-b.test", probability: 0.97, value: 0.95, reason: "live member" },
      { key: "investigate_site:known.test", kind: "investigate_site", target_type: "domain", target_key: "known.test", probability: 0.9, value: 0.9, reason: "member Main already tracks" },
      { key: "analyze_wallet:0xabc0000000000000000000000000000000000001", kind: "analyze_wallet", target_type: "wallet", target_key: "0xabc0000000000000000000000000000000000001", value: 0.7, reason: "collection wallet" },
      { key: "bogus", kind: "delete_everything", target_type: "x", target_key: "y" },
    ],
    changes: [{ id: "c1", domain: "claim-b.test", facet: "ip", value: ["185.1.1.1"], at: "2026-09-20T10:00:00.000Z" }, { id: "c2", domain: "claim-b.test", facet: "status", value: "live", at: "2026-09-20T10:00:00.000Z" }, { id: "c3", domain: "not-a-member.test", facet: "ip", value: ["1.1.1.1"] }],
    contradictions: [{ fingerprint: "planted:x", kind: "inconsistent_indicator", severity: 0.7, summary: "@handle appears on a site whose other settings belong to someone else", status: "open" }, { fingerprint: "minor", kind: "source_conflict", severity: 0.3, summary: "minor", status: "open" }],
    ...over.rest,
  };
}

function seedMain(db) {
  const run = (q, ...a) => db.sql.prepare(q).run(...a);
  run("INSERT INTO investigations(id,external_id,title) VALUES ('inv-h-id','inv-h','Operation OP-H1')");
  run("INSERT INTO investigations(id,external_id,title) VALUES ('inv-k','ext-k','known site')");
  run("INSERT INTO entities(id,entity_type,canonical_key,display_name) VALUES ('e-w','wallet','ethereum:0xabc0000000000000000000000000000000000001','w')");
  run("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES ('ie-w','inv-h-id','e-w','operation_hunter','r')");
  run("INSERT INTO inbox_candidates(id,canonical_domain,url,status,score,investigation_id) VALUES ('cand-k','known.test','https://known.test/','ready',0.6,'inv-k')");
}

test("migration 0012 is additive and required by the schema gate", async () => {
  assert.ok(h12 > 0);
  assert.doesNotMatch(scripts[h12], /DROP\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s+`?\w+`?\s+SET/i);
  const { assertSchemaReady } = await L("lib/schema-ready.js");
  const before = database(h12);
  const tables = before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'");
  await assert.rejects(assertSchemaReady(globalThis.__TEST_ENV.DB), /SCHEMA_UPGRADE_INCOMPLETE/);
  before.sql.exec(scripts[h12]);
  const after = new Map(before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => [r.name, r.sql]));
  for (const t of tables) assert.equal(after.get(t.name), t.sql, `${t.name} unchanged`);
  // later releases add their own required migrations; the gate passes once the ordered set is complete
  for (let i = h12 + 1; i < scripts.length; i++) before.sql.exec(scripts[i]);
  await assertSchemaReady(globalThis.__TEST_ENV.DB);
  assert.equal(before.one("SELECT value FROM ops_state WHERE key='module_limit:operation_hunter'").value, "1");
});

test("migration 0014 (Site Finder hunts) is additive and required by the schema gate", async () => {
  const h14 = names.indexOf("0014_finder_hunts.sql");
  assert.ok(h14 > h12);
  assert.doesNotMatch(scripts[h14], /DROP\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s+`?\w+`?\s+SET/i);
  const { assertSchemaReady } = await L("lib/schema-ready.js");
  const before = database(h14);
  const tables = before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'");
  await assert.rejects(assertSchemaReady(globalThis.__TEST_ENV.DB), /SCHEMA_UPGRADE_INCOMPLETE/);
  before.sql.exec(scripts[h14]);
  const after = new Map(before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => [r.name, r.sql]));
  for (const t of tables) assert.equal(after.get(t.name), t.sql, `${t.name} unchanged`);
  for (let i = h14 + 1; i < scripts.length; i++) before.sql.exec(scripts[i]);
  await assertSchemaReady(globalThis.__TEST_ENV.DB);
  // Objects added by migrations after 0014 (e.g. 0015) are not 0014's to roll back.
  const later = before.all("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => r.name).filter(n => !after.has(n));
  before.sql.exec("DROP TABLE finder_hunts");            // rollback of 0014 restores the v2.1 schema exactly
  const restored = new Map(before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => [r.name, r.sql]));
  assert.deepEqual([...restored.keys()].sort(), [...tables.map(t => t.name), ...later].sort());
});

test("migration 0015 (v4 wallet pipeline) is additive and required by the schema gate", async () => {
  const h15 = names.indexOf("0015_wallet_pipeline.sql");
  assert.ok(h15 > names.indexOf("0014_finder_hunts.sql"));
  assert.doesNotMatch(scripts[h15], /DROP\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s+`?\w+`?\s+SET/i);
  const { assertSchemaReady } = await L("lib/schema-ready.js");
  const before = database(h15);
  const tables = before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'");
  await assert.rejects(assertSchemaReady(globalThis.__TEST_ENV.DB), /SCHEMA_UPGRADE_INCOMPLETE/);
  before.sql.exec(scripts[h15]);
  before.sql.exec(scripts[h15]);                         // idempotent: a second run changes nothing
  const after = new Map(before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => [r.name, r.sql]));
  for (const t of tables) assert.equal(after.get(t.name), t.sql, `${t.name} unchanged`);
  for (let i = h15 + 1; i < scripts.length; i++) before.sql.exec(scripts[i]);
  await assertSchemaReady(globalThis.__TEST_ENV.DB);
  for (const t of ["wallet_observations", "wallet_candidates", "wallet_discovery_stats", "report_contents", "module_destinations"]) before.sql.exec(`DROP TABLE ${t}`);
  const restored = new Map(before.all("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").map(r => [r.name, r.sql]));
  const laterObjects=[];
  const onlyLater=new DatabaseSync(':memory:');
  // Later migrations may add indexes/settings to earlier tables. Supply their
  // real dependencies, then compare only objects newly introduced by them.
  for(let i=0;i<=h15;i++)onlyLater.exec(scripts[i]);
  const earlierNames=new Set(onlyLater.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name));
  for(let i=h15+1;i<scripts.length;i++)onlyLater.exec(scripts[i]);
  laterObjects.push(...onlyLater.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name).filter(name=>!earlierNames.has(name)&&onlyLater.prepare("SELECT tbl_name FROM sqlite_master WHERE name=?").get(name)&&!["wallet_observations","wallet_candidates","wallet_discovery_stats","report_contents","module_destinations"].includes(onlyLater.prepare("SELECT tbl_name FROM sqlite_master WHERE name=?").get(name).tbl_name)));onlyLater.close();
  assert.deepEqual([...restored.keys()].sort(), [...tables.map(t => t.name),...laterObjects].sort(), "dropping the five v4 tables restores its earlier objects while retaining later migrations");
});

test("contracts: module, job type and work kind", async () => {
  const { SOURCE_MODULES } = await L("lib/platform.js"); const { JOB_TYPES } = await L("lib/domain.js"); const { KINDS, MODULE_OF } = await L("lib/ops/workitems.js");
  assert.ok(SOURCE_MODULES.includes("operation_hunter"));
  assert.ok(JOB_TYPES.includes("HUNT_OPERATION"));
  assert.ok(KINDS.includes("reconstruct_operation"));
  assert.equal(MODULE_OF.reconstruct_operation, "operation_hunter");
});

test("a Hunter snapshot is stored idempotently and its proposals become Main's own work", async () => {
  const db = database(); seedMain(db);
  const route = await L("app/api/v1/operations/sync/route.js");
  assert.equal((await route.POST(req("/api/v1/operations/sync", snapshot(), "wrong"))).status, 401);
  assert.equal((await route.POST(req("/api/v1/operations/sync", { schema_version: "9", operation: {} }, "hunter-key"))).status, 400);
  const r1 = await route.POST(req("/api/v1/operations/sync", snapshot(), "hunter-key"));
  assert.equal(r1.status, 201, await r1.clone().text());
  const body = await r1.json();
  assert.equal(body.proposals.received, 4);
  const op = db.one("SELECT * FROM hunter_operations WHERE external_id='op-h1'");
  assert.equal(op.model_status, "rotating");
  assert.equal(JSON.parse(op.discoveries).length, 3);
  assert.equal(db.n("SELECT COUNT(*) n FROM hunter_operation_members WHERE operation_id=?", op.id), 4);
  // Unknown correlated site receives its own site-specific investigation and report boundary.
  const cand = db.one("SELECT * FROM inbox_candidates WHERE canonical_domain='claim-b.test'");
  assert.equal(cand.source_module, "operation_hunter");
  assert.equal(cand.investigation_id, db.one("SELECT id FROM investigations WHERE external_id='operation-site:claim-b.test'").id);
  assert.notEqual(cand.investigation_id, "inv-h-id");
  assert.equal(db.one("SELECT investigation_id FROM work_items WHERE kind='investigate_candidate' AND target_key='claim-b.test'").investigation_id,cand.investigation_id);
  assert.match(JSON.parse(cand.details).disclaimer, /not proof of common ownership/);
  assert.ok(db.one("SELECT * FROM work_items WHERE kind='investigate_candidate' AND target_key='claim-b.test'"));
  // known site -> investigate_candidate work in its own investigation
  const known = db.one("SELECT * FROM work_items WHERE kind='investigate_candidate' AND target_key='known.test'");
  assert.equal(known.investigation_id, "inv-k");
  assert.match(known.reason, /Operation Hunter \(OP-H1\)/);
  // wallet present in a Main investigation -> analyze_wallet work on the entity
  assert.equal(db.one("SELECT target_key FROM work_items WHERE kind='analyze_wallet'").target_key, "e-w");
  // an unknown proposal kind is recorded, never executed
  assert.equal(db.one("SELECT outcome FROM hunter_proposals WHERE proposal_key='bogus'").outcome, "not_actionable");
  // observations: only member sites, through the temporal layer
  assert.equal(db.n("SELECT COUNT(*) n FROM entity_facets WHERE subject_key='claim-b.test' AND source_table='hunter_operations'"), 2);
  assert.equal(db.n("SELECT COUNT(*) n FROM entity_facets WHERE subject_key='not-a-member.test'"), 0);
  // the significant contradiction became a human task; the minor one did not
  assert.equal(db.n("SELECT COUNT(*) n FROM contradictions WHERE kind LIKE 'hunter_%'"), 1);
  assert.equal(db.one("SELECT status FROM work_items WHERE kind='review_contradiction'").status, "waiting_human");
  // the same snapshot again changes nothing
  const works = db.n("SELECT COUNT(*) n FROM work_items"), changes = db.n("SELECT COUNT(*) n FROM entity_changes");
  assert.equal((await route.POST(req("/api/v1/operations/sync", snapshot(), "hunter-key"))).status, 200);
  assert.equal(db.n("SELECT COUNT(*) n FROM work_items"), works);
  assert.equal(db.n("SELECT COUNT(*) n FROM entity_changes"), changes, "the same observation again is not a change");
  // a real change later is a change (and reaches Main's reactions)
  const moved = snapshot({ rest: { changes: [{ id: "c9", domain: "claim-b.test", facet: "ip", value: ["185.9.9.9"], at: "2026-09-23T10:00:00.000Z" }] } });
  await route.POST(req("/api/v1/operations/sync", moved, "hunter-key"));
  assert.equal(db.one("SELECT change_kind FROM entity_changes WHERE subject_key='claim-b.test' ORDER BY detected_at DESC LIMIT 1").change_kind, "infrastructure_changed");
  // a person skipping the site makes Main refuse Hunter's investigation proposal for it
  db.sql.prepare("UPDATE inbox_candidates SET decision='skip' WHERE canonical_domain='known.test'").run();
  await route.POST(req("/api/v1/operations/sync", snapshot({ rest: { proposals: [{ key: "investigate_site:known.test:2", kind: "investigate_site", target_type: "domain", target_key: "known.test", value: 1 }] } }), "hunter-key"));
  assert.equal(db.one("SELECT outcome FROM hunter_proposals WHERE proposal_key='investigate_site:known.test:2'").outcome, "skipped_by_person");
});

test("demo operations are mirrored for display but never create work", async () => {
  const db = database(); seedMain(db);
  const route = await L("app/api/v1/operations/sync/route.js");
  const demo = snapshot({ operation: { external_id: "op-demo", is_demo: true } });
  assert.equal((await route.POST(req("/api/v1/operations/sync", demo, "hunter-key"))).status, 201);
  assert.equal(db.n("SELECT COUNT(*) n FROM work_items"), 0);
  assert.equal(db.n("SELECT COUNT(*) n FROM inbox_candidates WHERE source_module='operation_hunter'"), 0);
});

test("reconstruction: proposed only while Hunter is registered, routed as a HUNT_OPERATION job, judged by what it found", async () => {
  const db = database();
  const H = await L("lib/ops/hunter.js"), E = await L("lib/ops/executor.js");
  const run = (q, ...a) => db.sql.prepare(q).run(...a);
  run("INSERT INTO campaigns(id,title,status,deadline_at) VALUES ('camp-1','Claim ring','RUNNING','2030-01-01 00:00:00')");
  for (const d of ["a.test", "b.test", "c.test"]) run("INSERT INTO campaign_members(id,campaign_id,domain,state) VALUES (?,?,?,?)", `m-${d}`, "camp-1", d, "done");
  run("INSERT INTO campaign_edges(id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) VALUES ('ce','camp-1','site','a.test','wallet','ethereum:0xabc','displays_wallet','observed','evidence','ev')");
  assert.equal(await H.proposeReconstructions(), 0, "nothing proposed while Hunter is not registered");
  run("INSERT INTO module_registry(module_name,connection_status,runtime_status,capabilities,last_heartbeat_at) VALUES ('operation_hunter','connected','idle','[\"operation:reconstruct\"]',CURRENT_TIMESTAMP)");
  assert.equal(await H.proposeReconstructions(), 1);
  assert.equal(await H.proposeReconstructions(), 0, "idempotent");
  const w = db.one("SELECT * FROM work_items WHERE kind='reconstruct_operation'");
  assert.equal(w.module, "operation_hunter");
  const out = await E.executeWork(w);
  assert.equal(out.status, "running", JSON.stringify(out));
  const job = db.one("SELECT * FROM jobs WHERE id=?", out.jobId);
  assert.equal(job.job_type, "HUNT_OPERATION");
  const payload = JSON.parse(job.payload);
  assert.deepEqual(payload.seeds.map(s => s.value), ["a.test", "b.test", "c.test", "0xabc"]);
  assert.equal(payload.campaign_id, "camp-1");
  assert.ok(payload.automation_policy, "the platform's automation policy travels with the job");
  // Hunter completes the job and syncs: usefulness comes from the members it found
  run("UPDATE jobs SET status='completed',result=? WHERE id=?", JSON.stringify({ operation_id: "op-camp" }), job.id);
  const early = await E.reconcileWork({ ...w, job_id: job.id });
  assert.equal(early.status, "done"); assert.ok(early.useful < 0.5, "not useful until Hunter reports members");
  await H.syncFromHunter(snapshot({ operation: { external_id: "op-camp", campaign_id: "camp-1" } }));
  const later = await E.reconcileWork({ ...w, job_id: job.id });
  assert.equal(later.useful, 1);
  assert.equal(db.one("SELECT campaign_id FROM hunter_operations WHERE external_id='op-camp'").campaign_id, "camp-1");
  assert.equal(await H.proposeReconstructions(), 0, "a campaign with a reconstruction is not proposed again");
  const view = await H.hunterForCampaign("camp-1");
  assert.equal(view.external_id, "op-camp");
  assert.match(view.disclaimer, /not proof/);
});

test("operator and module requests go through work items", async () => {
  const db = database(); seedMain(db);
  const sync = await L("app/api/v1/operations/sync/route.js"), rq = await L("app/api/v1/operations/[id]/requests/route.js"), rc = await L("app/api/v1/operations/reconstruct/route.js");
  assert.equal((await rq.POST(req("/x", { kind: "site_check", canonical_key: "known.test" }, "hunter-key"), P({ id: "op-none" }))).status, 404);
  await sync.POST(req("/api/v1/operations/sync", snapshot(), "hunter-key"));
  const r = await rq.POST(req("/x", { kind: "site_check", canonical_key: "new-member.test", reason: "analyst" }, "hunter-key"), P({ id: "op-h1" }));
  assert.equal(r.status, 202);
  assert.ok(db.one("SELECT * FROM inbox_candidates WHERE canonical_domain='new-member.test'"));
  assert.equal((await rc.POST(req("/x", { domain: "x.test" }))).status, 202);
  assert.equal(db.one("SELECT source FROM work_items WHERE kind='reconstruct_operation' AND target_key='x.test'").source, "command");
  assert.equal((await rc.POST(req("/x", {}))).status, 400);
});

test.after(async () => { await rm(work, { recursive: true, force: true }); });


test("v6 schema gate rejects an incomplete operation alias migration",async()=>{const db=database();const schema=await L("lib/schema-ready.js");await schema.assertSchemaReady(globalThis.__TEST_ENV.DB);db.sql.exec("DROP TABLE operation_aliases");await assert.rejects(()=>schema.assertSchemaReady(globalThis.__TEST_ENV.DB),/SCHEMA_UPGRADE_INCOMPLETE/);});
