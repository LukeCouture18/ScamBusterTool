/**
 * v7: pure valuation of the v5 Investigation Director's proposed actions (no database access).
 * Used by director-bridge.ts (which persists the decision) and by the offline decision benchmark.
 */
import { TESTS, type TestFamily, type GapFamily } from './ontology';
import { deriveGaps, fnv, type Snapshot, type Candidate, type Gap, type HistoryFact } from './derive';
import { valueCandidate, type Valued } from './value';
type Row = Record<string, unknown>;

export type V5Action = { kind: string; target: string; gap: string; reason: string; value: number; cost: number; fingerprint: string };
export const FAMILY: Record<string, TestFamily> = { provider_retry: 'BLOCKCHAIN_REFRESH', investigate_site: 'PUBLIC_SITE_INSPECTION', correlate_wallet: 'CORRELATION_REVIEW', reconstruct_operation: 'HUNTER_HYPOTHESIS_TEST', find_related: 'RELATED_SITE_HUNT' };
const GAP_OF: Record<string, GapFamily[]> = { provider_retry: ['BLOCKCHAIN_ACTIVITY', 'REPORT_EVIDENCE'], investigate_site: ['SITE_IDENTITY', 'PAYMENT_INTERFACE'], correlate_wallet: ['WALLET_REUSE'], reconstruct_operation: ['OPERATION_MEMBERSHIP', 'HYPOTHESIS_DISCRIMINATION'], find_related: ['RELATED_SITE'] };

export type DirectorContext = { inv: string; site: Row | null; cands: Row[]; investigated: boolean; reportReady: boolean; priorActions: Row[]; providerHealth: Row[] };

function subjectOf(a: V5Action, ctx: DirectorContext) {
  if (a.kind === 'provider_retry') { const c = ctx.cands.find(c => c.id === a.target); return c ? `wallet:${c.identity}` : `wallet:${a.target}`; }
  if (a.kind === 'correlate_wallet') return `wallet:${a.target}`;
  if (a.kind === 'investigate_site') return `site:${a.target}`;
  if (a.kind === 'reconstruct_operation') return `hunter:${ctx.inv}`;
  return `scope:${ctx.inv}`;
}

/** Pure: values the v5 Director's proposed actions with the v7 model. No database access. */
export function rankDirectorActions<T extends V5Action>(ctx: DirectorContext, actions: T[], learning: Snapshot['learning']) {
  const site = ctx.site;
  const deposit = ctx.cands.filter(c => c.best_context === 'deposit');
  const history: HistoryFact[] = ctx.priorActions.filter(a => FAMILY[String(a.kind)]).map(a => ({ family: FAMILY[String(a.kind)], subject: subjectOf({ kind: String(a.kind), target: String(a.target), gap: '', reason: '', value: 0, cost: 0, fingerprint: String(a.fingerprint) }, ctx),
    inputs_hash: fnv(String(a.fingerprint)), status: ['planned', 'running'].includes(String(a.status)) ? 'running' : 'finished', useful: a.useful == null ? null : Number(a.useful) > 0, dead: Number(a.useful ?? 0) === 0, duplicate: false }));
  const s: Snapshot = {
    scope: { kind: 'investigation', id: ctx.inv, label: String(site?.canonical_key ?? ctx.inv), seed: site ? String(site.canonical_key) : null, investigation_id: ctx.inv }, now: new Date().toISOString(),
    sites: site ? [{ key: String(site.canonical_key), entity_id: String(site.id), investigation_id: ctx.inv, association: 'seed', inspected: ctx.investigated, payment_seen: ctx.cands.length > 0, deposit_seen: deposit.length > 0, wallet_page_rechecked: true, status: 'unknown', strong_units: 0, weak_units: 0, timing_known: true,
      report: { exists: true, ready: ctx.reportReady, destination: true, blockers: [] } }] : [],
    wallets: ctx.cands.map(c => { const h = ctx.providerHealth.find(p => p.network === c.validated_network); return { id: String(c.id), identity: String(c.identity), address: String(c.address), network: c.validated_network ? String(c.validated_network) : null, context: String(c.best_context), validation: String(c.validation_status), analysis: String(c.analysis_status),
      investigation_id: ctx.inv, site_key: site ? String(site.canonical_key) : null, validated_sites: Number(c.validated_sites ?? 1), provider: h?.state === 'unavailable' ? 'unavailable' as const : 'healthy' as const, provider_ready: true, owned_by_director: false, reuse_reviewed: false, reuse_searched: true }; }),
    artifacts: [], questions: [], contradictions: [], units: {}, waves: { count: 0, newest_unhunted: false }, hunter: { present: true, evidence_since_last_analysis: 1 },
    history, learning, budget: { remaining: 1, max: 1 },
  };
  const gaps = deriveGaps(s), byFamily = new Map<string, Gap>();
  for (const g of gaps) if (!byFamily.has(`${g.family}:${g.subject}`)) byFamily.set(`${g.family}:${g.subject}`, g);
  const valued: Array<{ action: T; v: Valued | null }> = [];
  const extraGaps: Gap[] = [];
  for (const a of actions) {
    const family = FAMILY[a.kind]; if (!family) { valued.push({ action: a, v: null }); continue; }
    const subject = subjectOf(a, ctx), keys: string[] = [];
    for (const gf of GAP_OF[a.kind] ?? []) {
      const exact = byFamily.get(`${gf}:${subject}`) ?? gaps.find(g => g.family === gf);
      if (exact) { if (exact.status !== 'open') exact.status = 'open'; keys.push(exact.key); }
    }
    if (!keys.length) {
      // The v5 Director proposed it, so its prerequisite gap exists even if this snapshot is coarse.
      const gf = (GAP_OF[a.kind] ?? ['RELATED_SITE'])[0], g: Gap = { key: `${gf}:${subject}`, family: gf, subject, current: a.reason, missing: a.reason, matters: a.reason, supporting: [], contradicting: [], uncertainty: .6, tests: [family], dependencies: [], status: 'open', exhaustion: '', revisit: [], report_blocking: a.kind === 'provider_retry' ? 1 : 0, time_sensitivity: .1, coverage: 1, discrimination: null };
      extraGaps.push(g); keys.push(g.key);
    }
    const c: Candidate = { key: `${family}:${subject}:${fnv(a.fingerprint)}`, family, subject, gaps: keys, objective: { kind: TESTS[family].specialist === 'site_finder' ? 'finder' : TESTS[family].specialist === 'operation_hunter' ? 'hunter' : TESTS[family].specialist === 'main_local' ? 'local' : TESTS[family].specialist === 'wallet_investigator' ? 'wallet' : 'site', text: a.reason }, inputs_hash: fnv(a.fingerprint), prerequisites_met: true, bounds: TESTS[family].bounds };
    try { valued.push({ action: a, v: valueCandidate(c, s, new Map([...gaps, ...extraGaps].map(g => [g.key, g] as const))) }); } catch { valued.push({ action: a, v: null }); }
  }
  const v5Rank = new Map(actions.map((a, i) => [a.fingerprint, i] as const));
  valued.sort((x, y) => (y.v?.utility ?? -1) - (x.v?.utility ?? -1) || (v5Rank.get(x.action.fingerprint)! - v5Rank.get(y.action.fingerprint)!));
  return { valued, snapshot: s, gaps: [...gaps, ...extraGaps] };
}

