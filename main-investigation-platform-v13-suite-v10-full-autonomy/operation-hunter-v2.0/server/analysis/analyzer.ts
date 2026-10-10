import type { HunterApp } from '../app.js';
import type { Finding } from '../core/model.js';
import type { ContradictionReport, Hypothesis } from '../types.js';
import { loadOpData, OpData } from './data.js';
import { analyzeGraph, GraphAnalysis } from './graph.js';
import { analyzeInfrastructure, InfraAnalysis } from './infrastructure.js';
import { analyzeFinancial, FinancialAnalysisV1 } from './financial.js';
import { analyzeKits, KitAnalysis } from './kits.js';
import { analyzeTemporal, TemporalAnalysis } from './temporal.js';
import { analyzeCrossOps, CrossOpLink } from './crossop.js';
import { analyzeGaps, Gap } from './gaps.js';
import { buildTemplates, evaluateHypotheses } from './hypotheses.js';
import { deriveFingerprints } from './reappearance.js';
import { draftFindings, composeBrief, reconstructionDepth, scoreImportance, Brief } from './findings.js';
import { nowIso, stableId } from '../core/util.js';
import { inferMembership, toRows, MembershipAnalysis } from '../reasoning/membership.js';
import { assignCredit } from '../pursuit/credit.js';
import { ensureSearchPatterns } from '../pursuit/search.js';
import { buildLivingModel, recordModelVersion, syncContradictions, LivingModel, ModelDiff } from '../model/living.js';
import { modelFindings } from '../model/modelFindings.js';

export interface OperationAnalysis {
  operationId: string;
  revision: number;
  computedAt: string;
  durationMs: number;
  graph: GraphAnalysis;
  membership: MembershipAnalysis;
  infrastructure: InfraAnalysis;
  financial: FinancialAnalysisV1;
  kits: KitAnalysis;
  temporal: TemporalAnalysis;
  crossOps: CrossOpLink[];
  gaps: Gap[];
  hypotheses: Hypothesis[];
  contradictions: ContradictionReport[];
  findings: Finding[];
  brief: Brief;
  /** v2.0 living operation model (lifecycles, waves & forecast, history, money, competing explanations). */
  model: LivingModel;
  modelVersion: number | null;
  modelDiff: ModelDiff | null;
}

/**
 * Runs every analysis over one operation's evidence and persists the
 * derived state (hypotheses, findings, fingerprints, profile summaries).
 * Results are cached per operation revision; pursuit marks operations dirty
 * and a debounced background pass keeps the Brief live while it runs.
 */
export class Analyzer {
  private timers = new Map<string, NodeJS.Timeout>();
  private memory = new Map<string, OperationAnalysis>();
  debounceMs = 1200;

  constructor(private app: HunterApp) {}

  markDirty(operationId: string) {
    if (this.timers.has(operationId)) return;
    const t = setTimeout(() => {
      this.timers.delete(operationId);
      try { this.analyze(operationId); } catch (err) { console.error('[analyzer] background analysis failed', err); }
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(operationId, t);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  peek(operationId: string): OperationAnalysis | undefined {
    const m = this.memory.get(operationId);
    if (m) return m;
    return this.app.store.getAnalysis<OperationAnalysis>(operationId, 'full')?.data;
  }

  get(operationId: string): OperationAnalysis | null {
    const rev = this.app.store.revision(operationId);
    const m = this.memory.get(operationId);
    if (m && m.revision === rev) return m;
    const cached = this.app.store.getAnalysis<OperationAnalysis>(operationId, 'full');
    if (cached && cached.revision === rev && cached.data?.brief) {
      this.memory.set(operationId, cached.data);
      return cached.data;
    }
    return this.analyze(operationId);
  }

  analyze(operationId: string): OperationAnalysis | null {
    const started = Date.now();
    const { store } = this.app;
    const data = loadOpData(store, operationId);
    if (!data) return null;
    const revision = store.revision(operationId);
    const financial = analyzeFinancial(data);
    const walletRoles = new Map(financial.wallets.map(w => [w.address.toLowerCase(), w.role]));
    const previousMembership = new Map(this.app.intel.getMembership(operationId).map(r => [r.entityId, r]));
    const membership = inferMembership(data, walletRoles, { previous: previousMembership, weights: this.app.calibration().weights });
    this.app.intel.saveMembership(toRows(operationId, membership));
    assignCredit(this.app, data, previousMembership, membership, this.app.allocator.learner);
    ensureSearchPatterns(this.app, data, membership);
    const graph = applyMembership(analyzeGraph(data, walletRoles), membership);
    const infrastructure = analyzeInfrastructure(data, graph);
    this.persistRoles(data, graph, membership);
    const kits = refineKitLevels(analyzeKits(data, financial, graph), membership);
    const temporal = analyzeTemporal(data, infrastructure, financial, kits);
    const crossOps = analyzeCrossOps(store, data, financial, graph);
    const gaps = analyzeGaps(data, graph, infrastructure, kits, financial, store.doneSignatures(operationId));
    const templates = buildTemplates(data, graph, infrastructure, kits, financial, crossOps);
    const { hypotheses, contradictions } = evaluateHypotheses(store, data, templates, gaps);
    const fingerprints = deriveFingerprints(data, graph, infrastructure, kits, financial);
    store.replaceFingerprints(operationId, fingerprints);
    const reapps = store.getReappearanceLeads(operationId);
    // v2.0: the living model, its version history and persisted contradictions.
    const model = buildLivingModel({ data, intel: this.app.intel, membership, infra: infrastructure, fin: financial, kits, gaps, reapps });
    const version = recordModelVersion(this.app.intel, operationId, model, membership, 'analysis');
    const { created: newContradictions } = syncContradictions(this.app.intel, operationId, model.contradictions);
    for (const c of newContradictions.filter(x => x.severity >= 0.5)) store.addChange(operationId, 'contradiction', c.summary, { contradictionId: c.id, kind: c.kind });
    if (version && version.version > 1 && version.diff.significance >= 0.4) store.addChange(operationId, 'model_change', `Model v${version.version}: ${version.diff.changes.slice(0, 3).map(c => c.text).join(' · ')}`, { version: version.version });
    const drafts = [...draftFindings(data, graph, infrastructure, kits, financial, temporal, crossOps, hypotheses, gaps, reapps), ...modelFindings(data, model, version?.diff ?? null, this.app.intel.modelVersions(operationId, 2))];
    const findings = this.persistFindings(data, drafts);
    const depth = reconstructionDepth(data, graph, infrastructure, kits, financial);
    const changes = store.getChanges(operationId, null, 200);
    const brief = composeBrief(data, findings, depth, infrastructure, financial, kits, hypotheses, changes);
    this.updateProfile(data, brief, gaps, hypotheses, changes, findings);
    const analysis: OperationAnalysis = {
      operationId, revision, computedAt: nowIso(), durationMs: Date.now() - started, graph, membership, infrastructure, financial, kits, temporal, crossOps, gaps, hypotheses, contradictions, findings, brief,
      model, modelVersion: version?.version ?? this.app.intel.latestModel(operationId)?.version ?? null, modelDiff: version?.diff ?? null,
    };
    store.setAnalysis(operationId, 'full', revision, analysis);
    this.memory.set(operationId, analysis);
    this.app.integration?.queueSync(operationId);
    store.emit('analysis', { operationId, revision });
    return analysis;
  }

  /** Record each entity's role (core / peripheral / orphan) so other operations can ignore peripheral overlaps. */
  private persistRoles(data: OpData, graph: GraphAnalysis, membership: MembershipAnalysis) {
    const core = new Set(graph.core), periph = new Set(graph.peripheral), orphan = new Set(graph.orphans);
    this.app.store.tx(() => {
      for (const e of data.entities) {
        const m = membership.byId[e.id];
        // v2.0: things assessed as outside the operation (other operators' sites and settings) never count as its members elsewhere.
        const outside = m && (m.status === 'excluded' || (m.status === 'unknown' && ['domain', 'identifier', 'email', 'wallet', 'contract', 'artifact', 'template'].includes(e.type)));
        const role = e.isSeed || core.has(e.id) ? 'core' : periph.has(e.id) ? 'peripheral' : outside ? 'outside' : orphan.has(e.id) ? 'orphan' : 'context';
        const strength = graph.linkStrength[e.id]?.strength ?? 0;
        if (e.metadata?.linkRole === role && Math.abs((e.metadata?.linkStrength ?? -1) - strength) < 0.01) continue;
        this.app.store.updateEntity({ ...e, metadata: { ...e.metadata, linkRole: role, linkStrength: strength, ...(graph.roleReasons[e.id] ? { roleReason: graph.roleReasons[e.id] } : {}) } });
      }
    });
  }

  private persistFindings(data: OpData, drafts: ReturnType<typeof draftFindings>): Finding[] {
    const { store } = this.app;
    const now = nowIso();
    const out: Finding[] = [];
    store.tx(() => {
      for (const d of drafts) {
        const existing = store.findingByKey(data.op.id, d.key);
        const firstSeenAt = existing?.firstSeenAt ?? now;
        const f: Finding = {
          ...d,
          id: existing?.id ?? stableId('fnd', data.op.id, d.key),
          operationId: data.op.id,
          status: existing?.status ?? 'new',
          firstSeenAt,
          updatedAt: now,
          importance: existing?.status === 'dismissed' ? 0 : scoreImportance(d, data.op.lastViewedAt ?? null, firstSeenAt) - (existing?.status === 'acted' ? 15 : 0),
          isNewSinceLastView: Boolean(data.op.lastViewedAt && firstSeenAt > data.op.lastViewedAt),
        };
        if (!existing) store.addChange(data.op.id, 'finding', `New finding: ${f.title}`, { findingId: f.id, kind: f.kind });
        store.saveFinding(f, true);
        out.push(f);
      }
      store.deactivateFindingsExcept(data.op.id, drafts.map(d => d.key));
    });
    return out.sort((a, b) => b.importance - a.importance);
  }

  private updateProfile(data: OpData, brief: Brief, gaps: Gap[], hypotheses: Hypothesis[], changes: ReturnType<HunterApp['store']['getChanges']>, findings: Finding[]) {
    const facts = findings.filter(f => f.confidence >= 0.8 && f.kind !== 'critical_gap').slice(0, 6).map(f => f.whatFound);
    this.app.store.updateOperation(data.op.id, {
      narrative: brief.narrative,
      establishedFacts: facts.length ? facts : data.op.establishedFacts,
      uncertainties: [...hypotheses.filter(h => h.status === 'FORMULATED').map(h => `Open: ${h.title} (${Math.round(h.confidenceScore * 100)}%)`), ...findings.slice(0, 3).map(f => f.uncertainty)].slice(0, 6),
      evidenceGaps: gaps.slice(0, 6).map(g => g.title),
      unresolvedQuestions: hypotheses.filter(h => h.confidenceScore >= 0.35 && h.confidenceScore < 0.8).map(h => `${h.title}?`).slice(0, 5),
      recommendedNextSteps: brief.top.map(f => f.nextStep).slice(0, 5),
      recentChanges: changes.slice(0, 6).map(c => `${c.at.slice(0, 16).replace('T', ' ')} — ${c.summary}`),
    });
  }

  /** Update a finding's status (seen / dismissed / acted) and learn from the feedback. */
  setFindingStatus(findingId: string, status: Finding['status']) {
    const f = this.app.store.getFinding(findingId);
    if (!f) return null;
    const next = { ...f, status, updatedAt: nowIso() };
    this.app.store.saveFinding(next, true);
    // Credit the pivots that produced the finding's entities.
    if (status === 'dismissed' || status === 'acted') {
      for (const id of f.entityIds.slice(0, 10)) {
        const e = this.app.store.getEntity(id);
        const via = e?.discoveredVia ? this.app.store.getPivot(e.discoveredVia) : undefined;
        if (via) this.app.strategy.feedback(via.pivotType, via.targetType, status === 'acted');
      }
    }
    this.app.store.touch(f.operationId, 'finding_feedback');
    return next;
  }
}

/**
 * v2.0: membership inference is the authority for what belongs to the
 * operation. The v1 link-strength graph is kept for paths and clusters.
 */
function applyMembership(graph: GraphAnalysis, membership: MembershipAnalysis): GraphAnalysis {
  const core: string[] = [], peripheral: string[] = [];
  const roleReasons = { ...graph.roleReasons };
  for (const m of membership.members) {
    if (m.status === 'member') core.push(m.entityId);
    else if (m.status === 'probable' || m.status === 'candidate') peripheral.push(m.entityId);
    if (m.status !== 'member' && m.factors.length) roleReasons[m.entityId] = m.factors.slice(0, 3).map(f => f.text).join('; ');
  }
  const linkStrength = { ...graph.linkStrength };
  for (const m of membership.members) if (m.type === 'domain') linkStrength[m.entityId] = { ...(linkStrength[m.entityId] ?? { path: [m.value], via: [] }), strength: m.probability };
  const known = new Set([...core, ...peripheral]);
  return { ...graph, core, peripheral, orphans: graph.orphans.filter(id => !known.has(id)), roleReasons, linkStrength };
}

/** v2.0: indicator levels from membership inference (cross-operator detection, inconsistent carriers) refine the kit view. */
function refineKitLevels(kits: KitAnalysis, membership: MembershipAnalysis): KitAnalysis {
  const indicators = kits.indicators.map(i => {
    const m = membership.indicators[i.id];
    if (!m) return i;
    if (m.level === 'vendor' && i.level !== 'vendor') return { ...i, level: 'vendor' as const, reason: m.reason };
    if (m.level === 'operator' && (i.level === 'shared' || i.level === 'single') && i.domains.length >= 2 && !m.inconsistent.length) return { ...i, level: 'operator' as const, reason: `Set on ${i.domains.length} of this operation's sites; no site run by a different operator carries it.` };
    return i;
  });
  const operatorIndicators = indicators.filter(i => i.level === 'operator').map(i => ({ value: i.value, type: i.kind, reason: i.reason }));
  const vendorExtra = indicators.filter(i => i.level === 'vendor' && !kits.vendorIndicators.some(v => v.value === i.value)).map(i => ({ value: i.value, type: i.type, reason: i.reason }));
  return { ...kits, indicators, operatorIndicators, vendorIndicators: [...kits.vendorIndicators, ...vendorExtra] };
}
