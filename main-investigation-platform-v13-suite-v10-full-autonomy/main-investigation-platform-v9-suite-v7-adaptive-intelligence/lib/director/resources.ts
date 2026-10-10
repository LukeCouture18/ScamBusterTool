/** Conservative, durable upper-bound reservations shared by every module job in an enrolled investigation.
 * Resource estimates are allowances, not measured evidence or claimed actual provider-call telemetry.
 */
import { getD1, json } from '../platform';
import type { JobInput } from '../jobs';
import { ensureBudget } from '../planner';
export type Cost = { jobs: number; requests: number; provider_calls: number; public_work: number; finder: number; hunter: number; wallet: number; effort_seconds: number };
export async function enroll(investigationId: string) {
 await ensureBudget(investigationId);
 const db=getD1();
 await db.prepare('INSERT OR IGNORE INTO director_investigations(investigation_id) VALUES (?)').bind(investigationId).run();
 await db.prepare(`INSERT OR IGNORE INTO director_resources(investigation_id,max_jobs,max_requests,max_provider_calls,max_public_work,max_wallet,max_effort_seconds)
 SELECT investigation_id,max_jobs,max_api_calls,max_api_calls,max_api_calls,max_wallets,max_runtime_seconds FROM investigation_budgets WHERE investigation_id=?`).bind(investigationId).run();
 const historic=(await db.prepare("SELECT j.* FROM jobs j WHERE j.investigation_id=? AND j.job_type<>'PREPARE_REPORT' AND NOT EXISTS(SELECT 1 FROM director_reservations r WHERE r.job_id=j.id)").bind(investigationId).all<Record<string,unknown>>()).results;
 for(const job of historic) {
  let payload={};try{payload=JSON.parse(String(job.payload??'{}'));}catch{}
  const cost=jobCost({...job,payload} as unknown as JobInput),entries=Object.entries(cost);
  await db.batch([db.prepare('INSERT OR IGNORE INTO director_reservations(job_id,investigation_id,cost) VALUES (?,?,?)').bind(job.id,investigationId,json(cost)),
   db.prepare(`UPDATE director_resources SET ${entries.map(([k,v])=>`${k}=${k}+${v}`).join(',')} WHERE investigation_id=? AND changes()=1`).bind(investigationId)]);
 }

}
export function jobCost(input: JobInput): Cost {
 const p=(input.payload && typeof input.payload==='object'?input.payload:{}) as Record<string,unknown>;
 const validation=input.target_module==='wallet_investigator' && p.analyze===false;
 const attempts=Math.max(1,Math.min(3,input.max_attempts??3));
 const base:Cost={jobs:1,requests:0,provider_calls:0,public_work:0,finder:0,hunter:0,wallet:0,effort_seconds:validation?2:180};
 if(input.target_module==='wallet_investigator'&&!validation) {base.provider_calls=6*attempts;base.requests=6*attempts;base.wallet=1;base.effort_seconds=180*attempts;}
 if(input.target_module==='site_investigator'){base.requests=50*attempts;base.public_work=50*attempts;base.effort_seconds=180*attempts;}
 if(input.target_module==='site_finder'){base.requests=90*attempts;base.public_work=90*attempts;base.finder=1;base.effort_seconds=180*attempts;}
 if(input.target_module==='operation_hunter'){base.requests=40*attempts;base.public_work=40*attempts;base.hunter=1;base.effort_seconds=180*attempts;}
 return base;
}
/** The job INSERT and these statements must execute in the same D1 batch. No orphan charge on crash. */
export async function reservation(input:JobInput,jobId:string) {
 if(!input.investigation_id || input.job_type==='PREPARE_REPORT')return null; // Approved submission is its own frozen lifecycle.
 const db=getD1(), inv=input.investigation_id;
 const resource=await db.prepare('SELECT investigation_id FROM director_resources WHERE investigation_id=?').bind(inv).first();
 if(!resource)return null; // Legacy investigations remain operable until adopted by the director.
 const cost=jobCost(input), entries=Object.entries(cost);
 const payload=(input.payload&&typeof input.payload==='object'?input.payload:{}) as Record<string,unknown>;
 if(input.target_module==='site_investigator')input.payload={...payload,resource_limits:{requests_per_attempt:50}};
 if(input.target_module==='site_finder')input.payload={...payload,budget:{http:40,dns:40,crtsh:4,rdap:6}};
 const mission=await db.prepare('SELECT root_id FROM autonomous_missions WHERE investigation_id=?').bind(inv).first<{root_id:string}>();
 const campaign=mission?` AND EXISTS(SELECT 1 FROM mission_resources WHERE root_id=? AND jobs+${cost.jobs}<=max_jobs-max_sites AND requests+${cost.requests}<=max_requests AND provider_calls+${cost.provider_calls}<=max_provider_calls)`:'';
 const shared=mission?[db.prepare(`UPDATE mission_resources SET jobs=jobs+${cost.jobs},requests=requests+${cost.requests},provider_calls=provider_calls+${cost.provider_calls} WHERE root_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=?)`).bind(mission.root_id,jobId),
 db.prepare('INSERT INTO mission_reservations(job_id,root_id,cost) SELECT id,?,? FROM jobs WHERE id=?').bind(mission.root_id,json(cost),jobId)]:[];
 const predicate=entries.map(([k,v])=>`${k}+${v}<=max_${k}${k==='jobs'?'-1':''}`).join(' AND ');
 return {predicate:` AND EXISTS(SELECT 1 FROM director_resources WHERE investigation_id=? AND ${predicate})${campaign}`,args:[inv,...(mission?[mission.root_id]:[])],
 statements:[db.prepare(`UPDATE director_resources SET ${entries.map(([k,v])=>`${k}=${k}+${v}`).join(',')} WHERE investigation_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=?)`).bind(inv,jobId),
 db.prepare('INSERT INTO director_reservations(job_id,investigation_id,cost) SELECT id,?,? FROM jobs WHERE id=?').bind(inv,json(cost),jobId),...shared]};
}
