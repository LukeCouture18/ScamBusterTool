import { getD1, json, now, type SourceModule } from "./platform";
import { canTransitionJob, jobDedupeKey, retryDelaySeconds } from "./domain.mjs";
import { assertExecutionAllowed } from "./ops/guard";

export type JobInput = { job_type: string; investigation_id?: string | null; target_entity_id?: string | null; target_module: SourceModule; created_by_module: SourceModule; payload?: unknown; priority?: number; max_attempts?: number; parent_job_id?: string | null; pipeline_id?: string | null; stage_key?: string | null; trigger_reason?: string; trigger_rule_id?: string | null; trigger_event_id?: string | null; correlation_id?: string | null; requires_approval?: boolean; freshness_key?: string | null; depends_on_job_ids?: string[]; budget_dimension?: "wallet" | "related_site" | "job"; dedupe_scope?: string };

export async function enqueueJob(input: JobInput) {
  assertExecutionAllowed(`enqueueJob:${input.job_type}`);
  // dedupe_scope (v4) distinguishes otherwise-identical global jobs, e.g. two discovery pivots on different indicators.
  const db = getD1(); const dedupe = jobDedupeKey(input.job_type, input.investigation_id, input.target_entity_id, input.target_module) + (input.dedupe_scope ? `:${input.dedupe_scope.slice(0, 200)}` : "");
  const existing = await db.prepare("SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('pending','running','retrying','needs-review')").bind(dedupe).first<Record<string, unknown>>();
  if (existing) return { job: existing, created: false, duplicate: true };
  const id = crypto.randomUUID();
  const { reservation } = await import("./director/resources");
  const reserve = await reservation(input,id);
  try {
    const approvalStatus=input.requires_approval?"pending":"not_required"; const status=input.requires_approval?"awaiting-approval":"pending";
    const values=[id,input.job_type,input.investigation_id??null,input.target_entity_id??null,input.target_module,input.created_by_module,dedupe,json(input.payload),Math.max(0,Math.min(100,input.priority??50)),input.max_attempts??3,input.parent_job_id??null,input.pipeline_id??null,input.stage_key??null,input.trigger_reason??"",input.trigger_rule_id??null,input.trigger_event_id??null,input.correlation_id??null,input.requires_approval?1:0,approvalStatus,input.freshness_key??null,status];
    const fields="id,job_type,investigation_id,target_entity_id,target_module,created_by_module,dedupe_key,payload,priority,max_attempts,parent_job_id,pipeline_id,stage_key,trigger_reason,trigger_rule_id,trigger_event_id,correlation_id,requires_approval,approval_status,freshness_key,status";
    if(input.budget_dimension || reserve){
      if(!input.investigation_id)throw new Error("BUDGET_INVESTIGATION_REQUIRED");
      const extra=input.budget_dimension==="wallet"?" AND used_wallets<max_wallets":input.budget_dimension==="related_site"?" AND used_related_sites<max_related_sites":"";
      const incr=input.budget_dimension==="wallet"?",used_wallets=used_wallets+1":input.budget_dimension==="related_site"?",used_related_sites=used_related_sites+1":"";
      const statements=[
        db.prepare(`INSERT INTO jobs (${fields}) SELECT ${values.map(()=>"?").join(",")} FROM investigation_budgets WHERE investigation_id=? AND used_jobs<max_jobs AND used_api_calls<max_api_calls AND used_runtime_seconds<max_runtime_seconds${extra}${reserve?.predicate ?? ""}`).bind(...values,input.investigation_id,...(reserve?.args ?? [])),
        db.prepare(`UPDATE investigation_budgets SET used_jobs=used_jobs+1${incr},updated_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=?)`).bind(input.investigation_id,id),
        db.prepare("INSERT INTO job_events (id,job_id,source_module,event_type,message) SELECT ?,id,?,'created','Job queued' FROM jobs WHERE id=?").bind(crypto.randomUUID(),input.created_by_module,id),
      ];
      if(reserve)statements.push(...reserve.statements);
      const dp=(input.payload && typeof input.payload==='object'?input.payload:{}) as Record<string,unknown>;
      if(typeof dp.director_action_id==='string')statements.push(db.prepare("UPDATE director_actions SET status='running',job_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=?)").bind(id,dp.director_action_id,id));
      if(typeof dp.refresh_key==='string' && typeof dp.wallet_candidate_id==='string' && dp.director_action_id)statements.push(
       db.prepare("UPDATE director_retries SET status='running',attempts=attempts+1,generation=generation+1,job_id=?,updated_at=CURRENT_TIMESTAMP WHERE candidate_id=? AND status='parked' AND EXISTS(SELECT 1 FROM jobs WHERE id=?)").bind(id,dp.wallet_candidate_id,id),
       db.prepare("UPDATE wallet_candidates SET analysis_status='queued',analysis_job_id=? WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=?)").bind(id,dp.wallet_candidate_id,id));
      if(input.trigger_event_id)statements.push(db.prepare("INSERT OR IGNORE INTO job_event_links (id,job_id,event_id,link_type,explanation) SELECT ?,id,?,'triggered_by',? FROM jobs WHERE id=?").bind(crypto.randomUUID(),input.trigger_event_id,input.trigger_reason??"",id));
      for(const dep of input.depends_on_job_ids??[])statements.push(db.prepare("INSERT INTO job_dependencies (job_id,depends_on_job_id) SELECT id,? FROM jobs WHERE id=?").bind(dep,id));
      const results=await db.batch(statements);if((results[0]?.meta?.changes??0)!==1)throw new Error("BUDGET_EXHAUSTED");
      return{job:await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first(),created:true,duplicate:false};
    }
    await db.prepare(`INSERT INTO jobs (${fields}) VALUES (${values.map(()=>"?").join(",")})`).bind(...values).run();
  } catch(error) {
    const raced = await db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").bind(dedupe).first<Record<string, unknown>>();
    if (raced) return { job: raced, created: false, duplicate: true };
    if(error instanceof Error)throw error;
    throw new Error("Unable to create job");
  }
  await db.prepare("INSERT INTO job_events (id, job_id, source_module, event_type, message) VALUES (?, ?, ?, 'created', 'Job queued')").bind(crypto.randomUUID(), id, input.created_by_module).run();
  if(input.trigger_event_id)await db.prepare("INSERT OR IGNORE INTO job_event_links (id,job_id,event_id,link_type,explanation) VALUES (?,?,?,'triggered_by',?)").bind(crypto.randomUUID(),id,input.trigger_event_id,input.trigger_reason??"").run();
  for(const dependencyId of input.depends_on_job_ids??[]) await db.prepare("INSERT OR IGNORE INTO job_dependencies (job_id,depends_on_job_id) VALUES (?,?)").bind(id,dependencyId).run();
  return { job: await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first(), created: true, duplicate: false };
}

export async function claimJob(module: SourceModule, leaseSeconds = 300) {
  const db = getD1();
  await db.prepare("UPDATE jobs SET status=CASE WHEN job_type='PREPARE_REPORT' OR attempt_count>=max_attempts THEN 'needs-review' ELSE 'retrying' END, last_error='Worker lease expired; job recovered automatically', lease_expires_at=NULL, available_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE target_module=? AND status='running' AND lease_expires_at<CURRENT_TIMESTAMP").bind(module).run();
  const exhausted=await db.prepare("SELECT id,investigation_id,pipeline_id,target_entity_id,job_type FROM jobs j WHERE target_module=? AND status='needs-review' AND last_error LIKE 'Worker lease expired%' AND NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.job_id=j.id AND r.status='open')").bind(module).all<Record<string,unknown>>();for(const job of exhausted.results)await db.prepare("INSERT INTO review_queue (id,investigation_id,pipeline_id,job_id,entity_id,review_type,priority,title,reason,details) VALUES (?,?,?,?,?,'failed_job',85,?,?,?)").bind(crypto.randomUUID(),job.investigation_id??null,job.pipeline_id??null,job.id,job.target_entity_id??null,`${job.job_type} needs review`,`The worker lease expired after the allowed attempts.`,json(job)).run();
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = await db.prepare("SELECT j.id FROM jobs j LEFT JOIN investigation_pipelines p ON p.id=j.pipeline_id WHERE j.target_module = ? AND j.status IN ('pending','retrying') AND j.approval_status IN ('not_required','approved') AND j.available_at <= ? AND (j.lease_expires_at IS NULL OR j.lease_expires_at < ?) AND (p.id IS NULL OR p.status='running') AND NOT EXISTS (SELECT 1 FROM job_dependencies d JOIN jobs parent ON parent.id=d.depends_on_job_id WHERE d.job_id=j.id AND parent.status!='completed') ORDER BY j.priority DESC, j.created_at ASC LIMIT 1").bind(module, now(), now()).first<{ id: string }>();
    if (!candidate) return null;
    const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const update = await db.prepare("UPDATE jobs SET status = 'running', claimed_by_module = ?, attempt_count = attempt_count + 1, lease_expires_at = ?, last_worker_heartbeat_at=CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending','retrying') AND (lease_expires_at IS NULL OR lease_expires_at < ?)").bind(module, lease, candidate.id, now()).run();
    if ((update.meta?.changes ?? 0) === 1) {
      await db.batch([
        db.prepare("INSERT INTO job_events (id, job_id, source_module, event_type, message) VALUES (?, ?, ?, 'claimed', 'Job claimed')").bind(crypto.randomUUID(), candidate.id, module),
        db.prepare("INSERT INTO module_registry (module_name, connection_status, runtime_status, current_job_id, last_heartbeat_at) VALUES (?, 'connected', 'running', ?, CURRENT_TIMESTAMP) ON CONFLICT(module_name) DO UPDATE SET connection_status='connected', runtime_status='running', current_job_id=excluded.current_job_id, last_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP").bind(module, candidate.id),
      ]);
      return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(candidate.id).first<Record<string, unknown>>();
    }
  }
  return null;
}

export async function updateJob(module: SourceModule, jobId: string, action: string, input: { progress?: number; message?: string; result?: unknown; error?: string; retry?: boolean }) {
  const db = getD1(); const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (job.claimed_by_module !== module) throw new Error("JOB_NOT_OWNED");
  if(job.status!=="running"||!job.lease_expires_at||new Date(String(job.lease_expires_at).replace(" ","T")+(/[z+-]/i.test(String(job.lease_expires_at).slice(-6))?"":"Z")).getTime()<Date.now())throw new Error("WORKER_LEASE_EXPIRED");
  if (action === "progress") {
    if (!canTransitionJob(String(job.status), "running") && job.status !== "running") throw new Error("INVALID_JOB_TRANSITION");
    await db.prepare("UPDATE jobs SET current_progress = ?, progress_message = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND claimed_by_module = ?")
      .bind(Math.max(0, Math.min(1, input.progress ?? 0)), input.message ?? "", new Date(Date.now() + 300000).toISOString(), jobId, module).run();
  } else if (action === "complete") {
    if (!canTransitionJob(String(job.status), "completed")) throw new Error("INVALID_JOB_TRANSITION");
    await db.batch([
      db.prepare("UPDATE jobs SET status='completed', result=?, current_progress=1, progress_message=?, lease_expires_at=NULL, completed_at=CURRENT_TIMESTAMP, dedupe_key=dedupe_key || ':done:' || id, updated_at=CURRENT_TIMESTAMP WHERE id=? AND claimed_by_module=?").bind(json(input.result), input.message ?? "Completed", jobId, module),
      db.prepare("UPDATE module_registry SET runtime_status='idle', current_job_id=NULL, jobs_completed=jobs_completed+1, last_successful_sync_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE module_name=?").bind(module),
      db.prepare("INSERT INTO entity_analysis_state (entity_id,module_name,analysis_type,last_analyzed_at,fresh_until,last_job_id,result_summary) SELECT target_entity_id,target_module,job_type,CURRENT_TIMESTAMP,datetime('now','+' || CASE WHEN job_type='ANALYZE_WALLET' THEN 24 ELSE 12 END || ' hours'),id,? FROM jobs WHERE id=? AND target_entity_id IS NOT NULL ON CONFLICT(entity_id,module_name,analysis_type) DO UPDATE SET last_analyzed_at=CURRENT_TIMESTAMP,fresh_until=excluded.fresh_until,last_job_id=excluded.last_job_id,result_summary=excluded.result_summary,updated_at=CURRENT_TIMESTAMP").bind(json(input.result),jobId),
      db.prepare("UPDATE review_queue SET status='resolved',resolution='Job completed successfully after recovery',resolved_at=CURRENT_TIMESTAMP WHERE job_id=? AND status='open' AND review_type='failed_job'").bind(jobId),
    ]);
  } else if (action === "fail") {
    if (!canTransitionJob(String(job.status), input.retry === false ? "failed" : "retrying")) throw new Error("INVALID_JOB_TRANSITION");
    const attempts = Number(job.attempt_count ?? 0); const max = Number(job.max_attempts ?? 3); const retry = job.job_type !== "PREPARE_REPORT" && input.retry !== false && attempts < max;
    const status = retry ? "retrying" : "failed"; const available = new Date(Date.now() + retryDelaySeconds(attempts) * 1000).toISOString();
    await db.batch([
      db.prepare("UPDATE jobs SET status=?, last_error=?, progress_message=?, lease_expires_at=NULL, available_at=?, dedupe_key=CASE WHEN ?='failed' THEN dedupe_key || ':failed:' || id ELSE dedupe_key END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND claimed_by_module=?").bind(status, input.error ?? "Unknown failure", input.message ?? "", available, status, jobId, module),
      db.prepare("UPDATE module_registry SET runtime_status=?, current_job_id=NULL, last_error=?, recent_errors=json_insert(CASE WHEN json_valid(recent_errors) THEN recent_errors ELSE '[]' END, '$[#]', ?), updated_at=CURRENT_TIMESTAMP WHERE module_name=?").bind(status === "retrying" ? "idle" : "error", input.error ?? "Unknown failure", input.error ?? "Unknown failure", module),
    ]);
    if(!retry)await db.batch([db.prepare("INSERT INTO review_queue (id,investigation_id,pipeline_id,job_id,entity_id,review_type,priority,title,reason,details) VALUES (?,?,?,?,?,'failed_job',85,?,?,?)").bind(crypto.randomUUID(),job.investigation_id??null,job.pipeline_id??null,jobId,job.target_entity_id??null,`${job.job_type} failed`,input.error??"Unknown failure",json(input)),db.prepare("INSERT INTO notifications (id,investigation_id,pipeline_id,notification_type,severity,title,message,resource_type,resource_id) VALUES (?,?,?,'job.failed','high',?,?, 'job',?)").bind(crypto.randomUUID(),job.investigation_id??null,job.pipeline_id??null,`${job.job_type} failed`,input.error??"Unknown failure",jobId)]);
  } else if (action === "needs-review") {
    if (!canTransitionJob(String(job.status), "needs-review")) throw new Error("INVALID_JOB_TRANSITION");
    await db.prepare("UPDATE jobs SET status='needs-review', progress_message=?, result=?, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND claimed_by_module=?").bind(input.message ?? "Review required", json(input.result), jobId, module).run();
  } else throw new Error("UNKNOWN_JOB_ACTION");
  if(action==="complete"&&job.job_type==="ANALYZE_WALLET"&&job.target_entity_id){const {publishEvent}=await import("./events");await publishEvent(module,{event_id:`job:${jobId}:wallet-analyzed`,event_type:"wallet.analyzed",schema_version:"1.0",correlation_id:String(job.correlation_id??jobId),causation_event_id:job.trigger_event_id?String(job.trigger_event_id):undefined,investigation_id:job.investigation_id?String(job.investigation_id):undefined,entity_id:String(job.target_entity_id),occurred_at:now(),provenance:{adapter:"legacy-job-completion",job_id:jobId},payload:{job_id:jobId,result:input.result??{},confidence:1},hop_count:1});}
  await db.prepare("INSERT INTO job_events (id, job_id, source_module, event_type, message, data) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), jobId, module, action, input.message ?? input.error ?? "", json(input)).run();
  if(["complete","fail","needs-review"].includes(action)&&String(job.payload??"").includes('"campaign_id"')){try{const cid=JSON.parse(String(job.payload)).campaign_id;if(typeof cid==="string"){const {wakeCampaigns}=await import("./campaign/campaign");await wakeCampaigns({campaignId:cid});}}catch{/* v4 campaign layer is best-effort */}}
  if(["complete","fail","needs-review"].includes(action)&&job.investigation_id){try{const {onInvestigationActivity}=await import("./agent/hooks");await onInvestigationActivity(String(job.investigation_id),"job");}catch{/* AI layer is best-effort */}}
  const fresh=await db.prepare("SELECT investigation_id,pipeline_id,stage_key,job_type,status,target_entity_id,trigger_reason FROM jobs WHERE id=?").bind(jobId).first<Record<string,unknown>>();
  if(fresh?.pipeline_id){const totals=await db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END) done,SUM(CASE WHEN status IN ('failed','needs-review') THEN 1 ELSE 0 END) blocked FROM jobs WHERE pipeline_id=?").bind(fresh.pipeline_id).first<{total:number;done:number;blocked:number}>();const progress=totals?.total?Number(totals.done??0)/Number(totals.total):0;await db.prepare("UPDATE investigation_pipelines SET progress=?, current_stage=COALESCE(?,current_stage), status=CASE WHEN ?>=1 THEN 'completed' WHEN ?>0 THEN 'needs-review' ELSE status END, completed_at=CASE WHEN ?>=1 THEN CURRENT_TIMESTAMP ELSE completed_at END, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(progress,fresh.stage_key,progress,Number(totals?.blocked??0),progress,fresh.pipeline_id).run();if(fresh.stage_key)await db.prepare("UPDATE pipeline_stages SET status=CASE WHEN ?='completed' THEN 'completed' WHEN ? IN ('failed','needs-review') THEN 'needs-review' ELSE status END,progress=CASE WHEN ?='completed' THEN 1 ELSE progress END,completed_at=CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,updated_at=CURRENT_TIMESTAMP WHERE pipeline_id=? AND stage_key=?").bind(fresh.status,fresh.status,fresh.status,fresh.status,fresh.pipeline_id,fresh.stage_key).run();}
  await db.prepare("INSERT INTO investigation_timeline (id,investigation_id,pipeline_id,job_id,entity_id,source_module,event_type,title,detail,reason,severity,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),fresh?.investigation_id??null,fresh?.pipeline_id??null,jobId,fresh?.target_entity_id??null,module,`job.${action}`,`${fresh?.job_type??"Job"} ${action}`,input.message??input.error??"",fresh?.trigger_reason??"",action==="fail"?"error":"info",json(input)).run();
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
}
