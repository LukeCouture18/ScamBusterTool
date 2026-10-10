-- v8, additive only. Analytical state never replaces specialist evidence or approved boundaries.
CREATE TABLE IF NOT EXISTS scientific_sets (
 operation_id TEXT NOT NULL, set_key TEXT NOT NULL, question TEXT NOT NULL, scope TEXT NOT NULL,
 stop_state TEXT NOT NULL DEFAULT 'ALTERNATIVES_REMAIN', watermark TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,set_key)
);
CREATE TABLE IF NOT EXISTS scientific_hypotheses (
 operation_id TEXT NOT NULL, set_key TEXT NOT NULL, hypothesis_key TEXT NOT NULL, statement TEXT NOT NULL,
 role TEXT NOT NULL, status TEXT NOT NULL, uncertainty TEXT NOT NULL, supports TEXT NOT NULL DEFAULT '[]',
 contradicts TEXT NOT NULL DEFAULT '[]', unexplained TEXT NOT NULL DEFAULT '[]', alternatives TEXT NOT NULL DEFAULT '[]',
 assumptions TEXT NOT NULL DEFAULT '[]', predictions TEXT NOT NULL DEFAULT '[]', tests TEXT NOT NULL DEFAULT '[]',
 reason TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,set_key,hypothesis_key)
);
CREATE TABLE IF NOT EXISTS scientific_history (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, record_kind TEXT NOT NULL, record_key TEXT NOT NULL,
 before_state TEXT, after_state TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL,
 content_hash TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(operation_id,record_kind,record_key,content_hash)
);
CREATE INDEX IF NOT EXISTS scientific_history_scope ON scientific_history(operation_id,at DESC,id);
CREATE TABLE IF NOT EXISTS scientific_observations (
 operation_id TEXT NOT NULL, evidence_id TEXT NOT NULL, version_hash TEXT NOT NULL, subject TEXT NOT NULL,
 facet TEXT NOT NULL, value TEXT NOT NULL, reliability TEXT NOT NULL, independence_key TEXT NOT NULL,
 upstream_origin TEXT NOT NULL, source_module TEXT NOT NULL, captured_at TEXT NOT NULL, job_id TEXT,
 detail TEXT NOT NULL, PRIMARY KEY(operation_id,evidence_id,version_hash)
);
CREATE INDEX IF NOT EXISTS scientific_observation_scope ON scientific_observations(operation_id,subject,facet,captured_at);
CREATE TABLE IF NOT EXISTS scientific_predictions (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, set_key TEXT NOT NULL, hypothesis_key TEXT NOT NULL,
 expectation TEXT NOT NULL, would_weaken TEXT NOT NULL, strong_contradiction TEXT NOT NULL,
 test_family TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(operation_id,set_key,hypothesis_key,expectation)
);
CREATE TABLE IF NOT EXISTS scientific_plans (
 test_id TEXT PRIMARY KEY REFERENCES adaptive_tests(id), operation_id TEXT NOT NULL, set_key TEXT NOT NULL,
 question TEXT NOT NULL, branches TEXT NOT NULL, predictions_hash TEXT NOT NULL, baseline TEXT NOT NULL,
 falsification INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 outcome_branch TEXT, checked TEXT, coverage TEXT, limitations TEXT, observed_evidence TEXT,
 interpretation TEXT, assessed_at TEXT
);
CREATE TABLE IF NOT EXISTS scientific_contradictions (
 operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, claim TEXT NOT NULL, observations TEXT NOT NULL,
 independence_units TEXT NOT NULL, explanations TEXT NOT NULL, tests TEXT NOT NULL, importance TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'UNRESOLVED', resolution_evidence TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL,
 content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS scientific_conflict_status ON scientific_contradictions(operation_id,status,importance);
CREATE TABLE IF NOT EXISTS scientific_commonality (
 artifact_key TEXT PRIMARY KEY, corpus_sites INTEGER NOT NULL, observed_sites INTEGER NOT NULL, category TEXT NOT NULL,
 upstream_origin TEXT NOT NULL, limitations TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scientific_branches (
 operation_id TEXT NOT NULL, branch_key TEXT NOT NULL, novelty TEXT NOT NULL, discoveries INTEGER NOT NULL,
 duplicate_rate REAL, depth INTEGER NOT NULL, artifact_freshness TEXT NOT NULL, last_useful TEXT,
 coverage TEXT NOT NULL, unexplored TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,branch_key)
);
CREATE TABLE IF NOT EXISTS scientific_reservations (
 test_id TEXT PRIMARY KEY REFERENCES adaptive_tests(id), operation_id TEXT NOT NULL,
 purpose TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scientific_boundaries (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, cluster_a TEXT NOT NULL,
 cluster_b TEXT NOT NULL, shared_evidence TEXT NOT NULL, contradictions TEXT NOT NULL, reason TEXT NOT NULL,
 uncertainty TEXT NOT NULL, decision_id TEXT, status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scientific_briefings (
 operation_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO ops_state(key,value) VALUES ('scientific_enabled','true'),('scientific_falsification_fraction','0.25');
