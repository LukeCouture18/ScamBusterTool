import type { Entity, EntityType } from '../types.js';
import type { CollectorResult, Observation } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult } from './base.js';
import { artifactObservations } from './artifact.js';
import { canonicalize, detectType, extractIndicators, hostnameOf, registrableDomain } from '../core/canonical.js';
import { staticUbiquity } from '../engine/noise.js';

const CONTENT_FIELDS = ['html', 'content', 'source', 'page_source', 'pageSource', 'text', 'body', 'context_text', 'script', 'js'];

/**
 * Offline pivots over what Hunter (and the rest of the suite) already knows.
 * Always available, including in offline mode.
 */
export class InternalCollector implements Collector {
  id = 'internal';
  name = 'Hunter knowledge base';
  kind = 'internal' as const;
  pivotTypes = ['EVIDENCE_MINING', 'TRACKER_REUSE'];
  description = 'Re-reads collected evidence for missed indicators and matches identifiers against every other operation in this Hunter instance.';

  availability(_settings: RuntimeSettings) { return { ok: true }; }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    return pivotType === 'EVIDENCE_MINING' ? this.mine(entity, ctx) : this.trackerReuse(entity, ctx);
  }

  private mine(entity: Entity, ctx: CollectorContext): CollectorResult {
    const evidence = ctx.store.evidenceForEntity(entity.id).filter(e => e.status === 'valid' && e.type !== 'indicator_mining');
    const observations: Observation[] = [];
    for (const ev of evidence) {
      for (const field of CONTENT_FIELDS) {
        const value = ev.rawData?.[field];
        if (typeof value !== 'string' || value.length < 40) continue;
        if (/<[a-z!][\s\S]*>/i.test(value) && value.length > 200) {
          observations.push(...artifactObservations(entity, value, { source: `analysis:${ev.source}`, provenance: `Fingerprint of content in evidence ${ev.id} (${ev.provenance})`, observedAt: ev.timestamp, label: `Content from ${ev.source}` })
            .map(o => ({ ...o, assertion: 'derived' as const, raw: { ...o.raw, derivedFromEvidenceId: ev.id } })));
        } else {
          const obs = indicatorObservation(entity, value, ev.id, ev.source, ev.timestamp);
          if (obs) observations.push(obs);
        }
      }
      // plain observation text too
      const fromText = indicatorObservation(entity, ev.originalObservation, ev.id, ev.source, ev.timestamp, true);
      if (fromText) observations.push(fromText);
    }
    return { observations, resultVolume: observations.length };
  }

  private trackerReuse(entity: Entity, ctx: CollectorContext): CollectorResult {
    const canonical = canonicalize(entity.type, entity.value);
    const hits = ctx.store.operationsWithCanonical(canonical).filter(h => h.operationId !== ctx.operationId);
    const observations: Observation[] = [];
    let volume = 0;
    for (const hit of hits) {
      const other = ctx.store.getOperation(hit.operationId);
      if (!other) continue;
      const rels = ctx.store.getRelationships(hit.operationId).filter(r => (r.targetEntityId === hit.entityId || r.sourceEntityId === hit.entityId) && r.state !== 'CONTRADICTED');
      const otherEntities = new Map(ctx.store.getEntities(hit.operationId).map(e => [e.id, e]));
      for (const rel of rels) {
        const otherId = rel.sourceEntityId === hit.entityId ? rel.targetEntityId : rel.sourceEntityId;
        const site = otherEntities.get(otherId);
        if (!site || site.type !== 'domain') continue;
        volume++;
        const b = new ObservationBuilder({
          kind: 'cross_operation_match', source: 'hunter:cross-operation', observedAt: rel.lastObserved,
          summary: `${entity.value} is also used by ${site.value}, recorded in operation ${other.code} (${rel.reasoning})`,
          raw: { otherOperationId: other.id, otherOperationCode: other.code, relationshipId: rel.id, supportingEvidenceIds: rel.evidenceIds },
          confidence: Math.min(0.85, rel.confidence * 0.9), assertion: 'derived',
          provenance: `Hunter cross-operation index (operation ${other.code}, relationship ${rel.id})`,
        }, entity);
        b.rel(b.entity('domain', site.value, { metadata: { alsoInOperation: other.code } }), 'subject', 'USES_IDENTIFIER', `In operation ${other.code}: ${rel.reasoning}`, Math.min(0.85, rel.confidence * 0.9));
        observations.push(b.build());
        if (observations.length >= 25) break;
      }
    }
    return { observations, resultVolume: volume };
  }
}

function indicatorObservation(entity: Entity, text: string, evidenceId: string, source: string, at: string, fromSummary = false): Observation | null {
  const found = extractIndicators(text).filter(i => {
    if (canonicalize(i.type, i.value) === canonicalize(entity.type, entity.value)) return false;
    if (i.type === 'domain') {
      if (entity.type === 'domain' && registrableDomain(i.value) === registrableDomain(entity.value)) return false;
      if (staticUbiquity('domain', i.value).ubiquity >= 0.9) return false;
    }
    return true;
  });
  if (!found.length) return null;
  // Summaries of relationships already mention both ends; only mine free-form content fully.
  const useful = fromSummary ? found.filter(f => f.type === 'wallet' || f.type === 'identifier' || f.type === 'email') : found;
  if (!useful.length) return null;
  const b = new ObservationBuilder({
    kind: 'indicator_mining', source: `analysis:${source}`, observedAt: at,
    summary: `Evidence ${evidenceId} about ${entity.value} mentions ${useful.slice(0, 5).map(f => f.value).join(', ')}${useful.length > 5 ? ` +${useful.length - 5}` : ''}`,
    raw: { derivedFromEvidenceId: evidenceId, indicators: useful },
    confidence: 0.6, assertion: 'derived', provenance: `Indicator extraction over evidence ${evidenceId}`,
  }, entity);
  for (const ind of useful.slice(0, 25)) {
    const type = ind.type as EntityType;
    const relType = type === 'wallet' ? 'REFERENCES_WALLET' : type === 'domain' ? 'MENTIONS' : 'USES_IDENTIFIER';
    b.rel('subject', b.entity(type, ind.value, { metadata: { discoveredIn: 'evidence text', hint: ind.hint } }), relType, `Evidence ${evidenceId} mentions ${ind.hint} ${ind.value}`, 0.6);
  }
  return b.build();
}

/** Pivots delegated to the Main Investigation Platform (when connected). */
export class MainPlatformCollector implements Collector {
  id = 'main';
  name = 'Main Investigation Platform';
  kind = 'delegated' as const;
  pivotTypes = ['MAIN_LOOKUP', 'SITE_CHECK_REQUEST'];
  description = 'Looks up what Site Finder, Site Investigator, WalletLogger and Wallet Investigator already recorded, and can request a site check through Main’s normal routing.';

  availability(_settings: RuntimeSettings, ctx?: { main?: any }) {
    return ctx?.main?.configured() ? { ok: true } : { ok: false, reason: 'Main Platform connection not configured' };
  }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (!ctx.main?.configured()) return emptyResult('Main Platform not connected');
    if (pivotType === 'SITE_CHECK_REQUEST') {
      const res = await ctx.main.requestSiteCheck(ctx.operationId, hostnameOf(entity.value), 'Operation Hunter needs page content and deposit wallets for this related site');
      return { observations: [], resultVolume: 0, pending: res.accepted, note: res.detail };
    }
    const result = await ctx.main.lookup(entity.value);
    return { observations: mainLookupObservations(entity, result), resultVolume: result.matches.length + result.relations.length };
  }
}

export function mainTypeToHunter(type: string, value: string): { type: EntityType; value: string } | null {
  const t = String(type ?? '').toLowerCase();
  let v = String(value ?? '');
  if (['site', 'related_site', 'page', 'deposit_page', 'domain'].includes(t)) return { type: 'domain', value: hostnameOf(v) };
  if (['wallet', 'counterparty', 'deposit_option'].includes(t)) {
    if (/^[a-z0-9-]+:/.test(v) && !/^0x/.test(v)) v = v.split(':').slice(1).join(':');
    const d = detectType(v);
    return d === 'wallet' ? { type: 'wallet', value: v } : null;
  }
  const d = detectType(v);
  return d ? { type: d, value: v } : null;
}

function mapRelType(rel: string): Observation['relationships'][number]['type'] {
  const r = rel.toLowerCase();
  if (/wallet|deposit|address|pays?_to|receiv/.test(r)) return 'REFERENCES_WALLET';
  if (/redirect/.test(r)) return 'REDIRECTS_TO';
  if (/transfer|fund|sent|flow/.test(r)) return 'FUNDS_TRANSFER';
  if (/resolv|host|ip/.test(r)) return 'RESOLVES_TO';
  if (/template|kit/.test(r)) return 'EXECUTES_TEMPLATE';
  return 'MENTIONS';
}

export function mainLookupObservations(entity: Entity, result: import('./base.js').MainLookupResult): Observation[] {
  const observations: Observation[] = [];
  const me = canonicalize(entity.type, entity.value);
  for (const rel of result.relations.slice(0, 40)) {
    const from = mainTypeToHunter(rel.from.type, rel.from.value);
    const to = mainTypeToHunter(rel.to.type, rel.to.value);
    if (!from || !to) continue;
    const touchesMe = canonicalize(from.type, from.value) === me || canonicalize(to.type, to.value) === me;
    if (!touchesMe) continue;
    const b = new ObservationBuilder({
      kind: 'main_relationship', source: `main:${rel.sourceModule}`, observedAt: rel.observedAt ?? new Date().toISOString(),
      summary: `Main Platform (${rel.sourceModule}) recorded ${rel.relType.replace(/_/g, ' ')}: ${from.value} → ${to.value}`,
      raw: { ...rel }, confidence: Math.max(0.3, Math.min(0.95, rel.confidence || 0.7)), assertion: 'imported',
      provenance: `Main Platform investigation ${rel.investigationId}, ${rel.assertion} relationship from ${rel.sourceModule}`,
    }, entity);
    const fromRef = canonicalize(from.type, from.value) === me ? 'subject' : b.entity(from.type, from.value);
    const toRef = canonicalize(to.type, to.value) === me ? 'subject' : b.entity(to.type, to.value);
    b.rel(fromRef, toRef, mapRelType(rel.relType), `${rel.sourceModule} reported ${rel.relType}`, Math.max(0.3, Math.min(0.95, rel.confidence || 0.7)));
    observations.push(b.build());
  }
  for (const ev of result.evidence.slice(0, 15)) {
    if (!ev.text || ev.text.length < 40) continue;
    const isHtml = /<[a-z!][\s\S]*>/i.test(ev.text) && ev.text.length > 200;
    if (isHtml) {
      observations.push(...artifactObservations(entity, ev.text, { source: `main:${ev.sourceModule}`, provenance: `Main Platform evidence ${ev.id} (${ev.title}) from ${ev.sourceModule}`, observedAt: ev.capturedAt, label: ev.title })
        .map(o => ({ ...o, assertion: 'imported' as const })));
    } else {
      const inds = extractIndicators(ev.text).filter(i => canonicalize(i.type, i.value) !== me);
      const b = new ObservationBuilder({
        kind: 'main_evidence', source: `main:${ev.sourceModule}`, observedAt: ev.capturedAt,
        summary: `Main Platform evidence "${ev.title}" (${ev.sourceModule}): ${ev.text.slice(0, 160)}${ev.text.length > 160 ? '…' : ''}`,
        raw: { mainEvidenceId: ev.id, title: ev.title, text: ev.text.slice(0, 20000), investigationId: ev.investigationId, evidenceClass: ev.evidenceClass },
        confidence: 0.8, assertion: 'imported', provenance: `Main Platform evidence ${ev.id} from ${ev.sourceModule}`,
      }, entity);
      for (const ind of inds.slice(0, 15)) {
        const relType = ind.type === 'wallet' ? 'REFERENCES_WALLET' : ind.type === 'domain' ? 'MENTIONS' : 'USES_IDENTIFIER';
        if (ind.type === 'domain' && staticUbiquity('domain', ind.value).ubiquity >= 0.9) continue;
        b.rel('subject', b.entity(ind.type as EntityType, ind.value), relType, `${ev.sourceModule} evidence mentions ${ind.value}`, 0.7);
      }
      observations.push(b.build());
    }
  }
  if (!observations.length && result.matches.length) {
    const invs = Array.from(new Set(result.matches.map(m => m.investigationId))).filter(Boolean);
    const b = new ObservationBuilder({
      kind: 'main_presence', source: 'main:platform', observedAt: new Date().toISOString(),
      summary: `${entity.value} exists in ${invs.length} Main Platform investigation${invs.length === 1 ? '' : 's'} (${invs.slice(0, 3).join(', ')}) with no additional linked records`,
      raw: { matches: result.matches.slice(0, 20) }, confidence: 0.9, assertion: 'imported', provenance: 'Main Platform unified search',
    }, entity);
    b.subject({ metadata: { mainInvestigations: invs } });
    observations.push(b.build());
  }
  return observations;
}
