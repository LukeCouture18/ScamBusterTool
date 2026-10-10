/**
 * Factual Findings Generation Engine
 * Generates evidence-linked, non-pejorative findings based strictly on observed data.
 */

import crypto from 'crypto';
import { FindingRecord, WalletEntity } from '../../src/types';
import { queryAll, runStatement } from '../db/database';

export function generateWalletFindings(wallet: WalletEntity): FindingRecord[] {
  const findings: FindingRecord[] = [];

  // 1. Cross-website reuse findings
  const websiteRows = queryAll<{ website_domain: string }>(
    `SELECT DISTINCT website_domain FROM wallet_observations WHERE wallet_id = ? AND website_domain IS NOT NULL;`,
    [wallet.id]
  );
  if (websiteRows.length > 1) {
    const domains = websiteRows.map((w) => w.website_domain);
    const finding: FindingRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      finding_type: 'cross_website_reuse',
      summary: `Wallet observed on ${domains.length} investigated websites`,
      explanation: `The wallet address was documented as a payment/deposit destination across multiple distinct domains: ${domains.join(', ')}.`,
      supporting_evidence_ids: [],
      supporting_tx_hashes: [],
      confidence: 1.0,
      completeness: 'COMPLETE',
      created_at: Date.now(),
      analysis_version: '1.0.0',
    };
    saveFinding(finding);
    findings.push(finding);
  }

  // 2. Rapid pass-through fund flow
  const rapidPatterns = queryAll<{ description: string; supporting_tx_hashes_json: string; evidence_id: string }>(
    `SELECT description, supporting_tx_hashes_json, evidence_id FROM fund_flow_patterns WHERE wallet_id = ? AND pattern_type = 'rapid_passthrough';`,
    [wallet.id]
  );
  for (const rp of rapidPatterns) {
    const txHashes = JSON.parse(rp.supporting_tx_hashes_json || '[]') as string[];
    const finding: FindingRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      finding_type: 'rapid_passthrough_detected',
      summary: 'Rapid inbound-to-outbound fund transfer observed',
      explanation: rp.description,
      supporting_evidence_ids: [rp.evidence_id],
      supporting_tx_hashes: txHashes,
      confidence: 0.95,
      completeness: 'COMPLETE',
      created_at: Date.now(),
      analysis_version: '1.0.0',
    };
    saveFinding(finding);
    findings.push(finding);
  }

  // 3. Shared counterparty across investigations
  const sharedCounterparties = queryAll<{ counterparty_address: string; associated_investigations_json: string; evidence_id: string }>(
    `SELECT counterparty_address, associated_investigations_json, evidence_id FROM counterparties
     WHERE wallet_id = ? AND json_array_length(associated_investigations_json) > 1;`,
    [wallet.id]
  );
  for (const sc of sharedCounterparties) {
    const invs = JSON.parse(sc.associated_investigations_json || '[]') as string[];
    const finding: FindingRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      finding_type: 'shared_counterparty_detected',
      summary: `Counterparty ${sc.counterparty_address.slice(0, 8)}... shared across ${invs.length} investigations`,
      explanation: `Blockchain counterparty ${sc.counterparty_address} also appears in records belonging to ${invs.length} other investigations: [${invs.join(', ')}].`,
      supporting_evidence_ids: [sc.evidence_id],
      supporting_tx_hashes: [],
      confidence: 0.9,
      completeness: 'COMPLETE',
      created_at: Date.now(),
      analysis_version: '1.0.0',
    };
    saveFinding(finding);
    findings.push(finding);
  }

  // 4. Data completeness limitations
  if (wallet.completeness === 'PARTIAL' || wallet.completeness === 'LIMITED') {
    const finding: FindingRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      finding_type: 'partial_data_warning',
      summary: 'Blockchain transaction history is partial or limited',
      explanation: wallet.completeness_details?.warning_message || 'The data retrieved from the blockchain provider did not complete all pagination pages. Historical totals and transaction counts are incomplete.',
      supporting_evidence_ids: [],
      supporting_tx_hashes: [],
      confidence: 1.0,
      completeness: wallet.completeness,
      created_at: Date.now(),
      analysis_version: '1.0.0',
    };
    saveFinding(finding);
    findings.push(finding);
  }

  // 5. Ambiguity / Network Conflict
  if (wallet.network_ambiguity) {
    const finding: FindingRecord = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      finding_type: 'network_ambiguity',
      summary: 'EVM Address network is currently unresolved',
      explanation: 'Hexadecimal 0x address format matches all EVM chains (Ethereum, BSC, Polygon, Arbitrum, Base). Specific network has not yet been confirmed by on-chain activity or explicit investigation context.',
      supporting_evidence_ids: [],
      supporting_tx_hashes: [],
      confidence: 0.8,
      completeness: 'COMPLETE',
      created_at: Date.now(),
      analysis_version: '1.0.0',
    };
    saveFinding(finding);
    findings.push(finding);
  }

  return findings;
}

function saveFinding(f: FindingRecord): void {
  runStatement(
    `INSERT OR REPLACE INTO findings (id, wallet_id, finding_type, summary, explanation, supporting_evidence_ids_json, supporting_tx_hashes_json, confidence, completeness, created_at, analysis_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      f.id,
      f.wallet_id,
      f.finding_type,
      f.summary,
      f.explanation,
      JSON.stringify(f.supporting_evidence_ids),
      JSON.stringify(f.supporting_tx_hashes),
      f.confidence,
      f.completeness,
      f.created_at,
      f.analysis_version,
    ]
  );
}
