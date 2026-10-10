import type { IntelStore, FacetChange, FacetValue, Contradiction } from '../core/intelStore.js';
import type { OpData } from '../analysis/data.js';
import type { MembershipAnalysis } from '../reasoning/membership.js';
import type { InfraAnalysis } from '../analysis/infrastructure.js';
import type { FinancialAnalysisV1 } from '../analysis/financial.js';
import type { KitAnalysis } from '../analysis/kits.js';
import type { Gap } from '../analysis/gaps.js';
import type { ReappearanceLead } from '../types.js';
import { FACET_LABEL } from './facets.js';
import { round, plural, listPhrase } from '../core/util.js';

/**
 * The living operation model.
 *
 * Everything Hunter believes about an operation at one moment, organised the
 * way an investigator thinks about it rather than as a graph: which sites
 * belong (and since when), each site's life (registered → live → dark →
 * resurfaced), how the infrastructure moved, how the kit evolved, where the
 * money goes, whether the operation is active, dormant or due to rotate,
 * competing explanations for what is seen, contradictions, open unknowns.
 *
 * Every re-analysis rebuilds the model from the evidence and the facet ledger;
 * when it differs materially from the previous version a new model version is
 * stored with a readable diff, so "what changed since last week" is a lookup.
 */

export type SiteState = 'pending' | 'live' | 'dark' | 'suspended' | 'resurfaced' | 'unknown';

export interface SiteLife {
  entityId: string; value: string; membership: string; probability: number;
  registeredAt: string | null; firstSeen: string; lastSeen: string; state: SiteState; stateSince: string | null;
  wentDarkAt: string | null; resurfacedAt: string | null; lifetimeDays: number | null;
  hosting: Array<{ value: string; from: string; to: string | null }>;
  nameservers: Array<{ value: string; from: string; to: string | null }>;
  kit: string | null;
}

export interface Forecast {
  status: 'due' | 'soon' | 'overdue' | 'not_due' | 'unknown';
  basis: string;
  medianIntervalDays: number | null;
  lastWaveAt: string | null;
  nextExpectedAt: string | null;
  window: [string, string] | null;
  confidence: number;
  reserve: string[];
}

export interface AchHypothesis { key: string; label: string; inconsistency: number; support: number; score: number; verdict: 'favoured' | 'viable' | 'unlikely' }
export interface AchEvidence { text: string; weight: number; ratings: Record<string, 'C' | 'I' | 'N' | 'CC' | 'II'>; evidenceIds: string[] }
export interface AchQuestion {
  key: string; question: string; hypotheses: AchHypothesis[]; evidence: AchEvidence[];
  leading: string; margin: number; discriminatingTest: string; caveat: string;
}

export interface ContradictionDraft { fingerprint: string; kind: string; severity: number; summary: string; data: Record<string, any> }

export interface LivingModel {
  builtAt: string;
  status: 'active' | 'rotating' | 'dormant' | 'dark' | 'unknown';
  statusReason: string;
  counts: { members: number; probable: number; candidates: number; live: number; dark: number; reserve: number; operatorIndicators: number; wallets: number };
  sites: SiteLife[];
  waves: Array<{ index: number; start: string; end: string; sites: string[] }>;
  forecast: Forecast;
  infraHistory: Array<{ at: string; site: string; facet: string; kind: string; text: string; significance: number }>;
  kitLineage: Array<{ family: string; variants: Array<{ label: string; firstSeen: string; sites: string[]; added: string[] }> }>;
  money: {
    pipeline: Array<{ address: string; role: string; reason: string }>;
    exits: Array<{ address: string; label: string; kind: string; usd: number; share: number | null }>;
    stolenUsd: number; victims: number;
  };
  otherGroups: Array<{ domains: string[]; indicators: string[]; overlap: string[] }>;
  hypotheses: AchQuestion[];
  contradictions: ContradictionDraft[];
  unknowns: string[];
}

const DAY = 86400000;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const iso = (ms: number) => new Date(ms).toISOString();
const short = (v: string) => (v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);

export function buildLivingModel(input: {
  data: OpData; intel: IntelStore; membership: MembershipAnalysis; infra: InfraAnalysis; fin: FinancialAnalysisV1; kits: KitAnalysis; gaps: Gap[]; reapps: ReappearanceLead[]; now?: number;
}): LivingModel {
  const { data, intel, membership, infra, fin, kits, gaps } = input;
  const now = input.now ?? Date.now();
  const facets = intel.facetValues(data.op.id);
  const changes = intel.facetChanges(data.op.id, { limit: 2000 });
  const facetsOf = new Map<string, FacetValue[]>();
  for (const f of facets) (facetsOf.get(f.entityId) ?? facetsOf.set(f.entityId, []).get(f.entityId)!).push(f);
  const changesOf = new Map<string, FacetChange[]>();
  for (const c of changes) (changesOf.get(c.entityId) ?? changesOf.set(c.entityId, []).get(c.entityId)!).push(c);

  // ------------------------------------------------------------ sites and their lives
  const kitOf = new Map<string, string>();
  for (const f of kits.families) for (const v of f.variants) for (const d of f.domains) if (!kitOf.has(d)) kitOf.set(d, f.name);
  const sites: SiteLife[] = [];
  for (const m of membership.members) {
    if (m.type !== 'domain' || !['member', 'probable'].includes(m.status)) continue;
    const e = data.byId.get(m.entityId);
    if (!e || e.metadata?.role === 'script/resource host') continue;
    const fv = facetsOf.get(e.id) ?? [];
    const ch = (changesOf.get(e.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const history = (facet: string) => fv.filter(f => f.facet === facet).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)).map(f => ({ value: f.value, from: f.firstSeen, to: f.current ? null : (f.endedAt ?? f.lastSeen) }));
    const dnsStatus = fv.filter(f => f.facet === 'dns.status' && f.current).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
    const rdap = fv.filter(f => f.facet === 'rdap.status' && f.current)[0];
    const dark = ch.filter(c => (c.facet === 'dns.status' && c.to === 'no_answer') || (c.facet === 'dns.a' && c.kind === 'disappeared'));
    const back = ch.filter(c => c.kind === 'resurfaced' && (c.facet === 'dns.a' || c.facet === 'dns.status'));
    let state: SiteState = 'unknown';
    let stateSince: string | null = null;
    if (rdap && /hold|suspend|redemption|delete/i.test(rdap.value)) { state = 'suspended'; stateSince = rdap.firstSeen; }
    else if (dnsStatus?.value === 'no_answer') { state = 'dark'; stateSince = dnsStatus.firstSeen; }
    else if (dnsStatus?.value === 'resolving') {
      const lastBack = back[back.length - 1];
      state = lastBack && (!dark.length || lastBack.at > dark[dark.length - 1].at) ? 'resurfaced' : 'live';
      stateSince = lastBack?.at ?? dnsStatus.firstSeen;
    } else if (e.metadata?.standby || infra.standby.includes(e.value)) state = 'pending';
    else if (infra.takenDown.includes(e.value)) state = 'dark';
    const reg = (e.metadata?.registeredAt as string | undefined) ?? null;
    const wentDarkAt = dark.length ? dark[dark.length - 1].at : (state === 'dark' || state === 'suspended' ? stateSince : null);
    const lifeEnd = wentDarkAt ? Date.parse(wentDarkAt) : state === 'live' || state === 'resurfaced' ? now : null;
    sites.push({
      entityId: e.id, value: e.value, membership: m.status, probability: m.probability, registeredAt: reg, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
      state, stateSince, wentDarkAt, resurfacedAt: back.length ? back[back.length - 1].at : null,
      lifetimeDays: reg && lifeEnd ? Math.max(0, Math.round((lifeEnd - Date.parse(reg)) / DAY)) : null,
      hosting: history('dns.a').length ? history('dns.a') : history('hosting.ip'), nameservers: history('dns.ns').length ? history('dns.ns') : history('rdap.ns'),
      kit: kitOf.get(e.value) ?? null,
    });
  }
  sites.sort((a, b) => (a.registeredAt ?? a.firstSeen).localeCompare(b.registeredAt ?? b.firstSeen));
  const memberSites = sites.filter(s => s.membership === 'member');

  // ------------------------------------------------------------ waves and forecast
  const regs = memberSites.filter(s => s.registeredAt).map(s => ({ at: Date.parse(s.registeredAt!), site: s.value })).sort((a, b) => a.at - b.at);
  const waves: LivingModel['waves'] = [];
  for (const r of regs) {
    const w = waves[waves.length - 1];
    if (w && r.at - Date.parse(w.end) <= 10 * DAY) { w.end = iso(r.at); w.sites.push(r.site); }
    else waves.push({ index: waves.length + 1, start: iso(r.at), end: iso(r.at), sites: [r.site] });
  }
  const reserve = [...new Set([...infra.standby, ...infra.possibleReserve, ...sites.filter(s => s.state === 'pending').map(s => s.value)])];
  const forecast = forecastNextWave(waves, reserve, now);

  // ------------------------------------------------------------ status of the operation as a whole
  const live = sites.filter(s => s.state === 'live' || s.state === 'resurfaced');
  const darkSites = sites.filter(s => s.state === 'dark' || s.state === 'suspended');
  const recentDark = darkSites.filter(s => s.wentDarkAt && now - Date.parse(s.wentDarkAt) <= 21 * DAY);
  const lastReg = regs.length ? regs[regs.length - 1].at : null;
  const lastFlow = fin.flows.map(f => Date.parse(f.last)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;
  const lastActivity = Math.max(lastReg ?? 0, lastFlow ?? 0, ...live.map(s => Date.parse(s.lastSeen)));
  let status: LivingModel['status'] = 'unknown';
  let statusReason = 'Not enough dated evidence yet.';
  if (!memberSites.length && !fin.hasData) { status = 'unknown'; }
  else if (recentDark.length && (reserve.length || forecast.status === 'due' || forecast.status === 'overdue')) { status = 'rotating'; statusReason = `${plural(recentDark.length, 'site')} went dark recently${reserve.length ? ` and ${plural(reserve.length, 'reserve domain')} ${reserve.length === 1 ? 'is' : 'are'} ready` : ''}${forecast.status === 'due' || forecast.status === 'overdue' ? `; by its own rhythm a new wave is ${forecast.status}` : ''}.`; }
  else if (live.length) { status = 'active'; statusReason = `${plural(live.length, 'site')} still ${live.length === 1 ? 'answers' : 'answer'}${lastFlow && now - lastFlow <= 30 * DAY ? ', and money moved in the last 30 days' : ''}.`; }
  else if (darkSites.length && lastActivity && now - lastActivity > 60 * DAY) { status = 'dormant'; statusReason = `No live sites and no activity for ${Math.round((now - lastActivity) / DAY)} days. Operations often return after a pause — standing hunts keep watching.`; }
  else if (darkSites.length) { status = 'dark'; statusReason = `All ${plural(darkSites.length, 'known site')} are down; no replacement found yet.`; }

  // ------------------------------------------------------------ infrastructure history (member sites only)
  const siteIds = new Set(sites.map(s => s.entityId));
  const infraHistory = changes
    .filter(c => siteIds.has(c.entityId) && ['dns.a', 'dns.ns', 'hosting.ip', 'rdap.status', 'rdap.ns', 'dns.status', 'page.structure', 'rdap.registrar'].includes(c.facet) && c.kind !== 'appeared')
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80)
    .map(c => ({ at: c.at, site: data.byId.get(c.entityId)?.value ?? c.entityId, facet: c.facet, kind: c.kind, significance: c.significance, text: describe(c) }));

  // ------------------------------------------------------------ kit lineage
  const memberValues = new Set(memberSites.map(s => s.value));
  const kitLineage = kits.families.filter(f => f.domains.some(d => memberValues.has(d))).map(f => ({
    family: f.name,
    variants: f.variants.map(v => ({ label: v.label, firstSeen: v.firstSeen, added: v.addedCapabilities, sites: (kits.templates.find(t => t.id === v.templateId) as any)?.domains?.filter((d: string) => memberValues.has(d)) ?? [] })),
  }));

  // ------------------------------------------------------------ money
  const pipeline = membership.members.filter(m => (m.type === 'wallet' || m.type === 'contract') && m.status === 'member').map(m => {
    const w = fin.wallets.find(x => x.address.toLowerCase() === m.value.toLowerCase());
    return { address: m.value, role: w?.role ?? 'UNKNOWN', reason: m.factors[0]?.text ?? '' };
  });
  const pipeSet = new Set(pipeline.map(p => p.address.toLowerCase()));
  const exits = fin.exits.map(x => {
    const inflow = fin.flows.filter(f => f.to.toLowerCase() === x.address.toLowerCase());
    const fromOp = inflow.filter(f => pipeSet.has(f.from.toLowerCase())).reduce((s, f) => s + (f.usd || f.total), 0);
    const total = inflow.reduce((s, f) => s + (f.usd || f.total), 0);
    return { address: x.address, label: x.label, kind: x.kind, usd: x.usd, share: total ? round(fromOp / total, 2) : null };
  });

  // ------------------------------------------------------------ competing explanations, contradictions, unknowns
  const hypotheses = [whoIsBehind(data, membership, fin, pipeline), isItActive(status, live.length, darkSites.length, recentDark.length, reserve, forecast, input.reapps)].filter(Boolean) as AchQuestion[];
  const contradictions = detectContradictions(data, membership, sites, changes, fin);
  const unknowns = listUnknowns(membership, sites, fin, forecast, gaps, pipeline);

  return {
    builtAt: iso(now), status, statusReason,
    counts: {
      members: memberSites.length, probable: sites.filter(s => s.membership === 'probable').length,
      candidates: membership.members.filter(m => m.type === 'domain' && m.status === 'candidate').length,
      live: live.length, dark: darkSites.length, reserve: reserve.length,
      operatorIndicators: Object.values(membership.indicators).filter(i => i.level === 'operator' && i.carriers.some(c => membership.byId[c]?.status === 'member')).length,
      wallets: pipeline.length,
    },
    sites, waves, forecast, infraHistory, kitLineage,
    money: { pipeline, exits, stolenUsd: fin.stolen.usd, victims: fin.stolen.victims },
    otherGroups: membership.otherGroups.map(g => ({ domains: g.domains.map(id => data.byId.get(id)?.value ?? id), indicators: g.indicators.map(id => data.byId.get(id)?.value ?? id), overlap: g.overlapWithOperation.map(id => data.byId.get(id)?.value ?? id) })),
    hypotheses, contradictions, unknowns,
  };
}

function describe(c: FacetChange): string {
  const label = FACET_LABEL[c.facet] ?? c.facet;
  switch (c.kind) {
    case 'changed': return `${label} changed from ${c.from ?? '—'} to ${c.to ?? '—'}`;
    case 'disappeared': return `${label} ${c.from ?? ''} no longer observed`;
    case 'resurfaced': return `${label} ${c.to ?? ''} observed again after a gap`;
    case 'contradiction': return `sources disagree on ${label}: ${c.from ?? '—'} vs ${c.to ?? '—'}`;
    default: return `${label}: ${c.to ?? ''}`;
  }
}

/** When is the next deployment wave expected, from the operation's own rhythm? */
export function forecastNextWave(waves: Array<{ start: string }>, reserve: string[], now = Date.now()): Forecast {
  const starts = waves.map(w => Date.parse(w.start)).sort((a, b) => a - b);
  const base: Forecast = { status: 'unknown', basis: '', medianIntervalDays: null, lastWaveAt: starts.length ? iso(starts[starts.length - 1]) : null, nextExpectedAt: null, window: null, confidence: 0, reserve };
  if (starts.length < 2) {
    base.basis = starts.length ? 'Only one deployment wave is known, so there is no rhythm to extrapolate yet.' : 'No dated deployment waves yet.';
    if (reserve.length) { base.status = 'soon'; base.basis += ` But ${plural(reserve.length, 'registered domain')} ${reserve.length === 1 ? 'is' : 'are'} parked on the operation's infrastructure, ready to go live.`; base.confidence = 0.35; }
    return base;
  }
  const intervals = starts.slice(1).map((s, i) => (s - starts[i]) / DAY);
  const med = median(intervals)!;
  const spread = intervals.length > 1 ? Math.max(...intervals) - Math.min(...intervals) : med * 0.5;
  const last = starts[starts.length - 1];
  const next = last + med * DAY;
  const half = Math.max(5, spread / 2 + med * 0.15) * DAY;
  const window: [string, string] = [iso(next - half), iso(next + half)];
  let status: Forecast['status'];
  if (now > next + half) status = 'overdue';
  else if (now >= next - half) status = 'due';
  else if (now >= next - half - med * 0.25 * DAY) status = 'soon';
  else status = 'not_due';
  const regularity = med > 0 ? Math.max(0, 1 - spread / med) : 0;
  const confidence = round(Math.min(0.85, 0.25 + 0.15 * intervals.length + 0.3 * regularity + (reserve.length ? 0.1 : 0)), 2);
  return {
    status, medianIntervalDays: round(med, 1), lastWaveAt: iso(last), nextExpectedAt: iso(next), window, confidence, reserve,
    basis: `${waves.length} waves roughly every ${Math.round(med)} days (intervals: ${intervals.map(i => Math.round(i)).join(', ')} days)${reserve.length ? `; ${plural(reserve.length, 'reserve domain')} already registered` : ''}. A rhythm is a tendency, not a schedule.`,
  };
}

// ------------------------------------------------------------ analysis of competing hypotheses
function ach(key: string, question: string, hyps: Array<{ key: string; label: string }>, evidence: AchEvidence[], tests: Record<string, string>, caveat: string): AchQuestion | null {
  if (!evidence.length) return null;
  const val = { C: 1, CC: 2, I: -1, II: -2, N: 0 } as const;
  const scored = hyps.map(h => {
    let inc = 0, sup = 0;
    for (const e of evidence) { const r = e.ratings[h.key] ?? 'N'; const v = val[r] * e.weight; if (v < 0) inc += -v; else sup += v; }
    return { ...h, inconsistency: round(inc, 2), support: round(sup, 2), score: round(sup - 1.5 * inc, 2) };
  }).sort((a, b) => b.score - a.score);
  const margin = scored.length > 1 ? round(scored[0].score - scored[1].score, 2) : scored[0].score;
  const out: AchHypothesis[] = scored.map((h, i) => ({ ...h, verdict: i === 0 && margin >= 1 ? 'favoured' : h.inconsistency > h.support + 1 ? 'unlikely' : 'viable' }));
  const runnerUp = scored[1]?.key;
  return { key, question, hypotheses: out, evidence, leading: scored[0].label, margin, discriminatingTest: tests[`${scored[0].key}|${runnerUp}`] ?? tests[scored[0].key] ?? tests.default, caveat };
}

function whoIsBehind(data: OpData, m: MembershipAnalysis, fin: FinancialAnalysisV1, pipeline: Array<{ address: string; role: string }>): AchQuestion | null {
  const members = m.members.filter(x => x.type === 'domain' && x.status === 'member');
  if (members.length < 2) return null;
  const inds = Object.values(m.indicators).filter(i => i.carriers.filter(c => m.byId[c]?.status === 'member').length >= 2);
  const ev: AchEvidence[] = [];
  const opIds = inds.filter(i => i.level === 'operator' && ['identifier', 'email'].includes(i.type));
  const opFiles = inds.filter(i => i.level === 'operator' && i.type === 'artifact');
  const vendor = inds.filter(i => i.level === 'vendor');
  const infraInd = inds.filter(i => i.level === 'infrastructure');
  const planted = Object.values(m.indicators).filter(i => i.inconsistent.length);
  if (opIds.length) ev.push({ text: `${plural(opIds.length, 'operator setting')} (${listPhrase(opIds.map(i => short(i.value)), 3)}) recur across member sites`, weight: 1.5, ratings: { one: 'CC', customers: 'I', coincidence: 'II' }, evidenceIds: [] });
  if (opFiles.length) ev.push({ text: `${plural(opFiles.length, 'per-deployment file')} identical across member sites`, weight: 1, ratings: { one: 'C', customers: 'I', coincidence: 'II' }, evidenceIds: [] });
  if (vendor.length) ev.push({ text: `Kit-level indicators shared (${listPhrase(vendor.map(i => short(i.value)), 2)}) — these identify the software, and also appear with other operators`, weight: 0.6, ratings: { one: 'C', customers: 'C', coincidence: 'I' }, evidenceIds: [] });
  if (infraInd.length) ev.push({ text: `Shared private infrastructure (${listPhrase(infraInd.map(i => short(i.value)), 2)})`, weight: 0.8, ratings: { one: 'C', customers: 'N', coincidence: 'I' }, evidenceIds: [] });
  const treasuries = pipeline.filter(p => p.role === 'TREASURY');
  if (treasuries.length) ev.push({ text: `Collection wallets converge on ${plural(treasuries.length, 'treasury', 'treasuries')}`, weight: 1.4, ratings: { one: 'CC', customers: 'I', coincidence: 'II' }, evidenceIds: [] });
  if (m.otherGroups.length) ev.push({ text: `${plural(m.otherGroups.length, 'other operator group')} use${m.otherGroups.length === 1 ? 's' : ''} the same kit with different settings`, weight: 0.8, ratings: { one: 'N', customers: 'C', coincidence: 'N' }, evidenceIds: [] });
  if (planted.length) ev.push({ text: `${plural(planted.length, 'setting')} appear${planted.length === 1 ? 's' : ''} on a site whose other settings belong to someone else (copied or planted)`, weight: 0.7, ratings: { one: 'N', customers: 'C', coincidence: 'N' }, evidenceIds: [] });
  if (!opIds.length && !opFiles.length && !treasuries.length) ev.push({ text: 'No operator-level link between the sites has been found yet', weight: 1, ratings: { one: 'I', customers: 'C', coincidence: 'C' }, evidenceIds: [] });
  void data; void fin;
  return ach('who', 'Are the member sites run by one operator?', [
    { key: 'one', label: 'One operator runs these sites' },
    { key: 'customers', label: 'Several customers of the same kit vendor' },
    { key: 'coincidence', label: 'Unrelated sites that happen to share hosting' },
  ], ev, {
    'one|customers': 'Trace the collection wallets of two different member sites: convergence on one treasury separates one operator from separate kit customers.',
    'customers|one': 'Look for an operator setting (analytics account, support handle, collection wallet) shared by sites from different groups — none so far.',
    default: 'Profile more member sites for operator settings (analytics, support handles, wallets).',
  }, 'Even the favoured explanation is an inference from shared settings and money flows; it is not proof of who controls the sites.');
}

function isItActive(status: string, live: number, dark: number, recentDark: number, reserve: string[], f: Forecast, reapps: ReappearanceLead[]): AchQuestion | null {
  if (!live && !dark && !reserve.length) return null;
  const ev: AchEvidence[] = [];
  if (live) ev.push({ text: `${plural(live, 'member site')} still answer${live === 1 ? 's' : ''}`, weight: 1.2, ratings: { active: 'CC', moved: 'N', dormant: 'I', ended: 'II' }, evidenceIds: [] });
  if (recentDark) ev.push({ text: `${plural(recentDark, 'site')} went dark in the last three weeks`, weight: 1, ratings: { active: 'N', moved: 'C', dormant: 'C', ended: 'C' }, evidenceIds: [] });
  if (reserve.length) ev.push({ text: `${plural(reserve.length, 'domain')} registered on the operation's infrastructure but not yet live`, weight: 1.1, ratings: { active: 'C', moved: 'CC', dormant: 'C', ended: 'I' }, evidenceIds: [] });
  if (f.status === 'due' || f.status === 'overdue') ev.push({ text: `By its own rhythm a new wave is ${f.status}`, weight: 0.6, ratings: { active: 'C', moved: 'C', dormant: 'N', ended: 'N' }, evidenceIds: [] });
  const returns = reapps.filter(r => r.status === 'CONFIRMED_ROTATION');
  if (returns.length) ev.push({ text: `${plural(returns.length, 'new site')} appeared with the operation's own settings`, weight: 1.6, ratings: { active: 'C', moved: 'CC', dormant: 'II', ended: 'II' }, evidenceIds: [] });
  if (!live && dark) ev.push({ text: 'No known site is live', weight: 1, ratings: { active: 'II', moved: 'C', dormant: 'C', ended: 'C' }, evidenceIds: [] });
  void status;
  return ach('activity', 'Is the operation still running?', [
    { key: 'active', label: 'Still running on the known sites' },
    { key: 'moved', label: 'Moving to new infrastructure' },
    { key: 'dormant', label: 'Paused, likely to return' },
    { key: 'ended', label: 'Wound down' },
  ], ev, {
    'moved|dormant': 'Run the standing hunts now (nameserver, naming pattern, per-deployment files) — a new site with the operation\'s own settings settles it.',
    'dormant|moved': 'Watch the reserve domains and the collection wallets: the first live reserve site or new deposit separates a pause from a move.',
    'active|moved': 'Re-check the live sites\' DNS and the reserve domains in a few days.',
    default: 'Keep the standing hunts and wallet watches running.',
  }, 'Absence of observations is weak evidence: sites can move somewhere Hunter has no view of.');
}

// ------------------------------------------------------------ contradictions
function detectContradictions(data: OpData, m: MembershipAnalysis, sites: SiteLife[], changes: FacetChange[], fin: FinancialAnalysisV1): ContradictionDraft[] {
  const out: ContradictionDraft[] = [];
  // 1. settings that appear on a site whose other settings belong to someone else
  for (const i of Object.values(m.indicators)) {
    if (!i.inconsistent.length || i.level === 'commodity') continue;
    const names = i.inconsistent.map(id => data.byId.get(id)?.value ?? id);
    out.push({ fingerprint: `planted:${i.entityId}`, kind: 'inconsistent_indicator', severity: 0.7, summary: `${short(i.value)} appears on ${listPhrase(names, 2)}, whose other settings point to a different operator — copied, planted, or a shared account.`, data: { indicator: i.value, sites: names, carriers: i.carriers.map(id => data.byId.get(id)?.value ?? id) } });
  }
  // 2. sources that disagree about the same fact at the same time
  const byKey = new Map<string, FacetChange[]>();
  for (const c of changes.filter(x => x.kind === 'contradiction')) (byKey.get(`${c.entityId}:${c.facet}`) ?? byKey.set(`${c.entityId}:${c.facet}`, []).get(`${c.entityId}:${c.facet}`)!).push(c);
  for (const [key, cs] of byKey) {
    const c = cs[0];
    const v = data.byId.get(c.entityId)?.value ?? c.entityId;
    out.push({ fingerprint: `sources:${key}`, kind: 'source_conflict', severity: 0.4, summary: `Sources disagree on the ${FACET_LABEL[c.facet] ?? c.facet} of ${v}: ${c.from ?? '—'} vs ${c.to ?? '—'} (${plural(cs.length, 'time')}).`, data: { entity: v, facet: c.facet, from: c.from, to: c.to, source: c.source } });
  }
  // 3. sites the model used to count and now does not
  for (const a of m.members) {
    if (a.type !== 'domain' || a.previous !== 'member' || ['member', 'probable'].includes(a.status) || a.analystVerdict) continue;
    out.push({ fingerprint: `reversal:${a.entityId}`, kind: 'membership_reversal', severity: 0.6, summary: `${a.value} was counted as part of the operation but no longer is (${a.status}, ${Math.round(a.probability * 100)}%): ${a.factors.find(f => f.weight < 0)?.text ?? 'the evidence that tied it in was weakened'}.`, data: { site: a.value, now: a.status, probability: a.probability } });
  }
  // 4. timeline: activity observed before the domain was (re-)registered → possibly a new owner
  for (const s of sites) {
    if (!s.registeredAt) continue;
    const evs = (data.evidenceByEntity.get(s.entityId) ?? []).filter(e => ['site_scan', 'page_fingerprint', 'ct_certificate'].includes(e.type));
    const early = evs.filter(e => Date.parse(e.timestamp) < Date.parse(s.registeredAt!) - 3 * DAY);
    if (early.length) out.push({ fingerprint: `timeline:${s.entityId}`, kind: 'timeline', severity: 0.5, summary: `${s.value} was observed ${early.length === 1 ? 'once' : `${early.length} times`} before its current registration date (${s.registeredAt.slice(0, 10)}) — the domain may have been dropped and re-registered, possibly by someone else.`, data: { site: s.value, registeredAt: s.registeredAt, earliest: early.map(e => e.timestamp).sort()[0] } });
  }
  // 5. a member site displays an address that belongs to an exchange or service
  for (const w of fin.wallets) {
    if (!['EXCHANGE', 'SERVICE', 'BRIDGE', 'MIXER'].includes(w.role)) continue;
    const e = data.entities.find(x => x.value.toLowerCase() === w.address.toLowerCase());
    if (!e) continue;
    const shownBy = (data.in.get(e.id) ?? []).filter(r => r.type === 'REFERENCES_WALLET').map(r => data.byId.get(r.sourceEntityId)).filter(x => x && m.byId[x.id]?.status === 'member');
    if (shownBy.length) out.push({ fingerprint: `svcwallet:${e.id}`, kind: 'service_wallet_displayed', severity: 0.5, summary: `Member site ${shownBy[0]!.value} displays ${short(w.address)}, which behaves like a ${w.role.toLowerCase()} address — payments may go to a deposit account rather than an operator wallet.`, data: { wallet: w.address, role: w.role } });
  }
  return out.sort((a, b) => b.severity - a.severity);
}

function listUnknowns(m: MembershipAnalysis, sites: SiteLife[], fin: FinancialAnalysisV1, f: Forecast, gaps: Gap[], pipeline: Array<{ role: string }>): string[] {
  const u: string[] = [];
  const probable = sites.filter(s => s.membership === 'probable');
  if (probable.length) u.push(`Whether ${listPhrase(probable.map(s => s.value), 2)} ${probable.length === 1 ? 'belongs' : 'belong'} to the operation (probable, not confirmed).`);
  if (!Object.values(m.indicators).some(i => i.level === 'operator')) u.push('No operator-level setting has been found — the sites could still be separate customers of one kit.');
  if (!fin.hasData) u.push('Where the money goes: no wallet activity traced yet.');
  else if (!pipeline.some(p => p.role === 'TREASURY') && !fin.exits.length) u.push('Where the money ends up: no treasury or cash-out found yet.');
  const unknownState = sites.filter(s => s.state === 'unknown');
  if (unknownState.length) u.push(`Whether ${plural(unknownState.length, 'member site')} ${unknownState.length === 1 ? 'is' : 'are'} still up (never checked).`);
  if (f.status === 'unknown') u.push('When the next wave will come — no rhythm established yet.');
  for (const g of gaps.slice(0, 2)) if (!u.some(x => x.includes(g.title))) u.push(g.title);
  return u.slice(0, 6);
}

// ------------------------------------------------------------ versions and diffs
export interface ModelSnapshot {
  status: string; members: string[]; probable: string[]; live: string[]; dark: string[]; reserve: string[];
  indicators: string[]; wallets: string[]; exits: string[]; forecast: string; leading: Record<string, string>; contradictions: string[];
}

export function snapshotOf(model: LivingModel, m: MembershipAnalysis): ModelSnapshot {
  return {
    status: model.status,
    members: model.sites.filter(s => s.membership === 'member').map(s => s.value).sort(),
    probable: model.sites.filter(s => s.membership === 'probable').map(s => s.value).sort(),
    live: model.sites.filter(s => s.state === 'live' || s.state === 'resurfaced').map(s => s.value).sort(),
    dark: model.sites.filter(s => s.state === 'dark' || s.state === 'suspended').map(s => s.value).sort(),
    reserve: [...model.forecast.reserve].sort(),
    indicators: Object.values(m.indicators).filter(i => i.level === 'operator' && i.carriers.some(c => m.byId[c]?.status === 'member')).map(i => i.value).sort(),
    wallets: model.money.pipeline.map(p => `${p.role}:${p.address.toLowerCase()}`).sort(),
    exits: model.money.exits.map(e => e.label || e.address).sort(),
    forecast: model.forecast.status,
    leading: Object.fromEntries(model.hypotheses.map(h => [h.key, h.leading])),
    contradictions: model.contradictions.map(c => c.fingerprint).sort(),
  };
}

export interface ModelDiff { changes: Array<{ kind: string; text: string; significance: number }>; significance: number }

export function diffSnapshots(prev: ModelSnapshot | null, next: ModelSnapshot): ModelDiff {
  const changes: ModelDiff['changes'] = [];
  if (!prev) return { changes: [{ kind: 'initial', text: `First model: ${plural(next.members.length, 'member site')}, ${plural(next.indicators.length, 'operator setting')}, ${plural(next.wallets.length, 'operation wallet')}.`, significance: 1 }], significance: 1 };
  const setDiff = (a: string[], b: string[]) => ({ added: b.filter(x => !a.includes(x)), removed: a.filter(x => !b.includes(x)) });
  const add = (kind: string, text: string, significance: number) => changes.push({ kind, text, significance });
  const mem = setDiff(prev.members, next.members);
  if (mem.added.length) add('members_added', `${plural(mem.added.length, 'site')} now counted as part of the operation: ${listPhrase(mem.added, 4)}`, 0.9);
  if (mem.removed.length) add('members_removed', `${plural(mem.removed.length, 'site')} no longer counted: ${listPhrase(mem.removed, 4)}`, 0.8);
  const pr = setDiff(prev.probable, next.probable).added.filter(x => !next.members.includes(x));
  if (pr.length) add('probable_added', `${plural(pr.length, 'new probable site')}: ${listPhrase(pr, 3)}`, 0.5);
  const dk = setDiff(prev.dark, next.dark);
  if (dk.added.length) add('went_dark', `${plural(dk.added.length, 'site')} went dark: ${listPhrase(dk.added, 3)}`, 0.7);
  const lv = setDiff(prev.live, next.live).added.filter(x => prev.members.includes(x) && prev.dark.includes(x));
  if (lv.length) add('resurfaced', `${plural(lv.length, 'site')} came back: ${listPhrase(lv, 3)}`, 0.8);
  const rs = setDiff(prev.reserve, next.reserve);
  if (rs.added.length) add('reserve_added', `${plural(rs.added.length, 'reserve domain')} found: ${listPhrase(rs.added, 3)}`, 0.6);
  const ind = setDiff(prev.indicators, next.indicators);
  if (ind.added.length) add('indicators_added', `New operator setting${ind.added.length === 1 ? '' : 's'}: ${listPhrase(ind.added.map(short), 3)}`, 0.7);
  const wl = setDiff(prev.wallets, next.wallets);
  if (wl.added.length) add('wallets_added', `${plural(wl.added.length, 'operation wallet')} added to the money pipeline`, 0.6);
  const ex = setDiff(prev.exits, next.exits);
  if (ex.added.length) add('exits_added', `Money now traced to ${listPhrase(ex.added, 3)}`, 0.7);
  if (prev.status !== next.status) add('status', `Operation status changed: ${prev.status} → ${next.status}`, 0.8);
  if (prev.forecast !== next.forecast && ['due', 'overdue'].includes(next.forecast)) add('forecast', `A new wave is now ${next.forecast} by the operation's rhythm`, 0.5);
  for (const [k, v] of Object.entries(next.leading)) if (prev.leading[k] && prev.leading[k] !== v) add('hypothesis', `Leading explanation changed: "${prev.leading[k]}" → "${v}"`, 0.8);
  const ct = setDiff(prev.contradictions, next.contradictions);
  if (ct.added.length) add('contradictions', `${plural(ct.added.length, 'new contradiction')} to review`, 0.5);
  const significance = round(Math.min(1, changes.reduce((s, c) => s + c.significance, 0) / 2), 2);
  return { changes, significance };
}

/** Persist the model as a new version when it changed materially; returns the diff (or null when unchanged). */
export function recordModelVersion(intel: IntelStore, operationId: string, model: LivingModel, m: MembershipAnalysis, trigger: string): { version: number; diff: ModelDiff } | null {
  const snapshot = snapshotOf(model, m);
  const prevV = intel.latestModel(operationId);
  const prev = (prevV?.snapshot as ModelSnapshot | null) ?? null;
  if (prev && JSON.stringify(prev) === JSON.stringify(snapshot)) return null;
  const diff = diffSnapshots(prev, snapshot);
  if (prev && !diff.changes.length) return null;
  const summary = diff.changes.slice(0, 3).map(c => c.text).join(' · ');
  const v = intel.addModelVersion({ operationId, trigger, summary, snapshot, diff });
  return { version: v.version, diff };
}

/** Persist contradictions (idempotent by fingerprint); retire ones that are no longer observed. */
export function syncContradictions(intel: IntelStore, operationId: string, drafts: ContradictionDraft[]): { created: Contradiction[]; open: Contradiction[] } {
  const created: Contradiction[] = [];
  for (const d of drafts) {
    const r = intel.upsertContradiction({ operationId, fingerprint: d.fingerprint, kind: d.kind, severity: d.severity, summary: d.summary, data: d.data });
    if (r.created) created.push(r.contradiction);
  }
  intel.retireContradictionsExcept(operationId, drafts.map(d => d.fingerprint));
  return { created, open: intel.contradictions(operationId).filter(c => c.status === 'open') };
}
