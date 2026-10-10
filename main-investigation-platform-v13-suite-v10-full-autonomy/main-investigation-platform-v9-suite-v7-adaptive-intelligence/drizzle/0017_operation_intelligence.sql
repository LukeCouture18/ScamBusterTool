-- v6: additive coordination/provenance projections. Original evidence and report tables unchanged.
CREATE TABLE IF NOT EXISTS operation_state (
 operation_id TEXT PRIMARY KEY REFERENCES hunter_operations(id), state TEXT NOT NULL DEFAULT 'ACTIVE',
 revision INTEGER NOT NULL DEFAULT 0, semantic_hash TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 1,
 lease_owner TEXT, lease_until TEXT, last_evaluated_at TEXT, last_action_at TEXT, reason TEXT NOT NULL DEFAULT '',
 max_hunts INTEGER NOT NULL DEFAULT 8, hunts INTEGER NOT NULL DEFAULT 0, empty_runs INTEGER NOT NULL DEFAULT 0,
 boundary_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS operation_state_queue ON operation_state(dirty,state,last_action_at);
CREATE TABLE IF NOT EXISTS operation_entities (
 operation_id TEXT NOT NULL REFERENCES hunter_operations(id), entity_id TEXT NOT NULL REFERENCES entities(id),
 association TEXT NOT NULL DEFAULT 'proposed', origin TEXT NOT NULL DEFAULT 'hunter', reason TEXT NOT NULL DEFAULT '',
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(operation_id,entity_id)
);
CREATE INDEX IF NOT EXISTS operation_entity_lookup ON operation_entities(entity_id,association,operation_id);
CREATE TABLE IF NOT EXISTS operation_edges (
 operation_id TEXT NOT NULL REFERENCES hunter_operations(id), relationship_id TEXT NOT NULL REFERENCES relationships(id),
 source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, relationship_type TEXT NOT NULL,
 assertion_kind TEXT NOT NULL, category TEXT NOT NULL, independence_key TEXT NOT NULL,
 source_module TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL,
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(operation_id,relationship_id)
);
CREATE INDEX IF NOT EXISTS operation_edge_source ON operation_edges(operation_id,source_entity_id,category);
CREATE INDEX IF NOT EXISTS operation_edge_target ON operation_edges(operation_id,target_entity_id,category);
CREATE INDEX IF NOT EXISTS operation_relationship_target ON relationships(target_entity_id,id);
CREATE INDEX IF NOT EXISTS operation_relationship_source ON relationships(source_entity_id,id);
CREATE TABLE IF NOT EXISTS operation_hypotheses (
 operation_id TEXT NOT NULL REFERENCES hunter_operations(id), hypothesis_key TEXT NOT NULL, statement TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', confidence REAL, uncertainty TEXT NOT NULL,
 supports TEXT NOT NULL DEFAULT '[]', contradicts TEXT NOT NULL DEFAULT '[]', alternatives TEXT NOT NULL DEFAULT '[]',
 strengthen TEXT NOT NULL, weaken TEXT NOT NULL, next_test TEXT NOT NULL, content_hash TEXT NOT NULL,
 source_module TEXT NOT NULL DEFAULT 'operation_hunter', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(operation_id,hypothesis_key)
);
CREATE TABLE IF NOT EXISTS operation_history (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES hunter_operations(id), kind TEXT NOT NULL,
 record_key TEXT NOT NULL, content_hash TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL,
 UNIQUE(operation_id,kind,record_key,content_hash)
);
CREATE INDEX IF NOT EXISTS operation_history_time ON operation_history(operation_id,at DESC,id);
CREATE TABLE IF NOT EXISTS operation_facets (
 operation_id TEXT NOT NULL REFERENCES hunter_operations(id), entity_key TEXT NOT NULL, facet TEXT NOT NULL,
 value TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, source_module TEXT NOT NULL,
 PRIMARY KEY(operation_id,entity_key,facet)
);
CREATE TABLE IF NOT EXISTS operation_contradictions (
 operation_id TEXT NOT NULL REFERENCES hunter_operations(id), fingerprint TEXT NOT NULL, summary TEXT NOT NULL,
 status TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(operation_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS operation_hunts (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES hunter_operations(id), fingerprint TEXT NOT NULL UNIQUE,
 family TEXT NOT NULL, reason TEXT NOT NULL, value REAL NOT NULL, work_item_id TEXT, status TEXT NOT NULL DEFAULT 'reserved',
 baseline TEXT NOT NULL DEFAULT '{}', outcome TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 finished_at TEXT
);
CREATE INDEX IF NOT EXISTS operation_hunt_status ON operation_hunts(operation_id,status);
CREATE TABLE IF NOT EXISTS operation_decisions (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES hunter_operations(id), kind TEXT NOT NULL,
 target_operation_id TEXT, entity_ids TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL, boundary_revision INTEGER NOT NULL,
 review_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', result TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS operation_aliases (
 operation_id TEXT PRIMARY KEY REFERENCES hunter_operations(id), target_operation_id TEXT NOT NULL REFERENCES hunter_operations(id),
 decision_id TEXT NOT NULL REFERENCES operation_decisions(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Global scheduling is serialized by Main's existing scheduler lease; per-operation reservations survive crashes.
INSERT OR IGNORE INTO ops_state(key,value) VALUES ('operation_daily_hunts','24'),('operation_active_hunts','4');

CREATE INDEX IF NOT EXISTS operation_edge_independence ON operation_edges(independence_key,operation_id);
