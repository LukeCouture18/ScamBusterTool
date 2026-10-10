// Real Main + real passive content scanner + real WI + real Form worker.
// Public pages and chain/form transports are fixtures; no installed-extension claim.
import assert from 'node:assert/strict';
import accountApi from '../integrations/crypto-wallet-logger-v08/account-vault.js';
const privateStore={data:{},async get(k){return {[k]:structuredClone(this.data[k])};},async set(v){Object.assign(this.data,structuredClone(v));}};const vault=new accountApi.Vault(privateStore);
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {applyMigrations,startMain,MODULE_KEYS as KEYS} from './lib/main-harness.mjs';
import {runPython,repoRoot,pythonCommand,pythonEnv,localPath} from './lib/portable.mjs';import {evm} from './lib/test-addresses.mjs';
const work=mkdtempSync(join(tmpdir(),'autonomy-v10-')),path=join(work,'main.sqlite'),cwd=process.cwd();let main;
const rows=[],submissions=[],outage=new Set();let calls=0;
const extra=async(req,res,url)=>{if(url.pathname!=='/autonomy-form')return false;let body='';for await(const c of req)body+=c;submissions.push(body);res.writeHead(200,{'content-type':'text/html'});res.end('Your response has been recorded');return true;};
const moduleTrace=[];
const bridge=async(cmd,key,corpus,dir)=>{const py=pythonCommand();return new Promise((resolve,reject)=>{const child=spawn(py.command,[...py.args,localPath('./v10-public-bridge.py',import.meta.url),cmd],{env:pythonEnv({OPERATION_HIDDEN_CONFIG:JSON.stringify({dir,corpus,url:main.url,key,discover_all:true})})});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('exit',code=>{if(code)return reject(new Error(err));try{const r=JSON.parse(out.trim().split(/\r?\n/).at(-1));moduleTrace.push({cmd,...r});resolve(r);}catch(e){reject(new Error(out+err));}});});};
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
const wrap=s=>`<!doctype html><html><head><title>Account payment information</title></head><body>${s}</body></html>`;
const deposit=(address,net=true)=>`<section><h2>Deposit ${net?'USDT ERC20 Ethereum':''}</h2><p>Send only ${net?'USDT on Ethereum':''} to your deposit address</p><input readonly value="${address}" aria-label="Deposit address"><button>Copy deposit address</button></section>`;
const names=['public','login','modal','qr','dynamic','decoys','ambiguous','outage','browser-restart','main-restart','wallet-change','related','no-wallet','unsafe'];
const fixtures=names.map((name,i)=>{const address=evm(101+i),domain=`v10-${name}.example`;let html=deposit(address),click=null,qr=null;
 if(name==='login')html=`<p>Login required. Sign in to access deposit information.</p><button onclick="document.body.innerHTML=decodeURIComponent('${encodeURIComponent(deposit(address))}')">Sign in normally</button>`,click='Sign in normally';
 if(name==='modal')html=`<button onclick="document.querySelector('dialog').showModal()">Open deposit</button><dialog>${deposit(address)}</dialog>`,click='Open deposit';
 if(name==='dynamic')html=`<button onclick="document.body.insertAdjacentHTML('beforeend',decodeURIComponent('${encodeURIComponent(deposit(address))}'))">Show account details</button>`,click='Show account details';
 if(name==='qr')html='<section><h2>Deposit USDT Ethereum ERC20</h2><p>Scan this deposit QR code to send funds on Ethereum.</p><img src="QR_IMAGE" alt="Deposit QR code"></section>',qr=address;
 if(name==='decoys')html+=`<aside><h2>Example wallet</h2><p>Documentation example ${evm(201)}</p></aside><section><h2>Withdrawal address</h2><input value="${evm(202)}" aria-label="Your withdrawal wallet"></section><section><h2>Transaction history</h2><p>Previous sender ${evm(203)}</p></section><section><h2>Token contract</h2><code>${evm(204)}</code></section>`;
 if(name==='ambiguous')html=deposit(address,false);
 if(name==='no-wallet')html='<h1>Public account overview</h1><p>No payment or wallet information is displayed.</p>';
 if(name==='unsafe')html=`<h1>Withdrawal settings</h1><p>Your withdrawal destination</p><input value="${address}" aria-label="Withdrawal wallet">`;
 return {name,domain,address,html:wrap(html),click,qr,restart:name==='browser-restart'};}).filter(f=>!process.env.AUTONOMY_CASE||f.name===process.env.AUTONOMY_CASE);
try{
 applyMigrations(path);main=await startMain({dbFile:path,work,extra});
 process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES='0';mkdirSync(join(work,'wallet'));process.chdir(join(work,'wallet'));
 const {initDatabase}=await import('../integrations/wallet-investigator/server/db/database.ts');await initDatabase();const {runMigrations}=await import('../integrations/wallet-investigator/server/db/migrations.ts');await runMigrations();
 const {globalProviderManager}=await import('../integrations/wallet-investigator/server/providers/manager.ts');globalProviderManager.registerProvider({name:'V9FixtureChain',priority:9999,supported_networks:['ethereum'],is_healthy:async()=>true,fetch_wallet_activity:async(address,network)=>{calls++;if(outage.has(address.toLowerCase()))throw new Error('Fixture provider unavailable');return {provider_name:'V9FixtureChain',network,address,transactions:[{tx_hash:'0x'+createHash('sha256').update(address).digest('hex'),timestamp:1700000000000,from_address:'0x'+'b'.repeat(40),to_address:address,asset:'ETH',is_token:false,raw_amount:'1000000000000000000',status:'confirmed'}],balance_raw:'0',balance_asset:'ETH',completeness:'COMPLETE',completeness_details:{status:'COMPLETE',pages_retrieved:1,records_retrieved:1,provider_limit_hit:false,pagination_completed:true}};}});
 const {PlatformWorker}=await import('../integrations/wallet-investigator/server/integration/platform_worker.ts');const wi=new PlatformWorker(main.url,KEYS.wallet_investigator);await wi.register();
 mkdirSync(join(work,'form'));process.chdir(join(work,'form'));process.env.FORM_SUBMITTER_MODULE_KEY=KEYS.form_submitter;
 const {ReportWorker,durableStorage}=await import('../integrations/form-submitter/server/integration/platform_worker.ts');process.chdir(cwd);
 const at=new Date().toISOString(),formUrl='https://docs.google.com/forms/d/e/V9Autonomy/viewform';
 durableStorage.syncFullState({settings:{username:'fixture-analyst',teamInviteCode:'fixture-team',autoSubmitGlobalEnabled:true},formConfig:{formUrl,formId:'V9Autonomy',formTitle:'V9 synthetic destination',formVersionHash:'v10-fixture',verifiedAt:at,parsedSchema:{formId:'V9Autonomy',formTitle:'V9 synthetic destination',formUrl,versionHash:'v10-fixture',sections:[],allQuestions:[{id:'1',entryKey:'entry.1',title:'Site URL',type:'SHORT_ANSWER',required:true,pageIndex:1},{id:'2',entryKey:'entry.2',title:'Wallets',type:'PARAGRAPH',required:true,pageIndex:1}],parsedAt:at},fieldMappings:[{id:'site',fieldKey:'siteUrl',label:'Site URL',entryKey:'entry.1',pageIndex:1,required:true},{id:'wallets',fieldKey:'walletsList',label:'Wallets',entryKey:'entry.2',pageIndex:1,required:true}],multiWalletFormat:'COMBINED_LIST'}});
 const fetchOriginal=globalThis.fetch;globalThis.fetch=(url,options)=>String(url).startsWith(formUrl.replace('/viewform','/'))?fetchOriginal(main.url+'/autonomy-form',options):fetchOriginal(url,options);
 const form=new ReportWorker(main.url,KEYS.form_submitter);await form.register();await form.reportDestination();
 await vault.unlock('synthetic private master password');
 for(const f of fixtures)if(f.name==='login'){const input={requestId:'golden-private-login-001',intent:'owned_account_import',loginUrl:'https://'+f.domain+'/login',username:'golden-private@example.com',password:'golden-private-password-2026'};const a=await vault.prepare(input),recovered=await vault.prepare(input);assert.equal(a.id,recovered.id);f.credentials={...vault.credentials(a.id,input.loginUrl),code:'123456'};f.privateDeposit=deposit(f.address)+'<p>Signed in</p>';const depositHtml='<p>Loading authenticated payment information</p>';const verify='<form onsubmit="showDeposit(event)"><input autocomplete="one-time-code"><button>Verify normally</button></form>';f.html=wrap(`<script>window.showVerification=e=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(verify)}};window.showDeposit=e=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(depositHtml)}};</script><form onsubmit="showVerification(event)"><p>Login required. Sign in to access deposit information.</p><input name="email"><input type="password" autocomplete="current-password"><button>Sign in normally</button></form>`);}
 for(const f of fixtures)assert.ok(!JSON.stringify(privateStore.data).includes(f.credentials?.password??'golden-private-password-2026'));
 const fixtureFile=join(work,'fixtures.json');writeFileSync(fixtureFile,JSON.stringify(fixtures));
 const rendered=runPython('tests/v10-rendered.py',{args:[fixtureFile],cwd:repoRoot,timeout:120000});
 const browser=JSON.parse(rendered.trim().split(/\r?\n/).at(-1));
 for(const fixture of fixtures){
  // Independent scenario time windows; retain the production per-scenario rate limit.
  main.sql.exec('DELETE FROM rate_limit_windows');
  const started=performance.now(),c=browser.results.find(c=>c.domain===fixture.domain);assert.deepEqual(c.page_errors,[]);
  const discoverDir=join(work,'discovery-'+fixture.name);mkdirSync(discoverDir);const corpus=join(discoverDir,'corpus.json');
  const indicator='<p>Investment plans: guaranteed 3% daily profit. Minimum deposit $25. Staking platform. Referral bonus. Cloud mining. Withdrawal tax required before release.</p>';
  writeFileSync(corpus,JSON.stringify({seed:fixture.domain,pages:{[fixture.domain]:{html:fixture.html.replace('</body>',indicator+'</body>'),links:[]}}}));
  ok(await main.call('POST','/api/v1/modules/site_finder/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:discover','site:relate'],supported_event_types:[]},KEYS.site_finder));
  ok(await main.call('POST','/api/v1/modules/site_investigator/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:investigate'],supported_event_types:[]},KEYS.site_investigator));
  const request_id='golden-start-'+fixture.name;let start=ok(await main.call('POST','/api/v1/autonomy',{request_id}));
  await bridge('finder',KEYS.site_finder,corpus,discoverDir);
  if(process.env.AUTONOMY_TRACE)console.log('FINDER_TRACE',JSON.stringify({trace:moduleTrace.at(-1),candidates:main.all('SELECT id,canonical_domain,status,details FROM inbox_candidates')}));
  start=ok(await main.call('GET','/api/v1/autonomy/search/'+request_id));
  // Normal workers may first drain a previous investigation's queued discovery.
  // Drive bounded ordinary worker/poll cycles instead of assuming the first claim is ours.
  for(let round=0;round<12&&start.state==='Finding site';round++){await bridge('finder',KEYS.site_finder,corpus,discoverDir);start=ok(await main.call('GET','/api/v1/autonomy/search/'+request_id));}
  assert.equal(start.state,'Investigating',JSON.stringify(start));const inv=start.investigation_id;
  const resumed=ok(await main.call('POST','/api/v1/autonomy',{request_id}));assert.equal(resumed.investigation_id,inv,'lost acknowledgement resumes selection');
  assert.equal(main.n('SELECT COUNT(*) n FROM inbox_decisions'),0,'automatic selection never records analyst useful vote');
  await bridge('investigator',KEYS.site_investigator,corpus,discoverDir);
  // Keep real public workers available; ordinary maintenance owns follow-up work.
  // This API replay models a lost start acknowledgement, not another counted operator action.
  if(fixture.name==='outage')outage.add(fixture.address.toLowerCase());
  ok(await main.call('POST','/api/v1/ops/tick',{}));
  if(fixture.name==='login')assert.equal(ok(await main.call('GET',`/api/v1/investigations/${inv}/autonomy`)).state,'Waiting for login');
  let seq=0;
  const send=async o=>{const t=new Date().toISOString(),id=createHash('sha256').update(`${fixture.domain}:${o.address}:${o.context.class}:${seq++}`).digest('hex'),wire={id,type:'wallet.observation',schemaVersion:'2.0.0',occurredAt:t,source:'CryptoWalletLogger',sourceVersion:'0.9.0',payload:{...o,observationId:id,page:{domain:fixture.domain,url:`https://${fixture.domain}/deposit`,title:'Account payment information'},firstSeen:t,lastSeen:t,seenCount:1}};ok(await main.call('POST','/api/v1/compat/logger',wire,KEYS.crypto_wallet_logger));ok(await main.call('POST','/api/v1/compat/logger',wire,KEYS.crypto_wallet_logger));};
  for(const o of c.observations)await send(o);
  for(let k=0;k<8;k++){if(!await wi.tick())break;}
  let relatedProof=null;
  if(fixture.name==='related'){
   const dir=join(work,'related');mkdirSync(dir);const file=join(dir,'corpus.json'),child='v10-related-next.example';
   const body=deposit(fixture.address)+`<p>Investment plans: guaranteed 3% daily profit. Minimum deposit $25. Staking platform. Referral bonus. Cloud mining. Withdrawal tax required before release.</p><a href="https://t.me/v10support">Public support</a>`;
   writeFileSync(file,JSON.stringify({seed:fixture.domain,pages:{[fixture.domain]:{html:wrap(body+`<a href="https://${child}">Related public deployment</a>`),links:[child]},[child]:{html:wrap(body),links:[]}}}));
   for(const [mod,cap] of [['site_finder',['site:discover','site:relate']],['site_investigator',['site:investigate']]])ok(await main.call('POST',`/api/v1/modules/${mod}/register`,{module_version:'v9',schema_version:'3.0',capabilities:cap,supported_event_types:[]},KEYS[mod]));
   for(let r=0;r<8;r++){
    main.sql.exec('DELETE FROM rate_limit_windows');
    ok(await main.call('POST',`/api/v1/investigations/${inv}/director`,{}));
    await bridge('investigator',KEYS.site_investigator,file,dir);
    ok(await main.call('POST','/api/v1/ops/tick',{}));
    await bridge('finder',KEYS.site_finder,file,dir);
    if(main.one("SELECT id FROM inbox_candidates WHERE canonical_domain=?",child)){relatedProof={domain:child,source:'real Finder public discovery'};break;}
   }
   assert.ok(relatedProof,'related case must actually discover a new deployment');
   // Drain automatic public follow-up and retire available workers before the
   // isolated approval stage. Module reconnection is handled by maintenance.
   for(let r=0;r<4;r++){await bridge('investigator',KEYS.site_investigator,file,dir);await bridge('finder',KEYS.site_finder,file,dir);}
   main.sql.exec("UPDATE module_registry SET last_heartbeat_at='2000-01-01' WHERE module_name IN ('site_finder','site_investigator')");
  }
  if(fixture.name==='wallet-change')await send({...c.observations.find(o=>o.context.class==='deposit'),address:evm(250)});
  if(fixture.name==='main-restart'){const port=Number(new URL(main.url).port);await main.close();main=await startMain({dbFile:path,work,port,extra,label:'v10-restarted'});}
  for(let i=0;i<10;i++){
   for(let k=0;k<8;k++){if(!await wi.tick())break;}
   ok(await main.call('POST','/api/v1/ops/tick',{}));
   await bridge('investigator',KEYS.site_investigator,corpus,discoverDir);
   await bridge('finder',KEYS.site_finder,corpus,discoverDir);
   ok(await main.call('POST',`/api/v1/investigations/${inv}/director`,{}));
   if(fixture.name==='outage'&&i===0){assert.ok(main.n("SELECT COUNT(*) n FROM director_retries WHERE investigation_id=? AND status='parked'",inv));outage.clear();main.sql.exec("UPDATE director_retries SET next_at='2000-01-01';UPDATE director_provider_health SET next_probe_at='2000-01-01'");}
   const view=ok(await main.call('GET',`/api/v1/investigations/${inv}/autonomy`));if(view.state==='Ready for approval')break;
  }
  let view=ok(await main.call('GET',`/api/v1/investigations/${inv}/autonomy`));const readinessMs=Math.round(performance.now()-started),readinessJobs=main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',inv);const normal=!['ambiguous','no-wallet','unsafe'].includes(fixture.name);
  if(process.env.AUTONOMY_TRACE)console.log('READINESS_TRACE',JSON.stringify({director:main.one('SELECT * FROM director_investigations WHERE investigation_id=?',inv),work:main.all('SELECT kind,status,job_id,reason FROM work_items WHERE investigation_id=?',inv),jobs:main.all('SELECT job_type,status FROM jobs WHERE investigation_id=?',inv)}));
  if(normal){assert.equal(view.state,'Ready for approval',`${fixture.name}: ${JSON.stringify(view)}`);assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='PREPARE_REPORT'",inv),0);
   const report=view.report;ok(await main.call('PATCH',`/api/v1/investigations/${inv}/report`,{candidate_id:report.id,action:'approve',reason:'Fixture operator reviewed the exact report.',content_sha256:report.content_sha256}));
   process.chdir(join(work,'form'));try{await form.tick();await form.tick();}finally{process.chdir(cwd);}
   view=ok(await main.call('GET',`/api/v1/investigations/${inv}/autonomy`));assert.equal(view.state,'Submitted');assert.equal(main.one('SELECT verification_status FROM report_candidates WHERE id=?',report.id).verification_status,'verified');
  }else{assert.ok(['Needs you','Parked','Waiting for login'].includes(view.state),`non-reportable case must stop: ${view.state}`);assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='PREPARE_REPORT'",inv),0);}
  const actualDeposit=c.observations.filter(o=>o.context.class==='deposit'),target=c.observations.some(o=>o.address.toLowerCase()===fixture.address.toLowerCase()&&o.context.class==='deposit');
  if(normal)assert.ok(target,`${fixture.name}: scanner missed deposit wallet`);
  if(fixture.name==='decoys'){assert.ok(actualDeposit.every(o=>o.address.toLowerCase()===fixture.address.toLowerCase()),'decoys cannot be promoted');assert.equal(main.n("SELECT COUNT(*) n FROM jobs j WHERE investigation_id=? AND job_type='ANALYZE_WALLET' AND json_extract(payload,'$.pipeline') IS NULL AND NOT EXISTS(SELECT 1 FROM observation_versions v WHERE v.entity_id=j.target_entity_id AND v.source_module IN ('site_investigator','crypto_wallet_logger'))",inv),0,'legacy analysis cannot re-analyse its own projection without upstream page evidence');}
  assert.equal(main.n("SELECT COUNT(*) n FROM (SELECT dedupe_key FROM jobs WHERE investigation_id=? AND status IN ('pending','running','retrying') GROUP BY dedupe_key HAVING COUNT(*)>1)",inv),0);
  assert.equal(main.n('SELECT COUNT(*) n FROM (SELECT evidence_sha256 FROM report_candidates WHERE investigation_id=? GROUP BY evidence_sha256 HAVING COUNT(*)>1)',inv),0);
  rows.push({scenario:fixture.name,related_discovery:relatedProof,state:view.state,human_actions:1+(normal?1:0)+c.human_browsing_actions.length,human_action_events:[{action:'Start Investigation'},...c.human_browsing_actions,...(normal?[{action:'Approve & Submit'}]:[])],manual_tool_transitions:0,deposit_recall:normal?Number(target):null,deposit_precision:actualDeposit.length?actualDeposit.filter(o=>o.address.toLowerCase()===fixture.address.toLowerCase()).length/actualDeposit.length:null,validated_wallets:main.n("SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=? AND validation_status='valid' AND best_context='deposit'",inv),automatic_reports:normal?1:0,jobs:readinessJobs,total_jobs_after_submission:main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',inv),time_to_readiness_ms:readinessMs,duplicate_jobs:0,duplicate_reports:0,unnecessary_questions:normal?main.n("SELECT COUNT(*) n FROM autonomy_checkpoints WHERE investigation_id=? AND status='open' AND kind<>'final_approval'",inv):0});
  console.log('PASS',JSON.stringify(rows.at(-1)));if(process.env.AUTONOMY_TRACE)console.log('TRACE',JSON.stringify({jobs:main.all('SELECT job_type,status,trigger_reason,payload,result,last_error FROM jobs WHERE investigation_id=?',inv),wallets:main.all('SELECT * FROM wallet_candidates WHERE investigation_id=?',inv)}));
 }
 const result={ok:true,scenarios:rows,submissions:submissions.length,provider_adapter_calls:calls,module_trace:moduleTrace,rendered_scope:browser.scope,private_account_recovery:true,metric_limits:'Fixture browser interactions are individually counted. API acknowledgement replays, independent rate-limit windows, clock acceleration and automatic scheduler/worker steps are not human actions. Timing excludes shared browser fixture preparation; no live-provider accuracy claim.'};
 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/golden.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e);process.exitCode=1;}finally{process.chdir(cwd);await main?.close();if(process.env.AUTONOMY_TRACE)console.log('DEBUG_DB',path);else rmSync(work,{recursive:true,force:true});}
