import {localPath,runPythonJson} from './lib/portable.mjs';
import assert from "node:assert/strict";

const base = "http://127.0.0.1:8787";
const keys = { site_finder:"test-sf", site_investigator:"test-si", crypto_wallet_logger:"test-logger", wallet_investigator:"test-wi", form_submitter:"test-form" };
const call = async (path, key, body) => {
  const response = await fetch(base + path, { method:"POST", headers:{"content-type":"application/json","x-api-key":key}, body:JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};

if (process.env.VERIFY_RESTART !== "1") {
  for (const [moduleName,key] of Object.entries(keys)) await call(`/api/v1/modules/${moduleName}/register`,key,{module_version:"v6.1-release-test",schema_version:"3.0",capabilities:moduleName==="site_investigator"?["site:investigate"]:moduleName==="wallet_investigator"?["wallet:analyze"]:moduleName==="form_submitter"?["report-preparation"]:moduleName==="crypto_wallet_logger"?["wallet:log"]:["site:relate"],supported_event_types:[]});
  const fixture=runPythonJson(localPath("./finder-batch-synthetic.py",import.meta.url),{env:{MIP_BATCH_JSON:"1"}});
  for (const batch of [fixture.unpromoted_observation,fixture]) await call("/api/v1/ingest/site_finder",keys.site_finder,{schema_version:"3.0",batch_id:batch.batch_id,sent_at:new Date().toISOString(),records:batch.records});
  const orchestration=await fetch(base+"/api/v1/orchestration").then(response=>response.json());
  assert.ok(orchestration.pipelines.length>0,"normal startup must process promoted persisted work");
  assert.ok(orchestration.jobs.some(job=>job.job_type==="INVESTIGATE_SITE"),"normal startup must persist downstream work");
  console.log(JSON.stringify({ok:true,phase:"started",pipelines:orchestration.pipelines.length,jobs:orchestration.jobs.length}));
} else {
  const orchestration=await fetch(base+"/api/v1/orchestration").then(response=>response.json());
  const dashboard=await fetch(base+"/api/v1/dashboard").then(response=>response.json());
  assert.ok(orchestration.pipelines.length>0,"pipelines survive normal production restart");
  assert.ok(Number(dashboard.counts.entities)>0,"entities survive normal production restart");
  console.log(JSON.stringify({ok:true,phase:"restarted",pipelines:orchestration.pipelines.length,entities:Number(dashboard.counts.entities)}));
}
