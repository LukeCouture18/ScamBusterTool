/**
 * Worker-level test for v4 ANALYZE_WALLET jobs (pipeline 'wallet-v4').
 * Runs in an isolated temporary directory (never the module's real data/ folder) with the real
 * engine and the synthetic provider:
 *   WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES=1 node --import tsx tests/platform-worker-v4.ts
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const isolated = mkdtempSync(join(tmpdir(), 'wallet-platform-v4-'));
process.chdir(isolated);
const { initDatabase, queryAll } = await import('../server/db/database');
const { runMigrations } = await import('../server/db/migrations');
const { PlatformWorker } = await import('../server/integration/platform_worker');
await import('../server/jobs/job_queue');

type WalletRecord = {
  external_id: string; investigation_id: string; canonical_key: string; address: string; network: string; family: string | null;
  classification: string; completeness: string;
  data: { wallet_candidate_id: string; validation: { status: string; network: string | null; family: string | null; address_normalized: string; checksum: string; reasons: string[] }; analysis: { status: string; reason?: string; completeness?: string } };
  provenance: { origin_job_id: string; pipeline: string; provenance_notes: string[] };
};
type Call = { path: string; method: string; body: unknown };
type IngestBatch = { origin_job_id: string; records: { wallets: WalletRecord[]; transactions: unknown[]; evidence: Array<{entity:{canonical_key:string}}>; counterparties: unknown[] } };
type JobPatch = { action: string; result: { analysis: string; canonical_key: string } };

const inv = crypto.randomUUID();
const entityId = crypto.randomUUID();
const worker = new PlatformWorker('http://127.0.0.1:8080', 'synthetic-key');
let calls: Call[] = [];
worker.request = async (path: string, method = 'GET', body?: unknown) => {
  calls.push({ path, method, body });
  // Main lower-cases canonical keys and (here) has no upstream observation versions for the entity:
  // a v4 job must not depend on either.
  if (path.includes('/context?')) return { entities: [{ id: entityId, entity_type: 'wallet', canonical_key: 'tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t' }], observation_versions: [] };
  if (path.includes('/ingest/')) return { error_count: 0, status: 'accepted' };
  return { accepted: true };
};

const analysisJobCount = () => queryAll<Record<string, unknown>>('SELECT * FROM analysis_jobs').length;
async function run(payload: Record<string, unknown>) {
  calls = [];
  const id = crypto.randomUUID();
  await worker.process({ id, job_type: 'ANALYZE_WALLET', investigation_id: inv, target_entity_id: entityId, correlation_id: `corr-${id}`, payload: JSON.stringify({ pipeline: 'wallet-v4', ...payload }) });
  const ingests = calls.filter(c => c.path === '/api/v1/ingest/wallet_investigator');
  assert.equal(ingests.length, 1, 'exactly one ingest batch per job');
  assert.ok(ingests[0].body && typeof ingests[0].body === 'object');
  const batch = ingests[0].body as IngestBatch;
  assert.equal(batch.origin_job_id, id);
  assert.equal(batch.records.wallets.length, 1, 'validation is always reported as one wallets record');
  const wallet = batch.records.wallets[0] as WalletRecord;
  const patches = calls.filter(c => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.ok(patches[0].body && typeof patches[0].body === 'object');
  return { id, batch, wallet, patch: patches[0].body as JobPatch };
}

const results: Record<string, unknown> = {};
try {
  await initDatabase();
  await runMigrations();

  // 1. Valid TRON address: case preserved end to end, analysis runs under 'tron'. No synthetic
  //    fixture exists for it, so every provider fails: a provider outage → analysis PARTIAL.
  {
    const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const before = analysisJobCount();
    const { wallet, patch, batch } = await run({ wallet_candidate_id: 'cand-tron', address: tron, family: 'tron', candidate_networks: ['tron'], network_hint: { network: 'tron', token: 'USDT', source: 'label' } });
    assert.equal(wallet.address, tron);
    assert.equal(wallet.canonical_key, `tron:${tron}`);
    assert.equal(wallet.network, 'tron');
    assert.equal(wallet.classification, 'valid');
    assert.equal(wallet.data.wallet_candidate_id, 'cand-tron');
    assert.equal(wallet.data.validation.status, 'valid');
    assert.equal(wallet.data.validation.address_normalized, tron);
    assert.equal(wallet.data.analysis.status, 'PARTIAL');
    assert.ok(wallet.data.analysis.reason, 'completeness reason recorded');
    assert.ok(wallet.provenance.provenance_notes.some(n => /No upstream observation/.test(n)), 'missing observation version is a provenance note, not a failure');
    assert.equal(analysisJobCount(), before + 1, 'analysis ran');
    const job = queryAll<{ address: string; network: string }>('SELECT address, network FROM analysis_jobs ORDER BY created_at DESC LIMIT 1')[0];
    assert.equal(job.address, tron, 'engine analysed the case-preserved address');
    assert.equal(job.network, 'tron');
    const row = queryAll<{ address: string; normalized_address: string }>('SELECT address, normalized_address FROM wallets WHERE resolved_network = ?', ['tron'])[0];
    assert.equal(row.address, tron);
    assert.equal(row.normalized_address, tron);
    assert.equal(patch.action, 'needs-review');
    assert.equal(patch.result.analysis, 'PARTIAL');
    assert.equal(patch.result.canonical_key, `tron:${tron}`);
    assert.deepEqual(batch.records.transactions ?? [], []);
    results.tron = { classification: wallet.classification, analysis: wallet.data.analysis.status, patch: patch.action };
  }

  // 2. Mixed-case EVM with a broken EIP-55 checksum → invalid, no analysis.
  {
    const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    const before = analysisJobCount();
    const { wallet, patch, batch } = await run({ wallet_candidate_id: 'cand-bad', address: broken, family: 'evm', candidate_networks: ['ethereum', 'bsc'], network_hint: { network: 'bsc', token: 'USDT', source: 'label' } });
    assert.equal(wallet.classification, 'invalid');
    assert.equal(wallet.data.validation.checksum, 'eip55_invalid');
    assert.equal(wallet.network, 'unknown');
    assert.equal(wallet.canonical_key, `evm:${broken.toLowerCase()}`);
    assert.equal(wallet.address, broken);
    assert.equal(wallet.data.analysis.status, 'SKIPPED');
    assert.equal(analysisJobCount(), before, 'no analysis for an invalid address');
    assert.equal(batch.records.transactions, undefined);
    assert.equal(patch.action, 'complete');
    assert.equal(patch.result.analysis, 'SKIPPED');
    results.invalid_evm = { classification: wallet.classification, patch: patch.action };
  }

  // 3. Valid EVM, two candidates, no hint → network_ambiguous; never guessed, no analysis.
  {
    const addr = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
    const before = analysisJobCount();
    const { wallet, patch } = await run({ wallet_candidate_id: 'cand-amb', address: addr, family: 'evm', candidate_networks: ['ethereum', 'bsc'], network_hint: null });
    assert.equal(wallet.classification, 'network_ambiguous');
    assert.equal(wallet.data.validation.network, null);
    assert.equal(wallet.network, 'unknown');
    assert.equal(wallet.canonical_key, `evm:${addr.toLowerCase()}`);
    assert.equal(analysisJobCount(), before);
    assert.equal(patch.action, 'complete');
    results.ambiguous_evm = { classification: wallet.classification, network: wallet.network };
  }

  // 4. analyze:false → validate only, even though the address is valid with a resolved network.
  {
    const addr = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
    const before = analysisJobCount();
    const { wallet, patch } = await run({ wallet_candidate_id: 'cand-vo', address: addr, family: 'evm', candidate_networks: ['ethereum', 'bsc'], network_hint: { network: 'BEP20', token: 'USDT', source: 'label' }, analyze: false });
    assert.equal(wallet.classification, 'valid');
    assert.equal(wallet.network, 'bsc');
    assert.equal(wallet.canonical_key, `bsc:${addr.toLowerCase()}`);
    assert.equal(wallet.data.analysis.status, 'SKIPPED');
    assert.equal(analysisJobCount(), before);
    assert.equal(patch.action, 'complete');
    results.validate_only = { classification: wallet.classification, network: wallet.network };
  }

  // 5. Valid EVM with a fixture and an ERC20 hint → full bounded analysis under 'ethereum'.
  {
    const addr = '0x71c841094df8cf7fa128565551f337f74c7dbb94';
    const { wallet, patch, batch } = await run({ wallet_candidate_id: 'cand-full', address: addr, family: 'evm', candidate_networks: ['ethereum', 'bsc'], network_hint: { network: 'ERC20', token: 'USDT', source: 'label' } });
    assert.equal(wallet.classification, 'valid');
    assert.equal(wallet.canonical_key, `ethereum:${addr}`);
    assert.ok(batch.records.transactions.length > 0);
    assert.ok(batch.records.evidence.length > 0);
    assert.ok(batch.records.counterparties.length > 0);
    for (const e of batch.records.evidence) assert.equal(e.entity.canonical_key, `ethereum:${addr}`);
    assert.ok(['complete', 'needs-review'].includes(patch.action));
    results.full_evm = { transactions: batch.records.transactions.length, evidence: batch.records.evidence.length, analysis: wallet.data.analysis.status };
  }

  // 6. TRON address with a contradicting 'bsc' hint → network_ambiguous, address kept, no analysis.
  {
    const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const before = analysisJobCount();
    const { wallet } = await run({ wallet_candidate_id: 'cand-tron-bsc', address: tron, family: 'tron', candidate_networks: ['tron'], network_hint: { network: 'bsc', token: 'USDT', source: 'nearby-text' } });
    assert.equal(wallet.classification, 'network_ambiguous');
    assert.equal(wallet.canonical_key, `tron:${tron}`);
    assert.equal(wallet.address, tron);
    assert.equal(analysisJobCount(), before);
  }

  console.log(JSON.stringify({ ok: true, ...results }));
} finally {
  process.chdir(originalCwd);
  rmSync(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(0);
