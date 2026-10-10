import type { Entity, ReappearanceFingerprint, ReappearanceLead } from '../types.js';
import type { HunterApp } from '../app.js';
import type { OpData } from './data.js';
import type { GraphAnalysis } from './graph.js';
import type { InfraAnalysis } from './infrastructure.js';
import type { KitAnalysis } from './kits.js';
import type { FinancialAnalysisV1 } from './financial.js';
import { canonicalize, registrableDomain, tldOf, hostnameOf } from '../core/canonical.js';
import { simhashSimilarity } from '../collectors/artifact.js';
import { newId, nowIso, round, stableId, uniq, listPhrase } from '../core/util.js';

export interface CandidateFeatures {
  domain?: string; nameservers?: string[]; ips?: string[]; asns?: string[]; identifiers?: string[]; wallets?: string[];
  templates?: string[]; simhash?: string; resources?: string[]; registrar?: string; kitFamily?: string; title?: string;
  // legacy v0.x feature names
  domHash?: string; gaTag?: string; destinationWallet?: string;
}

const OPERATOR_TYPES = new Set(['tag_identifier', 'wallet', 'wallet_settlement_cluster']);

/** Derive the signature set that would recognise this operation if it reappeared elsewhere. */
export function deriveFingerprints(data: OpData, graph: GraphAnalysis, infra: InfraAnalysis, kits: KitAnalysis, fin: FinancialAnalysisV1): ReappearanceFingerprint[] {
  const core = new Set(graph.core);
  const coreDomains = infra.domains.filter(d => core.has(d.id));
  const window = `${(coreDomains.map(d => d.firstSeen).sort()[0] ?? data.op.createdAt).slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}`;
  const fps: ReappearanceFingerprint[] = [];
  const add = (signatureType: ReappearanceFingerprint['signatureType'], value: string, description: string, weight: number) => {
    if (!value || fps.some(f => f.signatureType === signatureType && f.signatureValue === value)) return;
    fps.push({ id: stableId('fp', data.op.id, signatureType, value), operationId: data.op.id, signatureType, signatureValue: value, description, activeWindow: window, confidenceWeight: weight });
  };
  for (const t of kits.templates.filter(t => t.domains.some(d => coreDomains.some(c => c.value === d)))) add('template_dom_hash', t.value, `Page structure ${t.label}${t.simhash ? ` (simhash ${t.simhash})` : ''}`, 0.6);
  for (const r of kits.resources.filter(r => !r.common && r.domains.some(d => coreDomains.some(c => c.value === d)))) add('resource_hash', r.value, `Kit file ${r.label}`, 0.55);
  for (const f of kits.families) add('kit_family', f.name, `Kit family ${f.name}`, 0.25);
  for (const i of kits.indicators.filter(i => i.level === 'operator' || i.level === 'shared')) {
    if (i.type === 'wallet' || i.type === 'contract') add('wallet', i.value.toLowerCase(), `${i.kind} ${i.value}`, 0.95);
    else add('tag_identifier', canonicalize(i.type, i.value), `${i.kind} ${i.value}`, i.level === 'operator' ? 0.9 : 0.6);
  }
  for (const w of fin.wallets.filter(w => ['COLLECTION', 'SPLITTER', 'TREASURY', 'DEPLOYER'].includes(w.role))) add('wallet', w.address.toLowerCase(), `${w.role.toLowerCase()} wallet ${w.address}`, 0.95);
  for (const s of infra.nameserverSets.filter(s => !s.commodity && s.domains.some(d => coreDomains.some(c => c.value === d)))) add('nameserver_pair', s.key, `Nameservers ${s.key}`, 0.5);
  for (const a of infra.asns.filter(a => !a.commodity)) add('hosting_asn', a.asn, `Hosting network ${a.asn} ${a.holder ?? ''}`.trim(), 0.2);
  if (infra.naming && infra.naming.keywords.length) add('naming_pattern', `kw:${infra.naming.keywords.slice(0, 8).join(',')}|tld:${infra.naming.tlds.join(',')}`, `Domain names like ${infra.naming.pattern} (${listPhrase(infra.naming.examples, 3)})`, 0.35);
  for (const c of infra.certificates.filter(c => c.domainsInOperation.length >= 2)) add('cert_san_base', uniq(c.domainsInOperation.map(registrableDomain)).sort().join(','), `Domains certified together: ${listPhrase(c.domainsInOperation, 3)}`, 0.3);
  return fps.sort((a, b) => b.confidenceWeight - a.confidenceWeight);
}

export function scoreCandidate(fps: ReappearanceFingerprint[], f: CandidateFeatures, simhashOf: (templateValue: string) => string | undefined) {
  const norm = normalizeFeatures(f);
  const breakdown: ReappearanceLead['matchBreakdown'] = [];
  const matched: string[] = [];
  let remain = 1;
  let operatorLevel = false;
  for (const fp of fps) {
    let sim = 0;
    let observed = '';
    switch (fp.signatureType) {
      case 'template_dom_hash': {
        if (norm.templates.includes(fp.signatureValue)) { sim = 1; observed = fp.signatureValue; }
        else {
          const mine = simhashOf(fp.signatureValue);
          const theirs = norm.simhash ?? norm.templates.map(t => simhashOf(t)).find(Boolean);
          if (mine && theirs) { const s = simhashSimilarity(mine, theirs); if (s >= 0.8) { sim = s; observed = `near-identical structure (${Math.round(s * 100)}%)`; } }
        }
        break;
      }
      case 'resource_hash': if (norm.resources.includes(fp.signatureValue)) { sim = 1; observed = fp.signatureValue; } break;
      case 'kit_family': if (norm.kitFamily && norm.kitFamily === fp.signatureValue) { sim = 1; observed = norm.kitFamily; } break;
      case 'tag_identifier': if (norm.identifiers.includes(fp.signatureValue)) { sim = 1; observed = fp.signatureValue; } break;
      case 'wallet': if (norm.wallets.includes(fp.signatureValue)) { sim = 1; observed = fp.signatureValue; } break;
      case 'nameserver_pair': {
        const want = fp.signatureValue.split(' + ');
        const hit = want.filter(n => norm.nameservers.includes(n));
        if (hit.length) { sim = hit.length / want.length; observed = hit.join(' + '); }
        break;
      }
      case 'hosting_asn': if (norm.asns.includes(fp.signatureValue)) { sim = 1; observed = fp.signatureValue; } break;
      case 'naming_pattern': {
        if (!norm.domain) break;
        const [kwPart, tldPart] = fp.signatureValue.split('|');
        const kws = kwPart.replace('kw:', '').split(',');
        const tlds = (tldPart ?? '').replace('tld:', '').split(',');
        const tokens = registrableDomain(norm.domain).split('.')[0].split(/[-_]/).filter(t => t.length >= 3);
        const hits = tokens.filter(t => kws.includes(t));
        if (hits.length) { sim = Math.min(1, 0.45 + 0.25 * hits.length + (tlds.includes(tldOf(norm.domain)) ? 0.15 : 0)); observed = `${norm.domain} (${hits.join(', ')})`; }
        break;
      }
      case 'cert_san_base': break;
      default: break;
    }
    if (sim > 0) {
      matched.push(fp.id);
      breakdown.push({ fingerprintType: fp.signatureType, expected: fp.signatureValue, observed, similarity: round(sim, 2) });
      remain *= 1 - fp.confidenceWeight * sim;
      if (OPERATOR_TYPES.has(fp.signatureType) && sim >= 0.99) operatorLevel = true;
    }
  }
  const score = Math.round((1 - remain) * 100);
  const kitOnly = !operatorLevel && breakdown.some(b => ['template_dom_hash', 'resource_hash', 'kit_family'].includes(b.fingerprintType)) && !breakdown.some(b => b.fingerprintType === 'nameserver_pair');
  const status: ReappearanceLead['status'] = score >= 80 && operatorLevel ? 'CONFIRMED_ROTATION' : kitOnly && score >= 45 ? 'NEW_CLUSTER' : score >= 50 ? 'OPEN' : 'FALSE_ALARM';
  return { score, breakdown, matched, operatorLevel, status };
}

function normalizeFeatures(f: CandidateFeatures) {
  return {
    domain: f.domain ? hostnameOf(f.domain).replace(/^www\./, '') : undefined,
    nameservers: (f.nameservers ?? []).map(n => hostnameOf(n)).sort(),
    ips: f.ips ?? [], asns: (f.asns ?? []).map(a => canonicalize('asn', a)),
    identifiers: uniq([...(f.identifiers ?? []), ...(f.gaTag ? [f.gaTag] : [])].map(i => canonicalize('identifier', i))),
    wallets: uniq([...(f.wallets ?? []), ...(f.destinationWallet ? [f.destinationWallet] : [])].map(w => canonicalize('wallet', w))),
    templates: uniq([...(f.templates ?? []), ...(f.domHash ? [f.domHash.startsWith('dom:') ? f.domHash : `dom:${f.domHash}`] : [])]),
    simhash: f.simhash, resources: (f.resources ?? []).map(r => (r.startsWith('sha256:') ? r : `sha256:${r}`).toLowerCase()), kitFamily: f.kitFamily,
  };
}

export class ReappearanceEngine {
  constructor(private app: HunterApp) {}

  private simhashOf = (templateValue: string): string | undefined => {
    const row = this.app.store.get<{ metadata: string }>("SELECT metadata FROM entities WHERE type='template' AND canonical=? LIMIT 1", templateValue.toLowerCase());
    try { return row ? JSON.parse(row.metadata).simhash : undefined; } catch { return undefined; }
  };

  /** Everything Hunter already knows about a candidate (from any operation). */
  knownFeatures(value: string): CandidateFeatures {
    const domain = hostnameOf(value).replace(/^www\./, '');
    const hits = this.app.store.operationsWithCanonical(domain);
    const f: CandidateFeatures = { domain, nameservers: [], ips: [], asns: [], identifiers: [], wallets: [], templates: [], resources: [] };
    for (const hit of hits) {
      for (const r of this.app.store.getRelationships(hit.operationId).filter(r => r.sourceEntityId === hit.entityId)) {
        const t = this.app.store.getEntity(r.targetEntityId);
        if (!t) continue;
        if (r.type === 'DELEGATED_TO') f.nameservers!.push(t.value);
        else if (r.type === 'RESOLVES_TO' && t.type === 'ip') { f.ips!.push(t.value); if (t.metadata?.asn) f.asns!.push(t.metadata.asn); }
        else if (r.type === 'USES_IDENTIFIER') f.identifiers!.push(t.value);
        else if (r.type === 'REFERENCES_WALLET') f.wallets!.push(t.value);
        else if (r.type === 'EXECUTES_TEMPLATE') { f.templates!.push(t.value); if (t.metadata?.simhash) f.simhash = t.metadata.simhash; if (t.metadata?.kitFamily) f.kitFamily = t.metadata.kitFamily; }
        else if (r.type === 'SHARES_RESOURCE') f.resources!.push(t.value);
      }
    }
    return f;
  }

  /** Score without saving (used to decide whether a candidate deserves a closer look). */
  preview(operationId: string, candidateValue: string, features: CandidateFeatures = {}): number {
    return scoreCandidate(this.app.store.getFingerprints(operationId), { ...features, domain: features.domain ?? candidateValue }, this.simhashOf).score;
  }

  check(operationId: string, candidateValue: string, candidateType: string, features: CandidateFeatures = {}, source = 'manual'): ReappearanceLead & { operatorLevel: boolean; saved: boolean } {
    const fps = this.app.store.getFingerprints(operationId);
    const known = this.knownFeatures(candidateValue);
    const merged: CandidateFeatures = {
      ...known, ...features, domain: candidateType === 'domain' ? candidateValue : features.domain ?? known.domain,
      nameservers: uniq([...(known.nameservers ?? []), ...(features.nameservers ?? [])]), identifiers: uniq([...(known.identifiers ?? []), ...(features.identifiers ?? [])]),
      wallets: uniq([...(known.wallets ?? []), ...(features.wallets ?? [])]), templates: uniq([...(known.templates ?? []), ...(features.templates ?? [])]),
      resources: uniq([...(known.resources ?? []), ...(features.resources ?? [])]), ips: uniq([...(known.ips ?? []), ...(features.ips ?? [])]), asns: uniq([...(known.asns ?? []), ...(features.asns ?? [])]),
    };
    const result = scoreCandidate(fps, merged, this.simhashOf);
    const existing = this.app.store.findReappearance(operationId, candidateValue);
    const lead: ReappearanceLead = {
      id: existing?.id ?? newId('reapp', 10), operationId, candidateValue: candidateValue.toLowerCase(), candidateType, matchedFingerprintIds: result.matched,
      overallSimilarityScore: result.score, matchBreakdown: result.breakdown,
      reasoning: reasoning(result, candidateValue), detectedAt: existing?.detectedAt ?? nowIso(), status: existing && existing.status !== 'OPEN' && existing.status !== result.status ? existing.status : result.status, source,
    };
    const saved = result.score >= 40;
    if (saved) {
      this.app.store.saveReappearance(lead);
      if (!existing) {
        this.app.store.addChange(operationId, 'reappearance', `${candidateValue} matches this operation's fingerprint (${result.score}%, ${lead.status.toLowerCase().replace('_', ' ')}) — source: ${source}`, { candidate: candidateValue, score: result.score });
        this.app.store.logAudit(operationId, 'REAPPEARANCE', `${candidateValue}: ${result.score}% (${source})`);
      }
      this.app.store.touch(operationId, 'reappearance');
    }
    return { ...lead, operatorLevel: result.operatorLevel, saved };
  }

  /** Match a candidate seen elsewhere (Main Platform, monitors) against every operation. */
  checkAgainstAll(candidateValue: string, candidateType: string, features: CandidateFeatures, source: string) {
    const out: Array<ReappearanceLead & { operatorLevel: boolean; saved: boolean }> = [];
    for (const op of this.app.store.getOperations()) {
      if (op.isDemo || op.status === 'CONCLUDED') continue;
      if (this.app.store.findEntity(op.id, candidateType, candidateValue)) continue; // already part of it
      const r = this.check(op.id, candidateValue, candidateType, features, source);
      if (r.saved) out.push(r);
    }
    return out.sort((a, b) => b.overallSimilarityScore - a.overallSimilarityScore);
  }

  /** Called after a pursuit pivot adds entities: note cross-operation overlaps immediately. */
  onNewEntities(operationId: string, entities: Entity[]) {
    for (const e of entities) {
      if (e.type !== 'domain' && e.type !== 'wallet' && e.type !== 'identifier') continue;
      if ((e.ubiquity ?? 0) >= 0.75) continue;
      const others = this.app.store.operationsWithCanonical(e.canonical ?? e.value).filter(h => h.operationId !== operationId);
      for (const other of others) {
        const op = this.app.store.getOperation(other.operationId);
        const me = this.app.store.getOperation(operationId);
        if (!op || !me || Boolean(op.isDemo) !== Boolean(me.isDemo)) continue;
        this.app.store.addChange(operationId, 'cross_operation', `${e.value} also belongs to operation ${op.code}`, { otherOperationId: op.id, value: e.value });
      }
    }
  }
}

function reasoning(r: ReturnType<typeof scoreCandidate>, candidate: string): string {
  if (!r.breakdown.length) return `${candidate} shares nothing with this operation's fingerprint.`;
  const parts = r.breakdown.map(b => `${b.fingerprintType.replace(/_/g, ' ')} (${Math.round(b.similarity * 100)}%)`);
  const base = `${candidate} matches ${listPhrase(parts, 4)}.`;
  if (r.status === 'CONFIRMED_ROTATION') return `${base} Operator-level indicators match, so this is most likely the same operation redeploying. Verify before acting — this is a strong match, not proof.`;
  if (r.status === 'NEW_CLUSTER') return `${base} Only kit-level features match: probably the same kit used by a different group.`;
  if (r.status === 'OPEN') return `${base} Worth checking: some operational features match but nothing operator-specific yet.`;
  return `${base} Too weak to link.`;
}
