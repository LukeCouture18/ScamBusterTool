import crypto from 'node:crypto';
import type { Entity } from '../types.js';
import type { CollectorResult, Observation } from '../core/model.js';
import { Collector, CollectorContext, ObservationBuilder, RuntimeSettings, emptyResult } from './base.js';
import { walletFamily } from '../core/canonical.js';
import { nowIso } from '../core/util.js';

export interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: string;            // decimal string in whole units (ETH, USDT…)
  symbol: string;
  timestamp: string;
  method?: string;
  tokenAddress?: string;
  fromLabel?: string; toLabel?: string;
  fromIsContract?: boolean; toIsContract?: boolean;
  usd?: number;
}

export const DEFAULT_BLOCKSCOUT: Record<string, string> = {
  ethereum: 'https://eth.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com',
};

export function formatUnits(raw: string | number | undefined | null, decimals = 18): string {
  if (raw === undefined || raw === null || raw === '') return '0';
  let v: bigint;
  try { v = BigInt(String(raw).split('.')[0]); } catch { return String(raw); }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
  const whole = v / base;
  const frac = (v % base).toString().padStart(Number(decimals), '0').slice(0, 6).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function labelKindFromName(name: string | undefined): string | undefined {
  const n = String(name ?? '').toLowerCase();
  if (!n) return undefined;
  if (/tornado|mixer|railgun|sinbad|blender|wasabi|samourai|privacy pool/.test(n)) return 'mixer';
  if (/binance|coinbase|kraken|okx|okex|bybit|kucoin|huobi|htx|gate\.io|mexc|bitget|bitfinex|crypto\.com|exchange|hot wallet|deposit/.test(n)) return 'exchange';
  if (/bridge|wormhole|stargate|across|hop protocol|synapse|layerzero|celer|multichain|orbiter/.test(n)) return 'bridge';
  if (/uniswap|sushiswap|1inch|0x: exchange|curve|balancer|pancakeswap|router|permit2|aggregator/.test(n)) return 'dex';
  return undefined;
}

/**
 * Group raw transfers by counterparty and direction; one observation per
 * group keeps evidence readable ("A sent 3 transfers totalling 12.4 ETH to B").
 */
export function transfersToObservations(subject: Entity, transfers: Transfer[], network: string, provenance: string, source: string, lookupLabel?: (addr: string) => { label: string; kind: string } | undefined): Observation[] {
  const me = subject.value.toLowerCase();
  const groups = new Map<string, { dir: 'in' | 'out'; counterparty: string; symbol: string; items: Transfer[]; label?: string; isContract?: boolean }>();
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (!from || !to || from === to) continue;
    const dir = from === me ? 'out' : to === me ? 'in' : null;
    if (!dir) continue;
    const counterparty = dir === 'out' ? t.to : t.from;
    const key = `${dir}:${counterparty.toLowerCase()}:${t.symbol}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { dir, counterparty, symbol: t.symbol, items: [], label: dir === 'out' ? t.toLabel : t.fromLabel, isContract: dir === 'out' ? t.toIsContract : t.fromIsContract }));
    g.items.push(t);
  }
  // Keep the most significant counterparties: labelled services always, then by count/volume.
  const ranked = [...groups.values()].sort((a, b) => {
    const la = lookupLabel?.(a.counterparty) || a.label ? 1 : 0;
    const lb = lookupLabel?.(b.counterparty) || b.label ? 1 : 0;
    return lb - la || sum(b.items) - sum(a.items) || b.items.length - a.items.length;
  }).slice(0, 30);
  const observations: Observation[] = [];
  for (const g of ranked) {
    const items = g.items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const total = sum(items);
    const usd = items.reduce((acc, t) => acc + (t.usd ?? 0), 0);
    const known = lookupLabel?.(g.counterparty);
    const label = known?.label ?? g.label;
    const labelKind = known?.kind ?? labelKindFromName(label);
    const cpDesc = label ? `${label} (${g.counterparty.slice(0, 10)}…)` : g.counterparty;
    const summary = g.dir === 'out'
      ? `${subject.value.slice(0, 12)}… sent ${items.length} ${g.symbol} transfer${items.length === 1 ? '' : 's'} totalling ${fmt(total)} ${g.symbol} to ${cpDesc} on ${network} (${items[0].timestamp.slice(0, 10)} → ${items[items.length - 1].timestamp.slice(0, 10)})`
      : `${subject.value.slice(0, 12)}… received ${items.length} ${g.symbol} transfer${items.length === 1 ? '' : 's'} totalling ${fmt(total)} ${g.symbol} from ${cpDesc} on ${network} (${items[0].timestamp.slice(0, 10)} → ${items[items.length - 1].timestamp.slice(0, 10)})`;
    const b = new ObservationBuilder({
      kind: 'transfer_flow', source, observedAt: items[0].timestamp, summary,
      raw: {
        network, direction: g.dir, counterparty: g.counterparty, counterpartyLabel: label, counterpartyKind: labelKind, symbol: g.symbol,
        total: fmt(total), usd: usd || undefined, count: items.length, first: items[0].timestamp, last: items[items.length - 1].timestamp,
        transfers: items.slice(-60).map(t => ({ hash: t.hash, amount: t.amount, timestamp: t.timestamp, method: t.method, usd: t.usd })),
      },
      confidence: 1, assertion: 'blockchain_fact', provenance,
    }, subject);
    b.subject({ metadata: { network } });
    const cpType = g.isContract || labelKind === 'dex' || labelKind === 'mixer' || labelKind === 'bridge' ? 'contract' : 'wallet';
    const cp = b.entity(cpType, g.counterparty, {
      label: label ? `${label}` : undefined,
      metadata: { network, ...(label ? { name: label } : {}), ...(labelKind ? { labelKind } : {}), ...(g.isContract ? { isContract: true } : {}) },
      firstSeen: items[0].timestamp, lastSeen: items[items.length - 1].timestamp,
    });
    const reasoning = `${items.length} on-chain ${g.symbol} transfer${items.length === 1 ? '' : 's'} (${fmt(total)} ${g.symbol}) on ${network}`;
    if (g.dir === 'out') b.rel('subject', cp, 'FUNDS_TRANSFER', reasoning, 1, items[0].timestamp);
    else b.rel(cp, 'subject', 'FUNDS_TRANSFER', reasoning, 1, items[0].timestamp);
    observations.push(b.build());
  }
  return observations;
}

function sum(items: Transfer[]) {
  return items.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
}
function fmt(n: number) {
  return n >= 1000 ? n.toFixed(0) : n >= 1 ? n.toFixed(3).replace(/\.?0+$/, '') : n.toPrecision(3);
}

// ---------------------------------------------------------------- Blockscout (EVM)
export class BlockscoutCollector implements Collector {
  id = 'blockscout';
  name = 'EVM chains (Blockscout explorers)';
  kind = 'passive_public' as const;
  pivotTypes = ['WALLET_TRACE', 'WALLET_PROFILE'];
  description = 'Public Blockscout explorer APIs for Ethereum, Arbitrum, Base, Optimism, Polygon and Gnosis: transfers, contract status, deployers and public tags.';

  availability(settings: RuntimeSettings) {
    return settings.networkMode === 'live' ? { ok: true } : { ok: false, reason: 'Offline mode' };
  }

  private networks(ctx: CollectorContext): Array<[string, string]> {
    const configured = Object.keys(ctx.settings.blockscoutNetworks ?? {}).length ? ctx.settings.blockscoutNetworks : DEFAULT_BLOCKSCOUT;
    return Object.entries(configured);
  }

  /** Networks where this address has activity (cheap counters call per network, cached). */
  private async activeNetworks(entity: Entity, ctx: CollectorContext): Promise<Array<[string, string, any]>> {
    const hinted = String(entity.metadata?.network ?? '').toLowerCase();
    const out: Array<[string, string, any]> = [];
    const ordered = this.networks(ctx).sort(([a], [b]) => Number(hinted.startsWith(b.slice(0, 3))) - Number(hinted.startsWith(a.slice(0, 3))));
    for (const [network, base] of ordered) {
      try {
        const res = await ctx.http.json<any>({ url: `${base}/api/v2/addresses/${entity.value}`, collector: this.id, ttlSeconds: 6 * 3600, bypassCache: ctx.bypassCache, accept404: true });
        if (res.status === 404 || !res.body) continue;
        const b = res.body;
        const active = b.is_contract || b.has_token_transfers || b.has_logs || (b.coin_balance && b.coin_balance !== '0') || b.creation_tx_hash || b.creation_transaction_hash;
        if (active) out.push([network, base, b]);
      } catch { /* network unreachable: try the next */ }
    }
    return out;
  }

  async execute(pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (walletFamily(entity.value) !== 'evm') return emptyResult('Not an EVM address');
    const networks = await this.activeNetworks(entity, ctx);
    if (!networks.length) return emptyResult('No activity found on configured EVM networks');
    const lookup = (addr: string) => ctx.store.getLabel(addr);
    if (pivotType === 'WALLET_PROFILE') {
      const observations: Observation[] = [];
      for (const [network, base, info] of networks) observations.push(addressProfileObservation(entity, info, network, `Blockscout ${base}/api/v2/addresses/${entity.value}`, 'blockscout:' + network));
      return { observations, resultVolume: networks.length };
    }
    const observations: Observation[] = [];
    let volume = 0;
    for (const [network, base] of networks) {
      const transfers: Transfer[] = [];
      const tx = await ctx.http.json<any>({ url: `${base}/api/v2/addresses/${entity.value}/transactions`, collector: this.id, ttlSeconds: 30 * 60, bypassCache: ctx.bypassCache, accept404: true });
      for (const item of tx.body?.items ?? []) {
        if (!item?.value || item.value === '0') continue;
        transfers.push({
          hash: item.hash, from: item.from?.hash ?? '', to: item.to?.hash ?? '', amount: formatUnits(item.value, 18), symbol: nativeSymbol(network),
          timestamp: toIso(item.timestamp), method: item.method ?? undefined, fromLabel: item.from?.name ?? undefined, toLabel: item.to?.name ?? undefined,
          fromIsContract: item.from?.is_contract, toIsContract: item.to?.is_contract,
        });
      }
      const tt = await ctx.http.json<any>({ url: `${base}/api/v2/addresses/${entity.value}/token-transfers?type=ERC-20`, collector: this.id, ttlSeconds: 30 * 60, bypassCache: ctx.bypassCache, accept404: true });
      for (const item of tt.body?.items ?? []) {
        const decimals = Number(item.total?.decimals ?? item.token?.decimals ?? 18);
        transfers.push({
          hash: item.transaction_hash ?? item.tx_hash, from: item.from?.hash ?? '', to: item.to?.hash ?? '', amount: formatUnits(item.total?.value, decimals),
          symbol: item.token?.symbol ?? 'TOKEN', timestamp: toIso(item.timestamp), method: item.method ?? undefined,
          tokenAddress: item.token?.address_hash ?? item.token?.address, fromLabel: item.from?.name ?? undefined, toLabel: item.to?.name ?? undefined,
          fromIsContract: item.from?.is_contract, toIsContract: item.to?.is_contract,
        });
      }
      const more = Boolean(tx.body?.next_page_params || tt.body?.next_page_params);
      volume += transfers.length * (more ? 20 : 1);
      observations.push(...transfersToObservations(entity, transfers, network, `Blockscout ${base} transactions + ERC-20 transfers for ${entity.value}${more ? ' (most recent page only)' : ''}`, 'blockscout:' + network, lookup));
    }
    return { observations, resultVolume: volume };
  }
}

export function addressProfileObservation(entity: Entity, info: any, network: string, provenance: string, source: string): Observation {
  const tags: string[] = [...(info?.public_tags ?? []), ...(info?.metadata?.tags ?? [])].map((t: any) => t?.display_name ?? t?.name ?? t?.label).filter(Boolean);
  const creator = info?.creator_address_hash;
  const creationTx = info?.creation_transaction_hash ?? info?.creation_tx_hash;
  const name = info?.name ?? info?.ens_domain_name ?? undefined;
  const parts = [
    info?.is_contract ? 'is a smart contract' : 'is an externally owned account (regular wallet)',
    name ? `named "${name}"` : null,
    creator ? `deployed by ${creator}` : null,
    info?.is_verified ? 'with verified source code' : info?.is_contract ? 'with unverified source code' : null,
    tags.length ? `tagged ${tags.join(', ')}` : null,
  ].filter(Boolean);
  const b = new ObservationBuilder({
    kind: 'address_profile', source, observedAt: nowIso(), summary: `${entity.value} on ${network} ${parts.join(', ')}`,
    raw: { network, isContract: Boolean(info?.is_contract), name, creator, creationTx, verified: info?.is_verified, tags, balance: info?.coin_balance },
    confidence: 0.98, assertion: 'blockchain_fact', provenance,
  }, entity);
  const labelKind = labelKindFromName([name, ...tags].join(' '));
  b.subject({ metadata: { network, isContract: Boolean(info?.is_contract), name, explorerTags: tags, ...(labelKind ? { labelKind } : {}), verified: info?.is_verified } });
  if (creator) b.rel('subject', b.entity('wallet', creator, { metadata: { network, role: 'contract deployer' } }), 'CREATED_BY', `Contract creation transaction ${creationTx ?? ''} was sent by ${creator}`, 1);
  return b.build();
}

function nativeSymbol(network: string) {
  return network === 'polygon' ? 'POL' : network === 'gnosis' ? 'xDAI' : network === 'bsc' ? 'BNB' : 'ETH';
}

function toIso(v: any): string {
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

// ---------------------------------------------------------------- TRON (TronGrid)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function tronHexToBase58(hex: string): string {
  let h = String(hex ?? '').toLowerCase().replace(/^0x/, '');
  if (h.length === 40) h = `41${h}`;
  if (!/^41[0-9a-f]{40}$/.test(h)) return hex;
  const payload = Buffer.from(h, 'hex');
  const check = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  let n = BigInt(`0x${Buffer.concat([payload, check]).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

export class TronGridCollector implements Collector {
  id = 'trongrid';
  name = 'TRON (TronGrid)';
  kind = 'passive_public' as const;
  pivotTypes = ['WALLET_TRACE'];
  description = 'Public TronGrid API: TRC-20 (e.g. USDT) and TRX transfers for TRON addresses. An API key (Settings) raises rate limits.';

  availability(settings: RuntimeSettings) {
    return settings.networkMode === 'live' ? { ok: true } : { ok: false, reason: 'Offline mode' };
  }

  async execute(_pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (walletFamily(entity.value) !== 'tron') return emptyResult('Not a TRON address');
    const headers = ctx.settings.apiKeys.trongrid ? { 'TRON-PRO-API-KEY': ctx.settings.apiKeys.trongrid } : undefined;
    const base = 'https://api.trongrid.io';
    const transfers: Transfer[] = [];
    const trc20 = await ctx.http.json<any>({ url: `${base}/v1/accounts/${entity.value}/transactions/trc20?limit=200&only_confirmed=true`, collector: this.id, headers, ttlSeconds: 30 * 60, bypassCache: ctx.bypassCache });
    for (const item of trc20.body?.data ?? []) {
      transfers.push({
        hash: item.transaction_id, from: item.from, to: item.to, amount: formatUnits(item.value, Number(item.token_info?.decimals ?? 6)),
        symbol: item.token_info?.symbol ?? 'TRC20', timestamp: toIso(item.block_timestamp), tokenAddress: item.token_info?.address,
      });
    }
    const native = await ctx.http.json<any>({ url: `${base}/v1/accounts/${entity.value}/transactions?limit=100&only_confirmed=true`, collector: this.id, headers, ttlSeconds: 30 * 60, bypassCache: ctx.bypassCache });
    for (const item of native.body?.data ?? []) {
      const c = item?.raw_data?.contract?.[0];
      if (c?.type !== 'TransferContract') continue;
      const v = c.parameter?.value ?? {};
      transfers.push({ hash: item.txID, from: tronHexToBase58(v.owner_address), to: tronHexToBase58(v.to_address), amount: formatUnits(v.amount, 6), symbol: 'TRX', timestamp: toIso(item.block_timestamp) });
    }
    const more = Boolean(trc20.body?.meta?.fingerprint);
    return { observations: transfersToObservations(entity, transfers, 'tron', `TronGrid ${base} TRC-20 + TRX transfers for ${entity.value}`, 'trongrid', a => ctx.store.getLabel(a)), resultVolume: transfers.length * (more ? 10 : 1) };
  }
}

// ---------------------------------------------------------------- Bitcoin (mempool.space)
export class MempoolCollector implements Collector {
  id = 'mempool';
  name = 'Bitcoin (mempool.space)';
  kind = 'passive_public' as const;
  pivotTypes = ['WALLET_TRACE'];
  description = 'Public mempool.space API for Bitcoin address transaction history.';

  availability(settings: RuntimeSettings) {
    return settings.networkMode === 'live' ? { ok: true } : { ok: false, reason: 'Offline mode' };
  }

  async execute(_pivotType: string, entity: Entity, ctx: CollectorContext): Promise<CollectorResult> {
    if (walletFamily(entity.value) !== 'btc') return emptyResult('Not a Bitcoin address');
    const res = await ctx.http.json<any[]>({ url: `https://mempool.space/api/address/${entity.value}/txs`, collector: this.id, ttlSeconds: 30 * 60, bypassCache: ctx.bypassCache });
    return { observations: transfersToObservations(entity, btcTransfers(entity.value, res.body ?? []), 'bitcoin', `mempool.space /api/address/${entity.value}/txs (latest 50)`, 'mempool', a => ctx.store.getLabel(a)), resultVolume: (res.body ?? []).length };
  }
}

export function btcTransfers(address: string, txs: any[]): Transfer[] {
  const out: Transfer[] = [];
  for (const tx of txs) {
    const ts = tx?.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : nowIso();
    const inputs: Array<{ addr: string; value: number }> = (tx.vin ?? []).map((v: any) => ({ addr: v?.prevout?.scriptpubkey_address, value: Number(v?.prevout?.value ?? 0) })).filter((x: any) => x.addr);
    const outputs: Array<{ addr: string; value: number }> = (tx.vout ?? []).map((v: any) => ({ addr: v?.scriptpubkey_address, value: Number(v?.value ?? 0) })).filter((x: any) => x.addr);
    const spends = inputs.some(i => i.addr === address);
    if (spends) {
      for (const o of outputs) if (o.addr !== address) out.push({ hash: tx.txid, from: address, to: o.addr, amount: formatUnits(o.value, 8), symbol: 'BTC', timestamp: ts });
    } else {
      const received = outputs.filter(o => o.addr === address).reduce((a, o) => a + o.value, 0);
      const sender = inputs[0]?.addr;
      if (sender && received) out.push({ hash: tx.txid, from: sender, to: address, amount: formatUnits(received, 8), symbol: 'BTC', timestamp: ts });
    }
  }
  return out;
}
