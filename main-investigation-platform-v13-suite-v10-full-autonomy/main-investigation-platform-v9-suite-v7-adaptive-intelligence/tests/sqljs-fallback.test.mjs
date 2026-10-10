// Regression: tests/lib/sqljs-fallback.mjs must be inert when the real sql.js is installed.
//
// On Windows + Node 24, registering the fallback's module hook next to tsx left
// `await import('.../wallet-investigator/server/integration/platform_worker.ts')` with an empty
// namespace (startPlatformWorker undefined) even though the file exports it. The fallback now
// registers nothing when sql.js resolves; this test proves that on the machine it runs on:
//
//   * a Wallet Investigator with the real sql.js installed next to it, imported with
//     `node --import tsx --import tests/lib/sqljs-fallback.mjs` (the joined tests' exact flags, in
//     both orders), still exposes PlatformWorker and startPlatformWorker as functions,
//   * no hook was registered (globalThis.__MIP_SQLJS_STANDIN__ === false), and
//   * `sql.js` still resolves to the real package, not to tests/lib/sqljs-standin.
//
// Where the repository has the real sql.js (a normal `npm install`), the repository's own Wallet
// Investigator is used. Otherwise (a sandbox without npm) a temporary copy of the Wallet
// Investigator is given a real-shaped sql.js package so the installed path is still exercised;
// the repository itself is never modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileHref, removeDir, repoRoot} from './lib/portable.mjs';

const walletRoot = join(repoRoot, 'integrations', 'wallet-investigator');
const fallback = fileHref(join(repoRoot, 'tests', 'lib', 'sqljs-fallback.mjs'));
const standinDir = join(repoRoot, 'tests', 'lib', 'sqljs-standin');
const resolveFrom = (dir, id) => { try { return createRequire(join(dir, 'package.json')).resolve(id); } catch { return null; } };
const tsx = resolveFrom(repoRoot, 'tsx') ?? resolveFrom(walletRoot, 'tsx');

function probe(root, order) {
  const worker = fileHref(join(root, 'server', 'integration', 'platform_worker.ts'));
  const script = `
import {createRequire} from 'node:module';
const m = await import(${JSON.stringify(worker)});
let sqljs = null; try { sqljs = createRequire(${JSON.stringify(join(root, 'server', 'db', 'database.ts'))}).resolve('sql.js'); } catch {}
process.stdout.write('PROBE' + JSON.stringify({keys: Object.keys(m).sort(), PlatformWorker: typeof m.PlatformWorker,
  startPlatformWorker: typeof m.startPlatformWorker, standin: globalThis.__MIP_SQLJS_STANDIN__, sqljs}) + '\\n');
process.exit(0);`;
  const imports = order === 'tsx-first' ? ['--import', fileHref(tsx), '--import', fallback] : ['--import', fallback, '--import', fileHref(tsx)];
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...imports, '--input-type=module', '-e', script],
    {cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, env: {...process.env, WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1', MAIN_PLATFORM_URL: '', WALLET_INVESTIGATOR_MODULE_KEY: ''}});
  const line = (run.stdout || '').split('\n').find(l => l.startsWith('PROBE'));
  assert.ok(line, `probe produced no result (exit ${run.status}):\n${run.stderr}\n${run.stdout}`);
  return JSON.parse(line.slice(5));
}

/** A Wallet Investigator with a real sql.js next to it: the repository's own, or a temporary copy. */
function walletWithRealSqlJs(temp) {
  const real = resolveFrom(walletRoot, 'sql.js');
  if (real) return {root: walletRoot, real, simulated: false};
  const root = join(temp, 'wallet-investigator');
  for (const part of ['server', 'src', 'package.json', 'tsconfig.json']) if (existsSync(join(walletRoot, part))) cpSync(join(walletRoot, part), join(root, part), {recursive: true});
  // Same shape as the published package (CommonJS main exporting initSqlJs); backed by the stand-in.
  const pkg = join(root, 'node_modules', 'sql.js');
  mkdirSync(join(pkg, 'dist'), {recursive: true});
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({name: 'sql.js', version: '0.0.0-test', main: './dist/sql-wasm.mjs'}));
  writeFileSync(join(pkg, 'dist', 'sql-wasm.mjs'), `export {default} from ${JSON.stringify(fileHref(join(standinDir, 'index.mjs')))};\n`);
  return {root, real: resolveFrom(root, 'sql.js'), simulated: true};
}

test('with real sql.js installed the fallback registers nothing and the Wallet worker keeps PlatformWorker and startPlatformWorker', {timeout: 180000}, async t => {
  assert.ok(tsx, 'tsx is not installed (npm install in the repository root)');
  const temp = mkdtempSync(join(tmpdir(), 'mip-sqljs-fallback-'));
  try {
    const wallet = walletWithRealSqlJs(temp);
    assert.ok(wallet.real, 'sql.js does not resolve for the Wallet Investigator under test');
    if (wallet.simulated) t.diagnostic('real sql.js is not installed here; used a temporary Wallet Investigator copy with a real-shaped sql.js package');
    for (const order of ['tsx-first', 'fallback-first']) {
      const result = probe(wallet.root, order);
      assert.equal(result.PlatformWorker, 'function', `${order}: PlatformWorker missing, namespace keys ${JSON.stringify(result.keys)}`);
      assert.equal(result.startPlatformWorker, 'function', `${order}: startPlatformWorker missing, namespace keys ${JSON.stringify(result.keys)}`);
      assert.deepEqual(result.keys, ['PlatformWorker', 'startPlatformWorker']);
      assert.equal(result.standin, false, `${order}: the fallback registered a module hook although sql.js is installed`);
      assert.ok(result.sqljs && !result.sqljs.startsWith(standinDir), `${order}: sql.js resolved to ${result.sqljs}`);
    }
  } finally {
    await removeDir(temp);
  }
});

test('without sql.js the fallback still serves the node:sqlite stand-in and the worker still loads', {timeout: 120000}, async t => {
  if (resolveFrom(walletRoot, 'sql.js') || resolveFrom(repoRoot, 'sql.js')) {
    t.skip('the real sql.js is installed in this repository, so the stand-in path is not used here');
    return;
  }
  assert.ok(tsx, 'tsx is not installed');
  const result = probe(walletRoot, 'tsx-first');
  assert.equal(result.standin, true);
  assert.equal(result.PlatformWorker, 'function');
  assert.equal(result.startPlatformWorker, 'function');
});
