PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS websites (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), normalized_domain TEXT NOT NULL, start_url TEXT NOT NULL, title TEXT, status TEXT, risk_score INTEGER DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(case_id, normalized_domain));
CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id), url TEXT NOT NULL, kind TEXT, title TEXT, http_status INTEGER, auth_scope TEXT NOT NULL DEFAULT 'public', content_hash TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(website_id,url,auth_scope));
CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, canonical_address TEXT NOT NULL, network TEXT, token TEXT, confidence REAL NOT NULL, first_seen TEXT NOT NULL, UNIQUE(canonical_address,network,token));
CREATE TABLE IF NOT EXISTS deposit_options (id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id), page_id TEXT REFERENCES pages(id), wallet_id TEXT REFERENCES wallets(id), token TEXT, network TEXT, label TEXT, auth_scope TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), website_id TEXT REFERENCES websites(id), page_id TEXT REFERENCES pages(id), kind TEXT NOT NULL, source_class TEXT NOT NULL, source_url TEXT, value_json TEXT NOT NULL, confidence REAL NOT NULL, collected_at TEXT NOT NULL, artifact_path TEXT, sha256 TEXT);
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), website_id TEXT REFERENCES websites(id), kind TEXT NOT NULL, summary TEXT NOT NULL, source_class TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relationships (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, relationship_type TEXT NOT NULL, evidence_id TEXT REFERENCES evidence(id), confidence REAL NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), website_id TEXT REFERENCES websites(id), body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,tag));
CREATE TABLE IF NOT EXISTS timeline (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), website_id TEXT REFERENCES websites(id), event_type TEXT NOT NULL, source_class TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, case_id TEXT, website_id TEXT, job_type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence(case_id,collected_at);
CREATE INDEX IF NOT EXISTS idx_timeline_case ON timeline(case_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(website_id);
CREATE INDEX IF NOT EXISTS idx_relationships_case ON relationships(case_id);

