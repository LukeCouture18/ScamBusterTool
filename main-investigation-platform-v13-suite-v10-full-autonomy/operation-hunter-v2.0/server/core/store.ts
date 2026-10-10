import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  OperationProfile, Seed, Evidence, Entity, Relationship, Hypothesis, Lead, ReappearanceFingerprint,
  ReappearanceLead, MonitoringProbe, LearningOutcomeRecord,
} from '../types.js';
import type { PursuitRun, PivotRecord, Finding, Checkpoint, ChangeRecord, PivotResultSummary } from './model.js';
import { MIGRATIONS } from './migrations.js';
import { newId, nowIso, parseJson } from './util.js';
import { canonicalize } from './canonical.js';

export const STORE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface StoreOptions {
  dataDir?: string;
  filename?: string;          // ':memory:' for tests
  readonly?: boolean;
}

type Row = Record<string, any>;

const j = (value: unknown) => JSON.stringify(value ?? null);

/**
 * Durable storage for Operation Hunter, backed by SQLite (node:sqlite).
 *
 * - WAL journaling; every multi-record change runs in a transaction.
 * - Ordered migrations recorded in schema_migrations.
 * - Each operation carries a revision counter; analyses are cached per revision.
 * - Emits `change` events so the UI can refresh live (server-sent events).
 */
export class HunterStore extends EventEmitter {
  readonly db: DatabaseSync;
  readonly file: string;
  readonly dataDir: string;
  private statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(options: StoreOptions = {}) {
    super();
    this.setMaxListeners(100);
    this.dataDir = options.dataDir ?? process.env.HUNTER_DATA_DIR ?? path.resolve(process.cwd(), 'data');
    const filename = options.filename ?? 'hunter.db';
    if (filename === ':memory:') {
      this.file = ':memory:';
    } else {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.file = path.join(this.dataDir, filename);
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (this.file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    this.migrate();
  }

  // ---------------------------------------------------------------- basics
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: any[]) {
    return this.stmt(sql).run(...params.map(norm));
  }

  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return (this.stmt(sql).get(...params.map(norm)) as T | undefined) ?? undefined;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.stmt(sql).all(...params.map(norm)) as T[];
  }

  /** Run fn inside a transaction (nested calls use savepoints). */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const name = `sp${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.txDepth--;
      try { this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* already rolled back */ }
      throw error;
    }
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map(r => Number(r.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.tx(() => {
        this.db.exec(migration.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, nowIso());
      });
    }
  }

  schemaVersion(): number {
    return Number(this.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')?.v ?? 0);
  }

  integrityCheck(): string {
    return String(this.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check ?? 'unknown');
  }

  /** Online backup to a file (VACUUM INTO). */
  backup(targetFile: string) {
    if (this.file === ':memory:') throw new Error('Cannot back up an in-memory store');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    this.db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
    return targetFile;
  }

  // ---------------------------------------------------------------- meta / settings
  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key=?', key)?.value;
  }

  setMeta(key: string, value: string) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key);
    return row ? parseJson<T>(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, j(value), nowIso());
  }

  allSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.all<{ key: string; value: string }>('SELECT key, value FROM settings')) out[row.key] = parseJson(row.value, null);
    return out;
  }

  // ---------------------------------------------------------------- change tracking
  touch(operationId: string, kind: string) {
    this.run('UPDATE operations SET revision = revision + 1, updated_at = ? WHERE id = ?', nowIso(), operationId);
    this.emit('change', { operationId, kind, at: nowIso() });
  }

  revision(operationId: string): number {
    return Number(this.get<{ revision: number }>('SELECT revision FROM operations WHERE id=?', operationId)?.revision ?? 0);
  }

  logAudit(operationId: string, action: string, details: string) {
    this.run('INSERT INTO audit_log (id, operation_id, action, details, timestamp) VALUES (?, ?, ?, ?, ?)', newId('audit', 8), operationId, action, details, nowIso());
  }

  getAuditLogs(operationId?: string, limit = 300) {
    const rows = operationId
      ? this.all('SELECT * FROM audit_log WHERE operation_id=? ORDER BY timestamp DESC, rowid DESC LIMIT ?', operationId, limit)
      : this.all('SELECT * FROM audit_log ORDER BY timestamp DESC, rowid DESC LIMIT ?', limit);
    return rows.map(r => ({ id: r.id, operationId: r.operation_id, action: r.action, details: r.details, timestamp: r.timestamp }));
  }

  addChange(operationId: string, kind: string, summary: string, data: Record<string, any> = {}): ChangeRecord {
    const rec: ChangeRecord = { id: newId('chg', 10), operationId, at: nowIso(), kind, summary, data };
    this.run('INSERT INTO changes (id, operation_id, at, kind, summary, data) VALUES (?, ?, ?, ?, ?, ?)', rec.id, operationId, rec.at, kind, summary, j(data));
    return rec;
  }

  getChanges(operationId: string, since?: string | null, limit = 200): ChangeRecord[] {
    const rows = since
      ? this.all('SELECT * FROM changes WHERE operation_id=? AND at>? ORDER BY at DESC, rowid DESC LIMIT ?', operationId, since, limit)
      : this.all('SELECT * FROM changes WHERE operation_id=? ORDER BY at DESC, rowid DESC LIMIT ?', operationId, limit);
    return rows.map(r => ({ id: r.id, operationId: r.operation_id, at: r.at, kind: r.kind, summary: r.summary, data: parseJson(r.data, {}) }));
  }

  // ---------------------------------------------------------------- operations
  private mapOperation(r: Row): OperationProfile {
    const profile = parseJson<Record<string, any>>(r.profile, {});
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      targetType: r.target_type,
      initialSeed: r.initial_seed,
      status: r.status,
      summary: r.summary ?? '',
      establishedFacts: profile.establishedFacts ?? [],
      uncertainties: profile.uncertainties ?? [],
      recentChanges: profile.recentChanges ?? [],
      evidenceGaps: profile.evidenceGaps ?? [],
      unresolvedQuestions: profile.unresolvedQuestions ?? [],
      recommendedNextSteps: profile.recommendedNextSteps ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      isDemo: Boolean(r.is_demo),
      mainInvestigationId: r.main_investigation_id ?? null,
      lastViewedAt: r.last_viewed_at ?? null,
      revision: Number(r.revision ?? 0),
      tags: parseJson<string[]>(r.tags, []),
      narrative: profile.narrative ?? '',
    };
  }

  getOperations(): OperationProfile[] {
    return this.all('SELECT * FROM operations ORDER BY is_demo ASC, updated_at DESC').map(r => this.mapOperation(r));
  }

  getOperation(id: string): OperationProfile | undefined {
    const r = this.get('SELECT * FROM operations WHERE id=? OR code=?', id, id);
    return r ? this.mapOperation(r) : undefined;
  }

  insertOperation(op: OperationProfile) {
    const profile = {
      establishedFacts: op.establishedFacts, uncertainties: op.uncertainties, recentChanges: op.recentChanges,
      evidenceGaps: op.evidenceGaps, unresolvedQuestions: op.unresolvedQuestions, recommendedNextSteps: op.recommendedNextSteps,
      narrative: op.narrative ?? '',
    };
    this.run(`INSERT INTO operations (id, code, name, target_type, initial_seed, status, summary, profile, is_demo, main_investigation_id, last_viewed_at, revision, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      op.id, op.code, op.name, op.targetType, op.initialSeed, op.status, op.summary, j(profile), op.isDemo ? 1 : 0,
      op.mainInvestigationId ?? null, op.lastViewedAt ?? null, op.revision ?? 0, j(op.tags ?? []), op.createdAt, op.updatedAt);
  }

  updateOperation(id: string, updates: Partial<OperationProfile>): OperationProfile | undefined {
    const current = this.getOperation(id);
    if (!current) return undefined;
    const next = { ...current, ...updates, updatedAt: nowIso() };
    const profile = {
      establishedFacts: next.establishedFacts, uncertainties: next.uncertainties, recentChanges: next.recentChanges,
      evidenceGaps: next.evidenceGaps, unresolvedQuestions: next.unresolvedQuestions, recommendedNextSteps: next.recommendedNextSteps,
      narrative: next.narrative ?? '',
    };
    this.run(`UPDATE operations SET code=?, name=?, target_type=?, initial_seed=?, status=?, summary=?, profile=?, is_demo=?, main_investigation_id=?, last_viewed_at=?, tags=?, updated_at=? WHERE id=?`,
      next.code, next.name, next.targetType, next.initialSeed, next.status, next.summary, j(profile), next.isDemo ? 1 : 0,
      next.mainInvestigationId ?? null, next.lastViewedAt ?? null, j(next.tags ?? []), next.updatedAt, current.id);
    return this.getOperation(current.id);
  }

  deleteOperation(id: string) {
    this.tx(() => {
      for (const table of OPERATION_TABLES) this.run(`DELETE FROM ${table} WHERE operation_id=?`, id);
      this.run('DELETE FROM operations WHERE id=?', id);
    });
    this.emit('change', { operationId: id, kind: 'deleted', at: nowIso() });
  }

  // ---------------------------------------------------------------- seeds
  private mapSeed(r: Row): Seed {
    return { id: r.id, operationId: r.operation_id, type: r.type, value: r.value, label: r.label ?? undefined, addedAt: r.added_at, status: r.status, notes: r.notes ?? undefined };
  }

  getSeeds(operationId: string): Seed[] {
    return this.all('SELECT * FROM seeds WHERE operation_id=? ORDER BY added_at', operationId).map(r => this.mapSeed(r));
  }

  insertSeed(seed: Seed & { source?: string }) {
    this.run('INSERT INTO seeds (id, operation_id, type, value, canonical, label, notes, status, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      seed.id, seed.operationId, seed.type, seed.value, canonicalize(seed.type, seed.value), seed.label ?? null, seed.notes ?? null, seed.status, seed.source ?? 'analyst', seed.addedAt);
  }

  updateSeedStatus(id: string, status: Seed['status']) {
    this.run('UPDATE seeds SET status=? WHERE id=?', status, id);
  }

  // ---------------------------------------------------------------- entities
  private mapEntity(r: Row): Entity {
    return {
      id: r.id, operationId: r.operation_id, type: r.type, value: r.value, label: r.label, metadata: parseJson(r.metadata, {}),
      firstSeen: r.first_seen, lastSeen: r.last_seen, isActive: Boolean(r.is_active), isSeed: Boolean(r.is_seed),
      canonical: r.canonical, depth: Number(r.depth ?? 0), ubiquity: Number(r.ubiquity ?? 0), discoveredVia: r.discovered_via ?? undefined,
      tags: parseJson<string[]>(r.tags, []),
    };
  }

  getEntities(operationId: string): Entity[] {
    return this.all('SELECT * FROM entities WHERE operation_id=? ORDER BY depth, first_seen', operationId).map(r => this.mapEntity(r));
  }

  getEntity(id: string): Entity | undefined {
    const r = this.get('SELECT * FROM entities WHERE id=?', id);
    return r ? this.mapEntity(r) : undefined;
  }

  findEntity(operationId: string, type: string, value: string): Entity | undefined {
    const r = this.get('SELECT * FROM entities WHERE operation_id=? AND type=? AND canonical=?', operationId, type, canonicalize(type, value));
    return r ? this.mapEntity(r) : undefined;
  }

  findEntityByCanonical(operationId: string, canonical: string): Entity | undefined {
    const r = this.get('SELECT * FROM entities WHERE operation_id=? AND canonical=? ORDER BY is_seed DESC LIMIT 1', operationId, canonical);
    return r ? this.mapEntity(r) : undefined;
  }

  /** All operations that contain an entity with this canonical key. */
  operationsWithCanonical(canonical: string): Array<{ operationId: string; entityId: string; type: string }> {
    return this.all("SELECT operation_id, id, type FROM entities WHERE canonical=? AND COALESCE(json_extract(metadata,'$.linkRole'),'core') IN ('core','context')", canonical).map(r => ({ operationId: r.operation_id, entityId: r.id, type: r.type }));
  }

  /** Global index: how many operations share each canonical value. */
  canonicalIndex(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const r of this.all<{ canonical: string; operation_id: string }>("SELECT canonical, operation_id FROM entities WHERE COALESCE(json_extract(metadata,'$.linkRole'),'core') IN ('core','context')")) {
      let set = map.get(r.canonical);
      if (!set) map.set(r.canonical, (set = new Set()));
      set.add(r.operation_id);
    }
    return map;
  }

  insertEntity(e: Entity) {
    this.run(`INSERT INTO entities (id, operation_id, type, value, canonical, label, metadata, first_seen, last_seen, is_active, is_seed, depth, ubiquity, discovered_via, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, e.operationId, e.type, e.value, e.canonical ?? canonicalize(e.type, e.value), e.label, j(e.metadata ?? {}), e.firstSeen, e.lastSeen,
      e.isActive ? 1 : 0, e.isSeed ? 1 : 0, e.depth ?? 0, e.ubiquity ?? 0, e.discoveredVia ?? null, j(e.tags ?? []));
  }

  updateEntity(e: Entity) {
    this.run(`UPDATE entities SET value=?, label=?, metadata=?, first_seen=?, last_seen=?, is_active=?, is_seed=?, depth=?, ubiquity=?, discovered_via=?, tags=? WHERE id=?`,
      e.value, e.label, j(e.metadata ?? {}), e.firstSeen, e.lastSeen, e.isActive ? 1 : 0, e.isSeed ? 1 : 0, e.depth ?? 0, e.ubiquity ?? 0,
      e.discoveredVia ?? null, j(e.tags ?? []), e.id);
  }

  countEntities(operationId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) n FROM entities WHERE operation_id=?', operationId)?.n ?? 0);
  }

  // ---------------------------------------------------------------- evidence
  private mapEvidence(r: Row): Evidence {
    return {
      id: r.id, operationId: r.operation_id, source: r.source, type: r.type, timestamp: r.observed_at, originalObservation: r.observation,
      rawData: parseJson(r.raw, {}), sha256Hash: r.sha256, provenance: r.provenance, confidence: Number(r.confidence), status: r.status,
      invalidationReason: r.invalidation_reason ?? undefined, relatedEntityIds: parseJson<string[]>(r.related_entity_ids, []),
      collector: r.collector ?? undefined, assertion: r.assertion ?? undefined, synthetic: Boolean(r.synthetic), collectedAt: r.collected_at,
      pivotId: r.pivot_id ?? undefined,
    };
  }

  getEvidence(operationId: string): Evidence[] {
    return this.all('SELECT * FROM evidence WHERE operation_id=? ORDER BY observed_at DESC, rowid DESC', operationId).map(r => this.mapEvidence(r));
  }

  getEvidenceById(id: string): Evidence | undefined {
    const r = this.get('SELECT * FROM evidence WHERE id=?', id);
    return r ? this.mapEvidence(r) : undefined;
  }

  findEvidenceByHash(operationId: string, hash: string): Evidence | undefined {
    const r = this.get('SELECT * FROM evidence WHERE operation_id=? AND sha256=? LIMIT 1', operationId, hash);
    return r ? this.mapEvidence(r) : undefined;
  }

  insertEvidence(ev: Evidence) {
    this.run(`INSERT INTO evidence (id, operation_id, source, type, collector, observed_at, collected_at, observation, raw, sha256, provenance, confidence, status, invalidation_reason, related_entity_ids, assertion, synthetic, pivot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ev.id, ev.operationId, ev.source, ev.type, ev.collector ?? null, ev.timestamp, ev.collectedAt ?? nowIso(), ev.originalObservation, j(ev.rawData ?? {}),
      ev.sha256Hash, ev.provenance, ev.confidence, ev.status, ev.invalidationReason ?? null, j(ev.relatedEntityIds ?? []), ev.assertion ?? 'observed',
      ev.synthetic ? 1 : 0, ev.pivotId ?? null);
    for (const entityId of ev.relatedEntityIds ?? []) {
      this.run('INSERT OR IGNORE INTO evidence_entities (evidence_id, entity_id, operation_id) VALUES (?, ?, ?)', ev.id, entityId, ev.operationId);
    }
  }

  addEvidenceEntities(evidenceId: string, operationId: string, entityIds: string[]) {
    const ev = this.getEvidenceById(evidenceId);
    if (!ev) return;
    const merged = Array.from(new Set([...(ev.relatedEntityIds ?? []), ...entityIds]));
    this.run('UPDATE evidence SET related_entity_ids=? WHERE id=?', j(merged), evidenceId);
    for (const entityId of entityIds) this.run('INSERT OR IGNORE INTO evidence_entities (evidence_id, entity_id, operation_id) VALUES (?, ?, ?)', evidenceId, entityId, operationId);
  }

  setEvidenceStatus(id: string, status: Evidence['status'], reason: string | null) {
    this.run('UPDATE evidence SET status=?, invalidation_reason=? WHERE id=?', status, reason, id);
  }

  evidenceForEntity(entityId: string): Evidence[] {
    return this.all('SELECT e.* FROM evidence e JOIN evidence_entities x ON x.evidence_id=e.id WHERE x.entity_id=? ORDER BY e.observed_at DESC', entityId).map(r => this.mapEvidence(r));
  }

  countEvidence(operationId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) n FROM evidence WHERE operation_id=?', operationId)?.n ?? 0);
  }

  // ---------------------------------------------------------------- relationships
  private mapRelationship(r: Row): Relationship {
    return {
      id: r.id, operationId: r.operation_id, sourceEntityId: r.source_entity_id, targetEntityId: r.target_entity_id, type: r.type, state: r.state,
      confidence: Number(r.confidence), reasoning: r.reasoning, evidenceIds: parseJson<string[]>(r.evidence_ids, []), firstObserved: r.first_observed,
      lastObserved: r.last_observed, contradictingEvidenceIds: parseJson<string[]>(r.contradicting_evidence_ids, []), assertion: r.assertion ?? undefined,
      sources: parseJson<string[]>(r.sources, []),
    };
  }

  getRelationships(operationId: string): Relationship[] {
    return this.all('SELECT * FROM relationships WHERE operation_id=? ORDER BY first_observed', operationId).map(r => this.mapRelationship(r));
  }

  findRelationship(operationId: string, sourceId: string, targetId: string, type: string): Relationship | undefined {
    const r = this.get('SELECT * FROM relationships WHERE operation_id=? AND source_entity_id=? AND target_entity_id=? AND type=?', operationId, sourceId, targetId, type);
    return r ? this.mapRelationship(r) : undefined;
  }

  upsertRelationshipRow(rel: Relationship) {
    this.run(`INSERT INTO relationships (id, operation_id, source_entity_id, target_entity_id, type, state, confidence, reasoning, evidence_ids, contradicting_evidence_ids, first_observed, last_observed, assertion, sources)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, confidence=excluded.confidence, reasoning=excluded.reasoning, evidence_ids=excluded.evidence_ids,
        contradicting_evidence_ids=excluded.contradicting_evidence_ids, first_observed=excluded.first_observed, last_observed=excluded.last_observed,
        assertion=excluded.assertion, sources=excluded.sources`,
      rel.id, rel.operationId, rel.sourceEntityId, rel.targetEntityId, rel.type, rel.state, rel.confidence, rel.reasoning, j(rel.evidenceIds ?? []),
      j(rel.contradictingEvidenceIds ?? []), rel.firstObserved, rel.lastObserved, rel.assertion ?? 'observed', j(rel.sources ?? []));
  }

  relationshipsForEvidence(evidenceId: string): Relationship[] {
    return this.all("SELECT * FROM relationships WHERE evidence_ids LIKE ?", `%"${evidenceId}"%`).map(r => this.mapRelationship(r));
  }

  // ---------------------------------------------------------------- hypotheses
  getHypotheses(operationId: string): Hypothesis[] {
    return this.all('SELECT data FROM hypotheses WHERE operation_id=? ORDER BY created_at', operationId).map(r => parseJson<Hypothesis>(r.data, null as any)).filter(Boolean);
  }

  getHypothesis(id: string): (Hypothesis & { templateKey?: string }) | undefined {
    const r = this.get('SELECT data, template_key FROM hypotheses WHERE id=?', id);
    return r ? { ...parseJson<Hypothesis>(r.data, null as any), templateKey: r.template_key ?? undefined } : undefined;
  }

  hypothesisByTemplate(operationId: string, templateKey: string): Hypothesis | undefined {
    const r = this.get('SELECT data FROM hypotheses WHERE operation_id=? AND template_key=?', operationId, templateKey);
    return r ? parseJson<Hypothesis>(r.data, null as any) : undefined;
  }

  saveHypothesis(h: Hypothesis, templateKey?: string | null) {
    this.run(`INSERT INTO hypotheses (id, operation_id, template_key, status, confidence, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, confidence=excluded.confidence, data=excluded.data, updated_at=excluded.updated_at,
      template_key=COALESCE(excluded.template_key, hypotheses.template_key)`,
      h.id, h.operationId, templateKey ?? null, h.status, h.confidenceScore, j(h), h.createdAt, h.updatedAt);
  }

  // ---------------------------------------------------------------- leads
  getLeads(operationId: string): Lead[] {
    return this.all('SELECT data FROM leads WHERE operation_id=? ORDER BY priority DESC, created_at', operationId).map(r => parseJson<Lead>(r.data, null as any)).filter(Boolean);
  }

  getLead(id: string): Lead | undefined {
    const r = this.get('SELECT data FROM leads WHERE id=?', id);
    return r ? parseJson<Lead>(r.data, null as any) : undefined;
  }

  leadByKey(operationId: string, key: string): Lead | undefined {
    const r = this.get('SELECT data FROM leads WHERE operation_id=? AND key=?', operationId, key);
    return r ? parseJson<Lead>(r.data, null as any) : undefined;
  }

  saveLead(lead: Lead) {
    this.run(`INSERT INTO leads (id, operation_id, key, status, priority, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, priority=excluded.priority, data=excluded.data, updated_at=excluded.updated_at, key=excluded.key`,
      lead.id, lead.operationId, lead.key ?? null, lead.status, lead.priorityScore, j(lead), lead.createdAt, lead.updatedAt ?? nowIso());
  }

  deleteLeads(operationId: string, where: 'stale_pending') {
    if (where === 'stale_pending') this.run("DELETE FROM leads WHERE operation_id=? AND status='PENDING' AND json_extract(data,'$.source')='planner'", operationId);
  }

  // ---------------------------------------------------------------- fingerprints & reappearance
  getFingerprints(operationId?: string): ReappearanceFingerprint[] {
    const rows = operationId ? this.all('SELECT * FROM fingerprints WHERE operation_id=? ORDER BY weight DESC', operationId) : this.all('SELECT * FROM fingerprints ORDER BY weight DESC');
    return rows.map(r => ({ id: r.id, operationId: r.operation_id, signatureType: r.signature_type, signatureValue: r.value, description: r.description, activeWindow: r.active_window, confidenceWeight: Number(r.weight) }));
  }

  replaceFingerprints(operationId: string, fps: ReappearanceFingerprint[]) {
    this.tx(() => {
      this.run('DELETE FROM fingerprints WHERE operation_id=?', operationId);
      for (const fp of fps) {
        this.run('INSERT OR IGNORE INTO fingerprints (id, operation_id, signature_type, value, description, active_window, weight) VALUES (?, ?, ?, ?, ?, ?, ?)',
          fp.id, operationId, fp.signatureType, fp.signatureValue, fp.description, fp.activeWindow, fp.confidenceWeight);
      }
    });
  }

  getReappearanceLeads(operationId: string): ReappearanceLead[] {
    return this.all('SELECT data FROM reappearance_alerts WHERE operation_id=? ORDER BY detected_at DESC', operationId).map(r => parseJson<ReappearanceLead>(r.data, null as any)).filter(Boolean);
  }

  findReappearance(operationId: string, candidateValue: string): ReappearanceLead | undefined {
    const r = this.get('SELECT data FROM reappearance_alerts WHERE operation_id=? AND candidate=?', operationId, candidateValue.toLowerCase());
    return r ? parseJson<ReappearanceLead>(r.data, null as any) : undefined;
  }

  saveReappearance(lead: ReappearanceLead) {
    this.run(`INSERT INTO reappearance_alerts (id, operation_id, candidate, status, score, data, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, score=excluded.score, data=excluded.data`,
      lead.id, lead.operationId, lead.candidateValue.toLowerCase(), lead.status, lead.overallSimilarityScore, j(lead), lead.detectedAt);
  }

  // ---------------------------------------------------------------- monitors
  getMonitors(operationId?: string): MonitoringProbe[] {
    const rows = operationId ? this.all('SELECT data FROM monitors WHERE operation_id=? ORDER BY created_at', operationId) : this.all('SELECT data FROM monitors ORDER BY created_at');
    return rows.map(r => parseJson<MonitoringProbe>(r.data, null as any)).filter(Boolean);
  }

  dueMonitors(nowAt: string, limit = 10): MonitoringProbe[] {
    return this.all("SELECT data FROM monitors WHERE status<>'PAUSED' AND next_run_at<=? ORDER BY next_run_at LIMIT ?", nowAt, limit).map(r => parseJson<MonitoringProbe>(r.data, null as any)).filter(Boolean);
  }

  saveMonitor(m: MonitoringProbe) {
    this.run(`INSERT INTO monitors (id, operation_id, target_type, target_value, status, next_run_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, next_run_at=excluded.next_run_at, data=excluded.data`,
      m.id, m.operationId, m.targetType, m.targetValue, m.status, m.nextRunAt ?? nowIso(), j(m), m.lastCheckedAt ?? nowIso());
  }

  findMonitor(operationId: string, targetValue: string, pivotType?: string): MonitoringProbe | undefined {
    return this.getMonitors(operationId).find(m => m.targetValue.toLowerCase() === targetValue.toLowerCase() && (!pivotType || m.pivotType === pivotType));
  }

  // ---------------------------------------------------------------- pursuit runs & pivots
  private mapRun(r: Row): PursuitRun {
    return {
      id: r.id, operationId: r.operation_id, status: r.status, config: parseJson(r.config, {} as any), budgetUsed: Number(r.budget_used),
      startedAt: r.started_at, updatedAt: r.updated_at, finishedAt: r.finished_at ?? null, stopReason: r.stop_reason ?? null,
      stats: parseJson(r.stats, { pivots: 0, newEntities: 0, newEvidence: 0, failures: 0, deadEnds: 0, commoditySkipped: 0, maxDepthReached: 0, recentYield: [] }),
    };
  }

  latestRun(operationId: string): PursuitRun | undefined {
    const r = this.get('SELECT * FROM pursuit_runs WHERE operation_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1', operationId);
    return r ? this.mapRun(r) : undefined;
  }

  getRun(id: string): PursuitRun | undefined {
    const r = this.get('SELECT * FROM pursuit_runs WHERE id=?', id);
    return r ? this.mapRun(r) : undefined;
  }

  runsWithStatus(status: string): PursuitRun[] {
    return this.all('SELECT * FROM pursuit_runs WHERE status=?', status).map(r => this.mapRun(r));
  }

  getRuns(operationId: string, limit = 20): PursuitRun[] {
    return this.all('SELECT * FROM pursuit_runs WHERE operation_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?', operationId, limit).map(r => this.mapRun(r));
  }

  saveRun(run: PursuitRun) {
    this.run(`INSERT INTO pursuit_runs (id, operation_id, status, config, budget_used, started_at, updated_at, finished_at, stop_reason, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, config=excluded.config, budget_used=excluded.budget_used, updated_at=excluded.updated_at,
      finished_at=excluded.finished_at, stop_reason=excluded.stop_reason, stats=excluded.stats`,
      run.id, run.operationId, run.status, j(run.config), run.budgetUsed, run.startedAt, run.updatedAt, run.finishedAt ?? null, run.stopReason ?? null, j(run.stats));
  }

  private mapPivot(r: Row): PivotRecord {
    return {
      id: r.id, operationId: r.operation_id, runId: r.run_id, collector: r.collector, pivotType: r.pivot_type, entityId: r.entity_id,
      targetType: r.target_type, targetValue: r.target_value, depth: Number(r.depth), priority: Number(r.priority), status: r.status,
      attempts: Number(r.attempts), createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, signature: r.signature,
      result: parseJson<PivotResultSummary | null>(r.result, null), error: r.error,
      branchId: r.branch_id ?? null, progress: r.progress === null || r.progress === undefined ? null : Number(r.progress), valueEstimate: r.value_estimate === null || r.value_estimate === undefined ? null : Number(r.value_estimate),
    };
  }

  getPivots(operationId: string, limit = 500): PivotRecord[] {
    return this.all('SELECT * FROM pivots WHERE operation_id=? ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT ?', operationId, limit).map(r => this.mapPivot(r));
  }

  getPivot(id: string): PivotRecord | undefined {
    const r = this.get('SELECT * FROM pivots WHERE id=?', id);
    return r ? this.mapPivot(r) : undefined;
  }

  pivotBySignature(operationId: string, signature: string): PivotRecord | undefined {
    const r = this.get('SELECT * FROM pivots WHERE operation_id=? AND signature=?', operationId, signature);
    return r ? this.mapPivot(r) : undefined;
  }

  doneSignatures(operationId: string): Set<string> {
    return new Set(this.all<{ signature: string }>("SELECT signature FROM pivots WHERE operation_id=? AND status IN ('done','running','pending_external','skipped')", operationId).map(r => r.signature));
  }

  failedAttempts(operationId: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const r of this.all<{ signature: string; attempts: number }>("SELECT signature, attempts FROM pivots WHERE operation_id=? AND status='failed'", operationId)) map.set(r.signature, Number(r.attempts));
    return map;
  }

  savePivot(p: PivotRecord) {
    this.run(`INSERT INTO pivots (id, operation_id, run_id, collector, pivot_type, entity_id, target_type, target_value, depth, priority, status, attempts, created_at, started_at, finished_at, signature, result, error, branch_id, progress, value_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, collector=excluded.collector, status=excluded.status, attempts=excluded.attempts, started_at=excluded.started_at,
        finished_at=excluded.finished_at, result=excluded.result, error=excluded.error, priority=excluded.priority, branch_id=excluded.branch_id, progress=excluded.progress, value_estimate=excluded.value_estimate`,
      p.id, p.operationId, p.runId ?? null, p.collector, p.pivotType, p.entityId, p.targetType, p.targetValue, p.depth, p.priority, p.status, p.attempts,
      p.createdAt, p.startedAt ?? null, p.finishedAt ?? null, p.signature, j(p.result ?? null), p.error ?? null, p.branchId ?? null, p.progress ?? null, p.valueEstimate ?? null);
  }

  /** Pivots stuck in `running` (process crashed mid-pivot) go back to failed so they can be retried. */
  recoverInterruptedPivots(): number {
    const res = this.run("UPDATE pivots SET status='failed', error='Interrupted by restart; will retry' WHERE status='running'");
    return Number(res.changes ?? 0);
  }

  // ---------------------------------------------------------------- strategy learning
  getStrategyRows(): Array<{ pivot_type: string; entity_type: string; attempts: number; successes: number; useful_yield: number; new_entities: number; contradictions: number; confidence_sum: number; analyst_positive: number; analyst_negative: number; updated_at: string }> {
    return this.all('SELECT * FROM strategy_stats ORDER BY pivot_type, entity_type');
  }

  bumpStrategy(pivotType: string, entityType: string, delta: { attempts?: number; successes?: number; usefulYield?: number; newEntities?: number; contradictions?: number; confidence?: number; analystPositive?: number; analystNegative?: number }) {
    this.run(`INSERT INTO strategy_stats (pivot_type, entity_type, attempts, successes, useful_yield, new_entities, contradictions, confidence_sum, analyst_positive, analyst_negative, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pivot_type, entity_type) DO UPDATE SET attempts=attempts+excluded.attempts, successes=successes+excluded.successes, useful_yield=useful_yield+excluded.useful_yield,
        new_entities=new_entities+excluded.new_entities, contradictions=contradictions+excluded.contradictions, confidence_sum=confidence_sum+excluded.confidence_sum,
        analyst_positive=analyst_positive+excluded.analyst_positive, analyst_negative=analyst_negative+excluded.analyst_negative, updated_at=excluded.updated_at`,
      pivotType, entityType, delta.attempts ?? 0, delta.successes ?? 0, delta.usefulYield ?? 0, delta.newEntities ?? 0, delta.contradictions ?? 0,
      delta.confidence ?? 0, delta.analystPositive ?? 0, delta.analystNegative ?? 0, nowIso());
  }

  getLearningOutcomes(operationId?: string, limit = 300): LearningOutcomeRecord[] {
    const rows = operationId ? this.all('SELECT data FROM learning_outcomes WHERE operation_id=? ORDER BY timestamp DESC LIMIT ?', operationId, limit) : this.all('SELECT data FROM learning_outcomes ORDER BY timestamp DESC LIMIT ?', limit);
    return rows.map(r => parseJson<LearningOutcomeRecord>(r.data, null as any)).filter(Boolean);
  }

  addLearningOutcome(o: LearningOutcomeRecord) {
    this.run('INSERT OR REPLACE INTO learning_outcomes (id, operation_id, pivot_type, timestamp, data) VALUES (?, ?, ?, ?, ?)', o.id, o.operationId, o.pivotType, o.timestamp, j(o));
  }

  // ---------------------------------------------------------------- findings
  getFindings(operationId: string): Finding[] {
    return this.all('SELECT data FROM findings WHERE operation_id=? ORDER BY importance DESC', operationId).map(r => parseJson<Finding>(r.data, null as any)).filter(Boolean);
  }

  getFinding(id: string): Finding | undefined {
    const r = this.get('SELECT data FROM findings WHERE id=?', id);
    return r ? parseJson<Finding>(r.data, null as any) : undefined;
  }

  findingByKey(operationId: string, key: string): Finding | undefined {
    const r = this.get('SELECT data FROM findings WHERE operation_id=? AND key=?', operationId, key);
    return r ? parseJson<Finding>(r.data, null as any) : undefined;
  }

  saveFinding(f: Finding, active = true) {
    this.run(`INSERT INTO findings (id, operation_id, key, kind, status, importance, active, data, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, importance=excluded.importance, active=excluded.active, data=excluded.data, updated_at=excluded.updated_at`,
      f.id, f.operationId, f.key, f.kind, f.status, f.importance, active ? 1 : 0, j(f), f.firstSeenAt, f.updatedAt);
  }

  activeFindings(operationId: string): Finding[] {
    return this.all('SELECT data FROM findings WHERE operation_id=? AND active=1 ORDER BY importance DESC', operationId).map(r => parseJson<Finding>(r.data, null as any)).filter(Boolean);
  }

  deactivateFindingsExcept(operationId: string, keys: string[]) {
    const keep = new Set(keys);
    for (const r of this.all<{ id: string; key: string }>('SELECT id, key FROM findings WHERE operation_id=? AND active=1', operationId)) {
      if (!keep.has(r.key)) this.run('UPDATE findings SET active=0 WHERE id=?', r.id);
    }
  }

  // ---------------------------------------------------------------- analysis cache
  getAnalysis<T>(operationId: string, kind: string): { revision: number; data: T; computedAt: string } | undefined {
    const r = this.get('SELECT revision, data, computed_at FROM analysis_cache WHERE operation_id=? AND kind=?', operationId, kind);
    return r ? { revision: Number(r.revision), data: parseJson<T>(r.data, null as any), computedAt: r.computed_at } : undefined;
  }

  setAnalysis(operationId: string, kind: string, revision: number, data: unknown) {
    this.run(`INSERT INTO analysis_cache (operation_id, kind, revision, data, computed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(operation_id, kind) DO UPDATE SET revision=excluded.revision, data=excluded.data, computed_at=excluded.computed_at`,
      operationId, kind, revision, j(data), nowIso());
  }

  // ---------------------------------------------------------------- checkpoints
  getCheckpoints(operationId: string, limit = 50): Checkpoint[] {
    return this.all('SELECT * FROM checkpoints WHERE operation_id=? ORDER BY created_at DESC LIMIT ?', operationId, limit)
      .map(r => ({ id: r.id, operationId: r.operation_id, createdAt: r.created_at, label: r.label, metrics: parseJson(r.metrics, {}), entityKeys: parseJson(r.entity_keys, []) }));
  }

  addCheckpoint(c: Checkpoint) {
    this.run('INSERT INTO checkpoints (id, operation_id, created_at, label, metrics, entity_keys) VALUES (?, ?, ?, ?, ?, ?)', c.id, c.operationId, c.createdAt, c.label, j(c.metrics), j(c.entityKeys));
  }

  // ---------------------------------------------------------------- collector cache
  getCached(key: string): { body: any; fetchedAt: string; status: number } | undefined {
    const r = this.get('SELECT body, fetched_at, status, expires_at FROM collector_cache WHERE key=?', key);
    if (!r) return undefined;
    if (r.expires_at && r.expires_at < nowIso()) return undefined;
    return { body: parseJson(r.body, null), fetchedAt: r.fetched_at, status: Number(r.status) };
  }

  setCached(key: string, collector: string, status: number, body: unknown, ttlSeconds: number) {
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.run(`INSERT INTO collector_cache (key, collector, status, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`,
      key, collector, status, j(body), nowIso(), expires);
  }

  pruneCache() {
    this.run('DELETE FROM collector_cache WHERE expires_at < ?', nowIso());
  }

  // ---------------------------------------------------------------- labels
  getLabel(value: string): { label: string; kind: string; source: string } | undefined {
    const r = this.get('SELECT label, kind, source FROM labels WHERE value=?', value.toLowerCase());
    return r ? { label: r.label, kind: r.kind, source: r.source } : undefined;
  }

  setLabel(value: string, label: string, kind: string, source: string) {
    this.run('INSERT INTO labels (value, label, kind, source) VALUES (?, ?, ?, ?) ON CONFLICT(value) DO UPDATE SET label=excluded.label, kind=excluded.kind, source=excluded.source',
      value.toLowerCase(), label, kind, source);
  }

  allLabels() {
    return this.all('SELECT value, label, kind, source FROM labels ORDER BY kind, label');
  }

  // ---------------------------------------------------------------- integration outbox & state
  enqueueOutbox(kind: string, payload: unknown, coalesceKey?: string) {
    if (coalesceKey) {
      const existing = this.get<{ id: string }>("SELECT id FROM outbox WHERE coalesce_key=? AND status='pending'", coalesceKey);
      if (existing) {
        this.run('UPDATE outbox SET payload=?, created_at=? WHERE id=?', j(payload), nowIso(), existing.id);
        return existing.id;
      }
    }
    const id = newId('out', 12);
    this.run("INSERT INTO outbox (id, kind, coalesce_key, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
      id, kind, coalesceKey ?? null, j(payload), nowIso(), nowIso());
    return id;
  }

  dueOutbox(limit = 20) {
    return this.all("SELECT * FROM outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?", nowIso(), limit)
      .map(r => ({ id: r.id as string, kind: r.kind as string, payload: parseJson<any>(r.payload, {}), attempts: Number(r.attempts), coalesceKey: r.coalesce_key as string | null }));
  }

  markOutbox(id: string, status: 'delivered' | 'pending' | 'dead', error?: string, delaySeconds = 0) {
    this.run('UPDATE outbox SET status=?, attempts=attempts+1, last_error=?, next_attempt_at=?, delivered_at=CASE WHEN ?=\'delivered\' THEN ? ELSE delivered_at END WHERE id=?',
      status, error ?? null, new Date(Date.now() + delaySeconds * 1000).toISOString(), status, nowIso(), id);
  }

  outboxStats() {
    const rows = this.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM outbox GROUP BY status');
    const out: { pending: number; delivered: number; dead: number; [k: string]: number } = { pending: 0, delivered: 0, dead: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    const last = this.get<{ last_error: string }>("SELECT last_error FROM outbox WHERE last_error IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1");
    return { ...out, lastError: last?.last_error ?? null };
  }

  pruneOutbox(days = 14) {
    this.run("DELETE FROM outbox WHERE status='delivered' AND delivered_at < ?", new Date(Date.now() - days * 86400000).toISOString());
  }

  getLinks(operationId: string) {
    return this.all('SELECT * FROM main_links WHERE operation_id=?', operationId);
  }

  linkMain(operationId: string, kind: string, externalId: string, data: Record<string, any> = {}) {
    this.run('INSERT INTO main_links (operation_id, kind, external_id, data, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(operation_id, kind, external_id) DO UPDATE SET data=excluded.data',
      operationId, kind, externalId, j(data), nowIso());
  }

  operationsLinkedTo(kind: string, externalId: string): string[] {
    return this.all<{ operation_id: string }>('SELECT operation_id FROM main_links WHERE kind=? AND external_id=?', kind, externalId).map(r => r.operation_id);
  }

  processedMainEvent(eventId: string): boolean {
    return Boolean(this.get('SELECT 1 x FROM main_events_processed WHERE event_id=?', eventId));
  }

  markMainEvent(eventId: string, outcome: string) {
    this.run('INSERT OR IGNORE INTO main_events_processed (event_id, outcome, processed_at) VALUES (?, ?, ?)', eventId, outcome, nowIso());
  }
}

/** Tables that carry an operation_id column (used for deletes and exports). */
export const OPERATION_TABLES = [
  'seeds', 'evidence_entities', 'evidence', 'relationships', 'entities', 'hypotheses', 'leads', 'fingerprints', 'reappearance_alerts',
  'monitors', 'pursuit_runs', 'pivots', 'learning_outcomes', 'findings', 'analysis_cache', 'checkpoints', 'changes', 'audit_log', 'main_links',
  'facet_values', 'facet_changes', 'membership', 'membership_feedback', 'branches', 'model_versions', 'hunts', 'credits', 'contradictions', 'resource_ledger',
];

function norm(value: any) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}
