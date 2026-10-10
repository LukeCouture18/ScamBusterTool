/** Real WI engine + real Main routes. Fault injection is only in the provider transport and clock. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS as KEYS} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'director-provider-')),dbFile=join(work,'main.sqlite'),cwd=process.cwd();let main;
let recovered=false,calls=0;
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});
 const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
 mkdirSync(join(work,'wallet'));process.chdir(join(work,'wallet'));
 process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES='1';
 const {initDatabase}=await import('../integrations/wallet-investigator/server/db/database.ts');await initDatabase();
 const {runMigrations}=await import('../integrations/wallet-investigator/server/db/migrations.ts');await runMigrations();
 const {globalProviderManager}=await import('../integrations/wallet-investigator/server/providers/manager.ts');
 globalProviderManager.registerProvider({name:'RecoveryTransport',supported_networks:['ethereum'],priority:1000,is_healthy:async()=>true,
 fetch_wallet_activity:async(address,network)=>{calls++;return {provider_name:'RecoveryTransport',network,address,transactions:recovered?[{tx_hash:'0x'+'a'.repeat(64),timestamp:1700000000000,from_address:'0x'+'b'.repeat(40),to_address:address,asset:'ETH',is_token:false,raw_amount:'1000000000000000000',status:'confirmed'}]:[],balance_raw:'0',balance_asset:'ETH',completeness:recovered?'COMPLETE':'FAILED',completeness_details:{status:recovered?'COMPLETE':'FAILED',pages_retrieved:recovered?1:0,records_retrieved:recovered?1:0,provider_limit_hit:false,pagination_completed:recovered,missing_native_history:!recovered,missing_token_history:!recovered,warning_message:recovered?undefined:'Provider unavailable'}};}});
 const {PlatformWorker}=await import('../integrations/wallet-investigator/server/integration/platform_worker.ts');
 const wi=new PlatformWorker(main.url,KEYS.wallet_investigator);await wi.register();process.chdir(cwd);
 const address='0x'+'1'.repeat(40),at=new Date().toISOString();
 const ev={id:'recovery-observation-1',type:'wallet.observation',schemaVersion:'2.0.0',occurredAt:at,source:'CryptoWalletLogger',sourceVersion:'0.9.0',payload:{observationId:'recovery-observation-1',address,family:'evm',candidateNetworks:['ethereum'],networkHint:{network:'ethereum',source:'selected-option'},context:{class:'deposit',confidence:.95,cues:['deposit address'],negativeCues:[],section:'Deposit ETH',snippet:address},detection:{method:'text'},page:{domain:'recovery.example',url:'https://recovery.example/deposit'},firstSeen:at,lastSeen:at,seenCount:1}};
 ok(await main.call('POST','/api/v1/modules/form_submitter/destination',{kind:'google_form',form_id:'Synthetic',form_url:'https://docs.google.com/forms/d/e/Synthetic/viewform',version_hash:'1'},KEYS.form_submitter));
 ok(await main.call('POST','/api/v1/compat/logger',ev,KEYS.crypto_wallet_logger));await wi.tick();
 const c=main.one('SELECT * FROM wallet_candidates');assert.equal(c.validation_status,'valid');assert.equal(c.analysis_status,'partial');assert.equal(main.one('SELECT status FROM director_retries').status,'parked');
 const before=main.one('SELECT rc.evidence_sha256 FROM report_candidates rc JOIN report_contents c ON c.candidate_id=rc.id WHERE c.superseded_by IS NULL').evidence_sha256;
 assert.equal(main.one('SELECT ready FROM report_contents WHERE superseded_by IS NULL').ready,0);
 // Main process restart during provider backoff, keeping WI's durable engine/cache as well.
 const port=Number(new URL(main.url).port);await main.close();main=await startMain({dbFile,work,label:'recovery',port});
 recovered=true;main.sql.exec("UPDATE director_retries SET next_at='2000-01-01T00:00:00Z';UPDATE director_provider_health SET next_probe_at='2000-01-01T00:00:00Z'");
 for(let n=0;n<3;n++)ok(await main.call('POST',`/api/v1/investigations/${c.investigation_id}/director`,{}));
 await wi.tick();
 assert.equal(calls,2,'refresh bypassed the failed cache and historical result exactly once');
 assert.equal(main.one('SELECT analysis_status FROM wallet_candidates').analysis_status,'completed');
 assert.equal(main.one('SELECT status FROM director_retries').status,'resolved');
 assert.equal(main.one('SELECT ready FROM report_contents WHERE superseded_by IS NULL').ready,1);
 const current=main.one('SELECT rc.id,rc.evidence_sha256 FROM report_candidates rc JOIN report_contents c ON c.candidate_id=rc.id WHERE c.superseded_by IS NULL');assert.notEqual(current.evidence_sha256,before);
 const replay=await main.call('POST','/api/v1/compat/logger',ev,KEYS.crypto_wallet_logger);ok(replay);assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates'),1);
 assert.equal((await main.call('PATCH',`/api/v1/investigations/${c.investigation_id}/report`,{candidate_id:current.id,action:'approve',reason:'Reviewed exact report',content_sha256:before})).status,409);
 // A later browser observation contradicts the network. It must create a fresh
 // validation job, withdraw readiness, and preserve WI's ambiguity decision.
 const oldJob=main.one('SELECT analysis_job_id FROM wallet_candidates').analysis_job_id;
 const changed=structuredClone(ev);changed.id=changed.payload.observationId='recovery-observation-2';changed.payload.networkHint.network='bsc';
 ok(await main.call('POST','/api/v1/compat/logger',changed,KEYS.crypto_wallet_logger));
 assert.notEqual(main.one('SELECT validation_job_id FROM wallet_candidates').validation_job_id,oldJob);
 assert.equal(main.one('SELECT ready FROM report_contents WHERE superseded_by IS NULL').ready,0);
 await wi.tick();assert.equal(main.one('SELECT validation_status FROM wallet_candidates').validation_status,'network_ambiguous');assert.equal(main.one('SELECT validated_network FROM wallet_candidates').validated_network,null);
 ok(await main.call('POST',`/api/v1/investigations/${c.investigation_id}/director`,{}));
 assert.equal(main.n("SELECT COUNT(*) n FROM human_checkpoints WHERE kind='analyst_review' AND status='open'"),1);
 assert.equal(calls,2,'network ambiguity never launches guessed blockchain analysis');
 console.log(JSON.stringify({ok:true,provider_calls:calls,retry_attempts:1,restart:true,cache_bypassed:true,report_rebuilt:true,stale_hash_rejected:true,changed_network_revalidated_without_guessing:true}));
}catch(error){console.error(error);process.exitCode=1;}finally{process.chdir(cwd);if(main)await main.close();rmSync(work,{recursive:true,force:true});process.exit(process.exitCode??0);}
