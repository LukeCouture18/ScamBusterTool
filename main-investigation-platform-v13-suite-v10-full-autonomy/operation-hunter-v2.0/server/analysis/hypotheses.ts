import type { Hypothesis, HypothesisCategory, HypothesisStatus, ContradictionReport, ReasoningTraceChain } from '../types.js';
import type { HunterStore } from '../core/store.js';
import type { OpData } from './data.js';
import type { GraphAnalysis } from './graph.js';
import type { InfraAnalysis } from './infrastructure.js';
import type { KitAnalysis } from './kits.js';
import type { FinancialAnalysisV1 } from './financial.js';
import type { CrossOpLink } from './crossop.js';
import type { Gap } from './gaps.js';
import { evidenceIdsFor } from './data.js';
import { listPhrase, nowIso, round, stableId, uniq, plural } from '../core/util.js';

interface Indicator { text: string; weight: number; evidenceIds: string[]; relIds: string[] }
interface Template {
  key: string; category: HypothesisCategory; title: string; description: string; nullHypothesis: string;
  indicators: Indicator[]; strengthen: string[]; weaken: string[]; resolve: string[]; competing: string[]; bias: number; gapCategories: string[];
}

export interface HypothesisResult { hypotheses: Hypothesis[]; contradictions: ContradictionReport[] }

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

function status(conf: number, negatives: number): HypothesisStatus {
  if (negatives >= 2 && conf < 0.3) return 'CONTRADICTED';
  if (conf >= 0.8) return 'STRONGLY_SUPPORTED';
  if (conf < 0.35) return 'WEAKENED';
  return 'FORMULATED';
}

export function buildTemplates(data: OpData, graph: GraphAnalysis, infra: InfraAnalysis, kits: KitAnalysis, fin: FinancialAnalysisV1, cross: CrossOpLink[]): Template[] {
  const templates: Template[] = [];
  const core = new Set(graph.core);
  const coreDomains = infra.domains.filter(d => core.has(d.id));
  const relsOf = (pred: (r: OpData['relationships'][number]) => boolean) => data.relationships.filter(pred);

  // H1: one operator behind the core sites
  if (coreDomains.length >= 2) {
    const ind: Indicator[] = [];
    for (const i of kits.indicators.filter(x => x.level === 'operator' && x.domains.length >= 2)) {
      const rels = relsOf(r => r.targetEntityId === i.id || r.sourceEntityId === i.id);
      ind.push({ text: `${i.kind} ${i.value} is set on ${plural(i.domains.length, 'site')} (${listPhrase(i.domains, 3)})`, weight: i.type === 'wallet' || i.type === 'contract' ? 1.3 : 1.1, evidenceIds: evidenceIdsFor(rels, 6), relIds: rels.map(r => r.id).slice(0, 6) });
    }
    for (const d of fin.deployers.filter(x => x.contracts.length >= 2)) {
      const rels = relsOf(r => r.type === 'CREATED_BY');
      ind.push({ text: `One deployer (${d.deployer.slice(0, 10)}…) created ${d.contracts.length} collection contracts`, weight: 1.4, evidenceIds: evidenceIdsFor(rels, 4), relIds: rels.map(r => r.id).slice(0, 4) });
    }
    const multiCerts = infra.certificates.filter(c => uniq(c.domainsInOperation.map(x => x.split('.').slice(-2).join('.'))).length >= 2 && c.domainsInOperation.every(x => coreDomains.some(d => d.value === x)));
    for (const c of multiCerts.slice(0, 3)) {
      const rels = relsOf(r => r.sourceEntityId === c.id && r.type === 'COVERS');
      ind.push({ text: `Certificate ${c.label} names ${listPhrase(c.domainsInOperation, 3)} together`, weight: 0.8, evidenceIds: evidenceIdsFor(rels, 3), relIds: rels.map(r => r.id).slice(0, 3) });
    }
    const privateNs = infra.nameserverSets.find(s => !s.commodity && s.domains.filter(x => coreDomains.some(d => d.value === x)).length >= 3);
    if (privateNs) {
      const rels = relsOf(r => r.type === 'DELEGATED_TO').filter(r => privateNs.nameservers.includes(data.byId.get(r.targetEntityId)?.value ?? ''));
      ind.push({ text: `${plural(privateNs.domains.length, 'domain')} use the same non-commodity nameservers ${privateNs.nameservers[0]}`, weight: 0.4, evidenceIds: evidenceIdsFor(rels, 4), relIds: rels.map(r => r.id).slice(0, 4) });
    }
    const treasuries = fin.wallets.filter(w => w.role === 'TREASURY' && w.senders >= 2);
    if (treasuries.length) ind.push({ text: `Funds from ${plural(treasuries[0].senders, 'collection address', 'collection addresses')} converge on treasury ${treasuries[0].address.slice(0, 10)}…`, weight: 0.6, evidenceIds: [], relIds: [] });
    // Contradictions: separate groups of operator indicators that never co-occur.
    const opInd = kits.indicators.filter(x => x.level === 'operator' && x.domains.length >= 2 && x.type === 'identifier');
    const groups = uniq(opInd.map(i => i.domains.slice().sort().join(',')));
    const disjoint = groups.length >= 2 && groups.every((g, i) => groups.every((h, j) => i === j || !g.split(',').some(x => h.split(',').includes(x))));
    if (disjoint) ind.push({ text: 'Two sets of sites use completely different operator identifiers, which suggests more than one deployment team', weight: -1.2, evidenceIds: [], relIds: [] });
    if (kits.indicators.some(x => x.level === 'shared' && x.type === 'identifier')) ind.push({ text: 'An identifier here also appears in another operation — it could be a kit default rather than an operator setting', weight: -0.4, evidenceIds: [], relIds: [] });
    templates.push({
      key: 'common_operator', category: 'COMMON_OPERATOR', bias: -0.8,
      title: 'The core sites are run by a single operator',
      description: `The ${coreDomains.length} core sites (${listPhrase(coreDomains.map(d => d.value), 3)}) appear to be deployed and administered by the same person or team.`,
      nullHypothesis: 'The sites were set up by different people who happen to use the same kit and hosting.',
      indicators: ind, competing: ['kit_syndication', 'bulletproof_hosting'],
      strengthen: ['Another operator-level indicator (analytics ID, support handle, deployer) shared by sites from different waves', 'The same collection wallet displayed on several sites (site check / WalletLogger evidence)'],
      weaken: ['Sites in the cluster with different analytics/support handles and different treasuries', 'The shared identifier also appearing in unrelated operations (kit default)'],
      resolve: ['Hosting provider or exchange records linking the accounts (law-enforcement process)', 'Operator self-identification in a support channel'],
      gapCategories: ['kit', 'money', 'operator'],
    });
  }

  // H2: kit syndication
  if (kits.families.length) {
    const ind: Indicator[] = [];
    const shared = kits.families.filter(f => f.otherOperations.length);
    for (const f of shared) ind.push({ text: `${f.name} page code is also used in ${listPhrase(f.otherOperations)}`, weight: 1.0, evidenceIds: [], relIds: [] });
    for (const v of kits.vendorIndicators.filter(x => x.type === 'wallet' || x.type === 'contract')) ind.push({ text: `Fee wallet ${v.value.slice(0, 10)}… takes a fixed cut: ${v.reason}`, weight: 1.2, evidenceIds: [], relIds: [] });
    const kitSiblings = infra.domains.filter(d => d.role === 'peripheral' && d.templates.length);
    if (kitSiblings.length) ind.push({ text: `${plural(kitSiblings.length, 'site')} run the same kit but have no operator-level link to this operation (${listPhrase(kitSiblings.map(d => d.value), 3)})`, weight: 0.9, evidenceIds: [], relIds: [] });
    if (kits.families.some(f => f.capabilities.some(c => /Obfuscated/i.test(c)))) ind.push({ text: 'Kit code is professionally obfuscated, typical of commercially sold drainers', weight: 0.3, evidenceIds: [], relIds: [] });
    if (!shared.length && !kitSiblings.length) ind.push({ text: 'The kit has not been seen outside this operation yet', weight: -0.6, evidenceIds: [], relIds: [] });
    templates.push({
      key: 'kit_syndication', category: 'SCAM_KIT_SYNDICATION', bias: -0.6,
      title: `${kits.families[0].name} is a commercial kit used by several groups`,
      description: 'The page code and wallet-draining logic come from a kit that is sold or rented to multiple operators (drainer-as-a-service), rather than being written by this operator.',
      nullHypothesis: 'The kit is private to this operator and not used by anyone else.',
      indicators: ind, competing: ['common_operator'],
      strengthen: ['The same kit files on sites with unrelated analytics/support identifiers', 'A fee wallet receiving fixed percentages from several unrelated collection contracts'],
      weaken: ['Kit code found only on sites that share operator-level identifiers'],
      resolve: ['Vendor advertisements or leaked panel access showing multiple customers'],
      gapCategories: ['kit'],
    });
  }

  // H3: bulletproof / shared hosting
  const hostingWithStrangers = infra.hosting.filter(h => !h.commodity && h.domains.length >= 2);
  if (hostingWithStrangers.length) {
    const ind: Indicator[] = [];
    for (const h of hostingWithStrangers) {
      const strangers = h.domains.filter(d => !core.has(infra.domains.find(x => x.value === d)?.id ?? ''));
      const rels = relsOf(r => r.type === 'RESOLVES_TO' && data.byId.get(r.targetEntityId)?.value === h.ip);
      if (strangers.length) ind.push({ text: `${h.ip}${h.holder ? ` (${h.holder})` : ''} also hosts ${plural(strangers.length, 'unrelated-looking site')}: ${listPhrase(strangers, 3)}`, weight: 0.9, evidenceIds: evidenceIdsFor(rels, 4), relIds: rels.map(r => r.id).slice(0, 4) });
      else ind.push({ text: `${h.ip} hosts only this operation's sites (${plural(h.domains.length, 'site')}) — looks dedicated`, weight: -0.7, evidenceIds: evidenceIdsFor(rels, 3), relIds: rels.map(r => r.id).slice(0, 3) });
    }
    const asns = infra.asns.filter(a => !a.commodity);
    if (asns.length) ind.push({ text: `Hosting concentrated in ${listPhrase(asns.map(a => `${a.asn} ${a.holder ?? ''}`.trim()), 2)}`, weight: 0.3, evidenceIds: [], relIds: [] });
    templates.push({
      key: 'bulletproof_hosting', category: 'SHARED_BULLETPROOF_HOSTING', bias: -0.4,
      title: 'The operation rents abuse-tolerant hosting shared with other criminals',
      description: 'Servers and nameservers are rented from providers that host many unrelated abusive sites; shared hosting does not by itself link those sites to this operator.',
      nullHypothesis: 'The servers are dedicated to this operation.',
      indicators: ind, competing: ['common_operator'],
      strengthen: ['Reverse lookups showing many unrelated abuse sites on the same servers'],
      weaken: ['Every co-hosted site sharing this operation’s identifiers'],
      resolve: ['Hosting provider customer records'],
      gapCategories: ['hosting'],
    });
  }

  // H4: cash-out
  if (fin.hasData) {
    const ind: Indicator[] = [];
    for (const x of fin.exits) {
      const rels = relsOf(r => r.type === 'FUNDS_TRANSFER' && data.byId.get(r.targetEntityId)?.value.toLowerCase() === x.address);
      ind.push({ text: `${Object.entries(x.bySymbol).map(([s, v]) => `${v} ${s}`).join(' + ')} sent to ${x.label} (${x.kind})`, weight: x.kind === 'exchange deposit' ? 1.3 : x.kind === 'mixer' ? 0.9 : 0.6, evidenceIds: evidenceIdsFor(rels, 4), relIds: rels.map(r => r.id).slice(0, 4) });
    }
    if (!fin.exits.length) ind.push({ text: 'No exit to an exchange, mixer or bridge has been traced yet', weight: -1.0, evidenceIds: [], relIds: [] });
    if (fin.sweepTiming.automated) ind.push({ text: fin.sweepTiming.description, weight: 0.3, evidenceIds: [], relIds: [] });
    const main = fin.exits[0];
    templates.push({
      key: 'cash_out', category: 'CASH_OUT_SERVICE', bias: -0.3,
      title: main ? `Stolen funds are cashed out through ${main.label}` : 'Stolen funds are cashed out through a service',
      description: 'The money trail ends at services (exchange deposit addresses, mixers, bridges) used to convert or hide the proceeds.',
      nullHypothesis: 'Funds are still held by the operator and have not been cashed out.',
      indicators: ind, competing: [],
      strengthen: ['Further hops from the treasury into labelled exchange hot wallets', 'Deposit addresses reused across several cash-out events'],
      weaken: ['Funds sitting unmoved in the treasury'],
      resolve: ['Exchange compliance response identifying the deposit account'],
      gapCategories: ['money'],
    });
  }

  // H5: rotation
  if (infra.rotations.length || fin.rotations.length || infra.takenDown.length) {
    const ind: Indicator[] = [];
    for (const r of infra.rotations) ind.push({ text: `${r.from} → ${r.to} after ${r.gapDays} days, sharing ${r.sharedFeatures.join(', ')}`, weight: 1.0, evidenceIds: r.evidenceIds.slice(0, 4), relIds: [] });
    for (const r of fin.rotations) ind.push({ text: r.reason, weight: 0.7, evidenceIds: [], relIds: [] });
    if (infra.standby.length) ind.push({ text: `${plural(infra.standby.length, 'reserve domain')} registered but not yet used: ${listPhrase(infra.standby, 3)}`, weight: 0.6, evidenceIds: [], relIds: [] });
    if (!infra.rotations.length && infra.takenDown.length) ind.push({ text: 'Domains were taken down but no replacement has been found yet', weight: -0.5, evidenceIds: [], relIds: [] });
    templates.push({
      key: 'rotation', category: 'INFRASTRUCTURE_ROTATION', bias: -0.5,
      title: 'The operator replaces infrastructure after takedowns and will do it again',
      description: 'When a site is taken down or burned, the same setup reappears on new domains/addresses. Expect new sites matching this operation’s fingerprint.',
      nullHypothesis: 'The replacement sites belong to someone else copying the setup.',
      indicators: ind, competing: [],
      strengthen: ['A new domain matching the fingerprint appearing shortly after a takedown', 'Reserve domains becoming active'],
      weaken: ['New sites with different operator identifiers'],
      resolve: ['Observing the same operator identifiers on the replacement site'],
      gapCategories: ['monitoring'],
    });
  }

  // H6: false positives among peripheral sites
  const fpCandidates = infra.domains.filter(x => x.role === 'peripheral' && (graph.roleReasons[x.id] || !x.templates.length))
    .sort((a, b) => Number(Boolean(graph.roleReasons[b.id])) - Number(Boolean(graph.roleReasons[a.id])));
  for (const d of fpCandidates.slice(0, 3)) {
    const ls = graph.linkStrength[d.id];
    const contrary = graph.roleReasons[d.id];
    templates.push({
      key: `false_positive:${d.value}`, category: 'FALSE_POSITIVE', bias: 0.2,
      title: `${d.value} is not part of this operation`,
      description: contrary ? `${contrary} Shared hosting alone does not link sites.` : `${d.value} is connected only through ${ls?.via?.length ? ls.via.map(v => v.toLowerCase().replace(/_/g, ' ')).join(' → ') : 'weak links'} (link strength ${Math.round((ls?.strength ?? 0) * 100)}%). Shared hosting alone does not link sites.`,
      nullHypothesis: `${d.value} belongs to the same operator.`,
      indicators: [
        { text: `Only linked through ${ls?.path?.join(' → ') ?? 'shared infrastructure'}`, weight: 0.8, evidenceIds: [], relIds: [] },
        ...(contrary ? [{ text: 'Runs different page code and shares no operator identifier with the operation’s sites', weight: 1.0, evidenceIds: [], relIds: [] }] : []),
        ...(d.pageTitle ? [{ text: `Different kind of site: "${d.pageTitle}"`, weight: 0.5, evidenceIds: [], relIds: [] }] : []),
        ...(d.identifiers.length ? [{ text: `Has its own identifiers ${listPhrase(d.identifiers, 2)}`, weight: 0.3, evidenceIds: [], relIds: [] }] : []),
      ],
      competing: [], strengthen: ['A site check showing unrelated content'], weaken: ['Finding this operation’s identifiers or wallets on it'], resolve: ['Page content and deposit wallets from a site check'],
      gapCategories: [],
    });
  }
  return templates;
}

export function evaluateHypotheses(store: HunterStore, data: OpData, templates: Template[], gaps: Gap[]): HypothesisResult {
  const now = nowIso();
  const out: Hypothesis[] = [];
  const idByKey = new Map<string, string>();
  for (const t of templates) idByKey.set(t.key, store.hypothesisByTemplate(data.op.id, t.key)?.id ?? stableId('hyp', data.op.id, t.key));
  for (const t of templates) {
    const existing = store.hypothesisByTemplate(data.op.id, t.key) as (Hypothesis & { analystLocked?: boolean; analystStatus?: HypothesisStatus }) | undefined;
    const score = t.bias + t.indicators.reduce((s, i) => s + i.weight, 0);
    const conf = round(logistic(score), 2);
    const negatives = t.indicators.filter(i => i.weight < 0).length;
    const h: Hypothesis & { analystLocked?: boolean; analystStatus?: HypothesisStatus } = {
      id: idByKey.get(t.key)!, operationId: data.op.id, title: t.title, description: t.description, category: t.category,
      status: existing?.analystLocked && existing.analystStatus ? existing.analystStatus : status(conf, negatives),
      confidenceScore: conf,
      supportingEvidenceIds: uniq(t.indicators.filter(i => i.weight > 0).flatMap(i => i.evidenceIds)).slice(0, 20),
      contradictingEvidenceIds: uniq(t.indicators.filter(i => i.weight < 0).flatMap(i => i.evidenceIds)).slice(0, 20),
      supportingObservations: t.indicators.filter(i => i.weight > 0).map(i => i.text),
      contradictingObservations: t.indicators.filter(i => i.weight < 0).map(i => i.text),
      conditionsToStrengthen: t.strengthen, conditionsToWeaken: t.weaken, conditionsToResolve: t.resolve,
      competingHypothesisIds: t.competing.map(k => idByKey.get(k)).filter(Boolean) as string[],
      aiGenerated: true, createdAt: existing?.createdAt ?? now, updatedAt: now,
      analystLocked: existing?.analystLocked, analystStatus: existing?.analystStatus,
    };
    store.saveHypothesis(h, t.key);
    out.push(h);
  }
  // Manual hypotheses: drop invalidated support, weaken accordingly.
  for (const h of store.getHypotheses(data.op.id)) {
    if (out.some(x => x.id === h.id)) continue;
    const invalid = h.supportingEvidenceIds.filter(id => data.evidenceById.get(id)?.status === 'invalidated');
    if (invalid.length) {
      const next = { ...h, supportingEvidenceIds: h.supportingEvidenceIds.filter(id => !invalid.includes(id)), contradictingEvidenceIds: uniq([...h.contradictingEvidenceIds, ...invalid]), confidenceScore: round(Math.max(0.1, h.confidenceScore * 0.6), 2), updatedAt: now };
      if (!next.supportingEvidenceIds.length) next.status = 'WEAKENED';
      store.saveHypothesis(next, null);
      out.push(next);
    } else out.push(h);
  }
  // Retire auto hypotheses whose template no longer applies.
  const activeKeys = new Set(templates.map(t => t.key));
  for (const row of store.all<{ id: string; template_key: string | null; data: string }>('SELECT id, template_key, data FROM hypotheses WHERE operation_id=? AND template_key IS NOT NULL', data.op.id)) {
    if (row.template_key && !activeKeys.has(row.template_key)) {
      const h = JSON.parse(row.data) as Hypothesis;
      if (h.status !== 'RESOLVED') store.saveHypothesis({ ...h, status: 'WEAKENED', updatedAt: now, contradictingObservations: uniq([...h.contradictingObservations, 'The pattern behind this hypothesis is no longer present in the evidence']) }, row.template_key);
    }
  }

  const contradictions: ContradictionReport[] = [];
  for (const t of templates) {
    const h = out.find(x => x.id === idByKey.get(t.key))!;
    if (h.confidenceScore < 0.45) continue;
    const invalid = data.invalidEvidence.filter(e => e.relatedEntityIds.some(id => data.byId.has(id))).slice(0, 3);
    const relatedGaps = gaps.filter(g => t.gapCategories.includes(g.category)).slice(0, 4).map(g => g.title);
    contradictions.push({
      hypothesisId: h.id, hypothesisTitle: h.title, disprovalHypothesis: t.nullHypothesis,
      contradictingEvidence: [
        ...t.indicators.filter(i => i.weight < 0).map(i => ({ evidenceId: i.evidenceIds[0] ?? 'analysis', observation: i.text, source: 'hunter analysis' })),
        ...invalid.map(e => ({ evidenceId: e.id, observation: `${e.originalObservation} [invalidated: ${e.invalidationReason ?? ''}]`, source: e.source })),
      ],
      unresolvedGaps: relatedGaps.length ? relatedGaps : ['No independent source has yet been checked that could contradict this.'],
      devilAdvocateAssessment: devilsAdvocate(t, h.confidenceScore),
    });
  }
  return { hypotheses: out, contradictions };
}

function devilsAdvocate(t: Template, conf: number): string {
  const strongest = [...t.indicators].filter(i => i.weight > 0).sort((a, b) => b.weight - a.weight)[0];
  const base = `Argue the opposite: "${t.nullHypothesis}"`;
  if (!strongest) return `${base} Nothing specific supports the hypothesis yet, so the opposite is equally plausible.`;
  return `${base} The case for the hypothesis rests mostly on: ${strongest.text}. If that turned out to be a kit default, a shared service or a data error, confidence would drop from ${Math.round(conf * 100)}% to about ${Math.round(logistic(t.bias + t.indicators.reduce((s, i) => s + (i === strongest ? 0 : i.weight), 0)) * 100)}%. ${t.weaken[0] ? `Look for: ${t.weaken[0].toLowerCase()}.` : ''}`;
}

export function traceability(data: OpData, hypotheses: Hypothesis[], itemId: string): ReasoningTraceChain {
  const h = hypotheses.find(x => x.id === itemId) ?? [...hypotheses].sort((a, b) => b.confidenceScore - a.confidenceScore)[0];
  if (!h) {
    return { conclusionId: 'none', claim: 'No hypotheses yet', conclusion: 'Run a pursuit to generate hypotheses.', confidenceScore: 0, leadingHypothesis: { id: 'none', title: 'None', category: 'FALSE_POSITIVE', confidence: 0, confidenceScore: 0 }, competingHypotheses: [], supportingRelationships: [], observations: [], originalEvidence: [], activeContradictions: [], devilAdvocateCounterTheory: '', devilsAdvocateCondition: '', alternativeExplanations: [] };
  }
  const evidence = h.supportingEvidenceIds.map(id => data.evidenceById.get(id)).filter(Boolean) as OpData['evidence'];
  const rels = data.relationships.filter(r => r.evidenceIds.some(id => h.supportingEvidenceIds.includes(id))).slice(0, 12);
  const competitors = hypotheses.filter(x => h.competingHypothesisIds.includes(x.id));
  return {
    conclusionId: h.id, claim: h.title, conclusion: `${h.title} — ${Math.round(h.confidenceScore * 100)}% (${h.status.toLowerCase().replace('_', ' ')})`, confidenceScore: h.confidenceScore,
    leadingHypothesis: { id: h.id, title: h.title, category: h.category, confidence: h.confidenceScore, confidenceScore: h.confidenceScore },
    competingHypotheses: competitors.map(c => ({ id: c.id, title: c.title, category: c.category, confidence: c.confidenceScore, whyNotFavored: c.confidenceScore < h.confidenceScore ? `Less supported (${Math.round(c.confidenceScore * 100)}%): ${c.contradictingObservations[0] ?? c.supportingObservations[0] ?? 'fewer indicators'}` : `Comparable support (${Math.round(c.confidenceScore * 100)}%) — both remain open` })),
    supportingRelationships: rels.map(r => ({ id: r.id, type: r.type, reasoning: r.reasoning, source: data.byId.get(r.sourceEntityId)?.value ?? r.sourceEntityId, target: data.byId.get(r.targetEntityId)?.value ?? r.targetEntityId, confidence: r.confidence })),
    observations: evidence.map(e => ({ evidenceId: e.id, source: e.source, originalObservation: e.originalObservation, confidence: e.confidence })),
    originalEvidence: evidence.map(e => ({ id: e.id, type: e.type, provenance: e.provenance, sha256Hash: e.sha256Hash, rawDataSummary: JSON.stringify(e.rawData).slice(0, 220) })),
    activeContradictions: h.contradictingObservations.map(c => ({ contradictionTitle: c, disprovalReason: c, unresolvedGaps: h.conditionsToWeaken })),
    devilAdvocateCounterTheory: h.conditionsToWeaken.join(' '), devilsAdvocateCondition: `This conclusion would be disproved by: ${h.conditionsToWeaken[0] ?? 'contradicting operator-level evidence'}.`,
    alternativeExplanations: competitors.map(c => c.title),
  };
}
