import type { Finding, FindingAction, FindingKind, ReconstructionDepth, ChangeRecord } from '../core/model.js';
import type { Hypothesis, ReappearanceLead } from '../types.js';
import type { OpData } from './data.js';
import type { GraphAnalysis } from './graph.js';
import type { InfraAnalysis } from './infrastructure.js';
import type { KitAnalysis } from './kits.js';
import type { FinancialAnalysisV1 } from './financial.js';
import type { TemporalAnalysis } from './temporal.js';
import type { CrossOpLink } from './crossop.js';
import type { Gap } from './gaps.js';
import { formatDuration } from './financial.js';
import { evidenceIdsFor } from './data.js';
import { listPhrase, plural, round, uniq, isoDay, clamp } from '../core/util.js';

export type Draft = Omit<Finding, 'id' | 'operationId' | 'status' | 'firstSeenAt' | 'updatedAt'>;

export interface Brief {
  headline: string;
  narrative: string;
  top: Finding[];
  depth: ReconstructionDepth;
  confidence: { percentage: number; assessment: string };
  changesSinceLastView: { count: number; items: ChangeRecord[]; since: string | null };
  nextStep: string;
  counts: Record<string, number>;
}

const money = (by: Record<string, number>) => Object.entries(by).map(([s, v]) => `${v >= 1000 ? Math.round(v).toLocaleString() : round(v, 3)} ${s}`).join(' + ');

export function draftFindings(data: OpData, graph: GraphAnalysis, infra: InfraAnalysis, kits: KitAnalysis, fin: FinancialAnalysisV1, temporal: TemporalAnalysis, cross: CrossOpLink[], hypotheses: Hypothesis[], gaps: Gap[], reapps: ReappearanceLead[]): Draft[] {
  const drafts: Draft[] = [];
  const core = new Set(graph.core);
  const coreDomains = infra.domains.filter(d => core.has(d.id));
  const entityIdsFor = (values: string[]) => data.entities.filter(e => values.includes(e.value)).map(e => e.id);
  const relsTouching = (ids: string[]) => data.relationships.filter(r => ids.includes(r.sourceEntityId) || ids.includes(r.targetEntityId));

  // 1. Reappearance alerts
  for (const r of reapps.filter(x => x.status !== 'FALSE_ALARM' && x.overallSimilarityScore >= 50).slice(0, 2)) {
    const strong = r.status === 'CONFIRMED_ROTATION';
    drafts.push({
      key: `reappearance:${r.candidateValue}`, kind: 'reappearance',
      title: strong ? `New site ${r.candidateValue} looks like this operation redeploying` : `${r.candidateValue} partially matches this operation`,
      whatFound: `${r.candidateValue} matches ${plural(r.matchBreakdown.length, 'part')} of this operation's fingerprint (${r.overallSimilarityScore}%): ${listPhrase(r.matchBreakdown.map(b => b.fingerprintType.replace(/_/g, ' ')), 4)}. Detected ${isoDay(r.detectedAt)} via ${r.source ?? 'a check'}.`,
      whyItMatters: strong ? 'Operator-level settings (analytics, support handle or wallets) carried over — the operation is live again on a new domain.' : 'Some operational features match; it may be a new site of this operation or a copycat using the same kit.',
      whatItMeans: strong ? 'The takedowns so far have not stopped them. Acting on the new site early protects the next victims.' : 'Treat it as a lead to verify, not as part of the operation yet.',
      uncertainty: `${r.reasoning}`,
      doesNotProve: 'A fingerprint match is similarity, not proof of the same operator.',
      nextStep: strong ? `Send ${r.candidateValue} to the Main inbox for a manual check and add it to the operation.` : `Add ${r.candidateValue} as a seed and let Hunter profile it.`,
      action: { type: strong ? 'send_to_inbox' : 'run_pivot', label: strong ? 'Send to Main inbox' : 'Profile this site', params: { value: r.candidateValue, reappearanceId: r.id, addAsSeed: true } },
      confidence: round(r.overallSimilarityScore / 100, 2), importance: strong ? 92 : 70, evidenceIds: [], entityIds: entityIdsFor([r.candidateValue]), view: 'monitoring',
    });
  }

  // 2. Operator-level indicators (grouped by identical site sets)
  const opInds = kits.indicators.filter(i => i.level === 'operator' && i.domains.length >= 2 && i.type !== 'wallet' && i.type !== 'contract');
  const groups = new Map<string, typeof opInds>();
  for (const i of opInds) { const k = i.domains.slice().sort().join('|'); groups.set(k, [...(groups.get(k) ?? []), i]); }
  for (const [k, list] of [...groups.entries()].sort((a, b) => b[1][0].domains.length - a[1][0].domains.length).slice(0, 2)) {
    const domains = list[0].domains;
    const waves = uniq(domains.map(d => infra.waves.find(w => w.domains.includes(d))?.index).filter(Boolean) as number[]);
    const ids = list.map(i => i.id);
    drafts.push({
      key: `operator:${k}`, kind: 'operator_indicator',
      title: `Same ${listPhrase(uniq(list.map(i => i.kind)), 2)} on ${plural(domains.length, 'site')}`,
      whatFound: `${listPhrase(list.map(i => `${i.kind} ${i.value}`), 3)} appear${list.length === 1 ? 's' : ''} on ${listPhrase(domains, 4)}${waves.length > 1 ? `, spanning ${waves.length} deployment waves` : ''}.`,
      whyItMatters: 'Identifiers like analytics accounts and support handles are configured by whoever deploys the site, so reuse across sites is one of the strongest links between them.',
      whatItMeans: `These ${domains.length} sites are very likely run by the same people${waves.length > 1 ? ', who kept operating after earlier sites went down' : ''}.`,
      uncertainty: list.some(i => i.otherOperations.length) ? 'One of these identifiers also appears in another operation, so it might be a kit default.' : 'None of these identifiers appear in any other operation Hunter knows, which makes a kit default unlikely.',
      doesNotProve: 'It does not identify the person behind the account.',
      nextStep: 'Trace the wallets these sites display to see where victims’ funds go.',
      action: { type: 'open_view', label: 'See operator indicators', params: { view: 'kits' } },
      confidence: 0.9, importance: 74 + Math.min(12, domains.length * 2) + (waves.length > 1 ? 4 : 0), evidenceIds: evidenceIdsFor(relsTouching(ids), 8), entityIds: [...ids, ...entityIdsFor(domains)], view: 'kits',
    });
  }

  // 3. Money: collection -> exits
  if (fin.hasData && (fin.stolen.transfers > 0 || fin.exits.length)) {
    const collection = fin.wallets.filter(w => w.role === 'COLLECTION' || w.role === 'SPLITTER');
    const deposit = fin.exits.find(x => x.kind === 'exchange deposit');
    const mixer = fin.exits.find(x => x.kind === 'mixer');
    const fee = fin.splits.flatMap(s => s.recipients).find(r => r.role === 'FEE_RECIPIENT');
    const flowIds = uniq(fin.flows.flatMap(f => f.evidenceIds)).slice(0, 10);
    if (fin.stolen.transfers) drafts.push({
      key: 'money:collection', kind: 'money_flow',
      title: `${fin.stolen.usd ? `≈$${fin.stolen.usd.toLocaleString()}` : money(fin.stolen.bySymbol)} collected from ${plural(fin.stolen.victims, 'victim address', 'victim addresses')}`,
      whatFound: `${plural(fin.stolen.transfers, 'transfer')} (${money(fin.stolen.bySymbol)}) went into ${plural(collection.length, 'collection address', 'collection addresses')}${fin.splits.length ? `, which automatically split each payment (${fin.splits[0].recipients.map(r => `${Math.round(r.share * 100)}% to ${r.role.toLowerCase().replace('_', ' ')}`).join(', ')})` : ''}. ${fin.sweepTiming.description}`,
      whyItMatters: 'This is the operation’s income. Following it shows who benefits and where it can be intercepted.',
      whatItMeans: fee ? `The operator keeps the main share; a fixed cut goes to a separate fee wallet — the business model of a rented "drainer-as-a-service" kit.` : 'Funds are pooled before being moved on.',
      uncertainty: 'Victim totals only include transfers Hunter has traced so far; more history may exist beyond the latest pages of explorer data.',
      doesNotProve: 'Receiving funds does not prove who owns an address.',
      nextStep: deposit ? `Look at the exchange deposit ${deposit.address.slice(0, 12)}… — the exchange can identify that account.` : 'Keep tracing the treasury to find where money leaves the operation.',
      action: { type: 'open_view', label: 'Follow the money', params: { view: 'money' } },
      confidence: 0.95, importance: 76, evidenceIds: flowIds, entityIds: collection.map(c => c.id), view: 'money',
    });
    if (deposit || mixer) {
      const main = deposit ?? mixer!;
      drafts.push({
        key: `money:exit:${main.address}`, kind: 'cash_out',
        title: deposit ? `Stolen funds cashed out through an exchange deposit address` : `Stolen funds sent into ${mixer!.label}`,
        whatFound: `${money(main.bySymbol)} moved from ${plural(main.via.length, 'operation wallet')} to ${main.label}${deposit && mixer ? `; separately ${money(mixer.bySymbol)} went to ${mixer.label}` : ''}.`,
        whyItMatters: deposit ? 'Exchange deposit addresses are assigned to one customer account. The exchange holds identity records for it.' : 'Mixers break the on-chain trail; what went in is effectively where tracing stops.',
        whatItMeans: deposit ? 'This is the single most actionable point in the operation for a report or law-enforcement request.' : 'Follow any funds that did not go to the mixer — those are still traceable.',
        uncertainty: deposit ? 'The deposit role is inferred from the pattern (it forwards straight to a labelled exchange hot wallet). Labels come from public explorer tags.' : 'Mixer label from a public tag.',
        doesNotProve: 'It does not show that the exchange account holder is the scam operator — accounts can be rented or belong to money mules.',
        nextStep: deposit ? 'Include this deposit address and the transaction hashes in your report (Form Submitter via Main).' : 'Trace the treasury’s other outflows.',
        action: { type: 'open_view', label: 'See the cash-out path', params: { view: 'money', focus: main.address } },
        confidence: deposit ? 0.85 : 0.9, importance: deposit ? 86 : 64, evidenceIds: fin.flows.filter(f => f.to === main.address).flatMap(f => f.evidenceIds).slice(0, 6), entityIds: entityIdsFor([main.address]), view: 'money',
      });
    }
    const multiDeploy = fin.deployers.find(d => d.contracts.length >= 2);
    if (multiDeploy) drafts.push({
      key: `deployer:${multiDeploy.deployer}`, kind: 'deployer',
      title: `One deployer created ${plural(multiDeploy.contracts.length, 'collection contract')}`,
      whatFound: `${multiDeploy.deployer} deployed ${listPhrase(multiDeploy.contracts.map(c => `${c.slice(0, 10)}…`), 3)}, each of which received victim funds in a different period.`,
      whyItMatters: 'Whoever deploys the contracts controls the deployer key — this links the waves at the operator level, not just the kit.',
      whatItMeans: 'The switch to a new contract was a rotation by the same operator.',
      uncertainty: 'Deployment data comes from explorer records (blockchain fact).',
      doesNotProve: 'It does not reveal who holds the deployer key.',
      nextStep: 'Trace the deployer’s funding source — who paid its gas fees?',
      action: { type: 'run_pivot', label: 'Trace the deployer', params: { pivotType: 'WALLET_TRACE', value: multiDeploy.deployer } },
      confidence: 0.95, importance: 70, evidenceIds: evidenceIdsFor(data.relationships.filter(r => r.type === 'CREATED_BY'), 6), entityIds: entityIdsFor([multiDeploy.deployer, ...multiDeploy.contracts]), view: 'money',
    });
  }

  // 4. Rotation
  if (infra.rotations.length) {
    const r0 = infra.rotations[0];
    const chain = infra.rotations.map(r => `${r.to} (+${r.gapDays}d)`);
    drafts.push({
      key: `rotation:${r0.from}`, kind: 'rotation',
      title: `After ${r0.from} went dark, the same setup reappeared on new domains`,
      whatFound: `${r0.from} stopped serving; ${listPhrase(chain, 3)} came up with the same ${listPhrase(uniq(infra.rotations.flatMap(r => r.sharedFeatures.map(f => f.split(' ')[0]))), 3)}.`,
      whyItMatters: 'Operators rotate domains after takedowns. Seeing the pattern lets you predict — and catch — the next one.',
      whatItMeans: 'Takedowns of single domains have not disrupted the operation; its infrastructure and settings survive between waves.',
      uncertainty: 'Rotation is inferred from timing and shared features.',
      doesNotProve: 'Timing alone would not prove a rotation; it is the shared operator settings that support it.',
      nextStep: infra.standby.length ? `Watch the reserve domains (${listPhrase(infra.standby, 2)}) — they are the likely next wave.` : 'Keep monitors running on the shared nameservers and kit fingerprint.',
      action: { type: 'add_monitor', label: 'Watch for the next wave', params: { kind: 'rotation' } },
      confidence: 0.8, importance: 66, evidenceIds: infra.rotations.flatMap(r => r.evidenceIds).slice(0, 8), entityIds: entityIdsFor(infra.rotations.flatMap(r => [r.from, r.to])), view: 'timeline',
    });
  }
  const reserve = [...infra.standby, ...infra.possibleReserve];
  if (reserve.length) drafts.push({
    key: `standby:${reserve.slice().sort().join(',')}`, kind: 'standby_domains',
    title: `${plural(reserve.length, 'reserve domain')} registered but not live yet`,
    whatFound: `${infra.standby.length ? `${listPhrase(infra.standby, 4)} ${infra.standby.length === 1 ? 'is' : 'are'} tied to this operation (certificates or identifiers)` : ''}${infra.standby.length && infra.possibleReserve.length ? '; ' : ''}${infra.possibleReserve.length ? `${listPhrase(infra.possibleReserve, 3)} ${infra.possibleReserve.length === 1 ? 'shares' : 'share'} only the operation's private nameservers (possible reserve)` : ''} — none of them serve a site yet.`,
    whyItMatters: 'Reserve domains are what the operator switches to after a takedown.',
    whatItMeans: 'You can prepare reports or blocklists before victims ever see these sites.',
    uncertainty: 'A domain may stay unused forever; monitoring confirms when it goes live.',
    doesNotProve: 'Registration alone is not abuse — do not report a domain before it serves scam content.',
    nextStep: 'Enable monitors so Hunter alerts you the moment one goes live.',
    action: { type: 'add_monitor', label: 'Monitor reserve domains', params: { values: reserve } },
    confidence: infra.standby.length ? 0.75 : 0.5, importance: 60, evidenceIds: [], entityIds: entityIdsFor(reserve), view: 'infrastructure',
  });

  // 5. Shared certificate
  const multiCert = infra.certificates.find(c => uniq(c.domainsInOperation.map(d => d.split('.').slice(-2).join('.'))).length >= 2);
  if (multiCert) drafts.push({
    key: `cert:${multiCert.id}`, kind: 'shared_certificate',
    title: `One certificate covers ${plural(multiCert.domainsInOperation.length, 'different domain')}`,
    whatFound: `${multiCert.label} lists ${listPhrase(multiCert.domainsInOperation, 4)} together (issued ${isoDay(multiCert.notBefore)}).`,
    whyItMatters: 'Only someone who controls all these domains can obtain one certificate for them.',
    whatItMeans: 'These domains were administered together at that time.',
    uncertainty: 'Some hosting panels bundle customer domains, but that is rare for unrelated owners.',
    doesNotProve: 'It shows shared administration of the domains, not who the administrator is.',
    nextStep: 'Check the other names on the certificate — some may not be live yet.',
    action: { type: 'open_view', label: 'Open certificates', params: { view: 'infrastructure' } },
    confidence: 0.85, importance: 57, evidenceIds: evidenceIdsFor(relsTouching([multiCert.id]), 4), entityIds: [multiCert.id, ...entityIdsFor(multiCert.domainsInOperation)], view: 'infrastructure',
  });

  // 6. Kit family
  for (const f of kits.families.slice(0, 1)) {
    const variants = f.variants.length > 1 ? ` in ${f.variants.length} versions (${listPhrase(f.variants.map(v => v.label), 3)})` : '';
    const added = f.variants.flatMap(v => v.addedCapabilities);
    drafts.push({
      key: `kit:${f.name}`, kind: 'kit_family',
      title: f.otherOperations.length ? `${f.name} is shared with ${listPhrase(f.otherOperations)}` : `Sites run the ${f.name} drainer kit`,
      whatFound: `${plural(f.domains.length, 'site')} run ${f.name}${variants}. It ${f.capabilities.length ? `asks wallets for: ${listPhrase(f.capabilities.slice(0, 3), 3)}` : 'was fingerprinted by page structure'}.${added.length ? ` Newest version adds: ${listPhrase(added, 2)}.` : ''}`,
      whyItMatters: 'The kit tells you how victims lose funds and gives a fingerprint to find sibling sites.',
      whatItMeans: f.otherOperations.length ? 'The same kit is used by other groups — treat kit similarity as shared tooling, not the same operator.' : 'So far the kit has only been seen in this operation.',
      uncertainty: f.variants.some(v => v.similarityToPrevious !== null) ? `Variant similarity: ${f.variants.filter(v => v.similarityToPrevious !== null).map(v => `${Math.round((v.similarityToPrevious ?? 0) * 100)}%`).join(', ')}.` : 'Family naming depends on the source that classified it.',
      doesNotProve: kits.attributionBoundary,
      nextStep: 'Search for other sites loading the same kit files.',
      action: { type: 'open_view', label: 'Open kit analysis', params: { view: 'kits' } },
      confidence: 0.8, importance: f.otherOperations.length ? 58 : 50, evidenceIds: evidenceIdsFor(relsTouching(f.templateIds), 6), entityIds: f.templateIds, view: 'kits',
    });
  }

  // 7. Cross operation
  for (const c of cross.filter(x => x.overallSimilarityScore >= 30).slice(0, 1)) {
    const opLevel = c.analyticalDistinction === 'COMMON_OPERATOR_HIGH_CONFIDENCE';
    drafts.push({
      key: `cross:${c.operationBId}`, kind: 'cross_operation',
      title: opLevel ? `Operator-level overlap with ${c.operationBCode}` : c.analyticalDistinction === 'SHARED_COMMERCIAL_KIT' ? `Same kit as ${c.operationBCode}, but a different operator` : `Weak overlap with ${c.operationBCode}`,
      whatFound: `Shared with ${c.operationBName}: ${listPhrase(c.shared.filter(s => s.level !== 'context').map(s => s.label), 4) || 'only commodity infrastructure'}.`,
      whyItMatters: 'Comparing operations separates the kit seller from the people using it, and shows when one group runs several campaigns.',
      whatItMeans: c.reasoning,
      uncertainty: `Similarity ${c.overallSimilarityScore}% (weighted by how meaningful each shared item is).`,
      doesNotProve: c.whatItDoesNotProve,
      nextStep: opLevel ? `Review ${c.operationBCode} for the shared indicators and consider merging the investigations.` : 'Keep them separate; watch the shared vendor wallet for new customers.',
      action: { type: 'open_view', label: 'Compare operations', params: { view: 'crossops', operationId: c.operationBId } },
      confidence: opLevel ? 0.75 : 0.7, importance: opLevel ? 78 : 52, evidenceIds: [], entityIds: [], view: 'crossops',
    });
  }

  // 8. False positives / contradictions worth knowing
  for (const h of hypotheses.filter(x => x.category === 'FALSE_POSITIVE' && x.confidenceScore >= 0.6).slice(0, 1)) {
    const domain = h.title.split(' ')[0];
    drafts.push({
      key: `fp:${domain}`, kind: 'contradiction',
      title: `${domain} is probably not part of this operation`,
      whatFound: h.description,
      whyItMatters: 'Shared hosting pulls unrelated sites into a graph. Keeping them out avoids false accusations and wasted effort.',
      whatItMeans: `Hunter keeps ${domain} as context only and does not expand from it.`,
      uncertainty: `${Math.round(h.confidenceScore * 100)}% confident it is unrelated. ${h.conditionsToWeaken[0] ?? ''}`,
      doesNotProve: 'Being unrelated to this operation says nothing about whether the site is legitimate.',
      nextStep: 'No action needed unless new evidence links it.',
      action: { type: 'mark_reviewed', label: 'Got it' },
      confidence: h.confidenceScore, importance: 42, evidenceIds: h.supportingEvidenceIds, entityIds: entityIdsFor([domain]), view: 'hypotheses',
    });
  }
  const contradicted = hypotheses.filter(x => x.category !== 'FALSE_POSITIVE' && x.contradictingObservations.length && x.confidenceScore >= 0.3 && x.confidenceScore <= 0.7).slice(0, 1);
  for (const h of contradicted) drafts.push({
    key: `contra:${h.id}`, kind: 'contradiction', title: `Open question: ${h.title.toLowerCase()}?`,
    whatFound: `Supporting: ${listPhrase(h.supportingObservations, 2) || 'little'}. Against: ${listPhrase(h.contradictingObservations, 2)}.`,
    whyItMatters: 'Hunter keeps competing explanations open until evidence decides between them.',
    whatItMeans: `Currently ${Math.round(h.confidenceScore * 100)}% — undecided.`, uncertainty: h.conditionsToStrengthen[0] ?? '', doesNotProve: 'An undecided hypothesis should not appear as a conclusion in a report.',
    nextStep: h.conditionsToStrengthen[0] ? `Look for: ${h.conditionsToStrengthen[0].toLowerCase()}.` : 'Collect more evidence.',
    action: { type: 'open_view', label: 'Open hypotheses', params: { view: 'hypotheses' } }, confidence: h.confidenceScore, importance: 40, evidenceIds: [...h.supportingEvidenceIds, ...h.contradictingEvidenceIds].slice(0, 6), entityIds: [], view: 'hypotheses',
  });

  // 9. Critical gaps
  for (const g of gaps.filter(x => x.impact >= 70).slice(0, 2)) {
    const pivotAction: FindingAction | undefined = g.suggestedPivot ? { type: g.suggestedPivot.pivotType === 'SITE_CHECK_REQUEST' ? 'request_site_check' : 'run_pivot', label: g.suggestedPivot.label, params: { pivotType: g.suggestedPivot.pivotType, entityId: g.suggestedPivot.entityId } } : g.key.startsWith('seed:') ? { type: 'start_pursuit', label: 'Start pursuit' } : undefined;
    drafts.push({
      key: `gap:${g.key}`, kind: 'critical_gap', title: g.title, whatFound: g.detail,
      whyItMatters: 'Closing this gap would change what Hunter can conclude.',
      whatItMeans: 'The reconstruction is incomplete here.', uncertainty: 'Until it is closed, conclusions that depend on it stay provisional.', doesNotProve: 'A gap is missing evidence, not evidence of absence.',
      nextStep: g.suggestedPivot?.label ?? 'Run a pursuit.', action: pivotAction, confidence: 1, importance: Math.round(g.impact * 0.72), evidenceIds: [], entityIds: g.entityIds, view: 'gaps',
    });
  }

  // 10. Hosting cluster (only if nothing stronger ties the sites)
  const host = graph.clusters.find(c => c.category === 'HOSTING_INFRASTRUCTURE');
  if (host && !opInds.length) drafts.push({
    key: `hosting:${host.id}`, kind: 'infrastructure_cluster', title: host.name, whatFound: host.description,
    whyItMatters: 'Shared servers and nameservers are how Hunter found related sites.', whatItMeans: 'These sites share infrastructure; that is a starting point, not a conclusion.',
    uncertainty: 'Hosting can be shared by unrelated customers.', doesNotProve: 'Shared hosting does not prove shared operators.', nextStep: 'Look for operator-level links (analytics IDs, wallets) on these sites.',
    action: { type: 'open_view', label: 'Open infrastructure', params: { view: 'infrastructure' } }, confidence: host.confidence, importance: 48, evidenceIds: evidenceIdsFor(relsTouching(host.entityIds), 5), entityIds: host.entityIds, view: 'infrastructure',
  });
  const burst = infra.waves.find(w => w.domains.length >= 3);
  if (burst) drafts.push({
    key: `wave:${burst.start.slice(0, 10)}`, kind: 'registration_burst', title: `${plural(burst.domains.length, 'domain')} registered within ${Math.max(1, Math.round((Date.parse(burst.end) - Date.parse(burst.start)) / 86400000) + 1)} days`,
    whatFound: `${listPhrase(burst.domains, 4)} were registered ${isoDay(burst.start)}${burst.end !== burst.start ? `–${isoDay(burst.end)}` : ''} via ${listPhrase(burst.registrars, 2) || 'unknown registrars'}.`,
    whyItMatters: 'Bulk registrations mark a deployment wave.', whatItMeans: 'These domains were likely prepared together.', uncertainty: 'Registration timing alone is weak evidence.', doesNotProve: 'Many unrelated domains are registered every day.',
    nextStep: 'Check which of them are live.', action: { type: 'open_view', label: 'Open timeline', params: { view: 'timeline' } }, confidence: 0.6, importance: 38, evidenceIds: [], entityIds: entityIdsFor(burst.domains), view: 'timeline',
  });
  if (infra.naming && infra.naming.coverage >= 0.6 && coreDomains.length >= 3) drafts.push({
    key: `naming:${infra.naming.pattern}`, kind: 'naming_pattern', title: `Domain names follow a pattern: ${infra.naming.pattern}`,
    whatFound: `${Math.round(infra.naming.coverage * 100)}% of the core domains use the words ${listPhrase(infra.naming.keywords.slice(0, 5), 5)} (${listPhrase(infra.naming.tlds, 4)}).`,
    whyItMatters: 'Naming habits help recognise new domains from the same operator in certificate logs and Site Finder results.', whatItMeans: 'Hunter uses this pattern when checking new candidates.',
    uncertainty: 'Scam naming is repetitive across many groups — this is a weak signal on its own.', doesNotProve: 'A similar name alone links nothing.', nextStep: 'Nothing required; it is part of the reappearance fingerprint.',
    confidence: 0.5, importance: 30, evidenceIds: [], entityIds: [], view: 'infrastructure',
  });
  void temporal;
  return drafts;
}

export function reconstructionDepth(data: OpData, graph: GraphAnalysis, infra: InfraAnalysis, kits: KitAnalysis, fin: FinancialAnalysisV1): ReconstructionDepth {
  const core = new Set(graph.core);
  const coreDomains = infra.domains.filter(d => core.has(d.id) && !d.isResourceHost);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const infraScore = pct(coreDomains.filter(d => d.nameservers.length || d.ips.length).length, coreDomains.length);
  const kitScore = pct(coreDomains.filter(d => d.templates.length).length, coreDomains.filter(d => d.status === 'active' || d.isSeed || d.templates.length).length || coreDomains.length);
  const moneyScore = !fin.hasData ? 0 : fin.exits.length ? 100 : fin.wallets.some(w => w.role === 'TREASURY') ? 65 : 35;
  const timeScore = pct(coreDomains.filter(d => d.registeredAt).length, coreDomains.length);
  const operatorScore = Math.min(100, kits.operatorIndicators.length * 30 + fin.deployers.filter(d => d.contracts.length > 1).length * 30);
  const supported = data.relationships.filter(r => r.state === 'SUPPORTED' || (r.sources?.length ?? 0) >= 2 || r.assertion === 'blockchain_fact').length;
  const corroboration = pct(supported, data.relationships.length);
  const dims = [
    { key: 'infrastructure', label: 'Infrastructure mapped', score: infraScore, detail: `${coreDomains.length} core domains, ${infra.hosting.filter(h => !h.commodity).length} servers` },
    { key: 'kit', label: 'Kit identified', score: kitScore, detail: kits.families.length ? listPhrase((kits.families.filter(f => f.domains.some(d => coreDomains.some(c => c.value === d))).length ? kits.families.filter(f => f.domains.some(d => coreDomains.some(c => c.value === d))) : kits.families).map(f => f.name), 2) : 'no page fingerprints yet' },
    { key: 'money', label: 'Money traced', score: moneyScore, detail: fin.hasData ? `${fin.wallets.length} addresses, ${fin.exits.length} exits` : 'no transfers traced' },
    { key: 'timeline', label: 'Timeline dated', score: timeScore, detail: `${infra.waves.length} deployment wave(s)` },
    { key: 'operator', label: 'Operator links', score: operatorScore, detail: `${kits.operatorIndicators.length} operator-level indicators` },
    { key: 'corroboration', label: 'Corroboration', score: corroboration, detail: `${supported}/${data.relationships.length} links multi-source or on-chain` },
  ];
  const score = Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length);
  return { score, dimensions: dims };
}

export function composeBrief(data: OpData, findings: Finding[], depth: ReconstructionDepth, infra: InfraAnalysis, fin: FinancialAnalysisV1, kits: KitAnalysis, hypotheses: Hypothesis[], changes: ChangeRecord[]): Brief {
  const active = findings.filter(f => f.status !== 'dismissed');
  const top: Finding[] = [];
  const kindsUsed = new Map<FindingKind, number>();
  for (const f of active.sort((a, b) => b.importance - a.importance)) {
    const n = kindsUsed.get(f.kind) ?? 0;
    if (n >= (f.kind === 'reappearance' ? 2 : 1)) continue;
    top.push(f);
    kindsUsed.set(f.kind, n + 1);
    if (top.length >= 5) break;
  }
  const coreDomains = infra.domains.filter(d => d.role === 'core' && !d.isResourceHost);
  const operatorHyp = hypotheses.find(h => h.category === 'COMMON_OPERATOR');
  const headlineParts: string[] = [];
  if (coreDomains.length) headlineParts.push(`${plural(coreDomains.length, 'site')}${infra.waves.length > 1 ? ` across ${infra.waves.length} waves` : ''}${operatorHyp && operatorHyp.confidenceScore >= 0.7 ? ' linked to one operator' : ''}`);
  if (kits.families.length) headlineParts.push(`running ${kits.families[0].name}`);
  if (fin.stolen.transfers) headlineParts.push(`${fin.stolen.usd ? `≈$${fin.stolen.usd.toLocaleString()}` : money(fin.stolen.bySymbol)} collected`);
  const exit = fin.exits[0];
  if (exit) headlineParts.push(`cashed out via ${exit.kind}`);
  const headline = headlineParts.length ? `${capitalize(headlineParts.join(', '))}.` : data.entities.length > 1 ? `${plural(data.entities.length, 'indicator')} collected so far — not enough for a picture of the operation yet.` : 'Nothing investigated yet — start a pursuit from the seed.';

  const sentences: string[] = [];
  if (coreDomains.length) {
    const seed = data.op.initialSeed;
    sentences.push(`Starting from ${seed}, Hunter mapped ${plural(coreDomains.length, 'closely linked site')}${infra.standby.length ? ` (including ${plural(infra.standby.length, 'reserve domain')} not yet live)` : ''}${infra.hosting.filter(h => !h.commodity).length ? ` on ${plural(infra.hosting.filter(h => !h.commodity).length, 'server')}` : ''}.`);
  }
  if (kits.operatorIndicators.length) sentences.push(`They share operator-level settings (${listPhrase(kits.operatorIndicators.map(o => o.value), 3)}), so they are very likely run by the same people.`);
  else if (kits.families.length) sentences.push(`They share kit code (${kits.families[0].name}) but no operator-level link has been confirmed yet.`);
  if (infra.rotations.length) sentences.push(`When sites went dark the operator moved to new domains with the same setup.`);
  if (fin.hasData && fin.stolen.transfers) sentences.push(`Victim funds flow into ${plural(fin.wallets.filter(w => w.role === 'COLLECTION' || w.role === 'SPLITTER').length, 'collection address', 'collection addresses')}${fin.exits.length ? ` and leave through ${listPhrase(fin.exits.map(e => e.kind), 3)}` : ''}.`);
  if (!sentences.length) sentences.push('Hunter has not collected enough evidence to describe the operation yet.');
  const conf = operatorHyp ? Math.round(operatorHyp.confidenceScore * 100) : Math.round((top.reduce((s, f) => s + f.confidence, 0) / Math.max(1, top.length)) * 100);
  const assessment = conf >= 80 ? 'Strong: several independent, evidence-backed links.' : conf >= 55 ? 'Moderate: supported, but key links rest on few sources.' : conf > 0 ? 'Tentative: treat conclusions as leads.' : 'Not enough evidence yet.';
  const since = data.op.lastViewedAt ?? null;
  const newChanges = since ? changes.filter(c => c.at > since) : [];
  return {
    headline, narrative: sentences.join(' '), top, depth, confidence: { percentage: conf, assessment },
    changesSinceLastView: { count: newChanges.length, items: newChanges.slice(0, 8), since },
    nextStep: top[0]?.nextStep ?? 'Start a pursuit from the seed.',
    counts: { domains: coreDomains.length, entities: data.entities.length, evidence: data.evidence.length, wallets: fin.wallets.length, findings: active.length },
  };
}

export function scoreImportance(d: Draft, lastViewedAt: string | null, firstSeenAt: string) {
  let imp = d.importance * (0.6 + 0.4 * clamp(d.confidence));
  if (lastViewedAt && firstSeenAt > lastViewedAt) imp += 8;
  return Math.round(clamp(imp, 0, 100));
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
