CREATE TABLE IF NOT EXISTS investigation_state (
 investigation_id TEXT PRIMARY KEY REFERENCES investigations(id), state TEXT NOT NULL DEFAULT 'NEW',
 derived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL DEFAULT '', source_event_id TEXT
);
CREATE TABLE IF NOT EXISTS investigation_state_history (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id), from_state TEXT,
 to_state TEXT NOT NULL, reason TEXT NOT NULL, source_event_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_state_history_inv ON investigation_state_history(investigation_id,created_at);
CREATE TABLE IF NOT EXISTS investigation_budgets (
 investigation_id TEXT PRIMARY KEY REFERENCES investigations(id), max_jobs INTEGER NOT NULL DEFAULT 30,
 max_related_sites INTEGER NOT NULL DEFAULT 10, max_wallets INTEGER NOT NULL DEFAULT 20,
 max_expansion_depth INTEGER NOT NULL DEFAULT 2, max_api_calls INTEGER NOT NULL DEFAULT 500,
 max_runtime_seconds INTEGER NOT NULL DEFAULT 7200, used_jobs INTEGER NOT NULL DEFAULT 0,
 used_related_sites INTEGER NOT NULL DEFAULT 0, used_wallets INTEGER NOT NULL DEFAULT 0,
 used_api_calls INTEGER NOT NULL DEFAULT 0, used_runtime_seconds INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS planner_decisions (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 entity_id TEXT REFERENCES entities(id), source_event_id TEXT REFERENCES event_store(id),
 action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, policy TEXT NOT NULL,
 evidence_refs TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0,
 expected_value REAL NOT NULL DEFAULT 0, limits TEXT NOT NULL DEFAULT '{}',
 job_id TEXT REFERENCES jobs(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_event_id,action,entity_id)
);
CREATE INDEX IF NOT EXISTS idx_planner_decisions_inv ON planner_decisions(investigation_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_decisions_once ON planner_decisions(source_event_id,action,COALESCE(entity_id,''));
CREATE TABLE IF NOT EXISTS approval_gates (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 job_id TEXT REFERENCES jobs(id), action TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 requested_reason TEXT NOT NULL, decided_by TEXT, decided_at TEXT, decision_reason TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(job_id,action)
);
CREATE TABLE IF NOT EXISTS expansion_candidates (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 entity_id TEXT NOT NULL REFERENCES entities(id), relationship_id TEXT REFERENCES relationships(id),
 depth INTEGER NOT NULL DEFAULT 1, evidence_refs TEXT NOT NULL DEFAULT '[]',
 confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(investigation_id,entity_id,relationship_id)
);
CREATE TABLE IF NOT EXISTS resolved_observations (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 entity_id TEXT NOT NULL REFERENCES entities(id), field TEXT NOT NULL, value TEXT NOT NULL,
 method TEXT NOT NULL, confidence REAL NOT NULL, supporting_ids TEXT NOT NULL DEFAULT '[]',
 conflicting_ids TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
 resolved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(investigation_id,entity_id,field)
);
CREATE TABLE IF NOT EXISTS evidence_quality (
 evidence_id TEXT PRIMARY KEY REFERENCES evidence(id), quality REAL NOT NULL,
 directness REAL NOT NULL, freshness REAL NOT NULL, corroboration REAL NOT NULL,
 verification REAL NOT NULL, rationale TEXT NOT NULL, evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cross_investigation_overlaps (
 id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id),
 first_investigation_id TEXT NOT NULL REFERENCES investigations(id),
 second_investigation_id TEXT NOT NULL REFERENCES investigations(id),
 observation_count INTEGER NOT NULL DEFAULT 2, reason TEXT NOT NULL,
 observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(entity_id,first_investigation_id,second_investigation_id)
);
CREATE TABLE IF NOT EXISTS monitoring_targets (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 entity_id TEXT NOT NULL REFERENCES entities(id), kind TEXT NOT NULL,
 interval_seconds INTEGER NOT NULL DEFAULT 86400, next_check_at TEXT NOT NULL,
 last_check_at TEXT, last_snapshot_hash TEXT, enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(investigation_id,entity_id,kind)
);
CREATE TABLE IF NOT EXISTS monitoring_snapshots (
 id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES monitoring_targets(id),
 content_hash TEXT NOT NULL, snapshot TEXT NOT NULL, changed INTEGER NOT NULL,
 captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(target_id,content_hash)
);
CREATE TABLE IF NOT EXISTS report_candidates (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id),
 status TEXT NOT NULL DEFAULT 'needs_review', evidence_snapshot TEXT NOT NULL,
 evidence_sha256 TEXT NOT NULL, approval_id TEXT REFERENCES approval_gates(id),
 submission_job_id TEXT REFERENCES jobs(id), verification_status TEXT NOT NULL DEFAULT 'unknown',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS discovery_feedback (
 id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL REFERENCES event_store(id),
 result_event_id TEXT NOT NULL REFERENCES event_store(id), technique TEXT NOT NULL,
 campaign TEXT NOT NULL, useful_observations INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_event_id,result_event_id)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_due ON monitoring_targets(enabled,next_check_at);
CREATE TABLE IF NOT EXISTS investigation_links (
 id TEXT PRIMARY KEY, first_investigation_id TEXT NOT NULL REFERENCES investigations(id),
 second_investigation_id TEXT NOT NULL REFERENCES investigations(id),
 status TEXT NOT NULL CHECK(status IN ('linked','separate')),
 reason TEXT NOT NULL, decided_by TEXT NOT NULL,
 decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(first_investigation_id,second_investigation_id)
);
