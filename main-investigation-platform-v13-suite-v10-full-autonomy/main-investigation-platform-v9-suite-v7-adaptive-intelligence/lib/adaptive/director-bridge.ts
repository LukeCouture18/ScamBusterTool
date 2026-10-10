/**
 * v7 arbitration for the v5 Investigation Director.
 *
 * The v5 Director keeps its action set, its safety checks, its human/provider stops and its
 * resource ledger. v7 only re-orders the actions it already proposed, using the same typed
 * gaps and information-value model as operations, and records an explainable decision.
 * If the model cannot value an action, the v5 order is kept for that action.
 */
import { getD1 } from '../platform';
import { parse, type Row } from '../ops/common';
import { POLICY, type Valued } from './value';
import { recordDecision, adaptiveEnabled } from './engine';
import { familyLearning } from './snapshot';
import { rankDirectorActions, type V5Action, type DirectorContext } from './director-rank';
export type { DirectorContext } from './director-rank';

/** Re-orders v5 actions by v7 value per cost and records the decision. Returns the actions in execution order. */
export async function arbitrate<T extends V5Action>(ctx: DirectorContext, actions: T[]): Promise<T[]> {
  if (!actions.length || !(await adaptiveEnabled())) return actions;
  try {
    const { valued, snapshot, gaps } = rankDirectorActions(ctx, actions, await familyLearning());
    const ranked = valued.filter(x => x.v).map(x => x.v!) as Valued[];
    if (ranked.length) {
      const chosen = ranked[0];
      await recordDecision('investigation', ctx.inv, snapshot, gaps, { chosen: { ...chosen, eligible: true }, ranked, exploration: false, stop: null });
      // The decision is executed by the v5 Director itself; mark it so it is not mistaken for pending work.
      await getD1().prepare("UPDATE adaptive_decisions SET status='finished',finished_at=COALESCE(finished_at,?) WHERE scope_kind='investigation' AND scope_id=? AND status='decided'").bind(new Date().toISOString(), ctx.inv).run();
    }
    return valued.map(x => x.action);
  } catch (error) {
    console.error('adaptive arbitration skipped:', error instanceof Error ? error.message : error);
    return actions; // never block the v5 Director
  }
}

/** Cross-investigation ordering for the Director tick: last expected value plus a bounded starvation boost. */
export async function investigationOrder(ids: string[]) {
  if (!ids.length || !(await adaptiveEnabled())) return ids;
  const rows = (await getD1().prepare(`SELECT d.investigation_id id,d.updated_at,s.last_utility FROM director_investigations d LEFT JOIN adaptive_scope_state s ON s.scope_kind='investigation' AND s.scope_id=d.investigation_id WHERE d.investigation_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Row>()).results;
  const score = new Map(rows.map(r => { const hours = Math.max(0, (Date.now() - Date.parse(String(r.updated_at).replace(' ', 'T') + 'Z')) / 3600000); return [String(r.id), Number(r.last_utility ?? .5) + Math.min(.3, (Number.isFinite(hours) ? hours : 0) * .02)] as const; }));
  return [...ids].sort((a, b) => (score.get(b) ?? .5) - (score.get(a) ?? .5) || ids.indexOf(a) - ids.indexOf(b));
}

export { POLICY, parse };
