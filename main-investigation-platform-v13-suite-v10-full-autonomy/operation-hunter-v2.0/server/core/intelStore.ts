import type { HunterStore } from './store.js';
import { newId, nowIso, parseJson, sha256, stableId } from './util.js';

/**
 * Storage for the v2.0 intelligence layer: the temporal facet ledger, living
 * model versions, probabilistic membership, pursuit branches, standing hunts,
 * entity aliases, progress-based learning with delayed credit, contradictions
 * and the global resource ledger. All tables are operation-scoped except the
 * learner and aliases, which are shared across operations.
 */

export type ChangeKind = 'appeared' | 'changed' | 'disappeared' | 'resurfaced' | 'contradiction';

export interface FacetValue {
  operationId: string; entityId: string; facet: string; valueHash: string; value: string; firstSeen: string; lastSeen: string;
  observations: number; sources: string[]; current: boolean; endedAt: string | null;
}
export interface FacetChange {
  id: string; operationId: string; entityId: string; facet: string; kind: ChangeKind; from: string | null; to: string | null;
  at: string; source: string; significance: number; evidenceId: string | null; data: Record<string, any>;
}
export type MembershipStatus = 'member' | 'probable' | 'candidate' | 'excluded' | 'unknown';
export interface MembershipFactor { key: string; family: string; weight: number; text: string; evidenceIds?: string[] }
export interface MembershipRow {
  operationId: string; entityId: string; status: MembershipStatus; probability: number; factors: MembershipFactor[]; since: string; updatedAt: string; analystVerdict: string | null;
}
export type BranchStatus = 'active' | 'parked' | 'saturated' | 'exhausted' | 'revisit' | 'blocked';
export interface BranchStats {
  pulls: number; cost: number; progress: number; progressSq: number; lastProgressAt: string | null; zeroStreak: number;
  failures: number; frontier: number; recent: number[]; revisits: number; noise: number;
}
export interface Branch {
  id: string; operationId: string; kind: string; anchor: string; question: string; status: BranchStatus; stats: BranchStats;
  revisitAt: string | null; createdAt: string; updatedAt: string;
}
export interface ModelVersion { operationId: string; version: number; createdAt: string; trigger: string; summary: string; snapshot: any; diff: any }
export interface Hunt {
  id: string; operationId: string; kind: string; query: string; status: 'active' | 'paused' | 'retired'; cadenceMinutes: number; nextRunAt: string;
  lastRunAt: string | null; runs: number; hits: number; data: Record<string, any>; createdAt: string;
}
export interface Contradiction {
  id: string; operationId: string; fingerprint: string; kind: string; status: 'open' | 'resolved' | 'dismissed'; severity: number; summary: string;
  data: Record<string, any>; detectedAt: string; resolvedAt: string | null; resolution: string | null;
}

export const EMPTY_BRANCH_STATS: BranchStats = { pulls: 0, cost: 0, progress: 0, progressSq: 0, lastProgressAt: null, zeroStreak: 0, failures: 0, frontier: 0, recent: [], revisits: 0, noise: 0 };

type Row = Record<string, any>;
const j = (v: unknown) => JSON.stringify(v ?? null);

export class IntelStore {
  constructor(private s: HunterStore) {}

  // ---------------------------------------------------------------- facets
  /** Record one observation of a facet value. Returns the change it implies (if any). */
  observeFacet(input: { operationId: string; entityId: string; facet: string; value: string; at: string; source: string; exclusive?: boolean; evidenceId?: string | null; contradictionWindowMs?: number; significance?: number }): FacetChange | null {
    const hash = sha256(input.value).slice(0, 24);
    const existing = this.s.get<Row>('SELECT * FROM facet_values WHERE entity_id=? AND facet=? AND value_hash=?', input.entityId, input.facet, hash);
    const current = this.s.all<Row>('SELECT * FROM facet_values WHERE entity_id=? AND facet=? AND current=1', input.entityId, input.facet);
    const exclusive = input.exclusive !== false;
    let change: FacetChange | null = null;
    this.s.tx(() => {
      if (existing) {
        const sources = new Set(parseJson<string[]>(existing.sources, [])); sources.add(input.source);
        const wasCurrent = Number(existing.current) === 1;
        this.s.run('UPDATE facet_values SET last_seen=MAX(last_seen, ?), observations=observations+1, sources=?, current=1, ended_at=NULL WHERE entity_id=? AND facet=? AND value_hash=?',
          input.at, j([...sources]), input.entityId, input.facet, hash);
        if (!wasCurrent) {
          // a value that had ended is observed again: resurfaced
          if (exclusive) for (const c of current) this.endValue(c, input.at);
          change = this.addChange({ ...input, kind: 'resurfaced', from: current[0]?.value ?? null, to: input.value });
        }
        return;
      }
      const first = !this.s.get('SELECT 1 FROM facet_values WHERE entity_id=? AND facet=? LIMIT 1', input.entityId, input.facet);
      const window = input.contradictionWindowMs ?? 3600000;
      const newestCurrent = current.reduce((m, c) => (c.last_seen > m ? c.last_seen : m), '');
      if (exclusive && current.length && Date.parse(input.at) < Date.parse(newestCurrent) - window) {
        // An older observation arriving late (e.g. an archived scan): history, not a change.
        this.s.run('INSERT INTO facet_values (operation_id, entity_id, facet, value_hash, value, first_seen, last_seen, observations, sources, current, ended_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
          input.operationId, input.entityId, input.facet, hash, input.value, input.at, input.at, 1, j([input.source]), input.at);
        return;
      }
      if (exclusive && current.length) {
        const recentOther = current.find(c => !parseJson<string[]>(c.sources, []).includes(input.source) && Math.abs(Date.parse(c.last_seen) - Date.parse(input.at)) < window);
        if (recentOther) {
          // Two sources disagree about the same fact at nearly the same time: record, don't treat as a change.
          this.s.run('INSERT INTO facet_values (operation_id, entity_id, facet, value_hash, value, first_seen, last_seen, observations, sources, current, ended_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
            input.operationId, input.entityId, input.facet, hash, input.value, input.at, input.at, 1, j([input.source]), input.at);
          change = this.addChange({ ...input, kind: 'contradiction', from: recentOther.value, to: input.value, data: { otherSource: parseJson<string[]>(recentOther.sources, []) } });
          return;
        }
        for (const c of current) this.endValue(c, input.at);
      }
      this.s.run('INSERT INTO facet_values (operation_id, entity_id, facet, value_hash, value, first_seen, last_seen, observations, sources, current, ended_at) VALUES (?,?,?,?,?,?,?,?,?,1,NULL)',
        input.operationId, input.entityId, input.facet, hash, input.value, input.at, input.at, 1, j([input.source]));
      // First observation of a facet is state, not a change.
      if (!first) change = this.addChange({ ...input, kind: exclusive && current.length ? 'changed' : 'appeared', from: exclusive ? current[0]?.value ?? null : null, to: input.value });
    });
    return change;
  }

  /** Mark a facet as having no current value (e.g. DNS stopped answering). */
  endFacet(input: { operationId: string; entityId: string; facet: string; at: string; source: string; evidenceId?: string | null; significance?: number }): FacetChange | null {
    const current = this.s.all<Row>('SELECT * FROM facet_values WHERE entity_id=? AND facet=? AND current=1', input.entityId, input.facet);
    if (!current.length) return null;
    let change: FacetChange | null = null;
    this.s.tx(() => {
      for (const c of current) this.endValue(c, input.at);
      change = this.addChange({ ...input, kind: 'disappeared', from: current.map(c => c.value).join(' | '), to: null });
    });
    return change;
  }

  private endValue(row: Row, at: string) {
    this.s.run('UPDATE facet_values SET current=0, ended_at=? WHERE entity_id=? AND facet=? AND value_hash=?', at, row.entity_id, row.facet, row.value_hash);
  }

  private addChange(input: { operationId: string; entityId: string; facet: string; kind: ChangeKind; from: string | null; to: string | null; at: string; source: string; evidenceId?: string | null; significance?: number; data?: Record<string, any> }): FacetChange {
    const c: FacetChange = {
      id: newId('fch', 10), operationId: input.operationId, entityId: input.entityId, facet: input.facet, kind: input.kind, from: input.from, to: input.to,
      at: input.at, source: input.source, significance: input.significance ?? 0.5, evidenceId: input.evidenceId ?? null, data: input.data ?? {},
    };
    this.s.run('INSERT INTO facet_changes (id, operation_id, entity_id, facet, kind, from_value, to_value, at, source, significance, evidence_id, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      c.id, c.operationId, c.entityId, c.facet, c.kind, c.from, c.to, c.at, c.source, c.significance, c.evidenceId, j(c.data));
    return c;
  }

  facetValues(operationId: string, entityId?: string): FacetValue[] {
    const rows = entityId
      ? this.s.all<Row>('SELECT * FROM facet_values WHERE entity_id=? ORDER BY facet, first_seen', entityId)
      : this.s.all<Row>('SELECT * FROM facet_values WHERE operation_id=? ORDER BY entity_id, facet, first_seen', operationId);
    return rows.map(r => ({ operationId: r.operation_id, entityId: r.entity_id, facet: r.facet, valueHash: r.value_hash, value: r.value, firstSeen: r.first_seen, lastSeen: r.last_seen, observations: Number(r.observations), sources: parseJson(r.sources, []), current: Number(r.current) === 1, endedAt: r.ended_at ?? null }));
  }

  facetChanges(operationId: string, opts: { since?: string | null; entityId?: string; limit?: number } = {}): FacetChange[] {
    const params: any[] = [operationId];
    let sql = 'SELECT * FROM facet_changes WHERE operation_id=?';
    if (opts.since) { sql += ' AND at > ?'; params.push(opts.since); }
    if (opts.entityId) { sql += ' AND entity_id=?'; params.push(opts.entityId); }
    sql += ' ORDER BY at DESC, rowid DESC LIMIT ?'; params.push(opts.limit ?? 500);
    return this.s.all<Row>(sql, ...params).map(r => ({ id: r.id, operationId: r.operation_id, entityId: r.entity_id, facet: r.facet, kind: r.kind, from: r.from_value ?? null, to: r.to_value ?? null, at: r.at, source: r.source, significance: Number(r.significance), evidenceId: r.evidence_id ?? null, data: parseJson(r.data, {}) }));
  }

  // ---------------------------------------------------------------- membership
  getMembership(operationId: string): MembershipRow[] {
    return this.s.all<Row>('SELECT * FROM membership WHERE operation_id=?', operationId).map(r => this.mapMembership(r));
  }
  membershipOf(operationId: string, entityId: string): MembershipRow | undefined {
    const r = this.s.get<Row>('SELECT * FROM membership WHERE operation_id=? AND entity_id=?', operationId, entityId);
    return r ? this.mapMembership(r) : undefined;
  }
  private mapMembership(r: Row): MembershipRow {
    return { operationId: r.operation_id, entityId: r.entity_id, status: r.status, probability: Number(r.probability), factors: parseJson(r.factors, []), since: r.since, updatedAt: r.updated_at, analystVerdict: r.analyst_verdict ?? null };
  }
  saveMembership(rows: MembershipRow[]) {
    this.s.tx(() => {
      for (const m of rows) {
        this.s.run(`INSERT INTO membership (operation_id, entity_id, status, probability, factors, since, updated_at, analyst_verdict) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(operation_id, entity_id) DO UPDATE SET status=excluded.status, probability=excluded.probability, factors=excluded.factors, since=CASE WHEN membership.status=excluded.status THEN membership.since ELSE excluded.since END, updated_at=excluded.updated_at, analyst_verdict=COALESCE(excluded.analyst_verdict, membership.analyst_verdict)`,
          m.operationId, m.entityId, m.status, m.probability, j(m.factors), m.since, m.updatedAt, m.analystVerdict);
      }
    });
  }
  setVerdict(operationId: string, entityId: string, verdict: 'member' | 'not_member' | null, reason: string | null, factors: MembershipFactor[]) {
    this.s.tx(() => {
      this.s.run(`INSERT INTO membership (operation_id, entity_id, status, probability, factors, since, updated_at, analyst_verdict) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(operation_id, entity_id) DO UPDATE SET analyst_verdict=excluded.analyst_verdict, updated_at=excluded.updated_at`,
        operationId, entityId, verdict === 'member' ? 'member' : verdict === 'not_member' ? 'excluded' : 'unknown', verdict === 'member' ? 1 : 0, j(factors), nowIso(), nowIso(), verdict);
      if (verdict) this.s.run('INSERT INTO membership_feedback (id, operation_id, entity_id, verdict, reason, factors, at) VALUES (?,?,?,?,?,?,?)', newId('mfb', 10), operationId, entityId, verdict, reason, j(factors), nowIso());
    });
  }
  membershipFeedback(operationId?: string): Array<{ operationId: string; entityId: string; verdict: string; reason: string | null; factors: MembershipFactor[]; at: string }> {
    const rows = operationId ? this.s.all<Row>('SELECT * FROM membership_feedback WHERE operation_id=? ORDER BY at', operationId) : this.s.all<Row>('SELECT * FROM membership_feedback ORDER BY at');
    return rows.map(r => ({ operationId: r.operation_id, entityId: r.entity_id, verdict: r.verdict, reason: r.reason ?? null, factors: parseJson(r.factors, []), at: r.at }));
  }

  // ---------------------------------------------------------------- branches
  getBranches(operationId: string): Branch[] {
    return this.s.all<Row>('SELECT * FROM branches WHERE operation_id=? ORDER BY created_at', operationId).map(r => this.mapBranch(r));
  }
  getBranch(id: string): Branch | undefined {
    const r = this.s.get<Row>('SELECT * FROM branches WHERE id=?', id);
    return r ? this.mapBranch(r) : undefined;
  }
  private mapBranch(r: Row): Branch {
    return { id: r.id, operationId: r.operation_id, kind: r.kind, anchor: r.anchor, question: r.question, status: r.status, stats: { ...EMPTY_BRANCH_STATS, ...parseJson(r.stats, {}) }, revisitAt: r.revisit_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  ensureBranch(operationId: string, kind: string, anchor: string, question: string): Branch {
    const id = stableId('br', operationId, kind, anchor);
    const now = nowIso();
    this.s.run('INSERT OR IGNORE INTO branches (id, operation_id, kind, anchor, question, status, stats, revisit_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, operationId, kind, anchor, question, 'active', j(EMPTY_BRANCH_STATS), null, now, now);
    return this.getBranch(id)!;
  }
  saveBranch(b: Branch) {
    this.s.run('UPDATE branches SET status=?, stats=?, revisit_at=?, question=?, updated_at=? WHERE id=?', b.status, j(b.stats), b.revisitAt, b.question, nowIso(), b.id);
  }

  // ---------------------------------------------------------------- model versions
  latestModel(operationId: string): ModelVersion | undefined {
    const r = this.s.get<Row>('SELECT * FROM model_versions WHERE operation_id=? ORDER BY version DESC LIMIT 1', operationId);
    return r ? this.mapModel(r) : undefined;
  }
  modelVersions(operationId: string, limit = 50, withSnapshots = false): ModelVersion[] {
    return this.s.all<Row>(`SELECT operation_id, version, created_at, trigger, summary, ${withSnapshots ? 'snapshot' : "'null' AS snapshot"}, diff FROM model_versions WHERE operation_id=? ORDER BY version DESC LIMIT ?`, operationId, limit).map(r => this.mapModel(r));
  }
  modelVersion(operationId: string, version: number): ModelVersion | undefined {
    const r = this.s.get<Row>('SELECT * FROM model_versions WHERE operation_id=? AND version=?', operationId, version);
    return r ? this.mapModel(r) : undefined;
  }
  private mapModel(r: Row): ModelVersion {
    return { operationId: r.operation_id, version: Number(r.version), createdAt: r.created_at, trigger: r.trigger, summary: r.summary, snapshot: parseJson(r.snapshot, null), diff: parseJson(r.diff, {}) };
  }
  addModelVersion(v: Omit<ModelVersion, 'version' | 'createdAt'>): ModelVersion {
    const version = Number(this.s.get<{ v: number }>('SELECT MAX(version) v FROM model_versions WHERE operation_id=?', v.operationId)?.v ?? 0) + 1;
    const createdAt = nowIso();
    this.s.run('INSERT INTO model_versions (operation_id, version, created_at, trigger, summary, snapshot, diff) VALUES (?,?,?,?,?,?,?)', v.operationId, version, createdAt, v.trigger, v.summary, j(v.snapshot), j(v.diff));
    // Keep full snapshots for the most recent 60 versions; older ones keep only their diff.
    this.s.run("UPDATE model_versions SET snapshot='null' WHERE operation_id=? AND version <= ?", v.operationId, version - 60);
    return { ...v, version, createdAt };
  }

  // ---------------------------------------------------------------- hunts
  getHunts(operationId?: string): Hunt[] {
    const rows = operationId ? this.s.all<Row>('SELECT * FROM hunts WHERE operation_id=? ORDER BY created_at', operationId) : this.s.all<Row>('SELECT * FROM hunts ORDER BY created_at');
    return rows.map(r => this.mapHunt(r));
  }
  dueHunts(now = nowIso()): Hunt[] {
    return this.s.all<Row>("SELECT * FROM hunts WHERE status='active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 50", now).map(r => this.mapHunt(r));
  }
  private mapHunt(r: Row): Hunt {
    return { id: r.id, operationId: r.operation_id, kind: r.kind, query: r.query, status: r.status, cadenceMinutes: Number(r.cadence_minutes), nextRunAt: r.next_run_at, lastRunAt: r.last_run_at ?? null, runs: Number(r.runs), hits: Number(r.hits), data: parseJson(r.data, {}), createdAt: r.created_at };
  }
  upsertHunt(h: Omit<Hunt, 'id' | 'createdAt' | 'runs' | 'hits' | 'lastRunAt'> & Partial<Hunt>): Hunt {
    const id = h.id ?? stableId('hunt', h.operationId, h.kind, h.query);
    const existing = this.s.get<Row>('SELECT * FROM hunts WHERE id=?', id);
    if (existing) {
      this.s.run('UPDATE hunts SET status=?, cadence_minutes=?, next_run_at=?, last_run_at=?, runs=?, hits=?, data=? WHERE id=?',
        h.status, h.cadenceMinutes, h.nextRunAt, h.lastRunAt ?? existing.last_run_at, h.runs ?? existing.runs, h.hits ?? existing.hits, j(h.data ?? parseJson(existing.data, {})), id);
    } else {
      this.s.run('INSERT INTO hunts (id, operation_id, kind, query, status, cadence_minutes, next_run_at, last_run_at, runs, hits, data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id, h.operationId, h.kind, h.query, h.status, h.cadenceMinutes, h.nextRunAt, h.lastRunAt ?? null, h.runs ?? 0, h.hits ?? 0, j(h.data ?? {}), nowIso());
    }
    return this.mapHunt(this.s.get<Row>('SELECT * FROM hunts WHERE id=?', id)!);
  }

  // ---------------------------------------------------------------- aliases
  addAlias(alias: string, canonical: string, kind: string, reason: string) {
    if (!alias || alias === canonical) return;
    this.s.run('INSERT OR IGNORE INTO aliases (alias, canonical, kind, reason, created_at) VALUES (?,?,?,?,?)', alias, canonical, kind, reason, nowIso());
  }
  resolveAlias(value: string): string {
    return this.s.get<{ canonical: string }>('SELECT canonical FROM aliases WHERE alias=?', value)?.canonical ?? value;
  }
  aliasesOf(canonical: string): Array<{ alias: string; kind: string; reason: string }> {
    return this.s.all<Row>('SELECT alias, kind, reason FROM aliases WHERE canonical=?', canonical).map(r => ({ alias: r.alias, kind: r.kind, reason: r.reason }));
  }

  // ---------------------------------------------------------------- learner
  learnerRows(): Array<{ context: string; pivotType: string; pulls: number; cost: number; progress: number; progressSq: number; credited: number }> {
    return this.s.all<Row>('SELECT * FROM learner').map(r => ({ context: r.context, pivotType: r.pivot_type, pulls: Number(r.pulls), cost: Number(r.cost), progress: Number(r.progress), progressSq: Number(r.progress_sq), credited: Number(r.credited) }));
  }
  bumpLearner(context: string, pivotType: string, d: { pulls?: number; cost?: number; progress?: number; credited?: number }) {
    const p = d.progress ?? 0;
    this.s.run(`INSERT INTO learner (context, pivot_type, pulls, cost, progress, progress_sq, credited, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(context, pivot_type) DO UPDATE SET pulls=pulls+excluded.pulls, cost=cost+excluded.cost, progress=progress+excluded.progress, progress_sq=progress_sq+excluded.progress_sq, credited=credited+excluded.credited, updated_at=excluded.updated_at`,
      context, pivotType, d.pulls ?? 0, d.cost ?? 0, p, p * p, d.credited ?? 0, nowIso());
  }
  addCredit(operationId: string, pivotId: string, entityId: string | null, kind: string, amount: number): boolean {
    const res = this.s.run('INSERT OR IGNORE INTO credits (id, operation_id, pivot_id, entity_id, kind, amount, at) VALUES (?,?,?,?,?,?,?)', newId('crd', 10), operationId, pivotId, entityId ?? '', kind, amount, nowIso());
    return Number(res.changes) > 0;
  }
  credits(operationId: string) {
    return this.s.all<Row>('SELECT * FROM credits WHERE operation_id=? ORDER BY at DESC', operationId).map(r => ({ pivotId: r.pivot_id, entityId: r.entity_id || null, kind: r.kind, amount: Number(r.amount), at: r.at }));
  }

  // ---------------------------------------------------------------- contradictions
  upsertContradiction(c: Omit<Contradiction, 'id' | 'detectedAt' | 'resolvedAt' | 'resolution' | 'status'> & { status?: Contradiction['status'] }): { contradiction: Contradiction; created: boolean } {
    const existing = this.s.get<Row>('SELECT * FROM contradictions WHERE operation_id=? AND fingerprint=?', c.operationId, c.fingerprint);
    if (existing) {
      this.s.run('UPDATE contradictions SET severity=?, summary=?, data=? WHERE id=?', c.severity, c.summary, j(c.data), existing.id);
      return { contradiction: this.mapContradiction(this.s.get<Row>('SELECT * FROM contradictions WHERE id=?', existing.id)!), created: false };
    }
    const id = newId('ctr', 10);
    this.s.run('INSERT INTO contradictions (id, operation_id, fingerprint, kind, status, severity, summary, data, detected_at) VALUES (?,?,?,?,?,?,?,?,?)', id, c.operationId, c.fingerprint, c.kind, c.status ?? 'open', c.severity, c.summary, j(c.data), nowIso());
    return { contradiction: this.mapContradiction(this.s.get<Row>('SELECT * FROM contradictions WHERE id=?', id)!), created: true };
  }
  contradictions(operationId: string): Contradiction[] {
    return this.s.all<Row>('SELECT * FROM contradictions WHERE operation_id=? ORDER BY detected_at DESC', operationId).map(r => this.mapContradiction(r));
  }
  resolveContradiction(id: string, status: 'resolved' | 'dismissed' | 'open', resolution: string | null) {
    this.s.run('UPDATE contradictions SET status=?, resolution=?, resolved_at=? WHERE id=?', status, resolution, status === 'open' ? null : nowIso(), id);
  }
  retireContradictionsExcept(operationId: string, fingerprints: string[]) {
    const keep = new Set(fingerprints);
    for (const c of this.contradictions(operationId)) if (c.status === 'open' && !keep.has(c.fingerprint)) this.resolveContradiction(c.id, 'resolved', 'No longer observed after re-analysis');
  }
  private mapContradiction(r: Row): Contradiction {
    return { id: r.id, operationId: r.operation_id, fingerprint: r.fingerprint, kind: r.kind, status: r.status, severity: Number(r.severity), summary: r.summary, data: parseJson(r.data, {}), detectedAt: r.detected_at, resolvedAt: r.resolved_at ?? null, resolution: r.resolution ?? null };
  }

  // ---------------------------------------------------------------- resource ledger
  spend(operationId: string, amount: number, day = nowIso().slice(0, 10)) {
    this.s.run('INSERT INTO resource_ledger (day, operation_id, spent, pivots) VALUES (?,?,?,1) ON CONFLICT(day, operation_id) DO UPDATE SET spent=spent+excluded.spent, pivots=pivots+1', day, operationId, amount);
  }
  spentToday(day = nowIso().slice(0, 10)): Map<string, number> {
    return new Map(this.s.all<Row>('SELECT operation_id, spent FROM resource_ledger WHERE day=?', day).map(r => [r.operation_id, Number(r.spent)]));
  }
}
