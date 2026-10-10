-- v9 adds durable operator state without changing specialist or source records.
CREATE TABLE IF NOT EXISTS autonomy_investigations (
 investigation_id TEXT PRIMARY KEY REFERENCES investigations(id), site_url TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'Starting', doing TEXT NOT NULL DEFAULT 'Starting investigation',
 next_action TEXT NOT NULL DEFAULT 'Main will collect public evidence and observe normal browsing.',
 stop_reason TEXT, next_at TEXT, revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS autonomy_history (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
 content_hash TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(investigation_id,content_hash)
);
CREATE INDEX IF NOT EXISTS autonomy_due ON autonomy_investigations(next_at,updated_at);
CREATE TABLE IF NOT EXISTS autonomy_checkpoints (
 investigation_id TEXT NOT NULL, checkpoint_key TEXT NOT NULL, kind TEXT NOT NULL,
 what TEXT NOT NULL, why TEXT NOT NULL, action TEXT NOT NULL, afterward TEXT NOT NULL,
 url TEXT, status TEXT NOT NULL DEFAULT 'open', source_id TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(investigation_id,checkpoint_key)
);
CREATE INDEX IF NOT EXISTS autonomy_attention ON autonomy_checkpoints(status,investigation_id);
CREATE TABLE IF NOT EXISTS scientific_matches (
 test_id TEXT NOT NULL, hypothesis_key TEXT NOT NULL, role TEXT NOT NULL, outcome TEXT NOT NULL,
 evidence_ids TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(test_id,hypothesis_key)
);
CREATE INDEX IF NOT EXISTS work_target_terminal ON work_items(kind,target_key,status);
CREATE INDEX IF NOT EXISTS jobs_target_proof ON jobs(target_entity_id,target_module,status,completed_at);
CREATE INDEX IF NOT EXISTS evidence_investigation_recent ON evidence(investigation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_observation_domain ON wallet_observations(domain,context_class,received_at);
INSERT OR IGNORE INTO ops_state(key,value) VALUES ('autonomy_enabled','true'),('scientific_policy_version','9');

CREATE TABLE IF NOT EXISTS autonomy_report_claims (
 investigation_id TEXT NOT NULL, content_hash TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE,
 approval_id TEXT NOT NULL UNIQUE, PRIMARY KEY(investigation_id,content_hash)
);
