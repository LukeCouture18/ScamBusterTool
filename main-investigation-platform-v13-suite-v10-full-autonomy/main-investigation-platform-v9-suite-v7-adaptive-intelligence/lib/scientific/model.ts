/** Pure scientific reasoning. Predictions and ratings are expectations, never new evidence. */
import type { Candidate, Gap, Snapshot } from '../adaptive/derive';
import { choose, valueCandidate, utilityOf, POLICY, type Choice } from '../adaptive/value';
import { TESTS } from '../adaptive/ontology';
export const CONTRADICTION_OUTCOMES = ['RESOLVED_SUPPORTS_HYPOTHESIS','RESOLVED_WEAKENS_HYPOTHESIS','RESOLVED_ALTERNATIVE_EXPLANATION','OPERATION_SPLIT_REQUIRED','EVIDENCE_ERROR','INSUFFICIENT_EVIDENCE','UNRESOLVED'] as const;
export const RELIABILITIES = ['direct_observation','deterministic_validation','provider_returned_data','derived_software_analysis','external_metadata','analyst_conclusion'] as const;
export type Observation = { id:string; subject:string; facet:string; value:string; reliability:typeof RELIABILITIES[number]; unit:string; upstream:string; source:string; captured:string; job:string|null; detail:Record<string,unknown> };
export type Explanation = { key:string; role:string; statement:string; status:string; uncertainty:string; supports:Observation[]; contradicts:Observation[]; unexplained:Observation[]; alternatives:string[]; assumptions:string[]; reason:string };
export type Branch = { key:string; label:string; effects:Record<string,string>; absence:boolean; requires_coverage:boolean };
export const independent = (obs:Observation[]) => [...new Map(obs.map(o=>[o.upstream||o.unit,o])).values()];
export function inferRole(key:string,statement:string) {
 const s=`${key} ${statement}`.toLowerCase();
 if(/unknown|insufficient|undistinguished/.test(s))return 'unknown';
 if(/unchanged.*wallet|single.*wallet|same.*wallet.*every|all.*same.*wallet/.test(s))return 'single_wallet';
 if(/kit|template.*unrelated|vendor/.test(s))return 'kit';
 if(/infrastructure|cdn|hosting.*only/.test(s))return 'infrastructure';
 if(/network.*change|token.*change/.test(s))return 'network_change';
 if(/rotation|rotat/.test(s))return 'rotation';
 if(/artifact|observation error/.test(s))return 'observation_error';
 return 'operation';
}
export function revise(h:{key:string;role:string;statement:string;alternatives?:string[];supports?:Observation[];contradicts?:Observation[]}, observations:Observation[]):Explanation {
 const obs=independent(observations), shared=obs.filter(o=>o.facet==='distinctive_reuse'), generic=obs.filter(o=>o.facet==='generic_overlap');
 const deposit=obs.filter(o=>o.facet==='validated_deposit'), networks=new Set(deposit.map(o=>String(o.detail.network??''))), addresses=new Set(deposit.map(o=>o.value));
 let supports=independent(h.supports??[]),contradicts=independent(h.contradicts??[]),status='OPEN',reason='Evidence does not yet distinguish the competing explanations.';
 if(h.role==='operation') {supports=independent([...supports,...shared]);if(shared.length>=2){status='BEST_SUPPORTED_BUT_UNPROVEN';reason='Independent distinctive categories support association; operator identity and ownership remain unknown.';}}
 if(h.role==='kit'||h.role==='infrastructure') {supports=independent([...supports,...generic]);contradicts=independent([...contradicts,...shared]);if(shared.length>=2){status='WEAKENED';reason='Independent distinctive reuse is not explained by generic hosting or a copied template alone.';}else if(generic.length){status='VIABLE';reason='Generic overlap is compatible with shared providers or kits and does not distinguish operators.';}}
 if(h.role==='single_wallet'&&addresses.size>1){contradicts=independent([...contradicts,...deposit]);status='REJECTED';reason='Wallet Investigator validated different deposit addresses; the explicit unchanged single-wallet prediction is false.';}
 if(h.role==='rotation'&&addresses.size>1){supports=independent([...supports,...deposit]);status='VIABLE';reason='Different validated deposit addresses are compatible with rotation, configuration changes or different operators.';}
 if(h.role==='network_change'&&addresses.size>1&&networks.size===1){contradicts=independent([...contradicts,...deposit]);status='WEAKENED';reason='Wallet Investigator places the changed addresses on the same network; a network change alone does not explain them.';}
 if(contradicts.length&&status==='OPEN'){status='CHALLENGED';reason='Independent challenging evidence remains alongside the supporting observations.';}
 if(h.role==='unknown'){status='VIABLE';reason='Unknown remains legitimate: bounded observations cannot establish operator identity or exclude every alternative.';}
 const accounted=new Set([...supports,...contradicts].map(o=>o.id));
 return {...h,status,uncertainty:status==='REJECTED'?'Explicit bounded prediction contradicted.':status==='BEST_SUPPORTED_BUT_UNPROVEN'?'Association better supported; attribution unproven.':'Alternatives remain; no probability estimate is justified.',supports,contradicts,unexplained:obs.filter(o=>!accounted.has(o.id)).slice(0,30),alternatives:h.alternatives??[],assumptions:['Specialist observations are correctly scoped.','Corpus coverage is incomplete.','Shared artifacts may have a common upstream vendor.'],reason};
}
export function prediction(role:string) {
 if(role==='single_wallet')return {expectation:'The scoped deployments display the same validated deposit address.',would_weaken:'A different observed deposit address needing validation.',strong_contradiction:'Wallet Investigator validates a different scoped deposit address.',test_family:'PUBLIC_SITE_INSPECTION'};
 if(role==='kit'||role==='infrastructure')return {expectation:'The shared artifact also appears outside this cluster, without distinctive wallet/contact continuity.',would_weaken:'Independent rare contact or validated wallet reuse.',strong_contradiction:'Multiple independent operation-specific artifacts unexplained by the proposed generic source.',test_family:'PUBLIC_ARTIFACT_SEARCH'};
 if(role==='rotation')return {expectation:'The same public deployment presents a changed validated deposit address over time.',would_weaken:'Observations belong to different sites or times cannot be established.',strong_contradiction:'Deterministic validation establishes that the apparent change is an extraction error.',test_family:'TEMPORAL_RECHECK'};
 if(role==='network_change')return {expectation:'Wallet Investigator establishes a changed displayed network/token context.',would_weaken:'Both addresses validate on the same displayed network.',strong_contradiction:'No network/token change in fully inspected public payment presentations.',test_family:'TEMPORAL_RECHECK'};
 return {expectation:'Independent distinctive wallet, contact or configuration continuity across scoped deployments.',would_weaken:'Only generic kit/CDN similarity remains after bounded checks.',strong_contradiction:'Direct contradictory scope or deterministic evidence error invalidates the claimed linkage.',test_family:'PUBLIC_ARTIFACT_SEARCH'};
}
export function outcomeBranches(hypotheses:{key:string;role:string}[],family:string):Branch[] {
 const generic=family==='RELATED_SITE_HUNT'||family==='CORRELATION_REVIEW';
 const effects=(positive:boolean)=>Object.fromEntries(hypotheses.map(h=>[h.key,h.role==='unknown'?'Uncertainty remains.':positive?(generic?(h.role==='kit'||h.role==='infrastructure'?'Compatible with generic reuse; review commonality.':'Generic overlap alone leaves this explanation unchanged.'):(h.role==='operation'?'Strengthens association if independently validated; no ownership inference.':h.role==='single_wallet'?'Compare validated addresses against unchanged-wallet prediction.':'Compare the observation with this alternative; do not assume rejection.')):'Failure to observe is not absence; leave unchanged unless bounded coverage directly tests the prediction.']));
 return [{key:'distinctive_or_changed_observation',label:'New independent or changed public observation',effects:effects(true),absence:false,requires_coverage:false},
 {key:'not_observed_in_scope',label:'Not observed in the bounded check',effects:effects(false),absence:false,requires_coverage:true},
 {key:'inconclusive',label:'Unavailable, conflicting or incomplete result',effects:Object.fromEntries(hypotheses.map(h=>[h.key,'No update justified; retain uncertainty and disagreement.'])),absence:false,requires_coverage:false}];
}
/** Branch history stays branch-specific; unrelated empty hunts do not exhaust a fresh artifact. */
export function branchProfile(c:Candidate,s:Snapshot) {
 const history=s.history.filter(h=>h.family===c.family&&h.subject===c.subject&&h.status==='finished');
 const inputs=c.family==='PUBLIC_ARTIFACT_SEARCH'?(c.objective.artifacts??[]).map(a=>a.value):[...(c.objective.seeds??[]),...(c.objective.artifacts??[]).map(a=>a.value)];
 const sent=new Set([...(s.finder_sent?.seeds??[]),...(s.finder_sent?.artifacts??[])].map(x=>x.toLowerCase()));
 const fresh=inputs.filter(x=>!sent.has(x.toLowerCase())&&!sent.has(x.toLowerCase().replace(/^(ga4|ua|gtm):/,'')));
 const useful=history.filter(h=>h.useful),duplicates=history.filter(h=>h.duplicate||h.dead);
 const site=s.sites.find(x=>`site:${x.key}`===c.subject),age=site?.status_changed_at?Math.max(0,(Date.parse(s.now)-Date.parse(site.status_changed_at))/86400000):null;
 const continuity=(c.objective.artifacts??[]).filter(a=>['contact','analytics','wallet','build'].includes(a.kind));
 return {history,fresh,inputs,discoveries:useful.length,duplicate_rate:history.length?duplicates.length/history.length:null,depth:history.length,last_useful:useful.at(-1)?.finished_at??null,
 replacement: c.family==='REPLACEMENT_SITE_HUNT'&&site?.status==='dead'&&history.length===0&&continuity.length>0,
 temporal_weight:age===null?.5:age<=7?1:age<=30?.6:.2,continuity:continuity.length};
}
/** v8 uses the SAME eligible candidate pool as v7; changes ranking and retains urgent precedence. */
export function v8ScientificChoice(s:Snapshot,gaps:Gap[],candidates:Candidate[],opts:{seed:string;exploration?:boolean;falsificationRemaining?:number}):Choice {
 const base=choose(s,gaps,candidates,{...opts,exploration:false});
 const valued=candidates.map(c=>valueCandidate(c,s,new Map(gaps.map(g=>[g.key,g]))));
 for(const v of valued){
  const b=branchProfile(v,s);if(TESTS[v.family].specialist!=='site_finder')continue;
  const combinedFresh=v.family==='RELATED_SITE_HUNT'&&v.objective.mode!=='template_variant'&&b.fresh.length>=2&&(v.objective.artifacts??[]).filter(a=>['contact','analytics','wallet','build'].includes(a.kind)&&b.fresh.includes(a.value)).length>=2;
  if(combinedFresh){v.utility=Math.max(v.utility,.85+Math.min(.35,b.fresh.length*.08));v.adjusted=Math.max(v.adjusted,.3);v.eligible=v.prerequisites_met;v.components.saturation.value=0;v.components.saturation.reason='Several unexplored distinctive artifacts open a fresh combined branch despite empty seed-only history.';}
  const freshArtifact=v.family==='PUBLIC_ARTIFACT_SEARCH'&&b.fresh.length>0&&(v.objective.artifacts??[]).some(a=>['contact','analytics','wallet','build'].includes(a.kind));
  if(freshArtifact){v.components.saturation.value=0;v.components.saturation.reason='This artifact branch is fresh; exhausted seed-only branches do not saturate it.';v.utility=Math.max(v.utility,.55+(v.family==='PUBLIC_ARTIFACT_SEARCH'?.25:0));v.adjusted=Math.max(v.adjusted,.2);v.eligible=v.prerequisites_met;}
  if(b.replacement){v.utility=Math.max(v.utility,.8+.3*b.temporal_weight+Math.min(.2,b.continuity*.05));v.adjusted=Math.max(v.adjusted,.3);v.eligible=v.prerequisites_met;v.components.duplicate_probability.reason='A disappearance creates a new bounded temporal question even when its continuity artifact was previously searched.';}
 }
 const ranked=valued.sort((a,b)=>b.utility-a.utility||a.key.localeCompare(b.key));
 const eligible=ranked.filter(v=>v.eligible&&v.utility>=POLICY.utility_floor);
 const urgent=eligible.filter(v=>v.components.report_readiness.value>=.9||v.components.time_sensitivity.value>=.9);
 const falsify=eligible.filter(v=>v.objective.mode==='template_variant'||v.subject.startsWith('infra:')||v.gaps.some(k=>k.startsWith('CONTRADICTION_RESOLUTION:')));
 const chosen=urgent[0]??((opts.falsificationRemaining??0)>0?falsify[0]:null)??eligible[0]??null;
 return {...base,ranked,chosen,exploration:false,stop:chosen?null:base.stop};
}
export function negativeMeaning(input:{successful:boolean;scope:string[];coverage:'complete_scoped'|'partial'|'unknown';limitations:string[];found:boolean}) {
 return {absence:input.successful&&!input.found&&input.coverage==='complete_scoped'&&input.limitations.length===0,
 meaning:input.found?'Observed in the checked scope.':input.successful&&input.coverage==='complete_scoped'&&!input.limitations.length?'Absent within this explicitly finite checked scope only.':'Not observed; absence is not established.',...input};
}

/** v9 ranks the original pool by marginal branch evidence, without arbitrary utility floors.
 * A failed search of other inputs cannot exhaust this branch. Exact repeats stay discounted. */
export function scientificChoice(s:Snapshot,gaps:Gap[],candidates:Candidate[],opts:{seed:string;exploration?:boolean;falsificationRemaining?:number}):Choice {
 const base=choose(s,gaps,candidates,{...opts,exploration:false}),map=new Map(gaps.map(g=>[g.key,g]));
 const ranked=candidates.map(c=>{
  const b=branchProfile(c,s),finder=TESTS[c.family].specialist==='site_finder';
  const history=finder?s.history.filter(h=>h.family!==c.family||h.subject===c.subject&&(!b.fresh.length||h.inputs_hash===c.inputs_hash)):s.history;
  const v=valueCandidate(c,{...s,history},map);
  // Separation uses the test's observable category, and shrinks with known units.
  // These are decision priors, never posterior probabilities or factual evidence.
  const separation=v.components.hypothesis_discrimination.value;
  const gain=Math.min(.12,separation*.12)*(1-v.components.saturation.value)*(1-v.components.duplicate_probability.value);
  v.adjusted+=gain;v.utility=utilityOf(v.adjusted,v.components.report_readiness.value,v.cost_units);
  if(finder&&b.fresh.length)v.components.saturation.reason='Saturation uses this exact branch and input history; unrelated empty hunts do not exhaust fresh public artifacts.';
  return v;
 }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.utility-a.utility||a.key.localeCompare(b.key));
 const eligible=ranked.filter(v=>v.eligible&&v.utility>=POLICY.utility_floor),urgent=eligible.filter(v=>v.components.report_readiness.value>=.8||v.components.time_sensitivity.value>=.8);
 const falsify=eligible.filter(v=>v.objective.mode==='template_variant'||v.subject.startsWith('infra:')||v.gaps.some(k=>k.startsWith('CONTRADICTION_RESOLUTION:')));
 const chosen=urgent[0]??((opts.falsificationRemaining??0)>0?falsify[0]:null)??eligible[0]??null;
 return {...base,ranked,chosen,exploration:false,stop:chosen?null:base.stop};
}

export type PredictionMatch={hypothesis_key:string;role:string;outcome:'supports'|'weakens'|'contradicts'|'unchanged'|'inconclusive';evidence_ids:string[];reason:string};
/** Exact plan hypotheses and source lineage, rather than any newly collected row, determine effects. */
export function matchPredictions(hypotheses:{key:string;role:string}[],baseline:Observation[],observed:Observation[],successful:boolean):PredictionMatch[] {
 const fresh=independent(observed),deposits=fresh.filter(o=>o.facet==='validated_deposit'&&o.reliability==='deterministic_validation'),prior=baseline.filter(o=>o.facet==='validated_deposit'),shared=fresh.filter(o=>o.facet==='distinctive_reuse'),generic=fresh.filter(o=>o.facet==='generic_overlap'),distinctiveCategories=new Set(shared.map(o=>String(o.detail.category??(o.detail.metadata as Record<string,unknown>|undefined)?.category??o.unit)));
 return hypotheses.map(h=>{
  let outcome:PredictionMatch['outcome']=successful?'unchanged':'inconclusive',refs:Observation[]=[],reason='This result does not directly distinguish this prediction.';
  if(successful&&h.role==='single_wallet'&&deposits.length&&new Set([...prior,...deposits].map(o=>o.value)).size>1){outcome='contradicts';refs=deposits;reason='New authoritative scoped deposit evidence contradicts the unchanged-wallet prediction.';}
  if(successful&&h.role==='rotation'){
   refs=deposits.filter(o=>prior.some(p=>p.subject===o.subject&&p.value!==o.value&&Date.parse(p.captured)<Date.parse(o.captured)));
   if(refs.length){outcome='supports';reason='The same deployment presents a different validated deposit at a later time. Rotation remains one of several explanations.';}
  }
  if(successful&&h.role==='network_change'){
   refs=deposits.filter(o=>prior.some(p=>p.subject===o.subject&&p.value!==o.value&&p.detail.network===o.detail.network));
   if(refs.length){outcome='weakens';reason='Changed scoped addresses validate on the same network; network change alone is insufficient.';}
  }
  if(successful&&h.role==='operation'&&distinctiveCategories.size>=2){outcome='supports';refs=shared;reason='Independent distinctive categories support association; attribution remains unknown.';}
  if(successful&&['kit','infrastructure'].includes(h.role)){
   if(distinctiveCategories.size>=2){outcome='weakens';refs=shared;reason='Independent distinctive continuity challenges a generic-only explanation.';}
   else if(generic.length){outcome='supports';refs=generic;reason='Generic overlap is compatible with this alternative and cannot establish an operator.';}
  }
  if(h.role==='unknown'){outcome='unchanged';reason='Unknown remains legitimate after bounded checks.';}
  return {hypothesis_key:h.key,role:h.role,outcome,evidence_ids:refs.map(o=>o.id),reason};
 });
}

/** Comparable claims remain conflicting until an explicit deterministic scoped correction arrives. */
export function classifyDisagreement(claims:Observation[],observations:Observation[]){
 const values=new Set(claims.map(o=>o.value));if(values.size<2)return {status:'RESOLVED_SUPPORTS_HYPOTHESIS',resolution:[] as string[],reason:'Comparable observations agree within the checked scope.'};
 const correction=observations.find(o=>o.reliability==='deterministic_validation'&&Array.isArray((o.detail.metadata as Record<string,unknown>|undefined)?.corrects_evidence_ids)&&((o.detail.metadata as Record<string,unknown>).corrects_evidence_ids as string[]).some(id=>claims.some(c=>c.id===id)));
 return {status:correction?'EVIDENCE_ERROR':'UNRESOLVED',resolution:correction?[correction.id]:[],reason:correction?'Wallet Investigator deterministic correction identifies the scoped evidence error.':claims.map(o=>`${String((o.detail.metadata as Record<string,unknown>|undefined)?.provider||o.source)} says ${o.value}`).join('; ')+'; Main cannot currently resolve this disagreement.'};
}
