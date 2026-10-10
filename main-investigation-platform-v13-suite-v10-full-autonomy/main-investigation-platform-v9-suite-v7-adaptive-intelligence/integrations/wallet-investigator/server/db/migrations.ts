/**
 * Versioned Schema Migration Runner
 * Guarantees reproducible, audit-compliant database evolution.
 */

import { getDb, runStatement, queryAll, queryFirst, saveDatabaseToDisk } from './database';

export interface Migration {
  version: number;
  name: string;
  up: (db: ReturnType<typeof getDb>) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db) => {
      // Investigations
      db.run(`
        CREATE TABLE investigations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Wallets
      db.run(`
        CREATE TABLE wallets (
          id TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          normalized_address TEXT NOT NULL,
          address_format TEXT NOT NULL,
          reported_network TEXT,
          observed_network TEXT NOT NULL,
          resolved_network TEXT NOT NULL,
          network_ambiguity INTEGER NOT NULL DEFAULT 0,
          network_conflict_notes TEXT,
          validation_status TEXT NOT NULL,
          first_seen_timestamp INTEGER,
          last_seen_timestamp INTEGER,
          first_tx_timestamp INTEGER,
          latest_tx_timestamp INTEGER,
          total_incoming_tx_count INTEGER NOT NULL DEFAULT 0,
          total_outgoing_tx_count INTEGER NOT NULL DEFAULT 0,
          total_tx_count INTEGER NOT NULL DEFAULT 0,
          balance_raw TEXT NOT NULL DEFAULT '0',
          balance_display TEXT NOT NULL DEFAULT '0',
          balance_asset TEXT NOT NULL DEFAULT '',
          total_received_raw TEXT NOT NULL DEFAULT '0',
          total_received_display TEXT NOT NULL DEFAULT '0',
          total_sent_raw TEXT NOT NULL DEFAULT '0',
          total_sent_display TEXT NOT NULL DEFAULT '0',
          completeness TEXT NOT NULL DEFAULT 'UNKNOWN',
          completeness_details_json TEXT,
          unique_counterparty_count INTEGER NOT NULL DEFAULT 0,
          observation_count INTEGER NOT NULL DEFAULT 0,
          investigation_count INTEGER NOT NULL DEFAULT 0,
          is_bookmarked INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Wallet Observations
      db.run(`
        CREATE TABLE wallet_observations (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          address TEXT NOT NULL,
          claimed_network TEXT,
          claimed_asset TEXT,
          source_module TEXT NOT NULL,
          investigation_id TEXT,
          site_entity_id TEXT,
          website_domain TEXT,
          source_url TEXT,
          page_title TEXT,
          deposit_option_context TEXT,
          correlation_id TEXT,
          evidence_id TEXT,
          timestamp INTEGER NOT NULL,
          notes TEXT,
          raw_payload TEXT,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Transactions
      db.run(`
        CREATE TABLE transactions (
          id TEXT PRIMARY KEY,
          tx_hash TEXT NOT NULL,
          network TEXT NOT NULL,
          wallet_id TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          block_number INTEGER,
          timestamp INTEGER NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          counterparty_address TEXT NOT NULL,
          direction TEXT NOT NULL,
          asset TEXT NOT NULL,
          is_token INTEGER NOT NULL DEFAULT 0,
          token_contract TEXT,
          token_decimals INTEGER,
          raw_amount TEXT NOT NULL,
          display_amount TEXT NOT NULL,
          fee_raw TEXT,
          fee_display TEXT,
          status TEXT NOT NULL DEFAULT 'confirmed',
          provider TEXT NOT NULL,
          completeness TEXT NOT NULL DEFAULT 'COMPLETE',
          evidence_id TEXT NOT NULL,
          raw_metadata_json TEXT,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // UTXO Details (inputs and outputs)
      db.run(`
        CREATE TABLE utxo_entries (
          id TEXT PRIMARY KEY,
          tx_id TEXT NOT NULL,
          tx_hash TEXT NOT NULL,
          entry_type TEXT NOT NULL, -- 'input' or 'output'
          entry_index INTEGER NOT NULL,
          address TEXT NOT NULL,
          raw_amount TEXT NOT NULL,
          display_amount TEXT NOT NULL,
          is_change INTEGER NOT NULL DEFAULT 0,
          is_target_wallet INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (tx_id) REFERENCES transactions(id) ON DELETE CASCADE
        );
      `);

      // Counterparties
      db.run(`
        CREATE TABLE counterparties (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          counterparty_address TEXT NOT NULL,
          network TEXT NOT NULL,
          direction TEXT NOT NULL,
          tx_count INTEGER NOT NULL DEFAULT 0,
          first_interaction_timestamp INTEGER NOT NULL,
          last_interaction_timestamp INTEGER NOT NULL,
          assets_json TEXT NOT NULL DEFAULT '[]',
          total_received_from_raw TEXT NOT NULL DEFAULT '0',
          total_received_from_display TEXT NOT NULL DEFAULT '0',
          total_sent_to_raw TEXT NOT NULL DEFAULT '0',
          total_sent_to_display TEXT NOT NULL DEFAULT '0',
          is_known_site_wallet INTEGER NOT NULL DEFAULT 0,
          associated_websites_json TEXT NOT NULL DEFAULT '[]',
          associated_investigations_json TEXT NOT NULL DEFAULT '[]',
          example_tx_hashes_json TEXT NOT NULL DEFAULT '[]',
          evidence_id TEXT NOT NULL,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Connected Wallets Discovery
      db.run(`
        CREATE TABLE connected_wallets (
          id TEXT PRIMARY KEY,
          source_wallet_id TEXT NOT NULL,
          source_wallet_address TEXT NOT NULL,
          connected_wallet_address TEXT NOT NULL,
          network TEXT NOT NULL,
          relevance_score REAL NOT NULL,
          reasons_json TEXT NOT NULL DEFAULT '[]',
          relationship_type TEXT NOT NULL,
          hop_distance INTEGER NOT NULL DEFAULT 1,
          supporting_tx_hashes_json TEXT NOT NULL DEFAULT '[]',
          supporting_investigations_json TEXT NOT NULL DEFAULT '[]',
          supporting_websites_json TEXT NOT NULL DEFAULT '[]',
          is_promoted INTEGER NOT NULL DEFAULT 0,
          promoted_at INTEGER,
          promoted_job_id TEXT,
          evidence_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (source_wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Fund Flow Patterns
      db.run(`
        CREATE TABLE fund_flow_patterns (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          supporting_addresses_json TEXT NOT NULL DEFAULT '[]',
          supporting_tx_hashes_json TEXT NOT NULL DEFAULT '[]',
          metric_summary TEXT,
          detected_at INTEGER NOT NULL,
          evidence_id TEXT NOT NULL,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Provenance
      db.run(`
        CREATE TABLE provenance_records (
          id TEXT PRIMARY KEY,
          source_module TEXT NOT NULL,
          source_record_id TEXT,
          provider TEXT NOT NULL,
          retrieval_timestamp INTEGER NOT NULL,
          investigation_id TEXT,
          correlation_id TEXT,
          analysis_version TEXT NOT NULL,
          method TEXT NOT NULL,
          completeness TEXT NOT NULL,
          confidence REAL NOT NULL
        );
      `);

      // Evidence Records
      db.run(`
        CREATE TABLE evidence_records (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          wallet_id TEXT,
          tx_hash TEXT,
          source_provider TEXT,
          investigation_id TEXT,
          correlation_id TEXT,
          raw_payload TEXT,
          provenance_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (provenance_id) REFERENCES provenance_records(id)
        );
      `);

      // Findings
      db.run(`
        CREATE TABLE findings (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          finding_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          explanation TEXT NOT NULL,
          supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          supporting_tx_hashes_json TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL,
          completeness TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          analysis_version TEXT NOT NULL,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Review Queue
      db.run(`
        CREATE TABLE review_queue (
          id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL,
          title TEXT NOT NULL,
          why_it_needs_review TEXT NOT NULL,
          target_wallet_id TEXT NOT NULL,
          target_address TEXT NOT NULL,
          network TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          supporting_tx_hashes_json TEXT NOT NULL DEFAULT '[]',
          decision_notes TEXT,
          decided_at INTEGER,
          decided_by TEXT,
          created_at INTEGER NOT NULL
        );
      `);

      // Analysis Jobs
      db.run(`
        CREATE TABLE analysis_jobs (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          address TEXT NOT NULL,
          network TEXT NOT NULL,
          profile TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'QUEUED',
          progress_percentage INTEGER NOT NULL DEFAULT 0,
          current_step TEXT NOT NULL DEFAULT 'Initialized',
          investigation_id TEXT,
          correlation_id TEXT,
          retries_attempted INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
        );
      `);

      // Provider Cache
      db.run(`
        CREATE TABLE provider_cache (
          cache_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          completeness TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          fetched_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);

      // Main Platform Integration Queue (durable offline outbox)
      db.run(`
        CREATE TABLE main_platform_queue (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED, DELIVERED, FAILED
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: '002_indexes_and_views',
    up: (db) => {
      db.run(`CREATE INDEX idx_wallets_address ON wallets(normalized_address);`);
      db.run(`CREATE INDEX idx_wallets_network ON wallets(resolved_network);`);
      db.run(`CREATE INDEX idx_observations_wallet ON wallet_observations(wallet_id);`);
      db.run(`CREATE INDEX idx_observations_website ON wallet_observations(website_domain);`);
      db.run(`CREATE INDEX idx_observations_investigation ON wallet_observations(investigation_id);`);
      db.run(`CREATE INDEX idx_transactions_wallet ON transactions(wallet_id);`);
      db.run(`CREATE INDEX idx_transactions_hash ON transactions(tx_hash);`);
      db.run(`CREATE INDEX idx_transactions_counterparty ON transactions(counterparty_address);`);
      db.run(`CREATE INDEX idx_transactions_timestamp ON transactions(timestamp);`);
      db.run(`CREATE INDEX idx_counterparties_wallet ON counterparties(wallet_id);`);
      db.run(`CREATE INDEX idx_counterparties_address ON counterparties(counterparty_address);`);
      db.run(`CREATE INDEX idx_review_queue_status ON review_queue(status);`);
      db.run(`CREATE INDEX idx_jobs_status ON analysis_jobs(status);`);
      db.run(`CREATE INDEX idx_evidence_wallet ON evidence_records(wallet_id);`);
      db.run(`CREATE INDEX idx_findings_wallet ON findings(wallet_id);`);
    },
  },
];

/**
 * Executes all pending database migrations in sequence
 */
export async function runMigrations(): Promise<{ applied: number; currentVersion: number }> {
  const db = getDb();

  // Create schema_migrations tracker if absent
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = queryAll<{ version: number }>(`SELECT version FROM schema_migrations ORDER BY version ASC;`);
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  let appliedCount = 0;
  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      console.log(`[Migrations] Applying migration v${migration.version}: ${migration.name}...`);
      migration.up(db);
      runStatement(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);`,
        [migration.version, migration.name, Date.now()]
      );
      appliedCount++;
    }
  }

  saveDatabaseToDisk();

  const currentVersionRow = queryFirst<{ max_v: number }>(`SELECT MAX(version) as max_v FROM schema_migrations;`);
  const currentVersion = currentVersionRow?.max_v || 0;

  console.log(`[Migrations] Migration status: ${appliedCount} applied. Current schema version: v${currentVersion}`);
  return { applied: appliedCount, currentVersion };
}
