-- 0015 · v4 wallet pipeline (additive).
-- Logger observations -> one wallet candidate per (investigation, family:normalised address) -> Wallet
-- Investigator validation/analysis -> automatically built report contents bound to an exact hash.
CREATE TABLE IF NOT EXISTS wallet_candidates (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  identity TEXT NOT NULL,                       -- family:normalised address (one wallet however often it is seen)
  family TEXT NOT NULL,
  address TEXT NOT NULL,                        -- exactly as exposed to the browser (case preserved)
  address_normalized TEXT NOT NULL,
  candidate_networks TEXT NOT NULL DEFAULT '[]',
  network_hint TEXT,                            -- strongest hint seen (JSON)
  best_context TEXT NOT NULL DEFAULT 'unknown', -- deposit|withdrawal|example|transaction_history|contract|unrelated|unknown
  best_context_confidence REAL NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  deposit_observations INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'pending', -- pending|queued|valid|invalid|network_ambiguous|unsupported|unable_to_validate
  validated_network TEXT,
  validation TEXT,                              -- Wallet Investigator result (JSON)
  validation_job_id TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'none', -- none|queued|completed|partial|failed|skipped
  analysis_job_id TEXT,
  entity_id TEXT,                               -- validated wallet entity (<network>:<address>)
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (investigation_id, identity)
);
CREATE INDEX IF NOT EXISTS idx_wallet_candidates_status ON wallet_candidates(investigation_id, validation_status);

CREATE TABLE IF NOT EXISTS wallet_observations (
  id TEXT PRIMARY KEY,                          -- logger observationId (stable per family|address|page|method|class)
  candidate_id TEXT NOT NULL REFERENCES wallet_candidates(id),
  investigation_id TEXT NOT NULL,
  address TEXT NOT NULL,
  context_class TEXT NOT NULL,
  context_confidence REAL NOT NULL DEFAULT 0,
  cues TEXT NOT NULL DEFAULT '[]',
  negative_cues TEXT NOT NULL DEFAULT '[]',
  section TEXT,
  snippet TEXT,
  method TEXT,
  methods TEXT NOT NULL DEFAULT '[]',
  after_interaction INTEGER NOT NULL DEFAULT 0,
  network_hint TEXT,
  format_check TEXT,
  domain TEXT,
  page_url TEXT,
  frame_url TEXT,
  page_title TEXT,
  details TEXT,                                 -- domPath, qrPayload, responseUrl, uri (JSON)
  first_seen TEXT,
  last_seen TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  evidence_id TEXT,                             -- the Main evidence row preserving this observation
  content_sha256 TEXT NOT NULL,
  source_event_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_observations_candidate ON wallet_observations(candidate_id);
CREATE INDEX IF NOT EXISTS idx_wallet_observations_page ON wallet_observations(investigation_id, page_url);

-- What kinds of pages and interface patterns turn out to carry genuine deposit wallets.
CREATE TABLE IF NOT EXISTS wallet_discovery_stats (
  pattern TEXT PRIMARY KEY,                     -- e.g. path:/deposit/*, method:qr, section:deposit usdt
  kind TEXT NOT NULL,
  observations INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,         -- validated wallets in a deposit context
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The full content of an automatically built wallet report (bound by report_candidates.evidence_sha256).
CREATE TABLE IF NOT EXISTS report_contents (
  candidate_id TEXT PRIMARY KEY REFERENCES report_candidates(id),
  investigation_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'wallet-report-v4',
  summary TEXT NOT NULL,                        -- what the analyst sees (JSON)
  warnings TEXT NOT NULL DEFAULT '[]',
  ready INTEGER NOT NULL DEFAULT 0,             -- every required field and provenance check passed
  destination_sha256 TEXT,
  superseded_by TEXT,
  stale_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_report_contents_investigation ON report_contents(investigation_id, created_at);

-- Where an approved report would be submitted, as the submitting module reports it.
CREATE TABLE IF NOT EXISTS module_destinations (
  module_name TEXT PRIMARY KEY,
  destination TEXT NOT NULL,                    -- {kind, form_id, form_url, version_hash, title}
  destination_sha256 TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
