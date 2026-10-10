import type { PivotSpec } from '../core/model.js';
import { walletFamily, isDomain } from '../core/canonical.js';

const NOT_OWNERSHIP = 'It does not show who controls these things — shared infrastructure can be rented by unrelated people.';

/**
 * The pivot catalogue: every way Hunter can expand from one indicator to
 * related ones. Collectors implement pivots; the planner ranks them; the
 * explanations are written for someone learning the craft.
 */
export const PIVOTS: Record<string, PivotSpec> = {
  CT_PATTERN_SEARCH: {
    pivotType: 'CT_PATTERN_SEARCH', entityTypes: ['pattern'], label: 'Search certificate logs for look-alike names', cost: 'medium', priorGain: 1.8, monitorable: true,
    applies: e => String(e.value).startsWith('name:'),
    explain: v => ({
      what: `Search the public certificate transparency logs for recently certified domains whose names follow the operation's naming pattern (${v.replace(/^name:/, '')}).`,
      why: 'Operators reuse naming templates. Newly certified domains that fit the template are candidates for the operation’s other or next sites; Hunter then verifies each one before accepting it.',
      doesNotProve: 'A matching name alone proves nothing — legitimate sites use the same words. Candidates are only accepted with independent evidence.',
    }),
  },
  TITLE_SEARCH: {
    pivotType: 'TITLE_SEARCH', entityTypes: ['pattern'], label: 'Find archived pages with the same title', cost: 'medium', priorGain: 1.2,
    applies: e => String(e.value).startsWith('title:'),
    explain: v => ({
      what: `Search a public scan archive for pages titled "${v.replace(/^title:/, '')}".`,
      why: 'Kits are often deployed with their exact default page title; the same distinctive title on another domain is a lead worth verifying.',
      doesNotProve: 'Kits are sold to many customers, so a shared title links the kit, not the operator.',
    }),
  },
  DNS_RESOLVE: {
    pivotType: 'DNS_RESOLVE', entityTypes: ['domain', 'hostname'], label: 'Resolve DNS records', cost: 'low', priorGain: 2.2, monitorable: true,
    explain: v => ({
      what: `Look up the public DNS records of ${v}: which server addresses (A records), which nameservers, which mail servers, and any verification text records.`,
      why: 'DNS is the address book of the internet. Server addresses and nameservers are often reused across a scam operation’s sites.',
      doesNotProve: NOT_OWNERSHIP,
    }),
  },
  CT_SEARCH: {
    pivotType: 'CT_SEARCH', entityTypes: ['domain'], label: 'Search certificate transparency logs', cost: 'low', priorGain: 2.5, monitorable: true,
    explain: v => ({
      what: `Search the public certificate transparency logs for every TLS certificate issued for ${v} and its subdomains.`,
      why: 'Operators often buy one certificate covering several of their sites, or issue certificates for sites before launching them — a public record that links sites and reveals ones not yet in use.',
      doesNotProve: 'A shared certificate strongly suggests shared administration but can also come from a shared hosting panel or reseller.',
    }),
  },
  RDAP_DOMAIN: {
    pivotType: 'RDAP_DOMAIN', entityTypes: ['domain'], label: 'Fetch registration record (RDAP)', cost: 'low', priorGain: 1.6,
    explain: v => ({
      what: `Fetch the public registration record for ${v}: registrar, creation date, expiry and registered nameservers.`,
      why: 'Registration dates build the operation’s timeline; bursts of registrations on the same day at the same registrar often mark one deployment wave.',
      doesNotProve: 'Registrars and privacy services are shared by millions of domains; matching registrars alone links nothing.',
    }),
  },
  IP_PROFILE: {
    pivotType: 'IP_PROFILE', entityTypes: ['ip'], label: 'Identify network owner (ASN)', cost: 'low', priorGain: 1.0,
    explain: v => ({
      what: `Find which network (autonomous system) announces ${v}, who holds it, and where it is registered.`,
      why: 'Scam operators favour hosting providers that ignore abuse reports. Knowing the network helps map hosting choices and who to notify.',
      doesNotProve: 'Many unrelated customers share a hosting provider.',
    }),
  },
  REVERSE_IP: {
    pivotType: 'REVERSE_IP', entityTypes: ['ip'], label: 'Find other sites on this server', cost: 'medium', priorGain: 2.0,
    applies: e => !e.metadata?.commodity,
    explain: v => ({
      what: `Ask passive sources which other domains have pointed to ${v}.`,
      why: 'Dedicated scam servers often host several of the same operator’s sites at once.',
      doesNotProve: 'Shared hosting can put hundreds of unrelated sites on one address — Hunter ignores addresses that turn out to be crowded.',
    }),
  },
  REVERSE_NS: {
    pivotType: 'REVERSE_NS', entityTypes: ['nameserver'], label: 'Find domains using this nameserver', cost: 'medium', priorGain: 2.4,
    explain: v => ({
      what: `List domains whose DNS is delegated to ${v}.`,
      why: 'A small private or offshore nameserver is a strong clustering signal: few legitimate sites use it.',
      doesNotProve: 'Large DNS providers are shared by millions of domains; Hunter never expands those.',
    }),
  },
  SITE_PROFILE: {
    pivotType: 'SITE_PROFILE', entityTypes: ['domain'], label: 'Fetch passive page fingerprint', cost: 'medium', priorGain: 2.0, monitorable: true,
    applies: e => isDomain(e.value),
    explain: v => ({
      what: `Look up existing public scans of ${v} (from a passive scanning service) to learn its page title, server, loaded files and trackers — without visiting it ourselves.`,
      why: 'The page’s structure, scripts and trackers identify the scam kit and sometimes operator-specific settings such as analytics IDs or wallet addresses.',
      doesNotProve: 'Identical page code often means the same purchased kit, not the same operator.',
    }),
  },
  SHARED_RESOURCE: {
    pivotType: 'SHARED_RESOURCE', entityTypes: ['template', 'artifact'], label: 'Find sites loading the same files', cost: 'medium', priorGain: 2.6,
    explain: v => ({
      what: `Search passive scan archives for other sites that loaded the exact same file or page structure (${v}).`,
      why: 'Scam kits reuse the same scripts and page layouts. Matching files finds sibling sites even when hosting and domains differ.',
      doesNotProve: 'A kit can be sold to many buyers — shared files point to shared tooling, not necessarily the same people.',
    }),
  },
  TRACKER_REUSE: {
    pivotType: 'TRACKER_REUSE', entityTypes: ['identifier', 'email'], label: 'Find other sites using this identifier', cost: 'medium', priorGain: 2.2,
    explain: v => ({
      what: `Look for other sites and records that contain the same identifier (${v}) — analytics IDs, Telegram handles, WalletConnect project IDs or contact emails.`,
      why: 'Identifiers like analytics accounts or support handles are set by whoever deploys the site, so they are among the strongest operator-level links.',
      doesNotProve: 'Kits sometimes ship with a default identifier left in by the seller; check whether the value appears across unrelated operations.',
    }),
  },
  WALLET_TRACE: {
    pivotType: 'WALLET_TRACE', entityTypes: ['wallet', 'contract'], label: 'Trace wallet transfers', cost: 'medium', priorGain: 3.0, monitorable: true,
    applies: e => walletFamily(e.value) !== 'unknown' && walletFamily(e.value) !== 'solana',
    explain: v => ({
      what: `Read the public blockchain history of ${v}: who sent it funds, where the funds went next, and when.`,
      why: 'Following the money reveals collection wallets, where stolen funds converge, and cash-out points such as exchange deposit addresses.',
      doesNotProve: 'Sending or receiving funds does not prove two addresses have the same owner — exchanges, services and victims transact with scammers too.',
    }),
  },
  WALLET_PROFILE: {
    pivotType: 'WALLET_PROFILE', entityTypes: ['wallet', 'contract'], label: 'Profile address (contract, deployer, tags)', cost: 'low', priorGain: 1.2,
    applies: e => walletFamily(e.value) === 'evm',
    explain: v => ({
      what: `Check whether ${v} is a smart contract, who deployed it, and whether block explorers have tagged it.`,
      why: 'Drainer contracts are deployed by an address; that deployer often deploys the operation’s other contracts too.',
      doesNotProve: 'Explorer tags are community labels and can be wrong.',
    }),
  },
  EVIDENCE_MINING: {
    pivotType: 'EVIDENCE_MINING', entityTypes: ['domain', 'artifact', 'template'], label: 'Extract indicators from collected evidence', cost: 'low', priorGain: 1.3,
    explain: v => ({
      what: `Re-read everything already collected about ${v} (page source, reports, module evidence) and pull out wallets, domains, trackers and handles mentioned in it.`,
      why: 'Evidence often contains more leads than were noticed when it was first collected.',
      doesNotProve: 'A mention is not a relationship of control; it is a lead to verify.',
    }),
  },
  MAIN_LOOKUP: {
    pivotType: 'MAIN_LOOKUP', entityTypes: ['domain', 'wallet', 'contract', 'ip', 'identifier', 'email'], label: 'Check Main Platform records', cost: 'low', priorGain: 1.5,
    explain: v => ({
      what: `Ask the Main Investigation Platform whether any module (Site Finder, Site Investigator, WalletLogger, Wallet Investigator) has already recorded ${v}.`,
      why: 'Other modules may have visited the site, captured deposit wallets or analysed transactions — reusing that evidence avoids repeating work.',
      doesNotProve: 'Presence in another investigation does not mean the investigations are about the same operator.',
    }),
  },
  SITE_CHECK_REQUEST: {
    pivotType: 'SITE_CHECK_REQUEST', entityTypes: ['domain'], label: 'Request a site check from Site Investigator', cost: 'high', priorGain: 2.0,
    explain: v => ({
      what: `Ask the Main Platform to route ${v} to Site Investigator, which visits the site within its own safety rules and reports page content and deposit wallets.`,
      why: 'Passive sources cannot see live page content; the site check captures the kit fingerprint and wallets directly.',
      doesNotProve: 'Site content shows what the site displays today, not who operates it.',
    }),
  },
};

export function pivotSpec(pivotType: string): PivotSpec | undefined {
  return PIVOTS[pivotType];
}
