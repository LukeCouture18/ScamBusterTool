import assert from "node:assert/strict";

const base = (process.env.MIP_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const keys = JSON.parse(process.env.MIP_MODULE_KEYS ?? "{}");
const modules = ["site_finder", "site_investigator", "crypto_wallet_logger", "wallet_investigator"];
const run = `e2e-${Date.now()}`;
const investigation = `${run}-case`;
const siteDomain=`${run}.example`;
const depositUrl=`https://${siteDomain}/deposit`;
const walletAddress=`0x${Date.now().toString(16)}abcdef`;

function records(overrides = {}) {
  return { investigations:[], sites:[], related_sites:[], pages:[], deposit_pages:[], wallets:[], deposit_options:[], transactions:[], counterparties:[], tokens:[], networks:[], infrastructure_indicators:[], relationships:[], evidence:[], discovery_paths:[], findings:[], notes:[], module_activity:[], ...overrides };
}

async function call(module, path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type":"application/json", "x-api-key":keys[module], ...(options.headers ?? {}) } });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function ingest(module, batch, data, origin_job_id) {
  return call(module, `/api/v1/ingest/${module}`, { method:"POST", body:JSON.stringify({ schema_version:"1.1", batch_id:batch, sent_at:new Date().toISOString(), ...(origin_job_id ? {origin_job_id} : {}), records:data }) });
}

for (const moduleName of modules) {
  assert.ok(keys[moduleName], `Missing E2E key for ${moduleName}`);
  const heartbeat = await call(moduleName, `/api/v1/modules/${moduleName}/heartbeat`, { method:"POST", body:JSON.stringify({module_version:"e2e",schema_version:"1.1",status:"idle",capabilities:["e2e"]}) });
  assert.equal(heartbeat.response.status, 200, JSON.stringify(heartbeat.body));
}

// Keep repeated local runs deterministic by cancelling leftover non-terminal test work.
const existingOrchestration=await fetch(`${base}/api/v1/orchestration`).then(response=>response.json());
for(const job of existingOrchestration.jobs??[]){if(!["completed","cancelled"].includes(job.status))await fetch(`${base}/api/v1/orchestration/jobs/${job.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"cancel",reason:"E2E queue cleanup"})});}
for(const moduleName of modules){for(let i=0;i<20;i++){const claimed=await call(moduleName,`/api/v1/modules/${moduleName}/jobs/claim`,{method:"POST"});if(claimed.response.status===204)break;assert.equal(claimed.response.status,200,JSON.stringify(claimed.body));await fetch(`${base}/api/v1/orchestration/jobs/${claimed.body.job.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"cancel",reason:"E2E queue cleanup"})});}}

const unauthorized = await fetch(`${base}/api/v1/modules/site_finder/jobs/claim`, {method:"POST",headers:{"x-api-key":"wrong"}});
assert.equal(unauthorized.status, 401);

const siteBatch = await ingest("site_finder", `${run}-sf`, records({
  investigations:[{external_id:investigation,title:"E2E coordinated investigation",status:"open",priority:"high",confidence:1,provenance:{test:run}}],
  sites:[{external_id:`${run}-site`,investigation_id:investigation,canonical_key:`https://${siteDomain}/path`,display_name:siteDomain,confidence:.96,classification:"target",provenance:{test:run}}],
}));
assert.equal(siteBatch.response.status, 202, JSON.stringify(siteBatch.body));
assert.equal(siteBatch.body.status, "accepted");

const started=await fetch(`${base}/api/v1/orchestration`).then(response=>response.json());
const pipeline=started.pipelines.find(item=>item.investigation_external_id===investigation);
assert.equal(pipeline.profile_id,"deep-investigation");
const paused=await fetch(`${base}/api/v1/orchestration/pipelines/${pipeline.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"pause",reason:"E2E operator pause"})});assert.equal(paused.status,200);
const blockedByPause=await call("site_investigator","/api/v1/modules/site_investigator/jobs/claim",{method:"POST"});assert.equal(blockedByPause.response.status,204);
const resumed=await fetch(`${base}/api/v1/orchestration/pipelines/${pipeline.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"resume",reason:"E2E operator resume"})});assert.equal(resumed.status,200);

const claims = await Promise.all([1,2].map(() => call("site_investigator", "/api/v1/modules/site_investigator/jobs/claim", {method:"POST"})));
assert.equal(claims.filter((item) => item.response.status === 200).length, 1, "only one worker may claim a job");
const siteJob = claims.find((item) => item.body?.job)?.body.job;
assert.equal(siteJob.job_type, "INVESTIGATE_SITE");

const depositEvidence = `${run}-deposit-evidence`;
const siteInvestigation = await ingest("site_investigator", `${run}-si`, records({
  pages:[{external_id:`${run}-page`,investigation_id:investigation,canonical_key:depositUrl,display_name:"Deposit page",confidence:.94,provenance:{test:run}}],
  deposit_pages:[{external_id:`${run}-deposit-page`,investigation_id:investigation,canonical_key:depositUrl,display_name:"Deposit page",confidence:.97,provenance:{test:run}}],
  related_sites:[{external_id:`${run}-related`,investigation_id:investigation,canonical_key:`related-${siteDomain}`,display_name:`related-${siteDomain}`,confidence:.92,provenance:{test:run}}],
  wallets:[{external_id:`${run}-wallet`,investigation_id:investigation,canonical_key:walletAddress,network:"ethereum",display_name:walletAddress,classification:"merchant_deposit",confidence:.91,provenance:{test:run}}],
  deposit_options:[{external_id:`${run}-option`,investigation_id:investigation,canonical_key:`${run}-eth-option`,display_name:"ETH deposit",confidence:.9,provenance:{test:run}}],
  evidence:[{external_id:depositEvidence,investigation_id:investigation,evidence_type:"screenshot",evidence_class:"observed_website",observation_scope:"public",context_text:"Wallet shown on deposit page",title:"Deposit page evidence",confidence:1,provenance:{test:run}}],
  relationships:[
    {external_id:`${run}-site-page`,investigation_id:investigation,relationship_type:"contains",from:{entity_type:"site",canonical_key:siteDomain},to:{entity_type:"page",canonical_key:depositUrl},evidence_ids:[depositEvidence],confidence:.95,provenance:{test:run}},
    {external_id:`${run}-page-wallet`,investigation_id:investigation,relationship_type:"offers_wallet",from:{entity_type:"page",canonical_key:depositUrl},to:{entity_type:"wallet",canonical_key:walletAddress,network:"ethereum"},evidence_ids:[depositEvidence],confidence:.95,provenance:{test:run}},
  ],
}), siteJob.id);
assert.equal(siteInvestigation.body.status, "accepted", JSON.stringify(siteInvestigation.body));
const siteComplete = await call("site_investigator", `/api/v1/modules/site_investigator/jobs/${siteJob.id}`, {method:"PATCH",body:JSON.stringify({action:"complete",message:"E2E site investigation complete",result:{batch:siteInvestigation.body.batch_id}})});
assert.equal(siteComplete.response.status, 200, JSON.stringify(siteComplete.body));
const approvalState=await fetch(`${base}/api/v1/orchestration`).then(response=>response.json());
const approvalJob=approvalState.jobs.find(job=>job.investigation_id===pipeline.investigation_id&&job.job_type==="FIND_RELATED_SITES"&&job.status==="awaiting-approval");
assert.ok(approvalJob,"related-site expansion should wait for approval");
const approved=await fetch(`${base}/api/v1/orchestration/jobs/${approvalJob.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"approve",reason:"E2E approval"})});assert.equal(approved.status,200);
const approvedClaim=await call("site_finder","/api/v1/modules/site_finder/jobs/claim",{method:"POST"});assert.equal(approvedClaim.response.status,200);assert.equal(approvedClaim.body.job.id,approvalJob.id);
await fetch(`${base}/api/v1/orchestration/jobs/${approvalJob.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"cancel",reason:"E2E approval verified"})});

const loggerClaims = await Promise.all([1,2].map(() => call("crypto_wallet_logger", "/api/v1/modules/crypto_wallet_logger/jobs/claim", {method:"POST"})));
assert.equal(loggerClaims.filter((item) => item.response.status === 200).length, 1, "only one logger may claim wallet capture");
const loggerJob = loggerClaims.find((item) => item.body?.job)?.body.job;
assert.equal(loggerJob.job_type, "LOG_WALLET_ACTIVITY");
const loggerResult = await ingest("crypto_wallet_logger", `${run}-logger`, records({
  wallets:[{external_id:`${run}-logger-wallet`,investigation_id:investigation,canonical_key:walletAddress,network:"ethereum",display_name:walletAddress,classification:"exchange_deposit",confidence:.99,provenance:{capture:"browser"}}],
  evidence:[{external_id:`${run}-browser-evidence`,investigation_id:investigation,evidence_type:"browser_capture",evidence_class:"observed_website",observation_scope:"authenticated",context_text:"Authenticated wallet display",title:"Browser wallet capture",confidence:1,provenance:{capture:"browser"}}],
}),loggerJob.id);
assert.equal(loggerResult.body.status, "accepted", JSON.stringify(loggerResult.body));
const directWalletClaim=await call("wallet_investigator","/api/v1/modules/wallet_investigator/jobs/claim",{method:"POST"});
assert.equal(directWalletClaim.response.status,200,"a validated wallet must route directly to Wallet Investigator without waiting for Logger");
assert.equal(directWalletClaim.body.job.job_type,"ANALYZE_WALLET");
assert.equal(directWalletClaim.body.job.trigger_event_id?true:false,true,"event-routed jobs retain their trigger event");
const loggerComplete=await call("crypto_wallet_logger",`/api/v1/modules/crypto_wallet_logger/jobs/${loggerJob.id}`,{method:"PATCH",body:JSON.stringify({action:"complete",result:{batch:loggerResult.body.batch_id}})});
assert.equal(loggerComplete.response.status,200,JSON.stringify(loggerComplete.body));

const duplicateWalletClaim=await call("wallet_investigator", "/api/v1/modules/wallet_investigator/jobs/claim", {method:"POST"});
assert.equal(duplicateWalletClaim.response.status,204,"duplicate wallet events must not create duplicate active analysis");
let walletJob = directWalletClaim.body.job;
assert.equal(walletJob.job_type, "ANALYZE_WALLET");
const failed=await call("wallet_investigator",`/api/v1/modules/wallet_investigator/jobs/${walletJob.id}`,{method:"PATCH",body:JSON.stringify({action:"fail",retry:false,error:"Simulated provider outage"})});
assert.equal(failed.body.job.status,"failed");
const retry=await fetch(`${base}/api/v1/orchestration/jobs/${walletJob.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"retry",reason:"Provider recovered"})});
assert.equal(retry.status,200);
const reclaimed=await call("wallet_investigator","/api/v1/modules/wallet_investigator/jobs/claim",{method:"POST"});
assert.equal(reclaimed.response.status,200,JSON.stringify(reclaimed.body));walletJob=reclaimed.body.job;
const chainEvidence = `${run}-chain-evidence`;
const walletResult = await ingest("wallet_investigator", `${run}-wi`, records({
  transactions:[{external_id:`${run}-tx`,investigation_id:investigation,canonical_key:"0xTX123",network:"ethereum",display_name:"0xTX123",confidence:1,provenance:{provider:"e2e"}}],
  counterparties:[{external_id:`${run}-cp`,investigation_id:investigation,canonical_key:"0xCOUNTERPARTY",network:"ethereum",display_name:"0xCOUNTERPARTY",confidence:.88,provenance:{provider:"e2e"}}],
  evidence:[{external_id:chainEvidence,investigation_id:investigation,evidence_type:"chain_record",evidence_class:"blockchain_fact",observation_scope:"public",context_text:"Transaction provider response",title:"On-chain transaction",confidence:1,provenance:{provider:"e2e"}}],
  relationships:[{external_id:`${run}-tx-cp`,investigation_id:investigation,relationship_type:"transferred_to",assertion_kind:"blockchain_fact",from:{entity_type:"transaction",canonical_key:"0xTX123",network:"ethereum"},to:{entity_type:"counterparty",canonical_key:"0xCOUNTERPARTY",network:"ethereum"},evidence_ids:[chainEvidence],confidence:1,provenance:{provider:"e2e"}}],
}), walletJob.id);
assert.equal(walletResult.body.status, "accepted", JSON.stringify(walletResult.body));
const walletComplete = await call("wallet_investigator", `/api/v1/modules/wallet_investigator/jobs/${walletJob.id}`, {method:"PATCH",body:JSON.stringify({action:"complete",result:{batch:walletResult.body.batch_id}})});
assert.equal(walletComplete.response.status, 200, JSON.stringify(walletComplete.body));

const partial = await ingest("site_finder", `${run}-partial`, records({
  notes:[{external_id:`${run}-note`,investigation_id:investigation,title:"Valid note",body:"This valid record must survive its malformed neighbor.",confidence:.8,provenance:{test:run}}],
  sites:[{display_name:"invalid because external_id is missing"}],
}));
assert.equal(partial.body.status, "partial", JSON.stringify(partial.body));
assert.equal(partial.body.error_count, 1);
assert.ok(partial.body.inserted_count >= 1);

const replay = await ingest("site_finder", `${run}-sf`, records({}));
assert.equal(replay.response.status, 200);
assert.equal(replay.body.replayed, true);

const dashboard = await fetch(`${base}/api/v1/dashboard`).then((response) => response.json());
assert.ok(Number(dashboard.counts.entities) >= 5);
assert.ok(dashboard.modules.every((module) => module.status !== "offline"));
const status = await fetch(`${base}/api/v1/integration/status`).then((response) => response.json());
assert.ok(status.modules.length === 4);
const orchestration=await fetch(`${base}/api/v1/orchestration`).then(response=>response.json());
assert.ok(orchestration.pipelines.some((pipeline)=>pipeline.investigation_external_id===investigation));
assert.ok(orchestration.timeline.some((event)=>event.event_type==="automation.triggered"));
assert.ok(orchestration.reviews.some((review)=>review.review_type==="conflicting_evidence"));
assert.ok(orchestration.events.some((event)=>event.event_type==="wallet.validated"));
assert.ok(orchestration.jobs.some((job)=>job.trigger_event_type==="wallet.validated"));

console.log(JSON.stringify({ok:true,run,site_batch:siteBatch.body,wallet_batch:walletResult.body,partial_batch:partial.body,counts:dashboard.counts}, null, 2));
