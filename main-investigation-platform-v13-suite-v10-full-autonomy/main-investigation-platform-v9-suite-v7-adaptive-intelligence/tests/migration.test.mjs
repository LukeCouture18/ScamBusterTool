import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("coordination migration is additive and includes operational tables", async () => {
  const sql = await readFile(new URL("../drizzle/0001_coordination_hub.sql", import.meta.url), "utf8");
  for (const table of ["investigation_entities", "investigation_observations", "evidence_versions", "relationship_evidence", "jobs", "job_events", "module_registry", "dead_letters", "audit_log", "rate_limit_windows"]) {
    assert.match(sql, new RegExp("CREATE TABLE (?:IF NOT EXISTS )?`" + table + "`", "i"));
  }
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
});

test("orchestrator migration preserves data and adds durable workflow state", async()=>{
  const sql=await readFile(new URL("../drizzle/0002_investigation_orchestrator.sql",import.meta.url),"utf8");
  for(const table of ["automation_profiles","automation_rules","investigation_pipelines","pipeline_stages","job_dependencies","entity_analysis_state","investigation_timeline","notifications","review_queue","entity_aliases"]){assert.match(sql,new RegExp("CREATE TABLE `"+table+"`","i"));}
  assert.match(sql,/ALTER TABLE `jobs` ADD COLUMN `pipeline_id`/i);
  assert.doesNotMatch(sql,/DROP\s+TABLE|DELETE\s+FROM/i);
});

test("v4 migration adds a durable event backbone without replacing v3 data",async()=>{
  const sql=await readFile(new URL("../drizzle/0003_event_driven_backbone.sql",import.meta.url),"utf8");
  for(const table of ["event_store","event_deliveries","event_dead_letters","observation_versions","relationship_versions","job_event_links"])assert.match(sql,new RegExp("CREATE TABLE `"+table+"`","i"));
  assert.match(sql,/ALTER TABLE `jobs` ADD COLUMN `trigger_event_id`/i);
  assert.match(sql,/ALTER TABLE `module_registry` ADD COLUMN `supported_event_types`/i);
  assert.doesNotMatch(sql,/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i);
});
