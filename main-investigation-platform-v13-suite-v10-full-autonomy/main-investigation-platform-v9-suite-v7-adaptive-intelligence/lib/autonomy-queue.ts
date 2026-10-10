/** Honest read-only queue classes. A pending row is not necessarily executable. */
import {getD1} from './platform';
import {ts,type Row} from './ops/common';
export const QUEUE_CLASSES=['runnable','running','waiting provider','waiting human','waiting scheduled revisit','superseded','completed','failed retryable','failed final','orphaned'] as const;
export async function autonomyQueue(investigationId?:string,limit=200){
 const db=getD1(),scope=investigationId?' WHERE j.investigation_id=?':'';
 const jobs=(await db.prepare(`SELECT j.id,j.investigation_id,j.job_type,j.status,j.available_at,j.lease_expires_at,j.target_module,j.attempt_count,j.max_attempts,m.last_heartbeat_at,
 EXISTS(SELECT 1 FROM human_checkpoints h WHERE h.investigation_id=j.investigation_id AND h.status='open') human,
 EXISTS(SELECT 1 FROM director_retries r WHERE r.job_id=j.id AND r.status='parked') provider
 FROM jobs j LEFT JOIN module_registry m ON m.module_name=j.target_module${scope} ORDER BY j.created_at DESC LIMIT ?`).bind(...(investigationId?[investigationId]:[]),Math.max(1,Math.min(500,limit))).all<Row>()).results;
 const work=(await db.prepare(`SELECT w.id,w.investigation_id,w.kind,w.status,w.not_before,w.job_id,j.status job_status,
 EXISTS(SELECT 1 FROM human_checkpoints h WHERE h.investigation_id=w.investigation_id AND h.status='open') human
 FROM work_items w LEFT JOIN jobs j ON j.id=w.job_id${investigationId?' WHERE w.investigation_id=?':''} ORDER BY w.updated_at DESC LIMIT ?`).bind(...(investigationId?[investigationId]:[]),Math.max(1,Math.min(500,limit))).all<Row>()).results;
 const rows=[...jobs.map(j=>{
  let category:string='orphaned',why='No currently available worker can execute this work.';
  if(j.status==='completed'){category='completed';why='The specialist completion is preserved.';}
  else if(j.status==='cancelled'){category='superseded';why='This work was cancelled or replaced.';}
  else if(j.status==='needs-review'||j.human){category='waiting human';why='A person must resolve the recorded checkpoint.';}
  else if(j.status==='failed'||j.status==='dead'){category='failed final';why='The bounded attempts ended.';}
  else if(j.provider){category='waiting provider';why='Provider recovery is parked until its due time.';}
  else if(j.status==='running'&&ts(j.lease_expires_at)>Date.now()){category='running';why='The specialist has a valid lease.';}
  else if(j.status==='running'){category='failed retryable';why='The expired lease is eligible for automatic recovery.';}
  else if(['pending','retrying'].includes(String(j.status))&&ts(j.available_at)>Date.now()){category='waiting scheduled revisit';why='Its scheduled retry is not due.';}
  else if(['pending','retrying'].includes(String(j.status))&&Date.now()-ts(j.last_heartbeat_at)<120000){category=j.status==='retrying'?'failed retryable':'runnable';why='Due work has an available registered specialist.';}
  return {...j,source:'job',category,why};
 }),...work.map(w=>{
  let category:string='orphaned',why='The linked work has no executable owner; maintenance will reconcile it.';
  if(w.status==='done'){category='completed';why='The useful result or specialist proof is preserved.';}
  else if(['cancelled','suppressed','superseded'].includes(String(w.status))){category='superseded';why='Policy or updated evidence superseded this work.';}
  else if(w.human||w.status==='waiting_human'){category='waiting human';why='A person must resolve the recorded checkpoint.';}
  else if(w.status==='failed'){category='failed final';why='Its bounded attempts ended.';}
  else if(w.status==='running'&&['pending','running','retrying'].includes(String(w.job_status))){category='running';why='A linked specialist is answering this question.';}
  else if(ts(w.not_before)>Date.now()){category='waiting scheduled revisit';why='The scheduled revisit is not due.';}
  else if(['queued','deferred'].includes(String(w.status))){category='runnable';why='Due policy work can be evaluated on the next maintenance tick.';}
  return {...w,source:'work',category,why};
 })];
 return {rows,counts:Object.fromEntries(QUEUE_CLASSES.map(c=>[c,rows.filter(r=>r.category===c).length])),bounded:true};
}
