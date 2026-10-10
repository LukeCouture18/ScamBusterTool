-- Main Platform v2: the investigation inbox.
-- Additive only: no existing table or column is changed.
CREATE TABLE `inbox_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `canonical_domain` text NOT NULL,
  `url` text NOT NULL,
  `status` text DEFAULT 'ready' NOT NULL,
  `score` real DEFAULT 0 NOT NULL,
  `headline` text DEFAULT '' NOT NULL,
  `category` text DEFAULT '' NOT NULL,
  `cluster_key` text,
  `related_domains` text DEFAULT '[]' NOT NULL,
  `wallets` text DEFAULT '[]' NOT NULL,
  `source_module` text DEFAULT 'site_finder' NOT NULL,
  `source_record_id` text,
  `finder_candidate_id` text,
  `investigation_id` text,
  `entity_id` text,
  `evidence_id` text,
  `details` text DEFAULT '{}' NOT NULL,
  `suppressed_reason` text,
  `presented_at` text,
  `lease_until` text,
  `opened_at` text,
  `decision` text,
  `decision_reason` text,
  `decided_at` text,
  `progress_state` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`),
  FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
CREATE UNIQUE INDEX `idx_inbox_candidates_domain` ON `inbox_candidates` (`canonical_domain`);
CREATE INDEX `idx_inbox_candidates_queue` ON `inbox_candidates` (`status`,`score`,`created_at`);
CREATE INDEX `idx_inbox_candidates_cluster` ON `inbox_candidates` (`cluster_key`);
CREATE INDEX `idx_inbox_candidates_decided` ON `inbox_candidates` (`decision`,`decided_at`);
CREATE TABLE `inbox_decisions` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `id` text NOT NULL,
  `candidate_id` text NOT NULL,
  `canonical_domain` text NOT NULL,
  `finder_candidate_id` text,
  `decision` text NOT NULL,
  `reason` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`candidate_id`) REFERENCES `inbox_candidates`(`id`)
);
CREATE UNIQUE INDEX `idx_inbox_decisions_id` ON `inbox_decisions` (`id`);
CREATE TABLE `inbox_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO `inbox_settings` (`key`,`value`) VALUES
  ('target_depth','10'),
  ('min_score','0.6'),
  ('investigate_on_useful','true'),
  ('find_related_on_useful','true'),
  ('discovery_http_budget','200'),
  ('max_discovery_jobs_per_day','48'),
  ('lease_minutes','15');
