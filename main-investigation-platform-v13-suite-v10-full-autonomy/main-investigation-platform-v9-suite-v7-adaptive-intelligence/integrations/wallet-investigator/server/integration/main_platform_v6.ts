/**
 * Main Investigation Platform v6 Integration
 * Canonical Module Registration, Heartbeat, Job Ingestion,
 * and Durable Offline Event Delivery Outbox.
 */

import crypto from 'crypto';
import { MainPlatformIntegrationStatus, MainPlatformJobPayload } from '../../src/types';
import { AddressValidationResult, toEngineNetwork, toLegacyValidation, validateAddress, WalletValidationResult } from '../crypto/validation';
import { queryAll, queryFirst, runStatement } from '../db/database';
import { globalJobQueue } from '../jobs/job_queue';

export const CANONICAL_CAPABILITIES = [
  'blockchain-analysis',
  'wallet-validation',
  'counterparty-discovery',
  'fund-flow-analysis',
  'controlled-wallet-expansion',
];

export class MainPlatformIntegration {
  private moduleId = 'wallet_investigator';
  private version = '1.0.0';
  private platformStatus: 'ONLINE' | 'STANDALONE_MODE' | 'REPLAYING_OFFLINE_QUEUE' | 'AUTH_ERROR' = 'STANDALONE_MODE';
  private lastHeartbeat: number | undefined;
  private isReplaying = false;

  constructor() {
    this.initHeartbeat();
    // Outbox delivery worker
    setInterval(() => this.processOutbox(), 4000).unref();
  }

  private initHeartbeat(): void {
    this.lastHeartbeat = Date.now();
    this.platformStatus = 'STANDALONE_MODE';
    console.log(`[MainPlatformV6] Initialized integration module '${this.moduleId}' with capabilities:`, CANONICAL_CAPABILITIES);
  }

  public getStatus(): MainPlatformIntegrationStatus {
    const queueCountRow = queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM main_platform_queue WHERE status = 'QUEUED';`
    );
    const jobsProcessedRow = queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM analysis_jobs WHERE status IN ('COMPLETED', 'PARTIAL');`
    );

    return {
      registered: true,
      module_id: this.moduleId,
      version: this.version,
      status: this.platformStatus,
      last_heartbeat_timestamp: this.lastHeartbeat,
      capabilities: CANONICAL_CAPABILITIES,
      queued_outgoing_events_count: queueCountRow?.cnt || 0,
      processed_jobs_count: jobsProcessedRow?.cnt || 0,
    };
  }
  public connected():void{this.platformStatus='ONLINE';this.lastHeartbeat=Date.now();}
  public disconnected(authFailure=false):void{this.platformStatus=authFailure?'AUTH_ERROR':'STANDALONE_MODE';}
  public async flushOutbox():Promise<void>{await this.processOutbox();}

  /**
   * Accepts canonical jobs from Main Investigation Platform v6
   * (e.g. ANALYZE_WALLET, REFRESH_WALLET, VALIDATE_WALLET)
   */
  public handleIncomingJob(payload: MainPlatformJobPayload, preValidated?: WalletValidationResult): {
    accepted: boolean;
    job_id?: string;
    wallet_id?: string;
    message: string;
  } {
    if (!payload.address) {
      return { accepted: false, message: 'Address field is mandatory.' };
    }

    // Step 1: Validate address & identify network. v4 jobs pass the authoritative result they already
    // computed (status must be valid with a resolved network); legacy jobs validate here as before.
    let validation: AddressValidationResult;
    if (preValidated) {
      if (preValidated.status !== 'valid' || !preValidated.network) return { accepted: false, message: `Wallet validation status is ${preValidated.status}; analysis is not run.` };
      const engineNetwork = toEngineNetwork(preValidated.network);
      validation = { ...toLegacyValidation(preValidated), resolved_network: engineNetwork, detected_network: preValidated.family === 'evm' ? 'evm_uncertain' : engineNetwork, network_ambiguity: false, conflict_detected: false };
    } else {
      validation = validateAddress(payload.address, payload.claimed_network);
    }
    if(!validation.is_valid||validation.conflict_detected)return{accepted:false,message:'Invalid wallet address or conflicting network; analyst review required.'};

    // Step 2: Upsert Wallet Entity
    const wallet = queryFirst<{ id: string }>(
      `SELECT id FROM wallets WHERE normalized_address = ? AND resolved_network = ?;`,
      [validation.normalized_address,validation.resolved_network]
    );

    let walletId = wallet?.id;
    if (!walletId) {
      walletId = crypto.randomUUID();
      runStatement(
        `INSERT INTO wallets (id, address, normalized_address, address_format, reported_network, observed_network, resolved_network, network_ambiguity, validation_status, total_incoming_tx_count, total_outgoing_tx_count, total_tx_count, balance_raw, balance_display, balance_asset, total_received_raw, total_received_display, total_sent_raw, total_sent_display, completeness, unique_counterparty_count, observation_count, investigation_count, is_bookmarked, notes, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          walletId,
          payload.address,
          validation.normalized_address,
          validation.address_format,
          payload.claimed_network || null,
          validation.detected_network,
          validation.resolved_network,
          validation.network_ambiguity ? 1 : 0,
          validation.validation_status,
          0, 0, 0, '0', '0', '', '0', '0', '0', '0', 'UNKNOWN',
          0, 1, payload.investigation_id ? 1 : 0, 0,
          `Ingested from Main Investigation Platform v6 job ${payload.job_id}`,
          JSON.stringify(['main_platform_v6']),
          Date.now(),
          Date.now(),
        ]
      );
    }

    // Step 3: Record observation
    runStatement(
      `INSERT INTO wallet_observations (id, wallet_id, address, claimed_network, claimed_asset, source_module, investigation_id, site_entity_id, correlation_id, timestamp, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        crypto.randomUUID(),
        walletId,
        payload.address,
        payload.claimed_network || null,
        payload.claimed_asset || null,
        'main_platform',
        payload.investigation_id || null,
        payload.site_id || null,
        payload.correlation_id,
        Date.now(),
        `Main Investigation Platform v6 job: ${payload.job_type}`,
      ]
    );

    // If validation-only job
    if (payload.job_type === 'VALIDATE_WALLET') {
      return {
        accepted: true,
        wallet_id: walletId,
        message: `Validated address successfully. Status: ${validation.validation_status}, Resolved Network: ${validation.resolved_network}`,
      };
    }

    // Step 4: Enqueue analysis job with idempotency
    const job = globalJobQueue.enqueueJob(
      walletId,
      payload.address,
      validation.resolved_network,
      payload.profile || 'STANDARD',
      payload.investigation_id,
      payload.correlation_id,
      payload.refresh_key
    );

    return {
      accepted: true,
      job_id: job.id,
      wallet_id: walletId,
      message: `Job ${payload.job_id} accepted by Wallet Investigator v1.0. Analysis queued.`,
    };
  }

  /**
   * Outbox worker delivering queued events or replaying upon reconnection
   */
  private async processOutbox(): Promise<void> {
    if (this.isReplaying) return;

    let queuedEvents: { id: string; event_type: string; idempotency_key: string; payload_json: string }[];
    try {
      queuedEvents = queryAll<{ id: string; event_type: string; idempotency_key: string; payload_json: string }>(
        `SELECT * FROM main_platform_queue WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 10;`
      );
    } catch {
      // Database not open yet (this timer starts when the module is imported); try again next tick.
      return;
    }

    if (queuedEvents.length === 0) return;

    this.isReplaying = true;
    for (const ev of queuedEvents) {
      try {
        // A local outbox row is not delivered until the platform acknowledges it.
        const base=process.env.MAIN_PLATFORM_URL,token=process.env.WALLET_INVESTIGATOR_MODULE_KEY;
        const event=JSON.parse(ev.payload_json);
        if(!base||!token||!event.entity_id||!event.investigation_id)continue;
        const response=await fetch(`${base.replace(/\/$/,'')}/api/v1/events`,{method:'POST',headers:{'content-type':'application/json','x-api-key':token},body:JSON.stringify({source_module:'wallet_investigator',events:[{event_id:ev.idempotency_key,event_type:'wallet.analyzed',schema_version:'3.0',investigation_id:event.investigation_id,entity_id:event.entity_id,correlation_id:event.correlation_id,provenance:{method:'wallet_investigator',outbox_id:ev.id},payload:event}]})});
        if(!response.ok)throw new Error(`Platform event HTTP ${response.status}`);
        const acknowledgement=await response.json() as {accepted?:number;rejected?:number};
        if(acknowledgement.accepted!==1||acknowledgement.rejected)throw new Error('Platform event was not acknowledged');
        runStatement(
          `UPDATE main_platform_queue SET status = 'DELIVERED', updated_at = ? WHERE id = ?;`,
          [Date.now(), ev.id]
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        runStatement(
          `UPDATE main_platform_queue SET last_error = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?;`,
          [msg, Date.now(), ev.id]
        );
      }
    }
    this.isReplaying = false;
  }
}

export const globalMainPlatform = new MainPlatformIntegration();

export function queueMainPlatformEvent(eventType: string, idempotencyKey: string, payload: Record<string, unknown>): void {
  runStatement(
      `INSERT OR IGNORE INTO main_platform_queue (id, event_type, idempotency_key, payload_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'QUEUED', ?, ?);`,
    [
      crypto.randomUUID(),
      eventType,
      idempotencyKey,
      JSON.stringify(payload),
      Date.now(),
      Date.now(),
    ]
  );
}
