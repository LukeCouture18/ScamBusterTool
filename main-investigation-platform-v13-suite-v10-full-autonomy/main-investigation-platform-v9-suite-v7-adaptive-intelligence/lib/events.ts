import { z } from "zod";
import { retryDelaySeconds } from "./domain.mjs";
import { createReview, notify, timeline } from "./orchestrator";
import { getD1, json, now, sha256, type SourceModule } from "./platform";
import { planFromEvent } from "./planner";
import {dispatchFeedback} from "./feedback";

import {EVENT_TYPES,type EventType} from "../sdk/typescript/src/contracts";
export {EVENT_TYPES};
export type {EventType};

export const eventInputSchema=z.object({
  event_id:z.string().min(1).max(240),event_type:z.enum(EVENT_TYPES),schema_version:z.enum(["1.0","2.0","3.0"]).default("3.0"),
  correlation_id:z.string().min(1).max(240).optional(),causation_event_id:z.string().min(1).max(240).optional(),
  investigation_id:z.string().min(1).max(240).optional(),entity_id:z.string().uuid().optional(),
  occurred_at:z.string().datetime({offset:true}).optional(),provenance:z.record(z.string(),z.unknown()).default({}),
  payload:z.record(z.string(),z.unknown()).default({}),hop_count:z.number().int().min(0).max(8).default(0),
}).strict();
export type EventInput=z.infer<typeof eventInputSchema>;

type StoredEvent=Record<string,unknown>&{id:string;event_id:string;event_type:EventType;source_module:SourceModule;correlation_id:string;investigation_id:string|null;entity_id:string|null;payload:string;provenance:string;hop_count:number;attempt_count:number;max_attempts:number};
function parseJson<T>(value:unknown,fallback:T):T{try{return typeof value==="string"?JSON.parse(value) as T:(value as T)??fallback;}catch{return fallback;}}
async function resolveInvestigationId(value?:string){if(!value)return null;const row=await getD1().prepare("SELECT id FROM investigations WHERE id=? OR external_id=? LIMIT 1").bind(value,value).first<{id:string}>();return row?.id??null;}

export async function selectModuleForCapability(capability:string,sourceModule?:SourceModule){
  const rows=await getD1().prepare("SELECT module_name,capabilities,last_heartbeat_at,runtime_status,current_job_id FROM module_registry").all<Record<string,unknown>>();
  const candidates=(rows.results as Array<Record<string,unknown>>).filter(row=>{
    const name=String(row.module_name) as SourceModule;const capabilities=parseJson<string[]>(row.capabilities,[]);
    const heartbeat=row.last_heartbeat_at?new Date(String(row.last_heartbeat_at).replace(" ","T")+"Z").getTime():0;return name!==sourceModule&&row.runtime_status!=="error"&&Date.now()-heartbeat<120000&&capabilities.includes(capability);
  }).sort((a,b)=>{
    const healthy=(row:Record<string,unknown>)=>row.last_heartbeat_at&&Date.now()-new Date(String(row.last_heartbeat_at).replace(" ","T")+(/[z+-]/i.test(String(row.last_heartbeat_at).slice(-6))?"":"Z")).getTime()<120000?1:0;
    return healthy(b)-healthy(a)||Number(Boolean(a.current_job_id))-Number(Boolean(b.current_job_id));
  });
  return (candidates[0]?.module_name as SourceModule|undefined)??null;
}

async function routeEvent(event:StoredEvent){
  const db=getD1();const payload=parseJson<Record<string,unknown>>(event.payload,{});
  if(Number(event.hop_count)>=8)throw new Error("EVENT_HOP_LIMIT_EXCEEDED");
  await timeline({investigationId:event.investigation_id,entityId:event.entity_id,sourceModule:event.source_module,eventType:event.event_type,title:event.event_type,detail:String(payload.summary??payload.canonical_key??"Event received"),reason:`Published by ${event.source_module}.`,data:{event_id:event.event_id,correlation_id:event.correlation_id,causation_event_id:event.causation_event_id}});

  // A high observation confidence alone cannot establish address or chain validity.

  if(event.event_type==="wallet.analyzed"&&event.entity_id){
    await db.prepare("INSERT INTO entity_analysis_state (entity_id,module_name,analysis_type,last_analyzed_at,fresh_until,result_summary) VALUES (?,'wallet_investigator','ANALYZE_WALLET',CURRENT_TIMESTAMP,datetime('now','+24 hours'),?) ON CONFLICT(entity_id,module_name,analysis_type) DO UPDATE SET last_analyzed_at=CURRENT_TIMESTAMP,fresh_until=excluded.fresh_until,result_summary=excluded.result_summary,updated_at=CURRENT_TIMESTAMP").bind(event.entity_id,event.payload).run();
  }
  if(event.event_type==="relationship.discovered"&&payload.conflict===true)await createReview({investigationId:event.investigation_id,entityId:event.entity_id,type:"conflicting_relationship",priority:80,title:"Conflicting relationship observations",reason:"Modules reported incompatible relationship facts.",details:{event_id:event.event_id,payload}});
  if(event.event_type==="evidence.added"&&Number(payload.confidence??0)>=.9)await notify({investigationId:event.investigation_id,type:"important_evidence",severity:"high",title:"Important new evidence",message:String(payload.title??"High-confidence evidence was added."),resourceType:"event",resourceId:event.id});
  if(event.event_type==="site.triaged"){
    const outcome=String(payload.outcome??"");
    if(!["observed","triaged","promoted","dismissed","inconclusive"].includes(outcome))throw new Error("INVALID_TRIAGE_OUTCOME");
    const confidence=Number(payload.confidence);
    if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error("INVALID_TRIAGE_CONFIDENCE");
    await db.prepare("INSERT OR IGNORE INTO site_triage (id,event_id,investigation_id,entity_id,source_module,outcome,confidence,indicators,reasons,discovery_path,request_downstream,provenance,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),event.id,event.investigation_id,event.entity_id,event.source_module,outcome,confidence,json(payload.indicator_categories??[]),json(payload.evidence_refs??[]),json(payload.discovery_path??{}),payload.request_downstream===true?1:0,event.provenance,String(event.occurred_at)).run();
  }
  const registry=await db.prepare("SELECT module_name,supported_event_types FROM module_registry WHERE module_name<>?").bind(event.source_module).all<{module_name:string;supported_event_types:string}>();
  for(const subscriber of registry.results){const accepted=parseJson<string[]>(subscriber.supported_event_types,[]);if(accepted.includes(event.event_type))await db.prepare("INSERT OR IGNORE INTO module_event_inbox (id,event_id,module_name) VALUES (?,?,?)").bind(crypto.randomUUID(),event.id,subscriber.module_name).run();}

  await planFromEvent(event,payload);
  const { wakeOperations } = await import('./ops/intelligence');
  await wakeOperations(event);
  if(event.investigation_id&&["evidence.added","site.investigated","wallet.analyzed","wallet.validated","relationship.discovered"].includes(event.event_type)){try{const {onInvestigationActivity}=await import("./agent/hooks");await onInvestigationActivity(event.investigation_id,"evidence");}catch{/* AI layer is best-effort */}}
  if(["site.investigated","wallet.validated","wallet.analyzed","relationship.discovered","evidence.added"].includes(event.event_type)&&event.investigation_id){
    const origins=await db.prepare("SELECT id,payload FROM event_store WHERE investigation_id=? AND source_module='site_finder' AND event_type IN ('site.discovered','site.triaged') AND id<>? AND (correlation_id=? OR entity_id=?) ORDER BY received_at DESC LIMIT 20").bind(event.investigation_id,event.id,event.correlation_id,event.entity_id).all<{id:string;payload:string}>();
    for(const origin of origins.results){const discovery=parseJson<Record<string,unknown>>(origin.payload,{});if(!discovery.technique||!discovery.campaign)continue;await db.prepare("INSERT OR IGNORE INTO discovery_feedback (id,source_event_id,result_event_id,technique,campaign,useful_observations) VALUES (?,?,?,?,?,1)").bind(crypto.randomUUID(),origin.id,event.id,String(discovery.technique),String(discovery.campaign)).run();}
  }
}

export async function processEventById(id:string){
  const db=getD1();const claimed=await db.prepare("UPDATE event_store SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+2 minutes'),last_error=NULL WHERE id=? AND status IN ('pending','retrying') AND available_at<=CURRENT_TIMESTAMP").bind(id).run();
  if((claimed.meta?.changes??0)!==1)return db.prepare("SELECT * FROM event_store WHERE id=?").bind(id).first();
  const event=await db.prepare("SELECT * FROM event_store WHERE id=?").bind(id).first<StoredEvent>();if(!event)return null;
  try{await routeEvent(event);await db.prepare("UPDATE event_store SET status='processed',processed_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=?").bind(id).run();}
  catch(error){const message=error instanceof Error?error.message:"Unknown event processing failure";const retry=Number(event.attempt_count)+1<Number(event.max_attempts);const next=new Date(Date.now()+retryDelaySeconds(Number(event.attempt_count)+1)*1000).toISOString();await db.prepare("UPDATE event_store SET status=?,available_at=?,lease_expires_at=NULL,last_error=? WHERE id=?").bind(retry?"retrying":"dead-letter",next,message,id).run();if(!retry){await db.prepare("INSERT INTO event_dead_letters (id,event_id,source_module,event_type,payload,error_code,error_message,attempt_count) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,event.source_module,event.event_type,event.payload,"EVENT_PROCESSING_FAILED",message,Number(event.attempt_count)+1).run();await createReview({investigationId:event.investigation_id,entityId:event.entity_id,type:"failed_event",priority:90,title:`Failed event: ${event.event_type}`,reason:message,details:{event_id:event.event_id,correlation_id:event.correlation_id}});}}
  try{await dispatchFeedback(20,id);}catch{/* Persisted inbox is retried by the dispatch endpoint. */}
  return db.prepare("SELECT * FROM event_store WHERE id=?").bind(id).first();
}

export async function recoverEvents(limit=25){const db=getD1();await db.prepare("UPDATE event_store SET status=CASE WHEN attempt_count>=max_attempts THEN 'dead-letter' ELSE 'retrying' END,lease_expires_at=NULL,available_at=CURRENT_TIMESTAMP,last_error='Event processing lease expired; recovered after restart' WHERE status='processing' AND lease_expires_at<CURRENT_TIMESTAMP").run();
 await db.prepare("INSERT OR IGNORE INTO event_dead_letters (id,event_id,source_module,event_type,payload,error_code,error_message,attempt_count) SELECT lower(hex(randomblob(16))),e.id,e.source_module,e.event_type,e.payload,'EVENT_LEASE_EXHAUSTED',e.last_error,e.attempt_count FROM event_store e WHERE e.status='dead-letter' AND NOT EXISTS (SELECT 1 FROM event_dead_letters d WHERE d.event_id=e.id AND d.resolved_at IS NULL)").run();
 const due=await db.prepare("SELECT id FROM event_store WHERE status IN ('pending','retrying') AND available_at<=CURRENT_TIMESTAMP ORDER BY received_at LIMIT ?").bind(Math.max(1,Math.min(100,limit))).all<{id:string}>();for(const row of due.results)await processEventById(row.id);return{processed:due.results.length};}

export async function publishEvent(sourceModule:SourceModule,input:EventInput){
  const parsed=eventInputSchema.parse(input);const db=getD1();const investigationId=await resolveInvestigationId(parsed.investigation_id);const canonical=json({event_type:parsed.event_type,investigation_id:investigationId,entity_id:parsed.entity_id??null,payload:parsed.payload,provenance:parsed.provenance});const hash=await sha256(canonical);const id=crypto.randomUUID();const correlationId=parsed.correlation_id??parsed.event_id;
  if(parsed.event_type==="report.ready"&&sourceModule!=="platform")throw new Error("REPORT_APPROVAL_REQUIRED");
  if(parsed.event_type.startsWith("report.")&&parsed.event_type!=="report.ready"&&!(["form_submitter","platform"] as string[]).includes(sourceModule))throw new Error("REPORT_SOURCE_FORBIDDEN");
  if(parsed.schema_version==="3.0"&&parsed.event_type==="wallet.validated"&&(!parsed.provenance.method||!Array.isArray(parsed.payload.evidence_refs)||parsed.payload.evidence_refs.length===0))throw new Error("VALIDATION_EVIDENCE_REQUIRED");
  await db.prepare("INSERT OR IGNORE INTO event_store (id,event_id,event_type,schema_version,correlation_id,causation_event_id,investigation_id,entity_id,source_module,payload,provenance,content_hash,hop_count,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,parsed.event_id,parsed.event_type,parsed.schema_version,correlationId,parsed.causation_event_id??null,investigationId,parsed.entity_id??null,sourceModule,json(parsed.payload),json(parsed.provenance),hash,parsed.hop_count,parsed.occurred_at??now()).run();
  const stored=await db.prepare("SELECT * FROM event_store WHERE event_id=?").bind(parsed.event_id).first<StoredEvent>();if(!stored)throw new Error("EVENT_PERSIST_FAILED");const duplicate=stored.id!==id;if(duplicate&&(stored.content_hash!==hash||stored.source_module!==sourceModule))throw new Error("EVENT_ID_CONFLICT");if(!duplicate||["pending","retrying"].includes(String(stored.status)))await processEventById(stored.id);return{event:await db.prepare("SELECT * FROM event_store WHERE id=?").bind(stored.id).first(),duplicate};
}

export async function replayEvent(id:string){const db=getD1();const event=await db.prepare("SELECT * FROM event_store WHERE id=? OR event_id=?").bind(id,id).first<StoredEvent>();if(!event)return null;await db.batch([db.prepare("UPDATE event_store SET status='pending',attempt_count=0,available_at=CURRENT_TIMESTAMP,lease_expires_at=NULL,last_error=NULL,processed_at=NULL,replay_count=replay_count+1 WHERE id=?").bind(event.id),db.prepare("UPDATE event_deliveries SET status='pending',attempt_count=0,available_at=CURRENT_TIMESTAMP,lease_expires_at=NULL,last_error=NULL,processed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE event_id=?").bind(event.id),db.prepare("UPDATE event_dead_letters SET resolved_at=CURRENT_TIMESTAMP WHERE event_id=? AND resolved_at IS NULL").bind(event.id)]);return processEventById(event.id);}
