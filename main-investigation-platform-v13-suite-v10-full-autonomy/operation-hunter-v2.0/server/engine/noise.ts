import { registrableDomain, hostnameOf } from '../core/canonical.js';
import type { EntityType } from '../types.js';

/**
 * Commodity-infrastructure awareness ("pivot hygiene").
 *
 * Pivoting through shared infrastructure (a Cloudflare IP, a big registrar's
 * nameservers, jQuery's file hash, an exchange hot wallet) connects a scam to
 * thousands of unrelated sites. Professional investigators treat such
 * indicators as context, never as links. Hunter scores every entity with a
 * ubiquity value in [0, 1]; entities above COMMODITY_THRESHOLD are never
 * expanded and carry little weight in clustering and cross-operation scoring.
 */

export const COMMODITY_THRESHOLD = 0.75;

const COMMODITY_NS_SUFFIXES = [
  'ns.cloudflare.com', 'cloudflare.com', 'awsdns', 'domaincontrol.com', 'registrar-servers.com', 'googledomains.com',
  'google.com', 'nsone.net', 'azure-dns.com', 'azure-dns.net', 'azure-dns.org', 'azure-dns.info', 'dnsimple.com',
  'dns-parking.com', 'parkingcrew.net', 'sedoparking.com', 'bodis.com', 'name-services.com', 'namebrightdns.com',
  'dnspod.net', 'hichina.com', 'porkbun.com', 'namecheaphosting.com', 'digitalocean.com', 'linode.com', 'vercel-dns.com',
  'hostinger.com', 'ultradns.net', 'ultradns.com', 'dynect.net', 'akam.net', 'wixdns.net', 'squarespacedns.com',
  'shopify.com', 'yandex.net', 'gandi.net', 'ovh.net', 'hetzner.com', 'contabo.net', 'afternic.com', 'ztomy.com',
];

const COMMODITY_DOMAINS = new Set([
  'google.com', 'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'google-analytics.com', 'cloudflare.com', 'cloudflareinsights.com',
  'jsdelivr.net', 'cdnjs.com', 'unpkg.com', 'jquery.com', 'bootstrapcdn.com', 'fontawesome.com', 'facebook.com', 'fbcdn.net',
  'twitter.com', 'x.com', 't.me', 'telegram.org', 'youtube.com', 'github.com', 'githubusercontent.com', 'walletconnect.com',
  'walletconnect.org', 'infura.io', 'alchemy.com', 'alchemyapi.io', 'metamask.io', 'etherscan.io', 'bscscan.com', 'coingecko.com',
  'coinmarketcap.com', 'binance.com', 'amazonaws.com', 'cloudfront.net', 'microsoft.com', 'apple.com', 'w3.org', 'schema.org',
  'wordpress.org', 'gravatar.com', 'polyfill.io', 'hcaptcha.com', 'recaptcha.net', 'stripe.com', 'intercom.io', 'crisp.chat',
  'tawk.to', 'jivosite.com', 'reown.com', 'web3modal.org', 'ankr.com', 'llamarpc.com', 'publicnode.com',
]);

const COMMODITY_ASNS = new Set([
  'AS13335', 'AS209242', 'AS16509', 'AS14618', 'AS15169', 'AS396982', 'AS8075', 'AS54113', 'AS20940', 'AS16625', 'AS32934',
  'AS14061', 'AS24940', 'AS16276', 'AS63949', 'AS20473', 'AS51167', 'AS47583', 'AS46606', 'AS26496', 'AS19551', 'AS22612',
]);

// Cloudflare published IPv4 ranges (anycast front-ends shared by millions of sites).
const COMMODITY_CIDRS: Array<[number, number]> = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
].map(parseCidr);

function parseCidr(cidr: string): [number, number] {
  const [ip, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return [(ipToInt(ip) & mask) >>> 0, mask];
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + Number(oct)) >>> 0, 0) >>> 0;
}

export function isCommodityIp(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ipToInt(ip);
  return COMMODITY_CIDRS.some(([net, mask]) => ((n & mask) >>> 0) === net);
}

export function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip);
}

/** Static ubiquity prior for an entity, before any pivot results are known. */
export function staticUbiquity(type: EntityType | string, value: string, metadata: Record<string, any> = {}): { ubiquity: number; reason?: string } {
  const v = String(value ?? '').toLowerCase();
  switch (type) {
    case 'nameserver': {
      const hit = COMMODITY_NS_SUFFIXES.find(s => v.includes(s));
      return hit ? { ubiquity: 0.95, reason: `Nameserver belongs to a large DNS provider (${hit}); millions of unrelated domains use it.` } : { ubiquity: 0.1 };
    }
    case 'domain':
    case 'hostname': {
      const reg = registrableDomain(hostnameOf(v));
      if (COMMODITY_DOMAINS.has(reg)) return { ubiquity: 1, reason: `${reg} is a widely used public service, not operator infrastructure.` };
      return { ubiquity: 0 };
    }
    case 'ip': {
      if (isPrivateIp(v)) return { ubiquity: 1, reason: 'Private or reserved address (not internet infrastructure).' };
      if (isCommodityIp(v)) return { ubiquity: 0.95, reason: 'Cloudflare anycast address shared by a very large number of sites.' };
      const asn = String(metadata.asn ?? '').split(' ')[0].toUpperCase();
      if (asn && COMMODITY_ASNS.has(asn)) return { ubiquity: 0.5, reason: `Hosted in a large cloud network (${asn}); IPs may be shared or reassigned.` };
      return { ubiquity: 0.1 };
    }
    case 'asn': {
      const asn = v.toUpperCase().split(' ')[0];
      return COMMODITY_ASNS.has(asn) ? { ubiquity: 0.97, reason: 'Major cloud/CDN network — hosting there says nothing about who runs a site.' } : { ubiquity: 0.4 };
    }
    case 'registrar': {
      const big = ['namecheap', 'godaddy', 'google', 'tucows', 'porkbun', 'namesilo', 'cloudflare', 'gandi', 'ovh', 'ionos', 'hostinger', 'dynadot', 'publicdomainregistry', 'network solutions', 'enom', 'alibaba', 'hichina', 'nicenic', 'gname', 'webnic'];
      return big.some(b => v.includes(b)) ? { ubiquity: 0.9, reason: 'Large retail registrar used by millions of domains.' } : { ubiquity: 0.6 };
    }
    case 'wallet':
    case 'contract': {
      const kind = String(metadata.labelKind ?? '').toLowerCase();
      if (['exchange', 'mixer', 'bridge', 'dex', 'protocol', 'token'].includes(kind)) return { ubiquity: 0.95, reason: `Labelled ${kind} address — a shared service used by many people.` };
      return { ubiquity: 0 };
    }
    case 'identifier': {
      if (v.startsWith('wc:')) return { ubiquity: 0.3 };
      return { ubiquity: 0 };
    }
    default:
      return { ubiquity: 0 };
  }
}

/** Result-volume thresholds above which a pivot target is treated as commodity. */
const VOLUME_THRESHOLDS: Record<string, number> = { CT_PATTERN_SEARCH: 250, TITLE_SEARCH: 60,
  REVERSE_IP: 60,
  REVERSE_NS: 250,
  SHARED_RESOURCE: 80,
  TRACKER_REUSE: 150,
  CT_SEARCH: 800,
  WALLET_TRACE: 2000,
};

export function ubiquityFromVolume(pivotType: string, volume: number): number {
  const threshold = VOLUME_THRESHOLDS[pivotType];
  if (!threshold || volume <= 0) return 0;
  if (volume >= threshold) return Math.min(1, 0.8 + Math.log10(volume / threshold) * 0.2);
  return Math.min(0.7, (volume / threshold) * 0.7);
}

export function isCommodity(ubiquity: number | undefined): boolean {
  return (ubiquity ?? 0) >= COMMODITY_THRESHOLD;
}

/** Relevance weight of a shared indicator type for linking sites/operations. */
export const LINK_WEIGHT: Record<string, number> = {
  wallet: 1.0, contract: 1.0, identifier: 0.9, email: 0.85, certificate: 0.7, template: 0.55, artifact: 0.55, domain: 0.8,
  ip: 0.45, nameserver: 0.3, hostname: 0.3, asn: 0.12, registrar: 0.08,
};

export function linkWeight(type: string, ubiquity = 0): number {
  return (LINK_WEIGHT[type] ?? 0.3) * (1 - Math.min(1, ubiquity));
}
