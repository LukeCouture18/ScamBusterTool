/** Real SIGKILL around v8 durable phases, restart and replay on the same populated database. */
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';import {localPath} from './lib/portable.mjs';
if(process.argv[2]==='child'){
 const cfg=JSON.parse(process.env.SCIENTIFIC_CRASH_CONFIG);let killed=false;
 const main=await startMain({...cfg,faultHook:(phase,sql)=>{if(!killed&&phase===cfg.phase&&sql.includes(cfg.match)){killed=true;process.kill(process.pid,'SIGKILL');}}});console.log(JSON.stringify({url:main.url}));await new Promise(()=>{});
}else{
 const work=mkdtempSync(join(tmpdir(),'science-crash-')),passed=[];
 const cases=[['hypothesis prediction creation','INSERT OR IGNORE INTO scientific_predictions','batch'],['test outcome plan','INSERT OR IGNORE INTO scientific_plans','batch'],['contradiction creation','INSERT INTO scientific_contradictions','batch'],['contradiction resolution','INSERT INTO scientific_contradictions','batch'],['hypothesis revision','INSERT INTO scientific_hypotheses','batch'],['falsification reservation','INSERT OR IGNORE INTO scientific_reservations','batch'],['operation split proposal','INSERT OR IGNORE INTO scientific_boundaries','batch'],['alternative explanation update','INSERT INTO scientific_hypotheses','batch'],['commonality update','INSERT INTO scientific_commonality','statement'],['scientific briefing projection','INSERT INTO scientific_briefings','statement']];
 const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const evaluate=async m=>{m.sql.exec('UPDATE operation_state SET dirty=1,lease_until=NULL');return m.call('POST','/api/v1/operations/crash-science/intelligence',{});};
 async function base(path,dir){
  applyMigrations(path);const db=new DatabaseSync(path);
  db.exec("INSERT INTO investigations(id,external_id,title) VALUES ('inv','inv','Crash fixture');INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES ('op','crash-science','Scientific used state','site0.example','inv');INSERT INTO operation_state(operation_id) VALUES ('op');");
  for(let i=0;i<4;i++){
   const site=`s${i}`,domain=`site${i}.example`,wallet='0x'+(i<2?'1':'2').repeat(40),contact=i<2?'contact-A':'contact-B';
   db.prepare("INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES (?,'site',?,?,'inv')").run(site,domain,domain);
   db.prepare("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES (?,'inv',?,'site_investigator',?)").run(`ie${i}`,site,site);
   db.prepare("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op','site',?,'member')").run(domain);
   for(const [id,source,type,facet,value,meta] of [[`contact${i}`,'site_investigator','public_page','contact',contact,{}],[`wallet${i}`,'wallet_investigator','address_validation','validated_deposit',wallet,{network:'ethereum',address:wallet,validation_status:'valid',context:'deposit'}],[`an${i}`,'site_investigator','analytics_ids','analytics_ids','["G-CRASH777"]',{}]])db.prepare("INSERT INTO evidence(id,entity_id,investigation_id,source_module,source_record_id,evidence_type,title,context_text,metadata,schema_version,captured_at) VALUES (?,?,'inv',?,?,?,?,?,?,'3.0','2026-10-01T00:00:00Z')").run(id,site,source,id,type,id,value,JSON.stringify({facet,value,...meta}));
  }
  db.exec("INSERT INTO entities(id,entity_type,canonical_key,display_name) VALUES ('kit','template','kit:common','Common template')");
  for(let i=0;i<4;i++){db.prepare("INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at) VALUES (?,?,'kit','template_overlap','site_investigator',?,'3.0','2026-10-01T00:00:00Z')").run(`r${i}`,`s${i}`,`r${i}`);db.prepare("INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES (?,?,?,'site_investigator')").run(`re${i}`,`r${i}`,`contact${i}`);}
  db.prepare("INSERT INTO operation_hypotheses(operation_id,hypothesis_key,statement,status,uncertainty,strengthen,weaken,next_test,content_hash) VALUES ('op','linkage:fixed','Unchanged single wallet on every site','open','Unknown','Consistent wallets','Different validated wallet','Public inspection','initial')").run();db.close();
  const m=await startMain({dbFile:path,work:dir,label:'prepare'});for(const mod of ['site_finder','site_investigator'])await m.call('POST',`/api/v1/modules/${mod}/register`,{module_version:'test',schema_version:'3.0',capabilities:mod==='site_finder'?['site:relate']:['site:investigate'],supported_event_types:[]},MODULE_KEYS[mod]);await m.close();
 }
 try{
  for(const [name,match,unit] of cases)for(const edge of ['before','after']){
   const dir=join(work,String(passed.length));mkdirSync(dir);const path=join(dir,'used.sqlite');await base(path,dir);
   const child=spawn(process.execPath,['--import','tsx',localPath('./scientific-crash.mjs',import.meta.url),'child'],{env:{...process.env,SCIENTIFIC_CRASH_CONFIG:JSON.stringify({dbFile:path,work:dir,phase:`${edge}_${unit}`,match})},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
   const url=await new Promise((r,j)=>{let out='';child.stdout.on('data',d=>{out+=d;try{r(JSON.parse(out.trim().split(/\r?\n/).at(-1)).url);}catch{}});child.once('exit',()=>j(new Error(err)));});
   const timer=setTimeout(()=>child.kill('SIGTERM'),20000);await fetch(url+'/api/v1/operations/crash-science/intelligence',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});const killed=await exit;clearTimeout(timer);assert.equal(killed.signal,'SIGKILL',`${name} ${edge} must reach real injection: ${err}`);
   const m=await startMain({dbFile:path,work:dir,label:'recovered'});try{
    m.sql.exec("UPDATE operation_state SET lease_until=NULL,dirty=1");for(let i=0;i<3;i++)ok(await evaluate(m));
    assert.equal(m.one("SELECT status FROM scientific_hypotheses WHERE hypothesis_key='linkage:fixed'").status,'REJECTED');
    assert.equal(m.n("SELECT COUNT(*) n FROM scientific_boundaries"),1);assert.equal(m.n("SELECT COUNT(*) n FROM operation_decisions WHERE kind='split'"),1);
    assert.equal(m.n("SELECT COUNT(*) n FROM operation_aliases"),0);assert.equal(m.n('SELECT COUNT(*) n FROM evidence'),12);
    assert.equal(m.n('SELECT COUNT(*) n FROM (SELECT operation_id,record_kind,record_key,content_hash FROM scientific_history GROUP BY 1,2,3,4 HAVING COUNT(*)>1)'),0);
    assert.equal(m.n("SELECT COUNT(*) n FROM adaptive_tests t WHERE status='running' AND NOT EXISTS(SELECT 1 FROM scientific_plans p WHERE p.test_id=t.id)"),0);
    const before=m.n('SELECT COUNT(*) n FROM scientific_history');ok(await evaluate(m));assert.equal(m.n('SELECT COUNT(*) n FROM scientific_history'),before);
    passed.push({phase:name,edge,signal:killed.signal,revision:'REJECTED',split_proposals:1,approved_boundary_mutations:0});console.log(`PASS ${edge} ${name}`);
   }finally{await m.close();}
  }
  const result={ok:true,crashes:passed.length,passed,scope:'Real child-process SIGKILL with local SQLite transaction boundaries. Remote D1/network in-flight behavior is not certified.'};mkdirSync('verification/scientific-v8',{recursive:true});writeFileSync('verification/scientific-v8/crash.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){console.error(e);process.exitCode=1;}finally{rmSync(work,{recursive:true,force:true});}
}
