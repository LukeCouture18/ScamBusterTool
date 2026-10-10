/**
 * Ordered, append-only schema migrations. Never edit a shipped migration;
 * add a new one. Each runs inside a transaction and is recorded in
 * schema_migrations.
 */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'v1_0_core',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL, initial_seed TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT '{}', is_demo INTEGER NOT NULL DEFAULT 0,
  main_investigation_id TEXT, last_viewed_at TEXT, revision INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_code ON operations(code);

CREATE TABLE IF NOT EXISTS seeds (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, canonical TEXT NOT NULL,
  label TEXT, notes TEXT, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'analyst', added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seeds_op ON seeds(operation_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, canonical TEXT NOT NULL,
  label TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1, is_seed INTEGER NOT NULL DEFAULT 0, depth INTEGER NOT NULL DEFAULT 0,
  ubiquity REAL NOT NULL DEFAULT 0, discovered_via TEXT, tags TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_identity ON entities(operation_id, type, canonical);
CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, collector TEXT,
  observed_at TEXT NOT NULL, collected_at TEXT NOT NULL, observation TEXT NOT NULL, raw TEXT NOT NULL DEFAULT '{}',
  sha256 TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL DEFAULT 'valid',
  invalidation_reason TEXT, related_entity_ids TEXT NOT NULL DEFAULT '[]', assertion TEXT NOT NULL DEFAULT 'observed',
  synthetic INTEGER NOT NULL DEFAULT 0, pivot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_op ON evidence(operation_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(operation_id, sha256);

CREATE TABLE IF NOT EXISTS evidence_entities (
  evidence_id TEXT NOT NULL, entity_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (evidence_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_entities_entity ON evidence_entities(entity_id);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, type TEXT NOT NULL,
  state TEXT NOT NULL, confidence REAL NOT NULL, reasoning TEXT NOT NULL DEFAULT '', evidence_ids TEXT NOT NULL DEFAULT '[]',
  contradicting_evidence_ids TEXT NOT NULL DEFAULT '[]', first_observed TEXT NOT NULL, last_observed TEXT NOT NULL,
  assertion TEXT NOT NULL DEFAULT 'observed', sources TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_identity ON relationships(operation_id, source_entity_id, target_entity_id, type);

CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, template_key TEXT, status TEXT NOT NULL, confidence REAL NOT NULL,
  data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_op ON hypotheses(operation_id);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, key TEXT, status TEXT NOT NULL, priority REAL NOT NULL, data TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_op ON leads(operation_id, status, priority);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_key ON leads(operation_id, key) WHERE key IS NOT NULL;

CREATE TABLE IF NOT EXISTS fingerprints (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, signature_type TEXT NOT NULL, value TEXT NOT NULL, description TEXT NOT NULL,
  active_window TEXT NOT NULL DEFAULT '', weight REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_value ON fingerprints(signature_type, value);

CREATE TABLE IF NOT EXISTS reappearance_alerts (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, candidate TEXT NOT NULL, status TEXT NOT NULL, score REAL NOT NULL,
  data TEXT NOT NULL, detected_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reappearance_candidate ON reappearance_alerts(operation_id, candidate);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, target_type TEXT NOT NULL, target_value TEXT NOT NULL, status TEXT NOT NULL,
  next_run_at TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(status, next_run_at);

CREATE TABLE IF NOT EXISTS pursuit_runs (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, status TEXT NOT NULL, config TEXT NOT NULL, budget_used INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, stop_reason TEXT, stats TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_op ON pursuit_runs(operation_id, started_at);

CREATE TABLE IF NOT EXISTS pivots (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, run_id TEXT, collector TEXT NOT NULL, pivot_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  target_type TEXT NOT NULL, target_value TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, priority REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  signature TEXT NOT NULL, result TEXT, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pivots_signature ON pivots(operation_id, signature);
CREATE INDEX IF NOT EXISTS idx_pivots_status ON pivots(status);

CREATE TABLE IF NOT EXISTS strategy_stats (
  pivot_type TEXT NOT NULL, entity_type TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
  useful_yield REAL NOT NULL DEFAULT 0, new_entities INTEGER NOT NULL DEFAULT 0, contradictions INTEGER NOT NULL DEFAULT 0,
  confidence_sum REAL NOT NULL DEFAULT 0, analyst_positive INTEGER NOT NULL DEFAULT 0, analyst_negative INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY (pivot_type, entity_type)
);

CREATE TABLE IF NOT EXISTS learning_outcomes (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, pivot_type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_op ON learning_outcomes(operation_id, timestamp);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, importance REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_key ON findings(operation_id, key);

CREATE TABLE IF NOT EXISTS analysis_cache (
  operation_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, kind)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT NOT NULL, metrics TEXT NOT NULL, entity_keys TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_op ON checkpoints(operation_id, created_at);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_changes_op ON changes(operation_id, at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_op ON audit_log(operation_id, timestamp);

CREATE TABLE IF NOT EXISTS collector_cache (
  key TEXT PRIMARY KEY, collector TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT
);

CREATE TABLE IF NOT EXISTS labels (value TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, coalesce_key TEXT, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_coalesce ON outbox(coalesce_key, status);

CREATE TABLE IF NOT EXISTS main_links (
  operation_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', linked_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_main_links_ext ON main_links(kind, external_id);

CREATE TABLE IF NOT EXISTS main_events_processed (event_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, processed_at TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: 'v2_0_living_model',
    sql: `
-- Temporal facet ledger: every distinct value a facet (A records, nameservers, status, page structure, ...) has had.
CREATE TABLE IF NOT EXISTS facet_values (
  operation_id TEXT NOT NULL, entity_id TEXT NOT NULL, facet TEXT NOT NULL, value_hash TEXT NOT NULL, value TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, observations INTEGER NOT NULL DEFAULT 1, sources TEXT NOT NULL DEFAULT '[]',
  current INTEGER NOT NULL DEFAULT 1, ended_at TEXT,
  PRIMARY KEY (entity_id, facet, value_hash)
);
CREATE INDEX IF NOT EXISTS idx_facet_values_op ON facet_values(operation_id, facet);
CREATE TABLE IF NOT EXISTS facet_changes (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, entity_id TEXT NOT NULL, facet TEXT NOT NULL, kind TEXT NOT NULL,
  from_value TEXT, to_value TEXT, at TEXT NOT NULL, source TEXT NOT NULL, significance REAL NOT NULL DEFAULT 0.5,
  evidence_id TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_facet_changes_op ON facet_changes(operation_id, at);

-- Probabilistic membership of entities in an operation, with the factors that explain it.
CREATE TABLE IF NOT EXISTS membership (
  operation_id TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL, probability REAL NOT NULL,
  factors TEXT NOT NULL DEFAULT '[]', since TEXT NOT NULL, updated_at TEXT NOT NULL, analyst_verdict TEXT,
  PRIMARY KEY (operation_id, entity_id)
);
CREATE TABLE IF NOT EXISTS membership_feedback (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, entity_id TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT,
  factors TEXT NOT NULL DEFAULT '[]', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_membership_feedback_op ON membership_feedback(operation_id);

-- Lines of inquiry pursued in parallel, each with its own yield history and exhaustion state.
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT NOT NULL, question TEXT NOT NULL,
  status TEXT NOT NULL, stats TEXT NOT NULL DEFAULT '{}', revisit_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_anchor ON branches(operation_id, kind, anchor);

-- Versioned snapshots of the living operation model and what changed between them.
CREATE TABLE IF NOT EXISTS model_versions (
  operation_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, trigger TEXT NOT NULL,
  summary TEXT NOT NULL, snapshot TEXT NOT NULL, diff TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (operation_id, version)
);

-- Standing reappearance hunts (certificate pattern, private nameserver, kit resource, operator identifier, wallet watch).
CREATE TABLE IF NOT EXISTS hunts (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, query TEXT NOT NULL, status TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL, next_run_at TEXT NOT NULL, last_run_at TEXT, runs INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hunts_query ON hunts(operation_id, kind, query);
CREATE INDEX IF NOT EXISTS idx_hunts_due ON hunts(status, next_run_at);

-- Entity resolution: alternative spellings/encodings that denote the same thing.
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY, canonical TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases(canonical);

-- Contextual strategy learning measured in progress (not raw volume), with delayed credit.
CREATE TABLE IF NOT EXISTS learner (
  context TEXT NOT NULL, pivot_type TEXT NOT NULL, pulls REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0, progress_sq REAL NOT NULL DEFAULT 0, credited REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (context, pivot_type)
);
CREATE TABLE IF NOT EXISTS credits (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, pivot_id TEXT NOT NULL, entity_id TEXT, kind TEXT NOT NULL, amount REAL NOT NULL, at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_unique ON credits(operation_id, pivot_id, kind, entity_id);

-- Deterministic contradictions, fingerprinted so each is raised once.
CREATE TABLE IF NOT EXISTS contradictions (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  severity REAL NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', detected_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contradictions_fp ON contradictions(operation_id, fingerprint);

-- Global daily resource governor across operations.
CREATE TABLE IF NOT EXISTS resource_ledger (
  day TEXT NOT NULL, operation_id TEXT NOT NULL, spent REAL NOT NULL DEFAULT 0, pivots INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, operation_id)
);

ALTER TABLE pivots ADD COLUMN branch_id TEXT;
ALTER TABLE pivots ADD COLUMN progress REAL;
ALTER TABLE pivots ADD COLUMN value_estimate REAL;
`,
  },
];
