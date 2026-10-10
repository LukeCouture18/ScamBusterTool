/**
 * Persistent Background Job Runner
 * Manages analysis jobs with crash recovery, progress updates,
 * idempotency, retry/backoff, and cancellation.
 */

import crypto from 'crypto';
import { AnalysisJob, AnalysisProfileConfig, AnalysisProfileType, BlockchainNetwork, JobStatus, WalletEntity } from '../../src/types';
import { queryAll, queryFirst, runStatement } from '../db/database';
import { analyzeWalletActivity } from '../engine/analysis';
import { discoverConnectedWallets } from '../engine/connected_wallets';
import { generateWalletFindings } from '../engine/findings';
import { runControlledMultiHopTrace } from '../engine/multi_hop';
import { normalizeTransactions } from '../engine/normalizer';
import { evaluateReviewQueueItems } from '../engine/review_queue';
import { queueMainPlatformEvent } from '../integration/main_platform_v6';
import { globalProviderManager } from '../providers/manager';

export const PROFILE_CONFIGS: Record<AnalysisProfileType, AnalysisProfileConfig> = {
  QUICK: {
    name: 'QUICK',
    max_pages: 1,
    tx_limit_per_page: 25,
    hop_depth: 0,
    counterparty_expansion_limit: 10,
    api_budget_calls: 2,
    timeout_ms: 5000,
  },
  STANDARD: {
    name: 'STANDARD',
    max_pages: 3,
    tx_limit_per_page: 50,
    hop_depth: 1,
    counterparty_expansion_limit: 25,
    api_budget_calls: 6,
    timeout_ms: 12000,
  },
  DEEP: {
    name: 'DEEP',
    max_pages: 10,
    tx_limit_per_page: 100,
    hop_depth: 2,
    counterparty_expansion_limit: 50,
    api_budget_calls: 15,
    timeout_ms: 30000,
  },
};

export class BackgroundJobQueue {
  private isProcessing = false;
  private cancelledJobs = new Set<string>();

  constructor() {
    this.recoverStaleJobs();
    // Background polling loop
    setInterval(() => this.processNextJob(), 1500).unref();
  }

  /**
   * Recovers jobs interrupted by a crash or restart
   */
  public recoverStaleJobs(): void {
    try {
      const runningJobs = queryAll<{ id: string }>(
        `SELECT id FROM analysis_jobs WHERE status = 'RUNNING';`
      );
      for (const job of runningJobs) {
        console.log(`[JobQueue] Recovering interrupted job ${job.id} -> reset to QUEUED`);
        runStatement(
          `UPDATE analysis_jobs SET status = 'QUEUED', current_step = 'Recovered after server restart' WHERE id = ?;`,
          [job.id]
        );
      }
    } catch {
      // Database not yet initialized at module import time; will be handled when DB is ready
    }
  }

  /**
   * Queues an analysis job with strict idempotency
   */
  public enqueueJob(
    walletId: string,
    address: string,
    network: BlockchainNetwork,
    profile: AnalysisProfileType = 'STANDARD',
    investigationId?: string,
    correlationId?: string,
    refreshKey?: string
  ): AnalysisJob {
    const idempotencyKey = `job:${walletId}:${profile}:${investigationId || 'none'}` + (refreshKey ? `:refresh:${refreshKey}` : '');

    // Check for active job
    const existing = queryFirst<Record<string, unknown>>(
      `SELECT * FROM analysis_jobs
       WHERE wallet_id = ? AND status IN ('QUEUED', 'RUNNING')
       ORDER BY created_at DESC LIMIT 1;`,
      [walletId]
    );

    if (existing) {
      return this.mapJobRow(existing);
    }
    const historical = queryFirst<Record<string, unknown>>(`SELECT * FROM analysis_jobs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1;`, [idempotencyKey]);
    if (historical) return this.mapJobRow(historical);

    const jobId = crypto.randomUUID();
    const job: AnalysisJob = {
      id: jobId,
      wallet_id: walletId,
      address,
      network,
      profile,
      status: 'QUEUED',
      progress_percentage: 0,
      current_step: 'Queued for analysis',
      investigation_id: investigationId,
      correlation_id: correlationId,
      retries_attempted: 0,
      idempotency_key: idempotencyKey,
      created_at: Date.now(),
    };

    runStatement(
      `INSERT INTO analysis_jobs (id, wallet_id, address, network, profile, status, progress_percentage, current_step, investigation_id, correlation_id, retries_attempted, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        job.id,
        job.wallet_id,
        job.address,
        job.network,
        job.profile,
        job.status,
        job.progress_percentage,
        job.current_step,
        job.investigation_id || null,
        job.correlation_id || null,
        job.retries_attempted,
        job.idempotency_key,
        job.created_at,
      ]
    );

    return job;
  }

  public cancelJob(jobId: string): boolean {
    this.cancelledJobs.add(jobId);
    runStatement(
      `UPDATE analysis_jobs SET status = 'CANCELLED', current_step = 'Cancelled by user' WHERE id = ?;`,
      [jobId]
    );
    return true;
  }

  private async processNextJob(): Promise<void> {
    if (this.isProcessing) return;

    let nextJobRow: Record<string, unknown> | null = null;
    try {
      nextJobRow = queryFirst<Record<string, unknown>>(
        `SELECT * FROM analysis_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1;`
      );
    } catch {
      // Database not ready yet
      return;
    }

    if (!nextJobRow) return;

    this.isProcessing = true;
    const job = this.mapJobRow(nextJobRow);

    try {
      await this.executeJob(job);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[JobQueue] Job ${job.id} execution failed:`, errorMsg);
      runStatement(
        `UPDATE analysis_jobs SET status = 'FAILED', error_message = ?, current_step = 'Failed', completed_at = ? WHERE id = ?;`,
        [errorMsg, Date.now(), job.id]
      );
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeJob(job: AnalysisJob): Promise<void> {
    if (this.cancelledJobs.has(job.id)) return;

    const profileConfig = PROFILE_CONFIGS[job.profile] || PROFILE_CONFIGS.STANDARD;

    // Step 1: Mark Running (10%)
    runStatement(
      `UPDATE analysis_jobs SET status = 'RUNNING', progress_percentage = 10, current_step = 'Querying blockchain providers...', started_at = ? WHERE id = ?;`,
      [Date.now(), job.id]
    );

    // Fetch wallet entity
    const walletRow = queryFirst<Record<string, unknown>>(
      `SELECT * FROM wallets WHERE id = ?;`,
      [job.wallet_id]
    );
    if (!walletRow) {
      throw new Error(`Wallet with ID ${job.wallet_id} not found.`);
    }
    const wallet = this.mapWalletRow(walletRow);

    // Step 2: Fetch activity from provider (30%)
    const fetchResult = await globalProviderManager.fetchActivity(job.address, job.network, {
      max_pages: profileConfig.max_pages,
      page_size: profileConfig.tx_limit_per_page,
      bypassCache: job.idempotency_key.includes(":refresh:"),
      maxProviderAttempts: profileConfig.api_budget_calls,
    });

    if (this.cancelledJobs.has(job.id)) return;

    // Update wallet balance & completeness
    wallet.balance_raw = fetchResult.balance_raw;
    wallet.balance_asset = fetchResult.balance_asset;
    wallet.completeness = fetchResult.completeness;
    wallet.completeness_details = fetchResult.completeness_details;

    runStatement(
      `UPDATE wallets
       SET balance_raw = ?, balance_asset = ?, completeness = ?, completeness_details_json = ?, updated_at = ?
       WHERE id = ?;`,
      [
        wallet.balance_raw,
        wallet.balance_asset,
        wallet.completeness,
        JSON.stringify(wallet.completeness_details),
        Date.now(),
        wallet.id,
      ]
    );

    runStatement(
      `UPDATE analysis_jobs SET progress_percentage = 40, current_step = 'Normalizing transactions & minting evidence...' WHERE id = ?;`,
      [job.id]
    );

    // Step 3: Normalize transactions & mint evidence (50%)
    const { transactions } = normalizeTransactions(
      wallet,
      fetchResult.transactions,
      fetchResult.provider_name,
      fetchResult.completeness,
      job.investigation_id,
      job.correlation_id
    );

    runStatement(
      `UPDATE analysis_jobs SET progress_percentage = 60, current_step = 'Extracting counterparties & analyzing fund flows...' WHERE id = ?;`,
      [job.id]
    );

    // Step 4: Analyze Counterparties & Fund-Flow patterns (70%)
    analyzeWalletActivity(wallet);

    // Step 5: Connected Wallet Discovery (80%)
    discoverConnectedWallets(wallet);

    // Step 6: Generate Findings & Review Queue (90%)
    generateWalletFindings(wallet);
    evaluateReviewQueueItems(wallet);

    // Optional Step for DEEP profile: controlled multi-hop
    if (job.profile === 'DEEP' && profileConfig.hop_depth > 1) {
      runStatement(
        `UPDATE analysis_jobs SET progress_percentage = 92, current_step = 'Tracing controlled multi-hop fund flows...' WHERE id = ?;`,
        [job.id]
      );
      await runControlledMultiHopTrace(wallet.address, wallet.resolved_network, {
        max_depth: profileConfig.hop_depth,
        max_wallets: 15,
      });
    }

    // Deliver canonical results to Main Platform integration queue
    queueMainPlatformEvent('ANALYSIS_COMPLETED', job.idempotency_key, {
      job_id: job.id,
      wallet_id: wallet.id,
      address: wallet.address,
      network: wallet.resolved_network,
      completeness: wallet.completeness,
      total_transactions: transactions.length,
      investigation_id: job.investigation_id,
      correlation_id: job.correlation_id,
    });

    // Step 7: Completed (100%)
    const finalStatus: JobStatus = fetchResult.completeness === 'PARTIAL' ? 'PARTIAL' : 'COMPLETED';
    runStatement(
      `UPDATE analysis_jobs SET status = ?, progress_percentage = 100, current_step = 'Analysis completed successfully', completed_at = ? WHERE id = ?;`,
      [finalStatus, Date.now(), job.id]
    );
  }

  private mapJobRow(row: Record<string, unknown>): AnalysisJob {
    return {
      id: String(row.id),
      wallet_id: String(row.wallet_id),
      address: String(row.address),
      network: row.network as BlockchainNetwork,
      profile: row.profile as AnalysisProfileType,
      status: row.status as JobStatus,
      progress_percentage: Number(row.progress_percentage),
      current_step: String(row.current_step),
      investigation_id: row.investigation_id ? String(row.investigation_id) : undefined,
      correlation_id: row.correlation_id ? String(row.correlation_id) : undefined,
      retries_attempted: Number(row.retries_attempted),
      error_message: row.error_message ? String(row.error_message) : undefined,
      started_at: row.started_at ? Number(row.started_at) : undefined,
      completed_at: row.completed_at ? Number(row.completed_at) : undefined,
      idempotency_key: String(row.idempotency_key),
      created_at: Number(row.created_at),
    };
  }

  private mapWalletRow(row: Record<string, unknown>): WalletEntity {
    return {
      id: String(row.id),
      address: String(row.address),
      normalized_address: String(row.normalized_address),
      address_format: row.address_format as WalletEntity['address_format'],
      reported_network: row.reported_network ? String(row.reported_network) : undefined,
      observed_network: row.observed_network as WalletEntity['observed_network'],
      resolved_network: row.resolved_network as WalletEntity['resolved_network'],
      network_ambiguity: Boolean(row.network_ambiguity),
      network_conflict_notes: row.network_conflict_notes ? String(row.network_conflict_notes) : undefined,
      validation_status: row.validation_status as WalletEntity['validation_status'],
      first_seen_timestamp: row.first_seen_timestamp ? Number(row.first_seen_timestamp) : undefined,
      last_seen_timestamp: row.last_seen_timestamp ? Number(row.last_seen_timestamp) : undefined,
      first_tx_timestamp: row.first_tx_timestamp ? Number(row.first_tx_timestamp) : undefined,
      latest_tx_timestamp: row.latest_tx_timestamp ? Number(row.latest_tx_timestamp) : undefined,
      total_incoming_tx_count: Number(row.total_incoming_tx_count || 0),
      total_outgoing_tx_count: Number(row.total_outgoing_tx_count || 0),
      total_tx_count: Number(row.total_tx_count || 0),
      balance_raw: String(row.balance_raw || '0'),
      balance_display: String(row.balance_display || '0'),
      balance_asset: String(row.balance_asset || ''),
      total_received_raw: String(row.total_received_raw || '0'),
      total_received_display: String(row.total_received_display || '0'),
      total_sent_raw: String(row.total_sent_raw || '0'),
      total_sent_display: String(row.total_sent_display || '0'),
      completeness: row.completeness as WalletEntity['completeness'],
      completeness_details: row.completeness_details_json ? JSON.parse(String(row.completeness_details_json)) : undefined,
      unique_counterparty_count: Number(row.unique_counterparty_count || 0),
      observation_count: Number(row.observation_count || 0),
      investigation_count: Number(row.investigation_count || 0),
      is_bookmarked: Boolean(row.is_bookmarked),
      notes: row.notes ? String(row.notes) : undefined,
      tags: JSON.parse(String(row.tags_json || '[]')),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }
}

export const globalJobQueue = new BackgroundJobQueue();
