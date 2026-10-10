import {apiError} from '@/lib/platform';
import {operationBriefing,operationIntelligenceTick} from '@/lib/ops/intelligence';
import {getBool} from '@/lib/ops/common';
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
 try {const url=new URL(request.url);const limit=Number(url.searchParams.get('limit')??100);if(!Number.isInteger(limit)||limit<1||limit>200)return apiError(400,'VALIDATION_ERROR','Limit must be an integer from 1 to 200.');const data=await operationBriefing((await context.params).id,{view:url.searchParams.get('view')??'site',cursor:url.searchParams.get('cursor')??'',limit});return data?Response.json(data):apiError(404,'NOT_FOUND','Operation not found.');}
 catch(e){return apiError(500,'OPERATION_ERROR',e instanceof Error?e.message:'Unavailable');}
}
export async function POST() {try{return Response.json(await operationIntelligenceTick(await getBool('scheduler_paused',false)));}catch(e){return apiError(500,'OPERATION_ERROR',e instanceof Error?e.message:'Unavailable');}}
