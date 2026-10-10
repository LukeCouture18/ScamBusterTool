/**
 * v4 wallet validation (contract §3). Run:
 *   node --import tsx --test tests/validation-v4.test.ts
 * Pure functions only: no database, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  base58CheckEncode,
  base58Decode,
  base58Encode,
  encodeSegwitAddress,
  keccak256,
  normalizeNetworkLabel,
  RIPPLE_BASE58_ALPHABET,
  toEip55,
  validateAddress,
  validateWalletAddress as v,
} from '../server/crypto/validation';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** Deterministic pseudo-random bytes for generated vectors. */
const bytes = (seed: string, n: number) => new Uint8Array(createHash('sha512').update(seed).digest()).slice(0, n);
const withVersion = (version: number, body: Uint8Array) => new Uint8Array([version, ...body]);
/** Changes one character to another character of the same alphabet. */
function mutate(address: string, index: number, alphabet: string): string {
  const i = index < 0 ? address.length + index : index;
  const c = address[i];
  const next = alphabet[(alphabet.indexOf(c) + 1) % alphabet.length];
  return address.slice(0, i) + next + address.slice(i + 1);
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function assertValid(address: string, network: string, family: string, opts = {}) {
  const r = v(address, opts);
  assert.equal(r.status, 'valid', `${address}: ${JSON.stringify(r)}`);
  assert.equal(r.network, network);
  assert.equal(r.family, family);
  return r;
}
function assertInvalid(address: string, opts = {}) {
  const r = v(address, opts);
  assert.equal(r.status, 'invalid', `${address}: ${JSON.stringify(r)}`);
  assert.equal(r.network, null);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

test('keccak-256 known digests', () => {
  assert.equal(hex(keccak256('')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(hex(keccak256('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // Multi-block input (> 136-byte rate)
  assert.equal(hex(keccak256('a'.repeat(200))).length, 64);
  assert.notEqual(hex(keccak256('a'.repeat(136))), hex(keccak256('a'.repeat(135))));
});

test('base58 / base58check encoders round-trip published addresses', () => {
  const genesis = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const raw = base58Decode(genesis)!;
  assert.equal(raw.length, 25);
  assert.equal(base58Encode(raw), genesis);
  assert.equal(base58CheckEncode(raw.slice(0, 21)), genesis);
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  assert.equal(base58CheckEncode(base58Decode(tron)!.slice(0, 21)), tron);
  const xrp = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
  assert.equal(base58CheckEncode(base58Decode(xrp, RIPPLE_BASE58_ALPHABET)!.slice(0, 21), RIPPLE_BASE58_ALPHABET), xrp);
});

test('segwit encoder reproduces BIP-173 / BIP-350 published addresses', () => {
  const p2wpkh = new Uint8Array(Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex'));
  assert.equal(encodeSegwitAddress('bc', 0, p2wpkh), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  const taproot = new Uint8Array(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));
  assert.equal(encodeSegwitAddress('bc', 1, taproot), 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
});

// ---------------------------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------------------------

const EIP55 = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

test('EVM: EIP-55 published vectors are valid with checksum eip55_valid', () => {
  for (const a of EIP55) {
    assert.equal(toEip55(a.toLowerCase()), a);
    const r = assertValid(a, 'bsc', 'evm', { networkHint: { network: 'bsc', token: 'USDT', source: 'selected-option' } });
    assert.equal(r.checksum, 'eip55_valid');
    assert.equal(r.address_normalized, a.toLowerCase());
  }
});

test('EVM: wrong case of one letter fails EIP-55 → invalid', () => {
  for (const a of EIP55) {
    const i = [...a].findIndex((c, k) => k > 1 && /[a-f]/i.test(c));
    const flipped = a.slice(0, i) + (a[i] === a[i].toLowerCase() ? a[i].toUpperCase() : a[i].toLowerCase()) + a.slice(i + 1);
    const r = assertInvalid(flipped, { networkHint: 'ethereum' });
    assert.equal(r.checksum, 'eip55_invalid');
    assert.equal(r.family, 'evm');
    assert.equal(r.address_normalized, flipped.toLowerCase());
  }
});

test('EVM: all-lower and all-upper are format-valid with checksum absent', () => {
  const lower = EIP55[0].toLowerCase();
  const upper = '0x' + EIP55[0].slice(2).toUpperCase();
  for (const a of [lower, upper]) {
    const r = assertValid(a, 'ethereum', 'evm', { networkHint: 'ERC20' });
    assert.equal(r.checksum, 'eip55_absent');
    assert.equal(r.address_normalized, lower);
  }
});

test('EVM: wrong length and non-hex are invalid', () => {
  assert.equal(assertInvalid(EIP55[0].slice(0, 41)).family, 'evm');
  assert.equal(assertInvalid(EIP55[0] + 'a').family, 'evm');
  assertInvalid('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg');
});

test('EVM: no usable hint and several candidates → network_ambiguous (never guessed)', () => {
  const none = v(EIP55[1]);
  assert.equal(none.status, 'network_ambiguous');
  assert.equal(none.network, null);
  assert.equal(none.family, 'evm');
  assert.equal(none.candidate_networks.length, 7);
  const two = v(EIP55[1], { candidateNetworks: ['ethereum', 'bsc'], networkHint: null });
  assert.equal(two.status, 'network_ambiguous');
  assert.deepEqual(two.candidate_networks, ['ethereum', 'bsc']);
  const tokenOnly = v(EIP55[1], { candidateNetworks: ['ethereum', 'bsc'], networkHint: { network: null, token: 'USDT', source: 'nearby-text' } });
  assert.equal(tokenOnly.status, 'network_ambiguous');
  const generic = v(EIP55[1], { networkHint: 'unknown' });
  assert.equal(generic.status, 'network_ambiguous');
});

test('EVM: single candidate or a usable hint resolves the network', () => {
  assertValid(EIP55[2], 'polygon', 'evm', { candidateNetworks: ['polygon'] });
  assertValid(EIP55[2], 'bsc', 'evm', { candidateNetworks: ['ethereum', 'bsc'], networkHint: { network: 'bsc', token: 'USDT', source: 'label' } });
  // Raw labels passed as hint text
  const labels: Array<[string, string]> = [
    ['ERC20', 'ethereum'], ['BEP20', 'bsc'], ['BSC', 'bsc'], ['BNB Smart Chain', 'bsc'], ['USDT (BEP-20)', 'bsc'],
    ['Polygon', 'polygon'], ['MATIC', 'polygon'], ['Arbitrum One', 'arbitrum'], ['OP', 'optimism'], ['Optimism', 'optimism'],
    ['Base', 'base'], ['AVAX C-Chain', 'avalanche'],
  ];
  for (const [label, net] of labels) assertValid(EIP55[2], net, 'evm', { networkHint: label });
  // Hint object whose network is a label
  assertValid(EIP55[2], 'ethereum', 'evm', { networkHint: { network: 'ERC20', token: 'USDT', source: 'label' } });
  // Canonical candidate list with raw labels mapped
  assertValid(EIP55[2], 'bsc', 'evm', { candidateNetworks: ['BEP20'] });
});

test('EVM: hint contradicting the family → network_ambiguous with a reason', () => {
  const r = v(EIP55[3], { networkHint: { network: 'TRC20', token: 'USDT', source: 'label' } });
  assert.equal(r.status, 'network_ambiguous');
  assert.equal(r.family, 'evm');
  assert.ok(r.reasons.some(x => /contradicts/.test(x)));
});

// ---------------------------------------------------------------------------------------------
// Bitcoin
// ---------------------------------------------------------------------------------------------

test('Bitcoin: published base58 addresses are valid and case-preserved', () => {
  for (const a of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT']) {
    const r = assertValid(a, 'bitcoin', 'bitcoin');
    assert.equal(r.checksum, 'base58check_valid');
    assert.equal(r.address_normalized, a);
  }
  // The P2SH version byte (0x05) is shared with legacy Litecoin; a single candidate/hint resolves it.
  assertValid('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bitcoin', 'bitcoin', { candidateNetworks: ['bitcoin'] });
  assertValid('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bitcoin', 'bitcoin', { networkHint: 'BTC' });
  assertValid('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'litecoin', 'litecoin', { networkHint: 'LTC' });
  assertValid('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'litecoin', 'litecoin', { family: 'litecoin' });
  assert.equal(v('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy').status, 'network_ambiguous');
});

test('Bitcoin: one changed character breaks base58check', () => {
  // 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb differs from the genesis address only in the last character.
  const r = assertInvalid('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb');
  assert.equal(r.checksum, 'base58check_invalid');
  assert.equal(r.family, 'bitcoin');
  assert.equal(assertInvalid(mutate('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 10, B58)).checksum, 'base58check_invalid');
  // Wrong length: valid checksum over a 20-byte payload
  assert.equal(assertInvalid(base58CheckEncode(withVersion(0x00, bytes('short', 19)))).family, 'bitcoin');
});

test('Bitcoin: bech32 / bech32m (BIP-173 / BIP-350)', () => {
  const p2wpkh = assertValid('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bitcoin', 'bitcoin');
  assert.equal(p2wpkh.checksum, 'bech32_valid');
  const upper = assertValid('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bitcoin', 'bitcoin');
  assert.equal(upper.address_normalized, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(assertValid('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'bitcoin', 'bitcoin').checksum, 'bech32_valid');
  const tr = assertValid('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'bitcoin', 'bitcoin');
  assert.equal(tr.checksum, 'bech32m_valid');
  // BIP-350 valid: witness v1, 40-byte program
  assertValid('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'bitcoin', 'bitcoin');
  // Generated: witness v2 with 16-byte program (bech32m)
  assertValid(encodeSegwitAddress('bc', 2, bytes('v2', 16)), 'bitcoin', 'bitcoin');
});

test('Bitcoin: bech32 vs bech32m mix-ups, broken checksums, bad lengths and mixed case are invalid', () => {
  // BIP-350 invalid vectors: v1 with bech32 checksum; v0 with bech32m checksum
  assert.equal(assertInvalid('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd').checksum, 'bech32_invalid');
  assert.equal(assertInvalid('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh').checksum, 'bech32_invalid');
  // Generated equivalents
  assertInvalid(encodeSegwitAddress('bc', 0, bytes('p', 20), 'bech32m'));
  assertInvalid(encodeSegwitAddress('bc', 1, bytes('p', 32), 'bech32'));
  // One changed character
  assertInvalid(mutate('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', -1, BECH32));
  assertInvalid(mutate('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 20, BECH32));
  // Wrong program lengths
  assertInvalid(encodeSegwitAddress('bc', 0, bytes('p', 21)));
  assertInvalid(encodeSegwitAddress('bc', 0, bytes('p', 31)));
  assertInvalid(encodeSegwitAddress('bc', 1, bytes('p', 1)));
  assertInvalid(encodeSegwitAddress('bc', 1, bytes('p', 41)));
  // Mixed case
  assertInvalid('bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});

// ---------------------------------------------------------------------------------------------
// Litecoin / Dogecoin
// ---------------------------------------------------------------------------------------------

test('Litecoin: base58 0x30 / 0x32 / 0x05 and bech32 ltc', () => {
  const l = base58CheckEncode(withVersion(0x30, bytes('ltc-l', 20)));
  const m = base58CheckEncode(withVersion(0x32, bytes('ltc-m', 20)));
  assert.ok(l.startsWith('L'));
  assert.ok(m.startsWith('M'));
  assert.equal(assertValid(l, 'litecoin', 'litecoin').address_normalized, l);
  assertValid(m, 'litecoin', 'litecoin');
  const p2sh = base58CheckEncode(withVersion(0x05, bytes('ltc-3', 20)));
  assertValid(p2sh, 'litecoin', 'litecoin', { candidateNetworks: ['litecoin'] });
  const segwit = encodeSegwitAddress('ltc', 0, bytes('ltc-seg', 20));
  assert.ok(segwit.startsWith('ltc1q'));
  assert.equal(assertValid(segwit, 'litecoin', 'litecoin').checksum, 'bech32_valid');
  assertValid(encodeSegwitAddress('ltc', 1, bytes('ltc-tr', 32)), 'litecoin', 'litecoin');
  assertInvalid(mutate(l, 5, B58));
  assertInvalid(mutate(segwit, -2, BECH32));
  assertInvalid(encodeSegwitAddress('ltc', 0, bytes('ltc-seg', 20), 'bech32m'));
});

test('Dogecoin: base58 0x1e / 0x16', () => {
  const d = base58CheckEncode(withVersion(0x1e, bytes('doge-d', 20)));
  const s = base58CheckEncode(withVersion(0x16, bytes('doge-s', 20)));
  assert.ok(d.startsWith('D'));
  assert.ok(/^[9A]/.test(s));
  assert.equal(assertValid(d, 'dogecoin', 'dogecoin').address_normalized, d);
  assertValid(s, 'dogecoin', 'dogecoin');
  assert.equal(assertInvalid(mutate(d, 8, B58)).family, 'dogecoin');
});

// ---------------------------------------------------------------------------------------------
// TRON / XRP / Solana
// ---------------------------------------------------------------------------------------------

test('TRON: base58check 0x41, case preserved; broken checksum and wrong length invalid', () => {
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const r = assertValid(tron, 'tron', 'tron', { candidateNetworks: ['tron'], networkHint: { network: 'tron', token: 'USDT', source: 'label' } });
  assert.equal(r.address_normalized, tron);
  assert.equal(r.checksum, 'base58check_valid');
  assertValid(tron, 'tron', 'tron', { networkHint: 'USDT (TRC20)' });
  const broken = mutate(tron, 12, B58);
  assert.equal(assertInvalid(broken).checksum, 'base58check_invalid');
  assert.equal(v(broken).family, 'tron');
  // The lower-cased key Main stores is not a valid TRON address.
  assert.notEqual(v(tron.toLowerCase()).status, 'valid');
  const short = base58CheckEncode(withVersion(0x41, bytes('tron-short', 19)));
  assert.equal(assertInvalid(short).family, 'tron');
});

test('TRON address with hint bsc → network_ambiguous, address kept', () => {
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const r = v(tron, { candidateNetworks: ['tron'], networkHint: { network: 'bsc', token: 'USDT', source: 'nearby-text' } });
  assert.equal(r.status, 'network_ambiguous');
  assert.equal(r.family, 'tron');
  assert.equal(r.network, null);
  assert.equal(r.address_normalized, tron);
  assert.equal(r.checksum, 'base58check_valid');
  assert.ok(r.reasons.some(x => /bsc/.test(x) && /contradicts/.test(x)));
});

test('XRP: ripple-alphabet base58check', () => {
  const xrp = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
  const r = assertValid(xrp, 'xrp', 'xrp');
  assert.equal(r.address_normalized, xrp);
  assert.equal(r.checksum, 'base58check_valid');
  const gen = base58CheckEncode(withVersion(0x00, bytes('xrp', 20)), RIPPLE_BASE58_ALPHABET);
  assert.ok(gen.startsWith('r'));
  assertValid(gen, 'xrp', 'xrp');
  assert.equal(assertInvalid(mutate(xrp, 7, RIPPLE_BASE58_ALPHABET)).family, 'xrp');
});

test('Solana: base58 decoding to exactly 32 bytes', () => {
  const sol = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
  const r = assertValid(sol, 'solana', 'solana', { networkHint: 'SPL' });
  assert.equal(r.address_normalized, sol);
  assert.equal(r.checksum, 'ed25519_length');
  assertValid(base58Encode(bytes('sol-gen', 32)), 'solana', 'solana');
  assertInvalid(base58Encode(new Uint8Array([7, ...bytes('sol-33', 32)])));
  const r31 = v(base58Encode(new Uint8Array([7, ...bytes('sol-31', 30)])));
  assert.notEqual(r31.status, 'valid');
});

// ---------------------------------------------------------------------------------------------
// Unsupported / unable / misc
// ---------------------------------------------------------------------------------------------

test('Recognisable but unsupported chains → unsupported', () => {
  const cardano = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
  const stellar = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
  for (const a of [cardano, stellar, 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']) {
    const r = v(a);
    assert.equal(r.status, 'unsupported', a);
    assert.equal(r.network, null);
  }
});

test('Garbage input is invalid; internal failure → unable_to_validate', () => {
  assert.equal(v('').status, 'invalid');
  assert.equal(v('not_a_crypto_address_123').status, 'invalid');
  const hostile = { get network(): string { throw new Error('boom'); } };
  const r = v(EIP55[0], { networkHint: hostile });
  assert.equal(r.status, 'unable_to_validate');
  assert.ok(r.reasons[0].includes('boom'));
});

test('Normalisation: EVM lower, bech32 lower, base58 case-preserved; whitespace trimmed', () => {
  assert.equal(v(`  ${EIP55[0]}\n`, { networkHint: 'bsc' }).address_normalized, EIP55[0].toLowerCase());
  assert.equal(v('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4').address_normalized, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  for (const a of ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']) {
    assert.equal(v(a).address_normalized, a);
  }
});

test('Network labels map to canonical names', () => {
  assert.equal(normalizeNetworkLabel('USDT (TRC20)').network, 'tron');
  assert.equal(normalizeNetworkLabel('BEP20').network, 'bsc');
  assert.equal(normalizeNetworkLabel('ERC-20').network, 'ethereum');
  assert.equal(normalizeNetworkLabel('AVAX C-Chain').network, 'avalanche');
  assert.equal(normalizeNetworkLabel('SPL').network, 'solana');
  assert.equal(normalizeNetworkLabel('USDT').network, null);
  assert.equal(normalizeNetworkLabel('ERC20 or TRC20').network, null);
});

test('Legacy adapter keeps the old result shape and status names', () => {
  const evm = validateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'ethereum');
  assert.equal(evm.is_valid, true);
  assert.equal(evm.resolved_network, 'ethereum');
  assert.equal(evm.validation_status, 'valid_checksum');
  const uncertain = validateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  assert.equal(uncertain.resolved_network, 'evm_uncertain');
  assert.equal(uncertain.network_ambiguity, true);
  assert.equal(validateAddress(EIP55[0].toLowerCase()).validation_status, 'valid_no_checksum');
  const conflict = validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'bsc');
  assert.equal(conflict.validation_status, 'network_conflict');
  assert.equal(conflict.conflict_detected, true);
  assert.equal(validateAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh').resolved_network, 'xrpl');
  assert.equal(validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').validation_status, 'invalid_checksum');
  assert.equal(validateAddress('garbage').validation_status, 'invalid_format');
  assert.equal(validateAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0').address_format, 'btc_taproot');
});

test('conflicting observed networks require review even when the strongest hint names one', () => {
  const hint={network:'ethereum',conflicting:['ethereum','bsc']};
  const r=v('0x'+'1'.repeat(40),{candidateNetworks:['ethereum'],networkHint:hint});
  assert.equal(r.status,'network_ambiguous');assert.equal(r.network,null);
  assert.ok(r.reasons.some(x=>x.includes('Conflicting observed')));
  assert.equal(v('0xgarbage',{networkHint:hint}).status,'invalid','format/checksum rejection still runs first');
});
