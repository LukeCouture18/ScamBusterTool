/**
 * Blockchain wallet address validation & network resolution (v4 contract, sections 2 and 3).
 *
 * `validateWalletAddress` is the authoritative validator. It performs real checks:
 *   - EVM: 0x + 40 hex, EIP-55 mixed-case checksum verified with Keccak-256 (implemented below)
 *   - Bitcoin / Litecoin / Dogecoin / TRON: Base58Check (double SHA-256) with version bytes
 *   - Bitcoin / Litecoin SegWit: bech32 / bech32m with the BIP-173 / BIP-350 witness rules
 *   - XRP: Base58Check with the Ripple alphabet
 *   - Solana: Base58 decoding to exactly 32 bytes (ed25519 public key length)
 *
 * Network resolution never guesses: the format decides the family, and within a family with more
 * than one network (EVM, or the Bitcoin/Litecoin shared P2SH version) a usable hint or a single
 * candidate network is required, otherwise the result is `network_ambiguous`.
 *
 * `validateAddress` is the legacy adapter (old result shape and status names) used by the rest of
 * the module; it is computed from `validateWalletAddress`.
 */

import { createHash } from 'node:crypto';
import { AddressFormat, BlockchainNetwork, ValidationStatus } from '../../src/types';

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

export type WalletFamily = 'evm' | 'tron' | 'bitcoin' | 'litecoin' | 'dogecoin' | 'solana' | 'xrp';
export type EvmNetwork = 'ethereum' | 'bsc' | 'polygon' | 'arbitrum' | 'optimism' | 'base' | 'avalanche';
export type CanonicalNetwork = EvmNetwork | 'tron' | 'bitcoin' | 'litecoin' | 'dogecoin' | 'solana' | 'xrp';
export type WalletValidationStatus = 'valid' | 'invalid' | 'network_ambiguous' | 'unsupported' | 'unable_to_validate';
export type WalletChecksum =
  | 'eip55_valid'
  | 'eip55_absent'
  | 'eip55_invalid'
  | 'base58check_valid'
  | 'base58check_invalid'
  | 'bech32_valid'
  | 'bech32m_valid'
  | 'bech32_invalid'
  | 'ed25519_length'
  | 'none';

export interface NetworkHint {
  network?: string | null;
  token?: string | null;
  source?: string | null;
  /** Optional additive v5 interface: distinct networks observed for this address. */
  conflicting?: readonly string[];
}

export interface WalletValidationOptions {
  candidateNetworks?: readonly string[] | null;
  networkHint?: NetworkHint | string | null;
  /** Optional family claimed by the upstream sensor. Only used to break the BTC/LTC P2SH tie. */
  family?: string | null;
}

export interface WalletValidationResult {
  status: WalletValidationStatus;
  family: WalletFamily | null;
  network: CanonicalNetwork | null;
  candidate_networks: CanonicalNetwork[];
  address_normalized: string;
  checksum: WalletChecksum;
  reasons: string[];
}

export const EVM_NETWORKS: readonly EvmNetwork[] = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'avalanche'];
export const FAMILY_NETWORKS: Record<WalletFamily, readonly CanonicalNetwork[]> = {
  evm: EVM_NETWORKS,
  tron: ['tron'],
  bitcoin: ['bitcoin'],
  litecoin: ['litecoin'],
  dogecoin: ['dogecoin'],
  solana: ['solana'],
  xrp: ['xrp'],
};
const ALL_NETWORKS = new Set<CanonicalNetwork>(Object.values(FAMILY_NETWORKS).flat());
const FAMILIES = new Set<WalletFamily>(Object.keys(FAMILY_NETWORKS) as WalletFamily[]);

export function familyOfNetwork(network: CanonicalNetwork): WalletFamily {
  for (const [family, nets] of Object.entries(FAMILY_NETWORKS)) if (nets.includes(network)) return family as WalletFamily;
  throw new Error(`Unknown network ${network}`);
}

// ---------------------------------------------------------------------------------------------
// Network label normalisation (canonical names, plus labels such as ERC20 / BEP20 / TRC20)
// ---------------------------------------------------------------------------------------------

/** Labels that name a network unambiguously. Keys are lower-case, words separated by one space. */
const STRONG_LABELS: Record<string, CanonicalNetwork> = {
  ethereum: 'ethereum', erc20: 'ethereum', 'erc 20': 'ethereum', 'ethereum mainnet': 'ethereum',
  bsc: 'bsc', bep20: 'bsc', 'bep 20': 'bsc', 'bnb smart chain': 'bsc', 'binance smart chain': 'bsc', 'bnb chain': 'bsc',
  polygon: 'polygon', matic: 'polygon', 'polygon pos': 'polygon',
  arbitrum: 'arbitrum', 'arbitrum one': 'arbitrum',
  optimism: 'optimism', 'op mainnet': 'optimism',
  base: 'base',
  avalanche: 'avalanche', 'avax c chain': 'avalanche', 'avalanche c chain': 'avalanche', 'c chain': 'avalanche', 'avaxc': 'avalanche',
  tron: 'tron', trc20: 'tron', 'trc 20': 'tron', trx: 'tron',
  bitcoin: 'bitcoin', btc: 'bitcoin',
  litecoin: 'litecoin', ltc: 'litecoin',
  dogecoin: 'dogecoin', doge: 'dogecoin',
  solana: 'solana', spl: 'solana',
  xrp: 'xrp', ripple: 'xrp', xrpl: 'xrp', 'xrp ledger': 'xrp',
};
/** Ticker-like labels that are also gas tokens on other networks; used only when nothing stronger matched. */
const WEAK_LABELS: Record<string, CanonicalNetwork> = {
  eth: 'ethereum', ether: 'ethereum', bnb: 'bsc', pol: 'polygon', arb: 'arbitrum', op: 'optimism', avax: 'avalanche', sol: 'solana',
};
const GENERIC_LABELS = new Set(['', 'unknown', 'auto', 'crypto', 'wallet', 'deposit', 'evm', 'evm_uncertain', 'any', 'none', 'null']);

export interface NetworkLabelResult {
  network: CanonicalNetwork | null;
  /** Set when the text was not usable (empty, generic, unknown, or naming several networks). */
  problem?: string;
}

/** Maps a canonical name or a raw label ("USDT (TRC20)", "BEP20", "AVAX C-Chain") to a canonical network. */
export function normalizeNetworkLabel(raw: unknown): NetworkLabelResult {
  if (typeof raw !== 'string') return { network: null, problem: 'no network label' };
  const text = raw.trim().toLowerCase();
  if (GENERIC_LABELS.has(text)) return { network: null, problem: text ? `generic label '${raw}'` : 'no network label' };
  if (ALL_NETWORKS.has(text as CanonicalNetwork)) return { network: text as CanonicalNetwork };
  if (text === 'xrpl') return { network: 'xrp' };
  const words = text.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const strong = new Set<CanonicalNetwork>();
  const weak = new Set<CanonicalNetwork>();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (STRONG_LABELS[phrase]) strong.add(STRONG_LABELS[phrase]);
      if (n === 1 && WEAK_LABELS[phrase]) weak.add(WEAK_LABELS[phrase]);
    }
  }
  const chosen = strong.size ? strong : weak;
  if (chosen.size === 1) return { network: [...chosen][0] };
  if (chosen.size > 1) return { network: null, problem: `label '${raw}' names several networks (${[...chosen].join(', ')})` };
  return { network: null, problem: `label '${raw}' does not name a supported network` };
}

function hintFromOptions(hint: WalletValidationOptions['networkHint']): { network: CanonicalNetwork | null; text: string | null; problem?: string } {
  if (hint === null || hint === undefined) return { network: null, text: null };
  if (typeof hint === 'string') {
    const r = normalizeNetworkLabel(hint);
    return { network: r.network, text: hint, problem: r.problem };
  }
  if (typeof hint === 'object') {
    if (typeof hint.network === 'string' && hint.network.trim()) {
      const r = normalizeNetworkLabel(hint.network);
      if (r.network) return { network: r.network, text: hint.network };
      // Fall back to the token text only for a usable label ("USDT (TRC20)").
      if (typeof hint.token === 'string') {
        const t = normalizeNetworkLabel(hint.token);
        if (t.network) return { network: t.network, text: hint.token };
      }
      return { network: null, text: hint.network, problem: r.problem };
    }
    if (typeof hint.token === 'string' && hint.token.trim()) {
      const t = normalizeNetworkLabel(hint.token);
      return { network: t.network, text: hint.token, problem: t.problem };
    }
  }
  return { network: null, text: null };
}

// ---------------------------------------------------------------------------------------------
// Keccak-256 (original Keccak padding, as used by Ethereum / EIP-55)
// ---------------------------------------------------------------------------------------------

const KECCAK_RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets r[x][y]
const KECCAK_ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const MASK64 = (1n << 64n) - 1n;
const rotl64 = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF1600(s: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], KECCAK_ROT[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
    }
    s[0] ^= KECCAK_RC[round];
  }
}

/** Keccak-256 digest (Ethereum flavour: padding byte 0x01, not SHA3's 0x06). */
export function keccak256(input: Uint8Array | string): Uint8Array {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      state[i] ^= lane;
    }
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/** Returns the EIP-55 checksummed form of a 0x-prefixed 40-hex-digit address. */
export function toEip55(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower);
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Base58 / Base58Check
// ---------------------------------------------------------------------------------------------

export const BITCOIN_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const RIPPLE_BASE58_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** Decodes Base58 text with the given alphabet; returns null on a character outside the alphabet. */
export function base58Decode(text: string, alphabet = BITCOIN_BASE58_ALPHABET): Uint8Array | null {
  if (!text) return null;
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = alphabet.indexOf(ch);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === alphabet[0]) zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function base58Encode(data: Uint8Array, alphabet = BITCOIN_BASE58_ALPHABET): string {
  const digits: number[] = [];
  for (const byte of data) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let i = 0; i < data.length && data[i] === 0; i++) out += alphabet[0];
  for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]];
  return out;
}

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const doubleSha256 = (data: Uint8Array): Uint8Array => sha256(sha256(data));

export function base58CheckEncode(payload: Uint8Array, alphabet = BITCOIN_BASE58_ALPHABET): string {
  const checksum = doubleSha256(payload).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return base58Encode(full, alphabet);
}

interface Base58CheckDecoded {
  bytes: Uint8Array; // full decoded bytes including checksum
  payload: Uint8Array; // without checksum
  checksumOk: boolean;
}
function base58CheckDecode(text: string, alphabet = BITCOIN_BASE58_ALPHABET): Base58CheckDecoded | null {
  const bytes = base58Decode(text, alphabet);
  if (!bytes || bytes.length < 5) return null;
  const payload = bytes.slice(0, bytes.length - 4);
  const expected = doubleSha256(payload).slice(0, 4);
  const actual = bytes.slice(bytes.length - 4);
  return { bytes, payload, checksumOk: expected.every((b, i) => b === actual[i]) };
}

// ---------------------------------------------------------------------------------------------
// Bech32 / Bech32m (BIP-173 / BIP-350)
// ---------------------------------------------------------------------------------------------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk >>> 0;
}
function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

type Bech32Encoding = 'bech32' | 'bech32m';
interface Bech32Decoded {
  hrp: string;
  data: number[]; // 5-bit words without checksum
  encoding: Bech32Encoding;
}
type Bech32DecodeError = { error: string };

function bech32Decode(text: string): Bech32Decoded | Bech32DecodeError {
  if (text.length > 90) return { error: 'longer than 90 characters' };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 33 || c > 126) return { error: 'contains characters outside the printable ASCII range' };
  }
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return { error: 'mixes upper and lower case' };
  const lower = text.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return { error: 'separator position is invalid' };
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return { error: `contains '${ch}', which is not a bech32 character` };
    data.push(v);
  }
  const check = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  const encoding: Bech32Encoding | null = check === BECH32_CONST ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null;
  if (!encoding) return { error: 'checksum does not match' };
  return { hrp, data: data.slice(0, data.length - 6), encoding };
}

export function bech32Encode(hrp: string, data: number[], encoding: Bech32Encoding): string {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ (encoding === 'bech32' ? BECH32_CONST : BECH32M_CONST);
  let out = hrp + '1';
  for (const d of data) out += BECH32_CHARSET[d];
  for (let i = 0; i < 6; i++) out += BECH32_CHARSET[(mod >>> (5 * (5 - i))) & 31];
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

/** Encodes a segwit address (used by tests to build vectors). */
export function encodeSegwitAddress(hrp: string, version: number, program: Uint8Array, encoding?: Bech32Encoding): string {
  const words = convertBits([...program], 8, 5, true)!;
  return bech32Encode(hrp, [version, ...words], encoding ?? (version === 0 ? 'bech32' : 'bech32m'));
}

interface SegwitResult {
  ok: boolean;
  checksum: WalletChecksum;
  reasons: string[];
  version?: number;
  program?: Uint8Array;
}
function decodeSegwit(text: string, expectedHrp: string): SegwitResult {
  const decoded = bech32Decode(text);
  if ('error' in decoded) return { ok: false, checksum: 'bech32_invalid', reasons: [`Bech32 decoding failed: ${decoded.error}.`] };
  if (decoded.hrp !== expectedHrp) return { ok: false, checksum: 'bech32_invalid', reasons: [`Human-readable part '${decoded.hrp}' is not '${expectedHrp}'.`] };
  if (decoded.data.length < 1) return { ok: false, checksum: 'bech32_invalid', reasons: ['Missing witness version.'] };
  const version = decoded.data[0];
  if (version > 16) return { ok: false, checksum: 'bech32_invalid', reasons: [`Witness version ${version} is out of range (0-16).`] };
  const programWords = convertBits(decoded.data.slice(1), 5, 8, false);
  if (!programWords) return { ok: false, checksum: 'bech32_invalid', reasons: ['Witness program has invalid padding.'] };
  const program = new Uint8Array(programWords);
  if (program.length < 2 || program.length > 40) {
    return { ok: false, checksum: 'bech32_invalid', reasons: [`Witness program is ${program.length} bytes; it must be 2-40 bytes.`] };
  }
  if (version === 0) {
    if (decoded.encoding !== 'bech32') return { ok: false, checksum: 'bech32_invalid', reasons: ['Witness version 0 must use bech32, but this address uses the bech32m checksum (BIP-350).'] };
    if (program.length !== 20 && program.length !== 32) {
      return { ok: false, checksum: 'bech32_invalid', reasons: [`Witness version 0 program is ${program.length} bytes; it must be 20 (P2WPKH) or 32 (P2WSH) bytes.`] };
    }
    return { ok: true, checksum: 'bech32_valid', reasons: [`Valid bech32 witness v0 address (${program.length === 20 ? 'P2WPKH' : 'P2WSH'}).`], version, program };
  }
  if (decoded.encoding !== 'bech32m') return { ok: false, checksum: 'bech32_invalid', reasons: [`Witness version ${version} must use bech32m, but this address uses the bech32 checksum (BIP-350).`] };
  return { ok: true, checksum: 'bech32m_valid', reasons: [`Valid bech32m witness v${version} address${version === 1 && program.length === 32 ? ' (Taproot)' : ''}.`], version, program };
}

// ---------------------------------------------------------------------------------------------
// Unsupported-but-recognisable chains
// ---------------------------------------------------------------------------------------------

const UNSUPPORTED_PATTERNS: Array<{ chain: string; test: (a: string) => boolean }> = [
  { chain: 'Cardano', test: a => /^(addr|stake)(_test)?1[02-9ac-hj-np-z]{20,}$/.test(a) || /^(Ae2|DdzFF)[1-9A-HJ-NP-Za-km-z]{40,}$/.test(a) },
  { chain: 'Stellar', test: a => /^[GM][A-Z2-7]{55}$/.test(a) || /^M[A-Z2-7]{68}$/.test(a) },
  { chain: 'Algorand', test: a => /^[A-Z2-7]{58}$/.test(a) },
  { chain: 'Bitcoin Cash', test: a => /^(bitcoincash:)?[qp][02-9ac-hj-np-z]{41}$/i.test(a) },
  { chain: 'Monero', test: a => /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(a) || /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{104}$/.test(a) },
  { chain: 'TON', test: a => /^(EQ|UQ|Ef|Uf|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(a) || /^-?[01]:[0-9a-fA-F]{64}$/.test(a) },
  { chain: 'Tezos', test: a => /^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) },
  { chain: 'Polkadot/Kusama (SS58)', test: a => /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a) && (base58Decode(a)?.length ?? 0) >= 35 },
  { chain: 'Cosmos-SDK chain', test: a => /^(cosmos|osmo|terra|juno|kava|akash|secret|sei|celestia|inj|evmos|axelar|stars|dydx)1[02-9ac-hj-np-z]{38,}$/.test(a) },
  { chain: 'BNB Beacon Chain', test: a => /^t?bnb1[02-9ac-hj-np-z]{38}$/.test(a) },
  { chain: 'Bitcoin/Litecoin testnet', test: a => /^(tb|bcrt|tltc|rltc)1[02-9ac-hj-np-z]{8,}$/i.test(a) },
  { chain: 'Harmony/MultiversX/Zilliqa', test: a => /^(one|erd|zil)1[02-9ac-hj-np-z]{38,58}$/.test(a) },
  { chain: 'Filecoin', test: a => /^f[0-4][a-z0-9]{8,}$/.test(a) },
  { chain: 'Hedera', test: a => /^0\.0\.\d{1,12}$/.test(a) },
  { chain: 'NEAR', test: a => /^[a-z0-9_-]{2,59}\.near$/.test(a) },
  { chain: 'EOS', test: a => /^EOS[1-9A-HJ-NP-Za-km-z]{50}$/.test(a) },
];

// ---------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------

interface Detected {
  status: 'valid' | 'invalid' | 'unsupported';
  family: WalletFamily | null;
  /** Networks the format admits (before candidates / hint). */
  formatNetworks: CanonicalNetwork[];
  normalized: string;
  checksum: WalletChecksum;
  reasons: string[];
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Results whose network_ambiguous status comes from a hint contradicting the format (legacy: network_conflict). */
const HINT_CONTRADICTIONS = new WeakSet<WalletValidationResult>();

function detectFormat(address: string): Detected {
  const reasons: string[] = [];
  const invalid = (family: WalletFamily | null, normalized: string, checksum: WalletChecksum, why: string): Detected => ({
    status: 'invalid', family, formatNetworks: family ? [...FAMILY_NETWORKS[family]] : [], normalized, checksum, reasons: [why],
  });

  if (!address) return invalid(null, '', 'none', 'Address is empty.');

  // 1. EVM -----------------------------------------------------------------------------------
  if (/^0[xX][0-9a-fA-F]*$/.test(address)) {
    const hex = address.slice(2);
    const normalized = '0x' + hex.toLowerCase();
    if (hex.length !== 40) return invalid('evm', normalized, 'none', `EVM address must have 40 hex digits after 0x; this one has ${hex.length}.`);
    const allLower = hex === hex.toLowerCase();
    const allUpper = hex === hex.toUpperCase();
    if (allLower || allUpper) {
      reasons.push(`EVM address is all ${allLower ? 'lower' : 'upper'} case, so it carries no EIP-55 checksum; format is valid.`);
      return { status: 'valid', family: 'evm', formatNetworks: [...EVM_NETWORKS], normalized, checksum: 'eip55_absent', reasons };
    }
    const expected = toEip55(address);
    if (expected.slice(2) !== hex) {
      return invalid('evm', normalized, 'eip55_invalid', 'Mixed-case EVM address fails EIP-55 checksum verification (likely a typo or altered character).');
    }
    reasons.push('Mixed-case EVM address passes EIP-55 checksum verification.');
    return { status: 'valid', family: 'evm', formatNetworks: [...EVM_NETWORKS], normalized, checksum: 'eip55_valid', reasons };
  }
  if (/^0[xX]/.test(address) && address.length >= 30 && address.length <= 50) {
    return invalid('evm', address.toLowerCase(), 'none', 'Looks like an EVM address but contains non-hex characters.');
  }

  // 2. SegWit (bech32 / bech32m) -------------------------------------------------------------
  const lowerAddr = address.toLowerCase();
  const segwitHrp = lowerAddr.startsWith('bc1') ? 'bc' : lowerAddr.startsWith('ltc1') ? 'ltc' : null;
  if (segwitHrp && /^[a-z0-9]+$/i.test(address)) {
    const family: WalletFamily = segwitHrp === 'bc' ? 'bitcoin' : 'litecoin';
    const r = decodeSegwit(address, segwitHrp);
    if (r.ok) return { status: 'valid', family, formatNetworks: [family], normalized: lowerAddr, checksum: r.checksum, reasons: r.reasons };
    // A Solana key can, rarely, start with "bc1"/"ltc1"; let a 32-byte Base58 string fall through.
    const maybeSolana = address.length >= 32 && address.length <= 44 && BASE58_RE.test(address) && base58Decode(address)?.length === 32;
    if (!maybeSolana) return { status: 'invalid', family, formatNetworks: [family], normalized: lowerAddr, checksum: r.checksum, reasons: r.reasons };
  }

  // 3. Base58 families -------------------------------------------------------------------------
  if (BASE58_RE.test(address)) {
    // XRP uses its own alphabet and always starts with 'r'.
    if (address.startsWith('r') && address.length >= 25 && address.length <= 35) {
      const x = base58CheckDecode(address, RIPPLE_BASE58_ALPHABET);
      if (x && x.checksumOk && x.payload.length === 21 && x.payload[0] === 0x00) {
        return { status: 'valid', family: 'xrp', formatNetworks: ['xrp'], normalized: address, checksum: 'base58check_valid', reasons: ['Valid XRP Ledger classic address (Base58Check, Ripple alphabet).'] };
      }
    }
    const d = base58CheckDecode(address);
    if (d && d.checksumOk && d.payload.length === 21) {
      const v = d.payload[0];
      const ok = (family: WalletFamily | null, nets: CanonicalNetwork[], why: string): Detected => ({
        status: 'valid', family, formatNetworks: nets, normalized: address, checksum: 'base58check_valid', reasons: [why],
      });
      if (v === 0x00) return ok('bitcoin', ['bitcoin'], 'Valid Bitcoin P2PKH address (Base58Check version 0x00).');
      if (v === 0x05) return ok(null, ['bitcoin', 'litecoin'], 'Valid P2SH address (Base58Check version 0x05), a format shared by Bitcoin and legacy Litecoin.');
      if (v === 0x30) return ok('litecoin', ['litecoin'], 'Valid Litecoin P2PKH address (Base58Check version 0x30).');
      if (v === 0x32) return ok('litecoin', ['litecoin'], 'Valid Litecoin P2SH address (Base58Check version 0x32).');
      if (v === 0x1e) return ok('dogecoin', ['dogecoin'], 'Valid Dogecoin P2PKH address (Base58Check version 0x1e).');
      if (v === 0x16) return ok('dogecoin', ['dogecoin'], 'Valid Dogecoin P2SH address (Base58Check version 0x16).');
      if (v === 0x41) return ok('tron', ['tron'], 'Valid TRON address (Base58Check version 0x41, 21 bytes).');
      return { status: 'unsupported', family: null, formatNetworks: [], normalized: address, checksum: 'base58check_valid', reasons: [`Valid Base58Check payload with version byte 0x${v.toString(16).padStart(2, '0')}, which is not a supported network.`] };
    }
    if (d && d.checksumOk && d.payload.length !== 21 && d.payload.length >= 10 && d.payload.length <= 24) {
      const versionFamily: Record<number, WalletFamily> = { 0x00: 'bitcoin', 0x05: 'bitcoin', 0x30: 'litecoin', 0x32: 'litecoin', 0x1e: 'dogecoin', 0x16: 'dogecoin', 0x41: 'tron' };
      const fam = versionFamily[d.payload[0]];
      if (fam) {
        return invalid(fam, address, 'base58check_valid', `${fam === 'tron' ? 'TRON' : fam[0].toUpperCase() + fam.slice(1)} version byte 0x${d.payload[0].toString(16).padStart(2, '0')} with a ${d.payload.length - 1}-byte body; a ${fam} address carries exactly 20 bytes after the version byte.`);
      }
    }
    if (d && d.checksumOk && d.payload.length !== 21 && d.payload.length >= 20 && d.payload.length <= 40) {
      return { status: 'unsupported', family: null, formatNetworks: [], normalized: address, checksum: 'base58check_valid', reasons: [`Valid Base58Check address with a ${d.payload.length}-byte payload, which is not a supported network format.`] };
    }
    const raw = base58Decode(address);
    if (raw && raw.length === 32 && address.length >= 32 && address.length <= 44) {
      return { status: 'valid', family: 'solana', formatNetworks: ['solana'], normalized: address, checksum: 'ed25519_length', reasons: ['Valid Solana address: Base58 decodes to exactly 32 bytes (ed25519 public key). Solana addresses carry no checksum.'] };
    }
  }

  // 4. Recognisable but unsupported chains -------------------------------------------------------
  for (const p of UNSUPPORTED_PATTERNS) {
    if (p.test(address)) {
      return { status: 'unsupported', family: null, formatNetworks: [], normalized: address, checksum: 'none', reasons: [`Address format belongs to ${p.chain}, which is not a supported network.`] };
    }
  }

  // 5. Looks like a supported family but failed its checks --------------------------------------
  if (BASE58_RE.test(address)) {
    const raw = base58Decode(address);
    const d = base58CheckDecode(address);
    const len = raw?.length ?? 0;
    const describe = (label: string) =>
      len === 25 && d && !d.checksumOk
        ? `${label} Base58Check checksum does not match (likely a typo or altered character).`
        : `${label} address has the wrong length: Base58 decodes to ${len} bytes, expected 25 (21-byte payload + 4-byte checksum).`;
    const cs: WalletChecksum = len === 25 ? 'base58check_invalid' : 'none';
    if (address.startsWith('r') && address.length >= 25 && address.length <= 35) {
      const x = base58CheckDecode(address, RIPPLE_BASE58_ALPHABET);
      const xl = base58Decode(address, RIPPLE_BASE58_ALPHABET)?.length ?? 0;
      return invalid('xrp', address, xl === 25 ? 'base58check_invalid' : 'none', xl === 25 && x && !x.checksumOk ? 'XRP Base58Check checksum (Ripple alphabet) does not match.' : `XRP address has the wrong length: decodes to ${xl} bytes, expected 25.`);
    }
    if (/^T/.test(address) && address.length >= 30 && address.length <= 38) return invalid('tron', address, cs, describe('TRON'));
    if (/^[13]/.test(address) && address.length >= 25 && address.length <= 36) return invalid('bitcoin', address, cs, describe('Bitcoin'));
    if (/^[LM]/.test(address) && address.length >= 25 && address.length <= 36) return invalid('litecoin', address, cs, describe('Litecoin'));
    if (/^[D9A]/.test(address) && address.length >= 25 && address.length <= 36) return invalid('dogecoin', address, cs, describe('Dogecoin'));
    if (address.length >= 43 && address.length <= 44) {
      return invalid('solana', address, 'none', `Base58 string decodes to ${len} bytes; a Solana address must decode to exactly 32 bytes.`);
    }
  }
  return invalid(null, address, 'none', 'Unrecognised address format (not a supported or recognisable wallet address).');
}

/**
 * Authoritative v4 validation (contract §3). Never throws: internal failures are reported as
 * `unable_to_validate`.
 */
export function validateWalletAddress(address: string, options: WalletValidationOptions = {}): WalletValidationResult {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  try {
    return validateInner(trimmed, options);
  } catch (error) {
    return {
      status: 'unable_to_validate',
      family: null,
      network: null,
      candidate_networks: [],
      address_normalized: trimmed,
      checksum: 'none',
      reasons: [`Internal validation failure: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function validateInner(address: string, options: WalletValidationOptions): WalletValidationResult {
  const det = detectFormat(address);
  const reasons = [...det.reasons];
  if (det.status !== 'valid') {
    return {
      status: det.status,
      family: det.family,
      network: null,
      candidate_networks: det.formatNetworks,
      address_normalized: det.normalized,
      checksum: det.checksum,
      reasons,
    };
  }

  const formatNets = det.formatNetworks;

  // Candidate networks supplied upstream (canonical names, or raw labels mapped to them).
  let cands: CanonicalNetwork[] = [...formatNets];
  const supplied = (options.candidateNetworks ?? []).filter(x => typeof x === 'string' && x.trim());
  if (supplied.length) {
    const mapped = new Set<CanonicalNetwork>();
    const dropped: string[] = [];
    for (const s of supplied) {
      const r = normalizeNetworkLabel(s);
      if (r.network) mapped.add(r.network);
      else dropped.push(s);
    }
    if (dropped.length) reasons.push(`Ignored unrecognised candidate network label(s): ${dropped.join(', ')}.`);
    const inter = formatNets.filter(n => mapped.has(n));
    const outside = [...mapped].filter(n => !formatNets.includes(n));
    if (outside.length) reasons.push(`Candidate network(s) ${outside.join(', ')} do not match this address format and were ignored.`);
    if (inter.length) cands = inter;
  }

  // Shared BTC/LTC P2SH: a claimed family may narrow it when nothing else does.
  const claimedFamily = typeof options.family === 'string' && FAMILIES.has(options.family.toLowerCase() as WalletFamily) ? (options.family.toLowerCase() as WalletFamily) : null;
  if (claimedFamily && det.family && claimedFamily !== det.family) {
    reasons.push(`Upstream family '${claimedFamily}' disagrees with the address format ('${det.family}'); the format was used.`);
  }

  const hint = hintFromOptions(options.networkHint);
  if (hint.problem && hint.text !== null) reasons.push(`Network hint not usable: ${hint.problem}.`);

  const familyFor = (net: CanonicalNetwork | null): WalletFamily | null => (net ? familyOfNetwork(net) : det.family ?? (cands.length === 1 ? familyOfNetwork(cands[0]) : 'bitcoin'));
  const base = { address_normalized: det.normalized, checksum: det.checksum };

  const observed = typeof options.networkHint==='object' && options.networkHint
    ? options.networkHint.conflicting ?? [] : [];
  const conflicts=[...new Set(observed.map(label=>normalizeNetworkLabel(label).network).filter((n):n is CanonicalNetwork=>Boolean(n)))];
  if(conflicts.length>1) {
    reasons.push(`Conflicting observed network hints (${conflicts.join(', ')}); analyst review is required.`);
    const result:WalletValidationResult={...base,status:'network_ambiguous',family:familyFor(null),network:null,candidate_networks:[...new Set([...cands,...conflicts.filter(n=>formatNets.includes(n))])],reasons};
    HINT_CONTRADICTIONS.add(result);return result;
  }

  if (hint.network) {
    if (!formatNets.includes(hint.network)) {
      reasons.push(`Network hint '${hint.text}' (${hint.network}) contradicts the address format (${det.family ?? formatNets.join('/')}); the address is kept but its network needs review.`);
      const contradicted: WalletValidationResult = { ...base, status: 'network_ambiguous', family: familyFor(null), network: null, candidate_networks: cands, reasons };
      HINT_CONTRADICTIONS.add(contradicted);
      return contradicted;
    }
    if (!cands.includes(hint.network)) reasons.push(`Network hint '${hint.network}' was not in the supplied candidate list; the explicit hint was used.`);
    reasons.push(`Network resolved to ${hint.network} from the hint '${hint.text}'.`);
    return { ...base, status: 'valid', family: familyFor(hint.network), network: hint.network, candidate_networks: cands.includes(hint.network) ? cands : [...cands, hint.network], reasons };
  }

  if (cands.length > 1 && claimedFamily && !det.family) {
    const narrowed = cands.filter(n => familyOfNetwork(n) === claimedFamily);
    if (narrowed.length === 1) {
      reasons.push(`Network resolved to ${narrowed[0]} from the upstream family '${claimedFamily}'.`);
      cands = narrowed;
    }
  }

  if (cands.length === 1) {
    if (formatNets.length > 1) reasons.push(`Network resolved to ${cands[0]}, the only candidate network.`);
    return { ...base, status: 'valid', family: familyFor(cands[0]), network: cands[0], candidate_networks: cands, reasons };
  }
  reasons.push(`No usable network hint and ${cands.length} candidate networks (${cands.join(', ')}); the network is not guessed.`);
  return { ...base, status: 'network_ambiguous', family: familyFor(null), network: null, candidate_networks: cands, reasons };
}

// ---------------------------------------------------------------------------------------------
// Legacy adapter (old result shape / status names used across the module)
// ---------------------------------------------------------------------------------------------

export interface AddressValidationResult {
  is_valid: boolean;
  address_format: AddressFormat;
  detected_network: BlockchainNetwork;
  resolved_network: BlockchainNetwork;
  validation_status: ValidationStatus;
  has_checksum: boolean;
  checksum_valid: boolean;
  network_ambiguity: boolean;
  conflict_detected: boolean;
  conflict_notes?: string;
  normalized_address: string;
  supported_assets: string[];
  /** The authoritative v4 result this legacy view was derived from. */
  v4?: WalletValidationResult;
}

/** Contract network → internal engine/provider network name. */
export function toEngineNetwork(network: CanonicalNetwork): BlockchainNetwork {
  return network === 'xrp' ? 'xrpl' : (network as BlockchainNetwork);
}
/** Internal engine network name → contract network name. */
export function toContractNetwork(network: string): string {
  return network === 'xrpl' ? 'xrp' : network;
}

const SUPPORTED_ASSETS: Record<string, string[]> = {
  evm: ['ETH', 'USDT ERC20', 'USDC', 'BNB', 'BEP20', 'MATIC', 'POL'],
  bitcoin: ['BTC'], litecoin: ['LTC'], dogecoin: ['DOGE'], tron: ['TRX', 'USDT TRC20'], solana: ['SOL', 'USDC SPL'], xrp: ['XRP'],
};

function legacyFormat(r: WalletValidationResult, family: WalletFamily | null, network: CanonicalNetwork | null): AddressFormat {
  const a = r.address_normalized;
  switch (family) {
    case 'evm': return 'evm_hex';
    case 'tron': return 'tron_base58';
    case 'solana': return 'solana_base58';
    case 'xrp': return 'xrpl_base58';
    case 'dogecoin': return 'doge_base58';
    case 'litecoin': return a.startsWith('ltc1') ? 'ltc_bech32' : 'ltc_base58';
    case 'bitcoin':
      if (a.startsWith('bc1')) return r.checksum === 'bech32m_valid' ? 'btc_taproot' : 'btc_bech32';
      if (network === 'litecoin') return 'ltc_base58';
      return a.startsWith('3') ? 'btc_p2sh' : 'btc_p2pkh';
    default: return 'invalid';
  }
}

/** Builds the legacy result shape from a v4 result. */
export function toLegacyValidation(r: WalletValidationResult): AddressValidationResult {
  const hasChecksum = r.checksum !== 'eip55_absent' && r.checksum !== 'ed25519_length' && r.checksum !== 'none';
  const family = r.family;
  if (r.status === 'valid' || r.status === 'network_ambiguous') {
    const isEvm = family === 'evm';
    // P2SH shared by BTC/LTC with no resolution: legacy default is bitcoin with the ambiguity flag.
    const conflict = HINT_CONTRADICTIONS.has(r);
    const sharedP2sh = !isEvm && !conflict && r.status === 'network_ambiguous';
    const resolved: BlockchainNetwork = r.network
      ? toEngineNetwork(r.network)
      : isEvm ? 'evm_uncertain' : sharedP2sh ? 'bitcoin' : family ? toEngineNetwork(FAMILY_NETWORKS[family][0]) : 'evm_uncertain';
    const status: ValidationStatus = conflict ? 'network_conflict' : hasChecksum ? 'valid_checksum' : 'valid_no_checksum';
    return {
      is_valid: true,
      address_format: legacyFormat(r, family, r.network),
      detected_network: isEvm ? 'evm_uncertain' : resolved,
      resolved_network: resolved,
      validation_status: status,
      has_checksum: hasChecksum,
      checksum_valid: true,
      network_ambiguity: r.status === 'network_ambiguous' && !conflict,
      conflict_detected: conflict,
      conflict_notes: conflict ? r.reasons.find(x => x.includes('contradicts')) ?? r.reasons.join(' ') : undefined,
      normalized_address: r.address_normalized,
      supported_assets: family ? SUPPORTED_ASSETS[family] : [],
      v4: r,
    };
  }
  const checksumFailed = r.checksum === 'eip55_invalid' || r.checksum === 'base58check_invalid' || r.checksum === 'bech32_invalid';
  return {
    is_valid: false,
    address_format: 'invalid',
    detected_network: 'evm_uncertain',
    resolved_network: 'evm_uncertain',
    validation_status: r.status === 'invalid' && checksumFailed ? 'invalid_checksum' : 'invalid_format',
    has_checksum: hasChecksum,
    checksum_valid: false,
    network_ambiguity: false,
    conflict_detected: false,
    conflict_notes: r.reasons.join(' ') || 'Unrecognized cryptocurrency address format or invalid characters.',
    normalized_address: r.address_normalized,
    supported_assets: [],
    v4: r,
  };
}

/**
 * Legacy entry point: validates an address with an optional free-text reported network/token.
 * Generic labels ("crypto", "wallet", "unknown", ...) are treated as no hint.
 */
export function validateAddress(rawAddress: string, reportedNetworkOrToken?: string): AddressValidationResult {
  const reported = (reportedNetworkOrToken || '').trim();
  const hint = reported && !GENERIC_LABELS.has(reported.toLowerCase()) ? reported : null;
  return toLegacyValidation(validateWalletAddress(rawAddress, { networkHint: hint }));
}
