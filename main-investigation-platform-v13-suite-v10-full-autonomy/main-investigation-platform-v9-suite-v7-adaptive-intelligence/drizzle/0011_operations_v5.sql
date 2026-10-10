-- Main Platform v5 "Operations": continuous, platform-wide investigation.
-- Additive only: new tables and indexes; no existing table or column changes,
-- so an interrupted or repeated upgrade can never leave an existing table
-- half-modified. Nothing here lets AI output become evidence.

-- ---------------------------------------------------------------------------
-- Global intelligence graph. Nodes and edges are DERIVED from observed and
-- deterministic platform rows; every edge cites its source row. Relationship is
-- never ownership. AI reasoning (hypotheses) links to nodes through a separate
-- table and never appears as an edge.
CREATE TABLE `intel_nodes` (
  `id` text PRIMARY KEY NOT NULL,
  `node_type` text NOT NULL,                 -- domain|wallet|chain_observation|ip|asn|certificate|nameserver|hosting|technology|template|favicon|identifier|evidence|investigation|campaign
  `node_key` text NOT NULL,
  `label` text DEFAULT '' NOT NULL,
  `generic` integer DEFAULT 0 NOT NULL,      -- 1 = shared by too many unrelated things (CDN, big host): links nothing
  `degree` integer DEFAULT 0 NOT NULL,
  `first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL    -- first source: {table, ref}
);
CREATE UNIQUE INDEX `idx_intel_nodes_key` ON `intel_nodes` (`node_type`,`node_key`);

CREATE TABLE `intel_edges` (
  `id` text PRIMARY KEY NOT NULL,
  `src_node` text NOT NULL,
  `dst_node` text NOT NULL,
  `kind` text NOT NULL,                      -- hosted_on|uses_nameserver|presents_certificate|uses_template|shows_favicon|displays_wallet|uses_service|related_site|member_of|investigates|supports|same_kit|observed_on_chain
  `basis` text NOT NULL,                     -- observed|deterministic
  `source_table` text NOT NULL,
  `source_ref` text NOT NULL,
  `strength` real DEFAULT 0.5 NOT NULL,      -- relationship strength (see confidence_records)
  `active` integer DEFAULT 1 NOT NULL,       -- 0 once a later observation shows the link no longer holds
  `first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_intel_edges_unique` ON `intel_edges` (`src_node`,`dst_node`,`kind`,`source_table`,`source_ref`);
CREATE INDEX `idx_intel_edges_src` ON `intel_edges` (`src_node`);
CREATE INDEX `idx_intel_edges_dst` ON `intel_edges` (`dst_node`);

CREATE TABLE `intel_reasoning_links` (      -- AI/deterministic reasoning ABOUT nodes; never an edge
  `id` text PRIMARY KEY NOT NULL,
  `reasoning_type` text NOT NULL,            -- hypothesis|inference
  `reasoning_ref` text NOT NULL,
  `node_id` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_intel_reasoning_unique` ON `intel_reasoning_links` (`reasoning_type`,`reasoning_ref`,`node_id`);

-- ---------------------------------------------------------------------------
-- Temporal intelligence: entity -> observation -> timestamp -> change -> opportunity.
-- `entity_facets` holds the current value of each observed facet; an identical
-- re-observation only updates last_seen (it is not new evidence). A different
-- value writes a snapshot and a change.
CREATE TABLE `entity_facets` (
  `subject_type` text NOT NULL,
  `subject_key` text NOT NULL,
  `facet` text NOT NULL,                     -- status|ip|nameservers|certificate|deposit_page|wallets|related|template|favicon
  `value_hash` text NOT NULL,
  `value` text NOT NULL,
  `source_table` text NOT NULL,
  `source_ref` text NOT NULL,
  `first_seen_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `observations` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (`subject_type`,`subject_key`,`facet`)
);
CREATE TABLE `entity_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `subject_type` text NOT NULL,
  `subject_key` text NOT NULL,
  `facet` text NOT NULL,
  `value_hash` text NOT NULL,
  `value` text NOT NULL,
  `source_table` text NOT NULL,
  `source_ref` text NOT NULL,
  `observed_at` text NOT NULL
);
CREATE INDEX `idx_entity_snapshots_subject` ON `entity_snapshots` (`subject_type`,`subject_key`,`facet`,`observed_at`);
CREATE TABLE `entity_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `subject_type` text NOT NULL,
  `subject_key` text NOT NULL,
  `facet` text NOT NULL,
  `change_kind` text NOT NULL,               -- site_disappeared|site_returned|infrastructure_changed|certificate_changed|deposit_appeared|deposit_disappeared|wallet_changed|related_domain_appeared|cluster_inactive
  `from_value` text,
  `to_value` text,
  `significance` real DEFAULT 0.5 NOT NULL,
  `source_table` text NOT NULL,
  `source_ref` text NOT NULL,
  `detected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `work_item_id` text                        -- the opportunity it created, if any
);
CREATE INDEX `idx_entity_changes_subject` ON `entity_changes` (`subject_type`,`subject_key`,`detected_at`);

-- ---------------------------------------------------------------------------
-- Global opportunity queue: every piece of investigation work is a typed,
-- deterministically scored work item. The scheduler is the only executor.
CREATE TABLE `work_items` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,                      -- investigate_candidate|revisit_changed_site|inspect_infrastructure|analyze_wallet|expand_campaign|test_hypothesis|compare_clusters|revisit_incomplete|draft_report|review_contradiction|campaign_step|form_campaign|merge_campaigns|split_campaign|discovery_cycle
  `target_type` text NOT NULL,
  `target_key` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,   -- queued|running|waiting_human|done|failed|cancelled|suppressed|deferred
  `priority` real DEFAULT 0 NOT NULL,
  `factors` text DEFAULT '{}' NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `source` text NOT NULL,                    -- discovery|change|gap|campaign|contradiction|command|formation|scheduler|experiment
  `module` text,                             -- which module it will load, for per-module limits
  `campaign_id` text,
  `investigation_id` text,
  `gap_id` text,
  `experiment_id` text,
  `experiment_arm` text,
  `not_before` text,                         -- cooldown / backoff
  `attempts` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 3 NOT NULL,
  `last_error` text,
  `lease_owner` text,
  `lease_until` text,
  `job_id` text,
  `run_id` text,
  `result` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `started_at` text,
  `finished_at` text
);
CREATE UNIQUE INDEX `idx_work_items_fingerprint` ON `work_items` (`fingerprint`);
CREATE INDEX `idx_work_items_queue` ON `work_items` (`status`,`priority`);
CREATE INDEX `idx_work_items_campaign` ON `work_items` (`campaign_id`,`status`);
CREATE TABLE `work_item_events` (
  `id` text PRIMARY KEY NOT NULL,
  `work_item_id` text NOT NULL,
  `event` text NOT NULL,
  `detail` text DEFAULT '{}' NOT NULL,
  `at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_work_item_events_item` ON `work_item_events` (`work_item_id`);

-- ---------------------------------------------------------------------------
-- Scheduler, budgets, settings.
CREATE TABLE `ops_state` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO `ops_state` (`key`,`value`) VALUES
  ('scheduler_paused','false'),
  ('discovery_paused','false'),
  ('discovery_min_priority','0'),
  ('max_concurrent_work','6'),
  ('module_limit:site_investigator','3'),
  ('module_limit:wallet_investigator','3'),
  ('module_limit:site_finder','2'),
  ('module_limit:crypto_wallet_logger','2'),
  ('exploration_share','0.1'),
  ('starvation_boost_per_hour','0.02'),
  ('starvation_boost_cap','0.25'),
  ('auto_form_campaigns','true'),
  ('auto_merge_campaigns','true'),
  ('revisit_cooldown_hours','24'),
  ('lease_seconds','180');
CREATE TABLE `scheduler_ticks` (
  `id` text PRIMARY KEY NOT NULL,
  `owner` text NOT NULL,
  `started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `finished_at` text,
  `status` text DEFAULT 'running' NOT NULL,  -- running|done|failed|skipped
  `summary` text DEFAULT '{}' NOT NULL
);
CREATE INDEX `idx_scheduler_ticks_started` ON `scheduler_ticks` (`started_at`);
CREATE TABLE `budget_limits` (
  `scope` text NOT NULL,                     -- global|campaign:<id>|module:<name>|provider:<name>
  `kind` text NOT NULL,                      -- module_jobs|discovery_requests|investigations|model_calls|model_tokens|model_cost_usd
  `window` text NOT NULL,                    -- day|total
  `max_units` real NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`scope`,`kind`,`window`)
);
INSERT OR IGNORE INTO `budget_limits` (`scope`,`kind`,`window`,`max_units`) VALUES
  ('global','module_jobs','day',400),
  ('global','discovery_requests','day',60),
  ('global','investigations','day',80),
  ('global','model_calls','day',300),
  ('global','model_tokens','day',600000),
  ('global','model_cost_usd','day',5);
CREATE TABLE `budget_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `kind` text NOT NULL,
  `units` real NOT NULL,
  `ref` text NOT NULL,
  `day` text NOT NULL,                       -- YYYY-MM-DD (UTC)
  `at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_budget_ledger_ref` ON `budget_ledger` (`scope`,`kind`,`ref`);
CREATE INDEX `idx_budget_ledger_day` ON `budget_ledger` (`scope`,`kind`,`day`);

-- ---------------------------------------------------------------------------
-- Evidence gaps: exactly what is missing, and how it ended.
CREATE TABLE `evidence_gaps` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text,
  `campaign_id` text,
  `subject_type` text NOT NULL,
  `subject_key` text NOT NULL,
  `gap_kind` text NOT NULL,                  -- no_site_observation|no_deposit_destination|wallet_not_analyzed|unconfirmed_relationship|infrastructure_unknown|stale_observation
  `known` text DEFAULT '[]' NOT NULL,
  `missing` text NOT NULL,
  `safe_actions` text DEFAULT '[]' NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,     -- open|resolved|unresolved|inaccessible|irrelevant
  `resolution` text,
  `resolved_by` text,
  `attempts` integer DEFAULT 0 NOT NULL,
  `history` text DEFAULT '[]' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_evidence_gaps_unique` ON `evidence_gaps` (`subject_type`,`subject_key`,`gap_kind`);
CREATE INDEX `idx_evidence_gaps_status` ON `evidence_gaps` (`status`);

-- ---------------------------------------------------------------------------
-- Confidence calibration: separate dimensions, each change with its reason.
CREATE TABLE `confidence_records` (
  `id` text PRIMARY KEY NOT NULL,
  `subject_type` text NOT NULL,
  `subject_id` text NOT NULL,
  `dimension` text NOT NULL,                 -- observation_reliability|relationship_strength|hypothesis_confidence|discovery_confidence|entity_resolution|ai_uncertainty
  `value` real NOT NULL,
  `previous` real,
  `reason` text NOT NULL,
  `basis` text NOT NULL,                     -- observed|deterministic|human|ai
  `source_ref` text,
  `at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_confidence_subject` ON `confidence_records` (`subject_type`,`subject_id`,`dimension`,`at`);

-- ---------------------------------------------------------------------------
-- Contradictions: never silently resolved; each creates a review.
CREATE TABLE `contradictions` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,                      -- providers_disagree|observations_conflict|ai_contradicts_evidence|known_fact_changed|equivalent_records_incompatible
  `subject_type` text NOT NULL,
  `subject_key` text NOT NULL,
  `a_ref` text NOT NULL,
  `b_ref` text NOT NULL,
  `a_value` text,
  `b_value` text,
  `detail` text DEFAULT '' NOT NULL,
  `importance` real DEFAULT 0.5 NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,     -- open|resolved|dismissed
  `resolution` text,
  `fingerprint` text NOT NULL,
  `work_item_id` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `resolved_at` text
);
CREATE UNIQUE INDEX `idx_contradictions_fingerprint` ON `contradictions` (`fingerprint`);

-- ---------------------------------------------------------------------------
-- Strategy experiments (bounded A/B).
CREATE TABLE `strategy_experiments` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `hypothesis` text NOT NULL,
  `domain` text NOT NULL,                    -- discovery|investigation
  `arm_a` text NOT NULL,
  `arm_b` text NOT NULL,
  `population_max` integer NOT NULL,
  `budget_units` real NOT NULL,
  `used_units` real DEFAULT 0 NOT NULL,
  `metric` text NOT NULL,                    -- useful_per_cost
  `stop_condition` text DEFAULT '{}' NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,    -- draft|running|stopped|complete
  `result` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `started_at` text,
  `finished_at` text
);
CREATE TABLE `experiment_assignments` (
  `id` text PRIMARY KEY NOT NULL,
  `experiment_id` text NOT NULL,
  `arm` text NOT NULL,
  `subject_key` text NOT NULL,
  `work_item_id` text,
  `outcome` real,
  `cost` real,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_experiment_assignments_subject` ON `experiment_assignments` (`experiment_id`,`subject_key`);

-- ---------------------------------------------------------------------------
-- Campaign formation, merge, split, inactivity: metadata and lineage (history).
CREATE TABLE `campaign_meta` (
  `campaign_id` text PRIMARY KEY NOT NULL,
  `origin` text DEFAULT 'manual' NOT NULL,   -- manual|auto|split|merge
  `formation_refs` text DEFAULT '[]' NOT NULL, -- intel edge ids that justified the grouping
  `goal` text DEFAULT '' NOT NULL,           -- campaign-level plan: what it is trying to learn
  `goal_revision` integer DEFAULT 0 NOT NULL,
  `merged_into` text,
  `split_from` text,
  `formed_by_work_item` text,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_campaign_meta_work_item` ON `campaign_meta` (`formed_by_work_item`);
CREATE TABLE `campaign_lineage` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `event` text NOT NULL,                     -- formed|merged_into|absorbed|split_from|split_off|inactive|reopened
  `related_campaign_id` text,
  `detail` text DEFAULT '{}' NOT NULL,
  `at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_campaign_lineage_campaign` ON `campaign_lineage` (`campaign_id`);

-- ---------------------------------------------------------------------------
-- Dry-run simulations.
CREATE TABLE `simulations` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `source` text NOT NULL,                    -- fixture|history
  `config` text DEFAULT '{}' NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `result` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `finished_at` text
);

-- ---------------------------------------------------------------------------
-- Model routing telemetry and replayable AI decisions.
CREATE TABLE `model_invocations` (
  `id` text PRIMARY KEY NOT NULL,
  `decision_id` text,
  `task` text NOT NULL,
  `tier` text NOT NULL,                      -- fast|standard|deep
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `status` text NOT NULL,                    -- ok|error|timeout|invalid_output|skipped_budget|fallback
  `latency_ms` integer DEFAULT 0 NOT NULL,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `completion_tokens` integer DEFAULT 0 NOT NULL,
  `cost_usd` real DEFAULT 0 NOT NULL,
  `error` text,
  `useful` real,
  `is_replay` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_model_invocations_provider` ON `model_invocations` (`provider`,`created_at`);
CREATE TABLE `ai_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,                     -- global|campaign|investigation|command
  `subject_id` text,
  `role` text NOT NULL,
  `task` text NOT NULL,
  `visible_state` text NOT NULL,
  `evidence_refs` text DEFAULT '[]' NOT NULL,
  `capability_schema` text NOT NULL,
  `schema_hash` text NOT NULL,
  `provider` text,
  `model` text,
  `proposal` text,
  `policy_decision` text DEFAULT '{}' NOT NULL,
  `accepted` integer DEFAULT 0 NOT NULL,
  `work_item_id` text,
  `job_id` text,
  `result` text DEFAULT '{}' NOT NULL,
  `replay_of` text,
  `is_replay` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_ai_decisions_subject` ON `ai_decisions` (`scope`,`subject_id`,`created_at`);

-- Role invocations of the v5 investigation team (typed artifacts, global scope).
CREATE TABLE `ops_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `tick_id` text,
  `role` text NOT NULL,
  `kind` text NOT NULL,
  `body` text NOT NULL,
  `decision_id` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_ops_artifacts_created` ON `ops_artifacts` (`created_at`);

-- ---------------------------------------------------------------------------
-- Command interface log.
CREATE TABLE `operator_commands` (
  `id` text PRIMARY KEY NOT NULL,
  `text` text NOT NULL,
  `intent` text,
  `compiled` text DEFAULT '{}' NOT NULL,
  `policy` text DEFAULT '{}' NOT NULL,
  `status` text NOT NULL,                    -- answered|queued|refused|failed
  `result` text DEFAULT '{}' NOT NULL,
  `decision_id` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ---------------------------------------------------------------------------
-- Attention management.
CREATE TABLE `ops_notifications` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,                      -- human_action|useful_discovery|campaign_completed|contradiction|budget_warning|report_ready|health
  `severity` text DEFAULT 'info' NOT NULL,   -- info|warning|critical
  `title` text NOT NULL,
  `body` text DEFAULT '' NOT NULL,
  `link` text,
  `dedupe_key` text NOT NULL,
  `count` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,     -- open|read|dismissed
  `first_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `last_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_ops_notifications_open` ON `ops_notifications` (`dedupe_key`) WHERE `status`='open';

-- ---------------------------------------------------------------------------
-- Operational health snapshots.
CREATE TABLE `health_checks` (
  `id` text PRIMARY KEY NOT NULL,
  `component` text NOT NULL,
  `status` text NOT NULL,                    -- ok|degraded|down
  `detail` text DEFAULT '{}' NOT NULL,
  `at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_health_checks_component` ON `health_checks` (`component`,`at`);
