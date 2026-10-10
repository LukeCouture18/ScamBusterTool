/**
 * Cryptographic Checksum & Format Validation Utilities
 * Implements real checksum verification:
 * - Real SHA-256 & Double-SHA256 (pure JS implementation for deterministic sync client/server validation)
 * - Base58 decoding and Base58Check verification (BTC, LTC, DOGE, TRX, XRP)
 * - EIP-55 Mixed-case Checksum Verification using Keccak-256 (ETH, EVM, USDT ERC20/BEP20)
 * - Bech32 and Bech32m Polymod Checksum Verification (BTC SegWit bc1q..., Taproot bc1p..., LTC ltc1...)
 * - Ed25519 32-byte key validation for Solana
 */

// ==========================================
// 1. Pure JS SHA-256 for Base58Check
// ==========================================

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i = 0;
  let j = 0;

  const words: number[] = [];
  const asciiBitLength = data[lengthProperty] * 8;

  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;

  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  for (i = 0; i < data[lengthProperty]; i++) {
    words[i >> 2] |= data[i] << ((3 - (i % 4)) * 8);
  }

  words[asciiBitLength >> 5] |= 0x80 << (24 - (asciiBitLength % 32));
  words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;

  for (let blockStart = 0; blockStart < words.length; blockStart += 16) {
    const w: number[] = [];
    for (i = 0; i < 64; i++) {
      if (i < 16) {
        w[i] = words[blockStart + i] | 0;
      } else {
        const gamma0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const gamma1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + gamma0 + w[i - 7] + gamma1) | 0;
      }
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (i = 0; i < 64; i++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[i] + w[i]) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  const result = new Uint8Array(32);
  for (i = 0; i < 8; i++) {
    for (j = 0; j < 4; j++) {
      result[i * 4 + j] = (hash[i] >>> ((3 - j) * 8)) & 0xff;
    }
  }
  return result;
}

export function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256Bytes(sha256Bytes(data));
}

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const hash = sha256Bytes(bytes);
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ==========================================
// 2. Base58 & Base58Check
// ==========================================

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_MAP[B58_ALPHABET[i]] = i;
}

export function decodeBase58(input: string): Uint8Array | null {
  if (!input || typeof input !== 'string') return null;
  const bytes = [0];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const value = B58_MAP[c];
    if (value === undefined) return null; // Invalid character

    let carry = value;
    for (let j = 0; j < bytes.length; ++j) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Deal with leading zeros in base58 (Bitcoin '1')
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

export function verifyBase58Check(address: string, expectedPrefixBytes?: number[]): { valid: boolean; reason?: string } {
  const decoded = decodeBase58(address);
  if (!decoded) {
    return { valid: false, reason: 'Contains characters outside the Base58 alphabet' };
  }
  if (decoded.length < 5) {
    return { valid: false, reason: 'Decoded byte payload too short (< 5 bytes)' };
  }

  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);

  const hash = doubleSha256(payload);
  const calculatedChecksum = hash.slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== calculatedChecksum[i]) {
      return { valid: false, reason: 'Base58Check checksum mismatch' };
    }
  }

  if (expectedPrefixBytes && expectedPrefixBytes.length > 0) {
    const firstByte = payload[0];
    if (!expectedPrefixBytes.includes(firstByte)) {
      return { valid: false, reason: `Invalid network version byte: 0x${firstByte.toString(16)}` };
    }
  }

  return { valid: true };
}

// ==========================================
// 3. Keccak-256 & EIP-55 Checksum Validation
// ==========================================

const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(n: bigint, shift: number): bigint {
  shift %= 64;
  return ((n << BigInt(shift)) | (n >> BigInt(64 - shift))) & 0xffffffffffffffffn;
}

export function keccak256Hex(ascii: string): string {
  const bytes = new TextEncoder().encode(ascii);
  const rate = 136; // 1088 bits / 8
  const state = Array.from({ length: 25 }, () => 0n);

  let offset = 0;
  while (offset + rate <= bytes.length) {
    for (let i = 0; i < rate / 8; i++) {
      let word = 0n;
      for (let j = 0; j < 8; j++) {
        word |= BigInt(bytes[offset + i * 8 + j]) << BigInt(8 * j);
      }
      state[i] ^= word;
    }
    keccakF1600(state);
    offset += rate;
  }

  // Padding: 0x01 ... 0x80 for Keccak
  const padded = new Uint8Array(rate);
  const remaining = bytes.length - offset;
  padded.set(bytes.subarray(offset), 0);
  padded[remaining] ^= 0x01;
  padded[rate - 1] ^= 0x80;

  for (let i = 0; i < rate / 8; i++) {
    let word = 0n;
    for (let j = 0; j < 8; j++) {
      word |= BigInt(padded[i * 8 + j]) << BigInt(8 * j);
    }
    state[i] ^= word;
  }
  keccakF1600(state);

  let hex = '';
  for (let i = 0; i < 4; i++) {
    let word = state[i];
    for (let j = 0; j < 8; j++) {
      const b = Number(word & 0xffn);
      hex += b.toString(16).padStart(2, '0');
      word >>= 8n;
    }
  }
  return hex;
}

function keccakF1600(s: bigint[]) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C: bigint[] = Array(5).fill(0n);
    for (let x = 0; x < 5; x++) {
      C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    const D: bigint[] = Array(5).fill(0n);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + y * 5] ^= D[x];
      }
    }

    // Rho & Pi
    const B: bigint[] = Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rotl64(s[x + y * 5], RHO[x][y]);
      }
    }

    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const notNext = B[((x + 1) % 5) + y * 5] ^ 0xFFFFFFFFFFFFFFFFn;
        s[x + y * 5] = B[x + y * 5] ^ (notNext & B[((x + 2) % 5) + y * 5]);
      }
    }

    // Iota
    s[0] ^= RC[round];
  }
}

/**
 * Validates EIP-55 mixed-case checksum for an Ethereum/EVM address
 */
export function verifyEIP55(address: string): {
  valid: boolean;
  hasChecksum: boolean;
  expectedChecksumAddress: string;
  reason?: string;
} {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return {
      valid: false,
      hasChecksum: false,
      expectedChecksumAddress: '',
      reason: 'Must be 0x followed by exactly 40 hexadecimal characters',
    };
  }

  const raw = address.slice(2).toLowerCase();
  const hash = keccak256Hex(raw);

  let expected = '0x';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (parseInt(hash[i], 16) >= 8) {
      expected += char.toUpperCase();
    } else {
      expected += char;
    }
  }

  const isAllLower = address === '0x' + raw;
  const isAllUpper = address === '0x' + raw.toUpperCase();

  if (isAllLower || isAllUpper) {
    // Address does not utilize EIP-55 capitalization
    return {
      valid: true,
      hasChecksum: false,
      expectedChecksumAddress: expected,
      reason: 'Valid hexadecimal format, but all lowercase/uppercase (no EIP-55 mixed case checksum encoded)',
    };
  }

  if (address === expected) {
    return {
      valid: true,
      hasChecksum: true,
      expectedChecksumAddress: expected,
      reason: 'Valid EIP-55 mixed-case cryptographic checksum verified',
    };
  }

  return {
    valid: false,
    hasChecksum: true,
    expectedChecksumAddress: expected,
    reason: 'Invalid EIP-55 checksum capitalization. Potential typo or altered address characters.',
  };
}

// ==========================================
// 4. Bech32 & Bech32m Polymod Validation
// ==========================================

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_MAP: Record<string, number> = {};
for (let i = 0; i < BECH32_CHARSET.length; i++) {
  BECH32_MAP[BECH32_CHARSET[i]] = i;
}

const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (let p = 0; p < values.length; ++p) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (let i = 0; i < 5; ++i) {
      if ((top >> i) & 1) {
        chk ^= GEN[i];
      }
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  let p: number;
  for (p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) >> 5);
  }
  ret.push(0);
  for (p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) & 31);
  }
  return ret;
}

export function verifyBech32(address: string, expectedHrp: string = 'bc'): {
  valid: boolean;
  version: 'bech32' | 'bech32m' | null;
  witnessVersion?: number;
  reason?: string;
} {
  const lower = address.toLowerCase();
  const upper = address.toUpperCase();
  if (address !== lower && address !== upper) {
    return { valid: false, version: null, reason: 'Mixed case is not allowed in Bech32 addresses' };
  }

  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) {
    return { valid: false, version: null, reason: 'Invalid Bech32 separator or length bounds' };
  }

  const hrp = lower.substring(0, pos);
  if (hrp !== expectedHrp) {
    return { valid: false, version: null, reason: `Unexpected human-readable prefix: ${hrp} (expected ${expectedHrp})` };
  }

  const data: number[] = [];
  for (let p = pos + 1; p < lower.length; ++p) {
    const d = BECH32_MAP[lower.charAt(p)];
    if (d === undefined) {
      return { valid: false, version: null, reason: `Invalid Bech32 character at position ${p}` };
    }
    data.push(d);
  }

  const polymod = bech32Polymod(bech32HrpExpand(hrp).concat(data));
  const witnessVersion = data[0];

  if (polymod === BECH32_CONST) {
    // Standard Bech32 (SegWit v0)
    if (witnessVersion === 0) {
      return { valid: true, version: 'bech32', witnessVersion: 0 };
    }
    return { valid: true, version: 'bech32', witnessVersion };
  } else if (polymod === BECH32M_CONST) {
    // Bech32m (Taproot v1+)
    if (witnessVersion >= 1 && witnessVersion <= 16) {
      return { valid: true, version: 'bech32m', witnessVersion };
    }
    return { valid: true, version: 'bech32m', witnessVersion };
  }

  return { valid: false, version: null, reason: 'Bech32 / Bech32m polymod checksum verification failed' };
}

// ==========================================
// 5. Solana Base58 & 32-Byte Ed25519 Check
// ==========================================

export function verifySolanaAddress(address: string): { valid: boolean; reason?: string } {
  if (address.length < 32 || address.length > 44) {
    return { valid: false, reason: 'Solana addresses must be 32 to 44 characters long' };
  }
  const decoded = decodeBase58(address);
  if (!decoded) {
    return { valid: false, reason: 'Contains characters outside the Base58 alphabet' };
  }
  if (decoded.length !== 32) {
    return { valid: false, reason: `Decoded public key length is ${decoded.length} bytes (must be exactly 32 bytes for Ed25519)` };
  }
  return { valid: true };
}

// ==========================================
// 6. XRP / Ripple Address Validation
// ==========================================

const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const RIPPLE_MAP: Record<string, number> = {};
for (let i = 0; i < RIPPLE_ALPHABET.length; i++) {
  RIPPLE_MAP[RIPPLE_ALPHABET[i]] = i;
}

export function decodeRippleBase58(input: string): Uint8Array | null {
  if (!input || typeof input !== 'string') return null;
  const bytes = [0];
  for (let i = 0; i < input.length; i++) {
    const value = RIPPLE_MAP[input[i]];
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; ++j) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === 'r'; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function verifyXrpAddress(address: string): { valid: boolean; reason?: string } {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) {
    return { valid: false, reason: 'XRP address must start with "r" and be 25-35 characters in Base58' };
  }
  const decoded = decodeRippleBase58(address);
  if (!decoded || decoded.length !== 25) {
    return { valid: false, reason: 'Decoded XRP address payload must be 25 bytes' };
  }
  // Checksum verify
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const hash = doubleSha256(payload);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== hash[i]) {
      return { valid: false, reason: 'XRP Base58 checksum mismatch' };
    }
  }
  return { valid: true };
}
