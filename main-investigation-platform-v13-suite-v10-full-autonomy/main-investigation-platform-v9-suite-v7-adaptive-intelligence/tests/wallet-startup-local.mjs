import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {fileHref,removeDir,stopChild} from './lib/portable.mjs';

const moduleRoot=resolve('integrations/wallet-investigator');
const require=createRequire(join(moduleRoot,'package.json'));
const loader=fileHref(require.resolve('tsx'));
const temp=await mkdtemp(join(tmpdir(),'wallet-normal-startup-'));
const server=net.createServer();
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const port=server.address().port;
await new Promise(done=>server.close(done));
let child;
try{
  const seed=`import {initDatabase,runStatement} from ${JSON.stringify(fileHref(join(moduleRoot,'server/db/database.ts')))};
import {runMigrations} from ${JSON.stringify(fileHref(join(moduleRoot,'server/db/migrations.ts')))};
import {globalMainPlatform} from ${JSON.stringify(fileHref(join(moduleRoot,'server/integration/main_platform_v6.ts')))};
await initDatabase();await runMigrations();
const job=globalMainPlatform.handleIncomingJob({job_id:'synthetic-restart-job',job_type:'ANALYZE_WALLET',investigation_id:'synthetic-investigation',correlation_id:'synthetic-correlation',address:'0x71c841094df8cf7fa128565551f337f74c7dbb94',claimed_network:'ethereum',profile:'STANDARD'});
if(!job.accepted||!job.job_id)throw Error(job.message);
runStatement("UPDATE analysis_jobs SET status='RUNNING' WHERE id=?",[job.job_id]);process.exit(0);`;
  const seeded=spawnSync(process.execPath,['--import',loader,'--input-type=module','-e',seed],{cwd:temp,env:{...process.env,WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES:'1'},encoding:'utf8',timeout:20000});
  assert.equal(seeded.status,0,seeded.stderr||seeded.stdout);
  const dbPath=join(temp,'data/wallet_investigator.sqlite');
  const status=()=>{const db=new DatabaseSync(dbPath,{readOnly:true});try{return db.prepare("SELECT status,current_step FROM analysis_jobs LIMIT 1").get();}finally{db.close();}};
  assert.equal(status()?.status,'RUNNING');
  child=spawn(process.execPath,['--import',loader,join(moduleRoot,'server.ts')],{cwd:temp,env:{...process.env,WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES:'1',NODE_ENV:'development',PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  const deadline=Date.now()+25000;let recovered=false;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw Error(`Wallet server exited before recovery: ${logs}`);
    const row=status();
    if(['COMPLETED','PARTIAL'].includes(row?.status)){recovered=true;break;}
    await new Promise(done=>setTimeout(done,300));
  }
  assert.ok(recovered,`Normal server entry did not recover and process the persisted job: ${JSON.stringify(status())} ${logs}`);
  assert.match(logs,/Recovering interrupted job/);
  console.log(JSON.stringify({ok:true,real_module_entry:true,synthetic_provider:true,restarted_job:status()?.status}));
}finally{
  await stopChild(child);
  await removeDir(temp);
}
