import type { Entity, GraphBridge, GraphCluster, Relationship } from '../types.js';
import type { OpData } from './data.js';
import { relevant } from './data.js';
import { countBy, round, topEntries, listPhrase } from '../core/util.js';

type Facet = 'HOSTING_INFRASTRUCTURE' | 'CERTIFICATE_GROUP' | 'TEMPLATE_FAMILY' | 'TRACKER_SYNDICATE' | 'FINANCIAL_PIPELINE';

const FACET_EDGES: Record<Facet, Relationship['type'][]> = {
  HOSTING_INFRASTRUCTURE: ['RESOLVES_TO', 'DELEGATED_TO', 'USES_MAIL_SERVER', 'HOSTS', 'SHARED_INFRASTRUCTURE', 'SERVED_BY', 'REDIRECTS_TO'],
  CERTIFICATE_GROUP: ['COVERS', 'CERTIFIED_BY'],
  TEMPLATE_FAMILY: ['EXECUTES_TEMPLATE', 'SHARES_RESOURCE'],
  TRACKER_SYNDICATE: ['USES_IDENTIFIER', 'REFERENCES_WALLET', 'CONTROLS_WALLET', 'ANNOUNCED_BY'],
  FINANCIAL_PIPELINE: ['FUNDS_TRANSFER', 'CREATED_BY'],
};

/** How strongly a relationship type links two things operationally (for link-strength paths). */
export const EDGE_STRENGTH: Record<string, number> = {
  USES_IDENTIFIER: 0.95, REFERENCES_WALLET: 0.95, CONTROLS_WALLET: 0.95, CREATED_BY: 0.95, COVERS: 0.85, CERTIFIED_BY: 0.85, REDIRECTS_TO: 0.85,
  FUNDS_TRANSFER: 0.8, EXECUTES_TEMPLATE: 0.35, SHARES_RESOURCE: 0.35, RESOLVES_TO: 0.5, DELEGATED_TO: 0.45, MENTIONS: 0.5, USES_MAIL_SERVER: 0.4,
  SERVED_BY: 0.15, REGISTERED_WITH: 0.05, SHARED_INFRASTRUCTURE: 0.45, ROTATED_TO: 0.8, REAPPEARANCE_OF: 0.8, HOSTS: 0.6, SUBDOMAIN_OF: 0.8, SIMILAR_TO: 0.4, ANNOUNCED_BY: 0.6,
};

export interface GraphAnalysis {
  clusters: GraphCluster[];
  bridges: GraphBridge[];
  linkStrength: Record<string, { strength: number; path: string[]; via: string[] }>;
  roleReasons: Record<string, string>;
  core: string[];            // entity ids strongly tied to a seed
  peripheral: string[];      // relevant entities tied only weakly (shared hosting etc.)
  orphans: string[];         // not connected to any seed
  centrality: Array<{ entityId: string; value: string; type: string; betweenness: number; degree: number }>;
}

function components(ids: string[], adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Wallet roles that must not carry "trust" between parts of the graph: many
 * unrelated parties pay into fee wallets, exchanges and mixers.
 */
const NON_TRANSIT_ROLES = new Set(['FEE_RECIPIENT', 'EXCHANGE', 'MIXER', 'BRIDGE', 'DEX', 'SERVICE', 'CEX_DEPOSIT', 'VICTIM']);

function edgeStrength(type: string, target: Entity): number {
  if (type === 'USES_IDENTIFIER' && String(target.value).startsWith('wc:')) return 0.35; // WalletConnect project IDs are often baked into kits
  if (type === 'DELEGATED_TO' && target.type === 'nameserver') return (target.ubiquity ?? 0) <= 0.15 ? 0.6 : 0.4;
  return EDGE_STRENGTH[type] ?? 0.3;
}

export function analyzeGraph(data: OpData, walletRoles: Map<string, string> = new Map()): GraphAnalysis {
  const rel = data.relationships;
  const useful = (e: Entity | undefined) => Boolean(e && relevant(e) && e.type !== 'asn' && e.type !== 'registrar');
  const clusters: GraphCluster[] = [];

  for (const facet of Object.keys(FACET_EDGES) as Facet[]) {
    const adj = new Map<string, Set<string>>();
    for (const r of rel) {
      if (!FACET_EDGES[facet].includes(r.type)) continue;
      const a = data.byId.get(r.sourceEntityId), b = data.byId.get(r.targetEntityId);
      if (!useful(a) || !useful(b)) continue;
      // Shared services (exchanges, mixers) would merge unrelated pipelines; keep them out of money clusters.
      if (facet === 'FINANCIAL_PIPELINE' && (serviceKind(a!) || serviceKind(b!))) continue;
      (adj.get(a!.id) ?? adj.set(a!.id, new Set()).get(a!.id)!).add(b!.id);
      (adj.get(b!.id) ?? adj.set(b!.id, new Set()).get(b!.id)!).add(a!.id);
    }
    for (const comp of components([...adj.keys()], adj)) {
      const members = comp.map(id => data.byId.get(id)!).filter(Boolean);
      const domains = members.filter(e => e.type === 'domain');
      const wallets = members.filter(e => e.type === 'wallet' || e.type === 'contract');
      const qualifies = facet === 'FINANCIAL_PIPELINE' ? wallets.length >= 3 : domains.length >= 2;
      if (!qualifies) continue;
      const relsIn = rel.filter(r => comp.includes(r.sourceEntityId) && comp.includes(r.targetEntityId) && FACET_EDGES[facet].includes(r.type));
      const confidence = round(relsIn.length ? relsIn.reduce((s, r) => s + r.confidence, 0) / relsIn.length : 0.5, 2);
      clusters.push({
        id: `cluster-${facet.toLowerCase()}-${stableKey(comp)}`,
        operationId: data.op.id,
        name: clusterName(facet, members, data),
        category: facet as GraphCluster['category'],
        description: clusterDescription(facet, members, data),
        entityIds: comp,
        confidence,
        reasoning: `${relsIn.length} evidence-backed ${facet === 'FINANCIAL_PIPELINE' ? 'transfers/deployments' : 'links'} connect these ${members.length} items (${summaryTypes(members)}).`,
      });
    }
  }
  clusters.sort((a, b) => b.entityIds.length - a.entityIds.length);

  // Link strength from the seeds: best product of edge strengths along any path (Dijkstra on -log).
  const seedIds = data.entities.filter(e => e.isSeed).map(e => e.id);
  const strengthAdj = new Map<string, Array<{ to: string; w: number; type: string }>>();
  const transit = (e: Entity) => Boolean(e.isSeed) || relevant(e) && e.type !== 'asn' && e.type !== 'registrar' && !((e.type === 'wallet' || e.type === 'contract') && NON_TRANSIT_ROLES.has(walletRoles.get(e.value.toLowerCase()) ?? ''));
  for (const r of rel) {
    const a = data.byId.get(r.sourceEntityId), b = data.byId.get(r.targetEntityId);
    if (!a || !b) continue;
    // Never route "trust" through commodity nodes, low-signal hubs or shared-service wallets.
    const w = Math.min(edgeStrength(r.type, a), edgeStrength(r.type, b)) * Math.max(0.2, r.confidence);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      if (!transit(x)) continue;
      // a non-transit node can be reached (it gets a strength) but nothing is reached through it
      (strengthAdj.get(x.id) ?? strengthAdj.set(x.id, []).get(x.id)!).push({ to: y.id, w: transit(y) ? w : w * 0.5, type: r.type });
    }
  }
  const best = new Map<string, { strength: number; prev?: string; via?: string }>();
  const queue: Array<{ id: string; s: number }> = seedIds.map(id => ({ id, s: 1 }));
  for (const id of seedIds) best.set(id, { strength: 1 });
  while (queue.length) {
    queue.sort((a, b) => b.s - a.s);
    const cur = queue.shift()!;
    if ((best.get(cur.id)?.strength ?? 0) > cur.s + 1e-9) continue;
    for (const edge of strengthAdj.get(cur.id) ?? []) {
      const s = cur.s * edge.w;
      if (s > (best.get(edge.to)?.strength ?? 0) + 1e-9) {
        best.set(edge.to, { strength: s, prev: cur.id, via: edge.type });
        queue.push({ id: edge.to, s });
      }
    }
  }
  const linkStrength: GraphAnalysis['linkStrength'] = {};
  for (const [id, b] of best) {
    const path: string[] = [], via: string[] = [];
    let cur: string | undefined = id;
    let guard = 0;
    while (cur && guard++ < 50) {
      path.unshift(data.byId.get(cur)?.value ?? cur);
      const info = best.get(cur);
      if (info?.via) via.unshift(info.via);
      cur = info?.prev;
    }
    linkStrength[id] = { strength: round(b.strength, 3), path, via };
  }
  // Independent kinds of evidence into a domain add up (noisy-OR across evidence classes,
  // best link within each class — five signals from the same kit are still one fact).
  const CLASS: Record<string, string> = { USES_IDENTIFIER: 'operator', REFERENCES_WALLET: 'operator', CONTROLS_WALLET: 'operator', CREATED_BY: 'operator', COVERS: 'certificate', CERTIFIED_BY: 'certificate', EXECUTES_TEMPLATE: 'kit', SHARES_RESOURCE: 'kit', RESOLVES_TO: 'hosting', DELEGATED_TO: 'hosting', USES_MAIL_SERVER: 'hosting', FUNDS_TRANSFER: 'money', REDIRECTS_TO: 'redirect', MENTIONS: 'mention' };
  for (const d of data.entities.filter(e => e.type === 'domain' && !e.isSeed)) {
    const bestByClass = new Map<string, number>();
    for (const [nid, edges] of strengthAdj) {
      if (nid === d.id) continue;
      const s = best.get(nid)?.strength ?? 0;
      if (!s) continue;
      for (const edge of edges) {
        if (edge.to !== d.id) continue;
        const nodeClass = String(data.byId.get(nid)?.value ?? '').startsWith('wc:') ? 'kit' : (CLASS[edge.type] ?? 'other');
        bestByClass.set(nodeClass, Math.max(bestByClass.get(nodeClass) ?? 0, s * edge.w));
      }
    }
    const agg = round(1 - [...bestByClass.values()].reduce((acc, v) => acc * (1 - v), 1), 3);
    if (linkStrength[d.id] && agg > linkStrength[d.id].strength) linkStrength[d.id] = { ...linkStrength[d.id], strength: Math.min(0.99, agg) };
  }
  const relevantEntities = data.entities.filter(e => relevant(e) && e.type !== 'asn' && e.type !== 'registrar' && e.type !== 'certificate');
  let core = relevantEntities.filter(e => (linkStrength[e.id]?.strength ?? 0) >= 0.3).map(e => e.id);
  let peripheral = relevantEntities.filter(e => { const s = linkStrength[e.id]?.strength ?? 0; return s > 0 && s < 0.3; }).map(e => e.id);
  // Contrary evidence: a site that runs different page code than the operation's sites and shares
  // no operator-level identifier with them is context (co-hosted), not a member.
  const roleReasons: Record<string, string> = {};
  const coreSet = new Set(core);
  const tplOf = (id: string) => (data.out.get(id) ?? []).filter(r => r.type === 'EXECUTES_TEMPLATE').map(r => data.byId.get(r.targetEntityId)).filter(Boolean) as Entity[];
  const opIndOf = (id: string) => (data.out.get(id) ?? []).filter(r => r.type === 'USES_IDENTIFIER' || r.type === 'REFERENCES_WALLET').map(r => r.targetEntityId);
  const seedDomains = data.entities.filter(e => e.isSeed && e.type === 'domain');
  const tplVotes = new Map<string, number>();
  for (const id of core) for (const t of tplOf(id)) tplVotes.set(t.id, (tplVotes.get(t.id) ?? 0) + 1);
  const mainTemplates = new Set<string>(seedDomains.flatMap(d => tplOf(d.id).map(t => t.id)));
  if (!mainTemplates.size) { const topT = [...tplVotes.entries()].sort((a, b) => b[1] - a[1])[0]; if (topT) mainTemplates.add(topT[0]); }
  const mainFamilies = new Set([...mainTemplates].map(id => data.byId.get(id)?.metadata?.kitFamily).filter(Boolean));
  for (const id of [...core]) {
    const e = data.byId.get(id)!;
    if (e.type !== 'domain' || e.isSeed) continue;
    const tpls = tplOf(id);
    if (!tpls.length || !mainTemplates.size) continue;
    if (tpls.some(t => mainTemplates.has(t.id) || (t.metadata?.kitFamily && mainFamilies.has(t.metadata.kitFamily)))) continue;
    const sharesOperatorLink = opIndOf(id).some(ind => [...(data.in.get(ind) ?? [])].some(r => r.sourceEntityId !== id && coreSet.has(r.sourceEntityId)));
    if (sharesOperatorLink) continue;
    core = core.filter(x => x !== id);
    peripheral = [...peripheral, id];
    roleReasons[id] = `Runs different page code (${tpls[0].label}) and shares no operator identifier with the operation's sites — only infrastructure overlaps.`;
  }
  const orphans = relevantEntities.filter(e => !linkStrength[e.id]).map(e => e.id);

  // Betweenness centrality (Brandes, unweighted) over relevant entities.
  const nodes = relevantEntities.map(e => e.id);
  const nodeSet = new Set(nodes);
  const adj = new Map<string, string[]>();
  for (const r of rel) {
    if (!nodeSet.has(r.sourceEntityId) || !nodeSet.has(r.targetEntityId)) continue;
    (adj.get(r.sourceEntityId) ?? adj.set(r.sourceEntityId, []).get(r.sourceEntityId)!).push(r.targetEntityId);
    (adj.get(r.targetEntityId) ?? adj.set(r.targetEntityId, []).get(r.targetEntityId)!).push(r.sourceEntityId);
  }
  const bc = new Map<string, number>(nodes.map(n => [n, 0]));
  if (nodes.length <= 1500) {
    for (const s of nodes) {
      const stack: string[] = [];
      const pred = new Map<string, string[]>();
      const sigma = new Map<string, number>([[s, 1]]);
      const dist = new Map<string, number>([[s, 0]]);
      const q = [s];
      while (q.length) {
        const v = q.shift()!;
        stack.push(v);
        for (const w of adj.get(v) ?? []) {
          if (!dist.has(w)) { dist.set(w, dist.get(v)! + 1); q.push(w); }
          if (dist.get(w) === dist.get(v)! + 1) {
            sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!);
            (pred.get(w) ?? pred.set(w, []).get(w)!).push(v);
          }
        }
      }
      const delta = new Map<string, number>();
      while (stack.length) {
        const w = stack.pop()!;
        for (const v of pred.get(w) ?? []) delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0)));
        if (w !== s) bc.set(w, (bc.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }
  const norm = nodes.length > 2 ? (nodes.length - 1) * (nodes.length - 2) : 1;
  const centrality = nodes.map(id => ({ entityId: id, value: data.byId.get(id)!.value, type: data.byId.get(id)!.type, betweenness: round((bc.get(id) ?? 0) / norm, 4), degree: (adj.get(id) ?? []).length }))
    .sort((a, b) => b.betweenness - a.betweenness || b.degree - a.degree);

  // Bridges: entities that sit in two or more clusters of different kinds, ranked by betweenness.
  const membership = new Map<string, GraphCluster[]>();
  for (const c of clusters) for (const id of c.entityIds) (membership.get(id) ?? membership.set(id, []).get(id)!).push(c);
  const bridges: GraphBridge[] = [];
  for (const c of centrality) {
    const inClusters = membership.get(c.entityId) ?? [];
    const kinds = new Set(inClusters.map(x => x.category));
    if (kinds.size < 2 && c.betweenness < 0.15) continue;
    const e = data.byId.get(c.entityId)!;
    bridges.push({
      id: `bridge-${e.id}`, operationId: data.op.id, title: bridgeTitle(e), entityId: e.id, entityValue: e.value, entityType: e.type,
      connectedClusters: inClusters.map(x => x.id),
      bridgeSignificance: bridgeSignificance(e, inClusters, c.betweenness),
      riskAssessment: bridgeRisk(e),
    });
    if (bridges.length >= 8) break;
  }
  return { clusters, bridges, linkStrength, roleReasons, core, peripheral, orphans, centrality: centrality.slice(0, 40) };
}

function serviceKind(e: Entity) {
  return ['exchange', 'mixer', 'bridge', 'dex', 'protocol', 'token'].includes(String(e.metadata?.labelKind ?? ''));
}

function stableKey(ids: string[]) {
  return [...ids].sort()[0]?.replace(/^ent-/, '').slice(0, 8) ?? 'x';
}

function summaryTypes(members: Entity[]) {
  return topEntries(countBy(members, m => m.type), 4).map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`).join(', ');
}

function clusterName(facet: Facet, members: Entity[], data: OpData): string {
  const domains = members.filter(e => e.type === 'domain');
  switch (facet) {
    case 'HOSTING_INFRASTRUCTURE': {
      const ns = members.filter(e => e.type === 'nameserver').map(e => e.value);
      const ips = members.filter(e => e.type === 'ip');
      const asn = topEntries(countBy(ips, i => String(i.metadata?.asnHolder ?? i.metadata?.asn ?? '')), 1)[0]?.[0];
      return `Hosting cluster: ${domains.length} domains on ${ns.length ? ns[0] : ips.length ? ips[0].value : 'shared servers'}${asn ? ` (${asn.split(' ').slice(0, 2).join(' ')})` : ''}`;
    }
    case 'CERTIFICATE_GROUP':
      return `Certificate group: ${domains.length} domains share TLS certificates`;
    case 'TEMPLATE_FAMILY': {
      const tpls = members.filter(e => e.type === 'template');
      const fams = topEntries(countBy(tpls.filter(t => t.metadata?.kitFamily), t => String(t.metadata.kitFamily)), 2).map(([f]) => f);
      const name = fams.length ? fams.join(' + ') : tpls[0]?.label ?? 'shared page code';
      return `Kit family: ${name} on ${domains.length} sites`;
    }
    case 'TRACKER_SYNDICATE': {
      const ids = members.filter(e => e.type === 'identifier' || e.type === 'email').map(e => e.value);
      return `Operator indicators: ${listPhrase(ids, 2) || 'shared wallets'} across ${domains.length} sites`;
    }
    case 'FINANCIAL_PIPELINE': {
      const wallets = members.filter(e => e.type === 'wallet' || e.type === 'contract');
      return `Money pipeline: ${wallets.length} addresses`;
    }
  }
  void data;
  return facet;
}

function clusterDescription(facet: Facet, members: Entity[], _data: OpData): string {
  const domains = members.filter(e => e.type === 'domain').map(e => e.value);
  switch (facet) {
    case 'HOSTING_INFRASTRUCTURE': return `${domains.length} domains share servers or nameservers: ${listPhrase(domains, 5)}.`;
    case 'CERTIFICATE_GROUP': return `Certificates list these domains together: ${listPhrase(domains, 5)}. One certificate naming several domains is usually requested by one administrator.`;
    case 'TEMPLATE_FAMILY': return `These sites run the same page code or load identical script files: ${listPhrase(domains, 5)}.`;
    case 'TRACKER_SYNDICATE': return `These sites embed the same analytics/support identifiers or deposit wallets: ${listPhrase(domains, 5)}.`;
    case 'FINANCIAL_PIPELINE': return `Addresses connected by on-chain transfers or contract deployment (${members.length} addresses).`;
  }
}

function bridgeTitle(e: Entity) {
  switch (e.type) {
    case 'nameserver': return `Shared nameserver ${e.value}`;
    case 'ip': return `Shared server ${e.value}`;
    case 'certificate': return `Shared certificate ${e.label}`;
    case 'identifier': return `Shared identifier ${e.value}`;
    case 'wallet': case 'contract': return `Money hub ${e.label !== e.value ? e.label : `${e.value.slice(0, 12)}…`}`;
    case 'template': return `Kit fingerprint ${e.label}`;
    default: return `${e.type} ${e.value}`;
  }
}

function bridgeSignificance(e: Entity, clusters: GraphCluster[], bc: number) {
  const kinds = Array.from(new Set(clusters.map(c => c.category.toLowerCase().replace(/_/g, ' '))));
  return `${e.value} connects ${kinds.length ? listPhrase(kinds) : 'several parts of the graph'} (centrality ${round(bc * 100, 1)}%). Many paths between the operation’s parts run through it, so it is a high-value point to verify, monitor, or report.`;
}

function bridgeRisk(e: Entity) {
  switch (e.type) {
    case 'wallet': case 'contract': return 'Transfers show where funds moved, not who controls the addresses. Check labels before treating it as operator-owned.';
    case 'nameserver': case 'ip': return 'Hosting can be shared by unrelated customers; confirm with operator-level indicators before linking everything behind it.';
    case 'template': case 'artifact': return 'Kits are sold to many buyers; shared code may indicate a common vendor rather than a common operator.';
    default: return 'Treat as a lead: verify with an independent source before relying on it.';
  }
}
