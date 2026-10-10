// The two discovery loops of Site Finder v3, end to end over real HTTP:
//
//   A. Finder -> Main -> Hunter -> Finder
//      Operation Hunter reports an operation whose evidence is thin and asks for more sites like its
//      members, with the operation's own identifiers. Main turns the request into budgeted work and
//      a FIND_RELATED_SITES job; the real Site Finder claims it, opens a campaign hunt, pursues it on
//      its synthetic public internet, delivers what is new with its discovery path, and reports the
//      hunt to Main (Site Finder · Hunts).
//   B. Finder -> Investigation Mode -> Finder
//      A delivered site is marked useful and investigated; the investigation's public artifacts go
//      back to Site Finder as one bounded request that opens an investigation hunt.
//
// Both loops must produce useful expansion WITHOUT infinite rediscovery: repeating Hunter's request,
// re-running the scheduler and re-investigating the same site create no new jobs or hunts.
//
// Run: node --experimental-sqlite --import tsx tests/joined-pursuit-loops.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localPath, pythonCommand, pythonEnv} from './lib/portable.mjs';
import {applyMigrations, MODULE_KEYS as KEYS, startMain} from './lib/main-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'mip-pursuit-loops-'));
const dbFile = join(work, 'main.sqlite');
const finderDir = join(work, 'finder'); mkdirSync(finderDir);
const steps = [];
const step = s => { steps.push(s); console.log(`  ok  ${s}`); };
let main;

const finder = (cmd, extra = {}) => new Promise((ok, fail) => {
  const py = pythonCommand();
  const child = spawn(py.command, [...py.args, localPath('./finder-pursuit-bridge.py', import.meta.url), cmd],
    {env: pythonEnv({MIP_JOINED: JSON.stringify({dir: finderDir, url: main.url, key: KEYS.site_finder, ...extra})}), windowsHide: true});
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.on('error', fail);
  child.on('close', code => {
    if (code !== 0) return fail(new Error(`Site Finder ${cmd} exited ${code}:\n${err.slice(-3000)}`));
    try { ok(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch { fail(new Error(`Site Finder ${cmd} output: ${out.slice(-2000)}\n${err.slice(-2000)}`)); }
  });
});

try {
  applyMigrations(dbFile);
  main = await startMain({dbFile, work, label: 'loops'});
  const {call, one, n} = main;
  const ok = (r, status = [200, 201, 202]) => { assert.ok([].concat(status).includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`); return r.body; };
  ok(await call('POST', '/api/v1/modules/site_investigator/register', {module_version: 'loops', schema_version: '3.0', capabilities: ['site:investigate'], supported_event_types: []}, KEYS.site_investigator));
  const setup = await finder('setup');
  assert.ok(setup.register && setup.sites.length >= 2, JSON.stringify(setup));
  const opExt = `hunter:op:${setup.operation}`;

  // ------------------------------------------------------------------ A. Hunter asks, Finder hunts
  const snapshot = {schema_version: '2.0',
    operation: {external_id: opExt, code: 'OP-L', name: 'Loop test operation', status: 'ACTIVE', headline: 'Thin operation', confidence: 0.6, hunter_version: '2.1.0'},
    model: {status: 'active', counts: {members: setup.sites.length}},
    members: setup.sites.map(d => ({entity_type: 'site', canonical_key: d, role: 'member', probability: 0.8, state: 'live', why: 'shared operator settings'})),
    proposals: [{key: `find_related:thin:${setup.sites.length}`, kind: 'find_related', target_type: 'operation', target_key: opExt, seeds: setup.sites, value: 0.6,
      artifacts: [{kind: 'analytics', value: 'ga4:g-0000test'}, {kind: 'bogus', value: 'dropped'}], reason: 'Only a few member sites known'}]};
  ok(await call('POST', '/api/v1/operations/sync', snapshot, KEYS.operation_hunter));
  ok(await call('POST', '/api/v1/ops/tick'));
  const jobA = one("SELECT id,payload FROM jobs WHERE job_type='FIND_RELATED_SITES'");
  assert.ok(jobA, 'Main turned Hunter\'s evidence gap into a Site Finder job');
  const payloadA = JSON.parse(jobA.payload);
  assert.equal(payloadA.source, 'hunter');
  assert.deepEqual(payloadA.artifacts, [{kind: 'analytics', value: 'ga4:g-0000test'}], 'artifacts are sanitized, unknown kinds dropped');
  step('Hunter -> Main: evidence gap with the operation\'s identifiers becomes one budgeted FIND_RELATED_SITES job');

  const w1 = await finder('work');
  assert.ok(w1.ran.some(r => r.job_type === 'FIND_RELATED_SITES' && r.ran), JSON.stringify([w1.ran, w1.last_claim, one('SELECT target_module,status FROM jobs WHERE id=?', jobA.id)]));
  const campaign = w1.hunts.find(h => h.id === `campaign:${opExt}`);
  assert.ok(campaign, `Finder opened a campaign hunt: ${JSON.stringify(w1.hunts.map(h => h.id))}`);
  assert.equal(campaign.title, 'Looking for new deployments related to Operation OP-L Loop test operation');
  assert.equal(one('SELECT status FROM jobs WHERE id=?', jobA.id).status, 'completed');
  const hunts = ok(await call('GET', '/api/v1/suite/finder')).hunts;
  assert.ok(hunts.some(h => h.id === campaign.id && h.title === campaign.title), 'Main shows Finder\'s hunts');
  const delivered = n("SELECT COUNT(*) n FROM inbox_candidates WHERE source_module='site_finder'");
  assert.ok(delivered >= 1, 'the hunt delivered new sites to Main');
  const withPath = one(`SELECT canonical_domain,details FROM inbox_candidates WHERE source_module='site_finder' AND json_extract(details,'$.novelty.explain.because') IS NOT NULL LIMIT 1`);
  if (withPath) assert.match(JSON.parse(withPath.details).novelty.explain.because, /^Found this because/);
  step(`Finder -> Main: campaign hunt "${campaign.title}" ran; ${delivered} new site(s) delivered${withPath ? ' with their discovery path' : ''}; the hunt is visible in Main`);

  // the same request again, and more scheduler passes: nothing new is created
  for (let i = 0; i < 3; i++) { ok(await call('POST', '/api/v1/operations/sync', snapshot, KEYS.operation_hunter)); ok(await call('POST', '/api/v1/ops/tick')); }
  assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE job_type='FIND_RELATED_SITES'"), 1, 'a repeated request is one job');
  const w2 = await finder('work');
  assert.equal(w2.ran.length, 0, 'nothing waiting for Finder');
  assert.equal(w2.hunts.filter(h => h.kind === 'campaign').length, 1);
  step('loop A is bounded: repeated Hunter requests and scheduler passes create no new job or hunt');

  // ------------------------------------------------------------------ B. Investigation returns artifacts
  const cand = one("SELECT id,canonical_domain,investigation_id FROM inbox_candidates WHERE source_module='site_finder' AND investigation_id IS NOT NULL LIMIT 1");
  assert.ok(cand, 'a delivered site with an investigation');
  ok(await call('POST', '/api/v1/suite/actions', {action: 'review', domain: cand.canonical_domain, decision: 'useful'}), 202);
  const investigateOnce = async (label) => {
    let claim;
    for (let i = 0; i < 10; i++) {                       // other sites' investigations are completed without evidence
      claim = ok(await call('POST', '/api/v1/modules/site_investigator/jobs/claim', {}, KEYS.site_investigator));
      assert.ok(claim.job, `${label}: an investigation job for ${cand.canonical_domain}`);
      if (claim.job.investigation_id === cand.investigation_id) break;
      ok(await call('PATCH', `/api/v1/modules/site_investigator/jobs/${claim.job.id}`, {action: 'complete', result: {}}, KEYS.site_investigator));
    }
    const inv = one('SELECT external_id FROM investigations WHERE id=?', cand.investigation_id);
    const t = new Date().toISOString();
    const base = {investigation_id: inv.external_id, provenance: {source: 'site_investigator', origin_job_id: claim.job.id}};
    const ev = (id, type, value) => ({...base, external_id: `${claim.job.id}:${id}`, evidence_type: type, evidence_class: 'derived_observation', observation_scope: 'public',
      title: `Site Investigator: ${type}`, context_text: JSON.stringify(value), confidence: 0.8, entity: {entity_type: 'site', canonical_key: cand.canonical_domain}, observed_at: t});
    const batch = {schema_version: '3.0', batch_id: `si:${claim.job.id}:loops`, sent_at: t, origin_job_id: claim.job.id, records: {sites: [{...base, external_id: `site:${claim.job.id}`, canonical_key: cand.canonical_domain, display_name: cand.canonical_domain, confidence: 0.85, observed_at: t}],
      evidence: [ev('a', 'analytics_ids', ['G-L00P7E57']), ev('s', 'socials', ['https://t.me/loop_support']), ev('p', 'page_text', {title: `Loopex | Earn Daily`})]}};
    const res = ok(await call('POST', '/api/v1/ingest/site_investigator', batch, KEYS.site_investigator), 202);
    assert.equal(res.error_count, 0, JSON.stringify(res.errors));
    ok(await call('PATCH', `/api/v1/modules/site_investigator/jobs/${claim.job.id}`, {action: 'complete', result: {batch_id: batch.batch_id}}, KEYS.site_investigator));
  };
  await investigateOnce('first investigation');
  const wi = one("SELECT id,result FROM work_items WHERE fingerprint=?", `find_related:investigation:${cand.canonical_domain}`);
  assert.ok(wi, `the completed investigation became a Finder request: ${JSON.stringify(main.all("SELECT investigation_id,source_module,evidence_type,substr(context_text,1,60) c FROM evidence WHERE source_module='site_investigator'"))} inv=${cand.investigation_id} ${JSON.stringify(main.all("SELECT job_type,status,investigation_id FROM jobs"))}`);
  const arts = JSON.parse(wi.result).artifacts;
  assert.deepEqual(arts.map(a => a.kind).sort(), ['analytics', 'contact', 'title']);
  ok(await call('POST', '/api/v1/ops/tick'));
  const jobB = one("SELECT id,payload FROM jobs WHERE job_type='FIND_RELATED_SITES' AND json_extract(payload,'$.source')='investigation'");
  assert.ok(jobB, 'Main dispatched the investigation\'s artifacts to Finder');
  const w3 = await finder('work');
  assert.ok(w3.hunts.some(h => h.id === `investigation:${cand.canonical_domain}` && /Following artifacts from the investigation/.test(h.title)),
    JSON.stringify(w3.hunts.map(h => h.id)));
  step('Investigation Mode -> Finder: the investigation\'s public artifacts opened an investigation hunt');

  // re-investigate the same site: no second request, no second hunt
  ok(await call('POST', '/api/v1/suite/actions', {action: 'investigate_site', domain: cand.canonical_domain}), [202, 409]);
  ok(await call('POST', '/api/v1/ops/tick'));
  if (n("SELECT COUNT(*) n FROM jobs WHERE job_type IN ('INVESTIGATE_SITE','RECHECK_SITE') AND status='pending' AND investigation_id=?", cand.investigation_id)) await investigateOnce('second investigation');
  ok(await call('POST', '/api/v1/ops/tick'));
  assert.equal(n("SELECT COUNT(*) n FROM work_items WHERE fingerprint=?", `find_related:investigation:${cand.canonical_domain}`), 1, 'one request per investigated site, however often it is investigated');
  assert.equal(n("SELECT COUNT(*) n FROM jobs WHERE job_type='FIND_RELATED_SITES' AND json_extract(payload,'$.source')='investigation'"), 1);
  const w4 = await finder('work');
  assert.equal(w4.hunts.filter(h => h.kind === 'investigation').length, 1);
  assert.ok(w4.branches === w3.branches || w4.branches >= w3.branches, 'the tree only grows from real new evidence');
  step('loop B is bounded: re-investigating the site creates no new request, job or hunt');

  const errors = main.log.filter(l => / 5\d\d /.test(l));
  assert.deepEqual(errors, [], 'no server errors');
  console.log(JSON.stringify({ok: true, steps: steps.length, delivered, hunts: w4.hunts.length}));
} catch (error) {
  if (main) console.error(main.log.filter(l => / [45]\d\d/.test(l)).slice(-15).join('\n'));
  throw error;
} finally {
  if (main) await main.close().catch(() => {});
  rmSync(work, {recursive: true, force: true});
}
