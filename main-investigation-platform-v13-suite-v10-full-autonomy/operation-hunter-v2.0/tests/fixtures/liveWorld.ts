import { on, fakeResolver, days } from '../helpers.ts';

/**
 * Canned responses in the exact formats of the real public APIs (crt.sh,
 * rdap.org, RIPEstat, HackerTarget, urlscan.io, Blockscout, TronGrid,
 * mempool.space) for a small fictional operation. Used to exercise the live
 * collectors end to end without network access.
 */
export const SEED = 'secure-wallet-sync.app';
export const SISTER = 'wallet-sync-claim.app';
export const WALLET = '0x1111111111111111111111111111111111111111';
export const TREASURY = '0x2222222222222222222222222222222222222222';
export const DEPOSIT = '0x3333333333333333333333333333333333333333';
export const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
export const KIT_HASH = 'a'.repeat(64);

export const PAGE_HTML = `<!doctype html><html><head><title>Secure Wallet Sync</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SYNC1234AB"></script>
<script src="https://cdn.walletsync-assets.net/app/drain.min.js"></script>
<script>gtag('config','G-SYNC1234AB');const receiver="${WALLET}";async function x(){await provider.request({method:"eth_signTypedData_v4"});await t.setApprovalForAll(receiver,true)}</script></head>
<body><div id="app"><header class="nav"><a class="logo" href="/"></a><button class="connect" type="button">Connect</button></header><main><section class="hero"><h1></h1><p></p><button class="claim" type="button">Sync</button></section>
<section class="faq"><details><summary></summary><p></p></details></section></main><footer><a href="https://t.me/walletsync_help">Help</a></footer></div></body></html>`;

const crtRows = [
  { id: 111, issuer_ca_id: 183267, issuer_name: "C=US, O=Let's Encrypt, CN=R11", common_name: SEED, name_value: `${SEED}\n${SISTER}`, entry_timestamp: days(-19).replace('Z', '').slice(0, 23), not_before: days(-19).slice(0, 19), not_after: days(71).slice(0, 19), serial_number: '04aa11' },
  { id: 112, issuer_ca_id: 183267, issuer_name: "C=US, O=Let's Encrypt, CN=R11", common_name: `www.${SEED}`, name_value: `www.${SEED}`, entry_timestamp: days(-10).replace('Z', '').slice(0, 23), not_before: days(-10).slice(0, 19), not_after: days(80).slice(0, 19), serial_number: '04aa12' },
];

const rdap = (domain: string, created: number) => ({
  objectClassName: 'domain', ldhName: domain.toUpperCase(), status: ['client transfer prohibited'],
  events: [{ eventAction: 'registration', eventDate: days(created) }, { eventAction: 'expiration', eventDate: days(created + 365) }, { eventAction: 'last changed', eventDate: days(created + 1) }],
  nameservers: [{ ldhName: 'NS1.HOSTPRIVATE.NET' }, { ldhName: 'NS2.HOSTPRIVATE.NET' }],
  entities: [
    { roles: ['registrar'], handle: '69', publicIds: [{ type: 'IANA Registrar ID', identifier: '69' }], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Tucows Domains Inc.']]],
      entities: [{ roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse'], ['email', {}, 'text', 'abuse@tucows.com']]] }] },
    { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY'], ['email', {}, 'text', 'Please query the RDDS service of the Registrar of Record']]] },
  ],
});

const addr = (hash: string, name?: string, isContract = false) => ({ hash, name: name ?? null, is_contract: isContract });
const tx = (hash: string, from: string, to: string, wei: string, ts: number, fromName?: string, toName?: string) => ({ hash, from: addr(from, fromName), to: addr(to, toName), value: wei, timestamp: days(ts), method: null, block_number: 1 });

export const liveRoutes = [
  on('crt.sh/?q=', () => ({ body: crtRows })),
  on(`rdap.org/domain/${SEED}`, () => ({ body: rdap(SEED, -20) })),
  on(`rdap.org/domain/${SISTER}`, () => ({ body: rdap(SISTER, -19) })),
  on('rdap.org/domain/', () => ({ status: 404, body: { errorCode: 404 } })),
  on('stat.ripe.net/data/prefix-overview', () => ({ body: { status: 'ok', data: { resource: '45.155.205.0/24', asns: [{ asn: 211252, holder: 'AS-DELIS - Delis LLC' }], announced: true } } })),
  on('stat.ripe.net/data/maxmind-geo-lite', () => ({ body: { data: { located_resources: [{ locations: [{ country: 'NL' }] }] } } })),
  on('api.hackertarget.com/reverseiplookup', () => ({ body: `${SEED}\n${SISTER}\n` })),
  on('api.hackertarget.com/findshareddns', () => ({ body: `${SEED}\n${SISTER}\nunrelated-shop.store\n` })),
  on(/urlscan\.io\/api\/v1\/search\/\?q=hash/, () => ({ body: { total: 2, results: [{ _id: 'u1', task: { domain: SEED, time: days(-8) }, page: { domain: SEED } }, { _id: 'u2', task: { domain: SISTER, time: days(-7) }, page: { domain: SISTER } }] } })),
  on(/urlscan\.io\/api\/v1\/search\/\?q=page\.ip/, () => ({ body: { total: 1, results: [{ _id: 'u1', task: { domain: SEED, time: days(-8) }, page: { domain: SEED } }] } })),
  on('urlscan.io/api/v1/search/', (url) => {
    const q = decodeURIComponent(url);
    const d = q.includes(SISTER) ? SISTER : q.includes(SEED) ? SEED : null;
    if (!d) return { body: { total: 0, results: [] } };
    const id = d === SISTER ? 'u2' : 'u1';
    return { body: { total: 1, results: [{ _id: id, task: { domain: d, time: days(-8) }, page: { domain: d, ip: '45.155.205.10', asn: 'AS211252', asnname: 'AS-DELIS', country: 'NL', server: 'nginx', title: 'Secure Wallet Sync', url: `https://${d}/`, status: '200' }, result: `https://urlscan.io/api/v1/result/${id}/` }] } };
  }),
  on('urlscan.io/api/v1/result/', (url) => ({ body: { page: { domain: url.includes('u2') ? SISTER : SEED, ip: '45.155.205.10', asn: 'AS211252', asnname: 'AS-DELIS', server: 'nginx', title: 'Secure Wallet Sync', url: `https://${url.includes('u2') ? SISTER : SEED}/` }, data: { requests: [
    { response: { hash: KIT_HASH, response: { url: 'https://cdn.walletsync-assets.net/app/drain.min.js', mimeType: 'application/javascript' } } },
    { response: { hash: 'b'.repeat(64), response: { url: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', mimeType: 'application/javascript' } } },
  ] } } })),
  // Blockscout: only Ethereum knows these addresses
  on(/eth\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}\/transactions/, (url) => {
    const a = /addresses\/(0x[0-9a-f]{40})/.exec(url)![1];
    if (a === WALLET) return { body: { items: [
      tx('0xt1', '0x9999999999999999999999999999999999999991', WALLET, '2000000000000000000', -7), tx('0xt2', '0x9999999999999999999999999999999999999992', WALLET, '1500000000000000000', -6),
      tx('0xt3', '0x9999999999999999999999999999999999999993', WALLET, '500000000000000000', -5), tx('0xt4', WALLET, TREASURY, '3900000000000000000', -4.99),
    ], next_page_params: null } };
    if (a === TREASURY) return { body: { items: [tx('0xt4', WALLET, TREASURY, '3900000000000000000', -4.99), tx('0xt5', TREASURY, DEPOSIT, '3800000000000000000', -3)], next_page_params: null } };
    if (a === DEPOSIT) return { body: { items: [tx('0xt5', TREASURY, DEPOSIT, '3800000000000000000', -3), tx('0xt6', DEPOSIT, BINANCE, '3800000000000000000', -2.99, undefined, 'Binance 14')], next_page_params: null } };
    return { body: { items: [], next_page_params: null } };
  }),
  on(/eth\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}\/token-transfers/, () => ({ body: { items: [], next_page_params: null } })),
  on(/eth\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}$/, (url) => {
    const a = /addresses\/(0x[0-9a-f]{40})/.exec(url)![1];
    if (![WALLET, TREASURY, DEPOSIT].includes(a)) return { status: 404, body: { message: 'Not found' } };
    return { body: { hash: a, is_contract: false, has_token_transfers: false, has_logs: false, coin_balance: '100', name: null } };
  }),
  on('blockscout.com/api/v2/addresses/', () => ({ status: 404, body: { message: 'Not found' } })),
];

export const liveZone = fakeResolver({
  [SEED]: { A: ['45.155.205.10'], NS: ['ns1.hostprivate.net', 'ns2.hostprivate.net'], TXT: [['google-site-verification=abcTOKEN123']], MX: [] },
  [SISTER]: { A: ['45.155.205.10'], NS: ['ns1.hostprivate.net', 'ns2.hostprivate.net'] },
  'cdn.walletsync-assets.net': { A: ['45.155.205.11'] },
});
