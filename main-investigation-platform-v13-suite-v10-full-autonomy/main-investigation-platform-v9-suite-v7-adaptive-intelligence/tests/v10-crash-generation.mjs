// Real process death around durable Finder generation; completed worker result may precede Main recovery.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const libraries=['lib/autonomy-search.ts'],requestId='generation-crash-001';
const ok=r=>{assert.equal(r.status,202,JSON.stringify(r.body));return r.body;};
if(process.argv[2]==='child'){
 const c=JSON.parse(process.env.GENERATION_CRASH_CONFIG);let killed=false;
 const main=await startMain({dbFile:c.file,work:c.dir,libraryFiles:libraries,faultHook:(phase,sql)=>{
  if(!killed&&phase===c.edge+'_batch'&&sql.includes("SELECT ?,'DISCOVER_SITES'")){killed=true;process.kill(process.pid,'SIGKILL');}
 },extra:async(req,res,url)=>{
  if(url.pathname!=='/generation-action')return false;
  await main.library['lib/autonomy-search.ts'].startInvestigation(requestId);res.writeHead(200);res.end('done');return true;
 }});
 console.log(JSON.stringify({url:main.url}));await new Promise(()=>{});
}else{
 const work=mkdtempSync(join(tmpdir(),'generation-kill-')),results=[];let main,child;
 try{for(const edge of ['before','after']){
  const dir=join(work,edge);mkdirSync(dir);const file=join(dir,'main.sqlite');applyMigrations(file);
  main=await startMain({dbFile:file,work:dir,libraryFiles:libraries});
  const registration=await main.call('POST','/api/v1/modules/site_finder/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:discover','site:relate'],supported_event_types:[]},MODULE_KEYS.site_finder);assert.equal(registration.status,200);
  for(let i=0;i<3;i++){
   const search=ok(await main.call('POST','/api/v1/autonomy',{request_id:requestId}));assert.equal(search.generation,i+1);
   main.sql.prepare("UPDATE jobs SET status='completed' WHERE job_type='DISCOVER_SITES'").run();
  }
  await main.close();main=null;
  child=spawn(process.execPath,['--experimental-sqlite','--import','tsx',import.meta.filename,'child'],{env:{...process.env,GENERATION_CRASH_CONFIG:JSON.stringify({file,dir,edge})},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);
  const ended=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const url=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',d=>{text+=d;for(const line of text.trim().split(/\r?\n/))try{const v=JSON.parse(line);if(v.url)resolve(v.url);}catch{}});child.once('exit',()=>reject(new Error(err)));});
  const timer=setTimeout(()=>child.kill('SIGTERM'),15000);await fetch(url+'/generation-action').catch(()=>null);const exit=await ended;clearTimeout(timer);child=null;assert.equal(exit.signal,'SIGKILL');
  main=await startMain({dbFile:file,work:dir,libraryFiles:libraries,label:'recovery'});
  assert.equal(main.one('SELECT generation FROM autonomy_searches').generation,edge==='after'?4:3,'discovery generation must commit with its job');
  // The remote Finder may have completed its durable job before Main restarts.
  main.sql.exec("UPDATE jobs SET status='completed' WHERE job_type='DISCOVER_SITES';UPDATE autonomy_searches SET lease_until='2000-01-01';UPDATE inbox_supply_lock SET until_at='2000-01-01'");
  ok(await main.call('POST','/api/v1/autonomy',{request_id:requestId}));
  const search=ok(await main.call('POST','/api/v1/autonomy',{request_id:requestId}));assert.equal(search.state,'Parked');assert.equal(search.generation,4);
  assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES'"),4,'lost acknowledgement cannot allocate a fifth discovery generation');
  assert.equal(main.n('SELECT COUNT(*) n FROM investigations'),0);assert.equal(main.n('SELECT COUNT(*) n FROM inbox_decisions'),0);
  results.push({edge,signal:exit.signal,discovery_jobs:4,generation:4,state:search.state});console.log('PASS generation',edge);await main.close();main=null;
 }
 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/crash-generation.json',JSON.stringify({ok:true,results,scope:'Actual SIGKILL before/after local SQLite D1 batch. Finder completion before recovery and lease expiry are fixtures; no remote D1 process certification.'},null,2));
 }finally{child?.kill('SIGTERM');await main?.close();rmSync(work,{recursive:true,force:true});}
}
