-- Main Platform v4: investigation campaigns, the campaign intelligence graph,
-- the deterministic opportunity queue, hypotheses, role artifacts, experience
-- learning and cost accounting. Additive only: no existing table changes.
-- AI output never writes evidence or graph relationships; see lib/campaign.

CREATE TABLE `campaigns` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `status` text DEFAULT 'RUNNING' NOT NULL,          -- RUNNING|PAUSED|STOPPED|COMPLETE|BUDGET_EXHAUSTED
  `stop_reason` text,
  `headline` text DEFAULT '' NOT NULL,               -- what the system is doing, written by software
  `why` text DEFAULT '' NOT NULL,                    -- why it chose that work (deterministic summary of the winning factors)
  `auto_associate` integer DEFAULT 1 NOT NULL,
  `max_investigations` integer DEFAULT 20 NOT NULL,
  `max_parallel` integer DEFAULT 3 NOT NULL,
  `max_discovery_requests` integer DEFAULT 8 NOT NULL,
  `max_module_jobs` integer DEFAULT 60 NOT NULL,
  `max_model_calls` integer DEFAULT 40 NOT NULL,
  `max_model_tokens` integer DEFAULT 120000 NOT NULL,
  `max_duration_seconds` integer DEFAULT 86400 NOT NULL,
  `used_investigations` integer DEFAULT 0 NOT NULL,
  `used_discovery_requests` integer DEFAULT 0 NOT NULL,
  `used_module_jobs` integer DEFAULT 0 NOT NULL,
  `used_model_calls` integer DEFAULT 0 NOT NULL,
  `used_model_tokens` integer DEFAULT 0 NOT NULL,
  `ticks` integer DEFAULT 0 NOT NULL,
  `deadline_at` text NOT NULL,
  `lease_owner` text,
  `lease_until` text,
  `next_tick_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `finished_at` text
);
CREATE INDEX `idx_campaigns_due` ON `campaigns` (`status`,`next_tick_at`);

-- Investigations (and inbox candidates not yet investigated) in a campaign.
-- `reason` names the observable relationship that associated it.
CREATE TABLE `campaign_members` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `investigation_id` text,
  `candidate_id` text,
  `domain` text NOT NULL,
  `role` text DEFAULT 'member' NOT NULL,             -- seed|member
  `state` text DEFAULT 'pending' NOT NULL,           -- pending|investigating|waiting_human|done|suppressed
  `reason` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`)
);
CREATE UNIQUE INDEX `idx_campaign_members_domain` ON `campaign_members` (`campaign_id`,`domain`);
CREATE INDEX `idx_campaign_members_investigation` ON `campaign_members` (`investigation_id`);

-- The campaign intelligence graph. Every edge has provenance and a basis of
-- observed or deterministic. `kind` names a RELATIONSHIP, never ownership:
-- shared hosting, templates, certificates or wallets are reasons to look.
CREATE TABLE `campaign_edges` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `src_type` text NOT NULL,
  `src_key` text NOT NULL,
  `dst_type` text NOT NULL,
  `dst_key` text NOT NULL,
  `kind` text NOT NULL,                              -- displays_wallet|shares_indicator|same_kit|member_of|observed_relationship|tested_by
  `basis` text NOT NULL,                             -- observed|deterministic
  `source_table` text NOT NULL,                      -- where the fact lives (evidence|relationships|inbox_candidates|investigation_entities|jobs)
  `source_ref` text NOT NULL,                        -- the row(s) that prove it
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_campaign_edges_unique` ON `campaign_edges` (`campaign_id`,`src_type`,`src_key`,`dst_type`,`dst_key`,`kind`);
CREATE INDEX `idx_campaign_edges_campaign` ON `campaign_edges` (`campaign_id`);

-- The opportunity queue: every candidate piece of safe work, scored by the
-- deterministic priority engine. `fingerprint` makes each opportunity unique.
CREATE TABLE `opportunities` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `kind` text NOT NULL,                              -- investigate_candidate|discovery_pivot|test_hypothesis|compare_related
  `target_type` text NOT NULL,
  `target_key` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,             -- open|selected|executing|done|suppressed|rejected|saturated|blocked
  `priority` real DEFAULT 0 NOT NULL,
  `factors` text DEFAULT '{}' NOT NULL,              -- each deterministic factor and its weight
  `cost` real DEFAULT 1 NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `hypothesis_id` text,
  `investigation_id` text,
  `run_id` text,
  `job_id` text,
  `result` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`)
);
CREATE UNIQUE INDEX `idx_opportunities_fingerprint` ON `opportunities` (`campaign_id`,`fingerprint`);
CREATE INDEX `idx_opportunities_queue` ON `opportunities` (`campaign_id`,`status`,`priority`);

-- Hypotheses are AI/deterministic REASONING, not evidence. They never create
-- graph relationships. observation -> hypothesis -> test -> result -> confidence.
CREATE TABLE `hypotheses` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `observation` text NOT NULL,
  `observation_refs` text DEFAULT '[]' NOT NULL,     -- campaign_edges ids the observation rests on
  `statement` text NOT NULL,
  `test_kind` text NOT NULL,                         -- discovery_pivot|compare_related
  `test_target` text NOT NULL,
  `status` text DEFAULT 'proposed' NOT NULL,         -- proposed|testing|supported|disproved|inconclusive
  `confidence` real DEFAULT 0.5 NOT NULL,
  `history` text DEFAULT '[]' NOT NULL,              -- [{at, from, to, reason, basis}]
  `proposed_by` text NOT NULL,                       -- deterministic|model
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_hypotheses_test` ON `hypotheses` (`campaign_id`,`test_kind`,`test_target`);

-- Typed artifacts exchanged between roles (brief, proposal, review, analysis).
CREATE TABLE `campaign_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `tick` integer NOT NULL,
  `role` text NOT NULL,                              -- researcher|strategist|planner|reviewer|analyst
  `kind` text NOT NULL,                              -- brief|pivots|proposal|review|analysis
  `body` text NOT NULL,
  `model` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_campaign_artifacts_campaign` ON `campaign_artifacts` (`campaign_id`,`tick`);

-- Experience: context -> action -> expected -> actual -> cost -> usefulness.
-- `basis` decides the weight; ai_self rows are recorded for audit but carry no weight.
CREATE TABLE `experience` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text,
  `context` text NOT NULL,
  `action` text NOT NULL,
  `expected` real NOT NULL,
  `actual` real NOT NULL,
  `cost` real NOT NULL,
  `useful` real NOT NULL,
  `basis` text NOT NULL,                             -- human|observed|deterministic|ai_self
  `source_ref` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_experience_source` ON `experience` (`source_ref`,`action`);
CREATE INDEX `idx_experience_action` ON `experience` (`action`,`context`);

-- Economics per campaign: every unit of work and what it produced.
CREATE TABLE `campaign_costs` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL,
  `kind` text NOT NULL,                              -- model_call|module_job|discovery_request|investigation
  `units` real DEFAULT 1 NOT NULL,
  `tokens` integer DEFAULT 0 NOT NULL,
  `provider` text,
  `ref` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_campaign_costs_ref` ON `campaign_costs` (`campaign_id`,`kind`,`ref`);
