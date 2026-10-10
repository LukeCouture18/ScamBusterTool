// Release gate for the unified investigation suite: the whole operator workflow, end to end,
// through the real Main route handlers and the real module code, then the real suite UI in a
// browser.
//
//   Site Finder (its real next-generation engine on the synthetic hard world) delivers new sites
//   -> you review one in the suite (Site Finder · Find sites) -> Main routes the site investigation
//   -> the Site Investigator bridge (real v0.1 schema and exporter) delivers page evidence and a
//   wallet -> Wallet Logger (its real sync code) captures the same wallet passively -> Wallet
//   Investigator (its real platform worker and engine, synthetic chain provider) analyses it ->
//   an Operation Hunter snapshot places the site in an operation and asks for related sites, which
//   Main turns into a budgeted Site Finder job -> you prepare and approve a report -> Form
//   Submitter (its real worker, synthetic form receiver) files it and Main records the confirmation.
//
// Then a browser walks the five tools (Home, Site Finder, Wallet Investigator, Wallet Logger,
// Form Submitter, Operation Hunter, Advanced) and checks that each answers "what happened, what
// was found, why it matters, what next", that the investigation context (site, wallet, operation)
// follows you between tools, and that evidence is labelled by what it is (seen / analysis).
//
// No real network is touched. The Operation Hunter step posts a snapshot in Hunter's wire shape;
// Hunter's own engine against Main is covered by tests/joined-finder-main-hunter.mjs.
//
// Run: node --experimental-sqlite --import tsx --import ./tests/lib/sqljs-fallback.mjs tests/suite-workflow.mjs
// (or: node scripts/run-tests.mjs suite)
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {localPath, pythonCommand, pythonEnv, repoRoot, runPythonJson} from './lib/portable.mjs';
import {applyMigrations, MODULE_KEYS as KEYS, startMain} from './lib/main-harness.mjs';
import {buildSuiteUi, serveSuiteUi} from './ui/build.mjs';
import {buildAllPagesUi, serveAllPagesUi} from './ui/build-all.mjs';

const work = mkdtempSync(join(tmpdir(), 'mip-suite-'));
const dbFile = join(work, 'main.sqlite');
const shots = process.env.SUITE_SCREENSHOTS || join(work, 'screens');
mkdirSync(shots, {recursive: true});
const originalCwd = process.cwd();
const results = {};
let main;
let submissions = 0;
const waitFor = async (predicate, label, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  // ------------------------------------------------------------------ discovery (before Main starts)
  const finder = runPythonJson(localPath('./finder-ng-batches.py', import.meta.url));
  assert.ok(finder.batches.length >= 3, 'the next-generation engine delivers several sites');
  const target = finder.batches.find(b => b.pivot && b.truth !== 'benign') ?? finder.batches[0];
  const domain = target.domain;
  const siExport = runPythonJson(localPath('./site-bridge-synthetic.py', import.meta.url), {env: {MIP_BATCH_JSON: '1'}}).batch;

  // ------------------------------------------------------------------ Main + the suite UI
  applyMigrations(dbFile);
  const ui = await buildSuiteUi(join(work, 'ui'));
  const serveUi = ui.skipped ? null : serveSuiteUi(ui.dir);
  let sweepUi = null;          // tests/ui/build-all.mjs: every real page (cookie mip_ui=all), for the interaction sweep
  const extra = async (req, res, url) => {
    if (url.pathname === '/synthetic-form') {
      let raw = ''; for await (const c of req) raw += c;
      assert.match(raw, /entry\.1=/); submissions++;
      res.writeHead(200, {'content-type': 'text/html'}); res.end('Your response has been recorded'); return true;
    }
    if (sweepUi && await sweepUi(req, res, url)) return true;
    return serveUi ? serveUi(req, res, url) : false;
  };
  main = await startMain({dbFile, work, label: 'suite', extra});
  const {call, one, n} = main;
  // A human decision, taken by clicking the real button in the UI (tests/ui-act.py) and returning the
  // API response that click produced. Without a browser the same request is sent directly.
  results.ui_decisions = 0;
  const uiAct = async (spec, fallback) => {
    if (ui.skipped) return fallback();
    const py = pythonCommand();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(py.command, [...py.args, localPath('./ui-act.py', import.meta.url)], {env: pythonEnv({UI_ACT: JSON.stringify({base: main.url, ...spec})}), windowsHide: true});
      let o = '', e = ''; child.stdout.on('data', d => { o += d; }); child.stderr.on('data', d => { e += d; if(process.env.SUITE_PROGRESS)process.stderr.write(d); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(o) : reject(new Error(`UI action ${JSON.stringify(spec)} exited ${code}:\n${o.slice(-2000)}\n${e.slice(-2000)}`)));
    });
    const r = JSON.parse(out.trim().split(/\r?\n/).pop());
    if (r.skipped) { if (process.env.MIP_REQUIRE_UI === '1') throw new Error(r.skipped); return fallback(); }
    assert.deepEqual(r.errors, [], `browser errors while clicking ${spec.button}`);
    results.ui_decisions++;
    return r;
  };
  const ok = (r, status = [200, 201, 202]) => { assert.ok([].concat(status).includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`); return r.body; };
  for (const [module, caps] of [['site_finder', ['site:discover', 'site:relate']], ['site_investigator', ['site:investigate']], ['crypto_wallet_logger', ['wallet:log']]])
    ok(await call('POST', `/api/v1/modules/${module}/register`, {module_version: 'suite-test', schema_version: '3.0', capabilities: caps, supported_event_types: []}, KEYS[module]));

  // 1. Site Finder delivers; the suite shows the queue with plain reasons.
  for (const b of finder.batches) {
    const body = ok(await call('POST', '/api/v1/ingest/site_finder', {schema_version: '3.0', batch_id: b.batch_id, sent_at: new Date().toISOString(), records: b.records}, KEYS.site_finder));
    assert.equal(body.status, 'accepted', JSON.stringify(body.errors));
  }
  // Site Finder reports its hunts (the real hunts of the engine run above) through the real route.
  assert.ok(finder.hunts.length >= 1, 'the engine opened hunts');
  ok(await call('POST', '/api/v1/finder/hunts', {hunts: finder.hunts}, KEYS.site_finder), 202);
  let view = ok(await call('GET', '/api/v1/suite/finder'));
  assert.equal(view.hunts.length, Math.min(80, finder.hunts.length), 'Main shows every reported hunt');
  assert.equal(view.queue.length, finder.batches.length, 'every delivered site waits for review');
  const card = view.queue.find(c => c.domain === domain);
  assert.ok(card && card.why.length >= 1, 'each card explains why it is worth a look');
  assert.ok(view.queue.every(c => !/proves|confirmed scam/i.test(c.why.join(' '))), 'reasons never overstate');
  assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE job_type='INVESTIGATE_SITE'"), 0, 'nothing is investigated before you decide');
  results.discovery = {delivered: finder.batches.length, target: domain, reached_by: card.route?.route ?? 'direct'};

  // 2. You mark it useful from the suite; Main routes the site investigation.
  let act = ok(await uiAct({path: '/finder', within: `li[data-domain="${domain}"]`, button: '^Useful$', method: 'POST', api: '/api/v1/suite/actions'},
    () => call('POST', '/api/v1/suite/actions', {action: 'review', domain, decision: 'useful'})), 202);
  assert.match(act.message, /investigate/i);
  assert.equal((await call('POST', '/api/v1/suite/actions', {action: 'review', domain, decision: 'skip', reason: 'made_up'})).status, 400, 'unknown skip reasons are rejected');
  const cand = one('SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?', domain);
  const inv = one('SELECT id,external_id FROM investigations WHERE id=?', cand.investigation_id);
  assert.ok(inv, 'the reviewed site has an investigation');
  await waitFor(() => n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'", inv.id) === 1, 'site investigation routed');
  const again = ok(await uiAct({path: `/finder?site=${encodeURIComponent(domain)}`, button: '^Investigate (site|again)$', method: 'POST', api: '/api/v1/suite/actions'},
    () => call('POST', '/api/v1/suite/actions', {action: 'investigate_site', domain})), [202, 409]);
  assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE'", inv.id), 1, 'asking twice does not duplicate the investigation');

  // 3. The site investigation (Site Finder · investigation) delivers page evidence and a wallet.
  const claim = ok(await call('POST', '/api/v1/modules/site_investigator/jobs/claim', {}, KEYS.site_investigator));
  const job = claim.job; assert.ok(job, JSON.stringify(claim));
  const si = JSON.parse(JSON.stringify(siExport).replaceAll('synthetic.example', domain));
  si.origin_job_id = job.id; si.batch_id = `si:${job.id}:suite`; si.sent_at = new Date().toISOString();
  for (const rows of Object.values(si.records)) for (const row of rows) row.investigation_id = inv.external_id;
  const siResult = ok(await call('POST', '/api/v1/ingest/site_investigator', si, KEYS.site_investigator), 202);
  assert.equal(siResult.error_count, 0, JSON.stringify(siResult.errors));
  ok(await call('PATCH', `/api/v1/modules/site_investigator/jobs/${job.id}`, {action: 'complete', result: {batch_id: si.batch_id}}, KEYS.site_investigator));
  const address = '0x71c841094df8cf7fa128565551f337f74c7dbb94';
  const walletKey = `ethereum:${address}`;

  // 4. Wallet Logger (passive) records the same wallet on the same site.
  const scope = {}; scope.globalThis = scope;
  vm.runInNewContext(readFileSync(join(repoRoot, 'integrations', 'crypto-wallet-logger-v08', 'main-platform-sync.js'), 'utf8'), scope);
  const at = new Date().toISOString();
  const payload = scope.MainPlatformSync.walletEvent({id: 'suite-wallet-1', address, network: 'ethereum', confidence: 'high', context: 'Deposit address shown on the public deposit page', evidenceItems: [], evidenceTags: [], detectionMethods: ['text'], foundAt: at, lastSeenAt: at},
    {domain, topPageUrl: `https://${domain}/deposit`, sourcePageUrl: `https://${domain}/deposit`, pageTitle: 'Deposit'}, at);
  ok(await call('POST', '/api/v1/compat/logger', {id: 'suite-logger-wallet', type: 'wallet.observed', schemaVersion: '1.0.0', occurredAt: at, source: 'CryptoWalletLogger', sourceVersion: '0.8.0', payload}, KEYS.crypto_wallet_logger), 202);
  const replay = await call('POST', '/api/v1/compat/logger', {id: 'suite-logger-wallet', type: 'wallet.observed', schemaVersion: '1.0.0', occurredAt: at, source: 'CryptoWalletLogger', sourceVersion: '0.8.0', payload}, KEYS.crypto_wallet_logger);
  assert.equal(replay.body.replayed, true, 'a queued capture sent twice is stored once');
  assert.equal(n("SELECT COUNT(*) n FROM entities WHERE entity_type='wallet' AND canonical_key=?", walletKey), 1, 'one wallet, whichever tool saw it');

  // 5. Wallet Investigator (real worker) analyses the wallet.
  process.env.MAIN_PLATFORM_URL = main.url;
  process.env.WALLET_INVESTIGATOR_MODULE_KEY = KEYS.wallet_investigator;
  process.env.WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES = '1';
  mkdirSync(join(work, 'wallet-runtime')); process.chdir(join(work, 'wallet-runtime'));
  const walletWorker = await import(new URL('../integrations/wallet-investigator/server/integration/platform_worker.ts', import.meta.url));
  await walletWorker.startPlatformWorker();
  process.chdir(originalCwd);
  await waitFor(() => n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET'", inv.id) >= 1, 'wallet analysis planned');
  await waitFor(() => ['completed', 'needs-review'].includes(one("SELECT status FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET' ORDER BY created_at DESC LIMIT 1", inv.id)?.status), 'wallet analysis finished', 40000);
  await waitFor(() => n("SELECT COUNT(*) n FROM observations WHERE source_module='wallet_investigator' AND record_type='transaction'") > 0, 'on-chain records');
  const w = ok(await call('GET', `/api/v1/suite/wallet?id=${address}`));
  assert.ok(w.transactions.length > 0, 'the wallet view shows the recorded transactions');
  assert.ok(w.explain.some(s => /recorded \d+ transaction/.test(s)), 'money flow is explained in words');
  assert.ok(w.sites.some(s => s.domain === domain), 'the wallet links back to the site it was shown on');
  assert.ok(!w.explain.join(' ').match(/\bproves?\b(?! of)/i) || /not (by itself )?proof/.test(w.explain.join(' ')), 'no ownership claims');
  results.wallet = {transactions: w.transactions.length, counterparties: w.counterparties.length};

  // 6. An Operation Hunter snapshot places the site and wallet in an operation and asks for more sites.
  const others = finder.batches.filter(b => b.domain !== domain).slice(0, 2).map(b => b.domain);
  const opExt = 'hunter:op:suite-1';
  const snap = {schema_version: '2.0',
    operation: {external_id: opExt, code: 'OP-7', name: 'Suite test operation', status: 'ACTIVE', headline: 'Three look-alike yield sites share a build and a deposit wallet.', narrative: 'Reconstructed from shared operator settings.', confidence: 0.7, depth_score: 40, hunter_version: '2.0.0',
      investigation_id: inv.id, top_findings: [{title: 'Same build file on three sites', basis: 'observed'}]},
    model: {status: 'active', status_reason: 'New sites appeared this week', counts: {members: 4}, leads: [{title: 'Look for the next wave on new domains', value: 0.7}], unknowns: ['Who hosts the payment page'], version: 1},
    members: [{entity_type: 'site', canonical_key: domain, role: 'seed', probability: 0.9, state: 'live', why: 'Same build file and deposit wallet'},
      ...others.map((d, i) => ({entity_type: 'site', canonical_key: d, role: i ? 'probable' : 'member', probability: 0.55, state: 'live', why: 'Same page template'})),
      {entity_type: 'wallet', canonical_key: address, role: 'collection', probability: 0.8, state: 'active', why: 'Deposit address shown on member sites'}],
    proposals: [{key: 'find_related:thin:3', kind: 'find_related', target_type: 'operation', target_key: opExt, seeds: [domain, ...others], value: 0.6, reason: 'Only a few member sites known; look for more like them'}]};
  const op = ok(await call('POST', '/api/v1/operations/sync', snap, KEYS.operation_hunter));
  assert.equal(op.proposals.work, 1, JSON.stringify(op.proposals));
  ok(await call('POST', '/api/v1/operations/sync', snap, KEYS.operation_hunter));
  assert.equal(n("SELECT COUNT(*) n FROM work_items WHERE kind='find_related_sites'"), 1, 'the same Hunter request twice is one piece of work');
  ok(await call('POST', '/api/v1/ops/tick'));
  const related = one("SELECT payload FROM jobs WHERE job_type='FIND_RELATED_SITES' AND json_extract(payload,'$.source')='hunter'");
  assert.ok(related, 'Main turns Hunter\'s evidence gap into a Site Finder discovery job (within its budget)');
  const rp = JSON.parse(related.payload);
  assert.ok(rp.seeds.includes(domain) && rp.operation_id, JSON.stringify(rp));
  const ctx = ok(await call('GET', '/api/v1/finder/context?since=', undefined, KEYS.site_finder));
  assert.ok(ctx.known.some(s => s.domain === others[0] && s.source !== 'site_finder'), 'Site Finder learns which sites Main and Hunter already hold, so it does not bring them back');
  const siteView = ok(await call('GET', `/api/v1/suite/site?domain=${domain}`));
  assert.equal(siteView.operations.length, 1);
  const eth = siteView.wallets.find(x => x.key === walletKey);
  assert.ok(eth && eth.seen_by.length >= 3, `the wallet shows every tool that saw it: ${JSON.stringify(siteView.wallets)}`);
  const tron = siteView.wallets.find(x => x.network === 'tron');
  if (tron) assert.match(tron.address, /[A-Z]/, 'case-sensitive addresses are shown as reported, not lower-cased');
  assert.ok(siteView.evidence.some(e => e.basis.basis === 'observed'), 'observed evidence is labelled as seen');
  assert.match(siteView.note, /do not prove/);

  // 7. Report: prepare from the suite, approve, Form Submitter files it.
  process.env.FORM_SUBMITTER_MODULE_KEY = KEYS.form_submitter;
  mkdirSync(join(work, 'form-runtime')); process.chdir(join(work, 'form-runtime'));
  const {startPlatformReportWorker, durableStorage} = await import(new URL('../integrations/form-submitter/server/integration/platform_worker.ts', import.meta.url));
  const formUrl = 'https://docs.google.com/forms/d/e/TestLocal/viewform';
  durableStorage.syncFullState({settings: {username: 'suite-analyst', teamInviteCode: 'suite-code', autoSubmitGlobalEnabled: true}, formConfig: {formUrl, formId: 'TestLocal', formTitle: 'Synthetic', formVersionHash: 'synthetic-hash', verifiedAt: at,
    parsedSchema: {formId: 'TestLocal', formTitle: 'Synthetic', formUrl, versionHash: 'synthetic-hash', sections: [], allQuestions: [{id: '1', entryKey: 'entry.1', title: 'Site URL', type: 'TEXT', required: true, pageIndex: 1}], parsedAt: at},
    fieldMappings: [{id: 'site', fieldKey: 'siteUrl', label: 'Site URL', entryKey: 'entry.1', pageIndex: 1, required: true}], multiWalletFormat: 'COMBINED_LIST'}});
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https://docs.google.com/forms/d/e/TestLocal/') ? realFetch(`${main.url}/synthetic-form`, options) : realFetch(url, options);
  await startPlatformReportWorker();
  process.chdir(originalCwd);
  let reportsView = ok(await call('GET', '/api/v1/suite/reports'));
  assert.ok(reportsView.could_prepare.some(p => p.investigation_id === inv.id), 'the investigation is offered for a report');
  const invTitle = one('SELECT title FROM investigations WHERE id=?', inv.id).title;
  act = ok(await uiAct({path: '/reports', tab: '^Ready to prepare', within_text: invTitle, button: '^Prepare report$', method: 'POST', api: '/api/v1/suite/actions'},
    () => call('POST', '/api/v1/suite/actions', {action: 'prepare_report', investigation_id: inv.id})), 202);
  reportsView = ok(await call('GET', '/api/v1/suite/reports'));
  const rep = reportsView.reports.find(r => r.investigation_id === inv.id);
  assert.equal(rep.status, 'needs_review'); assert.equal(rep.ready_to_approve, true, JSON.stringify(rep.checks));
  assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='PREPARE_REPORT'", inv.id), 0, 'nothing is filed before you approve');
  ok(await uiAct({path: '/reports', tab: '^Review', within_text: rep.title, button: '^Approve and submit$', method: 'PATCH', api: `/api/v1/investigations/${inv.id}/report`},
    () => call('PATCH', `/api/v1/investigations/${inv.id}/report`, {candidate_id: rep.id, action: 'approve', reason: 'Evidence and scope reviewed'})));
  await waitFor(() => one('SELECT verification_status FROM report_candidates WHERE id=?', rep.id)?.verification_status === 'verified', 'report filed and confirmed', 30000);
  assert.equal(submissions, 1, 'one submission');
  reportsView = ok(await call('GET', '/api/v1/suite/reports'));
  assert.equal(reportsView.reports.find(r => r.id === rep.id).stage, 'Submitted and confirmed');
  globalThis.fetch = realFetch;
  results.report = {status: 'verified', submissions};

  // 8. Home summarises all five tools.
  const home = ok(await call('GET', '/api/v1/suite/home'));
  assert.equal(home.tools.reports.submitted, 1);
  assert.ok(home.tools.hunter.operations >= 1 && home.tools.logger.captures_total >= 1 && home.tools.wallets.analysed >= 1);
  const five = ['finder', 'wallets', 'logger', 'reports', 'hunter'].every(k => home.tools[k].modules.length >= 1);
  assert.ok(five);

  // ------------------------------------------------------------------ the UI, in a browser
  if (ui.skipped) {
    results.ui = `SKIPPED: ${ui.skipped}`;
    if (process.env.MIP_REQUIRE_UI === '1') throw new Error(results.ui);
  } else {
    const py = pythonCommand();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(py.command, [...py.args, localPath('./suite-ui-browser.py', import.meta.url)], {env: pythonEnv({SUITE_URL: main.url, SUITE_SITE: domain, SUITE_WALLET: walletKey, SUITE_OP: opExt, SUITE_SHOTS: shots, SUITE_OTHER: others[0]}), windowsHide: true});
      let o = '', e = ''; child.stdout.on('data', d => { o += d; }); child.stderr.on('data', d => { e += d; if(process.env.SUITE_PROGRESS)process.stderr.write(d); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(o) : reject(new Error(`browser check exited ${code}:\n${o.slice(-3000)}\n${e.slice(-3000)}`)));
    });
    const last = JSON.parse(out.trim().split(/\r?\n/).pop());
    if (last.skipped) { results.ui = `SKIPPED: ${last.skipped}`; if (process.env.MIP_REQUIRE_UI === '1') throw new Error(results.ui); }
    else results.ui = last;
  }
  // ------------------------------------------------------------------ every page, every control
  // tests/ui-click-all.py activates each control of each real page and fails on dead handlers,
  // console errors, exceptions, failed or 5xx requests and links to pages that do not exist. It runs
  // on this instance, then again after Main is restarted on the same database (buttons must still
  // work after a restart). MIP_UI_SWEEP=0 skips it.
  if (!ui.skipped && process.env.MIP_UI_SWEEP !== '0') {
    const built = await buildAllPagesUi(join(work, 'ui-all'));
    if (built.skipped) results.sweep = `SKIPPED: ${built.skipped}`;
    else {
      sweepUi = await serveAllPagesUi(built);
      const campaign = one('SELECT id FROM campaigns ORDER BY created_at LIMIT 1') ?? (await call('POST', '/api/v1/campaigns', {seed_domain: domain, title: 'Sweep campaign'})).body;
      const ids = {'/investigations/[id]': inv.id, '/campaigns/[id]': campaign?.id, '/operations/[id]': opExt};
      const paths = built.pages.filter(p=>!process.env.SUITE_SWEEP_OPERATIONS_ONLY||p==='/operations/[id]').map(p => p.includes('[') ? (ids[p] ? p.replace(/\[[^\]]+\]/, encodeURIComponent(ids[p])) : null) : p).filter(Boolean);
      assert.equal(paths.length, process.env.SUITE_SWEEP_OPERATIONS_ONLY?1:built.pages.length, `a dynamic page has no record to open: ${built.pages.join(', ')}`);
      const sweep = async (label, extraEnv = {}) => {
        const py = pythonCommand();
        const out = await new Promise((resolve, reject) => {
          const child = spawn(py.command, [...py.args, localPath('./ui-click-all.py', import.meta.url)], {env: pythonEnv({SUITE_URL: main.url, SUITE_SITE: domain, SUITE_PAGES: JSON.stringify(paths), ...extraEnv}), windowsHide: true});
          let o = '', e = ''; child.stdout.on('data', d => { o += d; }); child.stderr.on('data', d => { e += d; if(process.env.SUITE_PROGRESS)process.stderr.write(d); });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve(o) : reject(new Error(`interaction sweep (${label}) exited ${code}:\n${o.slice(-3000)}\n${e.slice(-3000)}`)));
        });
        const last = JSON.parse(out.trim().split(/\r?\n/).pop());
        if (process.env.SUITE_SWEEP_OUT) writeFileSync(`${process.env.SUITE_SWEEP_OUT}-${label.replace(/\W+/g, '-')}.json`, JSON.stringify(last, null, 1));
        if (last.skipped) return `SKIPPED: ${last.skipped}`;
        assert.ok(last.ok, `interaction sweep (${label}) found problems:\n${last.failures.map(f => `  ${f.where}: ${f.problem}`).join('\n')}`);
        return {pages: last.pages, hydrated: last.hydrated ?? 0, controls: last.controls, clicked: last.clicked, already_active: last.already_active ?? 0, external_links: last.external_links, warnings: last.warnings.length};
      };
      results.sweep = await sweep('first start');
      if (typeof results.sweep === 'object') {
        // Restart Main (fresh build, same database) and sweep again.
        await main.close();
        main = await startMain({dbFile, work, port:Number(new URL(main.url).port), label: 'suite-restart', extra, log: main.log});
        results.sweep_after_restart = await sweep('after restart', {SUITE_LIMIT: process.env.SUITE_SWEEP_RESTART_LIMIT ?? '12'});
      }
      if (process.env.MIP_REQUIRE_UI === '1' && typeof results.sweep === 'string') throw new Error(results.sweep);
    }
  }
  const errors = main.log.filter(l => / 5\d\d /.test(l));
  assert.deepEqual(errors, [], 'no server errors during the workflow');
  console.log(JSON.stringify({ok: true, ...results, screenshots: process.env.SUITE_SCREENSHOTS ? shots : undefined}));
} catch (error) {
  if (main) console.error(main.log.filter(l => / [45]\d\d/.test(l)).slice(-20).join('\n'));
  throw error;
} finally {
  process.chdir(originalCwd);
  if (main) await main.close().catch(() => {});
  if (!process.env.SUITE_SCREENSHOTS) rmSync(work, {recursive: true, force: true});
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
