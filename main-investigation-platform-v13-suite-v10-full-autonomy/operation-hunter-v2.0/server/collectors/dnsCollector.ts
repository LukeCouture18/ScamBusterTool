import dns from 'node:dns';
import type { Entity } from '../types.js';
import type { CollectorResult } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult, networkRequired } from './base.js';
import { nowIso } from '../core/util.js';
import { hostnameOf } from '../core/canonical.js';

const VERIFICATION_TOKENS = /^(google-site-verification|facebook-domain-verification|yandex-verification|ms|MS|apple-domain-verification|atlassian-domain-verification|tiktok-developers-site-verification|zoho-verification|have-i-been-pwned-verification)=(.+)$/;

/**
 * Live DNS resolution through the system (or configured) resolver.
 * Resolving public DNS is passive: it asks recursive resolvers what the
 * domain publicly advertises and never contacts the website itself.
 */
export class DnsCollector implements Collector {
  id = 'dns';
  name = 'DNS resolver';
  kind = 'passive_public' as const;
  pivotTypes = ['DNS_RESOLVE'];
  description = 'Public DNS records (A, AAAA, NS, MX, TXT, CNAME) via your system resolver or the servers set in Settings.';

  availability(settings: RuntimeSettings) {
    return networkRequired(settings);
  }

  async execute(_pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const host = hostnameOf(entity.value);
    if (!host) return emptyResult('Not a resolvable hostname');
    const resolver = ctx.dnsResolver ?? new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    if (!ctx.dnsResolver && ctx.settings.dnsServers.length) resolver.setServers(ctx.settings.dnsServers);
    const at = nowIso();
    const q = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (error: any) {
        if (['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'NXDOMAIN', 'ENOTIMP', 'EREFUSED'].includes(error?.code)) return null;
        if (error?.code === 'ETIMEOUT' || error?.code === 'ECONNREFUSED') throw Object.assign(new Error(`DNS ${error.code}`), { retryable: true });
        return null;
      }
    };
    const types = entity.type === 'domain' ? ['A', 'AAAA', 'NS', 'MX', 'TXT', 'CNAME'] : ['A', 'AAAA'];
    const answers: Record<string, any> = {};
    for (const t of types) {
      answers[t] = await q(() => {
        switch (t) {
          case 'A': return resolver.resolve4(host);
          case 'AAAA': return resolver.resolve6(host);
          case 'NS': return resolver.resolveNs(host);
          case 'MX': return resolver.resolveMx(host);
          case 'TXT': return resolver.resolveTxt(host);
          case 'CNAME': return resolver.resolveCname(host);
          default: return Promise.resolve(null);
        }
      });
    }
    const provenance = `DNS query for ${host} (${types.join('/')}) via ${ctx.settings.dnsServers.length ? ctx.settings.dnsServers.join(',') : 'system resolver'}`;
    const observations = [];
    const addresses: string[] = [...(answers.A ?? []), ...(answers.AAAA ?? [])];
    if (addresses.length) {
      const b = new ObservationBuilder({ kind: 'dns_a', source: 'dns', observedAt: at, summary: `${host} currently resolves to ${addresses.join(', ')}`, raw: { host, A: answers.A ?? [], AAAA: answers.AAAA ?? [] }, confidence: 0.97, provenance }, entity);
      b.subject({ isActive: true, lastSeen: at });
      for (const ip of addresses) b.rel('subject', b.entity('ip', ip), 'RESOLVES_TO', `DNS A/AAAA record for ${host} points to ${ip}`);
      observations.push(b.build());
    }
    if (answers.CNAME?.length) {
      const b = new ObservationBuilder({ kind: 'dns_cname', source: 'dns', observedAt: at, summary: `${host} is an alias (CNAME) of ${answers.CNAME.join(', ')}`, raw: { host, CNAME: answers.CNAME }, confidence: 0.97, provenance }, entity);
      for (const target of answers.CNAME) b.rel('subject', b.entity('hostname', hostnameOf(target)), 'REDIRECTS_TO', `CNAME record points ${host} at ${target}`);
      observations.push(b.build());
    }
    if (answers.NS?.length) {
      const b = new ObservationBuilder({ kind: 'dns_ns', source: 'dns', observedAt: at, summary: `${host} delegates DNS to ${answers.NS.join(', ')}`, raw: { host, NS: answers.NS }, confidence: 0.97, provenance }, entity);
      for (const ns of answers.NS) b.rel('subject', b.entity('nameserver', hostnameOf(ns)), 'DELEGATED_TO', `NS record for ${host} names ${ns}`);
      observations.push(b.build());
    }
    if (answers.MX?.length) {
      const mx = (answers.MX as Array<{ exchange: string; priority: number }>).filter(m => m.exchange);
      if (mx.length) {
        const b = new ObservationBuilder({ kind: 'dns_mx', source: 'dns', observedAt: at, summary: `${host} receives mail via ${mx.map(m => m.exchange).join(', ')}`, raw: { host, MX: mx }, confidence: 0.95, provenance }, entity);
        for (const m of mx) b.rel('subject', b.entity('hostname', hostnameOf(m.exchange)), 'USES_MAIL_SERVER', `MX record (priority ${m.priority}) names ${m.exchange}`);
        observations.push(b.build());
      }
    }
    if (answers.TXT?.length) {
      const records = (answers.TXT as string[][]).map(parts => parts.join(''));
      const tokens = records.map(r => VERIFICATION_TOKENS.exec(r)).filter(Boolean) as RegExpExecArray[];
      if (tokens.length) {
        const b = new ObservationBuilder({ kind: 'dns_txt_verification', source: 'dns', observedAt: at, summary: `${host} publishes account verification tokens: ${tokens.map(t => t[1]).join(', ')}`, raw: { host, TXT: records }, confidence: 0.95, provenance }, entity);
        for (const t of tokens) b.rel('subject', b.entity('identifier', `${t[1]}=${t[2]}`, { label: `${t[1]} token`, metadata: { identifierKind: 'verification_token', service: t[1] } }), 'USES_IDENTIFIER', `TXT record carries a ${t[1]} account token — set by whoever controls the site’s accounts`);
        observations.push(b.build());
      }
    }
    if (!observations.length) {
      const b = new ObservationBuilder({ kind: 'dns_no_answer', source: 'dns', observedAt: at, summary: `${host} returned no public DNS records at ${at.slice(0, 16)}Z (inactive, parked or taken down)`, raw: { host, answers }, confidence: 0.8, provenance }, entity);
      b.subject({ isActive: false, metadata: { dnsStatus: 'no_answer' } });
      observations.push(b.build());
    }
    return { observations, resultVolume: addresses.length + (answers.NS?.length ?? 0) };
  }
}
