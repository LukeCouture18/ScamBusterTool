/** Real Main routes with persisted external fault/evidence fixtures. No director imports. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {applyMigrations,startMain,MODULE_KEYS as KEYS} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'director-adversarial-')),dbFile=join(work,'main.sqlite');let main;const checks=[];
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
const tick=async inv=>ok(await main.call('POST',`/api/v1/investigations/${inv}/director`,{}));
function seed(name){const inv=crypto.randomUUID(),site=crypto.randomUUID();main.sql.prepare('INSERT INTO investigations(id,external_id,title) VALUES (?,?,?)').run(inv,inv,name);main.sql.prepare("INSERT INTO entities(id,investigation_id,entity_type,canonical_key,display_name) VALUES (?,?,'site',?,?)").run(site,inv,name,name);main.sql.prepare("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id,schema_version) VALUES (?,?,?,'site_finder',?,'3.0')").run(crypto.randomUUID(),inv,site,name);return {inv,site,name};}
async function evidence(s,module,type,text,scope='public') {return ok(await main.call('POST',`/api/v1/ingest/${module}`,{schema_version:'3.0',batch_id:crypto.randomUUID(),sent_at:new Date().toISOString(),records:{evidence:[{investigation_id:s.inv,external_id:crypto.randomUUID(),evidence_type:type,evidence_class:'observed_website',observation_scope:scope,title:type,context_text:JSON.stringify(text),confidence:.9}]}},KEYS[module]));}
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});
 for(const [mod,cap] of [['site_investigator','site:investigate'],['crypto_wallet_logger','wallet:log'],['wallet_investigator','wallet:analyze']])ok(await main.call('POST',`/api/v1/modules/${mod}/register`,{module_version:'adversarial',schema_version:'3.0',capabilities:[cap],supported_event_types:[]},KEYS[mod]));
 // Failure injection represents a worker transport that repeatedly stops. The
 // real director adopts its old result, schedules typed jobs, and reconciles them.
 const s=seed('flapping.example'),cid=crypto.randomUUID(),jid=crypto.randomUUID(),address='0x'+'1'.repeat(40);
 main.sql.prepare("INSERT INTO jobs(id,job_type,investigation_id,target_entity_id,target_module,created_by_module,dedupe_key,payload,status,result) VALUES (?,'ANALYZE_WALLET',?,?,'wallet_investigator','platform',?,?,'needs-review',?)").run(jid,s.inv,s.site,jid,JSON.stringify({pipeline:'wallet-v4',analyze:true}),JSON.stringify({completeness:'FAILED',completeness_reason:'Provider unavailable'}));
 main.sql.prepare("INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,best_context,validation_status,validated_network,analysis_status,analysis_job_id) VALUES (?,?,?,'evm',?,?,'deposit','valid','ethereum','partial',?)").run(cid,s.inv,`evm:${address}`,address,address,jid);
 await tick(s.inv);
 main.sql.prepare("INSERT INTO human_checkpoints(id,investigation_id,kind,title,instructions,detected_by,trigger_evidence) VALUES (?,?,'mfa','Waiting for your code','Enter it yourself','deterministic','[]')").run(crypto.randomUUID(),s.inv);
 for(let attempt=1;attempt<=3;attempt++){
  main.sql.prepare("UPDATE director_retries SET next_at='2000-01-01T00:00:00Z' WHERE candidate_id=?").run(cid);main.sql.exec("UPDATE director_provider_health SET next_probe_at='2000-01-01T00:00:00Z'");
  for(let n=0;n<3;n++)await tick(s.inv);
  const r=main.one('SELECT * FROM director_retries WHERE candidate_id=?',cid);assert.equal(r.status,'running');assert.equal(r.attempts,attempt);
  main.sql.prepare("UPDATE jobs SET status='failed',result='{}' WHERE id=?").run(r.job_id);await tick(s.inv);
 }
 assert.equal(main.one('SELECT status FROM director_retries WHERE candidate_id=?',cid).status,'exhausted');
 const before=main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',s.inv);
 for(let n=0;n<20;n++)await tick(s.inv);
 assert.equal(main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',s.inv),before);
 assert.equal(main.one('SELECT attempts FROM director_retries WHERE candidate_id=?',cid).attempts,3);
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND target_module='site_investigator'",s.inv),0,'MFA checkpoint permits only existing read-only analysis');
 checks.push('flapping provider: three fresh retries, no storm, safe recovery during MFA checkpoint');
 const login=seed('login.example');
 main.sql.prepare("INSERT INTO jobs(id,job_type,investigation_id,target_entity_id,target_module,created_by_module,dedupe_key,status) VALUES (?,'INVESTIGATE_SITE',?,?,'site_investigator','platform',?,'completed')").run(crypto.randomUUID(),login.inv,login.site,crypto.randomUUID());
 await evidence(login,'site_investigator','page_text',{kind:'login',text:'Please sign in to continue'});await tick(login.inv);
 assert.equal(main.one("SELECT status FROM human_checkpoints WHERE investigation_id=? AND kind='login'",login.inv).status,'open');
 await evidence(login,'site_investigator','dns',{ip:['192.0.2.1'],nameservers:['shared-cdn.example']});await tick(login.inv);
 assert.equal(main.one("SELECT status FROM human_checkpoints WHERE investigation_id=? AND kind='login'",login.inv).status,'open','DNS never means the person logged in');
 await evidence(login,'crypto_wallet_logger','wallet_display',{wallet:address},'authenticated');await tick(login.inv);
 assert.equal(main.one("SELECT status FROM human_checkpoints WHERE investigation_id=? AND kind='login'",login.inv).status,'resolved');
 checks.push('login: unrelated DNS cannot resume; new authenticated browser evidence can');
 const other=seed('unrelated.example');await evidence(other,'site_investigator','dns',{ip:['192.0.2.1'],nameservers:['shared-cdn.example']});await evidence(other,'site_investigator','page_text',{title:'Shared template',text:'Example address '+address});await tick(other.inv);
 assert.equal(main.n("SELECT COUNT(*) n FROM relationships WHERE relationship_type IN ('same_operator','owns','common_ownership')"),0);
 assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=?',other.inv),0,'example text does not create a confirmed deposit candidate');
 checks.push('shared CDN and example text do not establish ownership or a confirmed wallet');
 const n=main.n('SELECT COUNT(*) n FROM wallet_observations');
 for(const key of ['password','vault_key','privateKey','provider_credentials','session_token']) {
  const r=await main.call('POST','/api/v1/compat/logger',{payload:{nested:[{[key]:'synthetic-secret'}]}},KEYS.crypto_wallet_logger);assert.equal(r.status,400);assert.equal(r.body.error.code,'VALIDATION_ERROR');
 }
 assert.equal(main.n('SELECT COUNT(*) n FROM wallet_observations'),n);checks.push('nested secret fields rejected before ingestion');
 console.log(JSON.stringify({ok:true,checks}));
}finally{if(main)await main.close();rmSync(work,{recursive:true,force:true});}
