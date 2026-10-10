import {z} from 'zod';
import {apiError,readJsonBody} from '@/lib/platform';
import {proposeOperationDecision,confirmOperationDecision} from '@/lib/ops/operation-decisions';
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('propose'),kind:z.enum(['split','consolidate','associate','exclude']),entity_ids:z.array(z.string().min(1)).max(200),target_operation_id:z.string().optional(),reason:z.string().min(8).max(1200)}).strict(),
 z.object({action:z.literal('confirm'),decision_id:z.string().min(1),review_hash:z.string().length(64)}).strict()
]);
export async function POST(r:Request,c:{params:Promise<{id:string}>}) {
 try{const p=schema.parse(await readJsonBody(r,65536)),id=(await c.params).id;return Response.json(p.action==='confirm'?await confirmOperationDecision(id,p.decision_id,p.review_hash):await proposeOperationDecision(id,p));}
 catch(e){if(e instanceof z.ZodError)return apiError(400,'VALIDATION_ERROR','Invalid decision.',e.issues);const message=e instanceof Error?e.message:'Unavailable';return apiError(message.includes('CHANGED')||message.includes('MISMATCH')?409:400,'DECISION_ERROR',message);}
}
