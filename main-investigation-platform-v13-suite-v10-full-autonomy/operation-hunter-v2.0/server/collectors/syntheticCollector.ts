import type { Entity } from '../types.js';
import type { CollectorResult, Observation } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, emptyResult } from './base.js';
import { buildWorld, renderDemoPage, World, worldTime } from '../demo/world.js';
import { certificatesToObservations } from './ctCollector.js';
import { rdapDomainObservation, ipProfileObservation, reverseObservations } from './registryCollectors.js';
import { sharedResourceResult, siteProfileResult } from './urlscanCollector.js';
import { transfersToObservations, addressProfileObservation, Transfer } from './chainCollectors.js';
import { artifactObservations } from './artifact.js';
import { canonicalize, hostnameOf, registrableDomain } from '../core/canonical.js';

export const DEMO_PROVENANCE = 'DEMO WORLD (synthetic, not real data)';

/**
 * Serves every pivot type from the deterministic demo world (see demo/world.ts).
 * Used only for operations flagged as demo, and by the test-suite. Results use
 * the same parsers as the real collectors, so the full pipeline is exercised.
 */
export class SyntheticCollector implements Collector {
  id = 'demo';
  name = 'Demo world (synthetic)';
  kind = 'synthetic' as const;
  pivotTypes = ['DNS_RESOLVE', 'CT_SEARCH', 'RDAP_DOMAIN', 'IP_PROFILE', 'REVERSE_IP', 'REVERSE_NS', 'SITE_PROFILE', 'SHARED_RESOURCE', 'TRACKER_REUSE', 'WALLET_TRACE', 'WALLET_PROFILE'];
  description = 'Synthetic demonstration data for demo operations only. Never used for real operations.';
  private worlds = new Map<string, World>();

  availability() { return { ok: true }; }

  world(ctx: CollectorContext): World {
    const baseIso = ctx.store.getMeta(`demo_base:${ctx.operationId}`) ?? ctx.store.getMeta('demo_base') ?? new Date().toISOString();
    let w = this.worlds.get(baseIso);
    if (!w) this.worlds.set(baseIso, (w = buildWorld(baseIso)));
    return w;
  }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    const w = this.world(ctx);
    const late = Boolean(ctx.bypassCache); // monitor runs "see" the newest infrastructure
    const t = (d: number) => worldTime(w, d);
    const prov = (what: string) => `${DEMO_PROVENANCE} — ${what}`;
    const mark = (r: CollectorResult): CollectorResult => ({ ...r, observations: r.observations.map(o => ({ ...o, raw: { ...o.raw, synthetic: true } })) });
    switch (pivotType) {
      case 'DNS_RESOLVE': {
        const host = hostnameOf(entity.value);
        const d = w.domains[host.replace(/^www\./, '')];
        if (!d || (d.late && !late)) return emptyResult('No DNS records (demo world)');
        const obs: Observation[] = [];
        const at = new Date().toISOString();
        if (d.activeNow && d.a?.length) {
          const b = new ObservationBuilder({ kind: 'dns_a', source: 'demo:dns', observedAt: at, summary: `${host} currently resolves to ${d.a.join(', ')}`, raw: { host, A: d.a }, confidence: 0.97, provenance: prov(`DNS query for ${host}`) }, entity);
          b.subject({ isActive: true, lastSeen: at });
          for (const ip of d.a) b.rel('subject', b.entity('ip', ip), 'RESOLVES_TO', `DNS A record for ${host} points to ${ip}`);
          obs.push(b.build());
        }
        if (d.ns.length && (d.activeNow || d.status?.length === 0 || !d.status)) {
          const b = new ObservationBuilder({ kind: 'dns_ns', source: 'demo:dns', observedAt: at, summary: `${host} delegates DNS to ${d.ns.join(', ')}`, raw: { host, NS: d.ns }, confidence: 0.97, provenance: prov(`DNS NS query for ${host}`) }, entity);
          for (const ns of d.ns) b.rel('subject', b.entity('nameserver', ns), 'DELEGATED_TO', `NS record for ${host} names ${ns}`);
          obs.push(b.build());
        }
        if (d.txt?.length && d.activeNow) {
          const b = new ObservationBuilder({ kind: 'dns_txt_verification', source: 'demo:dns', observedAt: at, summary: `${host} publishes account verification tokens`, raw: { host, TXT: d.txt }, confidence: 0.95, provenance: prov(`DNS TXT query for ${host}`) }, entity);
          for (const txt of d.txt) b.rel('subject', b.entity('identifier', txt, { metadata: { identifierKind: 'verification_token' } }), 'USES_IDENTIFIER', 'TXT verification token');
          obs.push(b.build());
        }
        if (!d.activeNow || !obs.length) {
          const b = new ObservationBuilder({ kind: 'dns_no_answer', source: 'demo:dns', observedAt: at, summary: `${host} returned no A records (inactive, parked or taken down)`, raw: { host }, confidence: 0.8, provenance: prov(`DNS query for ${host}`) }, entity);
          b.subject({ isActive: false, metadata: { dnsStatus: 'no_answer' } });
          obs.push(b.build());
        }
        return mark({ observations: obs, resultVolume: (d.a?.length ?? 0) + d.ns.length });
      }
      case 'CT_SEARCH': {
        const reg = registrableDomain(entity.value);
        const rows = w.certs.filter(c => (!c.late || late) && c.names.some(n => registrableDomain(n.replace(/^\*\./, '')) === reg)).map(c => ({
          id: c.id, issuer_ca_id: c.issuerCaId, issuer_name: c.issuer, common_name: c.names[0], name_value: c.names.join('\n'),
          entry_timestamp: t(c.notBefore).replace('Z', ''), not_before: t(c.notBefore).slice(0, 19), not_after: t(c.notAfter).slice(0, 19), serial_number: c.serial,
        }));
        const r = certificatesToObservations(entity, rows, prov(`crt.sh search for ${reg}`), 'demo:crt.sh', true);
        return mark({ observations: r.observations, resultVolume: r.total });
      }
      case 'RDAP_DOMAIN': {
        const d = w.domains[registrableDomain(entity.value)];
        if (!d || (d.late && !late)) return emptyResult('No registration record (demo world)');
        const body = {
          ldhName: d.name, status: d.status ?? ['client transfer prohibited'],
          events: [{ eventAction: 'registration', eventDate: t(d.registered) }, { eventAction: 'expiration', eventDate: t(d.registered + 365) }],
          nameservers: d.ns.map(ns => ({ ldhName: ns.toUpperCase() })),
          entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', d.registrar]]] }, { roles: ['registrant'], vcardArray: ['vcard', [['org', {}, 'text', 'REDACTED FOR PRIVACY'], ['email', {}, 'text', 'redacted@privacy.example']]] }],
        };
        return mark({ observations: [rdapDomainObservation(entity, body, prov(`RDAP lookup for ${d.name}`), 'demo:rdap')], resultVolume: 1 });
      }
      case 'IP_PROFILE': {
        const ip = w.ips[entity.value];
        if (!ip) return emptyResult('Unknown IP (demo world)');
        return mark({ observations: [ipProfileObservation(entity, { asns: [{ asn: ip.asn, holder: ip.holder }], resource: ip.prefix, announced: true }, ip.country, prov(`RIPEstat prefix-overview for ${ip.ip}`), 'demo:ripestat')], resultVolume: 1 });
      }
      case 'REVERSE_IP': {
        const ip = w.ips[entity.value];
        if (!ip) return emptyResult('No reverse data (demo world)');
        if (ip.reverseVolume) {
          const fake = Array.from({ length: 40 }, (_, i) => `shared-site-${i}.example`);
          return mark({ ...reverseObservations(entity, 'REVERSE_IP', fake, prov(`reverse IP lookup for ${ip.ip}`), 'demo:reverse-ip'), resultVolume: ip.reverseVolume });
        }
        const list = (ip.reverse ?? []).filter(d => late || !w.domains[d]?.late);
        return mark(reverseObservations(entity, 'REVERSE_IP', list, prov(`reverse IP lookup for ${ip.ip}`), 'demo:reverse-ip'));
      }
      case 'REVERSE_NS': {
        const ns = w.nsReverse[entity.value];
        if (!ns) return emptyResult('No reverse NS data (demo world)');
        if (ns.volume) return mark({ observations: [], resultVolume: ns.volume, note: `${ns.volume.toLocaleString()} domains use this nameserver` });
        const list = ns.domains.filter(d => late || !w.domains[d]?.late);
        return mark(reverseObservations(entity, 'REVERSE_NS', list, prov(`shared-nameserver lookup for ${entity.value}`), 'demo:reverse-ns'));
      }
      case 'SITE_PROFILE': {
        const d = w.domains[registrableDomain(entity.value)] ?? w.domains[hostnameOf(entity.value)];
        if (!d?.scan || (d.late && !late)) return emptyResult('No public scans (demo world)');
        const scanAt = t(d.scan.at);
        const hit = { _id: `demo-scan-${d.name}`, task: { time: scanAt, domain: d.name }, page: { domain: d.name, ip: d.scan.ip, asn: `AS${w.ips[d.scan.ip]?.asn ?? ''}`, asnname: w.ips[d.scan.ip]?.holder, country: w.ips[d.scan.ip]?.country, server: d.scan.server, title: d.scan.title, url: `https://${d.name}/` } };
        const detail = { page: hit.page, data: { requests: d.scan.resources.map(r => ({ response: { hash: w.resources[r].hash, response: { url: `https://${d.name}${w.resources[r].url}`, mimeType: w.resources[r].mime } } })) } };
        const profile = siteProfileResult(entity, hit, detail, prov(`passive scan of ${d.name} (${scanAt.slice(0, 10)})`), 'demo:urlscan');
        // Page content as a site check would capture it -> real HTML fingerprinting.
        const tpl = w.templates[d.scan.template];
        const page = artifactObservations(entity, renderDemoPage(w, d), { source: 'demo:site-capture', provenance: prov(`captured page source of ${d.name}`), observedAt: scanAt, label: 'Captured page' })
          .map(o => ({ ...o, entities: o.entities.map(e => e.type === 'template' ? { ...e, label: `${tpl.kitFamily} ${tpl.variant} — ${e.label}`, metadata: { ...(e.metadata ?? {}), kitFamily: tpl.kitFamily, variant: tpl.variant, familySource: 'demo classification' } } : e) }));
        // label kit resources
        for (const o of profile.observations) {
          o.entities = o.entities.map(e => {
            if (e.type !== 'artifact') return e;
            const hash = String(e.value).replace(/^sha256:/, '');
            const r = Object.values(w.resources).find(x => x.hash === hash);
            return r ? { ...e, label: r.label, metadata: { ...(e.metadata ?? {}), sha256: hash, commonLibrary: r.label.includes('common library') || undefined } } : e;
          });
        }
        return mark({ observations: [...profile.observations, ...page], resultVolume: profile.resultVolume });
      }
      case 'SHARED_RESOURCE': {
        if (entity.type === 'template') {
          // Pages rendered from the same world template share one structural hash.
          const variant = entity.metadata?.variant;
          const kit = entity.metadata?.kitFamily;
          const hits = Object.values(w.domains).filter(d => d.scan && (late || !d.late) && w.templates[d.scan.template].kitFamily === kit && w.templates[d.scan.template].variant === variant);
          return mark(sharedResourceResult(entity, hits.map(d => ({ domain: d.name, time: t(d.scan!.at) })), hits.length, prov(`page-structure search for ${entity.value}`), 'demo:urlscan'));
        }
        const hash = String(entity.metadata?.sha256 ?? entity.value.replace(/^sha256:/, ''));
        const key = Object.keys(w.resources).find(k => w.resources[k].hash === hash);
        if (!key) return emptyResult('Resource not indexed (demo world)');
        if (key === 'jquery') return mark({ observations: [], resultVolume: 250000, note: 'Common library loaded by a very large number of sites' });
        const hits = Object.values(w.domains).filter(d => d.scan && (late || !d.late) && d.scan.resources.includes(key));
        return mark(sharedResourceResult(entity, hits.map(d => ({ domain: d.name, time: t(d.scan!.at) })), hits.length, prov(`resource hash search for ${hash.slice(0, 16)}…`), 'demo:urlscan'));
      }
      case 'TRACKER_REUSE': {
        const key = entity.type === 'identifier' ? canonicalize('identifier', entity.value) : entity.value.toLowerCase();
        const list = w.trackers[key] ?? w.trackers[entity.value] ?? [];
        const domains = list.filter(d => late || !w.domains[d]?.late);
        if (!domains.length) return emptyResult('Identifier not seen elsewhere (demo world)');
        const b = new ObservationBuilder({ kind: 'identifier_reuse', source: 'demo:tracker-search', observedAt: new Date().toISOString(), summary: `${entity.value} appears on ${domains.length} site${domains.length === 1 ? '' : 's'}: ${domains.join(', ')}`, raw: { domains }, confidence: 0.9, provenance: prov(`identifier search for ${entity.value}`) }, entity);
        for (const d of domains) b.rel(b.entity('domain', d, { metadata: { discoveredIn: 'identifier reuse' } }), 'subject', 'USES_IDENTIFIER', `${d} embeds ${entity.value}`, 0.9);
        return mark({ observations: [b.build()], resultVolume: domains.length });
      }
      case 'WALLET_TRACE': {
        const addr = entity.value.toLowerCase();
        const involved = w.transfers.filter(x => (late || !x.late) && (x.from.toLowerCase() === addr || x.to.toLowerCase() === addr));
        if (!involved.length) return emptyResult('No transfers (demo world)');
        const obs: Observation[] = [];
        for (const network of Array.from(new Set(involved.map(x => x.network)))) {
          const transfers: Transfer[] = involved.filter(x => x.network === network).map(x => ({
            hash: x.hash, from: x.from, to: x.to, amount: x.amount, symbol: x.symbol, timestamp: t(x.at), method: x.method, usd: x.usd,
            fromLabel: w.labels[x.from.toLowerCase()]?.label ?? w.wallets[x.from]?.name, toLabel: w.labels[x.to.toLowerCase()]?.label ?? w.wallets[x.to]?.name,
            fromIsContract: w.wallets[x.from]?.isContract, toIsContract: w.wallets[x.to]?.isContract,
          }));
          obs.push(...transfersToObservations(entity, transfers, network, prov(`${network} transfer history for ${entity.value}`), `demo:${network}`, a => w.labels[a.toLowerCase()] ?? ctx.store.getLabel(a)));
        }
        return mark({ observations: obs, resultVolume: involved.length });
      }
      case 'WALLET_PROFILE': {
        const info = w.wallets[entity.value.toLowerCase()] ?? w.wallets[entity.value];
        if (!info) return emptyResult('No profile (demo world)');
        return mark({ observations: [addressProfileObservation(entity, { is_contract: info.isContract, name: info.name, creator_address_hash: info.creator, creation_transaction_hash: info.creationTx, is_verified: info.verified, public_tags: (info.tags ?? []).map(n => ({ display_name: n })) }, info.network, prov(`address profile for ${entity.value}`), `demo:${info.network}`)], resultVolume: 1 });
      }
      default:
        return emptyResult('Pivot not modelled in the demo world');
    }
  }

  /** Labels for demo addresses (so exits are recognised). */
  demoLabels(ctx: CollectorContext) {
    return this.world(ctx).labels;
  }
}
