import type { Entity } from '../types.js';
import type { CollectorResult, Observation } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult } from './base.js';
import { hostnameOf, registrableDomain } from '../core/canonical.js';
import { staticUbiquity } from '../engine/noise.js';
import { reverseObservations } from './registryCollectors.js';
import { artifactObservations } from './artifact.js';

/**
 * urlscan.io passive scan archive. Hunter only *reads existing public scans*;
 * it never submits a new scan (which would make urlscan visit the site).
 * Provides page fingerprints (server, title, loaded resources and their
 * SHA-256 hashes) and reverse searches by resource hash or IP.
 */
export class UrlscanCollector implements Collector {
  id = 'urlscan';
  name = 'Passive scan archive (urlscan.io)';
  kind = 'passive_public' as const;
  pivotTypes = ['SITE_PROFILE', 'SHARED_RESOURCE', 'REVERSE_IP', 'TITLE_SEARCH'];
  description = 'Existing public urlscan.io scans: page title, server, loaded scripts and their hashes, the archived page content (analysed for operator settings and wallet-drain behaviour), and other sites loading the same files. Hunter only reads existing scans. An API key (Settings) raises rate limits.';

  availability(settings: RuntimeSettings) {
    if (settings.networkMode !== 'live') return { ok: false, reason: 'Offline mode' };
    return { ok: true };
  }

  private headers(ctx: CollectorContext) {
    const key = ctx.settings.apiKeys.urlscan;
    return key ? { 'API-Key': key } : undefined;
  }

  private async search(ctx: CollectorContext, query: string, size = 50) {
    const url = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=${size}`;
    const res = await ctx.http.json<any>({ url, collector: this.id, headers: this.headers(ctx), ttlSeconds: 12 * 3600, bypassCache: ctx.bypassCache });
    return { url, results: (res.body?.results ?? []) as any[], total: Number(res.body?.total ?? (res.body?.results ?? []).length) };
  }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (pivotType === 'REVERSE_IP') {
      const { url, results, total } = await this.search(ctx, `page.ip:"${entity.value}"`, 100);
      const domains = Array.from(new Set(results.map(r => hostnameOf(r?.page?.domain ?? r?.task?.domain ?? '')).filter(Boolean)));
      const out = reverseObservations(entity, 'REVERSE_IP', domains, `urlscan search ${url}`, 'urlscan');
      return { ...out, resultVolume: Math.max(total, domains.length) };
    }
    if (pivotType === 'TITLE_SEARCH') {
      const title = String(entity.value).replace(/^title:/, '').replace(/"/g, '').trim();
      if (title.length < 10) return emptyResult('Title too short to be distinctive');
      const { url, results, total } = await this.search(ctx, `page.title:"${title}"`, 100);
      const domains = Array.from(new Set(results.map(r => hostnameOf(r?.page?.domain ?? r?.task?.domain ?? '')).filter(Boolean)));
      if (!domains.length) return { observations: [], resultVolume: 0, note: 'No other archived pages with this title' };
      const kept = domains.slice(0, 30);
      const b = new ObservationBuilder({ kind: 'title_match', source: 'urlscan', observedAt: new Date().toISOString(), summary: `${domains.length} archived page${domains.length === 1 ? '' : 's'} titled "${title.slice(0, 60)}": ${kept.slice(0, 6).join(', ')}`, raw: { title, domains: kept, total }, confidence: 0.4, provenance: `urlscan search ${url}` }, entity);
      for (const d of kept) b.rel(b.entity('domain', d, { metadata: { discoveredIn: 'page-title search' } }), 'subject', 'MATCHES_PATTERN', `An archived scan of ${d} has the same page title`, 0.4);
      return { observations: [b.build()], resultVolume: Math.max(total, domains.length) };
    }
    if (pivotType === 'SHARED_RESOURCE') {
      const hash = String(entity.metadata?.sha256 ?? entity.value).replace(/^sha256:/i, '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) return emptyResult('No SHA-256 resource hash to search for');
      const { url, results, total } = await this.search(ctx, `hash:${hash}`, 100);
      return sharedResourceResult(entity, results.map(r => ({ domain: r?.page?.domain ?? r?.task?.domain, time: r?.task?.time })), total, `urlscan search ${url}`, 'urlscan');
    }
    // SITE_PROFILE
    const domain = hostnameOf(entity.value);
    const { results } = await this.search(ctx, `page.domain:${domain} OR task.domain:${domain}`, 10);
    if (!results.length) return emptyResult(`No public scans of ${domain} in urlscan.io`);
    const newest = results.sort((a, b) => String(b?.task?.time ?? '').localeCompare(String(a?.task?.time ?? '')))[0];
    let detail: any = null;
    const resultUrl = newest?.result ?? (newest?._id ? `https://urlscan.io/api/v1/result/${newest._id}/` : null);
    if (resultUrl) {
      try {
        detail = (await ctx.http.json<any>({ url: resultUrl, collector: this.id, headers: this.headers(ctx), ttlSeconds: 7 * 86400, bypassCache: ctx.bypassCache, accept404: true })).body;
      } catch { /* the search hit alone is still useful */ }
    }
    const profile = siteProfileResult(entity, newest, detail, `urlscan scan ${newest?._id ?? ''} (${newest?.task?.time ?? 'unknown time'})`, 'urlscan');
    // v2.0: read the page content urlscan archived at scan time (never the live site) and fingerprint it:
    // page structure, wallet-drain behaviour, and the operator settings embedded in it (analytics account,
    // support handles, receiving wallets, WalletConnect project).
    if (newest?._id && ctx.settings.archivedContent !== false) {
      try {
        const dom = await ctx.http.text({ url: `https://urlscan.io/dom/${newest._id}/`, collector: this.id, headers: this.headers(ctx), ttlSeconds: 30 * 86400, bypassCache: ctx.bypassCache, accept404: true });
        const html = typeof dom.body === 'string' ? dom.body : '';
        if (dom.status !== 404 && html.length > 40 && /<html|<body|<div/i.test(html)) {
          profile.observations.push(...artifactObservations(entity, html.slice(0, 2_000_000), { source: 'urlscan', provenance: `Archived page content (DOM) of urlscan scan ${newest._id}`, observedAt: newest?.task?.time, label: 'Archived page content' }));
          profile.resultVolume += 1;
        }
      } catch { /* archived content is optional */ }
    }
    return profile;
  }
}

export function sharedResourceResult(entity: Entity, hits: Array<{ domain?: string; time?: string }>, total: number, provenance: string, source: string): CollectorResult {
  const domains = Array.from(new Set(hits.map(h => hostnameOf(h.domain ?? '')).filter(Boolean)));
  if (!domains.length) return { observations: [], resultVolume: total };
  const kept = domains.slice(0, 40);
  const b = new ObservationBuilder({
    kind: 'shared_resource', source, observedAt: hits.map(h => h.time).filter(Boolean).sort().pop() ?? new Date().toISOString(),
    summary: `${domains.length} site${domains.length === 1 ? '' : 's'} loaded the same file/page structure ${entity.label || entity.value}: ${kept.slice(0, 8).join(', ')}${kept.length > 8 ? ' …' : ''}`,
    raw: { domains: kept, total }, confidence: 0.85, provenance,
  }, entity);
  for (const d of kept) b.rel(b.entity('domain', d, { metadata: { discoveredIn: 'shared resource' } }), 'subject', entity.type === 'template' ? 'EXECUTES_TEMPLATE' : 'SHARES_RESOURCE', `${d} loaded the identical resource`, 0.85);
  return { observations: [b.build()], resultVolume: Math.max(total, domains.length), truncated: domains.length > kept.length };
}

/** Turn a urlscan search hit (+ optional full result) into site-profile observations. */
export function siteProfileResult(entity: Entity, hit: any, detail: any, provenance: string, source: string): CollectorResult {
  const observations: Observation[] = [];
  const page = detail?.page ?? hit?.page ?? {};
  const at = hit?.task?.time ?? new Date().toISOString();
  const domain = hostnameOf(entity.value);
  const b = new ObservationBuilder({
    kind: 'site_scan', source, observedAt: at,
    summary: `Scan of ${domain} on ${String(at).slice(0, 10)}: title "${String(page.title ?? '').slice(0, 80)}", server ${page.server ?? 'unknown'}, IP ${page.ip ?? 'unknown'}${page.asnname ? ` (${page.asnname})` : ''}`,
    raw: { page: { title: page.title, server: page.server, ip: page.ip, asn: page.asn, asnname: page.asnname, country: page.country, url: page.url, status: page.status }, scanId: hit?._id, verdict: detail?.verdicts?.overall },
    confidence: 0.9, provenance,
  }, entity);
  b.subject({ metadata: { pageTitle: page.title, server: page.server, lastScanAt: at } });
  if (page.ip) {
    const ipRef = b.entity('ip', page.ip, { metadata: { asn: page.asn, asnHolder: page.asnname, country: page.country } });
    b.rel('subject', ipRef, 'RESOLVES_TO', `At scan time the site was served from ${page.ip}`, 0.9, at);
  }
  const finalHost = hostnameOf(page.url ?? '');
  if (finalHost && registrableDomain(finalHost) !== registrableDomain(domain)) {
    b.rel('subject', b.entity('domain', finalHost, { metadata: { discoveredIn: 'redirect' } }), 'REDIRECTS_TO', `Visiting ${domain} ended on ${finalHost}`, 0.9, at);
  }
  observations.push(b.build());

  // Loaded resources: keep scripts/documents not served by commodity CDNs.
  const requests: any[] = detail?.data?.requests ?? [];
  const resources = new Map<string, { hash: string; url: string; mime: string; host: string }>();
  for (const r of requests) {
    const resp = r?.response;
    const hash = resp?.hash;
    const url = resp?.response?.url ?? r?.request?.request?.url ?? '';
    const mime = String(resp?.response?.mimeType ?? '');
    if (!hash || !/javascript|html|json|wasm/i.test(mime)) continue;
    const host = hostnameOf(url);
    if (staticUbiquity('domain', host).ubiquity >= 0.9) continue;
    resources.set(hash, { hash, url, mime, host });
  }
  if (resources.size) {
    const rb = new ObservationBuilder({
      kind: 'site_resources', source, observedAt: at,
      summary: `${domain} loaded ${resources.size} non-CDN script/page resource${resources.size === 1 ? '' : 's'}: ${[...resources.values()].slice(0, 4).map(r => r.url.split('/').pop() || r.url).join(', ')}`,
      raw: { resources: [...resources.values()].slice(0, 40) }, confidence: 0.9, provenance,
    }, entity);
    for (const res of [...resources.values()].slice(0, 25)) {
      const name = res.url.split('?')[0].split('/').pop() || res.host;
      const ref = rb.entity('artifact', `sha256:${res.hash}`, { label: `${name} (${res.hash.slice(0, 10)}…)`, metadata: { sha256: res.hash, url: res.url, mime: res.mime } });
      rb.rel('subject', ref, 'SHARES_RESOURCE', `Page loaded ${res.url}`, 0.9, at);
      if (res.host && registrableDomain(res.host) !== registrableDomain(domain)) {
        rb.rel('subject', rb.entity('domain', res.host, { metadata: { role: 'script/resource host', discoveredIn: 'loaded resource' } }), 'MENTIONS', `Page loads code from ${res.host}`, 0.8, at);
      }
    }
    observations.push(rb.build());
  }
  return { observations, resultVolume: 1 + resources.size };
}
