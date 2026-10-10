/**
 * Blockchain Provider Types & Abstraction
 */

import { BlockchainNetwork, CompletenessDetails, DataCompleteness } from '../../src/types';

export interface RawProviderTx {
  tx_hash: string;
  block_number?: number;
  timestamp: number;
  from_address: string;
  to_address: string;
  asset: string;
  is_token: boolean;
  token_contract?: string;
  token_decimals?: number;
  raw_amount: string; // Base integer units
  fee_raw?: string;
  status: 'confirmed' | 'pending' | 'failed';
  utxo_inputs?: Array<{
    index: number;
    address: string;
    raw_amount: string;
    is_target_wallet: boolean;
  }>;
  utxo_outputs?: Array<{
    index: number;
    address: string;
    raw_amount: string;
    is_change?: boolean;
    is_target_wallet: boolean;
  }>;
  raw_metadata?: Record<string, unknown>;
}

export interface ProviderFetchOptions {
  max_pages?: number;
  page_size?: number;
  from_timestamp?: number;
  to_timestamp?: number;
  include_tokens?: boolean;
  simulation_mode?: 'normal' | 'simulate_partial' | 'simulate_rate_limit' | 'simulate_failure';
}

export interface ProviderFetchResult {
  request_meter?: { http_requests: number };
  provider_name: string;
  network: BlockchainNetwork;
  address: string;
  transactions: RawProviderTx[];
  balance_raw: string;
  balance_asset: string;
  completeness: DataCompleteness;
  completeness_details: CompletenessDetails;
  rate_limit_state?: {
    remaining: number;
    reset_in_seconds: number;
  };
  error_message?: string;
  raw_response_ref?: string;
}

export interface BlockchainProvider {
  name: string;
  supported_networks: BlockchainNetwork[];
  priority: number;
  is_healthy(): Promise<boolean>;
  fetch_wallet_activity(
    address: string,
    network: BlockchainNetwork,
    options?: ProviderFetchOptions
  ): Promise<ProviderFetchResult>;
}
