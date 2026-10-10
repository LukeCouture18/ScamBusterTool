/** Bounded stale work reconciliation. Completed target-specific jobs are proof; uncertainty is retained. */
import {getD1,json} from '../platform';
import {parse,type Row} from '../ops/common';
export async function reconcileStaleSiteWork(limit=50){
 const db=getD1(),rows=(await db.prepare("SELECT * FROM work_items WHERE kind IN ('investigate_candidate','revisit_changed_site') AND status IN ('queued','deferred','running') ORDER BY created_at,id LIMIT ?").bind(Math.max(1,Math.min(100,limit))).all<Row>()).results;
 let resolved=0,uncertain=0;
 for(const w of rows){
  const e=await db.prepare("SELECT id FROM entities WHERE entity_type='site' AND canonical_key=?").bind(w.target_key).first<Row>();if(!e){uncertain++;continue;}
  const active=await db.prepare("SELECT id FROM jobs WHERE target_entity_id=? AND target_module='site_investigator' AND status IN ('pending','running','retrying') LIMIT 1").bind(e.id).first<Row>();
  if(active){uncertain++;continue;}
  const proof=await db.prepare("SELECT id,completed_at FROM jobs WHERE target_entity_id=? AND target_module='site_investigator' AND job_type IN ('INVESTIGATE_SITE','RECHECK_SITE') AND status='completed' ORDER BY completed_at DESC LIMIT 1").bind(e.id).first<Row>();
  if(!proof){uncertain++;continue;}
  // A later recorded change means the successful job is stale; preserve this work for its usual retry path.
  const changed=await db.prepare("SELECT 1 x FROM entity_changes WHERE subject_key IN (?,?) AND detected_at>? LIMIT 1").bind(e.id,w.target_key,proof.completed_at).first<Row>();
  if(changed){
   // A 'deposit appeared' revisit is already answered by a later browser deposit
   // observation. It does not authorize another public fetch behind login.
   const browser=String(w.reason).includes('deposit appeared')?await db.prepare("SELECT o.evidence_id FROM wallet_observations o JOIN wallet_candidates c ON c.id=o.candidate_id WHERE o.domain=? AND o.context_class='deposit' AND c.validation_status='valid' AND o.evidence_id IS NOT NULL AND julianday(o.received_at)>=julianday(?) LIMIT 1").bind(w.target_key,w.created_at).first<Row>():null;
   if(!browser){uncertain++;continue;}
  }
  const detail={...parse<Row>(w.result,{}),reconciliation:'Target-specific specialist job already completed, with no unresolved later change.',proof_job_id:proof.id,proof_completed_at:proof.completed_at};
  await db.batch([db.prepare("UPDATE work_items SET status='done',result=?,job_id=?,lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','deferred','running')").bind(json(detail),proof.id,proof.completed_at,w.id),
   db.prepare("INSERT OR IGNORE INTO work_item_events(id,work_item_id,event,detail) SELECT ?,?,'stale_work_reconciled',? WHERE EXISTS(SELECT 1 FROM work_items WHERE id=? AND status='done' AND job_id=?)").bind(`stale:${w.id}:${proof.id}`,w.id,json(detail),w.id,proof.id)]);resolved++;
 }
 return {checked:rows.length,resolved,uncertain,deleted:0};
}
