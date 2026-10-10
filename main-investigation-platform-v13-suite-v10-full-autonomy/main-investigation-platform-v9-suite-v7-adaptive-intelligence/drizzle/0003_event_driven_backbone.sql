ALTER TABLE `jobs` ADD COLUMN `trigger_event_id` text;
ALTER TABLE `jobs` ADD COLUMN `correlation_id` text;
ALTER TABLE `module_registry` ADD COLUMN `supported_event_types` text DEFAULT '[]' NOT NULL;
ALTER TABLE `module_registry` ADD COLUMN `registration_metadata` text DEFAULT '{}' NOT NULL;
ALTER TABLE `module_registry` ADD COLUMN `last_registered_at` text;

CREATE TABLE `event_store` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `event_type` text NOT NULL,
  `schema_version` text DEFAULT '1.0' NOT NULL,
  `correlation_id` text NOT NULL,
  `causation_event_id` text,
  `investigation_id` text,
  `entity_id` text,
  `source_module` text NOT NULL,
  `payload` text DEFAULT '{}' NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL,
  `content_hash` text NOT NULL,
  `hop_count` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 5 NOT NULL,
  `available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `lease_expires_at` text,
  `last_error` text,
  `occurred_at` text NOT NULL,
  `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `processed_at` text,
  `replay_count` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_event_store_event_id` ON `event_store` (`event_id`);
CREATE INDEX `idx_event_store_dispatch` ON `event_store` (`status`,`available_at`,`received_at`);
CREATE INDEX `idx_event_store_correlation` ON `event_store` (`correlation_id`,`received_at`);
CREATE INDEX `idx_event_store_investigation` ON `event_store` (`investigation_id`,`received_at`);

CREATE TABLE `event_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `target_module` text NOT NULL,
  `capability` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 5 NOT NULL,
  `available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `lease_expires_at` text,
  `job_id` text,
  `last_error` text,
  `processed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `event_store`(`id`),
  FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`)
);
CREATE UNIQUE INDEX `idx_event_deliveries_once` ON `event_deliveries` (`event_id`,`target_module`,`capability`);
CREATE INDEX `idx_event_deliveries_dispatch` ON `event_deliveries` (`status`,`available_at`,`target_module`);

CREATE TABLE `event_dead_letters` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `delivery_id` text,
  `source_module` text NOT NULL,
  `event_type` text NOT NULL,
  `payload` text NOT NULL,
  `error_code` text NOT NULL,
  `error_message` text NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `resolved_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `event_store`(`id`),
  FOREIGN KEY (`delivery_id`) REFERENCES `event_deliveries`(`id`)
);
CREATE INDEX `idx_event_dead_letters_open` ON `event_dead_letters` (`resolved_at`,`created_at`);

CREATE TABLE `observation_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `observation_id` text NOT NULL,
  `entity_id` text NOT NULL,
  `source_module` text NOT NULL,
  `record_type` text NOT NULL,
  `source_record_id` text NOT NULL,
  `schema_version` text NOT NULL,
  `confidence` real DEFAULT 0.5 NOT NULL,
  `classification` text,
  `data` text NOT NULL,
  `provenance` text DEFAULT '{}' NOT NULL,
  `content_hash` text NOT NULL,
  `observed_at` text NOT NULL,
  `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`observation_id`) REFERENCES `observations`(`id`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_observation_versions_hash` ON `observation_versions` (`observation_id`,`content_hash`);
CREATE INDEX `idx_observation_versions_entity` ON `observation_versions` (`entity_id`,`received_at`);

CREATE TABLE `relationship_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `relationship_id` text NOT NULL,
  `source_module` text NOT NULL,
  `content_hash` text NOT NULL,
  `data` text NOT NULL,
  `observed_at` text NOT NULL,
  `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`relationship_id`) REFERENCES `relationships`(`id`)
);
CREATE UNIQUE INDEX `idx_relationship_versions_hash` ON `relationship_versions` (`relationship_id`,`content_hash`);

CREATE TABLE `job_event_links` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL,
  `event_id` text NOT NULL,
  `link_type` text DEFAULT 'triggered_by' NOT NULL,
  `explanation` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `event_store`(`id`)
);
CREATE UNIQUE INDEX `idx_job_event_links_once` ON `job_event_links` (`job_id`,`event_id`,`link_type`);
CREATE INDEX `idx_job_event_links_event` ON `job_event_links` (`event_id`,`created_at`);

CREATE INDEX `idx_jobs_trigger_event` ON `jobs` (`trigger_event_id`);
PRAGMA optimize;
