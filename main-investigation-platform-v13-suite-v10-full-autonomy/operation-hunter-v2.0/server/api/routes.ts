import fs from 'node:fs';
import path from 'node:path';
import type { HunterApp } from '../app.js';
import { HUNTER_VERSION } from '../app.js';
import { Router, RawResponse } from './http.js';
import { legacyBundle, legacyBriefing, predictiveRankings, temporalReport, legacyTrace, GLOSSARY } from '../services/compat.js';
import { briefPayload, graphPayload, entityDetail, operationSummary, expandSeeds, actOnFinding, resolveTarget } from '../services/views.js';
import { buildReport } from '../services/report.js';
import { modelPayload, modelVersionPayload, membershipPayload, setMembershipVerdict, facetsPayload, branchesPayload, huntsPayload, learnerPayload, nextLeads } from '../services/intel.js';
import { AiAssistant } from '../services/ai.js';
import { invalidateEvidence, reinstateEvidence } from '../engine/ingest.js';
import { analyzeHtml, artifactObservations } from '../collectors/artifact.js';
import { ingestObservations } from '../engine/ingest.js';
import { PIVOTS } from '../collectors/pivots.js';
import { detectType } from '../core/canonical.js';
import { HunterError, nowIso, newId } from '../core/util.js';

export function buildRouter(app: HunterApp): Router {
  const r = new Router();
  const ai = new AiAssistant(app);
  const op = (id: string) => {
    const o = app.store.getOperation(id);
    if (!o) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
    return o;
  };
  const analysis = (id: string) => app.analyzer.get(op(id).id)!;

  // ------------------------------------------------------------------ status & health
  r.get('/api/status', () => {
    const ops = app.store.getOperations();
    const count = (sql: string) => Number(app.store.get<{ n: number }>(sql)?.n ?? 0);
    return {
      status: 'LIVE', platform: `Operation Hunter v${HUNTER_VERSION}`, version: HUNTER_VERSION, centralHub: app.integration?.configured() ? 'CONNECTED' : 'STANDALONE',
      operationsCount: ops.length, evidenceCount: count('SELECT COUNT(*) n FROM evidence'), entitiesCount: count('SELECT COUNT(*) n FROM entities'),
      relationshipsCount: count('SELECT COUNT(*) n FROM relationships'), hypothesesCount: count('SELECT COUNT(*) n FROM hypotheses'), leadsCount: count('SELECT COUNT(*) n FROM leads'),
      reappearanceFingerprintsCount: count('SELECT COUNT(*) n FROM fingerprints'), strategyStatsCount: count('SELECT COUNT(*) n FROM strategy_stats'),
      temporalSnapshotsCount: ops.length, operationGenomesCount: ops.length, learningOutcomesCount: count('SELECT COUNT(*) n FROM learning_outcomes'),
      hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'), uptime: process.uptime(),
      networkMode: app.runtimeSettings().networkMode, schemaVersion: app.store.schemaVersion(),
    };
  });
  r.get('/api/v1/health', () => ({ ok: true, version: HUNTER_VERSION, schema: app.store.schemaVersion(), startedAt: app.startedAt, integration: app.integration?.status() ?? null }));

  // ------------------------------------------------------------------ operations (legacy + v1)
  r.post('/api/operations/reset-demo', async () => {
    const o = await app.operations.resetDemo();
    return { success: true, message: 'Rebuilt the synthetic demo world and reconstructed both demo operations', operation: o };
  });
  r.get('/api/operations', () => app.store.getOperations().map(o => ({ ...o, ...pick(operationSummary(app, o.id, { analyze: false })) })));
  r.post('/api/operations', ({ body }) => {
    const created = app.operations.create({ name: body.name, targetType: body.targetType, initialSeed: body.initialSeed, summary: body.summary, mainInvestigationId: body.mainInvestigationId });
    if (body.startPursuit) app.pursuit.start(created.id, body.config ?? {});
    return created;
  });
  r.get('/api/operations/:id', ({ params }) => legacyBundle(app, op(params.id).id));
  r.get('/api/v1/operations', () => app.store.getOperations().map(o => operationSummary(app, o.id)));
  r.post('/api/v1/operations', ({ body }) => {
    const created = app.operations.create({ name: body.name || `Operation ${String(body.initialSeed ?? '').slice(0, 30)}`, targetType: body.targetType ?? 'auto', initialSeed: body.initialSeed, summary: body.summary, mainInvestigationId: body.mainInvestigationId });
    for (const extra of (body.additionalSeeds ?? []) as string[]) if (String(extra).trim()) app.operations.addSeed(created.id, { value: String(extra).trim(), label: 'Additional seed' });
    if (body.startPursuit !== false) app.pursuit.start(created.id, body.config ?? {});
    app.integration?.queueSync(created.id);
    return operationSummary(app, created.id);
  });
  r.patch('/api/v1/operations/:id', ({ params, body }) => app.operations.update(op(params.id).id, body));
  r.delete('/api/v1/operations/:id', ({ params }) => { app.store.deleteOperation(op(params.id).id); return { ok: true }; });
  r.post('/api/v1/operations/:id/viewed', ({ params }) => { app.operations.markViewed(op(params.id).id); return { ok: true }; });
  r.get('/api/v1/operations/:id/brief', ({ params }) => briefPayload(app, op(params.id).id));
  r.get('/api/v1/operations/:id/analysis', ({ params }) => analysis(params.id));
  r.get('/api/v1/operations/:id/graph', ({ params }) => graphPayload(app, op(params.id).id));
  r.get('/api/v1/operations/:id/entities/:entityId', ({ params }) => entityDetail(app, op(params.id).id, params.entityId));
  r.get('/api/v1/operations/:id/changes', ({ params, query }) => app.store.getChanges(op(params.id).id, query.get('since'), Number(query.get('limit') ?? 200)));
  r.get('/api/v1/operations/:id/evidence', ({ params, query }) => {
    const all = app.store.getEvidence(op(params.id).id);
    const q = (query.get('q') ?? '').toLowerCase();
    const status = query.get('status');
    const filtered = all.filter(e => (!status || e.status === status) && (!q || `${e.originalObservation} ${e.source} ${e.type} ${e.provenance}`.toLowerCase().includes(q)));
    const limit = Math.min(1000, Number(query.get('limit') ?? 300));
    return { total: filtered.length, items: filtered.slice(0, limit) };
  });
  r.get('/api/v1/operations/:id/pivots', ({ params, query }) => app.store.getPivots(op(params.id).id, Number(query.get('limit') ?? 300)).map(p => ({ ...p, label: PIVOTS[p.pivotType]?.label ?? p.pivotType })));
  r.get('/api/v1/operations/:id/leads', ({ params }) => app.planner.refreshLeads(op(params.id).id));

  // ------------------------------------------------------------------ v2.0 intelligence layer
  r.get('/api/v1/operations/:id/model', ({ params }) => modelPayload(app, op(params.id).id));
  r.get('/api/v1/operations/:id/model/versions', ({ params, query }) => app.intel.modelVersions(op(params.id).id, Number(query.get('limit') ?? 50)));
  r.get('/api/v1/operations/:id/model/versions/:version', ({ params }) => modelVersionPayload(app, op(params.id).id, Number(params.version)));
  r.get('/api/v1/operations/:id/membership', ({ params, query }) => membershipPayload(app, op(params.id).id, { type: query.get('type'), status: query.get('status') }));
  r.post('/api/v1/operations/:id/membership/:entityId', ({ params, body }) => setMembershipVerdict(app, op(params.id).id, params.entityId, body.verdict ?? null, body.reason ?? null));
  r.get('/api/v1/operations/:id/facets', ({ params, query }) => facetsPayload(app, op(params.id).id, query.get('entityId')));
  r.get('/api/v1/operations/:id/branches', ({ params }) => branchesPayload(app, op(params.id).id));
  r.get('/api/v1/operations/:id/next', ({ params, query }) => nextLeads(app, op(params.id).id, Number(query.get('limit') ?? 5)));
  r.get('/api/v1/operations/:id/hunts', ({ params }) => { app.hunts.ensureHunts(op(params.id).id); return huntsPayload(app, params.id); });
  r.post('/api/v1/operations/:id/hunts/run', async ({ params }) => {
    const results = await app.hunts.runOperation(op(params.id).id, { force: true });
    return results.map(x => ({ huntId: x.hunt.id, kind: x.hunt.kind, newDomains: x.newDomains, returns: x.returns.map(r => ({ value: r.candidateValue, status: r.status, score: r.overallSimilarityScore })), error: x.error ?? null }));
  });
  r.patch('/api/v1/hunts/:huntId', ({ params, body }) => {
    const h = app.intel.getHunts().find(x => x.id === params.huntId);
    if (!h) throw new HunterError('NOT_FOUND', 'Hunt not found', 404);
    const status = ['active', 'paused', 'retired'].includes(body.status) ? body.status : h.status;
    const cadenceMinutes = Number.isFinite(Number(body.cadenceMinutes)) && Number(body.cadenceMinutes) >= 60 ? Number(body.cadenceMinutes) : h.cadenceMinutes;
    return app.intel.upsertHunt({ ...h, status, cadenceMinutes });
  });
  r.get('/api/v1/operations/:id/contradictions', ({ params }) => { analysis(params.id); return app.intel.contradictions(params.id); });
  r.patch('/api/v1/operations/:id/contradictions/:cid', ({ params, body }) => {
    op(params.id);
    const status = ['resolved', 'dismissed', 'open'].includes(body.status) ? body.status : 'resolved';
    app.intel.resolveContradiction(params.cid, status, body.resolution ?? null);
    return app.intel.contradictions(params.id).find(c => c.id === params.cid) ?? null;
  });
  r.get('/api/v1/learner', () => learnerPayload(app));
  r.get('/api/v1/governor', () => app.governor.status());
  r.post('/api/v1/operations/:id/pivots', async ({ params, body }) => {
    const o = op(params.id);
    const entity = body.entityId ? app.store.getEntity(body.entityId) : body.value ? resolveTarget(app, o.id, body.value) : undefined;
    if (!entity) throw new HunterError('NOT_FOUND', 'Target entity not found in this operation', 404);
    const rec = await app.pursuit.executePivot(o.id, body.pivotType, entity.id, { bypassCache: Boolean(body.refresh) });
    app.analyzer.analyze(o.id);
    return rec;
  });
  r.get('/api/v1/operations/:id/report', ({ params, query }) => {
    const rep = buildReport(app, op(params.id).id);
    if (!rep) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
    if (query.get('format') === 'json') return rep.json;
    const o = op(params.id);
    return new RawResponse(200, rep.markdown, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${o.code}-dossier.md"` });
  });
  r.get('/api/v1/operations/:id/export', ({ params }) => {
    const o = op(params.id);
    const data = {
      format: 'operation-hunter-export', version: HUNTER_VERSION, exportedAt: nowIso(), operation: o, seeds: app.store.getSeeds(o.id), entities: app.store.getEntities(o.id),
      relationships: app.store.getRelationships(o.id), evidence: app.store.getEvidence(o.id), hypotheses: app.store.getHypotheses(o.id), leads: app.store.getLeads(o.id),
      pivots: app.store.getPivots(o.id, 100000), monitors: app.store.getMonitors(o.id), reappearance: app.store.getReappearanceLeads(o.id), findings: app.store.getFindings(o.id),
      changes: app.store.getChanges(o.id, null, 100000), checkpoints: app.store.getCheckpoints(o.id, 1000),
    };
    return new RawResponse(200, JSON.stringify(data, null, 2), { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${o.code}-export.json"` });
  });
  r.get('/api/v1/operations/:id/checkpoints', ({ params }) => app.store.getCheckpoints(op(params.id).id));
  r.post('/api/v1/operations/:id/checkpoints', ({ params, body }) => { app.checkpoint(op(params.id).id, body.label || 'Manual checkpoint'); return app.store.getCheckpoints(params.id, 1)[0]; });

  // ------------------------------------------------------------------ findings
  r.post('/api/v1/findings/:findingId', ({ params, body }) => {
    const f = app.analyzer.setFindingStatus(params.findingId, body.status);
    if (!f) throw new HunterError('NOT_FOUND', 'Finding not found', 404);
    return f;
  });
  r.post('/api/v1/operations/:id/findings/:findingId/act', ({ params }) => actOnFinding(app, op(params.id).id, params.findingId));

  // ------------------------------------------------------------------ legacy analysis endpoints
  r.get('/api/operations/:id/temporal', ({ params }) => temporalReport(analysis(params.id)));
  r.get('/api/operations/:id/temporal/at-step/:stepIndex', ({ params }) => {
    const a = analysis(params.id);
    const idx = Math.max(0, Math.min(a.temporal.snapshots.length - 1, Number(params.stepIndex)));
    return a.temporal.snapshots[idx] ?? null;
  });
  r.get('/api/operations/:id/genomes', ({ params }) => analysis(params.id).kits.operationGenomes);
  r.get('/api/operations/:id/genome', ({ params }) => analysis(params.id).kits.genomes);
  r.post('/api/operations/:id/genome/analyze', async ({ params, body }) => {
    const o = op(params.id);
    const target = String(body.targetUrl || o.initialSeed);
    if (body.html) {
      const subject = resolveTarget(app, o.id, target) ?? (app.operations.addSeed(o.id, { value: target, label: 'Genome subject' }), resolveTarget(app, o.id, target));
      if (!subject) throw new HunterError('NOT_FOUND', 'Could not resolve target');
      ingestObservations(app.store, artifactObservations(subject, String(body.html), { source: 'analysis:analyst', provenance: 'Analyst-supplied page source (genome analysis)' }), { operationId: o.id, collector: 'internal', subjectDepth: subject.depth ?? 0 });
    } else {
      const subject = resolveTarget(app, o.id, target);
      if (subject) try { await app.pursuit.executePivot(o.id, 'SITE_PROFILE', subject.id); } catch { /* no source available */ }
    }
    const a = app.analyzer.analyze(o.id)!;
    return { success: true, genome: a.kits.genomes[0] ?? null, genomes: a.kits.genomes };
  });
  r.get('/api/operations/:id/traceability', ({ params, query }) => legacyTrace(app, op(params.id).id, String(query.get('itemId') ?? '')));
  r.get('/api/operations/:id/predictive-leads', ({ params }) => predictiveRankings(app.planner.refreshLeads(op(params.id).id)));
  r.get('/api/operations/:id/learning-outcomes', ({ params }) => app.store.getLearningOutcomes(params.id));
  r.get('/api/operations/:id/financial', ({ params }) => analysis(params.id).financial.legacy);
  r.get('/api/operations/:id/cross-op', ({ params }) => analysis(params.id).crossOps);
  r.get('/api/operations/:id/contradictions', ({ params }) => analysis(params.id).contradictions);
  r.get('/api/operations/:id/briefing', ({ params }) => legacyBriefing(app, analysis(params.id)));
  r.get('/api/operations/:id/clusters', ({ params }) => { const a = analysis(params.id); return { clusters: a.graph.clusters, bridges: a.graph.bridges }; });
  r.post('/api/operations/:id/clusters/analyze', ({ params }) => { const a = app.analyzer.analyze(op(params.id).id)!; return { success: true, clusters: a.graph.clusters, bridges: a.graph.bridges }; });
  r.get('/api/download-zip', () => {
    for (const name of [`operation-hunter-v${HUNTER_VERSION}.zip`, 'operation-hunter-v1.0.zip']) {
      const p = path.resolve(process.cwd(), 'public', name);
      if (fs.existsSync(p)) return new RawResponse(200, fs.readFileSync(p), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"` });
    }
    throw new HunterError('NOT_FOUND', 'Zip file not found', 404);
  });

  // ------------------------------------------------------------------ pursuit
  r.get('/api/operations/:id/pursuit', ({ params }) => app.pursuit.legacyState(op(params.id).id));
  r.post('/api/operations/:id/pursuit/start', ({ params, body }) => { app.pursuit.start(op(params.id).id, body.config ?? {}); return { success: true, pursuit: app.pursuit.legacyState(params.id), run: app.store.latestRun(params.id) }; });
  r.post('/api/operations/:id/pursuit/pause', ({ params }) => { app.pursuit.setStatus(op(params.id).id, 'PAUSED'); return { success: true, pursuit: app.pursuit.legacyState(params.id), run: app.store.latestRun(params.id) }; });
  r.post('/api/operations/:id/pursuit/resume', ({ params }) => { app.pursuit.start(op(params.id).id); return { success: true, pursuit: app.pursuit.legacyState(params.id), run: app.store.latestRun(params.id) }; });
  r.post('/api/operations/:id/pursuit/stop', ({ params }) => { app.pursuit.setStatus(op(params.id).id, 'STOPPED'); return { success: true, pursuit: app.pursuit.legacyState(params.id), run: app.store.latestRun(params.id) }; });
  r.post('/api/operations/:id/pursuit/step', async ({ params }) => {
    const rec = await app.pursuit.step(op(params.id).id);
    app.analyzer.analyze(params.id);
    const log = rec?.result ? (await import('../engine/pursuit.js')).toHopLog(rec) : null;
    return { success: true, log, pivot: rec, pursuit: app.pursuit.legacyState(params.id) };
  });
  r.get('/api/v1/operations/:id/runs', ({ params }) => app.store.getRuns(op(params.id).id));

  // ------------------------------------------------------------------ seeds, evidence, hypotheses, leads
  r.post('/api/operations/:id/seeds', ({ params, body }) => {
    if (!body.value) throw new HunterError('VALIDATION', 'type and value are required');
    return app.operations.addSeed(op(params.id).id, { type: body.type, value: body.value, label: body.label, notes: body.notes });
  });
  r.post('/api/operations/:id/expand', async ({ params, body }) => {
    const res = await expandSeeds(app, op(params.id).id, body.seedId);
    return body.seedId ? { success: true, result: res } : { success: true, message: `Expanded ${res.expandedCount} seeds, gathered ${res.newEvidenceCount} new evidence items`, result: res };
  });
  r.post('/api/operations/:id/reconstruct', ({ params }) => { app.analyzer.analyze(op(params.id).id); return { success: true, operation: app.store.getOperation(params.id) }; });
  r.post('/api/operations/:id/hypothesize', ({ params }) => ({ success: true, hypotheses: app.analyzer.analyze(op(params.id).id)!.hypotheses }));
  r.post('/api/operations/:id/hypotheses', ({ params, body }) => {
    const o = op(params.id);
    if (!body.title) throw new HunterError('VALIDATION', 'title is required');
    const now = nowIso();
    const h = {
      id: newId('hyp', 10), operationId: o.id, title: String(body.title), description: String(body.description ?? ''), category: body.category || 'COMMON_OPERATOR', status: 'FORMULATED' as const,
      confidenceScore: 0.5, supportingEvidenceIds: body.supportingEvidenceIds ?? [], contradictingEvidenceIds: body.contradictingEvidenceIds ?? [], supportingObservations: [], contradictingObservations: [],
      conditionsToStrengthen: ['Corroborating technical artifact required.'], conditionsToWeaken: ['Discovery of independent operator credentials.'], conditionsToResolve: ['Direct evidence of control.'],
      competingHypothesisIds: body.competingHypothesisIds ?? [], aiGenerated: false, createdAt: now, updatedAt: now,
    };
    app.store.saveHypothesis(h, null);
    app.store.logAudit(o.id, 'ADD_HYPOTHESIS', h.title);
    app.store.touch(o.id, 'hypothesis');
    return h;
  });
  r.patch('/api/v1/operations/:id/hypotheses/:hypothesisId', ({ params, body }) => {
    const h = app.store.getHypothesis(params.hypothesisId);
    if (!h || h.operationId !== params.id) throw new HunterError('NOT_FOUND', 'Hypothesis not found', 404);
    const next = { ...h, ...(body.status ? { status: body.status, analystLocked: true, analystStatus: body.status } : {}), ...(body.unlock ? { analystLocked: false, analystStatus: undefined } : {}), updatedAt: nowIso() };
    app.store.saveHypothesis(next, h.templateKey ?? null);
    app.store.touch(params.id, 'hypothesis');
    return next;
  });
  r.post('/api/operations/:id/leads/generate', ({ params }) => ({ success: true, leads: app.planner.refreshLeads(op(params.id).id) }));
  r.post('/api/operations/:id/leads/:leadId/execute', async ({ params }) => {
    const rec = await app.pursuit.executeLead(op(params.id).id, params.leadId);
    app.analyzer.analyze(params.id);
    return { success: rec.status !== 'failed', message: rec.result?.simpleExplanation ?? rec.error ?? 'Executed', leadId: params.leadId, pivot: rec };
  });
  r.post('/api/operations/:id/evidence/:evidenceId/invalidate', ({ params, body }) => {
    if (!body.reason) throw new HunterError('VALIDATION', 'invalidation reason is required');
    const ev = app.store.getEvidenceById(params.evidenceId);
    if (!ev || ev.operationId !== params.id) throw new HunterError('NOT_FOUND', 'Evidence item not found', 404);
    const res = invalidateEvidence(app.store, params.evidenceId, String(body.reason));
    app.analyzer.analyze(params.id);
    return { success: true, message: `Evidence invalidated. Recalculated ${res.affectedRelationships} dependent relationship(s) and all hypotheses.` };
  });
  r.post('/api/v1/operations/:id/evidence/:evidenceId/reinstate', ({ params }) => {
    const ev = app.store.getEvidenceById(params.evidenceId);
    if (!ev || ev.operationId !== params.id) throw new HunterError('NOT_FOUND', 'Evidence item not found', 404);
    reinstateEvidence(app.store, params.evidenceId);
    app.analyzer.analyze(params.id);
    return { success: true };
  });
  r.post('/api/operations/:id/evidence', ({ params, body }) => {
    if (!body.source || !body.type || !body.originalObservation) throw new HunterError('VALIDATION', 'source, type, and originalObservation are required');
    const ev = app.operations.addManualEvidence(op(params.id).id, body);
    app.analyzer.analyze(params.id);
    return ev;
  });
  r.post('/api/operations/:id/ai/analyze', async ({ params, body }) => {
    const res = await ai.analyze(op(params.id).id, body.focusArea);
    app.store.logAudit(params.id, 'AI_ANALYSIS', `Generated investigation review (${res.engineUsed})`);
    return res;
  });
  r.post('/api/operations/:id/reappearance/check', ({ params, body }) => {
    if (!body.candidateValue || !body.candidateType) throw new HunterError('VALIDATION', 'candidateValue and candidateType are required');
    const res = app.reappearance.check(op(params.id).id, String(body.candidateValue), String(body.candidateType), body.features ?? {}, 'manual');
    app.analyzer.analyze(params.id);
    return res;
  });

  r.get('/api/v1/operations/:id/reappearance', ({ params }) => {
    const id = op(params.id).id;
    return { leads: app.store.getReappearanceLeads(id), fingerprints: app.store.getFingerprints(id) };
  });
  r.patch('/api/v1/operations/:id/reappearance/:leadId', ({ params, body }) => {
    const id = op(params.id).id;
    const lead = app.store.getReappearanceLeads(id).find(l => l.id === params.leadId);
    if (!lead) throw new HunterError('NOT_FOUND', 'Reappearance lead not found', 404);
    const allowed = ['OPEN', 'CONFIRMED_ROTATION', 'NEW_CLUSTER', 'FALSE_ALARM'];
    if (!allowed.includes(body.status)) throw new HunterError('VALIDATION', `status must be one of ${allowed.join(', ')}`);
    lead.status = body.status;
    app.store.saveReappearance(lead);
    app.analyzer.markDirty(id);
    return lead;
  });

  // ------------------------------------------------------------------ monitoring
  r.get('/api/monitoring', ({ query }) => app.store.getMonitors(query.get('operationId') ?? undefined));
  r.post('/api/monitoring', ({ body }) => {
    if (!body.operationId || !body.targetType || !body.targetValue) throw new HunterError('VALIDATION', 'operationId, targetType, and targetValue are required');
    return app.monitor.create({ operationId: body.operationId, targetType: body.targetType, targetValue: body.targetValue, frequencyMinutes: body.frequencyMinutes, notes: body.notes, pivotType: body.pivotType });
  });
  r.patch('/api/monitoring/:id', ({ params, body }) => app.monitor.update(params.id, body));
  r.post('/api/monitoring/run', async ({ body }) => {
    const opId = body.operationId ?? app.store.getOperations()[0]?.id;
    if (!opId) throw new HunterError('NOT_FOUND', 'No operation to monitor', 404);
    if (!app.store.getMonitors(opId).length) app.monitor.ensureDefaultMonitors(opId);
    const results = await app.monitor.runOperation(opId);
    app.analyzer.analyze(opId);
    const reapp = results.flatMap(x => x.reappearances)[0] ?? null;
    const changed = results.filter(x => x.changed).length;
    return { success: true, message: `Ran ${results.length} monitor(s); ${changed} reported changes.`, results: results.map(x => ({ monitor: x.monitor, changed: x.changed, newEntities: x.newEntities })), detectedLead: reapp };
  });

  // ------------------------------------------------------------------ settings, sources, learning
  r.get('/api/strategy-stats', () => app.strategy.legacyStats());
  r.get('/api/v1/strategy', () => app.strategy.table());
  r.get('/api/v1/collectors', () => app.collectors.describe(app.runtimeSettings(), app.mainBridge()));
  r.get('/api/v1/settings', () => {
    const s = app.runtimeSettings();
    const stored = app.store.allSettings() as Record<string, any>;
    return {
      networkMode: s.networkMode, networkModeLockedByEnv: Boolean(process.env.HUNTER_NETWORK_MODE), disabledCollectors: s.disabledCollectors, dnsServers: s.dnsServers,
      blockscoutNetworks: s.blockscoutNetworks, apiKeys: Object.fromEntries(Object.entries(s.apiKeys).map(([k, v]) => [k, v ? `${String(v).slice(0, 3)}…${String(v).slice(-2)}` : ''])),
      main: app.integration?.publicConfig() ?? { url: stored.main?.url ?? '', configured: false },
      dataDir: app.store.dataDir, version: HUNTER_VERSION,
    };
  });
  r.patch('/api/v1/settings', ({ body }) => {
    if (body.networkMode) app.store.setSetting('networkMode', body.networkMode === 'offline' ? 'offline' : 'live');
    if (Array.isArray(body.disabledCollectors)) app.store.setSetting('disabledCollectors', body.disabledCollectors);
    if (Array.isArray(body.dnsServers)) app.store.setSetting('dnsServers', body.dnsServers);
    if (body.blockscoutNetworks && typeof body.blockscoutNetworks === 'object') app.store.setSetting('blockscoutNetworks', body.blockscoutNetworks);
    if (body.apiKeys && typeof body.apiKeys === 'object') {
      const current = (app.store.getSetting<Record<string, string>>('apiKeys', {}));
      for (const [k, v] of Object.entries(body.apiKeys)) { if (v === null || v === '') delete current[k]; else if (typeof v === 'string' && !v.includes('…')) current[k] = v; }
      app.store.setSetting('apiKeys', current);
    }
    if (body.main && app.integration) app.integration.configure(body.main);
    return { ok: true };
  });
  r.get('/api/v1/glossary', () => GLOSSARY);
  r.get('/api/v1/labels', () => app.store.allLabels());
  r.post('/api/v1/labels', ({ body }) => {
    if (!body.value || !body.label) throw new HunterError('VALIDATION', 'value and label are required');
    app.store.setLabel(String(body.value), String(body.label), String(body.kind ?? 'other'), 'analyst');
    return { ok: true };
  });
  r.post('/api/v1/artifact/analyze', ({ body }) => {
    if (!body.html) throw new HunterError('VALIDATION', 'html is required');
    return analyzeHtml(String(body.html));
  });
  r.post('/api/v1/detect', ({ body }) => ({ value: body.value, type: detectType(String(body.value ?? '')) }));
  r.post('/api/v1/backup', () => {
    const file = path.join(app.store.dataDir, 'backups', `hunter-${nowIso().replace(/[:.]/g, '-')}.db`);
    app.store.backup(file);
    return { ok: true, file };
  });

  // ------------------------------------------------------------------ Main Platform integration
  r.get('/api/v1/integration/status', () => app.integration?.status() ?? { configured: false });
  r.post('/api/v1/integration/test', async () => {
    if (!app.integration) throw new HunterError('UNAVAILABLE', 'Integration worker not running', 503);
    return app.integration.testConnection();
  });
  r.post('/api/v1/integration/sync', async () => { if (!app.integration) throw new HunterError('UNAVAILABLE', 'Integration worker not running', 503); return app.integration.cycle(); });
  r.post('/api/v1/operations/:id/main/link', ({ params, body }) => {
    const o = op(params.id);
    if (!body.investigationId) throw new HunterError('VALIDATION', 'investigationId is required');
    app.operations.update(o.id, { mainInvestigationId: String(body.investigationId) });
    app.store.linkMain(o.id, 'investigation', String(body.investigationId), { linkedBy: 'analyst' });
    app.integration?.queueSync(o.id);
    return { ok: true };
  });
  r.post('/api/v1/operations/:id/main/send-inbox', async ({ params, body }) => {
    if (!app.integration?.configured()) throw new HunterError('MAIN_NOT_CONNECTED', 'Main Platform is not connected', 409);
    return app.integration.sendToInbox(op(params.id).id, String(body.value), String(body.reason ?? 'Operation Hunter lead'));
  });
  r.post('/api/v1/integration/webhook', async ({ body, req }) => {
    if (!app.integration) throw new HunterError('UNAVAILABLE', 'Integration worker not running', 503);
    return app.integration.handleWebhook(body, req.headers);
  });

  // ------------------------------------------------------------------ live updates (server-sent events)
  r.stream('/api/v1/events', ({ req, res, query }) => {
    const only = query.get('operationId');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: HUNTER_VERSION })}\n\n`);
    const send = (kind: string) => (evt: any) => { if (!only || evt.operationId === only) res.write(`event: ${kind}\ndata: ${JSON.stringify(evt)}\n\n`); };
    const onChange = send('change'), onAnalysis = send('analysis');
    app.store.on('change', onChange);
    app.store.on('analysis', onAnalysis);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); app.store.off('change', onChange); app.store.off('analysis', onAnalysis); });
  });
  return r;
}

function pick(summary: any) {
  if (!summary) return {};
  const { headline, depth, confidence, counts, pursuit, newFindings, alerts } = summary;
  return { headline, depth, confidence, counts, pursuit, newFindings, alerts };
}
