/**
 * v7: typed evidence gaps and bounded test candidates, derived from an observable snapshot.
 *
 * Pure. The snapshot contains only what Main has legitimately recorded (authoritative module
 * records, Hunter's synced analysis, Main's own coordination history). It never contains
 * benchmark truth: benchmarks build snapshots from what their simulated specialists have
 * revealed so far, exactly like the database loader does.
 */
import { GAPS, TESTS, dependents, type GapFamily, type GapStatus, type TestFamily, type WakeCondition, type ResourceBounds } from './ontology';

export type SiteFact = {
  key: string; entity_id?: string | null; investigation_id?: string | null;
  association: 'seed' | 'proposed' | 'context' | 'confirmed_shared_evidence' | 'excluded';
  inspected: boolean; inspection_failures?: number; inspection_running?: boolean;
  payment_seen: boolean; deposit_seen: boolean; wallet_page_rechecked: boolean;
  status: 'live' | 'dead' | 'returned' | 'unknown'; status_changed_at?: string | null;
  changed_since_inspection?: boolean; human_barrier?: boolean;
  strong_units: number; weak_units: number;
  report?: { exists: boolean; ready: boolean; destination: boolean; blockers: string[] } | null;
  timing_known?: boolean;
};
export type WalletFact = {
  id: string; identity: string; address: string; network: string | null; context: string; validation: string; analysis: string;
  investigation_id: string | null; site_key: string | null; validated_sites: number;
  provider: 'healthy' | 'unavailable' | 'unknown'; provider_ready: boolean; owned_by_director: boolean;
  reuse_reviewed: boolean; reuse_searched: boolean; rotation_suspected?: boolean;
};
export type ArtifactFact = { kind: 'analytics' | 'contact' | 'title' | 'ns' | 'wallet' | 'template' | 'build'; value: string; sites: number; distinctive: boolean; searched: boolean; site_key?: string | null };
export type QuestionKind = 'linkage' | 'activity' | 'other';
export type QuestionFact = { key: string; question: string; alternatives: Array<{ key: string; label: string; status: string; verdict?: string | null }>; supports?: number; contradicts?: number; kind?: QuestionKind };
/** Which competing-explanation family a Hunter question belongs to (diagnosticity differs by family). */
export function questionKind(key: string, text: string): QuestionKind {
  const t = `${key} ${text}`.toLowerCase();
  if (/\bwho\b|operator|run by|same kit|kit vendor|shared|related|linked|one operation|explanation|artifact|configuration/.test(t)) return 'linkage';
  if (/activity|still running|active|dormant|moved|wound down|ended|paused|return/.test(t)) return 'activity';
  return 'other';
}
export type ContradictionFact = { fingerprint: string; summary: string; kind: string; status: string; new_evidence_since_hunter: boolean };
export type HistoryFact = { family: TestFamily; subject: string; inputs_hash: string; status: 'reserved' | 'running' | 'finished'; useful: boolean | null; dead: boolean; duplicate: boolean; finished_at?: string | null; gap_family?: GapFamily | null };
export type FamilyLearning = { n: number; useful: number; validated_site: number; validated_wallet: number; independent: number; discrimination: number; report: number; contradiction: number; dead: number; duplicate: number; generic: number; measured_n: number; cost_mean: number | null };
export type Snapshot = {
  scope: { kind: 'operation' | 'investigation'; id: string; label: string; seed?: string | null; investigation_id?: string | null };
  now: string;
  sites: SiteFact[]; wallets: WalletFact[]; artifacts: ArtifactFact[]; questions: QuestionFact[]; contradictions: ContradictionFact[];
  /** Distinct independence units per evidence category (v6 independence-key semantics). */
  units: Record<string, number>;
  waves: { count: number; newest_unhunted: boolean };
  hunter: { present: boolean; evidence_since_last_analysis: number };
  history: HistoryFact[];
  learning: Record<string, FamilyLearning>;
  budget: { remaining: number; max: number };
  /** Seeds and artifact values already handed to Site Finder for this scope by ANY component (lower-cased). */
  finder_sent?: { seeds: string[]; artifacts: string[] };
};

export type Gap = {
  key: string; family: GapFamily; subject: string;
  current: string; missing: string; matters: string;
  supporting: string[]; contradicting: string[];
  uncertainty: number; tests: TestFamily[]; dependencies: string[]; status: GapStatus;
  exhaustion: string; revisit: WakeCondition[];
  report_blocking: number; time_sensitivity: number; coverage: number;
  discrimination?: { question: string; a: string; b: string; prior: number; kind: QuestionKind } | null;
};

export type Objective = { kind: 'finder' | 'hunter' | 'site' | 'wallet' | 'local'; text: string; seeds?: string[]; artifacts?: Array<{ kind: string; value: string }>; question?: string; wallet?: string; site?: string; mode?: string };
export type Candidate = { key: string; family: TestFamily; subject: string; gaps: string[]; objective: Objective; inputs_hash: string; prerequisites_met: boolean; prerequisite?: string; bounds: ResourceBounds };

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
/** Small deterministic hash for input identity (not security). */
export function fnv(text: string) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

function gap(family: GapFamily, subject: string, p: Partial<Gap> & { current: string; missing: string; uncertainty: number }): Gap {
  const spec = GAPS[family];
  return { key: `${family}:${subject}`, family, subject, matters: spec.matters, supporting: [], contradicting: [], tests: (Object.keys(TESTS) as TestFamily[]).filter(t => (TESTS[t].answers[family] ?? 0) > 0),
    dependencies: [], status: 'open', exhaustion: spec.exhaustion, revisit: spec.revisit, report_blocking: 0, time_sensitivity: .1, coverage: 1, discrimination: null, ...p };
}

const tried = (s: Snapshot, family: TestFamily, subject: string) => s.history.filter(h => h.family === family && h.subject === subject);
const finishedEmpty = (h: HistoryFact[]) => h.filter(x => x.status === 'finished' && !x.useful).length;
const active = (h: HistoryFact[]) => h.some(x => x.status !== 'finished');

/** Derives the persistent typed gap set for one scope. Deterministic for equal snapshots. */
export function deriveGaps(s: Snapshot): Gap[] {
  const gaps: Gap[] = [];
  const sites = s.sites.filter(x => x.association !== 'excluded');
  const uninspected = sites.filter(x => !x.inspected);
  for (const site of sites) {
    const subject = `site:${site.key}`;
    if (site.human_barrier) gaps.push(gap('HUMAN_BARRIER', subject, { current: 'A login, verification or analyst-judgment checkpoint is open.', missing: 'Evidence behind the checkpoint.', uncertainty: .5, status: 'waiting_for_human', tests: [] }));
    if (!site.inspected) {
      const failures = site.inspection_failures ?? 0;
      gaps.push(gap('SITE_IDENTITY', subject, { current: site.association === 'seed' ? 'Seed site; no public inspection recorded.' : `Proposed site (${site.association}); no public inspection recorded.`,
        missing: `What does ${site.key} publicly present?`, uncertainty: .9, coverage: 1 / Math.max(1, uninspected.length),
        status: site.inspection_running ? 'in_progress' : failures >= 2 ? 'exhausted' : site.status === 'dead' ? 'waiting_for_evidence' : 'open',
        time_sensitivity: site.status === 'returned' ? .8 : .3, report_blocking: site.association === 'seed' ? .5 : .2 }));
      if (site.association !== 'seed' && site.weak_units > 0 && site.strong_units === 0)
        gaps.push(gap('OPERATION_MEMBERSHIP', subject, { current: `Linked only by ${site.weak_units} weak (template/infrastructure) unit(s).`, missing: `Is ${site.key} tied to the operation by independent evidence, or only by a shared kit/CDN?`,
          uncertainty: .8, supporting: [`${site.weak_units} weak overlap unit(s)`], dependencies: [`SITE_IDENTITY:${subject}`], coverage: 1 / Math.max(1, sites.length) }));
      continue;
    }
    if (!site.payment_seen && !site.deposit_seen) {
      const t = tried(s, 'LIKELY_WALLET_PAGE_INSPECTION', subject);
      gaps.push(gap('PAYMENT_INTERFACE', subject, { current: 'Public inspection recorded no payment presentation.', missing: `Does ${site.key} publicly solicit deposits?`, uncertainty: .6,
        status: site.human_barrier ? 'waiting_for_human' : active(t) ? 'in_progress' : site.wallet_page_rechecked || finishedEmpty(t) >= 1 ? 'exhausted' : 'open', report_blocking: .6, coverage: 1 / Math.max(1, sites.length) }));
    } else if (!site.deposit_seen) {
      const t = tried(s, 'LIKELY_WALLET_PAGE_INSPECTION', subject);
      gaps.push(gap('DEPOSIT_WALLET', subject, { current: 'Wallet-like data seen, but not in a deposit context.', missing: `Which wallet does ${site.key} present for deposits?`, uncertainty: .65,
        status: site.human_barrier ? 'waiting_for_human' : active(t) ? 'in_progress' : site.wallet_page_rechecked || finishedEmpty(t) >= 1 ? 'exhausted' : 'open', report_blocking: .8 }));
    }
    if (site.status === 'dead' || site.status === 'returned') {
      const t = tried(s, 'REPLACEMENT_SITE_HUNT', subject);
      const artifacts = s.artifacts.filter(a => a.site_key === site.key || a.sites > 1);
      gaps.push(gap('REPLACEMENT_SITE', subject, { current: site.status === 'dead' ? 'Site recorded as disappeared.' : 'Site returned after a disappearance.', missing: `Was ${site.key} replaced by a new public deployment?`,
        uncertainty: .7, time_sensitivity: site.status === 'dead' ? .95 : .6, status: active(t) ? 'in_progress' : t.some(x => x.status === 'finished') ? 'exhausted' : artifacts.length ? 'open' : 'blocked_by_dependency',
        dependencies: artifacts.length ? [] : ['PUBLIC_ARTIFACT_REUSE (no recorded artifact to search with)'] }));
    }
    if (site.changed_since_inspection) {
      const t = tried(s, 'TEMPORAL_RECHECK', subject);
      gaps.push(gap('SITE_REPLACEMENT', subject, { current: 'A material public change was recorded after inspection.', missing: `Is ${site.key} now a different deployment (new build, new wallet)?`, uncertainty: .6,
        time_sensitivity: .45, status: active(t) ? 'in_progress' : finishedEmpty(t) >= 1 ? 'exhausted' : 'open' }));
    }
    if (!site.timing_known && s.hunter.present) gaps.push(gap('DEPLOYMENT_TIMING', subject, { current: 'No first-seen/registration chronology recorded.', missing: `When was ${site.key} deployed relative to the others?`, uncertainty: .4, coverage: 1 / Math.max(1, sites.length), status: 'temporarily_low_value' }));
    if (site.report && site.report.ready && !site.report.destination) gaps.push(gap('REPORT_DESTINATION', subject, { current: 'Report contents are ready.', missing: 'Where will an approved report be submitted?', uncertainty: .3, status: 'waiting_for_human', tests: [], report_blocking: 1 }));
  }
  for (const w of s.wallets) {
    const subject = `wallet:${w.identity}`;
    if (w.context !== 'deposit') continue; // transaction-history and example addresses are context, not deposit evidence
    if (w.validation === 'network_ambiguous') { gaps.push(gap('WALLET_NETWORK', subject, { current: 'Wallet Investigator found an ambiguous network.', missing: 'Which network does the site display for this deposit address?', uncertainty: .7, status: 'waiting_for_human', tests: [], report_blocking: 1 })); continue; }
    if (['pending', 'queued', 'unable_to_validate'].includes(w.validation)) {
      gaps.push(gap('WALLET_VALIDATION', subject, { current: `Observed in deposit context; validation ${w.validation}.`, missing: `Is ${w.address} a valid address on the displayed network?`, uncertainty: .8,
        status: w.owned_by_director || w.validation === 'queued' ? 'in_progress' : w.validation === 'unable_to_validate' ? 'exhausted' : 'open', report_blocking: 1, time_sensitivity: .3 }));
      continue;
    }
    if (w.validation !== 'valid') continue;
    if (w.analysis !== 'completed') {
      const waiting = w.provider === 'unavailable' && !w.provider_ready;
      gaps.push(gap('BLOCKCHAIN_ACTIVITY', subject, { current: `Validated deposit wallet; chain analysis ${w.analysis}.`, missing: `What read-only activity does ${w.address} show?`, uncertainty: .7, report_blocking: 1,
        status: waiting ? 'waiting_for_provider' : w.owned_by_director || w.analysis === 'queued' ? 'in_progress' : 'open', dependencies: [`WALLET_VALIDATION:${subject}`] }));
      gaps.push(gap('REPORT_EVIDENCE', `investigation:${w.investigation_id}`, { current: 'Report blocked on chain evidence for a validated deposit wallet.', missing: 'Complete chain evidence for the report.', uncertainty: .7, report_blocking: 1,
        status: waiting ? 'waiting_for_provider' : w.owned_by_director ? 'in_progress' : 'open', dependencies: [`BLOCKCHAIN_ACTIVITY:${subject}`], tests: ['BLOCKCHAIN_REFRESH'] }));
    }
    if (w.validated_sites < 2) {
      const reviewed = w.reuse_reviewed, searched = w.reuse_searched;
      gaps.push(gap('WALLET_REUSE', subject, { current: `Validated deposit observation on ${w.validated_sites} site(s).`, missing: `Is ${w.address} independently presented by another deployment?`, uncertainty: .75,
        status: reviewed && searched ? 'exhausted' : 'open', supporting: [], dependencies: [] }));
    }
    if (w.rotation_suspected) {
      const t = tried(s, 'TEMPORAL_RECHECK', `site:${w.site_key}`);
      gaps.push(gap('WALLET_ROTATION', subject, { current: 'Deposit wallet changed between observations.', missing: 'Which deposit wallet is current, and since when?', uncertainty: .6, time_sensitivity: .6, status: active(t) ? 'in_progress' : finishedEmpty(t) ? 'exhausted' : 'open' }));
    }
  }
  for (const a of s.artifacts.filter(a => a.distinctive)) {
    const family: GapFamily = a.kind === 'contact' ? 'CONTACT_REUSE' : a.kind === 'wallet' ? 'WALLET_REUSE' : 'PUBLIC_ARTIFACT_REUSE';
    if (family === 'WALLET_REUSE') continue; // covered per validated wallet above
    gaps.push(gap(family, `artifact:${a.kind}:${a.value}`, { current: `${a.kind} ${a.value} recorded on ${a.sites} site(s).`, missing: `Do other deployments publicly reuse ${a.kind} ${a.value}?`, uncertainty: .7,
      status: a.searched ? 'exhausted' : 'open' }));
  }
  if ((s.units.template_similarity ?? 0) > 0) gaps.push(gap('TEMPLATE_SPECIFICITY', `scope:${s.scope.id}`, { current: `${s.units.template_similarity} template-similarity unit(s).`, missing: 'Does the template variant occur outside this operation (shared kit)?', uncertainty: .5,
    status: tried(s, 'RELATED_SITE_HUNT', `template:${s.scope.id}`).some(h => h.status === 'finished') ? 'exhausted' : 'open' }));
  if ((s.units.infrastructure_context ?? 0) > 0) gaps.push(gap('INFRASTRUCTURE_SPECIFICITY', `scope:${s.scope.id}`, { current: `${s.units.infrastructure_context} infrastructure unit(s).`, missing: 'Is the shared infrastructure generic (CDN) or specific?', uncertainty: .5,
    status: tried(s, 'CORRELATION_REVIEW', `infra:${s.scope.id}`).some(h => h.status === 'finished') ? 'exhausted' : 'open' }));
  for (const q of s.questions) {
    const open = q.alternatives.filter(a => ['open', 'challenged'].includes(a.status));
    if (open.length < 2) continue;
    const prior = open[0].verdict === 'favoured' ? .6 : .5;
    gaps.push(gap('HYPOTHESIS_DISCRIMINATION', `question:${q.key}`, { current: `${open.length} competing explanations remain: ${open.map(a => a.label).join(' / ')}.`, missing: q.question, uncertainty: .85,
      supporting: q.supports ? [`${q.supports} supporting reference(s)`] : [], contradicting: q.contradicts ? [`${q.contradicts} challenging reference(s)`] : [],
      discrimination: { question: q.question, a: open[0].label, b: open[1].label, prior, kind: q.kind ?? questionKind(q.key, q.question) } }));
  }
  for (const c of s.contradictions.filter(c => c.status === 'open')) {
    gaps.push(gap('CONTRADICTION_RESOLUTION', `contradiction:${c.fingerprint}`, { current: c.summary, missing: 'Which evidence resolves this contradiction?', uncertainty: .8, contradicting: [c.summary],
      status: c.new_evidence_since_hunter ? 'open' : 'waiting_for_evidence' }));
  }
  const relatedTries = s.history.filter(h => h.family === 'RELATED_SITE_HUNT' && h.status === 'finished');
  const relatedEmpty = relatedTries.length && relatedTries.slice(-3).every(h => !h.useful) && relatedTries.length >= 3;
  const relatedRunning = s.history.some(h => (h.family === 'RELATED_SITE_HUNT' || h.family === 'PUBLIC_ARTIFACT_SEARCH' || h.family === 'REPLACEMENT_SITE_HUNT') && h.status !== 'finished');
  if (sites.length) gaps.push(gap('RELATED_SITE', `scope:${s.scope.id}`, { current: `${sites.length} known deployment(s); ${relatedTries.length} related-site request(s) finished${relatedRunning ? '; one is running' : ''}.`, missing: 'Are there undiscovered public deployments of this operation?', uncertainty: clamp(.8 - .1 * relatedTries.length, .2),
    // Saturation of one TEST (e.g. seed-only hunts) is scored on that test; the QUESTION stays open for new inputs.
    status: relatedRunning ? 'in_progress' : 'open', coverage: 1, supporting: relatedEmpty ? ['The last three related-site requests delivered nothing new.'] : [] }));
  if (s.waves.newest_unhunted) gaps.push(gap('CAMPAIGN_WAVE', `scope:${s.scope.id}`, { current: `${s.waves.count} possible deployment wave(s) recorded by Hunter.`, missing: 'Which sites belong to the newest possible wave?', uncertainty: .7, time_sensitivity: .75 }));
  // Dependency wiring: a gap whose prerequisite family is still open on the same subject is blocked.
  const openKeys = new Map(gaps.filter(g => !['resolved', 'exhausted'].includes(g.status)).map(g => [g.key, g] as const));
  for (const g of gaps) for (const dep of g.dependencies) { const d = openKeys.get(dep); if (d && d !== g && g.status === 'open' && !['waiting_for_human'].includes(d.status)) g.status = 'blocked_by_dependency'; }
  return gaps.sort((a, b) => a.key.localeCompare(b.key));
}

const seedsOf = (s: Snapshot) => {
  const inspected = s.sites.filter(x => x.association !== 'excluded' && x.inspected && x.status !== 'dead').map(x => x.key);
  return [...new Set([...(s.scope.seed ? [s.scope.seed] : []), ...inspected])].slice(0, 8);
};

/** Generates bounded candidate tests for open gaps. Prerequisite failures are kept (with a reason) for explanation. */
export function generateCandidates(s: Snapshot, gaps: Gap[]): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (family: TestFamily, subject: string, gapKey: string, objective: Objective, inputs: unknown, prereq: string | null = null) => {
    const inputs_hash = fnv(JSON.stringify([family, subject, inputs]));
    const key = `${family}:${subject}:${inputs_hash}`;
    const cur = out.get(key);
    if (cur) { if (!cur.gaps.includes(gapKey)) cur.gaps.push(gapKey); return; }
    out.set(key, { key, family, subject, gaps: [gapKey], objective, inputs_hash, prerequisites_met: !prereq, prerequisite: prereq ?? undefined, bounds: TESTS[family].bounds });
  };
  const site = (k: string) => s.sites.find(x => `site:${x.key}` === k);
  const distinct = s.artifacts.filter(a => a.distinctive);
  // Artifact searches and replacement hunts surface related deployments: they also answer the open RELATED_SITE gap.
  const related = gaps.find(x => x.family === 'RELATED_SITE' && x.status === 'open');
  const addRelated = (family: TestFamily, subject: string, gapKey: string, objective: Objective, inputs: unknown, prereq: string | null = null) => {
    add(family, subject, gapKey, objective, inputs, prereq);
    if (related) add(family, subject, related.key, objective, inputs, prereq);
  };
  for (const g of gaps) {
    if (!['open'].includes(g.status)) continue;
    switch (g.family) {
      case 'SITE_IDENTITY': case 'OPERATION_MEMBERSHIP': {
        const x = site(g.subject); if (!x) break;
        add('PUBLIC_SITE_INSPECTION', g.subject, g.key, { kind: 'site', site: x.key, text: `Inspect the public pages of ${x.key}.` }, [x.key], x.investigation_id ? null : 'The site is not attached to an investigation yet.');
        break;
      }
      case 'PAYMENT_INTERFACE': case 'DEPOSIT_WALLET': {
        const x = site(g.subject); if (!x) break;
        add('LIKELY_WALLET_PAGE_INSPECTION', g.subject, g.key, { kind: 'site', site: x.key, mode: 'likely_wallet_pages', text: `Re-check likely public deposit pages of ${x.key} (no login).` }, [x.key], x.investigation_id ? null : 'No investigation boundary.');
        break;
      }
      case 'WALLET_VALIDATION': {
        const w = s.wallets.find(x => `wallet:${x.identity}` === g.subject); if (!w) break;
        add('WALLET_VALIDATION', g.subject, g.key, { kind: 'wallet', wallet: w.id, text: `Validate ${w.address} with Wallet Investigator.` }, [w.id]);
        break;
      }
      case 'BLOCKCHAIN_ACTIVITY': case 'REPORT_EVIDENCE': {
        const w = g.family === 'BLOCKCHAIN_ACTIVITY' ? s.wallets.find(x => `wallet:${x.identity}` === g.subject) : s.wallets.find(x => `investigation:${x.investigation_id}` === g.subject && x.validation === 'valid' && x.analysis !== 'completed');
        if (!w) break;
        add('BLOCKCHAIN_REFRESH', `wallet:${w.identity}`, g.key, { kind: 'wallet', wallet: w.id, text: `Refresh read-only chain activity for ${w.address}.` }, [w.id, w.analysis], w.provider === 'unavailable' && !w.provider_ready ? 'Provider backoff has not expired.' : null);
        break;
      }
      case 'WALLET_REUSE': {
        const w = s.wallets.find(x => `wallet:${x.identity}` === g.subject); if (!w) break;
        if (!w.reuse_reviewed) add('CORRELATION_REVIEW', g.subject, g.key, { kind: 'local', wallet: w.id, text: `Check Main's existing validated observations of ${w.address}.` }, [w.identity, w.validated_sites]);
        if (!w.reuse_searched) addRelated('PUBLIC_ARTIFACT_SEARCH', `artifact:wallet:${w.identity}`, g.key, { kind: 'finder', seeds: w.site_key ? [w.site_key] : seedsOf(s).slice(0, 1), artifacts: [{ kind: 'wallet', value: w.address }], text: `Search public sites for independent reuse of wallet ${w.address}.` }, [w.identity]);
        break;
      }
      case 'WALLET_ROTATION': case 'SITE_REPLACEMENT': {
        const key = g.family === 'WALLET_ROTATION' ? s.wallets.find(x => `wallet:${x.identity}` === g.subject)?.site_key : site(g.subject)?.key;
        if (!key) break;
        add('TEMPORAL_RECHECK', `site:${key}`, g.key, { kind: 'site', site: key, mode: 'temporal', text: `Re-check ${key} for build, wallet or status changes.` }, [key, g.family]);
        break;
      }
      case 'PUBLIC_ARTIFACT_REUSE': case 'CONTACT_REUSE': {
        const [, kind, ...rest] = g.subject.split(':'); const value = rest.join(':');
        const a = distinct.find(x => x.kind === kind && x.value === value);
        addRelated('PUBLIC_ARTIFACT_SEARCH', g.subject, g.key, { kind: 'finder', seeds: a?.site_key ? [a.site_key] : seedsOf(s).slice(0, 2), artifacts: [{ kind, value }], text: `Search for public sites containing ${kind} ${value}.` }, [kind, value]);
        break;
      }
      case 'TEMPLATE_SPECIFICITY': {
        // A template-variant search also surfaces related deployments (and other kit users): it answers RELATED_SITE too.
        const related = gaps.find(x => x.family === 'RELATED_SITE' && x.status === 'open');
        add('RELATED_SITE_HUNT', `template:${s.scope.id}`, g.key, { kind: 'finder', seeds: seedsOf(s).slice(0, 2), mode: 'template_variant', text: 'Test whether the template variant occurs outside this operation.' }, [seedsOf(s).slice(0, 2)]);
        if (related) add('RELATED_SITE_HUNT', `template:${s.scope.id}`, related.key, { kind: 'finder', seeds: seedsOf(s).slice(0, 2), mode: 'template_variant', text: 'Test whether the template variant occurs outside this operation.' }, [seedsOf(s).slice(0, 2)]);
        break;
      }
      case 'INFRASTRUCTURE_SPECIFICITY':
        add('CORRELATION_REVIEW', `infra:${s.scope.id}`, g.key, { kind: 'local', text: 'Count how many unrelated records share the infrastructure indicators.' }, [s.units.infrastructure_context]);
        break;
      case 'HYPOTHESIS_DISCRIMINATION': case 'CONTRADICTION_RESOLUTION': {
        if (s.hunter.present) add('HUNTER_HYPOTHESIS_TEST', `hunter:${s.scope.id}`, g.key, { kind: 'hunter', question: g.family === 'HYPOTHESIS_DISCRIMINATION' ? `Does current evidence discriminate "${g.discrimination?.a}" from "${g.discrimination?.b}"? Which evidence would?` : `Which evidence resolves: ${g.current}`, text: 'Ask Operation Hunter a structured discriminating question.' }, [g.key, s.hunter.evidence_since_last_analysis]);
        for (const w of s.wallets.filter(w => w.validation === 'valid' && w.context === 'deposit' && w.validated_sites < 2)) {
          if (!w.reuse_reviewed) add('CORRELATION_REVIEW', `wallet:${w.identity}`, g.key, { kind: 'local', wallet: w.id, text: `Check Main's existing validated observations of ${w.address}.` }, [w.identity, w.validated_sites]);
          if (!w.reuse_searched) addRelated('PUBLIC_ARTIFACT_SEARCH', `artifact:wallet:${w.identity}`, g.key, { kind: 'finder', seeds: w.site_key ? [w.site_key] : seedsOf(s).slice(0, 1), artifacts: [{ kind: 'wallet', value: w.address }], text: `Search public sites for independent reuse of wallet ${w.address}.` }, [w.identity]);
        }
        for (const a of distinct.filter(a => !a.searched && a.kind !== 'wallet')) addRelated('PUBLIC_ARTIFACT_SEARCH', `artifact:${a.kind}:${a.value}`, g.key, { kind: 'finder', seeds: a.site_key ? [a.site_key] : seedsOf(s).slice(0, 2), artifacts: [{ kind: a.kind, value: a.value }], text: `Search for public sites containing ${a.kind} ${a.value}.` }, [a.kind, a.value]);
        if ((s.units.template_similarity ?? 0) > 0) add('RELATED_SITE_HUNT', `template:${s.scope.id}`, g.key, { kind: 'finder', seeds: seedsOf(s).slice(0, 2), mode: 'template_variant', text: 'Test whether the template variant occurs outside this operation.' }, [seedsOf(s).slice(0, 2)]);
        break;
      }
      case 'RELATED_SITE': case 'CAMPAIGN_WAVE': {
        const seeds = seedsOf(s), arts = distinct.slice(0, 8).map(a => ({ kind: a.kind, value: a.value }));
        add('RELATED_SITE_HUNT', `scope:${s.scope.id}`, g.key, { kind: 'finder', seeds, artifacts: arts, mode: g.family === 'CAMPAIGN_WAVE' ? 'wave' : 'related', text: g.family === 'CAMPAIGN_WAVE' ? 'Search for deployments of the newest possible wave.' : `Search for public deployments related to ${seeds.slice(0, 3).join(', ')}.` }, [seeds, arts], seeds.length ? null : 'No recorded seed site.');
        break;
      }
      case 'REPLACEMENT_SITE': {
        const x = site(g.subject); if (!x) break;
        const arts = s.artifacts.filter(a => a.site_key === x.key || a.distinctive).slice(0, 8).map(a => ({ kind: a.kind, value: a.value }));
        addRelated('REPLACEMENT_SITE_HUNT', g.subject, g.key, { kind: 'finder', seeds: [x.key], artifacts: arts, mode: 'replacement', text: `Search for a replacement deployment of ${x.key} using its recorded artifacts.` }, [x.key, arts], arts.length ? null : 'No recorded artifact for the disappeared site.');
        break;
      }
      default: break;
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export { dependents };
