/**
 * v7 read models: decision explanations (default view) and the Advanced efficiency view.
 * Diagnostic only. Learning and value numbers are prioritization metadata, never evidence,
 * and none of this is ever added to a report.
 */
import { getD1 } from '../platform';
import { parse, type Row } from '../ops/common';
import { TESTS, GAPS, type TestFamily } from './ontology';
import { familyLearning } from './snapshot';

const all = async (q: string, ...a: unknown[]) => (await getD1().prepare(q).bind(...a).all<Row>()).results;
const one = async (q: string, ...a: unknown[]) => getD1().prepare(q).bind(...a).first<Row>();
export const LEARNING_CAVEAT = 'Learning and value scores only order Main\'s own work. They are not evidence, never change what a record says, and are never added to a report.';

async function testCard(t: Row) {
  const costs = await all('SELECT dimension,reserved,consumed,measured,source FROM adaptive_costs WHERE test_id=? ORDER BY dimension', t.id);
  const outcomes = await all('SELECT outcome_kind,outcome_ref,credit,basis FROM adaptive_outcomes WHERE test_id=? ORDER BY at LIMIT 40', t.id);
  const lineage = await all('SELECT stage,ref_kind,ref_id,strength FROM adaptive_lineage WHERE test_id=? ORDER BY at LIMIT 40', t.id);
  const family = String(t.family) as TestFamily;
  return { id: t.id, family, title: TESTS[family]?.title ?? family, specialist: t.specialist, safety_class: t.safety_class, subject: t.subject, status: t.status, exploration: Boolean(t.exploration),
    objective: parse<Row>(t.objective, {}), outcome: parse<Row>(t.outcome, {}), created_at: t.created_at, finished_at: t.finished_at,
    cost: { reserved: Object.fromEntries(costs.map(c => [c.dimension, Number(c.reserved)])), consumed: Object.fromEntries(costs.map(c => [c.dimension, Number(c.measured) === 1 ? c.consumed : null])), measured_sources: Object.fromEntries(costs.filter(c => Number(c.measured) === 1).map(c => [c.dimension, c.source])), unmeasured: costs.filter(c => Number(c.measured) !== 1 && Number(c.reserved) > 0).map(c => c.dimension) },
    outcomes, lineage };
}

/** What Main chose for this operation, what question it is answering, why, and what changed. */
export async function adaptiveOperationView(ref: string) {
  const op = await one('SELECT id,external_id,name FROM hunter_operations WHERE id=? OR external_id=?', ref, ref);
  if (!op) return null;
  const id = String(op.id);
  if (!(await one("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_decisions'"))) return { operation_id: id, installed: false };
  const decisions = await all("SELECT * FROM adaptive_decisions WHERE scope_kind='operation' AND scope_id=? ORDER BY created_at DESC,seq DESC LIMIT 12", id);
  const latestExternal = decisions.find(d => d.chosen_family && TESTS[String(d.chosen_family) as TestFamily]?.specialist !== 'main_local') ?? decisions[0] ?? null;
  const current: (Row & {test:Awaited<ReturnType<typeof testCard>>|null}) | null = latestExternal ? { ...latestExternal, deferred: parse<Row[]>(latestExternal.deferred, []), expected_cost: parse<Row>(latestExternal.expected_cost, {}), actual_cost: parse<Row | null>(latestExternal.actual_cost, null), changed: parse<Row | null>(latestExternal.changed, null),
    test: latestExternal.test_id ? await testCard((await one('SELECT * FROM adaptive_tests WHERE id=?', latestExternal.test_id)) ?? {}) : null } : null;
  const components = latestExternal ? await all('SELECT candidate_key,family,subject,component,value,weight,contribution,reason FROM adaptive_decision_components WHERE decision_id=? ORDER BY candidate_key,component', latestExternal.id) : [];
  const byCandidate: Record<string, Row> = {};
  for (const c of components) { const k = String(c.candidate_key); const x = byCandidate[k] ??= { candidate_key: k, family: c.family, subject: c.subject, components: {} }; (x.components as Row)[String(c.component)] = { value: c.value, weight: c.weight, contribution: c.contribution, reason: c.reason }; }
  const gaps = (await all("SELECT gap_key,family,subject,status,uncertainty,current_knowledge,missing_knowledge,why_matters,possible_tests,dependencies,exhaustion_condition,revisit_condition,supporting,contradicting,updated_at FROM adaptive_gaps WHERE scope_kind='operation' AND scope_id=? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting_for_human' THEN 2 WHEN 'waiting_for_provider' THEN 3 ELSE 4 END,family LIMIT 100", id))
    .map(g => ({ ...g, possible_tests: parse(g.possible_tests, []), dependencies: parse(g.dependencies, []), revisit_condition: parse(g.revisit_condition, []), supporting: parse(g.supporting, []), contradicting: parse(g.contradicting, []), human_only: Boolean(GAPS[g.family as keyof typeof GAPS]?.human_only) }));
  const tests = await all("SELECT * FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? ORDER BY created_at DESC LIMIT 15", id);
  const lastFinished = await one("SELECT t.*,d.question FROM adaptive_tests t LEFT JOIN adaptive_decisions d ON d.id=t.decision_id WHERE t.scope_kind='operation' AND t.scope_id=? AND t.status IN ('finished','failed') AND t.specialist<>'main_local' ORDER BY t.finished_at DESC LIMIT 1", id);
  const parking = await one("SELECT * FROM adaptive_parking WHERE scope_kind='operation' AND scope_id=?", id);
  const saturation = await all("SELECT level,scope_key,state,reason,updated_at FROM adaptive_saturation WHERE scope_key LIKE ? AND level IN ('operation','branch','gap','test') ORDER BY CASE level WHEN 'operation' THEN 0 WHEN 'branch' THEN 1 WHEN 'gap' THEN 2 ELSE 3 END LIMIT 80", `operation:${id}%`);
  const budget = await all("SELECT delta,before_max,after_max,reason,at FROM adaptive_budget_adjustments WHERE scope_kind='operation' AND scope_id=? ORDER BY at DESC LIMIT 20", id);
  const scopeState = await one("SELECT bonus,decisions,consecutive_starts,last_utility FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?", id);
  return {
    operation_id: id, installed: true,
    summary: current ? {
      chose: current.chosen_family ? `${TESTS[String(current.chosen_family) as TestFamily]?.title ?? current.chosen_family}` : null,
      question: current.question, why_it_matters: current.why_matters, why_selected: current.why_selected, status: current.status,
      stop: current.stop_state ? { state: current.stop_state, reason: current.stop_reason } : null,
      expected_cost: current.expected_cost, actual_cost: current.actual_cost, changed: current.changed, deferred: current.deferred, exploration: Boolean(current.exploration),
    } : null,
    current_test: current?.test ?? null,
    last_finished_test: lastFinished ? { ...(await testCard(lastFinished)), question: lastFinished.question ?? null } : null,
    parked: parking && !parking.woke_at ? { state: parking.state, reason: parking.reason, wake_conditions: parse(parking.wake_conditions, []), next_check_at: parking.next_check_at, skipped_unchanged_evaluations: Number(parking.skipped_evaluations) } : null,
    gaps, recent_tests: await Promise.all(tests.map(testCard)),
    details: { decisions: decisions.map(d => ({ id: d.id, seq: d.seq, status: d.status, chosen_family: d.chosen_family, question: d.question, utility: d.utility, stop_state: d.stop_state, created_at: d.created_at })), candidates: Object.values(byCandidate), saturation, budget_adjustments: budget, scope_state: scopeState },
    caveat: LEARNING_CAVEAT,
  };
}

/** Advanced efficiency view. Diagnostic; not a score. Cost-per-outcome figures need >= 3 measured observations. */
export async function adaptiveEfficiency(scope?: { kind: string; id: string }) {
  if (!(await one("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_tests'"))) return { installed: false };
  const where = scope ? 'WHERE t.scope_kind=? AND t.scope_id=?' : '', args = scope ? [scope.kind, scope.id] : [];
  const tests = await all(`SELECT t.family,t.status,t.useful,t.exploration,t.specialist,COALESCE(x.dead,0) dead,COALESCE(x.dup,0) dup FROM adaptive_tests t
    LEFT JOIN (SELECT test_id,SUM(outcome_kind='dead_end') dead,SUM(outcome_kind='duplicate') dup FROM adaptive_outcomes WHERE outcome_kind IN ('dead_end','duplicate') GROUP BY test_id) x ON x.test_id=t.id ${where}`, ...args);
  const finished = tests.filter(t => ['finished', 'failed'].includes(String(t.status)));
  const costs = await all(`SELECT c.dimension,SUM(c.reserved) reserved,SUM(CASE WHEN c.measured=1 THEN c.consumed END) consumed,SUM(c.measured) measured_n,COUNT(*) n FROM adaptive_costs c JOIN adaptive_tests t ON t.id=c.test_id ${where} GROUP BY c.dimension`, ...args);
  const outcomes = await all(`SELECT o.outcome_kind,COUNT(*) n,SUM(o.credit) credit FROM adaptive_outcomes o JOIN adaptive_tests t ON t.id=o.test_id ${where} GROUP BY o.outcome_kind`, ...args);
  const credit = (k: string) => Number(outcomes.find(o => o.outcome_kind === k)?.credit ?? 0);
  // Cost per useful outcome only from tests whose request dimensions were actually measured (set-based SQL; bounded).
  const scoped = `${where ? `${where} AND` : 'WHERE'} t.status IN ('finished','failed')`;
  const measuredSet = `NOT EXISTS(SELECT 1 FROM adaptive_costs c2 WHERE c2.test_id=t.id AND c2.dimension IN ('http','dns','certificate','rdap') AND c2.measured=0) AND EXISTS(SELECT 1 FROM adaptive_costs c3 WHERE c3.test_id=t.id AND c3.dimension='http')`;
  const req = await one(`SELECT COUNT(DISTINCT t.id) n,SUM(CASE WHEN c.dimension IN ('http','dns','certificate','rdap') THEN c.consumed ELSE 0 END) requests FROM adaptive_tests t JOIN adaptive_costs c ON c.test_id=t.id ${scoped} AND ${measuredSet}`, ...args);
  const jobRow = await one(`SELECT COUNT(DISTINCT t.id) n,SUM(c.consumed) jobs FROM adaptive_tests t JOIN adaptive_costs c ON c.test_id=t.id AND c.dimension='jobs' AND c.measured=1 ${scoped}`, ...args);
  const reqOutcomes = await all(`SELECT o.outcome_kind,SUM(o.credit) credit FROM adaptive_outcomes o JOIN adaptive_tests t ON t.id=o.test_id ${scoped} AND ${measuredSet} GROUP BY o.outcome_kind`, ...args);
  const sumFor = (k: string) => Number(reqOutcomes.find(o => o.outcome_kind === k)?.credit ?? 0);
  const requests = Number(req?.requests ?? 0), reqTests = Number(req?.n ?? 0), jobs = Number(jobRow?.jobs ?? 0), jobTests = Number(jobRow?.n ?? 0);
  const ratio = (num: number, den: number, n: number) => n >= 3 && den > 0 ? Math.round(num / den * 10) / 10 : null;
  const gapRows = await all(`SELECT status,COUNT(*) n FROM adaptive_gaps ${scope ? 'WHERE scope_kind=? AND scope_id=?' : ''} GROUP BY status`, ...args);
  const sat = await all(`SELECT level,state,COUNT(*) n FROM adaptive_saturation GROUP BY level,state ORDER BY level`);
  const budgetAdj = await all(`SELECT scope_id,delta,reason,at FROM adaptive_budget_adjustments ${scope ? 'WHERE scope_kind=? AND scope_id=?' : ''} ORDER BY at DESC LIMIT 20`, ...args);
  const expl = finished.filter(t => Number(t.exploration) === 1);
  return {
    installed: true, scope: scope ?? 'portfolio',
    actions: { tests: tests.length, finished: finished.length, useful: finished.filter(t => Number(t.useful) === 1).length, dead_ends: finished.filter(t => Number(t.dead) > 0).length, duplicates: finished.filter(t => Number(t.dup) > 0).length, local_reviews: tests.filter(t => t.specialist === 'main_local').length },
    cost_ledger: costs.map(c => ({ dimension: c.dimension, reserved: Number(c.reserved), consumed_measured: c.consumed == null ? null : Number(c.consumed), measured_tests: Number(c.measured_n), tests: Number(c.n) })),
    outcomes: Object.fromEntries(outcomes.map(o => [String(o.outcome_kind), { count: Number(o.n), credit: Math.round(Number(o.credit) * 1000) / 1000 }])),
    cost_per_useful_outcome: {
      basis: `${reqTests} test(s) with measured request counts; ${jobTests} with measured job counts (figures appear after 3).`,
      requests_per_new_site: ratio(requests, sumFor('site_discovered'), reqTests), requests_per_validated_site: ratio(requests, sumFor('validated_site'), reqTests),
      requests_per_validated_wallet: ratio(requests, sumFor('validated_wallet'), reqTests), jobs_per_independent_evidence: ratio(jobs, credit('independent_evidence'), jobTests),
      jobs_per_resolved_gap: ratio(jobs, credit('gap_resolved'), jobTests), jobs_per_report_readiness: ratio(jobs, credit('report_readiness'), jobTests),
    },
    gap_resolution: Object.fromEntries(gapRows.map(g => [String(g.status), Number(g.n)])),
    saturation: sat, exploration: { tests: expl.length, useful: expl.filter(t => Number(t.useful) === 1).length },
    budget: { adjustments: budgetAdj },
    learning: await familyLearning(),
    caveat: `${LEARNING_CAVEAT} Diagnostic view, not a performance score.`,
  };
}
