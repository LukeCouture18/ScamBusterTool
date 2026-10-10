import {apiError} from '@/lib/platform';
import {scientificView,scientificAdvanced} from '@/lib/scientific/engine';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
 try{const ref=(await context.params).id,data=await scientificView(ref);if(!data)return apiError(404,'NOT_FOUND','Operation not found.');return Response.json(new URL(request.url).searchParams.get('advanced')==='1'?{...data,advanced:await scientificAdvanced(ref)}:data);}catch(e){return apiError(500,'SCIENTIFIC_ERROR',e instanceof Error?e.message:'Unavailable');}
}
