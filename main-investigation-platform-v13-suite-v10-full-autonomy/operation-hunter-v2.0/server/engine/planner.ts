import type { Entity, Lead, Relationship } from '../types.js';
import type { PivotSpec } from '../core/model.js';
import type { HunterApp } from '../app.js';
import { PIVOTS } from '../collectors/pivots.js';
import { clamp, nowIso, round, stableId } from '../core/util.js';
import { isCommodity } from './noise.js';

const PROFILING = new Set(['IP_PROFILE', 'WALLET_PROFILE', 'RDAP_DOMAIN', 'MAIN_LOOKUP']);
const SERVICE_KINDS = new Set(['exchange', 'mixer', 'bridge', 'dex', 'protocol', 'token']);
const TYPE_WEIGHT: Record<string, number> = {
  wallet: 1, contract: 1, identifier: 0.95, email: 0.9, domain: 0.9, template: 0.85, artifact: 0.75, ip: 0.7, nameserver: 0.65,
  hostname: 0.5, certificate: 0.4, asn: 0.2, registrar: 0.15,
};
const COST_PENALTY = { low: 0, medium: 5, high: 12 } as const;

export interface PivotCandidate {
  key: string;
  spec: PivotSpec;
  entity: Entity;
  collectorId?: string;
  blockedReason?: string;
  score: number;
  breakdown: Lead['scoreBreakdown'];
  reasons: string[];
  victimLikely: boolean;
}

export function pivotSignature(pivotType: string, entity: Pick<Entity, 'canonical' | 'value' | 'type'>) {
  return `${pivotType}:${entity.canonical ?? entity.value.toLowerCase()}`;
}

/**
 * Generates and ranks every pivot Hunter could take next. The ranking blends
 * learned yield (strategy posterior), entity importance, distance from the
 * seed, whether the pivot closes an evidence gap, novelty and cost.
 */
export class LeadPlanner {
  constructor(private app: HunterApp) {}

  candidates(operationId: string, opts: { includeBlocked?: boolean } = {}): PivotCandidate[] {
    const { store, strategy } = this.app;
    const op = store.getOperation(operationId);
    if (!op) return [];
    const entities = store.getEntities(operationId);
    const relationships = store.getRelationships(operationId).filter(r => r.state !== 'CONTRADICTED');
    const done = store.doneSignatures(operationId);
    const failed = store.failedAttempts(operationId);
    const pivotsByEntity = new Map<string, number>();
    for (const sig of done) {
      const target = sig.slice(sig.indexOf(':') + 1);
      pivotsByEntity.set(target, (pivotsByEntity.get(target) ?? 0) + 1);
    }
    const evidenceKinds = new Map<string, Set<string>>();
    for (const ev of store.getEvidence(operationId)) {
      if (ev.status !== 'valid') continue;
      for (const id of ev.relatedEntityIds) {
        let s = evidenceKinds.get(id);
        if (!s) evidenceKinds.set(id, (s = new Set()));
        s.add(ev.type);
      }
    }
    const degree = new Map<string, number>();
    const outFunds = new Map<string, Relationship[]>();
    const inFundsSenders = new Map<string, Set<string>>();
    for (const r of relationships) {
      degree.set(r.sourceEntityId, (degree.get(r.sourceEntityId) ?? 0) + 1);
      degree.set(r.targetEntityId, (degree.get(r.targetEntityId) ?? 0) + 1);
      if (r.type === 'FUNDS_TRANSFER') {
        (outFunds.get(r.sourceEntityId) ?? outFunds.set(r.sourceEntityId, []).get(r.sourceEntityId)!).push(r);
        (inFundsSenders.get(r.targetEntityId) ?? inFundsSenders.set(r.targetEntityId, new Set()).get(r.targetEntityId)!).add(r.sourceEntityId);
      }
    }
    const main = this.app.mainBridge();
    const settings = this.app.runtimeSettings();
    const recentCutoff = new Date(Date.now() - 24 * 3600000).toISOString();
    const out: PivotCandidate[] = [];

    for (const entity of entities) {
      if (entity.metadata?.unsupported) continue;
      const commodity = isCommodity(entity.ubiquity) || Boolean(entity.metadata?.commodity);
      const serviceKind = String(entity.metadata?.labelKind ?? '');
      const kinds = evidenceKinds.get(entity.id) ?? new Set<string>();
      // Likely victim: wallet whose only transfers go out to one collection address that has many senders.
      const outs = outFunds.get(entity.id) ?? [];
      const victimLikely = (entity.type === 'wallet') && !entity.isSeed && outs.length > 0 && outs.every(r => (inFundsSenders.get(r.targetEntityId)?.size ?? 0) >= 3)
        && !inFundsSenders.has(entity.id) && outs.length <= 2;

      for (const spec of this.app.collectors.pivotsFor(entity)) {
        const key = pivotSignature(spec.pivotType, entity);
        if (done.has(key)) continue;
        if ((failed.get(key) ?? 0) >= 3) continue;
        if (commodity && !PROFILING.has(spec.pivotType)) continue;
        if (SERVICE_KINDS.has(serviceKind) && spec.pivotType === 'WALLET_TRACE') continue;
        if (entity.type === 'hostname' && spec.pivotType !== 'DNS_RESOLVE' && spec.pivotType !== 'MAIN_LOOKUP') continue;
        if (spec.pivotType === 'EVIDENCE_MINING' && !hasMinableEvidence(kinds)) continue;
        if (spec.pivotType === 'SITE_CHECK_REQUEST') {
          if (!main?.configured() || !op.mainInvestigationId || op.isDemo) continue;
          if (kinds.has('page_fingerprint') || !entity.isActive) continue;
        }
        if (spec.pivotType === 'MAIN_LOOKUP' && (!main?.configured() || op.isDemo)) continue;
        if (spec.pivotType === 'SHARED_RESOURCE' && entity.metadata?.commonLibrary) continue;
        const resolved = this.app.collectors.resolve(spec.pivotType, entity, op, settings, main);
        if (!resolved.collector && !opts.includeBlocked) continue;

        const reasons: string[] = [];
        const gain = strategy.expectedGain(spec.pivotType, entity.type);
        const p = strategy.successProbability(spec.pivotType, entity.type);
        const explore = strategy.explorationBonus(spec.pivotType, entity.type);
        let importance = (TYPE_WEIGHT[entity.type] ?? 0.4) * (1 - Math.min(0.9, entity.ubiquity ?? 0));
        if (entity.isSeed) { importance = Math.max(importance, 1); reasons.push('starts from a seed'); }
        importance *= 0.75 + Math.min(5, degree.get(entity.id) ?? 0) * 0.07;
        if (victimLikely) { importance *= 0.3; reasons.push('probably a victim wallet — tracing it rarely helps'); }
        const strength = entity.metadata?.linkStrength;
        if (!entity.isSeed && typeof strength === 'number') {
          importance *= 0.3 + 0.7 * Math.min(1, strength / 0.45);
          if (entity.metadata?.linkRole === 'peripheral') reasons.push('only weakly linked to the seed (kit sibling or co-hosted) — lower priority');
        }
        const depth = entity.depth ?? 0;
        const depthFactor = Math.pow(0.84, depth);
        const gap = gapScore(spec.pivotType, entity, kinds);
        if (gap.score) reasons.push(gap.reason);
        const touched = pivotsByEntity.get(entity.canonical ?? entity.value.toLowerCase()) ?? 0;
        let novelty = touched === 0 ? 8 : Math.max(1, 5 - touched);
        if (entity.firstSeen > recentCutoff && !entity.isSeed) novelty = Math.min(10, novelty + 2);
        const cost = COST_PENALTY[spec.cost];
        const raw = (gain * 9 + p * 14 + explore * 5) * importance * depthFactor + gap.score * 1.6 + novelty - cost;
        const score = Math.round(clamp(raw, 0, 100));
        reasons.unshift(`expected ~${round(gain, 1)} relevant new leads (${Math.round(p * 100)}% of similar pivots found something)`);
        if (depth > 0) reasons.push(`${depth} hop${depth === 1 ? '' : 's'} from the seed`);
        out.push({
          key, spec, entity, victimLikely,
          collectorId: resolved.collector?.id,
          blockedReason: resolved.collector ? undefined : resolved.reason,
          score: resolved.collector ? score : Math.min(score, 15),
          reasons,
          breakdown: {
            expectedInfoGain: round(clamp(gain * 2.5, 0, 10), 1),
            noveltyScore: round(novelty, 1),
            gapFulfillmentScore: round(gap.score, 1),
            historicalStrategyUtility: Math.round(p * 100),
            relevanceWeight: Math.round(importance * 100),
            costPenalty: cost,
            saturationPenalty: Math.round((1 - depthFactor) * 100),
            finalScore: score,
          },
        });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  }

  /** Persist the current candidate set as leads (upsert by key) and retire stale planner leads. */
  refreshLeads(operationId: string): Lead[] {
    const { store } = this.app;
    const candidates = this.candidates(operationId, { includeBlocked: true });
    // v2.0: rank by the allocator's expected progress per unit cost (value of information), without exploration noise.
    const scored = new Map(this.app.allocator.score(operationId, candidates, { explore: false }).map(s => [s.key, s]));
    candidates.sort((a, b) => (scored.get(b.key)?.expected ?? 0) - (scored.get(a.key)?.expected ?? 0));
    const keep = new Set<string>();
    const now = nowIso();
    store.tx(() => {
      for (const c of candidates.slice(0, 250)) {
        keep.add(c.key);
        const existing = store.leadByKey(operationId, c.key);
        const plain = c.spec.explain(c.entity.value);
        const lead: Lead = {
          id: existing?.id ?? stableId('lead', operationId, c.key),
          operationId,
          title: `${c.spec.label}: ${c.entity.label && c.entity.label !== c.entity.value ? `${c.entity.value} (${c.entity.label})` : c.entity.value}`,
          description: plain.what,
          targetType: c.entity.type,
          targetValue: c.entity.value,
          pivotType: c.spec.pivotType,
          priorityScore: scored.get(c.key)?.score ?? c.score,
          reasoning: [...(scored.get(c.key)?.why ?? []), ...c.reasons].slice(0, 5).join('; '),
          expectedInfoGain: Math.max(1, Math.round(c.breakdown!.expectedInfoGain)),
          noveltyScore: Math.max(1, Math.round(c.breakdown!.noveltyScore)),
          costEstimate: c.spec.cost,
          status: existing && ['INVESTIGATING'].includes(existing.status) ? existing.status : 'PENDING',
          relatedHypothesisIds: existing?.relatedHypothesisIds ?? [],
          executionActionKey: c.spec.pivotType,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          key: c.key,
          entityId: c.entity.id,
          depth: c.entity.depth ?? 0,
          collector: c.collectorId,
          source: 'planner',
          plain,
          scoreBreakdown: c.breakdown ? { ...c.breakdown, finalScore: scored.get(c.key)?.score ?? c.score, expectedProgressPerCost: scored.get(c.key)?.expected ?? null } as any : c.breakdown,
          blockedReason: c.blockedReason,
          lastError: existing?.lastError,
        };
        store.saveLead(lead);
      }
      for (const lead of store.getLeads(operationId)) {
        if (lead.source === 'planner' && lead.status === 'PENDING' && lead.key && !keep.has(lead.key)) {
          const doneRec = store.pivotBySignature(operationId, lead.key);
          store.saveLead({ ...lead, status: doneRec ? 'COMPLETED' : 'DISCARDED', updatedAt: now });
        }
      }
    });
    return store.getLeads(operationId).sort((a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || b.priorityScore - a.priorityScore);
  }
}

function hasMinableEvidence(kinds: Set<string>) {
  for (const k of kinds) if (['manual_import', 'analyst_note', 'main_evidence', 'html_source_audit', 'html_scam_kit', 'page_source', 'imported_report'].includes(k) || k.startsWith('manual')) return true;
  return false;
}

function gapScore(pivotType: string, entity: Entity, kinds: Set<string>): { score: number; reason: string } {
  switch (pivotType) {
    case 'DNS_RESOLVE':
      return [...kinds].some(k => k.startsWith('dns_')) ? { score: 0, reason: '' } : { score: 6, reason: 'no DNS evidence yet' };
    case 'CT_SEARCH':
      return kinds.has('ct_certificate') ? { score: 0, reason: '' } : { score: 7, reason: 'certificates not checked yet' };
    case 'RDAP_DOMAIN':
      return kinds.has('rdap_registration') ? { score: 0, reason: '' } : { score: 4, reason: 'registration date unknown (timeline gap)' };
    case 'SITE_PROFILE':
    case 'SITE_CHECK_REQUEST':
      return kinds.has('page_fingerprint') || kinds.has('site_scan') ? { score: 0, reason: '' } : { score: 8, reason: 'kit/template of this site unknown' };
    case 'WALLET_TRACE':
      return kinds.has('transfer_flow') && entity.isSeed === false ? { score: 2, reason: 'extends the money trail' } : { score: 9, reason: 'money trail not followed yet' };
    case 'WALLET_PROFILE':
      return kinds.has('address_profile') ? { score: 0, reason: '' } : { score: 5, reason: 'contract/deployer status unknown' };
    case 'IP_PROFILE':
      return kinds.has('ip_asn') ? { score: 0, reason: '' } : { score: 4, reason: 'hosting network unknown' };
    case 'SHARED_RESOURCE':
    case 'TRACKER_REUSE':
      return { score: 7, reason: 'could reveal sibling sites' };
    case 'REVERSE_NS':
    case 'REVERSE_IP':
      return { score: 5, reason: 'could reveal co-hosted sites' };
    default:
      return { score: 2, reason: 'adds context' };
  }
}

export function isKnownPivot(pivotType: string) {
  return Boolean(PIVOTS[pivotType]);
}
