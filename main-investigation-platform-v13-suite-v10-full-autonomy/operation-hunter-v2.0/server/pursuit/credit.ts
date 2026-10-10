import type { HunterApp } from '../app.js';
import type { OpData } from '../analysis/data.js';
import type { MembershipAnalysis } from '../reasoning/membership.js';
import type { MembershipRow } from '../core/intelStore.js';
import { ProgressLearner } from './learner.js';

/**
 * Delayed credit assignment. A lookup's real value is often only known later:
 * the domain it surfaced becomes a member once another lookup finds a shared
 * certificate; the wallet it revealed turns out to be the treasury. When the
 * analysis accepts something, the lookup that discovered it (and the lookup
 * that produced the deciding evidence) are credited in the learner, so the
 * pursuit learns which kinds of lookups actually build reconstructions.
 * Candidates later ruled out cost their discoverer a small penalty.
 */
export const CREDIT = { newMember: 8, verifiedMember: 3, operatorIndicator: 5, excludedCandidate: -0.5 };

export function assignCredit(app: HunterApp, data: OpData, previous: Map<string, MembershipRow>, membership: MembershipAnalysis, learner: ProgressLearner): number {
  let credited = 0;
  const give = (pivotId: string | undefined | null, entityId: string, kind: string, amount: number) => {
    if (!pivotId) return;
    const pivot = app.store.getPivot(pivotId);
    if (!pivot || pivot.operationId !== data.op.id) return;
    if (!app.intel.addCredit(data.op.id, pivot.id, entityId, kind, amount)) return;
    const ctx = pivot.result?.context ?? { pivotType: pivot.pivotType, entityType: pivot.targetType, status: 'unknown', level: 'n/a' };
    learner.credit(ctx, amount);
    credited += amount;
  };
  for (const m of membership.members) {
    const before = previous.get(m.entityId)?.status;
    const e = data.byId.get(m.entityId);
    if (!e || e.isSeed) continue;
    if (m.status === 'member' && before !== 'member') {
      if (e.type === 'domain') {
        give(e.discoveredVia, e.id, 'new_member', CREDIT.newMember);
        // the lookup on the site that produced its deciding evidence (page content, registration, DNS)
        const decisive = app.store.getPivots(data.op.id, 2000).filter(p => p.entityId === e.id && p.status === 'done' && (p.result?.newEvidence ?? 0) > 0).sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];
        if (decisive) give(decisive.id, e.id, 'verified_member', CREDIT.verifiedMember);
      } else if (membership.indicators[e.id]?.level === 'operator') {
        give(e.discoveredVia, e.id, 'operator_indicator', CREDIT.operatorIndicator);
      }
    } else if (e.type === 'domain' && (m.status === 'excluded') && before !== 'excluded') {
      give(e.discoveredVia, e.id, 'excluded_candidate', CREDIT.excludedCandidate);
    }
  }
  return credited;
}
