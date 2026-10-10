import {apiError} from '@/lib/platform';
import {explainConnection} from '@/lib/ops/intelligence';
export async function GET(_r:Request,c:{params:Promise<{id:string;edge:string}>}) {try {const p=await c.params,data=await explainConnection(p.id,p.edge);return data?Response.json(data):apiError(404,'NOT_FOUND','Connection not found.');}catch(e){return apiError(500,'OPERATION_ERROR',e instanceof Error?e.message:'Unavailable');}}
