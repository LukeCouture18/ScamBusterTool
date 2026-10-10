/** v8 durable analytical projection. No network, credentials, generated evidence or ownership claims. */
import {getD1,sha256,json} from '../platform';
import {parse,getBool,getNum,type Row} from '../ops/common';
import type {Candidate,Gap,Snapshot} from '../adaptive/derive';
import {inferRole,independent,revise,prediction,outcomeBranches,branchProfile,negativeMeaning,type Observation,type Explanation,classifyDisagreement,matchPredictions} from './model';
const now=()=>new Date().toISOString();
const one=(q:string,...a:unknown[])=>getD1().prepare(q).bind(...a).first<Row>();
const all=async(q:string,...a:unknown[])=>(await getD1().prepare(q).bind(...a).all<Row>()).results;
export async function scientificEnabled(){return Boolean(await one("SELECT name FROM sqlite_master WHERE type='table' AND name='scientific_sets'"))&&await getBool('scientific_enabled',true);}
const array=(v:unknown)=>Array.isArray(v)?v:[];
function decode(r:Row):Observation {const d={...parse<Row>(r.detail,{}),version_hash:r.version_hash};return {id:String(r.evidence_id),subject:String(r.subject),facet:String(r.facet),value:String(r.value),reliability:r.reliability as Observation['reliability'],unit:String(r.independence_key),upstream:String(r.upstream_origin),source:String(r.source_module),captured:String(r.captured_at),job:r.job_id?String(r.job_id):null,detail:d};}
async function historical(op:string,kind:string,key:string,before:unknown,after:unknown,evidence:string[],reason:string){
 const at=now(),hash=await sha256(json(after));
 return getD1().prepare('INSERT OR IGNORE INTO scientific_history(id,operation_id,record_kind,record_key,before_state,after_state,evidence_ids,reason,content_hash,at) VALUES (?,?,?,?,?,?,?,?,?,?)')
 .bind(await sha256(`scientific:${op}:${kind}:${key}:${hash}`),op,kind,key,before==null?null:json(before),json(after),json([...new Set(evidence)].sort()),reason,hash,at);
}
/** Evidence reliability is categorical. Only the originating authority can declare deterministic validation. */
function reliability(r:Row,m:Row):Observation['reliability']{
 if(r.source_module==='wallet_investigator'&&/validat/.test(String(r.evidence_type)))return 'deterministic_validation';
 if(r.source_module==='wallet_investigator')return 'provider_returned_data';
 if(r.source_module==='operation_hunter')return 'derived_software_analysis';
 if(m.provider||/dns|rdap|certificate|whois/.test(String(r.evidence_type)))return 'external_metadata';
 if(r.source_module==='analyst')return 'analyst_conclusion';
 return r.evidence_class==='derived'?'derived_software_analysis':'direct_observation';
}
export async function collectObservations(op:string){
 const db=getD1(),rows=await all(`SELECT DISTINCT e.* FROM evidence e JOIN operation_entities oe ON oe.entity_id=e.entity_id WHERE oe.operation_id=? AND oe.association<>'excluded' ORDER BY e.captured_at DESC,e.id LIMIT 1200`,op);
 const writes:D1PreparedStatement[]=[];
 for(const r of rows){
  const raw=parse<Row>(r.metadata,{}),m={...raw,...parse<Row>(raw.metadata,{})},p=parse<Row>(r.provenance,{}),rel=reliability(r,m);
  const facet=String(m.facet??r.evidence_type),value=String(m.value??r.context_text??r.title),upstream=String(m.upstream_origin??p.upstream_origin??m.template_origin??'');
  const unit=rel==='deterministic_validation'&&m.context==='deposit'&&m.address?`deposit:${m.network}:${m.address}`:upstream||`${r.source_module}:${r.source_record_id}`;
  const detail={title:r.title,uri:r.uri,network:m.network??null,metadata:m,provenance:p,limitations:array(m.limitations),classification:'source_observation'};
  const hash=await sha256(json([r.sha256,facet,value,rel,unit,detail]));
  writes.push(db.prepare('INSERT OR IGNORE INTO scientific_observations(operation_id,evidence_id,version_hash,subject,facet,value,reliability,independence_key,upstream_origin,source_module,captured_at,job_id,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(op,r.id,hash,r.entity_id??'',facet,value,rel,unit,upstream,String(r.source_module),r.captured_at,String(p.origin_job_id??p.job_id??m.job_id??'')||null,json(detail)));
 }
 if(writes.length)await db.batch(writes);
 return (await all('SELECT * FROM scientific_observations WHERE operation_id=? ORDER BY captured_at DESC,evidence_id LIMIT 1200',op)).map(decode);
}
/** Derived reuse observations always retain their original evidence IDs and common upstream origins. */
export const RELATIONAL_PAGE_SQL=`WITH page AS MATERIALIZED (
 SELECT oe.*,e.canonical_key,e.entity_type FROM operation_edges oe JOIN entities e ON e.id=oe.target_entity_id
 WHERE oe.operation_id=? AND oe.evidence_ids<>'[]' ORDER BY oe.relationship_id LIMIT 2000
), corpus AS MATERIALIZED (
 SELECT r.target_entity_id,COUNT(DISTINCT r.source_entity_id) corpus_sites FROM relationships r
 WHERE r.target_entity_id IN (SELECT target_entity_id FROM page) GROUP BY r.target_entity_id
)
SELECT page.*,COALESCE(corpus.corpus_sites,0) corpus_sites FROM page
LEFT JOIN corpus ON corpus.target_entity_id=page.target_entity_id ORDER BY page.relationship_id`;
async function relationalObservations(op:string):Promise<Observation[]>{
 const rows=await all(RELATIONAL_PAGE_SQL,op);
 const targets=new Map<string,Row[]>();for(const r of rows){const k=String(r.target_entity_id);targets.set(k,[...(targets.get(k)??[]),r]);}
 const out:Observation[]=[];
 for(const [target,edges] of targets){
  const first=edges[0],sites=new Set(edges.map(r=>r.source_entity_id)),generic=['template_similarity','infrastructure_context','blockchain_relationship'].includes(String(first.category));
  const corpus=Number(first.corpus_sites),isCommon=generic||corpus>=20;
  const k=String(first.canonical_key),category=isCommon?'generic':'observed_distinctive';
  await getD1().prepare('INSERT INTO scientific_commonality(artifact_key,corpus_sites,observed_sites,category,upstream_origin,limitations,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(artifact_key) DO UPDATE SET corpus_sites=excluded.corpus_sites,observed_sites=excluded.observed_sites,category=excluded.category,updated_at=excluded.updated_at')
   .bind(k,corpus,sites.size,category,generic?`shared:${target}`:'','Observed corpus only; rarity is not proof of truth or operator control.',now()).run();
  if(sites.size<2)continue;
  if(first.category==='wallet_observation'){
   const valid=await one("SELECT COUNT(DISTINCT investigation_id) n FROM wallet_candidates WHERE entity_id=? AND validation_status='valid' AND best_context='deposit'",target);
   if(Number(valid?.n)<2)continue;
  }
  if(!generic&&!['wallet_observation','public_contact','public_artifact'].includes(String(first.category)))continue;
  for(const e of edges.slice(0,30))for(const id of parse<string[]>(e.evidence_ids,[]).slice(0,5))out.push({id,subject:k,facet:isCommon?'generic_overlap':'distinctive_reuse',value:k,reliability:'derived_software_analysis',unit:`reuse:${first.category}:${target}`,upstream:`reuse:${first.category}:${target}`,source:String(first.source_module),captured:String(e.last_seen),job:null,detail:{source_site:e.source_entity_id,relationship_id:e.relationship_id,category:first.category,corpus_sites:corpus,limitation:'Association only; ownership not inferred.'}});
 }
 const deposits=await all(`SELECT c.*,o.evidence_id,o.domain,o.last_seen captured_at FROM wallet_candidates c JOIN wallet_observations o ON o.candidate_id=c.id WHERE c.validation_status='valid' AND c.best_context='deposit' AND c.investigation_id IN (SELECT ie.investigation_id FROM investigation_entities ie JOIN operation_entities oe ON oe.entity_id=ie.entity_id WHERE oe.operation_id=? AND oe.association<>'excluded') ORDER BY o.last_seen DESC LIMIT 200`,op);
 for(const c of deposits){const ev=await one('SELECT id FROM evidence WHERE id=?',c.evidence_id);if(!ev)continue;
  const site=c.domain?await one("SELECT e.id FROM entities e JOIN operation_entities oe ON oe.entity_id=e.id WHERE oe.operation_id=? AND oe.association<>'excluded' AND e.entity_type='site' AND e.canonical_key=?",op,c.domain):null;
  if(!site)continue; // A deposit must be scoped to the actual observed deployment, not every site in an investigation.
  out.push({id:String(ev.id),subject:String(site.id),facet:'validated_deposit',value:String(c.address_normalized),reliability:'deterministic_validation',unit:`deposit:${c.identity}`,upstream:`deposit:${c.identity}`,source:'wallet_investigator',captured:String(c.captured_at),job:c.validation_job_id?String(c.validation_job_id):null,detail:{network:c.validated_network,candidate_id:c.id,validation_authority:'wallet_investigator',validation_job_id:c.validation_job_id,observation_domain:c.domain}});
 }
 // A Wallet Investigator evidence record may also carry its deterministic address validation directly.
 const evs=await all("SELECT * FROM scientific_observations WHERE operation_id=? AND reliability='deterministic_validation'",op);
 for(const r of evs){const o=decode(r),m=(o.detail.metadata??{}) as Row;if(m.validation_status==='valid'&&m.context==='deposit'&&m.address){out.push({...o,facet:'validated_deposit',value:String(m.address).toLowerCase(),unit:`deposit:${m.network}:${m.address}`,upstream:`deposit:${m.network}:${m.address}`,detail:{...o.detail,network:m.network}});}}
 return out;
}
async function evidenceRefs(refs:unknown,obs:Observation[]):Promise<Observation[]>{
 const ids=new Set(array(refs).flatMap(x=>typeof x==='string'?[x]:array((x as Row)?.evidence_ids).map(String)));
 return obs.filter(o=>ids.has(o.id));
}
async function saveHypothesis(op:string,set:string,h:Explanation){
 const db=getD1(),old=await one('SELECT * FROM scientific_hypotheses WHERE operation_id=? AND set_key=? AND hypothesis_key=?',op,set,h.key),p=prediction(h.role);
 const compact=(o:Observation):Observation=>({...o,value:o.value.slice(0,600),detail:{title:o.detail.title,uri:o.detail.uri,network:o.detail.network,source_site:o.detail.source_site,validation_authority:o.detail.validation_authority,version_hash:o.detail.version_hash}});
 const data={...h,supports:independent(h.supports).map(compact),contradicts:independent(h.contradicts).map(compact),unexplained:h.unexplained.map(compact),predictions:[p]},hash=await sha256(json(data));
 if(old?.content_hash===hash)return;
 const ids=[...h.supports,...h.contradicts].map(o=>o.id),at=now();
 const writes=[db.prepare('INSERT INTO scientific_hypotheses(operation_id,set_key,hypothesis_key,statement,role,status,uncertainty,supports,contradicts,unexplained,alternatives,assumptions,predictions,tests,reason,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,set_key,hypothesis_key) DO UPDATE SET statement=excluded.statement,role=excluded.role,status=excluded.status,uncertainty=excluded.uncertainty,supports=excluded.supports,contradicts=excluded.contradicts,unexplained=excluded.unexplained,alternatives=excluded.alternatives,assumptions=excluded.assumptions,predictions=excluded.predictions,tests=excluded.tests,reason=excluded.reason,content_hash=excluded.content_hash,updated_at=excluded.updated_at')
 .bind(op,set,h.key,h.statement,h.role,h.status,h.uncertainty,json(data.supports),json(data.contradicts),json(data.unexplained),json(h.alternatives),json(h.assumptions),json([p]),json([p.test_family]),h.reason,hash,at),
 await historical(op,'hypothesis_revision',`${set}:${h.key}`,old?{status:old.status,supports:parse(old.supports,[]),contradicts:parse(old.contradicts,[])}:null,{status:h.status,supports:data.supports,contradicts:data.contradicts,statement:h.statement},ids,h.reason),
 db.prepare('INSERT OR IGNORE INTO scientific_predictions(id,operation_id,set_key,hypothesis_key,expectation,would_weaken,strong_contradiction,test_family,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
 .bind(await sha256(`prediction:${op}:${set}:${h.key}:${p.expectation}`),op,set,h.key,p.expectation,p.would_weaken,p.strong_contradiction,p.test_family,at)];
 await db.batch(writes);
}
export async function projectScientific(op:string){
 if(!await scientificEnabled())return;
 const observations=await collectObservations(op),derived=await relationalObservations(op),obs=[...observations,...derived];
 const rows=await all('SELECT * FROM operation_hypotheses WHERE operation_id=? ORDER BY hypothesis_key LIMIT 100',op),sets=new Map<string,Row[]>();
 for(const r of rows){const k=String(r.hypothesis_key).split(':')[0];sets.set(k,[...(sets.get(k)??[]),r]);}
 if(!sets.size)sets.set('linkage',[]);
 for(const [set,hs] of sets){
  const linkage=set==='linkage'||hs.some(h=>/operator|operation|kit|shared|linked/i.test(String(h.statement))),definitions=hs.map(r=>({key:String(r.hypothesis_key),role:inferRole(String(r.hypothesis_key),String(r.statement)),statement:String(r.statement),row:r}));
  if(linkage)for(const d of [{key:`${set}:shared_operation`,role:'operation',statement:'Scoped sites share a meaningful operation association.'},{key:`${set}:shared_kit`,role:'kit',statement:'Unrelated deployments reuse the same kit or vendor artifacts.'},{key:`${set}:shared_provider`,role:'infrastructure',statement:'Shared infrastructure/service providers explain the observed overlap.'}])if(!definitions.some(x=>x.role===d.role))definitions.push({...d,row:{} as Row});
  definitions.push({key:`${set}:unknown`,role:'unknown',statement:'Available evidence is insufficient to distinguish every explanation.',row:{} as Row});
  const alternatives=definitions.map(h=>h.statement),states:Explanation[]=[];
  for(const d of definitions){
   const supports=await evidenceRefs(parse(d.row.supports,[]),obs),contradicts=await evidenceRefs(parse(d.row.contradicts,[]),obs);
   const h=revise({...d,alternatives:alternatives.filter(x=>x!==d.statement),supports,contradicts},obs);await saveHypothesis(op,set,h);states.push(h);
  }
  const unresolved=await one("SELECT 1 x FROM scientific_contradictions WHERE operation_id=? AND status IN ('UNRESOLVED','INSUFFICIENT_EVIDENCE') LIMIT 1",op);
  const stop=unresolved?'CONTRADICTORY_EVIDENCE':states.some(h=>h.status==='BEST_SUPPORTED_BUT_UNPROVEN')?'BEST_SUPPORTED_BUT_UNPROVEN':obs.length?'ALTERNATIVES_REMAIN':'INSUFFICIENT_EVIDENCE';
  await getD1().prepare('INSERT INTO scientific_sets(operation_id,set_key,question,scope,stop_state,watermark,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(operation_id,set_key) DO UPDATE SET stop_state=excluded.stop_state,watermark=excluded.watermark,updated_at=excluded.updated_at')
   .bind(op,set,String(hs[0]?.statement??'Which explanation best fits the public observations?'),json({operation_id:op}),stop,await sha256(json(obs.map(o=>[o.id,o.facet,o.value]))),now()).run();
 }
 await detectConflicts(op,obs);
 await getD1().prepare("UPDATE scientific_sets SET stop_state='CONTRADICTORY_EVIDENCE' WHERE operation_id=? AND EXISTS(SELECT 1 FROM scientific_contradictions WHERE operation_id=? AND status IN ('UNRESOLVED','INSUFFICIENT_EVIDENCE'))").bind(op,op).run();
 await proposeScientificSplit(op,obs);
 await assessPlans(op,obs);
 await projectBriefing(op);
}
async function saveConflict(op:string,key:string,data:Row){
 const old=await one('SELECT * FROM scientific_contradictions WHERE operation_id=? AND fingerprint=?',op,key),hash=await sha256(json(data));if(old?.content_hash===hash)return;
 const ids=(data.observations as Observation[]).map(o=>o.id),at=now();
 await getD1().batch([getD1().prepare('INSERT INTO scientific_contradictions(operation_id,fingerprint,claim,observations,independence_units,explanations,tests,importance,status,resolution_evidence,reason,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,fingerprint) DO UPDATE SET observations=excluded.observations,status=excluded.status,resolution_evidence=excluded.resolution_evidence,reason=excluded.reason,content_hash=excluded.content_hash,updated_at=excluded.updated_at')
 .bind(op,key,String(data.claim),json(data.observations),json(independent(data.observations as Observation[]).map(o=>o.unit)),json(data.explanations),json(data.tests),String(data.importance),String(data.status),json(data.resolution_evidence??[]),String(data.reason),hash,at),await historical(op,'contradiction',key,old?{status:old.status}:null,data,ids,String(data.reason))]);
}
async function detectConflicts(op:string,obs:Observation[]){
 const groups=new Map<string,Observation[]>();
 for(const o of obs.filter(o=>!['generic_overlap','distinctive_reuse','validated_deposit'].includes(o.facet))){
  // Different times may represent a real change. Only comparable subject/facet/time observations conflict.
  const k=`${o.subject}:${o.facet}:${o.captured}`;groups.set(k,[...(groups.get(k)??[]),o]);
 }
 for(const [k,g] of groups){if(new Set(g.map(o=>o.value)).size<2)continue;
  const resolution=classifyDisagreement(g,obs);
  await saveConflict(op,await sha256(`disagreement:${k}`),{claim:`Comparable ${g[0].facet} observations disagree.`,observations:g,explanations:['Provider disagreement','Network/token context difference','Extraction/classification error','Scope or chronology mismatch'],tests:['WALLET_VALIDATION','PUBLIC_SITE_INSPECTION','TEMPORAL_RECHECK'],importance:'material',status:resolution.status,resolution_evidence:resolution.resolution,reason:resolution.reason});
 }
 const rejected=await all("SELECT * FROM scientific_hypotheses WHERE operation_id=? AND status='REJECTED'",op);
 for(const h of rejected){const c=parse<Observation[]>(h.contradicts,[]);await saveConflict(op,await sha256(`prediction:${h.hypothesis_key}`),{claim:h.statement,observations:c,explanations:['Wallet rotation','Different operator','Configuration change','Observation artifact'],tests:['TEMPORAL_RECHECK','WALLET_VALIDATION'],importance:'material',status:'RESOLVED_WEAKENS_HYPOTHESIS',resolution_evidence:c.map(o=>o.id),reason:h.reason});}
 // Import material Hunter contradictions without silently choosing or dropping their sources.
 for(const c of await all('SELECT * FROM operation_contradictions WHERE operation_id=? ORDER BY fingerprint LIMIT 100',op)){
  const ids=parse<string[]>(c.evidence_ids,[]),matching=obs.filter(o=>ids.includes(o.id)),detail=parse<Row>(c.detail,{});
  const resolved=String(c.status)==='resolved'&&matching.length>0;
  await saveConflict(op,`hunter:${c.fingerprint}`,{claim:c.summary,observations:matching,explanations:array(detail.explanations).length?detail.explanations:['Scope difference','Generic correlation','Uncollected evidence'],tests:['HUNTER_HYPOTHESIS_TEST','PUBLIC_SITE_INSPECTION'],importance:'material',status:resolved?'RESOLVED_ALTERNATIVE_EXPLANATION':'UNRESOLVED',resolution_evidence:resolved?ids:[],reason:resolved?'Operation Hunter returned a resolved analysis with delivered evidence references.':'Conflicting analysis is retained; no independent resolution has arrived.'});
 }
}
/** Must commit before every specialist/local execution. Replays never rewrite the outcome plan. */
export async function prepareScientificPlan(t:Row){
 if(!await scientificEnabled())return;
 const op=String(t.scope_id);await projectScientific(op);
 const hs=await all('SELECT hypothesis_key key,role,set_key,status FROM scientific_hypotheses WHERE operation_id=? ORDER BY set_key,hypothesis_key LIMIT 100',op),set=String([...new Set(hs.map(h=>String(h.set_key)))].sort((a,b)=>{
  const score=(k:string)=>{const set=hs.filter(h=>h.set_key===k),fit=String(t.family)==='TEMPORAL_RECHECK'?set.some(h=>h.role==='rotation'):String(t.family)==='WALLET_VALIDATION'?set.some(h=>h.role==='single_wallet'||h.role==='network_change'):['PUBLIC_ARTIFACT_SEARCH','RELATED_SITE_HUNT','REPLACEMENT_SITE_HUNT'].includes(String(t.family))?set.some(h=>h.role==='operation'):false;return (fit?10:0)+set.filter(h=>['OPEN','VIABLE','CHALLENGED','WEAKENED'].includes(String(h.status))).length;};
  return score(b)-score(a)||a.localeCompare(b);
 })[0]??'linkage'),selected=hs.filter(h=>h.set_key===set);
 const branches=outcomeBranches(selected.map(h=>({key:String(h.key),role:String(h.role)})),String(t.family)),objective=parse<Row>(t.objective,{});
 const falsify=objective.mode==='template_variant'||String(t.subject).startsWith('infra:')||parse<string[]>(t.gap_keys,[]).some(k=>k.startsWith('CONTRADICTION_RESOLUTION:'));
 const baselineRows=await all('SELECT evidence_id,version_hash FROM scientific_observations WHERE operation_id=? ORDER BY evidence_id,version_hash',op);
 const scoped=[...await collectObservations(op),...await relationalObservations(op)].filter(o=>['validated_deposit','distinctive_reuse','generic_overlap'].includes(o.facet)).slice(0,200);
 const baseline=[...baselineRows,...scoped.map(o=>({evidence_id:o.id,version_hash:o.detail.version_hash,observation:{...o,detail:{network:o.detail.network,source_site:o.detail.source_site}}}))],at=now();
 (branches[0] as typeof branches[0]&{hypotheses:unknown}).hypotheses=selected.map(h=>({key:String(h.key),role:String(h.role)}));
 const hash=await sha256(json(branches)),db=getD1();
 await db.batch([db.prepare('INSERT OR IGNORE INTO scientific_plans(test_id,operation_id,set_key,question,branches,predictions_hash,baseline,falsification,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
 .bind(t.id,op,set,String(objective.question??objective.text??'Compare new independent observations with predictions.'),json(branches),hash,json(baseline),falsify?1:0,at),
 db.prepare('INSERT OR IGNORE INTO scientific_reservations(test_id,operation_id,purpose,units,reason,created_at) VALUES (?,?,?,1,?,?)').bind(t.id,op,falsify?'falsification':'investigation',falsify?'Bounded attempt to weaken the leading explanation; urgent blockers take precedence.':'Chosen bounded observation; reservations never increase the total operation allowance.',at)]);
}
export async function falsificationRemaining(op:string,maximum:number){
 const n=Number((await one("SELECT COUNT(*) n FROM scientific_reservations WHERE operation_id=? AND purpose='falsification'",op))?.n??0);
 const fraction=Math.max(0,Math.min(.5,await getNum('scientific_falsification_fraction',.25)));
 return Math.max(0,Math.floor(maximum*fraction)-n);
}
export async function recordBranches(op:string,s:Snapshot,candidates:Candidate[],gaps:Gap[]){
 const db=getD1(),writes:D1PreparedStatement[]=[];
 for(const c of candidates.slice(0,40)){const b=branchProfile(c,s);writes.push(db.prepare('INSERT INTO scientific_branches(operation_id,branch_key,novelty,discoveries,duplicate_rate,depth,artifact_freshness,last_useful,coverage,unexplored,detail,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,branch_key) DO UPDATE SET novelty=excluded.novelty,discoveries=excluded.discoveries,duplicate_rate=excluded.duplicate_rate,depth=excluded.depth,artifact_freshness=excluded.artifact_freshness,last_useful=excluded.last_useful,coverage=excluded.coverage,unexplored=excluded.unexplored,detail=excluded.detail,updated_at=excluded.updated_at')
 .bind(op,c.key,b.fresh.length?'fresh':'previously_checked',b.discoveries,b.duplicate_rate,b.depth,b.replacement?'disappearance_changed_question':b.fresh.length?'fresh':'historical',b.last_useful,'Bounded provider corpus; full Internet coverage unavailable.',json(b.fresh),json({family:c.family,replacement:b.replacement,temporal_weight:b.temporal_weight,continuity:b.continuity,gaps:c.gaps.map(k=>gaps.find(g=>g.key===k)?.family)}),now()));}
 if(writes.length)await db.batch(writes);
}
async function assessPlans(op:string,obs:Observation[]){
 const rows=await all("SELECT p.*,t.status,t.job_id,t.outcome,t.family FROM scientific_plans p JOIN adaptive_tests t ON t.id=p.test_id WHERE p.operation_id=? AND p.assessed_at IS NULL AND t.status IN ('finished','failed','cancelled') ORDER BY p.created_at LIMIT 50",op);
 for(const p of rows){
  const base=new Set(parse<Row[]>(p.baseline,[]).map(o=>`${o.evidence_id}:${o.version_hash}`)),job=p.job_id?await one('SELECT result,status FROM jobs WHERE id=?',p.job_id):null,result=parse<Row>(job?.result,{});
  const correlated=obs.filter(o=>!base.has(`${o.id}:${o.detail.version_hash}`)&&p.job_id&&o.job===p.job_id),scope=array(result.checked_urls).map(String),coverage=result.coverage==='complete_scoped'?'complete_scoped':scope.length?'partial':'unknown';
  const limitation=['Public search cannot establish global absence.',...(array(result.limitations).map(String))];
  const negative=negativeMeaning({successful:p.status==='finished',scope,coverage,limitations:limitation,found:correlated.length>0});
  const branch=p.status!=='finished'||(correlated.length===0&&coverage==='unknown')?'inconclusive':correlated.length?'distinctive_or_changed_observation':'not_observed_in_scope';
  const planned=parse<Array<{hypotheses?:Array<{key:string;role:string}>}>>(p.branches,[])[0]?.hypotheses??[];
  const prior=parse<Array<{observation?:Observation}>>(p.baseline,[]).flatMap(b=>b.observation?[b.observation]:[]);
  const matches=matchPredictions(planned,prior,correlated,p.status==='finished');
  const interpretation=matches.length?matches.map(m=>`${m.hypothesis_key}: ${m.outcome}. ${m.reason}`).join(' '):negative.meaning;
  const writes=[getD1().prepare('UPDATE scientific_plans SET outcome_branch=?,checked=?,coverage=?,limitations=?,observed_evidence=?,interpretation=?,assessed_at=? WHERE test_id=? AND assessed_at IS NULL')
   .bind(branch,json(scope),coverage,json(limitation),json(correlated.map(o=>o.id)),interpretation,now(),p.test_id),await historical(op,'test_comparison',String(p.test_id),{branches:parse(p.branches,[])},{branch,negative,interpretation},correlated.map(o=>o.id),interpretation)];
  for(const m of matches)writes.push(getD1().prepare('INSERT OR IGNORE INTO scientific_matches(test_id,hypothesis_key,role,outcome,evidence_ids,reason) VALUES (?,?,?,?,?,?)').bind(p.test_id,m.hypothesis_key,m.role,m.outcome,json(m.evidence_ids),m.reason));
  const credit=(kind:string,ref:string,ids:string[])=>writes.push(getD1().prepare("INSERT OR IGNORE INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) VALUES (?,?,?,1,'provenance',?,'operation',?,?,?)").bind(kind,ref,p.test_id,p.family,op,json({evidence_ids:ids,plan_hash:p.predictions_hash}),now()));
  for(const m of matches.filter(m=>m.evidence_ids.length&&m.outcome!=='unchanged'&&m.outcome!=='inconclusive')) {
   credit('hypothesis_discriminated',`${p.test_id}:${m.hypothesis_key}`,m.evidence_ids);
   if(['kit','infrastructure'].includes(m.role)&&m.outcome==='supports')credit('alternative_explanation_discovered',`${p.test_id}:${m.hypothesis_key}`,m.evidence_ids);
   if(m.role==='operation'&&correlated.every(o=>o.facet==='generic_overlap'))credit('generic_correlation_rejected',String(p.test_id),correlated.map(o=>o.id));
  }
  if(correlated.length&&correlated.every(o=>o.facet==='generic_overlap')&&matches.some(m=>m.role==='operation'&&m.outcome==='unchanged'))credit('generic_correlation_rejected',String(p.test_id),correlated.map(o=>o.id));
  if(p.family==='REPLACEMENT_SITE_HUNT'&&correlated.some(o=>o.source==='site_investigator'&&['replacement_continuity','deployment_reappearance'].includes(o.facet)))credit('replacement_found',String(p.test_id),correlated.map(o=>o.id));
  if(correlated.length&&!prior.some(o=>correlated.some(n=>(n.upstream||n.unit)===(o.upstream||o.unit))))credit('fresh_branch_independent_evidence',String(p.test_id),correlated.map(o=>o.id));
  const boundary=await one("SELECT b.id,d.status,d.decided_at FROM scientific_boundaries b JOIN operation_decisions d ON d.id=b.decision_id WHERE b.operation_id=? AND d.status='approved' AND d.decided_at>=? LIMIT 1",op,p.created_at);
  if(boundary&&correlated.some(o=>o.facet==='validated_deposit'&&o.reliability==='deterministic_validation')&&correlated.some(o=>o.facet==='contact'||o.facet==='distinctive_reuse'))credit('operation_split_confirmed',String(boundary.id),correlated.map(o=>o.id));
  // Only direct job lineage earns scientific learning credit. Temporal coincidence earns nothing.
  const changes=correlated.length?await all("SELECT * FROM scientific_history WHERE operation_id=? AND record_kind IN ('hypothesis_revision','contradiction') AND at>=? ORDER BY at LIMIT 100",op,p.created_at):[];
  for(const c of changes){if(!parse<string[]>(c.evidence_ids,[]).some(id=>correlated.some(o=>o.id===id)))continue;
   const state=parse<Row>(c.after_state,{}),kind=c.record_kind==='contradiction'&&String(state.status).startsWith('RESOLVED_')?'contradiction_resolved':c.record_kind==='hypothesis_revision'&&['REJECTED','WEAKENED','BEST_SUPPORTED_BUT_UNPROVEN'].includes(String(state.status))?'hypothesis_discriminated':null;
   if(kind==='contradiction_resolved')credit('old_contradiction_resolved',String(c.id),correlated.map(o=>o.id));
   if(kind)writes.push(getD1().prepare("INSERT OR IGNORE INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) VALUES (?,?,?,1,'provenance',?,'operation',?,?,?)")
    .bind(kind,c.id,p.test_id,p.family,op,json({evidence_ids:correlated.map(o=>o.id),plan_hash:p.predictions_hash}),now()));
  }
  await getD1().batch(writes);
 }
}
async function projectBriefing(op:string){
 const hs=await all('SELECT * FROM scientific_hypotheses WHERE operation_id=? ORDER BY CASE status WHEN \'BEST_SUPPORTED_BUT_UNPROVEN\' THEN 0 WHEN \'REJECTED\' THEN 2 ELSE 1 END,set_key,hypothesis_key LIMIT 30',op),conflicts=await all("SELECT claim,status,reason FROM scientific_contradictions WHERE operation_id=? ORDER BY updated_at DESC LIMIT 12",op),recent=await all('SELECT record_kind,before_state,after_state,evidence_ids,reason,at FROM scientific_history WHERE operation_id=? ORDER BY at DESC,id DESC LIMIT 8',op),active=await one("SELECT p.* FROM scientific_plans p JOIN adaptive_tests t ON t.id=p.test_id WHERE p.operation_id=? AND t.status IN ('running','reserved') ORDER BY p.created_at DESC LIMIT 1",op);
 const direct=await all("SELECT evidence_id,subject,facet,value,detail,reliability FROM scientific_observations WHERE operation_id=? AND reliability IN ('direct_observation','deterministic_validation') ORDER BY captured_at DESC LIMIT 5",op);
 const detail={current_understanding:hs.some(h=>h.status==='BEST_SUPPORTED_BUT_UNPROVEN')?'Distinctive public evidence supports association. Operator identity and ownership remain unproven.':'Several explanations remain. Main is testing which observations distinguish them.',
 key_findings:direct.map(o=>({text:String(parse<Row>(o.detail,{}).title??o.facet),evidence_id:o.evidence_id,reliability:o.reliability})),
 hypotheses:hs.map(h=>({key:h.hypothesis_key,set:h.set_key,statement:h.statement,status:h.status,uncertainty:h.uncertainty,supports:parse(h.supports,[]),contradicts:parse(h.contradicts,[]),alternatives:parse(h.alternatives,[]),predictions:parse(h.predictions,[]),reason:h.reason,assumptions:parse(h.assumptions,[])})),
 biggest_unknown:conflicts.some(c=>c.status==='UNRESOLVED')?'Source disagreement remains unresolved.':'Whether the distinctive observations establish one operation or a shared vendor.',
 current_test:active?{question:active.question,branches:parse(active.branches,[]),falsification:Boolean(active.falsification)}:null,
 recent_changes:recent.map(r=>({...r,before_state:parse(r.before_state,null),after_state:parse(r.after_state,{}),evidence_ids:parse(r.evidence_ids,[])})),contradictions:conflicts};
 const hash=await sha256(json(detail));await getD1().prepare('INSERT INTO scientific_briefings(operation_id,content_hash,detail,updated_at) VALUES (?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET content_hash=excluded.content_hash,detail=excluded.detail,updated_at=excluded.updated_at WHERE content_hash<>excluded.content_hash').bind(op,hash,json(detail),now()).run();
}
export async function scientificView(ref:string){
 const op=await one('SELECT id FROM hunter_operations WHERE id=? OR external_id=?',ref,ref);if(!op)return null;
 if(!await scientificEnabled())return {installed:false};
 const row=await one('SELECT * FROM scientific_briefings WHERE operation_id=?',op.id);
 return {installed:true,...parse<Row>(row?.detail,{}),updated_at:row?.updated_at??null,sets:await all('SELECT set_key,stop_state FROM scientific_sets WHERE operation_id=?',op.id)};
}
export async function scientificAdvanced(ref:string){
 const op=await one('SELECT id FROM hunter_operations WHERE id=? OR external_id=?',ref,ref);if(!op)return null;
 return {operation_id:op.id,plans:await all('SELECT * FROM scientific_plans WHERE operation_id=? ORDER BY created_at DESC LIMIT 30',op.id),branches:await all('SELECT * FROM scientific_branches WHERE operation_id=? LIMIT 40',op.id),conflicts:await all('SELECT * FROM scientific_contradictions WHERE operation_id=? LIMIT 40',op.id),reservations:await all('SELECT * FROM scientific_reservations WHERE operation_id=? LIMIT 40',op.id),boundaries:await all('SELECT * FROM scientific_boundaries WHERE operation_id=? LIMIT 20',op.id)};
}

/** Proposals change no boundary; only v6's hashed analyst review can consolidate/split entities. */
async function proposeScientificSplit(op:string,obs:Observation[]){
 const sites=await all("SELECT oe.entity_id,e.canonical_key FROM operation_entities oe JOIN entities e ON e.id=oe.entity_id WHERE oe.operation_id=? AND e.entity_type='site' AND oe.association<>'excluded' ORDER BY e.id LIMIT 60",op);
 const groups=new Map<string,{sites:string[];evidence:string[]}>();
 for(const site of sites){
  const contacts=obs.filter(o=>o.subject===site.entity_id&&o.facet==='contact'),wallets=obs.filter(o=>o.subject===site.entity_id&&o.facet==='validated_deposit');
  if(!contacts.length||!wallets.length)continue;
  const key=`${contacts[0].value}:${wallets[0].value}`,g=groups.get(key)??{sites:[],evidence:[]};g.sites.push(String(site.entity_id));g.evidence.push(...contacts.map(o=>o.id),...wallets.map(o=>o.id));groups.set(key,g);
 }
 const clusters=[...groups.values()].filter(g=>g.sites.length>=2);if(clusters.length<2)return;
 const membership=new Map(clusters.flatMap((g,i)=>g.sites.map(site=>[site,i] as const)));
 const continuity=new Map<string,Set<number>>();
 for(const o of obs.filter(o=>o.facet==='distinctive_reuse')){const group=membership.get(String(o.detail.source_site??''));if(group==null)continue;const found=continuity.get(o.value)??new Set<number>();found.add(group);continuity.set(o.value,found);}
 if([...continuity.values()].some(groups=>groups.size>1))return; // Only CROSS-cluster continuity blocks this proposal.
 const [a,b]=clusters,reason='Two observed clusters have different validated deposit addresses and different public contacts. Generic overlap alone does not explain one operation; review a split while retaining alternatives.';
 const id=await sha256(`split:${op}:${json([a,b])}`),old=await one('SELECT id FROM scientific_boundaries WHERE id=?',id);if(old)return;
 const {proposeOperationDecision}=await import('../ops/operation-decisions');
 const proposal=await proposeOperationDecision(op,{kind:'split',entity_ids:b.sites,reason});
 await getD1().batch([getD1().prepare("INSERT OR IGNORE INTO scientific_boundaries(id,operation_id,kind,cluster_a,cluster_b,shared_evidence,contradictions,reason,uncertainty,decision_id,created_at) VALUES (?,?,'split',?,?,?,?,?,?,?,?)")
 .bind(id,op,json(a),json(b),json(obs.filter(o=>o.facet==='generic_overlap').map(o=>o.id)),json([...a.evidence,...b.evidence]),reason,'Different contacts and wallets can also reflect configuration changes or a multi-brand operator. Analyst review required.',proposal.id,now()),
 await historical(op,'split_proposal',id,null,{cluster_a:a,cluster_b:b,decision_id:proposal.id,status:'proposed'},[...a.evidence,...b.evidence],reason)]);
}

/** Active material conflicts become bounded investigation questions rather than passive annotations. */
export async function enrichScientificSnapshot(op:string,s:Snapshot){
 const conflicts=await all("SELECT * FROM scientific_contradictions WHERE operation_id=? AND status IN ('UNRESOLVED','INSUFFICIENT_EVIDENCE') ORDER BY updated_at DESC LIMIT 20",op);
 for(const c of conflicts)if(!s.contradictions.some(x=>x.fingerprint===c.fingerprint))s.contradictions.push({fingerprint:String(c.fingerprint),summary:String(c.claim),kind:'source_disagreement',status:'open',new_evidence_since_hunter:true});
 const sets=await all('SELECT set_key,question FROM scientific_sets WHERE operation_id=? ORDER BY set_key LIMIT 20',op);
 for(const set of sets){
  const hs=await all("SELECT hypothesis_key,statement,status,role FROM scientific_hypotheses WHERE operation_id=? AND set_key=? AND status<>'REJECTED' ORDER BY hypothesis_key LIMIT 10",op,set.set_key);
  if(hs.length<2||s.questions.some(q=>q.key===set.set_key))continue;
  s.questions.push({key:String(set.set_key),question:String(set.question),kind:'linkage',alternatives:hs.map(h=>({key:String(h.hypothesis_key),label:String(h.statement),status:h.status==='CHALLENGED'?'challenged':'open'}))});
 }
}
