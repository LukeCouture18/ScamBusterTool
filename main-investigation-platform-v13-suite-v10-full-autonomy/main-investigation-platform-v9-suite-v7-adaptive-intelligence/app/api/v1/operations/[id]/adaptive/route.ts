import {apiError} from '@/lib/platform';
import {adaptiveOperationView,adaptiveEfficiency} from '@/lib/adaptive/view';
/** v7: what Main chose for this operation, the question it answers, why, expected/actual cost and what changed. */
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
 try {
  const id=(await context.params).id,url=new URL(request.url);
  const view=await adaptiveOperationView(id);if(!view)return apiError(404,'NOT_FOUND','Operation not found.');
  if(url.searchParams.get('efficiency')==='1'&&'operation_id' in view)return Response.json({...view,efficiency:await adaptiveEfficiency({kind:'operation',id:String(view.operation_id)})});
  return Response.json(view);
 } catch(e){return apiError(500,'ADAPTIVE_ERROR',e instanceof Error?e.message:'Unavailable');}
}
