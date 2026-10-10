import type { Entity } from '../types.js';
import type { CollectorResult, Observation } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult, networkRequired } from './base.js';
import { hostnameOf, registrableDomain } from '../core/canonical.js';

const SERVICE_PREFIXES = new Set(['www', 'mail', 'webmail', 'cpanel', 'webdisk', 'cpcalendars', 'cpcontacts', 'autodiscover', 'autoconfig', 'whm', 'ftp', 'smtp', 'pop', 'imap']);

interface CrtRow {
  id: number; issuer_ca_id?: number; issuer_name?: string; common_name?: string; name_value?: string;
  entry_timestamp?: string; not_before?: string; not_after?: string; serial_number?: string;
}

/** Normalise one certificate name: strip wildcards and cPanel/service prefixes. */
export function normalizeSanName(name: string): { host: string; wildcard: boolean } | null {
  let n = String(name ?? '').trim().toLowerCase();
  if (!n || n.includes(' ') || n.includes('@')) return null;
  const wildcard = n.startsWith('*.');
  n = hostnameOf(n.replace(/^\*\./, ''));
  if (!n || !n.includes('.')) return null;
  const labels = n.split('.');
  if (labels.length > 2 && SERVICE_PREFIXES.has(labels[0])) n = labels.slice(1).join('.');
  return { host: n, wildcard };
}

export function issuerShort(issuer: string | undefined): string {
  const cn = /CN=([^,]+)/.exec(issuer ?? '')?.[1] ?? '';
  const o = /O=("[^"]+"|[^,]+)/.exec(issuer ?? '')?.[1]?.replace(/"/g, '') ?? '';
  return (o || cn || 'unknown issuer').trim();
}

/** Turns crt.sh rows into one observation per distinct certificate. */
export function certificatesToObservations(subject: Entity, rows: CrtRow[], provenance: string, source = 'crt.sh', synthetic = false): { observations: Observation[]; total: number; truncated: boolean } {
  const bySerial = new Map<string, CrtRow & { names: Set<string> }>();
  for (const row of rows) {
    const key = `${row.issuer_ca_id ?? ''}:${row.serial_number ?? row.id}`;
    let cert = bySerial.get(key);
    if (!cert) bySerial.set(key, (cert = { ...row, names: new Set() }));
    for (const n of String(row.name_value ?? '').split(/\n/)) if (n.trim()) cert.names.add(n.trim());
    if (row.common_name) cert.names.add(row.common_name);
    if (row.entry_timestamp && (!cert.entry_timestamp || row.entry_timestamp < cert.entry_timestamp)) cert.entry_timestamp = row.entry_timestamp;
  }
  const certs = [...bySerial.values()].sort((a, b) => String(b.not_before ?? '').localeCompare(String(a.not_before ?? '')));
  const total = certs.length;
  const kept = certs.slice(0, 150);
  const subjectReg = registrableDomain(subject.value);
  const observations: Observation[] = [];
  for (const cert of kept) {
    const names = new Map<string, boolean>();
    for (const n of cert.names) {
      const norm = normalizeSanName(n);
      if (norm) names.set(norm.host, (names.get(norm.host) ?? false) || norm.wildcard);
    }
    if (!names.size) continue;
    const issuer = issuerShort(cert.issuer_name);
    const observedAt = toIso(cert.entry_timestamp ?? cert.not_before) ?? new Date().toISOString();
    const nameList = [...names.keys()];
    const foreign = nameList.filter(n => registrableDomain(n) !== subjectReg);
    const summary = foreign.length
      ? `Certificate ${cert.serial_number ?? cert.id} (${issuer}, valid from ${String(cert.not_before ?? '').slice(0, 10)}) covers ${subject.value} together with other domains: ${foreign.slice(0, 6).join(', ')}${foreign.length > 6 ? ` +${foreign.length - 6}` : ''}`
      : `Certificate ${cert.serial_number ?? cert.id} (${issuer}, valid from ${String(cert.not_before ?? '').slice(0, 10)}) covers ${nameList.slice(0, 6).join(', ')}`;
    const b = new ObservationBuilder({
      kind: 'ct_certificate', source, observedAt, summary,
      raw: { crtsh_id: cert.id, serial: cert.serial_number, issuer: cert.issuer_name, issuer_ca_id: cert.issuer_ca_id, not_before: cert.not_before, not_after: cert.not_after, names: nameList, synthetic },
      confidence: 0.96, provenance,
    }, subject);
    const certRef = b.entity('certificate', `ct:${cert.issuer_ca_id ?? 'x'}:${cert.serial_number ?? cert.id}`, {
      label: `${issuer}: ${nameList.find(n => names.get(n)) ? `*.${nameList.find(n => names.get(n))}` : nameList[0]}${nameList.length > 1 ? ` +${nameList.length - 1}` : ''}`,
      metadata: { issuer, san: nameList.map(n => (names.get(n) ? `*.${n}` : n)), notBefore: cert.not_before, notAfter: cert.not_after, crtshId: cert.id, serial: cert.serial_number },
      firstSeen: toIso(cert.not_before) ?? observedAt,
      lastSeen: toIso(cert.not_after) ?? observedAt,
      isActive: cert.not_after ? Date.parse(cert.not_after) > Date.now() : true,
    });
    const subjectHost = hostnameOf(subject.value).replace(/^www\./, '');
    for (const name of nameList) {
      const isSubject = name === subjectHost;
      const ref = isSubject ? 'subject' : b.entity('domain', name, { metadata: { discoveredIn: 'certificate SAN', wildcardCovered: names.get(name) || undefined }, firstSeen: toIso(cert.not_before) ?? observedAt });
      b.rel(certRef, ref, 'COVERS', `Certificate names ${names.get(name) ? `*.${name}` : name} as a subject alternative name`, 0.96, observedAt);
      if (isSubject) b.rel('subject', certRef, 'CERTIFIED_BY', `${subject.value} is covered by this certificate`, 0.96, observedAt);
    }
    observations.push(b.build());
  }
  return { observations, total, truncated: total > kept.length };
}

function toIso(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = /Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export class CtCollector implements Collector {
  id = 'crtsh';
  name = 'Certificate Transparency (crt.sh)';
  kind = 'passive_public' as const;
  pivotTypes = ['CT_SEARCH', 'CT_PATTERN_SEARCH'];
  description = 'Public certificate transparency logs searched through crt.sh. Reveals certificates, co-certified domains and subdomains.';

  availability(settings: RuntimeSettings) {
    return networkRequired(settings);
  }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (pivotType === 'CT_PATTERN_SEARCH') return this.patternSearch(entity, ctx);
    const reg = registrableDomain(entity.value);
    if (!reg) return emptyResult('Not a domain');
    const urls = [`https://crt.sh/?q=${encodeURIComponent(reg)}&output=json`, `https://crt.sh/?q=${encodeURIComponent(`%.${reg}`)}&output=json`];
    const rows: CrtRow[] = [];
    const seen = new Set<number>();
    for (const url of urls) {
      const res = await ctx.http.json<CrtRow[]>({ url, collector: this.id, ttlSeconds: 12 * 3600, timeoutMs: 45000, bypassCache: ctx.bypassCache, accept404: true });
      for (const row of Array.isArray(res.body) ? res.body : []) {
        if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      }
    }
    const { observations, total, truncated } = certificatesToObservations(entity, rows, `crt.sh identity search for ${reg} and %.${reg}`);
    return { observations, resultVolume: total, truncated };
  }

  /**
   * v2.0 naming-pattern search: which recently certified domains contain the
   * operation's naming tokens? Returns candidates only (weak MATCHES_PATTERN
   * links); membership requires independent evidence.
   */
  private async patternSearch(entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const spec = String(entity.value).replace(/^name:/, '');
    const tokens = spec.split('+').map(t => t.trim().toLowerCase()).filter(t => /^[a-z0-9]{3,}$/.test(t)).slice(0, 3);
    if (tokens.length < 2) return emptyResult('Pattern needs at least two distinctive words');
    const since = entity.metadata?.since ? Date.parse(entity.metadata.since) : Date.now() - 180 * 86400000;
    const known = new Set<string>((entity.metadata?.exclude ?? []) as string[]);
    const q = `%${tokens.join('%')}%`;
    const url = `https://crt.sh/?q=${encodeURIComponent(q)}&output=json`;
    const res = await ctx.http.json<CrtRow[]>({ url, collector: this.id, ttlSeconds: 6 * 3600, timeoutMs: 60000, bypassCache: ctx.bypassCache, accept404: true });
    const rows = Array.isArray(res.body) ? res.body : [];
    const found = new Map<string, string>();
    for (const row of rows) {
      const when = Date.parse(toIso(row.not_before ?? row.entry_timestamp) ?? '');
      if (Number.isFinite(when) && when < since) continue;
      for (const n of String(row.name_value ?? '').split(/\n/)) {
        const norm = normalizeSanName(n);
        if (!norm) continue;
        const d = registrableDomain(norm.host);
        if (!d || known.has(d) || !tokens.every(t => d.includes(t))) continue;
        if (!found.has(d) || String(found.get(d)) > String(row.not_before)) found.set(d, String(row.not_before ?? ''));
      }
    }
    if (!found.size) return { observations: [], resultVolume: 0, note: 'No newly certified look-alike names' };
    const kept = [...found.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 30);
    const b = new ObservationBuilder({
      kind: 'ct_pattern_match', source: 'crt.sh', observedAt: new Date().toISOString(),
      summary: `${found.size} domain${found.size === 1 ? '' : 's'} certified since ${new Date(since).toISOString().slice(0, 10)} contain the operation's naming words (${tokens.join(' + ')}): ${kept.slice(0, 6).map(k => k[0]).join(', ')}${found.size > 6 ? ' …' : ''}`,
      raw: { tokens, since: new Date(since).toISOString(), domains: kept.map(k => ({ domain: k[0], notBefore: k[1] })), total: found.size }, confidence: 0.3, provenance: `crt.sh name search ${q}`,
    }, entity);
    for (const [d, nb] of kept) b.rel(b.entity('domain', d, { metadata: { discoveredIn: 'naming-pattern search', certifiedAt: nb }, firstSeen: toIso(nb) ?? undefined }), 'subject', 'MATCHES_PATTERN', `${d} contains the words ${tokens.join(' + ')} and was certified ${String(nb).slice(0, 10)}`, 0.3);
    return { observations: [b.build()], resultVolume: found.size, truncated: found.size > kept.length };
  }
}
