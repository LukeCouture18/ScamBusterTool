/** Canonical platform job adapter. The original wallet engine performs the analysis. */
import {initDatabase,queryAll,queryFirst,runStatement} from '../db/database';
import {runMigrations} from '../db/migrations';
import {globalJobQueue} from '../jobs/job_queue';
import {globalMainPlatform} from './main_platform_v6';
import {toContractNetwork,validateWalletAddress,type NetworkHint} from '../crypto/validation';

import {globalProviderManager} from '../providers/manager';
const moduleName='wallet_investigator';
type PlatformJob={id:string;job_type:string;investigation_id:string;target_entity_id:string;correlation_id:string;payload:string};
type ContextEntity={id:string;entity_type:string;canonical_key:string};
type ContextObservation={entity_id:string;source_module:string};
type AnalysisRow={status:string;error_message?:string;idempotency_key:string};
type WalletRow={id:string;resolved_network:string;network_ambiguity:number;validation_status:string;completeness:string;completeness_details_json:string};
type TransactionRow={id:string;network:string;tx_hash:string;raw_amount:string;asset:string;direction:string;provider:string;evidence_id:string;completeness:string};
type EvidenceRow={id:string;category:string;title:string;description:string;source_provider:string;provenance_id:string;raw_payload:string};
type CounterpartyRow={id:string;counterparty_address:string;network:string;tx_count:number;evidence_id:string};
type LinkRow={id:string;relationship_type:string;connected_wallet_address:string;network:string;evidence_id:string};
export class PlatformWorker {
 constructor(private base:string,private key:string){if(!/^https:\/\//.test(base)&&!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base))throw Error('Platform must be HTTPS or loopback');}
 async request(path:string,method='GET',body?:unknown){const response=await fetch(this.base.replace(/\/$/,'')+path,{method,headers:{'x-api-key':this.key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(response.status===204)return null;if(!response.ok)throw Error(`Platform ${method} ${path}: ${response.status}`);return response.json();}
 async register(){await this.request('/api/v1/modules/wallet_investigator/register','POST',{module_version:'1.0.0',schema_version:'3.0',capabilities:['wallet:analyze'],supported_event_types:[]});globalMainPlatform.connected();}
 async tick(){await this.request('/api/v1/modules/wallet_investigator/heartbeat','POST',{status:'idle',module_version:'1.0.0',schema_version:'3.0',capabilities:['wallet:analyze']});const claimed=await this.request('/api/v1/modules/wallet_investigator/jobs/claim','POST');if(claimed?.job)await this.process(claimed.job);return Boolean(claimed?.job);}
 async process(job:PlatformJob){const payload=parseJobPayload(job.payload);if(payload.pipeline==='wallet-v4')return this.processV4(job,payload);return this.processLegacy(job);}
 async processLegacy(job:PlatformJob){const patch=(action:string,extra:Record<string,unknown>={})=>this.request(`/api/v1/modules/wallet_investigator/jobs/${job.id}`,'PATCH',{action,...extra});let lease:ReturnType<typeof setInterval>|undefined;try{
  if(!['ANALYZE_WALLET','REFRESH_WALLET'].includes(job.job_type)||!job.investigation_id||!job.target_entity_id)throw Error('Invalid wallet job context');
  const context=await this.request(`/api/v1/investigations/${job.investigation_id}/context?module=wallet_investigator`);const entity=(context.entities as ContextEntity[]).find(e=>e.id===job.target_entity_id&&e.entity_type==='wallet');if(!entity)throw Error('Wallet entity is absent from investigation');
  const version=(context.observation_versions as ContextObservation[]).filter(v=>v.entity_id===entity.id&&['site_investigator','crypto_wallet_logger'].includes(v.source_module));if(!version.length)throw Error('No upstream wallet observations for this investigation');
  const key=String(entity.canonical_key);const separator=key.indexOf(':');const claimedNetwork=separator<0?'unknown':key.slice(0,separator),address=separator<0?key:key.slice(separator+1);const profile='STANDARD';
  const accepted=globalMainPlatform.handleIncomingJob({job_id:job.id,job_type:job.job_type as 'ANALYZE_WALLET'|'REFRESH_WALLET',investigation_id:job.investigation_id,correlation_id:job.correlation_id||job.id,address,claimed_network:claimedNetwork,profile});if(!accepted.accepted||!accepted.job_id)throw Error(accepted.message);
  lease=setInterval(()=>{this.request('/api/v1/modules/wallet_investigator/heartbeat','POST',{status:'running',module_version:'1.0.0',schema_version:'3.0',capabilities:['wallet:analyze'],current_job_id:job.id}).catch(()=>{});},45000);
  const deadline=Date.now()+180000;let result:AnalysisRow|undefined;do{result=queryFirst<AnalysisRow>('SELECT * FROM analysis_jobs WHERE id=?',[accepted.job_id])??undefined;if(['COMPLETED','PARTIAL','FAILED'].includes(result?.status??''))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  if(!result||result.status==='FAILED'||!['COMPLETED','PARTIAL'].includes(result.status))throw Error(result?.error_message||'Wallet analysis timed out');
  const wallet=queryFirst<WalletRow>('SELECT * FROM wallets WHERE id=?',[String(accepted.wallet_id)]);if(!wallet)throw Error('Wallet analysis has no durable wallet row');
  const base={investigation_id:job.investigation_id,confidence:.9,provenance:{source:'wallet_investigator',origin_job_id:job.id,correlation_id:job.correlation_id,local_wallet_id:wallet.id,completeness:wallet.completeness}};
  const transactions=queryAll<TransactionRow>('SELECT * FROM transactions WHERE wallet_id=?',[wallet.id]);const evidence=queryAll<EvidenceRow>('SELECT * FROM evidence_records WHERE wallet_id=?',[wallet.id]);const counterparties=queryAll<CounterpartyRow>('SELECT * FROM counterparties WHERE wallet_id=?',[wallet.id]);const links=queryAll<LinkRow>('SELECT * FROM connected_wallets WHERE source_wallet_id=?',[wallet.id]);
  const records={wallets:[{...base,external_id:`analysis:${job.id}`,address,network:wallet.resolved_network,classification:wallet.network_ambiguity?'needs_review':wallet.validation_status,completeness:wallet.completeness,completeness_details:wallet.completeness_details_json}],transactions:transactions.map(t=>({...base,external_id:t.id,canonical_key:`${t.network}:${t.tx_hash}:${t.id}`,tx_hash:t.tx_hash,amount:String(t.raw_amount),asset:t.asset,direction:t.direction,provider:t.provider,evidence_id:t.evidence_id,completeness:t.completeness})),counterparties:counterparties.map(c=>({...base,external_id:c.id,address:c.counterparty_address,network:c.network,tx_count:c.tx_count,evidence_id:c.evidence_id})),evidence:evidence.map(e=>({...base,external_id:e.id,evidence_type:e.category,evidence_class:'blockchain_fact',title:e.title,context_text:e.description,entity:{entity_type:'wallet',canonical_key:address,network:wallet.resolved_network},provenance:{...base.provenance,provider:e.source_provider,provenance_id:e.provenance_id,raw_payload:e.raw_payload}})),relationships:links.filter(l=>evidence.some(e=>e.id===l.evidence_id)).map(l=>({...base,external_id:l.id,relationship_type:l.relationship_type,assertion_kind:'derived',from:{entity_type:'wallet',canonical_key:address,network:wallet.resolved_network},to:{entity_type:'wallet',canonical_key:l.connected_wallet_address,network:l.network},evidence_ids:[l.evidence_id]}))};
  const ingested=await this.request('/api/v1/ingest/wallet_investigator','POST',{schema_version:'3.0',batch_id:`wallet-analysis:${job.id}`,sent_at:new Date().toISOString(),origin_job_id:job.id,records});if(ingested.error_count||ingested.status==='failed')throw Error(`Canonical ingest rejected ${ingested.error_count} rows`);
  runStatement("UPDATE main_platform_queue SET payload_json=json_set(payload_json,'$.entity_id',?,'$.platform_job_id',?) WHERE idempotency_key=?",[job.target_entity_id,job.id,String(result.idempotency_key)]);
  await patch(wallet.completeness==='PARTIAL'?'needs-review':'complete',{message:wallet.completeness==='PARTIAL'?'Provider returned partial history; analyst review required':'Analysis ingested',result:{completeness:wallet.completeness,transactions:transactions.length,counterparties:counterparties.length,evidence:evidence.length,relationships:records.relationships.length,ingestion_batch:`wallet-analysis:${job.id}`}});
  // Ingestion acknowledgement is not event-delivery acknowledgement. Keep the
  // event queued until /api/v1/events confirms acceptance; replay after outage.
  await globalMainPlatform.flushOutbox();
 }catch(error){await patch('fail',{error:error instanceof Error?error.message:String(error),retry:true}).catch(()=>{});throw error;}finally{if(lease)clearInterval(lease);}}
 /**
  * v4 pipeline (contract §2/§3): the address comes from the job payload with its case preserved
  * (Main lowercases canonical keys, so the entity key is never used to derive a base58 address).
  * Validation is always reported as a `wallets` ingest record; analysis runs only for a valid
  * address with a resolved network and analyze !== false.
  */
 async processV4(job:PlatformJob,payload:WalletV4Payload){const started=performance.now(),addressMeter=String(payload.address??''),networkMeter=typeof payload.network_hint==='object'&&payload.network_hint?String(payload.network_hint.network??''):String(payload.network_hint??''),beforeCalls=globalProviderManager.callsFor(addressMeter,networkMeter),beforeHttpCalls=globalProviderManager.httpCallsFor(addressMeter,networkMeter);const patch=(action:string,extra:Record<string,unknown>={})=>this.request(`/api/v1/modules/wallet_investigator/jobs/${job.id}`,'PATCH',{action,...extra});let lease:ReturnType<typeof setInterval>|undefined;let ingestedValidation=false;try{
  if(!['ANALYZE_WALLET','REFRESH_WALLET'].includes(job.job_type)||!job.investigation_id)throw Error('Invalid wallet job context');
  const address=typeof payload.address==='string'?payload.address.trim():'';
  const candidateId=typeof payload.wallet_candidate_id==='string'?payload.wallet_candidate_id:null;
  // Upstream observation versions are recorded for provenance only; in v4 the payload carries the address.
  const provenanceNotes:string[]=[];let upstreamSources:string[]=[];
  try{const context=await this.request(`/api/v1/investigations/${job.investigation_id}/context?module=wallet_investigator`);const versions=((context?.observation_versions??[]) as ContextObservation[]).filter(v=>(!job.target_entity_id||v.entity_id===job.target_entity_id)&&['site_investigator','crypto_wallet_logger'].includes(v.source_module));upstreamSources=[...new Set(versions.map(v=>v.source_module))];if(!versions.length)provenanceNotes.push('No upstream observation version found for the target entity; address taken from the job payload.');}catch(error){provenanceNotes.push(`Investigation context unavailable: ${error instanceof Error?error.message:String(error)}`);}
  const validation=validateWalletAddress(address,{candidateNetworks:Array.isArray(payload.candidate_networks)?payload.candidate_networks.filter((x):x is string=>typeof x==='string'):null,networkHint:payload.network_hint??null,family:typeof payload.family==='string'?payload.family:null});
  const valid=validation.status==='valid'&&Boolean(validation.network);
  const network=valid?String(validation.network):'unknown';
  const canonicalKey=valid?`${validation.network}:${validation.address_normalized}`:`${validation.family||'unknown'}:${validation.address_normalized}`;
  const analyze=payload.analyze!==false;
  const batchId=`wallet-v4:${job.id}`;
  const provenance={source:'wallet_investigator',origin_job_id:job.id,correlation_id:job.correlation_id,pipeline:'wallet-v4',wallet_candidate_id:candidateId,upstream_observation_sources:upstreamSources,provenance_notes:provenanceNotes};
  const confidence=valid?.9:validation.status==='network_ambiguous'?.5:validation.status==='unable_to_validate'?.3:.1;
  const walletRecord=(analysis:Record<string,unknown>,extra:Record<string,unknown>={})=>({investigation_id:job.investigation_id,external_id:batchId,canonical_key:canonicalKey,address,network,family:validation.family,classification:validation.status,confidence,completeness:analysis.completeness??'NOT_ANALYZED',...extra,data:{wallet_candidate_id:candidateId,validation,analysis},provenance:{...provenance,...(extra.provenance as Record<string,unknown>|undefined)}});
  const ingest=async(records:Record<string,unknown[]>)=>{const ingested=await this.request('/api/v1/ingest/wallet_investigator','POST',{schema_version:'3.0',batch_id:batchId,sent_at:new Date().toISOString(),origin_job_id:job.id,records});if(ingested?.error_count||ingested?.status==='failed')throw Error(`Canonical ingest rejected ${ingested?.error_count} rows`);};
  const summary={pipeline:'wallet-v4',wallet_candidate_id:candidateId,validation_status:validation.status,network,canonical_key:canonicalKey,ingestion_batch:batchId};
  if(!valid||!analyze){
   const reason=!valid?`Validation status ${validation.status}; analysis is only run for a valid address with a resolved network.`:'Validate-only job (analyze=false).';
   await ingest({wallets:[walletRecord({status:'SKIPPED',reason})]});ingestedValidation=true;
   await patch('complete',{message:`Wallet validated (${validation.status}); analysis not run`,result:{...summary,analysis:'SKIPPED',analysis_skipped_reason:reason}});
   return;
  }
  // Bounded analysis under the resolved network (existing engine).
  const profile='STANDARD';let analysisError:string|undefined;let result:AnalysisRow|undefined;let accepted:ReturnType<typeof globalMainPlatform.handleIncomingJob>|undefined;
  try{
   accepted=globalMainPlatform.handleIncomingJob({job_id:job.id,job_type:job.job_type as 'ANALYZE_WALLET'|'REFRESH_WALLET',investigation_id:job.investigation_id,correlation_id:job.correlation_id||job.id,address,claimed_network:network,profile,...(typeof payload.refresh_key==='string'?{refresh_key:payload.refresh_key}:{})},validation);
   if(!accepted.accepted||!accepted.job_id)throw Error(accepted.message);
   lease=setInterval(()=>{this.request('/api/v1/modules/wallet_investigator/heartbeat','POST',{status:'running',module_version:'1.0.0',schema_version:'3.0',capabilities:['wallet:analyze'],current_job_id:job.id}).catch(()=>{});},45000);
   const deadline=Date.now()+180000;do{result=queryFirst<AnalysisRow>('SELECT * FROM analysis_jobs WHERE id=?',[accepted.job_id])??undefined;if(['COMPLETED','PARTIAL','FAILED'].includes(result?.status??''))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
   if(!result||result.status==='FAILED'||!['COMPLETED','PARTIAL'].includes(result.status))throw Error(result?.error_message||'Wallet analysis timed out');
  }catch(error){analysisError=error instanceof Error?error.message:String(error);}
  const wallet=!analysisError&&accepted?.wallet_id?queryFirst<WalletRow>('SELECT * FROM wallets WHERE id=?',[String(accepted.wallet_id)]):null;
  if(analysisError||!wallet){
   // Engine failure (not a provider outage): validation is still reported, then the job is retried.
   const reason=analysisError||'Wallet analysis has no durable wallet row';
   await ingest({wallets:[walletRecord({status:'FAILED',reason})]});ingestedValidation=true;
   throw Error(reason);
  }
  const completeness=wallet.completeness;
  // Provider outage / truncated history: the engine records FAILED or PARTIAL completeness. The
  // analysis is reported as PARTIAL with the completeness details, never as complete.
  const partial=completeness!=='COMPLETE';
  let completenessDetails:unknown=wallet.completeness_details_json;try{completenessDetails=JSON.parse(wallet.completeness_details_json);}catch{/* keep raw text */}
  const completenessReason=partial?String((completenessDetails as {warning_message?:string})?.warning_message||`Provider data completeness is ${completeness}.`):undefined;
  const base={investigation_id:job.investigation_id,confidence:.9,provenance:{...provenance,local_wallet_id:wallet.id,completeness}};
  const transactions=queryAll<TransactionRow>('SELECT * FROM transactions WHERE wallet_id=?',[wallet.id]);const evidence=queryAll<EvidenceRow>('SELECT * FROM evidence_records WHERE wallet_id=?',[wallet.id]);const counterparties=queryAll<CounterpartyRow>('SELECT * FROM counterparties WHERE wallet_id=?',[wallet.id]);const links=queryAll<LinkRow>('SELECT * FROM connected_wallets WHERE source_wallet_id=?',[wallet.id]);
  const subject={entity_type:'wallet',canonical_key:canonicalKey,network};
  const analysis={status:partial?'PARTIAL':'COMPLETED',completeness,completeness_details:completenessDetails,...(completenessReason?{reason:completenessReason}:{}),transactions:transactions.length,counterparties:counterparties.length,evidence:evidence.length};
  const records={wallets:[walletRecord(analysis,{completeness,completeness_details:wallet.completeness_details_json,provenance:{local_wallet_id:wallet.id,completeness}})],transactions:transactions.map(t=>({...base,external_id:t.id,canonical_key:`${toContractNetwork(t.network)}:${t.tx_hash}:${t.id}`,network:toContractNetwork(t.network),tx_hash:t.tx_hash,amount:String(t.raw_amount),asset:t.asset,direction:t.direction,provider:t.provider,evidence_id:t.evidence_id,completeness:t.completeness})),counterparties:counterparties.map(c=>({...base,external_id:c.id,address:c.counterparty_address,network:toContractNetwork(c.network),tx_count:c.tx_count,evidence_id:c.evidence_id})),evidence:evidence.map(e=>({...base,external_id:e.id,evidence_type:e.category,evidence_class:'blockchain_fact',title:e.title,context_text:e.description,entity:subject,provenance:{...base.provenance,provider:e.source_provider,provenance_id:e.provenance_id,raw_payload:e.raw_payload}})),relationships:links.filter(l=>evidence.some(e=>e.id===l.evidence_id)).map(l=>({...base,external_id:l.id,relationship_type:l.relationship_type,assertion_kind:'derived',from:subject,to:{entity_type:'wallet',canonical_key:l.connected_wallet_address,network:toContractNetwork(l.network)},evidence_ids:[l.evidence_id]}))};
  await ingest(records);ingestedValidation=true;
  if(job.target_entity_id&&result)runStatement("UPDATE main_platform_queue SET payload_json=json_set(payload_json,'$.entity_id',?,'$.platform_job_id',?) WHERE idempotency_key=?",[job.target_entity_id,job.id,String(result.idempotency_key)]);
  await patch(partial?'needs-review':'complete',{message:partial?`Validated; analysis PARTIAL: ${completenessReason}`:'Validated; analysis ingested',result:{...summary,analysis:analysis.status,completeness,completeness_reason:completenessReason,transactions:transactions.length,counterparties:counterparties.length,evidence:evidence.length,relationships:records.relationships.length,meter:{used:{provider_calls:Math.max(0,globalProviderManager.callsFor(address,network)-beforeCalls),http:Math.max(0,globalProviderManager.httpCallsFor(address,network)-beforeHttpCalls),worker_ms:Math.round(performance.now()-started)},scope:'Measured provider adapter calls and HTTP requests; cached results make no HTTP request'}}});
  await globalMainPlatform.flushOutbox();
 }catch(error){await patch('fail',{error:error instanceof Error?error.message:String(error),retry:true,validation_reported:ingestedValidation}).catch(()=>{});throw error;}finally{if(lease)clearInterval(lease);}}
}
type WalletV4Payload={refresh_key?:string;pipeline?:string;wallet_candidate_id?:unknown;address?:unknown;family?:unknown;candidate_networks?:unknown;network_hint?:NetworkHint|string|null;analyze?:unknown};
function parseJobPayload(raw:unknown):WalletV4Payload&Record<string,unknown>{if(raw&&typeof raw==='object')return raw as WalletV4Payload;if(typeof raw!=='string'||!raw.trim())return {};try{const parsed=JSON.parse(raw);return parsed&&typeof parsed==='object'?parsed:{};}catch{return {};}}
export async function startPlatformWorker(){const base=process.env.MAIN_PLATFORM_URL,key=process.env.WALLET_INVESTIGATOR_MODULE_KEY;if(!base||!key)return;await initDatabase();await runMigrations();const worker=new PlatformWorker(base,key);await worker.register();setInterval(()=>worker.tick().catch(error=>{globalMainPlatform.disconnected(/401|403/.test(String(error)));console.error('Platform wallet worker:',error)}),3000);}
