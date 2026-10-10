import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const payload={schema_version:'2.0',operation:{external_id:'crash-op',seed:'crash.example',investigation_id:'inv',code:'CRASH',name:'Used crash fixture'},members:[{entity_type:'site',canonical_key:'crash.example',role:'seed',state:'live'}],model:{hypotheses:[{key:'q',question:'Could deployments reuse a public artifact?',hypotheses:[{key:'h',label:'Public artifact reuse',verdict:'viable'}],evidence:[],discriminatingTest:'Find independent public configuration reuse.',caveat:'Unknown operator.'}]},contradictions:[{fingerprint:'network-conflict',kind:'network',summary:'Conflicting public network hints.',status:'open'}],changes:[{domain:'crash.example',facet:'status',value:'live',at:'2026-09-01T00:00:00Z'}]};
if(process.argv[2]==='child') {
 const cfg=JSON.parse(process.env.OPERATION_CRASH_CONFIG);let killed=false;
 const main=await startMain({...cfg,faultHook:(phase,sql)=>{if(!killed&&phase===cfg.phase&&sql.includes(cfg.match)){killed=true;process.kill(process.pid,'SIGKILL');}}});
 console.log(JSON.stringify({url:main.url}));
 await new Promise(()=>{});
} else {
 const work=mkdtempSync(join(tmpdir(),'operation-crash-')),passed=[];
 const cases=[['operation snapshot','hunter_operations','statement','sync'],['hypothesis','operation_hypotheses','batch','sync'],['contradiction','operation_contradictions','batch','sync'],['temporal facet','operation_facets','batch','sync'],['evidence graph','INSERT INTO operation_edges','batch','sync'],['hunt reservation','INSERT OR IGNORE INTO operation_hunts','batch','tick'],['module-work handoff','INSERT OR IGNORE INTO work_items','statement','tick'],['operation split','UPDATE operation_decisions SET status=','batch','split'],['event-driven wakeup','UPDATE operation_state SET dirty=1,updated_at=CURRENT_TIMESTAMP WHERE operation_id IN','statement','event']];
 const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 try {
  for(const [name,match,unit,action] of cases)for(const edge of ['before','after']) {
   const dir=join(work,`${passed.length}`);mkdirSync(dir);const dbFile=join(dir,'used.sqlite');applyMigrations(dbFile);const sql=new DatabaseSync(dbFile);
   sql.exec("INSERT INTO investigations(id,external_id,title) VALUES ('inv','inv','Used investigation');INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES ('site','site','crash.example','crash.example','inv'),('infra','infrastructure_indicator','ip:192.0.2.1','192.0.2.1','inv');INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES ('ie','inv','site','site_investigator','site');INSERT INTO evidence(id,investigation_id,entity_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES ('ev','inv','site','site_investigator','ev','public','Source','3.0','2026-09-01T00:00:00Z');INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at) VALUES ('rel','site','infra','hosting_overlap','site_investigator','rel','3.0','2026-09-01T00:00:00Z');INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES ('re','rel','ev','site_investigator');INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES ('op','crash-op','Used operation','crash.example','inv');INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op','site','crash.example','seed');INSERT INTO operation_state(operation_id) VALUES ('op')");sql.close();
   let splitDecision;
   if(action==='split'){const prepare=await startMain({dbFile,work:dir,label:'prepare-split'});try{await prepare.call('POST','/api/v1/operations/sync',payload,MODULE_KEYS.operation_hunter);splitDecision=(await prepare.call('POST','/api/v1/operations/crash-op/decisions',{action:'propose',kind:'split',entity_ids:['site'],reason:'Reviewed separate deployment boundary.'})).body;assert.ok(splitDecision.review_hash);}finally{await prepare.close();}}
   const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./operation-crash.mjs',import.meta.url)),'child'],{cwd:process.cwd(),env:{...process.env,OPERATION_CRASH_CONFIG:JSON.stringify({dbFile,work:dir,label:'crash',phase:`${edge}_${unit}`,match})},stdio:['ignore','pipe','pipe']});
   let stderr='';child.stderr.on('data',d=>stderr+=d);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
   const url=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;try{resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1)).url);}catch{}});child.once('exit',()=>reject(new Error(`Child startup failed: ${stderr}`)));});
   const path=action==='sync'?'/api/v1/operations/sync':action==='split'?'/api/v1/operations/crash-op/decisions':action==='event'?'/api/v1/events':'/api/v1/operations/crash-op/intelligence';
   const actionBody=action==='sync'?payload:action==='split'?{action:'confirm',decision_id:splitDecision.id,review_hash:splitDecision.review_hash}:action==='event'?{source_module:'site_investigator',events:[{event_id:'crash-evidence-event',event_type:'evidence.added',investigation_id:'inv',payload:{source:'public observation'}}]}:{};
   await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-api-key':action==='event'?MODULE_KEYS.site_investigator:MODULE_KEYS.operation_hunter},body:JSON.stringify(actionBody)}).catch(()=>{});
   const deadline=setTimeout(()=>child.kill('SIGTERM'),15000);const exit=await exited;clearTimeout(deadline);assert.equal(exit.signal,'SIGKILL',`${name} ${edge}: injection must actually kill the process`);
   const clock=new DatabaseSync(dbFile);clock.exec("UPDATE operation_state SET lease_until='2000-01-01',dirty=1;UPDATE event_store SET lease_expires_at='2000-01-01' WHERE status='processing'");clock.close(); // advance expired lease, retain all used state
   const recovered=await startMain({dbFile,work:dir,label:'recovered'});
   try {
    const sync=await recovered.call('POST','/api/v1/operations/sync',payload,MODULE_KEYS.operation_hunter);assert.ok([200,201].includes(sync.status),JSON.stringify(sync.body));
    if(action==='split'){const r=await recovered.call('POST',path,actionBody);assert.equal(r.status,200,JSON.stringify(r.body));await recovered.call('POST',path,actionBody);assert.equal(recovered.n("SELECT COUNT(*) n FROM hunter_operations WHERE id LIKE 'split:%'"),1);recovered.sql.exec("UPDATE operation_state SET max_hunts=0 WHERE operation_id LIKE 'split:%'");}
    if(action==='event'){await recovered.call('GET','/api/v1/events');assert.equal(recovered.n("SELECT COUNT(*) n FROM event_store WHERE event_id='crash-evidence-event' AND status='processed'"),1);}
    await recovered.call('POST','/api/v1/operations/crash-op/intelligence',{});
    const b=ok(await recovered.call('GET','/api/v1/operations/crash-op/intelligence'));
    assert.equal(b.hypotheses.length,1);assert.equal(b.contradictions.length,1);assert.equal(b.edges.length,action==='split'?0:1);
    assert.equal(recovered.n('SELECT COUNT(*) n FROM operation_hunts'),1);assert.equal(recovered.n("SELECT COUNT(*) n FROM work_items WHERE fingerprint LIKE 'operation:%'"),1);
    assert.equal(recovered.n("SELECT COUNT(*) n FROM operation_history WHERE kind='hypothesis'"),1);
    assert.equal(recovered.n('SELECT COUNT(*) n FROM evidence'),1);assert.equal(recovered.n("SELECT COUNT(*) n FROM investigations WHERE id='inv'"),1);
    passed.push({phase:name,edge,actual_process_signal:exit.signal,logical_hunts:1,preserved_evidence:1});console.log(`PASS crash ${edge} ${name}`);
   }finally{await recovered.close();}
  }
  const result={ok:true,crashes:passed.length,passed,scope:'Actual child-process SIGKILL around SQL statements and atomic D1-double batches, restarting used SQLite state. External provider and Finder/Hunter outbox crash phases are covered by existing module tests, not all certified here.'};mkdirSync('verification/operation-v6',{recursive:true});writeFileSync('verification/operation-v6/crash.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){console.error(e);process.exitCode=1;}finally{rmSync(work,{recursive:true,force:true});}
}
