ALTER TABLE `investigations` ADD COLUMN `automation_profile_id` text DEFAULT 'standard-investigation' NOT NULL;
ALTER TABLE `jobs` ADD COLUMN `pipeline_id` text;
ALTER TABLE `jobs` ADD COLUMN `stage_key` text;
ALTER TABLE `jobs` ADD COLUMN `trigger_reason` text DEFAULT '' NOT NULL;
ALTER TABLE `jobs` ADD COLUMN `trigger_rule_id` text;
ALTER TABLE `jobs` ADD COLUMN `requires_approval` integer DEFAULT 0 NOT NULL;
ALTER TABLE `jobs` ADD COLUMN `approval_status` text DEFAULT 'not_required' NOT NULL;
ALTER TABLE `jobs` ADD COLUMN `freshness_key` text;
ALTER TABLE `jobs` ADD COLUMN `last_worker_heartbeat_at` text;

CREATE TABLE `automation_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `is_system` integer DEFAULT 0 NOT NULL,
  `is_enabled` integer DEFAULT 1 NOT NULL,
  `config` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `automation_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `is_enabled` integer DEFAULT 1 NOT NULL,
  `trigger_type` text NOT NULL,
  `source_module` text,
  `target_module` text NOT NULL,
  `job_type` text NOT NULL,
  `min_confidence` real DEFAULT 0 NOT NULL,
  `priority` integer DEFAULT 50 NOT NULL,
  `requires_approval` integer DEFAULT 0 NOT NULL,
  `freshness_hours` integer DEFAULT 24 NOT NULL,
  `profile_scope` text DEFAULT '[]' NOT NULL,
  `conditions` text DEFAULT '{}' NOT NULL,
  `explanation_template` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_automation_rules_trigger` ON `automation_rules` (`trigger_type`,`is_enabled`,`source_module`);

CREATE TABLE `investigation_pipelines` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `current_stage` text DEFAULT 'discovery' NOT NULL,
  `progress` real DEFAULT 0 NOT NULL,
  `pause_reason` text,
  `paused_at` text,
  `canceled_at` text,
  `completed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`profile_id`) REFERENCES `automation_profiles`(`id`)
);
CREATE INDEX `idx_pipelines_investigation_status` ON `investigation_pipelines` (`investigation_id`,`status`,`updated_at`);

CREATE TABLE `pipeline_stages` (
  `id` text PRIMARY KEY NOT NULL,
  `pipeline_id` text NOT NULL,
  `stage_key` text NOT NULL,
  `stage_order` integer NOT NULL,
  `module_name` text NOT NULL,
  `status` text DEFAULT 'waiting' NOT NULL,
  `progress` real DEFAULT 0 NOT NULL,
  `started_at` text,
  `completed_at` text,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`pipeline_id`) REFERENCES `investigation_pipelines`(`id`)
);
CREATE UNIQUE INDEX `idx_pipeline_stages_key` ON `pipeline_stages` (`pipeline_id`,`stage_key`);

CREATE TABLE `job_dependencies` (
  `job_id` text NOT NULL,
  `depends_on_job_id` text NOT NULL,
  `dependency_type` text DEFAULT 'completion' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`job_id`,`depends_on_job_id`),
  FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`),
  FOREIGN KEY (`depends_on_job_id`) REFERENCES `jobs`(`id`)
);
CREATE INDEX `idx_job_dependencies_parent` ON `job_dependencies` (`depends_on_job_id`);

CREATE TABLE `entity_analysis_state` (
  `entity_id` text NOT NULL,
  `module_name` text NOT NULL,
  `analysis_type` text NOT NULL,
  `last_analyzed_at` text,
  `fresh_until` text,
  `last_job_id` text,
  `result_summary` text DEFAULT '{}' NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`entity_id`,`module_name`,`analysis_type`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`),
  FOREIGN KEY (`last_job_id`) REFERENCES `jobs`(`id`)
);

CREATE TABLE `investigation_timeline` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text,
  `pipeline_id` text,
  `job_id` text,
  `entity_id` text,
  `source_module` text,
  `event_type` text NOT NULL,
  `title` text NOT NULL,
  `detail` text DEFAULT '' NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `severity` text DEFAULT 'info' NOT NULL,
  `data` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_timeline_investigation_time` ON `investigation_timeline` (`investigation_id`,`created_at`);
CREATE INDEX `idx_timeline_pipeline_time` ON `investigation_timeline` (`pipeline_id`,`created_at`);

CREATE TABLE `notifications` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text,
  `pipeline_id` text,
  `notification_type` text NOT NULL,
  `severity` text DEFAULT 'info' NOT NULL,
  `title` text NOT NULL,
  `message` text NOT NULL,
  `resource_type` text,
  `resource_id` text,
  `is_read` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `read_at` text
);
CREATE INDEX `idx_notifications_unread` ON `notifications` (`is_read`,`severity`,`created_at`);

CREATE TABLE `review_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text,
  `pipeline_id` text,
  `job_id` text,
  `entity_id` text,
  `review_type` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `priority` integer DEFAULT 50 NOT NULL,
  `title` text NOT NULL,
  `reason` text NOT NULL,
  `details` text DEFAULT '{}' NOT NULL,
  `resolution` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `resolved_at` text
);
CREATE INDEX `idx_review_queue_status_priority` ON `review_queue` (`status`,`priority`,`created_at`);

CREATE TABLE `entity_aliases` (
  `id` text PRIMARY KEY NOT NULL,
  `entity_id` text NOT NULL,
  `alias_type` text NOT NULL,
  `alias_value` text NOT NULL,
  `source_module` text NOT NULL,
  `confidence` real DEFAULT 0.5 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_entity_aliases_identity` ON `entity_aliases` (`alias_type`,`alias_value`,`source_module`);
CREATE INDEX `idx_entity_aliases_entity` ON `entity_aliases` (`entity_id`);

CREATE INDEX `idx_jobs_pipeline_stage` ON `jobs` (`pipeline_id`,`stage_key`,`status`);
CREATE INDEX `idx_jobs_approval_claim` ON `jobs` (`target_module`,`status`,`approval_status`,`available_at`,`priority`);
CREATE INDEX `idx_jobs_freshness_key` ON `jobs` (`freshness_key`,`created_at`);

PRAGMA optimize;
