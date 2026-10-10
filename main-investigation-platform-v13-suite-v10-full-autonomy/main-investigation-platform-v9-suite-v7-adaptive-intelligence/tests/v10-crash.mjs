// Real process termination at v10 durable handoffs. Lease clocks are advanced only after restart.
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';import {localPath} from './lib/portable.mjs';
const libraries=['lib/autonomy-search.ts','lib/missions.ts'];
const cases=[['search-created','INSERT OR IGNORE INTO autonomy_searches','statement','search'],['selection','INSERT OR IGNORE INTO autonomy_candidate_claims','batch','search'],['site-created','INSERT OR IGNORE INTO investigations','batch','search'],['mission-created','INSERT OR IGNORE INTO autonomous_missions','batch','search'],['search-attached',"SET state='Investigating'",'batch','search'],['child-reserved','INSERT OR IGNORE INTO mission_opportunities','batch','child'],['child-site-created','INSERT OR IGNORE INTO investigations','batch','child'],['child-attached','UPDATE mission_opportunities SET status','statement','child'],['mission-history','INSERT OR IGNORE INTO mission_history','batch','child']];
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
const action=(m,c)=>c.kind==='search'?m.library['lib/autonomy-search.ts'].startInvestigation('crash-search-0001'):m.library['lib/missions.ts'].missionTick(20);
if(process.argv[2]==='child'){
 const c=JSON.parse(process.env.V10_CRASH_CONFIG);let m,killed=false;
 m=await startMain({dbFile:c.file,work:c.dir,libraryFiles:libraries,faultHook:(phase,sql)=>{if(!killed&&phase===c.phase&&sql.includes(c.match)){killed=true;process.kill(process.pid,'SIGKILL');}},extra:async(req,res,url)=>{if(url.pathname!=='/v10-crash-action')return false;try{await action(m,c);res.writeHead(200);res.end('done');}catch(e){res.writeHead(500);res.end(String(e));}return true;}});console.log(JSON.stringify({url:m.url}));await new Promise(()=>{});
}else{
 const work=mkdtempSync(join(tmpdir(),'v10-kill-')),results=[];let current,child;
 try{for(const [name,match,unit,kind] of cases)for(const edge of ['before','after']){
  const dir=join(work,String(results.length));mkdirSync(dir);const file=join(dir,'main.sqlite');applyMigrations(file);
  current=await startMain({dbFile:file,work:dir,libraryFiles:libraries});
  ok(await current.call('POST','/api/v1/modules/site_investigator/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:investigate'],supported_event_types:[]},MODULE_KEYS.site_investigator));
  if(kind==='child')ok(await current.call('POST','/api/v1/autonomy',{site:'parent-crash.example'}));
  const domain=kind==='child'?'child-crash.example':'selected-crash.example';
  current.sql.prepare("INSERT INTO inbox_candidates(id,canonical_domain,url,score,status,related_domains,details) VALUES ('crash-candidate',?,?,.9,'ready',?,?)").run(domain,'https://'+domain,JSON.stringify(kind==='child'?['parent-crash.example']:[]),JSON.stringify({signals:[{name:'daily_return',group:'promise',origin_id:domain},{name:'deposit_address',group:'wallet',origin_id:domain}]}));
  await current.close();current=null;const c={file,dir,kind,phase:edge+'_'+unit,match};
  child=spawn(process.execPath,['--experimental-sqlite','--import','tsx',localPath('./v10-crash.mjs',import.meta.url),'child'],{env:{...process.env,V10_CRASH_CONFIG:JSON.stringify(c)},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);const ended=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  const url=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;for(const line of out.trim().split(/\r?\n/))try{const v=JSON.parse(line);if(v.url)resolve(v.url);}catch{}});child.once('exit',()=>reject(Error(err)));});
  const timer=setTimeout(()=>child.kill('SIGTERM'),15000);const response=await fetch(url+'/v10-crash-action').then(r=>r.text()).catch(()=>null),exit=await ended;clearTimeout(timer);child=null;assert.equal(exit.signal,'SIGKILL',name+' '+edge+' fault was not reached: '+response+' '+err);
  current=await startMain({dbFile:file,work:dir,libraryFiles:libraries,label:'recovered'});
  current.sql.exec("UPDATE autonomy_searches SET lease_until='2000-01-01';UPDATE mission_resources SET lease_until='2000-01-01'");
  await action(current,c);await action(current,c);
  const expected=kind==='child'?2:1;assert.equal(current.n('SELECT COUNT(*) n FROM investigations'),expected);assert.equal(current.n('SELECT COUNT(*) n FROM autonomous_missions'),expected);
  assert.equal(current.n("SELECT COUNT(*) n FROM inbox_candidates WHERE id='crash-candidate'"),1);
  assert.equal(current.n("SELECT COUNT(*) n FROM (SELECT dedupe_key FROM jobs WHERE status IN ('pending','running','retrying') GROUP BY dedupe_key HAVING COUNT(*)>1)"),0);
  assert.equal(current.n('SELECT COUNT(*) n FROM jobs WHERE job_type=\'INVESTIGATE_SITE\''),expected);
  assert.equal(current.n('SELECT COUNT(*) n FROM (SELECT job_id FROM mission_reservations GROUP BY job_id HAVING COUNT(*)>1)'),0);
  if(kind==='child'){assert.equal(current.one('SELECT sites FROM mission_resources').sites,2);assert.equal(current.one('SELECT status FROM mission_opportunities').status,'attached');}
  else{assert.equal(current.one('SELECT state FROM autonomy_searches').state,'Investigating');assert.equal(current.n('SELECT COUNT(*) n FROM autonomy_candidate_claims'),1);}
  results.push({phase:name,edge,signal:exit.signal,investigations:expected,duplicate_active_jobs:0,source_candidate_preserved:true});console.log('PASS',edge,name);await current.close();current=null;
 }
 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/crash.json',JSON.stringify({ok:true,crashes:results.length,results,scope:'Real SIGKILL before/after SQLite statement or batch; production v10 functions and routes. After restart lease expiry is accelerated. Remote D1, installed Chrome and mailbox/form server process termination are not certified here.'},null,2));
 }finally{child?.kill('SIGTERM');await current?.close();rmSync(work,{recursive:true,force:true});}
}
