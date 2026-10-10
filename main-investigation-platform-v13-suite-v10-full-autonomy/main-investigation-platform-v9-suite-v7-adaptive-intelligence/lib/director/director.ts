/** Investigation Director: reasons over stored evidence, never fetches a target or manufactures evidence. */
import { getD1, json, now } from '../platform';
import { enqueueJob, type JobInput } from '../jobs';
import { enroll } from './resources';
import { parse, ts, getNum, getBool, type Row } from '../ops/common';
import { selectModuleForCapability } from '../events';
import { AUTOMATION_POLICY } from '../agent/capabilities';
import { detectBarriers, CHECKPOINT_TEXT, type EvidenceLite } from '../agent/barriers';
import { investigationArtifacts } from '../ops/finder-loop';
import { advanceCandidate, reconcileWalletPipeline, rebuildWalletReport, buildWalletReportContent } from '../wallet-pipeline';

export const OBJECTIVES=['site_worth_investigating','payment_interface','deposit_wallets','wallet_validation','blockchain_evidence','operation_correlation','related_sites','report_readiness','report_blockers'] as const;
export const STOP_REASONS=['READY_TO_REPORT','WAITING_FOR_HUMAN','SOURCE_EXHAUSTED','LOW_EXPECTED_VALUE','BUDGET_EXHAUSTED','DUPLICATE_INVESTIGATION','INSUFFICIENT_PUBLIC_EVIDENCE','PROVIDER_UNAVAILABLE','NO_REPORTABLE_WALLET','COMPLETED'] as const;
const all=async(q:string,...a:unknown[])=>(await getD1().prepare(q).bind(...a).all<Row>()).results;
const one=async(q:string,...a:unknown[])=>getD1().prepare(q).bind(...a).first<Row>();
const later=(ms:number)=>new Date(Date.now()+ms).toISOString();
const backoff=(attempt:number)=>Math.min(60*60000,5*60000*2**Math.max(0,attempt));
async function activity(inv:string,key:string,title:string,reason:string) {
 const id=`director:${inv}:${key}`;
 await getD1().prepare(`INSERT OR IGNORE INTO investigation_timeline(id,investigation_id,source_module,event_type,title,detail,reason,data)
 VALUES (?,?,'platform','director.activity',?,?,?,'{}')`).bind(id,inv,title,reason,reason).run();
}
async function state(inv:string,value:string,reason:string|null,headline:string,nextAt:string|null=null) {
 const db=getD1(),before=await one('SELECT state,stop_reason,headline FROM director_investigations WHERE investigation_id=?',inv);
 await db.prepare('UPDATE director_investigations SET state=?,stop_reason=?,headline=?,next_at=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=?').bind(value,reason,headline,nextAt,inv).run();
 if(before?.state!==value||before?.stop_reason!==reason||before?.headline!==headline)
  await activity(inv,`state:${value}:${reason}:${headline}`,headline,reason?.replace(/_/g,' ').toLowerCase()??'The next step answers a specific evidence gap.');
 return {investigation_id:inv,state:value,stop_reason:reason,headline};
}
async function objective(inv:string,key:string,status:string,reason:string,refs:unknown[]=[]) {
 await getD1().prepare(`INSERT INTO director_objectives(investigation_id,objective,status,reason,evidence_refs) VALUES (?,?,?,?,?)
 ON CONFLICT(investigation_id,objective) DO UPDATE SET status=excluded.status,reason=excluded.reason,evidence_refs=excluded.evidence_refs,updated_at=CURRENT_TIMESTAMP`).bind(inv,key,status,reason,json(refs)).run();
}

/** Called only for an authenticated WI result for the candidate's active analysis job. */
export async function observeAnalysis(candidateId:string,jobId:string,analysis:Row) {
 const db=getD1(), c=await one('SELECT * FROM wallet_candidates WHERE id=?',candidateId);
 if(!c || c.analysis_job_id!==jobId || c.validation_status!=='valid' || c.best_context!=='deposit')return;
 await enroll(String(c.investigation_id));
 const inv=String(c.investigation_id),network=String(c.validated_network??''),status=String(analysis.status??'').toLowerCase();
 const retry=await one('SELECT * FROM director_retries WHERE candidate_id=?',candidateId);
 if(status==='completed') {
  await db.prepare("UPDATE director_retries SET status='resolved',updated_at=CURRENT_TIMESTAMP WHERE candidate_id=?").bind(candidateId).run();
  await db.prepare(`INSERT INTO director_provider_health(network,state,failures,last_result_at) VALUES (?,'healthy',0,?)
   ON CONFLICT(network) DO UPDATE SET state='healthy',failures=0,next_probe_at=NULL,last_result_at=excluded.last_result_at,updated_at=CURRENT_TIMESTAMP`).bind(network,now()).run();
  await activity(inv,`recovered:${jobId}`,retry?'Provider recovered — analysis resumed':'Blockchain evidence received','Wallet Investigator supplied the result; Main will rebuild the report.');
  await rebuildWalletReport(inv); return;
 }
 if(!['partial','failed'].includes(status))return;
 const details=parse<Row>(analysis.completeness_details,{});
 const reason=String(analysis.reason??details.warning_message??'Provider coverage is incomplete').slice(0,500);
 const transient=status==='failed'||String(analysis.completeness)==='FAILED'||details.missing_native_history===true||details.missing_token_history===true||/unavailable|outage|429|503|timeout|timed out|provider.*fail|no active provider|no synthetic fixture|not configured/i.test(reason);
 if(!transient)return; // Pagination ceilings and complete zero-activity results are not outages.
 if(retry?.source_job_id===jobId || ['exhausted','budget_exhausted'].includes(String(retry?.status)))return;
 const attempts=Number(retry?.attempts??0), exhausted=attempts>=Number(retry?.max_attempts??3),next=later(backoff(attempts));
 await db.prepare(`INSERT INTO director_retries(candidate_id,investigation_id,status,source_job_id,next_at,reason) VALUES (?,?,'parked',?,?,?)
 ON CONFLICT(candidate_id) DO UPDATE SET status=?,source_job_id=excluded.source_job_id,next_at=excluded.next_at,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP`).bind(candidateId,inv,jobId,next,reason,exhausted?'exhausted':'parked').run();
 await db.prepare(`INSERT INTO director_provider_health(network,state,failures,next_probe_at,last_result_at) VALUES (?,'unavailable',1,?,?)
 ON CONFLICT(network) DO UPDATE SET state='unavailable',failures=failures+1,next_probe_at=excluded.next_probe_at,last_result_at=excluded.last_result_at,updated_at=CURRENT_TIMESTAMP`).bind(network,next,now()).run();
 await activity(inv,`outage:${jobId}`,exhausted?'Provider retry limit reached':`Provider unavailable — retry parked for ${backoff(attempts)/60000} minutes`,reason);
}

/** Old populated v4 databases also acquire durable retry state without a new WI event. */
async function adoptPartial(inv:string) {
 const rows=await all(`SELECT c.* FROM wallet_candidates c LEFT JOIN director_retries r ON r.candidate_id=c.id
 WHERE c.investigation_id=? AND c.validation_status='valid' AND c.best_context='deposit' AND c.analysis_status IN ('partial','failed') AND r.candidate_id IS NULL`,inv);
 for(const c of rows) {
  const j=await one('SELECT result FROM jobs WHERE id=?',c.analysis_job_id),result=parse<Row>(j?.result,{});
  await observeAnalysis(String(c.id),String(c.analysis_job_id),{status:c.analysis_status,completeness:result.completeness??'FAILED',reason:result.completeness_reason??'Provider coverage incomplete in an existing v4 analysis'});
 }
}

async function prior(kind:string) {
 // Historical outcomes influence order only. Thirty-day decay, at most ±0.12, with a nonzero exploration floor.
 const rows=await all('SELECT useful,updated_at FROM director_actions WHERE kind=? AND useful IS NOT NULL ORDER BY updated_at DESC LIMIT 100',kind);
 let weight=0,score=0;
 for(const r of rows){const w=Math.exp(-Math.max(0,Date.now()-ts(r.updated_at))/(30*86400000));weight+=w;score+=Number(r.useful)*w;}
 return weight?Math.max(-.12,Math.min(.12,(score/weight-.5)*.24)):0;
}
type Action={kind:string;target:string;gap:string;reason:string;value:number;cost:number;fingerprint:string;input?:JobInput;local?:()=>Promise<Row>};
async function execute(inv:string,a:Action) {
 const db=getD1();const before=Number((await one('SELECT COUNT(*) n FROM evidence WHERE investigation_id=?',inv))?.n??0);
 const id=crypto.randomUUID();
 await db.prepare(`INSERT OR IGNORE INTO director_actions(id,investigation_id,fingerprint,kind,target,gap,reason,expected_value,cost,before_count)
 VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id,inv,a.fingerprint,a.kind,a.target,a.gap,a.reason,a.value,a.cost,before).run();
 const saved=await one('SELECT * FROM director_actions WHERE investigation_id=? AND fingerprint=?',inv,a.fingerprint);
 if(!saved || saved.status!=='planned')return null;
 try {
  if(a.local) {
   const result=await a.local();
   await db.prepare("UPDATE director_actions SET status='done',result=?,useful=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json(result),Number(result.useful??0),saved.id).run();
   await activity(inv,`action:${saved.id}`,String(result.headline??a.reason),a.reason);return {local:true};
  }
  const input=a.input!;
  const capability=input.target_module==='site_investigator'?'site:investigate':input.target_module==='site_finder'?'site:relate':input.target_module==='operation_hunter'?'operation:reconstruct':'wallet:analyze';
  if(!(await selectModuleForCapability(capability,'platform')))return {deferred:true};
  const occupancy=Number((await one("SELECT COUNT(*) n FROM jobs WHERE target_module=? AND status IN ('pending','running','retrying')",input.target_module))?.n??0);
  const moduleLimit=await getNum(`module_limit:${input.target_module}`,input.target_module==='site_investigator'?3:1);
  const globalOccupancy=Number((await one("SELECT COUNT(*) n FROM jobs WHERE status='running'"))?.n??0);
  if(occupancy>=moduleLimit||globalOccupancy>=await getNum('global_concurrency',8))return {deferred:true};
  const existing=await one("SELECT * FROM jobs WHERE investigation_id=? AND json_extract(payload,'$.director_action_id')=? LIMIT 1",inv,saved.id);
  const q=existing?{job:existing,created:false}:await enqueueJob({...input,investigation_id:inv,created_by_module:'platform',trigger_reason:a.reason,dedupe_scope:`director:${saved.id}`,max_attempts:1,
   payload:{...((input.payload??{}) as Row),director_action_id:saved.id,automation_policy:AUTOMATION_POLICY}});
  await db.prepare("UPDATE director_actions SET status='running',job_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind((q.job as Row).id,saved.id).run();
  await activity(inv,`action:${saved.id}`,a.reason,a.reason);return {job_id:(q.job as Row).id};
 }catch(error) {
  const budget=error instanceof Error && error.message==='BUDGET_EXHAUSTED';
  await db.prepare("UPDATE director_actions SET status=?,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(budget?'budget_exhausted':'failed',json({error:budget?'Investigation allowance exhausted':String(error)}),saved.id).run();
  if(budget)return {budget:true};throw error;
 }
}
async function reconcile(inv:string) {
 for(const r of await all("SELECT r.*,j.status job_status,c.analysis_status FROM director_retries r JOIN jobs j ON j.id=r.job_id JOIN wallet_candidates c ON c.id=r.candidate_id WHERE r.investigation_id=? AND r.status='running'",inv)) {
  if(['failed','cancelled','needs-review'].includes(String(r.job_status)))await observeAnalysis(String(r.candidate_id),String(r.job_id),{status:'FAILED',reason:'Provider analysis worker stopped before a usable result'});
 }
 for(const a of await all("SELECT a.*,j.status job_status,j.result job_result FROM director_actions a LEFT JOIN jobs j ON j.id=a.job_id WHERE a.investigation_id=? AND a.status='running'",inv)) {
  if(!['completed','failed','cancelled','needs-review'].includes(String(a.job_status)))continue;
  const evidence=Number((await one('SELECT COUNT(*) n FROM evidence WHERE investigation_id=?',inv))?.n??0);
  const result=parse<Row>(a.job_result,{});
  const useful=evidence>Number(a.before_count)?1:Array.isArray(result.new_candidates)&&result.new_candidates.length? .5:0;
  await getD1().prepare('UPDATE director_actions SET status=?,result=?,useful=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(a.job_status==='completed'?'done':'failed',json(result),useful,a.id).run();
  await activity(inv,`result:${a.id}`,useful?'New evidence received':'This branch produced no new useful evidence',String(a.reason));
 }
 // Crash after enqueue, before saving job_id: adopt by immutable payload identity.
 await getD1().prepare(`UPDATE director_actions SET job_id=(SELECT j.id FROM jobs j WHERE json_extract(j.payload,'$.director_action_id')=director_actions.id LIMIT 1),status='running'
 WHERE investigation_id=? AND status='planned' AND EXISTS(SELECT 1 FROM jobs j WHERE json_extract(j.payload,'$.director_action_id')=director_actions.id)`).bind(inv).run();
}

async function humanBarrier(inv:string,site:Row|null,evidence:Row[],hasDeposit:boolean,investigated:boolean) {
 const barriers=detectBarriers(evidence as EvidenceLite[],{publicWalletFound:hasDeposit,siteInvestigated:investigated});
 for(const b of barriers) {
  const newest=Math.max(...evidence.filter(e=>b.evidence_ids.includes(String(e.id))).map(e=>ts(e.created_at)),0);
  const completed=await one("SELECT resolved_at FROM human_checkpoints WHERE investigation_id=? AND kind=? AND status='resolved' ORDER BY resolved_at DESC LIMIT 1",inv,b.kind);
  const browser=await one("SELECT MAX(received_at) at FROM wallet_observations WHERE investigation_id=? AND context_class='deposit'",inv);
  if(ts(completed?.resolved_at)>=newest || ts(browser?.at)>=newest&&hasDeposit)continue;
  await getD1().prepare("UPDATE human_checkpoints SET status='resolved',resolution='new_evidence',resolved_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND kind=? AND status='open' AND ?").bind(inv,b.kind,hasDeposit?1:0).run();
  const text=CHECKPOINT_TEXT[b.kind];
  const marks=await one('SELECT (SELECT COALESCE(MAX(rowid),0) FROM evidence WHERE investigation_id=?) ev,(SELECT COALESCE(MAX(rowid),0) FROM investigation_entities WHERE investigation_id=?) ie',inv,inv);
  await getD1().prepare(`INSERT OR IGNORE INTO human_checkpoints(id,investigation_id,kind,title,instructions,url,detected_by,trigger_evidence,evidence_watermark,observation_watermark)
   VALUES (?,?,?,?,?,?,'deterministic',?,?,?)`).bind(crypto.randomUUID(),inv,b.kind,text.title,text.instructions,site?`https://${site.canonical_key}`:null,json(b.evidence_ids),marks?.ev??0,marks?.ie??0).run();
 }
 return one("SELECT title FROM human_checkpoints WHERE investigation_id=? AND status='open' LIMIT 1",inv);
}

/** One leased decision per investigation; the existing scheduler invokes this even with no browser open. */
export async function directInvestigation(inv:string,opts:{paused?:boolean}={}) {
 const db=getD1();await enroll(inv);const owner=crypto.randomUUID();
 const claim=await db.prepare('UPDATE director_investigations SET lease_owner=?,lease_until=? WHERE investigation_id=? AND (lease_until IS NULL OR lease_until<?)').bind(owner,later(60000),inv,now()).run();
 if(claim.meta?.changes!==1)return {investigation_id:inv,skipped:'leased'};
 try {
  const i=await one('SELECT * FROM investigations WHERE id=?',inv);
  if(!i||i.status==='archived')return state(inv,'STOPPED','COMPLETED','Investigation archived');
  await reconcile(inv);await reconcileWalletPipeline(inv,{startPending:false});await adoptPartial(inv);await rebuildWalletReport(inv);
  const site=await one("SELECT e.* FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='site' ORDER BY e.created_at LIMIT 1",inv);
  const cands=await all('SELECT * FROM wallet_candidates WHERE investigation_id=?',inv),confirmed=cands.filter(c=>c.validation_status==='valid'&&c.best_context==='deposit');
  const deposit=cands.filter(c=>c.best_context==='deposit');
  const evidence=await all('SELECT * FROM evidence WHERE investigation_id=? ORDER BY created_at DESC LIMIT 150',inv);
  const jobs=await all('SELECT * FROM jobs WHERE investigation_id=? ORDER BY created_at',inv);
  const investigated=jobs.some(j=>['INVESTIGATE_SITE','RECHECK_SITE'].includes(String(j.job_type))&&['completed','needs-review'].includes(String(j.status)));
  const active=jobs.filter(j=>['pending','running','retrying'].includes(String(j.status)));
  const built=await buildWalletReportContent(inv);
  const retries=await all('SELECT * FROM director_retries WHERE investigation_id=?',inv);
  const trying=retries.filter(r=>['parked','running'].includes(String(r.status)));
  const report=await one(`SELECT rc.*,c.ready FROM report_contents c JOIN report_candidates rc ON rc.id=c.candidate_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1`,inv);
  const priorActions=await all('SELECT * FROM director_actions WHERE investigation_id=?',inv);
  const tried=new Set(priorActions.filter(a=>a.status!=='planned').map(a=>String(a.fingerprint)));
  for(const key of OBJECTIVES) {
   let status='unresolved',reason='Main is checking what evidence is available.';
   if(key==='site_worth_investigating'){status=site?'resolved':'blocked';reason=site?'A site is attached to this investigation.':'A site record is required.';}
   if(key==='payment_interface'){status=deposit.length?'resolved':investigated?'exhausted':'unresolved';reason=deposit.length?'Logger observed a deposit presentation.':investigated?'Public investigation finished; normal browsing may reveal dynamic deposit pages.':'The public site has not been investigated.';}
   if(key==='deposit_wallets'){status=deposit.length?'resolved':'unresolved';reason=deposit.length?`${deposit.length} deposit candidates observed.`:'No deposit wallet has been observed.';}
   if(key==='wallet_validation'){status=deposit.some(c=>['pending','queued'].includes(String(c.validation_status)))?'in_progress':deposit.some(c=>c.validation_status==='network_ambiguous')?'blocked':deposit.length?'resolved':'not_applicable';reason='Wallet Investigator is authoritative for checksum and network validation.';}
   if(key==='blockchain_evidence'){status=trying.length?'in_progress':confirmed.some(c=>c.analysis_status!=='completed')?'blocked':confirmed.length?'resolved':'not_applicable';reason=trying.length?'Provider recovery is parked or running with a bounded retry allowance.':'Read-only chain analysis is limited to confirmed deposit wallets.';}
   if(key==='operation_correlation'){status=priorActions.some(a=>a.kind==='correlate_wallet'&&a.status==='done')?'resolved':confirmed.length?'unresolved':'not_applicable';reason='Check existing validated observations; a shared address is a correlation signal.';}
   if(key==='related_sites'){status=priorActions.some(a=>a.kind==='find_related'&&a.status==='done')?'exhausted':'unresolved';reason='Only specific recorded public artifacts justify bounded discovery.';}
   if(key==='report_readiness'||key==='report_blockers'){status=built.ready&&!trying.length?'resolved':active.length||trying.length?'in_progress':'blocked';reason=built.ready&&!trying.length?'Exact report contents are ready for approval.':built.warnings.join('; ')||'A confirmed deposit wallet is required.';}
   await objective(inv,key,status,reason,evidence.slice(0,8).map(e=>e.id));
  }
  const submission=jobs.find(j=>j.id===report?.submission_job_id);
  if(report?.verification_status==='verified')return state(inv,'COMPLETE','COMPLETED','Submission verified');
  if(submission&&['pending','running','retrying','needs-review','failed','completed'].includes(String(submission.status))) {
   if(submission.status==='completed')return state(inv,'COMPLETE','COMPLETED','Submission recorded; confirmation is unverified');
   if(submission.status==='failed')return state(inv,'WAITING_FOR_HUMAN','WAITING_FOR_HUMAN','Submission failed; review the outcome before any further attempt');
   return state(inv,submission.status==='needs-review'?'WAITING_FOR_HUMAN':'WAITING_FOR_MODULE',submission.status==='needs-review'?'WAITING_FOR_HUMAN':null,submission.status==='needs-review'?'Submission needs your verification':'Approved report is being submitted');
  }
  if(report?.status==='blocked')return state(inv,'STOPPED','WAITING_FOR_HUMAN','The analyst rejected this report; Main will not resubmit it');
  if(await one("SELECT id FROM human_checkpoints WHERE investigation_id=? AND status='cancelled' AND NOT EXISTS(SELECT 1 FROM human_checkpoints c WHERE c.investigation_id=? AND c.status='resolved' AND c.resolved_at>human_checkpoints.resolved_at) LIMIT 1",inv,inv))return state(inv,'STOPPED','WAITING_FOR_HUMAN','The analyst cancelled the human step');
  const human=await humanBarrier(inv,site,evidence,deposit.length>0,investigated);
  // Existing, validated deposit evidence can be analysed read-only while a browser
  // or network judgment is waiting. A checkpoint never authorizes site access.
  if(human&&!trying.length)return state(inv,'WAITING_FOR_HUMAN','WAITING_FOR_HUMAN',String(human.title));
  const correlationPending=confirmed.some(c=>!tried.has(`correlate:${c.identity}:${Number(c.observations)}`));
  const correlatedForHunter=priorActions.some(a=>a.kind==='correlate_wallet'&&Number(a.useful)>0);
  const hunterPending=Boolean(site&&correlatedForHunter&&!tried.has(`hunter:${site.id}`)&&await selectModuleForCapability('operation:reconstruct','platform'));
  const finderPending=Boolean(site&&!tried.has(`finder:${site.id}`)&&(confirmed.length||(await investigationArtifacts(inv,String(site.canonical_key))).length)&&await selectModuleForCapability('site:relate','platform'));
  if(built.ready&&!trying.length&&!correlationPending&&!hunterPending&&!finderPending&&!active.length){await rebuildWalletReport(inv);return state(inv,'WAITING_FOR_HUMAN','READY_TO_REPORT','Ready for your approval');}
  if(opts.paused||await getBool('scheduler_paused',false))return state(inv,'PAUSED',null,'Autonomous starts are paused');
  // Reconcile wallet candidates without a button. Local validation does not make Main authoritative.
  const pending=cands.find(c=>c.validation_status==='pending'||c.validation_status==='valid'&&c.best_context==='deposit'&&['none','skipped'].includes(String(c.analysis_status)));
  if(pending){await advanceCandidate(String(pending.id));return state(inv,'WAITING_FOR_MODULE',null,'Wallet Investigator is validating the observed address');}
  if(active.some(j=>j.job_type!=='PREPARE_REPORT'&&(!trying.length||j.target_module==='wallet_investigator')))return state(inv,'WAITING_FOR_MODULE',null,active[0].trigger_reason?String(active[0].trigger_reason):'Waiting for the current module result');
  const legacyOwner=await one("SELECT id FROM agent_runs WHERE investigation_id=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED') LIMIT 1",inv);
  const legacyQueued=await one("SELECT id FROM work_items WHERE investigation_id=? AND status IN ('queued','running','deferred') AND (status='running' OR not_before IS NULL OR julianday(not_before)<=julianday('now')) AND kind IN ('investigate_candidate','find_related_sites','reconstruct_operation','revisit_incomplete','revisit_changed_site') LIMIT 1",inv);
  const owned=Boolean(legacyOwner||legacyQueued);
  const actions:Action[]=[];
  for(const r of trying.filter(r=>r.status==='parked')) {
   const c=cands.find(c=>c.id===r.candidate_id);if(!c)continue;
   const health=await one('SELECT * FROM director_provider_health WHERE network=?',c.validated_network);
   const readyAt=Math.max(ts(r.next_at),health?.state==='unavailable'?ts(health.next_probe_at):0);
   if(readyAt>Date.now())continue;
   const generation=Number(r.generation)+1;
   actions.push({kind:'provider_retry',target:String(c.id),gap:'blockchain_evidence',reason:'Retry blockchain analysis because the provider backoff expired',value:.95,cost:1,fingerprint:`retry:${c.id}:${generation}`,
    input:{job_type:'REFRESH_WALLET',target_entity_id:site?String(site.id):null,target_module:'wallet_investigator',created_by_module:'platform',budget_dimension:'wallet',priority:85,payload:{pipeline:'wallet-v4',wallet_candidate_id:c.id,address:c.address,family:c.family,candidate_networks:parse(c.candidate_networks,[]),network_hint:parse(c.network_hint,null),analyze:true,refresh_key:`director:${c.id}:${generation}`}}});
  }
  if(site&&!owned&&!deposit.length&&!investigated&&!jobs.some(j=>j.target_entity_id===site.id&&j.job_type==='INVESTIGATE_SITE')) actions.push({kind:'investigate_site',target:String(site.canonical_key),gap:'payment_interface',reason:'Look for the deposit interface in public site evidence',value:.8,cost:2,fingerprint:`public:${site.id}`,input:{job_type:'INVESTIGATE_SITE',target_module:'site_investigator',created_by_module:'platform',target_entity_id:String(site.id),budget_dimension:'job',payload:{canonical_key:site.canonical_key,limits:{max_pages:20}}}});
  for(const c of confirmed) {
   const fp=`correlate:${c.identity}:${Number(c.observations)}`;
   if(!tried.has(fp))actions.push({kind:'correlate_wallet',target:String(c.identity),gap:'operation_correlation',reason:'Check where this validated deposit wallet has also been observed',value:.65,cost:.2,fingerprint:fp,local:async()=>{
    const related=await all("SELECT DISTINCT investigation_id FROM wallet_candidates WHERE identity=? AND validated_network=? AND investigation_id<>? AND validation_status='valid' AND best_context='deposit'",c.identity,c.validated_network,inv);
    return {headline:related.length?'Wallet also observed on another investigated site':'No other validated deposit observation found',investigations:related.map(r=>r.investigation_id),evidence_refs:(await all("SELECT evidence_id FROM wallet_observations WHERE candidate_id=? AND context_class='deposit'",c.id)).map(r=>r.evidence_id),useful:related.length?1:0,uncertainty:'Shared wallet observation does not establish common ownership.'};
   }});
  }
  const correlated=priorActions.find(a=>a.kind==='correlate_wallet'&&Number(a.useful)>0);
  if(site&&!owned&&correlated&&!tried.has(`hunter:${site.id}`))actions.push({kind:'reconstruct_operation',target:String(site.canonical_key),gap:'operation_correlation',reason:'Ask Operation Hunter to evaluate the validated cross-site wallet signal',value:.65,cost:2,fingerprint:`hunter:${site.id}`,input:{job_type:'HUNT_OPERATION',target_module:'operation_hunter',created_by_module:'platform',budget_dimension:'job',payload:{seed:{type:'site',value:site.canonical_key},seeds:[{type:'site',value:site.canonical_key}],title:i.title,reason:'validated_wallet_overlap',budget:6}}});
  const artifacts=site?await investigationArtifacts(inv,String(site.canonical_key)):[];
  if(confirmed.length)artifacts.push(...confirmed.slice(0,2).map(c=>({kind:'wallet',value:String(c.address)})));
  if(site&&!owned&&artifacts.length&&!trying.length&&!tried.has(`finder:${site.id}`))actions.push({kind:'find_related',target:String(site.canonical_key),gap:'related_sites',reason:'Start a bounded related-site hunt from recorded public artifacts',value:.45,cost:2,fingerprint:`finder:${site.id}`,input:{job_type:'FIND_RELATED_SITES',target_module:'site_finder',created_by_module:'platform',target_entity_id:String(site.id),budget_dimension:'related_site',payload:{domain:site.canonical_key,seeds:[site.canonical_key],artifacts:artifacts.slice(0,8),requested:4,budget:{http:40},reason:'director_evidence_gap'}}});
  // Existing Hunter gaps are delegated through their existing Main work items, never reimplemented here.
  for(const a of actions)a.value=Math.max(.1,a.value+await prior(a.kind));
  const v5order=actions.filter(a=>!tried.has(a.fingerprint)&&(!human||a.kind==='provider_retry')).sort((a,b)=>b.value/b.cost-a.value/a.cost||a.fingerprint.localeCompare(b.fingerprint));
  // v7: re-order (never add or remove) the v5 actions by typed-gap information value per cost, with a recorded explanation.
  const {arbitrate}=await import('../adaptive/director-bridge');
  const eligible=await arbitrate({inv,site,cands,investigated,reportReady:Boolean(built.ready),priorActions,providerHealth:await all('SELECT * FROM director_provider_health')},v5order);
  if(eligible.length) {
   const a=eligible[0],out=await execute(inv,a);
   if(out?.budget) {
    if(a.kind==='provider_retry')await db.prepare("UPDATE director_retries SET status='budget_exhausted' WHERE candidate_id=?").bind(a.target).run();
    return state(inv,'STOPPED','BUDGET_EXHAUSTED','The investigation allowance is exhausted');
   }
   if(out?.deferred)return state(inv,'WAITING_FOR_MODULE',null,'Waiting for the module to reconnect',later(5*60000));
   if(a.kind==='provider_retry'&&out?.job_id) {
    await db.batch([db.prepare("UPDATE director_retries SET status='running',attempts=attempts+1,generation=generation+1,job_id=?,updated_at=CURRENT_TIMESTAMP WHERE candidate_id=? AND status='parked'").bind(out.job_id,a.target),db.prepare("UPDATE wallet_candidates SET analysis_status='queued',analysis_job_id=? WHERE id=?").bind(out.job_id,a.target)]);
   }
   return state(inv,out?.local?'RUNNING':'WAITING_FOR_MODULE',null,a.reason);
  }
  if(owned)return state(inv,'WAITING_FOR_MODULE',null,'Existing investigation work is answering the evidence gap');
  if(trying.length)return state(inv,'WAITING_FOR_PROVIDER','PROVIDER_UNAVAILABLE','Provider unavailable — automatic recovery is parked',trying.map(r=>String(r.next_at)).sort()[0]);
  if(retries.some(r=>r.status==='exhausted'||r.status==='budget_exhausted'))return state(inv,'STOPPED',retries.some(r=>r.status==='budget_exhausted')?'BUDGET_EXHAUSTED':'PROVIDER_UNAVAILABLE','Provider recovery stopped at its bounded limit');
  if(cands.some(c=>c.best_context==='deposit'&&c.validation_status==='network_ambiguous')){
   await db.prepare("INSERT OR IGNORE INTO human_checkpoints(id,investigation_id,kind,title,instructions,detected_by,trigger_evidence) VALUES (?,?,'analyst_review','Resolve deposit wallet network','Review the network displayed beside the deposit address; Main cannot choose between incompatible networks.','deterministic','[]')").bind(crypto.randomUUID(),inv).run();
   return state(inv,'WAITING_FOR_HUMAN','WAITING_FOR_HUMAN','A deposit wallet has an ambiguous network; analyst judgment is required');
  }
  return state(inv,'STOPPED',!site?'INSUFFICIENT_PUBLIC_EVIDENCE':!confirmed.length?'NO_REPORTABLE_WALLET':artifacts.length?'SOURCE_EXHAUSTED':'LOW_EXPECTED_VALUE',!confirmed.length?'No reportable deposit wallet; safe public options are exhausted':'Further work has low expected value; the remaining report blockers are recorded');
 }finally{await db.prepare('UPDATE director_investigations SET lease_owner=NULL,lease_until=NULL WHERE investigation_id=? AND lease_owner=?').bind(inv,owner).run();}
}
export async function directorTick(paused=false,limit=20) {
 // Round-robin by last evaluation prevents a stopped case from starving a later one.
 const rows=await all(`SELECT i.id FROM investigations i LEFT JOIN director_investigations d ON d.investigation_id=i.id
 WHERE i.status<>'archived' AND (d.next_at IS NULL OR d.next_at<=?) ORDER BY COALESCE(d.updated_at,'') ASC,i.id LIMIT ?`,now(),limit);
 // v7: within the due set, higher last expected value goes first (bounded starvation boost keeps it fair).
 const {investigationOrder}=await import('../adaptive/director-bridge');
 const ordered=await investigationOrder(rows.map(r=>String(r.id)));
 const outcomes=[];for(const id of ordered)outcomes.push(await directInvestigation(id,{paused}));return outcomes;
}
export async function directorView(inv:string) {
 if(!(await one('SELECT id FROM investigations WHERE id=?',inv)))return null;
 const director=await one('SELECT * FROM director_investigations WHERE investigation_id=?',inv);
 const objectives=await all('SELECT * FROM director_objectives WHERE investigation_id=?',inv);
 const actions=await all('SELECT * FROM director_actions WHERE investigation_id=? ORDER BY created_at DESC LIMIT 40',inv);
 const findings=await all('SELECT id,title,evidence_class,source_module FROM evidence WHERE investigation_id=? ORDER BY created_at DESC LIMIT 8',inv);
 const wallets=await all('SELECT id,address,validated_network,validation_status,best_context,analysis_status FROM wallet_candidates WHERE investigation_id=? ORDER BY best_context LIMIT 40',inv);
 const tasks=await all("SELECT id,kind,title,instructions,url FROM human_checkpoints WHERE investigation_id=? AND status='open'",inv);
 const report=await one(`SELECT rc.*,c.ready,c.warnings,c.summary,j.status job_status FROM report_contents c JOIN report_candidates rc ON rc.id=c.candidate_id LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1`,inv);
 const lifecycle=!report?'BUILDING':report.verification_status==='verified'?'SUBMITTED_VERIFIED':report.verification_status==='unverified'?'SUBMITTED_UNVERIFIED':report.job_status==='needs-review'?'NEEDS_HUMAN':report.job_status==='failed'?'FAILED_FINAL':report.job_status==='retrying'?'FAILED_RETRYABLE':report.job_status==='running'?'SUBMITTING':report.status==='ready'?'APPROVED':report.status==='blocked'?'FAILED_FINAL':report.ready?'AWAITING_APPROVAL':'NOT_READY';
 const timeline=await all("SELECT title,reason,created_at FROM investigation_timeline WHERE investigation_id=? AND event_type='director.activity' ORDER BY rowid DESC LIMIT 30",inv);
 return {investigation_id:inv,state:director?.state??'NEW',stop_reason:director?.stop_reason??null,doing:director?.headline??'Waiting for the next automatic maintenance tick',why:actions[0]?.reason??'Main evaluates the recorded evidence and available safe actions.',next:director?.next_at??null,objectives:objectives.map(o=>({...o,evidence_refs:parse(o.evidence_refs,[])})),findings,wallets,needs_you:tasks,report:{lifecycle,missing:parse(report?.warnings,[]),candidate_id:report?.id??null,content_sha256:report?.evidence_sha256??null,summary:parse(report?.summary,null)},timeline,
 advanced:{actions:actions.map(a=>({...a,result:parse(a.result,{})})),resources:await one('SELECT * FROM director_resources WHERE investigation_id=?',inv),retries:await all('SELECT * FROM director_retries WHERE investigation_id=?',inv)}};
}
