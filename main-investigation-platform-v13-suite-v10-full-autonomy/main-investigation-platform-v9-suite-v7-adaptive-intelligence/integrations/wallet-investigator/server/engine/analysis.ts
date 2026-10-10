/**
 * Blockchain Fund-Flow Analysis & Counterparty Discovery Engine
 * Strictly identifies factual, observable transaction patterns without pejorative conclusions.
 */

import crypto from 'crypto';
import { CanonicalTransaction, CounterpartyRecord, FundFlowPattern, WalletEntity } from '../../src/types';
import { addRawAmounts, formatBaseUnitToDisplay } from '../crypto/precision';
import { queryAll, queryFirst, runStatement } from '../db/database';

export function analyzeWalletActivity(wallet: WalletEntity): {
  counterparties: CounterpartyRecord[];
  patterns: FundFlowPattern[];
} {
  // Fetch all transactions for this wallet
  const txRows = queryAll<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE wallet_id = ? ORDER BY timestamp ASC;`,
    [wallet.id]
  );

  const transactions: CanonicalTransaction[] = txRows.map((r) => ({
    id: String(r.id),
    tx_hash: String(r.tx_hash),
    network: r.network as CanonicalTransaction['network'],
    wallet_id: String(r.wallet_id),
    wallet_address: String(r.wallet_address),
    block_number: r.block_number ? Number(r.block_number) : undefined,
    timestamp: Number(r.timestamp),
    from_address: String(r.from_address),
    to_address: String(r.to_address),
    counterparty_address: String(r.counterparty_address),
    direction: r.direction as CanonicalTransaction['direction'],
    asset: String(r.asset),
    is_token: Boolean(r.is_token),
    token_contract: r.token_contract ? String(r.token_contract) : undefined,
    token_decimals: r.token_decimals ? Number(r.token_decimals) : undefined,
    raw_amount: String(r.raw_amount),
    display_amount: String(r.display_amount),
    fee_raw: r.fee_raw ? String(r.fee_raw) : undefined,
    fee_display: r.fee_display ? String(r.fee_display) : undefined,
    status: r.status as CanonicalTransaction['status'],
    provider: String(r.provider),
    completeness: r.completeness as CanonicalTransaction['completeness'],
    evidence_id: String(r.evidence_id),
  }));

  // 1. Counterparty Discovery
  const counterpartyMap = new Map<string, {
    address: string;
    incomingCount: number;
    outgoingCount: number;
    txCount: number;
    firstTime: number;
    lastTime: number;
    assets: Set<string>;
    receivedRaw: string;
    sentRaw: string;
    exampleHashes: string[];
    sampleDecimals: number;
  }>();

  for (const tx of transactions) {
    const cp = tx.counterparty_address;
    if (!cp || cp.toLowerCase() === wallet.address.toLowerCase()) continue;

    let existing = counterpartyMap.get(cp);
    if (!existing) {
      existing = {
        address: cp,
        incomingCount: 0,
        outgoingCount: 0,
        txCount: 0,
        firstTime: tx.timestamp,
        lastTime: tx.timestamp,
        assets: new Set<string>(),
        receivedRaw: '0',
        sentRaw: '0',
        exampleHashes: [],
        sampleDecimals: tx.token_decimals || 18,
      };
      counterpartyMap.set(cp, existing);
    }

    existing.txCount++;
    existing.firstTime = Math.min(existing.firstTime, tx.timestamp);
    existing.lastTime = Math.max(existing.lastTime, tx.timestamp);
    existing.assets.add(tx.asset);
    if (existing.exampleHashes.length < 5) {
      existing.exampleHashes.push(tx.tx_hash);
    }

    if (tx.direction === 'incoming') {
      existing.incomingCount++;
      existing.receivedRaw = addRawAmounts(existing.receivedRaw, tx.raw_amount);
    } else if (tx.direction === 'outgoing') {
      existing.outgoingCount++;
      existing.sentRaw = addRawAmounts(existing.sentRaw, tx.raw_amount);
    }
  }

  // Check known website observations for these counterparties
  const counterparties: CounterpartyRecord[] = [];
  for (const [cpAddress, data] of counterpartyMap.entries()) {
    const observations = queryAll<{ website_domain: string; investigation_id: string }>(
      `SELECT website_domain, investigation_id FROM wallet_observations WHERE LOWER(address) = LOWER(?);`,
      [cpAddress]
    );

    const associatedWebsites = Array.from(new Set(observations.map((o) => o.website_domain).filter(Boolean)));
    const associatedInvestigations = Array.from(new Set(observations.map((o) => o.investigation_id).filter(Boolean)));
    const isKnownSiteWallet = associatedWebsites.length > 0;

    let dir: 'incoming' | 'outgoing' | 'bidirectional' = 'incoming';
    if (data.incomingCount > 0 && data.outgoingCount > 0) {
      dir = 'bidirectional';
    } else if (data.outgoingCount > 0) {
      dir = 'outgoing';
    }

    const evidenceId = crypto.randomUUID();
    const provenanceId = crypto.randomUUID();

    // Provenance
    runStatement(
      `INSERT OR REPLACE INTO provenance_records (id, source_module, source_record_id, provider, retrieval_timestamp, investigation_id, analysis_version, method, completeness, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        provenanceId,
        'analysis_engine',
        wallet.id,
        'local_derivation',
        Date.now(),
        null,
        '1.0.0',
        'counterparty_aggregation',
        'COMPLETE',
        1.0,
      ]
    );

    // Evidence
    runStatement(
      `INSERT OR REPLACE INTO evidence_records (id, category, title, description, wallet_id, source_provider, provenance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        evidenceId,
        'DERIVED_SOFTWARE_ANALYSIS',
        `Counterparty Connection: ${cpAddress}`,
        `Observed ${data.txCount} transaction interactions between ${wallet.address} and ${cpAddress} on ${wallet.resolved_network}.`,
        wallet.id,
        'analysis_engine',
        provenanceId,
        Date.now(),
      ]
    );

    const record: CounterpartyRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      counterparty_address: cpAddress,
      network: wallet.resolved_network,
      direction: dir,
      tx_count: data.txCount,
      first_interaction_timestamp: data.firstTime,
      last_interaction_timestamp: data.lastTime,
      assets_involved: Array.from(data.assets),
      total_received_from_raw: data.receivedRaw,
      total_received_from_display: formatBaseUnitToDisplay(data.receivedRaw, data.sampleDecimals),
      total_sent_to_raw: data.sentRaw,
      total_sent_to_display: formatBaseUnitToDisplay(data.sentRaw, data.sampleDecimals),
      is_known_site_wallet: isKnownSiteWallet,
      associated_websites: associatedWebsites,
      associated_investigations: associatedInvestigations,
      example_tx_hashes: data.exampleHashes,
      evidence_id: evidenceId,
    };

    runStatement(
      `INSERT OR REPLACE INTO counterparties (id, wallet_id, counterparty_address, network, direction, tx_count, first_interaction_timestamp, last_interaction_timestamp, assets_json, total_received_from_raw, total_received_from_display, total_sent_to_raw, total_sent_to_display, is_known_site_wallet, associated_websites_json, associated_investigations_json, example_tx_hashes_json, evidence_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        record.id,
        record.wallet_id,
        record.counterparty_address,
        record.network,
        record.direction,
        record.tx_count,
        record.first_interaction_timestamp,
        record.last_interaction_timestamp,
        JSON.stringify(record.assets_involved),
        record.total_received_from_raw,
        record.total_received_from_display,
        record.total_sent_to_raw,
        record.total_sent_to_display,
        record.is_known_site_wallet ? 1 : 0,
        JSON.stringify(record.associated_websites),
        JSON.stringify(record.associated_investigations),
        JSON.stringify(record.example_tx_hashes),
        record.evidence_id,
      ]
    );

    counterparties.push(record);
  }

  // 2. Fund-Flow Pattern Discovery
  const patterns: FundFlowPattern[] = [];

  // Pattern A: Rapid Receive -> Send (Pass-through within 15 minutes / 900 seconds)
  for (let i = 0; i < transactions.length - 1; i++) {
    const txA = transactions[i];
    const txB = transactions[i + 1];

    if (
      txA.direction === 'incoming' &&
      txB.direction === 'outgoing' &&
      txB.timestamp >= txA.timestamp &&
      txB.timestamp - txA.timestamp <= 15 * 60 * 1000
    ) {
      const diffMinutes = Math.round((txB.timestamp - txA.timestamp) / 60000);
      const evidenceId = crypto.randomUUID();
      const pattern: FundFlowPattern = {
        id: crypto.randomUUID(),
        wallet_id: wallet.id,
        pattern_type: 'rapid_passthrough',
        title: 'Rapid Inbound-to-Outbound Transfer',
        description: `Wallet received funds in tx ${txA.tx_hash.slice(0, 10)}... and transferred onward ${diffMinutes} minutes later in tx ${txB.tx_hash.slice(0, 10)}...`,
        supporting_addresses: [txA.from_address, txB.to_address],
        supporting_tx_hashes: [txA.tx_hash, txB.tx_hash],
        metric_summary: `Delta: ${diffMinutes} min`,
        detected_at: Date.now(),
        evidence_id: evidenceId,
      };

      runStatement(
        `INSERT OR REPLACE INTO fund_flow_patterns (id, wallet_id, pattern_type, title, description, supporting_addresses_json, supporting_tx_hashes_json, metric_summary, detected_at, evidence_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          pattern.id,
          pattern.wallet_id,
          pattern.pattern_type,
          pattern.title,
          pattern.description,
          JSON.stringify(pattern.supporting_addresses),
          JSON.stringify(pattern.supporting_tx_hashes),
          pattern.metric_summary || null,
          pattern.detected_at,
          pattern.evidence_id,
        ]
      );
      patterns.push(pattern);
    }
  }

  // Pattern B: Repeated Counterparties (>1 transaction)
  for (const cp of counterparties) {
    if (cp.tx_count >= 2) {
      const evidenceId = crypto.randomUUID();
      const pattern: FundFlowPattern = {
        id: crypto.randomUUID(),
        wallet_id: wallet.id,
        pattern_type: 'repeated_counterparty',
        title: 'Repeated Counterparty Interaction',
        description: `Address ${cp.counterparty_address} interacted ${cp.tx_count} times with this wallet across assets [${cp.assets_involved.join(', ')}].`,
        supporting_addresses: [cp.counterparty_address],
        supporting_tx_hashes: cp.example_tx_hashes,
        metric_summary: `${cp.tx_count} transactions`,
        detected_at: Date.now(),
        evidence_id: evidenceId,
      };

      runStatement(
        `INSERT OR REPLACE INTO fund_flow_patterns (id, wallet_id, pattern_type, title, description, supporting_addresses_json, supporting_tx_hashes_json, metric_summary, detected_at, evidence_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          pattern.id,
          pattern.wallet_id,
          pattern.pattern_type,
          pattern.title,
          pattern.description,
          JSON.stringify(pattern.supporting_addresses),
          JSON.stringify(pattern.supporting_tx_hashes),
          pattern.metric_summary || null,
          pattern.detected_at,
          pattern.evidence_id,
        ]
      );
      patterns.push(pattern);
    }
  }

  // Pattern C: Multi-Website Reuse
  const siteObservations = queryAll<{ website_domain: string }>(
    `SELECT DISTINCT website_domain FROM wallet_observations WHERE wallet_id = ? AND website_domain IS NOT NULL;`,
    [wallet.id]
  );
  if (siteObservations.length > 1) {
    const domains = siteObservations.map((s) => s.website_domain);
    const evidenceId = crypto.randomUUID();
    const pattern: FundFlowPattern = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      pattern_type: 'multi_website_reuse',
      title: 'Observed Across Multiple Websites',
      description: `Wallet address was documented across ${domains.length} distinct domains: ${domains.join(', ')}.`,
      supporting_addresses: [wallet.address],
      supporting_tx_hashes: [],
      metric_summary: `${domains.length} distinct domains`,
      detected_at: Date.now(),
      evidence_id: evidenceId,
    };

    runStatement(
      `INSERT OR REPLACE INTO fund_flow_patterns (id, wallet_id, pattern_type, title, description, supporting_addresses_json, supporting_tx_hashes_json, metric_summary, detected_at, evidence_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        pattern.id,
        pattern.wallet_id,
        pattern.pattern_type,
        pattern.title,
        pattern.description,
        JSON.stringify(pattern.supporting_addresses),
        JSON.stringify(pattern.supporting_tx_hashes),
        pattern.metric_summary || null,
        pattern.detected_at,
        pattern.evidence_id,
      ]
    );
    patterns.push(pattern);
  }

  // Update wallet aggregates in database
  let totalInCount = 0;
  let totalOutCount = 0;
  let totalReceivedRaw = '0';
  let totalSentRaw = '0';

  for (const tx of transactions) {
    if (tx.direction === 'incoming') {
      totalInCount++;
      totalReceivedRaw = addRawAmounts(totalReceivedRaw, tx.raw_amount);
    } else if (tx.direction === 'outgoing') {
      totalOutCount++;
      totalSentRaw = addRawAmounts(totalSentRaw, tx.raw_amount);
    }
  }

  const sampleDecimals = transactions[0]?.token_decimals || 18;
  runStatement(
    `UPDATE wallets
     SET total_incoming_tx_count = ?,
         total_outgoing_tx_count = ?,
         total_tx_count = ?,
         total_received_raw = ?,
         total_received_display = ?,
         total_sent_raw = ?,
         total_sent_display = ?,
         unique_counterparty_count = ?,
         updated_at = ?
     WHERE id = ?;`,
    [
      totalInCount,
      totalOutCount,
      transactions.length,
      totalReceivedRaw,
      formatBaseUnitToDisplay(totalReceivedRaw, sampleDecimals),
      totalSentRaw,
      formatBaseUnitToDisplay(totalSentRaw, sampleDecimals),
      counterparties.length,
      Date.now(),
      wallet.id,
    ]
  );

  return { counterparties, patterns };
}
