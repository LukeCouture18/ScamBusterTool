import type { Entity, FinancialAnalysis, FinancialTransaction, FinancialTimelineEvent, AddressRotationRecord, CrossChainObservation } from '../types.js';
import type { OpData } from './data.js';
import { median, round, uniq, listPhrase, plural } from '../core/util.js';

export type WalletRole = 'VICTIM' | 'COLLECTION' | 'SPLITTER' | 'FEE_RECIPIENT' | 'TREASURY' | 'CEX_DEPOSIT' | 'EXCHANGE' | 'MIXER' | 'BRIDGE' | 'DEX' | 'SERVICE' | 'DEPLOYER' | 'INTERMEDIARY' | 'UNKNOWN';

export interface FlowTransfer { hash: string; from: string; to: string; amount: number; symbol: string; network: string; timestamp: string; usd?: number; method?: string; evidenceId: string }

export interface WalletProfile {
  id: string; address: string; label: string; network: string[]; role: WalletRole; roleReason: string; isContract: boolean; depth: number;
  inbound: Record<string, number>; outbound: Record<string, number>; inboundUsd: number; outboundUsd: number; senders: number; receivers: number;
  firstActivity?: string; lastActivity?: string; otherOperations: string[];
}

export interface FinancialAnalysisV1 {
  wallets: WalletProfile[];
  flows: Array<{ from: string; to: string; symbol: string; network: string; total: number; count: number; usd: number; first: string; last: string; evidenceIds: string[] }>;
  stolen: { bySymbol: Record<string, number>; usd: number; victims: number; transfers: number };
  exits: Array<{ address: string; label: string; kind: string; bySymbol: Record<string, number>; usd: number; via: string[] }>;
  sweepTiming: { medianSeconds: number | null; samples: number; automated: boolean; description: string };
  splits: Array<{ splitter: string; recipients: Array<{ address: string; share: number; role: WalletRole }> }>;
  rotations: AddressRotationRecord[];
  crossChain: CrossChainObservation[];
  deployers: Array<{ deployer: string; contracts: string[] }>;
  networks: string[];
  legacy: FinancialAnalysis;
  hasData: boolean;
}

const SERVICE_ROLE: Record<string, WalletRole> = { exchange: 'EXCHANGE', mixer: 'MIXER', bridge: 'BRIDGE', dex: 'DEX', protocol: 'SERVICE', token: 'SERVICE' };
const OWNERSHIP_DISCLAIMER = 'Transfers show that funds moved between addresses. They do not prove that two addresses share an owner: exchanges, services, victims and unrelated users can all appear in a money trail. Roles below are inferred from transaction patterns and should be verified.';

export function analyzeFinancial(data: OpData): FinancialAnalysisV1 {
  const walletEntities = data.entities.filter(e => e.type === 'wallet' || e.type === 'contract');
  const byAddr = new Map<string, Entity>(walletEntities.map(e => [e.value.toLowerCase(), e]));
  const transfers: FlowTransfer[] = [];
  const seen = new Set<string>();
  const fundRels = data.relationships.filter(r => r.type === 'FUNDS_TRANSFER');
  for (const rel of fundRels) {
    const from = data.byId.get(rel.sourceEntityId), to = data.byId.get(rel.targetEntityId);
    if (!from || !to) continue;
    for (const evId of rel.evidenceIds) {
      const ev = data.evidenceById.get(evId);
      if (!ev || ev.status !== 'valid') continue;
      const raw = ev.rawData ?? {};
      for (const t of raw.transfers ?? []) {
        const key = `${t.hash}:${from.value}:${to.value}:${raw.symbol}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        transfers.push({ hash: t.hash, from: from.value.toLowerCase(), to: to.value.toLowerCase(), amount: Number(t.amount) || 0, symbol: raw.symbol ?? '?', network: raw.network ?? 'unknown', timestamp: t.timestamp ?? ev.timestamp, usd: t.usd, method: t.method, evidenceId: ev.id });
      }
    }
  }
  transfers.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Node statistics
  interface Stat { in: Record<string, number>; out: Record<string, number>; inUsd: number; outUsd: number; senders: Set<string>; receivers: Set<string>; first?: string; last?: string; networks: Set<string>; inT: FlowTransfer[]; outT: FlowTransfer[] }
  const stats = new Map<string, Stat>();
  const stat = (a: string) => stats.get(a) ?? stats.set(a, { in: {}, out: {}, inUsd: 0, outUsd: 0, senders: new Set(), receivers: new Set(), networks: new Set(), inT: [], outT: [] }).get(a)!;
  for (const t of transfers) {
    const f = stat(t.from), g = stat(t.to);
    f.out[t.symbol] = (f.out[t.symbol] ?? 0) + t.amount; f.outUsd += t.usd ?? 0; f.receivers.add(t.to); f.outT.push(t); f.networks.add(t.network);
    g.in[t.symbol] = (g.in[t.symbol] ?? 0) + t.amount; g.inUsd += t.usd ?? 0; g.senders.add(t.from); g.inT.push(t); g.networks.add(t.network);
    for (const s of [f, g]) { s.first = !s.first || t.timestamp < s.first ? t.timestamp : s.first; s.last = !s.last || t.timestamp > s.last ? t.timestamp : s.last; }
  }

  // Roles
  const roles = new Map<string, { role: WalletRole; reason: string }>();
  const kindOf = (addr: string) => String(byAddr.get(addr)?.metadata?.labelKind ?? '');
  for (const [addr] of stats) {
    const k = kindOf(addr);
    if (SERVICE_ROLE[k]) roles.set(addr, { role: SERVICE_ROLE[k], reason: `Labelled ${k} (${byAddr.get(addr)?.label ?? 'label'})` });
  }
  const deployers: FinancialAnalysisV1['deployers'] = [];
  for (const rel of data.relationships.filter(r => r.type === 'CREATED_BY')) {
    const contract = data.byId.get(rel.sourceEntityId), dep = data.byId.get(rel.targetEntityId);
    if (!contract || !dep) continue;
    const d = deployers.find(x => x.deployer === dep.value) ?? (deployers.push({ deployer: dep.value, contracts: [] }), deployers[deployers.length - 1]);
    d.contracts.push(contract.value);
    if (!roles.has(dep.value.toLowerCase())) roles.set(dep.value.toLowerCase(), { role: 'DEPLOYER', reason: `Deployed ${plural(d.contracts.length, 'contract')}` });
  }
  // Leaf-like senders look like victims: they only send (nothing traced into them) to one or two places.
  const leafLike = (a: string) => { const s = stats.get(a); return Boolean(s) && s!.senders.size === 0 && s!.receivers.size <= 2 && !SERVICE_ROLE[kindOf(a)]; };
  const isContractAddr = (a: string) => Boolean(byAddr.get(a)?.metadata?.isContract || byAddr.get(a)?.type === 'contract');
  // Splitters: contracts that forward each inbound payment to several destinations.
  for (const [addr, s] of stats) {
    if (roles.has(addr)) continue;
    const dests = [...s.receivers].filter(x => !SERVICE_ROLE[kindOf(x)]);
    const victims = [...s.senders].filter(leafLike);
    if (isContractAddr(addr) && dests.length >= 2 && victims.length >= 1) roles.set(addr, { role: 'SPLITTER', reason: `Contract receiving from ${plural(victims.length, 'sender')} and splitting each payment to ${dests.length} destinations` });
  }
  // Collection points: many victim-like senders.
  for (const [addr, s] of stats) {
    if (roles.has(addr)) continue;
    const victims = [...s.senders].filter(leafLike);
    if (victims.length >= 3) roles.set(addr, { role: 'COLLECTION', reason: `Receives from ${victims.length} different victim-like senders` });
  }
  // Victims: send only to collection/splitter nodes.
  for (const [addr, s] of stats) {
    if (roles.has(addr)) continue;
    const recv = [...s.receivers];
    if (s.senders.size === 0 && recv.length && recv.length <= 2 && recv.every(r => ['COLLECTION', 'SPLITTER'].includes(roles.get(r)?.role ?? ''))) roles.set(addr, { role: 'VICTIM', reason: 'Only sent funds into a collection address' });
  }
  // Splits and fee recipients.
  const splits: FinancialAnalysisV1['splits'] = [];
  for (const [addr, r] of [...roles]) {
    if (r.role !== 'SPLITTER' && r.role !== 'COLLECTION') continue;
    const s = stats.get(addr)!;
    const totals = new Map<string, number>();
    const symCount = new Map<string, number>();
    for (const t of s.outT) symCount.set(t.symbol, (symCount.get(t.symbol) ?? 0) + 1);
    const dominant = [...symCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const t of s.outT) if (t.symbol === dominant) totals.set(t.to, (totals.get(t.to) ?? 0) + t.amount);
    const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
    const recipients = [...totals.entries()].map(([address, v]) => ({ address, share: round(v / sum, 3), role: 'UNKNOWN' as WalletRole })).sort((a, b) => b.share - a.share);
    if (recipients.length >= 2) {
      for (const rec of recipients) {
        const existing = roles.get(rec.address);
        if (existing && existing.role !== 'COLLECTION') { rec.role = existing.role; continue; }
        if (rec.share < 0.45) roles.set(rec.address, { role: 'FEE_RECIPIENT', reason: `Receives a steady ${Math.round(rec.share * 100)}% cut from ${addr.slice(0, 10)}… — typical of a drainer-kit vendor/affiliate fee` });
        else roles.set(rec.address, { role: 'TREASURY', reason: `Receives the main ${Math.round(rec.share * 100)}% share from ${addr.slice(0, 10)}…` });
        rec.role = roles.get(rec.address)!.role;
      }
      splits.push({ splitter: addr, recipients });
    } else if (recipients.length === 1 && !roles.has(recipients[0].address)) {
      roles.set(recipients[0].address, { role: 'TREASURY', reason: `Receives everything collected by ${addr.slice(0, 10)}…` });
    }
  }
  // Exchange deposit addresses: unlabelled, forward almost everything to a labelled exchange quickly.
  for (const [addr, s] of stats) {
    if (roles.has(addr)) continue;
    const toExchange = s.outT.filter(t => roles.get(t.to)?.role === 'EXCHANGE');
    const share = s.outT.length ? toExchange.length / s.outT.length : 0;
    if (toExchange.length && share >= 0.8) roles.set(addr, { role: 'CEX_DEPOSIT', reason: 'Forwards funds straight into an exchange hot wallet — the pattern of a customer deposit address (the exchange can identify the account holder)' });
  }
  for (const [addr, s] of stats) {
    if (roles.has(addr)) continue;
    const fromTreasury = [...s.senders].some(x => ['TREASURY', 'COLLECTION', 'SPLITTER'].includes(roles.get(x)?.role ?? ''));
    roles.set(addr, fromTreasury ? { role: 'INTERMEDIARY', reason: 'Receives funds from the operation’s treasury/collection addresses' } : { role: 'UNKNOWN', reason: 'Not enough transfers to infer a role' });
  }

  // Flows (aggregated edges)
  const flowMap = new Map<string, FinancialAnalysisV1['flows'][number]>();
  for (const t of transfers) {
    const key = `${t.from}>${t.to}>${t.symbol}>${t.network}`;
    const f = flowMap.get(key) ?? { from: t.from, to: t.to, symbol: t.symbol, network: t.network, total: 0, count: 0, usd: 0, first: t.timestamp, last: t.timestamp, evidenceIds: [] };
    f.total = round(f.total + t.amount, 6); f.count++; f.usd += t.usd ?? 0; f.last = t.timestamp;
    if (!f.evidenceIds.includes(t.evidenceId)) f.evidenceIds.push(t.evidenceId);
    flowMap.set(key, f);
  }
  const flows = [...flowMap.values()].sort((a, b) => b.usd - a.usd || b.total - a.total);

  // Stolen volume: flows from victims (or unknown senders) into collection points.
  const collectionAddrs = new Set([...roles].filter(([, r]) => r.role === 'COLLECTION' || r.role === 'SPLITTER').map(([a]) => a));
  const inbound = transfers.filter(t => collectionAddrs.has(t.to) && !collectionAddrs.has(t.from) && !SERVICE_ROLE[kindOf(t.from)]);
  const stolenBy: Record<string, number> = {};
  for (const t of inbound) stolenBy[t.symbol] = round((stolenBy[t.symbol] ?? 0) + t.amount, 6);
  const stolen = { bySymbol: stolenBy, usd: Math.round(inbound.reduce((s, t) => s + (t.usd ?? 0), 0)), victims: new Set(inbound.map(t => t.from)).size, transfers: inbound.length };

  // Exits
  const exits: FinancialAnalysisV1['exits'] = [];
  for (const [addr, r] of roles) {
    if (!['EXCHANGE', 'MIXER', 'BRIDGE', 'CEX_DEPOSIT'].includes(r.role)) continue;
    const s = stats.get(addr)!;
    const incomingFromOp = s.inT.filter(t => !['EXCHANGE', 'CEX_DEPOSIT'].includes(roles.get(t.from)?.role ?? '') || r.role === 'EXCHANGE');
    if (!incomingFromOp.length) continue;
    const by: Record<string, number> = {};
    for (const t of incomingFromOp) by[t.symbol] = round((by[t.symbol] ?? 0) + t.amount, 6);
    const lbl = byAddr.get(addr)?.label;
    exits.push({ address: addr, label: lbl && lbl !== addr ? lbl : r.role === 'CEX_DEPOSIT' ? `Exchange deposit ${addr.slice(0, 10)}…` : `${addr.slice(0, 10)}…`, kind: r.role === 'CEX_DEPOSIT' ? 'exchange deposit' : r.role.toLowerCase(), bySymbol: by, usd: Math.round(incomingFromOp.reduce((a, t) => a + (t.usd ?? 0), 0)), via: uniq(incomingFromOp.map(t => t.from)) });
  }
  exits.sort((a, b) => b.usd - a.usd);

  // Sweep timing at collection points.
  const delays: number[] = [];
  for (const addr of collectionAddrs) {
    const s = stats.get(addr)!;
    for (const tin of s.inT) {
      const next = s.outT.find(o => o.timestamp >= tin.timestamp);
      if (next) delays.push((Date.parse(next.timestamp) - Date.parse(tin.timestamp)) / 1000);
    }
  }
  const med = delays.length ? median(delays) : null;
  const automated = med !== null && med <= 900;
  const sweepTiming = {
    medianSeconds: med === null ? null : Math.round(med), samples: delays.length, automated,
    description: med === null ? 'Not enough inbound/outbound pairs to measure how fast funds are moved on.'
      : automated ? `Automated sweep: funds leave the collection address a median of ${formatDuration(med)} after arriving (${delays.length} samples) — consistent with an automated drainer backend.`
        : `Funds are moved on a median of ${formatDuration(med)} after arriving (${delays.length} samples) — slower than a typical automated sweep, suggesting manual handling.`,
  };

  // Rotations: a treasury passes funds to a new address that then takes over its role.
  const rotations: AddressRotationRecord[] = [];
  const treasuries = [...roles].filter(([, r]) => r.role === 'TREASURY').map(([a]) => a);
  for (const a of treasuries) {
    const sa = stats.get(a)!;
    for (const t of sa.outT) {
      const b = t.to;
      if (!['TREASURY', 'INTERMEDIARY', 'UNKNOWN'].includes(roles.get(b)?.role ?? '')) continue;
      const sb = stats.get(b)!;
      const sharedUpstream = [...sb.senders].filter(x => sa.senders.has(x) && collectionAddrs.has(x));
      const laterInflow = sb.inT.some(x => collectionAddrs.has(x.from) && x.timestamp > t.timestamp);
      if (sharedUpstream.length && laterInflow) {
        rotations.push({ originalAddress: a, rotatedAddress: b, rotationTimestamp: t.timestamp, network: t.network as any, transferTxHash: t.hash, reason: `Treasury ${a.slice(0, 10)}… passed funds to ${b.slice(0, 10)}…, which then started receiving from the same collection contract` });
        if (roles.get(b)?.role !== 'TREASURY') roles.set(b, { role: 'TREASURY', reason: 'Took over the treasury role after a rotation' });
      }
    }
  }
  for (const d of deployers) {
    if (d.contracts.length < 2) continue;
    const ordered = d.contracts.map(c => ({ c, first: stats.get(c.toLowerCase())?.first })).filter(x => x.first).sort((a, b) => a.first!.localeCompare(b.first!));
    for (let i = 1; i < ordered.length; i++) {
      rotations.push({ originalAddress: ordered[i - 1].c, rotatedAddress: ordered[i].c, rotationTimestamp: ordered[i].first!, network: 'ethereum', transferTxHash: '', reason: `Same deployer ${d.deployer.slice(0, 10)}… launched a new collection contract that took over from the previous one` });
    }
  }

  // Cross-chain
  const networks = uniq(transfers.map(t => t.network));
  const crossChain: CrossChainObservation[] = [];
  for (const [addr, r] of roles) {
    if (r.role !== 'BRIDGE') continue;
    const s = stats.get(addr)!;
    crossChain.push({ network: [...s.networks][0] as any, observedContracts: [addr], bridgedVolumeUsd: Math.round(s.inUsd), bridgeProtocol: byAddr.get(addr)?.label ?? 'bridge' });
  }
  for (const net of networks) {
    if (net === 'ethereum' || crossChain.some(c => c.network === net)) continue;
    const addrs = uniq(transfers.filter(t => t.network === net).flatMap(t => [t.from, t.to])).filter(a => ['TREASURY', 'COLLECTION', 'SPLITTER', 'INTERMEDIARY'].includes(roles.get(a)?.role ?? ''));
    if (addrs.length) crossChain.push({ network: net as any, observedContracts: addrs, bridgedVolumeUsd: Math.round(transfers.filter(t => t.network === net).reduce((s, t) => s + (t.usd ?? 0), 0)), bridgeProtocol: net === 'tron' ? 'native TRON activity' : 'same address active on another chain' });
  }

  // Depth from collection points (hop levels)
  const hop = new Map<string, number>();
  const queue = [...collectionAddrs];
  for (const a of queue) hop.set(a, 1);
  while (queue.length) {
    const a = queue.shift()!;
    for (const t of stats.get(a)?.outT ?? []) if (!hop.has(t.to)) { hop.set(t.to, (hop.get(a) ?? 1) + 1); queue.push(t.to); }
  }

  const wallets: WalletProfile[] = [...stats.entries()].map(([addr, s]) => {
    const e = byAddr.get(addr);
    const r = roles.get(addr)!;
    return {
      id: e?.id ?? addr, address: addr, label: e?.label ?? addr, network: [...s.networks], role: r.role, roleReason: r.reason, isContract: Boolean(e?.type === 'contract' || e?.metadata?.isContract),
      depth: hop.get(addr) ?? 0, inbound: roundAll(s.in), outbound: roundAll(s.out), inboundUsd: Math.round(s.inUsd), outboundUsd: Math.round(s.outUsd), senders: s.senders.size, receivers: s.receivers.size,
      firstActivity: s.first, lastActivity: s.last, otherOperations: e ? [...(data.crossIndex.get(e.canonical ?? e.value) ?? [])].filter(id => id !== data.op.id) : [],
    };
  }).sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || b.inboundUsd - a.inboundUsd);
  // Wallets with no transfers yet (e.g. seen on a page) still appear.
  for (const e of walletEntities) {
    if (stats.has(e.value.toLowerCase())) continue;
    const r = roles.get(e.value.toLowerCase());
    wallets.push({ id: e.id, address: e.value, label: e.label, network: e.metadata?.network ? [String(e.metadata.network)] : [], role: r?.role ?? (SERVICE_ROLE[String(e.metadata?.labelKind ?? '')] ?? 'UNKNOWN'), roleReason: r?.reason ?? 'No transfers traced yet', isContract: e.type === 'contract' || Boolean(e.metadata?.isContract), depth: 0, inbound: {}, outbound: {}, inboundUsd: 0, outboundUsd: 0, senders: 0, receivers: 0, otherOperations: [...(data.crossIndex.get(e.canonical ?? e.value) ?? [])].filter(id => id !== data.op.id) });
  }

  const legacy = toLegacy(data, wallets, transfers, roles, stolen, exits, sweepTiming, rotations, crossChain, hop);
  return { wallets, flows, stolen, exits, sweepTiming, splits, rotations, crossChain, deployers, networks, legacy, hasData: transfers.length > 0 };
}

function roleOrder(r: WalletRole) {
  return ['COLLECTION', 'SPLITTER', 'TREASURY', 'FEE_RECIPIENT', 'CEX_DEPOSIT', 'DEPLOYER', 'INTERMEDIARY', 'EXCHANGE', 'MIXER', 'BRIDGE', 'DEX', 'SERVICE', 'VICTIM', 'UNKNOWN'].indexOf(r);
}

function roundAll(o: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) out[k] = round(v, 4);
  return out;
}

export function formatDuration(seconds: number) {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${round(seconds / 3600, 1)} hours`;
  return `${round(seconds / 86400, 1)} days`;
}

function toLegacy(data: OpData, wallets: WalletProfile[], transfers: FlowTransfer[], roles: Map<string, { role: WalletRole; reason: string }>, stolen: FinancialAnalysisV1['stolen'], exits: FinancialAnalysisV1['exits'], timing: FinancialAnalysisV1['sweepTiming'], rotations: AddressRotationRecord[], crossChain: CrossChainObservation[], hop: Map<string, number>): FinancialAnalysis {
  const eth = (rec: Record<string, number>) => round(rec.ETH ?? 0, 4);
  const tag = (t: FlowTransfer): FinancialTransaction['classificationTag'] => {
    const rf = roles.get(t.from)?.role, rt = roles.get(t.to)?.role;
    if (rt === 'MIXER') return 'MIXER_ROUTING';
    if (rt === 'BRIDGE' || rf === 'BRIDGE') return 'CROSS_CHAIN_BRIDGE';
    if (rt === 'CEX_DEPOSIT' || rt === 'EXCHANGE') return 'CEX_DEPOSIT';
    if (rf === 'SPLITTER') return 'SPLITTER_DISTRIBUTION';
    if (rt === 'COLLECTION' || rt === 'SPLITTER') return 'VICTIM_DRAIN';
    return 'TREASURY_CONSOLIDATION';
  };
  const legacyTx: FinancialTransaction[] = transfers.slice(-400).map((t, i) => ({
    id: `tx-${i}-${t.hash.slice(2, 10)}`, txHash: t.hash, network: t.network as any, fromAddress: t.from, toAddress: t.to, value: String(t.amount), tokenSymbol: t.symbol,
    usdEquivalent: t.usd ?? 0, timestamp: t.timestamp, blockNumber: 0, method: t.method === 'permitTransferFrom' ? 'permit2_sweep' : t.symbol === 'ETH' || t.symbol === 'TRX' || t.symbol === 'BTC' ? 'native_transfer' : 'erc20_transfer',
    hopLevel: Math.min(4, hop.get(t.to) ?? 1), isConvergenceHub: ['COLLECTION', 'SPLITTER', 'TREASURY'].includes(roles.get(t.to)?.role ?? ''), isDivergenceExit: ['EXCHANGE', 'MIXER', 'CEX_DEPOSIT', 'BRIDGE'].includes(roles.get(t.to)?.role ?? ''),
    classificationTag: tag(t), verifiedCounterparty: data.entities.find(e => e.value.toLowerCase() === t.to)?.metadata?.name,
  }));
  const timeline: FinancialTimelineEvent[] = transfers.filter(t => ['VICTIM_DRAIN', 'MIXER_ROUTING', 'CEX_DEPOSIT', 'CROSS_CHAIN_BRIDGE'].includes(tag(t)) || roles.get(t.to)?.role === 'TREASURY').slice(-120).map((t, i) => {
    const tg = tag(t);
    const eventType: FinancialTimelineEvent['eventType'] = tg === 'VICTIM_DRAIN' ? 'APPROVAL_EXPLOIT' : tg === 'CEX_DEPOSIT' || tg === 'MIXER_ROUTING' ? 'OFFRAMP_EXIT' : tg === 'CROSS_CHAIN_BRIDGE' ? 'CROSS_CHAIN_BRIDGE' : tg === 'SPLITTER_DISTRIBUTION' ? 'ROYALTY_SPLIT' : 'TREASURY_TRANSFER';
    return { id: `fin-ev-${i}`, timestamp: t.timestamp, network: t.network as any, eventType, title: `${tg.replace(/_/g, ' ').toLowerCase()}: ${t.amount} ${t.symbol}`, description: `${t.from.slice(0, 10)}… → ${t.to.slice(0, 10)}…${t.method ? ` via ${t.method}` : ''}`, amount: `${t.amount} ${t.symbol}`, fromAddress: t.from, toAddress: t.to, txHash: t.hash };
  });
  const convergence = wallets.filter(w => ['COLLECTION', 'SPLITTER', 'TREASURY'].includes(w.role)).map(w => ({ walletAddress: w.address, incomingFlowsCount: w.senders, totalReceivedEth: eth(w.inbound), role: (w.role === 'TREASURY' ? 'TREASURY_AGGREGATOR' : 'SPLITTER_INTERMEDIARY') as 'TREASURY_AGGREGATOR' | 'SPLITTER_INTERMEDIARY' }));
  const divergence = exits.map(x => ({ destinationAddress: x.address, outflowCount: x.via.length, totalSentEth: round(x.bySymbol.ETH ?? 0, 4), destinationType: (x.kind === 'mixer' ? 'MIXER_RELAY' : x.kind.includes('exchange') ? 'CEX_DEPOSIT' : 'UNIDENTIFIED_EOA') as 'MIXER_RELAY' | 'CEX_DEPOSIT' | 'UNIDENTIFIED_EOA' }));
  const recurrence = wallets.filter(w => w.role === 'FEE_RECIPIENT' || (w.otherOperations.length > 0 && !['EXCHANGE', 'MIXER', 'SERVICE', 'DEX', 'BRIDGE'].includes(w.role))).map(w => `${w.label} (${w.role.toLowerCase().replace('_', ' ')}${w.otherOperations.length ? `, also in ${w.otherOperations.length} other operation(s)` : ''})`);
  return {
    id: `fin-${data.op.id}`, operationId: data.op.id, monitoredWallets: wallets.filter(w => !['VICTIM', 'EXCHANGE', 'MIXER', 'SERVICE', 'DEX', 'BRIDGE'].includes(w.role)).map(w => w.address),
    totalVolumeObservedEth: round(stolen.bySymbol.ETH ?? 0, 4), convergenceNodes: convergence, divergenceNodes: divergence, timingPatterns: timing.description,
    counterpartyRecurrence: recurrence.length ? recurrence : [listPhrase(exits.map(e => e.label), 3) || 'No recurring counterparties yet'],
    ownershipDisclaimer: OWNERSHIP_DISCLAIMER, transactions: legacyTx, timeline, addressRotations: rotations, crossChainObservations: crossChain,
  };
}
