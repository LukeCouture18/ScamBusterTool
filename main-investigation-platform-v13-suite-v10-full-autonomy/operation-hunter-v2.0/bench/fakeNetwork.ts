import { World, WorldDomain, currentIps, currentNs, dayIso, everIps, isRegistered, siteResources } from './world.ts';

/**
 * Serves a ground-truth World through the response formats of the real public
 * APIs Hunter queries: crt.sh, rdap.org, a DNS resolver, RIPEstat,
 * HackerTarget, urlscan.io (search, result, archived DOM) and Blockscout.
 * Answers always reflect the world's *current* day, so advancing the world
 * produces takedowns, new domains and moved hosting.
 */
export interface FakeNetwork {
  fetch: (url: string, init?: any) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
  resolver: any;
  requests: string[];
  count(host?: string): number;
}

export const PACED_HOSTS = ['crt.sh', 'api.hackertarget.com', 'urlscan.io', 'api.trongrid.io', 'rdap.org', 'stat.ripe.net', 'eth.blockscout.com', 'arbitrum.blockscout.com', 'base.blockscout.com', 'optimism.blockscout.com', 'polygon.blockscout.com', 'gnosis.blockscout.com', 'mempool.space'];

export function fakeNetwork(w: World): FakeNetwork {
  const requests: string[] = [];
  const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (typeof body === 'string' ? 'text/plain' : 'application/json') : null) }, text: async () => text };
  };
  const domains = () => [...w.domains.values()];
  const iso = (day: number) => dayIso(w, day);
  const regOf = (host: string) => host.replace(/^www\./, '');

  const crtRows = (pred: (name: string) => boolean) => w.certs.filter(c => c.day <= w.day && c.names.some(pred)).map(c => ({
    id: c.id, issuer_ca_id: 1000 + (c.issuer.length % 7), issuer_name: c.issuer, common_name: c.names[0], name_value: c.names.join('\n'),
    entry_timestamp: iso(c.day).replace('Z', ''), not_before: iso(c.day).slice(0, 19), not_after: iso(c.day + 90).slice(0, 19), serial_number: c.serial,
  }));
  const like = (pattern: string) => new RegExp(`^${pattern.split('%').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

  const scanId = (d: WorldDomain) => `scan-${w.seed}-${d.name.replace(/[^a-z0-9]/g, '')}`;
  const scanOf = (id: string) => domains().find(d => scanId(d) === id);
  const scanned = () => domains().filter(d => d.scanned && d.scanDay !== null && d.scanDay <= w.day && (d.kit || d.role !== 'core'));
  const hit = (d: WorldDomain) => ({ _id: scanId(d), task: { domain: d.name, time: iso(d.scanDay!) }, page: { domain: d.name, ip: d.scanIp, asn: `AS${w.ips.get(d.scanIp ?? '')?.asn ?? ''}`, asnname: w.ips.get(d.scanIp ?? '')?.holder, country: w.ips.get(d.scanIp ?? '')?.country, server: 'nginx', title: d.title, url: `https://${d.name}/`, status: '200' }, result: `https://urlscan.io/api/v1/result/${scanId(d)}/` });

  const reverseIp = (ip: string) => {
    const info = w.ips.get(ip);
    const own = domains().filter(d => isRegistered(d, w.day) && everIps(d, w.day).includes(ip)).map(d => d.name);
    if (info?.commodity) return [...own, ...Array.from({ length: 1200 }, (_, i) => `customer-site-${i}.com`)];
    return own;
  };
  const reverseNs = (ns: string) => {
    const own = domains().filter(d => isRegistered(d, w.day) && d.ns.includes(ns)).map(d => d.name);
    if (/cloudflare|hostinger|bluehost|ovh/.test(ns)) return [...own, ...Array.from({ length: 2400 }, (_, i) => `ns-customer-${i}.net`)];
    return own;
  };

  const address = (a: string) => {
    const wal = w.wallets.get(a.toLowerCase());
    const txs = w.transfers.filter(t => t.day <= w.day && (t.from === a || t.to === a));
    return { wal, txs };
  };

  async function fetchImpl(url: string) {
    requests.push(url);
    const u = new URL(url);
    const host = u.hostname;
    try {
      if (host === 'crt.sh') {
        const q = (u.searchParams.get('q') ?? '').toLowerCase();
        if (q.includes('%')) {
          const re = like(q);
          const rows = crtRows(n => re.test(n));
          return reply(200, rows.slice(0, 1000));
        }
        return reply(200, crtRows(n => regOf(n) === q || n.endsWith(`.${q}`)));
      }
      if (host === 'rdap.org') {
        const name = decodeURIComponent(u.pathname.split('/').pop() ?? '').toLowerCase();
        const d = w.domains.get(name);
        if (!d || !isRegistered(d, w.day)) return reply(404, { errorCode: 404, title: 'Not Found' });
        const held = d.takedown === 'registry' && d.liveTo !== null && d.liveTo <= w.day;
        return reply(200, {
          objectClassName: 'domain', ldhName: d.name.toUpperCase(), status: held ? ['client hold', 'server hold'] : ['client transfer prohibited'],
          events: [{ eventAction: 'registration', eventDate: iso(d.registeredAt) }, { eventAction: 'expiration', eventDate: iso(d.registeredAt + 365) }, { eventAction: 'last changed', eventDate: iso(held ? d.liveTo! : d.registeredAt + 1) }],
          nameservers: d.ns.map(n => ({ ldhName: n.toUpperCase() })),
          entities: [{ roles: ['registrar'], handle: '1', vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', d.registrar]]] }, { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY']]] }],
        });
      }
      if (host === 'stat.ripe.net') {
        const ip = u.searchParams.get('resource') ?? '';
        const info = w.ips.get(ip);
        if (u.pathname.includes('maxmind')) return reply(200, { data: { located_resources: [{ locations: [{ country: info?.country ?? 'ZZ' }] }] } });
        return reply(200, { status: 'ok', data: { resource: `${ip.split('.').slice(0, 3).join('.')}.0/24`, asns: info ? [{ asn: info.asn, holder: info.holder }] : [], announced: Boolean(info) } });
      }
      if (host === 'api.hackertarget.com') {
        const q = u.searchParams.get('q') ?? '';
        const list = u.pathname.includes('reverseiplookup') ? reverseIp(q) : reverseNs(q);
        return reply(200, list.length ? `${list.join('\n')}\n` : 'No DNS A records found');
      }
      if (host === 'urlscan.io') {
        if (u.pathname.startsWith('/api/v1/search')) {
          const q = u.searchParams.get('q') ?? '';
          let hits: WorldDomain[] = [];
          const hashM = /^hash:([0-9a-f]{64})$/.exec(q);
          const ipM = /^page\.ip:"?([0-9.]+)"?$/.exec(q);
          const domM = /page\.domain:([^\s]+)/.exec(q);
          const titleM = /^page\.title:"(.+)"$/.exec(q);
          if (hashM) hits = scanned().filter(d => siteResources(w, d).some(r => r.hash === hashM[1]));
          else if (ipM) hits = scanned().filter(d => d.scanIp === ipM[1]);
          else if (titleM) hits = scanned().filter(d => d.title === titleM[1]);
          else if (domM) hits = scanned().filter(d => d.name === domM[1].toLowerCase());
          return reply(200, { total: hits.length, results: hits.map(hit) });
        }
        if (u.pathname.startsWith('/api/v1/result/')) {
          const d = scanOf(u.pathname.split('/').filter(Boolean).pop()!);
          if (!d) return reply(404, { message: 'Not found' });
          return reply(200, { page: hit(d).page, data: { requests: siteResources(w, d).map(r => ({ response: { hash: r.hash, response: { url: r.url, mimeType: r.mime } } })) }, verdicts: { overall: { malicious: false } } });
        }
        if (u.pathname.startsWith('/dom/')) {
          const d = scanOf(u.pathname.split('/').filter(Boolean).pop()!);
          if (!d) return reply(404, 'Not found');
          const kit = d.kit ? w.kits.get(d.kit.version) : null;
          return reply(200, kit ? kit.html(d) : `<!doctype html><html><head><title>${d.title}</title></head><body><main><h1></h1><p></p></main></body></html>`);
        }
      }
      if (host.endsWith('blockscout.com')) {
        if (!host.startsWith('eth.')) return reply(404, { message: 'Not found' });
        const m = /\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})(\/[a-z-]+)?/.exec(u.pathname);
        if (!m) return reply(404, { message: 'Not found' });
        const a = m[1].toLowerCase();
        const { wal, txs } = address(a);
        if (!wal && !txs.length) return reply(404, { message: 'Not found' });
        const party = (x: string) => ({ hash: x, name: w.wallets.get(x)?.label ?? null, is_contract: ['exchange', 'mixer'].includes(w.wallets.get(x)?.role ?? '') && w.wallets.get(x)?.role === 'mixer' });
        if (!m[2]) return reply(200, { hash: a, is_contract: wal?.role === 'mixer', has_token_transfers: false, has_logs: false, coin_balance: txs.length ? '1000' : '0', name: wal?.label ?? null });
        if (m[2] === '/transactions') {
          const items = txs.slice(-50).reverse().map(t => ({ hash: t.hash, from: party(t.from), to: party(t.to), value: t.wei.toString(), timestamp: iso(t.day), method: null, block_number: 1 }));
          return reply(200, { items, next_page_params: null });
        }
        return reply(200, { items: [], next_page_params: null });
      }
      if (host === 'api.trongrid.io' || host === 'mempool.space') return reply(404, { message: 'Not found' });
      return reply(404, { message: `No fixture for ${host}` });
    } catch (err) {
      return reply(500, { message: String(err) });
    }
  }

  const answer = (host: string, type: string): Promise<any> => {
    const d = w.domains.get(host.toLowerCase().replace(/^www\./, ''));
    const nodata = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    if (!d) return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    if (type === 'A') { const ips = currentIps(d, w.day); return ips.length ? Promise.resolve(ips) : nodata(); }
    if (type === 'NS') { const ns = currentNs(d, w.day); return ns.length ? Promise.resolve(ns) : nodata(); }
    return nodata();
  };
  const resolver = {
    setServers() {},
    resolve4: (h: string) => answer(h, 'A'), resolve6: (h: string) => answer(h, 'AAAA'), resolveNs: (h: string) => answer(h, 'NS'),
    resolveMx: (h: string) => answer(h, 'MX'), resolveTxt: (h: string) => answer(h, 'TXT'), resolveCname: (h: string) => answer(h, 'CNAME'),
  };
  return { fetch: fetchImpl as any, resolver, requests, count: (h?: string) => (h ? requests.filter(r => r.includes(h)).length : requests.length) };
}
