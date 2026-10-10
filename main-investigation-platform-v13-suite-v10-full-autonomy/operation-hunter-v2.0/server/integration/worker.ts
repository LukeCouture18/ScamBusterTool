import type { HunterApp } from '../app.js';
import { HUNTER_VERSION } from '../app.js';
import type { MainBridge, MainLookupResult } from '../collectors/base.js';
import { MainClient, MainConfig, MainApiError } from './mainClient.js';
import { mainLookupObservations, mainTypeToHunter } from '../collectors/internalCollectors.js';
import { ingestObservations } from '../engine/ingest.js';
import { operationSummary } from '../services/views.js';
import { canonicalize, detectType, hostnameOf, extractIndicators } from '../core/canonical.js';
import { nowIso, parseJson, uniq, round, plural } from '../core/util.js';
import { isCommodity } from '../engine/noise.js';
import { briefIntel, nextLeads } from '../services/intel.js';

interface WorkerState {
  registeredAt: string | null;
  lastHeartbeatAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  connected: boolean;
  eventsProcessed: number;
  jobsHandled: number;
  syncsDelivered: number;
  lastSync?: { operationId: string; at: string; proposals: any; changes: any } | null;
}

/**
 * Durable, bidirectional link with the Main Investigation Platform.
 *
 * Hunter → Main: operation snapshots (Operations area), evidence ingestion
 * into linked investigations, inbox candidates and site-check requests — all
 * through a SQLite outbox that survives restarts and retries with backoff.
 * Main → Hunter: HUNT_OPERATION jobs, the module event inbox (new sites,
 * site checks, wallet analyses → enrichment and reappearance matching), and
 * inbox decisions on Hunter-sourced leads (strategy learning).
 */
export class IntegrationWorker {
  private timer: NodeJS.Timeout | null = null;
  private cycling = false;
  private state: WorkerState = { registeredAt: null, lastHeartbeatAt: null, lastCycleAt: null, lastError: null, lastErrorAt: null, connected: false, eventsProcessed: 0, jobsHandled: 0, syncsDelivered: 0 };
  readonly bridge: MainBridge;

  constructor(private app: HunterApp) {
    const self = this;
    this.bridge = {
      configured: () => self.configured(),
      lookup: (value: string) => self.lookup(value),
      requestSiteCheck: async (operationId: string, domain: string, reason: string) => {
        self.app.store.enqueueOutbox('site_check', { operationId, value: domain, reason }, `site_check:${operationId}:${domain}`);
        return { accepted: true, detail: 'Site check request queued for Main Platform' };
      },
    };
  }

  // ------------------------------------------------------------------ configuration
  config(): MainConfig {
    const stored = this.app.store.getSetting<Partial<MainConfig>>('main', {});
    return {
      url: process.env.MAIN_PLATFORM_URL ?? stored.url ?? '',
      apiKey: process.env.MAIN_PLATFORM_API_KEY ?? stored.apiKey ?? '',
      sitesToken: process.env.MAIN_SITES_TOKEN ?? stored.sitesToken,
      hunterUrl: process.env.HUNTER_PUBLIC_URL ?? stored.hunterUrl ?? `http://localhost:${process.env.PORT ?? 3000}`,
      enabled: process.env.MAIN_PLATFORM_URL ? process.env.MAIN_PLATFORM_ENABLED !== 'false' : stored.enabled !== false,
      syncDemo: stored.syncDemo ?? false,
      autoIngest: stored.autoIngest ?? true,
      autoInvestigation: stored.autoInvestigation ?? true,
    };
  }

  configured() {
    const c = this.config();
    return Boolean(c.enabled && c.url && c.apiKey);
  }

  configure(patch: Partial<MainConfig>) {
    const current = this.app.store.getSetting<Partial<MainConfig>>('main', {});
    const next: Partial<MainConfig> = { ...current };
    for (const key of ['url', 'hunterUrl', 'sitesToken'] as const) if (typeof patch[key] === 'string') next[key] = patch[key]!.trim();
    if (typeof patch.apiKey === 'string' && patch.apiKey && !patch.apiKey.includes('…')) next.apiKey = patch.apiKey.trim();
    if (patch.apiKey === '') delete next.apiKey;
    for (const key of ['enabled', 'syncDemo', 'autoIngest', 'autoInvestigation'] as const) if (typeof patch[key] === 'boolean') next[key] = patch[key];
    this.app.store.setSetting('main', next);
    this.state.registeredAt = null;
    return this.publicConfig();
  }

  publicConfig() {
    const c = this.config();
    return { url: c.url, hunterUrl: c.hunterUrl, enabled: c.enabled, syncDemo: c.syncDemo, autoIngest: c.autoIngest, autoInvestigation: c.autoInvestigation, apiKeySet: Boolean(c.apiKey), apiKey: c.apiKey ? `${c.apiKey.slice(0, 3)}…${c.apiKey.slice(-2)}` : '', sitesTokenSet: Boolean(c.sitesToken), configured: this.configured(), lockedByEnv: Boolean(process.env.MAIN_PLATFORM_URL) };
  }

  client() {
    return new MainClient(this.config(), this.app.http.fetchImpl);
  }

  status() {
    return { configured: this.configured(), ...this.state, outbox: this.app.store.outboxStats(), config: this.publicConfig(), cursor: this.app.store.getMeta('main_decisions_cursor') ?? '0' };
  }

  linkInfo(operationId: string) {
    const op = this.app.store.getOperation(operationId);
    const mainOp = this.app.store.getLinks(operationId).find(l => l.kind === 'main_operation');
    const url = this.config().url.replace(/\/+$/, '');
    return {
      connected: this.configured() && this.state.connected,
      configured: this.configured(),
      investigationId: op?.mainInvestigationId ?? null,
      investigationUrl: op?.mainInvestigationId && url ? `${url}/investigations/${op.mainInvestigationId}` : null,
      mainOperationUrl: mainOp && url ? `${url}/operations/${mainOp.external_id}` : null,
    };
  }

  // ------------------------------------------------------------------ lifecycle
  start(intervalMs = 10000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.cycle(); }, intervalMs);
    this.timer.unref?.();
    setTimeout(() => { void this.cycle(); }, 1500).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async testConnection() {
    if (!this.configured()) return { ok: false, error: 'Main Platform URL and module key are not configured' };
    try {
      const c = this.client();
      const health = await c.health().catch(e => ({ status: 0, body: { error: String(e?.message ?? e) } }));
      await c.register({ version: HUNTER_VERSION, uiUrl: this.config().hunterUrl, instanceId: this.app.store.getMeta('instance_id') });
      this.state.registeredAt = nowIso();
      this.state.connected = true;
      return { ok: true, health: health.body, registered: true };
    } catch (err) {
      this.fail(err);
      return { ok: false, error: err instanceof Error ? err.message : String(err), hint: err instanceof MainApiError && err.status === 401 ? 'Check the operation_hunter key in Main’s MODULE_API_KEYS' : err instanceof MainApiError && err.status === 404 ? 'This Main Platform build does not know the operation_hunter module yet — install the Operations upgrade' : undefined };
    }
  }

  /** One full integration pass. Safe to call concurrently (no-op while running). */
  private inflight: Promise<any> | null = null;

  async cycle(): Promise<any> {
    if (!this.configured()) return { skipped: true };
    if (this.inflight) return this.inflight;
    this.inflight = this.runCycle().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async runCycle() {
    this.cycling = true;
    const summary = { registered: false, events: 0, jobs: 0, outbox: 0, decisions: 0, errors: [] as string[] };
    try {
      const c = this.client();
      if (!this.state.registeredAt) {
        await c.register({ version: HUNTER_VERSION, uiUrl: this.config().hunterUrl, instanceId: this.app.store.getMeta('instance_id') });
        this.state.registeredAt = nowIso();
        summary.registered = true;
        for (const op of this.app.store.getOperations()) this.queueSync(op.id);
      }
      const running = this.app.store.runsWithStatus('RUNNING').length > 0;
      await c.heartbeat({ version: HUNTER_VERSION, status: running ? 'running' : 'idle' });
      this.state.lastHeartbeatAt = nowIso();
      this.state.connected = true;
      for (const step of [() => this.processEvents(c), () => this.processJobs(c), () => this.flushOutbox(c), () => this.pollDecisions(c)] as const) {
        try {
          Object.assign(summary, await step());
        } catch (err) {
          summary.errors.push(err instanceof Error ? err.message : String(err));
          this.fail(err);
        }
      }
      if (!summary.errors.length) this.state.lastError = null;
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err));
      this.fail(err);
      if (err instanceof MainApiError && (err.status === 401 || err.status === 404)) this.state.registeredAt = null;
    } finally {
      this.state.lastCycleAt = nowIso();
      this.cycling = false;
    }
    return summary;
  }

  private fail(err: unknown) {
    this.state.lastError = err instanceof Error ? err.message : String(err);
    this.state.lastErrorAt = nowIso();
    if (err instanceof MainApiError && (err.status === 0 || err.status >= 500)) this.state.connected = false;
  }

  // ------------------------------------------------------------------ outbound
  queueSync(operationId: string) {
    if (!this.configured()) return;
    const op = this.app.store.getOperation(operationId);
    if (!op) return;
    if (op.isDemo && !this.config().syncDemo) return;
    // One outbox item: evidence is ingested first (so Main can act on proposals), then the snapshot.
    this.app.store.enqueueOutbox('operation_sync', { operationId }, `sync:${operationId}`);
  }

  /**
   * v2.0: an operation with at least two member sites gets its own Main investigation
   * ("Operation OP-X — reconstructed by Operation Hunter") unless it is already linked to one,
   * so its evidence, members and wallets live in Main where its modules can act on them.
   */
  ensureMainInvestigation(operationId: string) {
    const op = this.app.store.getOperation(operationId);
    if (!op || op.isDemo || op.mainInvestigationId || this.config().autoInvestigation === false) return op?.mainInvestigationId ?? null;
    const members = this.app.analyzer.peek(op.id)?.model?.counts.members ?? 0;
    if (members < 2) return null;
    const ext = `hunter-op:${op.id}`;
    this.app.operations.update(op.id, { mainInvestigationId: ext });
    this.app.store.linkMain(op.id, 'investigation', ext, { via: 'auto', owned: true });
    this.app.store.addChange(op.id, 'main_link', `Created Main investigation for this operation (${plural(members, 'member site')})`);
    return ext;
  }

  async sendToInbox(operationId: string, value: string, reason: string) {
    const domain = hostnameOf(value);
    if (!domain) throw new Error('Only domains can be sent to the inbox');
    this.app.store.enqueueOutbox('inbox_candidate', { operationId, value: domain, reason }, `inbox:${operationId}:${domain}`);
    this.app.store.linkMain(operationId, 'inbox', domain, { reason, at: nowIso() });
    this.app.store.addChange(operationId, 'sent_to_inbox', `Sent ${domain} to the Main Platform inbox`);
    if (this.configured()) void this.cycle();
    return { queued: true, domain };
  }

  private async flushOutbox(c: MainClient) {
    let delivered = 0;
    for (const item of this.app.store.dueOutbox(25)) {
      try {
        if (item.kind === 'operation_sync') {
          const cursorKey = `main_sync_cursor:${item.payload.operationId}`;
          const startedAt = nowIso();
          this.ensureMainInvestigation(item.payload.operationId);
          const payload = this.buildSyncPayload(item.payload.operationId, { changesSince: this.app.store.getMeta(cursorKey) ?? null });
          if (payload && this.config().autoIngest !== false) { const batch = this.buildIngestBatch(item.payload.operationId); if (batch) await c.ingest(batch); }
          if (payload) {
            const res = await c.syncOperation(payload);
            if (res.body?.operation_id) this.app.store.linkMain(item.payload.operationId, 'main_operation', String(res.body.operation_id));
            if (res.body?.campaign_id) this.app.store.linkMain(item.payload.operationId, 'campaign', String(res.body.campaign_id));
            this.app.store.setMeta(cursorKey, startedAt);
            this.state.syncsDelivered++;
            this.state.lastSync = { operationId: item.payload.operationId, at: nowIso(), proposals: res.body?.proposals ?? null, changes: res.body?.changes ?? null };
          }
        } else if (item.kind === 'ingest') {
          const batch = this.buildIngestBatch(item.payload.operationId);
          if (batch) await c.ingest(batch);
        } else if (item.kind === 'inbox_candidate' || item.kind === 'site_check') {
          const op = this.app.store.getOperation(item.payload.operationId);
          if (op) {
            // Main needs the site in the linked investigation before it can route work.
            if (op.mainInvestigationId) { const batch = this.buildIngestBatch(op.id); if (batch) await c.ingest(batch); }
            const syncPayload = this.buildSyncPayload(op.id);
            if (syncPayload) await c.syncOperation(syncPayload);
            const a = this.app.analyzer.peek(op.id);
            const d = a?.infrastructure.domains.find(x => x.value === item.payload.value);
            await c.operationRequest(op.id, {
              kind: item.kind === 'site_check' ? 'site_check' : 'inbox_candidate', canonical_key: item.payload.value, reason: item.payload.reason,
              investigation_id: op.mainInvestigationId ?? undefined, score: round(d?.linkStrength ?? 0.8, 2),
              headline: `Operation ${op.code}: ${item.payload.reason}`.slice(0, 280), evidence_external_id: this.evidenceIdFor(op.id, item.payload.value),
            });
          }
        }
        this.app.store.markOutbox(item.id, 'delivered');
        delivered++;
      } catch (err) {
        const retryable = !(err instanceof MainApiError) || err.retryable || err.status === 409;
        const dead = !retryable || item.attempts >= 11;
        this.app.store.markOutbox(item.id, dead ? 'dead' : 'pending', err instanceof Error ? err.message : String(err), Math.min(3600, 15 * 2 ** item.attempts));
        if (err instanceof MainApiError && err.status >= 500) throw err;
      }
    }
    this.app.store.pruneOutbox();
    return { outbox: delivered };
  }

  private evidenceIdFor(operationId: string, value: string) {
    const e = this.app.store.findEntity(operationId, 'domain', value);
    const ev = e ? this.app.store.evidenceForEntity(e.id)[0] : undefined;
    return ev ? `hunter:${ev.id}` : undefined;
  }

  buildSyncPayload(operationId: string, opts: { changesSince?: string | null } = {}) {
    const op = this.app.store.getOperation(operationId);
    if (!op) return null;
    const a = this.app.analyzer.get(op.id);
    const s = operationSummary(this.app, op.id, { analyze: false });
    if (!a || !s) return null;
    const base = (this.config().hunterUrl ?? '').replace(/\/+$/, '');
    const campaign = this.app.store.getLinks(op.id).find(l => l.kind === 'campaign')?.external_id ?? null;
    const m = a.model;
    const intel = briefIntel(this.app, op.id);
    const leads = op.isDemo ? [] : nextLeads(this.app, op.id, 3);
    const sites = m.sites.filter(x => x.membership === 'member' || x.membership === 'probable');
    const members = [
      ...sites.map(x => ({ entity_type: 'site', canonical_key: x.value, role: this.app.store.getEntity(x.entityId)?.isSeed ? 'seed' : x.membership, probability: x.probability, state: x.state, why: a.membership.byId[x.entityId]?.factors.find(f => f.weight > 0)?.text ?? '' })),
      ...m.money.pipeline.map(w => ({ entity_type: 'wallet', canonical_key: w.address, role: w.role.toLowerCase(), probability: 1, state: 'observed', why: w.reason })),
    ];
    return {
      schema_version: '2.0',
      operation: {
        external_id: op.id, code: op.code, name: op.name, status: op.status, is_demo: Boolean(op.isDemo), seed: op.initialSeed, investigation_id: op.mainInvestigationId ?? null, campaign_id: campaign,
        headline: a.brief.headline, narrative: a.brief.narrative, confidence: round(a.brief.confidence.percentage / 100, 2), depth_score: a.brief.depth.score,
        depth: a.brief.depth.dimensions, stats: { ...a.brief.counts, alerts: s.alerts, hypotheses: a.hypotheses.length, gaps: a.gaps.length },
        pursuit: s.pursuit, ui_url: base ? `${base}/#/op/${op.id}` : null, revision: a.revision, updated_at: op.updatedAt, hunter_version: HUNTER_VERSION,
        top_findings: a.brief.top.map(f => this.findingPayload(f)),
        findings: a.findings.filter(f => f.status !== 'dismissed').slice(0, 25).map(f => this.findingPayload(f)),
        links: members.map(x => ({ entity_type: x.entity_type, canonical_key: x.canonical_key, role: x.role, status: x.state })),
        related_operations: a.crossOps.slice(0, 5).map(c => ({ external_id: c.operationBId, code: c.operationBCode, distinction: c.analyticalDistinction, score: c.overallSimilarityScore })),
      },
      model: intel ? {
        status: intel.status, status_reason: intel.statusReason, counts: intel.counts, forecast: intel.forecast, explanations: intel.explanations, unknowns: intel.unknowns,
        version: intel.modelVersion, last_change: intel.lastChange ?? '',
        hypotheses: m.hypotheses, waves: m.waves, infra_history: m.infraHistory, kit_lineage: m.kitLineage,
        leads: leads.map(l => ({ question: l.question, why: l.why, target: l.targetValue, lookup: l.label, does_not_prove: l.doesNotProve })),
      } : null,
      members: members.slice(0, 500),
      proposals: op.isDemo ? [] : this.proposalsFor(op.id),
      changes: op.isDemo ? [] : this.siteObservations(op.id, sites.map(x => x.entityId), opts.changesSince ?? null),
      contradictions: this.app.intel.contradictions(op.id).slice(0, 20).map(c => ({ fingerprint: c.fingerprint, kind: c.kind, severity: c.severity, summary: c.summary, status: c.status, data: c.data })),
    };
  }

  /**
   * What Hunter suggests the platform should do — Main decides. Member sites worth a look by
   * Main's own site investigation, and operation wallets worth a wallet analysis.
   */
  proposalsFor(operationId: string) {
    const a = this.app.analyzer.peek(operationId);
    if (!a?.model) return [];
    const out: Array<Record<string, any>> = [];
    // Site proposals only once the operation has a Main investigation to hold them (evidence first, then work).
    const sites = this.app.store.getOperation(operationId)?.mainInvestigationId ? a.model.sites : [];
    for (const s of sites.filter(x => x.membership === 'member' && ['live', 'resurfaced', 'unknown'].includes(x.state)).sort((x, y) => y.probability - x.probability).slice(0, 12)) {
      const why = a.membership.byId[s.entityId]?.factors.filter(f => f.weight > 0).slice(0, 2).map(f => f.text).join('; ') ?? '';
      out.push({ key: `investigate_site:${s.value}`, kind: 'investigate_site', target_type: 'domain', target_key: s.value, probability: s.probability, value: round(0.5 + 0.5 * s.probability, 2), reason: `${s.value} is ${s.state === 'live' ? 'live and ' : ''}part of the operation (${Math.round(s.probability * 100)}%): ${why}`.slice(0, 380) });
    }
    for (const w of a.model.money.pipeline.filter(p => ['COLLECTION', 'TREASURY', 'SPLITTER'].includes(p.role)).slice(0, 8)) {
      out.push({ key: `analyze_wallet:${w.address.toLowerCase()}`, kind: 'analyze_wallet', target_type: 'wallet', target_key: w.address.toLowerCase(), value: w.role === 'TREASURY' ? 0.8 : 0.65, reason: `${w.role.toLowerCase()} wallet of the operation: ${w.reason}`.slice(0, 380) });
    }
    // Evidence gaps Site Finder is better placed to close than Hunter's own pursuit: a wave that is due
    // (or a rotation under way), or an operation that is still thin after Hunter's public pivots ran dry.
    // One request per wave / per thin state; Main decides whether and when Finder runs it.
    const members = a.model.sites.filter(s => s.membership === 'member');
    const seeds = members.filter(s => ['live', 'resurfaced', 'unknown'].includes(s.state)).sort((x, y) => y.probability - x.probability).slice(0, 5).map(s => s.value);
    const run = this.app.store.latestRun(operationId);
    const exhausted = run && run.status !== 'RUNNING';
    // The operation's own observable identifiers travel with the request, so Site Finder can hunt for
    // new deployments that reuse them (Finder searches; Hunter does not repeat that work). Only
    // operator-level indicators carried by member sites: kit-level ones would find other operators.
    const artifacts = this.findableArtifacts(a);
    if (seeds.length && (a.model.status === 'rotating' || ['due', 'overdue'].includes(a.model.forecast.status))) {
      const wave = a.model.forecast.nextExpectedAt ? a.model.forecast.nextExpectedAt.slice(0, 10) : 'rotation';
      out.push({ key: `find_related:wave:${wave}`, kind: 'find_related', target_type: 'operation', target_key: operationId, seeds, artifacts, value: 0.75,
        reason: `${a.model.status === 'rotating' ? 'The operation is rotating' : `A new wave is ${a.model.forecast.status}`}: look for new sites built like ${seeds.slice(0, 2).join(', ')} before they are widely reported.` });
    } else if (seeds.length && members.length < 3 && exhausted) {
      out.push({ key: `find_related:thin:${members.length}`, kind: 'find_related', target_type: 'operation', target_key: operationId, seeds, artifacts, value: 0.6,
        reason: `Only ${members.length} site${members.length === 1 ? '' : 's'} confirmed and Hunter's public pivots are exhausted: ask Site Finder to search for more sites like ${seeds[0]}.` });
    }
    return out;
  }

  /** Operator-level identifiers of the operation, in Site Finder's artifact vocabulary. */
  findableArtifacts(a: any): Array<{ kind: string; value: string }> {
    const out: Array<{ kind: string; value: string }> = [];
    const m = a?.membership;
    if (!m) return out;
    for (const i of Object.values(m.indicators ?? {}) as any[]) {
      if (i.level !== 'operator' || !(i.carriers ?? []).some((c: string) => m.byId?.[c]?.status === 'member')) continue;
      const v = String(i.value ?? '');
      let kind = '';
      if (i.type === 'wallet' || i.type === 'contract') kind = 'wallet';
      else if (i.type === 'artifact') kind = 'asset';
      else if (i.kind === 'analytics') kind = 'analytics';
      else if (i.kind === 'telegram') kind = 'contact';
      else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) kind = 'apihost';
      if (kind && v) out.push({ kind, value: kind === 'contact' ? v.replace(/^@/, '') : v });
      if (out.length >= 20) break;
    }
    return out;
  }

  /** Current site observations (status, IPs, nameservers) newer than the last delivered sync, in Main's temporal facet format. */
  siteObservations(operationId: string, entityIds: string[], since: string | null) {
    const out: Array<Record<string, any>> = [];
    const ids = new Set(entityIds);
    for (const f of this.app.intel.facetValues(operationId)) {
      if (!ids.has(f.entityId) || !f.current || (since && f.lastSeen <= since)) continue;
      const domain = this.app.store.getEntity(f.entityId)?.value;
      if (!domain) continue;
      if (f.facet === 'dns.status') out.push({ id: `${f.entityId}:${f.facet}:${f.lastSeen}`, domain, facet: 'status', value: f.value === 'resolving' ? 'live' : 'dead', at: f.lastSeen });
      else if (f.facet === 'rdap.status' && /hold|suspend/i.test(f.value)) out.push({ id: `${f.entityId}:${f.facet}:${f.lastSeen}`, domain, facet: 'status', value: 'suspended', at: f.lastSeen });
      else if (f.facet === 'dns.a') out.push({ id: `${f.entityId}:${f.facet}:${f.lastSeen}`, domain, facet: 'ip', value: f.value.split(',').filter(Boolean), at: f.lastSeen });
      else if (f.facet === 'dns.ns') out.push({ id: `${f.entityId}:${f.facet}:${f.lastSeen}`, domain, facet: 'nameservers', value: f.value.split(',').filter(Boolean), at: f.lastSeen });
    }
    return out.sort((x, y) => String(x.at).localeCompare(String(y.at))).slice(-400);
  }

  private findingPayload(f: import('../core/model.js').Finding) {
    return { key: f.key, kind: f.kind, title: f.title, what: f.whatFound, why: f.whyItMatters, means: f.whatItMeans, uncertainty: f.uncertainty, does_not_prove: f.doesNotProve, next_step: f.nextStep, confidence: f.confidence, importance: f.importance, status: f.status, evidence_count: f.evidenceIds.length, evidence_ids: f.evidenceIds.map(id => `hunter:${id}`) };
  }

  /** Schema 3.0 ingestion batch that mirrors the operation's core findings into its linked Main investigation. */
  buildIngestBatch(operationId: string) {
    const op = this.app.store.getOperation(operationId);
    if (!op?.mainInvestigationId) return null;
    const a = this.app.analyzer.get(op.id);
    if (!a) return null;
    const inv = op.mainInvestigationId;
    const core = new Set(a.graph.core);
    const entities = this.app.store.getEntities(op.id).filter(e => core.has(e.id) && !isCommodity(e.ubiquity));
    const records: Record<string, any[]> = { investigations: [], sites: [], wallets: [], infrastructure_indicators: [], evidence: [], relationships: [], findings: [] };
    if (inv.startsWith('hunter-op:')) records.investigations.push({ external_id: inv, title: `Operation ${op.code} — ${op.name}`.slice(0, 480), status: 'open', priority: 'normal', description: `Reconstructed by Operation Hunter from ${op.initialSeed}. ${a.brief.headline} Membership is Hunter's inference from shared operator settings, certificates, hosting and money flows; it is not proof of common ownership.`, confidence: round(a.brief.confidence.percentage / 100, 2), provenance: { module: 'operation_hunter', operation_id: op.id } });
    const prov = { module: 'operation_hunter', operation_id: op.id, operation_code: op.code, hunter_version: HUNTER_VERSION };
    const keyOf = (e: typeof entities[number]) => (e.type === 'wallet' || e.type === 'contract' ? { entity_type: 'wallet', canonical_key: e.value, network: String(e.metadata?.network ?? 'unknown') } : e.type === 'domain' ? { entity_type: 'site', canonical_key: e.value } : { entity_type: 'infrastructure_indicator', canonical_key: `${e.type}:${e.value}` });
    for (const e of entities.slice(0, 300)) {
      const base = { external_id: `hunter:${op.id}:${e.id}`, investigation_id: inv, canonical_key: keyOf(e).canonical_key, display_name: e.label, confidence: round(Math.max(0.3, e.metadata?.linkStrength ?? 0.6), 2), provenance: { ...prov, entity_type: e.type }, observed_at: e.firstSeen };
      if (e.type === 'domain') records.sites.push({ ...base, classification: 'operation_member', confidence: round(a.membership.byId[e.id]?.probability ?? 0.8, 2), provenance: { ...base.provenance, membership: a.membership.byId[e.id]?.factors.filter(f => f.weight > 0).slice(0, 3).map(f => f.text) ?? [], note: 'Membership is inferred, not proof of ownership' } });
      else if (e.type === 'wallet' || e.type === 'contract') records.wallets.push({ ...base, network: String(e.metadata?.network ?? 'unknown'), classification: 'operation_wallet' });
      else if (['ip', 'nameserver', 'identifier', 'email', 'template', 'certificate', 'hostname'].includes(e.type)) records.infrastructure_indicators.push({ ...base, classification: e.type });
    }
    const coreIds = new Set(entities.map(e => e.id));
    const rels = this.app.store.getRelationships(op.id).filter(r => coreIds.has(r.sourceEntityId) && coreIds.has(r.targetEntityId) && r.state !== 'CONTRADICTED').slice(0, 300);
    const evidenceIds = uniq(rels.flatMap(r => r.evidenceIds.slice(0, 2)));
    for (const id of evidenceIds.slice(0, 400)) {
      const ev = this.app.store.getEvidenceById(id);
      if (!ev || ev.status !== 'valid') continue;
      records.evidence.push({ external_id: `hunter:${ev.id}`, investigation_id: inv, evidence_type: `hunter_${ev.type}`, evidence_class: ev.assertion === 'blockchain_fact' ? 'blockchain_fact' : 'derived_observation', observation_scope: 'public', title: ev.originalObservation.slice(0, 200), context_text: `${ev.originalObservation}\nSource: ${ev.source}\nProvenance: ${ev.provenance}\nSHA-256: ${ev.sha256Hash}`, confidence: round(ev.confidence, 2), provenance: { ...prov, hunter_evidence_id: ev.id, source: ev.source, synthetic: ev.synthetic }, observed_at: ev.timestamp });
    }
    const evSet = new Set(records.evidence.map(e => e.external_id));
    const byId = new Map(entities.map(e => [e.id, e]));
    for (const r of rels) {
      const ev = r.evidenceIds.map(id => `hunter:${id}`).filter(id => evSet.has(id));
      if (!ev.length) continue;
      const from = byId.get(r.sourceEntityId)!, to = byId.get(r.targetEntityId)!;
      records.relationships.push({ external_id: `hunter:${r.id}`, investigation_id: inv, relationship_type: r.type.toLowerCase(), from: keyOf(from), to: keyOf(to), assertion_kind: r.assertion === 'blockchain_fact' ? 'blockchain_fact' : 'derived', evidence_ids: ev, confidence: round(r.confidence, 2), provenance: { ...prov, reasoning: r.reasoning }, observed_at: r.firstObserved });
    }
    for (const f of a.brief.top) records.findings.push({ external_id: `hunter:${op.id}:${f.key}`, investigation_id: inv, finding_type: `operation_${f.kind}`, title: f.title.slice(0, 300), body: `${f.whatFound}\n\nWhy it matters: ${f.whyItMatters}\nUncertainty: ${f.uncertainty}\nDoes not prove: ${f.doesNotProve}`, confidence: round(f.confidence, 2), provenance: prov, observed_at: f.updatedAt });
    const total = Object.values(records).reduce((s, x) => s + x.length, 0);
    if (!total) return null;
    // Main caps a batch at 1000 records.
    let budget = 1000;
    for (const k of Object.keys(records)) { records[k] = records[k].slice(0, Math.max(0, budget)); budget -= records[k].length; }
    return { schema_version: '3.0', batch_id: `hunter:${op.id}:r${a.revision}`, sent_at: nowIso(), records };
  }

  // ------------------------------------------------------------------ inbound
  private async processEvents(c: MainClient) {
    const res = await c.pendingEvents(50);
    let n = 0;
    for (const ev of res.body?.events ?? []) {
      const eventId = String(ev.event_id);
      try {
        if (!this.app.store.processedMainEvent(eventId)) {
          const outcome = await this.handleEvent(c, ev);
          this.app.store.markMainEvent(eventId, outcome);
        }
        await c.ackEvent(String(ev.delivery_id));
        this.state.eventsProcessed++;
        n++;
      } catch (err) {
        this.fail(err);
        break; // keep order; retry next cycle
      }
    }
    return { events: n };
  }

  /** React to a Main Platform event. Returns a short outcome string for the audit trail. */
  async handleEvent(c: MainClient, ev: any): Promise<string> {
    const payload = parseJson<Record<string, any>>(ev.payload, {});
    const canonical = String(payload.canonical_key ?? '');
    const invId = ev.investigation_id ? String(ev.investigation_id) : null;
    const source = String(ev.source_module ?? 'main');
    if (source === 'operation_hunter') return 'own_event';
    const target = mainTypeToHunter(ev.event_type.startsWith('wallet') ? 'wallet' : 'site', canonical) ?? (canonical ? { type: detectType(canonical) ?? 'domain', value: canonical } : null);
    const linkedOps = invId ? this.app.store.operationsLinkedTo('investigation', invId).concat(this.app.store.getOperations().filter(o => o.mainInvestigationId === invId).map(o => o.id)) : [];
    const containing = target ? this.app.store.operationsWithCanonical(canonicalize(target.type, target.value)).map(h => h.operationId) : [];
    const affected = uniq([...linkedOps, ...containing]).filter(id => !this.app.store.getOperation(id)?.isDemo);
    const outcomes: string[] = [];
    // 1. Enrich operations that contain this entity / are linked to this investigation.
    if (target && affected.length && ['site.investigated', 'wallet.analyzed', 'wallet.validated', 'wallet.observed', 'evidence.added', 'relationship.discovered', 'site.triaged'].includes(ev.event_type)) {
      const lookup = await this.lookup(target.value);
      for (const opId of affected) {
        const entity = this.app.store.findEntity(opId, target.type, target.value) ?? this.app.store.findEntityByCanonical(opId, canonicalize(target.type, target.value));
        if (!entity) continue;
        const res = ingestObservations(this.app.store, mainLookupObservations(entity, lookup), { operationId: opId, collector: 'main', subjectDepth: entity.depth ?? 0 });
        if (res.newEvidence.length) {
          this.app.store.addChange(opId, 'main_event', `Main Platform (${source}) added ${res.newEvidence.length} evidence record(s) for ${target.value} via ${ev.event_type}`, { eventId: ev.event_id });
          this.app.analyzer.markDirty(opId);
          outcomes.push(`enriched:${opId}`);
        }
      }
    }
    // 2. New sites from discovery: check against every operation's fingerprint.
    if (target?.type === 'domain' && ['site.discovered', 'site.triaged'].includes(ev.event_type) && !containing.length) {
      let features: any = { domain: target.value };
      if (invId) {
        try {
          const ctx = await c.context(invId);
          const obs = (ctx.body?.observation_versions ?? []).filter((o: any) => String(o.data ?? '').includes(target.value)).slice(0, 5);
          const inds = extractIndicators(obs.map((o: any) => String(o.data)).join('\n'));
          features = { ...features, wallets: inds.filter(i => i.type === 'wallet').map(i => i.value), identifiers: inds.filter(i => i.type === 'identifier' || i.type === 'email').map(i => i.value) };
        } catch { /* context is optional */ }
      }
      // Cheap passive profile (DNS) for candidates that already look similar by name, so nameserver/IP reuse can be scored.
      const hasFingerprints = this.app.store.getFingerprints().length > 0;
      if (hasFingerprints && this.app.runtimeSettings().networkMode === 'live') {
        const prelim = this.app.store.getOperations().filter(o => !o.isDemo).map(o => this.app.reappearance.preview(o.id, target.value, features)).sort((x, y) => y - x)[0] ?? 0;
        if (prelim >= 25) Object.assign(features, await this.quickProfile(target.value));
      }
      const matches = this.app.reappearance.checkAgainstAll(target.value, 'domain', features, `Main Platform ${source} (${ev.event_type})`);
      for (const m of matches) {
        this.app.analyzer.markDirty(m.operationId);
        outcomes.push(`reappearance:${m.operationId}:${m.overallSimilarityScore}`);
        if (m.status === 'CONFIRMED_ROTATION' || m.overallSimilarityScore >= 70) this.queueSync(m.operationId);
      }
    }
    return outcomes.join(',') || 'no_action';
  }

  /** Resolve a candidate's DNS without adding it to any operation. */
  private async quickProfile(domain: string): Promise<{ nameservers: string[]; ips: string[] }> {
    const dns = this.app.collectors.get('dns');
    if (!dns) return { nameservers: [], ips: [] };
    try {
      const res = await dns.execute('DNS_RESOLVE', { id: 'probe', operationId: 'probe', type: 'domain', value: domain, label: domain, metadata: {}, firstSeen: '', lastSeen: '', isActive: true }, { store: this.app.store, http: this.app.http, settings: this.app.runtimeSettings(), operationId: 'probe', dnsResolver: this.app.dnsResolver });
      const ents = res.observations.flatMap(o => o.entities);
      return { nameservers: ents.filter(e => e.type === 'nameserver').map(e => e.value), ips: ents.filter(e => e.type === 'ip').map(e => e.value) };
    } catch {
      return { nameservers: [], ips: [] };
    }
  }

  private async processJobs(c: MainClient) {
    let handled = 0;
    for (let i = 0; i < 3; i++) {
      const res = await c.claimJob();
      const job = (res.body as any)?.job;
      if (!job) break;
      try {
        const result = await this.handleJob(job);
        await c.updateJob(job.id, 'complete', { message: result.message, result });
        this.state.jobsHandled++;
        handled++;
      } catch (err) {
        await c.updateJob(job.id, 'fail', { error: err instanceof Error ? err.message : String(err), retry: true }).catch(() => undefined);
      }
    }
    return { jobs: handled };
  }

  /** HUNT_OPERATION: attach the seed to an existing operation or start a new one, then pursue. */
  async handleJob(job: any) {
    const payload = parseJson<Record<string, any>>(job.payload, {});
    if (!['HUNT_OPERATION', 'RECHECK_SITE', 'FIND_RELATED_SITES'].includes(job.job_type)) throw new Error(`Unsupported job type ${job.job_type}`);
    const rawSeed = String(payload.seed?.value ?? payload.canonical_key ?? '');
    const seed = rawSeed.includes(':') && !/^0x/i.test(rawSeed) && !/^https?:/i.test(rawSeed) ? rawSeed.split(':').slice(1).join(':') : rawSeed;
    if (!seed) throw new Error('Job has no seed value');
    const type = payload.seed?.type && payload.seed.type !== 'site' ? payload.seed.type : detectType(seed) ?? 'domain';
    const investigationId = job.investigation_id ? String(job.investigation_id) : payload.investigation_id ? String(payload.investigation_id) : null;
    const canonical = canonicalize(type === 'site' ? 'domain' : type, seed);
    let opId: string | null = null;
    let action = 'created';
    // Existing operation containing the seed as a core member, or linked to the investigation.
    const containing = this.app.store.operationsWithCanonical(canonical).map(h => this.app.store.getOperation(h.operationId)).filter(o => o && !o.isDemo && o.status !== 'CONCLUDED');
    const linked = investigationId ? this.app.store.getOperations().find(o => o.mainInvestigationId === investigationId && !o.isDemo) : undefined;
    if (containing[0] || linked) {
      opId = (containing[0] ?? linked)!.id;
      action = 'attached';
    } else if (type === 'domain') {
      const match = this.app.reappearance.checkAgainstAll(seed, 'domain', { domain: seed }, 'Main Platform hunt request')[0];
      if (match && (match.status === 'CONFIRMED_ROTATION' || match.overallSimilarityScore >= 80)) { opId = match.operationId; action = 'matched'; }
    }
    if (!opId) {
      const op = this.app.operations.create({ name: String(payload.title ?? `Operation ${seed}`).slice(0, 80), initialSeed: seed, targetType: type === 'site' ? 'domain' : type, mainInvestigationId: investigationId, summary: `Started from Main Platform (${payload.reason ?? job.trigger_reason ?? 'hunt request'}).` });
      opId = op.id;
    } else {
      try { this.app.operations.addSeed(opId, { value: seed, type: type === 'site' ? 'domain' : type, label: 'From Main Platform', source: 'main' }); } catch { /* already a seed */ }
      if (investigationId && !this.app.store.getOperation(opId)?.mainInvestigationId) this.app.operations.update(opId, { mainInvestigationId: investigationId });
    }
    if (investigationId) this.app.store.linkMain(opId, 'investigation', investigationId, { via: 'job', jobId: job.id });
    // v2.0: a reconstruction request can carry several seeds (a campaign's sites and wallets) and the campaign it is for.
    for (const extra of Array.isArray(payload.seeds) ? payload.seeds.slice(0, 20) : []) {
      const v = String(extra?.value ?? '').trim();
      if (!v || v === seed) continue;
      const t = extra?.type && extra.type !== 'site' ? String(extra.type) : detectType(v) ?? 'domain';
      try { this.app.operations.addSeed(opId, { value: v, type: t, label: payload.campaign_id ? 'Campaign member (Main)' : 'From Main Platform', source: 'main' }); } catch { /* already known */ }
    }
    if (payload.campaign_id) this.app.store.linkMain(opId, 'campaign', String(payload.campaign_id), { via: 'job', jobId: job.id });
    const budget = Number(payload.budget);
    const run = this.app.pursuit.start(opId, { allowDelegation: true, ...(Number.isFinite(budget) && budget > 0 ? { budgetTotal: Math.min(400, Math.round(budget)) } : {}) });
    this.app.store.addChange(opId, 'main_job', `Main Platform asked Hunter to hunt ${seed} (${action}).`, { jobId: job.id });
    this.queueSync(opId);
    const op = this.app.store.getOperation(opId)!;
    const base = (this.config().hunterUrl ?? '').replace(/\/+$/, '');
    return { operation_id: op.id, operation_code: op.code, action, run_id: run.id, ui_url: base ? `${base}/#/op/${op.id}` : null, message: `${action === 'created' ? 'Created' : 'Updated'} operation ${op.code}; pursuit running` };
  }

  private async pollDecisions(c: MainClient) {
    const cursor = this.app.store.getMeta('main_decisions_cursor') ?? '0';
    const res = await c.decisions(cursor);
    let n = 0;
    for (const d of res.body?.decisions ?? []) {
      const domain = String(d.domain ?? '');
      for (const opId of this.app.store.operationsLinkedTo('inbox', domain)) {
        const useful = d.decision === 'useful';
        const entity = this.app.store.findEntity(opId, 'domain', domain);
        const via = entity?.discoveredVia ? this.app.store.getPivot(entity.discoveredVia) : undefined;
        if (via) this.app.strategy.feedback(via.pivotType, via.targetType, useful);
        this.app.store.addChange(opId, 'inbox_decision', `You marked ${domain} ${useful ? 'USEFUL' : `SKIP${d.reason ? ` (${d.reason})` : ''}`} in the Main inbox`, { decision: d.decision });
        if (entity && !useful && d.reason === 'not_a_scam') this.app.store.updateEntity({ ...entity, metadata: { ...entity.metadata, analystVerdict: 'not_a_scam' } });
        this.app.store.touch(opId, 'inbox_decision');
        n++;
      }
      // v2.0: a site Hunter placed in an operation that a person rejected in Main teaches membership inference.
      if (d.decision !== 'useful' && ['not_a_scam', 'not_crypto'].includes(String(d.reason ?? ''))) {
        for (const hit of this.app.store.operationsWithCanonical(canonicalize('domain', domain))) {
          const entity = this.app.store.findEntity(hit.operationId, 'domain', domain);
          if (!entity || this.app.intel.membershipOf(hit.operationId, entity.id)?.analystVerdict) continue;
          const current = this.app.analyzer.peek(hit.operationId)?.membership.byId[entity.id];
          if (!current || !['member', 'probable'].includes(current.status)) continue;
          this.app.intel.setVerdict(hit.operationId, entity.id, 'not_member', `Skipped in the Main inbox (${d.reason})`, current.factors);
          this.app.store.addChange(hit.operationId, 'inbox_decision', `${domain} was rejected in the Main inbox (${d.reason}); Hunter no longer counts it as part of the operation`, { decision: d.decision });
          this.app.store.touch(hit.operationId, 'membership_verdict');
          n++;
        }
      }
    }
    if (res.body?.next_cursor) this.app.store.setMeta('main_decisions_cursor', String(res.body.next_cursor));
    return { decisions: n };
  }

  // ------------------------------------------------------------------ lookups for the MAIN_LOOKUP pivot
  async lookup(value: string): Promise<MainLookupResult> {
    const c = this.client();
    const out: MainLookupResult = { matches: [], relations: [], evidence: [] };
    const search = await c.search(value);
    const results = search.body?.results ?? [];
    const investigations = new Set<string>();
    for (const r of results) {
      const ids = parseJson<string[]>(r.investigation_ids, []).filter(Boolean);
      if (r.entity_type === 'evidence') {
        out.evidence.push({ id: String(r.id), title: String(r.display_name ?? r.title ?? ''), text: String(r.context_text ?? r.canonical_key ?? ''), sourceModule: String(r.source_module ?? 'main'), capturedAt: String(r.captured_at ?? nowIso()), investigationId: ids[0] ?? '' });
        continue;
      }
      if (['note', 'investigation'].includes(r.entity_type)) continue;
      out.matches.push({ investigationId: ids[0] ?? '', entityType: String(r.entity_type), canonical: String(r.canonical_key), displayName: r.display_name, mainEntityId: r.id });
      ids.slice(0, 3).forEach(i => investigations.add(i));
    }
    for (const invId of [...investigations].slice(0, 2)) {
      try {
        const ctx = (await c.context(invId)).body;
        if (!ctx?.entities) continue;
        const ents = new Map<string, any>(ctx.entities.map((e: any) => [e.id, e]));
        const matchIds = new Set(out.matches.map(m => m.mainEntityId));
        for (const rel of ctx.relationships ?? []) {
          if (!matchIds.has(rel.source_entity_id) && !matchIds.has(rel.target_entity_id)) continue;
          if (rel.source_module === 'operation_hunter') continue;
          const a = ents.get(rel.source_entity_id), b = ents.get(rel.target_entity_id);
          if (!a || !b) continue;
          out.relations.push({ from: { type: a.entity_type, value: a.canonical_key }, to: { type: b.entity_type, value: b.canonical_key }, relType: String(rel.relationship_type), assertion: String(rel.assertion_kind), sourceModule: String(rel.source_module), confidence: Number(rel.confidence ?? 0.7), observedAt: rel.observed_at, investigationId: invId });
        }
        for (const ev of ctx.evidence ?? []) {
          if (!matchIds.has(ev.entity_id) || ev.source_module === 'operation_hunter') continue;
          out.evidence.push({ id: String(ev.id), title: String(ev.title), text: String(ev.context_text ?? ''), sourceModule: String(ev.source_module), capturedAt: String(ev.captured_at ?? nowIso()), investigationId: invId, evidenceClass: ev.evidence_class });
        }
      } catch { /* context is best effort */ }
    }
    out.evidence = out.evidence.filter(e => e.sourceModule !== 'operation_hunter');
    return out;
  }

  /** Optional push delivery (Main feedback webhook); same handling as the pull inbox. */
  async handleWebhook(body: any, _headers: Record<string, unknown>) {
    if (!this.configured()) return { accepted: false };
    void this.cycle();
    return { accepted: true, received: Array.isArray(body?.events) ? body.events.length : 1 };
  }
}

export { hostnameOf };
