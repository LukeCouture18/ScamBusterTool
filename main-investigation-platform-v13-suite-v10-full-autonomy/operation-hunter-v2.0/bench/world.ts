/**
 * Ground-truth worlds for benchmarking and adversarial testing.
 *
 * A seeded generator builds a small fictional internet: several scam
 * operations (one "target"), a commercial drainer kit sold by a vendor to more
 * than one operator, bulletproof hosting shared with unrelated sites, commodity
 * CDNs, parked and legitimate look-alike domains, planted "false flag"
 * indicators, stale scans that disagree with current DNS, takedowns,
 * rotations and domains that only appear later (reappearance).
 *
 * The world is served through the exact response formats of the public APIs
 * Hunter uses (see fakeNetwork.ts), so benchmarks exercise the real collectors
 * end to end. Everything here is synthetic.
 */

export type DomainRole = 'core' | 'sibling_op' | 'unrelated_op' | 'cohost_legit' | 'lookalike_legit' | 'parked' | 'cdn_customer';

export interface WorldDomain {
  name: string;
  op: string | null;            // ground-truth operation id (null = not part of any operation)
  role: DomainRole;
  registeredAt: number;         // world day
  liveFrom: number;
  liveTo: number | null;        // taken down / abandoned
  takedown: 'registry' | 'hosting' | null;
  registrar: string;
  ns: string[];
  ips: Array<{ ip: string; from: number; to: number | null }>;
  kit: { family: string; version: string } | null;
  title: string;
  ids: { ga?: string; telegram?: string; wc?: string; plantedTelegram?: string };
  wallets: string[];
  scanned: boolean;             // an archived public scan exists (urlscan)
  scanDay: number | null;
  scanIp: string | null;        // IP at scan time (may be stale vs DNS)
  certGroup: string;            // domains sharing a certificate
}

export interface WorldWallet { address: string; op: string | null; role: 'collection' | 'treasury' | 'fee' | 'deposit' | 'exchange' | 'mixer' | 'victim' | 'splitter'; label?: string }
export interface WorldTransfer { hash: string; from: string; to: string; wei: bigint; day: number }
export interface WorldCert { id: number; serial: string; names: string[]; day: number; issuer: string }
export interface WorldIp { ip: string; asn: number; holder: string; country: string; commodity: boolean }

export interface GroundTruthOperation {
  id: string; name: string; operator: { ga: string; telegram: string; ns: string[] }; kitVendor: string;
  domains: string[]; wallets: { collection: string[]; treasury: string[]; deposit: string[] };
}

export interface World {
  seed: number;
  day: number;                  // current world day (0 = world start)
  startMs: number;              // epoch ms of world day 0
  target: string;               // target operation id
  ops: GroundTruthOperation[];
  domains: Map<string, WorldDomain>;
  wallets: Map<string, WorldWallet>;
  transfers: WorldTransfer[];
  certs: WorldCert[];
  ips: Map<string, WorldIp>;
  kits: Map<string, { family: string; version: string; coreHash: string; html: (d: WorldDomain) => string }>;
  vendor: { feeWallet: string; wc: string; coreHash: string };
  adversarial: { plantedOn: string | null; lookalikes: string[]; staleScan: string | null; sourceDisagreement: string | null };
}

// ------------------------------------------------------------------ deterministic randomness
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(arr: T[]) => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    hex: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
}

const WORDS_A = ['claim', 'secure', 'wallet', 'airdrop', 'reward', 'bonus', 'refund', 'recovery', 'sync', 'verify', 'portal', 'connect', 'restore', 'migrate', 'unlock'];
const TLDS = ['xyz', 'top', 'click', 'link', 'app', 'online', 'site', 'live', 'pro', 'io'];
const LEGIT = ['bakery', 'plumbing', 'yoga', 'dental', 'garden', 'photo', 'travel', 'music', 'school', 'florist', 'autoparts', 'bistro', 'lawfirm', 'tutoring', 'petcare'];
const KIT_TITLES: Record<string, string> = { 'v3.1': 'Wallet Portal — Secure Asset Claim', 'v3.2': 'Wallet Portal — Secure Asset Claim', 'v4.0': 'Asset Recovery Center — Connect Wallet' };
const REGISTRARS = ['NameSilo, LLC', 'NameCheap, Inc.', 'Tucows Domains Inc.', 'PDR Ltd. d/b/a PublicDomainRegistry.com', 'Hostinger Operations, UAB'];

/** Build a world. `difficulty` 0..1 raises the share of hard-to-link sites and adversarial elements. */
export function generateWorld(seed: number, opts: { difficulty?: number; startDaysAgo?: number } = {}): World {
  const r = rng(seed);
  const difficulty = opts.difficulty ?? 0.5;
  const startMs = Date.now() - (opts.startDaysAgo ?? 150) * 86400000;
  const w: World = {
    seed, day: 110, startMs, target: 'op-target', ops: [], domains: new Map(), wallets: new Map(), transfers: [], certs: [], ips: new Map(), kits: new Map(),
    vendor: { feeWallet: evm(r), wc: `wc:${r.hex(32)}`, coreHash: r.hex(64) }, adversarial: { plantedOn: null, lookalikes: [], staleScan: null, sourceDisagreement: null },
  };
  // Infrastructure
  const bullet = { ip: ipv4(r, '185.193'), asn: 209588, holder: 'FLYHOSTING-AS FlyHosting LLC', country: 'SC', commodity: false };
  const bullet2 = { ip: ipv4(r, '194.26'), asn: 200019, holder: 'ALEXHOST SRL', country: 'MD', commodity: false };
  const bulletB = { ip: ipv4(r, '45.155'), asn: 211252, holder: 'AS-DELIS Delis LLC', country: 'NL', commodity: false };
  const cdn = { ip: `104.21.${r.int(1, 250)}.${r.int(1, 250)}`, asn: 13335, holder: 'CLOUDFLARENET', country: 'US', commodity: true };
  const cdn2 = { ip: `172.67.${r.int(1, 250)}.${r.int(1, 250)}`, asn: 13335, holder: 'CLOUDFLARENET', country: 'US', commodity: true };
  for (const ip of [bullet, bullet2, bulletB, cdn, cdn2]) w.ips.set(ip.ip, ip);
  const cfNs = ['aria.ns.cloudflare.com', 'kip.ns.cloudflare.com'];

  // Kit: one vendor, versions over time, sold to two operators
  const family = 'DrainKit';
  const versions = ['v3.1', 'v3.2', 'v4.0'];
  for (const [i, v] of versions.entries()) {
    const coreHash = r.hex(64);
    w.kits.set(v, { family, version: v, coreHash, html: d => kitHtml(v, i, d, w) });
  }

  // Operations
  const mkOp = (id: string, name: string, stem: string[]): GroundTruthOperation => ({
    id, name,
    operator: { ga: `G-${r.hex(10).toUpperCase()}`, telegram: `@${stem[0]}_${r.pick(['support', 'help', 'desk', 'team'])}${r.int(1, 99)}`, ns: [`ns1.${stem[1]}-dns.${r.pick(['is', 'net', 'cc'])}`, `ns2.${stem[1]}-dns.${r.pick(['is', 'net', 'cc'])}`] },
    kitVendor: family, domains: [], wallets: { collection: [], treasury: [], deposit: [] },
  });
  const opA = mkOp('op-target', 'Target operation', ['claimdesk', 'offshore']);
  opA.operator.ns = [opA.operator.ns[0], opA.operator.ns[0].replace('ns1.', 'ns2.')];
  const opB = mkOp('op-sibling', 'Sibling operation (same kit, different operator)', ['bonusteam', 'shadow']);
  opB.operator.ns = [opB.operator.ns[0], opB.operator.ns[0].replace('ns1.', 'ns2.')];
  const opC = mkOp('op-unrelated', 'Unrelated operation on shared hosting', ['pharma', 'bulk']);
  opC.operator.ns = [opC.operator.ns[0], opC.operator.ns[0].replace('ns1.', 'ns2.')];
  w.ops.push(opA, opB, opC);

  const usedNames = new Set<string>();
  // Operators reuse naming templates: one or two stem words plus variable words and a suffix.
  const stemsA = [r.pick(WORDS_A), r.pick(WORDS_A)];
  const suffixA = r.pick(['portal', 'center', 'hub', 'desk']);
  const name = (words: string[], tld?: string, stems?: string[], suffix?: string) => {
    for (let i = 0; i < 50; i++) {
      const first = stems && r.chance(0.75) ? r.pick(stems) : r.pick(words);
      const n = `${first}-${r.pick(words)}-${suffix && r.chance(0.7) ? suffix : r.pick(['portal', 'center', 'hub', 'app', 'desk', 'zone'])}.${tld ?? r.pick(TLDS)}`;
      if (!usedNames.has(n) && !n.split('.')[0].split('-').some((t, i2, arr) => arr.indexOf(t) !== i2)) { usedNames.add(n); return n; }
    }
    const n = `${r.pick(words)}${r.int(100, 999)}.${tld ?? r.pick(TLDS)}`; usedNames.add(n); return n;
  };

  // Target operation: waves over time; some hard (Cloudflare-fronted, only linkable via certs/ids/wallets)
  const waves = [
    { start: 5, n: 3, kit: 'v3.1' },
    { start: 40, n: 3, kit: 'v3.2' },
    { start: 80, n: 3, kit: 'v4.0' },
    { start: 125, n: 2, kit: 'v4.0' }, // future wave: appears after world.advance → reappearance test
  ];
  let certId = 9000000 + r.int(0, 99999);
  const mkCert = (names: string[], day: number, issuer = r.pick(["C=US, O=Let's Encrypt, CN=R11", 'C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA', "C=US, O=Google Trust Services, CN=WE1"])) => {
    w.certs.push({ id: certId++, serial: r.hex(16), names, day, issuer });
  };
  const collectionByWave: string[] = [];
  for (const [wi, wave] of waves.entries()) {
    const coll = evm(r);
    collectionByWave.push(coll);
    w.wallets.set(coll, { address: coll, op: opA.id, role: 'collection' });
    opA.wallets.collection.push(coll);
    const waveDomains: string[] = [];
    for (let k = 0; k < wave.n; k++) {
      const hard = r.chance(0.2 + difficulty * 0.35);
      const reg = wave.start + r.int(0, 3);
      const d: WorldDomain = {
        name: name(WORDS_A, undefined, stemsA, suffixA), op: opA.id, role: 'core', registeredAt: reg, liveFrom: reg + r.int(1, 3), liveTo: null, takedown: null,
        registrar: wi % 2 ? REGISTRARS[0] : REGISTRARS[1], ns: hard ? cfNs : opA.operator.ns,
        ips: [{ ip: hard ? cdn.ip : (wi < 2 ? bullet.ip : bullet2.ip), from: reg, to: null }], kit: { family, version: wave.kit },
        title: r.chance(0.6) ? KIT_TITLES[wave.kit] : `${cap(r.pick(WORDS_A))} ${cap(r.pick(['Portal', 'Center', 'Hub']))} — ${r.pick(['Claim your tokens', 'Secure your wallet', 'Restore access'])}`,
        ids: { ga: opA.operator.ga, telegram: r.chance(0.8) ? opA.operator.telegram : undefined, wc: w.vendor.wc }, wallets: [coll],
        scanned: r.chance(0.85 - difficulty * 0.2), scanDay: null, scanIp: null, certGroup: '',
      };
      d.scanDay = d.scanned ? d.liveFrom + r.int(1, 6) : null;
      d.scanIp = d.ips[0].ip;
      w.domains.set(d.name, d);
      waveDomains.push(d.name);
      opA.domains.push(d.name);
    }
    // certificates: pairs of the wave share a SAN certificate; the rest get their own
    for (let k = 0; k < waveDomains.length; k += 2) {
      const group = waveDomains.slice(k, k + (r.chance(0.6) ? 2 : 1));
      for (const g of group) w.domains.get(g)!.certGroup = group.join('+');
      mkCert(group.flatMap(g => [g, `www.${g}`]), wave.start + 4);
      if (group.length === 2 && waveDomains[k + 1] && !group.includes(waveDomains[k + 1])) mkCert([waveDomains[k + 1]], wave.start + 4);
    }
    for (const dn of waveDomains) if (!w.certs.some(c => c.names.includes(dn))) mkCert([dn, `www.${dn}`], w.domains.get(dn)!.liveFrom);
    // older waves get taken down when the next wave starts (rotation)
    if (wi > 0) {
      for (const prev of opA.domains.filter(dn => w.domains.get(dn)!.registeredAt < wave.start && w.domains.get(dn)!.liveTo === null)) {
        const pd = w.domains.get(prev)!;
        if (r.chance(0.7)) { pd.liveTo = wave.start + r.int(0, 4); pd.takedown = r.chance(0.5) ? 'registry' : 'hosting'; }
      }
    }
  }
  // one reserve domain registered but never served (standby)
  const reserve: WorldDomain = { name: name(WORDS_A, undefined, stemsA, suffixA), op: opA.id, role: 'core', registeredAt: 84, liveFrom: 9999, liveTo: null, takedown: null, registrar: REGISTRARS[0], ns: opA.operator.ns, ips: [], kit: null, title: '', ids: {}, wallets: [], scanned: false, scanDay: null, scanIp: null, certGroup: '' };
  w.domains.set(reserve.name, reserve); opA.domains.push(reserve.name);
  mkCert([reserve.name], 86);

  // Money: victims → collection → 80% treasury / 20% vendor fee → treasury → exchange deposit → exchange; part to mixer
  const treasury = evm(r); const treasury2 = evm(r); const deposit = evm(r); const binance = '0x28c6c06298d514db089934071355e5743bf21d60'; const tornado = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31';
  w.wallets.set(treasury, { address: treasury, op: opA.id, role: 'treasury' });
  w.wallets.set(treasury2, { address: treasury2, op: opA.id, role: 'treasury' });
  w.wallets.set(deposit, { address: deposit, op: opA.id, role: 'deposit' });
  w.wallets.set(binance, { address: binance, op: null, role: 'exchange', label: 'Binance 14' });
  w.wallets.set(tornado, { address: tornado, op: null, role: 'mixer', label: 'Tornado Cash Router' });
  w.wallets.set(w.vendor.feeWallet, { address: w.vendor.feeWallet, op: null, role: 'fee' });
  opA.wallets.treasury.push(treasury, treasury2); opA.wallets.deposit.push(deposit);
  let tx = 1;
  const send = (from: string, to: string, eth: number, day: number) => w.transfers.push({ hash: `0x${(seed * 1000 + tx++).toString(16).padStart(64, '0')}`, from, to, wei: BigInt(Math.round(eth * 1e6)) * 10n ** 12n, day });
  for (const [wi, coll] of collectionByWave.entries()) {
    const base = waves[wi].start + 6;
    for (let v = 0; v < r.int(4, 7); v++) {
      const victim = evm(r); w.wallets.set(victim, { address: victim, op: null, role: 'victim' });
      const amt = r.int(5, 60) / 10;
      const day = base + v * 2;
      send(victim, coll, amt, day);
      send(coll, wi < 2 ? treasury : treasury2, amt * 0.8, day + 0.002);
      send(coll, w.vendor.feeWallet, amt * 0.2, day + 0.002);
    }
  }
  send(treasury, deposit, 12, 70); send(deposit, binance, 12, 70.01);
  send(treasury, tornado, 4, 75); send(treasury2, deposit, 8, 100); send(deposit, binance, 8, 100.01);

  // Sibling operation B: same kit + vendor (fee wallet, WalletConnect ID, core script) — different operator
  const collB = evm(r); w.wallets.set(collB, { address: collB, op: opB.id, role: 'collection' }); opB.wallets.collection.push(collB);
  const treasB = evm(r); w.wallets.set(treasB, { address: treasB, op: opB.id, role: 'treasury' }); opB.wallets.treasury.push(treasB);
  for (let k = 0; k < 4; k++) {
    const reg = 30 + k * 15;
    const d: WorldDomain = {
      name: name(['bonus', 'airdrop', 'mint', 'drop', 'nft', 'free', 'gift', 'lucky']), op: opB.id, role: 'sibling_op', registeredAt: reg, liveFrom: reg + 1, liveTo: null, takedown: null,
      registrar: REGISTRARS[2], ns: k === 3 ? cfNs : opB.operator.ns, ips: [{ ip: k === 3 ? cdn2.ip : bulletB.ip, from: reg, to: null }], kit: { family, version: k < 2 ? 'v3.2' : 'v4.0' },
      title: r.chance(0.6) ? KIT_TITLES[k < 2 ? 'v3.2' : 'v4.0'] : `${cap(r.pick(['Mint', 'Bonus', 'Gift']))} Drop — ${r.pick(['Free mint', 'Claim bonus'])}`, ids: { ga: opB.operator.ga, telegram: opB.operator.telegram, wc: w.vendor.wc }, wallets: [collB],
      scanned: true, scanDay: reg + 3, scanIp: k === 3 ? cdn2.ip : bulletB.ip, certGroup: '',
    };
    w.domains.set(d.name, d); opB.domains.push(d.name); mkCert([d.name, `www.${d.name}`], reg + 1);
  }
  // False flag: one B site also displays A's Telegram handle (copied support contact / planted)
  if (difficulty >= 0.3) {
    const victimSite = w.domains.get(opB.domains[1])!;
    victimSite.ids.plantedTelegram = opA.operator.telegram;
    w.adversarial.plantedOn = victimSite.name;
  }
  for (let v = 0; v < 5; v++) { const victim = evm(r); w.wallets.set(victim, { address: victim, op: null, role: 'victim' }); const amt = r.int(5, 40) / 10; send(victim, collB, amt, 40 + v * 5); send(collB, treasB, amt * 0.8, 40 + v * 5 + 0.002); send(collB, w.vendor.feeWallet, amt * 0.2, 40 + v * 5 + 0.002); }
  send(treasB, binance, 5, 90);

  // Unrelated operation C on A's bulletproof server (different kit, different everything)
  for (let k = 0; k < 3; k++) {
    const reg = 20 + k * 20;
    const d: WorldDomain = {
      name: `${r.pick(['cheap', 'best', 'rx', 'meds'])}-${r.pick(['pharma', 'pills', 'store'])}${r.int(10, 99)}.${r.pick(['shop', 'store', 'online'])}`, op: opC.id, role: 'unrelated_op', registeredAt: reg, liveFrom: reg + 1, liveTo: null, takedown: null,
      registrar: REGISTRARS[3], ns: opC.operator.ns, ips: [{ ip: bullet.ip, from: reg, to: null }], kit: null, title: 'Online Pharmacy — Discount', ids: { ga: opC.operator.ga }, wallets: [], scanned: r.chance(0.7), scanDay: reg + 5, scanIp: bullet.ip, certGroup: '',
    };
    w.domains.set(d.name, d); opC.domains.push(d.name); mkCert([d.name], reg + 1);
  }
  // Co-hosted legitimate sites on the bulletproof IPs, and many customers on the CDN IPs
  for (let k = 0; k < 6 + Math.round(difficulty * 8); k++) {
    const ip = r.pick([bullet.ip, bullet2.ip]);
    const d: WorldDomain = { name: `${r.pick(LEGIT)}-${r.pick(LEGIT)}${r.int(1, 99)}.${r.pick(['com', 'net', 'org', 'eu'])}`, op: null, role: 'cohost_legit', registeredAt: r.int(-900, 50), liveFrom: 0, liveTo: null, takedown: null, registrar: r.pick(REGISTRARS), ns: [`ns1.${r.pick(['hostinger', 'bluehost', 'ovh'])}.com`], ips: [{ ip, from: -900, to: null }], kit: null, title: 'Small business', ids: {}, wallets: [], scanned: r.chance(0.3), scanDay: 30, scanIp: ip, certGroup: '' };
    w.domains.set(d.name, d); mkCert([d.name], r.int(0, 100));
  }
  // Legitimate look-alikes matching the naming pattern (should never be absorbed)
  for (let k = 0; k < 2; k++) {
    const d: WorldDomain = { name: name(['claim', 'secure', 'wallet', 'recovery'], 'com'), op: null, role: 'lookalike_legit', registeredAt: -400, liveFrom: -399, liveTo: null, takedown: null, registrar: REGISTRARS[4], ns: cfNs, ips: [{ ip: cdn2.ip, from: -400, to: null }], kit: null, title: 'Insurance claims help', ids: {}, wallets: [], scanned: true, scanDay: 50, scanIp: cdn2.ip, certGroup: '' };
    w.domains.set(d.name, d); w.adversarial.lookalikes.push(d.name); mkCert([d.name], 60);
  }
  // Stale scan: one core site moved hosting after it was scanned (scan IP ≠ current DNS)
  const movable = opA.domains.map(n => w.domains.get(n)!).find(d => d.scanned && d.ips[0]?.ip === bullet.ip && d.liveTo === null);
  if (movable) {
    movable.ips = [{ ip: bullet.ip, from: movable.registeredAt, to: movable.scanDay! + 5 }, { ip: bullet2.ip, from: movable.scanDay! + 5, to: null }];
    w.adversarial.staleScan = movable.name;
  }
  return w;
}

// ------------------------------------------------------------------ world queries
export const dayIso = (w: World, day: number) => new Date(w.startMs + day * 86400000).toISOString();

export function isRegistered(d: WorldDomain, day: number) { return d.registeredAt <= day; }
export function isLive(d: WorldDomain, day: number) { return d.liveFrom <= day && (d.liveTo === null || d.liveTo > day); }
export function currentIps(d: WorldDomain, day: number) {
  if (!isRegistered(d, day) || d.liveFrom > day) return [];
  if (d.liveTo !== null && d.liveTo <= day) return [];
  return d.ips.filter(i => i.from <= day && (i.to === null || i.to > day)).map(i => i.ip);
}
export function currentNs(d: WorldDomain, day: number) {
  if (!isRegistered(d, day)) return [];
  if (d.takedown === 'registry' && d.liveTo !== null && d.liveTo <= day) return [];
  return d.ns;
}
export function everIps(d: WorldDomain, day: number) { return d.ips.filter(i => i.from <= day).map(i => i.ip); }

/** Ground truth used for scoring: target-operation domains that exist by `day`. */
export function truthDomains(w: World, op = w.target) {
  return [...w.domains.values()].filter(d => d.op === op && d.registeredAt <= w.day).map(d => d.name);
}

export function advance(w: World, days: number) { w.day += days; }

// ------------------------------------------------------------------ helpers
function evm(r: ReturnType<typeof rng>) { return `0x${r.hex(40)}`; }
function ipv4(r: ReturnType<typeof rng>, prefix: string) { return `${prefix}.${r.int(1, 254)}.${r.int(2, 250)}`; }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Page HTML for a kit version: structure depends on the version; config (operator ids, wallets) on the deployment. */
function kitHtml(version: string, vi: number, d: WorldDomain, w: World): string {
  const extra = vi >= 1 ? '<section class="stats"><div class="stat"><span></span><b></b></div><div class="stat"><span></span><b></b></div></section>' : '';
  const extra2 = vi >= 2 ? '<section class="roadmap"><ol><li></li><li></li><li></li></ol></section><script>async function t(){await tronWeb.trx.sign(x)}</script>' : '';
  const telegram = d.ids.telegram ?? d.ids.plantedTelegram;
  const telegram2 = d.ids.plantedTelegram && d.ids.telegram ? d.ids.plantedTelegram : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${d.title}</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=${d.ids.ga ?? ''}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('config','${d.ids.ga ?? ''}');</script>
<script src="/assets/js/core.min.js?v=${version}"></script>
<script>const cfg={projectId:"${(d.ids.wc ?? '').replace('wc:', '')}",receiver:"${d.wallets[0] ?? ''}"};const modal=createWeb3Modal({projectId:cfg.projectId});async function drain(){await provider.request({method:"eth_signTypedData_v4"});await c.setApprovalForAll(cfg.receiver,true)}</script></head>
<body><div id="root"><header class="top"><a class="brand" href="/"><img alt="" src="/logo.svg"></a><nav><a href="#faq"></a><a href="#claim"></a></nav><button class="wallet-connect" type="button"></button></header>
<main><section class="hero"><h1></h1><p class="lead"></p><button id="claim" class="cta" type="button"></button></section>${extra}${extra2}
<section id="faq" class="faq"><details><summary></summary><p></p></details><details><summary></summary><p></p></details></section></main>
<footer><p>Support: ${telegram ? `<a href="https://t.me/${telegram.replace('@', '')}">${telegram}</a>` : ''}${telegram2 ? ` · <a href="https://t.me/${telegram2.replace('@', '')}">${telegram2}</a>` : ''}</p></footer></div></body></html>`;
}

/** Resource hashes loaded by a deployment: vendor core (kit-level, shared), per-version core, per-operator config, commodity library. */
export function siteResources(w: World, d: WorldDomain): Array<{ url: string; hash: string; mime: string }> {
  if (!d.kit) return d.role === 'cohost_legit' || d.role === 'lookalike_legit' ? [{ url: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', hash: 'f'.repeat(64), mime: 'application/javascript' }] : [];
  const kit = w.kits.get(d.kit.version)!;
  const opHash = hashOf(`config:${d.op}:${d.kit.version}`);
  return [
    { url: `https://${d.name}/assets/js/core.min.js?v=${d.kit.version}`, hash: kit.coreHash, mime: 'application/javascript' },
    { url: `https://${d.name}/assets/js/cfg.js`, hash: opHash, mime: 'application/javascript' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', hash: 'f'.repeat(64), mime: 'application/javascript' },
  ];
}

export function hashOf(s: string) {
  // tiny deterministic 256-bit hex hash (FNV-1a lanes) — not cryptographic, only for fixture identity
  let out = '';
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ lane;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
