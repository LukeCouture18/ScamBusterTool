import type { OpData } from './data.js';
import type { GraphAnalysis } from './graph.js';
import type { InfraAnalysis } from './infrastructure.js';
import type { KitAnalysis } from './kits.js';
import type { FinancialAnalysisV1 } from './financial.js';
import { relevant } from './data.js';
import { listPhrase, plural, daysBetween } from '../core/util.js';

export interface Gap {
  id: string;
  key: string;
  category: 'kit' | 'money' | 'hosting' | 'timeline' | 'operator' | 'corroboration' | 'monitoring' | 'coverage';
  title: string;
  detail: string;
  impact: number;           // 0..100
  entityIds: string[];
  suggestedPivot?: { pivotType: string; entityId: string; label: string };
}

/**
 * What the reconstruction is missing, ranked by how much closing it would
 * change the picture. Each gap names the pivot that would close it.
 */
export function analyzeGaps(data: OpData, graph: GraphAnalysis, infra: InfraAnalysis, kits: KitAnalysis, fin: FinancialAnalysisV1, pivotSignatures: Set<string>): Gap[] {
  const gaps: Gap[] = [];
  const core = new Set(graph.core);
  const done = (pivot: string, canonical: string) => pivotSignatures.has(`${pivot}:${canonical}`);
  const kindsOf = (id: string) => new Set((data.evidenceByEntity.get(id) ?? []).map(e => e.type));

  // Seeds never expanded.
  for (const e of data.entities.filter(x => x.isSeed)) {
    if (![...pivotSignatures].some(s => s.endsWith(`:${e.canonical}`))) {
      gaps.push({ id: `gap-seed-${e.id}`, key: `seed:${e.canonical}`, category: 'coverage', title: `Seed ${e.value} has not been investigated yet`, detail: 'Start a pursuit so Hunter can expand from this seed.', impact: 95, entityIds: [e.id] });
    }
  }
  // Core sites without page/kit evidence.
  const noKit = infra.domains.filter(d => core.has(d.id) && !d.isResourceHost && (d.status === 'active' || d.isSeed) && !d.templates.length && !kindsOf(d.id).has('site_scan'));
  if (noKit.length) {
    const first = noKit[0];
    gaps.push({
      id: 'gap-kit', key: 'kit:unknown', category: 'kit', title: `Page content unknown for ${plural(noKit.length, 'active site')}`,
      detail: `No page fingerprint yet for ${listPhrase(noKit.map(d => d.value), 3)}. Without it Hunter cannot tell which kit is used or which wallets the sites display.`,
      impact: 80, entityIds: noKit.map(d => d.id),
      suggestedPivot: done('SITE_PROFILE', first.value) ? { pivotType: 'SITE_CHECK_REQUEST', entityId: first.id, label: 'Request a site check via Main Platform' } : { pivotType: 'SITE_PROFILE', entityId: first.id, label: 'Fetch passive page fingerprint' },
    });
  }
  // Wallets shown on sites but not traced.
  const untraced = data.entities.filter(e => (e.type === 'wallet' || e.type === 'contract') && relevant(e) && !done('WALLET_TRACE', e.canonical ?? e.value) && (data.in.get(e.id) ?? []).some(r => r.type === 'REFERENCES_WALLET'));
  if (untraced.length) gaps.push({ id: 'gap-money-untraced', key: 'money:untraced', category: 'money', title: `${plural(untraced.length, 'wallet')} from the sites not traced`, detail: `The sites display ${listPhrase(untraced.map(w => `${w.value.slice(0, 10)}…`), 3)} but their transactions have not been followed.`, impact: 85, entityIds: untraced.map(w => w.id), suggestedPivot: { pivotType: 'WALLET_TRACE', entityId: untraced[0].id, label: 'Trace wallet transfers' } });
  // Money trail with no exit.
  if (fin.hasData && !fin.exits.length) {
    const t = fin.wallets.find(w => w.role === 'TREASURY') ?? fin.wallets.find(w => w.role === 'COLLECTION');
    const ent = t ? data.entities.find(e => e.value.toLowerCase() === t.address) : undefined;
    gaps.push({ id: 'gap-money-exit', key: 'money:exit', category: 'money', title: 'Cash-out point not found yet', detail: 'Funds have been traced into the operation’s wallets but not to an exchange, mixer or bridge. The exit is usually the most actionable point.', impact: 75, entityIds: ent ? [ent.id] : [], suggestedPivot: ent && !done('WALLET_TRACE', ent.canonical ?? ent.value) ? { pivotType: 'WALLET_TRACE', entityId: ent.id, label: 'Trace treasury outflows' } : undefined });
  }
  // Exchange deposit addresses (actionable) — note as a gap in legal/process terms.
  const deposits = fin.wallets.filter(w => w.role === 'CEX_DEPOSIT');
  if (deposits.length) gaps.push({ id: 'gap-exchange', key: 'money:exchange-account', category: 'money', title: 'Exchange account behind the deposit address is unknown', detail: `${plural(deposits.length, 'deposit address')} (${listPhrase(deposits.map(d => `${d.address.slice(0, 10)}…`), 2)}) belong to an exchange customer. Only the exchange can identify the account; this is the natural hand-off point for a report.`, impact: 60, entityIds: deposits.map(d => d.id) });
  // Domains without registration dates (timeline).
  const undated = infra.domains.filter(d => core.has(d.id) && !d.registeredAt);
  if (undated.length) gaps.push({ id: 'gap-timeline', key: 'timeline:registration', category: 'timeline', title: `Registration dates missing for ${plural(undated.length, 'domain')}`, detail: `The timeline cannot place ${listPhrase(undated.map(d => d.value), 3)} without registration records.`, impact: 40, entityIds: undated.map(d => d.id), suggestedPivot: { pivotType: 'RDAP_DOMAIN', entityId: undated[0].id, label: 'Fetch registration record' } });
  // Hosting unknown.
  const noAsn = data.entities.filter(e => e.type === 'ip' && relevant(e) && !e.metadata?.asn);
  if (noAsn.length) gaps.push({ id: 'gap-hosting', key: 'hosting:asn', category: 'hosting', title: `Network owner unknown for ${plural(noAsn.length, 'server')}`, detail: `${listPhrase(noAsn.map(i => i.value), 3)} — knowing the hosting provider helps cluster infrastructure and target abuse reports.`, impact: 35, entityIds: noAsn.map(i => i.id), suggestedPivot: { pivotType: 'IP_PROFILE', entityId: noAsn[0].id, label: 'Identify network owner' } });
  // Single-source links under key conclusions.
  const weak = data.relationships.filter(r => core.has(r.sourceEntityId) && core.has(r.targetEntityId) && (r.sources?.length ?? 1) === 1 && r.confidence < 0.7 && r.assertion !== 'blockchain_fact');
  if (weak.length >= 3) gaps.push({ id: 'gap-corroboration', key: 'corroboration:weak', category: 'corroboration', title: `${plural(weak.length, 'link')} rest on a single, lower-confidence source`, detail: 'Corroborating these from a second independent source would harden the reconstruction.', impact: 45, entityIds: [] });
  // No operator-level indicator yet.
  if (infra.domains.filter(d => core.has(d.id)).length >= 2 && !kits.operatorIndicators.length) gaps.push({ id: 'gap-operator', key: 'operator:none', category: 'operator', title: 'No operator-level link between the sites yet', detail: 'The sites are linked by infrastructure and/or kit code only. An analytics ID, support handle, deployer or shared collection wallet would show they are run by the same people.', impact: 70, entityIds: [] });
  // Stale observations.
  const stale = infra.domains.filter(d => d.status === 'active' && core.has(d.id) && daysBetween(d.lastSeen, new Date().toISOString()) > 14);
  if (stale.length) gaps.push({ id: 'gap-stale', key: 'monitoring:stale', category: 'monitoring', title: `${plural(stale.length, 'active site')} not re-checked for over two weeks`, detail: `${listPhrase(stale.map(d => d.value), 3)} may have changed. Monitors re-check them automatically once enabled.`, impact: 30, entityIds: stale.map(d => d.id) });
  // Unmonitored standby domains.
  if (infra.standby.length) gaps.push({ id: 'gap-standby', key: 'monitoring:standby', category: 'monitoring', title: `${plural(infra.standby.length, 'reserve domain')} could go live at any time`, detail: `${listPhrase(infra.standby, 3)} are registered but not serving yet. Watching them catches the next wave early.`, impact: 50, entityIds: infra.domains.filter(d => infra.standby.includes(d.value)).map(d => d.id) });
  return gaps.sort((a, b) => b.impact - a.impact);
}
