ALTER TABLE `observations` ADD COLUMN `record_type` text DEFAULT 'legacy' NOT NULL;
DROP INDEX `idx_observations_source_record`;
CREATE UNIQUE INDEX `idx_observations_source_type_record` ON `observations` (`source_module`,`record_type`,`source_record_id`);

ALTER TABLE `evidence` ADD COLUMN `evidence_class` text DEFAULT 'observed_website' NOT NULL;
ALTER TABLE `evidence` ADD COLUMN `observation_scope` text DEFAULT 'public' NOT NULL;
ALTER TABLE `evidence` ADD COLUMN `context_text` text DEFAULT '' NOT NULL;
ALTER TABLE `relationships` ADD COLUMN `assertion_kind` text DEFAULT 'observed' NOT NULL;
ALTER TABLE `ingestion_batches` ADD COLUMN `request_id` text;
ALTER TABLE `ingestion_batches` ADD COLUMN `origin_job_id` text;

CREATE TABLE `investigation_entities` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `entity_id` text NOT NULL,
  `role` text DEFAULT 'subject' NOT NULL,
  `source_module` text NOT NULL,
  `source_record_id` text NOT NULL,
  `confidence` real DEFAULT 0.5 NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL,
  `schema_version` text DEFAULT '1.0' NOT NULL,
  `first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_investigation_entities_link` ON `investigation_entities` (`investigation_id`,`entity_id`,`source_module`);
CREATE INDEX `idx_investigation_entities_entity` ON `investigation_entities` (`entity_id`);

CREATE TABLE `investigation_observations` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text NOT NULL,
  `source_module` text NOT NULL,
  `source_record_id` text NOT NULL,
  `confidence` real DEFAULT 0.5 NOT NULL,
  `classification` text,
  `data` text NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL,
  `schema_version` text DEFAULT '1.0' NOT NULL,
  `observed_at` text NOT NULL,
  `first_received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `last_received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`)
);
CREATE UNIQUE INDEX `idx_investigation_observations_source` ON `investigation_observations` (`source_module`,`source_record_id`);

CREATE TABLE `evidence_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `evidence_id` text NOT NULL,
  `source_module` text NOT NULL,
  `content_hash` text NOT NULL,
  `data` text NOT NULL,
  `captured_at` text NOT NULL,
  `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`)
);
CREATE UNIQUE INDEX `idx_evidence_versions_hash` ON `evidence_versions` (`evidence_id`,`content_hash`);

CREATE TABLE `relationship_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `relationship_id` text NOT NULL,
  `evidence_id` text NOT NULL,
  `source_module` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`relationship_id`) REFERENCES `relationships`(`id`),
  FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`)
);
CREATE UNIQUE INDEX `idx_relationship_evidence_link` ON `relationship_evidence` (`relationship_id`,`evidence_id`);

CREATE TABLE `notes` (
  `id` text PRIMARY KEY NOT NULL,
  `investigation_id` text,
  `entity_id` text,
  `source_module` text NOT NULL,
  `source_record_id` text NOT NULL,
  `title` text NOT NULL,
  `body` text NOT NULL,
  `note_kind` text DEFAULT 'analyst_note' NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL,
  `schema_version` text DEFAULT '1.0' NOT NULL,
  `observed_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_notes_source_record` ON `notes` (`source_module`,`source_record_id`);

CREATE TABLE `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `job_type` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `priority` integer DEFAULT 50 NOT NULL,
  `investigation_id` text,
  `target_entity_id` text,
  `target_module` text NOT NULL,
  `created_by_module` text NOT NULL,
  `dedupe_key` text NOT NULL,
  `payload` text DEFAULT '{}' NOT NULL,
  `result` text,
  `current_progress` real DEFAULT 0 NOT NULL,
  `progress_message` text DEFAULT '' NOT NULL,
  `claimed_by_module` text,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 3 NOT NULL,
  `available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `lease_expires_at` text,
  `last_error` text,
  `parent_job_id` text,
  `schema_version` text DEFAULT '1.0' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`target_entity_id`) REFERENCES `entities`(`id`),
  FOREIGN KEY (`parent_job_id`) REFERENCES `jobs`(`id`)
);
CREATE UNIQUE INDEX `idx_jobs_dedupe_key` ON `jobs` (`dedupe_key`);
CREATE INDEX `idx_jobs_claim` ON `jobs` (`target_module`,`status`,`available_at`,`priority`);
CREATE INDEX `idx_jobs_investigation` ON `jobs` (`investigation_id`,`created_at`);

CREATE TABLE `job_events` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL,
  `source_module` text NOT NULL,
  `event_type` text NOT NULL,
  `message` text DEFAULT '' NOT NULL,
  `data` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`)
);
CREATE INDEX `idx_job_events_job` ON `job_events` (`job_id`,`created_at`);

CREATE TABLE `module_registry` (
  `module_name` text PRIMARY KEY NOT NULL,
  `connection_status` text DEFAULT 'disconnected' NOT NULL,
  `runtime_status` text DEFAULT 'idle' NOT NULL,
  `module_version` text,
  `schema_version` text,
  `capabilities` text DEFAULT '[]' NOT NULL,
  `last_heartbeat_at` text,
  `last_successful_sync_at` text,
  `records_received` integer DEFAULT 0 NOT NULL,
  `records_sent` integer DEFAULT 0 NOT NULL,
  `jobs_completed` integer DEFAULT 0 NOT NULL,
  `current_job_id` text,
  `last_error` text,
  `recent_errors` text DEFAULT '[]' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `dead_letters` (
  `id` text PRIMARY KEY NOT NULL,
  `source_module` text NOT NULL,
  `batch_id` text NOT NULL,
  `record_type` text NOT NULL,
  `source_record_id` text,
  `payload` text NOT NULL,
  `error_code` text NOT NULL,
  `error_message` text NOT NULL,
  `retry_count` integer DEFAULT 0 NOT NULL,
  `next_retry_at` text,
  `resolved_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_dead_letters_module_unresolved` ON `dead_letters` (`source_module`,`resolved_at`,`created_at`);

CREATE TABLE `audit_log` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL,
  `actor_module` text,
  `action` text NOT NULL,
  `resource_type` text NOT NULL,
  `resource_id` text,
  `status` text NOT NULL,
  `details` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX `idx_audit_log_actor_time` ON `audit_log` (`actor_module`,`created_at`);
CREATE INDEX `idx_audit_log_resource` ON `audit_log` (`resource_type`,`resource_id`);

CREATE TABLE `rate_limit_windows` (
  `module_name` text NOT NULL,
  `window_start` text NOT NULL,
  `request_count` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (`module_name`,`window_start`)
);

PRAGMA optimize;
