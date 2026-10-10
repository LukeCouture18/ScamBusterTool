// v4 -> v5 upgrade: migration 0011 is additive, preserves every v4 record
// byte-for-byte, passes the startup schema gate, and an interrupted upgrade
// rolls back cleanly (the gate then refuses to start until it is re-applied).
import { importFrom } from "./lib/portable.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("../drizzle/", import.meta.url);
const names = (await readdir(root)).filter(n => /^[0-9]{4}_.*\.sql$/.test(n)).sort();
const scripts = await Promise.all(names.map(n => readFile(new URL(n, root), "utf8")));
const v5 = names.indexOf("0011_operations_v5.sql");
assert.ok(v5 > 0, "migration 0011 exists");
const work = await mkdtemp(join(tmpdir(), "mip-v5-migration-"));
await build({ entryPoints: ["lib/schema-ready.ts"], bundle: true, format: "esm", platform: "node", outfile: join(work, "gate.mjs") });
const { assertSchemaReady } = await importFrom(work, "gate.mjs");
const adapter = (sql) => ({ prepare(q) { let a = []; return { bind(...v) { a = v; return this; }, async all() { return { results: sql.prepare(q).all(...a) }; }, async first() { return sql.prepare(q).get(...a) ?? null; } }; } });

function seedV4(sql) {
  const run = (q, ...a) => sql.prepare(q).run(...a);
  run("INSERT INTO investigations(id,external_id,title) VALUES ('inv-1','ext-1','Historic investigation')");
  run("INSERT INTO evidence(id,investigation_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES ('ev-1','inv-1','site_investigator','r1','page_text','Deposit page','3.0',CURRENT_TIMESTAMP)");
  run("INSERT INTO inbox_candidates(id,canonical_domain,url,status,score,investigation_id,decision) VALUES ('cand-1','old.test','https://old.test/','completed',0.8,'inv-1','useful')");
  run("INSERT INTO agent_runs(id,investigation_id,status,deadline_at) VALUES ('run-1','inv-1','COMPLETED','2030-01-01 00:00:00')");
  run("INSERT INTO finder_outcomes(id,canonical_domain,outcome,basis) VALUES ('fo-1','old.test','useful','human')");
  run("INSERT INTO agent_settings(key,value) VALUES ('campaign_model_strategist','claude-x')");
  run("INSERT INTO campaigns(id,title,status,deadline_at,used_investigations) VALUES ('camp-1','Historic campaign','COMPLETE','2030-01-01 00:00:00',3)");
  run("INSERT INTO campaign_members(id,campaign_id,investigation_id,domain,state,reason) VALUES ('cm-1','camp-1','inv-1','old.test','done','seed')");
  run("INSERT INTO campaign_edges(id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) VALUES ('ce-1','camp-1','site','old.test','wallet','twallet','displays_wallet','observed','evidence','ev-1')");
  run("INSERT INTO opportunities(id,campaign_id,kind,target_type,target_key,fingerprint,status,priority) VALUES ('op-1','camp-1','investigate_candidate','domain','old.test','investigate:old.test','done',0.7)");
  run("INSERT INTO hypotheses(id,campaign_id,observation,statement,test_kind,test_target,status,confidence,proposed_by) VALUES ('h-1','camp-1','shared ip','sites share hosting','pivot','ip:1.2.3.4','supported',0.8,'deterministic')");
  run("INSERT INTO experience(id,context,action,expected,actual,cost,useful,basis,source_ref) VALUES ('x-1','ctx','investigate_candidate',0.5,1,1,1,'observed','op-1')");
  run("INSERT INTO campaign_costs(id,campaign_id,kind,units,ref) VALUES ('cc-1','camp-1','module_job',1,'job-1')");
  run("INSERT INTO campaign_artifacts(id,campaign_id,tick,role,kind,body) VALUES ('ca-1','camp-1',1,'planner','choice','{}')");
}
const V4_TABLES = ["investigations", "evidence", "inbox_candidates", "agent_runs", "finder_outcomes", "agent_settings", "campaigns", "campaign_members", "campaign_edges", "opportunities", "hypotheses", "experience", "campaign_costs", "campaign_artifacts"];
const fingerprint = (sql) => Object.fromEntries(V4_TABLES.map(t => [t, createHash("sha256").update(JSON.stringify(sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest("hex")]));
const v4db = () => { const sql = new DatabaseSync(":memory:"); for (let i = 0; i < v5; i++) sql.exec(scripts[i]); seedV4(sql); return sql; };

test("v4 database upgrades to v5: every v4 record preserved, schema gate passes, v5 defaults seeded", async () => {
  const sql = v4db();
  try {
    const before = fingerprint(sql);
    const v4Schema = sql.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    await assert.rejects(assertSchemaReady(adapter(sql)), /SCHEMA_UPGRADE_INCOMPLETE/, "a v5 build refuses to start on an un-upgraded v4 database");
    sql.exec("BEGIN"); sql.exec(scripts[v5]); for (let i = v5 + 1; i < scripts.length; i++) sql.exec(scripts[i]); sql.exec("COMMIT");
    assert.deepEqual(fingerprint(sql), before, "every v4 row is byte-identical after the upgrade");
    const after = new Map(sql.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all().map(r => [r.name, r.sql]));
    for (const t of v4Schema) assert.equal(after.get(t.name), t.sql, `v4 object ${t.name} unchanged (additive migration)`);
    await assertSchemaReady(adapter(sql));
    assert.equal(sql.prepare("SELECT value FROM ops_state WHERE key='scheduler_paused'").get().value, "false");
    assert.ok(sql.prepare("SELECT COUNT(*) n FROM budget_limits WHERE scope='global'").get().n >= 6);
    // v4 reads still work unchanged.
    assert.equal(sql.prepare("SELECT status FROM campaigns WHERE id='camp-1'").get().status, "COMPLETE");
  } finally { sql.close(); }
});

test("an interrupted v5 upgrade rolls back and the platform refuses to start until it is applied", async () => {
  const sql = v4db();
  try {
    const before = fingerprint(sql);
    const half = scripts[v5].split(";\n").slice(0, 12).join(";\n") + ";";
    sql.exec("BEGIN");
    assert.throws(() => { sql.exec(half); throw new Error("simulated crash mid-migration"); });
    sql.exec("ROLLBACK");
    assert.deepEqual(fingerprint(sql), before);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='work_items'").get().n, 0, "no partial v5 table survives");
    await assert.rejects(assertSchemaReady(adapter(sql)), /SCHEMA_UPGRADE_INCOMPLETE/);
    // Re-applying completes the upgrade (0011 and every later ordered migration, e.g. 0012 Operation Hunter).
    sql.exec("BEGIN"); for (let i = v5; i < scripts.length; i++) sql.exec(scripts[i]); sql.exec("COMMIT");
    await assertSchemaReady(adapter(sql));
  } finally { sql.close(); }
});

test("rollback to v4: v5 tables are additive, so v4 code reads a v5 database unchanged; dropping them restores the exact v4 schema", async () => {
  const sql = v4db();
  try {
    const v4Objects = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const before = fingerprint(sql);
    sql.exec("BEGIN"); sql.exec(scripts[v5]); sql.exec("COMMIT");
    const v5Tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).filter(n => !v4Objects.includes(n));
    assert.ok(v5Tables.length >= 26, `${v5Tables.length} v5 tables`);
    for (const t of v5Tables) sql.exec(`DROP TABLE ${t}`);
    assert.deepEqual(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name), v4Objects);
    assert.deepEqual(fingerprint(sql), before);
  } finally { sql.close(); }
});

test.after(async () => { await rm(work, { recursive: true, force: true }); });
