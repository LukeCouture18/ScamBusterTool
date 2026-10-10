/** Main's operation memory. Hunter owns inference; this layer projects authoritative
 * records, retains Hunter's falsifiable analysis, and coordinates bounded typed work.
 * Nothing here writes evidence, validation, site reports, or ownership assertions. */
import { getD1, sha256 } from '../platform';
import {scientificEnabled} from '../scientific/engine';
import { parse, json, type Row, getNum } from './common';
import { proposeWork, type Kind } from './workitems';
import type { SyncPayload } from './hunter';

const s = (v: unknown, limit = 1200) => String(v ?? '').slice(0, limit);
const arr = (v: unknown): Row[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as Row[] : [];
const refs = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(x => s(x, 240)))].slice(0, 100) : [];
const now = () => new Date().toISOString();
export const OPERATION_CAVEAT = 'Observed reuse, transactions, templates and infrastructure overlap do not establish common ownership or a common operator. Membership and deployment waves remain analytical hypotheses.';
async function installed() {return Boolean(await getD1().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_state'").first());}

function category(type: string) {
 if (/wallet|deposit|payment|transaction|counterparty|transfer/i.test(type)) return /transaction|counterparty|transfer/i.test(type) ? 'blockchain_relationship' : 'wallet_observation';
 if (/contact|email|telegram|social/i.test(type)) return 'public_contact';
 if (/template|kit|favicon/i.test(type)) return 'template_similarity';
 if (/certificate|cert/i.test(type)) return 'certificate_overlap';
 if (/ip|host|dns|ns|cdn|infra/i.test(type)) return 'infrastructure_context';
 return 'public_artifact';
}

async function resolveEvidence(raw: unknown) {
 const ids = refs(raw), db = getD1(), found: string[] = [], missing: string[] = [];
 for (const id of ids) {
  const hit = await db.prepare('SELECT id FROM evidence WHERE id=? OR (source_module=? AND source_record_id=?) LIMIT 1').bind(id, 'operation_hunter', id.startsWith('hunter:') ? id : `hunter:${id}`).first<Row>();
  if (hit) found.push(String(hit.id)); else missing.push(id);
 }
 return { evidence_ids: [...new Set(found)], unresolved_refs: missing };
}

async function history(op: string, kind: string, key: string, detail: unknown, at = now()) {
 const hash = await sha256(json(detail));
 return getD1().prepare('INSERT OR IGNORE INTO operation_history(id,operation_id,kind,record_key,content_hash,detail,at) VALUES (?,?,?,?,?,?,?)').bind(await sha256(`${op}:${kind}:${key}:${hash}`),op,kind,key,hash,json(detail),at);
}

/** Retains contradictions even when absent from a later snapshot. Resolution must be explicit. */
export async function ingestOperationAnalysis(op: string, p: SyncPayload) {
 if(!await installed())return; // During an ordered upgrade, old module ingestion remains recoverable.
 const db = getD1(), stmts: D1PreparedStatement[] = [];
 stmts.push(db.prepare('INSERT OR IGNORE INTO operation_state(operation_id) VALUES (?)').bind(op));
 const questions = arr(p.model?.hypotheses);
 for (const q of questions.slice(0, 20)) for (const h of arr(q.hypotheses).slice(0, 10)) {
  const key = `${s(q.key,100)}:${s(h.key,100)}`;
  const supports: Row[] = [], contradicts: Row[] = [];
  for (const ev of arr(q.evidence).slice(0, 80)) {
   const rating = (ev.ratings as Row | undefined)?.[String(h.key)];
   const lineage = await resolveEvidence(ev.evidenceIds);
   const detail = { text:s(ev.text), rating, ...lineage };
   if (rating === 'C' || rating === 'CC') supports.push(detail);
   if (rating === 'I' || rating === 'II') contradicts.push(detail);
  }
  const old = await db.prepare('SELECT contradicts FROM operation_hypotheses WHERE operation_id=? AND hypothesis_key=?').bind(op,key).first<Row>();
  // Omission is never a withdrawal. Preserve prior challenging evidence.
  const retained = parse<Row[]>(old?.contradicts,[]);
  for (const r of retained) if (!contradicts.some(x => json(x) === json(r))) contradicts.push(r);
  const alternatives = arr(q.hypotheses).filter(x=>x.key!==h.key).map(x=>s(x.label));
  const uncertainty = `${s(q.caveat)} Evidence not collected is unknown; no ownership attribution is asserted.`;
  const statement = `${s(q.question,400)} — Possible explanation: ${s(h.label,400)}`;
  const next = s(q.discriminatingTest) || 'Ask Hunter to compare competing explanations using existing authoritative evidence.';
  const detail = {statement,status:h.verdict==='unlikely'?'challenged':'open',confidence:null,uncertainty,supports,contradicts,alternatives,
   strengthen:'Independent validated deposit-wallet or distinctive public contact/configuration evidence consistent with this explanation.',
   weaken:'Contradicting chronology, independent contact/configuration differences, network conflicts or evidence that an overlap is generic.',next_test:next};
  const hash = await sha256(json(detail));
  stmts.push(db.prepare(`INSERT INTO operation_hypotheses(operation_id,hypothesis_key,statement,status,confidence,uncertainty,supports,contradicts,alternatives,strengthen,weaken,next_test,content_hash)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,hypothesis_key) DO UPDATE SET statement=excluded.statement,status=excluded.status,confidence=excluded.confidence,uncertainty=excluded.uncertainty,supports=excluded.supports,contradicts=excluded.contradicts,alternatives=excluded.alternatives,strengthen=excluded.strengthen,weaken=excluded.weaken,next_test=excluded.next_test,content_hash=excluded.content_hash,updated_at=CURRENT_TIMESTAMP WHERE content_hash<>excluded.content_hash`)
   .bind(op,key,statement,detail.status,null,uncertainty,json(supports),json(contradicts),json(alternatives),detail.strengthen,detail.weaken,next,hash));
  stmts.push(await history(op,'hypothesis',key,detail));
 }
 for (const c of (p.contradictions ?? []).slice(0,50)) {
  const key=s(c.fingerprint ?? c.key,240);if(!key)continue;
  const lineage = await resolveEvidence(c.evidence_ids ?? (c.data as Row | undefined)?.evidenceIds);
  const prior = await db.prepare('SELECT evidence_ids,status FROM operation_contradictions WHERE operation_id=? AND fingerprint=?').bind(op,key).first<Row>();
  const evidence = [...new Set([...lineage.evidence_ids,...parse<string[]>(prior?.evidence_ids,[])])];
  const status=s(c.status||'open',40),detail={...c,...lineage,evidence_ids:evidence};
  stmts.push(db.prepare(`INSERT INTO operation_contradictions(operation_id,fingerprint,summary,status,evidence_ids,detail,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(operation_id,fingerprint) DO UPDATE SET summary=excluded.summary,status=excluded.status,evidence_ids=excluded.evidence_ids,detail=excluded.detail,updated_at=excluded.updated_at`).bind(op,key,s(c.summary),status,json(evidence),json(detail),now()));
  stmts.push(await history(op,'contradiction',key,detail));
 }
 for(const f of arr(p.operation.findings).slice(0,25)) {
  const lineage = await resolveEvidence(f.evidence_ids);
  stmts.push(await history(op,'hunter_finding',s(f.key,200),{...f,...lineage,assertion_kind:'hypothesis'}));
 }
 for(const wave of arr(p.model?.waves).slice(0,30)) {
  stmts.push(await history(op,'possible_deployment_wave',s(wave.index,30),{...wave,source_module:'operation_hunter',assertion_kind:'derived',caveat:'Temporal grouping is not an ownership claim.'},s(wave.start,40)||now()));
 }
 const facetCache=new Map<string,Row>();
 for(const change of [...(p.changes??[])].slice(0,500).sort((a,b)=>s(a.at).localeCompare(s(b.at)))) {
  const key=s(change.domain,240), facet=s(change.facet,60),value=json(change.value), at=s(change.at,40);
  if(!key||!facet||!Number.isFinite(Date.parse(at)))continue;
  const cacheKey=`${key}:${facet}`;
  const old=facetCache.get(cacheKey)??await db.prepare('SELECT * FROM operation_facets WHERE operation_id=? AND entity_key=? AND facet=?').bind(op,key,facet).first<Row>();
  if(old && Date.parse(String(old.last_seen))>Date.parse(at)) {stmts.push(await history(op,'historical_observation',`${key}:${facet}`,{...change,source_module:'operation_hunter'},at));continue;}
  if(old?.value!==value) {
   const returned=facet==='status'&&/dead|dark|suspended|disappeared/i.test(String(old?.value))&&/live|resurfaced|returned/i.test(value);
   const kind=returned?'returned':!old?'first_observed':facet==='status'&&/dead|dark|suspended/i.test(value)?'disappeared':'changed';
   stmts.push(await history(op,kind,`${key}:${facet}`,{entity_key:key,facet,previous:old?.value??null,value:change.value,source_module:'operation_hunter',assertion_kind:'observed'},at));
  }
  stmts.push(db.prepare(`INSERT INTO operation_facets(operation_id,entity_key,facet,value,first_seen,last_seen,source_module) VALUES (?,?,?,?,?,?,'operation_hunter') ON CONFLICT(operation_id,entity_key,facet) DO UPDATE SET value=excluded.value,last_seen=MAX(last_seen,excluded.last_seen)`).bind(op,key,facet,value,at,at));
  facetCache.set(cacheKey,{value,last_seen:at});
 }
 // Batch is the crash boundary: model history, challenges and temporal facets commit together.
 stmts.push(db.prepare('UPDATE operation_state SET dirty=1,updated_at=CURRENT_TIMESTAMP WHERE operation_id=?').bind(op));
 await db.batch(stmts);
}

/** Coalesced wakeups carry no executable instruction. The scheduler re-evaluates current evidence. */
export async function wakeOperations(input:{investigation_id?:string|null;entity_id?:string|null;event_type:string}) {
 if(!await installed())return;
 const db=getD1();
 await db.prepare(`UPDATE operation_state SET dirty=1,updated_at=CURRENT_TIMESTAMP WHERE operation_id IN (
 SELECT oe.operation_id FROM operation_entities oe LEFT JOIN investigation_entities ie ON ie.entity_id=oe.entity_id
 WHERE oe.association<>'excluded' AND (oe.entity_id=? OR ie.investigation_id=?)
 UNION SELECT h.id FROM hunter_operations h WHERE h.investigation_id=? OR h.investigation_id=(SELECT external_id FROM investigations WHERE id=?))`).bind(input.entity_id??'',input.investigation_id??'',input.investigation_id??'',input.investigation_id??'').run();
}

/** Bounded projection, paginated by relationship id. Canonical source rows are never copied as facts. */
export async function projectOperation(op: string, cursor = '', limit = 500) {
 if(!await installed())return {projected:0,next_cursor:null};
 const db=getD1();
 await db.prepare('INSERT OR IGNORE INTO operation_state(operation_id) VALUES (?)').bind(op).run();
 const members=(await db.prepare(`SELECT e.id,e.created_at,e.updated_at,m.why FROM hunter_operation_members m JOIN entities e ON e.entity_type=m.entity_type AND e.canonical_key=m.canonical_key WHERE m.operation_id=?`).bind(op).all<Row>()).results;
 const stmts:D1PreparedStatement[]=[];
 for(const e of members) stmts.push(db.prepare(`INSERT INTO operation_entities(operation_id,entity_id,reason,first_seen,last_seen) VALUES (?,?,?,?,?) ON CONFLICT(operation_id,entity_id) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen),association=CASE WHEN origin='analyst' THEN association ELSE 'proposed' END,origin=CASE WHEN origin='analyst' THEN origin ELSE 'hunter' END,reason=CASE WHEN origin='analyst' THEN reason ELSE excluded.reason END
 WHERE last_seen<excluded.last_seen OR (origin<>'analyst' AND (association<>'proposed' OR origin<>'hunter' OR reason<>excluded.reason))`).bind(op,e.id,s(e.why),e.created_at,e.updated_at));
 if(stmts.length)await db.batch(stmts);
 // Adjacent evidence is context, not automatic membership. Do not traverse entire shared-CDN components.
 const rows=(await db.prepare(`SELECT DISTINCT r.* FROM operation_entities oe JOIN relationships r ON (r.source_entity_id=oe.entity_id OR r.target_entity_id=oe.entity_id)
 WHERE oe.operation_id=? AND (oe.association IN ('proposed','confirmed_shared_evidence') OR (oe.association='context' AND oe.entity_id IN (SELECT id FROM entities WHERE entity_type IN ('wallet','transaction')))) AND r.id>? AND NOT EXISTS (SELECT 1 FROM operation_entities ex WHERE ex.operation_id=? AND ex.association='excluded' AND ex.entity_id IN (r.source_entity_id,r.target_entity_id)) ORDER BY r.id LIMIT ?`).bind(op,cursor,op,Math.max(1,Math.min(1000,limit))).all<Row>()).results;
 // One bounded read per page replaces one remote read per relationship. The indexed
 // relationship/evidence ordering and original 100-reference limit remain unchanged.
 const references=rows.length?(await db.prepare(`WITH selected AS (SELECT value id FROM json_each(?)), ranked AS (
 SELECT re.relationship_id,re.evidence_id,ROW_NUMBER() OVER(PARTITION BY re.relationship_id ORDER BY re.evidence_id) position
 FROM relationship_evidence re JOIN selected s ON s.id=re.relationship_id)
 SELECT relationship_id,evidence_id FROM ranked WHERE position<=100 ORDER BY relationship_id,evidence_id`).bind(json(rows.map(r=>r.id))).all<Row>()).results:[];
 const evidenceByRelationship=new Map<string,string[]>();
 for(const ref of references){const id=String(ref.relationship_id),list=evidenceByRelationship.get(id)??[];list.push(String(ref.evidence_id));evidenceByRelationship.set(id,list);}
 const writes:D1PreparedStatement[]=[];
 for(const r of rows) {
  const ev=evidenceByRelationship.get(String(r.id))??[];
  const cat=category(String(r.relationship_type));
  const independence=await sha256(json([r.source_entity_id,r.target_entity_id,cat]));
  for(const endpoint of [r.source_entity_id,r.target_entity_id]) writes.push(db.prepare(`INSERT OR IGNORE INTO operation_entities(operation_id,entity_id,association,origin,reason,first_seen,last_seen) VALUES (?,?,'context','evidence','Adjacent authoritative evidence; context is not inferred membership.',?,?)`).bind(op,endpoint,r.observed_at,r.observed_at));
  writes.push(db.prepare(`INSERT INTO operation_edges(operation_id,relationship_id,source_entity_id,target_entity_id,relationship_type,assertion_kind,category,independence_key,source_module,evidence_ids,confidence,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,relationship_id) DO UPDATE SET evidence_ids=excluded.evidence_ids,last_seen=MAX(last_seen,excluded.last_seen),confidence=excluded.confidence
 WHERE evidence_ids<>excluded.evidence_ids OR last_seen<excluded.last_seen OR confidence<>excluded.confidence`).bind(op,r.id,r.source_entity_id,r.target_entity_id,r.relationship_type,r.assertion_kind,cat,independence,r.source_module,json(ev),Number(r.confidence),r.observed_at,r.observed_at));
  // Only a referenced edge can be presented as an explainable connection.
  if(ev.length) writes.push(await history(op,'relationship',String(r.id),{relationship_id:r.id,relationship_type:r.relationship_type,evidence_ids:ev,assertion_kind:r.assertion_kind,category:cat,source_module:r.source_module},String(r.observed_at)));
 }
 if(writes.length) await db.batch(writes);
 return {projected:rows.length,next_cursor:rows.length===limit?String(rows.at(-1)?.id):null};
}

async function metrics(op:string) {
 const db=getD1();
 const r=await db.prepare(`SELECT (SELECT COUNT(*) FROM operation_entities WHERE operation_id=? AND association<>'excluded') entities,
 (SELECT COUNT(DISTINCT oe.independence_key) FROM operation_edges oe WHERE oe.operation_id=? AND oe.evidence_ids<>'[]' AND oe.category NOT IN ('infrastructure_context','template_similarity') AND NOT EXISTS(SELECT 1 FROM operation_entities ex WHERE ex.operation_id=oe.operation_id AND ex.association='excluded' AND ex.entity_id IN (oe.source_entity_id,oe.target_entity_id))) independent_relationships,
 (SELECT COUNT(*) FROM operation_hypotheses WHERE operation_id=?) hypotheses,
 (SELECT COUNT(*) FROM operation_contradictions WHERE operation_id=? AND status='open') contradictions`).bind(op,op,op,op).first<Row>();
 return r??{};
}

/** Portfolio selection is one bounded opportunity per operation, fair by last serviced time.
 * Existing work-item scheduler/module limits and v5 investigation resource ledger remain authoritative. */
export async function operationIntelligenceTick(paused=false) {
 if(!await installed())return {evaluated:0,started:0,requires_migration:'0017'};
 const db=getD1();
 // v7: adaptive investigation intelligence (typed gaps, bounded tests, information value, learning).
 // Falls back to the v6 policy only when 0018 is absent or adaptive_enabled=false.
 const adaptive=await import('../adaptive/engine');
 const adaptiveOn=await adaptive.adaptiveEnabled();
 if(adaptiveOn)await adaptive.reconcileAdaptive();
 const learning=adaptiveOn?await adaptive.familyLearning():{};
 const pending:Awaited<ReturnType<typeof adaptive.evaluateOperation>>['pending'][]=[];
 await db.prepare(`INSERT OR IGNORE INTO operation_state(operation_id) SELECT id FROM hunter_operations WHERE is_demo=0`).run();
 const finished=(await db.prepare(`SELECT h.*,w.status work_status,w.result work_result FROM operation_hunts h JOIN work_items w ON w.id=h.work_item_id WHERE h.status='running' AND w.status IN ('done','failed','cancelled') LIMIT 50`).all<Row>()).results;
 for(const h of finished) {
  const current=await metrics(String(h.operation_id)),base=parse<Row>(h.baseline,{});
  const gained=Math.max(0,Number(current.independent_relationships)-Number(base.independent_relationships??0));
  const useful=h.work_status==='done'&&gained>0;
  await db.batch([db.prepare("UPDATE operation_hunts SET status='finished',outcome=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'").bind(json({useful,independent_relationships_gained:gained,work_status:h.work_status}),h.id),
   db.prepare('UPDATE operation_state SET empty_runs=CASE WHEN ? THEN 0 ELSE empty_runs+1 END,dirty=1 WHERE operation_id=? AND changes()=1').bind(useful?1:0,h.operation_id)]);
 }
 const ops=(await db.prepare(`SELECT st.*,h.seed,h.investigation_id,h.external_id,h.code FROM operation_state st JOIN hunter_operations h ON h.id=st.operation_id WHERE h.is_demo=0 AND st.state<>'CONSOLIDATED' AND (st.dirty=1 OR st.state='PAUSED' OR st.last_evaluated_at IS NULL OR st.last_evaluated_at<datetime('now','-6 hours')) AND (st.lease_until IS NULL OR st.lease_until<CURRENT_TIMESTAMP) ORDER BY COALESCE(st.last_action_at,st.last_evaluated_at,'1970'),st.operation_id LIMIT 8`).all<Row>()).results;
 let started=0;
 for(const op of ops) {
  const id=String(op.operation_id),owner=crypto.randomUUID();
  const claim=await db.prepare("UPDATE operation_state SET lease_owner=?,lease_until=datetime('now','+2 minutes') WHERE operation_id=? AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)").bind(owner,id).run();
  if(claim.meta.changes!==1)continue;
  try {
   // A complete incremental projection resumes via a durable cursor; a batch is bounded.
   const cursorRow=await db.prepare("SELECT value FROM ops_state WHERE key=?").bind(`operation_cursor:${id}`).first<Row>();
   const projection=await projectOperation(id,String(cursorRow?.value??''),500);
   await db.prepare('INSERT INTO ops_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(`operation_cursor:${id}`,projection.next_cursor??'').run();
   const scientific=await import('../scientific/engine');
   if(await scientific.scientificEnabled())await scientific.projectScientific(id);
   const m=await metrics(id);
   const semantic=await sha256(json({metrics:m, latest:(await db.prepare('SELECT kind,record_key,content_hash FROM operation_history WHERE operation_id=? ORDER BY at DESC,id DESC LIMIT 20').bind(id).all<Row>()).results}));
   const changed=semantic!==op.semantic_hash;
   const budget=Number(op.hunts)>=Number(op.max_hunts),saturated=Number(op.empty_runs)>=3&&!changed;
   await db.prepare(`UPDATE operation_state SET semantic_hash=?,revision=revision+?,state=?,reason=?,dirty=?,last_evaluated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE operation_id=? AND lease_owner=?`).bind(semantic,changed?1:0,paused?'PAUSED':budget?'BUDGET_EXHAUSTED':saturated?'SATURATED':'ACTIVE',paused?'Main is paused.':budget?'Bounded operation hunt allowance exhausted.':saturated?'Three completed hunts added no independent relationships.':'Testing a bounded evidence gap.',projection.next_cursor?1:0,id,owner).run();
   if(!paused)await recoverReservedHunts(id);
   if(adaptiveOn&&!paused&&!budget&&!saturated&&!projection.next_cursor) {
    const r=await adaptive.evaluateOperation(id,{learning,tick:owner});
    if(r.pending)pending.push(r.pending);
    else await db.prepare("UPDATE operation_state SET state=CASE WHEN ? IN ('SATURATED','WAITING_FOR_EVIDENCE','WAITING_FOR_HUMAN','WAITING_FOR_PROVIDER','EXHAUSTED') THEN ? ELSE state END,reason=? WHERE operation_id=? AND lease_owner=?").bind(r.state,r.state,s(r.reason,400),id,owner).run();
    continue;
   }
   if(paused||budget||saturated||started>=2||projection.next_cursor)continue;
   const active=await db.prepare("SELECT COUNT(*) n FROM operation_hunts WHERE status IN ('reserved','running')").first<Row>();
   const daily=await db.prepare("SELECT COUNT(*) n FROM operation_hunts WHERE created_at>=date('now')").first<Row>();
   if(Number(active?.n)>=await getNum('operation_active_hunts',4)||Number(daily?.n)>=await getNum('operation_daily_hunts',24))continue;
   if(await db.prepare("SELECT id FROM operation_hunts WHERE operation_id=? AND status IN ('reserved','running')").bind(id).first()) {
    await recoverReservedHunts(id);continue;
   }
   const inv=op.investigation_id?await db.prepare('SELECT id FROM investigations WHERE id=? OR external_id=?').bind(op.investigation_id,op.investigation_id).first<Row>():null;
   if(!inv||!s(op.seed))continue;
   const {enroll}=await import('../director/resources');await enroll(String(inv.id));
   const h=await db.prepare("SELECT statement,next_test FROM operation_hypotheses WHERE operation_id=? AND status IN ('open','challenged') ORDER BY CASE status WHEN 'challenged' THEN 0 ELSE 1 END LIMIT 1").bind(id).first<Row>();
   const contradictory=Number(m.contradictions)>0;
   // A fresh Hunter model already considered its own contradictions. First seek
   // independent public evidence; only return to Hunter after a bounded public test.
   const family=contradictory&&Number(op.hunts)>0?'reconstruct_operation':'find_related_sites';
   const fingerprint=`operation:${id}:${family}:${semantic}`;
   const reason=s(family==='reconstruct_operation'?`Ask Hunter to discriminate competing explanations and retain ${m.contradictions} contradictions.`:h?`Seek independent evidence: ${s(h.next_test,260)}`:`Find public deployments related to ${s(op.seed,160)}; shared infrastructure remains context.`,400);
   const consumed=await db.prepare("SELECT id FROM operation_hunts WHERE fingerprint=? AND status='finished'").bind(fingerprint).first();
   if(consumed){await db.prepare("UPDATE operation_state SET state='SATURATED',reason='This evidence gap has already had a bounded test. Waiting for new independent evidence.' WHERE operation_id=? AND lease_owner=?").bind(id,owner).run();continue;}
   const huntId=await sha256(fingerprint);
   // Reserve one logical hunt before handoff. A crash recovers this exact fingerprint.
   const inserted=await db.batch([db.prepare(`INSERT OR IGNORE INTO operation_hunts(id,operation_id,fingerprint,family,reason,value,baseline) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM operation_state WHERE operation_id=? AND hunts<max_hunts AND lease_owner=?) AND (SELECT COUNT(*) FROM operation_hunts WHERE status IN ('reserved','running'))<? AND (SELECT COUNT(*) FROM operation_hunts WHERE created_at>=date('now'))<?`).bind(huntId,id,fingerprint,family,reason,contradictory?.85:.65,json(m),id,owner,await getNum('operation_active_hunts',4),await getNum('operation_daily_hunts',24)),
    db.prepare('UPDATE operation_state SET hunts=hunts+1,last_action_at=CURRENT_TIMESTAMP WHERE operation_id=? AND changes()=1').bind(id)]);
   if(inserted[0].meta.changes===1){await recoverReservedHunts(id);started++;}
  } finally {await db.prepare('UPDATE operation_state SET lease_owner=NULL,lease_until=NULL WHERE operation_id=? AND lease_owner=?').bind(id,owner).run();}
 }
 if(adaptiveOn&&!paused&&pending.length) {
  const out=await adaptive.portfolioStart(pending.filter((p):p is NonNullable<typeof p>=>Boolean(p)),{maxStarts:2,active:await getNum('operation_active_hunts',4),daily:await getNum('operation_daily_hunts',24)});
  started+=out.started;
  for(const scope of out.scopes)await db.prepare("UPDATE operation_state SET state='ACTIVE',reason=? WHERE operation_id=?").bind(s((pending.find(p=>p?.scope===scope)?.decision.question as string)??'Testing a bounded evidence gap.',400),scope).run();
 }
 return {evaluated:ops.length,started,adaptive:adaptiveOn};
}

async function recoverReservedHunts(op:string) {
 const db=getD1();
 // v7 tests own their hunts and carry structured objectives; recover them through the adaptive handoff.
 const v7=Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_tests'").first());
 if(v7){const {handoffReserved}=await import('../adaptive/engine');await handoffReserved(op);}
 const rows=(await db.prepare(`SELECT h.*,o.seed,o.investigation_id,o.external_id FROM operation_hunts h JOIN hunter_operations o ON o.id=h.operation_id WHERE h.operation_id=? AND h.status='reserved' ${v7?'AND NOT EXISTS(SELECT 1 FROM adaptive_tests t WHERE t.hunt_id=h.id)':''} LIMIT 1`).bind(op).all<Row>()).results;
 for(const h of rows) {
  const inv=await db.prepare('SELECT id FROM investigations WHERE id=? OR external_id=?').bind(h.investigation_id??'',h.investigation_id??'').first<Row>();
  if(!inv)continue;
  // Finder work detail is already the platform's typed, passive discovery contract.
  const w=await proposeWork({kind:h.family as Kind,targetType:'domain',targetKey:String(h.seed),fingerprint:String(h.fingerprint),source:'gap',investigationId:String(inv.id),reason:String(h.reason),maxAttempts:1,
   factors:{info_gain:Number(h.value),novelty:.65,open_gaps:.8,cost:.3,previous_outcomes:await learnedYield(String(h.family))}});
  const result={seeds:[String(h.seed)],artifacts:[],operation_id:String(h.external_id),source:'operation-intelligence',question:String(h.reason),budget:{http:40,dns:40,crtsh:4,rdap:6}};
  await db.batch([db.prepare("UPDATE work_items SET result=? WHERE id=? AND status IN ('queued','deferred')").bind(json(result),w.id),db.prepare("UPDATE operation_hunts SET work_item_id=?,status='running' WHERE id=? AND status='reserved'").bind(w.id,h.id)]);
 }
}

async function learnedYield(family:string) {
 const rows=(await getD1().prepare("SELECT outcome,finished_at FROM operation_hunts WHERE family=? AND status='finished' ORDER BY finished_at DESC LIMIT 30").bind(family).all<Row>()).results;
 // Beta prior and 30-day decay: exploration stays bounded; learning is never evidence.
 let good=1,total=2;
 for(const r of rows){const age=Math.max(0,(Date.now()-Date.parse(String(r.finished_at)))/86400000),weight=Math.exp(-age/30);total+=weight;if(parse<Row>(r.outcome,{}).useful)good+=weight;}
 return good/total;
}

export async function duplicateOperationCandidates(op:string) {
 const db=getD1();
 return (await db.prepare(`SELECT b.operation_id,h.external_id,h.name,COUNT(DISTINCT a.independence_key) shared_independent_relationships
 FROM operation_edges a JOIN operation_edges b ON b.independence_key=a.independence_key AND b.operation_id<>a.operation_id
 JOIN hunter_operations h ON h.id=b.operation_id JOIN operation_state st ON st.operation_id=h.id
 WHERE a.operation_id=? AND a.evidence_ids<>'[]' AND b.evidence_ids<>'[]' AND a.category NOT IN ('infrastructure_context','template_similarity') AND st.state<>'CONSOLIDATED'
 AND NOT EXISTS(SELECT 1 FROM operation_entities ex WHERE ex.operation_id=a.operation_id AND ex.association='excluded' AND ex.entity_id IN(a.source_entity_id,a.target_entity_id))
 AND NOT EXISTS(SELECT 1 FROM operation_entities ex WHERE ex.operation_id=b.operation_id AND ex.association='excluded' AND ex.entity_id IN(b.source_entity_id,b.target_entity_id))
 GROUP BY b.operation_id HAVING COUNT(DISTINCT a.independence_key)>=2 AND COUNT(DISTINCT a.independence_key)>=.5*(SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=b.operation_id AND category NOT IN ('infrastructure_context','template_similarity')) LIMIT 5`).bind(op).all<Row>()).results;
}

export async function operationBriefing(ref:string,opts:{cursor?:string;limit?:number;view?:string}={}) {
 const db=getD1(), op=await db.prepare('SELECT * FROM hunter_operations WHERE id=? OR external_id=?').bind(ref,ref).first<Row>();
 if(!op)return null;
 const id=String(op.id),limit=Math.min(200,Math.max(1,opts.limit??100));
 const edges=(await db.prepare(`SELECT e.*,s.canonical_key source_key,s.entity_type source_type,t.canonical_key target_key,t.entity_type target_type FROM operation_edges e JOIN entities s ON s.id=e.source_entity_id JOIN entities t ON t.id=e.target_entity_id WHERE e.operation_id=? AND e.relationship_id>? AND e.evidence_ids<>'[]' AND NOT EXISTS(SELECT 1 FROM operation_entities ex WHERE ex.operation_id=? AND ex.association='excluded' AND ex.entity_id IN(e.source_entity_id,e.target_entity_id)) ${opts.view==='wallet'?"AND e.category IN ('wallet_observation','blockchain_relationship')":opts.view==='infrastructure'?"AND e.category IN ('infrastructure_context','certificate_overlap')":''} ORDER BY e.relationship_id LIMIT ?`).bind(id,opts.cursor??'',id,limit+1).all<Row>()).results;
 const page=edges.slice(0,limit),hypotheses=(await db.prepare('SELECT * FROM operation_hypotheses WHERE operation_id=? ORDER BY updated_at DESC LIMIT 100').bind(id).all<Row>()).results;
 const investigations=(await db.prepare(`SELECT DISTINCT i.id,i.title,i.status FROM operation_entities oe JOIN investigation_entities ie ON ie.entity_id=oe.entity_id JOIN investigations i ON i.id=ie.investigation_id WHERE oe.operation_id=? AND oe.association<>'excluded' LIMIT 100`).bind(id).all<Row>()).results;
 return {operation:{id,external_id:op.external_id,name:op.name,code:op.code,headline:op.headline,unknowns:parse(op.unknowns,[])},state:await db.prepare('SELECT * FROM operation_state WHERE operation_id=?').bind(id).first<Row>(),
  lineage:(await db.prepare("SELECT DISTINCT h.id,h.external_id,h.name FROM hunter_operations h WHERE h.id IN (SELECT operation_id FROM operation_aliases WHERE target_operation_id=? UNION SELECT target_operation_id FROM operation_aliases WHERE operation_id=? UNION SELECT json_extract(detail,'$.source_operation_id') FROM operation_history WHERE operation_id=? AND kind='boundary_lineage')").bind(id,id,id).all<Row>()).results,
  duplicate_candidates:await duplicateOperationCandidates(id),
  contents:(await db.prepare("SELECT e.entity_type,oe.association,COUNT(*) count FROM operation_entities oe JOIN entities e ON e.id=oe.entity_id WHERE oe.operation_id=? GROUP BY e.entity_type,oe.association").bind(id).all<Row>()).results,
  caveat:OPERATION_CAVEAT,edges:page.map(r=>({...r,evidence_ids:parse(r.evidence_ids,[])})),next_cursor:edges.length>limit?String(page.at(-1)?.relationship_id):null,
  hypotheses:hypotheses.map(r=>({...r,supports:parse(r.supports,[]),contradicts:parse(r.contradicts,[]),alternatives:parse(r.alternatives,[])})),
  contradictions:(await db.prepare('SELECT * FROM operation_contradictions WHERE operation_id=? ORDER BY updated_at DESC LIMIT 100').bind(id).all<Row>()).results.map(r=>({...r,evidence_ids:parse(r.evidence_ids,[])})),
  timeline:(await db.prepare('SELECT * FROM operation_history WHERE operation_id=? ORDER BY at DESC,id DESC LIMIT 100').bind(id).all<Row>()).results.map(r=>({...r,detail:parse(r.detail,{})})),
  investigations,hunts:(await db.prepare('SELECT * FROM operation_hunts WHERE operation_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all<Row>()).results,
  entities:(await db.prepare(`SELECT oe.*,e.entity_type,e.canonical_key,e.display_name FROM operation_entities oe JOIN entities e ON e.id=oe.entity_id WHERE oe.operation_id=? ORDER BY oe.association,e.entity_type,e.canonical_key LIMIT 200`).bind(id).all<Row>()).results,
  reports:(await db.prepare(`SELECT DISTINCT rc.id,rc.investigation_id,rc.status,rc.verification_status,rc.created_at FROM report_candidates rc JOIN investigation_entities ie ON ie.investigation_id=rc.investigation_id JOIN operation_entities oe ON oe.entity_id=ie.entity_id WHERE oe.operation_id=? AND oe.association<>'excluded' ORDER BY rc.created_at DESC LIMIT 30`).bind(id).all<Row>()).results,
  decisions:(await db.prepare("SELECT * FROM operation_decisions WHERE operation_id=? AND status='proposed' ORDER BY created_at DESC LIMIT 30").bind(id).all<Row>()).results};
}

export async function explainConnection(op:string,relationship:string) {
 const db=getD1(),e=await db.prepare('SELECT oe.* FROM operation_edges oe JOIN hunter_operations h ON h.id=oe.operation_id WHERE (h.id=? OR h.external_id=?) AND oe.relationship_id=?').bind(op,op,relationship).first<Row>();
 if(!e)return null;
 const evidence:Row[]=[];
 for(const id of parse<string[]>(e.evidence_ids,[])) {const ev=await db.prepare('SELECT id,title,uri,context_text,source_module,source_record_id,captured_at,investigation_id,provenance,evidence_class,observation_scope FROM evidence WHERE id=?').bind(id).first<Row>();if(ev)evidence.push({...ev,provenance:parse(ev.provenance,{})});}
 const original=await db.prepare('SELECT provenance,source_record_id,investigation_id,observed_at FROM relationships WHERE id=?').bind(relationship).first<Row>();
 const validation=(await db.prepare(`SELECT c.investigation_id,c.address,c.validated_network,c.validation_status,c.best_context,c.analysis_status FROM wallet_candidates c WHERE c.entity_id IN (?,?) LIMIT 100`).bind(e.source_entity_id,e.target_entity_id).all<Row>()).results;
 return {...e,evidence,relationship_provenance:parse(original?.provenance,{}),source_record_id:original?.source_record_id,investigation_id:original?.investigation_id,wallet_validation:validation,caveat:OPERATION_CAVEAT,strength:{category:e.category,independent_unit:e.independence_key,copies_are_not_independent:true,ownership_inference:false}};
}

export async function operationEvidence(op:string,evidenceId:string) {
 const db=getD1(),h=await db.prepare('SELECT id FROM hunter_operations WHERE id=? OR external_id=?').bind(op,op).first<Row>();if(!h)return null;
 const allowed=await db.prepare(`SELECT 1 FROM operation_edges oe,json_each(oe.evidence_ids) j WHERE oe.operation_id=? AND j.value=?
 UNION SELECT 1 FROM operation_hypotheses oh,json_tree(oh.supports) j WHERE oh.operation_id=? AND j.value=?
 UNION SELECT 1 FROM operation_hypotheses oh,json_tree(oh.contradicts) j WHERE oh.operation_id=? AND j.value=?
 UNION SELECT 1 FROM operation_contradictions oc,json_each(oc.evidence_ids) j WHERE oc.operation_id=? AND j.value=? LIMIT 1`).bind(h.id,evidenceId,h.id,evidenceId,h.id,evidenceId,h.id,evidenceId).first();
 // Scientific history may cite a formerly associated observation; keep the original scoped source inspectable.
 const scientificSource=!allowed&&await scientificEnabled()?await db.prepare('SELECT 1 FROM scientific_observations WHERE operation_id=? AND evidence_id=? LIMIT 1').bind(h.id,evidenceId).first():null;
 if(!allowed&&!scientificSource)return null;
 const ev=await db.prepare('SELECT * FROM evidence WHERE id=?').bind(evidenceId).first<Row>();
 return ev?{evidence:[{...ev,provenance:parse(ev.provenance,{})}],caveat:OPERATION_CAVEAT}:null;
}
