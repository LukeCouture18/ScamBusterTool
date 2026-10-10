import type { HunterApp } from '../app.js';
import type { Entity, ReappearanceLead } from '../types.js';
import type { Hunt } from '../core/intelStore.js';
import { PIVOTS } from '../collectors/pivots.js';
import { newId, nowIso, plural, stableId } from '../core/util.js';
import { isCommodity } from '../engine/noise.js';

/**
 * Standing reappearance hunts.
 *
 * Operations rarely stop when their sites are taken down; they move. For each
 * operation Hunter keeps a small set of standing searches derived from what
 * makes it recognisable — its private nameservers, its naming template, its
 * per-deployment files and page titles, and its wallets — and re-runs them on
 * an adaptive schedule (sooner when the operation's own history says a new
 * wave is due). Anything new is verified with a few cheap passive lookups and
 * then judged by the same membership inference used everywhere else, so a
 * "likely return" needs operator-level evidence, not just a similar name or
 * the same kit.
 */
const BASE_CADENCE: Record<string, number> = { REVERSE_NS: 12 * 60, CT_PATTERN_SEARCH: 24 * 60, SHARED_RESOURCE: 24 * 60, TITLE_SEARCH: 48 * 60, WALLET_TRACE: 6 * 60, REVERSE_IP: 24 * 60 };
const VERIFY = ['DNS_RESOLVE', 'SITE_PROFILE', 'RDAP_DOMAIN', 'CT_SEARCH'];

export interface HuntRunResult { hunt: Hunt; newDomains: string[]; verified: string[]; returns: ReappearanceLead[]; error?: string }

export class HuntEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private app: HunterApp) {}

  startScheduler(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runDue(); }, intervalMs);
    this.timer.unref?.();
  }
  stopScheduler() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Derive (or refresh) the standing hunts of an operation from its current reconstruction. */
  ensureHunts(operationId: string): Hunt[] {
    const op = this.app.store.getOperation(operationId);
    const a = this.app.analyzer.peek(operationId);
    if (!op || !a?.membership) return this.app.intel.getHunts(operationId);
    const byId = new Map(this.app.store.getEntities(operationId).map(e => [e.id, e]));
    const cadenceScale = this.cadenceScale(operationId);
    const want: Array<{ kind: string; entity: Entity; why: string }> = [];
    for (const [id, info] of Object.entries(a.membership.indicators)) {
      const e = byId.get(id);
      if (!e || isCommodity(e.ubiquity)) continue;
      const memberCarriers = info.carriers.filter(c => a.membership.byId[c]?.status === 'member').length;
      if (!memberCarriers) continue;
      if (e.type === 'nameserver' && info.level === 'infrastructure' && info.population <= 80) want.push({ kind: 'REVERSE_NS', entity: e, why: `New domains delegated to the operation's nameserver ${e.value}` });
      if (e.type === 'artifact' && info.level === 'operator') want.push({ kind: 'SHARED_RESOURCE', entity: e, why: `Sites loading the operation's per-deployment file ${e.label || e.value}` });
      if (e.type === 'ip' && info.level === 'infrastructure' && info.population <= 6 && memberCarriers >= 2) want.push({ kind: 'REVERSE_IP', entity: e, why: `New sites on the operation's dedicated server ${e.value}` });
    }
    for (const e of byId.values()) {
      if (e.type === 'pattern' && String(e.value).startsWith('name:')) want.push({ kind: 'CT_PATTERN_SEARCH', entity: e, why: `Newly certified names that fit the naming template (${String(e.value).slice(5).replace('+', ' + ')})` });
      if (e.type === 'pattern' && String(e.value).startsWith('title:')) want.push({ kind: 'TITLE_SEARCH', entity: e, why: `Archived pages with the operation's page title` });
    }
    for (const w of a.financial.wallets) {
      if (!['COLLECTION', 'TREASURY', 'SPLITTER'].includes(w.role)) continue;
      const e = [...byId.values()].find(x => x.value.toLowerCase() === w.address.toLowerCase());
      if (e && a.membership.byId[e.id]?.status === 'member') want.push({ kind: 'WALLET_TRACE', entity: e, why: `New money movements of the operation's ${w.role.toLowerCase()} wallet` });
    }
    const out: Hunt[] = [];
    for (const wnt of want.slice(0, 24)) {
      const base = BASE_CADENCE[wnt.kind] ?? 24 * 60;
      const existing = this.app.intel.getHunts(operationId).find(h => h.kind === wnt.kind && h.query === wnt.entity.id);
      const cadence = Math.max(60, Math.round(base * cadenceScale));
      out.push(this.app.intel.upsertHunt({
        id: existing?.id ?? stableId('hunt', operationId, wnt.kind, wnt.entity.id), operationId, kind: wnt.kind, query: wnt.entity.id,
        status: existing?.status ?? 'active', cadenceMinutes: cadence,
        nextRunAt: existing?.nextRunAt ?? new Date(Date.now() + cadence * 60000).toISOString(),
        data: { ...(existing?.data ?? {}), target: wnt.entity.value, label: PIVOTS[wnt.kind]?.label ?? wnt.kind, why: wnt.why, cadenceScale },
      }));
    }
    return out;
  }

  /**
   * Operations with a history of regular rotations are watched more closely when the next one is due;
   * long-dormant operations less often.
   */
  cadenceScale(operationId: string): number {
    const a = this.app.analyzer.peek(operationId);
    const model = a?.model;
    if (!model) return 1;
    if (model.status === 'rotating') return 0.3;
    if (model.forecast.status === 'due' || model.forecast.status === 'overdue') return 0.35;
    if (model.forecast.status === 'soon') return 0.6;
    if (model.status === 'dormant') return 2;
    return 1;
  }

  async runDue(now = nowIso()): Promise<HuntRunResult[]> {
    if (this.running) return [];
    this.running = true;
    const results: HuntRunResult[] = [];
    try {
      for (const hunt of this.app.intel.dueHunts(now)) {
        const op = this.app.store.getOperation(hunt.operationId);
        if (!op || op.isDemo) continue;
        results.push(await this.runOne(hunt));
      }
    } finally {
      this.running = false;
    }
    return results;
  }

  async runOperation(operationId: string, opts: { force?: boolean } = {}): Promise<HuntRunResult[]> {
    const hunts = this.ensureHunts(operationId).filter(h => h.status === 'active' && (opts.force || Date.parse(h.nextRunAt) <= Date.now()));
    const results: HuntRunResult[] = [];
    for (const h of hunts) results.push(await this.runOne(h));
    return results;
  }

  async runOne(hunt: Hunt): Promise<HuntRunResult> {
    const { store, intel } = this.app;
    const op = store.getOperation(hunt.operationId)!;
    const target = store.getEntity(hunt.query);
    const next = (patch: Partial<Hunt>) => intel.upsertHunt({ ...hunt, lastRunAt: nowIso(), runs: hunt.runs + 1, nextRunAt: new Date(Date.now() + hunt.cadenceMinutes * 60000).toISOString(), ...patch });
    if (!target) { const h = next({ status: 'retired' }); return { hunt: h, newDomains: [], verified: [], returns: [], error: 'Target no longer exists' }; }
    const before = new Set(store.getEntities(op.id).filter(e => e.type === 'domain').map(e => e.id));
    let error: string | undefined;
    try {
      await this.app.pursuit.executePivot(op.id, hunt.kind, target.id, { bypassCache: true, runId: null });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const fresh = store.getEntities(op.id).filter(e => e.type === 'domain' && !before.has(e.id) && e.metadata?.role !== 'script/resource host');
    // Verify each newcomer with a few passive lookups (bounded), then let membership inference decide.
    const verified: string[] = [];
    for (const d of fresh.slice(0, 6)) {
      for (const pv of VERIFY) {
        if (!this.app.collectors.pivotsFor(d).some(s => s.pivotType === pv)) continue;
        try { await this.app.pursuit.executePivot(op.id, pv, d.id, { runId: null }); } catch { /* unavailable source */ }
      }
      verified.push(d.value);
    }
    const analysis = this.app.analyzer.analyze(op.id);
    const returns: ReappearanceLead[] = [];
    for (const d of fresh) {
      const m = analysis?.membership.byId[d.id];
      if (!m) continue;
      const operatorLevel = m.factors.some(f => f.family === 'operator' && f.weight >= 2);
      const kitOnly = !operatorLevel && m.factors.some(f => f.family === 'kit');
      let status: ReappearanceLead['status'] | null = null;
      if (m.status === 'member' && operatorLevel) status = 'CONFIRMED_ROTATION';
      else if (m.status === 'member' || m.status === 'probable') status = 'OPEN';
      else if (m.status === 'excluded' && kitOnly) status = 'NEW_CLUSTER';
      if (!status) continue;
      const lead: ReappearanceLead = {
        id: store.findReappearance(op.id, d.value)?.id ?? newId('reapp', 10), operationId: op.id, candidateValue: d.value, candidateType: 'domain', matchedFingerprintIds: [],
        overallSimilarityScore: Math.round(m.probability * 100),
        matchBreakdown: m.factors.slice(0, 6).map(f => ({ fingerprintType: f.family, expected: f.key, observed: f.text, similarity: Math.max(0, Math.min(1, f.weight / 3.4)) })),
        reasoning: status === 'CONFIRMED_ROTATION' ? `New site ${d.value} carries the operation's own settings: ${m.factors.filter(f => f.family === 'operator').slice(0, 2).map(f => f.text).join('; ')}.`
          : status === 'NEW_CLUSTER' ? `New site ${d.value} runs the same kit but with someone else's settings — likely another customer of the kit vendor.`
            : `New site ${d.value} is probably part of the operation (${Math.round(m.probability * 100)}%): ${m.factors.slice(0, 2).map(f => f.text).join('; ')}.`,
        detectedAt: nowIso(), status, source: `hunt:${hunt.kind}`,
      };
      store.saveReappearance(lead);
      returns.push(lead);
      if (status === 'CONFIRMED_ROTATION') store.addChange(op.id, 'monitor_alert', `Likely return: ${d.value} appeared with the operation's own settings (found by the ${hunt.data.label ?? hunt.kind} hunt)`, { leadId: lead.id, huntId: hunt.id });
    }
    const h = next({ hits: hunt.hits + fresh.length, data: { ...hunt.data, lastNew: fresh.map(f => f.value).slice(0, 20), lastError: error ?? null, lastReturns: returns.map(r => r.candidateValue) } });
    if (fresh.length) store.addChange(op.id, 'hunt', `${hunt.data.label ?? hunt.kind} hunt found ${plural(fresh.length, 'new domain')}: ${fresh.slice(0, 4).map(f => f.value).join(', ')}${returns.length ? ` — ${returns.length} assessed as related` : ''}`, { huntId: hunt.id });
    if (returns.length) { this.app.integration?.queueSync(op.id); store.touch(op.id, 'hunt'); }
    return { hunt: h, newDomains: fresh.map(f => f.value), verified, returns, error };
  }
}
