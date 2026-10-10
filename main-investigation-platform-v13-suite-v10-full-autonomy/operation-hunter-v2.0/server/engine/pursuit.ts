import type { Entity, PursuitState, PursuitHopLog, Lead } from '../types.js';
import type { PursuitRun, PursuitConfigV1, PivotRecord, PivotResultSummary, CollectorResult } from '../core/model.js';
import type { HunterApp } from '../app.js';
import { PIVOTS } from '../collectors/pivots.js';
import { ingestObservations } from './ingest.js';
import { ubiquityFromVolume, isCommodity } from './noise.js';
import { pivotSignature, PivotCandidate } from './planner.js';
import { newId, nowIso, listPhrase, plural, HunterError, round } from '../core/util.js';
import { recordFacets, describeChange } from '../model/facets.js';
import { proxyProgress, COST_UNITS } from '../pursuit/progress.js';
import { statusOf, levelOf, ScoredCandidate } from '../pursuit/allocator.js';
import { branchKindOf } from '../pursuit/branches.js';

export const DEFAULT_CONFIG: PursuitConfigV1 = {
  maxHops: 4,
  budgetTotal: 80,
  concurrency: 2,
  minConfidenceThreshold: 0.35,
  avoidSaturation: true,
  saturationWindow: 8,
  maxMinutes: 45,
  allowDelegation: false,
};

const TERMINAL = new Set(['COMPLETED', 'BUDGET_EXHAUSTED', 'SATURATED', 'FAILED', 'STOPPED']);
/** Below this expected progress per unit of cost, further lookups are not worth their cost. */
export const DIMINISHING_THRESHOLD = 0.45;

/**
 * Autonomous pursuit: a durable, best-first expansion from the seeds.
 *
 * Every pivot is recorded before it runs and after it finishes, so a crash or
 * restart resumes exactly where it stopped. The loop respects hop limits,
 * a pivot budget, per-source failures, commodity infrastructure, and stops
 * when the frontier is exhausted or recent pivots stop producing anything new
 * (saturation).
 */
export class PursuitEngine {
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Map<string, number>();
  private lastRemaining = new Map<string, number>();
  private analyzedAt = new Map<string, number>();

  constructor(private app: HunterApp) {}

  // ------------------------------------------------------------ lifecycle
  startScheduler(intervalMs = 1500) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called on boot: pivots interrupted mid-flight are re-queued; RUNNING runs continue automatically. */
  recover(): { interruptedPivots: number; resumedRuns: number } {
    const interruptedPivots = this.app.store.recoverInterruptedPivots();
    const resumedRuns = this.app.store.runsWithStatus('RUNNING').length;
    for (const run of this.app.store.runsWithStatus('RUNNING')) {
      this.app.store.addChange(run.operationId, 'pursuit_resumed', 'Pursuit resumed automatically after restart');
    }
    return { interruptedPivots, resumedRuns };
  }

  activeRun(operationId: string): PursuitRun | undefined {
    const run = this.app.store.latestRun(operationId);
    return run && !TERMINAL.has(run.status) ? run : undefined;
  }

  start(operationId: string, config: Partial<PursuitConfigV1> & { budgetRemaining?: number } = {}): PursuitRun {
    const op = this.app.store.getOperation(operationId);
    if (!op) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
    const current = this.activeRun(operationId);
    const cfg = sanitizeConfig({ ...DEFAULT_CONFIG, ...(op.isDemo ? { concurrency: 3 } : {}), ...(current?.config ?? {}), ...config });
    if (current) {
      const next: PursuitRun = { ...current, status: 'RUNNING', config: cfg, updatedAt: nowIso(), stopReason: null };
      this.app.store.saveRun(next);
      this.app.store.logAudit(operationId, 'PURSUIT_RESUME', `Pursuit resumed (budget ${cfg.budgetTotal - next.budgetUsed} remaining)`);
      return next;
    }
    const run: PursuitRun = {
      id: newId('run', 10), operationId, status: 'RUNNING', config: cfg, budgetUsed: 0, startedAt: nowIso(), updatedAt: nowIso(), finishedAt: null, stopReason: null,
      stats: { pivots: 0, newEntities: 0, newEvidence: 0, failures: 0, deadEnds: 0, commoditySkipped: 0, maxDepthReached: 0, recentYield: [] },
    };
    this.app.store.saveRun(run);
    this.app.store.addChange(operationId, 'pursuit_started', `Pursuit started (up to ${cfg.maxHops} hops, ${cfg.budgetTotal} pivots)`);
    this.app.store.logAudit(operationId, 'PURSUIT_START', `Autonomous pursuit started: maxHops ${cfg.maxHops}, budget ${cfg.budgetTotal}`);
    this.app.store.touch(operationId, 'pursuit');
    return run;
  }

  setStatus(operationId: string, status: 'PAUSED' | 'RUNNING' | 'STOPPED', reason?: string): PursuitRun | undefined {
    const run = this.app.store.latestRun(operationId);
    if (!run) return undefined;
    if (status === 'RUNNING') return this.start(operationId);
    if (TERMINAL.has(run.status) && status === 'STOPPED') return run;
    const next: PursuitRun = { ...run, status, updatedAt: nowIso(), stopReason: reason ?? (status === 'PAUSED' ? 'Paused by analyst' : 'Stopped by analyst'), finishedAt: status === 'STOPPED' ? nowIso() : run.finishedAt };
    this.app.store.saveRun(next);
    this.app.store.logAudit(operationId, status === 'PAUSED' ? 'PURSUIT_PAUSE' : 'PURSUIT_STOP', next.stopReason ?? '');
    this.app.store.touch(operationId, 'pursuit');
    return next;
  }

  // ------------------------------------------------------------ scheduler tick
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of this.app.store.runsWithStatus('RUNNING')) {
        const active = this.inFlight.get(run.operationId) ?? 0;
        const slots = Math.max(0, run.config.concurrency - active);
        if (slots === 0) continue;
        const picks = this.pickNext(run, slots);
        if (!picks.length) {
          if (active === 0) this.finish(run.operationId, run.id);
          continue;
        }
        for (const pick of picks) {
          this.inFlight.set(run.operationId, (this.inFlight.get(run.operationId) ?? 0) + 1);
          void this.executeCandidate(run.operationId, pick, run.id)
            .catch(err => console.error('[pursuit] pivot failed', err))
            .finally(() => this.inFlight.set(run.operationId, Math.max(0, (this.inFlight.get(run.operationId) ?? 1) - 1)));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Choose the next pivots for a run by expected progress per unit cost, spread across branches. */
  private pickNext(run: PursuitRun, slots: number): PivotCandidate[] {
    const remaining = run.config.budgetTotal - run.budgetUsed - (this.inFlight.get(run.operationId) ?? 0);
    if (remaining <= 0) return [];
    if (!this.app.governor.allow(run.operationId)) { this.lastRemaining.set(run.operationId, -1); return []; }
    const inFlight = this.app.store.getPivots(run.operationId, 50).filter(p => p.status === 'running');
    const inFlightKeys = new Set(inFlight.map(p => p.signature));
    const base = this.app.planner.candidates(run.operationId).filter(c => (c.entity.depth ?? 0) < run.config.maxHops && c.collectorId && (run.config.allowDelegation || c.spec.pivotType !== 'SITE_CHECK_REQUEST'));
    const revisits = this.app.allocator.revisitCandidates(run.operationId).filter(c => !this.app.store.pivotBySignature(run.operationId, c.key));
    const scored = this.app.allocator.score(run.operationId, [...base, ...revisits]).filter(c => !inFlightKeys.has(c.key));
    this.lastRemaining.set(run.operationId, this.app.allocator.remainingValue(scored));
    if (!scored.length) return [];
    // Diminishing returns: once the reconstruction has had a fair budget, stop when nothing is expected to help.
    if (run.stats.pivots >= Math.max(12, run.config.saturationWindow) && (this.lastRemaining.get(run.operationId) ?? 0) < DIMINISHING_THRESHOLD) return [];
    return this.app.allocator.select(scored, Math.min(slots, remaining), inFlight.map(p => branchKindOf(p.pivotType)));
  }

  private finish(operationId: string, runId: string) {
    const run = this.app.store.getRun(runId);
    if (!run || TERMINAL.has(run.status) || run.status !== 'RUNNING') return;
    const remainingValue = this.lastRemaining.get(operationId);
    const status = this.stopCondition(run) ?? (remainingValue !== undefined && remainingValue >= 0 && remainingValue < DIMINISHING_THRESHOLD && run.stats.pivots >= 12 ? 'SATURATED' : remainingValue === -1 ? 'PAUSED' : 'COMPLETED');
    if (status === 'PAUSED') { this.setStatus(operationId, 'PAUSED', 'Paused: today\'s lookup allowance for this operation is used up (Settings → daily budget). It resumes automatically tomorrow.'); return; }
    const reason = status === 'BUDGET_EXHAUSTED' ? `Pivot budget of ${run.config.budgetTotal} used`
      : status === 'SATURATED' ? `Diminishing returns — the best remaining lookup is expected to add little (${round(remainingValue ?? 0, 2)} progress per lookup). Parked lines will be revisited automatically.`
        : 'No further lookups within the hop limit';
    this.close(run, status, reason);
  }

  private close(run: PursuitRun, status: PursuitRun['status'], reason: string) {
    const next: PursuitRun = { ...run, status, stopReason: reason, finishedAt: nowIso(), updatedAt: nowIso() };
    this.app.store.saveRun(next);
    this.app.store.addChange(run.operationId, 'pursuit_finished', `Pursuit ${status.toLowerCase().replace('_', ' ')}: ${reason}. ${plural(run.stats.pivots, 'pivot')}, ${plural(run.stats.newEntities, 'new entity', 'new entities')}.`, { runId: run.id, status });
    this.app.store.logAudit(run.operationId, `PURSUIT_${status}`, reason);
    this.app.store.touch(run.operationId, 'pursuit');
    this.app.analyzer.analyze(run.operationId);
    this.app.monitor.ensureDefaultMonitors(run.operationId);
    try { this.app.hunts.ensureHunts(run.operationId); } catch (err) { console.warn('[hunts] could not derive hunts', err); }
    this.app.checkpoint(run.operationId, `After pursuit (${status.toLowerCase()})`);
    this.app.integration?.queueSync(run.operationId);
  }

  private stopCondition(run: PursuitRun): PursuitRun['status'] | null {
    if (run.budgetUsed >= run.config.budgetTotal) return 'BUDGET_EXHAUSTED';
    const y = run.stats.recentYield;
    if (run.config.avoidSaturation && y.length >= run.config.saturationWindow && y.slice(-run.config.saturationWindow).every(v => v < 0.5) && (this.lastRemaining.get(run.operationId) ?? 1) < DIMINISHING_THRESHOLD * 2) return 'SATURATED';
    if (Date.now() - Date.parse(run.startedAt) > run.config.maxMinutes * 60000) return 'COMPLETED';
    return null;
  }

  // ------------------------------------------------------------ execution
  /** Run the pursuit synchronously until it stops (tests, jobs, CLI). */
  async runToCompletion(operationId: string, config: Partial<PursuitConfigV1> = {}, maxSteps = 500): Promise<PursuitRun> {
    const run = this.start(operationId, config);
    let steps = 0;
    while (steps < maxSteps) {
      const current = this.app.store.getRun(run.id)!;
      if (current.status !== 'RUNNING') break;
      const stop = this.stopCondition(current);
      if (stop) { this.close(current, stop, stop === 'SATURATED' ? `Last ${current.config.saturationWindow} pivots found nothing new` : stop === 'BUDGET_EXHAUSTED' ? `Pivot budget of ${current.config.budgetTotal} used` : 'Time limit reached'); break; }
      const picks = this.pickNext(current, current.config.concurrency);
      if (!picks.length) { this.finish(operationId, run.id); break; }
      await Promise.all(picks.map(p => this.executeCandidate(operationId, p, run.id)));
      steps += picks.length;
    }
    return this.app.store.getRun(run.id)!;
  }

  /** Execute the single best next pivot (legacy "step" button). */
  async step(operationId: string): Promise<PivotRecord | null> {
    let run = this.activeRun(operationId);
    if (!run) run = this.start(operationId);
    const picks = this.pickNext(run, 1);
    if (!picks.length) {
      this.finish(operationId, run.id);
      return null;
    }
    return this.executeCandidate(operationId, picks[0], run.id);
  }

  /** Execute a specific pivot on a specific entity (lead "Run" button, finding actions). */
  async executePivot(operationId: string, pivotType: string, entityId: string, opts: { runId?: string | null; bypassCache?: boolean; force?: boolean } = {}): Promise<PivotRecord> {
    const entity = this.app.store.getEntity(entityId);
    if (!entity || entity.operationId !== operationId) throw new HunterError('NOT_FOUND', 'Entity not found in this operation', 404);
    const spec = PIVOTS[pivotType];
    if (!spec) throw new HunterError('UNKNOWN_PIVOT', `Unknown pivot type ${pivotType}`);
    const op = this.app.store.getOperation(operationId)!;
    const resolved = this.app.collectors.resolve(pivotType, entity, op, this.app.runtimeSettings(), this.app.mainBridge());
    if (!resolved.collector) throw new HunterError('NO_COLLECTOR', resolved.reason ?? 'No data source available for this pivot', 409);
    const cand: PivotCandidate = { key: pivotSignature(pivotType, entity), spec, entity, collectorId: resolved.collector.id, score: 50, reasons: [], breakdown: undefined, victimLikely: false };
    return this.executeCandidate(operationId, cand, opts.runId ?? this.activeRun(operationId)?.id ?? null, opts);
  }

  async executeLead(operationId: string, leadId: string): Promise<PivotRecord> {
    const lead = this.app.store.getLead(leadId);
    if (!lead || lead.operationId !== operationId) throw new HunterError('NOT_FOUND', 'Lead not found', 404);
    let entityId = lead.entityId;
    if (!entityId) {
      const ent = this.app.store.findEntity(operationId, lead.targetType, lead.targetValue) ?? this.app.store.getEntities(operationId).find(e => e.value.toLowerCase() === lead.targetValue.toLowerCase());
      if (!ent) throw new HunterError('NOT_FOUND', 'Lead target is not an entity of this operation', 404);
      entityId = ent.id;
    }
    const pivotType = PIVOTS[lead.pivotType] ? lead.pivotType : legacyPivot(lead.pivotType, lead.targetType);
    this.app.store.saveLead({ ...lead, status: 'INVESTIGATING', updatedAt: nowIso() });
    const rec = await this.executePivot(operationId, pivotType, entityId, { force: true });
    return rec;
  }

  private async executeCandidate(operationId: string, cand: PivotCandidate, runId: string | null, opts: { bypassCache?: boolean; force?: boolean } = {}): Promise<PivotRecord> {
    const { store } = this.app;
    const op = store.getOperation(operationId)!;
    const existing = store.pivotBySignature(operationId, cand.key);
    if (existing && existing.status === 'running') return existing;
    const collector = this.app.collectors.get(cand.collectorId!)!;
    const record: PivotRecord = {
      id: existing?.id ?? newId('pvt', 10), operationId, runId, collector: collector.id, pivotType: cand.spec.pivotType, entityId: cand.entity.id,
      targetType: cand.entity.type, targetValue: cand.entity.value, depth: cand.entity.depth ?? 0, priority: cand.score, status: 'running',
      attempts: (existing?.attempts ?? 0) + 1, createdAt: existing?.createdAt ?? nowIso(), startedAt: nowIso(), finishedAt: null, signature: cand.key, result: null, error: null,
      branchId: null, progress: null, valueEstimate: (cand as ScoredCandidate).expected ?? null,
    };
    const analysisBefore = this.app.analyzer.peek(operationId);
    const subjectStatus = cand.entity.isSeed ? 'member' : statusOf(analysisBefore, cand.entity.id, cand.entity.type);
    const context = (cand as ScoredCandidate).context ?? { pivotType: cand.spec.pivotType, entityType: cand.entity.type, status: subjectStatus, level: levelOf(analysisBefore, cand.entity.id) };
    const branch = this.app.allocator.branches.forPivot(operationId, cand.spec.pivotType, cand.entity);
    record.branchId = branch.id;
    const isRevisit = cand.key.includes('#r');
    if (isRevisit) opts = { ...opts, bypassCache: true };
    store.savePivot(record);
    let result: CollectorResult | null = null;
    let error: any = null;
    try {
      result = await withTimeout(collector.execute(cand.spec.pivotType, cand.entity, {
        store, http: this.app.http, settings: this.app.runtimeSettings(), operationId, bypassCache: opts.bypassCache, main: this.app.mainBridge(), dnsResolver: this.app.dnsResolver,
      }), 90000);
    } catch (err) {
      error = err;
    }

    if (error || !result) {
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown failure');
      const failed: PivotRecord = { ...record, status: 'failed', finishedAt: nowIso(), error: message, result: { ...failureSummary(cand, message), context, branchKind: branch.kind }, progress: 0 };
      store.savePivot(failed);
      this.app.allocator.branches.update(branch, { progress: 0, cost: COST_UNITS[cand.spec.cost] ?? 1.5, failed: true, frontierLeft: this.frontierLeft(operationId, cand) });
      const lead = store.leadByKey(operationId, cand.key);
      if (lead) store.saveLead({ ...lead, status: failed.attempts >= 3 ? 'EXHAUSTED' : 'PENDING', lastError: message, updatedAt: nowIso() });
      this.bumpRun(runId, r => { r.stats.failures++; r.stats.pivots++; r.budgetUsed++; r.stats.recentYield.push(0); });
      store.addChange(operationId, 'pivot_failed', `${cand.spec.label} on ${cand.entity.value} failed: ${message}`, { pivotId: record.id });
      this.maybePauseOnFailures(runId);
      return failed;
    }

    // Commodity check before ingesting: crowded infrastructure is recorded as context, not expanded.
    const volumeUbiquity = ubiquityFromVolume(cand.spec.pivotType, result.resultVolume);
    const commodity = isCommodity(volumeUbiquity);
    if (volumeUbiquity > (cand.entity.ubiquity ?? 0)) {
      const updated: Entity = { ...cand.entity, ubiquity: volumeUbiquity, metadata: { ...cand.entity.metadata, ...(commodity ? { commodity: true, ubiquityReason: `${cand.spec.label} returned ${result.resultVolume.toLocaleString()} results — shared by too many unrelated sites to be a meaningful link.` } : {}), resultVolume: result.resultVolume } };
      store.updateEntity(updated);
    }
    const observations = commodity ? [] : result.observations;
    const ingest = ingestObservations(store, observations, { operationId, collector: collector.id, pivotId: record.id, subjectDepth: cand.entity.depth ?? 0, synthetic: collector.kind === 'synthetic' || op.isDemo });

    // v2.0: the facet ledger turns observations into changes; progress (not volume) drives learning and allocation.
    const changes = commodity ? [] : recordFacets(this.app.intel, store, operationId, cand.entity.id, result.observations);
    const progress = proxyProgress({ subject: cand.entity, subjectStatus, subjectProbability: this.app.analyzer.peek(operationId)?.membership?.byId?.[cand.entity.id]?.probability, pivotType: cand.spec.pivotType, ingest, changes, commodity, resultVolume: result.resultVolume });
    const cost = COST_UNITS[cand.spec.cost] ?? 1.5;
    this.app.allocator.learner.record(context, progress.total, cost);
    this.app.allocator.branches.update(branch, { progress: progress.total, cost, frontierLeft: this.frontierLeft(operationId, cand) });
    this.app.intel.spend(operationId, cost);
    const summary: PivotResultSummary = { ...describeResult(cand, result, ingest, commodity), progress: progress.total, progressParts: progress.parts, context, branchKind: branch.kind, why: (cand as ScoredCandidate).why, changes: changes.map(c => describeChange(c, cand.entity.value)) };
    const status = result.pending ? 'pending_external' : 'done';
    const done: PivotRecord = { ...record, status, finishedAt: nowIso(), result: summary, error: null, progress: progress.total };
    store.savePivot(done);
    const significant = changes.filter(c => c.significance >= 0.6 && c.kind !== 'contradiction');
    for (const c of significant.slice(0, 8)) store.addChange(operationId, 'facet_change', describeChange(c, cand.entity.value), { entityId: c.entityId, facet: c.facet, kind: c.kind, pivotId: record.id });
    for (const c of changes.filter(x => x.kind === 'contradiction').slice(0, 3)) store.addChange(operationId, 'source_conflict', describeChange(c, cand.entity.value), { entityId: c.entityId, facet: c.facet });
    if (significant.length) this.app.allocator.branches.reopenDue(operationId, new Set([cand.entity.id, ...ingest.newEntities.map(e => e.id)]));
    const lead = store.leadByKey(operationId, cand.key);
    if (lead) store.saveLead({ ...lead, status: 'COMPLETED', updatedAt: nowIso(), lastError: undefined });
    this.app.strategy.record({
      operationId, pivotType: cand.spec.pivotType, entityType: cand.entity.type, pivotId: record.id, newRelevant: ingest.newRelevantEntities.length,
      newEntities: ingest.newEntities.length, newEvidence: ingest.newEvidence.length, confidence: avgConfidence(observations), cost: cand.spec.cost,
      context: `${cand.spec.label} on ${cand.entity.type} ${cand.entity.value}`,
    });
    this.bumpRun(runId, r => {
      r.stats.pivots++; r.budgetUsed++; r.stats.newEntities += ingest.newEntities.length; r.stats.newEvidence += ingest.newEvidence.length;
      if (commodity) r.stats.commoditySkipped++;
      if (!ingest.newRelevantEntities.length) r.stats.deadEnds++;
      r.stats.maxDepthReached = Math.max(r.stats.maxDepthReached, (cand.entity.depth ?? 0) + (ingest.newEntities.length ? 1 : 0));
      // Information gain: new relevant entities, or new evidence from a profiling pivot (dates, owners, contract status).
      r.stats.recentYield = [...r.stats.recentYield, progress.total].slice(-30);
    });
    if (ingest.newEntities.length || commodity) {
      store.addChange(operationId, 'pivot', summary.simpleExplanation, { pivotId: record.id, pivotType: cand.spec.pivotType, newEntities: ingest.newEntities.map(e => e.value).slice(0, 20) });
    }
    store.logAudit(operationId, 'PIVOT', summary.actionSummary);
    const pivotsSoFar = runId ? this.app.store.getRun(runId)?.stats.pivots ?? 0 : 0;
    const last = this.analyzedAt.get(operationId) ?? 0;
    if (runId && (pivotsSoFar - last >= 4 || progress.total >= 4)) { this.analyzedAt.set(operationId, pivotsSoFar); this.app.analyzer.analyze(operationId); } // membership steers the next picks
    else this.app.analyzer.markDirty(operationId);
    this.app.reappearance.onNewEntities(operationId, ingest.newEntities);
    return done;
  }

  /** Lookups of the same branch kind still available on the same target (0 = the branch is exhausted for now). */
  private frontierLeft(operationId: string, cand: PivotCandidate): number {
    const kind = branchKindOf(cand.spec.pivotType);
    const done = this.app.store.doneSignatures(operationId);
    return this.app.collectors.pivotsFor(cand.entity).filter(sp => branchKindOf(sp.pivotType) === kind && sp.pivotType !== cand.spec.pivotType && !done.has(pivotSignature(sp.pivotType, cand.entity))).length;
  }

  private bumpRun(runId: string | null, mutate: (r: PursuitRun) => void) {
    if (!runId) return;
    const run = this.app.store.getRun(runId);
    if (!run) return;
    mutate(run);
    run.updatedAt = nowIso();
    this.app.store.saveRun(run);
    const stop = run.status === 'RUNNING' ? this.stopCondition(run) : null;
    if (stop && (this.inFlight.get(run.operationId) ?? 0) <= 1) {
      const reason = stop === 'BUDGET_EXHAUSTED' ? `Pivot budget of ${run.config.budgetTotal} used` : stop === 'SATURATED' ? `Last ${run.config.saturationWindow} pivots found nothing new` : 'Time limit reached';
      this.close(run, stop, reason);
    }
  }

  private maybePauseOnFailures(runId: string | null) {
    if (!runId) return;
    const run = this.app.store.getRun(runId);
    if (!run || run.status !== 'RUNNING') return;
    const recent = this.app.store.getPivots(run.operationId, 8);
    if (recent.length >= 8 && recent.every(p => p.status === 'failed')) {
      this.app.store.saveRun({ ...run, status: 'PAUSED', stopReason: 'Paused: the last 8 pivots failed (data sources unreachable or rate-limited). Check Settings → Data sources, then resume.', updatedAt: nowIso() });
      this.app.store.addChange(run.operationId, 'pursuit_paused', 'Pursuit paused because data sources kept failing');
    }
  }

  // ------------------------------------------------------------ legacy views
  legacyState(operationId: string): PursuitState {
    const run = this.app.store.latestRun(operationId);
    const pivots = this.app.store.getPivots(operationId, 200);
    const entities = this.app.store.getEntities(operationId);
    const cfg = run?.config ?? DEFAULT_CONFIG;
    const status = !run ? 'IDLE' : run.status === 'STOPPED' || run.status === 'FAILED' ? 'IDLE' : run.status;
    return {
      operationId,
      status: status as PursuitState['status'],
      currentHop: Math.min(cfg.maxHops, Math.max(1, (run?.stats.maxDepthReached ?? 0) + 1)),
      pivotsExecuted: pivots.filter(p => p.status === 'done' || p.status === 'pending_external').length,
      config: { maxHops: cfg.maxHops, budgetTotal: cfg.budgetTotal, budgetRemaining: Math.max(0, cfg.budgetTotal - (run?.budgetUsed ?? 0)), concurrency: cfg.concurrency, minConfidenceThreshold: cfg.minConfidenceThreshold, avoidSaturation: cfg.avoidSaturation },
      visitedEntityIds: Array.from(new Set(pivots.map(p => p.entityId))),
      visitedPivotSignatures: pivots.map(p => p.signature),
      abandonedBranches: entities.filter(e => e.metadata?.commodity).map(e => ({ entityId: e.id, reason: e.metadata?.ubiquityReason ?? 'Commodity infrastructure' })),
      logs: pivots.filter(p => p.result).map(p => toHopLog(p)),
      lastActiveAt: run?.updatedAt ?? nowIso(),
    };
  }
}

export function toHopLog(p: PivotRecord): PursuitHopLog {
  const r = p.result!;
  return {
    id: p.id, hopNumber: p.depth + 1, timestamp: p.finishedAt ?? p.createdAt, pivotType: p.pivotType, sourceEntityValue: p.targetValue,
    actionSummary: r.actionSummary, simpleExplanation: r.simpleExplanation, whyItMatters: r.whyItMatters, discoveredEntitiesCount: r.newEntities,
    newEvidenceCount: r.newEvidence, branchStatus: (r.branchStatus === 'COMMODITY' ? 'SATURATED' : r.branchStatus === 'PENDING_EXTERNAL' || r.branchStatus === 'FAILED' ? 'ABANDONED_DEAD_END' : r.branchStatus) as PursuitHopLog['branchStatus'],
    confidence: 0.9,
  };
}

function describeResult(cand: PivotCandidate, result: CollectorResult, ingest: ReturnType<typeof ingestObservations>, commodity: boolean): PivotResultSummary {
  const spec = cand.spec;
  const target = cand.entity.value;
  const discovered = ingest.newEntities.map(e => ({ type: e.type, value: e.value }));
  const relevant = ingest.newRelevantEntities;
  const names = relevant.map(e => e.value);
  let simple: string;
  let why: string;
  let branch: PivotResultSummary['branchStatus'];
  if (result.pending) {
    simple = `Hunter asked the Main Platform to check ${target}. Results will arrive automatically when the module finishes.`;
    why = spec.explain(target).why;
    branch = 'PENDING_EXTERNAL';
  } else if (commodity) {
    simple = `${target} turned out to be shared by about ${result.resultVolume.toLocaleString()} unrelated sites, so Hunter will not follow it.`;
    why = 'Following crowded shared infrastructure would connect this operation to thousands of unrelated sites — a classic false-positive trap.';
    branch = 'COMMODITY';
  } else if (relevant.length) {
    simple = `${spec.label} on ${target} found ${plural(relevant.length, 'new related item')}: ${listPhrase(names, 4)}.`;
    why = spec.explain(target).why;
    branch = 'EXPANDED';
  } else if (ingest.newEvidence.length) {
    simple = `${spec.label} on ${target} added ${plural(ingest.newEvidence.length, 'piece')} of evidence but no new sites, servers or wallets.`;
    why = 'Confirming facts from another source makes existing links stronger even when nothing new appears.';
    branch = 'SATURATED';
  } else {
    simple = `${spec.label} on ${target} found nothing${result.note ? ` (${result.note})` : ''}.`;
    why = 'A dead end is still useful: Hunter learns which pivots pay off and stops spending budget here.';
    branch = 'ABANDONED_DEAD_END';
  }
  return {
    newEntities: ingest.newEntities.length,
    newRelevantEntities: relevant.length,
    newEvidence: ingest.newEvidence.length,
    newRelationships: ingest.newRelationships.length,
    resultVolume: result.resultVolume,
    commodity,
    actionSummary: `${spec.pivotType} on ${cand.entity.type} ${target}: ${result.observations.length} observation(s), volume ${result.resultVolume}, +${ingest.newEntities.length} entities (+${relevant.length} relevant), +${ingest.newEvidence.length} evidence, +${ingest.newRelationships.length} relationships${commodity ? ' [commodity — not expanded]' : ''}${result.truncated ? ' [truncated]' : ''}`,
    simpleExplanation: simple,
    whyItMatters: why,
    discovered: discovered.slice(0, 40),
    branchStatus: branch,
  };
}

function failureSummary(cand: PivotCandidate, message: string): PivotResultSummary {
  return {
    newEntities: 0, newRelevantEntities: 0, newEvidence: 0, newRelationships: 0, resultVolume: 0, commodity: false,
    actionSummary: `${cand.spec.pivotType} on ${cand.entity.value} failed: ${message}`,
    simpleExplanation: `Hunter could not reach the data source for ${cand.spec.label.toLowerCase()} on ${cand.entity.value}. It will retry later.`,
    whyItMatters: 'Source failures are recorded so they are retried with backoff instead of silently losing a branch.',
    discovered: [], branchStatus: 'FAILED',
  };
}

function avgConfidence(obs: CollectorResult['observations']) {
  return obs.length ? obs.reduce((s, o) => s + o.confidence, 0) / obs.length : 0.5;
}

function sanitizeConfig(cfg: PursuitConfigV1 & { budgetRemaining?: number }): PursuitConfigV1 {
  return {
    maxHops: clampInt(cfg.maxHops, 1, 8),
    budgetTotal: clampInt(cfg.budgetTotal, 1, 1000),
    concurrency: clampInt(cfg.concurrency, 1, 6),
    minConfidenceThreshold: Math.max(0, Math.min(1, Number(cfg.minConfidenceThreshold) || 0.35)),
    avoidSaturation: cfg.avoidSaturation !== false,
    saturationWindow: clampInt(cfg.saturationWindow, 3, 50),
    maxMinutes: clampInt(cfg.maxMinutes, 1, 24 * 60),
    allowDelegation: Boolean(cfg.allowDelegation),
  };
}

function clampInt(v: unknown, min: number, max: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Pivot timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Map v0.x lead pivot names to v1.0 pivots. */
export function legacyPivot(pivotType: string, targetType: string): string {
  const map: Record<string, string> = {
    PASSIVE_DNS_REVERSE_NS: 'REVERSE_NS', PIVOT_REVERSE_NS: 'REVERSE_NS', REVERSE_NS: 'REVERSE_NS', PASSIVE_DNS: 'DNS_RESOLVE',
    BLOCKCHAIN_TRACE_OUTFLOW: 'WALLET_TRACE', TRACE_WALLET_OUTFLOW: 'WALLET_TRACE', ONCHAIN_TOKEN_TRACE: 'WALLET_TRACE',
    CERT_SAN_SUBDOMAIN_SEARCH: 'CT_SEARCH', EXPAND_CERT_SANS: 'CT_SEARCH', CERT_TRANSPARENCY: 'CT_SEARCH', DOM_AST_HASH: 'SHARED_RESOURCE',
    HTML_TRACKER_TAG: 'TRACKER_REUSE', REVERSE_IP: 'REVERSE_IP',
  };
  if (map[pivotType]) return map[pivotType];
  if (targetType === 'wallet' || targetType === 'contract') return 'WALLET_TRACE';
  if (targetType === 'ip') return 'REVERSE_IP';
  if (targetType === 'nameserver') return 'REVERSE_NS';
  if (targetType === 'identifier') return 'TRACKER_REUSE';
  return 'DNS_RESOLVE';
}

export type { Lead };
