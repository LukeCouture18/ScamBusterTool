import type { HunterStore } from '../core/store.js';
import type { Entity, Evidence, OperationProfile, Relationship, Seed } from '../types.js';
import { isCommodity } from '../engine/noise.js';

/** An immutable snapshot of one operation, loaded once per analysis pass. */
export interface OpData {
  op: OperationProfile;
  seeds: Seed[];
  entities: Entity[];
  byId: Map<string, Entity>;
  relationships: Relationship[];          // excludes CONTRADICTED
  contradicted: Relationship[];
  evidence: Evidence[];                   // valid only
  invalidEvidence: Evidence[];
  evidenceById: Map<string, Evidence>;
  out: Map<string, Relationship[]>;
  in: Map<string, Relationship[]>;
  evidenceByEntity: Map<string, Evidence[]>;
  crossIndex: Map<string, Set<string>>;   // canonical -> operation ids (all operations)
  opNames: Map<string, { code: string; name: string; isDemo: boolean }>;
}

export function loadOpData(store: HunterStore, operationId: string): OpData | null {
  const op = store.getOperation(operationId);
  if (!op) return null;
  const entities = store.getEntities(op.id);
  const byId = new Map(entities.map(e => [e.id, e]));
  const allRels = store.getRelationships(op.id).filter(r => byId.has(r.sourceEntityId) && byId.has(r.targetEntityId));
  const allEvidence = store.getEvidence(op.id);
  const evidence = allEvidence.filter(e => e.status === 'valid');
  const relationships = allRels.filter(r => r.state !== 'CONTRADICTED');
  const out = new Map<string, Relationship[]>();
  const inn = new Map<string, Relationship[]>();
  for (const r of relationships) {
    (out.get(r.sourceEntityId) ?? out.set(r.sourceEntityId, []).get(r.sourceEntityId)!).push(r);
    (inn.get(r.targetEntityId) ?? inn.set(r.targetEntityId, []).get(r.targetEntityId)!).push(r);
  }
  const evidenceByEntity = new Map<string, Evidence[]>();
  for (const ev of evidence) for (const id of ev.relatedEntityIds) (evidenceByEntity.get(id) ?? evidenceByEntity.set(id, []).get(id)!).push(ev);
  const opNames = new Map(store.getOperations().map(o => [o.id, { code: o.code, name: o.name, isDemo: Boolean(o.isDemo) }]));
  return {
    op, seeds: store.getSeeds(op.id), entities, byId, relationships, contradicted: allRels.filter(r => r.state === 'CONTRADICTED'),
    evidence, invalidEvidence: allEvidence.filter(e => e.status !== 'valid'), evidenceById: new Map(allEvidence.map(e => [e.id, e])),
    out, in: inn, evidenceByEntity, crossIndex: store.canonicalIndex(), opNames,
  };
}

export function neighbors(data: OpData, entityId: string, types?: Relationship['type'][]): Array<{ entity: Entity; rel: Relationship; direction: 'out' | 'in' }> {
  const res: Array<{ entity: Entity; rel: Relationship; direction: 'out' | 'in' }> = [];
  for (const r of data.out.get(entityId) ?? []) if (!types || types.includes(r.type)) { const e = data.byId.get(r.targetEntityId); if (e) res.push({ entity: e, rel: r, direction: 'out' }); }
  for (const r of data.in.get(entityId) ?? []) if (!types || types.includes(r.type)) { const e = data.byId.get(r.sourceEntityId); if (e) res.push({ entity: e, rel: r, direction: 'in' }); }
  return res;
}

export function relevant(e: Entity): boolean {
  return !isCommodity(e.ubiquity) && !e.metadata?.commodity && !e.metadata?.unsupported;
}

export function evidenceIdsFor(rels: Relationship[], limit = 12): string[] {
  const out: string[] = [];
  for (const r of rels) for (const id of r.evidenceIds) if (!out.includes(id)) out.push(id);
  return out.slice(0, limit);
}

/** Other operations that also contain this entity's canonical value. */
export function otherOperations(data: OpData, entity: Entity): string[] {
  const set = data.crossIndex.get(entity.canonical ?? entity.value);
  return set ? [...set].filter(id => id !== data.op.id) : [];
}
