import type { HunterApp } from '../app.js';
import { nowIso } from '../core/util.js';

/**
 * Global resource governor for long-running, many-operation use. A daily
 * lookup allowance (Settings → daily budget) is shared across operations in
 * proportion to how much they currently deserve it: recent progress, analyst
 * attention, links to Main Platform work and open reappearance alerts. Demo
 * operations get a small share. Monitoring and hunts use a separate reserve so
 * watching never starves (and is never starved by) active pursuits.
 */
export class ResourceGovernor {
  constructor(private app: HunterApp) {}

  dailyAllowance(): number {
    const v = Number((this.app.store.allSettings() as Record<string, any>).dailyLookups ?? process.env.HUNTER_DAILY_LOOKUPS ?? 4000);
    return Number.isFinite(v) && v > 0 ? v : 4000;
  }

  weights(): Map<string, number> {
    const out = new Map<string, number>();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    for (const op of this.app.store.getOperations()) {
      if (op.status === 'CONCLUDED') continue;
      let w = op.isDemo ? 0.3 : 1;
      const run = this.app.store.latestRun(op.id);
      if (run?.status === 'RUNNING') w += 0.5;
      const recent = (run?.stats.recentYield ?? []).slice(-10);
      w += Math.min(2, recent.reduce((s, x) => s + x, 0) / 20);
      if (op.lastViewedAt && op.lastViewedAt > dayAgo) w += 0.7;
      if (op.mainInvestigationId) w += 0.5;
      out.set(op.id, w);
    }
    return out;
  }

  /** Share of today's allowance this operation may use (in cost units). */
  share(operationId: string): number {
    const w = this.weights();
    const total = [...w.values()].reduce((s, x) => s + x, 0) || 1;
    const allowance = this.dailyAllowance() * 0.85; // 15% reserved for monitors and hunts
    return Math.max(40, allowance * ((w.get(operationId) ?? 1) / total));
  }

  allow(operationId: string): boolean {
    const spent = this.app.intel.spentToday(nowIso().slice(0, 10));
    const total = [...spent.values()].reduce((s, x) => s + x, 0);
    if (total >= this.dailyAllowance()) return false;
    return (spent.get(operationId) ?? 0) < this.share(operationId);
  }

  status() {
    const spent = this.app.intel.spentToday(nowIso().slice(0, 10));
    const ops = this.app.store.getOperations().map(o => ({ operationId: o.id, code: o.code, spent: Math.round((spent.get(o.id) ?? 0) * 10) / 10, share: Math.round(this.share(o.id)) }));
    return { day: nowIso().slice(0, 10), allowance: this.dailyAllowance(), spent: Math.round([...spent.values()].reduce((s, x) => s + x, 0) * 10) / 10, operations: ops };
  }
}
