import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import {fileHref,removeDir,stopChild} from './lib/portable.mjs';

const moduleRoot=resolve('integrations/form-submitter');
const loader=fileHref(createRequire(join(moduleRoot,'package.json')).resolve('tsx'));
const temp=await mkdtemp(join(tmpdir(),'form-normal-startup-'));
const inv=crypto.randomUUID(),site=crypto.randomUUID(),wallet=crypto.randomUUID();
const e1=crypto.randomUUID(),e2=crypto.randomUUID(),jobId=crypto.randomUUID(),candidateId=crypto.randomUUID();
const frozen=JSON.stringify({investigation_id:inv,evidence:[{id:e1},{id:e2}]});
const candidate={id:candidateId,status:'ready',submission_job_id:jobId,evidence_snapshot:frozen,evidence_sha256:crypto.createHash('sha256').update(frozen).digest('hex')};
const context={entities:[{id:site,entity_type:'site',canonical_key:'synthetic.test'},{id:wallet,entity_type:'wallet',canonical_key:'ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'}],relationships:[{id:'synthetic-relationship',source_entity_id:site,target_entity_id:wallet}],relationship_evidence:[{relationship_id:'synthetic-relationship',evidence_id:e1}],evidence:[{id:e1},{id:e2}]};
let claims=0,submissions=0,completed=0;
const platform=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  if(request.url==='/synthetic-form'){
    assert.match(raw,/entry\.1=/);
    submissions++;
    response.writeHead(200,{'content-type':'text/html'});
    response.end('Your response has been recorded');
    return;
  }
  const body=raw?JSON.parse(raw):{};
  assert.equal(request.headers['x-api-key'],'synthetic-form-key');
  let result={accepted:true};
  if(request.url?.endsWith('/jobs/claim'))result={job:claims++?null:{id:jobId,job_type:'PREPARE_REPORT',investigation_id:inv,target_entity_id:site,correlation_id:'synthetic-correlation'}};
  else if(request.url?.includes('/report?'))result={candidates:[candidate]};
  else if(request.url?.includes('/context?'))result=context;
  else if(request.url?.endsWith('/ingest/form_submitter')){
    context.evidence.push({id:crypto.randomUUID(),source_module:'form_submitter',source_record_id:body.records.evidence[0].external_id});
    result={error_count:0};
  }else if(request.url?.endsWith(`/jobs/${jobId}`)&&body.action==='complete')completed++;
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify(result));
});
await new Promise(done=>platform.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${platform.address().port}`;
const portProbe=net.createServer();await new Promise(done=>portProbe.listen(0,'127.0.0.1',done));
const modulePort=portProbe.address().port;await new Promise(done=>portProbe.close(done));
let child;
try{
  const now=new Date().toISOString(),formUrl='https://docs.google.com/forms/d/e/TestLocal/viewform';
  const schema={formId:'TestLocal',formTitle:'Synthetic',formUrl,versionHash:'synthetic-hash',sections:[],allQuestions:[{id:'1',entryKey:'entry.1',title:'Site URL',type:'TEXT',required:true,pageIndex:1}],parsedAt:now};
  const seed=`import {durableStorage} from ${JSON.stringify(fileHref(join(moduleRoot,'server/durableStorage.ts')))};durableStorage.syncFullState(${JSON.stringify({settings:{username:'synthetic-analyst',teamInviteCode:'synthetic-code',autoSubmitGlobalEnabled:true},formConfig:{formUrl,formId:'TestLocal',formTitle:'Synthetic',formVersionHash:'synthetic-hash',verifiedAt:now,parsedSchema:schema,fieldMappings:[{id:'site',fieldKey:'siteUrl',label:'Site URL',entryKey:'entry.1',pageIndex:1,required:true}],multiWalletFormat:'COMBINED_LIST'}})});`;
  const seeded=spawnSync(process.execPath,['--import',loader,'--input-type=module','-e',seed],{cwd:temp,encoding:'utf8',timeout:20000});
  assert.equal(seeded.status,0,seeded.stderr||seeded.stdout);
  const shim=join(temp,'localhost-form-shim.mjs');
  await writeFile(shim,`const upstream=globalThis.fetch;globalThis.fetch=(url,options)=>{if(String(url).startsWith('https://docs.google.com/forms/d/e/TestLocal/'))return upstream(${JSON.stringify(base+'/synthetic-form')},options);return upstream(url,options);};`);
  child=spawn(process.execPath,['--import',fileHref(shim),'--import',loader,join(moduleRoot,'server.ts')],{cwd:temp,env:{...process.env,MAIN_PLATFORM_URL:base,FORM_SUBMITTER_MODULE_KEY:'synthetic-form-key',NODE_ENV:'development',PORT:String(modulePort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  const deadline=Date.now()+25000;
  while(Date.now()<deadline&&completed===0){
    if(child.exitCode!==null)throw Error(`Form server exited before worker processed the persisted candidate: ${logs}`);
    await new Promise(done=>setTimeout(done,250));
  }
  assert.equal(completed,1,`Normal form server did not process configured job: ${logs}`);
  assert.equal(submissions,1);
  const saved=JSON.parse(await readFile(join(temp,'data/submitter_db.json'),'utf8'));
  assert.equal(saved.findings.find(f=>f.id===candidateId)?.submissionState,'COMPLETED');
  console.log(JSON.stringify({ok:true,real_module_entry:true,configured_submission:true,synthetic_receiver:true,submissions,completed}));
}finally{
  await stopChild(child);
  await new Promise(done=>platform.close(done));
  await removeDir(temp);
}
