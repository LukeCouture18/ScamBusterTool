import type { Entity, ScamKitGenome, OperationGenomeProfile, TaxonomyClassificationTier } from '../types.js';
import type { OpData } from './data.js';
import { neighbors, relevant, otherOperations } from './data.js';
import type { FinancialAnalysisV1 } from './financial.js';
import type { GraphAnalysis } from './graph.js';
import { simhashSimilarity } from '../collectors/artifact.js';
import { uniq, round, listPhrase } from '../core/util.js';

export interface KitTemplate { id: string; value: string; label: string; kitFamily?: string; variant?: string; familySource?: string; simhash?: string; capabilities: string[]; domains: string[]; firstSeen: string; lastSeen: string; otherOperations: string[] }
export interface KitIndicator { id: string; value: string; type: string; kind: string; domains: string[]; otherOperations: string[]; level: 'operator' | 'vendor' | 'shared' | 'single' | 'peripheral'; reason: string }

export interface KitAnalysis {
  templates: KitTemplate[];
  families: Array<{ name: string; templateIds: string[]; variants: Array<{ templateId: string; label: string; firstSeen: string; similarityToPrevious: number | null; addedCapabilities: string[] }>; domains: string[]; capabilities: string[]; otherOperations: string[] }>;
  resources: Array<{ id: string; value: string; label: string; url?: string; domains: string[]; otherOperations: string[]; common: boolean }>;
  indicators: KitIndicator[];
  vendorIndicators: Array<{ value: string; type: string; reason: string }>;
  operatorIndicators: Array<{ value: string; type: string; reason: string }>;
  attributionBoundary: string;
  tier: { tier: TaxonomyClassificationTier; levelDescription: string; criteriaMet: string[]; prohibitedClaims: string[] };
  genomes: ScamKitGenome[];
  operationGenomes: OperationGenomeProfile[];
}

const BOUNDARY = 'Kit code identifies the software, not the people using it: drainer kits are sold and leaked, so identical code on two sites shows shared tooling. Operator-level indicators (analytics accounts, support handles, deployers, collection wallets) are what tie sites to the same deployment — and even those support, rather than prove, common control.';

function identifierKind(e: Entity): string {
  const v = e.value;
  if (e.type === 'email') return 'contact email';
  if (/^G-|^UA-/i.test(v)) return 'analytics ID';
  if (/^GTM-/i.test(v)) return 'tag manager ID';
  if (v.startsWith('@')) return 'Telegram handle';
  if (v.startsWith('wc:')) return 'WalletConnect project ID';
  if (/verification/i.test(v)) return 'site-verification token';
  return String(e.metadata?.identifierKind ?? 'identifier');
}

export function analyzeKits(data: OpData, fin: FinancialAnalysisV1, graph: GraphAnalysis): KitAnalysis {
  const coreDomains = new Set(graph.core.map(id => data.byId.get(id)?.value).filter(Boolean) as string[]);
  const opCode = (id: string) => data.opNames.get(id)?.code ?? id;
  const templates: KitTemplate[] = data.entities.filter(e => e.type === 'template').map(t => {
    const doms = neighbors(data, t.id, ['EXECUTES_TEMPLATE']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
    return {
      id: t.id, value: t.value, label: t.label, kitFamily: t.metadata?.kitFamily, variant: t.metadata?.variant, familySource: t.metadata?.familySource, simhash: t.metadata?.simhash,
      capabilities: t.metadata?.capabilities ?? [], domains: uniq(doms), firstSeen: t.firstSeen, lastSeen: t.lastSeen, otherOperations: otherOperations(data, t).map(opCode),
    };
  }).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

  // Families: explicit kit family name, or near-duplicate page structures (SimHash >= 0.82).
  const families: KitAnalysis['families'] = [];
  for (const t of templates) {
    let fam = families.find(f => (t.kitFamily && f.name === t.kitFamily) || (!t.kitFamily && f.templateIds.some(id => {
      const other = templates.find(x => x.id === id);
      return other?.simhash && t.simhash && simhashSimilarity(other.simhash, t.simhash) >= 0.82;
    })));
    if (!fam) {
      fam = { name: t.kitFamily ?? `Unnamed kit (${t.value.replace('dom:', '').slice(0, 8)})`, templateIds: [], variants: [], domains: [], capabilities: [], otherOperations: [] };
      families.push(fam);
    }
    const prev = fam.variants[fam.variants.length - 1];
    const prevT = prev ? templates.find(x => x.id === prev.templateId) : undefined;
    fam.templateIds.push(t.id);
    fam.variants.push({
      templateId: t.id, label: t.variant ? `${t.variant}` : t.label, firstSeen: t.firstSeen,
      similarityToPrevious: prevT?.simhash && t.simhash ? round(simhashSimilarity(prevT.simhash, t.simhash), 2) : null,
      addedCapabilities: prevT ? t.capabilities.filter(c => !prevT.capabilities.includes(c)) : [],
    });
    fam.domains = uniq([...fam.domains, ...t.domains]);
    fam.capabilities = uniq([...fam.capabilities, ...t.capabilities]);
    fam.otherOperations = uniq([...fam.otherOperations, ...t.otherOperations]);
  }

  families.sort((a, b) => b.domains.filter(d => coreDomains.has(d)).length - a.domains.filter(d => coreDomains.has(d)).length);
  const resources = data.entities.filter(e => e.type === 'artifact').map(a => {
    const doms = neighbors(data, a.id, ['SHARES_RESOURCE', 'EXECUTES_TEMPLATE']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
    return { id: a.id, value: a.value, label: a.label, url: a.metadata?.url, domains: uniq(doms), otherOperations: otherOperations(data, a).map(opCode), common: Boolean(a.metadata?.commonLibrary || a.metadata?.commodity) };
  }).sort((a, b) => b.domains.length - a.domains.length);

  const roleOf = new Map(fin.wallets.map(w => [w.address.toLowerCase(), w.role]));
  const indicators: KitIndicator[] = [];
  for (const e of data.entities) {
    if (!relevant(e)) continue;
    let domains: string[] = [];
    let kind = '';
    if (e.type === 'identifier' || e.type === 'email') {
      domains = neighbors(data, e.id, ['USES_IDENTIFIER']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
      kind = identifierKind(e);
    } else if (e.type === 'wallet' || e.type === 'contract') {
      domains = neighbors(data, e.id, ['REFERENCES_WALLET', 'CONTROLS_WALLET']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
      const role = roleOf.get(e.value.toLowerCase());
      if (!domains.length && !['FEE_RECIPIENT', 'DEPLOYER', 'TREASURY', 'COLLECTION', 'SPLITTER'].includes(role ?? '')) continue;
      kind = role ? `wallet (${role.toLowerCase().replace('_', ' ')})` : 'wallet on site';
    } else continue;
    const others = otherOperations(data, e).map(opCode);
    const role = roleOf.get(e.value.toLowerCase());
    let level: KitIndicator['level'];
    let reason: string;
    const coreHits = domains.filter(d => coreDomains.has(d));
    if (domains.length && !coreHits.length && role !== 'FEE_RECIPIENT') {
      indicators.push({ id: e.id, value: e.value, type: e.type, kind, domains: uniq(domains), otherOperations: others, level: 'peripheral', reason: `Only on sites that are linked to this operation through shared kit code or hosting (${listPhrase(uniq(domains), 2)}) — most likely a different group using the same tools.` });
      continue;
    }
    domains = coreHits.length ? coreHits : domains;
    if (role === 'FEE_RECIPIENT') { level = 'vendor'; reason = `Receives a fixed cut of stolen funds${others.length ? ` here and in ${listPhrase(others)}` : ''} — the signature of a kit vendor or affiliate program, not the operator.`; }
    else if (kind === 'WalletConnect project ID') { level = 'vendor'; reason = others.length ? `Same WalletConnect project in ${listPhrase(others)} — baked into the kit by its builder, not set by each operator.` : 'WalletConnect project IDs are usually embedded by whoever built the kit, so they identify the kit build rather than the operator.'; }
    else if (others.length) { level = 'shared'; reason = `Also present in ${listPhrase(others)}: either the same operator or a default left in the kit. Check whether operator-level indicators overlap too.`; }
    else if (domains.length >= 2 || ['DEPLOYER', 'TREASURY', 'COLLECTION', 'SPLITTER'].includes(role ?? '')) { level = 'operator'; reason = domains.length >= 2 ? `Set on ${domains.length} of this operation's sites and nowhere else Hunter knows — an operator-level link.` : `Money role ${role?.toLowerCase()} unique to this operation.`; }
    else { level = 'single'; reason = 'Seen on one site only so far.'; }
    indicators.push({ id: e.id, value: e.value, type: e.type, kind, domains: uniq(domains), otherOperations: others, level, reason });
  }
  indicators.sort((a, b) => levelOrder(a.level) - levelOrder(b.level) || b.domains.length - a.domains.length);

  const vendorIndicators = [
    ...families.filter(f => f.otherOperations.length).map(f => ({ value: f.name, type: 'template', reason: `Same page code also used in ${listPhrase(f.otherOperations)}` })),
    ...resources.filter(r => !r.common && r.otherOperations.length).map(r => ({ value: r.label, type: 'artifact', reason: `Identical file loaded by sites in ${listPhrase(r.otherOperations)}` })),
    ...indicators.filter(i => i.level === 'vendor').map(i => ({ value: i.value, type: i.type, reason: i.reason })),
  ];
  const operatorIndicators = indicators.filter(i => i.level === 'operator').map(i => ({ value: i.value, type: i.kind, reason: i.reason }));

  const criteria: string[] = [];
  if (operatorIndicators.length) criteria.push(`${operatorIndicators.length} operator-level indicator(s) shared across this operation's sites`);
  if (families.length) criteria.push(`${families.length} kit famil${families.length === 1 ? 'y' : 'ies'} fingerprinted`);
  if (fin.hasData) criteria.push('on-chain flows traced');
  const tier: KitAnalysis['tier'] = operatorIndicators.length >= 2
    ? { tier: 'SUPPORTED_RELATIONSHIP', levelDescription: 'Several independent operator-level indicators tie the sites together; common control is supported but not proven.', criteriaMet: criteria, prohibitedClaims: ['Naming a person or group as the operator', 'Claiming shared kit code proves shared operator'] }
    : operatorIndicators.length === 1 || data.relationships.some(r => r.type === 'COVERS')
      ? { tier: 'CORRELATION', levelDescription: 'Sites are correlated by at least one strong indicator; further corroboration needed.', criteriaMet: criteria, prohibitedClaims: ['Asserting common ownership', 'Attributing to a named actor'] }
      : families.length
        ? { tier: 'SIMILARITY', levelDescription: 'Sites look alike (same kit) but no operator-level link has been observed.', criteriaMet: criteria, prohibitedClaims: ['Treating kit similarity as the same operator'] }
        : { tier: 'SAME_OBSERVATION', levelDescription: 'Too little evidence to classify beyond individual observations.', criteriaMet: criteria, prohibitedClaims: ['Any linkage claim'] };

  const scriptHosts = uniq(data.entities.filter(e => e.metadata?.role === 'script/resource host').map(e => e.value));
  const networks = uniq(fin.networks);
  const genomes: ScamKitGenome[] = families.map((f, i) => {
    const tpls = f.templateIds.map(id => templates.find(t => t.id === id)!).filter(Boolean);
    const latest = tpls[tpls.length - 1];
    return {
      id: `genome-${data.op.id}-${i}`, operationId: data.op.id, kitFamily: f.name, variantVersion: f.variants.map(v => v.label).join(' → '),
      domAstHash: (latest?.value ?? '').replace('dom:', ''), assetSignatures: resources.filter(r => !r.common && r.domains.some(d => f.domains.includes(d))).map(r => r.label).slice(0, 10),
      web3ProvidersDetected: f.capabilities.filter(c => /WalletConnect|TronLink|Solana|Web3Modal/i.test(c)),
      apiEndpointFingerprints: scriptHosts.slice(0, 10),
      depositInterfaceStyle: depositStyle(f.capabilities),
      vendorVsOperatorAnalysis: {
        kitVendorIndicators: vendorIndicators.map(v => `${v.value}: ${v.reason}`).slice(0, 8).concat(f.capabilities.length ? [`Kit capabilities: ${f.capabilities.slice(0, 4).join('; ')}`] : []),
        operatorSpecificIndicators: operatorIndicators.map(o => `${o.value} (${o.type})`).slice(0, 8),
        attributionBoundary: BOUNDARY,
      },
      firstSeen: tpls[0]?.firstSeen ?? data.op.createdAt, lastSeen: latest?.lastSeen ?? data.op.updatedAt,
    };
  });
  const infraSig = uniq(data.entities.filter(e => e.type === 'nameserver' && relevant(e)).map(e => e.value)).slice(0, 3).join(' + ') || 'none observed';
  const finSig = fin.hasData ? `${fin.wallets.filter(w => w.role === 'SPLITTER').length} splitter(s), ${fin.wallets.filter(w => w.role === 'TREASURY').length} treasury, ${fin.exits.length} exit(s); ${fin.sweepTiming.automated ? 'automated sweeps' : 'manual movement'}` : 'not traced';
  const operationGenomes: OperationGenomeProfile[] = [];
  let version = 1;
  for (const f of families) for (const v of f.variants) {
    const t = templates.find(x => x.id === v.templateId)!;
    const prev = operationGenomes[operationGenomes.length - 1];
    operationGenomes.push({
      id: `opg-${data.op.id}-${version}`, operationId: data.op.id, version: `v1.${version - 1}`, createdAt: t.firstSeen, scamKitFamily: f.name, variantVersion: v.label,
      domAstSignature: t.value, faviconMurmurHash: undefined, trackerSignatures: indicators.filter(i => t.domains.some(d => i.domains.includes(d)) && i.type !== 'wallet').map(i => i.value).slice(0, 6),
      infraPatternSignature: infraSig, financialBehaviorSignature: finSig, networkFootprint: networks as any, confidenceCalibration: round(0.6 + Math.min(0.35, t.domains.length * 0.08), 2),
      categorizationTaxonomy: tier,
      forkEvolution: prev ? { parentGenomeId: prev.id, divergedAt: t.firstSeen, mutationType: v.addedCapabilities.some(c => /TRON|Solana|switching/i.test(c)) ? 'TOKEN_DRAINER_EXPANSION' : 'PAYLOAD_OBFUSCATION', description: v.addedCapabilities.length ? `Adds: ${v.addedCapabilities.join('; ')}` : `Structure changed (similarity ${v.similarityToPrevious ?? 'n/a'})` } : undefined,
    });
    version++;
  }
  return { templates, families, resources, indicators, vendorIndicators, operatorIndicators, attributionBoundary: BOUNDARY, tier, genomes, operationGenomes };
}

function levelOrder(l: KitIndicator['level']) {
  return ['operator', 'shared', 'vendor', 'single', 'peripheral'].indexOf(l);
}

function depositStyle(caps: string[]) {
  const styles: string[] = [];
  if (caps.some(c => /Permit2/i.test(c))) styles.push('permit2-signature-drain');
  if (caps.some(c => /typed-data/i.test(c))) styles.push('offchain-signature-phishing');
  if (caps.some(c => /Unlimited token approval/i.test(c))) styles.push('approval-drain');
  if (caps.some(c => /setApprovalForAll/i.test(c))) styles.push('nft-approval-drain');
  if (caps.some(c => /Direct transaction/i.test(c))) styles.push('direct-transfer');
  return styles.join(' + ') || 'unknown (no page content analysed yet)';
}
