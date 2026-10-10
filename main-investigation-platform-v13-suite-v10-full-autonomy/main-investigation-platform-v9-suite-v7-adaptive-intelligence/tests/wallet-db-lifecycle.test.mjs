// Wallet Investigator database lifecycle (real module code, each step a separate process):
//   clean start -> populated restart -> process killed while saving -> damaged file on disk.
//
// Regressions covered:
//   * an interrupted save (process killed mid-write) left a truncated wallet_investigator.sqlite,
//     after which every start and every verification run failed with
//     "database disk image is malformed";
//   * the recovery path overwrote the user's unreadable database with an empty one;
//   * the Wallet test suite ran against the real integrations/wallet-investigator/data folder.
// Everything here runs in temporary directories; no real database is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileHref, removeDir, repoRoot} from './lib/portable.mjs';

const walletRoot = join(repoRoot, 'integrations', 'wallet-investigator');
const resolveFrom = (dir, id) => { try { return createRequire(join(dir, 'package.json')).resolve(id); } catch { return null; } };
const tsx = resolveFrom(repoRoot, 'tsx') ?? resolveFrom(walletRoot, 'tsx');
const database = fileHref(join(walletRoot, 'server', 'db', 'database.ts'));
const imports = ['--import', fileHref(tsx), '--import', fileHref(join(repoRoot, 'tests', 'lib', 'sqljs-fallback.mjs'))];
const env = {...process.env, MIP_QUIET_STANDIN: '1'};

function run(cwd, body) {
  const script = `const db = await import(${JSON.stringify(database)});\n${body}\nprocess.exit(0);`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...imports, '--input-type=module', '-e', script],
    {cwd, env, encoding: 'utf8', timeout: 60000, windowsHide: true});
  assert.equal(r.status, 0, `child failed:\n${r.stderr}\n${r.stdout}`);
  return (r.stdout.split('\n').find(l => l.startsWith('OUT')) ?? 'OUT null').slice(3);
}
const file = cwd => join(cwd, 'data', 'wallet_investigator.sqlite');
const leftovers = cwd => readdirSync(join(cwd, 'data')).filter(n => n.endsWith('.tmp'));

test('wallet database: clean start, restart with data, interrupted save and a damaged file', {timeout: 240000, skip: !tsx && 'tsx is not installed'}, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'mip-wallet-db-'));
  try {
    // 1. clean start creates the file
    run(cwd, `await db.initDatabase(); db.runStatement('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)'); db.runStatement("INSERT INTO t(v) VALUES ('first')"); db.saveDatabaseToDisk();`);
    assert.ok(existsSync(file(cwd)));
    assert.deepEqual(leftovers(cwd), []);

    // 2. restart on a populated database keeps the rows
    const rows = run(cwd, `await db.initDatabase(); console.log('OUT' + JSON.stringify(db.queryAll('SELECT v FROM t')));`);
    assert.deepEqual(JSON.parse(rows), [{v: 'first'}]);

    // 3. a process killed while it keeps saving never leaves a damaged database behind
    for (let round = 0; round < 3; round++) {
      const writer = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...imports, '--input-type=module', '-e',
        `const db = await import(${JSON.stringify(database)}); await db.initDatabase();
         db.runStatement("CREATE TABLE IF NOT EXISTS big(id INTEGER PRIMARY KEY, blob TEXT)");
         console.log('READY');
         for (;;) { db.runStatement('INSERT INTO big(blob) VALUES (?)', ['x'.repeat(20000)]); db.saveDatabaseToDisk(); }`],
        {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
      await new Promise((resolve, reject) => {
        writer.stdout.on('data', d => { if (String(d).includes('READY')) setTimeout(resolve, 400 + round * 300); });
        writer.on('exit', code => reject(new Error(`writer exited early (${code})`)));
      });
      writer.removeAllListeners('exit');
      await new Promise(done => { writer.on('exit', done); writer.kill('SIGKILL'); });
      const check = run(cwd, `await db.initDatabase(); console.log('OUT' + JSON.stringify(db.queryAll('PRAGMA quick_check')[0]));`);
      assert.deepEqual(JSON.parse(check), {quick_check: 'ok'}, `round ${round}: database damaged by an interrupted save`);
      assert.ok(!readdirSync(join(cwd, 'data')).some(n => n.includes('.corrupt-')), `round ${round}: an interrupted save produced an unreadable database`);
    }
    t.diagnostic(`database size after interrupted saves: ${statSync(file(cwd)).size} bytes`);

    // 4. a damaged file (e.g. copied mid-write by another tool) is kept, byte for byte, and a new database starts
    truncateSync(file(cwd), 50000);
    const damaged = readFileSync(file(cwd));
    run(cwd, `await db.initDatabase(); db.runStatement('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)'); db.saveDatabaseToDisk();`);
    const kept = readdirSync(join(cwd, 'data')).filter(n => n.startsWith('wallet_investigator.sqlite.corrupt-'));
    assert.equal(kept.length, 1, 'the unreadable database was not preserved');
    assert.ok(readFileSync(join(cwd, 'data', kept[0])).equals(damaged), 'the preserved file differs from the original');
    const again = run(cwd, `await db.initDatabase(); console.log('OUT' + JSON.stringify(db.queryAll('PRAGMA quick_check')[0]));`);
    assert.deepEqual(JSON.parse(again), {quick_check: 'ok'});
    assert.deepEqual(leftovers(cwd), []);
  } finally {
    await removeDir(cwd);
  }
});

test('the Wallet verification suite never touches integrations/wallet-investigator/data', {timeout: 240000, skip: !tsx && 'tsx is not installed'}, async () => {
  // A damaged database is placed where a real one would live; the verification suite must neither
  // read it (and fail with "malformed") nor change it.
  const scratch = mkdtempSync(join(tmpdir(), 'mip-wallet-suite-'));
  const copy = join(scratch, 'wallet-investigator');
  try {
    // Source only; node_modules is linked (a junction on Windows needs no admin rights), not copied.
    cpSync(walletRoot, copy, {recursive: true, filter: p => !/[\\/](data|dist|node_modules)$/.test(p)});
    if (existsSync(join(walletRoot, 'node_modules'))) symlinkSync(join(walletRoot, 'node_modules'), join(copy, 'node_modules'), 'junction');
    mkdirSync(join(copy, 'data'));
    const poisoned = Buffer.alloc(60000, 7);
    writeFileSync(join(copy, 'data', 'wallet_investigator.sqlite'), poisoned);
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...imports, 'tests/run-all-tests.ts'],
        {cwd: copy, env: {...env, WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1'}, encoding: 'utf8', timeout: 120000, windowsHide: true});
      assert.equal(r.status, 0, `run ${i + 1} failed:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
    }
    assert.ok(readFileSync(join(copy, 'data', 'wallet_investigator.sqlite')).equals(poisoned), 'the verification suite changed the module database');
    assert.deepEqual(readdirSync(join(copy, 'data')), ['wallet_investigator.sqlite']);
  } finally {
    await removeDir(scratch);
  }
});
