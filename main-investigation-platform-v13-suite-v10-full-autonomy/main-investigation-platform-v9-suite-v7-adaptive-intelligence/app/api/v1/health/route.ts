import {apiError,getD1} from "@/lib/platform";
export async function GET(){try{const db=getD1();const [events,jobs,inbox,modules,budgets,dead]=await Promise.all([
 db.prepare("SELECT status,COUNT(*) count FROM event_store GROUP BY status").all(),
 db.prepare("SELECT status,COUNT(*) count,ROUND(AVG((julianday(COALESCE(completed_at,CURRENT_TIMESTAMP))-julianday(created_at))*86400),1) average_age_seconds,SUM(CASE WHEN attempt_count>1 THEN 1 ELSE 0 END) retried FROM jobs GROUP BY status").all(),
 db.prepare("SELECT module_name,COUNT(*) pending,MIN(created_at) oldest, SUM(CASE WHEN push_attempts>=5 THEN 1 ELSE 0 END) push_exhausted FROM module_event_inbox WHERE acknowledged_at IS NULL GROUP BY module_name").all(),
 db.prepare("SELECT module_name,schema_version,runtime_status,last_heartbeat_at,last_error FROM module_registry").all(),
 db.prepare("SELECT investigation_id,max_jobs-used_jobs remaining_jobs,max_api_calls-used_api_calls remaining_reported_api_calls,max_runtime_seconds-used_runtime_seconds remaining_reported_runtime_seconds FROM investigation_budgets ORDER BY updated_at DESC LIMIT 100").all(),
 db.prepare("SELECT COUNT(*) n FROM event_dead_letters WHERE resolved_at IS NULL").first<{n:number}>()]);
 return Response.json({database:"available",events:events.results,jobs:jobs.results,feedback:inbox.results,modules:modules.results,budgets:budgets.results,open_dead_letters:dead?.n??0,generated_at:new Date().toISOString()});
 }catch(error){return apiError(503,"HEALTH_UNAVAILABLE",error instanceof Error?error.message:"Database health unavailable");}}
