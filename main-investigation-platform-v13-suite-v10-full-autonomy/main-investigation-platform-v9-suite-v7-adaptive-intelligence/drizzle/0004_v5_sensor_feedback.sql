CREATE TABLE IF NOT EXISTS site_triage (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES event_store(id),
 investigation_id TEXT REFERENCES investigations(id), entity_id TEXT REFERENCES entities(id),
 source_module TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('observed','triaged','promoted','dismissed','inconclusive')),
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), indicators TEXT NOT NULL DEFAULT '[]',
 reasons TEXT NOT NULL DEFAULT '[]', discovery_path TEXT NOT NULL DEFAULT '{}',
 request_downstream INTEGER NOT NULL DEFAULT 0, provenance TEXT NOT NULL DEFAULT '{}', observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_triage_entity ON site_triage(entity_id,observed_at);
CREATE TABLE IF NOT EXISTS module_event_inbox (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES event_store(id), module_name TEXT NOT NULL,
 acknowledged_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(event_id,module_name)
);
CREATE INDEX IF NOT EXISTS idx_module_event_inbox_pending ON module_event_inbox(module_name,acknowledged_at,created_at);
CREATE TABLE IF NOT EXISTS module_metrics (
 id TEXT PRIMARY KEY, source_module TEXT NOT NULL, technique TEXT NOT NULL, campaign TEXT NOT NULL,
 window_start TEXT NOT NULL, window_end TEXT NOT NULL, metrics TEXT NOT NULL DEFAULT '{}',
 provenance TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_module,technique,campaign,window_start,window_end)
);
CREATE INDEX IF NOT EXISTS idx_module_metrics_window ON module_metrics(source_module,window_start);
