import { domainToASCII } from 'node:url';
import net from 'node:net';
import type { EntityType } from '../types.js';

/**
 * Entity resolution primitives. Every entity is stored under a canonical key
 * so the same indicator observed by different sources (or typed differently
 * by an analyst) resolves to one node.
 */

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'net.cn', 'com.hk', 'com.sg', 'com.tr', 'com.mx', 'com.ar', 'co.za', 'co.in', 'co.kr', 'com.tw',
  'com.ua', 'co.id', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.ng', 'com.sa', 'com.eg', 'co.il', 'com.co',
  // common hosting platforms where each subdomain is a different owner
  'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'glitch.me',
  'repl.co', 'workers.dev', 'blogspot.com', 'wixsite.com', 'weebly.com', 'azurewebsites.net', 'onrender.com',
  'appspot.com', 'cloudfront.net', 'r2.dev', 'fly.dev', 'railway.app', 'surge.sh', 'ngrok.io', 'ngrok-free.app',
]);

export const EVM_RE = /^0x[0-9a-f]{40}$/i;
export const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export const BTC_RE = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
export const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DOMAIN_RE = /^(?=.{3,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z][a-z0-9-]{1,62}$/i;
const GA_RE = /^(UA-\d{4,12}-\d{1,4}|G-[A-Z0-9]{6,14}|GTM-[A-Z0-9]{4,10}|AW-\d{6,14})$/i;
const TELEGRAM_RE = /^(?:@|https?:\/\/t\.me\/|t\.me\/)([a-z0-9_]{4,32})$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const ASN_RE = /^AS\s?(\d{1,10})$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

export type WalletFamily = 'evm' | 'tron' | 'btc' | 'solana' | 'unknown';

export function walletFamily(value: string): WalletFamily {
  const v = value.trim();
  if (EVM_RE.test(v)) return 'evm';
  if (TRON_RE.test(v)) return 'tron';
  if (BTC_RE.test(v)) return 'btc';
  if (SOL_RE.test(v)) return 'solana';
  return 'unknown';
}

export function isIp(value: string): boolean {
  return net.isIP(value.trim()) !== 0;
}

export function isDomain(value: string): boolean {
  const host = hostnameOf(value);
  return Boolean(host && DOMAIN_RE.test(host) && !isIp(host));
}

/** Extract a hostname from a domain, hostname, or URL. */
export function hostnameOf(value: string): string {
  let v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v.includes('://')) {
    try { v = new URL(v).hostname; } catch { return ''; }
  } else {
    v = v.split('/')[0].split('?')[0].split('#')[0];
    if (v.includes('@')) v = v.split('@').pop() || '';
    v = v.replace(/:\d+$/, '');
  }
  v = v.replace(/\.$/, '').replace(/^\*\./, '');
  const ascii = domainToASCII(v);
  return ascii || v;
}

export function registrableDomain(value: string): string {
  const host = hostnameOf(value).replace(/^www\./, '');
  if (!host || isIp(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export function tldOf(value: string): string {
  const host = hostnameOf(value);
  const idx = host.lastIndexOf('.');
  return idx >= 0 ? host.slice(idx + 1) : '';
}

/** Guess the entity type of a free-form indicator. */
export function detectType(raw: string): EntityType | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (EVM_RE.test(value) || TRON_RE.test(value) || BTC_RE.test(value)) return 'wallet';
  if (isIp(value)) return 'ip';
  if (ASN_RE.test(value)) return 'asn';
  if (GA_RE.test(value) || TELEGRAM_RE.test(value)) return 'identifier';
  if (EMAIL_RE.test(value)) return 'email';
  if (/^sha256:/i.test(value) || HEX64_RE.test(value)) return 'certificate';
  if (isDomain(value)) return 'domain';
  return null;
}

/** Canonical key used for entity identity within an operation and across operations. */
export function canonicalize(type: string, raw: string): string {
  const value = String(raw ?? '').trim();
  switch (type) {
    case 'domain': {
      const host = hostnameOf(value);
      return host.startsWith('www.') ? host.slice(4) : host;
    }
    case 'hostname':
    case 'nameserver':
      return hostnameOf(value);
    case 'ip': {
      const v = value.replace(/^\[|\]$/g, '').toLowerCase();
      return v;
    }
    case 'asn': {
      const m = ASN_RE.exec(value.split(/\s/)[0]) || ASN_RE.exec(value);
      return m ? `AS${m[1]}` : value.toUpperCase().split(/\s/)[0];
    }
    case 'wallet':
    case 'contract': {
      // strip decorative suffixes such as "0xabc… (Railgun Relay)"
      const first = value.split(/\s/)[0];
      if (EVM_RE.test(first)) return first.toLowerCase();
      return first;
    }
    case 'identifier': {
      const tg = TELEGRAM_RE.exec(value);
      if (tg) return `@${tg[1].toLowerCase()}`;
      if (GA_RE.test(value)) return value.toUpperCase();
      return value.toLowerCase();
    }
    case 'email':
      return value.toLowerCase();
    case 'certificate':
      return value.replace(/^sha256:/i, '').replace(/[:\s]/g, '').replace(/\.+$/, '').toLowerCase();
    case 'registrar':
      return value.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|llc|ltd|limited|co|corp|gmbh|srl|sa|bv)$/i, '').replace(/\s+/g, ' ').trim();
    default:
      return value.toLowerCase();
  }
}

export function displayLabel(type: string, value: string, metadata: Record<string, any> = {}): string {
  if (metadata.label) return String(metadata.label);
  switch (type) {
    case 'ip': return metadata.asn ? `${value} (${String(metadata.asn).split(' ')[0]})` : value;
    case 'asn': return metadata.holder ? `${value} (${metadata.holder})` : value;
    case 'wallet':
    case 'contract': return metadata.name ? `${metadata.name} (${value.slice(0, 10)}…)` : value;
    default: return value;
  }
}

/** Extract indicators (domains, wallets, trackers, handles, emails) from free text or HTML. */
export function extractIndicators(text: string): Array<{ type: EntityType; value: string; hint: string }> {
  const out = new Map<string, { type: EntityType; value: string; hint: string }>();
  const add = (type: EntityType, value: string, hint: string) => {
    const key = `${type}:${canonicalize(type, value)}`;
    if (!out.has(key)) out.set(key, { type, value: canonicalize(type, value), hint });
  };
  const src = String(text ?? '');
  for (const m of src.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) add('wallet', m[0], 'EVM address');
  for (const m of src.matchAll(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g)) add('wallet', m[0], 'TRON address');
  for (const m of src.matchAll(/\bbc1[02-9ac-hj-np-z]{25,71}\b/g)) add('wallet', m[0], 'Bitcoin address');
  for (const m of src.matchAll(/\b(UA-\d{4,12}-\d{1,4}|G-[A-Z0-9]{8,12}|GTM-[A-Z0-9]{5,9})\b/g)) add('identifier', m[1], 'analytics / tag manager ID');
  for (const m of src.matchAll(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})/g)) add('identifier', `@${m[1]}`, 'Telegram link');
  for (const m of src.matchAll(/projectId["'\s:=]+["']([0-9a-f]{32})["']/gi)) add('identifier', `wc:${m[1].toLowerCase()}`, 'WalletConnect project ID');
  for (const m of src.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    if (!/\.(png|jpg|jpeg|gif|svg|webp|js|css)$/i.test(m[0])) add('email', m[0], 'email address');
  }
  for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'\s:?#]|$)/gi)) {
    const host = hostnameOf(m[1]);
    if (host && isDomain(host)) add('domain', host, 'linked host');
  }
  return Array.from(out.values());
}
