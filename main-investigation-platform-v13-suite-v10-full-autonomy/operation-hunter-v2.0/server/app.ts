import path from 'node:path';
import fs from 'node:fs';
import { HunterStore } from './core/store.js';
import { IntelStore } from './core/intelStore.js';
import { HttpClient, FetchLike } from './collectors/http.js';
import { CollectorRegistry } from './collectors/registry.js';
import type { MainBridge, RuntimeSettings } from './collectors/base.js';
import { DEFAULT_BLOCKSCOUT } from './collectors/chainCollectors.js';
import { BUNDLED_LABELS, LABEL_SOURCE } from './collectors/labels.js';
import { StrategyLearner } from './engine/strategy.js';
import { LeadPlanner } from './engine/planner.js';
import { PursuitEngine } from './engine/pursuit.js';
import { MonitorEngine } from './engine/monitor.js';
import { Analyzer } from './analysis/analyzer.js';
import { ReappearanceEngine } from './analysis/reappearance.js';
import { OperationService } from './services/operations.js';
import { Allocator } from './pursuit/allocator.js';
import { ResourceGovernor } from './pursuit/governor.js';
import { calibrateWeights, Calibration } from './reasoning/calibration.js';
import { HuntEngine } from './pursuit/hunts.js';
import type { IntegrationWorker } from './integration/worker.js';
import { newId, nowIso } from './core/util.js';

export const HUNTER_VERSION = '2.0.0';

export interface AppOptions {
  dataDir?: string;
  filename?: string;               // ':memory:' for tests
  fetchImpl?: FetchLike;
  networkMode?: 'live' | 'offline';
  dnsResolver?: any;
  seedDemo?: boolean;              // create the demo operation on an empty store (default true)
}

/**
 * Composition root. Everything that needs shared state receives the app.
 * Tests build isolated apps with an in-memory store and a fake fetch.
 */
export class HunterApp {
  readonly store: HunterStore;
  readonly intel: IntelStore;
  readonly http: HttpClient;
  readonly collectors: CollectorRegistry;
  readonly strategy: StrategyLearner;
  readonly planner: LeadPlanner;
  readonly pursuit: PursuitEngine;
  readonly analyzer: Analyzer;
  readonly monitor: MonitorEngine;
  readonly reappearance: ReappearanceEngine;
  readonly operations: OperationService;
  readonly allocator: Allocator;
  readonly governor: ResourceGovernor;
  readonly hunts: HuntEngine;
  integration: IntegrationWorker | null = null;
  dnsResolver: any;
  private networkModeOverride?: 'live' | 'offline';
  readonly startedAt = nowIso();

  constructor(options: AppOptions = {}) {
    this.store = new HunterStore({ dataDir: options.dataDir, filename: options.filename });
    this.intel = new IntelStore(this.store);
    this.http = new HttpClient(this.store, options.fetchImpl);
    this.http.setPacing('crt.sh', 2500);
    this.http.setPacing('api.hackertarget.com', 2000);
    this.http.setPacing('urlscan.io', 1500);
    this.http.setPacing('api.trongrid.io', 400);
    this.collectors = new CollectorRegistry();
    this.strategy = new StrategyLearner(this.store);
    this.planner = new LeadPlanner(this);
    this.allocator = new Allocator(this);
    this.governor = new ResourceGovernor(this);
    this.hunts = new HuntEngine(this);
    this.pursuit = new PursuitEngine(this);
    this.analyzer = new Analyzer(this);
    this.monitor = new MonitorEngine(this);
    this.reappearance = new ReappearanceEngine(this);
    this.operations = new OperationService(this);
    this.dnsResolver = options.dnsResolver;
    this.networkModeOverride = options.networkMode;
    this.bootstrap(options);
  }

  private bootstrap(options: AppOptions) {
    if (!this.store.getMeta('instance_id')) {
      this.store.setMeta('instance_id', newId('hunter', 12));
      this.store.setMeta('created_at', nowIso());
    }
    this.store.setMeta('app_version', HUNTER_VERSION);
    for (const l of BUNDLED_LABELS) if (!this.store.getLabel(l.value)) this.store.setLabel(l.value, l.label, l.kind, LABEL_SOURCE);
    // One-time import of the v0.x JSON store if present next to the database.
    if (this.store.file !== ':memory:') {
      const legacy = path.join(this.store.dataDir, 'hunter_store.json');
      if (fs.existsSync(legacy) && !this.store.getMeta('legacy_import_done')) {
        const imported = this.operations.importLegacyStore(legacy);
        // v0.x shipped a demo operation; v1.0 replaces it with the evidence-driven demo world.
        if (imported.skippedDemo && options.seedDemo !== false) this.operations.createDemo();
      }
    }
    if (options.seedDemo !== false && this.store.getOperations().length === 0) this.operations.createDemo();
  }

  runtimeSettings(): RuntimeSettings {
    const s = this.store.allSettings() as Record<string, any>;
    const keys = { ...(s.apiKeys ?? {}) } as Record<string, string>;
    if (process.env.URLSCAN_API_KEY) keys.urlscan = process.env.URLSCAN_API_KEY;
    if (process.env.TRONGRID_API_KEY) keys.trongrid = process.env.TRONGRID_API_KEY;
    if (process.env.HACKERTARGET_API_KEY) keys.hackertarget = process.env.HACKERTARGET_API_KEY;
    const envMode = process.env.HUNTER_NETWORK_MODE === 'offline' ? 'offline' : process.env.HUNTER_NETWORK_MODE === 'live' ? 'live' : undefined;
    return {
      networkMode: this.networkModeOverride ?? envMode ?? (s.networkMode === 'offline' ? 'offline' : 'live'),
      apiKeys: keys,
      disabledCollectors: Array.isArray(s.disabledCollectors) ? s.disabledCollectors : [],
      blockscoutNetworks: s.blockscoutNetworks && Object.keys(s.blockscoutNetworks).length ? s.blockscoutNetworks : DEFAULT_BLOCKSCOUT,
      dnsServers: Array.isArray(s.dnsServers) ? s.dnsServers.filter(Boolean) : (process.env.HUNTER_DNS_SERVERS ?? '').split(',').filter(Boolean),
      archivedContent: s.archivedContent !== false,
    };
  }

  setNetworkModeOverride(mode: 'live' | 'offline' | undefined) {
    this.networkModeOverride = mode;
  }

  mainBridge(): MainBridge | null {
    return this.integration?.bridge ?? null;
  }

  checkpoint(operationId: string, label: string) {
    const entities = this.store.getEntities(operationId);
    const evidence = this.store.countEvidence(operationId);
    const analysis = this.analyzer.peek(operationId);
    this.store.addCheckpoint({
      id: newId('cp', 10), operationId, createdAt: nowIso(), label,
      metrics: {
        entities: entities.length,
        domains: entities.filter(e => e.type === 'domain').length,
        wallets: entities.filter(e => e.type === 'wallet' || e.type === 'contract').length,
        evidence,
        depth: analysis?.brief?.depth?.score ?? 0,
      },
      entityKeys: entities.filter(e => (e.ubiquity ?? 0) < 0.75).map(e => `${e.type}:${e.canonical}`).slice(0, 5000),
    });
  }

  private calibrationCache: { at: number; count: number; value: Calibration } | null = null;
  /** Membership weights learned from analyst verdicts across all operations (cached). */
  calibration(): Calibration {
    const count = Number(this.store.get<{ n: number }>('SELECT COUNT(*) n FROM membership_feedback')?.n ?? 0);
    if (this.calibrationCache && this.calibrationCache.count === count) return this.calibrationCache.value;
    const value = calibrateWeights(this.intel.membershipFeedback());
    this.calibrationCache = { at: Date.now(), count, value };
    return value;
  }

  close() {
    this.pursuit.stopScheduler();
    this.monitor.stopScheduler();
    this.hunts.stopScheduler();
    this.analyzer.stop();
    this.integration?.stop();
    this.store.close();
  }
}
