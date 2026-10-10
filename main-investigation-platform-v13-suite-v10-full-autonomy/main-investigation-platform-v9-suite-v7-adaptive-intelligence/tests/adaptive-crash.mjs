/** v7 SIGKILL matrix: real child-process kills before/after the SQL of every new v7 state transition, then a
 * restart on the used database and a replay. Asserts exactly-once logical behaviour. */
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const payload={schema_version:'2.0',operation:{external_id:'crash-op',seed:'crash.example',investigation_id:'inv',code:'CRASH',name:'Used crash fixture'},members:[{entity_type:'site',canonical_key:'crash.example',role:'seed',state:'live'}],
 model:{hypotheses:[{key:'who',question:'Are the member sites run by one operator?',hypotheses:[{key:'one',label:'One operator',verdict:'favoured'},{key:'kit',label:'Customers of the same kit',verdict:'viable'}],evidence:[],discriminatingTest:'Find independent wallet reuse.',caveat:'Unknown operator.'}]},contradictions:[],changes:[{domain:'crash.example',facet:'status',value:'live',at:'2026-09-01T00:00:00Z'}]};
if(process.argv[2]==='child') {
 const cfg=JSON.parse(process.env.ADAPTIVE_CRASH_CONFIG);let killed=false;
 const main=await startMain({...cfg,faultHook:(phase,sql)=>{if(!killed&&phase===cfg.phase&&sql.includes(cfg.match)){killed=true;process.kill(process.pid,'SIGKILL');}}});
 console.log(JSON.stringify({url:main.url}));
 await new Promise(()=>{});
} else {
 const work=mkdtempSync(join(tmpdir(),'adaptive-crash-')),passed=[];
 // [name, SQL substring, unit, preparation]
 const cases=[
  ['gap creation','INSERT INTO adaptive_gaps','batch','fresh'],
  ['test planning (candidate components)','INSERT OR IGNORE INTO adaptive_decision_components','statement','fresh'],
  ['decision selection','INSERT OR IGNORE INTO adaptive_decisions(','statement','fresh'],
  ['resource reservation',"UPDATE adaptive_decisions SET status='reserved'",'batch','fresh'],
  ['specialist handoff','UPDATE adaptive_tests SET work_item_id','batch','fresh'],
  ['cost accounting','UPDATE adaptive_costs SET consumed','batch','finished'],
  ['outcome attribution','INSERT OR IGNORE INTO adaptive_outcomes','batch','finished'],
  ['learning update','UPDATE adaptive_tests SET attributed_at','batch','finished'],
  ['budget adjustment','INSERT OR IGNORE INTO adaptive_budget_adjustments','batch','budget'],
  ['parking','INSERT INTO adaptive_parking','statement','quiet'],
  ['reawakening','UPDATE adaptive_parking SET woke_at','statement','parked'],
 ];
 const ok=r=>{assert.ok([200,201].includes(r.status),JSON.stringify(r.body));return r.body;};
 const base=(dbFile)=>{const sql=new DatabaseSync(dbFile);sql.exec(`INSERT INTO investigations(id,external_id,title) VALUES ('inv','inv','Used investigation');
  INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES ('site','site','crash.example','crash.example','inv'),('infra','infrastructure_indicator','ip:192.0.2.1','192.0.2.1','inv');
  INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES ('ie','inv','site','site_investigator','site');
  INSERT INTO evidence(id,investigation_id,entity_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES ('ev','inv','site','site_investigator','ev','public','Source','3.0','2026-09-01T00:00:00Z');
  INSERT INTO evidence(id,investigation_id,entity_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at,context_text) VALUES ('ev-an','inv','site','site_investigator','ev-an','analytics_ids','Analytics','3.0','2026-09-01T00:00:00Z','["G-CRASH1"]');
  INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at) VALUES ('rel','site','infra','hosting_overlap','site_investigator','rel','3.0','2026-09-01T00:00:00Z');
  INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES ('re','rel','ev','site_investigator');
  INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,best_context,validation_status,validated_network,analysis_status,observations) VALUES ('cand','inv','evm:0xcc','evm','0xcc','0xcc','deposit','valid','ethereum','completed',1);
  INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES ('op','crash-op','Used operation','crash.example','inv');
  INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op','site','crash.example','seed');INSERT INTO operation_state(operation_id) VALUES ('op');`);sql.close();};
 const evaluate=async m=>{m.sql.exec("UPDATE operation_state SET dirty=1,lease_until=NULL");return m.call('POST','/api/v1/operations/crash-op/intelligence',{});};
 const register=async m=>{for(const [mod,cap] of [['site_finder',['site:relate']],['site_investigator',['site:investigate']]])await m.call('POST',`/api/v1/modules/${mod}/register`,{module_version:'t',schema_version:'3.0',capabilities:cap,supported_event_types:[]},MODULE_KEYS[mod]);};
 async function prepare(kind,dbFile,dir) {
  const m=await startMain({dbFile,work:dir,label:`prep-${kind}`});
  try {
   await register(m);ok(await m.call('POST','/api/v1/operations/sync',payload,MODULE_KEYS.operation_hunter));
   if(kind==='fresh')return;
   if(kind==='quiet'||kind==='parked'){const j=crypto.randomUUID();m.sql.prepare("INSERT INTO jobs(id,job_type,target_module,created_by_module,dedupe_key,payload,status,result,completed_at) VALUES (?,'FIND_RELATED_SITES','site_finder','platform',?,?,'completed','{\"new_candidates\":[]}',CURRENT_TIMESTAMP)").run(j,j,JSON.stringify({seeds:['crash.example'],artifacts:[{kind:'analytics',value:'ga4:g-crash1'},{kind:'wallet',value:'0xcc'}]}));
    m.sql.exec("DELETE FROM operation_hypotheses");if(kind==='parked'){for(let i=0;i<2;i++)await evaluate(m);assert.ok(m.one("SELECT 1 x FROM adaptive_parking WHERE scope_id='op' AND woke_at IS NULL"),'prepared parked operation');
     m.sql.exec("INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES ('site2','site','crash-two.example','crash-two.example','inv');INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op','site','crash-two.example','member')");}
    return;}
   await evaluate(m);
   const t=m.one("SELECT * FROM adaptive_tests WHERE status='running' AND work_item_id IS NOT NULL LIMIT 1");assert.ok(t,'a running external test exists');
   if(kind==='finished'||kind==='budget'){const jid=crypto.randomUUID();m.sql.prepare("INSERT INTO jobs(id,job_type,investigation_id,target_module,created_by_module,dedupe_key,payload,status,result,completed_at,attempt_count) VALUES (?,'FIND_RELATED_SITES','inv','site_finder','platform',?,?,'completed',?,CURRENT_TIMESTAMP,1)").run(jid,jid,JSON.stringify({work_item_id:t.work_item_id,seeds:['crash.example']}),JSON.stringify({new_candidates:['found.example'],meter:{used:{http:4,dns:20,crtsh:4,rdap:1}}}));
    m.sql.prepare("UPDATE work_items SET status='done',job_id=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(jid,t.work_item_id);}
   if(kind==='budget'){await evaluate(m);await evaluate(m);
    // A second useful hunt test already attributed, so the next budget check earns a bounded allowance.
    const t2=crypto.randomUUID();m.sql.prepare("INSERT INTO adaptive_decisions(id,scope_kind,scope_id,seq,state_hash,status,created_at) VALUES (?,'operation','op',900,?,'finished',?)").run('d-'+t2,'h-'+t2,new Date().toISOString());
    m.sql.prepare("INSERT INTO adaptive_tests(id,decision_id,scope_kind,scope_id,family,subject,inputs_hash,generation,safety_class,specialist,hunt_id,status,useful,attributed_at,budget_checked,created_at,finished_at) VALUES (?,?,'operation','op','RELATED_SITE_HUNT','scope:op','prior',0,'public_passive','site_finder','prior-hunt','finished',1,?,0,?,?)").run(t2,'d-'+t2,new Date().toISOString(),new Date(Date.now()-60000).toISOString(),new Date(Date.now()-60000).toISOString());
    m.sql.prepare("INSERT INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) VALUES ('site_discovered','prior.example',?,1,'provenance','RELATED_SITE_HUNT','operation','op','{}',?)").run(t2,new Date().toISOString());
    m.sql.exec("UPDATE adaptive_tests SET budget_checked=0 WHERE hunt_id IS NOT NULL");}
  } finally {await m.close();}
 }
 function invariants(m) {
  assert.equal(m.n("SELECT COUNT(*) n FROM (SELECT state_hash FROM adaptive_decisions GROUP BY scope_kind,scope_id,state_hash HAVING COUNT(*)>1)"),0,'one decision per observable state');
  assert.ok(m.n("SELECT COUNT(*) n FROM adaptive_tests WHERE scope_id='op' AND status IN ('reserved','running') AND specialist<>'main_local'")<=1,'at most one external test');
  assert.equal(m.n("SELECT COUNT(*) n FROM (SELECT work_item_id FROM adaptive_tests WHERE work_item_id IS NOT NULL GROUP BY work_item_id HAVING COUNT(*)>1)"),0,'one work item per test');
  assert.equal(m.n("SELECT COUNT(*) n FROM (SELECT fingerprint FROM work_items GROUP BY fingerprint HAVING COUNT(*)>1)"),0,'no duplicate work');
  assert.equal(m.n("SELECT COUNT(*) n FROM operation_hunts h WHERE h.status IN ('reserved','running') AND NOT EXISTS(SELECT 1 FROM adaptive_tests t WHERE t.hunt_id=h.id)"),0,'no orphan reserved hunt');
  assert.equal(m.n("SELECT COUNT(*) n FROM adaptive_tests t WHERE t.status<>'reserved' AND t.specialist<>'main_local' AND t.id NOT LIKE '%-%' AND (SELECT COUNT(*) FROM adaptive_costs c WHERE c.test_id=t.id)<>10"),0,'every test has its full cost ledger');
  assert.equal(m.n("SELECT COUNT(*) n FROM adaptive_tests t WHERE t.status='finished' AND t.specialist='site_finder' AND t.id NOT LIKE '%-%' AND (SELECT consumed FROM adaptive_costs c WHERE c.test_id=t.id AND c.dimension='http') IS NULL"),0,'finished Finder tests have measured consumption exactly once');
  for(const r of m.all('SELECT outcome_kind,outcome_ref,SUM(credit) s,COUNT(*) n FROM adaptive_outcomes GROUP BY outcome_kind,outcome_ref'))assert.ok(r.s<=1.0001,`${r.outcome_kind}:${r.outcome_ref} over-credited`);
  assert.equal(m.n("SELECT COUNT(*) n FROM (SELECT test_id FROM adaptive_budget_adjustments GROUP BY test_id HAVING COUNT(*)>1)"),0,'budget adjustment at most once per test');
  const bonus=m.one("SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id='op'")?.bonus??0,sum=m.one("SELECT COALESCE(SUM(delta),0) s FROM adaptive_budget_adjustments WHERE scope_id='op'").s;assert.equal(bonus,sum,'bonus equals its recorded adjustments');
  assert.ok(m.n("SELECT COUNT(*) n FROM adaptive_parking WHERE scope_id='op'")<=1);
  assert.equal(m.n('SELECT COUNT(*) n FROM evidence'),2,'no evidence written by v7');
 }
 try {
  for(const [name,match,unit,prep] of cases)for(const edge of ['before','after']) {
   const dir=join(work,`${passed.length}`);mkdirSync(dir);const dbFile=join(dir,'used.sqlite');applyMigrations(dbFile);base(dbFile);await prepare(prep,dbFile,dir);
   const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./adaptive-crash.mjs',import.meta.url)),'child'],{cwd:process.cwd(),env:{...process.env,ADAPTIVE_CRASH_CONFIG:JSON.stringify({dbFile,work:dir,label:'crash',phase:`${edge}_${unit}`,match})},stdio:['ignore','pipe','pipe']});
   let stderr='';child.stderr.on('data',d=>stderr+=d);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
   const url=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;try{resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1)).url);}catch{}});child.once('exit',()=>reject(new Error(`Child startup failed: ${stderr}`)));});
   const db=new DatabaseSync(dbFile);db.exec("UPDATE operation_state SET dirty=1,lease_until=NULL");db.close();
   for(let i=0;i<3;i++)await fetch(url+'/api/v1/operations/crash-op/intelligence',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});
   const deadline=setTimeout(()=>child.kill('SIGTERM'),20000);const exit=await exited;clearTimeout(deadline);assert.equal(exit.signal,'SIGKILL',`${name} ${edge}: injection must actually kill the process (${stderr.slice(-400)})`);
   const clock=new DatabaseSync(dbFile);clock.exec("UPDATE operation_state SET lease_until='2000-01-01',dirty=1");clock.close();
   const recovered=await startMain({dbFile,work:dir,label:'recovered'});
   try {
    for(let i=0;i<4;i++){const r=await evaluate(recovered);assert.equal(r.status,200,JSON.stringify(r.body));}
    invariants(recovered);
    if(prep==='finished'){assert.ok(recovered.one("SELECT 1 x FROM adaptive_outcomes WHERE outcome_kind='site_discovered' AND outcome_ref='found.example'"),'outcome attributed after recovery');assert.equal(recovered.n("SELECT COUNT(*) n FROM adaptive_outcomes WHERE outcome_ref='found.example'"),1);}
    if(prep==='budget')assert.ok(recovered.n('SELECT COUNT(*) n FROM adaptive_budget_adjustments')>=1,'allowance earned exactly once after recovery');
    if(prep==='quiet')assert.ok(recovered.one("SELECT 1 x FROM adaptive_parking WHERE scope_id='op'"),'parked after recovery');
    if(prep==='parked')assert.ok(recovered.one("SELECT woke_at FROM adaptive_parking WHERE scope_id='op'").woke_at||recovered.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id='op'")>1,'woken after recovery');
    if(prep==='fresh')assert.ok(recovered.n("SELECT COUNT(*) n FROM adaptive_tests WHERE scope_id='op'")>=1,'test planned after recovery');
    passed.push({phase:name,edge,actual_process_signal:exit.signal});console.log(`PASS crash ${edge} ${name}`);
   } finally {await recovered.close();}
  }
  const result={ok:true,crashes:passed.length,passed,scope:'Actual child-process SIGKILL before/after the SQL statement or atomic D1-double batch of each v7 transition (gap creation, candidate planning, decision selection, reservation, specialist handoff, cost accounting, attribution, learning update, budget adjustment, parking, reawakening), restart on the used SQLite file and replay.'};
  mkdirSync('verification/adaptive-v7',{recursive:true});writeFileSync('verification/adaptive-v7/crash.json',JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,crashes:passed.length}));
 }catch(e){console.error(e);process.exitCode=1;}finally{rmSync(work,{recursive:true,force:true});}
}
