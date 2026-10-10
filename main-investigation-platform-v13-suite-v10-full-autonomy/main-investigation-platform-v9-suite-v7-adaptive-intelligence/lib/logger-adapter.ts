import {z} from "zod";
import {getD1,now} from "./platform";
import {ingest,parseIngestRequest} from "./ingestion";
import {CONTEXT_CLASSES,canonicalNetwork,observationHash,recordObservation} from "./wallet-pipeline";
const input=z.object({id:z.string().min(1).max(240),type:z.enum(["wallet.observed","evidence.added","deposit_option.observed"]),schemaVersion:z.literal("1.0.0"),occurredAt:z.string().datetime({offset:true}),source:z.literal("CryptoWalletLogger"),sourceVersion:z.string().min(1).max(80),payload:z.record(z.string(),z.unknown())}).strict();
function string(value:unknown,max=2000){return typeof value==="string"?value.slice(0,max):"";}
function domainFor(payload:Record<string,unknown>){const raw=string(payload.domain,255).trim();if(!raw)return null;try{const url=new URL(`https://${raw}`);if(url.hostname===raw.toLowerCase()&&url.hostname.includes(".")&&!url.hostname.endsWith(".invalid")&&!url.username&&!url.password)return url.hostname;}catch{}return null;}
function confidence(value:unknown){return typeof value==="number"?Math.max(0,Math.min(1,value)):value==="high"?.85:value==="medium"?.65:.4;}
const text=(max:number)=>z.string().max(max);
const observationV2=z.object({id:z.string().min(1).max(240),type:z.literal("wallet.observation"),schemaVersion:z.literal("2.0.0"),occurredAt:z.string().datetime({offset:true}),source:z.literal("CryptoWalletLogger"),sourceVersion:z.string().min(1).max(80),payload:z.object({
 observationId:z.string().regex(/^[\w:.-]{8,200}$/),address:z.string().regex(/^[A-Za-z0-9]{20,120}$/),family:z.enum(["evm","tron","bitcoin","litecoin","dogecoin","solana","xrp"]),
 candidateNetworks:z.array(text(40)).max(12).default([]),networkHint:z.object({network:text(60).nullable().optional(),token:text(40).nullable().optional(),source:text(40).optional()}).passthrough().nullable().optional(),
 formatCheck:text(40).optional(),context:z.object({class:z.enum(CONTEXT_CLASSES),confidence:z.number().min(0).max(1).default(0),cues:z.array(text(200)).max(40).default([]),negativeCues:z.array(text(200)).max(40).default([]),section:text(400).optional(),snippet:text(2000).optional()}).passthrough(),
 detection:z.object({method:text(40).optional(),methods:z.array(text(40)).max(20).default([]),afterInteraction:z.boolean().optional()}).passthrough().optional(),
 page:z.object({domain:text(255),url:text(4096).optional(),frameUrl:text(4096).optional(),title:text(500).optional()}).passthrough(),
 evidence:z.record(z.string(),z.unknown()).optional(),firstSeen:text(40).optional(),lastSeen:text(40).optional(),seenCount:z.number().int().min(1).max(1_000_000).optional(),provenance:z.record(z.string(),z.unknown()).optional()}).passthrough()});
const CLASS_LABEL:Record<string,string>={deposit:"Deposit",withdrawal:"Withdrawal",example:"Example",transaction_history:"Transaction history",contract:"Contract/token",unrelated:"Unrelated",unknown:"Unclassified"};
async function investigationFor(domain:string){const db=getD1();const existing=await db.prepare("SELECT i.id,i.external_id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=? AND ie.source_module IN ('platform','site_finder','site_investigator','crypto_wallet_logger') ORDER BY CASE WHEN i.external_id='site:'||e.canonical_key THEN 0 ELSE 1 END,i.created_at LIMIT 1").bind(domain.replace(/^www\./,"")).first<{id:string;external_id:string}>();return existing;}
/** v0.9 wallet.observation: preserve the page evidence, then hand the observation to the wallet pipeline. */
async function ingestObservationV2(message:z.infer<typeof observationV2>){const p=message.payload,domain=domainFor({domain:p.page.domain});if(!domain)throw new Error("LOGGER_DOMAIN_INVALID");
 const existing=await investigationFor(domain),investigation=existing?.external_id??`logger:${domain}`,observedAt=message.occurredAt;
 const obs={...p,page:{...p.page,domain},context:{...p.context,class:p.context.class},networkHint:p.networkHint?{network:p.networkHint.network??undefined,token:p.networkHint.token??undefined,source:p.networkHint.source}:null};
 const contentHash=await observationHash(obs);
 const provenance={source:"CryptoWalletLogger",source_version:message.sourceVersion,event_id:message.id,observation_id:p.observationId,passive:true,original_event_type:message.type,source_url:p.page.url??"",detection_method:p.detection?.method??"text"};
 const conf=Math.min(.85,Math.max(.3,p.context.confidence));const records:Record<string,unknown[]>={};
 if(!existing)records.investigations=[{external_id:investigation,title:`Observed site: ${domain}`,status:"open",priority:"normal",confidence:conf,provenance}];
 records.sites=[{external_id:`logger:site:${domain}`,investigation_id:investigation,canonical_key:domain,display_name:domain,confidence:conf,provenance,observed_at:observedAt}];
 records.evidence=[{external_id:`logger:obs:${p.observationId}`,investigation_id:investigation,evidence_type:"wallet_observation",evidence_class:"observed_website",observation_scope:"public",title:`${CLASS_LABEL[p.context.class]} wallet shown on ${domain}`,context_text:String(p.context.snippet??"").slice(0,2000),uri:p.page.url??null,sha256:contentHash,confidence:conf,
  metadata:{address:p.address,family:p.family,network_hint:obs.networkHint,candidate_networks:p.candidateNetworks,format_check:p.formatCheck,context_class:p.context.class,context_confidence:p.context.confidence,cues:p.context.cues,negative_cues:p.context.negativeCues,section:p.context.section,detection:p.detection,page:obs.page,details:p.evidence??{},first_seen:p.firstSeen,last_seen:p.lastSeen,seen_count:p.seenCount},
  provenance,observed_at:p.firstSeen&&!Number.isNaN(Date.parse(p.firstSeen))?p.firstSeen:observedAt,entity:{entity_type:"site",canonical_key:domain}}];
 const parsed=parseIngestRequest({schema_version:"3.0",batch_id:`logger:${message.id}`,sent_at:now(),records});const result=await ingest("crypto_wallet_logger",parsed.payload,parsed.rejected);
 const db=getD1();const inv=await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=?").bind(investigation,investigation).first<{id:string}>();
 const ev=await db.prepare("SELECT id FROM evidence WHERE source_module='crypto_wallet_logger' AND source_record_id=?").bind(`logger:obs:${p.observationId}`).first<{id:string}>();
 if(inv){await recordObservation(inv.id,obs,ev?.id??null,message.id,contentHash);
  if(p.context.class==='deposit')await db.prepare("UPDATE human_checkpoints SET status='resolved',resolution='new_evidence',resolution_evidence=?,resolved_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND status='open' AND kind IN ('login','captcha','mfa','email_verification') AND created_at<=?").bind(JSON.stringify(ev?[ev.id]:[]),inv.id,observedAt).run();
  const {projectAutonomy}=await import('./autonomy');await projectAutonomy(inv.id);
 }
 return result;}
function assertNoSecrets(raw:unknown,depth=0):void {
 if(depth>16)throw new Error("LOGGER_PAYLOAD_DEPTH_EXCEEDED");
 if(!raw||typeof raw!=="object")return;
 for(const [key,value] of Object.entries(raw)) {
  if(/^(password|passwd|vault.?key|vault.?secret|private.?key|provider.?credentials?|api.?key|account.?secret|session.?token|access.?token|refresh.?token)$/i.test(key))throw new Error("LOGGER_SECRET_FIELD_FORBIDDEN");
  assertNoSecrets(value,depth+1);
 }
}
export async function ingestLoggerWire(raw:unknown){assertNoSecrets(raw);if(raw&&typeof raw==="object"&&(raw as {type?:unknown}).type==="wallet.observation")return ingestObservationV2(observationV2.parse(raw));const message=input.parse(raw),p=message.payload,domain=domainFor(p);if(!domain)throw new Error("LOGGER_DOMAIN_INVALID");const db=getD1();const existing=await db.prepare("SELECT i.external_id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=? AND ie.source_module IN ('platform','site_finder','site_investigator','crypto_wallet_logger') ORDER BY CASE WHEN i.external_id='site:'||e.canonical_key THEN 0 ELSE 1 END,i.created_at LIMIT 1").bind(domain.replace(/^www\./,"")).first<{external_id:string}>();const investigation=existing?.external_id??`logger:${domain}`,sourceUrl=string(p.sourceUrl,2048),wallet=string(p.wallet,240),network=canonicalNetwork(p.network)??(/^0x[0-9a-f]{40}$/i.test(string(p.wallet,240))?"":string(p.network,80)),observedAt=message.occurredAt,conf=confidence(p.confidence),provenance={source:"CryptoWalletLogger",source_version:message.sourceVersion,legacy_event_id:message.id,passive:true,original_event_type:message.type,source_url:sourceUrl};const records:Record<string,unknown[]>={};
 if(!existing)records.investigations=[{external_id:investigation,title:`Observed site: ${domain}`,status:"open",priority:"normal",confidence:conf,provenance}];
 records.sites=[{external_id:`logger:site:${domain}`,investigation_id:investigation,canonical_key:domain,display_name:domain,confidence:conf,provenance,observed_at:observedAt}];
 if(message.type==="wallet.observed"){
  if(!wallet||!/^\w[\w:.\-]{10,239}$/.test(wallet))throw new Error("LOGGER_WALLET_INVALID");
  records.wallets=[{external_id:`logger:wallet:${string(p.walletId,200)||message.id}`,investigation_id:investigation,address:wallet,network:network||"unknown",display_name:wallet,confidence:conf,classification:"observed_unverified",source_url:sourceUrl,provenance,observed_at:observedAt}];
 }
 if(message.type==="deposit_option.observed")records.deposit_options=[{external_id:`logger:deposit:${message.id}`,investigation_id:investigation,canonical_key:`${domain}:${sourceUrl}:${string(p.token,80)}:${network}`,display_name:string(p.token,80)||"Unspecified deposit option",confidence:conf,token:string(p.token,80),network:network||"unknown",source_url:sourceUrl,provenance,observed_at:observedAt}];
 // Loggers that send wallet.observation (0.9+) report wallets through the v4 pipeline, which validates them before they
 // become wallet entities; their legacy evidence events are kept as evidence about the site only.
 const v2Logger=/^(0\.(9|[1-9]\d)|[1-9])/.test(message.sourceVersion);
 if(message.type==="evidence.added")records.evidence=[{external_id:`logger:evidence:${message.id}`,investigation_id:investigation,evidence_type:string(p.recordType,100)||"page_observation",evidence_class:"observed_website",observation_scope:"public",title:`Browser observation on ${domain}`,context_text:string(p.context,10000),confidence:conf,metadata:{evidence_items:Array.isArray(p.evidenceItems)?p.evidenceItems.slice(0,25):[],source_url:sourceUrl},provenance,observed_at:observedAt,...(wallet&&!v2Logger?{entity:{entity_type:"wallet",canonical_key:wallet,network:network||"unknown"}}:{})}];
 const parsed=parseIngestRequest({schema_version:"3.0",batch_id:`logger:${message.id}`,sent_at:now(),records});return ingest("crypto_wallet_logger",parsed.payload,parsed.rejected);
}
