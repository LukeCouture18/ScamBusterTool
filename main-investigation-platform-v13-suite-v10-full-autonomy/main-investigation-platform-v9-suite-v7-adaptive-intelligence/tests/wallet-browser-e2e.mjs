// v4 acceptance, in a real browser with the real Wallet Logger extension:
//   you open a site, log in yourself, browse its deposit pages -> Wallet Logger (passive) sends what the
//   pages show -> Main -> Wallet Investigator (own process) validates and analyses -> Main builds the report
//   -> you press "Approve & Submit" in Main's UI -> Form Submitter (own process) files it once.
// Along the way: Main goes down while you browse (Logger queues, then reconnects), the browser is closed
// and reopened with wallets still queued, Wallet Investigator is killed and restarted, the chain provider is
// unavailable (synthetic provider without data -> analysis PARTIAL, noted in the report), and decoys
// (token contract, transaction hashes, an example address, your own withdrawal address) are present.
//
// Orchestration: this script runs Main (test harness), the test site, both workers as child processes and
// a small control endpoint; tests/wallet-browser-e2e.py drives the browser and calls the control endpoint.
// Nothing leaves the machine. Run:
//   node --experimental-sqlite --import tsx --import ./tests/lib/sqljs-fallback.mjs tests/wallet-browser-e2e.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localPath, pythonCommand, pythonEnv} from './lib/portable.mjs';
import {applyMigrations, MODULE_KEYS as KEYS, startMain} from './lib/main-harness.mjs';
import {evm, tron} from './lib/test-addresses.mjs';
import {buildSuiteUi, serveSuiteUi} from './ui/build.mjs';

const work = mkdtempSync(join(tmpdir(), 'mip-wallet-browser-'));
const dbFile = join(work, 'main.sqlite');
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
let main = null, mainPort = 0, submissions = 0;
const children = {};
const results = {};

// ------------------------------------------------------------------ the site under investigation (test fixture)
const W = {trc20: await tron(201), bep20: evm(202), erc20: evm(203)};
const DECOY = {contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', example: evm(210), withdraw: evm(211), counterparty: evm(212), txhash: 'a3f1' + '9c'.repeat(30)};
const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><header><a href="/">LuckyPay</a> · <a href="/account/deposit">Deposit</a> · <a href="/account/history">History</a> · <a href="/account/withdraw">Withdraw</a> · <a href="/help">Help</a></header><main>${body}</main><script>${script}</script></body></html>`;
const SITE_PAGES = {
  '/': () => page('LuckyPay – earn 3% a day on USDT', '<h1>Earn 3% daily on USDT</h1><p>Guaranteed returns. <a href="/login">Log in</a> to deposit.</p>'),
  '/login': () => page('Log in – LuckyPay', '<h1>Log in</h1><form method="post" action="/login"><label>Username <input id="username" name="username"></label><label>Password <input id="password" name="password" type="password"></label><button id="signin" type="submit">Log in</button></form>'),
  '/account/deposit': () => page('Deposit – LuckyPay', `<h1>Deposit USDT</h1><div role="tablist"><button id="tab-trc20" aria-selected="true">TRC20</button><button id="tab-bep20">BEP20 (BSC)</button></div>
    <section id="deposit"><h2 id="net">USDT · TRC20</h2><p>Send only USDT to this deposit address. Your balance is credited after 1 confirmation.</p><p>Deposit address: <b id="addr">loading…</b> <button id="copy">Copy address</button></p></section>
    <aside><p>USDT token contract (do not send here): <code>${DECOY.contract}</code></p></aside>`,
  `let current = 'trc20';
   async function show(net) { const r = await fetch('/api/deposit-address?network=' + net); const j = await r.json(); current = net;
     document.getElementById('net').textContent = net === 'trc20' ? 'USDT · TRC20' : 'USDT · BEP20 (BNB Smart Chain)'; document.getElementById('addr').textContent = j.address; }
   setTimeout(() => show('trc20'), 600);
   document.getElementById('tab-bep20').onclick = () => show('bep20');
   document.getElementById('tab-trc20').onclick = () => show('trc20');
   document.getElementById('copy').onclick = () => navigator.clipboard.writeText(document.getElementById('addr').textContent).catch(() => {});`),
  '/account/deposit/erc20': () => page('Deposit ERC20 – LuckyPay', `<h1>Deposit USDT (ERC20 · Ethereum)</h1><p>Send only USDT on the Ethereum network to this deposit address:</p><p><code id="addr">${W.erc20}</code> <button>Copy</button></p>`),
  '/account/history': () => page('History – LuckyPay', `<h1>Transaction history</h1><table><thead><tr><th>Date</th><th>Tx hash</th><th>From</th><th>Amount</th></tr></thead><tbody><tr><td>2026-09-30</td><td>${DECOY.txhash}</td><td>${DECOY.counterparty}</td><td>250 USDT</td></tr></tbody></table>`),
  '/account/withdraw': () => page('Withdraw – LuckyPay', `<h1>Withdraw</h1><label>Your withdrawal address <input id="to" value="${DECOY.withdraw}"></label><p>Withdrawals are processed within 24 h.</p>`),
  '/help': () => page('Help – LuckyPay', `<h1>How to deposit</h1><p>Copy the address shown on your deposit page. Example of what an address looks like: e.g. <code>${DECOY.example}</code> (example only, do not send).</p>`),
};
const site = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), logged = /session=ok/.test(req.headers.cookie ?? '');
  if (req.method === 'POST' && url.pathname === '/login') { let raw = ''; for await (const c of req) raw += c; res.writeHead(302, {location: '/account/deposit', 'set-cookie': 'session=ok; Path=/; HttpOnly'}); res.end(); return; }
  if (url.pathname.startsWith('/account') && !logged) { res.writeHead(302, {location: '/login'}); res.end(); return; }
  if (url.pathname === '/api/deposit-address') { if (!logged) { res.writeHead(401); res.end(); return; } res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({network: url.searchParams.get('network'), address: url.searchParams.get('network') === 'bep20' ? W.bep20 : W.trc20})); return; }
  const render = SITE_PAGES[url.pathname]; if (!render) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'}); res.end(render());
});
const sitePort = await listen(site);
const domain = 'luckypay.test', siteBase = `http://${domain}:${sitePort}`;

// ------------------------------------------------------------------ Main, the UI and the two workers
applyMigrations(dbFile);
const ui = await buildSuiteUi(join(work, 'ui'));
assert.ok(!ui.skipped, `UI build skipped: ${ui.skipped}`);
const serveUi = serveSuiteUi(ui.dir);
const extra = async (req, res, url) => {
  if (url.pathname === '/synthetic-form') { let raw = ''; for await (const c of req) raw += c; submissions++; results.form_body = decodeURIComponent(raw.replace(/\+/g, ' ')); res.writeHead(200, {'content-type': 'text/html'}); res.end('Your response has been recorded'); return true; }
  return serveUi(req, res, url);
};
const startMainProc = async () => { main = await startMain({dbFile, work, label: 'browser-e2e', extra, port: mainPort, log: main?.log ?? []}); mainPort = Number(new URL(main.url).port); };
await startMainProc();

function startWorker(name, script, env) {
  const dir = join(work, `${name}-runtime`); mkdirSync(dir, {recursive: true});
  const child = spawn(process.execPath, [...process.execArgv, localPath(script, import.meta.url)], {env: {...process.env, WORKER_DIR: dir, MAIN_PLATFORM_URL: main.url, ...env}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  child.out = ''; child.stdout.on('data', d => { child.out += d; }); child.stderr.on('data', d => { child.out += d; });
  children[name] = child;
  return new Promise((resolve, reject) => { const t = setInterval(() => { if (child.out.includes('WORKER_READY')) { clearInterval(t); resolve(); } }, 100); child.on('exit', code => { clearInterval(t); reject(new Error(`${name} exited ${code}: ${child.out.slice(-1500)}`)); }); });
}
const stopWorker = name => new Promise(r => { const c = children[name]; if (!c || c.exitCode !== null) return r(); c.removeAllListeners('exit'); c.on('exit', () => r()); c.kill('SIGKILL'); });
const startWi = () => startWorker('wallet', './lib/wallet-worker-proc.mjs', {WALLET_INVESTIGATOR_MODULE_KEY: KEYS.wallet_investigator, WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES: '1'});
await startWi();
await startWorker('form', './lib/form-worker-proc.mjs', {FORM_SUBMITTER_MODULE_KEY: KEYS.form_submitter, FORM_TARGET: `${main.url}/synthetic-form`});

// ------------------------------------------------------------------ control endpoint for the browser script
const events = [];
const control = createServer(async (req, res) => {
  const cmd = new URL(req.url, 'http://x').pathname.slice(1);
  try {
    if (cmd === 'stop-main') { await main.close(); main = null; }
    else if (cmd === 'start-main') await startMainProc();
    else if (cmd === 'kill-wi') await stopWorker('wallet');
    else if (cmd === 'start-wi') await startWi();
    else throw new Error(`unknown command ${cmd}`);
    events.push({cmd, at: new Date().toISOString()});
    res.writeHead(200); res.end('ok');
  } catch (error) { res.writeHead(500); res.end(String(error?.stack ?? error)); }
});
const controlPort = await listen(control);

try {
  const py = pythonCommand();
  const child = spawn(py.command, [...py.args, localPath('./wallet-browser-e2e.py', import.meta.url)], {windowsHide: true,
    env: pythonEnv({E2E: JSON.stringify({main: main.url, site: siteBase, domain, control: `http://127.0.0.1:${controlPort}`, key: KEYS.crypto_wallet_logger, profile: join(work, 'profile'), shots: process.env.WALLET_E2E_SHOTS ?? '',
      wallets: W, decoys: DECOY, ext: localPath('../integrations/crypto-wallet-logger-v08/', import.meta.url)})})});
  let out = '', err = ''; child.stdout.on('data', d => { out += d; process.stdout.write(d); }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('exit', r));
  if (code !== 0) throw new Error(`browser script failed (${code}):\n${err.slice(-4000)}\n--- wallet worker ---\n${children.wallet?.out.slice(-1500)}\n--- form worker ---\n${children.form?.out.slice(-1500)}`);
  results.browser = JSON.parse(out.trim().split('\n').pop());

  // ---------------------------------------------------------------- what Main recorded
  const inv = main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?", domain).id;
  const cand = a => main.one('SELECT * FROM wallet_candidates WHERE investigation_id=? AND address=?', inv, a);
  for (const [k, net] of [['trc20', 'tron'], ['bep20', 'bsc'], ['erc20', 'ethereum']]) {
    const c = cand(W[k]); assert.ok(c, `${k} deposit wallet reached Main`);
    assert.equal(c.validation_status, 'valid', `${k} validated`); assert.equal(c.validated_network, net, `${k} network`); assert.equal(c.best_context, 'deposit', `${k} is a deposit context`);
    assert.ok(['completed', 'partial'].includes(c.analysis_status), `${k} analysed (provider unavailable -> partial)`);
  }
  assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=? AND identity=?', inv, `evm:${W.bep20.toLowerCase()}`), 1, 'one candidate per wallet');
  const rep = main.one("SELECT rc.id,rc.status,rc.verification_status,c.summary FROM report_contents c JOIN report_candidates rc ON rc.id=c.candidate_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1", inv);
  assert.equal(rep.status, 'completed'); assert.equal(rep.verification_status, 'verified');
  const reported = JSON.parse(rep.summary).wallets.map(w => w.address).sort();
  assert.deepEqual(reported, Object.values(W).sort(), 'the report holds exactly the three deposit wallets, exact case');
  for (const [k, a] of Object.entries(DECOY)) { assert.ok(!reported.includes(a), `decoy ${k} not reported`); const c = cand(a); if (c) assert.notEqual(c.best_context === 'deposit' && c.validation_status === 'valid', true, `decoy ${k} is not a confirmed deposit wallet`); }
  assert.equal(submissions, 1, 'filed exactly once');
  for (const a of Object.values(W)) assert.ok(results.form_body.includes(a), 'the form received every reported wallet');
  // Every wallet came from Wallet Logger observations; nothing was typed or copied by hand.
  assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates c WHERE investigation_id=? AND NOT EXISTS (SELECT 1 FROM wallet_observations o WHERE o.candidate_id=c.id AND o.source_event_id IS NOT NULL)', inv), 0);
  // Wallet Investigator really was restarted with work waiting, and finished it afterwards.
  const restartAt = events.find(e => e.cmd === 'start-wi')?.at;
  assert.ok(restartAt && main.n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET' AND updated_at>=?", inv, restartAt.replace('T', ' ').slice(0, 19)) > 0, 'wallet jobs completed after the restart');
  const errors = main.log.filter(l => / 5\d\d /.test(l));
  assert.deepEqual(errors, [], 'no server errors');
  results.control = events.map(e => e.cmd);
  results.candidates = main.all('SELECT address,best_context,validation_status,analysis_status FROM wallet_candidates WHERE investigation_id=?', inv);
  delete results.form_body;
  console.log(JSON.stringify({ok: true, ...results}));
} finally {
  for (const name of Object.keys(children)) await stopWorker(name);
  if (main) await main.close().catch(() => {});
  site.close(); control.close();
  rmSync(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
