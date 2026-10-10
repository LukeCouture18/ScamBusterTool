-- Platform v5 · Operations + Operation Hunter v2.0
--
-- Operation Hunter becomes a registered module (`operation_hunter`): the platform's
-- specialised engine for reconstructing and pursuing the operation behind a site,
-- wallet or campaign. Main stays the coordinator: it asks Hunter to reconstruct
-- (work kind `reconstruct_operation` -> HUNT_OPERATION job) and receives Hunter's
-- living operation model, member lists, observed changes, contradictions and
-- proposals, which it turns into its own typed work through the normal scheduler.
--
-- Additive only: no existing table or row is modified.

CREATE TABLE `hunter_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `external_id` text NOT NULL,               -- Hunter's operation id
  `code` text DEFAULT '' NOT NULL,
  `name` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'ACTIVE' NOT NULL,   -- Hunter operation status
  `model_status` text DEFAULT 'unknown' NOT NULL, -- active|rotating|dormant|dark|unknown (living model)
  `status_reason` text DEFAULT '' NOT NULL,
  `headline` text DEFAULT '' NOT NULL,
  `narrative` text DEFAULT '' NOT NULL,
  `confidence` real DEFAULT 0 NOT NULL,
  `depth_score` integer DEFAULT 0 NOT NULL,
  `counts` text DEFAULT '{}' NOT NULL,
  `forecast` text DEFAULT '{}' NOT NULL,
  `explanations` text DEFAULT '[]' NOT NULL,  -- competing explanations (leading, runner-up, discriminating test)
  `discoveries` text DEFAULT '[]' NOT NULL,   -- the 3-5 strongest findings, with why / uncertainty / does-not-prove / next
  `leads` text DEFAULT '[]' NOT NULL,
  `unknowns` text DEFAULT '[]' NOT NULL,
  `contradictions` text DEFAULT '[]' NOT NULL,
  `pursuit` text DEFAULT '{}' NOT NULL,
  `model_version` integer,
  `last_change` text DEFAULT '' NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  `is_demo` integer DEFAULT 0 NOT NULL,
  `seed` text DEFAULT '' NOT NULL,
  `investigation_id` text,                   -- Main investigation holding Hunter's evidence (id or external id)
  `campaign_id` text,                        -- Main campaign this operation reconstructs, when known
  `ui_url` text,
  `hunter_version` text DEFAULT '' NOT NULL,
  `synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_hunter_operations_external` ON `hunter_operations` (`external_id`);
CREATE INDEX `idx_hunter_operations_campaign` ON `hunter_operations` (`campaign_id`);

CREATE TABLE `hunter_operation_members` (
  `operation_id` text NOT NULL,
  `entity_type` text NOT NULL,               -- site|wallet
  `canonical_key` text NOT NULL,
  `role` text DEFAULT '' NOT NULL,           -- seed|member|probable|collection|treasury|...
  `probability` real DEFAULT 0 NOT NULL,
  `state` text DEFAULT 'unknown' NOT NULL,   -- live|dark|suspended|pending|resurfaced|unknown (sites)
  `why` text DEFAULT '' NOT NULL,            -- strongest membership factor (explanation, not proof)
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`operation_id`,`entity_type`,`canonical_key`),
  FOREIGN KEY (`operation_id`) REFERENCES `hunter_operations`(`id`)
);
CREATE INDEX `idx_hunter_members_key` ON `hunter_operation_members` (`entity_type`,`canonical_key`);

CREATE TABLE `hunter_proposals` (
  `id` text PRIMARY KEY NOT NULL,
  `operation_id` text NOT NULL,
  `proposal_key` text NOT NULL,
  `kind` text NOT NULL,                      -- investigate_site|analyze_wallet|review_contradiction
  `target_type` text NOT NULL,
  `target_key` text NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `value` real DEFAULT 0 NOT NULL,
  `outcome` text DEFAULT 'received' NOT NULL, -- work_proposed|candidate_created|not_actionable|...
  `work_item_id` text,
  `detail` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_hunter_proposals_key` ON `hunter_proposals` (`operation_id`,`proposal_key`);

CREATE TABLE `hunter_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `operation_id` text,
  `external_operation_id` text NOT NULL,
  `kind` text NOT NULL,                      -- inbox_candidate|site_check
  `canonical_key` text NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `outcome` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_hunter_requests_key` ON `hunter_requests` (`external_operation_id`,`kind`,`canonical_key`);

INSERT OR IGNORE INTO `ops_state` (`key`,`value`) VALUES
  ('module_limit:operation_hunter','1'),
  ('auto_reconstruct','true'),
  ('reconstruct_min_sites','2');
