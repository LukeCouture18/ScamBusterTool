import type { HunterApp } from '../app.js';
import type { OperationAnalysis } from '../analysis/analyzer.js';
import type { CuratedBriefingLead, InvestigatorBriefing, PredictiveLeadRanking, Lead, TemporalReconstructionReport } from '../types.js';
import { traceability } from '../analysis/hypotheses.js';
import { loadOpData } from '../analysis/data.js';
import { listPhrase } from '../core/util.js';

export const GLOSSARY: Record<string, string> = {
  'Seed': 'The starting indicator you give Hunter (a domain, wallet, IP…). Everything else is discovered from it.',
  'Pivot': 'Using one known indicator to find related ones — e.g. from a domain to its server, then to other domains on that server.',
  'Passive DNS': 'Historical records of which domains pointed to which IP addresses, collected without contacting the sites.',
  'Certificate Transparency (CT)': 'Public, append-only logs of every TLS certificate issued. They reveal which domains were certified together and when.',
  'Nameserver': 'The server that answers DNS questions for a domain. Small private nameservers are strong clustering signals; big providers (Cloudflare) are not.',
  'ASN': 'Autonomous System Number — the network (hosting company) that routes an IP address.',
  'Scam kit / drainer kit': 'Ready-made phishing software, often sold or rented, that tricks visitors into signing wallet approvals that drain their funds.',
  'Operator-level indicator': 'A setting chosen by whoever runs a site (analytics account, support handle, deployer, collection wallet). Stronger evidence of common control than shared code or hosting.',
  'Commodity infrastructure': 'Services shared by huge numbers of unrelated sites (Cloudflare, big registrars, jQuery). Hunter never uses them as links.',
  'Splitter contract': 'A smart contract that automatically divides incoming stolen funds between wallets (e.g. operator 80%, kit vendor 20%).',
  'Exchange deposit address': 'An address an exchange assigns to one customer. Funds sent there can be tied to an account by the exchange.',
  'Reappearance': 'When an operation comes back on new infrastructure; Hunter detects it by matching the operation’s fingerprint.',
  'Hypothesis': 'A possible explanation with a confidence that rises or falls as evidence arrives. Competing explanations stay open until evidence decides.',
  'Evidence gap': 'Something Hunter has not been able to check yet that would change the conclusions.',
  'Link strength': 'How strongly an item is tied to the seed through evidence-backed relationships (0–100%). Weakly linked items are kept as context.',
};

export function legacyBriefing(app: HunterApp, a: OperationAnalysis): InvestigatorBriefing {
  const top = a.brief.top;
  const curated: CuratedBriefingLead[] = top.slice(0, 5).map(f => ({
    id: f.id, title: f.title, whatHunterNoticed: f.whatFound, whyItMatters: f.whyItMatters, whatItDoesNotProve: f.doesNotProve, simpleExplanation: f.whatItMeans,
    targetValue: String(f.action?.params?.value ?? f.entityIds[0] ?? ''), targetType: f.kind, pivotType: String(f.action?.params?.pivotType ?? f.kind.toUpperCase()),
    confidence: Math.round(f.confidence * 100), supportingEvidenceCount: f.evidenceIds.length, contradictingEvidenceCount: 0,
    evidenceSummary: f.evidenceIds.length ? `${f.evidenceIds.length} evidence record(s): ${f.evidenceIds.slice(0, 3).join(', ')}` : 'Derived from Hunter analysis of the collected evidence',
    recommendedNextStep: f.nextStep, bestNextStep: f.nextStep, priorityScore: f.importance, executionActionKey: f.action?.type, status: 'PENDING',
  }));
  const important = top[0];
  return {
    operationId: a.operationId, generatedAt: a.computedAt,
    whatDidWeFind: `${a.brief.headline} ${a.brief.narrative}`,
    whyDoesItMatter: important ? important.whyItMatters : 'Mapping the operation shows where it can be disrupted and how to recognise it when it returns.',
    howConfidentAreWe: { percentage: a.brief.confidence.percentage, assessment: a.brief.confidence.assessment, evidenceCount: a.brief.counts.evidence },
    importantDiscovery: important ? { title: important.title, description: important.whatFound, whyItMatters: important.whyItMatters, discoveredAt: important.firstSeenAt } : null,
    whatChanged: app.store.getChanges(a.operationId, null, 6).map(c => c.summary),
    uncertaintiesAndContradictions: [...a.contradictions.slice(0, 3).map(c => `${c.hypothesisTitle}: ${c.devilAdvocateAssessment}`), ...top.slice(0, 2).map(f => f.uncertainty)],
    topLeads: curated,
    whatShouldIInvestigateNext: a.brief.nextStep,
    glossary: GLOSSARY,
  };
}

export function predictiveRankings(leads: Lead[]): PredictiveLeadRanking[] {
  return leads.filter(l => l.status === 'PENDING').slice(0, 25).map(l => ({
    leadId: l.id, title: l.title, targetType: l.targetType, targetValue: l.targetValue, pivotType: l.pivotType, overallRankScore: l.priorityScore,
    scoreBreakdown: l.scoreBreakdown ?? { expectedInfoGain: l.expectedInfoGain, noveltyScore: l.noveltyScore, gapFulfillmentScore: 1, historicalStrategyUtility: 50, relevanceWeight: 50, costPenalty: 0, saturationPenalty: 0, finalScore: l.priorityScore },
    pedagogicalBreakdown: {
      whatHunterFound: l.plain?.what ?? l.description, whyItMatters: l.plain?.why ?? l.reasoning, whatItDoesNotProve: l.plain?.doesNotProve ?? 'A lead is a question to check, not a conclusion.',
      evidenceBasis: l.reasoning, confidencePercent: l.scoreBreakdown?.historicalStrategyUtility ?? 50, bestNextStep: l.blockedReason ? `Unavailable: ${l.blockedReason}` : `Run: ${l.title}`,
    },
  }));
}

export function temporalReport(a: OperationAnalysis): TemporalReconstructionReport {
  return { operationId: a.operationId, generatedAt: a.computedAt, snapshots: a.temporal.snapshots, timelineDiffs: a.temporal.diffs };
}

/** The v0.x "operation bundle" shape used by the classic views. */
export function legacyBundle(app: HunterApp, operationId: string) {
  const op = app.store.getOperation(operationId);
  if (!op) return null;
  const a = app.analyzer.get(op.id)!;
  const leads = app.store.getLeads(op.id);
  return {
    operation: op,
    briefing: legacyBriefing(app, a),
    pursuit: app.pursuit.legacyState(op.id),
    clusters: a.graph.clusters,
    bridges: a.graph.bridges,
    scamKitGenomes: a.kits.genomes,
    financialAnalysis: a.financial.legacy,
    crossOpSimilarities: a.crossOps,
    contradictionReports: a.contradictions,
    temporalSnapshots: a.temporal.snapshots,
    temporalDiffs: a.temporal.diffs,
    operationGenomes: a.kits.operationGenomes,
    predictiveRankings: predictiveRankings(leads),
    learningOutcomes: app.store.getLearningOutcomes(op.id, 100),
    seeds: app.store.getSeeds(op.id),
    entities: app.store.getEntities(op.id),
    relationships: app.store.getRelationships(op.id),
    evidence: app.store.getEvidence(op.id),
    hypotheses: app.store.getHypotheses(op.id),
    leads,
    fingerprints: app.store.getFingerprints(op.id),
    reappearanceLeads: app.store.getReappearanceLeads(op.id),
    monitoringProbes: app.store.getMonitors(op.id),
    strategyStats: app.strategy.legacyStats(),
    auditLogs: app.store.getAuditLogs(op.id, 300),
  };
}

export function legacyTrace(app: HunterApp, operationId: string, itemId: string) {
  const data = loadOpData(app.store, operationId);
  if (!data) return null;
  return traceability(data, app.store.getHypotheses(operationId), itemId);
}

export function describeOperationForAi(app: HunterApp, a: OperationAnalysis) {
  const op = app.store.getOperation(a.operationId)!;
  return [
    `Operation ${op.code} — ${op.name}${op.isDemo ? ' (DEMO, synthetic data)' : ''}`,
    `Headline: ${a.brief.headline}`,
    `Narrative: ${a.brief.narrative}`,
    `Top findings:\n${a.brief.top.map(f => `- ${f.title}: ${f.whatFound} (confidence ${Math.round(f.confidence * 100)}%)`).join('\n')}`,
    `Hypotheses:\n${a.hypotheses.map(h => `- ${h.title}: ${Math.round(h.confidenceScore * 100)}% ${h.status}`).join('\n')}`,
    `Gaps: ${listPhrase(a.gaps.map(g => g.title), 6)}`,
    `Domains: ${listPhrase(a.infrastructure.domains.filter(d => d.role === 'core').map(d => `${d.value} [${d.status}]`), 20)}`,
    `Money: ${a.financial.hasData ? `${a.financial.stolen.transfers} victim transfers; exits: ${listPhrase(a.financial.exits.map(e => `${e.label} (${e.kind})`), 5)}` : 'not traced'}`,
  ].join('\n\n');
}
