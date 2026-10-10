/**
 * Operation Hunter v1.0 domain model.
 *
 * The v0.x shapes in ../types.ts are still used for stored records and for the
 * classic views. This file adds the v1.0 concepts: collectors produce
 * Observations, the ingest pipeline turns each observation into exactly one
 * immutable Evidence record plus the entities/relationships it supports, and
 * the analysis layer derives everything else from that evidence.
 */
import type { EntityType, EvidenceAssertion, Relationship, LeadCost } from '../types.js';

export type { EntityType, EvidenceAssertion };

export interface ObservedEntity {
  ref: string;                    // local reference inside one observation
  type: EntityType;
  value: string;
  label?: string;
  metadata?: Record<string, any>;
  firstSeen?: string;
  lastSeen?: string;
  isActive?: boolean;
  tags?: string[];
}

export interface ObservedRelationship {
  from: string;                   // ObservedEntity.ref (or 'subject')
  to: string;
  type: Relationship['type'];
  reasoning: string;
  confidence?: number;
  observedAt?: string;
}

/** One normalized fact produced by a collector. Becomes one Evidence record. */
export interface Observation {
  kind: string;                   // evidence type, e.g. dns_a, ct_certificate, token_transfer
  source: string;                 // data source, e.g. dns, crt.sh, rdap, blockscout:ethereum
  observedAt: string;             // when the fact was true / recorded by the source
  summary: string;                // plain statement of what was observed
  raw: Record<string, any>;
  confidence: number;
  assertion: EvidenceAssertion;
  provenance: string;             // exact query / URL / method
  entities: ObservedEntity[];
  relationships: ObservedRelationship[];
}

export interface CollectorResult {
  observations: Observation[];
  /** How many raw results the source returned. Huge counts mean the pivot target is commodity infrastructure. */
  resultVolume: number;
  truncated?: boolean;
  note?: string;
  /** Delegated collectors return a pending marker; results arrive later (e.g. from Main Platform). */
  pending?: boolean;
}

export interface PivotSpec {
  pivotType: string;
  entityTypes: EntityType[];
  label: string;                  // short, e.g. "Resolve DNS records"
  cost: LeadCost;
  /** Plain-language explanation for someone learning. */
  explain: (value: string) => { what: string; why: string; doesNotProve: string };
  /** Optional filter, e.g. only EVM wallets. */
  applies?: (entity: { type: EntityType; value: string; metadata: Record<string, any> }) => boolean;
  /** Prior expected number of useful new entities (used before learning has data). */
  priorGain: number;
  monitorable?: boolean;
}

export type CollectorKind = 'passive_public' | 'internal' | 'delegated' | 'synthetic';

export interface CollectorAvailability { ok: boolean; reason?: string }

export interface PursuitConfigV1 {
  maxHops: number;
  budgetTotal: number;
  concurrency: number;
  minConfidenceThreshold: number;
  avoidSaturation: boolean;
  saturationWindow: number;       // pivots without new relevant entities before a branch is considered saturated
  maxMinutes: number;
  allowDelegation: boolean;       // may ask Main Platform modules to do site checks / wallet analysis
}

export type RunStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'BUDGET_EXHAUSTED' | 'SATURATED' | 'FAILED' | 'STOPPED';

export interface PursuitRun {
  id: string;
  operationId: string;
  status: RunStatus;
  config: PursuitConfigV1;
  budgetUsed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  stopReason?: string | null;
  stats: {
    pivots: number;
    newEntities: number;
    newEvidence: number;
    failures: number;
    deadEnds: number;
    commoditySkipped: number;
    maxDepthReached: number;
    recentYield: number[];        // new relevant entities per pivot, most recent last
  };
}

export type PivotStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'pending_external';

export interface PivotRecord {
  id: string;
  operationId: string;
  runId?: string | null;
  collector: string;
  pivotType: string;
  entityId: string;
  targetType: string;
  targetValue: string;
  depth: number;
  priority: number;
  status: PivotStatus;
  attempts: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  signature: string;
  result?: PivotResultSummary | null;
  error?: string | null;
  // v2.0
  branchId?: string | null;
  progress?: number | null;
  valueEstimate?: number | null;
}

export interface PivotResultSummary {
  newEntities: number;
  newRelevantEntities: number;
  newEvidence: number;
  newRelationships: number;
  resultVolume: number;
  commodity: boolean;
  actionSummary: string;
  simpleExplanation: string;
  whyItMatters: string;
  discovered: Array<{ type: string; value: string }>;
  branchStatus: 'EXPANDED' | 'SATURATED' | 'ABANDONED_DEAD_END' | 'CYCLE_DETECTED' | 'COMMODITY' | 'PENDING_EXTERNAL' | 'FAILED';
  // v2.0
  progress?: number;
  progressParts?: Array<{ label: string; value: number }>;
  context?: { pivotType: string; entityType: string; status: string; level: string };
  branchKind?: string;
  why?: string[];
  changes?: string[];
}

export type FindingKind =
  | 'infrastructure_cluster' | 'shared_certificate' | 'kit_family' | 'operator_indicator'
  | 'cash_out' | 'convergence_wallet' | 'rotation' | 'reappearance' | 'cross_operation'
  | 'contradiction' | 'critical_gap' | 'bridge_entity' | 'standby_domains' | 'registration_burst'
  | 'naming_pattern' | 'money_flow' | 'deployer' | 'fresh_activity'
  | 'forecast' | 'lifecycle' | 'competing_explanation' | 'model_change';

export interface FindingAction {
  type: 'run_pivot' | 'start_pursuit' | 'request_site_check' | 'send_to_inbox' | 'review_evidence' | 'open_view' | 'add_monitor' | 'mark_reviewed';
  label: string;
  params?: Record<string, any>;
}

export interface Finding {
  id: string;
  operationId: string;
  key: string;                    // stable identity so status survives re-analysis
  kind: FindingKind;
  title: string;
  whatFound: string;
  whyItMatters: string;
  whatItMeans: string;
  uncertainty: string;
  doesNotProve: string;
  nextStep: string;
  action?: FindingAction;
  confidence: number;             // 0..1
  importance: number;             // 0..100 ranking score
  evidenceIds: string[];
  entityIds: string[];
  status: 'new' | 'seen' | 'dismissed' | 'acted';
  firstSeenAt: string;
  updatedAt: string;
  isNewSinceLastView?: boolean;
  view?: string;                  // which deep view explains it
}

export interface Checkpoint {
  id: string;
  operationId: string;
  createdAt: string;
  label: string;
  metrics: Record<string, number>;
  entityKeys: string[];
}

export interface ChangeRecord {
  id: string;
  operationId: string;
  at: string;
  kind: string;
  summary: string;
  data?: Record<string, any>;
}

export interface ReconstructionDepth {
  score: number;                  // 0..100
  dimensions: Array<{ key: string; label: string; score: number; detail: string }>;
}
