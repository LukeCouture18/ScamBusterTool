-- Durable selection owns no analyst votes or private account information.
CREATE TABLE IF NOT EXISTS autonomy_searches (
 id TEXT PRIMARY KEY, active_slot INTEGER UNIQUE, state TEXT NOT NULL DEFAULT 'Finding site',
 candidate_id TEXT, investigation_id TEXT, assessment TEXT NOT NULL DEFAULT '{}',
 generation INTEGER NOT NULL DEFAULT 0, job_id TEXT, reason TEXT NOT NULL DEFAULT '',
 lease_owner TEXT, lease_until TEXT, deadline_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS autonomy_candidate_claims (
 candidate_id TEXT PRIMARY KEY, search_id TEXT NOT NULL UNIQUE REFERENCES autonomy_searches(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inbox_supply_lock (
 id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_at TEXT
);
INSERT OR IGNORE INTO inbox_supply_lock(id) VALUES(1);
CREATE INDEX IF NOT EXISTS autonomy_search_due ON autonomy_searches(state,updated_at);
CREATE INDEX IF NOT EXISTS wallet_candidate_address_proof ON wallet_candidates(address_normalized,validated_network,validation_status,best_context);
