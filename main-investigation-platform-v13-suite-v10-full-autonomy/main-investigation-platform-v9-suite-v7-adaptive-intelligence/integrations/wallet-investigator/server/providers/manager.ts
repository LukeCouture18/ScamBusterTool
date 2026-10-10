/**
 * Provider Manager & Dispatcher
 * Implements fallback failover, provider-aware rate limiting, request budgets,
 * caching with freshness tracking, and strict data completeness accounting.
 */

import { BlockchainNetwork, CompletenessDetails, DataCompleteness } from '../../src/types';
import { queryFirst, runStatement } from '../db/database';
import { SYNTHETIC_FIXTURES } from './fixtures';
import { blockscoutProvider } from './blockscout';
import { esploraProvider } from './esplora';
import { BlockchainProvider, ProviderFetchOptions, ProviderFetchResult, RawProviderTx } from './types';

export interface ProviderStats {
  name: string;
  is_healthy: boolean;
  requests_today: number;
  rate_limit_remaining: number;
  cooldown_until?: number;
  consecutive_failures: number;
}

export class ProviderManager {
  private providers: Map<string, BlockchainProvider> = new Map();
  private rateLimits: Map<string, { remaining: number; resetAt: number; cooldownUntil: number }> = new Map();
  private activityCalls = new Map<string,number>();
  public callsFor(address:string,network:string){return this.activityCalls.get(`${network}:${address}`)??0;}
  private httpCalls = new Map<string,number>();
  public httpCallsFor(address:string,network:string){return this.httpCalls.get(`${network}:${address}`)??0;}
  private requestCounts: Map<string, number> = new Map();

  constructor() {
    this.registerDefaultProviders();
  }

  /**
   * Registers default primary, secondary fallback, and synthetic providers
   */
  private registerDefaultProviders(): void {
    // 1. Synthetic / Offline Test Provider (Highest priority for deterministic testing & fixtures)
    if (process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES === '1') this.registerProvider({
      name: 'DeterministicFixturesProvider',
      supported_networks: [
        'bitcoin',
        'ethereum',
        'evm_uncertain',
        'bsc',
        'polygon',
        'arbitrum',
        'base',
        'optimism',
        'tron',
        'solana',
        'xrpl',
        'litecoin',
        'dogecoin',
      ],
      priority: 100,
      is_healthy: async () => true,
      fetch_wallet_activity: async (address, network, options) => {
        const fixture = SYNTHETIC_FIXTURES[address];
        if (fixture) {
          const isPartial = fixture.is_partial || (options?.max_pages && options.max_pages < 2 && fixture.total_tx_count > fixture.transactions.length);
          const completeness: DataCompleteness = isPartial ? 'PARTIAL' : 'COMPLETE';
          
          const details: CompletenessDetails = {
            status: completeness,
            pages_retrieved: 1,
            records_retrieved: fixture.transactions.length,
            provider_limit_hit: isPartial ? true : false,
            earliest_retrieved_activity: fixture.transactions[0]?.timestamp,
            latest_retrieved_activity: fixture.transactions[fixture.transactions.length - 1]?.timestamp,
            pagination_completed: !isPartial,
            missing_token_history: false,
            missing_native_history: false,
            warning_message: isPartial
              ? `Provider returned ${fixture.transactions.length} of ${fixture.total_tx_count} transactions due to pagination ceiling.`
              : undefined,
          };

          return {
            provider_name: 'DeterministicFixturesProvider',
            network: fixture.network,
            address,
            transactions: fixture.transactions,
            balance_raw: fixture.balance_raw,
            balance_asset: fixture.balance_asset,
            completeness,
            completeness_details: details,
            rate_limit_state: { remaining: 9999, reset_in_seconds: 3600 },
          };
        }

        // Unknown fixtures must never masquerade as complete blockchain history.
        throw new Error(`No synthetic fixture for ${address}`);
      },
    });

    if(process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES !== '1') {
      this.registerProvider(esploraProvider(fetch,(address,network)=>{const k=`${network}:${address}`;this.httpCalls.set(k,(this.httpCalls.get(k)??0)+1);}));
      const key=process.env.BLOCKSCOUT_API_KEY?.trim();
      if(key)this.registerProvider(blockscoutProvider(key,fetch,(address,network)=>{const k=`${network}:${address}`;this.httpCalls.set(k,(this.httpCalls.get(k)??0)+1);}));
      return; // A missing live provider is unavailable, never a simulated successful explorer.
    }
    // Fixture-only failover aliases preserve deterministic recovery tests.
    this.registerProvider({
      name: 'PrimaryPublicExplorerProvider',
      supported_networks: [
        'bitcoin',
        'ethereum',
        'bsc',
        'polygon',
        'arbitrum',
        'base',
        'tron',
        'solana',
        'xrpl',
        'litecoin',
        'dogecoin',
      ],
      priority: 50,
      is_healthy: async () => true,
      fetch_wallet_activity: async (address, network, options) => {
        // Fallback or live query simulation
        return this.providers.get('DeterministicFixturesProvider')!.fetch_wallet_activity(address, network, options);
      },
    });

    // 3. Secondary Failover Node Provider
    this.registerProvider({
      name: 'SecondaryFailoverProvider',
      supported_networks: ['bitcoin', 'ethereum', 'tron', 'solana', 'xrpl', 'litecoin', 'dogecoin'],
      priority: 10,
      is_healthy: async () => true,
      fetch_wallet_activity: async (address, network, options) => {
        return this.providers.get('DeterministicFixturesProvider')!.fetch_wallet_activity(address, network, options);
      },
    });
  }

  public registerProvider(provider: BlockchainProvider): void {
    this.providers.set(provider.name, provider);
    this.rateLimits.set(provider.name, {
      remaining: 100,
      resetAt: Date.now() + 60000,
      cooldownUntil: 0,
    });
    this.requestCounts.set(provider.name, 0);
  }

  /**
   * Fetches wallet activity with caching, rate limiting, and failover
   */
  public async fetchActivity(
    address: string,
    network: BlockchainNetwork,
    options?: ProviderFetchOptions & { bypassCache?: boolean; maxProviderAttempts?: number }
  ): Promise<ProviderFetchResult> {
    const cacheKey = `${network}:${['ethereum','bsc','polygon','arbitrum','base','optimism'].includes(network)?address.toLowerCase():address}:${options?.max_pages || 1}`;

    // 1. Check local persistent cache
    if (!options?.bypassCache) {
      const cached = queryFirst<{
        response_json: string;
        completeness: DataCompleteness;
        fetched_at: number;
        expires_at: number;
        provider: string;
      }>(`SELECT * FROM provider_cache WHERE cache_key = ? AND expires_at > ?;`, [cacheKey, Date.now()]);

      if (cached) {
        try {
          const parsed = JSON.parse(cached.response_json) as ProviderFetchResult;
          return {
            ...parsed,
            provider_name: `${cached.provider} (cached)`,
          };
        } catch {
          // Ignore cache parse error
        }
      }
    }

    // 2. Select compatible providers sorted by priority
    const candidates = Array.from(this.providers.values())
      .filter((p) => p.supported_networks.includes(network))
      .sort((a, b) => b.priority - a.priority);

    if (candidates.length === 0) {
      return {
        provider_name: 'None',
        network,
        address,
        transactions: [],
        balance_raw: '0',
        balance_asset: 'UNKNOWN',
        completeness: 'FAILED',
        completeness_details: {
          status: 'FAILED',
          pages_retrieved: 0,
          records_retrieved: 0,
          provider_limit_hit: false,
          pagination_completed: false,
          missing_token_history: true,
          missing_native_history: true,
          warning_message: `No active provider configured for network '${network}'.`,
        },
        error_message: `No provider registered for network '${network}'.`,
      };
    }

    let lastError: string | undefined;

    let attempted=0;
    for (const provider of candidates) {
      if(attempted>=Math.max(0,options?.maxProviderAttempts??6))break;
      const rateInfo = this.rateLimits.get(provider.name);
      if (rateInfo && rateInfo.cooldownUntil > Date.now()) {
        continue; // provider in cooldown
      }

      try {
        if(!(await provider.is_healthy()))continue;
        attempted++;
        const count = (this.requestCounts.get(provider.name) || 0) + 1;
        this.requestCounts.set(provider.name, count);

        const meterKey=`${network}:${address}`;
        this.activityCalls.set(meterKey,(this.activityCalls.get(meterKey)??0)+1);
        const result = await provider.fetch_wallet_activity(address, network, options);

        // Store into persistent provider_cache
        const ttlMs = 15 * 60 * 1000; // 15 min freshness
        runStatement(
          `INSERT OR REPLACE INTO provider_cache (cache_key, provider, endpoint, request_hash, response_json, completeness, status_code, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            cacheKey,
            provider.name,
            network,
            cacheKey,
            JSON.stringify(result),
            result.completeness,
            200,
            Date.now(),
            Date.now() + ttlMs,
          ]
        );

        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        console.warn(`[ProviderManager] Provider ${provider.name} failed: ${message}. Attempting failover...`);

        // Check if rate limited
        if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
          this.rateLimits.set(provider.name, {
            remaining: 0,
            resetAt: Date.now() + 60000,
            cooldownUntil: Date.now() + 30000, // 30s cooldown
          });
        }
      }
    }

    return {
      provider_name: 'FailoverExhausted',
      network,
      address,
      transactions: [],
      balance_raw: '0',
      balance_asset: 'UNKNOWN',
      completeness: 'FAILED',
      completeness_details: {
        status: 'FAILED',
        pages_retrieved: 0,
        records_retrieved: 0,
        provider_limit_hit: false,
        pagination_completed: false,
        missing_token_history: true,
        missing_native_history: true,
        warning_message: `All providers failed. Last error: ${lastError}`,
      },
      error_message: lastError || 'All candidate providers failed.',
    };
  }

  public getProviderStats(): ProviderStats[] {
    return Array.from(this.providers.values()).map((p) => {
      const rate = this.rateLimits.get(p.name);
      return {
        name: p.name,
        is_healthy: true,
        requests_today: this.requestCounts.get(p.name) || 0,
        rate_limit_remaining: rate?.remaining ?? 100,
        cooldown_until: rate?.cooldownUntil,
        consecutive_failures: 0,
      };
    });
  }
}

export const globalProviderManager = new ProviderManager();
