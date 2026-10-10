import {importFrom,localPath,runPythonJson} from './lib/portable.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
const failurePath=process.env.V61_FAILURE_PATH==='1';
const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');const migrations=new URL('../drizzle/',import.meta.url);for(const name of (await readdir(migrations)).filter(n=>/^[0-9]{4}_.*\.sql$/.test(n)).sort())sql.exec(await readFile(new URL(name,migrations),'utf8'));
const db={prepare(statement){let params=[];return{bind(...v){params=v;return this;},async run(){return{meta:{changes:Number(sql.prepare(statement).run(...params).changes)}};},async first(){return sql.prepare(statement).get(...params)??null;},async all(){return{results:sql.prepare(statement).all(...params)}}};},async batch(queries){sql.exec('BEGIN');try{const result=[];for(const q of queries)result.push(await q.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};globalThis.__TEST_ENV={DB:db,MODULE_API_KEYS:JSON.stringify({site_finder:'finder-local-key',site_investigator:'investigator-local-key',crypto_wallet_logger:'logger-local-key',wallet_investigator:'wallet-local-key',form_submitter:'form-local-key'})};
const work=await mkdtemp(join(tmpdir(),'mip-three-modules-'));try{await build({entryPoints:['app/api/v1/modules/[module]/register/route.ts','app/api/v1/ingest/[module]/route.ts','app/api/v1/modules/[module]/jobs/claim/route.ts','app/api/v1/modules/[module]/jobs/[id]/route.ts','app/api/v1/compat/logger/route.ts','app/api/v1/modules/[module]/heartbeat/route.ts','app/api/v1/modules/[module]/destination/route.ts','app/api/v1/events/route.ts','app/api/v1/investigations/[id]/context/route.ts','app/api/v1/investigations/[id]/report/route.ts'],bundle:true,splitting:true,format:'esm',platform:'node',outdir:work,plugins:[{name:'test-env',setup(p){p.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'test'}));p.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const env=globalThis.__TEST_ENV',loader:'js'}));}}]});
const destinationRoute=await importFrom(work,'modules/[module]/destination/route.js');const register=await importFrom(work,'modules/[module]/register/route.js');const ingest=await importFrom(work,'ingest/[module]/route.js');const claim=await importFrom(work,'modules/[module]/jobs/claim/route.js');const update=await importFrom(work,'modules/[module]/jobs/[id]/route.js');const logger=await importFrom(work,'compat/logger/route.js');const heartbeat=await importFrom(work,'modules/[module]/heartbeat/route.js');const events=await importFrom(work,'events/route.js');const contextRoute=await importFrom(work,'investigations/[id]/context/route.js');const reportRoute=await importFrom(work,'investigations/[id]/report/route.js');
const request=(path,data,key,method='POST')=>new Request('http://127.0.0.1'+path,{method,headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify(data)});const one=(q,...args)=>sql.prepare(q).get(...args);
for(const [module,key,capabilities] of [['site_finder','finder-local-key',['site:relate']],['site_investigator','investigator-local-key',['site:investigate']],['crypto_wallet_logger','logger-local-key',['wallet:log']]]){const res=await register.POST(request(`/api/v1/modules/${module}/register`,{module_version:'synthetic-integration',schema_version:'3.0',capabilities,supported_event_types:[]},key),{params:Promise.resolve({module})});assert.equal(res.status,200,await res.clone().text());}
const py=(file)=>runPythonJson(localPath(file,import.meta.url),{env:{MIP_BATCH_JSON:'1'}});const finder=py('./finder-batch-synthetic.py');const pendingWire={schema_version:'3.0',batch_id:finder.unpromoted_observation.batch_id,sent_at:new Date().toISOString(),records:finder.unpromoted_observation.records};let res=await ingest.POST(request('/api/v1/ingest/site_finder',pendingWire,'finder-local-key'),{params:Promise.resolve({module:'site_finder'})});assert.equal(res.status,202,await res.clone().text());assert.equal(one("SELECT COUNT(*) n FROM observations WHERE source_module='site_finder' AND record_type='site'").n,1);assert.equal(one('SELECT COUNT(*) n FROM investigations').n,0,'observation alone must not start an investigation');assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='INVESTIGATE_SITE'").n,0);const finderWire={schema_version:'3.0',batch_id:finder.batch_id,sent_at:new Date().toISOString(),records:finder.records};res=await ingest.POST(request('/api/v1/ingest/site_finder',finderWire,'finder-local-key'),{params:Promise.resolve({module:'site_finder'})});assert.equal(res.status,202,await res.clone().text());assert.equal((await res.json()).status,'accepted');const inv=one('SELECT id,external_id FROM investigations LIMIT 1');const site=one("SELECT id FROM entities WHERE entity_type='site' AND canonical_key='synthetic.example'");assert.ok(site);assert.equal(one("SELECT COUNT(*) n FROM observation_versions WHERE entity_id=? AND source_module='site_finder'",site.id).n,2,'both discovery and promoted observations remain');assert.equal(one("SELECT COUNT(*) n FROM site_triage WHERE investigation_id=? AND outcome='promoted'",inv.id).n,1);assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'",inv.id).n,1);
res=await claim.POST(request('/api/v1/modules/site_investigator/jobs/claim',{},'investigator-local-key'),{params:Promise.resolve({module:'site_investigator'})});assert.equal(res.status,200);const job=(await res.json()).job;assert.equal(job.target_entity_id,site.id);
const siteExport=py('./site-bridge-synthetic.py').batch;siteExport.origin_job_id=job.id;siteExport.batch_id=`si:${job.id}:synthetic`;siteExport.sent_at=new Date().toISOString();for(const rows of Object.values(siteExport.records))for(const row of rows)row.investigation_id=inv.external_id;
res=await ingest.POST(request('/api/v1/ingest/site_investigator',siteExport,'investigator-local-key'),{params:Promise.resolve({module:'site_investigator'})});assert.equal(res.status,202,await res.clone().text());const siteResult=await res.json();assert.equal(siteResult.error_count,0,JSON.stringify(siteResult.errors));assert.equal(one("SELECT COUNT(*) n FROM relationships WHERE investigation_id=? AND relationship_type='displays_wallet'",inv.id).n,1);assert.equal(one("SELECT COUNT(*) n FROM relationship_evidence").n,1);
res=await update.PATCH(request(`/api/v1/modules/site_investigator/jobs/${job.id}`,{action:'complete',result:{batch_id:siteExport.batch_id}},'investigator-local-key','PATCH'),{params:Promise.resolve({module:'site_investigator',id:job.id})});assert.equal(res.status,200,await res.clone().text());
const actualLoggerSource=readFileSync(new URL('../integrations/crypto-wallet-logger-v08/main-platform-sync.js',import.meta.url),'utf8');const scope={};scope.globalThis=scope;vm.runInNewContext(actualLoggerSource,scope);const address='0x71c841094df8cf7fa128565551f337f74c7dbb94';const payload=scope.MainPlatformSync.walletEvent({id:'synthetic-wallet-1',address,network:'ethereum',confidence:'high',context:'Synthetic public deposit label',evidenceItems:[],evidenceTags:[],detectionMethods:['text'],foundAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()},{domain:'synthetic.example',topPageUrl:'https://synthetic.example/deposit',sourcePageUrl:'https://synthetic.example/deposit',pageTitle:'Synthetic deposit'},new Date().toISOString());const wire={id:'synthetic-logger-wallet',type:'wallet.observed',schemaVersion:'1.0.0',occurredAt:new Date().toISOString(),source:'CryptoWalletLogger',sourceVersion:'0.8.0',payload};res=await logger.POST(request('/api/v1/compat/logger',wire,'logger-local-key'));assert.equal(res.status,202,await res.clone().text());assert.equal((await res.json()).error_count,0);res=await logger.POST(request('/api/v1/compat/logger',wire,'logger-local-key'));assert.equal(res.status,200);assert.equal((await res.json()).replayed,true);
const canonical=`ethereum:${address.toLowerCase()}`;assert.equal(one("SELECT COUNT(*) n FROM entities WHERE entity_type='wallet' AND canonical_key=?",canonical).n,1,'two real module wire shapes resolve to same wallet');assert.ok(one("SELECT COUNT(*) n FROM observation_versions WHERE entity_id=(SELECT id FROM entities WHERE entity_type='wallet' AND canonical_key=?)",canonical).n>=1,'wallet observations are retained');
assert.equal(one("SELECT COUNT(*) n FROM event_store WHERE event_type='wallet.validated' AND source_module='site_investigator'").n,1,'Site Investigator evidence triggers canonical validation');assert.equal(one("SELECT COUNT(*) n FROM planner_decisions WHERE action='ANALYZE_WALLET' AND outcome='deferred'").n,1,'offline wallet worker is explicitly deferred');
const evidenceWire={...wire,id:'synthetic-logger-evidence',type:'evidence.added',payload:{...payload,recordType:'wallet'}};res=await logger.POST(request('/api/v1/compat/logger',evidenceWire,'logger-local-key'));assert.equal(res.status,202,await res.clone().text());assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE source_module='crypto_wallet_logger' AND investigation_id=?",inv.id).n,1);assert.equal(one("SELECT COUNT(*) n FROM event_store WHERE source_module='crypto_wallet_logger' AND event_type='site.investigated'").n,0,'passive browser observation must not claim site investigation');
assert.equal(one("SELECT COUNT(*) n FROM event_store WHERE source_module='crypto_wallet_logger' AND event_type='wallet.validated'").n,1,'later browser evidence triggers validation without routing site work');
// Run the supplied wallet and form worker sources against the same Main
// Platform routes and SQLite state used above. Only provider/form transport is
// synthetic; module claiming, ingestion, planning and reporting use real code.
let submissions=0;let eventFailures=failurePath?1:0;const originalCwd=process.cwd();let platformServer;
try{
  platformServer=createServer(async(incoming,outgoing)=>{
    try{
      let raw='';for await(const chunk of incoming)raw+=chunk;
      const url=new URL(incoming.url,'http://127.0.0.1');
      if(url.pathname==='/synthetic-form'){
        assert.match(raw,/entry\.1=/);submissions++;
        outgoing.writeHead(200,{'content-type':'text/html'});
        outgoing.end(failurePath?'Submission received; confirmation pending':'Your response has been recorded');return;
      }
      const parts=url.pathname.split('/').filter(Boolean),moduleName=parts[3];
      const httpRequest=new Request(url,{method:incoming.method,headers:incoming.headers,body:raw||undefined});
      const ctx={params:Promise.resolve({module:moduleName,id:parts.at(-1)})};
      let response;
      if(parts[0]==='api'&&parts[2]==='modules'&&parts[4]==='register')response=await register.POST(httpRequest,ctx);
      else if(parts[0]==='api'&&parts[2]==='modules'&&parts[4]==='destination')response=await destinationRoute.POST(httpRequest,ctx);
      else if(parts[0]==='api'&&parts[2]==='modules'&&parts[4]==='heartbeat')response=await heartbeat.POST(httpRequest,ctx);
      else if(parts[0]==='api'&&parts[2]==='modules'&&parts[4]==='jobs'&&parts[5]==='claim')response=await claim.POST(httpRequest,ctx);
      else if(parts[0]==='api'&&parts[2]==='modules'&&parts[4]==='jobs'&&parts[5])response=await update.PATCH(httpRequest,{params:Promise.resolve({module:moduleName,id:parts[5]})});
      else if(parts[0]==='api'&&parts[2]==='ingest')response=await ingest.POST(httpRequest,{params:Promise.resolve({module:moduleName})});
      else if(url.pathname==='/api/v1/events'){
        if(eventFailures>0){eventFailures--;outgoing.writeHead(503);outgoing.end('synthetic outbox outage');return;}
        response=await events.POST(httpRequest);
      }
      else if(parts[0]==='api'&&parts[2]==='investigations'&&parts[4]==='context')response=await contextRoute.GET(httpRequest,{params:Promise.resolve({id:parts[3]})});
      else if(parts[0]==='api'&&parts[2]==='investigations'&&parts[4]==='report')response=await reportRoute[incoming.method](httpRequest,{params:Promise.resolve({id:parts[3]})});
      else throw Error(`Unmapped platform route ${incoming.method} ${url.pathname}`);
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){outgoing.writeHead(500);outgoing.end(String(error));}
  });
  await new Promise(done=>platformServer.listen(0,'127.0.0.1',done));
  const platformPort=platformServer.address().port;
  const base=`http://127.0.0.1:${platformPort}`;
  process.env.MAIN_PLATFORM_URL=base;
  process.env.WALLET_INVESTIGATOR_MODULE_KEY='wallet-local-key';
  process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES='1';
  await mkdir(join(work,'wallet-runtime'));
  process.chdir(join(work,'wallet-runtime'));
  const walletWorker=await import(new URL('../integrations/wallet-investigator/server/integration/platform_worker.ts',import.meta.url));
  const walletDb=await import(new URL('../integrations/wallet-investigator/server/db/database.ts',import.meta.url));
  await walletWorker.startPlatformWorker();
  const waitFor=async(predicate,label,timeout=16000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(predicate())return;await new Promise(done=>setTimeout(done,150));}throw Error(`Timed out waiting for ${label}`);};
  await waitFor(()=>one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET'",inv.id).n===1,'wallet planning');
  try {
    await waitFor(()=>one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module='wallet_investigator'",inv.id).n>0,'real wallet worker evidence',30000);
  } catch (error) {
    console.error(JSON.stringify({investigation:inv,jobs:sql.prepare("SELECT id,investigation_id,status,last_error FROM jobs WHERE job_type='ANALYZE_WALLET'").all(),events:sql.prepare("SELECT event_type,source_module FROM event_store ORDER BY rowid DESC LIMIT 8").all(),evidence:sql.prepare("SELECT investigation_id,source_module,COUNT(*) n FROM evidence GROUP BY investigation_id,source_module").all(),ingest:sql.prepare("SELECT source_module,status,error_count,errors FROM ingestion_batches ORDER BY received_at DESC LIMIT 5").all()}));
    throw error;
  }
  await waitFor(()=>['completed','needs-review'].includes(one("SELECT status FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET'",inv.id)?.status),'wallet job terminal state');
  const walletJob=one("SELECT id,status FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET'",inv.id);
  assert.ok(['completed','needs-review'].includes(walletJob.status));
  assert.ok(one("SELECT COUNT(*) n FROM observations WHERE record_type='transaction' AND source_module='wallet_investigator'").n>0);
  assert.equal(one("SELECT COUNT(DISTINCT source_module) n FROM observation_versions WHERE entity_id=(SELECT id FROM entities WHERE canonical_key=?)",canonical).n>=2,true);
  await waitFor(()=>walletDb.queryAll("SELECT id FROM main_platform_queue WHERE status='QUEUED'").length===0,'wallet outbox replay',12000);
  await waitFor(()=>one("SELECT COUNT(*) n FROM event_store WHERE investigation_id=? AND event_type='wallet.analyzed'",inv.id).n>0,'wallet analyzed event');
  if(failurePath){
    await new Promise(done=>platformServer.close(done));
    await new Promise(done=>platformServer.listen(platformPort,'127.0.0.1',done));
    assert.ok(one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=?",inv.id).n>2,'platform restart preserves evidence');
  }

  process.env.FORM_SUBMITTER_MODULE_KEY='form-local-key';
  await mkdir(join(work,'form-runtime'));process.chdir(join(work,'form-runtime'));
  const {startPlatformReportWorker,durableStorage}=await import(new URL('../integrations/form-submitter/server/integration/platform_worker.ts',import.meta.url));
  const now=new Date().toISOString(),formUrl='https://docs.google.com/forms/d/e/TestLocal/viewform';
  durableStorage.syncFullState({settings:{username:'synthetic-analyst',teamInviteCode:'synthetic-code',autoSubmitGlobalEnabled:true},formConfig:{formUrl,formId:'TestLocal',formTitle:'Synthetic',formVersionHash:'synthetic-hash',verifiedAt:now,parsedSchema:{formId:'TestLocal',formTitle:'Synthetic',formUrl,versionHash:'synthetic-hash',sections:[],allQuestions:[{id:'1',entryKey:'entry.1',title:'Site URL',type:'TEXT',required:true,pageIndex:1}],parsedAt:now},fieldMappings:[{id:'site',fieldKey:'siteUrl',label:'Site URL',entryKey:'entry.1',pageIndex:1,required:true}],multiWalletFormat:'COMBINED_LIST'}});
  const realFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).startsWith('https://docs.google.com/forms/d/e/TestLocal/')?realFetch(`${base}/synthetic-form`,options):realFetch(url,options);
  await startPlatformReportWorker();
  const report=await reportRoute.POST(new Request(`${base}/api/v1/investigations/${inv.id}/report`,{method:'POST'}),{params:Promise.resolve({id:inv.id})});
  assert.equal(report.status,201,await report.clone().text());
  const candidate=await report.json();
  const approval=await reportRoute.PATCH(new Request(`${base}/api/v1/investigations/${inv.id}/report`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({candidate_id:candidate.candidate_id,action:'approve',reason:'Synthetic evidence and scope reviewed'})}),{params:Promise.resolve({id:inv.id})});
  assert.equal(approval.status,200,await approval.clone().text());
  const reportEvent=one("SELECT e.id FROM event_store e WHERE event_type='report.ready' AND investigation_id=? ORDER BY rowid DESC LIMIT 1",inv.id);
  assert.ok(reportEvent);
  await waitFor(()=>one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='PREPARE_REPORT'",inv.id).n===1,'approved reporting job');
  if(failurePath)await waitFor(()=>submissions===1&&durableStorage.getState().findings.find(f=>f.id===candidate.candidate_id)?.submissionState==='UNKNOWN','verification-unknown report',18000);
  else await waitFor(()=>one("SELECT verification_status FROM report_candidates WHERE id=?",candidate.candidate_id)?.verification_status==='verified','verified report',18000);
  assert.equal(submissions,1,'receiver must see one submission');
  assert.equal(durableStorage.getState().findings.find(f=>f.id===candidate.candidate_id)?.submissionState,failurePath?'UNKNOWN':'COMPLETED');
  assert.equal(one("SELECT COUNT(*) n FROM evidence WHERE source_module='form_submitter' AND investigation_id=?",inv.id).n,failurePath?0:1);
  if(failurePath){
    await new Promise(done=>setTimeout(done,3500));
    assert.equal(submissions,1,'unknown confirmation must never trigger a blind resubmission');
    assert.equal(one("SELECT status FROM jobs WHERE investigation_id=? AND job_type='PREPARE_REPORT'",inv.id).status,'needs-review');
  }else assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND status='completed'",inv.id).n>=2,true);
  globalThis.fetch=realFetch;
  console.log(JSON.stringify({ok:true,path:failurePath?'failure-recovery':'golden',modules:['site_finder','site_investigator','crypto_wallet_logger','wallet_investigator','form_submitter'],synthetic_provider:true,synthetic_form:true,platform_restart:failurePath,verification:failurePath?'unknown':'verified',investigation_id:inv.id,wallet_job:walletJob.id,report_id:candidate.candidate_id,submissions}));
}finally{process.chdir(originalCwd);if(platformServer)await new Promise(done=>platformServer.close(done));}
setTimeout(()=>process.exit(0),50);
}finally{await rm(work,{recursive:true,force:true});sql.close();}
