import type { HunterApp } from '../app.js';
import { listPhrase, isoDay } from '../core/util.js';
import { HUNTER_VERSION } from '../app.js';

/** Markdown dossier: the operation as a shareable, evidence-referenced document. */
export function buildReport(app: HunterApp, operationId: string): { markdown: string; json: any } | null {
  const op = app.store.getOperation(operationId);
  const a = app.analyzer.get(operationId);
  if (!op || !a) return null;
  const evidence = app.store.getEvidence(operationId);
  const valid = evidence.filter(e => e.status === 'valid');
  const cite = (ids: string[]) => (ids.length ? ` [${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}]` : '');
  const L: string[] = [];
  L.push(`# ${op.name} (${op.code})`);
  L.push('');
  if (op.isDemo) L.push('> **DEMO — synthetic data. Nothing in this report describes real infrastructure or people.**\n');
  L.push(`Generated ${new Date().toISOString()} by Operation Hunter ${HUNTER_VERSION}. Seed: \`${op.initialSeed}\`. Evidence records: ${valid.length} valid, ${evidence.length - valid.length} invalidated/quarantined.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(`**${a.brief.headline}**`);
  L.push('');
  L.push(a.brief.narrative);
  L.push('');
  L.push(`Confidence: ${a.brief.confidence.percentage}% — ${a.brief.confidence.assessment} Reconstruction depth: ${a.brief.depth.score}/100 (${a.brief.depth.dimensions.map(d => `${d.label.toLowerCase()} ${d.score}`).join(', ')}).`);
  L.push('');
  L.push('> Scope and limits: every statement below is either an observed fact (cited evidence IDs) or an inference labelled as such. Shared infrastructure, kit code or transactions are never presented as proof of common ownership.');
  L.push('');
  L.push('## Key findings');
  for (const f of a.brief.top) {
    L.push('');
    L.push(`### ${f.title}`);
    L.push(`- **Observed:** ${f.whatFound}${cite(f.evidenceIds)}`);
    L.push(`- **Why it matters:** ${f.whyItMatters}`);
    L.push(`- **Interpretation:** ${f.whatItMeans}`);
    L.push(`- **Uncertainty:** ${f.uncertainty}`);
    L.push(`- **Does not prove:** ${f.doesNotProve}`);
  }
  L.push('');
  L.push('## Infrastructure');
  L.push('');
  L.push('| Domain | Role | Status | Registered | Registrar | Nameservers | IPs |');
  L.push('|---|---|---|---|---|---|---|');
  for (const d of a.infrastructure.domains.slice(0, 80)) L.push(`| ${d.value}${d.isSeed ? ' (seed)' : ''} | ${d.role} | ${d.status} | ${isoDay(d.registeredAt) || '—'} | ${d.registrar ?? '—'} | ${d.nameservers.join(', ') || '—'} | ${d.ips.join(', ') || '—'} |`);
  if (a.infrastructure.hosting.length) {
    L.push('');
    L.push('Hosting: ' + a.infrastructure.hosting.slice(0, 12).map(h => `${h.ip} (${h.asn ?? '?'} ${h.holder ?? ''}${h.country ? `, ${h.country}` : ''}${h.commodity ? ', commodity' : ''}) → ${h.domains.length} domain(s)`).join('; '));
  }
  L.push('');
  L.push('## Kit / template intelligence');
  L.push('');
  for (const f of a.kits.families) L.push(`- **${f.name}**: ${f.domains.length} site(s); versions ${f.variants.map(v => v.label).join(' → ')}; capabilities: ${listPhrase(f.capabilities, 6) || 'unknown'}${f.otherOperations.length ? `; also in ${listPhrase(f.otherOperations)}` : ''}.`);
  if (a.kits.operatorIndicators.length) L.push(`- Operator-level indicators: ${a.kits.operatorIndicators.map(o => `${o.value} (${o.type})`).join(', ')}.`);
  if (a.kits.vendorIndicators.length) L.push(`- Kit/vendor-level indicators: ${a.kits.vendorIndicators.map(v => v.value).join(', ')}.`);
  L.push(`- Classification tier: **${a.kits.tier.tier}** — ${a.kits.tier.levelDescription}`);
  L.push('');
  L.push('## Money');
  L.push('');
  if (a.financial.hasData) {
    L.push(`Victim inflows: ${a.financial.stolen.transfers} transfers from ${a.financial.stolen.victims} addresses (${Object.entries(a.financial.stolen.bySymbol).map(([s, v]) => `${v} ${s}`).join(', ')}${a.financial.stolen.usd ? `, ≈$${a.financial.stolen.usd.toLocaleString()}` : ''}).`);
    L.push('');
    L.push('| Address | Role | Networks | In | Out | Reason |');
    L.push('|---|---|---|---|---|---|');
    for (const w of a.financial.wallets.filter(w => w.role !== 'VICTIM').slice(0, 40)) L.push(`| ${w.address} | ${w.role} | ${w.network.join(', ')} | ${Object.entries(w.inbound).map(([s, v]) => `${v} ${s}`).join(', ') || '—'} | ${Object.entries(w.outbound).map(([s, v]) => `${v} ${s}`).join(', ') || '—'} | ${w.roleReason} |`);
    L.push('');
    L.push(`Exits: ${a.financial.exits.map(x => `${x.label} (${x.kind})`).join('; ') || 'none traced'}. ${a.financial.sweepTiming.description}`);
    L.push('');
    L.push(`> ${a.financial.legacy.ownershipDisclaimer}`);
  } else L.push('No transfers traced yet.');
  L.push('');
  L.push('## Timeline');
  L.push('');
  for (const e of a.temporal.events.slice().reverse().slice(0, 60)) L.push(`- ${e.at.slice(0, 16).replace('T', ' ')} — **${e.title}**: ${e.detail}${cite(e.evidenceIds)}`);
  L.push('');
  L.push('## Hypotheses (competing explanations)');
  L.push('');
  for (const h of a.hypotheses.slice().sort((x, y) => y.confidenceScore - x.confidenceScore)) {
    L.push(`- **${h.title}** — ${Math.round(h.confidenceScore * 100)}% (${h.status}). For: ${listPhrase(h.supportingObservations, 3) || '—'}. Against: ${listPhrase(h.contradictingObservations, 2) || 'nothing yet'}.`);
  }
  L.push('');
  L.push('## Evidence gaps');
  L.push('');
  for (const g of a.gaps) L.push(`- ${g.title}: ${g.detail}`);
  if (a.crossOps.length) {
    L.push('');
    L.push('## Related operations');
    L.push('');
    for (const c of a.crossOps.slice(0, 5)) L.push(`- ${c.operationBName} (${c.operationBCode}) — ${c.analyticalDistinction} (${c.overallSimilarityScore}%): ${c.reasoning}`);
  }
  L.push('');
  L.push('## Evidence appendix');
  L.push('');
  L.push('| ID | Observed at | Source | Assertion | Observation | SHA-256 |');
  L.push('|---|---|---|---|---|---|');
  for (const e of valid.slice(0, 400)) L.push(`| ${e.id} | ${e.timestamp.slice(0, 19)} | ${e.source} | ${e.assertion ?? 'observed'}${e.synthetic ? ' (synthetic)' : ''} | ${e.originalObservation.replace(/\|/g, '/').slice(0, 220)} | \`${e.sha256Hash.slice(0, 16)}…\` |`);
  const markdown = L.join('\n');
  return {
    markdown,
    json: { operation: op, brief: a.brief, findings: a.findings, hypotheses: a.hypotheses, gaps: a.gaps, infrastructure: a.infrastructure, kits: a.kits, financial: { ...a.financial, legacy: undefined }, temporal: a.temporal, crossOps: a.crossOps, evidence: valid, generatedAt: new Date().toISOString(), version: HUNTER_VERSION },
  };
}
