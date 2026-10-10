/**
 * Connected Wallet Discovery
 * Scores and surfaces investigation-relevant connected wallets
 * with complete "Why This Wallet Was Surfaced" factual justifications.
 */

import crypto from 'crypto';
import { BlockchainNetwork, ConnectedWalletDiscovery, WalletEntity } from '../../src/types';
import { queryAll, runStatement } from '../db/database';

export function discoverConnectedWallets(wallet: WalletEntity): ConnectedWalletDiscovery[] {
  // 1. Get counterparties of this wallet
  const cpRows = queryAll<Record<string, unknown>>(
    `SELECT * FROM counterparties WHERE wallet_id = ?;`,
    [wallet.id]
  );

  const discoveredList: ConnectedWalletDiscovery[] = [];

  for (const cp of cpRows) {
    const cpAddress = String(cp.counterparty_address);
    const txCount = Number(cp.tx_count);
    const isKnownSite = Boolean(cp.is_known_site_wallet);
    const associatedWebsites = JSON.parse(String(cp.associated_websites_json || '[]')) as string[];
    const associatedInvestigations = JSON.parse(String(cp.associated_investigations_json || '[]')) as string[];
    const exampleTxs = JSON.parse(String(cp.example_tx_hashes_json || '[]')) as string[];

    // Check if this counterparty appears in other wallets as well
    const crossWalletRows = queryAll<{ wallet_id: string; wallet_address: string; tx_hash: string }>(
      `SELECT DISTINCT t.wallet_id, w.address as wallet_address, t.tx_hash
       FROM transactions t
       JOIN wallets w ON t.wallet_id = w.id
       WHERE LOWER(t.counterparty_address) = LOWER(?) AND t.wallet_id != ?;`,
      [cpAddress, wallet.id]
    );

    const isSharedCounterparty = crossWalletRows.length > 0;
    const reasons: string[] = [];
    let score = 10; // Base direct connection

    reasons.push(`Direct blockchain counterparty with ${txCount} recorded transaction(s).`);

    if (txCount > 1) {
      score += 25;
      reasons.push(`Repeated interactions (${txCount} transactions) with investigated wallet.`);
    }

    if (isKnownSite) {
      score += 40;
      reasons.push(`Address was previously documented on scam website deposit page(s): ${associatedWebsites.join(', ')}.`);
    }

    if (isSharedCounterparty) {
      score += 50;
      const otherWallets = Array.from(new Set(crossWalletRows.map((r) => r.wallet_address)));
      reasons.push(`Shared counterparty: Also interacted with ${otherWallets.length} other investigated wallet(s): ${otherWallets.slice(0, 3).join(', ')}.`);
    }

    // Check if pass-through timing pattern occurred with this counterparty
    const rapidRows = queryAll<{ metric_summary: string }>(
      `SELECT metric_summary FROM fund_flow_patterns
       WHERE wallet_id = ? AND pattern_type = 'rapid_passthrough' AND supporting_addresses_json LIKE ?;`,
      [wallet.id, `%${cpAddress}%`]
    );
    if (rapidRows.length > 0) {
      score += 30;
      reasons.push(`Involved in rapid inbound-to-outbound fund transfer within 15 minutes.`);
    }

    let relType: ConnectedWalletDiscovery['relationship_type'] = 'direct_counterparty';
    if (isSharedCounterparty) relType = 'shared_counterparty';
    else if (isKnownSite) relType = 'multi_site_counterparty';
    else if (txCount > 1) relType = 'repeated_counterparty';
    else if (rapidRows.length > 0) relType = 'rapid_passthrough';

    const evidenceId = crypto.randomUUID();
    const provenanceId = crypto.randomUUID();

    // Create provenance & evidence
    runStatement(
      `INSERT OR REPLACE INTO provenance_records (id, source_module, source_record_id, provider, retrieval_timestamp, analysis_version, method, completeness, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        provenanceId,
        'connected_wallet_engine',
        wallet.id,
        'local_heuristics',
        Date.now(),
        '1.0.0',
        'scoring_algorithm',
        'COMPLETE',
        0.95,
      ]
    );

    runStatement(
      `INSERT OR REPLACE INTO evidence_records (id, category, title, description, wallet_id, source_provider, provenance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        evidenceId,
        'DERIVED_SOFTWARE_ANALYSIS',
        `Connected Wallet Discovery: ${cpAddress}`,
        `Surfaced connected wallet with score ${score}. Reasons: ${reasons.join(' ')}`,
        wallet.id,
        'connected_wallet_engine',
        provenanceId,
        Date.now(),
      ]
    );

    const discovery: ConnectedWalletDiscovery = {
      id: crypto.randomUUID(),
      source_wallet_id: wallet.id,
      source_wallet_address: wallet.address,
      connected_wallet_address: cpAddress,
      network: wallet.resolved_network,
      relevance_score: Math.min(score, 100),
      reasons,
      relationship_type: relType,
      hop_distance: 1,
      supporting_tx_hashes: exampleTxs.concat(crossWalletRows.map((r) => r.tx_hash).slice(0, 3)),
      supporting_investigations: associatedInvestigations,
      supporting_websites: associatedWebsites,
      is_promoted: false,
      evidence_id: evidenceId,
      created_at: Date.now(),
    };

    runStatement(
      `INSERT OR REPLACE INTO connected_wallets (id, source_wallet_id, source_wallet_address, connected_wallet_address, network, relevance_score, reasons_json, relationship_type, hop_distance, supporting_tx_hashes_json, supporting_investigations_json, supporting_websites_json, is_promoted, evidence_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        discovery.id,
        discovery.source_wallet_id,
        discovery.source_wallet_address,
        discovery.connected_wallet_address,
        discovery.network,
        discovery.relevance_score,
        JSON.stringify(discovery.reasons),
        discovery.relationship_type,
        discovery.hop_distance,
        JSON.stringify(discovery.supporting_tx_hashes),
        JSON.stringify(discovery.supporting_investigations),
        JSON.stringify(discovery.supporting_websites),
        0,
        discovery.evidence_id,
        discovery.created_at,
      ]
    );

    discoveredList.push(discovery);
  }

  // Sort discovered wallets by relevance score descending
  discoveredList.sort((a, b) => b.relevance_score - a.relevance_score);
  return discoveredList;
}
