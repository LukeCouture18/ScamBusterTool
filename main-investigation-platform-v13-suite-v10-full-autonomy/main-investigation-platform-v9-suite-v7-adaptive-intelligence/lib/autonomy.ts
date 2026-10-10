/** The v9 front door and durable read model. Specialist evidence remains authoritative. */
import { getD1, json, sha256 } from './platform';
import { enroll } from './director/resources';
import { ensureBudget } from './planner';
import { directInvestigation } from './director/director';
import { publishEvent } from './events';
import {autonomyQueue} from './autonomy-queue';
import {assertExecutionAllowed} from './ops/guard';
import { parse, type Row } from './ops/common';

export const OPERATOR_STATES = ['Starting','Investigating site','Waiting for login','Looking for wallet','Validating wallet','Analyzing wallet','Checking related evidence','Building report','Ready for approval','Submitting','Submitted','Parked','Needs you'] as const;
const all=async(q:string,...a:unknown[])=>(await getD1().prepare(q).bind(...a).all<Row>()).results;
const one=async(q:string,...a:unknown[])=>getD1().prepare(q).bind(...a).first<Row>();
export function siteUrl(input:string) {
 const u=new URL(/^https?:\/\//i.test(input.trim())?input.trim():`https://${input.trim()}`);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!u.hostname.includes('.')||u.hostname.length>253)throw new Error('Enter a public site URL without account details.');
 u.hash='';u.search='';return u;
}

/** Atomic site identity + investigation creation makes concurrent starts resumptions. */
export async function investigateSite(input:string,lineage?:{root_id:string;parent_id:string;depth:number}) {
 assertExecutionAllowed('autonomy:investigate_site');
 const u=siteUrl(input),domain=u.hostname.toLowerCase().replace(/^www\./,''),db=getD1();
 let known=await one(`SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id
 WHERE e.entity_type='site' AND e.canonical_key=? AND i.status<>'archived' AND ie.source_module IN ('platform','site_finder','site_investigator','crypto_wallet_logger')
 ORDER BY CASE WHEN i.external_id=? THEN 0 ELSE 1 END,i.created_at LIMIT 1`,domain,`site:${domain}`);
 if(!known) {
  const inv=crypto.randomUUID(),entity=crypto.randomUUID(),ext=`site:${domain}`;
  await db.batch([
   db.prepare("INSERT OR IGNORE INTO investigations(id,external_id,title,description) VALUES (?,?,?,?)").bind(inv,ext,`Investigate ${domain}`,'Normal browsing supplies passive observations. Wallet Investigator validates; exact report approval is required.'),
   db.prepare("INSERT OR IGNORE INTO entities(id,entity_type,canonical_key,display_name,investigation_id) SELECT ?,'site',?,?,id FROM investigations WHERE external_id=?").bind(entity,domain,domain,ext),
   db.prepare("INSERT OR IGNORE INTO investigation_entities(id,investigation_id,entity_id,role,source_module,source_record_id,schema_version) SELECT ?,i.id,e.id,'primary','platform',?,'3.0' FROM investigations i JOIN entities e ON e.entity_type='site' AND e.canonical_key=? WHERE i.external_id=?").bind(`start:${domain}`,ext,domain,ext)
  ]);
  known=await one('SELECT id FROM investigations WHERE external_id=?',ext);
 }
 const inv=String(known!.id);
 await db.prepare('INSERT OR IGNORE INTO autonomy_investigations(investigation_id,site_url) VALUES (?,?)').bind(inv,u.href).run();
 await enroll(inv);await ensureBudget(inv);
 const {ensureMission}=await import('./missions');await ensureMission(inv,u.href,lineage);
 // Transfer only unstarted legacy scheduling ownership; running jobs remain owned.
 await db.prepare(`UPDATE work_items SET status='superseded',reason='Public investigation is owned by the durable Start Investigation pipeline',updated_at=CURRENT_TIMESTAMP
 WHERE investigation_id=? AND status IN ('queued','deferred') AND job_id IS NULL AND run_id IS NULL
 AND kind IN ('investigate_candidate','find_related_sites','reconstruct_operation')`).bind(inv).run();
 await db.prepare(`UPDATE agent_runs SET status='STOPPED',stop_reason='Durable investigation handoff',finished_at=CURRENT_TIMESTAMP
 WHERE investigation_id=? AND status='WAITING_FOR_MODULE' AND NOT EXISTS(SELECT 1 FROM jobs WHERE investigation_id=? AND status IN ('pending','running','retrying'))
 AND NOT EXISTS(SELECT 1 FROM human_checkpoints WHERE investigation_id=? AND status='open')`).bind(inv,inv,inv).run();
 await directInvestigation(inv);await projectAutonomy(inv);
 return {investigation_id:inv,site_url:u.href,workspace_url:`/investigations/${inv}`,state:(await one('SELECT state FROM autonomy_investigations WHERE investigation_id=?',inv))?.state};
}

/** Recover the window after a committed approval and before event delivery. No approval is invented. */
export async function recoverApprovedReports(limit=30) {
 const rows=await all(`SELECT c.id,c.investigation_id,c.evidence_sha256,c.approval_id FROM report_candidates c JOIN approval_gates a ON a.id=c.approval_id
 WHERE a.status='approved' AND a.action='PREPARE_REPORT' AND c.status IN ('needs_review','ready') AND c.submission_job_id IS NULL ORDER BY c.created_at LIMIT ?`,limit);
 for(const c of rows) {
  const site=await one("SELECT e.id FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='site' ORDER BY e.created_at LIMIT 1",c.investigation_id);
  if(!site)continue;
  await getD1().prepare("UPDATE report_candidates SET status='ready' WHERE id=? AND status='needs_review'").bind(c.id).run();
  await publishEvent('platform',{event_id:`report:${c.id}:ready`,event_type:'report.ready',schema_version:'3.0',hop_count:0,investigation_id:String(c.investigation_id),entity_id:String(site.id),
   provenance:{candidate_id:c.id,evidence_sha256:c.evidence_sha256,approval_id:c.approval_id},payload:{candidate_id:c.id,evidence_sha256:c.evidence_sha256}});
 }
 return rows.length;
}

async function checkpoint(inv:string,key:string,kind:string,what:string,why:string,action:string,afterward:string,url:string|null,source:string|null) {
 await getD1().prepare(`INSERT INTO autonomy_checkpoints(investigation_id,checkpoint_key,kind,what,why,action,afterward,url,source_id)
 VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(investigation_id,checkpoint_key) DO UPDATE SET what=excluded.what,why=excluded.why,action=excluded.action,afterward=excluded.afterward,url=excluded.url,source_id=excluded.source_id,status='open',updated_at=CURRENT_TIMESTAMP`)
 .bind(inv,key,kind,what,why,action,afterward,url,source).run();
}

/** Projection never starts jobs. It tells the operator what can actually happen next. */
export async function projectAutonomy(inv:string) {
 const db=getD1(),site=await one("SELECT e.canonical_key FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='site' ORDER BY e.created_at LIMIT 1",inv);
 if(!site)return null;
 await db.prepare('INSERT OR IGNORE INTO autonomy_investigations(investigation_id,site_url) VALUES (?,?)').bind(inv,`https://${site.canonical_key}/`).run();
 const [d,cands,jobs,human,report,retry,queue]=await Promise.all([
  one('SELECT * FROM director_investigations WHERE investigation_id=?',inv),all('SELECT * FROM wallet_candidates WHERE investigation_id=?',inv),
  all("SELECT id,job_type,status,available_at,last_error FROM jobs WHERE investigation_id=? AND status IN ('pending','running','retrying','needs-review') ORDER BY priority DESC LIMIT 50",inv),
  all("SELECT * FROM human_checkpoints WHERE investigation_id=? AND status='open' ORDER BY created_at LIMIT 30",inv),
  one("SELECT r.*,c.ready,c.superseded_by,c.warnings,c.summary,j.status job_status FROM report_contents c JOIN report_candidates r ON r.id=c.candidate_id LEFT JOIN jobs j ON j.id=r.submission_job_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1",inv),
  one("SELECT status,next_at,reason FROM director_retries WHERE investigation_id=? AND status IN ('parked','running','exhausted','budget_exhausted') ORDER BY next_at LIMIT 1",inv),autonomyQueue(inv)
 ]);
 await db.prepare("UPDATE autonomy_checkpoints SET status='resolved' WHERE investigation_id=? AND status='open'").bind(inv).run();
 let state:string='Looking for wallet',doing='Observe deposit information delivered during your normal browsing.',next='Browse normally. Main will validate relevant observations and prepare the report automatically.',stop:string|null=null,nextAt:string|null=null;
 const deposit=cands.filter(c=>c.best_context==='deposit');
 const submission=report?.submission_job_id;
 if(report?.verification_status==='verified'||report?.status==='completed') {
  state='Submitted';doing=report.verification_status==='verified'?'The destination confirmed this submission.':'Submission was recorded; independent confirmation is unavailable.';next='The exact approved report and submission result are preserved.';
 } else if(submission&&['pending','running','retrying'].includes(String(report?.job_status))) {
  state='Submitting';doing='Form Submitter is filing the exact approved report.';next='Main will preserve the receipt or ask you to verify an uncertain result.';
 } else if(submission&&['needs-review','failed'].includes(String(report?.job_status))) {
  state='Needs you';doing='The submission outcome needs verification.';stop='Submission may have reached the destination; automatic resubmission could duplicate it.';next='Verify the destination before deciding whether another submission is appropriate.';
  await checkpoint(inv,'submission','submission_verification',doing,stop,'Review submission result',next,'/reports',String(report?.id));
 } else if(report?.status==='blocked') {
  state='Parked';doing='You rejected this report.';stop='Approval was declined.';next='New source evidence can create an updated report.';
 } else if(report?.ready&&report.status==='needs_review'&&!['parked','running'].includes(String(retry?.status))&&human.length===0&&d?.stop_reason==='READY_TO_REPORT'&&Number(queue.counts.running)+Number(queue.counts.runnable)+Number(queue.counts['failed retryable'])===0) {
  state='Ready for approval';doing='Report ready. Submit?';next='Review once and approve. Form Submitter will submit only these exact contents.';
  await checkpoint(inv,`report:${report.id}`,'final_approval',doing,'Main needs your approval before sending a report.','Review / Approve & Submit',next,`/reports?investigation=${inv}`,String(report.id));
 } else if(human.length) {
const h=human[0],login=['login','captcha','mfa','email_verification'].includes(String(h.kind));state=login?'Waiting for login':'Needs you';doing=login?'Login required':String(h.title);stop=login?'Deposit/payment information appears to require account access.':String(h.instructions);next='Main resumes automatically when appropriate new browser evidence arrives. Submit login and complete verification yourself.';
  for(const h of human)await checkpoint(inv,`human:${h.id}`,String(h.kind),String(h.title),String(h.instructions),login?'Open login':'Review evidence',next,h.url?String(h.url):null,String(h.id));
 } else if(retry?.status==='parked') {
  state='Parked';doing='The blockchain provider is temporarily unavailable.';stop=String(retry.reason);next='Main will retry automatically after the provider backoff.';nextAt=String(retry.next_at);
 } else if(deposit.some(c=>['pending','queued'].includes(String(c.validation_status)))) {state='Validating wallet';doing='Wallet Investigator is checking address validity and displayed network.';}
 else if(deposit.some(c=>c.validation_status==='valid'&&['queued','running'].includes(String(c.analysis_status)))) {state='Analyzing wallet';doing='Gather bounded, read-only blockchain evidence.';}
 else if(Number(queue.counts.orphaned)>0&&!queue.counts.runnable&&!queue.counts.running&&!queue.counts['failed retryable']) {state='Parked';doing='A required specialist is disconnected.';stop='No work can execute until the specialist reconnects.';next='Main will resume automatically when the specialist becomes available.';}
 else if(jobs.some(j=>['INVESTIGATE_SITE','RECHECK_SITE'].includes(String(j.job_type)))) {state='Investigating site';doing='Collect bounded public site evidence.';}
 else if(jobs.some(j=>['HUNT_OPERATION','FIND_RELATED_SITES','DISCOVER_SITES'].includes(String(j.job_type)))) {state='Checking related evidence';doing='Check useful public pivots within the investigation allowance.';}
 else if(d?.state==='STOPPED'||d?.state==='PAUSED'||d?.next_at&&Date.parse(String(d.next_at))>Date.now()||retry) {state='Parked';doing=String(d?.headline??'Safe useful options are exhausted.');stop=String(d?.stop_reason??retry?.reason??'No executable work remains.');next='New browser evidence or a due revisit can resume the investigation.';nextAt=d?.next_at?String(d.next_at):null;}
 else if(deposit.some(c=>c.validation_status==='valid')&&report) {state='Building report';doing='Check evidence provenance and report completeness.';}
 const hash=await sha256(json({state,doing,next,stop,nextAt}));
 await db.batch([
  db.prepare('UPDATE autonomy_investigations SET state=?,doing=?,next_action=?,stop_reason=?,next_at=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND (state<>? OR doing<>? OR next_action<>? OR COALESCE(stop_reason,\'\')<>? OR COALESCE(next_at,\'\')<>?)').bind(state,doing,next,stop,nextAt,inv,state,doing,next,stop??'',nextAt??''),
  db.prepare('INSERT OR IGNORE INTO autonomy_history(id,investigation_id,state,reason,content_hash) VALUES (?,?,?,?,?)').bind(`${inv}:${hash}`,inv,state,doing,hash)
 ]);
 return {investigation_id:inv,state,doing,next,stop_reason:stop,next_at:nextAt};
}

export async function autonomyTick(limit=30) {
 await recoverApprovedReports();
 const ids=await all("SELECT i.id FROM investigations i LEFT JOIN autonomy_investigations a ON a.investigation_id=i.id WHERE i.status<>'archived' ORDER BY COALESCE(a.updated_at,'') LIMIT ?",limit);
 for(const i of ids)await projectAutonomy(String(i.id));
 return {projected:ids.length};
}

export async function autonomyView(inv:string) {
 await projectAutonomy(inv);
 const state=await one('SELECT a.*,i.title FROM autonomy_investigations a JOIN investigations i ON i.id=a.investigation_id WHERE a.investigation_id=?',inv);
 if(!state)return null;
 const [wallets,evidence,needs,report,related]=await Promise.all([
  all("SELECT id,address,validated_network network,validation_status,best_context context,analysis_status activity FROM wallet_candidates WHERE investigation_id=? ORDER BY CASE best_context WHEN 'deposit' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT 40",inv),
  all('SELECT id,title,source_module,uri,captured_at FROM evidence WHERE investigation_id=? ORDER BY captured_at DESC LIMIT 8',inv),
  all("SELECT * FROM autonomy_checkpoints WHERE investigation_id=? AND status='open' ORDER BY checkpoint_key LIMIT 30",inv),
  one('SELECT r.id,r.status,r.evidence_sha256 content_sha256,r.verification_status,c.ready,c.summary,c.warnings FROM report_candidates r JOIN report_contents c ON c.candidate_id=r.id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1',inv),
  all("SELECT DISTINCT e.canonical_key domain FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='related_site' LIMIT 15",inv)
 ]);
 return {...state,wallets,evidence,needs_you:needs,related_sites:related,report:report?{...report,summary:parse(report.summary,{}),warnings:parse(report.warnings,[])}:null};
}

export async function continueInvestigation(inv:string) {
 const exists=await one('SELECT id FROM investigations WHERE id=?',inv);if(!exists)return null;
 await getD1().prepare("UPDATE human_checkpoints SET status='resolved',resolved_at=CURRENT_TIMESTAMP,resolution='analyst_confirmed' WHERE investigation_id=? AND status='open' AND kind IN ('login','captcha','mfa','email_verification')").bind(inv).run();
 await directInvestigation(inv);return autonomyView(inv);
}

export async function autonomyDashboard() {
 const [active,needs,reports,recent,searches]=await Promise.all([
  all("SELECT a.*,i.title FROM autonomy_investigations a JOIN investigations i ON i.id=a.investigation_id WHERE a.state<>'Submitted' ORDER BY a.updated_at DESC LIMIT 30"),
  all("SELECT c.*,i.title FROM autonomy_checkpoints c JOIN investigations i ON i.id=c.investigation_id WHERE c.status='open' ORDER BY c.updated_at DESC LIMIT 50"),
  all("SELECT a.investigation_id,a.site_url,i.title FROM autonomy_investigations a JOIN investigations i ON i.id=a.investigation_id WHERE a.state='Ready for approval' LIMIT 30"),
  all('SELECT e.id,e.investigation_id,e.title,e.source_module,e.captured_at FROM evidence e ORDER BY e.created_at DESC LIMIT 8'),
  all("SELECT id,state,reason,investigation_id FROM autonomy_searches WHERE state IN ('Finding site','Starting','Parked') ORDER BY updated_at DESC LIMIT 5")
 ]);
 return {active,needs_you:needs,reports_ready:reports,recent,searches};
}
