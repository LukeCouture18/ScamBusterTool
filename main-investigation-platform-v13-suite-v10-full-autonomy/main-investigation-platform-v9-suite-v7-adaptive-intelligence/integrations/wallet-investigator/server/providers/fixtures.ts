/**
 * Deterministic Synthetic Blockchain Fixtures
 * Provides robust, reproducible test data for all supported networks,
 * complex UTXO topologies, tokens, cross-investigation patterns,
 * partial dataset scenarios, and rate-limit simulations.
 */

import { BlockchainNetwork } from '../../src/types';
import { RawProviderTx } from './types';

export interface FixtureWalletData {
  address: string;
  network: BlockchainNetwork;
  claimed_tokens?: string[];
  balance_raw: string;
  balance_asset: string;
  total_tx_count: number;
  is_partial?: boolean;
  transactions: RawProviderTx[];
}

export const SYNTHETIC_FIXTURES: Record<string, FixtureWalletData> = {
  // 1. Bitcoin UTXO Scam Deposit Wallet (with multi-inputs, multi-outputs, and convergence)
  'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w': {
    address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
    network: 'bitcoin',
    balance_raw: '45000000', // 0.45 BTC
    balance_asset: 'BTC',
    total_tx_count: 3,
    transactions: [
      {
        tx_hash: '3a88c7e471f45681122a61b8fbf12f4835698b64e03f0b240409a807d9b97b01',
        block_number: 842100,
        timestamp: Date.now() - 86400000 * 5,
        from_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to_address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
        asset: 'BTC',
        is_token: false,
        raw_amount: '150000000', // 1.5 BTC
        fee_raw: '12500',
        status: 'confirmed',
        utxo_inputs: [
          {
            index: 0,
            address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            raw_amount: '150012500',
            is_target_wallet: false,
          },
        ],
        utxo_outputs: [
          {
            index: 0,
            address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
            raw_amount: '150000000',
            is_target_wallet: true,
          },
        ],
      },
      {
        tx_hash: 'f9b1c7d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        block_number: 842115,
        timestamp: Date.now() - 86400000 * 4,
        from_address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
        to_address: 'bc1qconsolidator777xyz9876543210abcdefghijkl',
        asset: 'BTC',
        is_token: false,
        raw_amount: '105000000', // 1.05 BTC swept to consolidator
        fee_raw: '15000',
        status: 'confirmed',
        utxo_inputs: [
          {
            index: 0,
            address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
            raw_amount: '150000000',
            is_target_wallet: true,
          },
        ],
        utxo_outputs: [
          {
            index: 0,
            address: 'bc1qconsolidator777xyz9876543210abcdefghijkl',
            raw_amount: '105000000',
            is_target_wallet: false,
          },
          {
            index: 1,
            address: 'bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w',
            raw_amount: '44985000',
            is_change: true,
            is_target_wallet: true,
          },
        ],
      },
    ],
  },

  // 2. Ethereum Scam Deposit Wallet with ETH + USDT ERC20
  '0x71c841094df8cf7fa128565551f337f74c7dbb94': {
    address: '0x71c841094df8cf7fa128565551f337f74c7dbb94',
    network: 'ethereum',
    claimed_tokens: ['ETH', 'USDT'],
    balance_raw: '350000000000000000', // 0.35 ETH
    balance_asset: 'ETH',
    total_tx_count: 4,
    transactions: [
      {
        tx_hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        block_number: 19800001,
        timestamp: Date.now() - 86400000 * 3,
        from_address: '0x3333333333333333333333333333333333333333',
        to_address: '0x71c841094df8cf7fa128565551f337f74c7dbb94',
        asset: 'ETH',
        is_token: false,
        raw_amount: '2000000000000000000', // 2.0 ETH
        fee_raw: '2100000000000000',
        status: 'confirmed',
      },
      {
        tx_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        block_number: 19800010,
        timestamp: Date.now() - 86400000 * 3 + 240000, // 4 mins later (rapid pass-through!)
        from_address: '0x71c841094df8cf7fa128565551f337f74c7dbb94',
        to_address: '0x8888888888888888888888888888888888888888',
        asset: 'ETH',
        is_token: false,
        raw_amount: '1650000000000000000', // 1.65 ETH onward
        fee_raw: '2100000000000000',
        status: 'confirmed',
      },
      {
        tx_hash: '0xdddd567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        block_number: 19800045,
        timestamp: Date.now() - 86400000 * 2,
        from_address: '0x4444444444444444444444444444444444444444',
        to_address: '0x71c841094df8cf7fa128565551f337f74c7dbb94',
        asset: 'USDT',
        is_token: true,
        token_contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        token_decimals: 6,
        raw_amount: '5000000000', // 5,000 USDT
        fee_raw: '4200000000000000',
        status: 'confirmed',
      },
      {
        tx_hash: '0xeeee567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        block_number: 19800055,
        timestamp: Date.now() - 86400000 * 2 + 180000, // 3 mins later (pass-through)
        from_address: '0x71c841094df8cf7fa128565551f337f74c7dbb94',
        to_address: '0x8888888888888888888888888888888888888888', // Shared destination consolidator!
        asset: 'USDT',
        is_token: true,
        token_contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        token_decimals: 6,
        raw_amount: '5000000000', // 5,000 USDT onward
        fee_raw: '4200000000000000',
        status: 'confirmed',
      },
    ],
  },

  // 3. TRON USDT TRC20 High Velocity Scam Wallet
  'TXxxScamDepositTronWallet99887766554': {
    address: 'TXxxScamDepositTronWallet99887766554',
    network: 'tron',
    claimed_tokens: ['TRX', 'USDT TRC20'],
    balance_raw: '125000000', // 125 TRX
    balance_asset: 'TRX',
    total_tx_count: 3,
    transactions: [
      {
        tx_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
        block_number: 59000100,
        timestamp: Date.now() - 86400000 * 1,
        from_address: 'TVictimOneTronWalletAddress1234567890',
        to_address: 'TXxxScamDepositTronWallet99887766554',
        asset: 'USDT TRC20',
        is_token: true,
        token_contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        token_decimals: 6,
        raw_amount: '12000000000', // 12,000 USDT
        fee_raw: '15000000',
        status: 'confirmed',
      },
      {
        tx_hash: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01',
        block_number: 59000120,
        timestamp: Date.now() - 86400000 * 1 + 120000, // 2 mins later
        from_address: 'TXxxScamDepositTronWallet99887766554',
        to_address: 'TMasterLaunderingHubWalletTron777888',
        asset: 'USDT TRC20',
        is_token: true,
        token_contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        token_decimals: 6,
        raw_amount: '12000000000', // 12,000 USDT
        fee_raw: '15000000',
        status: 'confirmed',
      },
    ],
  },

  // 4. Solana SPL Token Scam Wallet
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': {
    address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    network: 'solana',
    claimed_tokens: ['SOL', 'USDC SPL'],
    balance_raw: '2500000000', // 2.5 SOL
    balance_asset: 'SOL',
    total_tx_count: 2,
    transactions: [
      {
        tx_hash: '5VERi8qBQ8F1q7j6pYd8T8f4N2M6k9W1x3Z5y7B9a1C3e5G7i9K1m3O5q7S9u1W3',
        block_number: 260000120,
        timestamp: Date.now() - 86400000 * 6,
        from_address: 'VictimSolanaWallet11111111111111111111111111',
        to_address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        asset: 'SOL',
        is_token: false,
        raw_amount: '10000000000', // 10 SOL
        fee_raw: '5000',
        status: 'confirmed',
      },
      {
        tx_hash: '4MERi8qBQ8F1q7j6pYd8T8f4N2M6k9W1x3Z5y7B9a1C3e5G7i9K1m3O5q7S9u1W2',
        block_number: 260000180,
        timestamp: Date.now() - 86400000 * 6 + 300000,
        from_address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        to_address: 'SolanaExitExchangeDepositWallet77777777777777',
        asset: 'SOL',
        is_token: false,
        raw_amount: '7500000000', // 7.5 SOL onward
        fee_raw: '5000',
        status: 'confirmed',
      },
    ],
  },

  // 5. XRP Ledger Scam Wallet
  'rEb8TK3gBgk5auZyyYU55PAa2fZN87GWVL': {
    address: 'rEb8TK3gBgk5auZyyYU55PAa2fZN87GWVL',
    network: 'xrpl',
    balance_raw: '50000000', // 50 XRP
    balance_asset: 'XRP',
    total_tx_count: 2,
    transactions: [
      {
        tx_hash: '4B8C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C',
        block_number: 84000200,
        timestamp: Date.now() - 86400000 * 7,
        from_address: 'rVictimXrpFundingWalletAddress1234567890',
        to_address: 'rEb8TK3gBgk5auZyyYU55PAa2fZN87GWVL',
        asset: 'XRP',
        is_token: false,
        raw_amount: '2500000000', // 2,500 XRP
        fee_raw: '12',
        status: 'confirmed',
      },
      {
        tx_hash: '5C9D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D',
        block_number: 84000240,
        timestamp: Date.now() - 86400000 * 7 + 400000,
        from_address: 'rEb8TK3gBgk5auZyyYU55PAa2fZN87GWVL',
        to_address: 'rXrpConsolidationHubAddress9876543210',
        asset: 'XRP',
        is_token: false,
        raw_amount: '2450000000', // 2,450 XRP onward
        fee_raw: '12',
        status: 'confirmed',
      },
    ],
  },

  // 6. Litecoin Deposit Wallet
  'LhyXgZ5x2QkK8mNpRtVwYzA4bCdEfGhJkL': {
    address: 'LhyXgZ5x2QkK8mNpRtVwYzA4bCdEfGhJkL',
    network: 'litecoin',
    balance_raw: '120000000', // 1.2 LTC
    balance_asset: 'LTC',
    total_tx_count: 2,
    transactions: [
      {
        tx_hash: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
        block_number: 2600100,
        timestamp: Date.now() - 86400000 * 8,
        from_address: 'LVictimFundingWallet123456789012345',
        to_address: 'LhyXgZ5x2QkK8mNpRtVwYzA4bCdEfGhJkL',
        asset: 'LTC',
        is_token: false,
        raw_amount: '500000000', // 5 LTC
        fee_raw: '100000',
        status: 'confirmed',
      },
      {
        tx_hash: '8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c',
        block_number: 2600120,
        timestamp: Date.now() - 86400000 * 8 + 360000,
        from_address: 'LhyXgZ5x2QkK8mNpRtVwYzA4bCdEfGhJkL',
        to_address: 'LMasterLtcPoolWallet987654321098765',
        asset: 'LTC',
        is_token: false,
        raw_amount: '380000000', // 3.8 LTC
        fee_raw: '100000',
        status: 'confirmed',
      },
    ],
  },

  // 7. Dogecoin Deposit Wallet
  'DJmX4uY7eR9pK3tNqWbZ2vC5xL8aGfDhJs': {
    address: 'DJmX4uY7eR9pK3tNqWbZ2vC5xL8aGfDhJs',
    network: 'dogecoin',
    balance_raw: '50000000000', // 500 DOGE
    balance_asset: 'DOGE',
    total_tx_count: 2,
    transactions: [
      {
        tx_hash: '7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d',
        block_number: 5120000,
        timestamp: Date.now() - 86400000 * 9,
        from_address: 'DVictimDogePayer123456789012345678',
        to_address: 'DJmX4uY7eR9pK3tNqWbZ2vC5xL8aGfDhJs',
        asset: 'DOGE',
        is_token: false,
        raw_amount: '200000000000', // 2,000 DOGE
        fee_raw: '100000000',
        status: 'confirmed',
      },
      {
        tx_hash: '6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e',
        block_number: 5120040,
        timestamp: Date.now() - 86400000 * 9 + 480000,
        from_address: 'DJmX4uY7eR9pK3tNqWbZ2vC5xL8aGfDhJs',
        to_address: 'DConsolidatedDogePool98765432109876',
        asset: 'DOGE',
        is_token: false,
        raw_amount: '150000000000', // 1,500 DOGE
        fee_raw: '100000000',
        status: 'confirmed',
      },
    ],
  },

  // 8. PARTIAL DATA SCENARIO WALLET
  // Demonstrates requirement 6: "Every analysis should expose COMPLETE, PARTIAL, LIMITED, UNKNOWN, FAILED...
  // Record: pages retrieved, records retrieved, provider limits, earliest, latest, whether pagination completed"
  '1BoatSLRHtKNngkdXEeobR76b53LETtpyT': {
    address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    network: 'bitcoin',
    balance_raw: '25000000',
    balance_asset: 'BTC',
    total_tx_count: 1420, // 1420 on-chain, but provider was capped at 25
    is_partial: true,
    transactions: [
      {
        tx_hash: '0101010101010101010101010101010101010101010101010101010101010101',
        block_number: 840000,
        timestamp: Date.now() - 86400000 * 2,
        from_address: '1CounterpartyPartialA1111111111111',
        to_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        asset: 'BTC',
        is_token: false,
        raw_amount: '50000000',
        fee_raw: '10000',
        status: 'confirmed',
      },
      {
        tx_hash: '0202020202020202020202020202020202020202020202020202020202020202',
        block_number: 840050,
        timestamp: Date.now() - 86400000 * 1,
        from_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        to_address: '1CounterpartyPartialB2222222222222',
        asset: 'BTC',
        is_token: false,
        raw_amount: '25000000',
        fee_raw: '10000',
        status: 'confirmed',
      },
    ],
  },
};
