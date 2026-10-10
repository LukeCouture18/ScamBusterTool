import { apiError,assertModule,authError,authorizeModule,getD1 } from "@/lib/platform";
export async function POST(request:Request,context:{params:Promise<{module:string;id:string}>}){
 try{const {module,id}=await context.params;if(!assertModule(module))return apiError(404,"UNKNOWN_MODULE","Unknown module.");await authorizeModule(request,module);
 const result=await getD1().prepare("UPDATE module_event_inbox SET acknowledged_at=CURRENT_TIMESTAMP WHERE id=? AND module_name=? AND acknowledged_at IS NULL").bind(id,module).run();
 if(result.meta?.changes===0){const existing=await getD1().prepare("SELECT id FROM module_event_inbox WHERE id=? AND module_name=?").bind(id,module).first();if(!existing)return apiError(404,"NOT_FOUND","Delivery not found.");}
 return Response.json({acknowledged:true});}catch(error){return authError(error)??apiError(500,"ACK_ERROR",error instanceof Error?error.message:"Acknowledgement failed");}
}
