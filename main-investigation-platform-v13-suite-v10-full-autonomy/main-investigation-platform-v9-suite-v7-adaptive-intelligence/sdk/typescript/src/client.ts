export type InvestigationBudget={max_jobs:number;max_related_sites:number;max_wallets:number;max_expansion_depth:number;max_api_calls:number;max_runtime_seconds:number;used_jobs:number;used_related_sites:number;used_wallets:number;used_api_calls:number;used_runtime_seconds:number};
export type TriageOutcome="observed"|"triaged"|"promoted"|"dismissed"|"inconclusive";
export type EvidenceRef={id:string;sha256?:string;source_module:string;provenance:Record<string,unknown>};
export type ResolvedObservation={entity_id:string;field:string;value:string;confidence:number;supporting_ids:string[];conflicting_ids:string[];method:string};
export type PlannerDecision={id:string;action:string;outcome:string;reason:string;source_event_id:string;evidence_refs:string[];limits:InvestigationBudget};
export type ModuleName="site_finder"|"site_investigator"|"crypto_wallet_logger"|"wallet_investigator"|"form_submitter"|"operation_hunter"|"platform";
export type ClientOptions={baseUrl:string;module:ModuleName;apiKey:string;sitesBypassToken?:string;maxRetries?:number;fetchImpl?:typeof fetch};
import type {EventType} from "./contracts";
export type InvestigationEvent={event_id:string;event_type:EventType;schema_version?:"1.0"|"2.0"|"3.0";correlation_id?:string;causation_event_id?:string;investigation_id?:string;entity_id?:string;occurred_at?:string;provenance?:Record<string,unknown>;payload?:Record<string,unknown>;hop_count?:number};
export class MainInvestigationClient{
  private fetcher:typeof fetch;constructor(private options:ClientOptions){this.fetcher=options.fetchImpl??fetch;}
  private async request(path:string,init:RequestInit={}){const headers=new Headers(init.headers);headers.set("X-API-Key",this.options.apiKey);headers.set("Content-Type",headers.get("Content-Type")??"application/json");if(this.options.sitesBypassToken)headers.set("OAI-Sites-Authorization",`Bearer ${this.options.sitesBypassToken}`);let last:unknown;for(let attempt=0;attempt<=(this.options.maxRetries??4);attempt++){let response:Response;try{response=await this.fetcher(`${this.options.baseUrl.replace(/\/$/,"")}${path}`,{...init,headers});}catch(error){last=error;if(attempt===(this.options.maxRetries??4))throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(30000,500*2**attempt+Math.random()*250)));continue;}if(response.status===204)return null;const body=await response.json() as {error?:{message?:string}};if(response.ok)return body;last=new Error(body?.error?.message??`HTTP ${response.status}`);if(![429,502,503,504].includes(response.status))throw last;if(attempt<(this.options.maxRetries??4))await new Promise(resolve=>setTimeout(resolve,Math.min(30000,500*2**attempt+Math.random()*250)));}throw last;}
  ingestLegacyLoggerEvent(event:{id:string;type:"wallet.observed"|"evidence.added"|"deposit_option.observed";schemaVersion:"1.0.0";occurredAt:string;source:"CryptoWalletLogger";sourceVersion:string;payload:Record<string,unknown>}){if(this.options.module!=="crypto_wallet_logger")throw new Error("CryptoWalletLogger only");return this.request("/api/v1/compat/logger",{method:"POST",body:JSON.stringify(event)});}
  heartbeat(input:{module_version:string;schema_version:string;status:"idle"|"running"|"error";capabilities:string[];current_job_id?:string|null;error?:string|null}){return this.request(`/api/v1/modules/${this.options.module}/heartbeat`,{method:"POST",body:JSON.stringify(input)});}
  register(input:{module_version:string;capabilities:string[];supported_event_types?:string[];metadata?:Record<string,unknown>}){return this.request(`/api/v1/modules/${this.options.module}/register`,{method:"POST",body:JSON.stringify({schema_version:"3.0",supported_event_types:[],metadata:{},...input})});}
  pendingEvents(limit=50){return this.request(`/api/v1/modules/${this.options.module}/events?limit=${limit}`);}
  acknowledgeEvent(deliveryId:string){return this.request(`/api/v1/modules/${this.options.module}/events/${encodeURIComponent(deliveryId)}`,{method:"POST"});}
  submitMetrics(input:{technique:string;campaign:string;window_start:string;window_end:string;metrics:Record<string,number>;provenance?:Record<string,unknown>}){return this.request(`/api/v1/modules/${this.options.module}/metrics`,{method:"POST",body:JSON.stringify(input)});}
  getMetrics(){return this.request(`/api/v1/modules/${this.options.module}/metrics`);}
  publishEvents(events:InvestigationEvent[]){return this.request("/api/v1/events",{method:"POST",body:JSON.stringify({source_module:this.options.module,events})});}
  publishEvent(event:InvestigationEvent){return this.publishEvents([event]);}
  ingest(records:Record<string,unknown[]>,options:{batchId:string;originJobId?:string;schemaVersion?:"1.1"|"3.0"} ){return this.request(`/api/v1/ingest/${this.options.module}`,{method:"POST",body:JSON.stringify({schema_version:options.schemaVersion??"3.0",batch_id:options.batchId,sent_at:new Date().toISOString(),origin_job_id:options.originJobId,records})});}
  claimJob(){return this.request(`/api/v1/modules/${this.options.module}/jobs/claim`,{method:"POST"});}
  updateJob(jobId:string,update:{action:"progress"|"complete"|"fail"|"needs-review";progress?:number;message?:string;result?:unknown;error?:string;retry?:boolean}){return this.request(`/api/v1/modules/${this.options.module}/jobs/${jobId}`,{method:"PATCH",body:JSON.stringify(update)});}
  createJob(input:{job_type:string;target_module:ModuleName;investigation_id?:string;target_entity_id?:string;priority?:number;payload?:unknown}){return this.request("/api/v1/jobs",{method:"POST",body:JSON.stringify({...input,source_module:this.options.module})});}
  getPlan(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/plan`);}
  updateBudget(id:string,limits:Partial<InvestigationBudget>){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/plan`,{method:"PATCH",body:JSON.stringify(limits)});}
  getGraph(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/graph`);}
  getResolved(id:string,entityId:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/resolve?entity_id=${encodeURIComponent(entityId)}`);}
  getMonitoring(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/monitoring`);}
  monitor(id:string,input:{entity_id:string;kind:"site"|"wallet"|"relationship";interval_seconds?:number;enabled?:boolean}){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/monitoring`,{method:"POST",body:JSON.stringify(input)});}
  getReports(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/report`);}
  prepareReport(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/report`,{method:"POST"});}
  inboxDecisions(after="",limit=100){return this.request(`/api/v1/inbox/decisions?module=${this.options.module}&after=${encodeURIComponent(after)}&limit=${limit}`);}
  getInvestigationContext(id:string){return this.request(`/api/v1/investigations/${encodeURIComponent(id)}/context?module=${this.options.module}`);}
}
