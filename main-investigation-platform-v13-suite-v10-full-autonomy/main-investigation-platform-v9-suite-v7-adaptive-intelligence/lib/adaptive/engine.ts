import {scientificChoice} from '../scientific/model';
import {scientificEnabled,projectScientific,recordBranches,prepareScientificPlan,falsificationRemaining,enrichScientificSnapshot} from '../scientific/engine';
/**
 * v7 Adaptive Investigation Intelligence — the durable loop.
 *
 *   model uncertainty -> typed gaps -> bounded tests -> information value -> cost -> choose
 *   -> execute through an EXISTING specialist -> measure -> attribute -> learn -> reprioritize
 *   -> stop (park with wake conditions) when marginal value is low
 *
 * Crash boundaries: every state transition is one atomic D1 batch gated on the previous state,
 * and every identity is deterministic (decision per observable state, test per decision, hunt
 * fingerprint per test generation), so a restart replays to the same logical work exactly once.
 *
 * Writes only coordination/decision-learning metadata. Never evidence, validation, reports or
 * ownership assertions. Hunter stays the inference authority; Wallet Investigator stays the
 * wallet/chain authority; Finder returns observations only.
 */
import { getD1, sha256, json } from '../platform';
import { parse, getNum, getState, type Row } from '../ops/common';
import { TESTS, GAPS, type TestFamily, type WakeCondition } from './ontology';
import { deriveGaps, generateCandidates, type Gap, type Snapshot, type FamilyLearning } from './derive';
import { choose, explain, POLICY, type Valued, type Choice } from './value';
import { creditShares, budgetAdjustment, combine, gapState, wakeReasons, BUDGET, type Link, type SatState } from './policy';
import { loadOperationSnapshot, familyLearning, operationWatermark } from './snapshot';

const all = async (q: string, ...a: unknown[]) => (await getD1().prepare(q).bind(...a).all<Row>()).results;
const one = async (q: string, ...a: unknown[]) => getD1().prepare(q).bind(...a).first<Row>();
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const ts = (v: unknown) => { const s = String(v ?? ''); if (!s) return 0; const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; };
/** Test families that spend public requests or Hunter effort and so count against operation hunt allowances. */
export const HUNT_FAMILIES = new Set<TestFamily>(['RELATED_SITE_HUNT', 'PUBLIC_ARTIFACT_SEARCH', 'REPLACEMENT_SITE_HUNT', 'HUNTER_HYPOTHESIS_TEST', 'PUBLIC_SITE_INSPECTION', 'LIKELY_WALLET_PAGE_INSPECTION', 'TEMPORAL_RECHECK']);
const COST_DIMS = ['jobs', 'http', 'dns', 'certificate', 'rdap', 'provider_calls', 'retries', 'worker_ms', 'wall_ms', 'bytes'] as const;

export async function adaptiveInstalled() { return Boolean(await one("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_tests'")); }
export async function adaptiveEnabled() { return (await adaptiveInstalled()) && (await getState('adaptive_enabled', 'true')) !== 'false'; }

// ------------------------------------------------------------------------------------------------
// Gaps
// ------------------------------------------------------------------------------------------------
/** Upserts the current typed gap set; gaps no longer derived are resolved (history is immutable). */
export async function persistGaps(kind: string, id: string, gaps: Gap[]) {
  const db = getD1(), at = now(), stmts: D1PreparedStatement[] = [];
  const existing = new Map((await all('SELECT gap_key,status,content_hash FROM adaptive_gaps WHERE scope_kind=? AND scope_id=?', kind, id)).map(r => [String(r.gap_key), r] as const));
  const transitions: Array<{ key: string; to: string }> = [];
  for (const g of gaps) {
    const detail = { family: g.family, subject: g.subject, status: g.status, uncertainty: g.uncertainty, current: g.current, missing: g.missing, tests: g.tests, dependencies: g.dependencies, supporting: g.supporting, contradicting: g.contradicting };
    const hash = await sha256(json(detail)), prev = existing.get(g.key);
    if (prev?.content_hash === hash) continue;
    stmts.push(db.prepare(`INSERT INTO adaptive_gaps(scope_kind,scope_id,gap_key,family,subject,current_knowledge,missing_knowledge,why_matters,supporting,contradicting,uncertainty,possible_tests,dependencies,status,exhaustion_condition,revisit_condition,content_hash,first_seen,updated_at,resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(scope_kind,scope_id,gap_key) DO UPDATE SET current_knowledge=excluded.current_knowledge,missing_knowledge=excluded.missing_knowledge,supporting=excluded.supporting,contradicting=excluded.contradicting,
     uncertainty=excluded.uncertainty,possible_tests=excluded.possible_tests,dependencies=excluded.dependencies,status=excluded.status,content_hash=excluded.content_hash,updated_at=excluded.updated_at,resolved_at=NULL`)
      .bind(kind, id, g.key, g.family, g.subject, g.current, g.missing, g.matters, json(g.supporting), json(g.contradicting), g.uncertainty, json(g.tests), json(g.dependencies), g.status, g.exhaustion, json(g.revisit), hash, at, at));
    stmts.push(db.prepare('INSERT OR IGNORE INTO adaptive_gap_history(id,scope_kind,scope_id,gap_key,status,content_hash,detail,at) VALUES (?,?,?,?,?,?,?,?)').bind(await sha256(`${kind}:${id}:${g.key}:${hash}`), kind, id, g.key, g.status, hash, json(detail), at));
    if (prev && prev.status !== g.status && ['exhausted', 'resolved'].includes(g.status)) transitions.push({ key: g.key, to: g.status });
  }
  const live = new Set(gaps.map(g => g.key));
  for (const [key, prev] of existing) if (!live.has(key) && prev.status !== 'resolved') {
    const hash = await sha256(json({ resolved: key, after: prev.content_hash }));
    stmts.push(db.prepare("UPDATE adaptive_gaps SET status='resolved',resolved_at=?,updated_at=?,content_hash=? WHERE scope_kind=? AND scope_id=? AND gap_key=? AND status<>'resolved'").bind(at, at, hash, kind, id, key));
    stmts.push(db.prepare('INSERT OR IGNORE INTO adaptive_gap_history(id,scope_kind,scope_id,gap_key,status,content_hash,detail,at) VALUES (?,?,?,?,?,?,?,?)').bind(await sha256(`${kind}:${id}:${key}:${hash}`), kind, id, key, 'resolved', hash, json({ resolved_because: 'No longer derivable from current authoritative records.' }), at));
    transitions.push({ key, to: 'resolved' });
  }
  // Gap resolution lineage: the most recent finished test that targeted the gap (no causal claim beyond that).
  for (const t of transitions) {
    const test = await one(`SELECT id FROM adaptive_tests WHERE scope_kind=? AND scope_id=? AND status IN ('finished','failed') AND gap_keys LIKE ? AND finished_at>=? ORDER BY finished_at DESC LIMIT 1`, kind, id, `%${t.key.replace(/[%_]/g, '')}%`, later(-7 * 86400000));
    if (!test) continue;
    stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,'gap_resolution','gap',?,'derived',?,?)").bind(await sha256(`gapres:${test.id}:${t.key}`), test.id, t.key, json({ to: t.to }), at));
    if (t.to === 'resolved') stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) SELECT 'gap_resolved',?,id,1,'derived',family,scope_kind,scope_id,?,? FROM adaptive_tests WHERE id=? AND NOT EXISTS(SELECT 1 FROM adaptive_outcomes WHERE outcome_kind='gap_resolved' AND outcome_ref=?)`).bind(`${kind}:${id}:${t.key}`, json({ gap: t.key }), at, test.id, `${kind}:${id}:${t.key}`));
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  return { changed: stmts.length, transitions };
}

// ------------------------------------------------------------------------------------------------
// Decisions
// ------------------------------------------------------------------------------------------------
async function stateHash(s: Snapshot, gaps: Gap[], choice: Choice) {
  return sha256(json({ gaps: gaps.map(g => [g.key, g.status, g.uncertainty]), ranked: choice.ranked.map(v => [v.key, v.eligible, Math.round(v.utility * 100)]), history: s.history.map(h => [h.family, h.subject, h.inputs_hash, h.status, h.useful]), budget: s.budget.remaining }));
}

/** Persists one decision per observable state with every candidate's components. Idempotent. */
export async function recordDecision(kind: string, id: string, s: Snapshot, gaps: Gap[], choice: Choice) {
  const db = getD1(), hash = await stateHash(s, gaps, choice);
  const existing = await one('SELECT * FROM adaptive_decisions WHERE scope_kind=? AND scope_id=? AND state_hash=?', kind, id, hash);
  if (existing) return existing;
  const e = explain(choice, gaps), decisionId = await sha256(`adaptive-decision:${kind}:${id}:${hash}`);
  const seq = Number((await one('SELECT COALESCE(MAX(seq),0)+1 n FROM adaptive_decisions WHERE scope_kind=? AND scope_id=?', kind, id))?.n ?? 1);
  const c = choice.chosen;
  const stmts: D1PreparedStatement[] = [db.prepare(`INSERT OR IGNORE INTO adaptive_decisions(id,scope_kind,scope_id,seq,state_hash,status,chosen_key,chosen_family,exploration,question,why_matters,why_selected,deferred,stop_state,stop_reason,utility,expected_cost,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(decisionId, kind, id, seq, hash, c ? 'decided' : 'stopped', c?.key ?? null, c?.family ?? null, choice.exploration ? 1 : 0, e.question, e.matters, e.why, json(e.deferred),
    choice.stop?.state ?? null, choice.stop?.reason ?? null, c?.utility ?? null, json(c ? { effort_units: c.cost_units, bounds: c.bounds } : {}), now())];
  for (const v of choice.ranked.slice(0, 12)) for (const [component, x] of Object.entries(v.components))
    stmts.push(db.prepare('INSERT OR IGNORE INTO adaptive_decision_components(decision_id,candidate_key,family,subject,component,value,weight,contribution,reason) VALUES (?,?,?,?,?,?,?,?,?)').bind(decisionId, v.key, v.family, v.subject, component, x.value, x.weight, x.contribution, x.reason));
  stmts.push(db.prepare(`INSERT INTO adaptive_scope_state(scope_kind,scope_id,decisions,last_utility,last_summary,updated_at) VALUES (?,?,1,?,?,?) ON CONFLICT(scope_kind,scope_id) DO UPDATE SET decisions=decisions+1,last_utility=excluded.last_utility,last_summary=excluded.last_summary,updated_at=excluded.updated_at`)
    .bind(kind, id, c?.utility ?? 0, json({ chose: e.chose, question: e.question, stop: choice.stop }), now()));
  await db.batch(stmts);
  return await one('SELECT * FROM adaptive_decisions WHERE id=?', decisionId);
}

/** Saturation at test, gap, branch, operation and investigation level (portfolio level is written by the portfolio pass). */
async function recordSaturation(kind: string, id: string, gaps: Gap[], choice: Choice) {
  const db = getD1(), at = now(), stmts: D1PreparedStatement[] = [];
  const put = (level: string, key: string, state: SatState, reason: string) => stmts.push(db.prepare('INSERT INTO adaptive_saturation(level,scope_key,state,reason,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(level,scope_key) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at WHERE adaptive_saturation.state<>excluded.state OR adaptive_saturation.reason<>excluded.reason').bind(level, key, state, reason.slice(0, 300), at));
  for (const v of choice.ranked.slice(0, 10)) {
    const state: SatState = v.components.duplicate_probability.value >= .85 ? 'exhausted' : v.components.saturation.value >= .5 || !v.eligible ? 'temporarily_low_value' : 'active';
    put('test', `${kind}:${id}:${v.family}:${v.subject}`, state, v.ineligible_reason ?? v.components.saturation.reason);
  }
  const branch = new Map<string, SatState[]>();
  for (const g of gaps) { put('gap', `${kind}:${id}:${g.key}`, gapState(g.status), `${g.status}: ${g.missing}`); branch.set(g.family, [...(branch.get(g.family) ?? []), gapState(g.status)]); }
  for (const [family, states] of branch) put('branch', `${kind}:${id}:${family}`, combine(states), `${states.length} ${family} gap(s)`);
  const scopeState: SatState = choice.chosen ? 'active' : (choice.stop?.state ?? 'exhausted');
  put(kind, `${kind}:${id}`, scopeState, choice.chosen ? `Testing: ${choice.chosen.family}` : choice.stop?.reason ?? 'No test available.');
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

// ------------------------------------------------------------------------------------------------
// Local tests (Main reading its own authoritative records; no network)
// ------------------------------------------------------------------------------------------------
async function runLocalTest(decision: Row, v: Valued, s: Snapshot) {
  const db = getD1(), testId = await sha256(`adaptive-test:${decision.id}`), started = Date.now(), at = now();
  const generation = Number((await one(`SELECT COUNT(*) n FROM adaptive_tests WHERE scope_kind=? AND scope_id=? AND family=? AND inputs_hash=?`, decision.scope_kind, decision.scope_id, v.family, v.inputs_hash))?.n ?? 0);
  const scientificOn=await scientificEnabled();
  if(scientificOn){
    await db.prepare(`INSERT OR IGNORE INTO adaptive_tests(id,decision_id,scope_kind,scope_id,family,subject,inputs_hash,generation,gap_keys,objective,safety_class,specialist,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`).bind(testId,decision.id,decision.scope_kind,decision.scope_id,v.family,v.subject,v.inputs_hash,generation,json(v.gaps),json(v.objective),TESTS[v.family].safety,TESTS[v.family].specialist,at).run();
    await prepareScientificPlan((await one('SELECT * FROM adaptive_tests WHERE id=?',testId))!);
  }
  let outcome: Row = {}, useful = 0;
  if (v.subject.startsWith('wallet:')) {
    const w = s.wallets.find(x => `wallet:${x.identity}` === v.subject);
    const rows = w ? await all(`SELECT DISTINCT c.investigation_id,c.id FROM wallet_candidates c WHERE c.identity=? AND c.validated_network=? AND c.validation_status='valid' AND c.best_context='deposit' AND c.investigation_id<>? LIMIT 20`, w.identity, w.network, w.investigation_id) : [];
    useful = rows.length ? 1 : 0;
    outcome = { reviewed: 'validated deposit observations', other_investigations: rows.map(r => r.investigation_id), inputs_validated_sites: w?.validated_sites ?? 0, caveat: 'A shared validated deposit observation is a correlation signal, not common ownership.', dead_end: !useful };
  } else {
    const infra = await all(`SELECT oe.target_entity_id entity,(SELECT COUNT(DISTINCT r.source_entity_id) FROM relationships r WHERE r.target_entity_id=oe.target_entity_id) degree FROM operation_edges oe WHERE oe.operation_id=? AND oe.category='infrastructure_context' GROUP BY oe.target_entity_id LIMIT 20`, decision.scope_id);
    const generic = infra.filter(r => Number(r.degree) >= 5).length;
    useful = infra.length ? 1 : 0;
    outcome = { reviewed: 'infrastructure indicators', indicators: infra.length, generic_indicators: generic, determination: generic ? 'At least one shared indicator is widely shared (generic); it is context only.' : 'Shared indicators are not widely shared in Main\'s records; still context, not ownership.', generic_evidence: true };
  }
  const wall = Date.now() - started;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO adaptive_tests(id,decision_id,scope_kind,scope_id,family,subject,inputs_hash,generation,gap_keys,objective,safety_class,specialist,exploration,status,outcome,useful,created_at,started_at,finished_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'finished',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM adaptive_decisions WHERE id=? AND status='decided')`)
      .bind(testId, decision.id, decision.scope_kind, decision.scope_id, v.family, v.subject, v.inputs_hash, generation, json(v.gaps), json(v.objective), TESTS[v.family].safety, TESTS[v.family].specialist, Number(decision.exploration), json(outcome), useful, at, at, now(), decision.id),
    db.prepare("UPDATE adaptive_decisions SET status='finished',test_id=?,finished_at=?,actual_cost=?,changed=? WHERE id=? AND status='decided' AND EXISTS(SELECT 1 FROM adaptive_tests WHERE id=?)").bind(testId, now(), json({ wall_ms: wall, external_requests: 0 }), json(outcome), decision.id, testId),
  ];
  for (const d of COST_DIMS) stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_costs(test_id,dimension,reserved,consumed,measured,source,recorded_at) SELECT ?,?,?,?,1,'main_local',? WHERE EXISTS(SELECT 1 FROM adaptive_tests WHERE id=?)").bind(testId, d, 0, d === 'wall_ms' ? wall : d === 'bytes' ? null : 0, now(), testId));
  stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) SELECT ?,?,'decision','decision',?,'provenance','{}',? WHERE EXISTS(SELECT 1 FROM adaptive_tests WHERE id=?)").bind(await sha256(`lin:${testId}:decision`), testId, decision.id, at, testId));
  stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) SELECT ?,?,'specialist_action','local',?,'provenance',?,? WHERE EXISTS(SELECT 1 FROM adaptive_tests WHERE id=?)").bind(await sha256(`lin:${testId}:local`), testId, v.subject, json({ specialist: 'main_local' }), at, testId));
  if(scientificOn)stmts.splice(1,0,db.prepare("UPDATE adaptive_tests SET status='finished',outcome=?,useful=?,started_at=?,finished_at=? WHERE id=? AND status='reserved'").bind(json(outcome),useful,at,now(),testId));
  await db.batch(stmts);
  return { test_id: testId, useful, outcome };
}

// ------------------------------------------------------------------------------------------------
// Operation evaluation (phase 1). Returns an external candidate for the portfolio pass, if any.
// ------------------------------------------------------------------------------------------------
export type Pending = { decision: Row; chosen: Valued; scope: string; gap: Gap | undefined; snapshot: Snapshot };

export async function evaluateOperation(op: string, ctx: { learning: Record<string, FamilyLearning>; tick: string }): Promise<{ pending: Pending | null; state: string; reason: string; skipped?: boolean }> {
  const db = getD1();
  const parked = await one("SELECT * FROM adaptive_parking WHERE scope_kind='operation' AND scope_id=? AND woke_at IS NULL", op);
  const mark = await operationWatermark(op);
  if (parked) {
    const before = parse<Row>(parked.watermark, {}), changed = wakeReasons(before as never, mark as never);
    const sameOther = before.evidence_rows === mark.evidence_rows && before.finished_tests === mark.finished_tests;
    if (!changed.length && sameOther && ts(parked.next_check_at) > Date.now()) {
      await db.prepare("UPDATE adaptive_parking SET skipped_evaluations=skipped_evaluations+1 WHERE scope_kind='operation' AND scope_id=? AND woke_at IS NULL").bind(op).run();
      return { pending: null, state: String(parked.state), reason: `Parked: ${parked.reason} Waiting for: ${parse<string[]>(parked.wake_conditions, []).join(', ').replace(/_/g, ' ')}.`, skipped: true };
    }
    await db.prepare("UPDATE adaptive_parking SET woke_at=?,wake_reason=? WHERE scope_kind='operation' AND scope_id=? AND woke_at IS NULL").bind(now(), changed.join(',') || (sameOther ? 'scheduled_temporal_recheck' : 'new_independent_evidence'), op).run();
  }
  const maxLocal = await getNum('adaptive_local_tests_per_evaluation', 3);
  for (let round = 0; round <= maxLocal; round++) {
    const s = await loadOperationSnapshot(op, ctx.learning);
    if (!s) return { pending: null, state: 'ACTIVE', reason: 'Operation not found.' };
    if(await scientificEnabled())await enrichScientificSnapshot(op,s);
    const gaps = deriveGaps(s);
    await persistGaps('operation', op, gaps);
    const candidates = generateCandidates(s, gaps);
    const seq = Number((await one("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_kind='operation' AND scope_id=?", op))?.n ?? 0);
    const scientificOn=await scientificEnabled();
    if(scientificOn)await recordBranches(op,s,candidates,gaps);
    const choice = scientificOn ? scientificChoice(s,gaps,candidates,{seed:`${op}:${seq}`,falsificationRemaining:await falsificationRemaining(op,s.budget.max)}) : choose(s, gaps, candidates, { seed: `${op}:${seq}` });
    // Only one external test per operation at a time (v6 invariant); local reads may still proceed.
    const activeExternal = await one(`SELECT 1 x FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? AND status IN ('reserved','running') AND specialist<>'main_local' LIMIT 1`, op);
    if (activeExternal && choice.chosen && TESTS[choice.chosen.family].specialist !== 'main_local') {
      const local = choice.ranked.find(v => v.eligible && v.utility >= POLICY.utility_floor && TESTS[v.family].specialist === 'main_local');
      if (!local) return { pending: null, state: 'ACTIVE', reason: 'A bounded test is already running for this operation.' };
      choice.chosen = local; choice.exploration = false;
    }
    await recordSaturation('operation', op, gaps, choice);
    const decision = await recordDecision('operation', op, s, gaps, choice);
    if (!decision) return { pending: null, state: 'ACTIVE', reason: 'Decision unavailable.' };
    if (!choice.chosen || decision.status === 'stopped') {
      const stop = choice.stop ?? { state: 'temporarily_low_value' as const, reason: 'No test above the value floor.' };
      await park(op, stop.state, stop.reason, gaps, mark);
      return { pending: null, state: stop.state === 'temporarily_low_value' || stop.state === 'exhausted' ? 'SATURATED' : stop.state.toUpperCase(), reason: stop.reason };
    }
    if (TESTS[choice.chosen.family].specialist === 'main_local') {
      if (decision.status === 'decided') await runLocalTest(decision, choice.chosen, s);
      if (round === maxLocal) return { pending: null, state: 'ACTIVE', reason: 'Local review limit for this evaluation reached.' };
      continue;
    }
    if (decision.status !== 'decided') return { pending: null, state: 'ACTIVE', reason: String(decision.why_selected ?? 'Decision already acted on.') };
    return { pending: { decision, chosen: choice.chosen, scope: op, gap: gaps.find(g => g.key === choice.chosen!.primary_gap), snapshot: s }, state: 'ACTIVE', reason: String(decision.why_selected ?? '') };
  }
  return { pending: null, state: 'ACTIVE', reason: 'Evaluation bounded.' };
}

async function park(op: string, state: string, reason: string, gaps: Gap[], mark: Row) {
  const wake = new Set<WakeCondition>();
  for (const g of gaps.filter(g => !['resolved'].includes(g.status))) for (const w of GAPS[g.family].revisit) wake.add(w);
  if (!wake.size) wake.add('new_independent_evidence');
  wake.add('budget_refreshed');
  const recheck = gaps.some(g => ['SITE_REPLACEMENT', 'WALLET_ROTATION', 'REPLACEMENT_SITE'].includes(g.family)) ? 24 : 6;
  await getD1().prepare(`INSERT INTO adaptive_parking(scope_kind,scope_id,state,reason,wake_conditions,watermark,parked_at,next_check_at,skipped_evaluations,woke_at,wake_reason) VALUES ('operation',?,?,?,?,?,?,?,0,NULL,NULL)
   ON CONFLICT(scope_kind,scope_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,wake_conditions=excluded.wake_conditions,watermark=excluded.watermark,parked_at=excluded.parked_at,next_check_at=excluded.next_check_at,skipped_evaluations=0,woke_at=NULL,wake_reason=NULL`)
    .bind(op, state, reason.slice(0, 400), json([...wake].sort()), json(mark), now(), later(recheck * 3600000)).run();
}

// ------------------------------------------------------------------------------------------------
// Reservation and handoff (phase 2)
// ------------------------------------------------------------------------------------------------
/** Atomically reserves the chosen test (and, for public/Hunter work, a v6 operation hunt) under every cap. */
export async function reserveTest(p: Pending, caps: { active: number; daily: number }) {
  const db = getD1(), d = p.decision, v = p.chosen, op = p.scope, at = now();
  const testId = await sha256(`adaptive-test:${d.id}`);
  const generation = Number((await one(`SELECT COUNT(*) n FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? AND family=? AND inputs_hash=?`, op, v.family, v.inputs_hash))?.n ?? 0);
  const hunt = HUNT_FAMILIES.has(v.family), workKind = TESTS[v.family].work_kind;
  const fingerprint = `operation:${op}:${v.family}:${v.inputs_hash}:${generation}`, huntId = hunt ? await sha256(fingerprint) : null;
  const baseline = await one(`SELECT (SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=?1 AND evidence_ids<>'[]' AND category NOT IN ('infrastructure_context','template_similarity')) independent,
    (SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=?1 AND evidence_ids<>'[]' AND category IN ('infrastructure_context','template_similarity')) weak,
    (SELECT COUNT(*) FROM operation_contradictions WHERE operation_id=?1) contradictions,(SELECT COUNT(*) FROM operation_history WHERE operation_id=?1 AND kind='hypothesis') hypothesis_versions`, op);
  const gate = `EXISTS(SELECT 1 FROM adaptive_decisions WHERE id=? AND status='reserved' AND test_id=?)`;
  const capSql = hunt ? ` AND EXISTS(SELECT 1 FROM operation_state st WHERE st.operation_id=? AND st.hunts < st.max_hunts + COALESCE((SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=st.operation_id),0))
    AND (SELECT COUNT(*) FROM operation_hunts WHERE status IN ('reserved','running'))<? AND (SELECT COUNT(*) FROM operation_hunts WHERE created_at>=date('now'))<?
    AND NOT EXISTS(SELECT 1 FROM operation_hunts WHERE operation_id=? AND status IN ('reserved','running'))` : '';
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE adaptive_decisions SET status='reserved',test_id=? WHERE id=? AND status='decided' AND NOT EXISTS(SELECT 1 FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? AND status IN ('reserved','running') AND specialist<>'main_local')${capSql}`)
      .bind(testId, d.id, op, ...(hunt ? [op, caps.active, caps.daily, op] : [])),
    db.prepare(`INSERT OR IGNORE INTO adaptive_tests(id,decision_id,scope_kind,scope_id,family,subject,inputs_hash,generation,gap_keys,objective,safety_class,specialist,hunt_id,exploration,status,baseline,created_at)
     SELECT ?,?,'operation',?,?,?,?,?,?,?,?,?,?,?,'reserved',?,? WHERE ${gate}`).bind(testId, d.id, op, v.family, v.subject, v.inputs_hash, generation, json(v.gaps), json(v.objective), TESTS[v.family].safety, TESTS[v.family].specialist, huntId, Number(d.exploration), json(baseline ?? {}), at, d.id, testId),
  ];
  if (hunt && workKind) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO operation_hunts(id,operation_id,fingerprint,family,reason,value,baseline) SELECT ?,?,?,?,?,?,? WHERE ${gate}`)
      .bind(huntId, op, fingerprint, workKind, String(d.question ?? v.objective.text).slice(0, 400), v.utility, json({ independent_relationships: Number(baseline?.independent ?? 0), adaptive_test_id: testId }), d.id, testId));
    stmts.push(db.prepare(`UPDATE operation_state SET hunts=hunts+1,last_action_at=CURRENT_TIMESTAMP WHERE operation_id=? AND ${gate}`).bind(op, d.id, testId));
  }
  for (const dim of COST_DIMS) {
    const reserved = dim === 'jobs' ? v.bounds.jobs : dim === 'http' ? v.bounds.http : dim === 'dns' ? v.bounds.dns : dim === 'certificate' ? v.bounds.certificate : dim === 'rdap' ? v.bounds.rdap : dim === 'provider_calls' ? v.bounds.provider_calls : dim === 'wall_ms' || dim === 'worker_ms' ? v.bounds.effort_seconds * 1000 : 0;
    stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_costs(test_id,dimension,reserved,consumed,measured,source,recorded_at) SELECT ?,?,?,NULL,0,'reservation',? WHERE ${gate}`).bind(testId, dim, reserved, at, d.id, testId));
  }
  stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) SELECT ?,?,'decision','decision',?,'provenance',?,? WHERE ${gate}`).bind(await sha256(`lin:${testId}:decision`), testId, d.id, json({ question: d.question, exploration: Boolean(d.exploration) }), at, d.id, testId));
  stmts.push(db.prepare(`UPDATE adaptive_scope_state SET consecutive_starts=consecutive_starts+1,last_started_at=? WHERE scope_kind='operation' AND scope_id=? AND ${gate}`).bind(at, op, d.id, testId));
  stmts.push(db.prepare(`UPDATE adaptive_scope_state SET consecutive_starts=0 WHERE scope_kind='operation' AND scope_id<>? AND ${gate}`).bind(op, d.id, testId));
  const out = await db.batch(stmts);
  return out[0].meta.changes === 1 ? testId : null;
}

/** Hands reserved tests to existing specialists. Replay-safe: same fingerprint, same work item. */
export async function handoffReserved(op?: string) {
  const db = getD1();
  const rows = await all(`SELECT t.*,h.fingerprint,h.id hunt_row,o.seed,o.external_id,o.investigation_id op_investigation FROM adaptive_tests t JOIN hunter_operations o ON o.id=t.scope_id LEFT JOIN operation_hunts h ON h.id=t.hunt_id WHERE t.scope_kind='operation' AND (t.status='reserved' OR (t.status='running' AND h.status='reserved')) ${op ? 'AND t.scope_id=?' : ''} ORDER BY t.created_at LIMIT 10`, ...(op ? [op] : []));
  const { proposeWork } = await import('../ops/workitems');
  let handed = 0;
  for (const t of rows) {
    await prepareScientificPlan(t);
    const family = String(t.family) as TestFamily, spec = TESTS[family], objective = parse<Row>(t.objective, {});
    const site = objective.site ? await one(`SELECT e.id,(SELECT ie.investigation_id FROM investigation_entities ie WHERE ie.entity_id=e.id ORDER BY ie.rowid LIMIT 1) inv FROM entities e WHERE e.entity_type='site' AND e.canonical_key=?`, objective.site) : null;
    const opInv = t.op_investigation ? await one('SELECT id FROM investigations WHERE id=? OR external_id=?', t.op_investigation, t.op_investigation) : null;
    const inv = String(site?.inv ?? opInv?.id ?? '');
    const question = String((await one('SELECT question FROM adaptive_decisions WHERE id=?', t.decision_id))?.question ?? objective.text ?? '').slice(0, 360);
    if (spec.work_kind === 'wallet_pipeline' || (family === 'BLOCKCHAIN_REFRESH')) {
      // Wallet work belongs to the authoritative wallet pipeline / v5 Director; Main only asks it to act now.
      const c = await one('SELECT * FROM wallet_candidates WHERE id=?', objective.wallet);
      if (c) {
        const { advanceCandidate } = await import('../wallet-pipeline');
        await advanceCandidate(String(c.id));
        await db.prepare("UPDATE director_investigations SET next_at=NULL WHERE investigation_id=?").bind(c.investigation_id).run();
      }
      await db.batch([db.prepare("UPDATE adaptive_tests SET status='running',started_at=? WHERE id=? AND status='reserved'").bind(now(), t.id),
        db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,'specialist_action','wallet_candidate',?,'provenance',?,?)").bind(await sha256(`lin:${t.id}:wallet`), t.id, String(objective.wallet ?? ''), json({ specialist: 'wallet_investigator', route: 'wallet pipeline / investigation director' }), now())]);
      handed++; continue;
    }
    if (!spec.work_kind || !t.fingerprint) continue;
    if (!inv) { await db.prepare("UPDATE adaptive_tests SET status='failed',finished_at=?,outcome=? WHERE id=? AND status='reserved'").bind(now(), json({ error: 'No investigation boundary for this test.' }), t.id).run(); continue; }
    const firstSeed = Array.isArray(objective.seeds) && objective.seeds.length ? String(objective.seeds[0]) : '';
    const targetKey = String(objective.site ?? '') || firstSeed || String(t.seed ?? '');
    const w = await proposeWork({ kind: spec.work_kind as never, targetType: 'domain', targetKey: targetKey || String(t.seed), fingerprint: String(t.fingerprint), source: 'gap', investigationId: inv,
      reason: `${spec.title}: ${question}`.slice(0, 400), maxAttempts: 1, factors: { info_gain: .7, novelty: .6, open_gaps: .8, cost: .3 } });
    const payload = spec.work_kind === 'find_related_sites'
      ? { seeds: (Array.isArray(objective.seeds) && objective.seeds.length ? objective.seeds : [t.seed]).map(String).slice(0, 10), artifacts: Array.isArray(objective.artifacts) ? objective.artifacts.slice(0, 20) : [], operation_id: String(t.external_id), source: 'adaptive-intelligence',
          reason: String(objective.text ?? question).slice(0, 160), objective: { family, mode: objective.mode ?? null, text: objective.text, question }, budget: { http: spec.bounds.http, dns: spec.bounds.dns, crtsh: spec.bounds.certificate, rdap: spec.bounds.rdap } }
      : spec.work_kind === 'reconstruct_operation' ? { operation_id: String(t.external_id), question: String(objective.question ?? question).slice(0, 400), source: 'adaptive-intelligence' }
      : { focus: objective.mode ?? 'public', question, source: 'adaptive-intelligence' };
    await db.batch([db.prepare("UPDATE work_items SET result=? WHERE id=? AND status IN ('queued','deferred')").bind(json(payload), w.id),
      db.prepare("UPDATE operation_hunts SET work_item_id=?,status='running' WHERE id=? AND status='reserved'").bind(w.id, t.hunt_id),
      db.prepare("UPDATE adaptive_tests SET work_item_id=?,status='running',started_at=COALESCE(started_at,?) WHERE id=? AND status='reserved'").bind(w.id, now(), t.id),
      db.prepare("UPDATE adaptive_decisions SET status='executing' WHERE id=? AND status='reserved'").bind(t.decision_id),
      db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,'specialist_action','work_item',?,'provenance',?,?)").bind(await sha256(`lin:${t.id}:work`), t.id, w.id, json({ kind: spec.work_kind, specialist: spec.specialist }), now())]);
    await projectScientific(String(t.scope_id));
    handed++;
  }
  return handed;
}

// ------------------------------------------------------------------------------------------------
// Completion, actual cost, lineage, attribution, learning inputs, dynamic budgets
// ------------------------------------------------------------------------------------------------
async function measuredCosts(t: Row, job: Row | null) {
  const out: Array<{ dim: string; consumed: number | null; measured: number; source: string }> = [];
  if (!job) { for (const d of COST_DIMS) out.push({ dim: d, consumed: null, measured: 0, source: 'not exposed' }); return out; }
  const result = parse<Row>(job.result, {});
  const meter = (result.meter ?? (result.v2 as Row | undefined)?.meter ?? null) as Row | null;
  const used = (meter?.used ?? null) as Row | null;
  const claimed = await one("SELECT MAX(created_at) at FROM job_events WHERE job_id=? AND event_type='claimed'", job.id);
  const ended = await one("SELECT MAX(created_at) at FROM job_events WHERE job_id=? AND event_type IN ('complete','fail','needs-review')", job.id);
  const wall = job.completed_at ? ts(job.completed_at) - ts(job.created_at) : ts(ended?.at) - ts(job.created_at);
  const worker = claimed?.at && ended?.at ? ts(ended.at) - ts(claimed.at) : null;
  out.push({ dim: 'jobs', consumed: 1, measured: 1, source: 'main.jobs' });
  out.push({ dim: 'retries', consumed: Math.max(0, Number(job.attempt_count ?? 1) - 1), measured: 1, source: 'main.jobs.attempt_count' });
  out.push({ dim: 'wall_ms', consumed: wall > 0 ? wall : 0, measured: 1, source: 'main.jobs timestamps (second resolution)' });
  out.push({ dim: 'worker_ms', consumed: worker != null && worker >= 0 ? worker : null, measured: worker != null && worker >= 0 ? 1 : 0, source: worker != null ? 'main.job_events claimed->finished (second resolution)' : 'not exposed' });
  for(const d of ['http','dns','certificate','rdap','provider_calls']) {
    const key=d==='certificate'?'crtsh':d;
    const value=used?.[key];
    const exposed=value!=null&&Number.isFinite(Number(value))&&Number(value)>=0;
    out.push({dim:d,consumed:exposed?Number(value):job.target_module==='site_finder'&&d==='provider_calls'?0:null,measured:exposed||job.target_module==='site_finder'&&d==='provider_calls'?1:0,source:exposed?(job.target_module==='site_finder'?'site_finder.round_meter':`${job.target_module}.meter`):'not exposed'});
  }
  if(used?.worker_ms!=null){const row=out.find(c=>c.dim==='worker_ms')!;row.consumed=Number(used.worker_ms);row.measured=1;row.source=`${job.target_module}.monotonic_clock`;}
  out.push({ dim: 'bytes', consumed: null, measured: 0, source: 'not exposed' });
  return out;
}

async function finishTest(t: Row, status: 'finished' | 'failed', outcome: Row, job: Row | null) {
  const db = getD1(), at = now();
  const costs = await measuredCosts(t, job);
  const stmts: D1PreparedStatement[] = [db.prepare("UPDATE adaptive_tests SET status=?,outcome=?,useful=?,job_id=COALESCE(?,job_id),finished_at=? WHERE id=? AND status='running'").bind(status, json(outcome), outcome.useful ? 1 : 0, job?.id ?? null, at, t.id)];
  const gate = "EXISTS(SELECT 1 FROM adaptive_tests WHERE id=? AND status IN ('finished','failed') AND finished_at=?)";
  for (const c of costs) stmts.push(db.prepare(`UPDATE adaptive_costs SET consumed=?,measured=?,source=?,recorded_at=? WHERE test_id=? AND dimension=? AND ${gate}`).bind(c.consumed, c.measured, c.source, at, t.id, c.dim, t.id, at));
  if (job) stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) SELECT ?,?,'specialist_action','job',?,'provenance',?,? WHERE ${gate}`).bind(await sha256(`lin:${t.id}:job:${job.id}`), t.id, job.id, json({ job_type: job.job_type, status: job.status }), at, t.id, at));
  const actual = Object.fromEntries(costs.map(c => [c.dim, c.measured ? c.consumed : null]));
  stmts.push(db.prepare(`UPDATE adaptive_decisions SET status='finished',finished_at=?,actual_cost=?,changed=? WHERE id=? AND ${gate}`).bind(at, json(actual), json(outcome), t.decision_id, t.id, at));
  await db.batch(stmts);
}

/** Finishes running tests whose specialist work ended. Never double-finishes (status-gated). */
export async function reconcileTests() {
  const rows = await all("SELECT t.*,w.status work_status,w.job_id work_job FROM adaptive_tests t LEFT JOIN work_items w ON w.id=t.work_item_id WHERE t.status='running' ORDER BY t.started_at LIMIT 50");
  let finished = 0;
  for (const t of rows) {
    const objective = parse<Row>(t.objective, {}), family = String(t.family) as TestFamily;
    if (t.work_item_id) {
      if (!['done', 'failed', 'cancelled'].includes(String(t.work_status))) continue;
      const job = t.work_job ? await one('SELECT * FROM jobs WHERE id=?', t.work_job) : null;
      const outcome = await immediateOutcome(t, family, job);
      await finishTest(t, t.work_status === 'done' ? 'finished' : 'failed', outcome, job); finished++; continue;
    }
    if (objective.wallet) {
      const c = await one('SELECT * FROM wallet_candidates WHERE id=?', objective.wallet);
      const done = !c || (family === 'WALLET_VALIDATION' ? !['pending', 'queued'].includes(String(c.validation_status)) : ['completed', 'partial', 'failed', 'budget_exhausted', 'skipped'].includes(String(c.analysis_status)) && ts(c.updated_at) >= ts(t.started_at) - 1000);
      const expired = ts(t.started_at) < Date.now() - 24 * 3600000;
      if (!done && !expired) continue;
      const job = c ? await one('SELECT * FROM jobs WHERE id=?', family === 'WALLET_VALIDATION' ? c.validation_job_id : c.analysis_job_id) : null;
      const ok = Boolean(c) && (family === 'WALLET_VALIDATION' ? c!.validation_status === 'valid' : c!.analysis_status === 'completed');
      await finishTest(t, ok || done ? 'finished' : 'failed', { useful: ok, validation: c?.validation_status ?? null, analysis: c?.analysis_status ?? null, expired: !done && expired, dead_end: !ok }, job); finished++;
    }
  }
  return finished;
}

async function immediateOutcome(t: Row, family: TestFamily, job: Row | null): Promise<Row> {
  const result = parse<Row>(job?.result, {}), base = parse<Row>(t.baseline, {});
  const after = await one(`SELECT (SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=?1 AND evidence_ids<>'[]' AND category NOT IN ('infrastructure_context','template_similarity')) independent,
    (SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=?1 AND evidence_ids<>'[]' AND category IN ('infrastructure_context','template_similarity')) weak,
    (SELECT COUNT(*) FROM operation_contradictions WHERE operation_id=?1) contradictions,(SELECT COUNT(*) FROM operation_history WHERE operation_id=?1 AND kind='hypothesis') hypothesis_versions`, t.scope_id);
  const out: Row = { job_status: job?.status ?? null, independent_gain: Math.max(0, Number(after?.independent ?? 0) - Number(base.independent ?? 0)), weak_gain: Math.max(0, Number(after?.weak ?? 0) - Number(base.weak ?? 0)),
    contradictions_gain: Math.max(0, Number(after?.contradictions ?? 0) - Number(base.contradictions ?? 0)), hypothesis_updates: Math.max(0, Number(after?.hypothesis_versions ?? 0) - Number(base.hypothesis_versions ?? 0)) };
  if (family.endsWith('HUNT') || family === 'PUBLIC_ARTIFACT_SEARCH') {
    const claimed = (Array.isArray(result.new_candidates) ? result.new_candidates : Array.isArray((result.v2 as Row | undefined)?.new_candidates) ? (result.v2 as Row).new_candidates as unknown[] : []).map(String);
    out.new_candidates = claimed; out.duplicate = job?.status === 'completed' && !claimed.length && !Number(out.independent_gain);
  }
  if (family === 'HUNTER_HYPOTHESIS_TEST') out.duplicate = !Number(out.hypothesis_updates) && !Number(out.contradictions_gain) && !Number(out.independent_gain);
  if (['PUBLIC_SITE_INSPECTION', 'LIKELY_WALLET_PAGE_INSPECTION', 'TEMPORAL_RECHECK'].includes(family) && job?.investigation_id) {
    out.new_evidence = Number((await one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module='site_investigator' AND created_at>=?", job.investigation_id, String(t.started_at ?? t.created_at).replace('T', ' ').slice(0, 19)))?.n ?? 0);
  }
  // Usefulness is judged only on what THIS specialist action returned; operation-wide gains during the window
  // are recorded but attributed separately (and only when no other module work could explain them).
  out.useful = family.endsWith('HUNT') || family === 'PUBLIC_ARTIFACT_SEARCH' ? Boolean(Array.isArray(out.new_candidates) && out.new_candidates.length)
    : family === 'HUNTER_HYPOTHESIS_TEST' ? Boolean(Number(out.contradictions_gain) || Number(out.hypothesis_updates))
    : Boolean(Number(out.new_evidence));
  out.dead_end = job?.status === 'completed' ? !out.useful : job ? true : false;
  return out;
}

/** Attribution: immediate outputs now, downstream outcomes whenever they appear. Each outcome is credited once. */
export async function attributeOutcomes() {
  const db = getD1();
  // 1) Immediate outputs of newly finished tests.
  // Attribute only after Main has projected the operation at least once since the test finished
  // (or after an hour), so evidence ingested by the specialist is visible to the attribution.
  for (const t of await all(`SELECT t.* FROM adaptive_tests t LEFT JOIN operation_state st ON st.operation_id=t.scope_id WHERE t.status IN ('finished','failed') AND t.attributed_at IS NULL
    AND (t.specialist='main_local' OR t.scope_kind<>'operation' OR st.last_evaluated_at>=replace(substr(t.finished_at,1,19),'T',' ') OR t.finished_at<?) ORDER BY t.finished_at LIMIT 50`, later(-3600000))) {
    const o = parse<Row>(t.outcome, {}), at = now(), stmts: D1PreparedStatement[] = [];
    const credit = (kind: string, ref: string, c: number, basis: string, detail: Row = {}) => stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM adaptive_outcomes WHERE outcome_kind=? AND outcome_ref=? AND test_id<>?)`).bind(kind, ref, t.id, Math.round(c * 1000) / 1000, basis, t.family, t.scope_kind, t.scope_id, json(detail), at, kind, ref, t.id));
    for (const domain of (Array.isArray(o.new_candidates) ? o.new_candidates : []).map(String)) {
      // Every FIND_RELATED_SITES job (any origin) that delivered this domain is a claimant.
      const claimants = await all(`SELECT j.id,(SELECT t2.id FROM adaptive_tests t2 WHERE t2.job_id=j.id) test_id FROM jobs j, json_each(json_extract(j.result,'$.new_candidates')) d WHERE j.job_type='FIND_RELATED_SITES' AND j.status='completed' AND d.value=? LIMIT 20`, domain);
      const links: Link[] = claimants.map(c => ({ test_id: String(c.test_id ?? `job:${c.id}`), strength: 'provenance' }));
      if (!links.length) links.push({ test_id: String(t.id), strength: 'provenance' });
      for (const s of creditShares(links).shares.filter(s => s.test_id === t.id)) credit('site_discovered', domain, s.credit, s.basis, { claimants: links.length });
      stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,'immediate_output','site',?,'provenance','{}',?)").bind(await sha256(`lin:${t.id}:site:${domain}`), t.id, domain, at));
    }
    // Any other module job touching this operation's investigations during the window makes an operation-wide
    // gain ambiguous: then it is recorded as temporal coincidence and earns no credit.
    const windowStart = String(t.started_at ?? t.created_at).replace('T', ' ').slice(0, 19), windowEnd = String(t.finished_at).replace('T', ' ').slice(0, 19);
    const concurrent = Number((await one(`SELECT COUNT(*) n FROM jobs j WHERE (j.id<>COALESCE(?, '') ) AND j.created_at<=? AND COALESCE(j.completed_at,j.updated_at)>=? AND (j.investigation_id IN (SELECT ie.investigation_id FROM operation_entities oe JOIN investigation_entities ie ON ie.entity_id=oe.entity_id WHERE oe.operation_id=?) OR j.target_module='operation_hunter')`, t.job_id, windowEnd, windowStart, t.scope_id))?.n ?? 0)
      + Number((await one(`SELECT COUNT(*) n FROM adaptive_tests WHERE scope_kind=? AND scope_id=? AND id<>? AND specialist<>'main_local' AND started_at<? AND COALESCE(finished_at,'9999')>?`, t.scope_kind, t.scope_id, t.id, t.finished_at, t.started_at ?? t.created_at))?.n ?? 0);
    const strength = concurrent ? 'temporal_only' : 'derived';
    if (Number(o.independent_gain)) {
      const keys = await all(`SELECT DISTINCT independence_key k FROM operation_edges WHERE operation_id=? AND evidence_ids<>'[]' AND category NOT IN ('infrastructure_context','template_similarity') AND first_seen>=? AND first_seen<=? LIMIT 50`, t.scope_id, String(t.started_at ?? t.created_at), String(t.finished_at));
      for (const k of keys) {
        if (strength === 'derived') credit('independent_evidence', String(k.k), 1, 'derived');
        stmts.push(db.prepare("INSERT OR IGNORE INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,'later_evidence','independence_unit',?,?,'{}',?)").bind(await sha256(`lin:${t.id}:unit:${k.k}`), t.id, String(k.k), strength, at));
      }
      if (!keys.length && strength === 'derived') credit('independent_evidence', `${t.id}:gain`, Math.min(1, Number(o.independent_gain)), 'derived');
    } else if (Number(o.weak_gain)) credit('generic_evidence', `${t.id}:weak`, 1, 'observed');
    if (Number(o.contradictions_gain)) credit('contradiction_discovered', `${t.scope_id}:contradictions:${t.id}`, strength === 'derived' ? 1 : 0, strength);
    if (Number(o.hypothesis_updates) && t.family === 'HUNTER_HYPOTHESIS_TEST') credit('hypothesis_discrimination', `${t.scope_id}:hypothesis:${t.id}`, strength === 'derived' ? .5 : 0, strength, { note: 'Hunter updated its analysis after the structured question; conservative half credit.' });
    if (t.family === 'CORRELATION_REVIEW' && Array.isArray(o.other_investigations) && o.other_investigations.length) credit('hypothesis_discrimination', `${t.subject}:reuse:${(o.other_investigations as unknown[]).length}`, 1, 'provenance');
    if (o.duplicate) credit('duplicate', String(t.id), 1, 'observed');
    else if (o.dead_end && !o.useful) credit('dead_end', String(t.id), 1, 'observed');
    stmts.push(db.prepare('UPDATE adaptive_tests SET attributed_at=? WHERE id=? AND attributed_at IS NULL').bind(at, t.id));
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  }
  // 2) Downstream outcomes: validated sites, validated wallets and report readiness reached later.
  const lineageSites = await all(`SELECT DISTINCT l.ref_id domain FROM adaptive_lineage l JOIN adaptive_tests t ON t.id=l.test_id WHERE l.stage='immediate_output' AND l.ref_kind='site' AND t.finished_at>=? LIMIT 200`, later(-30 * 86400000));
  for (const r of lineageSites) await creditDownstream(String(r.domain));
  for (const t of await all(`SELECT t.* FROM adaptive_tests t WHERE t.family IN ('WALLET_VALIDATION','BLOCKCHAIN_REFRESH','PUBLIC_SITE_INSPECTION','LIKELY_WALLET_PAGE_INSPECTION','TEMPORAL_RECHECK') AND t.status='finished' AND t.finished_at>=? LIMIT 200`, later(-30 * 86400000))) {
    const objective = parse<Row>(t.objective, {});
    if (objective.site) await creditDownstream(String(objective.site));
    if (objective.wallet) {
      const c = await one('SELECT * FROM wallet_candidates WHERE id=?', objective.wallet);
      if (c?.validation_status === 'valid' && c.best_context === 'deposit') await creditOnce('validated_wallet', String(c.identity) + ':' + String(c.investigation_id), [{ test_id: String(t.id), strength: 'provenance' }]);
      const ready = c ? await one('SELECT candidate_id FROM report_contents WHERE investigation_id=? AND ready=1 AND superseded_by IS NULL LIMIT 1', c.investigation_id) : null;
      if (ready && t.family === 'BLOCKCHAIN_REFRESH') await creditOnce('report_readiness', String(c!.investigation_id), [{ test_id: String(t.id), strength: 'provenance' }]);
    }
  }
}

async function creditOnce(kind: string, ref: string, links: Link[], detail: Row = {}) {
  const db = getD1(), at = now();
  if (await one('SELECT 1 x FROM adaptive_outcomes WHERE outcome_kind=? AND outcome_ref=? LIMIT 1', kind, ref)) return;
  const shares = creditShares(links).shares.filter(s => !s.test_id.startsWith('job:'));
  if (!shares.length) return;
  await db.batch(shares.map(s => db.prepare(`INSERT OR IGNORE INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) SELECT ?,?,id,?,?,family,scope_kind,scope_id,?,? FROM adaptive_tests WHERE id=?`).bind(kind, ref, s.credit, s.basis, json({ ...detail, claimants: links.length }), at, s.test_id)));
}

/** A discovered/inspected site's later validation, wallets and report readiness, credited along its lineage. */
async function creditDownstream(domain: string) {
  const site = await one(`SELECT e.id,(SELECT ie.investigation_id FROM investigation_entities ie WHERE ie.entity_id=e.id ORDER BY ie.rowid LIMIT 1) inv FROM entities e WHERE e.entity_type='site' AND e.canonical_key=?`, domain);
  if (!site?.inv) return;
  const discovered = await all(`SELECT DISTINCT l.test_id FROM adaptive_lineage l WHERE l.stage='immediate_output' AND l.ref_kind='site' AND l.ref_id=?`, domain);
  const otherClaimants = await all(`SELECT j.id FROM jobs j, json_each(json_extract(j.result,'$.new_candidates')) d WHERE j.job_type='FIND_RELATED_SITES' AND j.status='completed' AND d.value=? AND NOT EXISTS(SELECT 1 FROM adaptive_tests t WHERE t.job_id=j.id) LIMIT 20`, domain);
  const inspected = await all(`SELECT id test_id FROM adaptive_tests WHERE family IN ('PUBLIC_SITE_INSPECTION','LIKELY_WALLET_PAGE_INSPECTION','TEMPORAL_RECHECK') AND status='finished' AND json_extract(objective,'$.site')=?`, domain);
  const links: Link[] = [...discovered.map(r => ({ test_id: String(r.test_id), strength: 'derived' as const })), ...otherClaimants.map(r => ({ test_id: `job:${r.id}`, strength: 'derived' as const })), ...inspected.map(r => ({ test_id: String(r.test_id), strength: 'provenance' as const }))];
  if (!links.length) return;
  const deposit = await all(`SELECT identity FROM wallet_candidates WHERE investigation_id=? AND validation_status='valid' AND best_context='deposit'`, site.inv);
  const evidence = await one(`SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module='site_investigator'`, site.inv);
  if (Number(evidence?.n ?? 0) > 0 && deposit.length) await creditOnce('validated_site', domain, links);
  for (const w of deposit) await creditOnce('validated_wallet', `${w.identity}:${site.inv}`, links);
  const ready = await one('SELECT 1 x FROM report_contents WHERE investigation_id=? AND ready=1 AND superseded_by IS NULL LIMIT 1', site.inv);
  if (ready) await creditOnce('report_readiness', String(site.inv), links);
}

/** Bounded, earned allowance changes after attributed hunt-counted tests. Exactly once per test. */
export async function adjustBudgets() {
  const db = getD1(), cap = await getNum('adaptive_bonus_cap', BUDGET.max_bonus);
  for (const t of await all("SELECT * FROM adaptive_tests WHERE scope_kind='operation' AND attributed_at IS NOT NULL AND budget_checked=0 AND hunt_id IS NOT NULL ORDER BY finished_at LIMIT 20")) {
    const st = await one('SELECT max_hunts,hunts FROM operation_state WHERE operation_id=?', t.scope_id);
    const bonus = Number((await one("SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?", t.scope_id))?.bonus ?? 0);
    const recent = await all(`SELECT t.id,t.useful,(SELECT COUNT(*) FROM adaptive_outcomes o WHERE o.test_id=t.id AND o.outcome_kind IN ('independent_evidence','validated_site','validated_wallet','site_discovered','hypothesis_discrimination') AND o.credit>0) independent,
      (SELECT COUNT(*) FROM adaptive_outcomes o WHERE o.test_id=t.id AND o.outcome_kind='duplicate') dup,(SELECT COUNT(*) FROM adaptive_outcomes o WHERE o.test_id=t.id AND o.outcome_kind='dead_end') dead
      FROM adaptive_tests t WHERE t.scope_kind='operation' AND t.scope_id=? AND t.hunt_id IS NOT NULL AND t.attributed_at IS NOT NULL AND t.finished_at<=? ORDER BY t.finished_at DESC LIMIT 4`, t.scope_id, t.finished_at);
    const adj = budgetAdjustment({ max_hunts: Number(st?.max_hunts ?? 8) + bonus, hunts: Number(st?.hunts ?? 0), bonus: Math.min(bonus, cap) }, recent.reverse().map(r => ({ useful: Number(r.useful) === 1, independent: Number(r.independent) > 0, duplicate: Number(r.dup) > 0, dead: Number(r.dead) > 0 })));
    const stmts: D1PreparedStatement[] = [db.prepare('UPDATE adaptive_tests SET budget_checked=1 WHERE id=? AND budget_checked=0').bind(t.id)];
    if (adj.delta !== 0 && st) {
      const before = Number(st.max_hunts) + bonus, afterMax = before + adj.delta;
      stmts.push(db.prepare(`INSERT OR IGNORE INTO adaptive_budget_adjustments(id,scope_kind,scope_id,test_id,delta,before_max,after_max,reason,at) SELECT ?,'operation',?,?,?,?,?,?,? WHERE changes()=1`).bind(await sha256(`budget:${t.id}`), t.scope_id, t.id, adj.delta, before, afterMax, adj.reason, now()));
      // Only the bounded bonus moves; the base allowance and every global ceiling are untouched.
      stmts.push(db.prepare(`INSERT INTO adaptive_scope_state(scope_kind,scope_id,bonus,updated_at) SELECT 'operation',?,MAX(-?,MIN(?,?)),? WHERE changes()=1 ON CONFLICT(scope_kind,scope_id) DO UPDATE SET bonus=MAX(-?,MIN(?,bonus+?)),updated_at=excluded.updated_at`)
        .bind(t.scope_id, Number(st.max_hunts), cap, adj.delta, now(), Number(st.max_hunts) - Math.max(BUDGET.min_allowance_floor, Number(st.hunts)), cap, adj.delta));
    }
    await db.batch(stmts);
  }
}

/** The whole post-execution learning pass: finish -> attribute -> adjust. Each step is idempotent. */
export async function reconcileAdaptive() {
  if (!(await adaptiveInstalled())) return { finished: 0 };
  const finished = await reconcileTests();
  await attributeOutcomes();
  await adjustBudgets();
  return { finished };
}

// ------------------------------------------------------------------------------------------------
// Portfolio pass: where is the next unit of effort most valuable?
// ------------------------------------------------------------------------------------------------
export async function portfolioStart(pending: Pending[], opts: { maxStarts: number; active: number; daily: number }) {
  const { portfolioOrder } = await import('./policy');
  const db = getD1(), tick = crypto.randomUUID(), at = now();
  const recent = await all(`SELECT scope_id,COUNT(*) n FROM adaptive_tests WHERE scope_kind='operation' AND specialist<>'main_local' AND created_at>=? GROUP BY scope_id`, later(-24 * 3600000));
  const total = recent.reduce((x, r) => x + Number(r.n), 0) || 1;
  const entries = [];
  for (const p of pending) {
    const st = await one("SELECT consecutive_starts,last_started_at FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?", p.scope);
    const opState = await one('SELECT last_action_at,last_evaluated_at FROM operation_state WHERE operation_id=?', p.scope);
    const g = p.gap, c = p.chosen.components;
    entries.push({ scope: p.scope, utility: p.chosen.utility, time_sensitivity: c.time_sensitivity.value, report_closeness: c.report_readiness.value, contradiction: g?.family === 'CONTRADICTION_RESOLUTION' ? 1 : 0, new_wave: g?.family === 'CAMPAIGN_WAVE' ? 1 : 0,
      provider_opportunity: p.chosen.family === 'BLOCKCHAIN_REFRESH' ? 1 : 0, exploration: Boolean(p.decision.exploration), hours_since_service: Math.max(0, (Date.now() - ts(opState?.last_action_at ?? st?.last_started_at ?? '1970-01-01')) / 3600000),
      recent_share: Number(recent.find(r => r.scope_id === p.scope)?.n ?? 0) / total, consecutive: Number(st?.consecutive_starts ?? 0), eligible: true });
  }
  const order = portfolioOrder(entries.map(e => ({ ...e, hours_since_service: Math.min(e.hours_since_service, 48) })));
  let started = 0; const startedScopes: string[] = [];
  for (const [rank, e] of order.entries()) {
    const p = pending.find(x => x.scope === e.scope)!;
    let ok = false;
    if (started < opts.maxStarts) ok = Boolean(await reserveTest(p, { active: opts.active, daily: opts.daily }));
    if (ok) { started++; startedScopes.push(e.scope); await handoffReserved(e.scope); }
    await db.prepare('INSERT OR IGNORE INTO adaptive_portfolio(tick_id,scope_kind,scope_id,rank,score,started,reason,at) VALUES (?,?,?,?,?,?,?,?)').bind(tick, 'operation', e.scope, rank, e.score, ok ? 1 : 0, e.reason, at).run();
  }
  await db.prepare('DELETE FROM adaptive_portfolio WHERE at<?').bind(later(-14 * 86400000)).run();
  if (order.length) await db.prepare("INSERT INTO adaptive_saturation(level,scope_key,state,reason,updated_at) VALUES ('portfolio','portfolio',?,?,?) ON CONFLICT(level,scope_key) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at").bind(started ? 'active' : 'temporarily_low_value', `${order.length} operation(s) proposed tests; ${started} started this tick.`, at).run();
  return { started, scopes: startedScopes, ranked: order.map(o => ({ scope: o.scope, score: o.score, reason: o.reason })) };
}

export { familyLearning };
