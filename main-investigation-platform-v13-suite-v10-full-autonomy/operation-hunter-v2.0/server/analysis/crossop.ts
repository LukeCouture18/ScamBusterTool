import type { CrossOperationSimilarity, Entity } from '../types.js';
import type { HunterStore } from '../core/store.js';
import type { OpData } from './data.js';
import type { FinancialAnalysisV1 } from './financial.js';
import type { GraphAnalysis } from './graph.js';
import { relevant } from './data.js';
import { linkWeight } from '../engine/noise.js';
import { round, listPhrase } from '../core/util.js';

export interface CrossOpLink extends CrossOperationSimilarity {
  operationBCode: string;
  sharedIdentifiers: string[];
  shared: Array<{ type: string; value: string; label: string; weight: number; level: 'operator' | 'kit' | 'hosting' | 'context' }>;
  whatItDoesNotProve: string;
  isDemo: boolean;
}

const OPERATOR_TYPES = new Set(['identifier', 'email']);
const KIT_TYPES = new Set(['template', 'artifact']);
const HOSTING_TYPES = new Set(['ip', 'nameserver', 'hostname', 'asn', 'registrar', 'certificate']);

/**
 * Compare one operation against every other operation in this Hunter
 * instance by shared canonical indicators, weighted by how meaningful each
 * indicator type is and how common it is on the internet.
 */
export function analyzeCrossOps(store: HunterStore, data: OpData, fin: FinancialAnalysisV1, graph: GraphAnalysis): CrossOpLink[] {
  const core = new Set(graph.core);
  const mine = new Map<string, Entity>();
  for (const e of data.entities) if (e.canonical) mine.set(`${bucket(e.type)}:${e.canonical}`, e);
  const roleOf = new Map(fin.wallets.map(w => [w.address.toLowerCase(), w.role]));
  const results: CrossOpLink[] = [];
  for (const other of store.getOperations()) {
    if (other.id === data.op.id) continue;
    // Demo and real operations are never compared with each other.
    if (Boolean(other.isDemo) !== Boolean(data.op.isDemo)) continue;
    const shared: CrossOpLink['shared'] = [];
    for (const e of store.getEntities(other.id)) {
      const m = mine.get(`${bucket(e.type)}:${e.canonical}`);
      if (!m) continue;
      const kitType = KIT_TYPES.has(m.type) || m.value.startsWith('wc:') || ['FEE_RECIPIENT'].includes(roleOf.get(m.value.toLowerCase()) ?? '');
      const theirRole = String(e.metadata?.linkRole ?? 'core');
      // Overlaps that sit on the periphery of either operation (kit siblings, co-hosted sites) are not links between the operations.
      if (!kitType && (['peripheral', 'orphan', 'outside'].includes(theirRole) || (!core.has(m.id) && ['domain', 'identifier', 'email', 'wallet', 'contract'].includes(m.type) && !m.isSeed))) continue;
      const ub = Math.max(m.ubiquity ?? 0, e.ubiquity ?? 0);
      const role = roleOf.get(m.value.toLowerCase());
      let level: CrossOpLink['shared'][number]['level'] = 'context';
      if (m.type === 'wallet' || m.type === 'contract') level = role === 'FEE_RECIPIENT' || ['EXCHANGE', 'MIXER', 'BRIDGE', 'DEX', 'SERVICE'].includes(role ?? '') ? (role === 'FEE_RECIPIENT' ? 'kit' : 'context') : 'operator';
      else if (OPERATOR_TYPES.has(m.type)) level = m.value.startsWith('wc:') ? 'kit' : 'operator';
      else if (KIT_TYPES.has(m.type)) level = 'kit';
      else if (HOSTING_TYPES.has(m.type)) level = ub >= 0.75 ? 'context' : 'hosting';
      else if (m.type === 'domain') level = core.has(m.id) && !m.metadata?.discoveredIn?.includes?.('shared resource') ? 'operator' : 'kit';
      let weight = linkWeight(m.type, ub);
      if (level === 'kit' && (m.type === 'wallet' || m.type === 'contract')) weight = 0.5;
      if (!relevant(m) && level !== 'context') level = 'context';
      shared.push({ type: m.type, value: m.value, label: m.label, weight: round(weight, 2), level });
    }
    if (!shared.length) continue;
    const meaningful = shared.filter(s => s.level !== 'context');
    const op = meaningful.filter(s => s.level === 'operator');
    const kit = meaningful.filter(s => s.level === 'kit');
    const host = meaningful.filter(s => s.level === 'hosting');
    const raw = Math.round(100 * (1 - meaningful.reduce((acc, s) => acc * (1 - Math.min(0.95, s.weight)), 1)));
    // Kit-level or hosting-level overlap alone can never score as high as an operator-level overlap.
    const score = op.length ? raw : kit.length ? Math.min(raw, 65) : host.length ? Math.min(raw, 35) : Math.min(raw, 10);
    const distinction: CrossOperationSimilarity['analyticalDistinction'] = op.length ? 'COMMON_OPERATOR_HIGH_CONFIDENCE' : kit.length ? 'SHARED_COMMERCIAL_KIT' : host.length ? 'SHARED_BULLETPROOF_HOSTING' : 'COINCIDENTAL_CORRELATION';
    const reasoning = distinction === 'COMMON_OPERATOR_HIGH_CONFIDENCE'
      ? `Both operations share operator-level indicators (${listPhrase(op.map(s => s.value), 3)}). Things like analytics accounts, support handles and collection wallets are set by whoever runs a deployment, so this is the strongest kind of cross-operation link Hunter reports. It supports — but does not prove — a common operator; kit defaults and shared services can also produce overlaps.`
      : distinction === 'SHARED_COMMERCIAL_KIT'
        ? `The operations share kit-level indicators (${listPhrase(kit.map(s => s.label), 3)}) but no operator-level ones: different analytics, support handles and treasuries. The best-supported reading is two independent groups using the same commercial drainer kit (and paying the same vendor), not one operator.`
        : distinction === 'SHARED_BULLETPROOF_HOSTING'
          ? `The operations only share hosting (${listPhrase(host.map(s => s.value), 3)}). Abuse-tolerant hosts serve many unrelated customers, so this is weak evidence of any connection.`
          : `Only commodity context overlaps (${listPhrase(shared.map(s => s.value), 3)}). Treat as coincidence.`;
    results.push({
      operationAId: data.op.id, operationBId: other.id, operationBName: other.name, operationBCode: other.code, isDemo: Boolean(other.isDemo),
      sharedInfrastructure: shared.filter(s => HOSTING_TYPES.has(s.type)).map(s => `${s.label}${s.level === 'context' ? ' (commodity)' : ''}`),
      sharedGenomes: kit.filter(s => KIT_TYPES.has(s.type)).map(s => s.label),
      sharedFinancialNodes: shared.filter(s => s.type === 'wallet' || s.type === 'contract').map(s => `${s.label}${s.level === 'kit' ? ' (fee recipient — vendor level)' : ''}`),
      sharedIdentifiers: shared.filter(s => OPERATOR_TYPES.has(s.type)).map(s => s.value),
      overallSimilarityScore: score, analyticalDistinction: distinction, reasoning, shared,
      whatItDoesNotProve: 'Overlap between operations never proves shared ownership. Hunter reports what is shared and how meaningful that kind of indicator usually is.',
    });
  }
  return results.sort((a, b) => b.overallSimilarityScore - a.overallSimilarityScore);
}

function bucket(type: string) {
  return type === 'contract' ? 'wallet' : type === 'hostname' ? 'domain' : type;
}
