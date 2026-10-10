import type { Entity } from '../types.js';
import type { OpData } from './data.js';
import { neighbors, relevant, evidenceIdsFor } from './data.js';
import type { GraphAnalysis } from './graph.js';
import { registrableDomain, tldOf } from '../core/canonical.js';
import { countBy, daysBetween, uniq, round } from '../core/util.js';
import { isCommodity } from '../engine/noise.js';

export interface DomainProfile {
  id: string; value: string; isSeed: boolean; depth: number; registrar?: string; registeredAt?: string; expiresAt?: string;
  nameservers: string[]; ips: string[]; asns: string[]; countries: string[]; certificates: Array<{ id: string; label: string }>;
  templates: string[]; kitFamily?: string; identifiers: string[]; wallets: string[]; status: 'active' | 'standby' | 'taken_down' | 'inactive' | 'unknown';
  statusReason: string; role: 'core' | 'peripheral' | 'orphan'; linkStrength: number; linkPath: string[]; firstSeen: string; lastSeen: string; discoveredIn?: string;
  pageTitle?: string;
  isResourceHost: boolean;   // serves scripts/APIs to the sites rather than being a site itself
}

export interface Rotation { from: string; to: string; at: string; gapDays: number; sharedFeatures: string[]; evidenceIds: string[] }

export interface InfraAnalysis {
  domains: DomainProfile[];
  hosting: Array<{ ip: string; asn?: string; holder?: string; country?: string; domains: string[]; commodity: boolean; reason?: string }>;
  asns: Array<{ asn: string; holder?: string; countries: string[]; ips: string[]; domains: string[]; commodity: boolean }>;
  nameserverSets: Array<{ key: string; nameservers: string[]; domains: string[]; commodity: boolean }>;
  registrars: Array<{ name: string; domains: string[]; commodity: boolean }>;
  tlds: Record<string, number>;
  waves: Array<{ index: number; start: string; end: string; domains: string[]; registrars: string[]; nameservers: string[] }>;
  certificates: Array<{ id: string; label: string; issuer?: string; notBefore?: string; names: string[]; domainsInOperation: string[] }>;
  naming: { pattern: string; keywords: string[]; coverage: number; examples: string[]; tlds: string[] } | null;
  standby: string[];
  possibleReserve: string[];   // not-yet-live domains linked only by the operation's private nameservers
  takenDown: string[];
  rotations: Rotation[];
}

export function analyzeInfrastructure(data: OpData, graph: GraphAnalysis): InfraAnalysis {
  const domainEntities = data.entities.filter(e => e.type === 'domain' && relevant(e));
  const coreSet = new Set(graph.core);
  const periphSet = new Set(graph.peripheral);
  const kindsFor = (id: string) => new Set((data.evidenceByEntity.get(id) ?? []).map(ev => ev.type));

  const domains: DomainProfile[] = domainEntities.map(d => {
    const nb = neighbors(data, d.id);
    const ips = nb.filter(n => n.rel.type === 'RESOLVES_TO' && n.entity.type === 'ip' && n.direction === 'out');
    const ns = nb.filter(n => n.rel.type === 'DELEGATED_TO' && n.entity.type === 'nameserver');
    const certs = nb.filter(n => (n.rel.type === 'COVERS' || n.rel.type === 'CERTIFIED_BY') && n.entity.type === 'certificate');
    const templates = nb.filter(n => n.rel.type === 'EXECUTES_TEMPLATE' && n.entity.type === 'template');
    const idents = nb.filter(n => n.rel.type === 'USES_IDENTIFIER' && (n.entity.type === 'identifier' || n.entity.type === 'email'));
    const wallets = nb.filter(n => (n.rel.type === 'REFERENCES_WALLET' || n.rel.type === 'CONTROLS_WALLET') && (n.entity.type === 'wallet' || n.entity.type === 'contract'));
    const asns = uniq(ips.map(i => String(i.entity.metadata?.asn ?? '')).filter(Boolean));
    const countries = uniq(ips.map(i => String(i.entity.metadata?.country ?? '')).filter(Boolean));
    const kinds = kindsFor(d.id);
    const heldStatus = (d.metadata?.registryStatus ?? []).some((s: string) => /hold|suspend|redemption/i.test(s)) || Boolean(d.metadata?.takedownStatus);
    let status: DomainProfile['status'] = 'unknown';
    let statusReason = 'Not checked yet';
    if (heldStatus) { status = 'taken_down'; statusReason = 'Registry shows hold/suspension'; }
    else if (kinds.has('dns_a') && d.isActive) { status = 'active'; statusReason = 'Currently resolves'; }
    else if (kinds.has('dns_no_answer') || (!d.isActive && kinds.size)) {
      const registeredRecently = daysBetween(d.metadata?.registeredAt ?? d.firstSeen, new Date().toISOString()) < 45;
      status = registeredRecently ? 'standby' : 'inactive';
      statusReason = registeredRecently ? 'Registered recently but not serving a site yet (reserve domain)' : 'No longer resolves';
    } else if (kinds.has('site_scan') || kinds.has('page_fingerprint')) {
      status = 'active'; statusReason = 'Seen serving content (DNS not checked)';
    } else if (kinds.has('ct_certificate') || kinds.has('rdap_registration')) {
      status = 'unknown'; statusReason = 'Known from certificates/registration; DNS not checked yet';
    }
    const ls = graph.linkStrength[d.id];
    return {
      id: d.id, value: d.value, isSeed: Boolean(d.isSeed), depth: d.depth ?? 0, registrar: d.metadata?.registrar, registeredAt: d.metadata?.registeredAt, expiresAt: d.metadata?.expiresAt,
      nameservers: ns.map(n => n.entity.value).sort(), ips: ips.map(i => i.entity.value), asns, countries,
      certificates: certs.map(c => ({ id: c.entity.id, label: c.entity.label })), templates: templates.map(t => t.entity.value),
      kitFamily: templates.find(t => t.entity.metadata?.kitFamily)?.entity.metadata?.kitFamily, identifiers: idents.map(i => i.entity.value), wallets: wallets.map(w => w.entity.value),
      status, statusReason, role: (coreSet.has(d.id) ? 'core' : periphSet.has(d.id) ? 'peripheral' : 'orphan') as DomainProfile['role'], linkStrength: ls?.strength ?? 0, linkPath: ls?.path ?? [],
      firstSeen: d.metadata?.registeredAt ?? d.firstSeen, lastSeen: d.lastSeen, discoveredIn: d.metadata?.discoveredIn, pageTitle: d.metadata?.pageTitle, isResourceHost: d.metadata?.role === 'script/resource host' && !d.isSeed,
    };
  }).sort((a, b) => Number(b.isSeed) - Number(a.isSeed) || (b.linkStrength - a.linkStrength) || a.value.localeCompare(b.value));

  const ipEntities = data.entities.filter(e => e.type === 'ip');
  const hosting = ipEntities.map(ip => {
    const doms = neighbors(data, ip.id, ['RESOLVES_TO']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
    return { ip: ip.value, asn: ip.metadata?.asn, holder: ip.metadata?.asnHolder, country: ip.metadata?.country, domains: uniq(doms), commodity: isCommodity(ip.ubiquity) || Boolean(ip.metadata?.commodity), reason: ip.metadata?.ubiquityReason };
  }).sort((a, b) => b.domains.length - a.domains.length);

  const asnMap = new Map<string, InfraAnalysis['asns'][number]>();
  for (const h of hosting) {
    if (!h.asn) continue;
    const a: InfraAnalysis['asns'][number] = asnMap.get(h.asn) ?? { asn: h.asn, holder: h.holder, countries: [], ips: [], domains: [], commodity: false };
    a.ips.push(h.ip);
    a.domains = uniq([...a.domains, ...h.domains]);
    if (h.country && !a.countries.includes(h.country)) a.countries.push(h.country);
    const asnEntity = data.entities.find(e => e.type === 'asn' && e.value === h.asn);
    a.commodity = isCommodity(asnEntity?.ubiquity);
    asnMap.set(h.asn, a);
  }

  const nsSets = new Map<string, InfraAnalysis['nameserverSets'][number]>();
  for (const d of domains) {
    if (!d.nameservers.length) continue;
    const key = d.nameservers.join(' + ');
    const set = nsSets.get(key) ?? { key, nameservers: d.nameservers, domains: [], commodity: d.nameservers.every(n => isCommodity(data.entities.find(e => e.type === 'nameserver' && e.value === n)?.ubiquity)) };
    set.domains.push(d.value);
    nsSets.set(key, set);
  }

  const regMap = new Map<string, InfraAnalysis['registrars'][number]>();
  for (const d of domains) {
    if (!d.registrar) continue;
    const r = regMap.get(d.registrar) ?? { name: d.registrar, domains: [], commodity: isCommodity(data.entities.find(e => e.type === 'registrar' && e.value.toLowerCase().includes(d.registrar!.toLowerCase().split(/[ ,]/)[0]))?.ubiquity) };
    r.domains.push(d.value);
    regMap.set(d.registrar, r);
  }

  // Registration waves: split registrations by gaps of more than 3 days.
  const dated = domains.filter(d => d.registeredAt && d.role === 'core' && !d.isResourceHost).sort((a, b) => a.registeredAt!.localeCompare(b.registeredAt!));
  const waves: InfraAnalysis['waves'] = [];
  for (const d of dated) {
    const last = waves[waves.length - 1];
    if (last && daysBetween(last.end, d.registeredAt!) <= 3) {
      last.end = d.registeredAt!;
      last.domains.push(d.value);
      if (d.registrar && !last.registrars.includes(d.registrar)) last.registrars.push(d.registrar);
      for (const n of d.nameservers) if (!last.nameservers.includes(n)) last.nameservers.push(n);
    } else {
      waves.push({ index: waves.length + 1, start: d.registeredAt!, end: d.registeredAt!, domains: [d.value], registrars: d.registrar ? [d.registrar] : [], nameservers: [...d.nameservers] });
    }
  }

  const certificates = data.entities.filter(e => e.type === 'certificate').map(c => {
    const names: string[] = (c.metadata?.san ?? []).map((n: string) => String(n));
    const inOp = neighbors(data, c.id, ['COVERS', 'CERTIFIED_BY']).filter(n => n.entity.type === 'domain').map(n => n.entity.value);
    return { id: c.id, label: c.label, issuer: c.metadata?.issuer, notBefore: c.metadata?.notBefore, names, domainsInOperation: uniq(inOp) };
  }).sort((a, b) => b.domainsInOperation.length - a.domainsInOperation.length);

  const coreDomains = domains.filter(d => d.role === 'core' && !d.isResourceHost);
  const naming = namingPattern(coreDomains.map(d => d.value));
  const rotations = detectRotations(domains, data);

  return {
    domains, hosting, asns: [...asnMap.values()].sort((a, b) => b.domains.length - a.domains.length),
    nameserverSets: [...nsSets.values()].sort((a, b) => b.domains.length - a.domains.length),
    registrars: [...regMap.values()].sort((a, b) => b.domains.length - a.domains.length),
    tlds: countBy(domains.filter(d => d.role !== 'orphan'), d => tldOf(d.value)), waves, certificates, naming,
    standby: domains.filter(d => d.status === 'standby' && d.role === 'core' && !d.isResourceHost).map(d => d.value),
    possibleReserve: domains.filter(d => d.status === 'standby' && d.role === 'peripheral' && !d.isResourceHost && d.nameservers.some(n => domains.some(c => c.role === 'core' && c.nameservers.includes(n)))).map(d => d.value),
    takenDown: domains.filter(d => d.status === 'taken_down').map(d => d.value),
    rotations,
  };
}

/** Lexical pattern shared by an operation's domain names (e.g. "claim-*-portal"). */
export function namingPattern(domains: string[]): InfraAnalysis['naming'] {
  if (domains.length < 3) return null;
  const tokenized = domains.map(d => registrableDomain(d).split('.')[0].split(/[-_]|(?<=\D)(?=\d)/).filter(t => t.length >= 3));
  const df = new Map<string, number>();
  for (const tokens of tokenized) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const keywords = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 10);
  if (!keywords.length) return null;
  const covered = tokenized.filter(tokens => tokens.some(t => keywords.includes(t))).length;
  const firsts = countBy(tokenized, t => t[0]);
  const lasts = countBy(tokenized, t => t[t.length - 1]);
  const topFirst = Object.entries(firsts).sort((a, b) => b[1] - a[1])[0];
  const topLast = Object.entries(lasts).sort((a, b) => b[1] - a[1])[0];
  const parts: string[] = [];
  if (topFirst && topFirst[1] / domains.length >= 0.35) parts.push(topFirst[0]); else parts.push('*');
  parts.push('*');
  if (topLast && topLast[1] / domains.length >= 0.35 && topLast[0] !== topFirst?.[0]) parts.push(topLast[0]);
  const pattern = parts.join('-').replace(/(\*-)+\*/g, '*');
  return { pattern, keywords, coverage: round(covered / domains.length, 2), examples: domains.slice(0, 5), tlds: uniq(domains.map(tldOf)) };
}

/** Old domain goes dark; a newer domain appears with the same setup → probable rotation. */
function detectRotations(domains: DomainProfile[], data: OpData): Rotation[] {
  const out: Rotation[] = [];
  // A rotation is the same operation moving: both ends must belong to the operation's core.
  // (Peripheral sites sharing a kit are more likely other customers of the same kit.)
  const dark = domains.filter(d => d.role === 'core' && !d.isResourceHost && (d.status === 'taken_down' || d.status === 'inactive'));
  const candidates = domains.filter(d => d.role === 'core' && !d.isResourceHost && (d.status === 'active' || d.status === 'standby'));
  for (const to of candidates) {
    const toStart = to.registeredAt ?? to.firstSeen;
    let best: Rotation | null = null;
    for (const from of dark) {
      const fromStart = from.registeredAt ?? from.firstSeen;
      if (!fromStart || !toStart || toStart <= fromStart || daysBetween(fromStart, toStart) < 3) continue;
      const shared: string[] = [];
      if (from.nameservers.length && from.nameservers.join() === to.nameservers.join() && from.nameservers.every(n => !isCommodity(data.entities.find(e => e.value === n)?.ubiquity))) shared.push(`nameservers ${from.nameservers[0]}`);
      const tpl = from.templates.filter(t => to.templates.includes(t));
      if (tpl.length) shared.push('identical page structure');
      else if (from.kitFamily && from.kitFamily === to.kitFamily) shared.push(`same kit family (${from.kitFamily})`);
      const ids = from.identifiers.filter(i => to.identifiers.includes(i));
      if (ids.length) shared.push(`identifiers ${ids.slice(0, 2).join(', ')}`);
      const w = from.wallets.filter(x => to.wallets.includes(x));
      if (w.length) shared.push('same deposit wallet');
      if (shared.length < 2) continue;
      const rot: Rotation = { from: from.value, to: to.value, at: toStart, gapDays: round(daysBetween(fromStart, toStart), 1), sharedFeatures: shared, evidenceIds: evidenceIdsFor([...(data.out.get(from.id) ?? []), ...(data.out.get(to.id) ?? [])], 8) };
      if (!best || fromStart > (domains.find(d => d.value === best!.from)?.registeredAt ?? '')) best = rot;
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export type { Entity };
