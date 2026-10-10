import type { Entity } from '../types.js';
import type { Branch, BranchStatus, IntelStore } from '../core/intelStore.js';
import { nowIso, round } from '../core/util.js';

/**
 * Lines of inquiry. Every lookup belongs to a branch — profiling one site,
 * the hosting around one nameserver or server, one kit file, one operator
 * setting, one money trail, one naming search. Branches keep their own yield
 * history so the pursuit can tell a productive line from one that has dried
 * up, park it, and come back to it later (revisit) when something changes.
 */
export type BranchKind = 'site' | 'hosting' | 'certificates' | 'kit' | 'operator' | 'money' | 'search' | 'delegated';

const FAMILY: Record<string, BranchKind> = {
  DNS_RESOLVE: 'site', RDAP_DOMAIN: 'site', SITE_PROFILE: 'site', EVIDENCE_MINING: 'site', MAIN_LOOKUP: 'site',
  CT_SEARCH: 'certificates',
  REVERSE_NS: 'hosting', REVERSE_IP: 'hosting', IP_PROFILE: 'hosting',
  SHARED_RESOURCE: 'kit',
  TRACKER_REUSE: 'operator',
  WALLET_TRACE: 'money', WALLET_PROFILE: 'money',
  CT_PATTERN_SEARCH: 'search', TITLE_SEARCH: 'search',
  SITE_CHECK_REQUEST: 'delegated',
};

export const BRANCH_LABEL: Record<BranchKind, string> = {
  site: 'Site profiling', hosting: 'Hosting', certificates: 'Certificates', kit: 'Kit files', operator: 'Operator settings', money: 'Money trail', search: 'Look-alike search', delegated: 'Main Platform checks',
};

export function branchKindOf(pivotType: string): BranchKind {
  return FAMILY[pivotType] ?? 'site';
}

export function branchQuestion(kind: BranchKind, e: Entity): string {
  switch (kind) {
    case 'site': return `What is ${e.value}, and does it belong to the operation?`;
    case 'certificates': return `Which other sites share certificates with ${e.value}?`;
    case 'hosting': return `Which other sites use ${e.value}, and are they the operator's?`;
    case 'kit': return `Which other sites load ${e.label || e.value}?`;
    case 'operator': return `Where else does ${e.value} appear?`;
    case 'money': return `Where does money move from ${e.value.slice(0, 14)}…?`;
    case 'search': return `Are there newly registered sites that fit ${String(e.value).replace(/^(name|title):/, '')}?`;
    case 'delegated': return `What does the Main Platform's site check show for ${e.value}?`;
    default: return e.value;
  }
}

/** How long a saturated branch rests before it is worth another look (doubles with each fruitless revisit). */
export const REVISIT_MINUTES: Record<BranchKind, number> = { site: 7 * 1440, hosting: 2 * 1440, certificates: 3 * 1440, kit: 3 * 1440, operator: 3 * 1440, money: 1440, search: 1440, delegated: 1440 };

export class BranchTracker {
  constructor(private intel: IntelStore) {}

  forPivot(operationId: string, pivotType: string, entity: Entity): Branch {
    const kind = branchKindOf(pivotType);
    return this.intel.ensureBranch(operationId, kind, entity.id, branchQuestion(kind, entity));
  }

  /** Record a lookup's outcome on its branch and decide the branch's state. */
  update(branch: Branch, outcome: { progress: number; cost: number; failed?: boolean; frontierLeft: number }): Branch {
    const s = { ...branch.stats };
    s.pulls += 1;
    s.cost = round(s.cost + outcome.cost, 2);
    s.progress = round(s.progress + outcome.progress, 2);
    s.progressSq = round(s.progressSq + outcome.progress * outcome.progress, 2);
    s.recent = [...s.recent, round(outcome.progress, 2)].slice(-12);
    s.frontier = outcome.frontierLeft;
    if (outcome.failed) s.failures += 1;
    if (outcome.progress >= 0.5) { s.zeroStreak = 0; s.lastProgressAt = nowIso(); } else s.zeroStreak += 1;
    let status: BranchStatus = branch.status === 'revisit' ? 'active' : branch.status;
    let revisitAt = branch.revisitAt;
    if (outcome.failed && s.failures >= 3 && s.progress === 0) status = 'blocked';
    else if (outcome.frontierLeft === 0) {
      status = 'exhausted';
      revisitAt = new Date(Date.now() + REVISIT_MINUTES[branch.kind as BranchKind] * 60000 * Math.pow(2, s.revisits)).toISOString();
    } else if (s.zeroStreak >= 3 && s.pulls >= 3) {
      status = 'saturated';
      revisitAt = new Date(Date.now() + REVISIT_MINUTES[branch.kind as BranchKind] * 60000 * Math.pow(2, s.revisits)).toISOString();
    } else if (outcome.progress >= 0.5) status = 'active';
    const next: Branch = { ...branch, stats: s, status, revisitAt };
    this.intel.saveBranch(next);
    return next;
  }

  /** Reopen branches whose rest period is over, or that a real change touched. */
  reopenDue(operationId: string, touchedEntityIds: Set<string> = new Set()): Branch[] {
    const reopened: Branch[] = [];
    const now = Date.now();
    for (const b of this.intel.getBranches(operationId)) {
      if (b.status !== 'saturated' && b.status !== 'exhausted') continue;
      const due = b.revisitAt && Date.parse(b.revisitAt) <= now;
      // A change touching the branch reopens it early, but never within an hour of its last lookup (no churn).
      const touched = touchedEntityIds.has(b.anchor) && now - Date.parse(b.updatedAt) > 60 * 60000;
      if (due || touched) {
        const next: Branch = { ...b, status: 'revisit', stats: { ...b.stats, revisits: b.stats.revisits + 1, zeroStreak: 0 }, revisitAt: null };
        this.intel.saveBranch(next);
        reopened.push(next);
      }
    }
    return reopened;
  }

  /** Branch multiplier used by the allocator: saturated lines fade, revisits get a fresh look. */
  factor(branch: Branch | undefined): number {
    if (!branch) return 1;
    if (branch.status === 'blocked') return 0.05;
    if (branch.status === 'saturated') return 0.25;
    if (branch.status === 'exhausted') return 0.4;
    if (branch.status === 'revisit') return 1.15;
    const s = branch.stats;
    if (!s.pulls) return 1.05;
    return Math.max(0.35, Math.min(1.3, 0.6 + (s.progress / s.pulls) / 6));
  }
}
