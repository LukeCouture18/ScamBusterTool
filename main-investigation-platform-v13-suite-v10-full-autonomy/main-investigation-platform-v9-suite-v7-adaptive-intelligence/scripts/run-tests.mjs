// Cross-platform runner for the multi-step test scripts in package.json.
//
//   node scripts/run-tests.mjs <group> [extra args for the last step]
//   node scripts/run-tests.mjs all          every group, PASS/FAIL per group
//   node scripts/run-tests.mjs doctor       check the toolchain the groups need
//
// npm runs package.json scripts through cmd.exe on Windows, where `VAR=1 cmd`,
// `( cd dir && ... )`, `python3` and `.venv/bin/python` do not work. Each group
// here runs exactly the steps its npm script used to chain, in the same order,
// with the same flags and environment, completing all steps despite a failure.
// Python steps use the interpreter resolved by tests/lib/portable.mjs
// (MIP_PYTHON, then .venv\Scripts\python.exe or .venv/bin/python, then PATH).
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {pythonCommand, pythonEnv, repoRoot} from '../tests/lib/portable.mjs';

const SF = join('integrations', 'site-finder-v07');
const WI = join('integrations', 'wallet-investigator');
const LOGGER = join('integrations', 'crypto-wallet-logger-v08');
const node = (...args) => ({kind: 'node', args});
const py = (...args) => ({kind: 'python', args});
const inDir = (cwd, step) => ({...step, cwd});
const withEnv = (env, step) => ({...step, env});
// Resolves `sql.js` to a node:sqlite stand-in only when the real package is not installed.
const SQLJS = pathToFileURL(join(repoRoot, 'tests', 'lib', 'sqljs-fallback.mjs')).href;

export const groups = {
  unit: [node('--test', ...unitTests())],
  'autonomy-v10': [
    ...['v10-one-click','v10-missions','v10-authority','v10-confidence','v10-projection','v10-corpus-counts','v10-crash','v10-crash-generation','v10-golden','v10-request-lifecycle'].map(name=>node('--experimental-sqlite','--import','tsx',`tests/${name}.mjs`)),
    inDir(LOGGER,node('--test','tests/accounts-v10.test.mjs','tests/accounts-worker-v10.test.mjs','tests/wallet-core.test.mjs','tests/context-precision.test.mjs','tests/sync-queue.test.mjs')),
    py('tests/v10-finder-job.py'),py('tests/v10-account-fill.py'),py('tests/v10-accounts-ui.py'),
  ],
  'full-autonomy': [
    ...['autonomy-migration','autonomy-scientific-integration','autonomy-decision-benchmark','autonomy-independent-holdout','autonomy-crash','autonomy-stress','autonomy-v9'].map(name=>node('--experimental-sqlite','--import','tsx',`tests/${name}.mjs`)),
    withEnv({SCIENTIFIC_HELD_OUT:'1',ADAPTIVE_SEEDS:'101,203,307,409,503,607,709,811'},node('--import','tsx','tests/autonomy-decision-benchmark.mjs')),
    inDir(WI,node('--import','tsx','--test','tests/blockscout-v9.test.ts','tests/esplora-v9.test.ts')),
  ],
  'scientific-intelligence': [
    ...['scientific-intelligence','scientific-crash','scientific-queue','scientific-laboratory','scientific-stress','scientific-ui'].map(name=>node('--experimental-sqlite','--import','tsx',`tests/${name}.mjs`)),
    node('--import','tsx','tests/scientific-policy-rollout.mjs'),
    node('--import','tsx','tests/scientific-decision-benchmark.mjs'),
    withEnv({SCIENTIFIC_HELD_OUT:'1',ADAPTIVE_SEEDS:'101,203,307,409,503,607,709,811'},node('--import','tsx','tests/scientific-decision-benchmark.mjs')),
    withEnv({ADAPTIVE_POLICY:'v8'},node('--experimental-sqlite','--import','tsx','--import',SQLJS,'tests/scientific-real-revision.mjs')),
  ],
  'operation-intelligence': [...['operation-intelligence','operation-crash','operation-benchmark','operation-stress','operation-hidden','operation-ui'].map(name=>node('--experimental-sqlite','--import','tsx',...(name==='operation-hidden'?['--import',SQLJS]:[]),`tests/${name}.mjs`)),py('tests/site-investigator-v6-fixes.py')],
  // v7 adaptive investigation intelligence. The real-module A/B (adaptive-hidden) runs the same harness under both policies.
  'adaptive-intelligence': [
    ...['adaptive-intelligence','adaptive-crash','adaptive-stress','adaptive-ui'].map(name=>node('--experimental-sqlite','--import','tsx',`tests/${name}.mjs`)),
    node('--import','tsx','tests/adaptive-decision-benchmark.mjs'),
    node('--import','tsx','tests/adaptive-hard-corpus.mjs'),
    withEnv({ADAPTIVE_POLICY:'v6'},node('--experimental-sqlite','--import','tsx','--import',SQLJS,'tests/adaptive-hidden.mjs')),
    withEnv({ADAPTIVE_POLICY:'v7'},node('--experimental-sqlite','--import','tsx','--import',SQLJS,'tests/adaptive-hidden.mjs')),
  ],
  'director': [
    node('--test', 'tests/director-migration.test.mjs'),
    node('--experimental-sqlite', '--import', 'tsx', '--import', SQLJS, 'tests/director-acceptance.mjs'),
    node('--experimental-sqlite', '--import', 'tsx', '--import', SQLJS, 'tests/director-provider-recovery.mjs'),
    node('--experimental-sqlite', '--import', 'tsx', '--import', SQLJS, 'tests/director-adversarial.mjs'),
  ],
  'startup:modules': [
    py('tests/site-finder-startup-local.py'),
    py('tests/site-investigator-startup-local.py'),
    node('--experimental-sqlite', 'tests/wallet-startup-local.mjs'),
    node('tests/form-startup-local.mjs'),
  ],
  'five-modules': [
    node('tests/form-source-local.mjs'),
    node('tests/form-configured-local.mjs'),
    inDir(WI, withEnv({WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1'}, node('--import', 'tsx', '--import', SQLJS, 'tests/run-all-tests.ts'))),
    inDir(WI, withEnv({WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1'}, node('--import', 'tsx', '--import', SQLJS, 'tests/platform-worker-local.ts'))),
  ],
  // The whole operator workflow across the five tools, then the unified suite UI in a browser.
  suite: [
    node('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', '--import', SQLJS, 'tests/suite-workflow.mjs'),
  ],
  // Site Finder v3 discovery loops: Finder -> Main -> Hunter -> Finder and Finder -> Investigation -> Finder.
  loops: [
    node('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', 'tests/joined-pursuit-loops.mjs'),
  ],
  'joined:v61': [
    node('--experimental-sqlite', '--import', 'tsx', '--import', SQLJS, 'tests/v61-joined-five-modules.mjs'),
    withEnv({V61_FAILURE_PATH: '1'}, node('--experimental-sqlite', '--import', 'tsx', '--import', SQLJS, 'tests/v61-joined-five-modules.mjs')),
  ],
  'integration:v6': [
    node('--experimental-sqlite', 'tests/v6-integration.mjs'),
    node('--experimental-sqlite', 'tests/v6-three-modules.mjs'),
    node('--experimental-sqlite', 'tests/v6-feedback-local.mjs'),
    node('tests/logger-queue-local.mjs'),
    py('tests/site-bridge-synthetic.py'),
    py('tests/site-bridge-worker.py'),
    py('tests/finder-feedback-synthetic.py'),
    py('tests/finder-push-synthetic.py'),
    py('tests/scheduler-local.py'),
    node('--experimental-sqlite', 'tests/scheduler-fallback-local.mjs'),
  ],
  // Site Finder -> Main -> Operation Hunter over HTTP, with an in-place upgrade from the
  // previous schema. Needs the Operation Hunter folder beside this one (or HUNTER_DIR);
  // reports SKIP without it (MIP_REQUIRE_HUNTER=1 makes that a failure).
  'joined:hunter': [
    node('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', 'tests/joined-finder-main-hunter.mjs'),
  ],
  // v4 wallet discovery and reporting: Logger detection, Wallet Investigator validation, the pipeline through Main to an
  // approved, submitted report (in-process), then the same in a real browser with the real extension and separate workers.
  'wallet-pipeline': [
    inDir(LOGGER, node('--test', 'tests/wallet-core.test.mjs', 'tests/sync-queue.test.mjs', 'tests/context-precision.test.mjs')),
    inDir(LOGGER, py('tests/browser_extension_test.py')),
    inDir(WI, node('--import', 'tsx', '--test', 'tests/validation-v4.test.ts')),
    inDir(WI, withEnv({WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1'}, node('--import', 'tsx', '--import', SQLJS, 'tests/platform-worker-v4.ts'))),
    node('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', '--import', SQLJS, 'tests/wallet-pipeline-e2e.mjs'),
    node('--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', '--import', SQLJS, 'tests/wallet-browser-e2e.mjs'),
  ],
  'v2': [
    node('--experimental-sqlite', 'tests/v2-inbox.mjs'),
    inDir(SF, py('run_tests_standalone.py', 'test_v2_precision.py')),
  ],
  'v3': [
    node('--experimental-sqlite', 'tests/v3-agent.mjs'),
  ],
  'v4': [
    node('--experimental-sqlite', 'tests/v4-campaign.mjs'),
    inDir(SF, py('run_tests_standalone.py', 'test_v4_context.py')),
  ],
  'v5': [
    node('--experimental-sqlite', 'tests/v5-operations.mjs'),
    inDir(SF, py('run_tests_standalone.py', 'test_v5_continuous.py')),
  ],
  'site-finder': [
    inDir(SF, py('run_tests_standalone.py')),
  ],
  'benchmark': [
    inDir(SF, py('-m', 'benchmark.run', '--split', 'eval')),
  ],
  'benchmark:v4': [
    node('--experimental-sqlite', 'tests/bench-v4.mjs', '--seeds', '5', '--budget', '10'),
  ],
  'benchmark:v5': [
    node('--experimental-sqlite', 'tests/bench-v5.mjs', '--seeds', '5', '--budget', '12'),
  ],
  'benchmark:v3': [
    inDir(SF, py('-m', 'benchmark.eval_v3', '--split', 'eval')),
  ],
};

// `all` = every acceptance group (the benchmark is a measurement, not a gate).
const ALL = [
  ['unit', [node('--test', ...unitTests())]],
  ['migration-matrix', [node('--experimental-sqlite', '--test', 'tests/v61-migration-matrix.mjs')]],
  ...['suite', 'loops', 'integration:v6', 'v2', 'v3', 'v4', 'v5', 'joined:hunter', 'joined:v61', 'five-modules', 'startup:modules', 'site-finder', 'wallet-pipeline', 'director', 'operation-intelligence', 'adaptive-intelligence', 'scientific-intelligence','full-autonomy','autonomy-v10'].map(name => [name, groups[name]]),
];

function unitTests() {
  // Explicit list rather than a shell glob: cmd.exe does not expand globs.
  return readdirSync(join(repoRoot, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name));
}

function describe(step) {
  const where = step.cwd ? `[${step.cwd}] ` : '';
  const env = step.env ? Object.entries(step.env).map(([k, v]) => `${k}=${v} `).join('') : '';
  return `${where}${env}${step.kind} ${step.args.join(' ')}`;
}

function runStep(step, extra = []) {
  const cwd = join(repoRoot, step.cwd ?? '');
  let command, args, env;
  if (step.kind === 'python') {
    const python = pythonCommand();
    command = python.command;
    args = [...python.args, ...step.args, ...extra];
    env = pythonEnv(step.env);
  } else {
    command = process.execPath;
    args = [...step.args, ...extra];
    env = {...process.env, ...step.env};
  }
  const result = spawnSync(command, args, {cwd, env, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runGroup(name, steps, extra = []) {
  console.log(`\n=== ${name} (${steps.length} step${steps.length === 1 ? '' : 's'}) ===`);
  const outcomes=[];
  for (const [index, step] of steps.entries()) {
    console.log(`--- ${name} ${index + 1}/${steps.length}: ${describe(step)}`);
    const status=runStep(step,index===steps.length-1?extra:[]);
    outcomes.push(status);
    if(status!==0)console.error(`FAIL ${name}: step ${index+1}/${steps.length} exited with ${status}: ${describe(step)}`);
  }
  const failed=outcomes.filter(s=>s!==0).length;
  console.log(`${failed?'FAIL':'PASS'} ${name}: ${outcomes.length-failed}/${outcomes.length} steps passed`);
  return failed?1:0;
}

function doctor() {
  const checks = [];
  const check = (label, fn) => {
    try { checks.push([label, true, fn() ?? '']); } catch (error) { checks.push([label, false, error.message]); }
  };
  check('node >= 22.13 with node:sqlite', () => {
    const probe = spawnSync(process.execPath, ['--experimental-sqlite', '-e', "require('node:sqlite')"], {encoding: 'utf8'});
    if (probe.status !== 0) throw new Error(probe.stderr.trim() || 'node:sqlite unavailable');
    return process.version;
  });
  check('python interpreter', () => { const p = pythonCommand(); return `${p.command} ${p.args.join(' ')} (${p.source})`.replace('  ', ' '); });
  check('python packages for Site Finder / bridge tests', () => {
    const p = pythonCommand();
    const probe = spawnSync(p.command, [...p.args, '-c', 'import flask, requests; print("flask", flask.__version__ if hasattr(flask, "__version__") else "?")'], {encoding: 'utf8', env: pythonEnv()});
    if (probe.status !== 0) throw new Error((probe.stderr || '').trim().split(/\r?\n/).pop());
    return probe.stdout.trim();
  });
  for (const [label, from] of [['esbuild (platform)', repoRoot], ['tsx (platform)', repoRoot], ['tsx (wallet-investigator)', join(repoRoot, WI)], ['tsx (form-submitter)', join(repoRoot, 'integrations', 'form-submitter')]]) {
    check(label, () => createRequire(join(from, 'package.json')).resolve(label.split(' ')[0]));
  }
  check('built worker config (npm run build)', () => {
    const file = join(repoRoot, 'dist', 'server', 'wrangler.json');
    if (!existsSync(file)) throw new Error(`${file} missing; run npm run build`);
    JSON.parse(readFileSync(file, 'utf8'));
    return file;
  });
  check('harness portability (no raw-path imports, URL.pathname or POSIX-only python)', () => {
    // Regression guard for the patterns that break the harness on Windows.
    const rules = [
      [/\bimport\(\s*(join|resolve|path\.join)\(/, 'dynamic import of a filesystem path; use importFile/importFrom'],
      [/import\.meta\.url\)\.pathname/, 'URL.pathname as a path; use fileURLToPath/localPath'],
      [/from \$\{JSON\.stringify\(join\(/, 'raw path in a generated import; wrap it in fileHref()'],
      [/['"]python3['"]|\.venv\/bin\/python/, 'POSIX-only python; use pythonCommand()/runPython()'],
    ];
    const files = ['tests', 'scripts'].flatMap(dir => readdirSync(join(repoRoot, dir)).filter(n => /\.(mjs|js|ts)$/.test(n)).map(n => join(dir, n)));
    const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
    const problems = [];
    for (const file of files.filter(f => !f.endsWith('run-tests.mjs'))) {
      readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const [pattern, why] of rules) if (pattern.test(line)) problems.push(`${file}:${i + 1} ${why}`);
      });
    }
    for (const [name, command] of Object.entries(scripts)) {
      if (/(^|\s|\()[A-Z_][A-Z0-9_]*=\S*\s/.test(command) || /python3|\.venv\/bin/.test(command)) problems.push(`package.json scripts.${name}: POSIX-only shell syntax`);
    }
    if (problems.length) throw new Error(`\n  ${problems.join('\n  ')}`);
    return `${files.length} files, ${Object.keys(scripts).length} npm scripts`;
  });
  for (const [label, ok, detail] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

const [name, ...extra] = process.argv.slice(2);
if (name === 'doctor') process.exit(doctor());
if (name === 'all') {
  const results = ALL.map(([group, steps]) => [group, runGroup(group, steps)]);
  console.log('\n=== summary ===');
  for (const [group, status] of results) console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${group}`);
  process.exit(results.every(([, status]) => status === 0) ? 0 : 1);
}
if (!groups[name]) {
  console.error(`Unknown group "${name}". Groups: ${Object.keys(groups).join(', ')}, all, doctor`);
  process.exit(2);
}
process.exit(runGroup(name, groups[name], extra));
