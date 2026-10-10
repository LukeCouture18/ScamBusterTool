import { sha256 } from '../core/util.js';

/**
 * SYNTHETIC DEMO WORLD — not real data.
 *
 * A small, deterministic model of a slice of the internet used only by demo
 * operations and the test suite. It lets the real pursuit, ingest and analysis
 * engines be exercised end to end without network access. Every observation
 * produced from it is flagged `synthetic` and labelled as demo data.
 *
 * Two fictional operations share one commercial drainer kit:
 *  - "Arctic Drainer": offshore hosting, private nameservers, one operator's
 *    analytics/Telegram/deployer reused across three deployment waves, money
 *    converging on a treasury and exiting to an exchange deposit and a mixer.
 *  - "Helios": the same kit files and the same kit-vendor fee wallet, but
 *    Cloudflare-fronted hosting and entirely different operator indicators.
 * Plus noise: an unrelated casino site on the same bulletproof nameserver and
 * a crowded shared-hosting IP, to exercise false-positive handling.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const evm = (seed: string) => `0x${sha256(`evm:${seed}`).slice(0, 40)}`;
export const tron = (seed: string) => {
  const h = sha256(`tron:${seed}`);
  let out = 'T';
  for (let i = 0; out.length < 34; i += 2) out += B58[parseInt(h.slice(i % 60, (i % 60) + 2), 16) % 58];
  return out;
};

export interface WorldDomain {
  name: string; registered: number; registrar: string; ns: string[]; a?: string[]; aaaa?: string[]; mx?: string[]; txt?: string[];
  status?: string[]; activeNow: boolean; late?: boolean;
  scan?: { at: number; title: string; server: string; ip: string; template: string; resources: string[]; config?: { ga?: string; tg?: string; contract?: string; tron?: string; wc?: string } };
}
export interface WorldCert { id: number; issuerCaId: number; issuer: string; serial: string; notBefore: number; notAfter: number; names: string[]; late?: boolean }
export interface WorldIp { ip: string; asn: number; holder: string; country: string; prefix: string; reverse?: string[]; reverseVolume?: number }
export interface WorldResource { hash: string; url: string; mime: string; label: string }
export interface WorldTemplate { id: string; kitFamily: string; variant: string; extraBlocks: number }
export interface WorldWallet { address: string; network: string; isContract?: boolean; name?: string; creator?: string; creationTx?: string; verified?: boolean; tags?: string[] }
export interface WorldTransfer { hash: string; network: string; from: string; to: string; amount: string; symbol: string; at: number; usd?: number; method?: string; late?: boolean }

export interface World {
  base: number;
  domains: Record<string, WorldDomain>;
  certs: WorldCert[];
  ips: Record<string, WorldIp>;
  nsReverse: Record<string, { domains: string[]; volume?: number }>;
  resources: Record<string, WorldResource>;
  templates: Record<string, WorldTemplate>;
  wallets: Record<string, WorldWallet>;
  transfers: WorldTransfer[];
  trackers: Record<string, string[]>;
  labels: Record<string, { label: string; kind: string }>;
}

const ETH_USD = 3500;
const res = (name: string) => sha256(`resource:${name}`);

export function buildWorld(baseIso: string): World {
  const base = Date.parse(baseIso);
  // --- wallets
  const W = {
    arcticSplitter: '0x71c8282929d0092e02e82110c49281a94b810b82',
    arcticSplitter2: evm('arctic-splitter-2'),
    arcticDeployer: evm('arctic-deployer'),
    arcticTreasury: '0x3a4f891002ec7922d99f110c01a082b99f2010aa',
    arcticTreasury2: evm('arctic-treasury-2'),
    cexDeposit: evm('arctic-cex-deposit'),
    cexHot: '0x28c6c06298d514db089934071355e5743bf21d60',
    mixer: '0xd90e2f925da726b50c4ed8d0fb90ad053324f31',
    bridge: evm('demo-bridge'),
    arbConsolidation: evm('arctic-arb-consolidation'),
    vendorFee: evm('drainerx-vendor-fee'),
    heliosSplitter: evm('helios-splitter'),
    heliosDeployer: evm('helios-deployer'),
    heliosTreasury: evm('helios-treasury'),
    heliosCex: evm('helios-cex-deposit'),
    tronCollector: tron('arctic-tron-collector'),
    tronConsolidation: tron('arctic-tron-consolidation'),
    tronExchange: tron('demo-tron-exchange'),
  };
  const victims = Array.from({ length: 12 }, (_, i) => evm(`victim-${i}`));
  const tronVictims = Array.from({ length: 4 }, (_, i) => tron(`tron-victim-${i}`));

  // --- templates & resources
  const templates: Record<string, WorldTemplate> = {
    'drainerx-2.4': { id: 'drainerx-2.4', kitFamily: 'CryptoDrainer-X', variant: 'v2.4', extraBlocks: 0 },
    'drainerx-2.5': { id: 'drainerx-2.5', kitFamily: 'CryptoDrainer-X', variant: 'v2.5 (adds TRON support)', extraBlocks: 2 },
    'casino': { id: 'casino', kitFamily: 'Generic casino landing page', variant: 'n/a', extraBlocks: 0 },
  };
  const resources: Record<string, WorldResource> = {
    kit24: { hash: res('drainerx-core-2.4.js'), url: '/assets/js/core.min.js', mime: 'application/javascript', label: 'core.min.js (CryptoDrainer-X v2.4 core)' },
    kit25: { hash: res('drainerx-core-2.5.js'), url: '/assets/js/core.min.js', mime: 'application/javascript', label: 'core.min.js (CryptoDrainer-X v2.5 core)' },
    arcticCfg1: { hash: res('arctic-config-1.js'), url: '/assets/js/cfg.js', mime: 'application/javascript', label: 'cfg.js (Arctic wave 1 config)' },
    arcticCfg2: { hash: res('arctic-config-2.js'), url: '/assets/js/cfg.js', mime: 'application/javascript', label: 'cfg.js (Arctic wave 2 config)' },
    arcticCfg3: { hash: res('arctic-config-3.js'), url: '/assets/js/cfg.js', mime: 'application/javascript', label: 'cfg.js (Arctic wave 3 config)' },
    heliosCfg: { hash: res('helios-config.js'), url: '/static/settings.js', mime: 'application/javascript', label: 'settings.js (Helios config)' },
    jquery: { hash: res('jquery-3.7.1.min.js'), url: '/assets/js/jquery.min.js', mime: 'application/javascript', label: 'jquery.min.js (common library)' },
    casinoJs: { hash: res('casino-app.js'), url: '/app.js', mime: 'application/javascript', label: 'app.js (casino)' },
  };

  const OFFSHORE_NS = ['ns1.offshore-dns.is', 'ns2.offshore-dns.is'];
  const domains: Record<string, WorldDomain> = {
    'eth-recovery-claim.top': {
      name: 'eth-recovery-claim.top', registered: -30, registrar: 'NameSilo, LLC', ns: OFFSHORE_NS, a: undefined, activeNow: false,
      status: ['client hold'], txt: ['google-site-verification=arcT1c-9fQv2LkP0wX7s'],
      scan: { at: -26, title: 'ETH Recovery Portal — Claim Lost Assets', server: 'nginx/1.18.0', ip: '185.193.127.44', template: 'drainerx-2.4', resources: ['kit24', 'arcticCfg1', 'jquery'], config: { ga: 'G-99X4K21Z', tg: 'arctic_drain_support', contract: W.arcticSplitter } },
    },
    'claim-asset-portal.com': {
      name: 'claim-asset-portal.com', registered: -31, registrar: 'NameSilo, LLC', ns: OFFSHORE_NS, a: ['185.193.127.44'], activeNow: true,
      scan: { at: -20, title: 'Asset Claim Portal', server: 'nginx/1.18.0', ip: '185.193.127.44', template: 'drainerx-2.4', resources: ['kit24', 'arcticCfg1', 'jquery'], config: { ga: 'G-99X4K21Z', tg: 'arctic_drain_support', contract: W.arcticSplitter } },
    },
    'claim-revoke-portal.link': {
      name: 'claim-revoke-portal.link', registered: -18, registrar: 'NICENIC INTERNATIONAL GROUP CO., LIMITED', ns: OFFSHORE_NS, a: ['194.26.29.112'], activeNow: true,
      scan: { at: -15, title: 'Revoke Token Approvals — Secure Your Wallet', server: 'nginx/1.18.0', ip: '194.26.29.112', template: 'drainerx-2.4', resources: ['kit24', 'arcticCfg2', 'jquery'], config: { ga: 'G-99X4K21Z', tg: 'arctic_drain_support', contract: W.arcticSplitter2 } },
    },
    'revoke-approvals-portal.link': {
      name: 'revoke-approvals-portal.link', registered: -18, registrar: 'NICENIC INTERNATIONAL GROUP CO., LIMITED', ns: OFFSHORE_NS, a: ['194.26.29.112'], activeNow: true,
    },
    'claim-refund-portal.click': {
      name: 'claim-refund-portal.click', registered: -5, registrar: 'Regery OU', ns: OFFSHORE_NS, a: ['194.26.29.155'], activeNow: true,
      scan: { at: -3, title: 'Claim Your Refund — Official Portal', server: 'nginx/1.22.1', ip: '194.26.29.155', template: 'drainerx-2.5', resources: ['kit25', 'arcticCfg3', 'jquery'], config: { ga: 'G-99X4K21Z', tg: 'arctic_drain_support', contract: W.arcticSplitter2, tron: W.tronCollector } },
    },
    'wallet-refund-center.click': { name: 'wallet-refund-center.click', registered: -5, registrar: 'Regery OU', ns: OFFSHORE_NS, activeNow: false },
    'eth-support-verification.top': { name: 'eth-support-verification.top', registered: -7, registrar: 'NameSilo, LLC', ns: OFFSHORE_NS, activeNow: false },
    'claim-vault-security.link': {
      name: 'claim-vault-security.link', registered: 0, registrar: 'NICENIC INTERNATIONAL GROUP CO., LIMITED', ns: OFFSHORE_NS, a: ['194.26.29.155'], activeNow: true, late: true,
      scan: { at: 0, title: 'Vault Security Check', server: 'nginx/1.22.1', ip: '194.26.29.155', template: 'drainerx-2.5', resources: ['kit25', 'arcticCfg3', 'jquery'], config: { ga: 'G-99X4K21Z', tg: 'arctic_drain_support', contract: W.arcticSplitter2, tron: W.tronCollector } },
    },
    'bet-royale-casino.win': {
      name: 'bet-royale-casino.win', registered: -120, registrar: 'NameSilo, LLC', ns: OFFSHORE_NS, a: ['185.193.127.44'], activeNow: true,
      scan: { at: -40, title: 'Bet Royale — 300% Welcome Bonus', server: 'Apache', ip: '185.193.127.44', template: 'casino', resources: ['casinoJs', 'jquery'] },
    },
    'helios-airdrop-bonus.xyz': {
      name: 'helios-airdrop-bonus.xyz', registered: -22, registrar: 'NameCheap, Inc.', ns: ['kara.ns.cloudflare.com', 'rick.ns.cloudflare.com'], a: ['104.21.55.10', '172.67.140.20'], activeNow: true,
      scan: { at: -12, title: 'Helios Airdrop — Claim Your Bonus', server: 'cloudflare', ip: '104.21.55.10', template: 'drainerx-2.4', resources: ['kit24', 'heliosCfg', 'jquery'], config: { ga: 'G-H3L10S77QA', tg: 'helios_airdrop_help', contract: W.heliosSplitter } },
    },
    'helios-claim.xyz': {
      name: 'helios-claim.xyz', registered: -21, registrar: 'NameCheap, Inc.', ns: ['kara.ns.cloudflare.com', 'rick.ns.cloudflare.com'], a: ['104.21.55.10', '172.67.140.20'], activeNow: true,
      scan: { at: -10, title: 'Helios Claim Center', server: 'cloudflare', ip: '104.21.55.10', template: 'drainerx-2.4', resources: ['kit24', 'heliosCfg', 'jquery'], config: { ga: 'G-H3L10S77QA', tg: 'helios_airdrop_help', contract: W.heliosSplitter } },
    },
  };

  const certs: WorldCert[] = [
    { id: 9100001, issuerCaId: 16418, issuer: 'C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA', serial: '4891a82910', notBefore: -29, notAfter: 61, names: ['*.claim-asset-portal.com', 'claim-asset-portal.com', 'eth-recovery-claim.top'] },
    { id: 9100002, issuerCaId: 183267, issuer: "C=US, O=Let's Encrypt, CN=R11", serial: '03a7f1c2d9', notBefore: -18, notAfter: 72, names: ['claim-revoke-portal.link', 'revoke-approvals-portal.link'] },
    { id: 9100003, issuerCaId: 183267, issuer: "C=US, O=Let's Encrypt, CN=R11", serial: '04be20aa71', notBefore: -5, notAfter: 85, names: ['claim-refund-portal.click', 'wallet-refund-center.click'] },
    { id: 9100004, issuerCaId: 183267, issuer: "C=US, O=Let's Encrypt, CN=R10", serial: '05c1d0ee12', notBefore: 0, notAfter: 90, names: ['claim-vault-security.link'], late: true },
    { id: 9100005, issuerCaId: 245690, issuer: 'C=US, O=Google Trust Services, CN=WE1', serial: '7f00aa1b3c', notBefore: -21, notAfter: 69, names: ['helios-airdrop-bonus.xyz', 'helios-claim.xyz'] },
    { id: 9100006, issuerCaId: 183267, issuer: "C=US, O=Let's Encrypt, CN=R11", serial: '0999ab0c01', notBefore: -100, notAfter: -10, names: ['bet-royale-casino.win', 'www.bet-royale-casino.win'] },
  ];

  const ips: Record<string, WorldIp> = {
    '185.193.127.44': { ip: '185.193.127.44', asn: 209588, holder: 'FLYHOSTING-AS FlyHosting LLC', country: 'SC', prefix: '185.193.126.0/23', reverse: ['eth-recovery-claim.top', 'claim-asset-portal.com', 'bet-royale-casino.win', 'cheap-vps-panel.net', 'pharma-discount-rx.shop'] },
    '194.26.29.112': { ip: '194.26.29.112', asn: 200019, holder: 'ALEXHOST SRL', country: 'MD', prefix: '194.26.29.0/24', reverse: ['claim-revoke-portal.link', 'revoke-approvals-portal.link'] },
    '194.26.29.155': { ip: '194.26.29.155', asn: 200019, holder: 'ALEXHOST SRL', country: 'MD', prefix: '194.26.29.0/24', reverse: ['claim-refund-portal.click'] },
    '104.21.55.10': { ip: '104.21.55.10', asn: 13335, holder: 'CLOUDFLARENET Cloudflare, Inc.', country: 'US', prefix: '104.21.48.0/20', reverseVolume: 5400 },
    '172.67.140.20': { ip: '172.67.140.20', asn: 13335, holder: 'CLOUDFLARENET Cloudflare, Inc.', country: 'US', prefix: '172.67.128.0/19', reverseVolume: 5100 },
  };

  const nsReverse: World['nsReverse'] = {
    'ns1.offshore-dns.is': { domains: ['eth-recovery-claim.top', 'claim-asset-portal.com', 'claim-revoke-portal.link', 'revoke-approvals-portal.link', 'claim-refund-portal.click', 'wallet-refund-center.click', 'eth-support-verification.top', 'bet-royale-casino.win', 'claim-vault-security.link'] },
    'ns2.offshore-dns.is': { domains: ['eth-recovery-claim.top', 'claim-asset-portal.com', 'claim-revoke-portal.link', 'revoke-approvals-portal.link', 'claim-refund-portal.click', 'wallet-refund-center.click', 'eth-support-verification.top', 'bet-royale-casino.win', 'claim-vault-security.link'] },
    'kara.ns.cloudflare.com': { domains: [], volume: 2400000 },
    'rick.ns.cloudflare.com': { domains: [], volume: 2400000 },
  };

  const wallets: Record<string, WorldWallet> = {
    [W.arcticSplitter]: { address: W.arcticSplitter, network: 'ethereum', isContract: true, name: undefined, creator: W.arcticDeployer, creationTx: `0x${sha256('create-1')}`, verified: false },
    [W.arcticSplitter2]: { address: W.arcticSplitter2, network: 'ethereum', isContract: true, creator: W.arcticDeployer, creationTx: `0x${sha256('create-2')}`, verified: false },
    [W.heliosSplitter]: { address: W.heliosSplitter, network: 'ethereum', isContract: true, creator: W.heliosDeployer, creationTx: `0x${sha256('create-h')}`, verified: false },
    [W.cexHot]: { address: W.cexHot, network: 'ethereum', name: 'Binance 14', tags: ['Exchange'] },
    [W.mixer]: { address: W.mixer, network: 'ethereum', isContract: true, name: 'Tornado Cash: Router', tags: ['Mixer'] },
    [W.bridge]: { address: W.bridge, network: 'ethereum', isContract: true, name: 'Across Protocol: Spoke Pool (demo)', tags: ['Bridge'] },
    [W.arcticDeployer]: { address: W.arcticDeployer, network: 'ethereum' },
    [W.arcticTreasury]: { address: W.arcticTreasury, network: 'ethereum' },
  };

  const T: WorldTransfer[] = [];
  let n = 0;
  const tx = (network: string, from: string, to: string, amount: number, symbol: string, at: number, method?: string, late?: boolean) => {
    T.push({ hash: `0x${sha256(`tx:${n++}:${from}:${to}:${at}`)}`, network, from, to, amount: String(amount), symbol, at, usd: symbol === 'ETH' ? Math.round(amount * ETH_USD) : symbol.startsWith('USD') ? Math.round(amount) : undefined, method, late });
  };
  // Wave 1: victims -> splitter 1 (permit2 sweeps), splitter -> treasury (80%) + vendor fee (20%)
  const wave1 = [18.45, 6.2, 2.75, 9.1, 0.84, 3.3];
  wave1.forEach((amt, i) => {
    const at = -26 + i * 1.4;
    tx('ethereum', victims[i], W.arcticSplitter, amt, 'ETH', at, 'permitTransferFrom');
    tx('ethereum', W.arcticSplitter, W.arcticTreasury, +(amt * 0.8).toFixed(4), 'ETH', at + 0.002, 'multicall');
    tx('ethereum', W.arcticSplitter, W.vendorFee, +(amt * 0.2).toFixed(4), 'ETH', at + 0.002, 'multicall');
  });
  // Wave 2: victims -> splitter 2
  const wave2 = [4.4, 12.9, 1.15, 7.7];
  wave2.forEach((amt, i) => {
    const at = -15 + i * 1.7;
    tx('ethereum', victims[6 + i], W.arcticSplitter2, amt, 'ETH', at, 'permitTransferFrom');
    tx('ethereum', W.arcticSplitter2, W.arcticTreasury, +(amt * 0.8).toFixed(4), 'ETH', at + 0.0015, 'multicall');
    tx('ethereum', W.arcticSplitter2, W.vendorFee, +(amt * 0.2).toFixed(4), 'ETH', at + 0.0015, 'multicall');
  });
  tx('ethereum', victims[10], W.arcticSplitter2, 25000, 'USDT', -9.5, 'permitTransferFrom');
  tx('ethereum', W.arcticSplitter2, W.arcticTreasury, 20000, 'USDT', -9.498, 'multicall');
  tx('ethereum', W.arcticSplitter2, W.vendorFee, 5000, 'USDT', -9.498, 'multicall');
  // Cash-out and laundering
  tx('ethereum', W.arcticTreasury, W.mixer, 14.8, 'ETH', -10, 'multicall');
  tx('ethereum', W.arcticTreasury, W.cexDeposit, 8.2, 'ETH', -8, undefined);
  tx('ethereum', W.cexDeposit, W.cexHot, 8.2, 'ETH', -7.98, undefined);
  tx('ethereum', W.arcticTreasury, W.cexDeposit, 20000, 'USDT', -8.9, 'transfer');
  tx('ethereum', W.cexDeposit, W.cexHot, 20000, 'USDT', -8.88, 'transfer');
  tx('ethereum', W.arcticTreasury, W.bridge, 6.5, 'ETH', -6.5, 'depositV3');
  tx('arbitrum', W.bridge, W.arcticTreasury, 6.49, 'ETH', -6.49, 'fillV3Relay');
  tx('arbitrum', W.arcticTreasury, W.arbConsolidation, 6.4, 'ETH', -6.2, undefined);
  // Treasury rotation
  tx('ethereum', W.arcticTreasury, W.arcticTreasury2, 3.1, 'ETH', -6, undefined);
  tx('ethereum', victims[11], W.arcticSplitter2, 5.5, 'ETH', -3, 'permitTransferFrom');
  tx('ethereum', W.arcticSplitter2, W.arcticTreasury2, 4.4, 'ETH', -2.999, 'multicall');
  tx('ethereum', W.arcticSplitter2, W.vendorFee, 1.1, 'ETH', -2.999, 'multicall');
  // TRON collection (wave 3 adds TRON support)
  tronVictims.forEach((v, i) => tx('tron', v, W.tronCollector, [1200, 5400, 830, 2600][i], 'USDT', -3 + i * 0.6));
  tx('tron', W.tronCollector, W.tronConsolidation, 9900, 'USDT', -0.9);
  tx('tron', W.tronConsolidation, W.tronExchange, 9800, 'USDT', -0.5);
  // Helios: same kit vendor fee, different everything else
  const heliosAmts = [3.2, 11.4, 0.6, 5.0];
  heliosAmts.forEach((amt, i) => {
    const at = -11 + i * 2;
    const victim = evm(`helios-victim-${i}`);
    tx('ethereum', victim, W.heliosSplitter, amt, 'ETH', at, 'permitTransferFrom');
    tx('ethereum', W.heliosSplitter, W.heliosTreasury, +(amt * 0.8).toFixed(4), 'ETH', at + 0.002, 'multicall');
    tx('ethereum', W.heliosSplitter, W.vendorFee, +(amt * 0.2).toFixed(4), 'ETH', at + 0.002, 'multicall');
  });
  tx('ethereum', W.heliosTreasury, W.heliosCex, 12.5, 'ETH', -2, undefined);

  const labels: World['labels'] = {
    [W.cexHot]: { label: 'Binance 14 (hot wallet)', kind: 'exchange' },
    [W.mixer]: { label: 'Tornado Cash Router', kind: 'mixer' },
    [W.bridge]: { label: 'Across Protocol Spoke Pool (demo)', kind: 'bridge' },
    [W.tronExchange.toLowerCase()]: { label: 'Exchange hot wallet (demo, TRON)', kind: 'exchange' },
  };

  const trackers: Record<string, string[]> = {
    'G-99X4K21Z': ['eth-recovery-claim.top', 'claim-asset-portal.com', 'claim-revoke-portal.link', 'claim-refund-portal.click'],
    '@arctic_drain_support': ['eth-recovery-claim.top', 'claim-asset-portal.com', 'claim-revoke-portal.link', 'claim-refund-portal.click'],
    'G-H3L10S77QA': ['helios-airdrop-bonus.xyz', 'helios-claim.xyz'],
    '@helios_airdrop_help': ['helios-airdrop-bonus.xyz', 'helios-claim.xyz'],
    'google-site-verification=arct1c-9fqv2lkp0wx7s': ['eth-recovery-claim.top'],
  };

  return { base, domains, certs, ips, nsReverse, resources, templates, wallets, transfers: T, trackers, labels };
}

export function worldTime(world: World, days: number): string {
  return new Date(world.base + days * 86400000).toISOString();
}

/** Render a demo page for a domain's scan so the real HTML analyzer can fingerprint it. */
export function renderDemoPage(world: World, domain: WorldDomain): string {
  const scan = domain.scan!;
  const tpl = world.templates[scan.template];
  const scripts = scan.resources.map(r => `<script src="https://${domain.name}${world.resources[r].url}" defer></script>`).join('\n');
  const cfg = scan.config ?? {};
  if (tpl.id === 'casino') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${scan.title}</title>${scripts}</head><body><header class="top"><a class="logo" href="/">Bet Royale</a><nav><a href="/slots">Slots</a><a href="/live">Live</a></nav></header><main><section class="hero"><h1>300% Welcome Bonus</h1><a class="btn" href="/register">Join</a></section><section class="games"><div class="card"></div><div class="card"></div><div class="card"></div></section></main><footer><p>18+</p></footer></body></html>`;
  }
  const extra = Array.from({ length: tpl.extraBlocks }, (_, i) => `<div class="network-tab" data-chain="tron-${i}"><button class="btn-tron" type="button">Connect TronLink</button><span class="hint"></span></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${scan.title}</title>
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/css/app.css">
<script async src="https://www.googletagmanager.com/gtag/js?id=${cfg.ga ?? ''}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${cfg.ga ?? ''}');</script>
${scripts}
<script>window.__CFG={receiver:"${cfg.contract ?? ''}",tron:"${cfg.tron ?? ''}",support:"https://t.me/${cfg.tg ?? ''}"};const modal=createWeb3Modal({projectId:"${sha256(`wc:${tpl.kitFamily}`).slice(0, 32)}"});async function go(){await provider.request({method:"eth_signTypedData_v4"});await c.setApprovalForAll(r,true);await p2.permitTransferFrom();await provider.request({method:"wallet_switchEthereumChain"})}</script>
</head><body><div id="app"><header class="navbar"><div class="brand"><img class="brand-logo" src="/assets/img/logo.svg" alt=""><span class="brand-name"></span></div><nav class="nav-links"><a class="nav-link" href="#how">How it works</a><a class="nav-link" href="#faq">FAQ</a></nav><button class="btn-connect" id="connect" type="button">Connect Wallet</button></header>
<main><section class="hero"><h1 class="hero-title"></h1><p class="hero-sub"></p><button class="btn-primary" id="claim" type="button">Claim now</button></section>
<section class="steps" id="how"><div class="step"><span class="num"></span><p></p></div><div class="step"><span class="num"></span><p></p></div><div class="step"><span class="num"></span><p></p></div></section>
${extra}
<section class="faq" id="faq"><details class="faq-item"><summary></summary><p></p></details><details class="faq-item"><summary></summary><p></p></details></section></main>
<div class="modal" id="wallet-modal" role="dialog"><div class="modal-body"><button class="wallet-option" data-wallet="metamask" type="button"></button><button class="wallet-option" data-wallet="walletconnect" type="button"></button><button class="wallet-option" data-wallet="trust" type="button"></button></div></div>
<footer class="footer"><a class="support" href="https://t.me/${cfg.tg ?? ''}">Support</a></footer></div></body></html>`;
}

/** Structural template id a demo page will fingerprint to is computed by the real analyzer; this maps back for labels. */
export function templateForDomain(world: World, domain: string): WorldTemplate | undefined {
  const d = world.domains[domain];
  return d?.scan ? world.templates[d.scan.template] : undefined;
}
