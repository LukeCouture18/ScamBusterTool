// The combined system, end to end, over real HTTP:
//
//   Site Finder (its real v2 store, platform bridge, durable outbox, sync worker and
//   decision ledger, in Python)  ->  Main Platform (its real route handlers, scheduler,
//   executor, campaign formation, inbox, temporal and budget code on a file-backed SQLite
//   D1 double)  <->  Operation Hunter v2 (its real integration worker, pursuit engine and
//   membership inference, from the sibling folder).
//
// Public sources are Operation Hunter's synthetic ground-truth world, so no real network
// is touched. Nothing inside any of the three programs is mocked.
//
//   1. An existing installation (the RC's own Main code, migrations 0000-0011) receives
//      Site Finder discoveries: three sites of one operation and an unrelated co-hosted site.
//   2. The installation is upgraded in place: the merged Main code and migration 0012.
//      Every earlier row survives and the schema gate passes.
//   3. Operation Hunter registers. Main's scheduler forms a campaign from the graph-supported
//      group (not the co-hosted site), then proposes and dispatches a reconstruction of the
//      campaign as a HUNT_OPERATION job, charged to its budgets and module slots.
//   4. Hunter claims the job, reconstructs the operation and syncs it back. Main links the
//      reconstruction to the campaign and turns Hunter's proposals into its own work.
//   5. Duplicates: Hunter re-syncs, Site Finder re-delivers an acknowledged batch, Main ticks
//      again. Nothing new is created.
//   6. Restart: Main and Hunter both restart on their databases; Main reconciles the job.
//   7. Feedback: inbox decisions reach Hunter (membership verdict) and Site Finder (ledger).
//   8. Scheduler control: with Hunter's module slot full, a second reconstruction waits;
//      with auto_reconstruct off, nothing is proposed.
//
// Run: node --experimental-sqlite --import tsx tests/joined-finder-main-hunter.mjs
// Operation Hunter is found at HUNTER_DIR or as any sibling folder of this one that
// contains it (operation-hunter, operation-hunter-v2.0 and hunter are tried first). Without it the test reports SKIP,
// unless MIP_REQUIRE_HUNTER=1.
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {importFile, localPath, pythonCommand, pythonEnv, repoRoot} from './lib/portable.mjs';
import * as harness from './lib/main-harness.mjs';

const siblings = () => { try { return readdirSync(join(repoRoot, '..')).map(n => join(repoRoot, '..', n)); } catch { return []; } };
const hunterDir = [process.env.HUNTER_DIR, ...['operation-hunter', 'operation-hunter-v2.0', 'hunter'].map(n => join(repoRoot, '..', n)), ...siblings()]
  .filter(Boolean).map(p => resolve(p)).find(p => existsSync(join(p, 'server', 'integration', 'worker.ts')) && existsSync(join(p, 'bench', 'world.ts')));
if (!hunterDir) {
  const msg = 'SKIP joined Site Finder -> Main -> Operation Hunter: Operation Hunter not found (set HUNTER_DIR or place it beside this folder)';
  if (process.env.MIP_REQUIRE_HUNTER === '1') { console.error(msg); process.exit(1); }
  console.log(msg); process.exit(0);
}
const rcDir = process.env.MIP_PREVIOUS_MAIN_DIR ? resolve(process.env.MIP_PREVIOUS_MAIN_DIR) : null;   // optional: a real previous installation's code
const {HunterApp} = await importFile(join(hunterDir, 'server', 'app.ts'));
const {IntegrationWorker} = await importFile(join(hunterDir, 'server', 'integration', 'worker.ts'));
const {generateWorld, truthDomains, currentIps, currentNs} = await importFile(join(hunterDir, 'bench', 'world.ts'));
const {fakeNetwork, PACED_HOSTS} = await importFile(join(hunterDir, 'bench', 'fakeNetwork.ts'));

const KEYS = {site_finder: 'finder-key', site_investigator: 'investigator-key', crypto_wallet_logger: 'logger-key', wallet_investigator: 'wallet-key', form_submitter: 'form-key', operation_hunter: 'hunter-key'};
const work = mkdtempSync(join(tmpdir(), 'mip-joined-hunter-'));
const dbFile = join(work, 'main.sqlite');
const finderDir = join(work, 'finder'); (await import('node:fs')).mkdirSync(finderDir);
const hunterData = join(work, 'hunter');
const allLogs = [];   // request log across every Main instance (previous, upgraded, restarted)

// ------------------------------------------------------------------------------ Main Platform
const startMain = (codeDir, label) => harness.startMain({dbFile, codeDir, work, label, keys: KEYS, log: allLogs});
const applyMigrations = filter => harness.applyMigrations(dbFile, filter);

// ------------------------------------------------------------------------------ Site Finder
// Asynchronous on purpose: Main serves Site Finder's requests from this same process.
const finder = (cmd, extra, url) => new Promise((ok, fail) => {
  const py = pythonCommand();
  const child = spawn(py.command, [...py.args, localPath('./finder-joined-bridge.py', import.meta.url), cmd],
    {env: pythonEnv({MIP_JOINED: JSON.stringify({dir: finderDir, url, key: KEYS.site_finder, ...extra})}), windowsHide: true});
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.on('error', fail);
  child.on('close', code => {
    if (code !== 0) return fail(new Error(`Site Finder ${cmd} exited ${code}:\n${err.slice(-3000)}`));
    try { ok(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch (e) { fail(new Error(`Site Finder ${cmd} output: ${out.slice(-2000)}\n${err.slice(-2000)}`)); }
  });
});

// ------------------------------------------------------------------------------ Operation Hunter
const w = generateWorld(3, {difficulty: 0.3});
const net = fakeNetwork(w);
function startHunter(mainUrl) {
  const realFetch = globalThis.fetch;
  const fetchImpl = (u, init) => (String(u).startsWith(mainUrl) ? realFetch(u, init) : net.fetch(u, init));
  const app = new HunterApp({dataDir: hunterData, seedDemo: false, networkMode: 'live', fetchImpl, dnsResolver: net.resolver});
  for (const h of PACED_HOSTS) app.http.setPacing(h, 0);
  app.analyzer.debounceMs = 5;
  app.allocator.seed(3);
  app.integration = new IntegrationWorker(app);
  app.integration.configure({url: mainUrl, apiKey: KEYS.operation_hunter, enabled: true, hunterUrl: 'http://hunter.local'});
  return app;
}

const results = [];
const step = (name) => { results.push(name); console.log(`  PASS  ${name}`); };
let main, hunter;
try {
  // Three live sites of the target operation that share its private name server and hosting,
  // and one unrelated site on the same bulletproof IP (shared hosting is not shared ownership).
  const day = w.day;
  const target = w.ops.find(o => o.id === w.target);
  const core = target.domains.map(d => w.domains.get(d)).filter(d => d.kit && d.liveFrom <= day && (d.liveTo === null || d.liveTo > day) && currentNs(d, day)[0]?.includes('-dns.'));
  const byIp = new Map();
  for (const d of core) { const ip = currentIps(d, day)[0]; (byIp.get(ip) ?? byIp.set(ip, []).get(ip)).push(d); }
  const group = [...byIp.values()].sort((a, b) => b.length - a.length)[0].slice(0, 3);
  assert.equal(group.length, 3, 'the world has three co-hosted sites of the operation');
  const sharedIp = currentIps(group[0], day)[0];
  const cohost = [...w.domains.values()].find(d => !truthDomains(w).includes(d.name) && currentIps(d, day).includes(sharedIp));
  const truth = new Set(truthDomains(w));
  // Site Finder's own keys for a probed site: hosting IP and the support-chat service it links to,
  // plus the continuous watch's name-server set and live/dead status.
  const finderView = (d, p) => ({domain: d.name, p, ip: currentIps(d, day)[0], ns: currentNs(d, day), site_status: 'live', wallets: d.wallets.slice(0, 1),
    keys: [['ip', currentIps(d, day)[0]], ...(d.ids.telegram ? [['service', `t.me/${d.ids.telegram.replace(/^@/, '')}`]] : [])]});
  const finderCandidates = [...group.map((d, i) => finderView(d, 0.86 - i * 0.02)), ...(cohost ? [finderView(cohost, 0.7)] : [])];
  const groupNames = group.map(d => d.name);

  // ============================================================== 1. existing installation
  const pre = applyMigrations(n => n < '0012');
  main = await startMain(rcDir ?? repoRoot, 'previous');
  if (!rcDir) {
    // Without the previous release's code at hand, the previous schema still has to serve: the
    // merged code must not need 0012 for Site Finder ingest (only the Hunter surfaces do).
  }
  const delivered = await finder('deliver', {candidates: finderCandidates}, main.url);
  assert.equal(delivered.register.registered, true, JSON.stringify(delivered.register));
  assert.equal(delivered.queued, finderCandidates.length, JSON.stringify(delivered));
  // The unmodified previous release rejects Site Finder's job-less batches (origin_job_id: null from
  // the shared SDK); Site Finder parks them in its outbox. Nothing is lost: they go out after the upgrade.
  const acceptedBefore = finderCandidates.filter(c => main.one('SELECT id FROM inbox_candidates WHERE canonical_domain=?', c.domain)).length;
  assert.ok(acceptedBefore === finderCandidates.length || delivered.sync.rejected === finderCandidates.length, JSON.stringify(delivered.sync));
  const before = {
    registry: main.n('SELECT COUNT(*) n FROM module_registry'), candidates: main.n('SELECT COUNT(*) n FROM inbox_candidates'), investigations: main.n('SELECT COUNT(*) n FROM investigations'),
    entities: main.n('SELECT COUNT(*) n FROM entities'), evidence: main.n('SELECT COUNT(*) n FROM evidence'), events: main.n('SELECT COUNT(*) n FROM event_store'),
  };
  assert.equal(main.n("SELECT COUNT(*) n FROM sqlite_master WHERE name='hunter_operations'"), 0, 'the previous schema has no Hunter tables');
  await main.close();
  step(`Site Finder -> previous installation (${pre.length} migrations${rcDir ? ', previous code' : ''}): ${acceptedBefore}/${finderCandidates.length} accepted, ${delivered.outbox.pending} parked in Site Finder's outbox`);

  // ============================================================== 2. upgrade in place
  const up = applyMigrations(n => n >= '0012');
  assert.deepEqual(up, ['0012_operation_hunter.sql', '0013_wallet_key_prefix.sql', '0014_finder_hunts.sql', '0015_wallet_pipeline.sql', '0016_investigation_director.sql', '0017_operation_intelligence.sql', '0018_adaptive_intelligence.sql','0019_scientific_intelligence.sql','0020_full_autonomy.sql','0021_one_click_investigation.sql','0022_autonomous_missions.sql']);
  main = await startMain(repoRoot, 'merged');
  for (const [k, q] of Object.entries({registry: 'module_registry', candidates: 'inbox_candidates', investigations: 'investigations', entities: 'entities', evidence: 'evidence', events: 'event_store'}))
    assert.equal(main.n(`SELECT COUNT(*) n FROM ${q}`), before[k], `${q} preserved by the upgrade`);
  assert.equal(main.one("SELECT value FROM ops_state WHERE key='module_limit:operation_hunter'")?.value, '1');
  const health = await main.call('GET', '/api/v1/health');
  assert.equal(health.status, 200, JSON.stringify(health.body));
  const ready = await main.call('GET', '/api/v1/ops/overview');
  assert.equal(ready.status, 200, `schema gate passes after 0012: ${JSON.stringify(ready.body).slice(0, 300)}`);
  const retried = await finder('retry', {}, main.url);
  assert.equal(retried.outbox.pending, 0, `Site Finder's parked batches delivered after the upgrade: ${JSON.stringify(retried)}\n${main.log.slice(-6).join('\n')}`);
  for (const c of finderCandidates) assert.ok(main.one('SELECT id FROM inbox_candidates WHERE canonical_domain=?', c.domain), `${c.domain} reached Main's inbox`);
  step(`upgrade 0000-0011 -> 0012 in place: every row preserved, schema gate passes, Site Finder -> Main delivers all ${finderCandidates.length} candidates`);

  // ============================================================== 3. Hunter registers; Main forms a campaign and asks for a reconstruction
  hunter = startHunter(main.url);
  const c0 = await hunter.integration.cycle();
  assert.equal(c0.errors.length, 0, JSON.stringify(c0.errors));
  assert.ok(JSON.parse(main.one("SELECT capabilities FROM module_registry WHERE module_name='operation_hunter'").capabilities).includes('operation:reconstruct'));
  let job = null, campaign = null;
  for (let i = 0; i < 8 && !job; i++) {
    const t = await main.call('POST', '/api/v1/ops/tick');
    assert.equal(t.status, 200, JSON.stringify(t.body).slice(0, 500));
    campaign = main.one('SELECT * FROM campaigns ORDER BY created_at LIMIT 1');
    job = main.one("SELECT * FROM jobs WHERE job_type='HUNT_OPERATION'");
  }
  assert.ok(campaign, `Main formed a campaign from Site Finder's graph-supported group. work: ${JSON.stringify(main.all('SELECT kind,status,target_key,last_error FROM work_items'))}`);
  const campaignSites = main.all('SELECT domain FROM campaign_members WHERE campaign_id=?', campaign.id).map(r => r.domain).sort();
  assert.deepEqual(campaignSites, [...groupNames].sort(), 'the campaign is the supported group; the co-hosted site is not in it');
  assert.ok(job, `Main dispatched a HUNT_OPERATION job. work: ${JSON.stringify(main.all('SELECT kind,status,target_type,target_key,last_error FROM work_items'))}`);
  const wi = main.one("SELECT * FROM work_items WHERE kind='reconstruct_operation'");
  assert.equal(wi.target_type, 'campaign'); assert.equal(wi.target_key, campaign.id); assert.equal(wi.status, 'running');
  assert.equal(job.target_module, 'operation_hunter');
  const payload = JSON.parse(job.payload);
  assert.equal(payload.campaign_id, campaign.id);
  assert.deepEqual(payload.seeds.filter(s => s.type === 'domain').map(s => s.value).sort(), [...groupNames].sort(), 'every campaign site is a seed');
  assert.ok(main.n("SELECT COUNT(*) n FROM budget_ledger WHERE scope='module:operation_hunter' AND kind='module_jobs'") === 1, 'the job was charged to Main\'s module_jobs budget for operation_hunter');
  assert.equal(main.n("SELECT COUNT(*) n FROM work_items WHERE kind='reconstruct_operation'"), 1);
  step('Main -> Hunter: campaign formed from Site Finder evidence, reconstruction proposed, charged and dispatched as HUNT_OPERATION');

  // ============================================================== 4. Hunter reconstructs and reports
  const c1 = await hunter.integration.cycle();
  assert.equal(c1.jobs, 1, JSON.stringify(c1));
  const op = hunter.store.getOperations().find(o => groupNames.includes(o.initialSeed));
  assert.ok(op, 'Hunter created an operation for the campaign');
  await hunter.pursuit.runToCompletion(op.id, {budgetTotal: 70, maxHops: 5, concurrency: 3, maxMinutes: 600}, 75);
  const a = hunter.analyzer.analyze(op.id);
  const members = a.model.sites.filter(s => s.membership === 'member').map(s => s.value);
  assert.ok(members.length >= 3, `members: ${members}`);
  assert.ok(members.every(m => truth.has(m)), `false members: ${members.filter(m => !truth.has(m))}`);
  if (cohost) assert.ok(!members.includes(cohost.name), 'the co-hosted site is not a member (shared hosting is not shared ownership)');
  hunter.integration.queueSync(op.id);
  const c2 = await hunter.integration.cycle();
  assert.equal(c2.errors.length, 0, JSON.stringify(c2.errors) + '\n' + main.log.slice(-10).join('\n'));
  const hop = main.one('SELECT * FROM hunter_operations WHERE external_id=?', op.id);
  assert.ok(hop); assert.equal(hop.campaign_id, campaign.id, 'the reconstruction is linked to the campaign');
  const ws = await main.call('GET', `/api/v1/ops/campaigns/${campaign.id}`);
  assert.equal(ws.status, 200); assert.equal(ws.body.reconstruction?.external_id, op.id, 'the campaign workspace shows its reconstructed operation');
  const hMembers = main.all("SELECT canonical_key FROM hunter_operation_members WHERE operation_id=? AND entity_type='site' AND role IN ('member','seed')", hop.id).map(r => r.canonical_key);
  assert.deepEqual(new Set(hMembers), new Set(members));
  step(`Hunter -> Main: ${members.length} members (all true), reconstruction linked to the campaign`);

  const proposals = main.all('SELECT * FROM hunter_proposals WHERE operation_id=?', hop.id);
  const hunterCands = main.all("SELECT * FROM inbox_candidates WHERE source_module='operation_hunter'");
  assert.ok(hunterCands.length >= 1, `Hunter's discoveries reached the inbox: ${JSON.stringify(proposals.map(p => [p.kind, p.target, p.outcome]))}`);
  assert.ok(hunterCands.every(c => truth.has(c.canonical_domain) && !groupNames.includes(c.canonical_domain)), 'only new, real members become inbox candidates');
  assert.equal(main.n('SELECT COUNT(*) n FROM (SELECT canonical_domain FROM inbox_candidates GROUP BY canonical_domain HAVING COUNT(*)>1)'), 0, 'no site has two inbox candidates');
  assert.ok(proposals.filter(p => p.kind === 'investigate_site' && groupNames.includes(p.target)).every(p => p.outcome !== 'candidate_created'), 'Site Finder\'s sites are not re-proposed as new candidates');
  assert.ok(proposals.some(p => p.kind === 'analyze_wallet' && p.outcome === 'work_proposed'), 'operation wallets became analyze_wallet work');
  const candWork = main.all("SELECT target_key FROM work_items WHERE kind='investigate_candidate'").map(r => r.target_key);
  assert.ok(hunterCands.every(c => candWork.includes(c.canonical_domain) || candWork.includes(c.id)), `every Hunter candidate has investigation work: ${JSON.stringify(main.all("SELECT kind,target_type,target_key FROM work_items WHERE kind='investigate_candidate'"))}`);
  assert.ok(main.n("SELECT COUNT(*) n FROM entity_snapshots WHERE source_table='hunter_operations'") >= 1, 'Hunter observations entered the temporal layer');
  assert.ok(groupNames.some(d => main.n("SELECT COUNT(*) n FROM entity_facets WHERE subject_key=? AND facet='nameservers' AND observations>=2", d) === 1), `Site Finder and Hunter corroborate name servers they both observed: ${JSON.stringify(main.all("SELECT subject_key,facet,source_table,observations FROM entity_facets"))}`);
  assert.equal(main.n("SELECT COUNT(*) n FROM contradictions WHERE kind='providers_disagree'"), 0, `the two modules agree on the facts they both observe: ${JSON.stringify(main.all("SELECT subject_key,detail FROM contradictions"))}`);
  step(`Hunter discoveries -> Main work/inbox: ${hunterCands.length} new candidates, wallet work, temporal facets`);

  // ============================================================== 5. duplicate events and jobs
  const snap = () => ({work: main.n('SELECT COUNT(*) n FROM work_items'), cands: main.n('SELECT COUNT(*) n FROM inbox_candidates'), jobs: main.n('SELECT COUNT(*) n FROM jobs'),
    inv: main.n('SELECT COUNT(*) n FROM investigations'), props: main.n('SELECT COUNT(*) n FROM hunter_proposals'), camps: main.n('SELECT COUNT(*) n FROM campaigns')});
  const s0 = snap();
  hunter.integration.queueSync(op.id); await hunter.integration.cycle();
  const resent = await finder('resend', {domain: groupNames[0]}, main.url);
  assert.equal(resent.outbox.pending, 0, JSON.stringify(resent));
  assert.equal(resent.sync.duplicates, 1, `Main recognised the re-delivered batch: ${JSON.stringify(resent.sync)}`);
  const cBefore = main.one('SELECT updated_at,decision FROM inbox_candidates WHERE canonical_domain=?', groupNames[0]);
  const again = await hunter.integration.cycle();
  assert.equal(again.jobs, 0, 'the job is not claimed twice');
  const s1 = snap();
  assert.deepEqual({...s1, work: s1.work}, {...s0}, `no duplicates after a repeated Hunter snapshot and a re-delivered Site Finder batch: ${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`);
  assert.ok(cBefore);
  step('duplicate protection: repeated Hunter sync, re-delivered Site Finder batch and re-claim create nothing');

  // ============================================================== 6. restart both; Main reconciles the job
  const opId = op.id;
  hunter.close(); await main.close();
  main = await startMain(repoRoot, 'restarted');
  hunter = startHunter(main.url);
  assert.ok(hunter.store.getOperation(opId), 'Hunter kept the operation across the restart');
  const r0 = await hunter.integration.cycle();
  assert.equal(r0.errors.length, 0, JSON.stringify(r0.errors));
  await main.call('POST', '/api/v1/ops/tick');
  const done = main.one('SELECT * FROM work_items WHERE id=?', wi.id);
  assert.equal(done.status, 'done', `${done.status}: ${done.last_error ?? done.result}`);
  assert.ok(JSON.parse(done.result).useful >= 0.6, done.result);
  assert.equal(main.one("SELECT status FROM jobs WHERE id=?", job.id).status, 'completed');
  assert.equal(main.n("SELECT COUNT(*) n FROM work_items WHERE kind='reconstruct_operation'"), 1, 'the campaign is not reconstructed again after the restart');
  step('restart/recovery: Main and Hunter restarted on their databases; the job reconciled as useful, not repeated');

  // ============================================================== 7. feedback: Main -> Hunter and Main -> Site Finder
  const reject = hunterCands[0];
  let dec = await main.call('POST', `/api/v1/inbox/${reject.id}/decision`, {decision: 'skip', reason: 'not_a_scam'});
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  const finderSite = main.one('SELECT * FROM inbox_candidates WHERE canonical_domain=?', groupNames[1]);
  dec = await main.call('POST', `/api/v1/inbox/${finderSite.id}/decision`, {decision: 'useful'});
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  await hunter.integration.cycle();
  const ent = hunter.store.findEntity(opId, 'domain', reject.canonical_domain);
  assert.equal(hunter.intel.membershipOf(opId, ent.id)?.analystVerdict, 'not_member', 'the inbox rejection became a membership verdict in Hunter');
  assert.equal(hunter.analyzer.analyze(opId).membership.byId[ent.id].status, 'excluded');
  const pulled = await finder('pull', {domains: [groupNames[1], reject.canonical_domain]}, main.url);
  assert.equal(pulled.candidates[groupNames[1]].decision, 'useful', `Site Finder learned from the inbox: ${JSON.stringify(pulled)}`);
  assert.equal(pulled.candidates[groupNames[1]].status, 'useful');
  assert.ok(pulled.pull.pulled >= 2, JSON.stringify(pulled));
  // Site Finder also folds in the decision on Hunter's candidate: it now knows that site is decided
  // and will not deliver it as new (its existing, unchanged platform-decision behaviour).
  assert.equal(pulled.candidates[reject.canonical_domain].decision, 'skip', JSON.stringify(pulled.candidates));
  step('Main feedback -> Hunter (membership verdict) and -> Site Finder (decision ledger)');

  // ============================================================== 8. scheduler and budgets control Hunter
  hunter.integration.queueSync(opId); await hunter.integration.cycle();
  const other = cohost?.name ?? groupNames[2];
  // hold the only Hunter slot with a running reconstruction, then ask for another
  let r = await main.call('POST', '/api/v1/operations/reconstruct', {domain: groupNames[2]});
  assert.equal(r.status, 202, JSON.stringify(r.body));
  r = await main.call('POST', '/api/v1/operations/reconstruct', {domain: other});
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await main.call('POST', '/api/v1/ops/tick');
  const pending = main.all("SELECT target_key,status FROM work_items WHERE kind='reconstruct_operation' AND target_type<>'campaign' ORDER BY created_at");
  assert.equal(pending.filter(p => p.status === 'running').length, 1, `module_limit:operation_hunter=1 holds one reconstruction at a time: ${JSON.stringify(pending)}`);
  assert.ok(pending.some(p => ['queued', 'deferred'].includes(p.status)), JSON.stringify(pending));
  main.sql.prepare("UPDATE ops_state SET value='false' WHERE key='auto_reconstruct'").run();
  const beforeAuto = main.n("SELECT COUNT(*) n FROM work_items WHERE kind='reconstruct_operation'");
  main.sql.prepare("INSERT INTO campaigns (id,title,status,headline,deadline_at) VALUES ('c-manual','Manual','RUNNING','x','2099-01-01T00:00:00Z')").run();
  for (const d of groupNames) main.sql.prepare("INSERT INTO campaign_members (id,campaign_id,domain,role,state) VALUES (?,?,?,'member','pending')").run(`m-${d}`, 'c-manual', d);
  await main.call('POST', '/api/v1/ops/tick');
  assert.equal(main.n("SELECT COUNT(*) n FROM work_items WHERE kind='reconstruct_operation'"), beforeAuto, 'auto_reconstruct=false: the scheduler proposes nothing');
  step('Main scheduler/budgets -> Hunter: one module slot, operator requests queue behind it, auto_reconstruct switch respected');

  const errors = allLogs.filter(l => / 5\d\d( |$)/.test(l));
  assert.deepEqual(errors, [], `no server errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${results.length} joined Site Finder -> Main -> Operation Hunter checks passed.`);
} finally {
  try { hunter?.close(); } catch { /* closed */ }
  try { await main?.close(); } catch { /* closed */ }
  rmSync(work, {recursive: true, force: true});
}
