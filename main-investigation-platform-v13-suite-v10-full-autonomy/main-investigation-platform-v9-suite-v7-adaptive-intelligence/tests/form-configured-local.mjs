import {importFrom} from './lib/portable.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
const base=process.cwd(),temp=await mkdtemp(join(tmpdir(),'mip-configured-report-'));let receiver;
try{
 process.chdir(temp);
 await build({entryPoints:[join(base,'integrations/form-submitter/server/integration/platform_worker.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'worker.mjs')});
 const {ReportWorker,durableStorage}=await importFrom(temp,'worker.mjs');
 let submissions=0;receiver=createServer((request,response)=>{let data='';request.on('data',chunk=>data+=chunk);request.on('end',()=>{submissions++;assert.match(data,/entry\.1=/);response.writeHead(200);response.end('Your response has been recorded');});});await new Promise(done=>receiver.listen(0,'127.0.0.1',done));
 const originalFetch=globalThis.fetch,endpoint=`http://127.0.0.1:${receiver.address().port}`;
 globalThis.fetch=(url,options)=>{assert.match(String(url),/^https:\/\/docs\.google\.com\/forms\/d\/e\/TestLocal\//);return originalFetch(endpoint,options);};
 const now=new Date().toISOString(),formUrl='https://docs.google.com/forms/d/e/TestLocal/viewform',schema={formId:'TestLocal',formTitle:'Synthetic',formUrl,versionHash:'synthetic-hash',sections:[],allQuestions:[{id:'1',entryKey:'entry.1',title:'Site URL',type:'TEXT',required:true,pageIndex:1}],parsedAt:now};
 durableStorage.syncFullState({settings:{username:'synthetic-analyst',teamInviteCode:'synthetic-code',autoSubmitGlobalEnabled:true},formConfig:{formUrl,formId:'TestLocal',formTitle:'Synthetic',formVersionHash:'synthetic-hash',verifiedAt:now,parsedSchema:schema,fieldMappings:[{id:'site',fieldKey:'siteUrl',label:'Site URL',entryKey:'entry.1',pageIndex:1,required:true}],multiWalletFormat:'COMBINED_LIST'}});
 const inv=crypto.randomUUID(),site=crypto.randomUUID(),wallet=crypto.randomUUID(),e1=crypto.randomUUID(),e2=crypto.randomUUID(),jobId=crypto.randomUUID(),candidateId=crypto.randomUUID();const frozen=JSON.stringify({investigation_id:inv,evidence:[{id:e1},{id:e2}]});const candidate={id:candidateId,status:'ready',submission_job_id:jobId,evidence_snapshot:frozen,evidence_sha256:crypto.createHash('sha256').update(frozen).digest('hex')};const context={entities:[{id:site,entity_type:'site',canonical_key:'synthetic.test'},{id:wallet,entity_type:'wallet',canonical_key:'ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'}],relationships:[{id:'rel',source_entity_id:site,target_entity_id:wallet}],relationship_evidence:[{relationship_id:'rel',evidence_id:e1}],evidence:[{id:e1},{id:e2}]};
 const calls=[],worker=new ReportWorker('http://127.0.0.1:8080','synthetic-key');worker.request=async(path,method,body)=>{calls.push({path,method,body});if(path.includes('/jobs/claim'))return{job:{id:jobId,job_type:'PREPARE_REPORT',investigation_id:inv,target_entity_id:site,correlation_id:'synthetic-correlation'}};if(path.includes('/report?'))return{candidates:[candidate]};if(path.includes('/context?'))return context;if(path.includes('/ingest/form_submitter')){context.evidence.push({id:crypto.randomUUID(),source_module:'form_submitter',source_record_id:body.records.evidence[0].external_id});return{error_count:0}};return{accepted:true};};
 await worker.register();await worker.tick();assert.equal(submissions,1,'configured production adapter must make real loopback HTTP submission');assert.equal(durableStorage.getState().findings[0].submissionState,'COMPLETED');assert.ok(calls.some(c=>c.body?.events?.some(event=>event.event_type==='report.completed'&&event.payload?.verified===true)),'verified event must follow persisted receipt');await worker.tick();assert.equal(submissions,1,'duplicate claimed job may not resubmit');globalThis.fetch=originalFetch;
 console.log(JSON.stringify({ok:true,real_form_source:true,configured_adapter:true,synthetic_receiver:true,submissions,duplicate_blocked:true}));
}finally{if(receiver)await new Promise(done=>receiver.close(done));process.chdir(base);await rm(temp,{recursive:true,force:true});}
