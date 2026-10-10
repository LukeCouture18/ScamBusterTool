/** Durable mission coordination above existing authority, exact approval and per-site evidence boundaries. */
import {getD1,json,sha256} from './platform';
import {parse,type Row} from './ops/common';
import {finderAssessment} from './finder-confidence';
import {projectAutonomy} from './autonomy';
import {assertExecutionAllowed} from './ops/guard';
export const MISSION_STAGES=['Starting','Finding site','Investigating','Waiting for you','Looking for wallet','Validating wallet','Analyzing wallet','Checking related sites','Reconstructing operation','Resolving evidence gaps','Preparing report','Ready for approval','Submitting','Submitted','Parked','Complete','Failed'] as const;
type Lineage={root_id:string;parent_id:string;depth:number};
const one=async(q:string,...a:unknown[])=>getD1().prepare(q).bind(...a).first<Row>();
const all=async(q:string,...a:unknown[])=>(await getD1().prepare(q).bind(...a).all<Row>()).results;
export async function ensureMission(inv:string,site:string,lineage?:Lineage){
 const db=getD1(),id=`mission:${inv}`,target=new URL(site).hostname.toLowerCase().replace(/^www\./,''),root=lineage?.root_id??id;
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO autonomous_missions(id,investigation_id,root_id,parent_id,depth,target) VALUES(?,?,?,?,?,?)`).bind(id,inv,root,lineage?.parent_id??null,lineage?.depth??0,target),
  db.prepare('INSERT OR IGNORE INTO mission_resources(root_id) SELECT root_id FROM autonomous_missions WHERE id=?').bind(id),
  db.prepare(`INSERT OR IGNORE INTO mission_reservations(job_id,root_id,cost) SELECT r.job_id,m.root_id,r.cost FROM director_reservations r JOIN autonomous_missions m ON m.investigation_id=r.investigation_id WHERE m.id=?`).bind(id),
  db.prepare(`UPDATE mission_resources SET jobs=COALESCE((SELECT SUM(json_extract(cost,'$.jobs')) FROM mission_reservations WHERE root_id=mission_resources.root_id),0),
   requests=COALESCE((SELECT SUM(json_extract(cost,'$.requests')) FROM mission_reservations WHERE root_id=mission_resources.root_id),0),
   provider_calls=COALESCE((SELECT SUM(json_extract(cost,'$.provider_calls')) FROM mission_reservations WHERE root_id=mission_resources.root_id),0)
   WHERE root_id=(SELECT root_id FROM autonomous_missions WHERE id=?)`).bind(id)
 ]);return one('SELECT * FROM autonomous_missions WHERE investigation_id=?',inv);
}
function stageOf(state:string,jobs:Row[],gaps:Row[],hasWallet:boolean){
 const mapped:Record<string,string>={'Investigating site':'Investigating','Waiting for login':'Waiting for you','Needs you':'Waiting for you','Building report':'Preparing report','Checking related evidence':'Checking related sites'};
 let stage=mapped[state]??state;
 if(stage==='Checking related sites'&&jobs.some(j=>j.job_type==='HUNT_OPERATION'))stage='Reconstructing operation';
 if(stage==='Looking for wallet'&&hasWallet&&gaps.some(g=>['blocked','unresolved'].includes(String(g.status))))stage='Resolving evidence gaps';
 return MISSION_STAGES.includes(stage as typeof MISSION_STAGES[number])?stage:'Parked';
}
/** Pure read-model refresh; no specialist is invoked by viewing a mission. */
export async function projectMission(inv:string){
 const m=await one('SELECT * FROM autonomous_missions WHERE investigation_id=?',inv);if(!m)return null;
 const a=await projectAutonomy(inv);if(!a)return null;
 const [gaps,findings,blockers,jobs,retries,resources,opportunities,report,actions,lineage,selection]=await Promise.all([
  all('SELECT objective,status,reason,evidence_refs FROM director_objectives WHERE investigation_id=? ORDER BY objective',inv),
  all("SELECT c.id,c.address,c.validated_network,c.validation_status,c.analysis_status,o.evidence_id FROM wallet_candidates c JOIN wallet_observations o ON o.candidate_id=c.id AND o.context_class='deposit' WHERE c.investigation_id=? AND c.validation_status='valid' AND c.best_context='deposit' ORDER BY c.id,o.id LIMIT 40",inv),
  all("SELECT id,kind,title,instructions,url FROM human_checkpoints WHERE investigation_id=? AND status='open' ORDER BY created_at LIMIT 20",inv),
  all("SELECT id,job_type,target_module,status,available_at FROM jobs WHERE investigation_id=? AND status IN ('pending','running','retrying','needs-review') ORDER BY created_at LIMIT 40",inv),
  all("SELECT candidate_id,status,next_at,reason FROM director_retries WHERE investigation_id=? AND status IN ('parked','running','exhausted','budget_exhausted') LIMIT 20",inv),
  one('SELECT * FROM mission_resources WHERE root_id=?',m.root_id),
  all('SELECT domain,depth,status,investigation_id,reason FROM mission_opportunities WHERE root_id=? ORDER BY created_at LIMIT 20',m.root_id),
  one('SELECT c.ready,c.warnings,r.id,r.status,r.verification_status FROM report_contents c JOIN report_candidates r ON r.id=c.candidate_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1',inv),
  all('SELECT kind,target,gap,reason,expected_value,cost,status,job_id FROM director_actions WHERE investigation_id=? ORDER BY created_at DESC LIMIT 8',inv),
  all('SELECT id,target,investigation_id,parent_id,depth,stage FROM autonomous_missions WHERE root_id=? ORDER BY depth,target LIMIT 8',m.root_id),
  one('SELECT assessment FROM autonomy_searches WHERE investigation_id=? ORDER BY created_at LIMIT 1',inv)
 ]);
 const stage=stageOf(a.state,jobs,gaps,findings.length>0),uncertainty=[...gaps.filter(g=>['blocked','unresolved','exhausted'].includes(String(g.status))).map(g=>String(g.reason)),...parse<string[]>(report?.warnings,[])].slice(0,20);
 const stopReason=['Ready for approval','Submitting','Submitted','Complete'].includes(stage)?'Report lifecycle is sufficient; further discovery has stopped.':stage==='Waiting for you'?'Only the recorded human checkpoint can advance this step.':a.stop_reason;
 const expansionStop=resources&&Number(resources.sites)>=Number(resources.max_sites)?'Campaign is saturated at the bounded site allowance.':resources&&(Number(resources.jobs)>=Number(resources.max_jobs)-Number(resources.max_sites)||Number(resources.requests)+150>Number(resources.max_requests))?'Campaign resource allowance is exhausted for further site expansion.':stopReason;
 const snapshot={expansion_stop_reason:expansionStop,selection:parse(selection?.assessment,{}),objective:m.objective,target:m.target,stage,doing:a.doing,next_action:a.next,stop_reason:stopReason,next_at:a.next_at,
  open_evidence_gaps:gaps.filter(g=>!['resolved','not_applicable'].includes(String(g.status))),authoritative_findings:findings,uncertainty,
  human_blockers:blockers,provider_blockers:retries,active_specialist_work:jobs,related_opportunities:opportunities,
  operation_opportunities:actions.filter(a=>a.kind==='reconstruct_operation'),report_readiness_gaps:parse(report?.warnings,[]),report,
  budget:resources?{sites:resources.sites,max_sites:resources.max_sites,jobs:resources.jobs,max_jobs:resources.max_jobs,requests:resources.requests,max_requests:resources.max_requests,provider_calls:resources.provider_calls,max_provider_calls:resources.max_provider_calls}:null,
  evidence_lineage:lineage,considered_and_selected_actions:actions,recovery:'Durable state; specialists retain leases, results and exact approved hashes.'};
 const hash=await sha256(json(snapshot)),db=getD1();
 await db.batch([
  db.prepare(`UPDATE autonomous_missions SET stage=?,snapshot=?,snapshot_hash=?,stop_reason=?,next_action=?,next_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND snapshot_hash<>?`).bind(stage,json(snapshot),hash,stopReason,a.next,a.next_at,m.id,hash),
  db.prepare('INSERT OR IGNORE INTO mission_history(id,mission_id,snapshot_hash,stage,reason,decision) VALUES(?,?,?,?,?,?)').bind(`${m.id}:${hash}`,m.id,hash,stage,a.doing,json({selected:a.next,stop_reason:a.stop_reason,alternatives:actions})),
  db.prepare('UPDATE autonomous_missions SET checked_at=CURRENT_TIMESTAMP WHERE id=?').bind(m.id)
 ]);return {...m,id:String(m.id),stage,snapshot,snapshot_hash:hash};
}

/** At most four sites and two levels per root; atomic reservation precedes site creation. */
async function expand(rootId:string){
 assertExecutionAllowed('mission:bounded_expansion');
 const db=getD1(),budget=await one('SELECT * FROM mission_resources WHERE root_id=?',rootId);if(!budget)return;
 const root=await one('SELECT stage FROM autonomous_missions WHERE id=?',rootId);
 if(['Ready for approval','Submitting','Submitted','Complete','Waiting for you','Failed'].includes(String(root?.stage)))return;
 // Finish durable selections first, even when the final slot has already been reserved.
 const pending=await all("SELECT * FROM mission_opportunities WHERE root_id=? AND status='selected' ORDER BY created_at LIMIT 1",rootId);
 if(pending.length){await attach(pending[0]);return;}
 if(Number(budget.sites)>=Number(budget.max_sites)||Number(budget.jobs)>=Number(budget.max_jobs)-1||Number(budget.requests)+150>Number(budget.max_requests))return;
 const parents=await all("SELECT * FROM autonomous_missions WHERE root_id=? AND depth<? AND stage NOT IN ('Ready for approval','Submitting','Submitted','Complete','Waiting for you','Failed') ORDER BY checked_at,target LIMIT 4",rootId,budget.max_depth);
 for(const parent of parents){
  const candidates=await all(`SELECT c.* FROM inbox_candidates c LEFT JOIN mission_opportunities p ON p.candidate_id=c.id LEFT JOIN autonomy_candidate_claims a ON a.candidate_id=c.id
   WHERE c.canonical_domain<>? AND c.status IN ('ready','presented') AND c.decision IS NULL AND p.id IS NULL AND a.candidate_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM autonomous_missions m WHERE m.target=c.canonical_domain)
   AND (EXISTS(SELECT 1 FROM json_each(c.related_domains) r WHERE r.value=?) OR json_extract(c.details,'$.novelty.parent')=?
    OR c.canonical_domain IN (SELECT e.canonical_key FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='related_site'))
   ORDER BY c.score DESC,c.created_at LIMIT 20`,parent.target,parent.target,parent.target,parent.investigation_id);
  const assessed=await Promise.all(candidates.map(async c=>({c,a:await finderAssessment(c)})));
  const useful=assessed.filter(x=>x.a.eligible&&x.a.expected_investigation_value>=.5).sort((a,b)=>b.a.expected_investigation_value-a.a.expected_investigation_value);
  if(!useful.length)continue;const {c,a}=useful[0],id=`${rootId}:${c.id}`;
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO mission_opportunities(id,root_id,parent_id,candidate_id,domain,url,depth,assessment,reason)
    SELECT ?,?,?,?,?,?,?,?,? FROM mission_resources WHERE root_id=? AND sites<max_sites AND ?<=max_depth AND requests+150<=max_requests AND jobs<max_jobs-1`)
    .bind(id,rootId,parent.id,c.id,c.canonical_domain,c.url,Number(parent.depth)+1,json(a),'Specific related discovery lineage and supported public indicators justify bounded collection; ownership remains unestablished.',rootId,Number(parent.depth)+1),
   db.prepare('UPDATE mission_resources SET sites=sites+1 WHERE root_id=? AND changes()=1').bind(rootId)
  ]);
  const chosen=await one("SELECT * FROM mission_opportunities WHERE id=? AND status='selected'",id);if(chosen)await attach(chosen);return;
 }
}
async function attach(opportunity:Row){
 const {investigateSite}=await import('./autonomy');
 const result=await investigateSite(String(opportunity.url),{root_id:String(opportunity.root_id),parent_id:String(opportunity.parent_id),depth:Number(opportunity.depth)});
 const child=await one('SELECT root_id FROM autonomous_missions WHERE investigation_id=?',result.investigation_id);
 await getD1().prepare("UPDATE mission_opportunities SET status=?,investigation_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='selected'")
 .bind(child?.root_id===opportunity.root_id?'attached':'parked',result.investigation_id,opportunity.id).run();
}
export async function missionTick(limit=8,paused=false){
 for(const a of await all('SELECT a.investigation_id,a.site_url FROM autonomy_investigations a LEFT JOIN autonomous_missions m ON m.investigation_id=a.investigation_id WHERE m.id IS NULL LIMIT 20'))await ensureMission(String(a.investigation_id),String(a.site_url));
 const roots=await all('SELECT root_id FROM mission_resources ORDER BY COALESCE(checked_at,\'\') LIMIT ?',Math.max(1,Math.min(20,limit)));let processed=0;
 for(const root of roots){const owner=crypto.randomUUID(),now=new Date().toISOString(),db=getD1();
  const lock=await db.prepare('UPDATE mission_resources SET lease_owner=?,lease_until=? WHERE root_id=? AND (lease_until IS NULL OR lease_until<?)').bind(owner,new Date(Date.now()+60000).toISOString(),root.root_id,now).run();if(lock.meta?.changes!==1)continue;
  try{for(const m of await all('SELECT investigation_id FROM autonomous_missions WHERE root_id=? ORDER BY depth,target LIMIT 4',root.root_id))await projectMission(String(m.investigation_id));
   if(!paused)await expand(String(root.root_id));processed++;
  }finally{await db.prepare('UPDATE mission_resources SET lease_owner=NULL,lease_until=NULL,checked_at=? WHERE root_id=? AND lease_owner=?').bind(new Date().toISOString(),root.root_id,owner).run();}
 }
 return {roots:processed};
}
export async function missionView(inv:string){const m=await projectMission(inv);if(!m)return null;const history=await all('SELECT stage,reason,decision,created_at FROM mission_history WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 25',m.id);return {...m,history:history.map(h=>({...h,decision:parse(h.decision,{})}))};}
