/** Held-out corpus. Main starts with ONE site and ZERO wallets. Every other
 * entity reaches Main through real Finder/SI/Logger-classifier/WI/Hunter bridges.
 * Public and blockchain transports are synthetic; no hidden evidence injection.
 */
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {performance} from 'node:perf_hooks';
import {applyMigrations,startMain,MODULE_KEYS as KEYS} from './lib/main-harness.mjs';import {pythonCommand,pythonEnv,localPath,importFile} from './lib/portable.mjs';
const work=mkdtempSync(join(tmpdir(),'operation-hidden-')),dbFile=join(work,'main.sqlite'),originalCwd=process.cwd(),started=performance.now();let main,hunter;
const ids=Array.from({length:7},(_,i)=>`q${createHash('sha256').update(`independent-v6-holdout:${i}`).digest('hex').slice(0,11)}.top`),wallets=['0x'+'1'.repeat(40),'0x'+'2'.repeat(40),'0x'+'3'.repeat(40)];
const truth=ids.slice(0,4),seed=truth[0],pages={};
for(let i=0;i<7;i++) {
 const links=i<3?[ids[i+1],ids[i===0?4:i===1?6:5]]:[];
 const wallet=i<2?wallets[0]:i<4?wallets[1]:i===4?wallets[0]:wallets[2];
 const history=i===4,contact=i<4?'quorra_verified_support':`unrelated_${i}_support`;
 const variant=i===3?'<article><h2>Mobile portal release</h2><p>This replacement deployment introduces an account dashboard with separate asset balances, transaction export, an accessible network selector and a revised support directory. Existing customers can review their public payment instructions and compare network information before choosing a deposit option. The mobile interface replaces the earlier investment-plan screen and uses a new public configuration bundle. No automatic transfers are performed. Wallet instructions remain visible in the public help center. The release history identifies a new deployment wave.</p><script src="/assets/app.71f03cfe.js"></script></article>':'';
 const body=history?`<h1>Transaction history</h1><p>Previous sender wallet ${wallet}. Transaction hash ${'f'.repeat(64)}. This is historical activity.</p>`:`<h1>Deposit USDT ERC20 Ethereum</h1><p>Investment plans: guaranteed 3% daily profit. Minimum deposit $25. Fast withdrawals.</p><section><h2>Deposit address</h2><p>Send only USDT on Ethereum to this deposit address: <code>${wallet}</code> <button>Copy deposit address</button></p></section><p>Staking investment platform. Referral bonus. Cloud mining.</p>${variant}`;
 pages[ids[i]]={html:`<!doctype html><html><head><title>Quorra Investment • Earn daily profit</title><script>window.analytics='G-Q0RRATEST';</script></head><body>${body}<a href="https://t.me/${contact}">Public support</a>${links.map(d=>`<a href="https://${d}">Public related deployment ${d}</a>`).join('')}</body></html>`,links,wallet,truth:i<4,history,dead:i===6};
}
const corpus={seed,pages};const corpusFile=join(work,'corpus.json');writeFileSync(corpusFile,JSON.stringify(corpus));
const moduleTrace=[],rounds=[],loggerSeen=new Set(),requests=[];let providerCalls=0;
const ok=r=>{assert.ok([200,201,202].includes(r.status),`${r.status} ${JSON.stringify(r.body)}`);return r.body;};
const worker=(cmd,key,extra={})=>new Promise((resolve,reject)=>{
 const py=pythonCommand(),child=spawn(py.command,[...py.args,localPath('./operation-hidden-bridge.py',import.meta.url),cmd],{env:pythonEnv({OPERATION_HIDDEN_CONFIG:JSON.stringify({dir:work,corpus:corpusFile,url:main.url,key,chromium:process.env.MIP_CHROMIUM??null,...extra})}),windowsHide:true});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>{if(code)return reject(new Error(`${cmd}: ${err.slice(-4000)} ${out.slice(-1000)}`));try{const r=JSON.parse(out.trim().split(/\r?\n/).at(-1));requests.push(...(r.requests??[]).map(url=>({module:cmd,url})));moduleTrace.push({module:cmd,ran:r.ran,domain:r.domain,costs:r.costs});resolve(r);}catch(e){reject(new Error(`${cmd}: ${out.slice(-1000)} ${err.slice(-2000)}`));}});
});
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});
 const at=new Date().toISOString();
 ok(await main.call('POST','/api/v1/ingest/site_finder',{schema_version:'3.0',batch_id:'seed-only',sent_at:at,records:{investigations:[{external_id:'one-seed',title:'Hidden corpus seed',confidence:1}],sites:[{external_id:'one-seed-site',investigation_id:'one-seed',canonical_key:seed,display_name:seed,confidence:.9,observed_at:at}]}},KEYS.site_finder));
 assert.equal(main.n("SELECT COUNT(*) n FROM entities WHERE entity_type='site'"),1);assert.equal(main.n("SELECT COUNT(*) n FROM entities WHERE entity_type='wallet'"),0);
 // Declared benchmark resource profile; this is policy configuration, not hidden evidence.
 main.sql.exec("UPDATE investigations SET automation_profile_id='deep-investigation';INSERT INTO ops_state(key,value) VALUES ('auto_form_campaigns','false') ON CONFLICT(key) DO UPDATE SET value='false'");
 main.sql.exec("UPDATE investigation_budgets SET max_jobs=80,max_api_calls=2000,max_runtime_seconds=14400 WHERE investigation_id IN(SELECT id FROM investigations WHERE external_id='one-seed')");
 ok(await main.call('POST','/api/v1/modules/site_investigator/register',{module_version:'real-hidden-worker',schema_version:'3.0',capabilities:['site:investigate'],supported_event_types:[]},KEYS.site_investigator));
 await worker('finder',KEYS.site_finder); // register; no work or discovery has yet been requested
 mkdirSync(join(work,'wallet'));process.chdir(join(work,'wallet'));process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES='1';
 const {initDatabase}=await import('../integrations/wallet-investigator/server/db/database.ts');await initDatabase();
 const {runMigrations}=await import('../integrations/wallet-investigator/server/db/migrations.ts');await runMigrations();
 const {globalProviderManager}=await import('../integrations/wallet-investigator/server/providers/manager.ts');
 globalProviderManager.registerProvider({name:'HiddenPublicChainTransport',supported_networks:['ethereum'],priority:1000,is_healthy:async()=>true,fetch_wallet_activity:async(address,network)=>{providerCalls++;return {provider_name:'HiddenPublicChainTransport',network,address,transactions:[{tx_hash:'0x'+createHash('sha256').update(address).digest('hex'),timestamp:1700000000000,from_address:'0x'+'b'.repeat(40),to_address:address,asset:'ETH',is_token:false,raw_amount:'1000000000000000000',status:'confirmed'}],balance_raw:'0',balance_asset:'ETH',completeness:'COMPLETE',completeness_details:{status:'COMPLETE',pages_retrieved:1,records_retrieved:1,provider_limit_hit:false,pagination_completed:true}};}});
 const {PlatformWorker}=await import('../integrations/wallet-investigator/server/integration/platform_worker.ts');const wi=new PlatformWorker(main.url,KEYS.wallet_investigator);await wi.register();process.chdir(originalCwd);
 const hunterDir=process.env.HUNTER_DIR??localPath('../../operation-hunter-v2.0/',import.meta.url),{HunterApp}=await importFile(join(hunterDir,'server/app.ts')),{IntegrationWorker}=await importFile(join(hunterDir,'server/integration/worker.ts'));
 const realFetch=globalThis.fetch;
 const fixtureFetch=async(url,init)=>{
  if(String(url).startsWith(main.url))return realFetch(url,init);
  const u=new URL(String(url)),host=u.hostname;requests.push({module:'hunter',url:String(url)});
  if(pages[host])return new Response(pages[host].dead?'Not found':pages[host].html,{status:pages[host].dead?404:200,headers:{'content-type':'text/html'}});
  let data=[];if(host==='crt.sh'){const known=Object.keys(pages).filter(d=>decodeURIComponent(u.search).includes(d));data=known.flatMap(d=>[d,...pages[d].links]).map(d=>({name_value:d,entry_timestamp:'2026-09-01T00:00:00Z'}));}
  else if(host==='rdap.org')data={events:[{eventAction:'registration',eventDate:'2026-08-15T00:00:00Z'}],nameservers:[{ldhName:'ns1.public-cdn.example'}]};
  else if(host==='urlscan.io')data={results:[],has_more:false};
  else data={items:[],result:[],total:0};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 const answer=(host,type)=>{requests.push({module:'hunter',url:`dns://${host}/${type}`});return pages[host]&&!pages[host].dead?Promise.resolve(type==='A'?['104.21.12.34']:type==='NS'?['ns1.public-cdn.example']:[]):Promise.reject(Object.assign(new Error('ENOTFOUND'),{code:'ENOTFOUND'}));};
 hunter=new HunterApp({dataDir:join(work,'hunter'),seedDemo:false,networkMode:'live',fetchImpl:fixtureFetch,dnsResolver:{setServers(){},resolve4:h=>answer(h,'A'),resolve6:h=>answer(h,'AAAA'),resolveNs:h=>answer(h,'NS'),resolveMx:h=>answer(h,'MX'),resolveTxt:h=>answer(h,'TXT'),resolveCname:h=>answer(h,'CNAME')}});
 for(const host of ['crt.sh','rdap.org','urlscan.io','api.etherscan.io','eth.blockscout.com'])hunter.http.setPacing(host,0);
 hunter.analyzer.debounceMs=5;hunter.integration=new IntegrationWorker(hunter);hunter.integration.configure({url:main.url,apiKey:KEYS.operation_hunter,enabled:true});console.log('hunter-register',JSON.stringify(await hunter.integration.cycle()));
 for(let round=0;round<12;round++) {
  ok(await main.call('POST','/api/v1/ops/tick',{}));
  const si=await worker('investigator',KEYS.site_investigator);console.log('SI collected public pages');
  for(const site of si.sites??[]) {
   if(site.status!=='investigated'||loggerSeen.has(site.normalized_domain))continue;
   loggerSeen.add(site.normalized_domain);const observed=await worker('logger',KEYS.crypto_wallet_logger,{domain:site.normalized_domain});
   for(const o of observed.observations??[]) {
    const oid=createHash('sha256').update(`${site.normalized_domain}:${o.address}:${o.context.class}`).digest('hex'),time=new Date().toISOString();
    ok(await main.call('POST','/api/v1/compat/logger',{id:oid,type:'wallet.observation',schemaVersion:'2.0.0',occurredAt:time,source:'CryptoWalletLogger',sourceVersion:'0.9.0',payload:{observationId:oid,address:o.address,family:o.family,candidateNetworks:['ethereum'],networkHint:{network:'ethereum',source:'nearby-text'},context:{...o.context,section:pages[site.normalized_domain]?.history?'Transaction history':'Deposit USDT ERC20 Ethereum',snippet:o.address},detection:{method:'text'},page:{domain:site.normalized_domain,url:`https://${site.normalized_domain}/deposit`},firstSeen:time,lastSeen:time,seenCount:1}},KEYS.crypto_wallet_logger));
   }
  }
  await wi.tick();console.log('hunter-cycle',JSON.stringify(await hunter.integration.cycle()));
  const operation=hunter.store.getOperations().find(o=>o.initialSeed===seed);
  if(operation){await hunter.pursuit.runToCompletion(operation.id,{budgetTotal:24,maxHops:3,concurrency:2,maxMinutes:3},24);hunter.analyzer.analyze(operation.id);hunter.integration.queueSync(operation.id);await hunter.integration.cycle();}
  const finder=await worker('finder',KEYS.site_finder);console.log('Finder public discovery cycle complete');
  const discovered=main.all("SELECT canonical_key FROM entities WHERE entity_type='site'").map(r=>r.canonical_key);
  rounds.push({round,sites:discovered,investigated:[...loggerSeen],validated_deposit_wallets:main.n("SELECT COUNT(DISTINCT identity) n FROM wallet_candidates WHERE validation_status='valid' AND best_context='deposit'"),finder_claimed:finder.ran?.claimed,operation_present:!!operation});
  console.log(JSON.stringify(rounds.at(-1)));
  if(round===5){const port=Number(new URL(main.url).port);await main.close();main=await startMain({dbFile,work,label:'hidden-restart',port});}
  if(truth.every(d=>loggerSeen.has(d))&&operation&&round>=6)break;
 }
 const known=main.all("SELECT canonical_key FROM entities WHERE entity_type='site'").map(r=>r.canonical_key),hiddenFound=truth.slice(1).filter(d=>known.includes(d)),investigated=truth.filter(d=>loggerSeen.has(d));
 assert.equal(hiddenFound.length,3,'All hidden target deployments must be discovered through module work.');assert.equal(investigated.length,4,'Real SI must investigate every target deployment.');
 assert.equal(main.n("SELECT COUNT(DISTINCT identity) n FROM wallet_candidates WHERE validation_status='valid' AND best_context='deposit' AND address IN (?,?)",...wallets.slice(0,2)),2);
 assert.ok(main.n('SELECT COUNT(*) n FROM hunter_operations')>0);assert.ok(main.n('SELECT COUNT(*) n FROM operation_edges')>0);
 const historyCandidate=main.one('SELECT best_context FROM wallet_candidates WHERE investigation_id IN (SELECT ie.investigation_id FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE e.canonical_key=?)',ids[4]);
 if(historyCandidate)assert.notEqual(historyCandidate.best_context,'deposit');
 const sourceProof=hiddenFound.map(domain=>({domain,finder_site_records:main.n("SELECT COUNT(*) n FROM observations o JOIN entities e ON e.id=o.entity_id WHERE e.canonical_key=? AND o.source_module='site_finder'",domain),first_discovery_round:rounds.find(r=>r.sites.includes(domain))?.round}));
 for(const proof of sourceProof)assert.ok(proof.finder_site_records>0,`Hidden site must have real Finder-ingest provenance: ${proof.domain}`);
 const nextOperationHunts=main.n("SELECT COUNT(*) n FROM operation_hunts WHERE status IN ('running','finished')");assert.ok(nextOperationHunts>0,'Operation update must generate a real next bounded hunt');
 const validatedReuse=main.n("SELECT COUNT(*) n FROM wallet_candidates WHERE address=? AND validation_status='valid' AND best_context='deposit'",wallets[0]);assert.ok(validatedReuse>=2);
 const jobs=main.n('SELECT COUNT(*) n FROM jobs'),useful=hiddenFound.length,owners=main.n("SELECT COUNT(*) n FROM relationships WHERE relationship_type IN ('owns','owned_by','common_ownership')"),duplicates=main.n("SELECT COUNT(*) n FROM (SELECT dedupe_key FROM jobs WHERE status IN ('pending','claimed','running') GROUP BY dedupe_key HAVING COUNT(*)>1)");
 const result={ok:true,seed_sites:1,initial_wallets:0,hidden_sites_injected:0,hidden_sites_discovered:hiddenFound.length,target_sites_investigated:investigated.length,validated_target_wallets:2,unsupported_ownership_claims:owners,duplicate_active_jobs:duplicates,human_actions:0,jobs,jobs_per_useful_discovery:jobs/useful,transport_requests:requests.length,requests_by_kind:{http:requests.filter(r=>r.url.startsWith('http')).length,dns:requests.filter(r=>r.url.startsWith('dns:')).length,tls:requests.filter(r=>r.url.startsWith('tls:')).length},requests_per_useful_discovery:requests.length/useful,provider_calls:providerCalls,time_to_final_operation_update_ms:performance.now()-started,restart:true,source_proof:sourceProof,multi_hop_useful_discoveries:sourceProof.filter(p=>p.domain!==truth[1]).length,operation_next_bounded_hunts:nextOperationHunts,validated_wallet_reuse_site_candidates:validatedReuse,rounds,moduleTrace,requests,limitations:['Public/blockchain transports are synthetic.','Unchanged Logger classifier ran on real rendered DOM; installed extension lifecycle remains a separate environment-limited check.','This corpus does not certify all operation benchmark scenarios.']};
 assert.equal(owners,0);assert.equal(duplicates,0);mkdirSync('verification/operation-v6',{recursive:true});writeFileSync('verification/operation-v6/hidden-discovery.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,requests:undefined,moduleTrace:undefined,rounds:undefined}));
}catch(e){process.exitCode=1;console.error(e);if(main)console.error(JSON.stringify({jobs:main.all('SELECT job_type,status,investigation_id,result FROM jobs'),registry:main.all('SELECT module_name,last_heartbeat_at,capabilities FROM module_registry'),observations:main.all('SELECT source_module,classification,entity_id FROM observations'),work:main.all('SELECT kind,status,reason,result FROM work_items'),candidates:main.all('SELECT canonical_domain,status,score FROM inbox_candidates')}));process.exitCode=1;}finally{process.chdir(originalCwd);hunter?.close();if(main)await main.close();rmSync(work,{recursive:true,force:true});process.exit(process.exitCode??0);}
