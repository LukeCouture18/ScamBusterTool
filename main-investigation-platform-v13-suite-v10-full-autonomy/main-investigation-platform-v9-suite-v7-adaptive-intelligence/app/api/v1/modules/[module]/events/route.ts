import { apiError,assertModule,authError,authorizeModule,getD1 } from "@/lib/platform";
export async function GET(request:Request,context:{params:Promise<{module:string}>}){
 try{
  const {module}=await context.params;if(!assertModule(module))return apiError(404,"UNKNOWN_MODULE","Unknown module.");
  await authorizeModule(request,module);
  const url=new URL(request.url);const limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")??50)||50));
  const rows=await getD1().prepare("SELECT i.id delivery_id,e.event_id,e.event_type,e.schema_version,e.correlation_id,e.causation_event_id,e.investigation_id,e.entity_id,e.source_module,e.payload,e.provenance,e.occurred_at FROM module_event_inbox i JOIN event_store e ON e.id=i.event_id WHERE i.module_name=? AND i.acknowledged_at IS NULL AND e.status='processed' ORDER BY i.created_at,i.id LIMIT ?").bind(module,limit).all();
  return Response.json({events:rows.results});
 }catch(error){return authError(error)??apiError(500,"INBOX_ERROR",error instanceof Error?error.message:"Inbox unavailable");}
}
