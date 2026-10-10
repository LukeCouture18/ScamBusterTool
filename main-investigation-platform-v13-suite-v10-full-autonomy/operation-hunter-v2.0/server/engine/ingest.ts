import type { Entity, Evidence, Relationship, RelationshipState } from '../types.js';
import type { Observation, ObservedEntity } from '../core/model.js';
import type { HunterStore } from '../core/store.js';
import { canonicalize, displayLabel } from '../core/canonical.js';
import { newId, nowIso, sha256, stableStringify, noisyOr, round, uniq } from '../core/util.js';
import { staticUbiquity, isCommodity } from './noise.js';

export interface IngestContext {
  operationId: string;
  collector: string;
  pivotId?: string;
  /** Depth of the pivot subject; new entities get depth + 1. */
  subjectDepth?: number;
  synthetic?: boolean;
  provenancePrefix?: string;
}

export interface IngestResult {
  newEntities: Entity[];
  newRelevantEntities: Entity[];
  updatedEntities: number;
  newEvidence: Evidence[];
  duplicateEvidence: number;
  newRelationships: Relationship[];
  touchedRelationships: number;
  entityIds: string[];
}

const LOW_SIGNAL_TYPES = new Set(['asn', 'registrar']);

function earlier(a?: string | null, b?: string | null) {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return a < b ? a : b;
}
function later(a?: string | null, b?: string | null) {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * The single path by which facts enter an operation.
 * Each observation becomes one immutable evidence record; entities are
 * resolved by canonical key; every relationship references the evidence that
 * supports it, and its confidence is the noisy-OR of that evidence.
 */
export function ingestObservations(store: HunterStore, observations: Observation[], ctx: IngestContext): IngestResult {
  const result: IngestResult = { newEntities: [], newRelevantEntities: [], updatedEntities: 0, newEvidence: [], duplicateEvidence: 0, newRelationships: [], touchedRelationships: 0, entityIds: [] };
  if (!observations.length) return result;
  store.tx(() => {
    for (const obs of observations) ingestOne(store, obs, ctx, result);
  });
  if (result.newEvidence.length || result.newEntities.length || result.newRelationships.length) store.touch(ctx.operationId, 'ingest');
  result.entityIds = uniq(result.entityIds);
  return result;
}

function resolveEntity(store: HunterStore, operationId: string, oe: ObservedEntity): Entity | undefined {
  const canonical = canonicalize(oe.type, oe.value);
  if (!canonical) return undefined;
  if (oe.type === 'wallet' || oe.type === 'contract') {
    return store.findEntity(operationId, 'wallet', oe.value) ?? store.findEntity(operationId, 'contract', oe.value);
  }
  if (oe.type === 'domain' || oe.type === 'hostname') {
    return store.findEntity(operationId, oe.type, oe.value) ?? store.findEntity(operationId, oe.type === 'domain' ? 'hostname' : 'domain', oe.value);
  }
  return store.findEntity(operationId, oe.type, oe.value);
}

function ingestOne(store: HunterStore, obs: Observation, ctx: IngestContext, result: IngestResult) {
  const at = obs.observedAt || nowIso();
  const hash = sha256(stableStringify({ kind: obs.kind, source: obs.source, raw: obs.raw, summary: obs.kind === 'dns_no_answer' ? '' : obs.summary }));
  const duplicate = store.findEvidenceByHash(ctx.operationId, hash);
  const baseDepth = ctx.subjectDepth ?? 0;

  // 1. entities
  const refToId = new Map<string, string>();
  for (const oe of obs.entities) {
    const existing = resolveEntity(store, ctx.operationId, oe);
    if (existing) {
      const next: Entity = { ...existing };
      next.metadata = { ...existing.metadata, ...stripUndefined(oe.metadata ?? {}) };
      if (oe.type === 'contract' && existing.type === 'wallet') next.metadata.isContract = true;
      next.firstSeen = earlier(existing.firstSeen, oe.firstSeen ?? (oe.ref === 'subject' ? undefined : at)) ?? existing.firstSeen;
      next.lastSeen = later(existing.lastSeen, oe.lastSeen ?? (oe.ref === 'subject' ? existing.lastSeen : at)) ?? existing.lastSeen;
      if (oe.isActive !== undefined && (oe.ref === 'subject' || (oe.lastSeen && oe.lastSeen >= existing.lastSeen))) next.isActive = oe.isActive;
      if (oe.ref !== 'subject') next.depth = Math.min(existing.depth ?? 0, baseDepth + 1);
      if (oe.label && (!existing.label || existing.label === existing.value)) next.label = oe.label;
      if (oe.tags?.length) next.tags = uniq([...(existing.tags ?? []), ...oe.tags]);
      const ub = staticUbiquity(next.type, next.value, next.metadata);
      if (ub.ubiquity > (next.ubiquity ?? 0)) {
        next.ubiquity = ub.ubiquity;
        if (ub.reason) next.metadata.ubiquityReason = ub.reason;
      }
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        store.updateEntity(next);
        result.updatedEntities++;
      }
      refToId.set(oe.ref, existing.id);
      result.entityIds.push(existing.id);
      continue;
    }
    const metadata: Record<string, any> = stripUndefined({ ...(oe.metadata ?? {}), discoveredBy: ctx.collector });
    const ub = staticUbiquity(oe.type, oe.value, metadata);
    if (ub.reason) metadata.ubiquityReason = ub.reason;
    const entity: Entity = {
      id: newId('ent', 10),
      operationId: ctx.operationId,
      type: oe.type,
      value: canonicalize(oe.type, oe.value) || oe.value,
      canonical: canonicalize(oe.type, oe.value),
      label: oe.label ?? displayLabel(oe.type, canonicalize(oe.type, oe.value) || oe.value, metadata),
      metadata,
      firstSeen: oe.firstSeen ?? at,
      lastSeen: oe.lastSeen ?? at,
      isActive: oe.isActive ?? true,
      isSeed: false,
      depth: oe.ref === 'subject' ? baseDepth : baseDepth + 1,
      ubiquity: ub.ubiquity,
      discoveredVia: ctx.pivotId,
      tags: oe.tags ?? [],
    };
    if (entity.type === 'wallet' || entity.type === 'contract') entity.value = oe.value.startsWith('0x') ? oe.value.toLowerCase() : oe.value;
    store.insertEntity(entity);
    result.newEntities.push(entity);
    if (!isCommodity(entity.ubiquity) && !LOW_SIGNAL_TYPES.has(entity.type)) result.newRelevantEntities.push(entity);
    refToId.set(oe.ref, entity.id);
    result.entityIds.push(entity.id);
  }

  // 2. evidence
  let evidence: Evidence;
  if (duplicate) {
    evidence = duplicate;
    result.duplicateEvidence++;
    const ids = [...refToId.values()].filter(id => !duplicate.relatedEntityIds.includes(id));
    if (ids.length) store.addEvidenceEntities(duplicate.id, ctx.operationId, ids);
  } else {
    evidence = {
      id: newId('ev', 10),
      operationId: ctx.operationId,
      source: obs.source,
      type: obs.kind,
      timestamp: at,
      originalObservation: obs.summary,
      rawData: obs.raw ?? {},
      sha256Hash: hash,
      provenance: ctx.provenancePrefix ? `${ctx.provenancePrefix} — ${obs.provenance}` : obs.provenance,
      confidence: round(obs.confidence, 3),
      status: 'valid',
      relatedEntityIds: uniq([...refToId.values()]),
      collector: ctx.collector,
      assertion: obs.assertion,
      synthetic: Boolean(ctx.synthetic || obs.raw?.synthetic),
      collectedAt: nowIso(),
      pivotId: ctx.pivotId,
    };
    store.insertEvidence(evidence);
    result.newEvidence.push(evidence);
  }

  // 3. relationships
  for (const orel of obs.relationships) {
    const sourceId = refToId.get(orel.from);
    const targetId = refToId.get(orel.to);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const conf = orel.confidence ?? obs.confidence;
    const when = orel.observedAt ?? at;
    const existing = store.findRelationship(ctx.operationId, sourceId, targetId, orel.type);
    if (existing) {
      const alreadyHas = existing.evidenceIds.includes(evidence.id);
      const evidenceIds = alreadyHas ? existing.evidenceIds : [...existing.evidenceIds, evidence.id];
      const sources = uniq([...(existing.sources ?? []), obs.source]);
      const wasContradicted = existing.state === 'CONTRADICTED';
      const confidence = alreadyHas ? existing.confidence : round(wasContradicted ? conf : noisyOr([existing.confidence, conf]), 3);
      const next: Relationship = {
        ...existing,
        evidenceIds,
        sources,
        confidence,
        state: nextState(existing.state, obs.assertion, sources.length, wasContradicted && !alreadyHas),
        firstObserved: earlier(existing.firstObserved, when) ?? existing.firstObserved,
        lastObserved: later(existing.lastObserved, when) ?? existing.lastObserved,
        assertion: rankAssertion(existing.assertion, obs.assertion),
      };
      store.upsertRelationshipRow(next);
      result.touchedRelationships++;
    } else {
      const rel: Relationship = {
        id: newId('rel', 10),
        operationId: ctx.operationId,
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        type: orel.type,
        state: nextState(undefined, obs.assertion, 1, false),
        confidence: round(conf, 3),
        reasoning: orel.reasoning,
        evidenceIds: [evidence.id],
        firstObserved: when,
        lastObserved: when,
        contradictingEvidenceIds: [],
        assertion: obs.assertion,
        sources: [obs.source],
      };
      store.upsertRelationshipRow(rel);
      result.newRelationships.push(rel);
    }
  }
}

function nextState(current: RelationshipState | undefined, assertion: string, sourceCount: number, revived: boolean): RelationshipState {
  if (current === 'CONTRADICTED' && !revived) return current;
  if (current === 'HYPOTHESIZED' && assertion === 'derived') return current;
  if (sourceCount >= 2 && assertion !== 'derived') return 'SUPPORTED';
  if (current === 'SUPPORTED') return current;
  if (assertion === 'derived') return current && current !== 'UNRESOLVED' ? current : 'CORRELATED';
  return 'OBSERVED';
}

function rankAssertion(a: string | undefined, b: string) {
  const order = ['derived', 'imported', 'analyst', 'observed', 'blockchain_fact'];
  return (order.indexOf(a ?? 'derived') >= order.indexOf(b) ? a : b) as Relationship['assertion'];
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Invalidate one evidence record and recompute everything that rested on it:
 * relationship confidences are recomputed from the remaining valid evidence
 * (noisy-OR); a relationship with no valid support becomes CONTRADICTED.
 */
export function invalidateEvidence(store: HunterStore, evidenceId: string, reason: string): { ok: boolean; affectedRelationships: number } {
  const ev = store.getEvidenceById(evidenceId);
  if (!ev) return { ok: false, affectedRelationships: 0 };
  let affected = 0;
  store.tx(() => {
    store.setEvidenceStatus(evidenceId, 'invalidated', reason);
    for (const rel of store.relationshipsForEvidence(evidenceId)) {
      if (rel.operationId !== ev.operationId) continue;
      affected++;
      const contradicting = uniq([...(rel.contradictingEvidenceIds ?? []), evidenceId]);
      const remaining = rel.evidenceIds.map(id => (id === evidenceId ? undefined : store.getEvidenceById(id))).filter((e): e is Evidence => Boolean(e && e.status === 'valid'));
      if (!remaining.length) {
        store.upsertRelationshipRow({ ...rel, state: 'CONTRADICTED', confidence: 0.05, contradictingEvidenceIds: contradicting, reasoning: rel.reasoning.includes('[INVALIDATED') ? rel.reasoning : `${rel.reasoning} [INVALIDATED: evidence ${evidenceId} marked invalid: "${reason}"]` });
      } else {
        const sources = uniq(remaining.map(e => e.source));
        const confidence = round(noisyOr(remaining.map(e => e.confidence)) * 0.9, 3);
        store.upsertRelationshipRow({ ...rel, confidence, sources, contradictingEvidenceIds: contradicting, state: sources.length >= 2 ? 'SUPPORTED' : 'HYPOTHESIZED' });
      }
    }
    store.addChange(ev.operationId, 'evidence_invalidated', `Evidence ${evidenceId} invalidated: ${reason}`, { evidenceId, affected });
    store.logAudit(ev.operationId, 'INVALIDATE_EVIDENCE', `Invalidated evidence ${evidenceId}: ${reason}`);
  });
  store.touch(ev.operationId, 'evidence_invalidated');
  return { ok: true, affectedRelationships: affected };
}

export function reinstateEvidence(store: HunterStore, evidenceId: string): boolean {
  const ev = store.getEvidenceById(evidenceId);
  if (!ev) return false;
  store.tx(() => {
    store.setEvidenceStatus(evidenceId, 'valid', null);
    for (const rel of store.relationshipsForEvidence(evidenceId)) {
      const valid = rel.evidenceIds.map(id => store.getEvidenceById(id)).filter((e): e is Evidence => Boolean(e && e.status === 'valid'));
      const sources = uniq(valid.map(e => e.source));
      store.upsertRelationshipRow({
        ...rel,
        contradictingEvidenceIds: (rel.contradictingEvidenceIds ?? []).filter(id => id !== evidenceId),
        confidence: round(noisyOr(valid.map(e => e.confidence)), 3),
        sources,
        state: sources.length >= 2 ? 'SUPPORTED' : 'OBSERVED',
        reasoning: rel.reasoning.replace(/ \[INVALIDATED:[^\]]*\]/, ''),
      });
    }
    store.addChange(ev.operationId, 'evidence_reinstated', `Evidence ${evidenceId} reinstated`, { evidenceId });
    store.logAudit(ev.operationId, 'REINSTATE_EVIDENCE', `Reinstated evidence ${evidenceId}`);
  });
  store.touch(ev.operationId, 'evidence_reinstated');
  return true;
}
