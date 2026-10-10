import { apiError, assertModule, authError, authorizeModule, enforceRateLimit } from "@/lib/platform";
import { claimJob } from "@/lib/jobs";
export async function POST(request:Request, context:{params:Promise<{module:string}>}) { try { const {module}=await context.params; if(!assertModule(module)) return apiError(404,"UNKNOWN_MODULE","Unknown module."); await authorizeModule(request,module); await enforceRateLimit(module); const job=await claimJob(module); return job?Response.json({job}):new Response(null,{status:204}); } catch(error){ return authError(error)??apiError(500,"CLAIM_ERROR",error instanceof Error?error.message:"Unable to claim job"); } }

