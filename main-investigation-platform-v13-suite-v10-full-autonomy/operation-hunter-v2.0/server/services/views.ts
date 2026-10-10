import { FACET_LABEL } from '../model/facets.js';
import { briefIntel, nextLeads } from './intel.js';
import type { HunterApp } from '../app.js';
import type { Finding } from '../core/model.js';
import { PIVOTS } from '../collectors/pivots.js';
import { detectType, canonicalize } from '../core/canonical.js';
import { HunterError, nowIso } from '../core/util.js';
import { seedTypeToEntity } from './operations.js';

/** Compact per-operation summary for lists (Hunter home and Main Platform sync). */
export function operationSummary(app: HunterApp, operationId: string, opts: { analyze?: boolean } = {}) {
  const op = app.store.getOperation(operationId);
  if (!op) return null;
  const a = opts.analyze === false ? app.analyzer.peek(op.id) : app.analyzer.get(op.id);
  const run = app.store.latestRun(op.id);
  const newFindings = a?.findings.filter(f => f.isNewSinceLastView && f.status !== 'dismissed').length ?? 0;
  return {
    id: op.id, code: op.code, name: op.name, status: op.status, isDemo: Boolean(op.isDemo), initialSeed: op.initialSeed, targetType: op.targetType, tags: op.tags ?? [],
    mainInvestigationId: op.mainInvestigationId ?? null, createdAt: op.createdAt, updatedAt: op.updatedAt, lastViewedAt: op.lastViewedAt ?? null,
    headline: a?.brief.headline ?? op.summary, depth: a?.brief.depth.score ?? 0, confidence: a?.brief.confidence.percentage ?? 0,
    counts: a?.brief.counts ?? { entities: app.store.countEntities(op.id), evidence: app.store.countEvidence(op.id) },
    topFinding: a?.brief.top[0] ? { title: a.brief.top[0].title, kind: a.brief.top[0].kind } : null,
    newFindings,
    alerts: app.store.getReappearanceLeads(op.id).filter(r => r.status === 'OPEN' || r.status === 'CONFIRMED_ROTATION').length,
    pursuit: run ? { status: run.status, budgetUsed: run.budgetUsed, budgetTotal: run.config.budgetTotal, pivots: run.stats.pivots, stopReason: run.stopReason, updatedAt: run.updatedAt } : null,
  };
}

export function briefPayload(app: HunterApp, operationId: string) {
  const op = app.store.getOperation(operationId);
  if (!op) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
  const a = app.analyzer.get(op.id)!;
  const run = app.store.latestRun(op.id);
  const recent = app.store.getPivots(op.id, 6).filter(p => p.result).map(p => ({ id: p.id, at: p.finishedAt, pivotType: p.pivotType, label: PIVOTS[p.pivotType]?.label ?? p.pivotType, target: p.targetValue, text: p.result!.simpleExplanation, status: p.status, branch: p.result!.branchStatus }));
  return {
    operation: op,
    brief: a.brief,
    pursuit: run ?? null,
    recentPivots: recent,
    counts: { findings: a.findings.filter(f => f.status !== 'dismissed').length, hypotheses: a.hypotheses.length, gaps: a.gaps.length, leads: app.store.getLeads(op.id).filter(l => l.status === 'PENDING').length, monitors: app.store.getMonitors(op.id).length },
    integration: app.integration?.linkInfo(op.id) ?? null,
    // v2.0: the living model in one glance, and the few next steps worth taking
    intel: briefIntel(app, op.id),
    leads: nextLeads(app, op.id, 3),
    analyzedAt: a.computedAt,
    revision: a.revision,
  };
}

/** Nodes/edges for the graph view, with roles so the UI can fade context. */
export function graphPayload(app: HunterApp, operationId: string) {
  const a = app.analyzer.get(operationId);
  if (!a) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
  const entities = app.store.getEntities(operationId);
  const rels = app.store.getRelationships(operationId);
  const core = new Set(a.graph.core), periph = new Set(a.graph.peripheral);
  const clusterOf = new Map<string, string[]>();
  for (const c of a.graph.clusters) for (const id of c.entityIds) clusterOf.set(id, [...(clusterOf.get(id) ?? []), c.category]);
  return {
    nodes: entities.map(e => ({ id: e.id, type: e.type, value: e.value, label: e.label, isSeed: Boolean(e.isSeed), depth: e.depth ?? 0, role: e.isSeed || core.has(e.id) ? 'core' : periph.has(e.id) ? 'peripheral' : (e.ubiquity ?? 0) >= 0.75 ? 'commodity' : 'context', strength: a.graph.linkStrength[e.id]?.strength ?? 0, active: e.isActive, clusters: clusterOf.get(e.id) ?? [], ubiquity: e.ubiquity ?? 0 })),
    edges: rels.map(r => ({ id: r.id, source: r.sourceEntityId, target: r.targetEntityId, type: r.type, state: r.state, confidence: r.confidence, evidence: r.evidenceIds.length, assertion: r.assertion })),
    clusters: a.graph.clusters, bridges: a.graph.bridges,
  };
}

export function entityDetail(app: HunterApp, operationId: string, entityId: string) {
  const e = app.store.getEntity(entityId);
  if (!e || e.operationId !== operationId) throw new HunterError('NOT_FOUND', 'Entity not found', 404);
  const rels = app.store.getRelationships(operationId).filter(r => r.sourceEntityId === e.id || r.targetEntityId === e.id);
  const pivots = app.store.getPivots(operationId, 1000).filter(p => p.entityId === e.id);
  const possible = app.collectors.pivotsFor(e).map(spec => {
    const op = app.store.getOperation(operationId)!;
    const r = app.collectors.resolve(spec.pivotType, e, op, app.runtimeSettings(), app.mainBridge());
    return { pivotType: spec.pivotType, label: spec.label, cost: spec.cost, available: Boolean(r.collector), reason: r.reason, done: pivots.some(p => p.pivotType === spec.pivotType && p.status === 'done'), explain: spec.explain(e.value) };
  });
  const a = app.analyzer.peek(operationId);
  return {
    entity: e,
    role: a ? (a.graph.core.includes(e.id) ? 'core' : a.graph.peripheral.includes(e.id) ? 'peripheral' : 'context') : 'unknown',
    linkPath: a?.graph.linkStrength[e.id] ?? null,
    relationships: rels.map(r => ({ ...r, other: app.store.getEntity(r.sourceEntityId === e.id ? r.targetEntityId : r.sourceEntityId), direction: r.sourceEntityId === e.id ? 'out' : 'in' })),
    evidence: app.store.evidenceForEntity(e.id).slice(0, 100),
    pivots, possiblePivots: possible,
    otherOperations: app.store.operationsWithCanonical(e.canonical ?? e.value).filter(h => h.operationId !== operationId).map(h => ({ ...h, code: app.store.getOperation(h.operationId)?.code })),
    monitors: app.store.getMonitors(operationId).filter(m => m.targetValue.toLowerCase() === e.value.toLowerCase()),
    // v2.0: why Hunter thinks it belongs (or not), your verdict, and how it changed over time
    membership: a?.membership?.byId?.[e.id] ? { ...a.membership.byId[e.id], since: app.intel.membershipOf(operationId, e.id)?.since ?? null } : null,
    indicator: a?.membership?.indicators?.[e.id] ? { ...a.membership.indicators[e.id], carriers: a.membership.indicators[e.id].carriers.map(id => app.store.getEntity(id)?.value ?? id), inconsistent: a.membership.indicators[e.id].inconsistent.map(id => app.store.getEntity(id)?.value ?? id) } : null,
    lifecycle: a?.model?.sites?.find(s => s.entityId === e.id) ?? null,
    history: app.intel.facetChanges(operationId, { entityId: e.id, limit: 60 }).map(c => ({ ...c, label: FACET_LABEL[c.facet] ?? c.facet })),
  };
}

const SEED_PIVOTS: Record<string, string[]> = {
  domain: ['DNS_RESOLVE', 'CT_SEARCH', 'RDAP_DOMAIN', 'SITE_PROFILE'],
  wallet: ['WALLET_PROFILE', 'WALLET_TRACE'], contract: ['WALLET_PROFILE', 'WALLET_TRACE'],
  ip: ['IP_PROFILE', 'REVERSE_IP'], nameserver: ['REVERSE_NS'], identifier: ['TRACKER_REUSE'], email: ['TRACKER_REUSE'], template: ['SHARED_RESOURCE'], artifact: ['SHARED_RESOURCE'],
};

/** Legacy "expand seed": run the first-hop pivots for one or all pending seeds. */
export async function expandSeeds(app: HunterApp, operationId: string, seedId?: string) {
  const seeds = app.store.getSeeds(operationId).filter(s => (seedId ? s.id === seedId : s.status === 'pending'));
  let newEvidence = 0, newEntities = 0, newRelationships = 0;
  for (const s of seeds) {
    const type = seedTypeToEntity(s.type);
    const entity = app.store.findEntity(operationId, type, s.value) ?? (type === 'wallet' ? app.store.findEntity(operationId, 'contract', s.value) : undefined);
    if (!entity) continue;
    for (const pivotType of SEED_PIVOTS[entity.type] ?? []) {
      try {
        const rec = await app.pursuit.executePivot(operationId, pivotType, entity.id);
        newEvidence += rec.result?.newEvidence ?? 0; newEntities += rec.result?.newEntities ?? 0; newRelationships += rec.result?.newRelationships ?? 0;
      } catch { /* collector unavailable for this pivot: skip */ }
    }
    app.store.updateSeedStatus(s.id, 'expanded');
  }
  app.analyzer.analyze(operationId);
  return { expandedCount: seeds.length, newEvidenceCount: newEvidence, newEntitiesCount: newEntities, newRelationshipsCount: newRelationships };
}

/** Perform the action attached to a finding. */
export async function actOnFinding(app: HunterApp, operationId: string, findingId: string) {
  const f = app.store.getFinding(findingId) as Finding | undefined;
  if (!f || f.operationId !== operationId) throw new HunterError('NOT_FOUND', 'Finding not found', 404);
  const action = f.action;
  if (!action) throw new HunterError('NO_ACTION', 'This finding has no action');
  let result: any = null;
  const p = action.params ?? {};
  const findEntity = (value?: string, id?: string) => (id ? app.store.getEntity(id) : undefined) ?? (value ? app.store.getEntities(operationId).find(e => e.value.toLowerCase() === String(value).toLowerCase()) : undefined);
  switch (action.type) {
    case 'run_pivot':
    case 'request_site_check': {
      let entity = findEntity(p.value, p.entityId);
      if (!entity && p.value) {
        app.operations.addSeed(operationId, { value: p.value, label: 'From finding', source: 'finding' });
        entity = findEntity(p.value);
      }
      if (!entity) throw new HunterError('NOT_FOUND', 'Target not found');
      if (p.pivotType) result = await app.pursuit.executePivot(operationId, p.pivotType, entity.id);
      else result = await expandEntity(app, operationId, entity.id);
      break;
    }
    case 'start_pursuit':
      result = app.pursuit.start(operationId);
      break;
    case 'add_monitor': {
      const values: string[] = p.values ?? [];
      const created = [];
      if (values.length) for (const v of values) { const e = findEntity(v); if (e) created.push(app.monitor.create({ operationId, targetType: e.type, targetValue: e.value })); }
      else app.monitor.ensureDefaultMonitors(operationId);
      result = { created: created.length, monitors: app.store.getMonitors(operationId).length };
      break;
    }
    case 'send_to_inbox': {
      if (!app.integration?.configured()) throw new HunterError('MAIN_NOT_CONNECTED', 'Connect Main Platform in Settings to send sites to the inbox', 409);
      result = await app.integration.sendToInbox(operationId, String(p.value), f.title);
      if (p.addAsSeed) try { app.operations.addSeed(operationId, { value: String(p.value), label: 'Reappearance', source: 'reappearance' }); } catch { /* already present */ }
      break;
    }
    case 'open_view':
    case 'review_evidence':
      return { navigate: p.view ?? f.view, params: p };
    case 'mark_reviewed':
      break;
  }
  app.analyzer.setFindingStatus(findingId, 'acted');
  app.store.addChange(operationId, 'finding_action', `Acted on finding: ${f.title} (${action.label})`, { findingId, at: nowIso() });
  return { ok: true, result };
}

export async function expandEntity(app: HunterApp, operationId: string, entityId: string) {
  const e = app.store.getEntity(entityId);
  if (!e) throw new HunterError('NOT_FOUND', 'Entity not found', 404);
  const out = [];
  for (const pivotType of SEED_PIVOTS[e.type] ?? []) {
    try { out.push(await app.pursuit.executePivot(operationId, pivotType, e.id)); } catch { /* skip unavailable */ }
  }
  return out;
}

export function resolveTarget(app: HunterApp, operationId: string, value: string) {
  const type = detectType(value) ?? 'domain';
  return app.store.findEntity(operationId, type, value) ?? app.store.findEntityByCanonical(operationId, canonicalize(type, value));
}
