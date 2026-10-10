CREATE TABLE `investigations` (
  `id` text PRIMARY KEY NOT NULL, `external_id` text NOT NULL, `title` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL, `priority` text DEFAULT 'normal' NOT NULL,
  `description` text DEFAULT '' NOT NULL, `schema_version` text DEFAULT '1.0' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_investigations_external_id` ON `investigations` (`external_id`);

CREATE TABLE `entities` (
  `id` text PRIMARY KEY NOT NULL, `investigation_id` text, `entity_type` text NOT NULL,
  `canonical_key` text NOT NULL, `display_name` text NOT NULL, `canonical_data` text DEFAULT '{}' NOT NULL,
  `max_confidence` real DEFAULT 0 NOT NULL, `classification` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`)
);
CREATE UNIQUE INDEX `idx_entities_type_key` ON `entities` (`entity_type`,`canonical_key`);
CREATE INDEX `idx_entities_investigation_type` ON `entities` (`investigation_id`,`entity_type`);

CREATE TABLE `observations` (
  `id` text PRIMARY KEY NOT NULL, `entity_id` text NOT NULL, `source_module` text NOT NULL, `source_record_id` text NOT NULL,
  `schema_version` text NOT NULL, `confidence` real DEFAULT 0.5 NOT NULL, `classification` text,
  `data` text NOT NULL, `provenance` text DEFAULT '{}' NOT NULL, `content_hash` text NOT NULL, `observed_at` text NOT NULL,
  `first_received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `last_received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_observations_source_record` ON `observations` (`source_module`,`source_record_id`);
CREATE INDEX `idx_observations_entity` ON `observations` (`entity_id`);

CREATE TABLE `relationships` (
  `id` text PRIMARY KEY NOT NULL, `investigation_id` text, `source_entity_id` text NOT NULL, `target_entity_id` text NOT NULL,
  `relationship_type` text NOT NULL, `source_module` text NOT NULL, `source_record_id` text NOT NULL,
  `confidence` real DEFAULT 0.5 NOT NULL, `provenance` text DEFAULT '{}' NOT NULL, `schema_version` text NOT NULL, `observed_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`), FOREIGN KEY (`source_entity_id`) REFERENCES `entities`(`id`), FOREIGN KEY (`target_entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_relationships_source_record` ON `relationships` (`source_module`,`source_record_id`);
CREATE INDEX `idx_relationships_endpoints` ON `relationships` (`source_entity_id`,`target_entity_id`);

CREATE TABLE `evidence` (
  `id` text PRIMARY KEY NOT NULL, `investigation_id` text, `entity_id` text, `source_module` text NOT NULL, `source_record_id` text NOT NULL,
  `evidence_type` text NOT NULL, `title` text NOT NULL, `uri` text, `object_key` text, `media_type` text, `sha256` text,
  `metadata` text DEFAULT '{}' NOT NULL, `provenance` text DEFAULT '{}' NOT NULL, `schema_version` text NOT NULL, `captured_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`), FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_evidence_source_record` ON `evidence` (`source_module`,`source_record_id`);
CREATE INDEX `idx_evidence_entity` ON `evidence` (`entity_id`);
CREATE INDEX `idx_evidence_sha256` ON `evidence` (`sha256`);

CREATE TABLE `discovery_paths` (
  `id` text PRIMARY KEY NOT NULL, `investigation_id` text, `source_module` text NOT NULL, `source_record_id` text NOT NULL,
  `steps` text NOT NULL, `provenance` text DEFAULT '{}' NOT NULL, `confidence` real DEFAULT 0.5 NOT NULL, `schema_version` text NOT NULL, `observed_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`)
);
CREATE UNIQUE INDEX `idx_discovery_paths_source_record` ON `discovery_paths` (`source_module`,`source_record_id`);

CREATE TABLE `findings` (
  `id` text PRIMARY KEY NOT NULL, `investigation_id` text, `entity_id` text, `source_module` text NOT NULL, `source_record_id` text NOT NULL,
  `finding_type` text DEFAULT 'note' NOT NULL, `title` text NOT NULL, `body` text NOT NULL, `confidence` real, `classification` text,
  `provenance` text DEFAULT '{}' NOT NULL, `schema_version` text NOT NULL, `observed_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`), FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_findings_source_record` ON `findings` (`source_module`,`source_record_id`);

CREATE TABLE `module_activity` (
  `id` text PRIMARY KEY NOT NULL, `source_module` text NOT NULL, `source_record_id` text NOT NULL, `status` text NOT NULL,
  `message` text DEFAULT '' NOT NULL, `metrics` text DEFAULT '{}' NOT NULL, `schema_version` text NOT NULL,
  `occurred_at` text NOT NULL, `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `idx_module_activity_source_record` ON `module_activity` (`source_module`,`source_record_id`);
CREATE INDEX `idx_module_activity_source_time` ON `module_activity` (`source_module`,`occurred_at`);

CREATE TABLE `ingestion_batches` (
  `id` text PRIMARY KEY NOT NULL, `source_module` text NOT NULL, `batch_id` text NOT NULL, `schema_version` text NOT NULL, `status` text NOT NULL,
  `received_count` integer DEFAULT 0 NOT NULL, `inserted_count` integer DEFAULT 0 NOT NULL, `updated_count` integer DEFAULT 0 NOT NULL,
  `duplicate_count` integer DEFAULT 0 NOT NULL, `error_count` integer DEFAULT 0 NOT NULL, `errors` text DEFAULT '[]' NOT NULL,
  `received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `completed_at` text
);
CREATE UNIQUE INDEX `idx_ingestion_batches_source_batch` ON `ingestion_batches` (`source_module`,`batch_id`);

PRAGMA optimize;
