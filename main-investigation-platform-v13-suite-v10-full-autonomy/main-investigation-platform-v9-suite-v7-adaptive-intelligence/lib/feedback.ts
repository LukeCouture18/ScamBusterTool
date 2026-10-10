import {env} from "cloudflare:workers";
import {getD1,json} from "./platform";
import {retryDelaySeconds} from "./domain.mjs";
import {createReview} from "./orchestrator";

export function validatedWebhook(value:unknown){
 if(typeof value!=="string")return null;
 let url:URL;try{url=new URL(value);}catch{return null;}
 const allowed=(env.FEEDBACK_WEBHOOK_ALLOWLIST??"").split(",").map(x=>x.trim()).filter(Boolean);
 const loopback=url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)&&env.FEEDBACK_ALLOW_LOOPBACK_HTTP==="true";
 if((url.protocol!=="https:"&&!loopback)||url.username||url.password||url.hash||!allowed.includes(url.origin))return null;
 return url.toString();
}
async function signature(body:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.FEEDBACK_SIGNING_KEY!),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return [...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)))].map(b=>b.toString(16).padStart(2,"0")).join("");}
export async function dispatchFeedback(limit=20,eventId?:string){const db=getD1();if(!env.FEEDBACK_SIGNING_KEY)return{delivered:0,pending:0,disabled:"FEEDBACK_SIGNING_KEY_MISSING"};
 const due=await db.prepare("SELECT i.id,i.event_id,i.module_name,i.push_attempts,r.registration_metadata,e.event_id external_event_id,e.event_type,e.schema_version,e.investigation_id,e.entity_id,e.source_module,e.payload,e.provenance,e.correlation_id FROM module_event_inbox i JOIN module_registry r ON r.module_name=i.module_name JOIN event_store e ON e.id=i.event_id WHERE i.acknowledged_at IS NULL AND e.status='processed' AND i.push_attempts<5 AND i.push_next_at<=CURRENT_TIMESTAMP AND (i.push_lease_until IS NULL OR i.push_lease_until<CURRENT_TIMESTAMP) AND (? IS NULL OR i.event_id=?) ORDER BY i.created_at LIMIT ?").bind(eventId??null,eventId??null,Math.max(1,Math.min(100,limit))).all<Record<string,unknown>>();let delivered=0;
 for(const row of due.results){let metadata:Record<string,unknown>={};try{metadata=JSON.parse(String(row.registration_metadata));}catch{}const url=validatedWebhook(metadata.feedback_webhook_url);if(!url)continue;
  const claimed=await db.prepare("UPDATE module_event_inbox SET push_attempts=push_attempts+1,push_lease_until=datetime('now','+1 minute') WHERE id=? AND acknowledged_at IS NULL AND push_attempts<5 AND push_next_at<=CURRENT_TIMESTAMP AND (push_lease_until IS NULL OR push_lease_until<CURRENT_TIMESTAMP)").bind(row.id).run();if(claimed.meta?.changes!==1)continue;
  const body=json({delivery_id:row.id,event_id:row.external_event_id,event_type:row.event_type,schema_version:row.schema_version,investigation_id:row.investigation_id,entity_id:row.entity_id,source_module:row.source_module,correlation_id:row.correlation_id,payload:JSON.parse(String(row.payload)),provenance:JSON.parse(String(row.provenance))});
  try{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-platform-delivery-id":String(row.id),"x-platform-signature":`sha256=${await signature(body)}`},body,signal:AbortSignal.timeout(5000),redirect:"error"});if(!response.ok)throw new Error(`HTTP_${response.status}`);
   await db.prepare("UPDATE module_event_inbox SET pushed_at=CURRENT_TIMESTAMP,push_lease_until=NULL,push_last_error=NULL,push_next_at=datetime('now','+5 minutes') WHERE id=? AND acknowledged_at IS NULL").bind(row.id).run();delivered++;
   if(Number(row.push_attempts)+1>=5)await createReview({investigationId:row.investigation_id?String(row.investigation_id):null,entityId:row.entity_id?String(row.entity_id):null,type:"feedback_unacknowledged",title:"Feedback delivery not acknowledged",reason:`${row.module_name} received five push attempts but did not acknowledge delivery ${row.id}.`,details:{delivery_id:row.id,module_name:row.module_name,event_id:row.external_event_id}});
  }catch(error){const attempts=Number(row.push_attempts)+1;await db.prepare("UPDATE module_event_inbox SET push_lease_until=NULL,push_last_error=?,push_next_at=? WHERE id=?").bind(error instanceof Error?error.message:String(error),new Date(Date.now()+retryDelaySeconds(attempts)*1000).toISOString(),row.id).run();if(attempts>=5)await createReview({investigationId:row.investigation_id?String(row.investigation_id):null,entityId:row.entity_id?String(row.entity_id):null,type:"feedback_delivery_failed",title:"Feedback push exhausted retries",reason:`${row.module_name} could not receive event ${row.external_event_id}: ${error instanceof Error?error.message:String(error)}`,details:{delivery_id:row.id,module_name:row.module_name,event_id:row.external_event_id}});}
 }
 return{delivered,pending:due.results.length-delivered};
}
