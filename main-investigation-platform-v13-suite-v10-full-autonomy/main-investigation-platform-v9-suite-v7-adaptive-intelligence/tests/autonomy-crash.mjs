/** Actual SIGKILL around v9 workflow commits, restart and replay on used source state. */
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';import {localPath} from './lib/portable.mjs';import {evm} from './lib/test-addresses.mjs';
const libraries=['lib/autonomy.ts','lib/wallet-pipeline.ts','lib/director/director.ts','lib/ops/hunter.ts','lib/ops/intelligence.ts','lib/scientific/queue.ts','lib/scientific/engine.ts','lib/jobs.ts'];
const address=evm(310),at='2026-10-03T10:00:00Z';
const observation={observationId:'v9-crash-observation',address,family:'evm',candidateNetworks:['ethereum'],networkHint:{network:'ethereum',source:'label'},context:{class:'deposit',confidence:.95,cues:['deposit'],negativeCues:[],section:'Deposit Ethereum',snippet:address},detection:{method:'text',methods:['text']},page:{domain:'crash-v9.example',url:'https://crash-v9.example/deposit'},firstSeen:at,lastSeen:at,seenCount:1};
const cases=[
 ['site investigation','INSERT OR IGNORE INTO investigations','batch','start'],
 ['wallet observation ingestion','INSERT INTO wallet_observations','statement','observe'],
 ['candidate deduplication','INSERT INTO wallet_candidates','statement','dedup'],
 ['validation scheduling','INSERT INTO jobs','batch','validate'],
 ['Wallet Investigator completion','UPDATE wallet_candidates SET validation_status=','statement','wallet'],
 ['provider retry','INSERT INTO director_retries','statement','provider'],
 ['operation update','INSERT INTO operation_entities','batch','operation'],
 ['report rebuild','INSERT OR IGNORE INTO report_contents','batch','report'],
 ['exact approval','UPDATE approval_gates SET status=','batch','approval'],
 ['submission handoff','INSERT INTO jobs','batch','submission'],
 ['lost confirmation','UPDATE jobs SET status=\'needs-review\'','statement','uncertain'],
 ['Finder hunt handoff','INSERT INTO jobs','batch','finder'],
 ['Hunter update','UPDATE hunter_operations SET','statement','hunter'],
 ['queue reconciliation',"UPDATE work_items SET status='done'",'batch','queue'],
 ['scientific revision','INSERT INTO scientific_hypotheses','batch','science'],
];
const ok=r=>{assert.ok([200,201,202,409].includes(r.status),JSON.stringify(r.body));return r.body;};
async function action(m,c){const a=m.library['lib/autonomy.ts'],w=m.library['lib/wallet-pipeline.ts'],jobs=m.library['lib/jobs.ts'];
 switch(c.kind){
 case 'start':return a.investigateSite('new-crash-v9.example');
 case 'observe':return w.recordObservation(c.inv,observation,c.evidence,'crash-source','crash-hash');
 case 'dedup':return w.recordObservation(c.inv,{...observation,observationId:'v9-crash-second-observation'},c.evidence,'crash-source-2','crash-hash-2');
 case 'validate':return w.advanceCandidate(c.candidate);
 case 'wallet':return w.onWalletInvestigatorBatch({origin_job_id:c.job,records:{wallets:[{external_id:'delivered',data:{wallet_candidate_id:c.candidate,validation:{status:'valid',network:'ethereum'},analysis:{status:'completed'}}}]}});
 case 'provider':return m.library['lib/director/director.ts'].observeAnalysis(c.candidate,c.job,{status:'failed',completeness:'FAILED',reason:'Provider unavailable'});
 case 'operation':return m.library['lib/ops/intelligence.ts'].projectOperation(c.op);
 case 'report':return w.rebuildWalletReport(c.inv);
 case 'approval':{if(m.one('SELECT status FROM report_candidates WHERE id=?',c.report.id)?.status==='ready')return {already_approved:true};const r=await m.call('PATCH',`/api/v1/investigations/${c.inv}/report`,{candidate_id:c.report.id,action:'approve',content_sha256:c.report.evidence_sha256,reason:'Review exact frozen report'});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
 case 'submission':return a.recoverApprovedReports();
 case 'uncertain':{const j=m.one('SELECT status FROM jobs WHERE id=?',c.formjob);if(j.status!=='running')return a.projectAutonomy(c.inv);return jobs.updateJob('form_submitter',c.formjob,'needs-review',{message:'Destination acknowledgement lost; verify manually',result:{outcome:'unknown'}});}
 case 'finder':return jobs.enqueueJob({job_type:'FIND_RELATED_SITES',investigation_id:c.inv,target_module:'site_finder',created_by_module:'platform',target_entity_id:c.site,budget_dimension:'related_site',dedupe_scope:'v9-crash-finder',payload:{seeds:['crash-v9.example'],requested:2}});
 case 'hunter':return m.library['lib/ops/hunter.ts'].syncFromHunter(c.snapshot);
 case 'queue':return m.library['lib/scientific/queue.ts'].reconcileStaleSiteWork();
 case 'science':return m.library['lib/scientific/engine.ts'].projectScientific(c.op);
 }
}
if(process.argv[2]==='child'){
 const c=JSON.parse(process.env.V9_CRASH_CONFIG);let m,killed=false;
 m=await startMain({dbFile:c.file,work:c.dir,libraryFiles:libraries,faultHook:(phase,sql)=>{if(!killed&&phase===c.phase&&sql.includes(c.match)){killed=true;process.kill(process.pid,'SIGKILL');}},extra:async(req,res,url)=>{if(url.pathname!=='/v9-test-phase')return false;try{await action(m,c);res.writeHead(200);res.end('done');}catch(e){res.writeHead(500);res.end(String(e));}return true;}});console.log(JSON.stringify({url:m.url}));await new Promise(()=>{});
}else{
 const work=mkdtempSync(join(tmpdir(),'v9-kill-')),results=[];let preparation;
 async function prepare(kind,dir,file){applyMigrations(file);const m=await startMain({dbFile:file,work:dir,libraryFiles:libraries});preparation=m;ok(await m.call('POST','/api/v1/modules/form_submitter/register',{module_version:'1.0.0',schema_version:'3.0',capabilities:['report-preparation'],supported_event_types:[]},MODULE_KEYS.form_submitter));const inv=ok(await m.call('POST','/api/v1/autonomy',{site:'crash-v9.example'})).investigation_id,site=m.one("SELECT id FROM entities WHERE canonical_key='crash-v9.example'").id,evidence=crypto.randomUUID();
  m.sql.prepare("INSERT INTO evidence(id,entity_id,investigation_id,source_module,source_record_id,evidence_type,title,context_text,provenance,schema_version,captured_at) VALUES (?,?,?,'crypto_wallet_logger','crash-source','wallet_observation','Original deposit evidence',?,'{\"passive\":true}','3.0',?)").run(evidence,site,inv,address,at);
  await m.library['lib/wallet-pipeline.ts'].recordObservation(inv,observation,evidence,'crash-source','crash-hash');const candidate=m.one('SELECT id FROM wallet_candidates').id,job=m.one('SELECT analysis_job_id FROM wallet_candidates').analysis_job_id;
  const walletEntity=crypto.randomUUID();m.sql.prepare("INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES (?,'wallet',?,?,?)").run(walletEntity,address,address,inv);m.sql.prepare("INSERT INTO evidence(id,entity_id,investigation_id,source_module,source_record_id,evidence_type,title,context_text,provenance,schema_version,captured_at) VALUES (?,?,?,'wallet_investigator','crash-validation','address_validation','Delivered authoritative validation',?,'{\"delivered_fixture\":true}','3.0',?)").run(crypto.randomUUID(),walletEntity,inv,address,at);
  m.sql.prepare("UPDATE wallet_candidates SET validation_status='valid',validated_network='ethereum',analysis_status='completed',entity_id=? WHERE id=?").run(walletEntity,candidate);m.sql.exec("UPDATE jobs SET status='completed',dedupe_key=dedupe_key||':done:'||id,completed_at=CURRENT_TIMESTAMP");
  await m.library['lib/wallet-pipeline.ts'].setModuleDestination('form_submitter',{kind:'google_form',form_id:'CrashFixture',form_url:'https://docs.google.com/forms/d/e/CrashFixture/viewform',version_hash:'fixture',title:'Fixture destination'});await m.library['lib/wallet-pipeline.ts'].rebuildWalletReport(inv);const report=m.one("SELECT r.* FROM report_candidates r JOIN report_contents c ON c.candidate_id=r.id WHERE r.status='needs_review' AND c.superseded_by IS NULL ORDER BY r.created_at DESC LIMIT 1");assert.ok(report);
  const snapshot={schema_version:'2.0',operation:{external_id:'v9-crash-op',name:'Crash operation',seed:'crash-v9.example',investigation_id:inv},members:[{entity_type:'site',canonical_key:'crash-v9.example',role:'seed',state:'live'}],model:{hypotheses:[{key:'wallet',question:'What explains the wallet?',hypotheses:[{key:'single',label:'Unchanged single wallet on every site',verdict:'viable'}],evidence:[]}]}};
  await m.library['lib/ops/hunter.ts'].syncFromHunter(snapshot);const op=m.one('SELECT id FROM hunter_operations').id;let formjob;
  if(kind==='observe'){m.sql.exec('DELETE FROM wallet_observations');m.sql.prepare("UPDATE wallet_candidates SET observations=0 WHERE id=?").run(candidate);}
  if(kind==='validate')m.sql.prepare("UPDATE wallet_candidates SET validation_status='pending',analysis_status='none' WHERE id=?").run(candidate);
  if(kind==='wallet')m.sql.prepare("UPDATE wallet_candidates SET validation_status='queued',analysis_status='queued' WHERE id=?").run(candidate);
  if(kind==='report')m.sql.exec('DELETE FROM report_contents;DELETE FROM report_candidates;DELETE FROM approval_gates;DELETE FROM autonomy_report_claims');
  if(kind==='submission'){m.sql.prepare("UPDATE approval_gates SET status='approved' WHERE id=?").run(report.approval_id);}
  if(kind==='uncertain'){ok(await m.call('PATCH',`/api/v1/investigations/${inv}/report`,{candidate_id:report.id,action:'approve',content_sha256:report.evidence_sha256,reason:'Review exact report'}));formjob=m.one("SELECT submission_job_id FROM report_candidates WHERE id=?",report.id).submission_job_id;assert.ok(formjob);m.sql.prepare("UPDATE jobs SET status='running',claimed_by_module='form_submitter',lease_expires_at=? WHERE id=?").run(new Date(Date.now()+300000).toISOString(),formjob);}
  if(kind==='queue'){const proof=crypto.randomUUID();m.sql.prepare("INSERT INTO jobs(id,job_type,investigation_id,target_entity_id,target_module,created_by_module,dedupe_key,payload,status,completed_at) VALUES (?,'INVESTIGATE_SITE',?,?,'site_investigator','platform',?,'{}','completed',CURRENT_TIMESTAMP)").run(proof,inv,site,proof);m.sql.prepare("INSERT INTO work_items(id,kind,target_type,target_key,investigation_id,fingerprint,status,reason,source) VALUES ('crash-work','investigate_candidate','site','crash-v9.example',?,'crash-work','queued','Inspect public evidence','discovery')").run(inv);}
  await m.close();preparation=null;return {kind,dir,file,inv,site,evidence,candidate,job,report,op,snapshot,formjob};
 }
 try{for(const [name,match,unit,kind] of cases.filter(c=>!process.env.V9_CRASH_PHASE||c[3]===process.env.V9_CRASH_PHASE))for(const edge of ['before','after']){
  const dir=join(work,String(results.length));mkdirSync(dir);const file=join(dir,'main.sqlite'),c=await prepare(kind,dir,file);Object.assign(c,{match,phase:edge+'_'+unit});const child=spawn(process.execPath,['--import','tsx',localPath('./autonomy-crash.mjs',import.meta.url),'child'],{env:{...process.env,V9_CRASH_CONFIG:JSON.stringify(c)},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  const url=await new Promise((r,j)=>{let out='';child.stdout.on('data',d=>{out+=d;try{r(JSON.parse(out.trim().split(/\r?\n/).at(-1)).url);}catch{}});child.once('exit',()=>j(new Error(err)));});const timer=setTimeout(()=>child.kill('SIGTERM'),15000);const response=await fetch(url+'/v9-test-phase').then(r=>r.text()).catch(()=>null);const exit=await exited;clearTimeout(timer);assert.equal(exit.signal,'SIGKILL',name+' '+edge+' injection must be reached '+err+' '+response);
  const m=await startMain({dbFile:file,work:dir,libraryFiles:libraries,label:'recovered'});try{await action(m,c);await m.library['lib/autonomy.ts'].recoverApprovedReports();await m.library['lib/autonomy.ts'].projectAutonomy(c.inv);
   assert.equal(m.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=?',c.inv),1);assert.equal(m.one('SELECT context_text FROM evidence WHERE id=?',c.evidence).context_text,address);assert.equal(m.n('SELECT COUNT(*) n FROM (SELECT investigation_id,evidence_sha256 FROM report_candidates GROUP BY 1,2 HAVING COUNT(*)>1)'),0);assert.equal(m.n("SELECT COUNT(*) n FROM (SELECT dedupe_key FROM jobs WHERE status IN ('pending','running','retrying') GROUP BY 1 HAVING COUNT(*)>1)"),0);
   if(kind==='uncertain'){assert.equal(m.one('SELECT status FROM jobs WHERE id=?',c.formjob).status,'needs-review');assert.equal(m.n("SELECT COUNT(*) n FROM jobs WHERE job_type='PREPARE_REPORT'"),1);}
   if(kind==='queue')assert.equal(m.one("SELECT status FROM work_items WHERE id='crash-work'").status,'done');
   results.push({phase:name,edge,signal:exit.signal,source_preserved:true,duplicate_candidates:0,duplicate_reports:0,duplicate_active_jobs:0});console.log('PASS',edge,name);
  }finally{await m.close();}
 }
 mkdirSync('verification/autonomy-v9',{recursive:true});writeFileSync('verification/autonomy-v9/crash.json',JSON.stringify({ok:true,crashes:results.length,results,scope:'Real child-process SIGKILL before/after local SQLite statements or transactions. Production workflow functions and exact approval route are used. Specialist delivery fixtures are preloaded; remote provider, remote D1 and an in-flight external submission process are not certified by this matrix.'},null,2));
 }catch(e){console.error(e);process.exitCode=1;}finally{await preparation?.close();rmSync(work,{recursive:true,force:true});}
}
