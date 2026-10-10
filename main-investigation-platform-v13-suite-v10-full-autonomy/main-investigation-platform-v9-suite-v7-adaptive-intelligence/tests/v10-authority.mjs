import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {applyMigrations,startMain,MODULE_KEYS as KEYS} from './lib/main-harness.mjs';
const cwd=process.cwd(),work=mkdtempSync(join(tmpdir(),'v10-authority-')),dbFile=join(work,'main.sqlite');let main,steal=false;
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
const address='0x71c841094df8cf7fa128565551f337f74c7dbb94';
try{
 applyMigrations(dbFile);main=await startMain({dbFile,work,libraryFiles:['lib/finder-confidence.ts','lib/inbox.ts'],faultHook:(phase,sql)=>{
  if(steal&&phase==='before_batch'&&sql.includes('Inbox supply')){steal=false;main.sql.exec("UPDATE inbox_supply_lock SET owner='new-owner',until_at='2099-01-01'");}
 }});
 const confidence=()=>main.library['lib/finder-confidence.ts'];
 const claimed=network=>({details:{wallet_proofs:[{address,network,validated:true}]}});
 assert.equal((await confidence().finderAssessment(claimed('ethereum'))).authoritative_wallet_proofs.length,0);
 const malformed=await confidence().finderAssessment({details:{signals:[null,0,'wallet_reuse',[]],wallet_proofs:[null,[],false,{address,network:'ethereum'}]}});assert.equal(malformed.authoritative_wallet_proofs.length,0);
 process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES='1';mkdirSync(join(work,'wallet'));process.chdir(join(work,'wallet'));
 const {initDatabase}=await import('../integrations/wallet-investigator/server/db/database.ts');await initDatabase();
 const {runMigrations}=await import('../integrations/wallet-investigator/server/db/migrations.ts');await runMigrations();
 const {PlatformWorker}=await import('../integrations/wallet-investigator/server/integration/platform_worker.ts');const wi=new PlatformWorker(main.url,KEYS.wallet_investigator);await wi.register();
 for(const domain of ['proof-one.example','proof-two.example']){
  const inv=ok(await main.call('POST','/api/v1/autonomy',{site:domain})).investigation_id,id=randomUUID(),at=new Date().toISOString();
  ok(await main.call('POST','/api/v1/compat/logger',{id,type:'wallet.observation',schemaVersion:'2.0.0',occurredAt:at,source:'CryptoWalletLogger',sourceVersion:'0.9.0',payload:{observationId:id,address,family:'evm',candidateNetworks:['ethereum','bsc'],networkHint:{network:'ethereum',token:'USDT',source:'deposit label'},context:{class:'deposit',confidence:.95},page:{domain,url:`https://${domain}/deposit`},firstSeen:at,lastSeen:at,seenCount:1}},KEYS.crypto_wallet_logger));
  assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=?',inv),1);
 }
 for(let i=0;i<16;i++)if(!await wi.tick())break;
 const supported=await confidence().finderAssessment(claimed('ethereum'));
 assert.equal(supported.relationship_confidence,'supported wallet reuse');assert.equal(supported.authoritative_wallet_proofs.length,2);
 assert.ok(supported.authoritative_wallet_proofs.every(p=>p.evidence_ids.length&&p.network==='ethereum'));
 assert.equal((await confidence().finderAssessment(claimed('bsc'))).relationship_confidence,'unestablished','same address on another network is not proof');
 const candidate=main.one('SELECT * FROM wallet_candidates ORDER BY investigation_id LIMIT 1');
 main.sql.prepare("UPDATE jobs SET status='needs-review' WHERE id=?").run(candidate.validation_job_id);
 assert.equal((await confidence().finderAssessment(claimed('ethereum'))).relationship_confidence,'unestablished','incomplete specialist job cannot establish reuse');
 main.sql.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(candidate.validation_job_id);
 main.sql.prepare("UPDATE wallet_observations SET context_class='withdrawal' WHERE candidate_id=?").run(candidate.id);
 assert.equal((await confidence().finderAssessment(claimed('ethereum'))).relationship_confidence,'unestablished','withdrawal context cannot become deposit proof');
 ok(await main.call('POST','/api/v1/modules/site_finder/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:discover'],supported_event_types:[]},KEYS.site_finder));
 main.sql.exec("UPDATE jobs SET status='completed' WHERE job_type='DISCOVER_SITES'");steal=true;
 const fenced=await main.library['lib/inbox.ts'].maintainSupply();assert.equal(fenced.queued,false);assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'"),0);assert.equal(main.one('SELECT owner FROM inbox_supply_lock').owner,'new-owner');
 main.sql.exec("UPDATE inbox_supply_lock SET until_at='2000-01-01'");await Promise.all(Array.from({length:20},()=>main.library['lib/inbox.ts'].maintainSupply()));
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'"),1);
 process.chdir(cwd);mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/authority.json',JSON.stringify({ok:true,checks:['malformed Finder input','forged validated flag rejected','actual WI worker validation','two independent site deposit observations','matching network required','completed same-investigation WI job required','withdrawal excluded','expired discovery owner fenced','concurrent supply exactly one job'],scope:'Production routes and WI worker; synthetic chain provider, local SQLite D1 transport.'},null,2));console.log('PASS authoritative confidence and expired-owner fencing');
}finally{process.chdir(cwd);await main?.close();rmSync(work,{recursive:true,force:true});}
