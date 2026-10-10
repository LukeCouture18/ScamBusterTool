import type { HunterApp } from '../app.js';
import type { ScoredCandidate } from '../pursuit/allocator.js';
import { BRANCH_LABEL, branchQuestion, BranchKind } from '../pursuit/branches.js';
import { PIVOTS } from '../collectors/pivots.js';
import { FACET_LABEL } from '../model/facets.js';
import { HunterError, round, plural } from '../core/util.js';

/**
 * v2.0 views over the intelligence layer: the living model and its history,
 * membership with explanations (and your verdicts), the facet ledger, pursuit
 * branches, standing hunts, contradictions, what Hunter has learned, and the
 * few leads worth your attention.
 */

export interface NextLead {
  key: string; title: string; question: string; why: string[]; expected: number; score: number;
  pivotType: string; label: string; entityId: string; targetValue: string; targetType: string; branchKind: string; cost: string;
  doesNotProve: string;
}

const LEAD_CAVEAT: Record<string, string> = {
  hosting: 'Sites on the same nameserver or server are often unrelated customers of the same provider.',
  certificates: 'A shared certificate ties names to one certificate request, not necessarily to one operator.',
  kit: 'Sites loading the same file may be other customers of the same kit.',
  operator: 'Reused settings can be copied or planted; each hit is judged on its other settings too.',
  money: 'Money moving between addresses does not prove shared ownership.',
  search: 'Names or titles that fit the pattern are only candidates until verified.',
  site: 'Profiling a site shows what it is today, not who runs it.',
  delegated: 'Main\'s check is a manual review, not an automated verdict.',
};

/** The best next investigative steps, by expected progress per unit of cost (no exploration noise). */
export function nextLeads(app: HunterApp, operationId: string, limit = 5): NextLead[] {
  const candidates = app.planner.candidates(operationId).filter(c => !c.blockedReason);
  if (!candidates.length) return [];
  const scored = app.allocator.score(operationId, candidates, { explore: false }).sort((a, b) => b.expected - a.expected);
  const picked: ScoredCandidate[] = [];
  const perKind = new Map<string, number>();
  for (const c of scored) {
    if (picked.length >= limit) break;
    if ((perKind.get(c.branchKind) ?? 0) >= 2) continue;
    if (picked.some(p => p.entity.id === c.entity.id)) continue;
    picked.push(c);
    perKind.set(c.branchKind, (perKind.get(c.branchKind) ?? 0) + 1);
  }
  return picked.map(c => ({
    key: c.key, title: `${c.spec.label}: ${c.entity.label && c.entity.label !== c.entity.value ? c.entity.label : c.entity.value}`,
    question: branchQuestion(c.branchKind as BranchKind, c.entity), why: c.why.slice(0, 3), expected: round(c.expected, 2), score: c.score,
    pivotType: c.spec.pivotType, label: c.spec.label, entityId: c.entity.id, targetValue: c.entity.value, targetType: c.entity.type, branchKind: c.branchKind, cost: c.spec.cost,
    doesNotProve: LEAD_CAVEAT[c.branchKind] ?? '',
  }));
}

export function modelPayload(app: HunterApp, operationId: string) {
  const a = app.analyzer.get(operationId);
  if (!a) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
  const versions = app.intel.modelVersions(operationId, 30);
  return {
    model: a.model,
    version: a.modelVersion,
    versions: versions.map(v => ({ version: v.version, createdAt: v.createdAt, trigger: v.trigger, summary: v.summary, changes: v.diff?.changes ?? [] })),
    contradictions: app.intel.contradictions(operationId),
    hunts: huntsPayload(app, operationId),
    branches: branchesPayload(app, operationId).summary,
  };
}

export function modelVersionPayload(app: HunterApp, operationId: string, version: number) {
  const v = app.intel.modelVersion(operationId, version);
  if (!v) throw new HunterError('NOT_FOUND', `Model version ${version} not found`, 404);
  return v;
}

export function membershipPayload(app: HunterApp, operationId: string, opts: { type?: string | null; status?: string | null } = {}) {
  const a = app.analyzer.get(operationId);
  if (!a) throw new HunterError('NOT_FOUND', 'Operation not found', 404);
  const rows = a.membership.members
    .filter(m => (!opts.type || m.type === opts.type) && (!opts.status || m.status === opts.status))
    .map(m => ({ ...m, since: app.intel.membershipOf(operationId, m.entityId)?.since ?? null }));
  const indicators = Object.values(a.membership.indicators).map(i => ({ ...i, carriers: i.carriers.map(id => app.store.getEntity(id)?.value ?? id), inconsistent: i.inconsistent.map(id => app.store.getEntity(id)?.value ?? id) }));
  return { members: rows, indicators, otherGroups: a.model.otherGroups, iterations: a.membership.iterations, calibration: app.calibration() };
}

/** Record your verdict on whether an entity belongs to the operation; the model re-runs and learns from it. */
export function setMembershipVerdict(app: HunterApp, operationId: string, entityId: string, verdict: 'member' | 'not_member' | null, reason: string | null) {
  const e = app.store.getEntity(entityId);
  if (!e || e.operationId !== operationId) throw new HunterError('NOT_FOUND', 'Entity not found in this operation', 404);
  if (verdict && !['member', 'not_member'].includes(verdict)) throw new HunterError('BAD_REQUEST', 'verdict must be member, not_member or null', 400);
  const current = app.analyzer.peek(operationId)?.membership.byId[entityId];
  app.intel.setVerdict(operationId, entityId, verdict, reason, current?.factors ?? []);
  app.store.addChange(operationId, 'analyst', verdict ? `You marked ${e.value} as ${verdict === 'member' ? 'part of' : 'not part of'} the operation${reason ? ` — ${reason}` : ''}` : `You cleared your verdict on ${e.value}`, { entityId });
  app.store.touch(operationId, 'membership_verdict');
  const a = app.analyzer.analyze(operationId)!;
  return { assessment: a.membership.byId[entityId] ?? null, modelVersion: a.modelVersion, diff: a.modelDiff };
}

export function facetsPayload(app: HunterApp, operationId: string, entityId?: string | null) {
  const values = app.intel.facetValues(operationId, entityId ?? undefined);
  const changes = app.intel.facetChanges(operationId, { entityId: entityId ?? undefined, limit: 300 });
  const name = (id: string) => app.store.getEntity(id)?.value ?? id;
  return {
    values: values.map(v => ({ ...v, entity: name(v.entityId), label: FACET_LABEL[v.facet] ?? v.facet })),
    changes: changes.map(c => ({ ...c, entity: name(c.entityId), label: FACET_LABEL[c.facet] ?? c.facet })),
  };
}

export function branchesPayload(app: HunterApp, operationId: string) {
  const branches = app.intel.getBranches(operationId).map(b => {
    const e = app.store.getEntity(b.anchor);
    return { ...b, anchorValue: e?.value ?? b.anchor, label: BRANCH_LABEL[b.kind as BranchKind] ?? b.kind, yieldPerLookup: b.stats.pulls ? round(b.stats.progress / b.stats.pulls, 2) : 0 };
  }).sort((a, b) => b.stats.progress - a.stats.progress);
  const summary: Record<string, { branches: number; active: number; saturated: number; exhausted: number; revisit: number; blocked: number; progress: number; lookups: number }> = {};
  for (const b of branches) {
    const s = summary[b.kind] ??= { branches: 0, active: 0, saturated: 0, exhausted: 0, revisit: 0, blocked: 0, progress: 0, lookups: 0 };
    s.branches++; s.progress = round(s.progress + b.stats.progress, 1); s.lookups += b.stats.pulls;
    if (b.status in s) (s as any)[b.status]++;
  }
  return { branches, summary };
}

export function huntsPayload(app: HunterApp, operationId?: string) {
  return app.intel.getHunts(operationId).map(h => ({ ...h, label: PIVOTS[h.kind]?.label ?? h.kind, target: h.data.target ?? h.query, why: h.data.why ?? '', cadence: h.cadenceMinutes >= 1440 ? `every ${round(h.cadenceMinutes / 1440, 1)} days` : `every ${round(h.cadenceMinutes / 60, 1)} hours` }));
}

export function learnerPayload(app: HunterApp) {
  const table = app.allocator.learner.table();
  const byPivot = new Map<string, { pulls: number; progress: number; credit: number }>();
  for (const r of table.filter(x => x.context === '*')) byPivot.set(r.pivotType, { pulls: r.pulls, progress: r.progressPerPull, credit: r.creditPerPull });
  return {
    summary: [...byPivot.entries()].map(([pivotType, v]) => ({ pivotType, label: PIVOTS[pivotType]?.label ?? pivotType, ...v })).sort((a, b) => b.progress + b.credit - (a.progress + a.credit)),
    contexts: table.filter(x => x.context !== '*').slice(0, 200),
    calibration: app.calibration(),
    note: 'Progress is what a lookup moved the reconstruction forward (new linked sites, operator settings, money destinations, verified sites, real changes) — not how much data it returned. Credit arrives later, when the analysis decides a discovery really belonged to the operation.',
  };
}

/** One-line summaries for the Brief (and for Main). */
export function briefIntel(app: HunterApp, operationId: string) {
  const a = app.analyzer.peek(operationId);
  if (!a?.model) return null;
  const m = a.model;
  const openContradictions = app.intel.contradictions(operationId).filter(c => c.status === 'open');
  const hunts = app.intel.getHunts(operationId).filter(h => h.status === 'active');
  return {
    status: m.status, statusReason: m.statusReason, counts: m.counts,
    forecast: { status: m.forecast.status, nextExpectedAt: m.forecast.nextExpectedAt, confidence: m.forecast.confidence, basis: m.forecast.basis },
    explanations: m.hypotheses.map(h => ({ key: h.key, question: h.question, leading: h.leading, margin: h.margin, runnerUp: h.hypotheses[1]?.label ?? null, test: h.discriminatingTest })),
    unknowns: m.unknowns,
    contradictions: { open: openContradictions.length, top: openContradictions.sort((x, y) => y.severity - x.severity).slice(0, 3).map(c => c.summary) },
    hunts: { active: hunts.length, nextRunAt: hunts.map(h => h.nextRunAt).sort()[0] ?? null, summary: hunts.length ? `${plural(hunts.length, 'standing hunt')} watching for the operation's return` : 'No standing hunts yet' },
    modelVersion: a.modelVersion,
    lastChange: app.intel.latestModel(operationId)?.summary ?? null,
  };
}
