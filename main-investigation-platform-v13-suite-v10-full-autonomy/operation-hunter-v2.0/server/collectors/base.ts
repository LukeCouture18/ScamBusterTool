import type { Entity } from '../types.js';
import type { CollectorAvailability, CollectorKind, CollectorResult, Observation, ObservedEntity, ObservedRelationship } from '../core/model.js';
import type { HunterStore } from '../core/store.js';
import type { HttpClient } from './http.js';
import type { EvidenceAssertion, EntityType } from '../types.js';

export type NetworkMode = 'live' | 'offline';

export interface RuntimeSettings {
  networkMode: NetworkMode;
  apiKeys: Record<string, string>;            // urlscan, trongrid, hackertarget, blockscout:<network>
  disabledCollectors: string[];
  blockscoutNetworks: Record<string, string>; // network -> base URL
  dnsServers: string[];
  /** v2.0: read archived page content from public scan archives (default on). */
  archivedContent?: boolean;
}

export interface MainLookupResult {
  matches: Array<{ investigationId: string; entityType: string; canonical: string; displayName?: string; mainEntityId?: string }>;
  relations: Array<{ from: { type: string; value: string }; to: { type: string; value: string }; relType: string; assertion: string; sourceModule: string; confidence: number; observedAt?: string; investigationId: string }>;
  evidence: Array<{ id: string; title: string; text: string; sourceModule: string; capturedAt: string; subject?: { type: string; value: string }; investigationId: string; evidenceClass?: string }>;
}

export interface MainBridge {
  configured(): boolean;
  lookup(value: string): Promise<MainLookupResult>;
  requestSiteCheck(operationId: string, domain: string, reason: string): Promise<{ accepted: boolean; detail: string }>;
}

export interface CollectorContext {
  store: HunterStore;
  http: HttpClient;
  settings: RuntimeSettings;
  operationId: string;
  bypassCache?: boolean;
  main?: MainBridge | null;
  /** DNS resolver override (tests). */
  dnsResolver?: any;
}

export interface Collector {
  id: string;
  name: string;
  kind: CollectorKind;
  pivotTypes: string[];
  /** Human description of the data source, shown in Settings. */
  description: string;
  availability(settings: RuntimeSettings, ctx?: { main?: MainBridge | null }): CollectorAvailability;
  execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult>;
}

/** Small helper to assemble an Observation with local entity references. */
export class ObservationBuilder {
  private entities: ObservedEntity[] = [];
  private relationships: ObservedRelationship[] = [];
  private refs = new Map<string, string>();

  constructor(
    private base: { kind: string; source: string; observedAt: string; summary: string; raw: Record<string, any>; confidence: number; assertion?: EvidenceAssertion; provenance: string },
    subject?: Entity,
  ) {
    if (subject) {
      this.entities.push({ ref: 'subject', type: subject.type, value: subject.value });
      this.refs.set(`${subject.type}:${subject.value.toLowerCase()}`, 'subject');
    }
  }

  entity(type: EntityType, value: string, extra: Omit<ObservedEntity, 'ref' | 'type' | 'value'> = {}): string {
    const key = `${type}:${String(value).toLowerCase()}`;
    const existing = this.refs.get(key);
    if (existing) {
      const e = this.entities.find(x => x.ref === existing)!;
      e.metadata = { ...(e.metadata ?? {}), ...(extra.metadata ?? {}) };
      if (extra.label && !e.label) e.label = extra.label;
      return existing;
    }
    const ref = `e${this.entities.length}`;
    this.entities.push({ ref, type, value, ...extra });
    this.refs.set(key, ref);
    return ref;
  }

  /** Update the subject entity (e.g. mark inactive, add metadata). */
  subject(extra: Omit<ObservedEntity, 'ref' | 'type' | 'value'>) {
    const e = this.entities.find(x => x.ref === 'subject');
    if (e) Object.assign(e, extra, { metadata: { ...(e.metadata ?? {}), ...(extra.metadata ?? {}) } });
    return this;
  }

  rel(from: string, to: string, type: ObservedRelationship['type'], reasoning: string, confidence?: number, observedAt?: string) {
    if (from === to) return;
    this.relationships.push({ from, to, type, reasoning, confidence, observedAt });
  }

  build(): Observation {
    return {
      kind: this.base.kind,
      source: this.base.source,
      observedAt: this.base.observedAt,
      summary: this.base.summary,
      raw: this.base.raw,
      confidence: this.base.confidence,
      assertion: this.base.assertion ?? 'observed',
      provenance: this.base.provenance,
      entities: this.entities,
      relationships: this.relationships,
    };
  }
}

export function emptyResult(note?: string): CollectorResult {
  return { observations: [], resultVolume: 0, note };
}

export function networkRequired(settings: RuntimeSettings): CollectorAvailability {
  return settings.networkMode === 'live' ? { ok: true } : { ok: false, reason: 'Offline mode: public network sources are disabled.' };
}
