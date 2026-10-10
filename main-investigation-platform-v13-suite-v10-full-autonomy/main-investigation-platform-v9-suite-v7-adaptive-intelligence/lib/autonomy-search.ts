/** Durable Finder -> selection -> ordinary investigation handoff, resumable at every boundary. */
import {getD1,json} from './platform';
import {type Row} from './ops/common';
import {finderAssessment} from './finder-confidence';
import {maintainSupply} from './inbox';
import {investigateSite} from './autonomy';
import {assertExecutionAllowed} from './ops/guard';
const one=async(q:string,...a:unknown[])=>getD1().prepare(q).bind(...a).first<Row>();
export async function searchView(id:string) {
 const row=await one('SELECT id,state,candidate_id,investigation_id,assessment,generation,reason,deadline_at FROM autonomy_searches WHERE id=?',id);
 if(!row)return null;
 return {...row,assessment:JSON.parse(String(row.assessment)),workspace_url:row.investigation_id?`/investigations/${row.investigation_id}`:null};
}
export async function startInvestigation(requestId=crypto.randomUUID()) {
 assertExecutionAllowed('autonomy:start_search');
 if(!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw new Error('Invalid start request identity.');
 const db=getD1();
 await db.prepare(`INSERT OR IGNORE INTO autonomy_searches(id,active_slot,deadline_at) VALUES(?,1,?)`).bind(requestId,new Date(Date.now()+30*60000).toISOString()).run();
 const owned=await one('SELECT id FROM autonomy_searches WHERE id=?',requestId);
 const active=owned??await one('SELECT id FROM autonomy_searches WHERE active_slot=1');
 if(!active)throw new Error('Search identity could not be recovered.');
 await advanceSearch(String(active.id));return searchView(String(active.id));
}
export async function advanceSearch(id:string) {
 assertExecutionAllowed('autonomy:advance_search');
 const db=getD1(),owner=crypto.randomUUID(),now=new Date().toISOString();
 const lock=await db.prepare(`UPDATE autonomy_searches SET lease_owner=?,lease_until=? WHERE id=? AND state IN ('Finding site','Starting') AND (lease_until IS NULL OR lease_until<?)`)
 .bind(owner,new Date(Date.now()+60000).toISOString(),id,now).run();if(lock.meta?.changes!==1)return;
 try {
  let s=await one('SELECT * FROM autonomy_searches WHERE id=?',id);if(!s)return;
  if(!s.candidate_id) {
   if(String(s.deadline_at)<=new Date().toISOString()){
    await db.prepare("UPDATE autonomy_searches SET state='Parked',active_slot=NULL,reason='Search deadline reached',updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind(id,owner).run();return;
   }
   const candidates=(await db.prepare(`SELECT c.* FROM inbox_candidates c LEFT JOIN autonomy_candidate_claims a ON a.candidate_id=c.id
    WHERE c.status IN ('ready','presented') AND c.decision IS NULL AND a.candidate_id IS NULL AND NOT EXISTS(SELECT 1 FROM mission_opportunities p WHERE p.candidate_id=c.id) ORDER BY c.score DESC,c.created_at LIMIT 50`).all<Row>()).results;
   const assessed=await Promise.all(candidates.map(async c=>({c,a:await finderAssessment(c)})));
   const selected=assessed.filter(x=>x.a.eligible).sort((a,b)=>b.a.expected_investigation_value-a.a.expected_investigation_value||String(a.c.id).localeCompare(String(b.c.id)))[0];
   if(selected) {
    await db.batch([
     db.prepare("INSERT OR IGNORE INTO autonomy_candidate_claims(candidate_id,search_id) SELECT ?,id FROM autonomy_searches WHERE id=? AND lease_owner=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(selected.c.id,id,owner),
     db.prepare(`UPDATE autonomy_searches SET candidate_id=?,assessment=?,state='Starting',reason='Selected for bounded public evidence collection',updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=? AND EXISTS(SELECT 1 FROM autonomy_candidate_claims WHERE candidate_id=? AND search_id=?)`).bind(selected.c.id,json(selected.a),id,owner,selected.c.id,id)
    ]);
    s=await one('SELECT * FROM autonomy_searches WHERE id=?',id);
   } else {
    if(String(s.deadline_at)<=now||Number(s.generation)>=4) {
     await db.prepare("UPDATE autonomy_searches SET state='Parked',active_slot=NULL,reason='No sufficiently supported candidate within the search allowance',updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind(id,owner).run();return;
    }
    const supply=await maintainSupply({searchId:id});
    if(supply.job_id&&supply.job_id!==s.job_id)await db.prepare('UPDATE autonomy_searches SET job_id=?,generation=generation+1,reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=? AND (job_id IS NULL OR job_id<>?) AND generation<4 AND deadline_at>?').bind(supply.job_id,supply.reason??'Bounded Finder discovery queued',id,owner,supply.job_id,new Date().toISOString()).run();
    else await db.prepare('UPDATE autonomy_searches SET reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?').bind(supply.reason??'Waiting for supported Finder evidence',id,owner).run();
    return;
   }
  }
  if(s?.candidate_id) {
   const renewed=await db.prepare('UPDATE autonomy_searches SET lease_until=? WHERE id=? AND lease_owner=?').bind(new Date(Date.now()+60000).toISOString(),id,owner).run();if(renewed.meta?.changes!==1)return;
   const c=await one('SELECT url FROM inbox_candidates WHERE id=?',s.candidate_id);if(!c)throw new Error('Selected candidate no longer exists.');
   const result=await investigateSite(String(c.url));
   await db.batch([
    db.prepare("UPDATE autonomy_searches SET state='Investigating',investigation_id=?,active_slot=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_owner=?").bind(result.investigation_id,id,owner),
    db.prepare("UPDATE inbox_candidates SET investigation_id=COALESCE(investigation_id,?),progress_state='autonomous_investigation',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(result.investigation_id,s.candidate_id)
   ]);
  }
 } finally {await db.prepare('UPDATE autonomy_searches SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?').bind(id,owner).run();}
}
export async function searchTick() {
 const rows=(await getD1().prepare("SELECT id FROM autonomy_searches WHERE state IN ('Finding site','Starting') ORDER BY updated_at LIMIT 5").all<Row>()).results;
 for(const s of rows)await advanceSearch(String(s.id));return {searches:rows.length};
}
