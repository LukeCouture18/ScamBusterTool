import type { Observation } from '../core/model.js';
import type { IntelStore, FacetChange } from '../core/intelStore.js';
import type { HunterStore } from '../core/store.js';
import { canonicalize, hostnameOf } from '../core/canonical.js';

/**
 * Facets are the time-varying properties of an entity that Hunter tracks as a
 * ledger: what a domain resolves to, which nameservers it uses, whether it
 * answers at all, its registry status, page structure, certificates, the
 * counterparties a wallet moves money to, and which domains sit on a private
 * nameserver. Each distinct value keeps first/last seen; the ledger turns new
 * observations into typed changes (appeared, changed, disappeared, resurfaced)
 * or, when two sources disagree at the same time, a contradiction.
 */

export interface FacetUpdate { facet: string; value?: string; end?: boolean; exclusive: boolean; significance: number; entityValue?: string; entityType?: string }

export const FACET_LABEL: Record<string, string> = {
  'dns.a': 'IP addresses', 'dns.ns': 'nameservers', 'dns.status': 'DNS status', 'hosting.ip': 'hosting server', 'rdap.status': 'registry status',
  'rdap.ns': 'registered nameservers', 'rdap.registrar': 'registrar', 'page.structure': 'page structure', 'page.title': 'page title', 'cert.issued': 'certificates',
  'chain.flow': 'money flows', 'ip.asn': 'network', 'ns.members': 'domains on nameserver', 'ip.members': 'domains on server', 'resource.members': 'sites loading this file',
  'identifier.members': 'sites using this identifier',
};

export function facetsFromObservation(obs: Observation, subjectType: string): FacetUpdate[] {
  const raw = obs.raw ?? {};
  const out: FacetUpdate[] = [];
  switch (obs.kind) {
    case 'dns_a': {
      const ips = [...(raw.A ?? []), ...(raw.AAAA ?? [])].map(String).sort();
      if (ips.length) {
        out.push({ facet: 'dns.a', value: ips.join(','), exclusive: true, significance: 0.7 });
        out.push({ facet: 'dns.status', value: 'resolving', exclusive: true, significance: 0.8 });
      }
      break;
    }
    case 'dns_ns': {
      const ns = (raw.NS ?? []).map((n: string) => hostnameOf(n)).sort();
      if (ns.length) out.push({ facet: 'dns.ns', value: ns.join(','), exclusive: true, significance: 0.8 });
      break;
    }
    case 'dns_no_answer':
      out.push({ facet: 'dns.status', value: 'no_answer', exclusive: true, significance: 0.85 });
      out.push({ facet: 'dns.a', end: true, exclusive: true, significance: 0.8 });
      break;
    case 'rdap_registration': {
      const status = (raw.status ?? []).map(String).sort().join(', ') || 'active';
      out.push({ facet: 'rdap.status', value: status, exclusive: true, significance: /hold|suspend|redemption|delete/i.test(status) ? 0.9 : 0.4 });
      if (raw.registrar) out.push({ facet: 'rdap.registrar', value: String(raw.registrar), exclusive: true, significance: 0.5 });
      if ((raw.nameservers ?? []).length) out.push({ facet: 'rdap.ns', value: (raw.nameservers as string[]).map(n => hostnameOf(n)).sort().join(','), exclusive: true, significance: 0.7 });
      break;
    }
    case 'site_scan':
      if (raw.page?.ip) out.push({ facet: 'hosting.ip', value: String(raw.page.ip), exclusive: true, significance: 0.6 });
      if (raw.page?.title) out.push({ facet: 'page.title', value: String(raw.page.title).slice(0, 200), exclusive: true, significance: 0.3 });
      break;
    case 'page_fingerprint':
      if (raw.structuralHash) out.push({ facet: 'page.structure', value: String(raw.structuralHash), exclusive: true, significance: 0.6 });
      break;
    case 'ct_certificate':
      if (raw.serial || raw.crtsh_id) out.push({ facet: 'cert.issued', value: `${raw.serial ?? raw.crtsh_id}:${(raw.names ?? []).slice(0, 6).join('|')}`, exclusive: false, significance: 0.5 });
      break;
    case 'transfer_flow':
      if (raw.counterparty) out.push({ facet: 'chain.flow', value: `${raw.direction}:${String(raw.counterparty).toLowerCase()}`, exclusive: false, significance: raw.direction === 'out' ? 0.75 : 0.55 });
      break;
    case 'ip_asn':
      if ((raw.asns ?? []).length) out.push({ facet: 'ip.asn', value: raw.asns.map((a: any) => `AS${a.asn}`).join(','), exclusive: true, significance: 0.5 });
      break;
    case 'reverse_ns':
      for (const d of (raw.domains ?? []).slice(0, 60)) out.push({ facet: 'ns.members', value: canonicalize('domain', d) ?? d, exclusive: false, significance: 0.85 });
      break;
    case 'reverse_ip':
      for (const d of (raw.domains ?? []).slice(0, 60)) out.push({ facet: 'ip.members', value: canonicalize('domain', d) ?? d, exclusive: false, significance: 0.6 });
      break;
    case 'shared_resource':
      for (const d of (raw.domains ?? []).slice(0, 60)) out.push({ facet: 'resource.members', value: canonicalize('domain', d) ?? d, exclusive: false, significance: 0.7 });
      break;
    case 'tracker_reuse':
      for (const d of (raw.domains ?? []).slice(0, 60)) out.push({ facet: 'identifier.members', value: canonicalize('domain', d) ?? d, exclusive: false, significance: 0.9 });
      break;
    default:
      break;
  }
  void subjectType;
  return out;
}

/** Apply every facet implied by a pivot's observations to the ledger. Returns the resulting changes. */
export function recordFacets(intel: IntelStore, store: HunterStore, operationId: string, subjectId: string, observations: Observation[]): FacetChange[] {
  const subject = store.getEntity(subjectId);
  if (!subject) return [];
  const changes: FacetChange[] = [];
  for (const obs of observations) {
    for (const u of facetsFromObservation(obs, subject.type)) {
      const at = pickTime(obs, u.facet);
      const c = u.end
        ? intel.endFacet({ operationId, entityId: subjectId, facet: u.facet, at, source: obs.source, significance: u.significance })
        : intel.observeFacet({ operationId, entityId: subjectId, facet: u.facet, value: u.value!, at, source: obs.source, exclusive: u.exclusive, significance: u.significance });
      if (c) changes.push(c);
    }
  }
  return changes;
}

/** Point-in-time facts use the observation time; "current state" facts (DNS, RDAP status) use when Hunter looked. */
function pickTime(obs: Observation, facet: string): string {
  if (facet.startsWith('dns.') || facet === 'rdap.status' || facet === 'rdap.ns' || facet === 'rdap.registrar' || facet === 'ip.asn' || facet.endsWith('.members')) return new Date().toISOString();
  return obs.observedAt || new Date().toISOString();
}

export function describeChange(c: FacetChange, subjectValue: string): string {
  const label = FACET_LABEL[c.facet] ?? c.facet;
  switch (c.kind) {
    case 'appeared':
      if (c.facet === 'ns.members') return `New domain ${c.to} appeared on nameserver ${subjectValue}`;
      if (c.facet === 'ip.members') return `New domain ${c.to} appeared on server ${subjectValue}`;
      if (c.facet === 'resource.members') return `New site ${c.to} loads the same file`;
      if (c.facet === 'identifier.members') return `New site ${c.to} uses identifier ${subjectValue}`;
      if (c.facet === 'chain.flow') { const [dir, cp] = String(c.to).split(':'); return `${subjectValue.slice(0, 12)}… ${dir === 'out' ? 'started sending funds to' : 'started receiving funds from'} ${cp.slice(0, 12)}…`; }
      if (c.facet === 'cert.issued') return `New certificate issued covering ${subjectValue}`;
      return `${subjectValue}: ${label} now ${c.to}`;
    case 'changed':
      return `${subjectValue}: ${label} changed from ${c.from} to ${c.to}`;
    case 'disappeared':
      return `${subjectValue}: ${label} disappeared (was ${c.from})`;
    case 'resurfaced':
      return `${subjectValue}: ${label} is back to ${c.to}`;
    case 'contradiction':
      return `${subjectValue}: sources disagree about ${label} (${c.from} vs ${c.to})`;
    default:
      return `${subjectValue}: ${label} ${c.kind}`;
  }
}
