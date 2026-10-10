/** Analyst-controlled operation boundaries. Evidence is immutable and never moved/deleted.
 * Every decision has a review hash, revision check and an atomic, replayable effect. */
import {getD1,sha256,json} from '../platform';
import {parse,type Row} from './common';

export async function proposeOperationDecision(ref:string,input:{kind:'split'|'consolidate'|'associate'|'exclude';entity_ids:string[];target_operation_id?:string;reason:string}) {
 const db=getD1(),op=await db.prepare('SELECT id,name FROM hunter_operations WHERE id=? OR external_id=?').bind(ref,ref).first<Row>();
 if(!op)throw new Error('OPERATION_NOT_FOUND');
 const id=String(op.id);await db.prepare('INSERT OR IGNORE INTO operation_state(operation_id) VALUES (?)').bind(id).run();
 const state=await db.prepare('SELECT boundary_revision,state FROM operation_state WHERE operation_id=?').bind(id).first<Row>();
 if(state?.state==='CONSOLIDATED')throw new Error('SOURCE_ALREADY_CONSOLIDATED');
 const ids=[...new Set(input.entity_ids)].sort();
 if(ids.length>200||(!ids.length&&input.kind!=='consolidate'))throw new Error('ENTITY_SELECTION_REQUIRED');
 for(const entity of ids)if(!await db.prepare('SELECT entity_id FROM operation_entities WHERE operation_id=? AND entity_id=?').bind(id,entity).first())throw new Error('ENTITY_OUTSIDE_OPERATION');
 let target:string|null=null,targetRevision:number|null=null;
 if(input.kind==='consolidate') {
  const hit=await db.prepare('SELECT id FROM hunter_operations WHERE id=? OR external_id=?').bind(input.target_operation_id??'',input.target_operation_id??'').first<Row>();
  if(!hit||hit.id===id)throw new Error('INVALID_TARGET_OPERATION');target=String(hit.id);
  if(await db.prepare('SELECT operation_id FROM operation_aliases WHERE operation_id=?').bind(target).first())throw new Error('TARGET_ALREADY_CONSOLIDATED');
  await db.prepare('INSERT OR IGNORE INTO operation_state(operation_id) VALUES (?)').bind(target).run();
  targetRevision=Number((await db.prepare('SELECT boundary_revision FROM operation_state WHERE operation_id=?').bind(target).first<Row>())?.boundary_revision);
 }
 const review={operation_id:id,kind:input.kind,entity_ids:ids,target_operation_id:target,reason:input.reason,boundary_revision:Number(state?.boundary_revision),target_boundary_revision:targetRevision};
 const hash=await sha256(json(review)),decisionId=await sha256(`operation-decision:${hash}`);
 await db.prepare('INSERT OR IGNORE INTO operation_decisions(id,operation_id,kind,target_operation_id,entity_ids,reason,boundary_revision,review_hash,result) VALUES (?,?,?,?,?,?,?,?,?)').bind(decisionId,id,input.kind,target,json(ids),input.reason,review.boundary_revision,hash,json({review})).run();
 return {id:decisionId,status:'proposed',review_hash:hash,review,requires_analyst_confirmation:true};
}

export async function confirmOperationDecision(ref:string,decisionId:string,hash:string) {
 const db=getD1(),d=await db.prepare('SELECT d.* FROM operation_decisions d JOIN hunter_operations h ON h.id=d.operation_id WHERE d.id=? AND (h.id=? OR h.external_id=?)').bind(decisionId,ref,ref).first<Row>();
 if(!d)throw new Error('DECISION_NOT_FOUND');if(d.review_hash!==hash)throw new Error('REVIEW_HASH_MISMATCH');
 if(d.status==='approved')return {id:decisionId,status:'approved',result:parse(d.result,{})};
 const state=await db.prepare('SELECT boundary_revision FROM operation_state WHERE operation_id=?').bind(d.operation_id).first<Row>();
 if(Number(state?.boundary_revision)!==Number(d.boundary_revision))throw new Error('BOUNDARY_CHANGED');
 const review=parse<Row>(d.result,{}).review as Row;
 const target=d.kind==='split'?`split:${decisionId}`:d.target_operation_id?String(d.target_operation_id):null;
 if(d.kind==='consolidate') {
  const t=await db.prepare('SELECT boundary_revision,state FROM operation_state WHERE operation_id=?').bind(target).first<Row>();
  if(Number(t?.boundary_revision)!==Number(review.target_boundary_revision)||t?.state==='CONSOLIDATED')throw new Error('BOUNDARY_CHANGED');
 }
 const token=crypto.randomUUID(),result={review,target_operation_id:target,commit_token:token};
 const gate='EXISTS(SELECT 1 FROM operation_decisions WHERE id=? AND status=\'applying\' AND result=?)';
 const args=[decisionId,json(result)];
 const stmts:D1PreparedStatement[]=[db.prepare(`UPDATE operation_decisions SET status='applying',result=? WHERE id=? AND status='proposed' AND EXISTS(SELECT 1 FROM operation_state WHERE operation_id=? AND boundary_revision=?) ${d.kind==='consolidate'?"AND EXISTS(SELECT 1 FROM operation_state WHERE operation_id=? AND boundary_revision=? AND state<>'CONSOLIDATED')":''}`).bind(json(result),decisionId,d.operation_id,d.boundary_revision,...(d.kind==='consolidate'?[target,review.target_boundary_revision]:[]))];
 const ids=parse<string[]>(d.entity_ids,[]);
 if(d.kind==='split') {
  const first=ids[0],entity=await db.prepare('SELECT e.canonical_key,e.entity_type,(SELECT investigation_id FROM investigation_entities WHERE entity_id=e.id ORDER BY first_seen_at LIMIT 1) investigation_id FROM entities e WHERE e.id=?').bind(first).first<Row>();
  stmts.push(db.prepare(`INSERT INTO hunter_operations(id,external_id,code,name,seed,headline,investigation_id) SELECT ?,?,?,?,?,?,? WHERE ${gate} ON CONFLICT(id) DO NOTHING`).bind(target,target,`SPLIT-${decisionId.slice(0,8)}`,'Analyst-separated cluster',entity?.entity_type==='site'?entity.canonical_key:'','Separated by an analyst decision; historical evidence retained.',entity?.investigation_id??null,...args));
  stmts.push(db.prepare(`INSERT OR IGNORE INTO operation_state(operation_id) SELECT ? WHERE ${gate}`).bind(target,...args));
 }
 if(d.kind==='split'||d.kind==='consolidate') {
  const selection=d.kind==='split'?`AND entity_id IN (${ids.map(()=>'?').join(',')})`:'';
  stmts.push(db.prepare(`INSERT INTO operation_entities(operation_id,entity_id,association,origin,reason,first_seen,last_seen) SELECT ?,entity_id,association,'analyst',?,first_seen,last_seen FROM operation_entities WHERE operation_id=? ${selection} AND ${gate} ON CONFLICT(operation_id,entity_id) DO UPDATE SET association=excluded.association,origin='analyst',reason=excluded.reason`).bind(target,d.reason,d.operation_id,...(d.kind==='split'?ids:[]),...args));
  // Only relations wholly inside a split are copied. Cross-boundary edges stay in historical source records.
  const edgeSelect=d.kind==='split'?`AND source_entity_id IN (${ids.map(()=>'?').join(',')}) AND target_entity_id IN (${ids.map(()=>'?').join(',')})`:'';
  stmts.push(db.prepare(`INSERT OR IGNORE INTO operation_edges SELECT ?,relationship_id,source_entity_id,target_entity_id,relationship_type,assertion_kind,category,independence_key,source_module,evidence_ids,confidence,first_seen,last_seen FROM operation_edges WHERE operation_id=? ${edgeSelect} AND ${gate}`).bind(target,d.operation_id,...(d.kind==='split'?[...ids,...ids]:[]),...args));
  stmts.push(db.prepare(`UPDATE operation_state SET dirty=1,boundary_revision=boundary_revision+1 WHERE operation_id=? AND ${gate}`).bind(target,...args));
 }
 if(d.kind==='split'||d.kind==='exclude'||d.kind==='associate') {
  stmts.push(db.prepare(`UPDATE operation_entities SET association=?,origin='analyst',reason=? WHERE operation_id=? AND entity_id IN (${ids.map(()=>'?').join(',')}) AND ${gate}`).bind(d.kind==='associate'?'confirmed_shared_evidence':'excluded',d.reason,d.operation_id,...ids,...args));
 }
 if(d.kind==='consolidate')stmts.push(db.prepare(`INSERT INTO operation_aliases(operation_id,target_operation_id,decision_id) SELECT ?,?,? WHERE ${gate} ON CONFLICT(operation_id) DO NOTHING`).bind(d.operation_id,target,decisionId,...args));
 stmts.push(db.prepare(`UPDATE operation_state SET boundary_revision=boundary_revision+1,dirty=1,state=CASE WHEN ?='consolidate' THEN 'CONSOLIDATED' ELSE 'ACTIVE' END WHERE operation_id=? AND ${gate}`).bind(d.kind,d.operation_id,...args));
 if(target)stmts.push(db.prepare(`INSERT OR IGNORE INTO operation_history(id,operation_id,kind,record_key,content_hash,detail,at) SELECT ?,?,'boundary_lineage',?,?,?,? WHERE ${gate}`).bind(`lineage:${decisionId}`,target,decisionId,hash,json({source_operation_id:d.operation_id,decision_id:decisionId,reason:d.reason,assertion_kind:'analyst_decision'}),new Date().toISOString(),...args));
 const detail=json({decision_id:decisionId,kind:d.kind,reason:d.reason,entity_ids:ids,target_operation_id:target,review_hash:hash});
 stmts.push(db.prepare(`INSERT OR IGNORE INTO operation_history(id,operation_id,kind,record_key,content_hash,detail,at) SELECT ?,?,'analyst_decision',?,?,?,? WHERE ${gate}`).bind(decisionId,d.operation_id,decisionId,hash,detail,new Date().toISOString(),...args));
 stmts.push(db.prepare(`UPDATE operation_decisions SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE id=? AND result=? AND status='applying'`).bind(...args));
 const commit=await db.batch(stmts);
 if(commit[0].meta.changes!==1)throw new Error('BOUNDARY_CHANGED');
 return {id:decisionId,status:'approved',result};
}
