import {apiError,getD1} from '@/lib/platform';
import {parse,type Row} from '@/lib/ops/common';
/** v7: how the adaptive model ordered the Investigation Director's own proposed actions (explanations only). */
export async function GET(_request:Request,context:{params:Promise<{id:string}>}) {
 try {
  const id=(await context.params).id,db=getD1();
  if(!(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_decisions'").first()))return Response.json({installed:false});
  const decisions=(await db.prepare("SELECT id,seq,chosen_family,question,why_matters,why_selected,deferred,utility,created_at FROM adaptive_decisions WHERE scope_kind='investigation' AND scope_id=? ORDER BY created_at DESC,seq DESC LIMIT 10").bind(id).all<Row>()).results;
  return Response.json({investigation_id:id,decisions:decisions.map(d=>({...d,deferred:parse(d.deferred,[])})),caveat:'Ordering metadata only; the v5 Director still decides what is safe and executes it.'});
 } catch(e){return apiError(500,'ADAPTIVE_ERROR',e instanceof Error?e.message:'Unavailable');}
}
