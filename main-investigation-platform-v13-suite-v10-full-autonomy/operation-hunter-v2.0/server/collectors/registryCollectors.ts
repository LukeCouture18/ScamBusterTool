import type { Entity } from '../types.js';
import type { CollectorResult } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult, networkRequired } from './base.js';
import { hostnameOf, registrableDomain } from '../core/canonical.js';
import { nowIso } from '../core/util.js';

function vcardField(entity: any, field: string): string | undefined {
  const card = entity?.vcardArray?.[1];
  if (!Array.isArray(card)) return undefined;
  const row = card.find((r: any) => Array.isArray(r) && r[0] === field);
  const v = row?.[3];
  return Array.isArray(v) ? v.filter(Boolean).join(' ') : v ? String(v) : undefined;
}

function rdapEvent(body: any, action: string): string | undefined {
  const ev = (body?.events ?? []).find((e: any) => String(e.eventAction).toLowerCase() === action);
  return ev?.eventDate ? new Date(ev.eventDate).toISOString() : undefined;
}

/** Parse an RDAP domain response into one observation. Exported for tests. */
export function rdapDomainObservation(subject: Entity, body: any, provenance: string, source = 'rdap') {
  const registered = rdapEvent(body, 'registration');
  const expires = rdapEvent(body, 'expiration');
  const changed = rdapEvent(body, 'last changed');
  const entities: any[] = body?.entities ?? [];
  const flat: any[] = [];
  const walk = (list: any[]) => { for (const e of list ?? []) { flat.push(e); walk(e.entities ?? []); } };
  walk(entities);
  const registrarEntity = flat.find(e => (e.roles ?? []).includes('registrar'));
  const registrar = vcardField(registrarEntity, 'fn') ?? registrarEntity?.handle;
  const ianaId = registrarEntity?.publicIds?.find((p: any) => /iana/i.test(p.type))?.identifier;
  const registrant = flat.find(e => (e.roles ?? []).includes('registrant'));
  const registrantEmail = vcardField(registrant, 'email');
  const registrantOrg = vcardField(registrant, 'org') ?? vcardField(registrant, 'fn');
  const nameservers: string[] = (body?.nameservers ?? []).map((n: any) => hostnameOf(n.ldhName ?? '')).filter(Boolean);
  const status: string[] = body?.status ?? [];
  const redacted = !registrantEmail || /redacted|privacy|proxy|withheld|protect/i.test(`${registrantEmail} ${registrantOrg ?? ''}`);
  const parts = [
    registrar ? `registered through ${registrar}` : 'registrar not disclosed',
    registered ? `created ${registered.slice(0, 10)}` : null,
    expires ? `expires ${expires.slice(0, 10)}` : null,
    nameservers.length ? `registry nameservers ${nameservers.join(', ')}` : null,
    status.length ? `status ${status.slice(0, 3).join(', ')}` : null,
  ].filter(Boolean);
  const b = new ObservationBuilder({
    kind: 'rdap_registration', source, observedAt: registered ?? changed ?? nowIso(),
    summary: `${subject.value}: ${parts.join('; ')}`,
    raw: { registrar, ianaId, registered, expires, changed, nameservers, status, registrantOrg: redacted ? undefined : registrantOrg, registrantEmail: redacted ? undefined : registrantEmail },
    confidence: 0.95, provenance,
  }, subject);
  const isHeld = status.some(s => /hold|suspend|inactive|redemption|pending delete/i.test(s));
  b.subject({ firstSeen: registered, metadata: { registrar, registeredAt: registered, expiresAt: expires, registryStatus: status, ...(isHeld ? { takedownStatus: 'registry hold / suspended' } : {}) }, ...(isHeld ? { isActive: false } : {}) });
  if (registrar) b.rel('subject', b.entity('registrar', registrar, { label: registrar, metadata: { ianaId } }), 'REGISTERED_WITH', `RDAP names ${registrar} as sponsoring registrar`);
  for (const ns of nameservers) b.rel('subject', b.entity('nameserver', ns), 'DELEGATED_TO', `Registry record lists ${ns} as a nameserver`, 0.95);
  if (!redacted && registrantEmail) b.rel('subject', b.entity('email', registrantEmail, { metadata: { role: 'registrant' } }), 'USES_IDENTIFIER', 'Registrant contact email published in the registration record', 0.9);
  return b.build();
}

export class RdapCollector implements Collector {
  id = 'rdap';
  name = 'Registration data (RDAP)';
  kind = 'passive_public' as const;
  pivotTypes = ['RDAP_DOMAIN'];
  description = 'Public domain registration records via the RDAP bootstrap service (rdap.org).';

  availability(settings: RuntimeSettings) { return networkRequired(settings); }

  async execute(_pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const reg = registrableDomain(entity.value);
    if (!reg) return emptyResult('Not a domain');
    const url = `https://rdap.org/domain/${encodeURIComponent(reg)}`;
    const res = await ctx.http.json({ url, collector: this.id, ttlSeconds: 24 * 3600, bypassCache: ctx.bypassCache, accept404: true, timeoutMs: 25000 });
    if (res.status === 404 || !res.body) return emptyResult(`No RDAP record for ${reg} (unregistered, deleted, or TLD without RDAP)`);
    const subject = reg === entity.value ? entity : { ...entity };
    return { observations: [rdapDomainObservation(subject, res.body, `RDAP lookup ${url}`)], resultVolume: 1 };
  }
}

export class RipeStatCollector implements Collector {
  id = 'ripestat';
  name = 'Network ownership (RIPEstat)';
  kind = 'passive_public' as const;
  pivotTypes = ['IP_PROFILE'];
  description = 'Which network (ASN) announces an IP address, its holder and country, via RIPEstat public data API.';

  availability(settings: RuntimeSettings) { return networkRequired(settings); }

  async execute(_pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const ip = entity.value.trim();
    const overview = await ctx.http.json({ url: `https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(ip)}&sourceapp=operation-hunter`, collector: this.id, ttlSeconds: 3 * 86400, bypassCache: ctx.bypassCache });
    let country: string | undefined;
    try {
      const geo = await ctx.http.json({ url: `https://stat.ripe.net/data/maxmind-geo-lite/data.json?resource=${encodeURIComponent(ip)}&sourceapp=operation-hunter`, collector: this.id, ttlSeconds: 7 * 86400, bypassCache: ctx.bypassCache });
      country = geo.body?.data?.located_resources?.[0]?.locations?.[0]?.country ?? undefined;
    } catch { /* geolocation is optional */ }
    return { observations: [ipProfileObservation(entity, overview.body?.data ?? {}, country, `RIPEstat prefix-overview for ${ip}`)], resultVolume: 1 };
  }
}

export function ipProfileObservation(entity: Entity, data: any, country: string | undefined, provenance: string, source = 'ripestat') {
  const asns: Array<{ asn: number | string; holder?: string }> = data?.asns ?? [];
  const prefix: string | undefined = data?.resource ?? data?.block?.resource;
  const holder = asns[0]?.holder;
  const summary = asns.length
    ? `${entity.value} is announced by AS${asns.map(a => a.asn).join(', AS')} (${holder ?? 'unknown holder'}) in prefix ${prefix ?? 'unknown'}${country ? `, located in ${country}` : ''}`
    : `${entity.value} is not currently announced in global routing${prefix ? ` (prefix ${prefix})` : ''}`;
  const b = new ObservationBuilder({ kind: 'ip_asn', source, observedAt: nowIso(), summary, raw: { asns, prefix, country, announced: data?.announced }, confidence: 0.95, provenance }, entity);
  b.subject({ metadata: { asn: asns[0] ? `AS${asns[0].asn}` : undefined, asnHolder: holder, prefix, country } });
  for (const a of asns) {
    b.rel('subject', b.entity('asn', `AS${a.asn}`, { label: `AS${a.asn}${a.holder ? ` (${a.holder})` : ''}`, metadata: { holder: a.holder, country } }), 'SERVED_BY', `BGP routing: prefix ${prefix ?? ''} is announced by AS${a.asn}`);
  }
  return b.build();
}

/** Reverse IP / shared-nameserver lookups through HackerTarget's free API (limited daily quota). */
export class HackerTargetCollector implements Collector {
  id = 'hackertarget';
  name = 'Reverse lookups (HackerTarget)';
  kind = 'passive_public' as const;
  pivotTypes = ['REVERSE_IP', 'REVERSE_NS'];
  description = 'Passive-DNS style reverse lookups (domains on an IP, domains sharing a nameserver). Free tier is limited to a small number of queries per day; add an API key in Settings for more.';

  availability(settings: RuntimeSettings) { return networkRequired(settings); }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const endpoint = pivotType === 'REVERSE_IP' ? 'reverseiplookup' : 'findshareddns';
    const key = ctx.settings.apiKeys.hackertarget;
    const url = `https://api.hackertarget.com/${endpoint}/?q=${encodeURIComponent(entity.value)}${key ? `&apikey=${encodeURIComponent(key)}` : ''}`;
    const res = await ctx.http.text({ url, collector: this.id, ttlSeconds: 3 * 86400, bypassCache: ctx.bypassCache });
    const text = String(res.body ?? '').trim();
    if (/API count exceeded|increase quota|error check your search/i.test(text)) {
      throw Object.assign(new Error(`HackerTarget: ${text.slice(0, 120)}`), { retryable: /count exceeded|quota/i.test(text) });
    }
    if (/No DNS A records found|no records found/i.test(text) || !text) return { observations: [], resultVolume: 0, note: 'No other domains recorded' };
    const domains = Array.from(new Set(text.split(/\r?\n/).map(l => hostnameOf(l.split(',')[0])).filter(d => d && d.includes('.'))));
    return reverseObservations(entity, pivotType, domains, `HackerTarget ${endpoint} for ${entity.value}`, 'hackertarget');
  }
}

export function reverseObservations(entity: Entity, pivotType: string, domains: string[], provenance: string, source: string, observedAt = nowIso()): CollectorResult {
  const volume = domains.length;
  const kept = domains.slice(0, 40);
  if (!kept.length) return { observations: [], resultVolume: 0 };
  const isIp = pivotType === 'REVERSE_IP';
  const b = new ObservationBuilder({
    kind: isIp ? 'reverse_ip' : 'reverse_ns', source, observedAt,
    summary: `${volume} domain${volume === 1 ? '' : 's'} ${isIp ? 'have pointed to' : 'delegate DNS to'} ${entity.value}${volume > kept.length ? ` (first ${kept.length} kept)` : ''}: ${kept.slice(0, 8).join(', ')}${kept.length > 8 ? ' …' : ''}`,
    raw: { domains: kept, total: volume }, confidence: isIp ? 0.75 : 0.8, provenance,
  }, entity);
  for (const d of kept) {
    const ref = b.entity('domain', d, { metadata: { discoveredIn: isIp ? 'reverse IP' : 'shared nameserver' } });
    if (isIp) b.rel(ref, 'subject', 'RESOLVES_TO', `Passive DNS: ${d} has resolved to ${entity.value}`, 0.75);
    else b.rel(ref, 'subject', 'DELEGATED_TO', `Passive DNS: ${d} uses nameserver ${entity.value}`, 0.8);
  }
  return { observations: [b.build()], resultVolume: volume, truncated: volume > kept.length };
}
