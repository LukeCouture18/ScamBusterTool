-- Missions coordinate permitted work. Findings remain in authoritative specialist/evidence tables.
CREATE TABLE IF NOT EXISTS autonomous_missions (
 id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL UNIQUE REFERENCES investigations(id),
 root_id TEXT NOT NULL,parent_id TEXT,depth INTEGER NOT NULL DEFAULT 0,target TEXT NOT NULL,
 objective TEXT NOT NULL DEFAULT 'Collect supported deposit evidence and prepare an exact report for approval',
 stage TEXT NOT NULL DEFAULT 'Starting',snapshot TEXT NOT NULL DEFAULT '{}',snapshot_hash TEXT NOT NULL DEFAULT '',
 stop_reason TEXT,next_action TEXT NOT NULL DEFAULT '',next_at TEXT,
 checked_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(root_id,target)
);
CREATE INDEX IF NOT EXISTS mission_fair_tick ON autonomous_missions(root_id,checked_at);
CREATE TABLE IF NOT EXISTS mission_resources (
 root_id TEXT PRIMARY KEY,max_sites INTEGER NOT NULL DEFAULT 4,max_depth INTEGER NOT NULL DEFAULT 2,
 max_jobs INTEGER NOT NULL DEFAULT 64,max_requests INTEGER NOT NULL DEFAULT 1200,max_provider_calls INTEGER NOT NULL DEFAULT 180,
 sites INTEGER NOT NULL DEFAULT 1,jobs INTEGER NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,provider_calls INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT,lease_until TEXT,checked_at TEXT
);
CREATE TABLE IF NOT EXISTS mission_reservations (
 job_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,cost TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mission_cost_root ON mission_reservations(root_id);
CREATE TABLE IF NOT EXISTS mission_opportunities (
 id TEXT PRIMARY KEY,root_id TEXT NOT NULL,parent_id TEXT NOT NULL,candidate_id TEXT NOT NULL UNIQUE,
 domain TEXT NOT NULL,url TEXT NOT NULL,depth INTEGER NOT NULL,assessment TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'selected',investigation_id TEXT,reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(root_id,domain)
);
CREATE INDEX IF NOT EXISTS mission_opportunity_pending ON mission_opportunities(root_id,status);
CREATE TABLE IF NOT EXISTS mission_history (
 id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL,stage TEXT NOT NULL,reason TEXT NOT NULL,
 decision TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(mission_id,snapshot_hash)
);
