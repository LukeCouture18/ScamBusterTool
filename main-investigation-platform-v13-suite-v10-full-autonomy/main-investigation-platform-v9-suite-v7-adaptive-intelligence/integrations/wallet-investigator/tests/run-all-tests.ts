import type { WalletEntity } from '../src/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The database lives in <working directory>/data. Run the suite in a fresh temporary directory so it
// never opens (or leaves state in) the Wallet Investigator's real data/wallet_investigator.sqlite,
// and a previous or interrupted run cannot affect this one. Server modules are imported after the
// directory change because database.ts resolves its path when it is first loaded.
const originalCwd = process.cwd();
const isolated = mkdtempSync(join(tmpdir(), 'wallet-verification-'));
process.chdir(isolated);
const cleanup = () => { process.chdir(originalCwd); try { rmSync(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort: it is a temp directory */ } };
process.on('exit', cleanup);

const { validateAddress } = await import('../server/crypto/validation');
const { parseDisplayToBaseUnit, formatBaseUnitToDisplay } = await import('../server/crypto/precision');
const { initDatabase, queryFirst, queryAll } = await import('../server/db/database');
const { runMigrations } = await import('../server/db/migrations');
const { globalProviderManager } = await import('../server/providers/manager');
const { findPathBetweenWallets } = await import('../server/engine/path_finder');
const { generateWalletFindings } = await import('../server/engine/findings');
const { promoteConnectedWalletToInvestigation } = await import('../server/engine/review_queue');
const { globalMainPlatform } = await import('../server/integration/main_platform_v6');

async function runTests() {
  console.log('=== STARTING INVESTIGATION PLATFORM VERIFICATION TEST SUITE ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, desc: string) {
    if (condition) {
      console.log(`✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${desc}`);
      failed++;
    }
  }

  // TEST 1: Address Validation & EVM Ambiguity Detection
  console.log('--- Suite 1: Address Validation & Network Resolution ---');
  const evmExplicit = validateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'ethereum');
  assert(evmExplicit.is_valid === true, 'EVM address is valid');
  assert(evmExplicit.resolved_network === 'ethereum', 'Reported network honored for EVM');
  assert(evmExplicit.network_ambiguity === false, 'Explicit reported network resolves EVM ambiguity');

  const evmUncertain = validateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  assert(evmUncertain.is_valid === true, 'EVM without reported network is format-valid');
  assert(evmUncertain.detected_network === 'evm_uncertain', 'Detected network is evm_uncertain');
  assert(evmUncertain.network_ambiguity === true, 'EVM address triggers network ambiguity flag (cross-EVM)');

  const btcBech32Test = validateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert(btcBech32Test.is_valid === true, 'BTC Bech32 address is valid');
  assert(btcBech32Test.detected_network === 'bitcoin', 'Detected network is bitcoin');
  assert(btcBech32Test.network_ambiguity === false, 'BTC Bech32 has no network ambiguity');
  assert(btcBech32Test.validation_status === 'valid_checksum', 'BTC Bech32 has valid checksum');

  const tronTest = validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert(tronTest.is_valid === true, 'TRON TRC20 address is valid');
  assert(tronTest.detected_network === 'tron', 'Detected network is tron');
  assert(tronTest.validation_status === 'valid_checksum', 'TRON address has valid base58 checksum');

  const solanaTest = validateAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  assert(solanaTest.is_valid === true, 'Solana base58 address is valid');
  assert(solanaTest.detected_network === 'solana', 'Detected network is solana');

  const invalidTest = validateAddress('not_a_crypto_address_123');
  assert(invalidTest.is_valid === false, 'Random string rejected as invalid');
  assert(invalidTest.validation_status === 'invalid_format', 'Random string flagged as invalid_format');

  // TEST 2: Financial Precision & Base Unit Math
  console.log('\n--- Suite 2: Base Unit Financial Math & Precision ---');
  const btcSatoshis = parseDisplayToBaseUnit('1.00000001', 8);
  assert(btcSatoshis === '100000001', '1.00000001 BTC is 100000001 satoshis');
  const btcDisplay = formatBaseUnitToDisplay('100000001', 8);
  assert(btcDisplay === '1.00000001', 'Displays exact decimal representation without float drift');

  const ethWei = parseDisplayToBaseUnit('0.000000000000000005', 18);
  assert(ethWei === '5', '5 wei computed accurately');

  const usdtUnits = parseDisplayToBaseUnit('50000.5', 6);
  assert(usdtUnits === '50000500000', 'USDT 6 decimals base units accurate');

  // TEST 3: Database & Migration Integrity
  console.log('\n--- Suite 3: Database & Migration Schema ---');
  await initDatabase();
  await runMigrations();
  const tableCheck = queryFirst<Record<string, unknown>>(
    `SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='wallets';`
  );
  assert(Number(tableCheck?.cnt) >= 1, 'Database schema initialized and wallets table exists');

  const observationCheck = queryFirst<Record<string, unknown>>(
    `SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='wallet_observations';`
  );
  assert(Number(observationCheck?.cnt) >= 1, 'wallet_observations table exists for multi-site evidence');

  // TEST 4: Blockchain Provider Layer & Fallback
  console.log('\n--- Suite 4: Blockchain Provider Layer & Fallback ---');
  const btcResult = await globalProviderManager.fetchActivity('bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w', 'bitcoin');
  assert(btcResult !== null, 'Provider retrieves Bitcoin wallet activity');
  assert(btcResult.completeness === 'COMPLETE' || btcResult.completeness === 'PARTIAL', 'Completeness caveat recorded');
  assert(Array.isArray(btcResult.transactions), 'Transactions array returned');

  const stats = globalProviderManager.getProviderStats();
  assert(stats.length >= 3, 'All configured blockchain provider tiers are registered');

  // TEST 5: Findings Engine & Non-Pejorative Evidence Linking
  console.log('\n--- Suite 5: Non-Pejorative Findings Engine ---');
  const findings = generateWalletFindings({ id: 'w_demo_1', address: 'bc1qdemo' } as WalletEntity);
  assert(Array.isArray(findings), 'Findings generator returns structured finding array');

  // TEST 6: Main Platform v6 Canonical Integration
  console.log('\n--- Suite 6: Main Platform v6 Canonical Protocol ---');
  const platformStatus = globalMainPlatform.getStatus();
  assert(platformStatus.module_id === 'wallet_investigator', 'Correct canonical module_id');
  assert(platformStatus.status === 'STANDALONE_MODE', 'Unregistered module is not falsely online');
  assert(platformStatus.capabilities.includes('blockchain-analysis'), 'Main Platform advertises blockchain-analysis capability');

  console.log(`\n=== TEST VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
