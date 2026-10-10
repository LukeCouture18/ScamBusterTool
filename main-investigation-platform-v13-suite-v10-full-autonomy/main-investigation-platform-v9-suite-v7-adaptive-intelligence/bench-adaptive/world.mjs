/**
 * v7 HIDDEN OPERATION WORLD (benchmark truth). OFFLINE EVALUATION ONLY.
 *
 * This module holds fixture truth: which sites belong to which operation, which wallets are
 * deposit wallets, when sites die, rotate, get replaced, or appear in a new wave. Production
 * decision code (lib/**) never imports this file. Policies only ever see `world.observed()`,
 * a deep copy of what simulated specialists have legitimately revealed so far.
 *
 * Specialists are simulated (public/passive semantics only): Finder returns observations,
 * Site Investigator reveals public page facts, Wallet Investigator validates/analyses read-only,
 * Hunter answers evidence-bound questions. Request costs follow the instrumented v6 workflow:
 * a Finder round ≈ 20 DNS + 4 CT + 1 RDAP + ~2 HTTP per probed candidate; a site inspection
 * ≈ 12 HTTP + 6 DNS + 1 TLS.
 */

const h32 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const chance = (key, p) => (h32(key) % 10000) / 10000 < p;
const dom = (op, i) => `${op.toLowerCase()}${(h32(`${op}:${i}`) % 9000 + 1000).toString(36)}-${i}.example`;

/** Builds a world: several independent operations plus unrelated kit users and decoys. */
export function buildWorld(seed = 1, spec = {}) {
  const sites = {}, wallets = {}, ops = {};
  // Structure varies with the seed (sizes, timings, which sites die/rotate, link topology); scenario types stay fixed.
  const v = (k, lo, span) => lo + (h32(`${seed}:${k}`) % span);
  const opDefs = spec.ops ?? [
    { id: 'A', kit: 'K1', n: v('An', 5, 3), wave: { at: v('Aw', 6, 4), n: v('Awn', 1, 3) }, die: [{ i: 2, at: v('Ad', 3, 4), replace: true }], rotate: [{ i: 1, at: v('Ar', 4, 4) }], chain: seed % 2 === 1 },
    { id: 'B', kit: 'K1', n: v('Bn', 4, 3), wave: null, die: [], rotate: seed % 3 === 0 ? [{ i: 0, at: 5 }] : [], login: [3] },
    { id: 'C', kit: 'K2', n: v('Cn', 5, 3), wave: { at: v('Cw', 7, 4), n: 2 }, die: [{ i: 4, at: v('Cd', 6, 4), replace: true }], rotate: [], chain: seed % 2 === 0 },
    { id: 'D', kit: 'K2', n: v('Dn', 5, 3), wave: null, die: [{ i: v('Di', 3, 2), at: v('Dd', 2, 4), replace: false }], rotate: [], split: true },
  ];
  for (const d of opDefs) {
    const id = `${d.id}${seed}`, contact = `${id.toLowerCase()}_support`, contact2 = `${id.toLowerCase()}_desk`, analytics = `ga4:g-${id.toLowerCase()}${h32(id) % 997}`;
    const w = [`0x${h32(`${id}:w0`).toString(16).padStart(8, '0').repeat(5)}`, `0x${h32(`${id}:w1`).toString(16).padStart(8, '0').repeat(5)}`, `0x${h32(`${id}:w2`).toString(16).padStart(8, '0').repeat(5)}`];
    for (const a of w) wallets[a] = { op: id, deposit: true, counterparty: `0x${'e'.repeat(40)}` };
    const list = [];
    const total = d.n + (d.wave?.n ?? 0);
    for (let i = 0; i < total; i++) {
      const key = dom(id, i), inWave = i >= d.n;
      const group = d.split && i >= Math.ceil(d.n / 2) ? 2 : 1;
      sites[key] = { op: id, kit: d.kit, cdn: 'cdn-shared', contact: group === 2 ? contact2 : contact, analytics: group === 2 ? null : analytics, title: `${d.kit} investment platform`,
        links: [], appear: inWave ? d.wave.at : 0, die: null, replacement_of: null, wave: inWave ? 1 : 0, deposit: [{ from: 0, wallet: w[i % 2] }], history: [], login: (d.login ?? []).includes(i), group };
      list.push(key);
    }
    // Link graph: a chain (multi-hop: each site links to the next), plus a few back links.
    if (d.links !== false) {
      for (let i = 0; i < d.n - 1; i++) sites[list[i]].links.push(list[i + 1]);
      if (!d.chain) for (let i = 2; i < d.n; i++) if (chance(`${id}:back:${i}`, .5)) sites[list[i]].links.push(list[0]);
    }
    if (d.wave) for (let i = d.n; i < total; i++) sites[list[i]].links.push(list[d.n - 1]);
    for (const r of d.rotate) sites[list[r.i]].deposit.push({ from: r.at, wallet: w[2] });
    for (const x of d.die) {
      sites[list[x.i]].die = x.at;
      if (x.replace) { const key = dom(id, 100 + x.i); sites[key] = { ...sites[list[x.i]], links: [], appear: x.at + 1, die: null, replacement_of: list[x.i], wave: 0, deposit: [{ from: 0, wallet: w[2] }], history: [] }; list.push(key); }
    }
    // A transaction-history page shows another operation's wallet: a decoy, never a deposit.
    sites[list[0]].history.push(`0x${'f'.repeat(40)}`);
    ops[id] = { id, seed: list[0], kit: d.kit, sites: list, contact, analytics, split: Boolean(d.split) };
  }
  // Unrelated kit users (shared kit / shared CDN decoys) with their own contacts and wallets.
  for (let i = 0; i < (spec.decoys ?? (6 + (h32(`decoys:${seed}`) % 6))); i++) {
    const key = `kituser${seed}-${i}.example`, wallet = `0x${h32(`decoy:${seed}:${i}`).toString(16).padStart(8, '0').repeat(5)}`;
    wallets[wallet] = { op: null, deposit: true, counterparty: `0x${'e'.repeat(40)}` };
    sites[key] = { op: null, kit: i % 2 ? 'K1' : 'K2', cdn: 'cdn-shared', contact: `independent_${seed}_${i}`, analytics: null, title: `${i % 2 ? 'K1' : 'K2'} investment platform`, links: [], appear: 0, die: null, replacement_of: null, wave: 0, deposit: [{ from: 0, wallet }], history: [], login: false, group: 0 };
  }
  return new World({ seed, tick: 0, sites, wallets, ops, provider_outage: spec.provider_outage ?? [5, 9], observed: initialObserved(ops) });
}

function initialObserved(ops) {
  const observed = { tick: 0, ops: {}, sites: {}, wallets: {}, finder: {}, pipeline: [], requests: 0, provider_calls: 0, jobs: 0, false_relationships: 0 };
  for (const op of Object.values(ops)) {
    observed.ops[op.id] = { id: op.id, seed: op.seed, hunter: { runs: 0, evidence_at_last_run: 0, contradiction: 'none', wave_flag: false, linkage: 'open', activity: 'open' }, evidence_units: 0 };
    observed.sites[op.seed] = { key: op.seed, op: op.id, found_by: 'seed', found_at: 0, inspected: false, status: 'live', artifacts: null, deposit: [], history: [], login: false, inspected_at: null };
    observed.finder[op.id] = { seeds: [], artifacts: [], returned: [] };
  }
  return observed;
}

export class World {
  constructor(state) { this.s = state; }
  clone() { return new World(structuredClone(this.s)); }
  /** The ONLY thing a policy may read. */
  observed() { return structuredClone(this.s.observed); }
  live(key, t = this.s.tick) { const x = this.s.sites[key]; return Boolean(x) && x.appear <= t && (x.die == null || t < x.die); }
  depositAt(key, t = this.s.tick) { const x = this.s.sites[key]; let w = null; for (const d of x.deposit) if (d.from <= t) w = d.wallet; return w; }

  /** Standing monitors (Hunter liveness facets): status of known sites changes as the world changes. */
  advance() {
    const s = this.s; s.tick += 1; s.observed.tick = s.tick;
    for (const [key, o] of Object.entries(s.observed.sites)) {
      const before = o.status, now = this.live(key) ? (before === 'dead' ? 'returned' : 'live') : 'dead';
      o.status = now === 'live' && before === 'returned' ? 'returned' : now;
      // Hunter's build/wallet monitor notices that a public page changed (not what it changed to).
      if (o.inspected && o.inspected_at != null && this.live(key) && this.depositAt(key) !== this.depositAt(key, o.inspected_at) && !o.deposit.includes(this.depositAt(key))) o.monitor_changed = true;
    }
    // Hunter's rhythm forecast: a wave becomes "due" once the operation has a few inspected sites.
    for (const op of Object.values(s.ops)) {
      const def = Object.values(s.sites).some(x => x.op === op.id && x.wave === 1 && x.appear <= s.tick + 1);
      const inspected = op.sites.filter(k => s.observed.sites[k]?.inspected).length;
      if (def && inspected >= 3 && !s.observed.ops[op.id].hunter.wave_flag) { s.observed.ops[op.id].hunter.wave_flag = true; s.observed.ops[op.id].waves = (s.observed.ops[op.id].waves ?? 0) + 1; }
    }
  }

  // ------------------------------------------------------------------ specialists
  /** Site Finder: observations only. Persistent pursuit per operation (repeat requests never repeat work). */
  finder(opId, { seeds = [], artifacts = [], mode = 'related' } = {}) {
    const s = this.s, ob = s.observed, f = ob.finder[opId], t = s.tick;
    const pool = [];
    const known = k => Boolean(ob.sites[k]) || f.returned.includes(k);
    const frontier = [...new Set([...seeds, ...f.returned])];
    for (const seed of frontier) for (const l of s.sites[seed]?.links ?? []) if (this.live(l) && !known(l)) pool.push([l, 'link']);
    for (const a of artifacts) {
      for (const [k, x] of Object.entries(s.sites)) {
        if (!this.live(k) || known(k)) continue;
        const match = (a.kind === 'contact' && x.contact === a.value) || (a.kind === 'analytics' && x.analytics === a.value) || (a.kind === 'wallet' && this.depositAt(k) === a.value);
        if (match && chance(`${k}:${a.value}`, .55)) pool.push([k, `artifact:${a.kind}`]);
        const kitMatch = (a.kind === 'title' || mode === 'template_variant') && x.title === a.value;
        if (kitMatch && chance(`${k}:kit:${t}`, .35)) pool.push([k, 'template']);
      }
    }
    if (mode === 'template_variant') { const kit = s.ops[opId].kit; for (const [k, x] of Object.entries(s.sites)) if (x.kit === kit && this.live(k) && !known(k) && chance(`${k}:tv:${t}`, .3)) pool.push([k, 'template']); }
    if (mode === 'replacement') for (const seed of seeds) for (const [k, x] of Object.entries(s.sites)) if (x.replacement_of === seed && this.live(k) && !known(k)) pool.push([k, 'replacement']);
    if (mode === 'wave') for (const [k, x] of Object.entries(s.sites)) if (x.op === opId && x.wave === 1 && this.live(k) && !known(k) && artifacts.some(a => a.value === x.contact || a.value === x.analytics)) pool.push([k, 'wave']);
    const uniq = [...new Map(pool.map(p => [p[0], p])).values()].sort((a, b) => h32(`${opId}:${a[0]}`) - h32(`${opId}:${b[0]}`)).slice(0, 3);
    for (const sd of seeds) if (!f.seeds.includes(sd)) f.seeds.push(sd);
    for (const a of artifacts) if (!f.artifacts.includes(String(a.value))) f.artifacts.push(String(a.value));
    const found = [];
    for (const [k, why] of uniq) {
      f.returned.push(k);
      ob.sites[k] = { key: k, op: opId, found_by: why, found_at: t, inspected: false, status: 'live', artifacts: null, deposit: [], history: [], login: false, inspected_at: null };
      ob.pipeline.push(k); found.push(k);
      if (s.sites[k].op !== opId) ob.false_relationships += 1; // proposed under the wrong operation (kit/CDN decoy)
    }
    const cost = { dns: 20, certificate: 4, rdap: 1, http: 2 * uniq.length + (artifacts.length ? 1 : 0) };
    ob.requests += cost.dns + cost.certificate + cost.rdap + cost.http; ob.jobs += 1;
    return { found, cost };
  }

  /** Site Investigator: public page facts of one site. */
  inspect(key) {
    const s = this.s, ob = s.observed, o = ob.sites[key], x = s.sites[key];
    ob.jobs += 1;
    if (!this.live(key)) { ob.requests += 8; o.inspected = true; o.failed = true; o.inspected_at = s.tick; return { ok: false, cost: { http: 4, dns: 4 } }; }
    ob.requests += 19;
    o.inspected = true; o.inspected_at = s.tick; o.login = x.login;
    o.artifacts = { contact: x.contact, analytics: x.analytics, title: x.title, kit: x.kit, cdn: x.cdn };
    const w = x.login ? null : this.depositAt(key);
    if (w && !o.deposit.includes(w)) o.deposit.push(w);
    o.history = [...x.history];
    for (const a of [w, ...x.history].filter(Boolean)) {
      const wo = ob.wallets[a] ??= { address: a, sites: [], deposit_sites: [], validated: false, analysis: 'none', reviewed: false };
      if (!wo.sites.includes(key)) wo.sites.push(key);
      if (a === w && !wo.deposit_sites.includes(key)) wo.deposit_sites.push(key);
    }
    this.bumpEvidence(o.op);
    return { ok: true, wallet: w, cost: { http: 12, dns: 6, tls: 1 } };
  }

  /** TEMPORAL_RECHECK: the same public collector with a smaller page budget (≈ 10 HTTP + 2 DNS). */
  recheck(key) {
    const s = this.s, ob = s.observed, o = ob.sites[key];
    ob.jobs += 1; ob.requests += 12;
    if (!o) return { ok: false, changed: false };
    o.monitor_changed = false;
    if (!this.live(key)) { const changed = o.status !== 'dead'; o.status = 'dead'; return { ok: false, changed }; }
    const w = s.sites[key].login ? null : this.depositAt(key), changed = Boolean(w) && !o.deposit.includes(w);
    if (changed) { o.deposit.push(w); const wo = ob.wallets[w] ??= { address: w, sites: [], deposit_sites: [], validated: false, analysis: 'none', reviewed: false }; if (!wo.sites.includes(key)) wo.sites.push(key); if (!wo.deposit_sites.includes(key)) wo.deposit_sites.push(key); this.bumpEvidence(o.op); }
    return { ok: true, changed };
  }

  /** Wallet Investigator: validation is authoritative; analysis needs the provider (outage window). */
  walletPipeline() {
    const s = this.s, ob = s.observed; let calls = 0;
    for (const w of Object.values(ob.wallets)) {
      if (!w.deposit_sites.length) continue;
      if (!w.validated) { w.validated = Boolean(s.wallets[w.address]); }
      if (w.validated && w.analysis !== 'completed') {
        const out = s.tick >= s.provider_outage[0] && s.tick < s.provider_outage[1];
        if (w.analysis === 'none' || (w.analysis === 'partial' && !out)) { calls += 2; w.analysis = out ? 'partial' : 'completed'; }
      }
    }
    ob.provider_calls += calls;
    return calls;
  }

  /** Operation Hunter: evidence-bound answers from what Main has observed (never from truth). */
  hunter(opId) {
    const s = this.s, ob = s.observed, o = ob.ops[opId];
    ob.requests += 30; ob.jobs += 1; o.hunter.runs += 1;
    const sites = Object.values(ob.sites).filter(x => x.op === opId && x.inspected && x.artifacts);
    const before = JSON.stringify(o.hunter);
    const reuse = Object.values(ob.wallets).some(w => w.validated && w.deposit_sites.filter(k => ob.sites[k]?.op === opId).length >= 2);
    const contacts = new Map(); for (const x of sites) contacts.set(x.artifacts.contact, (contacts.get(x.artifacts.contact) ?? 0) + 1);
    const shared = [...contacts.values()].some(n => n >= 2);
    if (reuse || shared) o.hunter.linkage = 'discriminated';
    // Late contradiction: two groups share a deposit wallet but present different support contacts.
    const groups = new Set(sites.filter(x => s.sites[x.key]?.op === opId).map(x => x.artifacts.contact));
    if (s.ops[opId]?.split && groups.size >= 2) o.hunter.contradiction = o.hunter.contradiction === 'none' ? 'open' : o.hunter.evidence_at_last_run < o.evidence_units ? 'resolved' : o.hunter.contradiction;
    if (o.hunter.wave_flag) o.hunter.activity = 'moving_or_active';
    o.hunter.evidence_at_last_run = o.evidence_units;
    return { changed: before !== JSON.stringify(o.hunter) };
  }

  correlation(address) { const w = this.s.observed.wallets[address]; if (w) w.reviewed = true; return { reuse: Boolean(w && w.deposit_sites.length >= 2) }; }

  bumpEvidence(opId) { if (this.s.observed.ops[opId]) this.s.observed.ops[opId].evidence_units += 1; }

  /** The always-on Main pipeline (identical for every policy): inspect up to 2 queued discoveries, then wallets. */
  pipeline() { const q = this.s.observed.pipeline.splice(0, 2); for (const k of q) this.inspect(k); this.walletPipeline(); return q; }

  // ------------------------------------------------------------------ truth-side scoring (benchmark only)
  score() {
    const s = this.s, ob = s.observed;
    const trueSites = Object.entries(s.sites).filter(([, x]) => x.op && x.appear <= s.tick);
    const discovered = trueSites.filter(([k, x]) => ob.sites[k] && ob.sites[k].op === x.op && ob.ops[x.op]?.seed !== k);
    const inspected = discovered.filter(([k]) => ob.sites[k].inspected && !ob.sites[k].failed);
    const validatedWallets = Object.values(ob.wallets).filter(w => w.validated && s.wallets[w.address]?.op && w.deposit_sites.length).length;
    const reports = Object.values(ob.sites).filter(x => x.inspected && x.deposit.some(a => ob.wallets[a]?.analysis === 'completed')).length;
    const multihop = discovered.filter(([k]) => { const x = ob.sites[k]; return x.found_by === 'link' && !s.sites[ob.ops[s.sites[k].op]?.seed]?.links.includes(k); }).length;
    const replacements = discovered.filter(([, x]) => x.replacement_of).length, wave = discovered.filter(([, x]) => x.wave === 1).length;
    const linkage = Object.values(ob.ops).filter(o => o.hunter.linkage === 'discriminated').length;
    const contradictions = Object.values(ob.ops).filter(o => o.hunter.contradiction === 'resolved').length;
    return { hidden_sites_discovered: discovered.length, true_sites_existing: trueSites.length - Object.keys(s.ops).length, validated_true_wallets: validatedWallets, multi_hop: multihop, replacements_found: replacements, wave_sites_found: wave,
      linkage_discriminated: linkage, contradictions_resolved: contradictions, reports_ready: reports, false_relationships: ob.false_relationships, requests: ob.requests, provider_calls: ob.provider_calls, jobs: ob.jobs, inspected_true: inspected.length };
  }
}

export const VALUE = { site: 1, wallet: .8, linkage: .6, contradiction: .6, report: 1, false_relationship: -.3, request: -.004 };
/** Benchmark-only scalar used for counterfactual regret: downstream value net of request cost. */
export function netValue(before, after) {
  return VALUE.site * (after.hidden_sites_discovered - before.hidden_sites_discovered) + VALUE.wallet * (after.validated_true_wallets - before.validated_true_wallets)
    + VALUE.linkage * (after.linkage_discriminated - before.linkage_discriminated) + VALUE.contradiction * (after.contradictions_resolved - before.contradictions_resolved)
    + VALUE.report * (after.reports_ready - before.reports_ready) + VALUE.false_relationship * (after.false_relationships - before.false_relationships) + VALUE.request * (after.requests - before.requests);
}
