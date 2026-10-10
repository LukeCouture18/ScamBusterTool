// v4 wallet pipeline, end to end through the real Main routes and the real module code:
//   Logger wallet.observation v2 events (exact wire shape) -> one candidate per wallet -> Wallet
//   Investigator (real platform worker + validator, synthetic chain provider) validates every
//   candidate and analyses deposit wallets -> Main builds the report itself -> one approval bound
//   to the exact contents and destination -> Form Submitter (real worker, synthetic form) submits.
//
// Covers: duplicate observations, several wallets, an invalid checksum, an ambiguous EVM network,
// example / transaction-history decoys, a report that changes after you opened it, a destination
// change after approval (reported to Main, and noticed only by Form Submitter), duplicate approval
// and duplicate submission attempts, and a Main restart in the middle of the pipeline.
// No real network is touched; nothing is copied by hand.
//
// Run: node --experimental-sqlite --import tsx --import ./tests/lib/sqljs-fallback.mjs tests/wallet-pipeline-e2e.mjs
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {repoRoot} from './lib/portable.mjs';
import {applyMigrations, MODULE_KEYS as KEYS, startMain} from './lib/main-harness.mjs';

import {brokenEvm, evm, tron} from './lib/test-addresses.mjs';

const work = mkdtempSync(join(tmpdir(), 'mip-wallet-e2e-'));
const dbFile = join(work, 'main.sqlite');
const originalCwd = process.cwd();
let main, submissions = 0;
const results = {};
const wait = async (pred, label, ms = 60000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await pred()) return; await new Promise(r => setTimeout(r, 200)); } throw new Error(`Timed out waiting for ${label}`); };
let formMode = 'ok', challenged = 0;
const extra = async (req, res, url) => { if (url.pathname !== '/synthetic-form') return false; let raw = ''; for await (const c of req) raw += c;
  if (formMode === 'captcha') { challenged++; res.writeHead(200, {'content-type': 'text/html'}); res.end('<html><body><div class="g-recaptcha" data-sitekey="x"></div>Unusual traffic from your computer network</body></html>'); return true; }
  submissions++;
  if(formMode==='drop-confirmation'){res.destroy();return true;}
  res.writeHead(200, {'content-type': 'text/html'}); res.end('Your response has been recorded'); return true; };

let seq = 0;
function observation(site, address, family, cls, o = {}) {
  const page = {domain: site, url: `https://${site}${o.path ?? '/deposit'}`, frameUrl: `https://${site}${o.path ?? '/deposit'}`, title: o.title ?? 'Deposit'};
  const at = new Date().toISOString();
  return {id: `e2e-${++seq}-${Math.random().toString(16).slice(2)}`, type: 'wallet.observation', schemaVersion: '2.0.0', occurredAt: at, source: 'CryptoWalletLogger', sourceVersion: '0.9.0',
    payload: {observationId: o.observationId ?? `obs-${address.slice(-10)}-${o.method ?? 'text'}-${cls}-${site}`, address, family, candidateNetworks: o.candidates ?? (family === 'evm' ? ['ethereum', 'bsc', 'polygon'] : [family]),
      networkHint: o.hint === undefined ? null : o.hint, formatCheck: 'checksum_valid',
      context: {class: cls, confidence: o.confidence ?? (cls === 'deposit' ? .92 : .8), cues: o.cues ?? (cls === 'deposit' ? ['deposit heading', 'send only USDT to this address'] : ['example']), negativeCues: [], section: o.section ?? 'Deposit USDT', snippet: o.snippet ?? `Your deposit address ${address} Copy`},
      detection: {method: o.method ?? 'text', methods: [o.method ?? 'text'], afterInteraction: Boolean(o.after)}, page,
      evidence: {domPath: 'html>body>main>div'}, firstSeen: at, lastSeen: at, seenCount: o.seen ?? 1, provenance: {sensor: 'CryptoWalletLogger', version: '0.9.0', passive: true}}};
}

try {
  applyMigrations(dbFile);
  main = await startMain({dbFile, work, label: 'wallet-e2e', extra});
  const ok = (r, status = [200, 201, 202]) => { assert.ok([].concat(status).includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 800)}`); return r.body; };
  // v5 holds approval while bounded provider recovery is outstanding. The
  // original synthetic providers never recover: advance only the retry clock,
  // then let the real scheduler/worker exhaust its allowance. All original
  // report, exact-hash, restart and submission assertions remain below.
  const recoveryTicks = new Map();
  const reportView = async investigationId => {
    if (Date.now() - (recoveryTicks.get(investigationId) ?? 0) > 900) {
      recoveryTicks.set(investigationId, Date.now());
      main.sql.prepare("UPDATE director_retries SET next_at='2000-01-01T00:00:00Z' WHERE investigation_id=? AND status='parked'").run(investigationId);
      main.sql.exec("UPDATE director_provider_health SET next_probe_at='2000-01-01T00:00:00Z'");
      ok(await main.call('POST', `/api/v1/investigations/${investigationId}/director`, {}));
    }
    return ok(await main.call('GET', `/api/v1/suite/wallet-pipeline?investigation_id=${investigationId}`)).report;
  };
  const send = async ev => ok(await main.call('POST', '/api/v1/compat/logger', ev, KEYS.crypto_wallet_logger), [200, 202]);
  ok(await main.call('POST', '/api/v1/modules/crypto_wallet_logger/register', {module_version: '0.9.0', schema_version: '3.0', capabilities: ['wallet:log'], supported_event_types: []}, KEYS.crypto_wallet_logger));

  // Real Wallet Investigator worker (in-process, isolated data directory, synthetic chain provider).
  process.env.MAIN_PLATFORM_URL = main.url; process.env.WALLET_INVESTIGATOR_MODULE_KEY = KEYS.wallet_investigator; process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES = '1';
  mkdirSync(join(work, 'wallet-runtime')); process.chdir(join(work, 'wallet-runtime'));
  const walletWorker = await import(new URL('../integrations/wallet-investigator/server/integration/platform_worker.ts', import.meta.url));
  await walletWorker.startPlatformWorker();
  // Real Form Submitter worker, ticked by the test so the order of events can be controlled.
  process.env.FORM_SUBMITTER_MODULE_KEY = KEYS.form_submitter;
  mkdirSync(join(work, 'form-runtime')); process.chdir(join(work, 'form-runtime'));
  const {ReportWorker, durableStorage} = await import(new URL('../integrations/form-submitter/server/integration/platform_worker.ts', import.meta.url));
  process.chdir(originalCwd);
  const at = new Date().toISOString(), formUrl = 'https://docs.google.com/forms/d/e/TestLocal/viewform';
  const formConfig = version => ({formUrl, formId: 'TestLocal', formTitle: 'Synthetic report form', formVersionHash: version, verifiedAt: at,
    parsedSchema: {formId: 'TestLocal', formTitle: 'Synthetic report form', formUrl, versionHash: version, sections: [], allQuestions: [{id: '1', entryKey: 'entry.1', title: 'Site URL', type: 'SHORT_ANSWER', required: true, pageIndex: 1}, {id: '2', entryKey: 'entry.2', title: 'Wallets', type: 'PARAGRAPH', required: true, pageIndex: 1}], parsedAt: at},
    fieldMappings: [{id: 'site', fieldKey: 'siteUrl', label: 'Site URL', entryKey: 'entry.1', pageIndex: 1, required: true}, {id: 'w', fieldKey: 'walletsList', label: 'Wallets', entryKey: 'entry.2', pageIndex: 1, required: true}], multiWalletFormat: 'COMBINED_LIST'});
  durableStorage.syncFullState({settings: {username: 'e2e-analyst', teamInviteCode: 'e2e-code', autoSubmitGlobalEnabled: true}, formConfig: formConfig('v1')});
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https://docs.google.com/forms/d/e/TestLocal/') ? realFetch(`${main.url}/synthetic-form`, options) : realFetch(url, options);
  const form = new ReportWorker(main.url, KEYS.form_submitter);
  await form.register(); await form.reportDestination();
  // Paced like the real worker loop (which ticks every few seconds); a rate-limited tick is simply retried on the next one.
  let lastTick = 0;
  const tickForm = async () => { const gap = 1000 - (Date.now() - lastTick); if (gap > 0) await new Promise(r => setTimeout(r, gap)); lastTick = Date.now();
    process.chdir(join(work, 'form-runtime')); try { await form.tick(); } catch (error) { if (!/: 429$/.test(String(error?.message))) throw error; } finally { process.chdir(originalCwd); } };

  // ------------------------------------------------------------ site 1: observations as the Logger sends them
  const site = 'pay-scam-one.example';
  const W1 = await tron(1), W2 = evm(2), W3 = brokenEvm(evm(3)), W4 = evm(4), D1 = evm(5), D2 = evm(6), W5 = await tron(7);
  assert.notEqual(W3, evm(3)); assert.notEqual(W3.toLowerCase(), W3);
  const first = observation(site, W1, 'tron', 'deposit', {hint: {network: 'tron', token: 'USDT', source: 'selected-option'}});
  await send(first); await send(first);                                                                     // replay of the same event
  await send(observation(site, W1, 'tron', 'deposit', {method: 'qr', hint: {network: 'tron', token: 'USDT', source: 'qr-uri'}}));   // same wallet, second method
  await send(observation(site, W1, 'tron', 'deposit', {method: 'copy-control', path: '/wallet/deposit', after: true, hint: {network: 'tron', token: 'USDT', source: 'label'}}));
  await send(observation(site, W2, 'evm', 'deposit', {hint: {network: 'bsc', token: 'USDT', source: 'selected-option'}, section: 'Deposit USDT · BEP20'}));
  await send(observation(site, W3, 'evm', 'deposit', {hint: {network: 'ethereum', token: 'USDT', source: 'label'}}));
  await send(observation(site, W4, 'evm', 'deposit', {hint: null, section: 'Deposit'}));                    // no network shown anywhere
  await send(observation(site, D1, 'evm', 'example', {path: '/help', section: 'How to deposit', cues: ['example', 'e.g.']}));
  // Logger 0.9 still sends the legacy evidence event for a deposit section; it must not mint a second wallet entity.
  await send({id: `legacy-${Date.now()}`, type: 'evidence.added', schemaVersion: '1.0.0', occurredAt: new Date().toISOString(), source: 'CryptoWalletLogger', sourceVersion: '0.9.0',
    payload: {domain: site, sourceUrl: `https://${site}/deposit`, wallet: W1, network: 'TRC20', token: 'USDT', recordType: 'deposit_option', context: `Deposit USDT TRC20 ${W1}`, confidence: 'high', evidenceItems: []}});
  // A token-only hint (the page says "USDT" but names no network) is how the Logger reports that: network null.
  const tokenOnly = observation(site, W4, 'evm', 'deposit', {method: 'copy-control', hint: {network: null, token: 'USDT', source: 'nearby-text'}});
  assert.equal((await main.call('POST', '/api/v1/compat/logger', tokenOnly, KEYS.crypto_wallet_logger)).status, 202, 'a token-only network hint is accepted');
  await send(observation(site, D2, 'evm', 'transaction_history', {path: '/history', section: 'Recent transactions', cues: ['transaction table', 'tx hash column']}));

  const inv = main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?", site).id;
  const cand = a => main.one('SELECT * FROM wallet_candidates WHERE investigation_id=? AND address=?', inv, a);
  assert.equal(main.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=?', inv), 6, 'one candidate per wallet (duplicates merged)');
  assert.equal(cand(W1).observations, 3, 'three distinct observations of W1; the replayed event is not a fourth');
  assert.equal(cand(W1).address, W1, 'base58 address kept exactly as shown');

  // ------------------------------------------------------------ validation and analysis happen by themselves
  await wait(() => ['valid', 'invalid', 'network_ambiguous'].every(s => main.n('SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=? AND validation_status=?', inv, s) > 0)
    && main.n("SELECT COUNT(*) n FROM wallet_candidates WHERE investigation_id=? AND validation_status IN ('pending','queued')", inv) === 0, 'every candidate validated', 120000);
  assert.equal(cand(W1).validation_status, 'valid'); assert.equal(cand(W1).validated_network, 'tron');
  assert.equal(cand(W2).validation_status, 'valid'); assert.equal(cand(W2).validated_network, 'bsc');
  assert.equal(cand(W3).validation_status, 'invalid', 'a broken EIP-55 checksum is rejected by Wallet Investigator');
  assert.equal(cand(W4).validation_status, 'network_ambiguous', 'an EVM deposit address with no network shown is not guessed');
  assert.equal(cand(D1).validation_status, 'network_ambiguous', 'an EVM example with no network shown is ambiguous, never guessed'); assert.equal(cand(D1).best_context, 'example');
  assert.ok(['none', 'skipped'].includes(cand(D1).analysis_status), 'examples are validated but not analysed');
  await wait(() => ['completed', 'partial'].includes(cand(W1).analysis_status) && ['completed', 'partial'].includes(cand(W2).analysis_status), 'deposit wallets analysed', 120000);
  results.validation = Object.fromEntries([['W1', W1], ['W2', W2], ['W3', W3], ['W4', W4], ['D1', D1], ['D2', D2]].map(([k, a]) => [k, `${cand(a).validation_status}/${cand(a).analysis_status}`]));

  // Main's scheduler ticks as it does in a deployment; it must not disturb the pipeline.
  for (let i = 0; i < 3; i++) ok(await main.call('POST', '/api/v1/ops/tick'));
  assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='ANALYZE_WALLET' AND COALESCE(json_extract(payload,'$.pipeline'),'')<>'wallet-v4'"), 0, 'the scheduler does not queue a second, older-style analysis of pipeline wallets');
  // ------------------------------------------------------------ the report was built without anyone touching it
  let report;
  await wait(async () => { report = await reportView(inv); return report?.state === 'ready_to_report'; }, 'ready to report', 120000)
    .catch(error => { console.error('REPORT', JSON.stringify(report), JSON.stringify(main.all('SELECT address,validation_status,analysis_status,best_context FROM wallet_candidates WHERE investigation_id=?', inv))); throw error; });
  const view = ok(await main.call('GET', `/api/v1/suite/wallet-pipeline?domain=${site}`));
  assert.deepEqual({observations: view.counts.observations, validated: view.counts.validated, rejected: view.counts.rejected, confirmed: view.counts.confirmed_deposit}, {observations: 9, validated: 2, rejected: 1, confirmed: 2});
  const inReport = report.summary.wallets.map(w => w.address).sort();
  assert.deepEqual(inReport, [W1, W2].sort(), 'exactly the confirmed deposit wallets, exact case');
  assert.ok(report.warnings.some(w => w.includes(W3) && w.includes('invalid')) && report.warnings.some(w => w.includes(W4) && w.includes('network')), JSON.stringify(report.warnings));
  const snap = JSON.parse(main.one('SELECT evidence_snapshot FROM report_candidates WHERE id=?', report.candidate_id).evidence_snapshot);
  for (const w of snap.wallets) for (const e of w.deposit_evidence) assert.ok(e.evidence_id && e.page_url && e.observed_at && e.method, 'every wallet carries its provenance');
  assert.equal(snap.wallets.find(w => w.address === W1).deposit_evidence.length, 3, 'every occurrence is kept as evidence');
  assert.ok(view.wallets.find(w => w.address === W1).why.cues.length > 0, 'the UI can say why it is a deposit wallet');

  // ------------------------------------------------------------ stale approval: the report changes after you opened it
  const opened = report.content_sha256;
  await send(observation(site, W5, 'tron', 'deposit', {path: '/deposit/trc20', hint: {network: 'tron', token: 'USDT', source: 'selected-option'}}));
  await send(observation(site, W5, 'tron', 'deposit', {path: '/deposit/trc20', method: 'qr', hint: {network: 'tron', token: 'USDT', source: 'qr-uri'}}));
  const stale = await main.call('PATCH', `/api/v1/investigations/${inv}/report`, {candidate_id: report.candidate_id, action: 'approve', reason: 'Looks right', content_sha256: opened});
  assert.equal(stale.status, 409, 'approving what you saw fails once the report has changed'); assert.equal(stale.body.error.code, 'REPORT_CHANGED');
  await wait(async () => { report = await reportView(inv); return report?.state === 'ready_to_report' && report.summary.wallets.length === 3; }, 'updated report with W5', 120000);
  assert.notEqual(report.content_sha256, opened);
  const noHash = await main.call('PATCH', `/api/v1/investigations/${inv}/report`, {candidate_id: report.candidate_id, action: 'approve', reason: 'Looks right'});
  assert.equal(noHash.status, 409, 'an approval must name the exact contents');

  // ------------------------------------------------------------ Main restarts in the middle; nothing is lost
  // Same address as before, as in production: both workers must reconnect by themselves.
  const port = Number(new URL(main.url).port);
  await main.close(); main = await startMain({dbFile, work, label: 'wallet-e2e-restart', extra, log: main.log, port});
  assert.equal(form.base, main.url);
  report = ok(await main.call('GET', `/api/v1/suite/wallet-pipeline?investigation_id=${inv}`)).report;
  assert.equal(report.state, 'ready_to_report');

  // ------------------------------------------------------------ one approval -> Form Submitter submits
  ok(await main.call('PATCH', `/api/v1/investigations/${inv}/report`, {candidate_id: report.candidate_id, action: 'approve', reason: 'Wallets, evidence and destination reviewed', content_sha256: report.content_sha256}));
  const again = await main.call('PATCH', `/api/v1/investigations/${inv}/report`, {candidate_id: report.candidate_id, action: 'approve', reason: 'twice', content_sha256: report.content_sha256});
  assert.equal(again.status, 409, 'a second approval of the same report is refused');
  await wait(async () => { await tickForm(); return main.one('SELECT status FROM report_candidates WHERE id=?', report.candidate_id).status === 'completed'; }, 'report submitted', 60000).catch(error => { console.error('SUBMIT', JSON.stringify(main.all('SELECT rc.status,rc.submission_job_id,j.status js FROM report_candidates rc LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE rc.id=?', report.candidate_id)), JSON.stringify(main.all('SELECT je.event_type,je.message FROM job_events je JOIN report_candidates rc ON rc.submission_job_id=je.job_id WHERE rc.id=? ORDER BY je.created_at', report.candidate_id))); throw error; });
  assert.equal(submissions, 1);
  assert.equal(main.one('SELECT verification_status FROM report_candidates WHERE id=?', report.candidate_id).verification_status, 'verified');
  // More sightings of already-reported wallets do not create a new report or a second submission.
  await send(observation(site, W1, 'tron', 'deposit', {method: 'input', path: '/assets', hint: {network: 'tron', token: 'USDT', source: 'label'}}));
  for (let i = 0; i < 3; i++) await tickForm();
  assert.equal(submissions, 1, 'no duplicate submission');
  assert.equal(main.n("SELECT COUNT(*) n FROM report_candidates WHERE investigation_id=? AND status='needs_review'", inv), 0, 'no new draft for wallets already reported');
  results.site1 = {submissions, wallets_reported: 3};

  // ------------------------------------------------------------ site 2: destination changes after approval
  const site2 = 'pay-scam-two.example', W6 = await tron(11), W7 = evm(12);
  await send(observation(site2, W6, 'tron', 'deposit', {hint: {network: 'tron', token: 'USDT', source: 'selected-option'}}));
  await send(observation(site2, W6, 'tron', 'deposit', {method: 'qr', hint: {network: 'tron', token: 'USDT', source: 'qr-uri'}}));
  const inv2 = main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?", site2).id;
  let r2;
  await wait(async () => { r2 = await reportView(inv2); return r2?.state === 'ready_to_report'; }, 'site 2 ready', 120000);
  ok(await main.call('PATCH', `/api/v1/investigations/${inv2}/report`, {candidate_id: r2.candidate_id, action: 'approve', reason: 'Reviewed', content_sha256: r2.content_sha256}));
  // (a) the form changes and Form Submitter tells Main before it submits: the approval is withdrawn.
  durableStorage.syncFullState({settings: {username: 'e2e-analyst', teamInviteCode: 'e2e-code', autoSubmitGlobalEnabled: true}, formConfig: formConfig('v2')});
  await form.reportDestination();
  assert.equal(main.one('SELECT status FROM report_candidates WHERE id=?', r2.candidate_id).status, 'stale', 'approval withdrawn when the destination changes');
  for (let i = 0; i < 2; i++) await tickForm();
  assert.equal(submissions, 1, 'nothing submitted under the old approval');
  let r2b;
  await wait(async () => { r2b = (await main.call('GET', `/api/v1/suite/wallet-pipeline?investigation_id=${inv2}`)).body.report; return r2b?.state === 'ready_to_report' && r2b.candidate_id !== r2.candidate_id; }, 're-approval requested', 30000);
  assert.equal(r2b.summary.destination.version_hash, 'v2');
  // (b) approve again, then the form changes but only Form Submitter knows: it refuses to submit.
  ok(await main.call('PATCH', `/api/v1/investigations/${inv2}/report`, {candidate_id: r2b.candidate_id, action: 'approve', reason: 'Reviewed', content_sha256: r2b.content_sha256}));
  durableStorage.syncFullState({settings: {username: 'e2e-analyst', teamInviteCode: 'e2e-code', autoSubmitGlobalEnabled: true}, formConfig: formConfig('v3')});
  const reported = form.reportDestination; form.reportDestination = async () => {};          // Main is not told
  await wait(async () => { await tickForm(); return ['needs-review'].includes(main.one('SELECT j.status s FROM report_candidates c JOIN jobs j ON j.id=c.submission_job_id WHERE c.id=?', r2b.candidate_id)?.s); }, 'Form Submitter stops on a changed destination', 60000).catch(error => { console.error('DEST', submissions, JSON.stringify(main.all('SELECT rc.id,rc.status,rc.submission_job_id,j.status js FROM report_candidates rc LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE rc.investigation_id=?', inv2)), JSON.stringify(main.all('SELECT id,status,action FROM approval_gates WHERE investigation_id=?', inv2)), JSON.stringify(main.all('SELECT j.job_type,j.status,je.event_type,je.message FROM jobs j JOIN job_events je ON je.job_id=j.id WHERE j.investigation_id=? ORDER BY je.created_at', inv2))); throw error; });
  assert.equal(submissions, 1, 'Form Submitter does not submit to a destination nobody approved');
  form.reportDestination = reported;
  results.site2 = {stale_on_destination_change: true, worker_refused_unapproved_destination: true};

  // ------------------------------------------------------------ site 4: the form asks for human verification -> Form Submitter stops for you
  const site4 = 'pay-scam-four.example', W8 = await tron(21);
  await form.reportDestination();   // site 2 left Form Submitter on form v3 without telling Main
  await send(observation(site4, W8, 'tron', 'deposit', {hint: {network: 'tron', token: 'USDT', source: 'selected-option'}}));
  await send(observation(site4, W8, 'tron', 'deposit', {method: 'qr', hint: {network: 'tron', token: 'USDT', source: 'qr-uri'}}));
  const inv4 = main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?", site4).id;
  let r4;
  await wait(async () => { r4 = await reportView(inv4); return r4?.state === 'ready_to_report'; }, 'site 4 ready', 120000);
  ok(await main.call('PATCH', `/api/v1/investigations/${inv4}/report`, {candidate_id: r4.candidate_id, action: 'approve', reason: 'Reviewed', content_sha256: r4.content_sha256}));
  formMode = 'captcha';
  const jobOf4 = () => main.one('SELECT j.status s,j.progress_message m FROM report_candidates c JOIN jobs j ON j.id=c.submission_job_id WHERE c.id=?', r4.candidate_id);
  await wait(async () => { await tickForm(); return jobOf4()?.s === 'needs-review'; }, 'Form Submitter stops at the CAPTCHA', 60000).catch(error => { console.error('CAPTCHA', challenged, JSON.stringify(main.all('SELECT rc.status,j.status js,j.progress_message FROM report_candidates rc LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE rc.investigation_id=?', inv4)), JSON.stringify(main.all('SELECT j.job_type,j.status,je.event_type,je.message FROM jobs j JOIN job_events je ON je.job_id=j.id WHERE j.investigation_id=? ORDER BY je.created_at', inv4)), JSON.stringify(main.all('SELECT outcome,reason FROM planner_decisions WHERE investigation_id=? ORDER BY created_at', inv4))); throw error; });
  for (let i = 0; i < 3; i++) await tickForm();
  assert.equal(challenged, 1, 'the challenge page is met once; nothing retries or works around it');
  assert.equal(submissions, 1, 'no submission recorded for site 4');
  const v4view = ok(await main.call('GET', `/api/v1/suite/wallet-pipeline?investigation_id=${inv4}`));
  assert.match(String(v4view.report.submission?.message ?? ''), /Stopped for you/, JSON.stringify(v4view.report.submission));
  formMode = 'ok';
  results.site4 = {stopped_for_human_verification: true, message: v4view.report.submission.message};

  // Receiver accepts the submission but the confirmation connection disappears.
  // Its side effect happened once; Main must park the uncertain outcome.
  const site5='pay-scam-lost-confirmation.example',W9=await tron(31);
  await send(observation(site5,W9,'tron','deposit',{hint:{network:'tron',token:'USDT',source:'selected-option'}}));
  await send(observation(site5,W9,'tron','deposit',{method:'qr',hint:{network:'tron',token:'USDT',source:'qr-uri'}}));
  const inv5=main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?",site5).id;
  let r5;await wait(async()=>{r5=await reportView(inv5);return r5?.state==='ready_to_report';},'lost-confirmation report ready',120000);
  ok(await main.call('PATCH',`/api/v1/investigations/${inv5}/report`,{candidate_id:r5.candidate_id,action:'approve',reason:'Reviewed exact contents',content_sha256:r5.content_sha256}));
  formMode='drop-confirmation';const acceptedBefore=submissions;
  await wait(async()=>{await tickForm();return main.one('SELECT j.status s FROM jobs j JOIN report_candidates c ON c.submission_job_id=j.id WHERE c.id=?',r5.candidate_id)?.s==='needs-review';},'lost response parks submission',60000);
  assert.equal(submissions,acceptedBefore+1,'receiver accepted exactly one POST');
  const countBefore=main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',inv5);
  for(let n=0;n<20;n++)ok(await main.call('POST',`/api/v1/investigations/${inv5}/director`,{}));
  for(let n=0;n<3;n++)await tickForm();
  assert.equal(submissions,acceptedBefore+1,'lost confirmation is never blindly resubmitted');
  assert.equal(main.n('SELECT COUNT(*) n FROM jobs WHERE investigation_id=?',inv5),countBefore);
  results.lost_confirmation={accepted_posts:1,automatic_resubmissions:0,needs_review:true};formMode='ok';

  // ------------------------------------------------------------ site 3: an EVM deposit wallet with only an ambiguous network
  const site3 = 'pay-scam-three.example';
  await send(observation(site3, W7, 'evm', 'deposit', {hint: null}));
  const inv3 = main.one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=?", site3).id;
  await wait(() => main.one('SELECT validation_status s FROM wallet_candidates WHERE investigation_id=?', inv3)?.s === 'network_ambiguous', 'ambiguous', 60000);
  const v3 = ok(await main.call('GET', `/api/v1/suite/wallet-pipeline?investigation_id=${inv3}`));
  assert.equal(v3.report.state, 'waiting', 'no report from an ambiguous wallet alone');

  // One wallet entity per wallet: the same address must not appear under several entity keys.
  const keys = main.all("SELECT e.canonical_key k FROM entities e WHERE e.entity_type='wallet'").map(r => r.k);
  const byAddress = new Map();
  for (const k of keys) { const a = k.split(':').pop().toLowerCase(); byAddress.set(a, [...(byAddress.get(a) ?? []), k]); }
  const split = [...byAddress.values()].filter(v => v.length > 1);
  assert.deepEqual(split, [], `wallets split across entity keys: ${JSON.stringify(split)} ${JSON.stringify(main.all("SELECT e.canonical_key,o.source_module,o.record_type FROM entities e LEFT JOIN observations o ON o.entity_id=e.id WHERE e.entity_type='wallet' AND e.canonical_key LIKE 'unknown:%'"))}`);
  const errors = main.log.filter(l => / 5\d\d /.test(l));
  assert.deepEqual(errors, [], 'no server errors');
  console.log(JSON.stringify({ok: true, ...results}));
} finally {
  process.chdir(originalCwd);
  if (main) await main.close().catch(() => {});
  rmSync(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
