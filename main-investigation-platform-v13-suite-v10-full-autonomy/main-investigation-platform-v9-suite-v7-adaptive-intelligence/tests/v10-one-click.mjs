import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'v10-start-')),dbFile=join(work,'main.sqlite');let main;
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
const findings=[];
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work,libraryFiles:['lib/finder-confidence.ts','lib/inbox.ts','lib/autonomy-search.ts']});
 const assess=main.library['lib/finder-confidence.ts'].assessFinder;
 const row=(signals,extra={})=>({status:'ready',details:{signals,...extra}});
 const s=(name,group,origin_id)=>({name,group,strength:1,phrase:name,...(origin_id?{origin_id}:{})});
 for(const name of ['cdn','hosting','template','kit','exchange_counterparty','certificate','nameserver']) {
  const a=assess(row([s(name,name,'one'),s(name,name,'two')]));assert.equal(a.eligible,false,name);assert.equal(a.relationship_confidence,'unestablished');
 }
 const copied=assess(row(Array.from({length:20},()=>s('daily_return','promise','same-upstream'))));assert.equal(copied.eligible,false);assert.equal(copied.evidence_independence.units,1);
 const unknown=assess(row([s('daily_return','promise'),s('deposit_address','wallet')]));assert.equal(unknown.evidence_independence.known_origins,0);assert.equal(unknown.evidence_independence.unknown_origin_units,1);assert.equal(unknown.relationship_confidence,'unestablished');
 for(const extra of [{site_status:'dead'},{duplicate:true}])assert.equal(assess(row([s('daily_return','promise'),s('deposit_address','wallet')],extra)).eligible,false);
 assert.equal(assess(row([s('daily_return','promise'),s('deposit_address','wallet'),{name:'risk_warning',group:'legitimacy',strength:-1}])).eligible,false);
 assert.equal(assess(row([{kind:'wallet_reuse',address:'0x'+'a'.repeat(40),network:'ethereum',validated:true}])).relationship_confidence,'unestablished');
 findings.push('generic correlation / copied and unknown origins / counter-evidence / forged wallet flag rejected');
 const waiting=ok(await main.call('POST','/api/v1/autonomy',{request_id:'start-wait-0001'}));assert.equal(waiting.state,'Finding site');assert.equal(main.n('SELECT COUNT(*) n FROM investigations'),0);
 const coalesced=ok(await main.call('POST','/api/v1/autonomy',{request_id:'coalesced-request-0001'}));assert.equal(coalesced.id,waiting.id);assert.equal(main.n("SELECT COUNT(*) n FROM autonomy_searches WHERE id='coalesced-request-0001'"),0);
 ok(await main.call('POST','/api/v1/modules/site_finder/register',{module_version:'test',schema_version:'3.0',capabilities:['site:discover','site:relate'],supported_event_types:[]},MODULE_KEYS.site_finder));
 ok(await main.call('POST','/api/v1/modules/site_investigator/register',{module_version:'test',schema_version:'3.0',capabilities:['site:investigate'],supported_event_types:[]},MODULE_KEYS.site_investigator));
 await Promise.all(Array.from({length:20},()=>main.library['lib/inbox.ts'].maintainSupply()));
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'"),1);
 const add=(id,domain,signals,score=.99)=>main.sql.prepare("INSERT INTO inbox_candidates(id,canonical_domain,url,score,status,details) VALUES (?,?,?,?,'ready',?)").run(id,domain,'https://'+domain,score,JSON.stringify({signals}));
 add('decoy','decoy.example',[s('same_cdn','cdn','cdn.example')]);
 add('supported','supported.example',[s('daily_return','promise','https://supported.example'),s('deposit_address','wallet','https://supported.example')],.9);
 const calls=await Promise.all(Array.from({length:12},()=>main.call('POST','/api/v1/autonomy',{request_id:'start-wait-0001'})));
 assert.ok(calls.every(r=>r.status===202));
 let selected=ok(await main.call('GET','/api/v1/autonomy/search/start-wait-0001'));assert.equal(selected.candidate_id,'supported');assert.equal(selected.state,'Investigating');
 assert.equal(main.n('SELECT COUNT(*) n FROM investigations'),1);assert.equal(main.n('SELECT COUNT(*) n FROM inbox_decisions'),0,'selection never pretends the analyst voted useful');
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'",selected.investigation_id),1);
 const inv=selected.investigation_id;await main.close();main=await startMain({dbFile,work,label:'restart',libraryFiles:['lib/inbox.ts']});
 selected=ok(await main.call('POST','/api/v1/autonomy',{request_id:'start-wait-0001'}));assert.equal(selected.investigation_id,inv);
 assert.equal(ok(await main.call('POST','/api/v1/autonomy',{site:'supported.example'})).investigation_id,inv);
 assert.equal(main.n('SELECT COUNT(*) n FROM investigations'),1);
 main.sql.prepare("INSERT INTO autonomy_searches(id,state,active_slot,deadline_at) VALUES('expire-test','Finding site',1,'2000-01-01')").run();
 assert.equal(ok(await main.call('GET','/api/v1/autonomy/search/expire-test')).state,'Parked');
 findings.push('bounded search / concurrent supply / supported selection / no analyst vote / restart and site-start dedup / timeout park');
 // Retain prior claimed candidates and fill the remaining ordinary inbox with unsupported rows.
 // A new search must request fresh evidence without inventing useful votes or bypassing caps.
 main.sql.prepare("UPDATE jobs SET status='completed' WHERE job_type='DISCOVER_SITES'").run();
 for(let i=0;i<10;i++)add('generic-'+i,'generic-'+i+'.example',[s('same_cdn','cdn','one-cdn')],.8);
 assert.equal((await main.library['lib/inbox.ts'].maintainSupply()).reason,'inbox full enough');
 await Promise.all(Array.from({length:20},()=>main.call('POST','/api/v1/autonomy',{request_id:'full-inbox-search'})));
 let fresh=ok(await main.call('GET','/api/v1/autonomy/search/full-inbox-search'));
 assert.equal(fresh.state,'Finding site');assert.equal(fresh.generation,1);
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'"),1);
 const payload=JSON.parse(main.sql.prepare("SELECT payload FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'").get().payload);
 assert.equal(payload.requested,1);assert.equal(payload.reason,'bounded_search_needs_supported_candidate');
 assert.equal(main.n('SELECT COUNT(*) n FROM inbox_decisions'),0);
 main.sql.prepare("UPDATE jobs SET status='completed' WHERE job_type='DISCOVER_SITES'").run();
 main.sql.prepare("UPDATE autonomy_searches SET generation=4 WHERE id='full-inbox-search'").run();
 assert.equal(ok(await main.call('GET','/api/v1/autonomy/search/full-inbox-search')).state,'Parked');
 const discoveryCount=main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES'");
 main.sql.prepare("INSERT OR REPLACE INTO inbox_settings(key,value) VALUES('max_discovery_jobs_per_day',?)").run(String(discoveryCount));
 fresh=ok(await main.call('POST','/api/v1/autonomy',{request_id:'full-inbox-capped'}));
 assert.equal(fresh.reason,'daily discovery cap reached');assert.equal(fresh.generation,0);
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES'"),discoveryCount);
 findings.push('full claimed/unsupported inbox requests one fresh candidate / concurrent singleton / no votes / four-generation and daily caps retained');

 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/one-click.json',JSON.stringify({ok:true,findings,scope:'Actual Main routes and source over local SQLite; candidate facts are fixtures. Graceful restart, not process-kill certification.'},null,2));
 console.log('PASS',findings);
} finally {await main?.close();rmSync(work,{recursive:true,force:true});}
