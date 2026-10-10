-- Suite v5: additive durable direction. Rollback drops only these seven tables.
CREATE TABLE IF NOT EXISTS director_investigations (
 investigation_id TEXT PRIMARY KEY REFERENCES investigations(id), state TEXT NOT NULL DEFAULT 'RUNNING',
 stop_reason TEXT, headline TEXT NOT NULL DEFAULT 'Understanding the investigation', next_at TEXT,
 lease_owner TEXT, lease_until TEXT, revision INTEGER NOT NULL DEFAULT 0, watermark TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS director_objectives (
 investigation_id TEXT NOT NULL REFERENCES investigations(id), objective TEXT NOT NULL, status TEXT NOT NULL,
 reason TEXT NOT NULL, evidence_refs TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(investigation_id,objective)
);
CREATE TABLE IF NOT EXISTS director_actions (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id), fingerprint TEXT NOT NULL,
 kind TEXT NOT NULL, target TEXT NOT NULL, gap TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
 expected_value REAL NOT NULL, cost REAL NOT NULL, risk REAL NOT NULL DEFAULT 0,
 job_id TEXT, result TEXT NOT NULL DEFAULT '{}', useful REAL, before_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(investigation_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_director_actions_pending ON director_actions(investigation_id,status);
CREATE TABLE IF NOT EXISTS director_retries (
 candidate_id TEXT PRIMARY KEY REFERENCES wallet_candidates(id), investigation_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'parked', attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 generation INTEGER NOT NULL DEFAULT 0, source_job_id TEXT, job_id TEXT, next_at TEXT NOT NULL,
 reason TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS director_provider_health (
 network TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'unknown', failures INTEGER NOT NULL DEFAULT 0,
 next_probe_at TEXT, last_result_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS director_resources (
 investigation_id TEXT PRIMARY KEY REFERENCES investigations(id),
 max_jobs INTEGER NOT NULL DEFAULT 30, max_requests INTEGER NOT NULL DEFAULT 500,
 max_provider_calls INTEGER NOT NULL DEFAULT 120, max_public_work INTEGER NOT NULL DEFAULT 250,
 max_finder INTEGER NOT NULL DEFAULT 4, max_hunter INTEGER NOT NULL DEFAULT 2,
 max_wallet INTEGER NOT NULL DEFAULT 20, max_effort_seconds INTEGER NOT NULL DEFAULT 7200,
 jobs INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, provider_calls INTEGER NOT NULL DEFAULT 0,
 public_work INTEGER NOT NULL DEFAULT 0, finder INTEGER NOT NULL DEFAULT 0, hunter INTEGER NOT NULL DEFAULT 0,
 wallet INTEGER NOT NULL DEFAULT 0, effort_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS director_reservations (
 job_id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id), cost TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
