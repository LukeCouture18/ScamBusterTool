-- Main Platform v3: AI-assisted investigation layer, investigation memory and
-- Site Finder outcome feedback. Additive only: no existing table or column is
-- changed. The AI layer never writes to `evidence`; see lib/agent/README.md.

-- One autonomous run per investigation at a time. Every limit is enforced here
-- and in lib/agent, never by the model.
CREATE TABLE `agent_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `status` text DEFAULT 'RUNNING' NOT NULL,          -- RUNNING|WAITING_FOR_MODULE|WAITING_FOR_HUMAN|PAUSED|COMPLETE|INSUFFICIENT_EVIDENCE|BUDGET_EXHAUSTED|STOPPED|FAILED
  `stop_reason` text,
  `headline` text DEFAULT '' NOT NULL,               -- one line for the UI, written by software
  `started_by` text DEFAULT 'platform' NOT NULL,
  `provider` text DEFAULT 'rules' NOT NULL,
  `max_actions` integer DEFAULT 12 NOT NULL,
  `max_duration_seconds` integer DEFAULT 21600 NOT NULL,
  `max_discovery_expansions` integer DEFAULT 1 NOT NULL,
  `max_module_calls` integer DEFAULT 8 NOT NULL,
  `max_model_calls` integer DEFAULT 24 NOT NULL,
  `max_model_tokens` integer DEFAULT 80000 NOT NULL,
  `max_retries` integer DEFAULT 3 NOT NULL,
  `max_low_value_steps` integer DEFAULT 3 NOT NULL,
  `used_actions` integer DEFAULT 0 NOT NULL,
  `used_discovery_expansions` integer DEFAULT 0 NOT NULL,
  `used_module_calls` integer DEFAULT 0 NOT NULL,
  `used_model_calls` integer DEFAULT 0 NOT NULL,
  `used_model_tokens` integer DEFAULT 0 NOT NULL,
  `used_retries` integer DEFAULT 0 NOT NULL,
  `consecutive_low_value` integer DEFAULT 0 NOT NULL,
  `consecutive_rejections` integer DEFAULT 0 NOT NULL,
  `last_step_no` integer DEFAULT 0 NOT NULL,
  `evidence_seen` integer DEFAULT 0 NOT NULL,        -- evidence rows already reflected in a plan
  `new_evidence` integer DEFAULT 0 NOT NULL,         -- evidence arrived since the last plan (UI: "New evidence found")
  `deadline_at` text NOT NULL,
  `next_run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `lease_owner` text,
  `lease_until` text,
  `started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `finished_at` text,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`)
);
CREATE UNIQUE INDEX `idx_agent_runs_active` ON `agent_runs` (`investigation_id`) WHERE `status` IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED');
CREATE INDEX `idx_agent_runs_due` ON `agent_runs` (`status`,`next_run_at`);

-- Every plan, validation, action and evaluation. `rationale` and `raw_output`
-- are model output: untrusted, stored for audit, never treated as evidence.
CREATE TABLE `agent_steps` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `investigation_id` text NOT NULL,
  `step_no` integer NOT NULL,
  `kind` text NOT NULL,                              -- plan|system|evaluation
  `state` text DEFAULT 'planning' NOT NULL,          -- planning|executing|done
  `provider` text,
  `model` text,
  `model_class` text,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `completion_tokens` integer DEFAULT 0 NOT NULL,
  `raw_output` text,
  `validation` text,                                 -- accepted|rejected|model_error|system
  `rejection_reasons` text DEFAULT '[]' NOT NULL,
  `capability` text,
  `arguments` text DEFAULT '{}' NOT NULL,
  `fingerprint` text,
  `triggering_evidence` text DEFAULT '[]' NOT NULL,
  `expected_value` real,
  `rationale` text DEFAULT '' NOT NULL,
  `outcome` text,                                    -- queued|duplicate|completed|no_change|waiting|concluded|blocked|rejected|error
  `job_id` text,
  `checkpoint_id` text,
  `result` text DEFAULT '{}' NOT NULL,
  `evidence_before` integer,
  `evidence_after` integer,
  `realized_value` real,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`)
);
CREATE UNIQUE INDEX `idx_agent_steps_no` ON `agent_steps` (`run_id`,`step_no`);
-- The same accepted action cannot be executed twice in a run.
CREATE UNIQUE INDEX `idx_agent_steps_fingerprint` ON `agent_steps` (`run_id`,`fingerprint`) WHERE `validation`='accepted' AND `fingerprint` IS NOT NULL;
CREATE INDEX `idx_agent_steps_investigation` ON `agent_steps` (`investigation_id`,`created_at`);
CREATE INDEX `idx_agent_steps_job` ON `agent_steps` (`job_id`);

-- Model calls, for cost and failure auditing.
CREATE TABLE `agent_model_calls` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `step_id` text,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `model_class` text NOT NULL,
  `status` text NOT NULL,                            -- ok|error|timeout|invalid_output
  `latency_ms` integer DEFAULT 0 NOT NULL,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `completion_tokens` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_agent_model_calls_run` ON `agent_model_calls` (`run_id`);

-- Human-only steps: login, CAPTCHA, MFA, email verification, analyst review.
CREATE TABLE `human_checkpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `run_id` text,
  `kind` text NOT NULL,                              -- login|captcha|mfa|email_verification|analyst_review
  `status` text DEFAULT 'open' NOT NULL,             -- open|resolved|cancelled
  `title` text NOT NULL,
  `instructions` text NOT NULL,
  `url` text,
  `detected_by` text NOT NULL,                       -- deterministic|model_proposal
  `trigger_evidence` text DEFAULT '[]' NOT NULL,
  `resolution` text,                                 -- new_evidence|analyst_confirmed|cancelled
  `resolution_evidence` text DEFAULT '[]' NOT NULL,
  `evidence_watermark` integer DEFAULT 0 NOT NULL,       -- max evidence rowid when opened: only later evidence can resolve it
  `observation_watermark` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `resolved_at` text,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`)
);
CREATE UNIQUE INDEX `idx_human_checkpoints_open` ON `human_checkpoints` (`investigation_id`,`kind`) WHERE `status`='open';

-- AI inference: kept apart from evidence. Every citation is validated against
-- this investigation's evidence before the row is written.
CREATE TABLE `agent_inferences` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `run_id` text NOT NULL,
  `step_id` text NOT NULL,
  `claim` text NOT NULL,
  `entity_id` text,
  `cited_evidence` text DEFAULT '[]' NOT NULL,
  `status` text DEFAULT 'unverified' NOT NULL,       -- always unverified: an inference never becomes evidence
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_agent_inferences_investigation` ON `agent_inferences` (`investigation_id`);

-- Human analyst conclusions, stated by a person.
CREATE TABLE `analyst_conclusions` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `conclusion` text NOT NULL,
  `cited_evidence` text DEFAULT '[]' NOT NULL,
  `author` text DEFAULT 'analyst' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Cross-investigation operational memory. Written only by deterministic code
-- from observed outcomes, module results and your decisions (basis column).
CREATE TABLE `memory_facts` (
  `id` text PRIMARY KEY NOT NULL,
  `subject_type` text NOT NULL,                      -- site|wallet|cluster|template|infrastructure|strategy
  `subject_key` text NOT NULL,
  `fact_type` text NOT NULL,                         -- investigated|wallet_observed|barrier|dead|decision|evidence_yield|strategy_outcome|module_result
  `value` text DEFAULT '{}' NOT NULL,
  `basis` text NOT NULL,                             -- observed|deterministic|human|external_metadata
  `investigation_id` text,
  `source_ref` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_memory_facts_unique` ON `memory_facts` (`subject_type`,`subject_key`,`fact_type`,`source_ref`);
CREATE INDEX `idx_memory_facts_subject` ON `memory_facts` (`subject_type`,`subject_key`);

-- Downstream outcomes for Site Finder's discovery learning. Observed or human
-- basis only: AI inference never becomes a training label.
CREATE TABLE `finder_outcomes` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `id` text NOT NULL,
  `canonical_domain` text NOT NULL,
  `finder_candidate_id` text,
  `investigation_id` text,
  `outcome` text NOT NULL,                           -- useful|skip|meaningful_evidence|wallet_evidence|investigation_completed|dead_site|auth_barrier|duplicate|low_evidence
  `basis` text NOT NULL,                             -- observed|human|deterministic
  `detail` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_finder_outcomes_id` ON `finder_outcomes` (`id`);
CREATE INDEX `idx_finder_outcomes_domain` ON `finder_outcomes` (`canonical_domain`);

CREATE TABLE `agent_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO `agent_settings` (`key`,`value`) VALUES
  ('enabled','true'),
  ('auto_start_on_useful','true'),
  ('max_actions','12'),
  ('max_duration_seconds','21600'),
  ('max_discovery_expansions','1'),
  ('max_module_calls','8'),
  ('max_model_calls','24'),
  ('max_model_tokens','80000'),
  ('max_retries','3'),
  ('max_low_value_steps','3');
