import type { HunterApp } from '../app.js';
import type { MonitoringProbe, Entity } from '../types.js';
import { PIVOTS } from '../collectors/pivots.js';
import { HunterError, newId, nowIso, sha256, stableStringify } from '../core/util.js';
import { isCommodity } from './noise.js';

const DEFAULT_FREQ: Record<string, number> = { DNS_RESOLVE: 24 * 60, REVERSE_NS: 24 * 60, WALLET_TRACE: 6 * 60, CT_SEARCH: 24 * 60, SITE_PROFILE: 3 * 24 * 60, REVERSE_IP: 3 * 24 * 60 };

/**
 * Long-running watch over an operation. Monitors re-run a pivot on a
 * schedule (bypassing the response cache), compare the result with the last
 * run, ingest anything new, and automatically profile and fingerprint-match
 * newly appeared domains so a redeployment surfaces as a reappearance alert.
 */
export class MonitorEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private app: HunterApp) {}

  startScheduler(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runDue(); }, intervalMs);
    this.timer.unref?.();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(input: { operationId: string; targetType: string; targetValue: string; pivotType?: string; frequencyMinutes?: number; notes?: string; status?: MonitoringProbe['status'] }): MonitoringProbe {
    const op = this.app.store.getOperation(input.operationId);
    if (!op) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
    const entity = this.app.store.findEntity(op.id, input.targetType, input.targetValue) ?? this.app.store.getEntities(op.id).find(e => e.value.toLowerCase() === input.targetValue.toLowerCase());
    const pivotType = input.pivotType ?? defaultPivot(input.targetType);
    const existing = this.app.store.findMonitor(op.id, input.targetValue, pivotType);
    if (existing) return existing;
    const probe: MonitoringProbe = {
      id: newId('probe', 8), operationId: op.id, targetType: input.targetType, targetValue: input.targetValue, frequencyMinutes: input.frequencyMinutes ?? DEFAULT_FREQ[pivotType] ?? 1440,
      lastCheckedAt: nowIso(), status: input.status ?? 'ACTIVE', matchesFound: 0, notes: input.notes ?? `${PIVOTS[pivotType]?.label ?? pivotType} every ${Math.round((input.frequencyMinutes ?? DEFAULT_FREQ[pivotType] ?? 1440) / 60)}h`,
      pivotType, entityId: entity?.id, nextRunAt: nowIso(), runs: 0,
    };
    this.app.store.saveMonitor(probe);
    this.app.store.logAudit(op.id, 'MONITOR_CREATE', `Monitoring ${input.targetValue} (${pivotType})`);
    return probe;
  }

  update(id: string, patch: Partial<Pick<MonitoringProbe, 'status' | 'frequencyMinutes' | 'notes'>>) {
    const m = this.app.store.getMonitors().find(x => x.id === id);
    if (!m) throw new HunterError('NOT_FOUND', 'Monitor not found', 404);
    const next = { ...m, ...patch };
    this.app.store.saveMonitor(next);
    return next;
  }

  /** After a pursuit: watch the parts of the operation most likely to change. */
  ensureDefaultMonitors(operationId: string) {
    const analysis = this.app.analyzer.peek(operationId);
    const entities = this.app.store.getEntities(operationId);
    const byValue = (v: string) => entities.find(e => e.value === v);
    const wanted: Array<{ e: Entity; pivot: string; note: string }> = [];
    for (const e of entities.filter(x => x.type === 'nameserver' && !isCommodity(x.ubiquity))) wanted.push({ e, pivot: 'REVERSE_NS', note: 'Watch for new domains on the operation’s private nameserver' });
    if (analysis) {
      for (const d of analysis.infrastructure.domains.filter(x => x.role === 'core' && (x.status === 'standby' || x.isSeed)).slice(0, 8)) { const e = byValue(d.value); if (e) wanted.push({ e, pivot: 'DNS_RESOLVE', note: d.status === 'standby' ? 'Reserve domain — alert when it goes live' : 'Seed domain status' }); }
      for (const w of analysis.financial.wallets.filter(x => ['TREASURY', 'COLLECTION', 'SPLITTER'].includes(x.role)).slice(0, 6)) { const e = entities.find(x => x.value.toLowerCase() === w.address); if (e) wanted.push({ e, pivot: 'WALLET_TRACE', note: `New ${w.role.toLowerCase()} activity` }); }
    }
    for (const w of wanted.slice(0, 20)) {
      if (this.app.store.findMonitor(operationId, w.e.value, w.pivot)) continue;
      this.create({ operationId, targetType: w.e.type, targetValue: w.e.value, pivotType: w.pivot, notes: w.note });
    }
  }

  async runDue(limit = 5) {
    if (this.running) return [];
    this.running = true;
    try {
      const due = this.app.store.dueMonitors(nowIso(), limit);
      const out = [];
      for (const m of due) out.push(await this.runOne(m));
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Run all active monitors of an operation now (legacy "run monitoring scan"). */
  async runOperation(operationId: string) {
    const results = [];
    for (const m of this.app.store.getMonitors(operationId).filter(x => x.status !== 'PAUSED')) results.push(await this.runOne(m));
    return results;
  }

  async runOne(m: MonitoringProbe) {
    const { store } = this.app;
    const op = store.getOperation(m.operationId);
    const entity = (m.entityId && store.getEntity(m.entityId)) || (op && (store.findEntity(op.id, m.targetType, m.targetValue) ?? store.getEntities(op.id).find(e => e.value.toLowerCase() === m.targetValue.toLowerCase())));
    const next: MonitoringProbe = { ...m, lastCheckedAt: nowIso(), nextRunAt: new Date(Date.now() + m.frequencyMinutes * 60000).toISOString(), runs: (m.runs ?? 0) + 1 };
    if (!op || !entity) {
      store.saveMonitor({ ...next, status: 'PAUSED', lastChange: 'Target no longer exists in the operation' });
      return { monitor: next, changed: false, newEntities: [] as string[], reappearances: [] as any[] };
    }
    const before = new Set(store.getEntities(op.id).map(e => e.id));
    let changed = false;
    let summary = 'No change';
    const reappearances: any[] = [];
    try {
      const rec = await this.app.pursuit.executePivot(op.id, m.pivotType ?? defaultPivot(m.targetType), entity.id, { bypassCache: true, runId: null });
      const fresh = store.getEntities(op.id).filter(e => !before.has(e.id));
      const digest = sha256(stableStringify({ discovered: (rec.result?.discovered ?? []).map(d => d.value).sort(), newEvidence: rec.result?.newEvidence ?? 0 }));
      changed = fresh.length > 0 || (Boolean(m.lastHash) && digest !== m.lastHash && (rec.result?.newEvidence ?? 0) > 0);
      next.lastHash = digest;
      if (fresh.length) {
        summary = `New: ${fresh.map(e => e.value).slice(0, 5).join(', ')}`;
        next.matchesFound = (m.matchesFound ?? 0) + fresh.length;
        next.status = 'ALERTING';
        store.addChange(op.id, 'monitor_alert', `Monitor on ${m.targetValue} found ${fresh.length} new item(s): ${fresh.map(e => e.value).slice(0, 5).join(', ')}`, { monitorId: m.id });
        // Profile new domains immediately and test them against the operation fingerprint.
        for (const d of fresh.filter(e => e.type === 'domain').slice(0, 5)) {
          for (const pivot of ['DNS_RESOLVE', 'CT_SEARCH', 'SITE_PROFILE', 'RDAP_DOMAIN']) {
            try { await this.app.pursuit.executePivot(op.id, pivot, d.id, { bypassCache: true, runId: null }); } catch { /* best effort */ }
          }
          this.app.analyzer.analyze(op.id);
          reappearances.push(this.app.reappearance.check(op.id, d.value, 'domain', {}, `monitor ${m.pivotType} on ${m.targetValue}`));
        }
      } else if (changed) {
        summary = `Changed: ${rec.result?.simpleExplanation ?? 'new evidence'}`;
        store.addChange(op.id, 'monitor_change', `Monitor on ${m.targetValue}: ${rec.result?.simpleExplanation ?? 'result changed'}`, { monitorId: m.id });
      } else if (next.status === 'ALERTING') next.status = 'ACTIVE';
    } catch (err) {
      summary = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    next.lastChange = summary;
    store.saveMonitor(next);
    if (changed) { store.touch(op.id, 'monitor'); this.app.integration?.queueSync(op.id); }
    return { monitor: next, changed, newEntities: store.getEntities(op.id).filter(e => !before.has(e.id)).map(e => e.value), reappearances };
  }
}

function defaultPivot(targetType: string) {
  switch (targetType) {
    case 'nameserver': return 'REVERSE_NS';
    case 'wallet': case 'contract': return 'WALLET_TRACE';
    case 'ip': return 'REVERSE_IP';
    case 'template': case 'artifact': return 'SHARED_RESOURCE';
    case 'identifier': return 'TRACKER_REUSE';
    default: return 'DNS_RESOLVE';
  }
}
