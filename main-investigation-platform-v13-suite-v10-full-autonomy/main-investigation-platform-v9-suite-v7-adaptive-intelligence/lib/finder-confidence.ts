/** Assess investigation value separately from operator relationship. No score is evidence. */
import { getD1 } from './platform';
import { clamp, parse, type Row } from './ops/common';
import { familyOf, normalizeAddress } from './wallet-pipeline';

type Proof = { address:string; network:string; investigation_id:string; evidence_ids:string[] };
const core = new Set(['promise','withdrawal_trap','wallet','seed_phrase','impersonation','app_kit','recovery']);
const generic = /cdn|hosting|template|kit|infrastructure|certificate|nameserver|counterparty|exchange|wording|metadata|\bip\b/i;
const distinctive = /distinctive_contact|contact_reuse|config_reuse|artifact_reuse/;
export function assessFinder(row:Row, proofs:Proof[] = []) {
 const d=parse<Row>(row.details,{}), signals=(Array.isArray(d.signals)?d.signals:[]).filter(s=>s&&typeof s==='object').slice(0,30) as Row[];
 const units=new Map<string,Row>(), unknown:string[]=[], why:string[]=[], contradictions:string[]=[];
 for(const s of signals) {
  const name=String(s.name??s.kind??''),group=String(s.group??name),phrase=String(s.phrase??name).slice(0,240);
  if(Number(s.strength??1)<0||['legitimacy','established'].includes(group))contradictions.push(phrase);
  if(generic.test(name+' '+group)&&!core.has(group)) {why.push(phrase+' (generic correlation)');continue;}
  const origin=String(s.upstream_id??s.artifact_hash??s.origin_id??s.origin_url??'').slice(0,500);
  // One unknown upstream unit for all unknown-origin observations, never one per signal.
  const key=origin||'unknown-origin';
  if(!units.has(key))units.set(key,s);
  if(!origin)unknown.push(phrase);
  why.push(phrase);
 }
 const positive=[...new Set(signals.filter(s=>core.has(String(s.group??s.kind))&&Number(s.strength??1)>0).map(s=>String(s.group??s.kind)))];
 const dead=['dead','unreachable','gone'].includes(String(d.site_status??''))||Number((d.fetch as Row|undefined)?.status)>=400;
 const duplicate=['suppressed','skipped'].includes(String(row.status))||Boolean(d.duplicate);
 const novelty=parse<Row>(d.novelty,{}), newValue=duplicate?0:novelty.returned_from||novelty.new_family?.valueOf()?0.8:0.5;
 const quality=dead?0:clamp(0.25+Math.min(positive.length,3)*0.16+Math.min(proofs.length,2)*0.15-contradictions.length*0.2);
 const priority=dead||duplicate?0:clamp((positive.length?0.58+Math.min(positive.length,3)*0.08:0.15)+Math.min(proofs.length,2)*0.12-contradictions.length*0.2);
 const origins=[...units.keys()].filter(k=>k!=='unknown-origin');
 const relationship=new Set(proofs.map(p=>p.investigation_id)).size>=2?'supported wallet reuse':signals.some(s=>distinctive.test(String(s.name??s.kind))&&Boolean(s.origin_id??s.origin_url??s.upstream_id))?'specific association to investigate':'unestablished';
 const uncertainty=[...(unknown.length?['Observation origin is incomplete; unknown origins count as one source.']:[]),...contradictions.map(c=>'Counter-evidence: '+c),...(!proofs.length?['Finder wallet labels are unverified until matching Main / Wallet Investigator deposit proof exists.']:[]),...(dead?['Site could not be reached.']:[])];
 return {investigation_priority:{score:priority,label:priority>=.7?'high':priority>=.5?'worth checking':'low'}, relationship_confidence:relationship,
  evidence_quality:{score:quality,label:quality>=.7?'strong observations':quality>=.5?'bounded observations':'limited'},
  evidence_independence:{known_origins:origins.length,unknown_origin_units:unknown.length?1:0,units:units.size,origins},
  novelty:newValue,expected_investigation_value:Math.round(priority*(.6+.4*newValue)*1000)/1000,
  important_uncertainty:uncertainty,why_found:why.slice(0,12),meaning:positive.length?'Recorded indicators justify bounded public investigation.':'The available indicators do not justify automatic investigation.',
  does_not_prove:['Fraud, identity, ownership or control.','Shared infrastructure, a copied artifact, or a transaction counterparty is insufficient.'],
  recommended_next_action:dead?'Park until a scheduled public revisit.':priority>=.7?'Collect bounded public site evidence.':'Wait for stronger specific evidence.',
  authoritative_wallet_proofs:proofs.slice(0,8),eligible:priority>=.7&&!dead&&!duplicate&&contradictions.length===0};
}

/** Trust comes from stored, authenticated specialist results, never a Finder validated flag. */
export async function finderAssessment(row:Row) {
 const d=parse<Row>(row.details,{}), signals=(Array.isArray(d.signals)?d.signals:[]).filter(s=>s&&typeof s==='object'&&!Array.isArray(s)).slice(0,30) as Row[];
 const wallets=(Array.isArray(d.wallet_proofs)?d.wallet_proofs:signals.filter(s=>s.kind==='wallet_reuse'||s.name==='wallet_reuse')).filter(w=>w&&typeof w==='object'&&!Array.isArray(w)).slice(0,8) as Row[];
 const proofs:Proof[]=[];
 for(const w of wallets) {
  const address=String(w.address??''),network=String(w.network??'').toLowerCase();if(!address||!network||address.length>160||network.length>40)continue;
  const rows=(await getD1().prepare(`SELECT c.investigation_id,c.address,c.validated_network,o.evidence_id
   FROM wallet_candidates c JOIN wallet_observations o ON o.candidate_id=c.id AND o.context_class='deposit'
   JOIN evidence e ON e.id=o.evidence_id AND e.investigation_id=c.investigation_id
   JOIN jobs j ON j.id=c.validation_job_id AND j.investigation_id=c.investigation_id AND j.job_type='ANALYZE_WALLET' AND j.target_module='wallet_investigator' AND j.status='completed'
   WHERE c.address_normalized=? AND c.validated_network=? AND c.validation_status='valid' AND c.best_context='deposit'
   AND e.source_module IN ('crypto_wallet_logger','site_investigator') ORDER BY c.investigation_id,o.id LIMIT 16`)
   .bind(normalizeAddress(familyOf(address),address),network).all<Row>()).results;
  for(const r of rows) {
   const id=String(r.investigation_id),existing=proofs.find(p=>p.investigation_id===id&&p.address===address&&p.network===network);
   if(existing)existing.evidence_ids=[...new Set([...existing.evidence_ids,String(r.evidence_id)])].slice(0,5);
   else proofs.push({address,network,investigation_id:id,evidence_ids:[String(r.evidence_id)]});
  }
 }
 return assessFinder(row,proofs);
}
