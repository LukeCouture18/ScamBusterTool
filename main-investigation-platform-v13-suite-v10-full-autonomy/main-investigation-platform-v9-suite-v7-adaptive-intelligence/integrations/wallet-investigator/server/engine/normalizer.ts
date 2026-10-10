/**
 * Canonical Transaction Normalizer & Evidence Linker
 * Converts provider outputs into unified canonical records,
 * preserves UTXO topologies, safely computes display amounts,
 * and mints immutable evidence records.
 */

import crypto from 'crypto';
import { BlockchainNetwork, CanonicalTransaction, CompletenessDetails, DataCompleteness, EvidenceRecord, ProvenanceRecord, UtxoInputOutput, WalletEntity } from '../../src/types';
import { ASSET_DECIMALS, formatBaseUnitToDisplay } from '../crypto/precision';
import { runStatement } from '../db/database';
import { RawProviderTx } from '../providers/types';

export function normalizeTransactions(
  wallet: WalletEntity,
  rawTxs: RawProviderTx[],
  providerName: string,
  completeness: DataCompleteness,
  investigationId?: string,
  correlationId?: string
): { transactions: CanonicalTransaction[]; evidenceRecords: EvidenceRecord[] } {
  const normalizedList: CanonicalTransaction[] = [];
  const evidenceRecords: EvidenceRecord[] = [];

  for (const raw of rawTxs) {
    const txId = crypto.randomUUID();
    const evidenceId = crypto.randomUUID();
    const provenanceId = crypto.randomUUID();

    const decimals = raw.token_decimals ?? (ASSET_DECIMALS[raw.asset.toUpperCase()] ?? 18);
    const displayAmount = formatBaseUnitToDisplay(raw.raw_amount, decimals);
    const feeDisplay = raw.fee_raw ? formatBaseUnitToDisplay(raw.fee_raw, ASSET_DECIMALS[wallet.resolved_network === 'bitcoin' ? 'BTC' : 'ETH'] ?? 18) : undefined;

    // Determine direction relative to target wallet
    const isFromTarget = raw.from_address.toLowerCase() === wallet.address.toLowerCase();
    const isToTarget = raw.to_address.toLowerCase() === wallet.address.toLowerCase();

    let direction: CanonicalTransaction['direction'] = 'incoming';
    let counterpartyAddress = raw.from_address;

    if (isFromTarget && isToTarget) {
      direction = 'self';
      counterpartyAddress = wallet.address;
    } else if (isFromTarget) {
      direction = 'outgoing';
      counterpartyAddress = raw.to_address;
    } else if (isToTarget) {
      direction = 'incoming';
      counterpartyAddress = raw.from_address;
    } else {
      // For UTXO or complex multisig
      direction = 'internal';
      counterpartyAddress = raw.from_address;
    }

    // UTXO input/output normalization
    let utxoInputs: UtxoInputOutput[] | undefined;
    let utxoOutputs: UtxoInputOutput[] | undefined;

    if (raw.utxo_inputs && raw.utxo_inputs.length > 0) {
      utxoInputs = raw.utxo_inputs.map((inp) => ({
        index: inp.index,
        address: inp.address,
        raw_amount: inp.raw_amount,
        display_amount: formatBaseUnitToDisplay(inp.raw_amount, decimals),
        is_target_wallet: inp.address.toLowerCase() === wallet.address.toLowerCase(),
      }));
    }

    if (raw.utxo_outputs && raw.utxo_outputs.length > 0) {
      utxoOutputs = raw.utxo_outputs.map((out) => ({
        index: out.index,
        address: out.address,
        raw_amount: out.raw_amount,
        display_amount: formatBaseUnitToDisplay(out.raw_amount, decimals),
        is_change: out.is_change,
        is_target_wallet: out.address.toLowerCase() === wallet.address.toLowerCase(),
      }));
    }

    // Provenance Record
    const provenance: ProvenanceRecord = {
      id: provenanceId,
      source_module: 'blockchain_provider',
      source_record_id: raw.tx_hash,
      provider: providerName,
      retrieval_timestamp: Date.now(),
      investigation_id: investigationId,
      correlation_id: correlationId,
      analysis_version: '1.0.0',
      method: 'direct_blockchain_retrieval',
      completeness,
      confidence: 1.0,
    };

    // Evidence Record
    const evidence: EvidenceRecord = {
      id: evidenceId,
      category: 'OBSERVED_BLOCKCHAIN_EVIDENCE',
      title: `On-chain transfer ${raw.asset} (${displayAmount})`,
      description: `Observed transaction ${raw.tx_hash} on ${wallet.resolved_network} involving ${wallet.address}.`,
      wallet_id: wallet.id,
      tx_hash: raw.tx_hash,
      source_provider: providerName,
      investigation_id: investigationId,
      correlation_id: correlationId,
      raw_payload: JSON.stringify(raw),
      provenance_id: provenanceId,
      created_at: Date.now(),
    };

    // Save provenance & evidence to database
    runStatement(
      `INSERT OR REPLACE INTO provenance_records (id, source_module, source_record_id, provider, retrieval_timestamp, investigation_id, correlation_id, analysis_version, method, completeness, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        provenance.id,
        provenance.source_module,
        provenance.source_record_id || null,
        provenance.provider,
        provenance.retrieval_timestamp,
        provenance.investigation_id || null,
        provenance.correlation_id || null,
        provenance.analysis_version,
        provenance.method,
        provenance.completeness,
        provenance.confidence,
      ]
    );

    runStatement(
      `INSERT OR REPLACE INTO evidence_records (id, category, title, description, wallet_id, tx_hash, source_provider, investigation_id, correlation_id, raw_payload, provenance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        evidence.id,
        evidence.category,
        evidence.title,
        evidence.description,
        evidence.wallet_id || null,
        evidence.tx_hash || null,
        evidence.source_provider || null,
        evidence.investigation_id || null,
        evidence.correlation_id || null,
        evidence.raw_payload || null,
        evidence.provenance_id,
        evidence.created_at,
      ]
    );

    const canonicalTx: CanonicalTransaction = {
      id: txId,
      tx_hash: raw.tx_hash,
      network: wallet.resolved_network,
      wallet_id: wallet.id,
      wallet_address: wallet.address,
      block_number: raw.block_number,
      timestamp: raw.timestamp,
      from_address: raw.from_address,
      to_address: raw.to_address,
      counterparty_address: counterpartyAddress,
      direction,
      asset: raw.asset,
      is_token: raw.is_token,
      token_contract: raw.token_contract,
      token_decimals: decimals,
      raw_amount: raw.raw_amount,
      display_amount: displayAmount,
      fee_raw: raw.fee_raw,
      fee_display: feeDisplay,
      status: raw.status,
      provider: providerName,
      completeness,
      evidence_id: evidenceId,
      utxo_inputs: utxoInputs,
      utxo_outputs: utxoOutputs,
      raw_metadata: raw.raw_metadata,
    };

    // Store transaction into SQLite
    runStatement(
      `INSERT OR REPLACE INTO transactions (id, tx_hash, network, wallet_id, wallet_address, block_number, timestamp, from_address, to_address, counterparty_address, direction, asset, is_token, token_contract, token_decimals, raw_amount, display_amount, fee_raw, fee_display, status, provider, completeness, evidence_id, raw_metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        canonicalTx.id,
        canonicalTx.tx_hash,
        canonicalTx.network,
        canonicalTx.wallet_id,
        canonicalTx.wallet_address,
        canonicalTx.block_number || null,
        canonicalTx.timestamp,
        canonicalTx.from_address,
        canonicalTx.to_address,
        canonicalTx.counterparty_address,
        canonicalTx.direction,
        canonicalTx.asset,
        canonicalTx.is_token ? 1 : 0,
        canonicalTx.token_contract || null,
        canonicalTx.token_decimals || null,
        canonicalTx.raw_amount,
        canonicalTx.display_amount,
        canonicalTx.fee_raw || null,
        canonicalTx.fee_display || null,
        canonicalTx.status,
        canonicalTx.provider,
        canonicalTx.completeness,
        canonicalTx.evidence_id,
        canonicalTx.raw_metadata ? JSON.stringify(canonicalTx.raw_metadata) : null,
      ]
    );

    // Save UTXO entries if present
    if (utxoInputs) {
      for (const inp of utxoInputs) {
        runStatement(
          `INSERT INTO utxo_entries (id, tx_id, tx_hash, entry_type, entry_index, address, raw_amount, display_amount, is_change, is_target_wallet)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            crypto.randomUUID(),
            canonicalTx.id,
            canonicalTx.tx_hash,
            'input',
            inp.index,
            inp.address,
            inp.raw_amount,
            inp.display_amount,
            0,
            inp.is_target_wallet ? 1 : 0,
          ]
        );
      }
    }

    if (utxoOutputs) {
      for (const out of utxoOutputs) {
        runStatement(
          `INSERT INTO utxo_entries (id, tx_id, tx_hash, entry_type, entry_index, address, raw_amount, display_amount, is_change, is_target_wallet)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            crypto.randomUUID(),
            canonicalTx.id,
            canonicalTx.tx_hash,
            'output',
            out.index,
            out.address,
            out.raw_amount,
            out.display_amount,
            out.is_change ? 1 : 0,
            out.is_target_wallet ? 1 : 0,
          ]
        );
      }
    }

    normalizedList.push(canonicalTx);
    evidenceRecords.push(evidence);
  }

  return { transactions: normalizedList, evidenceRecords };
}
