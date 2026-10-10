/**
 * Wallet Investigator v1.0 - Core Types
 * Complete Canonical Data Models for Blockchain Investigation & Fund-Flow Analysis
 */

export type BlockchainNetwork =
  | 'bitcoin'
  | 'ethereum'
  | 'evm_uncertain'
  | 'bsc'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'tron'
  | 'solana'
  | 'xrpl'
  | 'litecoin'
  | 'dogecoin'
  | 'avalanche';

export type AddressFormat =
  | 'btc_p2pkh'
  | 'btc_p2sh'
  | 'btc_bech32'
  | 'btc_taproot'
  | 'evm_hex'
  | 'tron_base58'
  | 'solana_base58'
  | 'xrpl_base58'
  | 'ltc_base58'
  | 'ltc_bech32'
  | 'doge_base58'
  | 'invalid'
  | 'unknown';

export type ValidationStatus =
  | 'valid'
  | 'valid_checksum'
  | 'valid_no_checksum'
  | 'ambiguous'
  | 'invalid_format'
  | 'invalid_checksum'
  | 'network_conflict';

export type DataCompleteness =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'LIMITED'
  | 'UNKNOWN'
  | 'FAILED';

export type TransactionDirection = 'incoming' | 'outgoing' | 'self' | 'internal';

export type EvidenceCategory =
  | 'OBSERVED_WEBSITE_EVIDENCE'
  | 'OBSERVED_BLOCKCHAIN_EVIDENCE'
  | 'DERIVED_SOFTWARE_ANALYSIS'
  | 'EXTERNAL_PROVIDER_METADATA'
  | 'ANALYST_NOTES_CONCLUSIONS';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED';

export type AnalysisProfileType = 'QUICK' | 'STANDARD' | 'DEEP';

export type ReviewStatus = 'PENDING' | 'REVIEWED' | 'PROMOTED' | 'DISMISSED' | 'DEFERRED';

export interface WalletEntity {
  id: string;
  address: string;
  normalized_address: string;
  address_format: AddressFormat;
  reported_network?: string;
  observed_network: BlockchainNetwork;
  resolved_network: BlockchainNetwork;
  network_ambiguity: boolean;
  network_conflict_notes?: string;
  validation_status: ValidationStatus;
  first_seen_timestamp?: number;
  last_seen_timestamp?: number;
  first_tx_timestamp?: number;
  latest_tx_timestamp?: number;
  total_incoming_tx_count: number;
  total_outgoing_tx_count: number;
  total_tx_count: number;
  balance_raw: string;
  balance_display: string;
  balance_asset: string;
  total_received_raw: string;
  total_received_display: string;
  total_sent_raw: string;
  total_sent_display: string;
  completeness: DataCompleteness;
  completeness_details?: CompletenessDetails;
  unique_counterparty_count: number;
  observation_count: number;
  investigation_count: number;
  is_bookmarked: boolean;
  notes?: string;
  tags: string[];
  created_at: number;
  updated_at: number;
}

export interface CompletenessDetails {
  status: DataCompleteness;
  pages_retrieved: number;
  records_retrieved: number;
  provider_limit_hit: boolean;
  earliest_retrieved_activity?: number;
  latest_retrieved_activity?: number;
  pagination_completed: boolean;
  missing_token_history: boolean;
  missing_native_history: boolean;
  warning_message?: string;
}

export interface WalletObservation {
  id: string;
  wallet_id: string;
  address: string;
  claimed_network?: string;
  claimed_asset?: string;
  source_module: 'manual_entry' | 'bulk_paste' | 'csv_import' | 'site_investigator' | 'crypto_wallet_logger' | 'main_platform' | 'blockchain_counterparty';
  investigation_id?: string;
  site_entity_id?: string;
  website_domain?: string;
  source_url?: string;
  page_title?: string;
  deposit_option_context?: string;
  correlation_id?: string;
  evidence_id?: string;
  timestamp: number;
  notes?: string;
  raw_payload?: string;
}

export interface CanonicalTransaction {
  id: string; // internal UUID
  tx_hash: string;
  network: BlockchainNetwork;
  wallet_id: string;
  wallet_address: string;
  block_number?: number;
  timestamp: number;
  from_address: string;
  to_address: string;
  counterparty_address: string;
  direction: TransactionDirection;
  asset: string;
  is_token: boolean;
  token_contract?: string;
  token_decimals?: number;
  raw_amount: string; // Base integer units
  display_amount: string; // Decimal formatted
  fee_raw?: string;
  fee_display?: string;
  status: 'confirmed' | 'pending' | 'failed';
  provider: string;
  completeness: DataCompleteness;
  evidence_id: string;
  utxo_inputs?: UtxoInputOutput[];
  utxo_outputs?: UtxoInputOutput[];
  raw_metadata?: Record<string, unknown>;
}

export interface UtxoInputOutput {
  index: number;
  address: string;
  raw_amount: string;
  display_amount: string;
  is_change?: boolean;
  is_target_wallet: boolean;
}

export interface CounterpartyRecord {
  id: string;
  wallet_id: string;
  counterparty_address: string;
  network: BlockchainNetwork;
  direction: 'incoming' | 'outgoing' | 'bidirectional';
  tx_count: number;
  first_interaction_timestamp: number;
  last_interaction_timestamp: number;
  assets_involved: string[];
  total_received_from_raw: string;
  total_received_from_display: string;
  total_sent_to_raw: string;
  total_sent_to_display: string;
  is_known_site_wallet: boolean;
  associated_websites: string[];
  associated_investigations: string[];
  example_tx_hashes: string[];
  evidence_id: string;
}

export interface ConnectedWalletDiscovery {
  id: string;
  source_wallet_id: string;
  source_wallet_address: string;
  connected_wallet_address: string;
  network: BlockchainNetwork;
  relevance_score: number;
  reasons: string[];
  relationship_type: 'direct_counterparty' | 'repeated_counterparty' | 'shared_counterparty' | 'convergence_point' | 'divergence_point' | 'rapid_passthrough' | 'multi_site_counterparty';
  hop_distance: number;
  supporting_tx_hashes: string[];
  supporting_investigations: string[];
  supporting_websites: string[];
  is_promoted: boolean;
  promoted_at?: number;
  promoted_job_id?: string;
  evidence_id: string;
  created_at: number;
}

export interface FundFlowPattern {
  id: string;
  wallet_id: string;
  pattern_type:
    | 'rapid_passthrough'
    | 'convergence'
    | 'divergence'
    | 'dormancy_break'
    | 'activity_burst'
    | 'first_funding_source'
    | 'latest_destination'
    | 'repeated_counterparty'
    | 'multi_website_reuse'
    | 'shared_counterparty';
  title: string;
  description: string;
  supporting_addresses: string[];
  supporting_tx_hashes: string[];
  metric_summary?: string;
  detected_at: number;
  evidence_id: string;
  confidence?: number;
}

export interface EvidenceRecord {
  id: string;
  category: EvidenceCategory;
  title: string;
  description: string;
  wallet_id?: string;
  tx_hash?: string;
  source_provider?: string;
  investigation_id?: string;
  correlation_id?: string;
  raw_payload?: string;
  created_at: number;
  provenance_id: string;
}

export interface ProvenanceRecord {
  id: string;
  source_module: string;
  source_record_id?: string;
  provider: string;
  retrieval_timestamp: number;
  investigation_id?: string;
  correlation_id?: string;
  analysis_version: string;
  method: string;
  completeness: DataCompleteness;
  confidence: number;
}

export interface FindingRecord {
  id: string;
  wallet_id: string;
  finding_type: string;
  summary: string;
  explanation: string;
  supporting_evidence_ids: string[];
  supporting_tx_hashes: string[];
  confidence: number;
  completeness: DataCompleteness;
  created_at: number;
  analysis_version: string;
}

export interface ReviewItem {
  id: string;
  item_type: 'connected_wallet' | 'cross_investigation' | 'network_conflict' | 'partial_data' | 'fund_flow_anomaly' | 'unresolved_entity';
  title: string;
  why_it_needs_review: string;
  target_wallet_id: string;
  target_address: string;
  network: BlockchainNetwork;
  status: ReviewStatus;
  supporting_evidence_ids: string[];
  supporting_tx_hashes: string[];
  decision_notes?: string;
  decided_at?: number;
  decided_by?: string;
  created_at: number;
}

export interface AnalysisJob {
  id: string;
  wallet_id: string;
  address: string;
  network: BlockchainNetwork;
  profile: AnalysisProfileType;
  status: JobStatus;
  progress_percentage: number;
  current_step: string;
  investigation_id?: string;
  correlation_id?: string;
  retries_attempted: number;
  error_message?: string;
  started_at?: number;
  completed_at?: number;
  idempotency_key: string;
  created_at: number;
}

export interface AnalysisProfileConfig {
  name: AnalysisProfileType;
  max_pages: number;
  tx_limit_per_page: number;
  hop_depth: number;
  counterparty_expansion_limit: number;
  api_budget_calls: number;
  timeout_ms: number;
}

export interface TimelineEvent {
  id: string;
  timestamp: number;
  event_type: 'website_observation' | 'blockchain_incoming' | 'blockchain_outgoing' | 'token_transfer' | 'finding_generated' | 'counterparty_discovered' | 'analyst_action' | 'job_completed';
  title: string;
  description: string;
  wallet_id: string;
  address: string;
  network: BlockchainNetwork;
  asset?: string;
  amount_display?: string;
  tx_hash?: string;
  evidence_id?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  address: string;
  network: BlockchainNetwork;
  node_type: 'investigated' | 'counterparty' | 'known_site_wallet' | 'discovered';
  is_source: boolean;
  tx_count: number;
  observation_count: number;
  completeness: DataCompleteness;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  asset: string;
  display_amount: string;
  tx_count: number;
  latest_timestamp: number;
  tx_hashes: string[];
  is_repeated: boolean;
  is_shared: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PathFinderQuery {
  source_address: string;
  target_address: string;
  max_hops: number;
  allow_provider_expansion: boolean;
  networks?: BlockchainNetwork[];
}

export interface PathResult {
  found: boolean;
  hops: number;
  path_addresses: string[];
  edges: Array<{
    from: string;
    to: string;
    asset: string;
    amount_display: string;
    tx_hash: string;
    timestamp: number;
  }>;
  evidence_ids: string[];
  completeness: DataCompleteness;
}

export interface InvestigationRecord {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived' | 'concluded';
  wallet_count: number;
  observation_count: number;
  finding_count: number;
  created_at: number;
  updated_at: number;
}

export interface MainPlatformIntegrationStatus {
  registered: boolean;
  module_id: string;
  version: string;
  status: 'ONLINE' | 'STANDALONE_MODE' | 'REPLAYING_OFFLINE_QUEUE' | 'AUTH_ERROR';
  last_heartbeat_timestamp?: number;
  capabilities: string[];
  queued_outgoing_events_count: number;
  processed_jobs_count: number;
  last_error?: string;
}

export interface MainPlatformJobPayload {
  refresh_key?: string;
  job_id: string;
  job_type: 'ANALYZE_WALLET' | 'REFRESH_WALLET' | 'VALIDATE_WALLET';
  investigation_id: string;
  site_id?: string;
  correlation_id: string;
  address: string;
  claimed_network?: string;
  claimed_asset?: string;
  profile?: AnalysisProfileType;
  callback_url?: string;
}

export interface DashboardStats {
  wallets_under_investigation: number;
  active_analyses: number;
  needs_review: number;
  partial_analyses: number;
  total_findings: number;
  investigations_count: number;
  main_platform?: MainPlatformIntegrationStatus;
  recent_activity?: Array<{
    type: string;
    title: string;
    badge: string;
    timestamp: number;
  }>;
}

export type NormalizedTransaction = CanonicalTransaction;
export type ConnectedWalletRecord = ConnectedWalletDiscovery;
export type FundFlowPatternRecord = FundFlowPattern;

