/**
 * REST API Routes for Wallet Investigator v1.0
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { validateAddress } from '../crypto/validation';
import { queryAll, queryFirst, runStatement } from '../db/database';
import { globalJobQueue } from '../jobs/job_queue';
import { findPathBetweenWallets } from '../engine/path_finder';
import { promoteConnectedWalletToInvestigation, updateReviewStatus } from '../engine/review_queue';
import { globalMainPlatform } from '../integration/main_platform_v6';
import { globalProviderManager } from '../providers/manager';
import { AnalysisProfileType, BlockchainNetwork, DataCompleteness, ReviewStatus } from '../../src/types';

const router = express.Router();

// 1. Dashboard Overview Stats
router.get('/stats/dashboard', (req: Request, res: Response) => {
  const walletsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM wallets;`)?.cnt || 0;
  const activeJobsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM analysis_jobs WHERE status IN ('QUEUED', 'RUNNING');`)?.cnt || 0;
  const pendingReviewsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM review_queue WHERE status = 'PENDING';`)?.cnt || 0;
  const partialWalletsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM wallets WHERE completeness IN ('PARTIAL', 'LIMITED');`)?.cnt || 0;
  const totalFindingsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM findings;`)?.cnt || 0;
  const investigationsCount = queryFirst<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM investigations;`)?.cnt || 0;

  const recentActivity = queryAll<Record<string, unknown>>(
    `SELECT 'job' as type, current_step as title, status as badge, created_at as timestamp FROM analysis_jobs
     UNION ALL
     SELECT 'review' as type, title, status as badge, created_at as timestamp FROM review_queue
     ORDER BY timestamp DESC LIMIT 8;`
  );

  res.json({
    wallets_under_investigation: walletsCount,
    active_analyses: activeJobsCount,
    needs_review: pendingReviewsCount,
    partial_analyses: partialWalletsCount,
    total_findings: totalFindingsCount,
    investigations_count: investigationsCount,
    main_platform: globalMainPlatform.getStatus(),
    recent_activity: recentActivity,
  });
});

// 2. Validate Address
router.post('/wallets/validate', (req: Request, res: Response) => {
  const { address, reported_network } = req.body;
  if (!address) {
    return res.status(400).json({ error: 'Address is required.' });
  }
  const result = validateAddress(address, reported_network);
  res.json(result);
});

// 3. List Wallets
router.get('/wallets', (req: Request, res: Response) => {
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';
  const network = req.query.network ? String(req.query.network) : '';
  const completeness = req.query.completeness ? String(req.query.completeness) : '';
  const bookmarkedOnly = req.query.bookmarked === 'true';

  let sql = `SELECT * FROM wallets WHERE 1=1 `;
  const params: NonNullable<Parameters<typeof queryAll>[1]> = [];

  if (search) {
    sql += ` AND (LOWER(address) LIKE ? OR LOWER(notes) LIKE ? OR LOWER(tags_json) LIKE ?) `;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (network) {
    sql += ` AND resolved_network = ? `;
    params.push(network);
  }
  if (completeness) {
    sql += ` AND completeness = ? `;
    params.push(completeness);
  }
  if (bookmarkedOnly) {
    sql += ` AND is_bookmarked = 1 `;
  }

  sql += ` ORDER BY updated_at DESC LIMIT 100;`;
  const rows = queryAll<Record<string, unknown>>(sql, params);

  const parsed = rows.map((r) => ({
    ...r,
    network_ambiguity: Boolean(r.network_ambiguity),
    is_bookmarked: Boolean(r.is_bookmarked),
    tags: JSON.parse(String(r.tags_json || '[]')),
    completeness_details: r.completeness_details_json ? JSON.parse(String(r.completeness_details_json)) : undefined,
  }));

  res.json({ wallets: parsed, total: parsed.length });
});

// 4. Ingest Wallet (Manual, Bulk, CSV/JSON, Site Investigator, CryptoWalletLogger)
router.post('/wallets', (req: Request, res: Response) => {
  const {
    address,
    reported_network,
    claimed_asset,
    source_module = 'manual_entry',
    website_domain,
    source_url,
    deposit_option_context,
    investigation_id,
    notes,
    tags = [],
    auto_analyze = true,
    profile = 'STANDARD',
  } = req.body;

  if (!address) {
    return res.status(400).json({ error: 'Address is required.' });
  }

  const validation = validateAddress(address, reported_network);
  if (!validation.is_valid && validation.validation_status === 'invalid_format') {
    return res.status(400).json({
      error: 'Invalid cryptocurrency address format.',
      validation,
    });
  }

  // Check if wallet already exists
  const wallet = queryFirst<Record<string, unknown>>(
    `SELECT * FROM wallets WHERE normalized_address = ?;`,
    [validation.normalized_address]
  );

  const walletId = wallet ? String(wallet.id) : crypto.randomUUID();

  if (!wallet) {
    runStatement(
      `INSERT INTO wallets (id, address, normalized_address, address_format, reported_network, observed_network, resolved_network, network_ambiguity, network_conflict_notes, validation_status, total_incoming_tx_count, total_outgoing_tx_count, total_tx_count, balance_raw, balance_display, balance_asset, total_received_raw, total_received_display, total_sent_raw, total_sent_display, completeness, unique_counterparty_count, observation_count, investigation_count, is_bookmarked, notes, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        walletId,
        address.trim(),
        validation.normalized_address,
        validation.address_format,
        reported_network || null,
        validation.detected_network,
        validation.resolved_network,
        validation.network_ambiguity ? 1 : 0,
        validation.conflict_notes || null,
        validation.validation_status,
        0, 0, 0, '0', '0', '', '0', '0', '0', '0', 'UNKNOWN',
        0, 1, investigation_id ? 1 : 0, 0,
        notes || null,
        JSON.stringify(tags),
        Date.now(),
        Date.now(),
      ]
    );
  } else {
    // Increment observation count
    runStatement(
      `UPDATE wallets SET observation_count = observation_count + 1, updated_at = ? WHERE id = ?;`,
      [Date.now(), walletId]
    );
  }

  // Record Observation
  const obsId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();
  const provenanceId = crypto.randomUUID();

  // Create Provenance
  runStatement(
    `INSERT INTO provenance_records (id, source_module, provider, retrieval_timestamp, investigation_id, analysis_version, method, completeness, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      provenanceId,
      source_module,
      'user_or_ingestion_feed',
      Date.now(),
      investigation_id || null,
      '1.0.0',
      'intake_observation',
      'COMPLETE',
      1.0,
    ]
  );

  // Create Evidence Record
  runStatement(
    `INSERT INTO evidence_records (id, category, title, description, wallet_id, source_provider, investigation_id, provenance_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      evidenceId,
      'OBSERVED_WEBSITE_EVIDENCE',
      `Observation from ${website_domain || source_module}`,
      `Address observed on ${website_domain || 'investigation source'}. Deposit context: ${deposit_option_context || 'N/A'}. Source URL: ${source_url || 'N/A'}`,
      walletId,
      source_module,
      investigation_id || null,
      provenanceId,
      Date.now(),
    ]
  );

  // Store observation
  runStatement(
    `INSERT INTO wallet_observations (id, wallet_id, address, claimed_network, claimed_asset, source_module, investigation_id, website_domain, source_url, deposit_option_context, evidence_id, timestamp, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      obsId,
      walletId,
      address.trim(),
      reported_network || null,
      claimed_asset || null,
      source_module,
      investigation_id || null,
      website_domain || null,
      source_url || null,
      deposit_option_context || null,
      evidenceId,
      Date.now(),
      notes || null,
    ]
  );

  let job: ReturnType<typeof globalJobQueue.enqueueJob> | null = null;
  if (auto_analyze) {
    job = globalJobQueue.enqueueJob(
      walletId,
      address.trim(),
      validation.resolved_network,
      profile as AnalysisProfileType,
      investigation_id
    );
  }

  res.status(201).json({
    wallet_id: walletId,
    observation_id: obsId,
    validation,
    analysis_job: job,
    message: 'Wallet ingested successfully and linked to observation.',
  });
});

// 5. Bulk Ingest
router.post('/wallets/bulk', (req: Request, res: Response) => {
  const { entries = [] } = req.body;
  const results = [];
  for (const entry of entries) {
    if (!entry.address) continue;
    const validation = validateAddress(entry.address, entry.reported_network);
    const walletId = crypto.randomUUID();
    runStatement(
      `INSERT OR IGNORE INTO wallets (id, address, normalized_address, address_format, reported_network, observed_network, resolved_network, network_ambiguity, validation_status, total_incoming_tx_count, total_outgoing_tx_count, total_tx_count, balance_raw, balance_display, balance_asset, total_received_raw, total_received_display, total_sent_raw, total_sent_display, completeness, unique_counterparty_count, observation_count, investigation_count, is_bookmarked, notes, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        walletId,
        entry.address.trim(),
        validation.normalized_address,
        validation.address_format,
        entry.reported_network || null,
        validation.detected_network,
        validation.resolved_network,
        validation.network_ambiguity ? 1 : 0,
        validation.validation_status,
        0, 0, 0, '0', '0', '', '0', '0', '0', '0', 'UNKNOWN',
        0, 1, entry.investigation_id ? 1 : 0, 0,
        entry.notes || null,
        JSON.stringify(entry.tags || []),
        Date.now(),
        Date.now(),
      ]
    );

    // Enqueue standard analysis
    globalJobQueue.enqueueJob(
      walletId,
      entry.address.trim(),
      validation.resolved_network,
      'STANDARD',
      entry.investigation_id
    );

    results.push({ address: entry.address, wallet_id: walletId, validation });
  }
  res.json({ ingested_count: results.length, items: results });
});

// 6. Get Wallet Profile & Associated Details
router.get('/wallets/:id', (req: Request, res: Response) => {
  const wallet = queryFirst<Record<string, unknown>>(
    `SELECT * FROM wallets WHERE id = ? OR address = ? OR normalized_address = ?;`,
    [req.params.id, req.params.id, req.params.id.toLowerCase()]
  );

  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found.' });
  }

  const walletId = String(wallet.id);
  const observations = queryAll<Record<string, unknown>>(
    `SELECT * FROM wallet_observations WHERE wallet_id = ? ORDER BY timestamp DESC;`,
    [walletId]
  );
  const counterparties = queryAll<Record<string, unknown>>(
    `SELECT * FROM counterparties WHERE wallet_id = ? ORDER BY tx_count DESC;`,
    [walletId]
  );
  const connectedWallets = queryAll<Record<string, unknown>>(
    `SELECT * FROM connected_wallets WHERE source_wallet_id = ? ORDER BY relevance_score DESC;`,
    [walletId]
  );
  const fundFlows = queryAll<Record<string, unknown>>(
    `SELECT * FROM fund_flow_patterns WHERE wallet_id = ? ORDER BY detected_at DESC;`,
    [walletId]
  );
  const findings = queryAll<Record<string, unknown>>(
    `SELECT * FROM findings WHERE wallet_id = ? ORDER BY created_at DESC;`,
    [walletId]
  );
  const evidence = queryAll<Record<string, unknown>>(
    `SELECT * FROM evidence_records WHERE wallet_id = ? ORDER BY created_at DESC;`,
    [walletId]
  );
  const activeJob = queryFirst<Record<string, unknown>>(
    `SELECT * FROM analysis_jobs WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 1;`,
    [walletId]
  );

  res.json({
    wallet: {
      ...wallet,
      network_ambiguity: Boolean(wallet.network_ambiguity),
      is_bookmarked: Boolean(wallet.is_bookmarked),
      tags: JSON.parse(String(wallet.tags_json || '[]')),
      completeness_details: wallet.completeness_details_json ? JSON.parse(String(wallet.completeness_details_json)) : undefined,
    },
    observations,
    counterparties: counterparties.map((c) => ({
      ...c,
      assets_involved: JSON.parse(String(c.assets_json || '[]')),
      associated_websites: JSON.parse(String(c.associated_websites_json || '[]')),
      associated_investigations: JSON.parse(String(c.associated_investigations_json || '[]')),
      example_tx_hashes: JSON.parse(String(c.example_tx_hashes_json || '[]')),
      is_known_site_wallet: Boolean(c.is_known_site_wallet),
    })),
    connected_wallets: connectedWallets.map((cw) => ({
      ...cw,
      reasons: JSON.parse(String(cw.reasons_json || '[]')),
      supporting_tx_hashes: JSON.parse(String(cw.supporting_tx_hashes_json || '[]')),
      supporting_investigations: JSON.parse(String(cw.supporting_investigations_json || '[]')),
      supporting_websites: JSON.parse(String(cw.supporting_websites_json || '[]')),
      is_promoted: Boolean(cw.is_promoted),
    })),
    fund_flows: fundFlows.map((f) => ({
      ...f,
      supporting_addresses: JSON.parse(String(f.supporting_addresses_json || '[]')),
      supporting_tx_hashes: JSON.parse(String(f.supporting_tx_hashes_json || '[]')),
    })),
    findings: findings.map((fn) => ({
      ...fn,
      supporting_evidence_ids: JSON.parse(String(fn.supporting_evidence_ids_json || '[]')),
      supporting_tx_hashes: JSON.parse(String(fn.supporting_tx_hashes_json || '[]')),
    })),
    evidence,
    active_job: activeJob,
  });
});

// 7. Trigger Analysis
router.post('/wallets/:id/analyze', (req: Request, res: Response) => {
  const { profile = 'STANDARD' } = req.body;
  const wallet = queryFirst<Record<string, unknown>>(`SELECT * FROM wallets WHERE id = ?;`, [req.params.id]);
  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found.' });
  }

  const job = globalJobQueue.enqueueJob(
    String(wallet.id),
    String(wallet.address),
    wallet.resolved_network as BlockchainNetwork,
    profile as AnalysisProfileType
  );

  res.json({ job, message: `Analysis job queued with ${profile} profile.` });
});

// 8. Toggle Bookmark
router.post('/wallets/:id/bookmark', (req: Request, res: Response) => {
  const wallet = queryFirst<{ is_bookmarked: number }>(`SELECT is_bookmarked FROM wallets WHERE id = ?;`, [req.params.id]);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });

  const newVal = wallet.is_bookmarked ? 0 : 1;
  runStatement(`UPDATE wallets SET is_bookmarked = ?, updated_at = ? WHERE id = ?;`, [newVal, Date.now(), req.params.id]);
  res.json({ is_bookmarked: Boolean(newVal) });
});

// 9. Update Notes & Tags
router.patch('/wallets/:id/notes', (req: Request, res: Response) => {
  const { notes, tags } = req.body;
  runStatement(
    `UPDATE wallets SET notes = ?, tags_json = ?, updated_at = ? WHERE id = ?;`,
    [notes || null, JSON.stringify(tags || []), Date.now(), req.params.id]
  );
  res.json({ success: true });
});

// 10. Transaction Explorer
router.get('/transactions', (req: Request, res: Response) => {
  const {
    wallet_id,
    search,
    direction,
    asset,
    network,
    page = '1',
    limit = '25',
  } = req.query;

  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  let sql = `SELECT * FROM transactions WHERE 1=1 `;
  let countSql = `SELECT COUNT(*) as total FROM transactions WHERE 1=1 `;
  const params: NonNullable<Parameters<typeof queryAll>[1]> = [];

  if (wallet_id) {
    sql += ` AND wallet_id = ? `;
    countSql += ` AND wallet_id = ? `;
    params.push(String(wallet_id));
  }
  if (direction) {
    sql += ` AND direction = ? `;
    countSql += ` AND direction = ? `;
    params.push(String(direction));
  }
  if (asset) {
    sql += ` AND asset = ? `;
    countSql += ` AND asset = ? `;
    params.push(String(asset));
  }
  if (network) {
    sql += ` AND network = ? `;
    countSql += ` AND network = ? `;
    params.push(String(network));
  }
  if (search) {
    const s = `%${String(search).trim().toLowerCase()}%`;
    sql += ` AND (LOWER(tx_hash) LIKE ? OR LOWER(counterparty_address) LIKE ? OR LOWER(from_address) LIKE ? OR LOWER(to_address) LIKE ?) `;
    countSql += ` AND (LOWER(tx_hash) LIKE ? OR LOWER(counterparty_address) LIKE ? OR LOWER(from_address) LIKE ? OR LOWER(to_address) LIKE ?) `;
    params.push(s, s, s, s);
  }

  const total = queryFirst<{ total: number }>(countSql, params)?.total || 0;

  sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?;`;
  const rows = queryAll<Record<string, unknown>>(sql, [...params, limitNum, offset]);

  // Include UTXO entries if available
  const parsed = rows.map((r) => {
    const rId = String(r.id);
    const utxoInputs = queryAll<Record<string, unknown>>(
      `SELECT * FROM utxo_entries WHERE tx_id = ? AND entry_type = 'input';`,
      [rId]
    );
    const utxoOutputs = queryAll<Record<string, unknown>>(
      `SELECT * FROM utxo_entries WHERE tx_id = ? AND entry_type = 'output';`,
      [rId]
    );

    return {
      ...r,
      is_token: Boolean(r.is_token),
      utxo_inputs: utxoInputs.map((i) => ({ ...i, is_change: Boolean(i.is_change), is_target_wallet: Boolean(i.is_target_wallet) })),
      utxo_outputs: utxoOutputs.map((o) => ({ ...o, is_change: Boolean(o.is_change), is_target_wallet: Boolean(o.is_target_wallet) })),
    };
  });

  res.json({
    transactions: parsed,
    total,
    page: pageNum,
    limit: limitNum,
    total_pages: Math.ceil(total / limitNum),
  });
});

// 11. Transaction Detail
router.get('/transactions/:id', (req: Request, res: Response) => {
  const tx = queryFirst<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE id = ? OR tx_hash = ?;`,
    [req.params.id, req.params.id]
  );
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });

  const txId = String(tx.id);
  const evidenceId = String(tx.evidence_id);

  const evidence = queryFirst<Record<string, unknown>>(
    `SELECT * FROM evidence_records WHERE id = ?;`,
    [evidenceId]
  );

  const utxoInputs = queryAll<Record<string, unknown>>(
    `SELECT * FROM utxo_entries WHERE tx_id = ? AND entry_type = 'input';`,
    [txId]
  );
  const utxoOutputs = queryAll<Record<string, unknown>>(
    `SELECT * FROM utxo_entries WHERE tx_id = ? AND entry_type = 'output';`,
    [txId]
  );

  res.json({
    transaction: {
      ...tx,
      is_token: Boolean(tx.is_token),
      utxo_inputs: utxoInputs,
      utxo_outputs: utxoOutputs,
    },
    evidence,
  });
});

// 12. Path Finder
router.post('/path-finder', async (req: Request, res: Response) => {
  const { source_address, target_address, max_hops = 2, allow_provider_expansion = false } = req.body;
  if (!source_address || !target_address) {
    return res.status(400).json({ error: 'source_address and target_address are required.' });
  }

  const result = await findPathBetweenWallets({
    source_address,
    target_address,
    max_hops: Number(max_hops),
    allow_provider_expansion: Boolean(allow_provider_expansion),
  });

  res.json(result);
});

// 13. Graph Data for Visualizer
router.get('/graph/:walletId', (req: Request, res: Response) => {
  const wallet = queryFirst<Record<string, unknown>>(
    `SELECT * FROM wallets WHERE id = ?;`,
    [req.params.walletId]
  );
  if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });

  const walletId = String(wallet.id);

  const counterparties = queryAll<Record<string, unknown>>(
    `SELECT * FROM counterparties WHERE wallet_id = ?;`,
    [walletId]
  );

  const txs = queryAll<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE wallet_id = ? LIMIT 50;`,
    [walletId]
  );

  const nodesMap = new Map<string, Record<string, unknown>>();

  // Source node
  nodesMap.set(String(wallet.address).toLowerCase(), {
    id: String(wallet.address),
    label: `${String(wallet.address).slice(0, 6)}...${String(wallet.address).slice(-4)}`,
    address: String(wallet.address),
    network: wallet.resolved_network,
    node_type: 'investigated',
    is_source: true,
    tx_count: Number(wallet.total_tx_count),
    completeness: wallet.completeness,
  });

  // Counterparty nodes
  for (const cp of counterparties) {
    const cpAddr = String(cp.counterparty_address);
    nodesMap.set(cpAddr.toLowerCase(), {
      id: cpAddr,
      label: `${cpAddr.slice(0, 6)}...${cpAddr.slice(-4)}`,
      address: cpAddr,
      network: cp.network,
      node_type: cp.is_known_site_wallet ? 'known_site_wallet' : 'counterparty',
      is_source: false,
      tx_count: Number(cp.tx_count),
      completeness: 'COMPLETE',
    });
  }

  // Edges
  const edges: Array<Record<string, unknown>> = [];
  for (const tx of txs) {
    edges.push({
      id: String(tx.id),
      source: String(tx.from_address),
      target: String(tx.to_address),
      asset: String(tx.asset),
      display_amount: String(tx.display_amount),
      tx_count: 1,
      latest_timestamp: Number(tx.timestamp),
      tx_hashes: [String(tx.tx_hash)],
      is_repeated: false,
      is_shared: false,
    });
  }

  res.json({
    nodes: Array.from(nodesMap.values()),
    edges,
  });
});

// 14. Timeline
router.get('/timeline/:walletId', (req: Request, res: Response) => {
  const walletId = req.params.walletId;
  const events: Array<Record<string, unknown>> = [];

  // Observations
  const obs = queryAll<Record<string, unknown>>(
    `SELECT * FROM wallet_observations WHERE wallet_id = ?;`,
    [walletId]
  );
  for (const o of obs) {
    events.push({
      id: o.id,
      timestamp: o.timestamp,
      event_type: 'website_observation',
      title: `Website Observation on ${o.website_domain || 'Source'}`,
      description: `Deposit context: ${o.deposit_option_context || 'Recorded on page'}. URL: ${o.source_url || 'N/A'}`,
      evidence_id: o.evidence_id,
    });
  }

  // Transactions
  const txs = queryAll<Record<string, unknown>>(
    `SELECT * FROM transactions WHERE wallet_id = ? ORDER BY timestamp ASC;`,
    [walletId]
  );
  for (const t of txs) {
    events.push({
      id: t.id,
      timestamp: t.timestamp,
      event_type: t.direction === 'incoming' ? 'blockchain_incoming' : 'blockchain_outgoing',
      title: `${t.direction === 'incoming' ? 'Inbound' : 'Outbound'} Transfer: ${t.display_amount} ${t.asset}`,
      description: `${t.direction === 'incoming' ? 'From' : 'To'} ${t.counterparty_address} (tx: ${String(t.tx_hash).slice(0, 10)}...)`,
      tx_hash: t.tx_hash,
      asset: t.asset,
      amount_display: t.display_amount,
      evidence_id: t.evidence_id,
    });
  }

  // Findings
  const findings = queryAll<Record<string, unknown>>(
    `SELECT * FROM findings WHERE wallet_id = ?;`,
    [walletId]
  );
  for (const f of findings) {
    events.push({
      id: f.id,
      timestamp: f.created_at,
      event_type: 'finding_generated',
      title: f.summary,
      description: f.explanation,
    });
  }

  events.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  res.json({ events });
});

// 15. Review Queue
router.get('/review-queue', (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) : 'PENDING';
  const items = queryAll<Record<string, unknown>>(
    `SELECT * FROM review_queue WHERE status = ? ORDER BY created_at DESC;`,
    [status]
  );
  res.json({ items });
});

router.post('/review-queue/:id/decision', (req: Request, res: Response) => {
  const { status, decision_notes, decided_by } = req.body;
  updateReviewStatus(req.params.id, status as ReviewStatus, decision_notes, decided_by);
  res.json({ success: true, message: `Review item marked as ${status}.` });
});

router.post('/connected-wallets/promote', (req: Request, res: Response) => {
  const { source_wallet_id, connected_address, investigation_id, justification } = req.body;
  if (!source_wallet_id || !connected_address) {
    return res.status(400).json({ error: 'source_wallet_id and connected_address required.' });
  }

  const result = promoteConnectedWalletToInvestigation(
    source_wallet_id,
    connected_address,
    investigation_id,
    justification
  );

  res.json({
    success: true,
    ...result,
    message: `Promoted ${connected_address} to investigation workspace. Analysis job initiated.`,
  });
});

// 16. Background Jobs
router.get('/jobs', (req: Request, res: Response) => {
  const jobs = queryAll<Record<string, unknown>>(
    `SELECT * FROM analysis_jobs ORDER BY created_at DESC LIMIT 50;`
  );
  res.json({ jobs });
});

router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  globalJobQueue.cancelJob(req.params.id);
  res.json({ success: true, message: 'Job cancellation requested.' });
});

// 17. Provider Health & Stats
router.get('/providers/status', (req: Request, res: Response) => {
  const stats = globalProviderManager.getProviderStats();
  res.json({ providers: stats });
});

// 18. Main Investigation Platform v6 Integration Endpoints
router.get('/main-platform/status', (req: Request, res: Response) => {
  res.json(globalMainPlatform.getStatus());
});

router.post('/main-platform/jobs', (req: Request, res: Response) => {
  const result = globalMainPlatform.handleIncomingJob(req.body);
  res.status(result.accepted ? 202 : 400).json(result);
});

// 19. Export Investigation Report (JSON / CSV / Formatted Markdown Report)
router.get('/export/:walletId', (req: Request, res: Response) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const wallet = queryFirst<Record<string, unknown>>(`SELECT * FROM wallets WHERE id = ?;`, [req.params.walletId]);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });

  const walletId = String(wallet.id);
  const txs = queryAll<Record<string, unknown>>(`SELECT * FROM transactions WHERE wallet_id = ?;`, [walletId]);
  const counterparties = queryAll<Record<string, unknown>>(`SELECT * FROM counterparties WHERE wallet_id = ?;`, [walletId]);
  const findings = queryAll<Record<string, unknown>>(`SELECT * FROM findings WHERE wallet_id = ?;`, [walletId]);
  const observations = queryAll<Record<string, unknown>>(`SELECT * FROM wallet_observations WHERE wallet_id = ?;`, [walletId]);

  if (format === 'csv') {
    // CSV format of transactions
    const header = 'tx_hash,network,timestamp,direction,from_address,to_address,asset,amount,status\n';
    const rows = txs.map((t) =>
      `"${t.tx_hash}","${t.network}","${t.timestamp}","${t.direction}","${t.from_address}","${t.to_address}","${t.asset}","${t.display_amount}","${t.status}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="wallet_${wallet.address}_txs.csv"`);
    return res.send(header + rows);
  }

  if (format === 'report') {
    // Human-readable investigation report with data completeness caveats
    const md = `# Wallet Investigator v1.0 — Blockchain Investigation Report
**Generated:** ${new Date().toISOString()}
**Analysis Version:** 1.0.0
**Target Address:** \`${wallet.address}\`
**Resolved Network:** ${wallet.resolved_network}
**Validation Status:** ${wallet.validation_status}
**Data Completeness:** **${wallet.completeness}**

---

## ⚠️ Data Completeness Notice
${wallet.completeness === 'PARTIAL' || wallet.completeness === 'LIMITED'
  ? `> **WARNING: DATASET IS INCOMPLETE**
> Provider rate limits or pagination boundaries restricted transaction retrieval.
> Total records retrieved: ${txs.length}. Historical balances and totals may be partial.`
  : `> **COMPLETE DATASET**
> Provider verified complete transaction retrieval through latest block.`
}

---

## Wallet Profile
- **Reported Network:** ${wallet.reported_network || 'None'}
- **Current Balance:** ${wallet.balance_display} ${wallet.balance_asset}
- **Recorded Transactions:** ${txs.length} (${wallet.total_incoming_tx_count} in / ${wallet.total_outgoing_tx_count} out)
- **Unique Counterparties:** ${counterparties.length}
- **Associated Website Observations:** ${observations.length}

---

## Observed Website Observations
${observations.map((o) => `- **Domain:** ${o.website_domain || 'N/A'} | **Deposit Context:** ${o.deposit_option_context || 'Standard'} | **URL:** ${o.source_url || 'N/A'}`).join('\n') || 'None recorded.'}

---

## Key Factual Findings
${findings.map((f) => `### ${f.summary}
- **Type:** \`${f.finding_type}\`
- **Explanation:** ${f.explanation}
- **Confidence:** ${Math.round(Number(f.confidence) * 100)}%
- **Completeness:** ${f.completeness}`).join('\n\n') || 'No anomalous patterns observed.'}

---

## Top Blockchain Counterparties
${counterparties.slice(0, 10).map((c) => `- \`${c.counterparty_address}\` (${c.direction}) — ${c.tx_count} txs across [${JSON.parse(String(c.assets_json || '[]')).join(', ')}]`).join('\n') || 'No counterparties recorded.'}
`;

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="report_${wallet.address}.md"`);
    return res.send(md);
  }

  // Default JSON export
  res.json({
    export_metadata: {
      generated_at: Date.now(),
      application: 'Wallet Investigator v1.0',
      data_completeness: wallet.completeness,
      completeness_details: wallet.completeness_details_json ? JSON.parse(String(wallet.completeness_details_json)) : undefined,
    },
    wallet,
    observations,
    transactions: txs,
    counterparties,
    findings,
  });
});

// Project Source ZIP Export
router.get('/export-project-zip', (req: Request, res: Response) => {
  try {
    const zipPath = path.resolve(process.cwd(), 'project-source.zip');
    try {
      execSync(`python3 -c '
import os, zipfile
output_filename = "project-source.zip"
exclude_dirs = {"node_modules", ".git", "dist", ".cache", "__pycache__"}
with zipfile.ZipFile(output_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith(".")]
        for file in files:
            if file == output_filename or file.endswith(".zip"):
                continue
            file_path = os.path.join(root, file)
            arcname = os.path.relpath(file_path, ".")
            zipf.write(file_path, arcname)
'`, { cwd: process.cwd(), timeout: 10000 });
    } catch (e) {
      console.warn('[ExportZip] Dynamic python zip refresh error, using cached zip:', e);
    }

    if (fs.existsSync(zipPath)) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="wallet-investigator-project.zip"');
      res.download(zipPath, 'wallet-investigator-project.zip');
    } else {
      res.status(404).json({ error: 'Source archive not found' });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error generating ZIP' });
  }
});

export default router;
