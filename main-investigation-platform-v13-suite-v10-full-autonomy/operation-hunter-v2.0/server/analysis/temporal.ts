import type { TemporalSnapshot } from '../types.js';
import type { OpData } from './data.js';
import type { InfraAnalysis } from './infrastructure.js';
import type { FinancialAnalysisV1 } from './financial.js';
import type { KitAnalysis } from './kits.js';
import { isoDay, uniq, round, daysBetween, plural } from '../core/util.js';

export interface TimelineEvent {
  at: string;
  kind: 'registration' | 'certificate' | 'site_seen' | 'went_dark' | 'kit_variant' | 'victim_funds' | 'cash_out' | 'rotation' | 'bridge' | 'deployment' | 'reappearance' | 'first_activity';
  title: string;
  detail: string;
  entityValues: string[];
  evidenceIds: string[];
  importance: number; // 1..3
}

export interface TemporalAnalysis {
  events: TimelineEvent[];
  phases: Array<{ index: number; label: string; start: string; end: string; summary: string; eventCount: number }>;
  snapshots: TemporalSnapshot[];
  diffs: Array<{ fromStep: string; toStep: string; structuralChanges: string[] }>;
  activity: Array<{ day: string; infrastructure: number; money: number }>;
  span: { start: string | null; end: string | null; days: number };
  lastActivity: string | null;
}

export function analyzeTemporal(data: OpData, infra: InfraAnalysis, fin: FinancialAnalysisV1, kits: KitAnalysis): TemporalAnalysis {
  const events: TimelineEvent[] = [];
  const now = new Date().toISOString();
  const lastActive = new Map<string, string>();
  for (const d of infra.domains) {
    const evs = data.evidenceByEntity.get(d.id) ?? [];
    const activeTimes = evs.filter(e => ['site_scan', 'page_fingerprint', 'dns_a'].includes(e.type)).map(e => e.timestamp);
    if (activeTimes.length) lastActive.set(d.value, activeTimes.sort().pop()!);
  }
  // The timeline describes this operation: only its core sites (peripheral sites are often other
  // customers of the same kit or neighbours on shared hosting, and are shown elsewhere).
  const coreSites = new Set(infra.domains.filter(d => d.role === 'core' && !d.isResourceHost).map(d => d.value));
  const touchesCore = (values: string[]) => values.some(v => coreSites.has(v));
  for (const d of infra.domains) {
    if (!coreSites.has(d.value)) continue;
    if (d.registeredAt) events.push({ at: d.registeredAt, kind: 'registration', title: `${d.value} registered`, detail: `${d.registrar ?? 'Unknown registrar'}${d.nameservers.length ? `, DNS on ${d.nameservers[0]}` : ''}`, entityValues: [d.value], evidenceIds: evIds(data, d.id, 'rdap_registration'), importance: d.isSeed ? 3 : 2 });
    const scans = (data.evidenceByEntity.get(d.id) ?? []).filter(e => e.type === 'site_scan');
    if (scans.length) {
      const first = scans.map(s => s.timestamp).sort()[0];
      events.push({ at: first, kind: 'site_seen', title: `${d.value} live`, detail: d.pageTitle ? `Page "${d.pageTitle}"` : 'Site observed serving content', entityValues: [d.value], evidenceIds: scans.map(s => s.id).slice(0, 3), importance: 2 });
    }
    if (d.status === 'taken_down' || d.status === 'inactive') {
      const at = lastActive.get(d.value) ?? d.lastSeen;
      events.push({ at, kind: 'went_dark', title: `${d.value} ${d.status === 'taken_down' ? 'taken down' : 'went dark'}`, detail: d.statusReason + (lastActive.get(d.value) ? ` (last seen active ${isoDay(at)})` : ''), entityValues: [d.value], evidenceIds: evIds(data, d.id, 'dns_no_answer').concat(evIds(data, d.id, 'rdap_registration')), importance: 3 });
    }
  }
  for (const c of infra.certificates) {
    if (!c.notBefore || !touchesCore(c.domainsInOperation)) continue;
    events.push({ at: toIso(c.notBefore), kind: 'certificate', title: `Certificate issued for ${c.domainsInOperation.length > 1 ? `${c.domainsInOperation.length} domains` : c.domainsInOperation[0]}`, detail: `${c.issuer ?? 'Issuer'}: ${c.names.slice(0, 4).join(', ')}`, entityValues: c.domainsInOperation, evidenceIds: evIds(data, c.id, 'ct_certificate'), importance: c.domainsInOperation.length > 1 ? 2 : 1 });
  }
  for (const f of kits.families) for (const v of f.variants) {
    const t = kits.templates.find(x => x.id === v.templateId);
    if (!t || !touchesCore(t.domains)) continue;
    events.push({ at: t.firstSeen, kind: 'kit_variant', title: `${f.name} ${v.label} observed`, detail: `${plural(t.domains.length, 'site')}${v.addedCapabilities.length ? `; new: ${v.addedCapabilities.join('; ')}` : ''}`, entityValues: t.domains, evidenceIds: evIds(data, t.id, 'page_fingerprint'), importance: v.addedCapabilities.length ? 3 : 2 });
  }
  // Money: group victim inflows per day; exits and bridges individually.
  const byDay = new Map<string, { usd: number; n: number; symbols: Set<string>; evidence: Set<string> }>();
  const collection = new Set(fin.wallets.filter(w => w.role === 'COLLECTION' || w.role === 'SPLITTER').map(w => w.address));
  for (const f of fin.flows) {
    if (collection.has(f.to) && !collection.has(f.from)) {
      const day = isoDay(f.first);
      const g = byDay.get(day) ?? { usd: 0, n: 0, symbols: new Set(), evidence: new Set() };
      g.usd += f.usd; g.n += f.count; g.symbols.add(f.symbol); f.evidenceIds.forEach(id => g.evidence.add(id));
      byDay.set(day, g);
    }
  }
  for (const [day, g] of byDay) events.push({ at: `${day}T12:00:00.000Z`, kind: 'victim_funds', title: `${plural(g.n, 'victim transfer')} collected`, detail: `${[...g.symbols].join('/')}${g.usd ? ` ≈ $${Math.round(g.usd).toLocaleString()}` : ''}`, entityValues: [], evidenceIds: [...g.evidence].slice(0, 5), importance: 1 });
  for (const x of fin.exits) {
    const flow = fin.flows.find(f => f.to === x.address);
    if (!flow) continue;
    events.push({ at: flow.first, kind: x.kind === 'bridge' ? 'bridge' : 'cash_out', title: `${x.kind === 'bridge' ? 'Funds bridged via' : 'Funds sent to'} ${x.label}`, detail: Object.entries(x.bySymbol).map(([s, v]) => `${v} ${s}`).join(', '), entityValues: [x.address], evidenceIds: flow.evidenceIds.slice(0, 3), importance: 3 });
  }
  for (const r of fin.rotations) events.push({ at: r.rotationTimestamp, kind: 'rotation', title: `Money rotation to ${r.rotatedAddress.slice(0, 10)}…`, detail: r.reason, entityValues: [r.originalAddress, r.rotatedAddress], evidenceIds: [], importance: 3 });
  for (const r of infra.rotations) events.push({ at: r.at, kind: 'rotation', title: `${r.from} → ${r.to}`, detail: `New domain with the same setup (${r.sharedFeatures.join(', ')}) ${r.gapDays} days later`, entityValues: [r.from, r.to], evidenceIds: r.evidenceIds, importance: 3 });
  for (const d of fin.deployers) events.push({ at: fin.wallets.find(w => d.contracts.map(c => c.toLowerCase()).includes(w.address))?.firstActivity ?? data.op.createdAt, kind: 'deployment', title: `Deployer ${d.deployer.slice(0, 10)}… active`, detail: `Deployed ${plural(d.contracts.length, 'contract')}`, entityValues: [d.deployer, ...d.contracts], evidenceIds: [], importance: d.contracts.length > 1 ? 3 : 2 });

  const real = events.filter(e => e.at && e.at <= now).sort((a, b) => a.at.localeCompare(b.at));
  const start = real[0]?.at ?? null, end = real[real.length - 1]?.at ?? null;

  // Phases: split where there is a quiet gap of ≥3 days, otherwise at registration waves.
  const boundaries = infra.waves.length >= 2 ? infra.waves.map(w => w.start) : [];
  const phases: TemporalAnalysis['phases'] = [];
  if (real.length) {
    const cuts = boundaries.length ? boundaries : [real[0].at];
    for (let i = 0; i < cuts.length; i++) {
      const s = i === 0 ? real[0].at : cuts[i];
      const e = i + 1 < cuts.length ? cuts[i + 1] : end!;
      const inPhase = real.filter(ev => ev.at >= s && (i + 1 < cuts.length ? ev.at < e : ev.at <= e));
      if (!inPhase.length) continue;
      const kinds = new Set(inPhase.map(ev => ev.kind));
      const label = i === 0 ? 'Initial deployment' : kinds.has('rotation') || kinds.has('went_dark') ? `Rotation & redeployment (wave ${i + 1})` : `Expansion (wave ${i + 1})`;
      phases.push({ index: phases.length, label, start: s, end: e, eventCount: inPhase.length, summary: phaseSummary(inPhase) });
    }
  }

  // Snapshots: state at the end of each phase and now.
  const stamps = [...phases.map(p => p.end)];
  if (!stamps.length || stamps[stamps.length - 1] < now) stamps.push(now);
  const snapshots: TemporalSnapshot[] = [];
  const activeDomainsAt = (t: string) => infra.domains.filter(d => coreSites.has(d.value) && (d.registeredAt ?? d.firstSeen) <= t && (d.status === 'active' || d.status === 'standby' ? true : (lastActive.get(d.value) ?? d.lastSeen) >= t));
  stamps.forEach((t, i) => {
    const doms = activeDomainsAt(t);
    const ips = uniq(doms.flatMap(d => d.ips));
    const ns = uniq(doms.flatMap(d => d.nameservers));
    const certs = infra.certificates.filter(c => c.notBefore && toIso(c.notBefore) <= t && c.domainsInOperation.some(x => doms.some(d => d.value === x))).map(c => c.label);
    const wallets = fin.wallets.filter(w => w.firstActivity && w.firstActivity <= t && !['VICTIM', 'EXCHANGE', 'MIXER', 'SERVICE', 'DEX', 'BRIDGE'].includes(w.role)).map(w => w.address);
    const prev = snapshots[i - 1];
    const added: TemporalSnapshot['addedSincePrevious'] = [];
    const removed: TemporalSnapshot['removedOrDecommissioned'] = [];
    if (prev) {
      for (const d of doms.map(x => x.value)) if (!prev.activeDomains.includes(d)) added.push({ entityType: 'domain', value: d, reason: 'Registered or first seen active in this period' });
      for (const d of prev.activeDomains) if (!doms.some(x => x.value === d)) removed.push({ entityType: 'domain', value: d, reason: infra.domains.find(x => x.value === d)?.statusReason ?? 'No longer active' });
      for (const ip of ips) if (!prev.activeIps.includes(ip)) added.push({ entityType: 'ip', value: ip, reason: 'New hosting address in use' });
      for (const ip of prev.activeIps) if (!ips.includes(ip)) removed.push({ entityType: 'ip', value: ip, reason: 'No active domain points here any more' });
      for (const w of wallets) if (!prev.activeWallets.includes(w)) added.push({ entityType: 'wallet', value: w, reason: `Started moving funds (${fin.wallets.find(x => x.address === w)?.role.toLowerCase()})` });
    }
    const windowEvents = real.filter(ev => (!prev || ev.at > prev.timestamp) && ev.at <= t);
    const mutations = windowEvents.filter(ev => ['kit_variant', 'rotation', 'deployment', 'bridge'].includes(ev.kind)).map(ev => `${ev.title}: ${ev.detail}`);
    snapshots.push({
      id: `snap-${data.op.id}-${i}`, operationId: data.op.id, stepIndex: i, stepLabel: i < phases.length ? `T${i}: ${phases[i].label}` : `T${i}: Now`, timestamp: t,
      summary: `${plural(doms.length, 'active domain')}, ${plural(ips.length, 'server')}, ${plural(wallets.length, 'operational wallet')}${windowEvents.length ? `; ${plural(windowEvents.length, 'event')} in this period` : ''}.`,
      activeDomains: doms.map(d => d.value), activeIps: ips, activeCertificates: certs, activeWallets: wallets, activeNameservers: ns, addedSincePrevious: added, removedOrDecommissioned: removed, mutations,
    });
  });
  const diffs = snapshots.slice(1).map((s, i) => ({
    fromStep: snapshots[i].stepLabel, toStep: s.stepLabel,
    structuralChanges: [
      ...s.addedSincePrevious.map(a => `+ ${a.entityType} ${a.value}`),
      ...s.removedOrDecommissioned.map(r => `− ${r.entityType} ${r.value} (${r.reason})`),
      ...s.mutations.map(m => `~ ${m}`),
    ].slice(0, 30),
  }));

  // Daily activity for sparklines (last 90 days of the operation's span).
  const counts = new Map<string, { infrastructure: number; money: number }>();
  for (const ev of real) {
    const day = isoDay(ev.at);
    const c = counts.get(day) ?? { infrastructure: 0, money: 0 };
    if (['victim_funds', 'cash_out', 'bridge'].includes(ev.kind)) c.money++; else c.infrastructure++;
    counts.set(day, c);
  }
  const activity: TemporalAnalysis['activity'] = [];
  if (start) {
    const first = Math.max(Date.parse(start), Date.parse(now) - 90 * 86400000);
    for (let t = first; t <= Date.parse(now) + 1; t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      activity.push({ day, ...(counts.get(day) ?? { infrastructure: 0, money: 0 }) });
    }
  }
  return { events: real.reverse(), phases, snapshots, diffs, activity, span: { start, end, days: start && end ? round(daysBetween(start, end), 1) : 0 }, lastActivity: end };
}

function evIds(data: OpData, entityId: string, kind: string) {
  return (data.evidenceByEntity.get(entityId) ?? []).filter(e => e.type === kind).map(e => e.id).slice(0, 3);
}

function toIso(v: string) {
  const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
}

function phaseSummary(events: TimelineEvent[]) {
  const regs = events.filter(e => e.kind === 'registration').length;
  const dark = events.filter(e => e.kind === 'went_dark').length;
  const money = events.filter(e => e.kind === 'victim_funds').length;
  const outs = events.filter(e => e.kind === 'cash_out').length;
  const parts = [regs ? `${plural(regs, 'domain')} registered` : '', dark ? `${plural(dark, 'domain')} went dark` : '', money ? `victim funds collected on ${plural(money, 'day')}` : '', outs ? `${plural(outs, 'cash-out')}` : ''].filter(Boolean);
  return parts.join('; ') || `${plural(events.length, 'event')}`;
}
