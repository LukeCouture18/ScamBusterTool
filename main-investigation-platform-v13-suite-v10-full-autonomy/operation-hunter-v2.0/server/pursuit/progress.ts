import type { Entity, Relationship } from '../types.js';
import type { IngestResult } from '../engine/ingest.js';
import type { FacetChange } from '../core/intelStore.js';
import { isCommodity } from '../engine/noise.js';
import { round } from '../core/util.js';

/**
 * Immediate progress estimate for one lookup. It rewards what moves the
 * reconstruction forward — strongly linked new sites, operator settings,
 * money destinations, verification of uncertain sites, real changes — and
 * gives nothing for volume: a lookup that returns 400 co-hosted domains is
 * noise, not progress. Delayed credit (see credit.ts) later corrects the
 * estimate once the analysis decides what actually belongs to the operation.
 */
const STRONG = new Set(['COVERS', 'CERTIFIED_BY', 'USES_IDENTIFIER', 'REFERENCES_WALLET', 'REDIRECTS_TO', 'CONTROLS_WALLET']);

export interface ProgressInput {
  subject: Entity;
  subjectStatus: string;           // membership status of the subject when the lookup ran
  subjectProbability?: number;     // membership probability of the subject (for value of verification)
  pivotType: string;
  ingest: IngestResult;
  changes: FacetChange[];
  commodity: boolean;
  resultVolume: number;
}

export interface ProgressBreakdown { total: number; parts: Array<{ label: string; value: number }> }

export function proxyProgress(p: ProgressInput): ProgressBreakdown {
  const parts: Array<{ label: string; value: number }> = [];
  const add = (label: string, value: number) => { if (value) parts.push({ label, value: round(value, 2) }); };
  if (p.commodity) return { total: 0, parts: [{ label: 'crowded shared service — not followed', value: 0 }] };
  const trusted = p.subjectStatus === 'member' || p.subject.isSeed;
  const uncertain = p.subjectStatus === 'probable' || p.subjectStatus === 'candidate' || p.subjectStatus === 'unknown';
  const relOf = new Map<string, Relationship>();
  for (const r of p.ingest.newRelationships) {
    relOf.set(r.sourceEntityId === p.subject.id ? r.targetEntityId : r.sourceEntityId, r);
  }
  let domains = 0, ids = 0, wallets = 0, weakDomains = 0;
  if (p.ingest.newRelationships.some(r => r.type === 'CREATED_BY')) add('contract deployer (operator key) identified', trusted ? 4 : 2);
  for (const e of p.ingest.newRelevantEntities) {
    const rel = relOf.get(e.id);
    if (e.type === 'domain') {
      if (e.metadata?.role === 'script/resource host') continue;
      if (rel?.type === 'MATCHES_PATTERN') { weakDomains++; continue; }
      if (rel && STRONG.has(rel.type) && trusted) domains += 4;
      else if (p.subject.type === 'nameserver' && !isCommodity(p.subject.ubiquity)) domains += p.resultVolume <= 60 ? 2.5 : 1;
      else if (p.subject.type === 'artifact' || p.subject.type === 'template') domains += 2.2;
      else if (p.subject.type === 'ip') domains += p.resultVolume <= 5 ? 1.2 : 0.4;
      else if (trusted) domains += 1.5;
      else domains += 0.6;
    } else if (e.type === 'identifier' || e.type === 'email') {
      if (!String(e.value).startsWith('wc:')) ids += trusted ? 3 : uncertain ? 2 : 1;
    } else if (e.type === 'wallet' || e.type === 'contract') {
      if (e.metadata?.labelKind === 'exchange' || e.metadata?.labelKind === 'mixer' || e.metadata?.labelKind === 'bridge') wallets += 3;
      else wallets += trusted ? 1.6 : 0.6;
    } else if (e.type === 'artifact') {
      // file fingerprints matter once, when they can reveal siblings
      add('new file fingerprint', trusted ? 0.8 : 0.3);
    }
  }
  add('new linked sites', Math.min(20, domains));
  add('look-alike candidates to verify', Math.min(2, weakDomains * 0.25));
  add('operator settings', Math.min(9, ids));
  add('money destinations', Math.min(8, wallets));
  // Verifying an uncertain site is progress even when nothing new appears.
  const verification = p.ingest.newEvidence.filter(ev => ['page_fingerprint', 'site_scan', 'rdap_registration', 'dns_a', 'dns_ns'].includes(ev.type)).length;
  if (uncertain && p.subject.type === 'domain' && verification) {
    // Verifying is worth what it can decide: a real contender more than a long shot co-hosted by chance.
    const q = p.subjectProbability ?? 0.25;
    add('verified an uncertain site', Math.min(3, 1.2 * verification) * Math.min(1, 0.15 + 1.4 * q * (1 - q) * 2));
  }
  if (trusted && p.subject.type === 'domain' && p.ingest.newEvidence.some(ev => ev.type === 'page_fingerprint')) add('kit and settings of a member site', 1.5);
  const reg = p.ingest.newEvidence.find(ev => ev.type === 'rdap_registration');
  if (trusted && reg) add('registration timeline of a member site', /hold|suspend|redemption/i.test(JSON.stringify(reg.rawData?.status ?? '')) ? 3.5 : 1.5);
  if (trusted && p.ingest.newEvidence.some(ev => ev.type === 'dns_no_answer')) add('member site went dark', 2.5);
  if (trusted && p.ingest.newEvidence.some(ev => ev.type === 'address_profile')) add('profile of an operation wallet', 1);
  const changeScore = p.changes.filter(c => c.kind !== 'contradiction').reduce((s, c) => s + c.significance * 3, 0);
  add('real-world changes detected', Math.min(8, changeScore));
  add('conflicting sources found', Math.min(2, p.changes.filter(c => c.kind === 'contradiction').length));
  const irrelevant = p.ingest.newEntities.length - p.ingest.newRelevantEntities.length;
  if (p.ingest.newEntities.length > 12) add('noise', -Math.min(3, (p.ingest.newEntities.length - 12) * 0.1));
  void irrelevant;
  const total = round(Math.max(0, parts.reduce((s, x) => s + x.value, 0)), 2);
  return { total, parts };
}

export const COST_UNITS: Record<string, number> = { low: 1, medium: 1.6, high: 3 };
