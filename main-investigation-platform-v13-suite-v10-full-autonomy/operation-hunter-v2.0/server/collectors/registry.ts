import type { Entity, OperationProfile } from '../types.js';
import type { PivotSpec } from '../core/model.js';
import type { Collector, MainBridge, RuntimeSettings } from './base.js';
import { PIVOTS } from './pivots.js';
import { walletFamily } from '../core/canonical.js';
import { DnsCollector } from './dnsCollector.js';
import { CtCollector } from './ctCollector.js';
import { RdapCollector, RipeStatCollector, HackerTargetCollector } from './registryCollectors.js';
import { UrlscanCollector } from './urlscanCollector.js';
import { BlockscoutCollector, TronGridCollector, MempoolCollector } from './chainCollectors.js';
import { InternalCollector, MainPlatformCollector } from './internalCollectors.js';
import { SyntheticCollector } from './syntheticCollector.js';

const REAL_ORDER: Record<string, string[]> = {
  DNS_RESOLVE: ['dns'],
  CT_SEARCH: ['crtsh'],
  CT_PATTERN_SEARCH: ['crtsh'],
  TITLE_SEARCH: ['urlscan'],
  RDAP_DOMAIN: ['rdap'],
  IP_PROFILE: ['ripestat'],
  REVERSE_IP: ['hackertarget', 'urlscan'],
  REVERSE_NS: ['hackertarget'],
  SITE_PROFILE: ['urlscan'],
  SHARED_RESOURCE: ['urlscan'],
  TRACKER_REUSE: ['internal'],
  WALLET_TRACE: ['blockscout', 'trongrid', 'mempool'],
  WALLET_PROFILE: ['blockscout'],
  EVIDENCE_MINING: ['internal'],
  MAIN_LOOKUP: ['main'],
  SITE_CHECK_REQUEST: ['main'],
};

export interface PivotOption { spec: PivotSpec; collector: Collector }

export class CollectorRegistry {
  readonly collectors: Collector[];
  readonly synthetic: SyntheticCollector;
  private byId: Map<string, Collector>;

  constructor(extra: Collector[] = []) {
    this.synthetic = new SyntheticCollector();
    this.collectors = [
      new DnsCollector(), new CtCollector(), new RdapCollector(), new RipeStatCollector(), new HackerTargetCollector(), new UrlscanCollector(),
      new BlockscoutCollector(), new TronGridCollector(), new MempoolCollector(), new InternalCollector(), new MainPlatformCollector(), this.synthetic,
      ...extra,
    ];
    this.byId = new Map(this.collectors.map(c => [c.id, c]));
  }

  get(id: string) { return this.byId.get(id); }

  /** Replace a collector (tests inject fakes). */
  override(collector: Collector) {
    const idx = this.collectors.findIndex(c => c.id === collector.id);
    if (idx >= 0) this.collectors[idx] = collector; else this.collectors.push(collector);
    this.byId.set(collector.id, collector);
  }

  /** The collector that will execute a pivot for an entity in an operation, or why none can. */
  resolve(pivotType: string, entity: Entity, op: OperationProfile, settings: RuntimeSettings, main: MainBridge | null): { collector?: Collector; reason?: string } {
    const spec = PIVOTS[pivotType];
    if (!spec) return { reason: `Unknown pivot ${pivotType}` };
    if (op.isDemo) {
      if (pivotType === 'EVIDENCE_MINING') return { collector: this.byId.get('internal') };
      if (this.synthetic.pivotTypes.includes(pivotType)) return { collector: this.synthetic };
      return { reason: 'Not available for demo operations' };
    }
    let order = REAL_ORDER[pivotType] ?? [];
    if (pivotType === 'WALLET_TRACE') {
      const fam = walletFamily(entity.value);
      order = fam === 'evm' ? ['blockscout'] : fam === 'tron' ? ['trongrid'] : fam === 'btc' ? ['mempool'] : [];
    }
    const reasons: string[] = [];
    for (const id of order) {
      const c = this.byId.get(id);
      if (!c) continue;
      if (settings.disabledCollectors.includes(id)) { reasons.push(`${c.name} disabled in Settings`); continue; }
      const a = c.availability(settings, { main });
      if (a.ok) return { collector: c };
      reasons.push(`${c.name}: ${a.reason}`);
    }
    return { reason: reasons.join('; ') || 'No collector implements this pivot' };
  }

  /** All pivots that apply to an entity type (regardless of availability). */
  pivotsFor(entity: Entity): PivotSpec[] {
    return Object.values(PIVOTS).filter(spec => spec.entityTypes.includes(entity.type) && (!spec.applies || spec.applies(entity as any)));
  }

  describe(settings: RuntimeSettings, main: MainBridge | null) {
    return this.collectors.filter(c => c.kind !== 'synthetic').map(c => {
      const a = settings.disabledCollectors.includes(c.id) ? { ok: false, reason: 'Disabled in Settings' } : c.availability(settings, { main });
      return { id: c.id, name: c.name, kind: c.kind, description: c.description, pivots: c.pivotTypes, available: a.ok, reason: a.reason ?? null };
    });
  }
}
