import type { Entity } from '../types.js';
import type { Observation } from '../core/model.js';
import { ObservationBuilder } from './base.js';
import { extractIndicators, hostnameOf, registrableDomain } from '../core/canonical.js';
import { sha256, nowIso } from '../core/util.js';
import { staticUbiquity } from '../engine/noise.js';

/**
 * Offline page/kit fingerprinting for HTML or JavaScript that an analyst
 * pastes in or another module captured. Produces:
 *  - a structural hash (tag/attribute skeleton, text removed) — identical kits
 *    deployed on different domains share it even when text/branding changes;
 *  - a 64-bit SimHash for near-duplicate (variant) detection;
 *  - wallet-drain capability indicators (what the code asks a wallet to do);
 *  - embedded indicators (wallets, trackers, Telegram handles, hosts).
 */

const CAPABILITIES: Array<[RegExp, string]> = [
  [/setApprovalForAll/i, 'NFT collection approval requests (setApprovalForAll)'],
  [/increaseAllowance|\.approve\(|approve\s*\(\s*[\w.]+\s*,\s*(?:ethers\.)?(?:constants\.)?MaxUint256|0xffffffffffffffffffffffff/i, 'Unlimited token approval requests'],
  [/permit2|PermitTransferFrom|PermitBatch/i, 'Permit2 signature requests'],
  [/eth_signTypedData(_v4)?|signTypedData/i, 'Off-chain typed-data signature requests (permits, orders)'],
  [/seaport|OrderComponents|fulfillAdvancedOrder/i, 'Seaport marketplace order signing'],
  [/wallet_switchEthereumChain|wallet_addEthereumChain/i, 'Forces wallet network switching (multi-chain draining)'],
  [/multicall|aggregate3/i, 'Batched multicall execution'],
  [/createWeb3Modal|Web3Modal|@walletconnect|WalletConnectProvider|walletconnect/i, 'WalletConnect / Web3Modal wallet connection'],
  [/TronWeb|tronLink|tronWeb\.trx/i, 'TRON wallet (TronLink) support'],
  [/signAllTransactions|@solana\/web3|phantom\.solana/i, 'Solana transaction signing'],
  [/eth_sendTransaction|sendTransaction\(/i, 'Direct transaction sending'],
  [/getBalance|balanceOf\(/i, 'Victim balance/asset enumeration'],
  [/debank|ankr\.com\/multichain|covalenthq|moralis/i, 'Third-party portfolio lookups (asset discovery)'],
  [/api\.telegram\.org\/bot|sendMessage\?chat_id/i, 'Telegram bot notifications (operator alerts)'],
  [/eval\(atob\(|Function\(atob\(|_0x[0-9a-f]{4,}\[/i, 'Obfuscated JavaScript (javascript-obfuscator style)'],
];

export interface HtmlAnalysis {
  title: string;
  structuralHash: string;
  simhash: string;
  tagCount: number;
  scriptUrls: string[];
  capabilities: string[];
  indicators: Array<{ type: string; value: string; hint: string }>;
  favicon?: string;
  contentHash: string;
}

function tagSkeleton(html: string): string[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, '<$1$2></$1>');
  const tokens: string[] = [];
  for (const m of cleaned.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    const attrs = Array.from(m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?==|\s|$|\/)/g)).map(a => a[1].toLowerCase()).filter(a => !a.startsWith('data-v-')).sort();
    tokens.push(attrs.length ? `${tag}[${attrs.join(',')}]` : tag);
  }
  return tokens;
}

export function simhash64(tokens: string[], shingle = 4): string {
  const v = new Array(64).fill(0);
  const grams = tokens.length < shingle ? [tokens.join(' ')] : tokens.slice(0, tokens.length - shingle + 1).map((_, i) => tokens.slice(i, i + shingle).join(' '));
  for (const g of grams) {
    const h = BigInt(`0x${sha256(g).slice(0, 16)}`);
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i);
  return out.toString(16).padStart(16, '0');
}

export function simhashSimilarity(a: string, b: string): number {
  try {
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let bits = 0;
    while (x) { bits += Number(x & 1n); x >>= 1n; }
    return 1 - bits / 64;
  } catch {
    return 0;
  }
}

export function analyzeHtml(html: string): HtmlAnalysis {
  const src = String(html ?? '');
  const tokens = tagSkeleton(src);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const scriptUrls = Array.from(new Set(Array.from(src.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)).map(m => m[1]))).slice(0, 50);
  const favicon = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(src)?.[1];
  const capabilities = CAPABILITIES.filter(([re]) => re.test(src)).map(([, label]) => label);
  return {
    title,
    structuralHash: tokens.length ? sha256(tokens.join('|')).slice(0, 16) : '',
    simhash: tokens.length ? simhash64(tokens) : '',
    tagCount: tokens.length,
    scriptUrls,
    capabilities,
    indicators: extractIndicators(src),
    favicon,
    contentHash: sha256(src),
  };
}

/** Observations describing an analysed page/script for a subject domain (or artifact). */
export function artifactObservations(subject: Entity, content: string, meta: { source: string; provenance: string; observedAt?: string; label?: string }): Observation[] {
  const analysis = analyzeHtml(content);
  const at = meta.observedAt ?? nowIso();
  const subjectReg = subject.type === 'domain' ? registrableDomain(subject.value) : '';
  const b = new ObservationBuilder({
    kind: 'page_fingerprint', source: meta.source, observedAt: at,
    summary: `${meta.label ?? 'Captured page'} for ${subject.value}: structure ${analysis.structuralHash || 'n/a'}${analysis.title ? `, title "${analysis.title.slice(0, 60)}"` : ''}; ${analysis.capabilities.length ? `wallet behaviour: ${analysis.capabilities.slice(0, 3).join('; ')}` : 'no wallet-drain behaviour patterns found'}; ${analysis.indicators.length} embedded indicator(s)`,
    raw: { title: analysis.title, structuralHash: analysis.structuralHash, simhash: analysis.simhash, tagCount: analysis.tagCount, capabilities: analysis.capabilities, scriptUrls: analysis.scriptUrls, contentSha256: analysis.contentHash, indicators: analysis.indicators },
    confidence: 0.9, provenance: meta.provenance,
  }, subject);
  if (analysis.structuralHash && analysis.tagCount >= 8) {
    const t = b.entity('template', `dom:${analysis.structuralHash}`, { label: `Page structure dom:${analysis.structuralHash.slice(0, 8)}${analysis.title ? ` ("${analysis.title.slice(0, 30)}")` : ''}`, metadata: { structuralHash: analysis.structuralHash, simhash: analysis.simhash, capabilities: analysis.capabilities, tagCount: analysis.tagCount } });
    b.rel('subject', t, 'EXECUTES_TEMPLATE', 'Captured page has this exact tag/attribute skeleton', 0.9);
  }
  for (const ind of analysis.indicators) {
    if (ind.type === 'domain') {
      if (registrableDomain(ind.value) === subjectReg) continue;
      if (staticUbiquity('domain', ind.value).ubiquity >= 0.9) continue;
      b.rel('subject', b.entity('domain', ind.value, { metadata: { discoveredIn: 'page content' } }), 'MENTIONS', `Page content links to ${ind.value}`, 0.7);
    } else if (ind.type === 'wallet') {
      b.rel('subject', b.entity('wallet', ind.value, { metadata: { discoveredIn: 'page content', hint: ind.hint } }), 'REFERENCES_WALLET', `Page content contains ${ind.hint} ${ind.value}`, 0.85);
    } else if (ind.type === 'identifier' || ind.type === 'email') {
      b.rel('subject', b.entity(ind.type as any, ind.value, { metadata: { identifierKind: ind.hint } }), 'USES_IDENTIFIER', `Page content embeds ${ind.hint} ${ind.value}`, 0.85);
    }
  }
  for (const url of analysis.scriptUrls) {
    const host = hostnameOf(url);
    if (!host || registrableDomain(host) === subjectReg || staticUbiquity('domain', host).ubiquity >= 0.9) continue;
    b.rel('subject', b.entity('domain', host, { metadata: { role: 'script/resource host', discoveredIn: 'page content' } }), 'MENTIONS', `Page loads script from ${url}`, 0.8);
  }
  return [b.build()];
}
