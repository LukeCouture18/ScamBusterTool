import {apiError} from '@/lib/platform';
import {adaptiveEfficiency} from '@/lib/adaptive/view';
/** v7 Advanced efficiency view (diagnostic, not a score). ?scope_kind=operation|investigation&scope_id=... narrows it. */
export async function GET(request:Request) {
 try {
  const url=new URL(request.url),kind=url.searchParams.get('scope_kind'),id=url.searchParams.get('scope_id');
  if((kind&&!['operation','investigation'].includes(kind))||(kind&&!id))return apiError(400,'VALIDATION_ERROR','scope_kind must be operation or investigation, with scope_id.');
  return Response.json(await adaptiveEfficiency(kind&&id?{kind,id}:undefined));
 } catch(e){return apiError(500,'ADAPTIVE_ERROR',e instanceof Error?e.message:'Unavailable');}
}
