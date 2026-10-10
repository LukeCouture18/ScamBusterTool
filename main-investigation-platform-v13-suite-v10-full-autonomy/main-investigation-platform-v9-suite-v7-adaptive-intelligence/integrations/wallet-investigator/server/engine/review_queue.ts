/**
 * Analyst Review Queue & Connected Wallet Promotion Engine
 */

import crypto from 'crypto';
import { ReviewItem, ReviewStatus, WalletEntity } from '../../src/types';
import { validateAddress } from '../crypto/validation';
import { queryAll, queryFirst, runStatement } from '../db/database';

export function evaluateReviewQueueItems(wallet: WalletEntity): ReviewItem[] {
  const generated: ReviewItem[] = [];

  // 1. High-scoring connected wallets
  const topConnected = queryAll<{
    id: string;
    connected_wallet_address: string;
    relevance_score: number;
    reasons_json: string;
    supporting_tx_hashes_json: string;
  }>(
    `SELECT id, connected_wallet_address, relevance_score, reasons_json, supporting_tx_hashes_json
     FROM connected_wallets
     WHERE source_wallet_id = ? AND relevance_score >= 50 AND is_promoted = 0;`,
    [wallet.id]
  );

  for (const cw of topConnected) {
    const reasons = JSON.parse(cw.reasons_json || '[]') as string[];
    const txHashes = JSON.parse(cw.supporting_tx_hashes_json || '[]') as string[];

    // Avoid duplicate review item if one already exists
    const existing = queryFirst(
      `SELECT id FROM review_queue WHERE target_address = ? AND item_type = 'connected_wallet';`,
      [cw.connected_wallet_address]
    );

    if (!existing) {
      const item: ReviewItem = {
        id: crypto.randomUUID(),
        item_type: 'connected_wallet',
        title: `High-Relevance Connected Wallet: ${cw.connected_wallet_address.slice(0, 10)}...`,
        why_it_needs_review: `Connected wallet scored ${cw.relevance_score}/100 based on: ${reasons.join('; ')}`,
        target_wallet_id: wallet.id,
        target_address: cw.connected_wallet_address,
        network: wallet.resolved_network,
        status: 'PENDING',
        supporting_evidence_ids: [],
        supporting_tx_hashes: txHashes,
        created_at: Date.now(),
      };
      saveReviewItem(item);
      generated.push(item);
    }
  }

  // 2. Partial data limitation review
  if (wallet.completeness === 'PARTIAL') {
    const existing = queryFirst(
      `SELECT id FROM review_queue WHERE target_wallet_id = ? AND item_type = 'partial_data';`,
      [wallet.id]
    );
    if (!existing) {
      const item: ReviewItem = {
        id: crypto.randomUUID(),
        item_type: 'partial_data',
        title: `Partial History Warning for ${wallet.address.slice(0, 10)}...`,
        why_it_needs_review: 'Provider rate or pagination limit truncated transaction history. Manual API key allocation or extended query profile recommended.',
        target_wallet_id: wallet.id,
        target_address: wallet.address,
        network: wallet.resolved_network,
        status: 'PENDING',
        supporting_evidence_ids: [],
        supporting_tx_hashes: [],
        created_at: Date.now(),
      };
      saveReviewItem(item);
      generated.push(item);
    }
  }

  // 3. Network Ambiguity Review
  if (wallet.network_ambiguity) {
    const existing = queryFirst(
      `SELECT id FROM review_queue WHERE target_wallet_id = ? AND item_type = 'network_conflict';`,
      [wallet.id]
    );
    if (!existing) {
      const item: ReviewItem = {
        id: crypto.randomUUID(),
        item_type: 'network_conflict',
        title: `EVM Network Ambiguity: ${wallet.address.slice(0, 10)}...`,
        why_it_needs_review: 'EVM address requires disambiguation between Ethereum, BSC, Polygon, or Layer-2s based on contextual deposit page evidence.',
        target_wallet_id: wallet.id,
        target_address: wallet.address,
        network: wallet.resolved_network,
        status: 'PENDING',
        supporting_evidence_ids: [],
        supporting_tx_hashes: [],
        created_at: Date.now(),
      };
      saveReviewItem(item);
      generated.push(item);
    }
  }

  return generated;
}

function saveReviewItem(item: ReviewItem): void {
  runStatement(
    `INSERT OR REPLACE INTO review_queue (id, item_type, title, why_it_needs_review, target_wallet_id, target_address, network, status, supporting_evidence_ids_json, supporting_tx_hashes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      item.id,
      item.item_type,
      item.title,
      item.why_it_needs_review,
      item.target_wallet_id,
      item.target_address,
      item.network,
      item.status,
      JSON.stringify(item.supporting_evidence_ids),
      JSON.stringify(item.supporting_tx_hashes),
      item.created_at,
    ]
  );
}

/**
 * Updates review item status (REVIEWED, PROMOTED, DISMISSED, DEFERRED)
 */
export function updateReviewStatus(
  reviewItemId: string,
  status: ReviewStatus,
  decisionNotes?: string,
  decidedBy: string = 'analyst'
): boolean {
  runStatement(
    `UPDATE review_queue
     SET status = ?, decision_notes = ?, decided_at = ?, decided_by = ?
     WHERE id = ?;`,
    [status, decisionNotes || null, Date.now(), decidedBy, reviewItemId]
  );
  return true;
}

/**
 * Promotes a connected counterparty address into a full investigated wallet entity
 */
export function promoteConnectedWalletToInvestigation(
  sourceWalletId: string,
  connectedAddress: string,
  investigationId?: string,
  justification?: string
): { walletId: string; jobId: string } {
  const sourceWallet = queryFirst<{ address: string; resolved_network: string }>(
    `SELECT address, resolved_network FROM wallets WHERE id = ?;`,
    [sourceWalletId]
  );

  const valResult = validateAddress(connectedAddress, sourceWallet?.resolved_network);

  // Check if wallet entity already exists
  const targetWallet = queryFirst<{ id: string }>(
    `SELECT id FROM wallets WHERE normalized_address = ?;`,
    [valResult.normalized_address]
  );

  let targetWalletId = targetWallet?.id;
  if (!targetWalletId) {
    targetWalletId = crypto.randomUUID();
    runStatement(
      `INSERT INTO wallets (id, address, normalized_address, address_format, reported_network, observed_network, resolved_network, network_ambiguity, validation_status, total_incoming_tx_count, total_outgoing_tx_count, total_tx_count, balance_raw, balance_display, balance_asset, total_received_raw, total_received_display, total_sent_raw, total_sent_display, completeness, unique_counterparty_count, observation_count, investigation_count, is_bookmarked, notes, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        targetWalletId,
        connectedAddress,
        valResult.normalized_address,
        valResult.address_format,
        sourceWallet?.resolved_network || null,
        valResult.detected_network,
        valResult.resolved_network,
        valResult.network_ambiguity ? 1 : 0,
        valResult.validation_status,
        0, 0, 0, '0', '0', '', '0', '0', '0', '0', 'UNKNOWN',
        0, 1, investigationId ? 1 : 0, 0,
        `Promoted from counterparty of ${sourceWallet?.address || sourceWalletId}. Justification: ${justification || 'Analyst decision'}`,
        JSON.stringify(['promoted_counterparty']),
        Date.now(),
        Date.now(),
      ]
    );
  }

  // Create observation linking provenance
  const obsId = crypto.randomUUID();
  runStatement(
    `INSERT INTO wallet_observations (id, wallet_id, address, claimed_network, source_module, investigation_id, timestamp, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      obsId,
      targetWalletId,
      connectedAddress,
      valResult.resolved_network,
      'blockchain_counterparty',
      investigationId || null,
      Date.now(),
      `Promoted from counterparty discovery. Reason: ${justification || 'High relevance score'}`,
    ]
  );

  // Mark as promoted in connected_wallets
  const jobId = crypto.randomUUID();
  runStatement(
    `UPDATE connected_wallets
     SET is_promoted = 1, promoted_at = ?, promoted_job_id = ?
     WHERE LOWER(connected_wallet_address) = LOWER(?);`,
    [Date.now(), jobId, connectedAddress]
  );

  // Create analysis job
  runStatement(
    `INSERT INTO analysis_jobs (id, wallet_id, address, network, profile, status, progress_percentage, current_step, investigation_id, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      jobId,
      targetWalletId,
      connectedAddress,
      valResult.resolved_network,
      'STANDARD',
      'QUEUED',
      0,
      'Job queued after promotion',
      investigationId || null,
      `promote:${targetWalletId}:${Date.now()}`,
      Date.now(),
    ]
  );

  return { walletId: targetWalletId, jobId };
}
