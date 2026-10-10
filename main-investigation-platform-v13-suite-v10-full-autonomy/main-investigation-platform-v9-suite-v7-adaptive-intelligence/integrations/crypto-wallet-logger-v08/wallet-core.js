/*
 * CryptoWalletLogger v0.9 — wallet-core.js ("Wallet Discovery v2")
 *
 * One dependency-free UMD module shared by:
 *   - the background service worker (importScripts),
 *   - the isolated-world content script,
 *   - the MAIN-world passive hook (page-hook.js captures it and removes the global again),
 *   - Node unit tests (`require("../wallet-core.js")`).
 *
 * Pure functions only: no DOM access, no network access, no timers.
 *
 * Detection is not validation. `formatCheck` is a quick pre-filter; Wallet Investigator validates authoritatively.
 */
(function umd(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && typeof module.exports === "object" && typeof window === "undefined" && typeof importScripts !== "function") {
    module.exports = api;
  } else if (root) {
    root.WalletCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function walletCoreFactory() {
  "use strict";

  const VERSION = "0.9.0";

  /* ------------------------------------------------------------------ */
  /* Canonical networks (V4_CONTRACT.md, "Canonical networks" table)     */
  /* ------------------------------------------------------------------ */

  const FAMILIES = ["evm", "tron", "bitcoin", "litecoin", "dogecoin", "solana", "xrp"];
  const FAMILY_NETWORKS = Object.freeze({
    evm: ["ethereum", "bsc", "polygon", "arbitrum", "optimism", "base", "avalanche"],
    tron: ["tron"],
    bitcoin: ["bitcoin"],
    litecoin: ["litecoin"],
    dogecoin: ["dogecoin"],
    solana: ["solana"],
    xrp: ["xrp"]
  });
  const NETWORK_FAMILY = Object.freeze(Object.fromEntries(Object.entries(FAMILY_NETWORKS).flatMap(([family, networks]) => networks.map(network => [network, family]))));
  const CHAIN_IDS = Object.freeze({ 1: "ethereum", 56: "bsc", 137: "polygon", 42161: "arbitrum", 10: "optimism", 8453: "base", 43114: "avalanche" });
  const CONTEXT_CLASSES = ["deposit", "withdrawal", "example", "transaction_history", "contract", "unrelated", "unknown"];
  const METHODS = ["text", "input", "attribute", "copy-control", "clipboard", "qr", "shadow-dom", "script-config", "network-response", "uri-link", "modal", "dynamic"];

  /* ------------------------------------------------------------------ */
  /* Byte helpers, SHA-256, Keccak-256                                   */
  /* ------------------------------------------------------------------ */

  const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  function utf8(value) {
    const text = String(value);
    if (textEncoder) return textEncoder.encode(text);
    const escaped = unescape(encodeURIComponent(text));
    return Uint8Array.from(escaped, char => char.charCodeAt(0));
  }
  function toHex(bytes) {
    let out = "";
    for (let index = 0; index < bytes.length; index += 1) out += (bytes[index] < 16 ? "0" : "") + bytes[index].toString(16);
    return out;
  }

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function sha256(input) {
    const bytes = typeof input === "string" ? utf8(input) : input;
    const length = bytes.length;
    const paddedLength = ((length + 9 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[length] = 0x80;
    const bitLengthHigh = Math.floor(length / 0x20000000);
    const bitLengthLow = (length << 3) >>> 0;
    padded[paddedLength - 8] = bitLengthHigh >>> 24; padded[paddedLength - 7] = bitLengthHigh >>> 16;
    padded[paddedLength - 6] = bitLengthHigh >>> 8; padded[paddedLength - 5] = bitLengthHigh;
    padded[paddedLength - 4] = bitLengthLow >>> 24; padded[paddedLength - 3] = bitLengthLow >>> 16;
    padded[paddedLength - 2] = bitLengthLow >>> 8; padded[paddedLength - 1] = bitLengthLow;
    const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let t = 0; t < 16; t += 1) {
        const p = offset + t * 4;
        w[t] = ((padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3]) >>> 0;
      }
      for (let t = 16; t < 64; t += 1) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let t = 0; t < 64; t += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + s1 + ch + SHA256_K[t] + w[t]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0; hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    for (let index = 0; index < 8; index += 1) {
      out[index * 4] = hash[index] >>> 24; out[index * 4 + 1] = hash[index] >>> 16;
      out[index * 4 + 2] = hash[index] >>> 8; out[index * 4 + 3] = hash[index];
    }
    return out;
  }
  const sha256Hex = input => toHex(sha256(input));

  // Keccak-f[1600] on 25 lanes stored as (hi, lo) 32-bit halves. Ethereum's Keccak-256 uses 0x01 domain padding.
  const KECCAK_RC = new Uint32Array([
    0x00000000, 0x00000001, 0x00000000, 0x00008082, 0x80000000, 0x0000808a, 0x80000000, 0x80008000,
    0x00000000, 0x0000808b, 0x00000000, 0x80000001, 0x80000000, 0x80008081, 0x80000000, 0x00008009,
    0x00000000, 0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a,
    0x00000000, 0x8000808b, 0x80000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003,
    0x80000000, 0x00008002, 0x80000000, 0x00000080, 0x00000000, 0x0000800a, 0x80000000, 0x8000000a,
    0x80000000, 0x80008081, 0x80000000, 0x00008080, 0x00000000, 0x80000001, 0x80000000, 0x80008008
  ]);
  const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

  function keccakF(sh, sl) {
    const bh = new Uint32Array(25);
    const bl = new Uint32Array(25);
    const ch = new Uint32Array(5);
    const cl = new Uint32Array(5);
    for (let round = 0; round < 24; round += 1) {
      for (let x = 0; x < 5; x += 1) {
        ch[x] = sh[x] ^ sh[x + 5] ^ sh[x + 10] ^ sh[x + 15] ^ sh[x + 20];
        cl[x] = sl[x] ^ sl[x + 5] ^ sl[x + 10] ^ sl[x + 15] ^ sl[x + 20];
      }
      for (let x = 0; x < 5; x += 1) {
        const nh = ch[(x + 1) % 5];
        const nl = cl[(x + 1) % 5];
        const dh = ch[(x + 4) % 5] ^ ((nh << 1) | (nl >>> 31));
        const dl = cl[(x + 4) % 5] ^ ((nl << 1) | (nh >>> 31));
        for (let y = 0; y < 25; y += 5) { sh[y + x] ^= dh; sl[y + x] ^= dl; }
      }
      for (let x = 0; x < 5; x += 1) {
        for (let y = 0; y < 5; y += 1) {
          const source = x + 5 * y;
          let hi = sh[source];
          let lo = sl[source];
          let rotation = KECCAK_ROT[source];
          if (rotation >= 32) { const swap = hi; hi = lo; lo = swap; rotation -= 32; }
          const target = y + 5 * ((2 * x + 3 * y) % 5);
          if (rotation) {
            bh[target] = (hi << rotation) | (lo >>> (32 - rotation));
            bl[target] = (lo << rotation) | (hi >>> (32 - rotation));
          } else { bh[target] = hi; bl[target] = lo; }
        }
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x += 1) {
          sh[y + x] = bh[y + x] ^ (~bh[y + ((x + 1) % 5)] & bh[y + ((x + 2) % 5)]);
          sl[y + x] = bl[y + x] ^ (~bl[y + ((x + 1) % 5)] & bl[y + ((x + 2) % 5)]);
        }
      }
      sh[0] ^= KECCAK_RC[2 * round];
      sl[0] ^= KECCAK_RC[2 * round + 1];
    }
  }

  function keccak256(input) {
    const bytes = typeof input === "string" ? utf8(input) : input;
    const rate = 136;
    const paddedLength = bytes.length + (rate - (bytes.length % rate));
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[paddedLength - 1] ^= 0x80;
    const sh = new Uint32Array(25);
    const sl = new Uint32Array(25);
    for (let offset = 0; offset < paddedLength; offset += rate) {
      for (let lane = 0; lane < rate / 8; lane += 1) {
        const p = offset + lane * 8;
        sl[lane] ^= padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
        sh[lane] ^= padded[p + 4] | (padded[p + 5] << 8) | (padded[p + 6] << 16) | (padded[p + 7] << 24);
      }
      keccakF(sh, sl);
    }
    const out = new Uint8Array(32);
    for (let lane = 0; lane < 4; lane += 1) {
      for (let byte = 0; byte < 4; byte += 1) {
        out[lane * 8 + byte] = (sl[lane] >>> (8 * byte)) & 0xff;
        out[lane * 8 + 4 + byte] = (sh[lane] >>> (8 * byte)) & 0xff;
      }
    }
    return out;
  }
  const keccak256Hex = input => toHex(keccak256(input));

  /* ------------------------------------------------------------------ */
  /* Address encodings                                                    */
  /* ------------------------------------------------------------------ */

  const BASE58_BITCOIN = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE58_RIPPLE = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
  const BASE58_MAPS = new Map();
  function base58Map(alphabet) {
    if (!BASE58_MAPS.has(alphabet)) {
      const map = new Int16Array(128).fill(-1);
      for (let index = 0; index < alphabet.length; index += 1) map[alphabet.charCodeAt(index)] = index;
      BASE58_MAPS.set(alphabet, map);
    }
    return BASE58_MAPS.get(alphabet);
  }

  function base58Decode(value, alphabet = BASE58_BITCOIN) {
    const text = String(value || "");
    if (!text || text.length > 120) return null;
    const map = base58Map(alphabet);
    const bytes = [0];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const digit = code < 128 ? map[code] : -1;
      if (digit < 0) return null;
      let carry = digit;
      for (let byte = 0; byte < bytes.length; byte += 1) {
        carry += bytes[byte] * 58;
        bytes[byte] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    let leadingZeros = 0;
    while (leadingZeros < text.length && text[leadingZeros] === alphabet[0]) leadingZeros += 1;
    while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
    const body = bytes.length === 1 && bytes[0] === 0 ? [] : bytes.reverse();
    const out = new Uint8Array(leadingZeros + body.length);
    out.set(body, leadingZeros);
    return out;
  }

  function base58Check(value, alphabet = BASE58_BITCOIN) {
    const decoded = base58Decode(value, alphabet);
    if (!decoded || decoded.length < 5) return null;
    const payload = decoded.slice(0, -4);
    const checksum = sha256(sha256(payload));
    const valid = checksum[0] === decoded[decoded.length - 4] && checksum[1] === decoded[decoded.length - 3] && checksum[2] === decoded[decoded.length - 2] && checksum[3] === decoded[decoded.length - 1];
    return { valid, version: payload[0], payload, length: decoded.length };
  }

  const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const BECH32_CONST = 1;
  const BECH32M_CONST = 0x2bc830a3;
  function bech32Polymod(values) {
    const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let checksum = 1;
    for (const value of values) {
      const top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ value;
      for (let index = 0; index < 5; index += 1) if ((top >>> index) & 1) checksum ^= generator[index];
    }
    return checksum >>> 0;
  }
  function bech32HrpExpand(hrp) {
    const out = [];
    for (let index = 0; index < hrp.length; index += 1) out.push(hrp.charCodeAt(index) >>> 5);
    out.push(0);
    for (let index = 0; index < hrp.length; index += 1) out.push(hrp.charCodeAt(index) & 31);
    return out;
  }
  function bech32Decode(value) {
    const text = String(value || "");
    if (text.length < 8 || text.length > 90) return null;
    if (text !== text.toLowerCase() && text !== text.toUpperCase()) return { error: "mixed-case" };
    const lower = text.toLowerCase();
    const separator = lower.lastIndexOf("1");
    if (separator < 1 || separator + 7 > lower.length) return null;
    const hrp = lower.slice(0, separator);
    const data = [];
    for (const char of lower.slice(separator + 1)) {
      const index = BECH32_CHARSET.indexOf(char);
      if (index < 0) return null;
      data.push(index);
    }
    const polymod = bech32Polymod(bech32HrpExpand(hrp).concat(data));
    const encoding = polymod === BECH32_CONST ? "bech32" : polymod === BECH32M_CONST ? "bech32m" : null;
    return { hrp, data: data.slice(0, -6), encoding };
  }
  function convertBits(data, fromBits, toBits, pad) {
    let accumulator = 0;
    let bits = 0;
    const out = [];
    const maxValue = (1 << toBits) - 1;
    for (const value of data) {
      if (value < 0 || value >> fromBits) return null;
      accumulator = (accumulator << fromBits) | value;
      bits += fromBits;
      while (bits >= toBits) { bits -= toBits; out.push((accumulator >> bits) & maxValue); }
    }
    if (pad) { if (bits) out.push((accumulator << (toBits - bits)) & maxValue); }
    else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue)) return null;
    return out;
  }
  /** Segwit address decode with BIP-173/BIP-350 witness rules. */
  function segwitDecode(value, expectedHrp) {
    const decoded = bech32Decode(value);
    if (!decoded || decoded.error) return { valid: false, reason: decoded?.error || "malformed" };
    if (expectedHrp && decoded.hrp !== expectedHrp) return { valid: false, reason: "hrp" };
    if (!decoded.encoding) return { valid: false, reason: "checksum", hrp: decoded.hrp };
    if (decoded.data.length < 1) return { valid: false, reason: "empty" };
    const version = decoded.data[0];
    if (version > 16) return { valid: false, reason: "witness-version" };
    const program = convertBits(decoded.data.slice(1), 5, 8, false);
    if (!program || program.length < 2 || program.length > 40) return { valid: false, reason: "program-length" };
    if (version === 0 && program.length !== 20 && program.length !== 32) return { valid: false, reason: "v0-program-length" };
    if (version === 0 && decoded.encoding !== "bech32") return { valid: false, reason: "v0-requires-bech32" };
    if (version !== 0 && decoded.encoding !== "bech32m") return { valid: false, reason: "v1+-requires-bech32m" };
    return { valid: true, hrp: decoded.hrp, version, program, encoding: decoded.encoding };
  }

  function eip55Checksum(address) {
    const lower = String(address).slice(2).toLowerCase();
    const hash = keccak256(utf8(lower));
    let out = "0x";
    for (let index = 0; index < 40; index += 1) {
      const char = lower[index];
      const nibble = (hash[index >> 1] >> (index % 2 === 0 ? 4 : 0)) & 0x0f;
      out += char >= "a" && char <= "f" && nibble >= 8 ? char.toUpperCase() : char;
    }
    return out;
  }
  function evmFormatCheck(address) {
    const body = address.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return "format_valid";
    return eip55Checksum(address) === address ? "checksum_valid" : "checksum_invalid";
  }

  /* ------------------------------------------------------------------ */
  /* Identification                                                       */
  /* ------------------------------------------------------------------ */

  const BASE58_VERSIONS = Object.freeze({ 0x00: "bitcoin", 0x05: "bitcoin", 0x30: "litecoin", 0x32: "litecoin", 0x1e: "dogecoin", 0x16: "dogecoin", 0x41: "tron" });

  function normalizeAddress(family, address) {
    const value = String(address || "").trim();
    if (family === "evm") return value.toLowerCase();
    if ((family === "bitcoin" || family === "litecoin") && /^(bc1|ltc1)/i.test(value)) return value.toLowerCase();
    return value;
  }

  function result(address, family, formatCheck, encoding) {
    const normalized = normalizeAddress(family, address);
    return { address, family, normalized, identity: `${family}:${normalized}`, formatCheck, encoding, candidateNetworks: [...FAMILY_NETWORKS[family]] };
  }

  /**
   * Identify one exact candidate string. Returns null when it is not a supported address.
   * opts.allowInvalidChecksum: keep well-formed bech32 strings whose checksum fails (formatCheck "checksum_invalid").
   */
  function identify(raw, opts = {}) {
    const address = String(raw || "").trim();
    if (address.length < 25 || address.length > 90) return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return result(address, "evm", evmFormatCheck(address), "eip55");
    const segwitPrefix = /^(bc1|ltc1)/i.exec(address);
    if (segwitPrefix) {
      const hrp = segwitPrefix[1].toLowerCase().slice(0, -1);
      const family = hrp === "bc" ? "bitcoin" : "litecoin";
      const decoded = segwitDecode(address, hrp);
      if (decoded.valid) return result(address, family, "checksum_valid", decoded.encoding);
      if (opts.allowInvalidChecksum && decoded.reason === "checksum") {
        const lower = address.toLowerCase();
        const plausible = hrp === "bc" ? [42, 62].includes(lower.length) : [43, 63].includes(lower.length);
        if (plausible) return result(address, family, "checksum_invalid", "bech32");
      }
      return null;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address) || address.length > 44) return null;
    if (address.length <= 35) {
      const check = base58Check(address, BASE58_BITCOIN);
      if (check?.valid && check.length === 25 && BASE58_VERSIONS[check.version] !== undefined) return result(address, BASE58_VERSIONS[check.version], "checksum_valid", "base58check");
      if (address[0] === "r") {
        const ripple = base58Check(address, BASE58_RIPPLE);
        if (ripple?.valid && ripple.length === 25 && ripple.version === 0x00) return result(address, "xrp", "checksum_valid", "base58check");
      }
    }
    if (address.length >= 32) {
      const decoded = base58Decode(address, BASE58_BITCOIN);
      if (decoded && decoded.length === 32) return result(address, "solana", "format_valid", "ed25519-length");
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Well-known addresses                                                 */
  /* ------------------------------------------------------------------ */

  // Major token contracts / mints. Identity -> { token, network }.
  const KNOWN_TOKEN_CONTRACTS = (() => {
    const list = [
      ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "ethereum"],
      ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", "ethereum"],
      ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", "ethereum"],
      ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", "ethereum"],
      ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC", "ethereum"],
      ["0x55d398326f99059fF775485246999027B3197955", "USDT", "bsc"],
      ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", "bsc"],
      ["0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", "BUSD", "bsc"],
      ["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", "bsc"],
      ["0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", "polygon"],
      ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", "polygon"],
      ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "USDC.e", "polygon"],
      ["0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", "arbitrum"],
      ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", "arbitrum"],
      ["0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "USDT", "optimism"],
      ["0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USDC", "optimism"],
      ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "base"],
      ["0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "USDT", "avalanche"],
      ["0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USDC", "avalanche"],
      ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "USDT", "tron"],
      ["TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", "USDC", "tron"],
      ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC", "solana"],
      ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT", "solana"],
      ["So11111111111111111111111111111111111111112", "wSOL", "solana"],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "SPL Token Program", "solana"]
    ];
    const map = new Map();
    for (const [address, token, network] of list) {
      const family = NETWORK_FAMILY[network];
      map.set(`${family}:${normalizeAddress(family, address)}`, { address, token, network });
    }
    return map;
  })();

  // Zero / burn / placeholder addresses are never a place to send funds: forced to "example".
  // Specification test vectors are only a cue (+example) because context should still win.
  const FORCED_EXAMPLES = new Map([
    ["evm:0x0000000000000000000000000000000000000000", "zero address"],
    ["evm:0x000000000000000000000000000000000000dead", "burn address"],
    ["evm:0xdead000000000000000042069420694206942069", "burn address"],
    ["evm:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "native-token placeholder address"],
    ["tron:T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", "zero address"],
    ["bitcoin:1111111111111111111114oLvT2", "burn address"],
    ["solana:11111111111111111111111111111111", "system program address"]
  ]);
  const KNOWN_EXAMPLES = new Map([
    ["evm:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "EIP-55 specification example"],
    ["evm:0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359", "EIP-55 specification example"],
    ["evm:0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb", "EIP-55 specification example"],
    ["evm:0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb", "EIP-55 specification example"],
    ["evm:0xab5801a7d398351b8be11c439e05c5b3259aec9b", "common documentation example"],
    ["bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "BIP-173 test vector"],
    ["bitcoin:bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "BIP-173 test vector"],
    ["bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "common documentation example"],
    ["bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "genesis block address (commonly used as an example)"]
  ]);
  function knownAddressInfo(identity) {
    if (KNOWN_TOKEN_CONTRACTS.has(identity)) return { kind: "token-contract", ...KNOWN_TOKEN_CONTRACTS.get(identity) };
    if (FORCED_EXAMPLES.has(identity)) return { kind: "forced-example", reason: FORCED_EXAMPLES.get(identity) };
    if (KNOWN_EXAMPLES.has(identity)) return { kind: "example", reason: KNOWN_EXAMPLES.get(identity) };
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Extraction from free text                                            */
  /* ------------------------------------------------------------------ */

  const EVM_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
  const SEGWIT_RE = /(?<![0-9A-Za-z])(?:bc1|BC1|ltc1|LTC1)[02-9ac-hj-np-zAC-HJ-NP-Z]{6,87}(?![0-9A-Za-z])/g;
  const BASE58_RE = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{25,44}(?![0-9A-Za-z])/g;
  const URI_RE = /(?<![A-Za-z0-9])(?:ethereum|bitcoin|litecoin|dogecoin|tron|solana|xrpl?|ripple):(?:\/\/)?(?:pay-)?[^\s"'<>`\\)]{20,400}/gi;
  const SOLANA_CONTEXT_RE = /\b(?:solana|sol|spl|phantom|solflare|lamports?|usdc|usdt|wallet|address|deposit|pay|payment|send|receive|recipient|fund|top ?up)\b/i;
  const SECRET_PREFIX_RE = /(?:signature|sig|txid|tx|txn|hash|blockhash|block|secret|private ?key|api ?key|apikey|token ?id|session|nonce|bearer|jwt|cid|ipfs|commit|sha|checksum|fingerprint|uuid|request ?id|order ?id)\s*(?:id|hash)?\s*[:=#]?\s*["'`]?\s*$/i;
  const ZERO_WIDTH_RE = /[​-‍⁠﻿­]/g;

  function cleanText(value, limit = 600) {
    return String(value || "").replace(ZERO_WIDTH_RE, "").replace(/[ \t\f\v\r]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, limit);
  }

  function plausibleSolana(candidate, source, index, opts) {
    if (KNOWN_TOKEN_CONTRACTS.has(`solana:${candidate}`) || FORCED_EXAMPLES.has(`solana:${candidate}`)) return true;
    if (!/\d/.test(candidate) || !/[A-Z]/.test(candidate) || !/[a-z]/.test(candidate)) return false;
    if (opts.trustSolana) return true;
    const before = source.slice(Math.max(0, index - 48), index);
    if (SECRET_PREFIX_RE.test(before)) return false;
    const windowText = `${source.slice(Math.max(0, index - 180), index)} ${source.slice(index + candidate.length, index + candidate.length + 180)} ${opts.context || ""}`;
    return SOLANA_CONTEXT_RE.test(windowText);
  }

  /**
   * Extract supported addresses from text.
   * Rejects tx hashes and hex substrings of longer hex runs (boundary-anchored regexes), base58 values that fail
   * checksums, and Solana-length base58 strings without wallet context.
   * Returns [{address, family, normalized, identity, formatCheck, encoding, candidateNetworks, index, end}].
   */
  function extractAddresses(text, opts = {}) {
    const source = String(text || "").replace(ZERO_WIDTH_RE, "");
    if (source.length < 25) return [];
    const limit = opts.limit || 400;
    const found = [];
    const spans = [];
    const overlaps = (start, end) => spans.some(([a, b]) => start < b && end > a);
    const add = (info, index) => {
      const end = index + info.address.length;
      if (overlaps(index, end)) return;
      spans.push([index, end]);
      found.push({ ...info, index, end });
    };
    for (const match of source.matchAll(EVM_RE)) {
      const info = identify(match[0]);
      if (info) add(info, match.index);
      if (found.length >= limit) break;
    }
    for (const match of source.matchAll(SEGWIT_RE)) {
      const info = identify(match[0], { allowInvalidChecksum: opts.allowInvalidChecksum !== false });
      if (info) add(info, match.index);
      if (found.length >= limit) break;
    }
    for (const match of source.matchAll(BASE58_RE)) {
      if (found.length >= limit) break;
      if (overlaps(match.index, match.index + match[0].length)) continue;
      const info = identify(match[0]);
      if (!info) continue;
      if (info.family === "solana" && !plausibleSolana(match[0], source, match.index, opts)) continue;
      add(info, match.index);
    }
    return found.sort((a, b) => a.index - b.index);
  }

  /* ------------------------------------------------------------------ */
  /* Payment URIs                                                         */
  /* ------------------------------------------------------------------ */

  const SCHEME_FAMILY = Object.freeze({ ethereum: "evm", bitcoin: "bitcoin", litecoin: "litecoin", dogecoin: "dogecoin", tron: "tron", solana: "solana", xrp: "xrp", xrpl: "xrp", ripple: "xrp" });

  function parseQuery(query) {
    const params = {};
    for (const pair of String(query || "").split("&")) {
      if (!pair) continue;
      const separator = pair.indexOf("=");
      const rawKey = separator < 0 ? pair : pair.slice(0, separator);
      const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
      let key = rawKey;
      let value = rawValue;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, " ")); } catch {}
      try { value = decodeURIComponent(rawValue.replace(/\+/g, " ")); } catch {}
      key = key.toLowerCase().slice(0, 64);
      if (!(key in params)) params[key] = value.slice(0, 512);
    }
    return params;
  }

  function tokenForContract(family, address) {
    const known = KNOWN_TOKEN_CONTRACTS.get(`${family}:${normalizeAddress(family, address)}`);
    return known ? known.token.replace(/\.e$/, "") : null;
  }

  /**
   * Parse ethereum: (EIP-681), bitcoin:, litecoin:, dogecoin:, tron:, solana: (Solana Pay), xrp:/ripple: URIs.
   * Returns {uri, scheme, address, family, info, chainId, network, token, amount, params, tokenContract} or null.
   */
  function parsePaymentUri(input) {
    const uri = String(input || "").trim().replace(ZERO_WIDTH_RE, "");
    const schemeMatch = /^([a-z]+):(.+)$/i.exec(uri);
    if (!schemeMatch) return null;
    const scheme = schemeMatch[1].toLowerCase();
    const family = SCHEME_FAMILY[scheme];
    if (!family) return null;
    let rest = schemeMatch[2].replace(/^\/\//, "");
    const queryIndex = rest.indexOf("?");
    const path = (queryIndex < 0 ? rest : rest.slice(0, queryIndex)).replace(/\/+$/, "");
    const params = parseQuery(queryIndex < 0 ? "" : rest.slice(queryIndex + 1));
    let address = path;
    let chainId = null;
    let network = family === "evm" ? null : FAMILY_NETWORKS[family][0];
    let token = null;
    let amount = params.amount || null;
    let tokenContract = null;
    if (family === "evm") {
      const parsed = /^(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(0x[0-9a-fA-F]+|\d+))?(?:\/([A-Za-z_][\w]*))?$/.exec(path);
      if (!parsed) return null;
      address = parsed[1];
      if (parsed[2]) {
        chainId = parsed[2].toLowerCase().startsWith("0x") ? parseInt(parsed[2], 16) : parseInt(parsed[2], 10);
        network = CHAIN_IDS[chainId] || null;
      }
      if (parsed[3] && parsed[3].toLowerCase() === "transfer" && params.address) {
        const recipient = identify(params.address);
        if (!recipient || recipient.family !== "evm") return null;
        tokenContract = parsed[1];
        token = tokenForContract("evm", tokenContract);
        address = recipient.address;
        amount = params.uint256 || params.amount || null;
      } else {
        amount = params.value || params.amount || null;
      }
    } else if (family === "solana") {
      if (params["spl-token"]) { tokenContract = params["spl-token"]; token = tokenForContract("solana", tokenContract); }
    } else if (family === "tron") {
      const contract = params.token || params.contract || params.contractaddress;
      if (contract && identify(contract)?.family === "tron") { tokenContract = contract; token = tokenForContract("tron", contract); }
      else if (contract && /^[A-Za-z]{2,10}$/.test(contract)) token = contract.toUpperCase();
    } else if (family === "xrp") {
      if (params.currency && /^[A-Za-z]{3,10}$/.test(params.currency)) token = params.currency.toUpperCase();
    }
    if (!token && params.token && /^[A-Za-z]{2,10}$/.test(params.token)) token = params.token.toUpperCase();
    const info = identify(address, { allowInvalidChecksum: true });
    if (!info || info.family !== family) return null;
    return { uri: uri.slice(0, 600), scheme, address: info.address, family, info, chainId, network, token, amount, params, tokenContract };
  }

  function extractPaymentUris(text) {
    const source = String(text || "").replace(ZERO_WIDTH_RE, "");
    const out = [];
    for (const match of source.matchAll(URI_RE)) {
      const parsed = parsePaymentUri(match[0].replace(/[.,;:!]+$/, ""));
      if (parsed) out.push({ ...parsed, index: match.index, end: match.index + match[0].length });
      if (out.length >= 100) break;
    }
    return out;
  }

  /** Addresses plus payment URIs; an address inside a URI carries `uri`. */
  function extractAll(text, opts = {}) {
    const source = String(text || "").replace(ZERO_WIDTH_RE, "");
    const uris = extractPaymentUris(source);
    const hits = extractAddresses(source, opts).map(hit => {
      const container = uris.find(uri => hit.index >= uri.index && hit.end <= uri.end) || null;
      if (!container) return { ...hit, uri: null };
      if (container.info.identity === hit.identity) return { ...hit, uri: container };
      // The token contract of an EIP-681 / Solana Pay / TRON URI is not the payment target.
      const contractIdentity = container.tokenContract ? identify(container.tokenContract)?.identity : null;
      return { ...hit, uri: null, uriTokenContract: contractIdentity === hit.identity ? container : null };
    });
    for (const uri of uris) {
      if (!hits.some(hit => hit.uri === uri)) hits.push({ ...uri.info, index: uri.index, end: uri.end, uri });
    }
    return hits.sort((a, b) => a.index - b.index);
  }

  /* ------------------------------------------------------------------ */
  /* Network hints                                                        */
  /* ------------------------------------------------------------------ */

  const NETWORK_TERMS = [
    { network: "tron", re: /\btrc[-_\s]?20\b|\btron\b|\btrx\b/i },
    { network: "ethereum", re: /\berc[-_\s]?20\b|\bethereum\b|\beth[-_\s]?mainnet\b/i },
    { network: "bsc", re: /\bbep[-_\s]?20\b|\bbsc\b|\bbnb[-_\s]?smart[-_\s]?chain\b|\bbinance[-_\s]?smart[-_\s]?chain\b|\bbnb[-_\s]?chain\b/i },
    { network: "polygon", re: /\bpolygon\b|\bmatic\b/i, exact: /^\s*pol\s*$/i },
    { network: "arbitrum", re: /\barbitrum(?:[-_\s]?one)?\b/i, exact: /^\s*arb(?:1)?\s*$/i },
    { network: "optimism", re: /\boptimism\b|\bop[-_\s]?mainnet\b/i, exact: /^\s*op\s*$/i },
    { network: "base", re: /\b(?:on|via) base\b|\bbase[-_\s]?(?:mainnet|network|chain)\b|\(base\)/i, exact: /^\s*base\b/i },
    { network: "avalanche", re: /\bavalanche\b|\bavax[-_\s]?c[-_\s]?chain\b|\bc[-_\s]chain\b|\bavaxc\b/i },
    { network: "solana", re: /\bspl\b|\bsolana\b/i, exact: /^\s*sol\s*$/i },
    { network: "bitcoin", re: /\bbitcoin\b|\bbtc\b/i },
    { network: "litecoin", re: /\blitecoin\b|\bltc\b/i },
    { network: "dogecoin", re: /\bdogecoin\b|\bdoge\b/i },
    { network: "xrp", re: /\bxrp\b|\bripple\b|\bxrpl\b/i }
  ];
  const TOKEN_TERMS = [
    ["USDT", /\busdt\b|\btether\b/i], ["USDC", /\busdc\b/i], ["BUSD", /\bbusd\b/i], ["DAI", /\bdai\b/i],
    ["ETH", /\beth\b|\bether\b/i], ["BTC", /\bbtc\b|\bbitcoin\b/i], ["BNB", /\bbnb\b/i], ["TRX", /\btrx\b/i],
    ["SOL", /\bsol\b/i], ["XRP", /\bxrp\b/i], ["LTC", /\bltc\b|\blitecoin\b/i], ["DOGE", /\bdoge\b|\bdogecoin\b/i],
    ["MATIC", /\bmatic\b/i], ["AVAX", /\bavax\b/i]
  ];

  /** Canonical networks mentioned in text. `exact` additionally accepts bare short labels (option/tab text). */
  function networksIn(text, exact = false) {
    const value = String(text || "");
    const out = new Set();
    if (!value) return out;
    for (const term of NETWORK_TERMS) if (term.re.test(value) || (exact && term.exact && term.exact.test(value))) out.add(term.network);
    // "BTC (BEP20)" / "BNB" style token words must not override explicit network words.
    if (out.size > 1 && /\b(?:erc|bep|trc)[-_\s]?20\b/i.test(value)) {
      for (const network of ["bitcoin", "litecoin", "dogecoin", "xrp"]) if (out.has(network) && !new RegExp(`\\b${network}\\b`, "i").test(value)) out.delete(network);
    }
    return out;
  }
  function tokensIn(text) {
    const value = String(text || "");
    const out = [];
    for (const [token, re] of TOKEN_TERMS) if (re.test(value)) out.push(token);
    return out;
  }
  function chooseToken(tokens, family) {
    const unique = [...new Set(tokens)];
    if (!unique.length) return null;
    const stable = unique.filter(token => ["USDT", "USDC", "BUSD", "DAI"].includes(token));
    if (stable.length === 1) return stable[0];
    if (stable.length > 1) return null;
    const native = { evm: null, tron: "TRX", bitcoin: "BTC", litecoin: "LTC", dogecoin: "DOGE", solana: "SOL", xrp: "XRP" }[family];
    if (unique.length === 1) return unique[0];
    return native && unique.includes(native) ? native : null;
  }

  /**
   * Network hint for an address. Inputs (all optional): {family, uri, qrUri, selected:[label], labels:[label], nearby:text}.
   * Returns {hint: {network, token, source} | null, mismatched: [network], ambiguous: [network]}.
   * Sources by priority: uri / qr-uri > selected-option > label > nearby-text. Never guesses between EVM networks.
   */
  function extractNetworkHint(input = {}) {
    const family = input.family;
    const allowed = FAMILY_NETWORKS[family] || [];
    const familyNetwork = family && family !== "evm" ? allowed[0] : null;
    const mismatched = new Set();
    const ambiguous = new Set();
    const allTokenText = [...(input.selected || []), ...(input.labels || []), input.nearby || ""].join("\n");
    const tokenGuess = () => chooseToken([...(input.selected || []).flatMap(tokensIn), ...(input.labels || []).flatMap(tokensIn)], family) || chooseToken(tokensIn(input.nearby || ""), family);

    for (const [key, source] of [["uri", "uri"], ["qrUri", "qr-uri"]]) {
      const uri = input[key];
      if (uri && uri.family === family) {
        const network = uri.network && allowed.includes(uri.network) ? uri.network : null;
        if (network || uri.token) return { hint: { network: network || familyNetwork, token: uri.token || tokenGuess(), source }, mismatched: [], ambiguous: [] };
      }
    }
    const levels = [["selected", "selected-option", true], ["labels", "label", true], ["nearby", "nearby-text", false]];
    for (const [key, source, exact] of levels) {
      const values = key === "nearby" ? [input.nearby || ""] : (input[key] || []);
      const found = new Set();
      for (const value of values) for (const network of networksIn(value, exact)) found.add(network);
      if (!found.size) continue;
      const consistent = [...found].filter(network => allowed.includes(network));
      for (const network of found) if (!allowed.includes(network)) mismatched.add(network);
      if (consistent.length === 1) return { hint: { network: consistent[0], token: tokenGuess(), source }, mismatched: [...mismatched], ambiguous: [] };
      if (consistent.length > 1) {
        for (const network of consistent) ambiguous.add(network);
        if (key !== "nearby") continue;
      }
    }
    const token = tokenGuess();
    if (familyNetwork && (token || networksIn(allTokenText).has(familyNetwork))) {
      const source = (input.selected || []).some(value => tokensIn(value).length || networksIn(value, true).size) ? "selected-option" : (input.labels || []).some(value => tokensIn(value).length || networksIn(value, true).size) ? "label" : "nearby-text";
      return { hint: { network: familyNetwork, token, source }, mismatched: [...mismatched], ambiguous: [...ambiguous] };
    }
    if (family === "evm" && token && !ambiguous.size) {
      const source = (input.selected || []).some(value => tokensIn(value).length) ? "selected-option" : (input.labels || []).some(value => tokensIn(value).length) ? "label" : "nearby-text";
      return { hint: { network: null, token, source }, mismatched: [...mismatched], ambiguous: [] };
    }
    return { hint: null, mismatched: [...mismatched], ambiguous: [...ambiguous] };
  }

  /* ------------------------------------------------------------------ */
  /* Context classification                                               */
  /* ------------------------------------------------------------------ */

  // Zones, nearest first. "near" is the address's own line / smallest text block (content.js passes it; otherwise it is
  // derived from `local`). label + near are the evidence that describes THIS address; heading/local/section describe
  // the surroundings and are shared with every other address in the same card/section.
  const ZONES = { heading: 1.2, label: 1.3, near: 1.0, local: 1.0, section: 0.45 };
  const ZONE_SUFFIX = { heading: " (heading)", label: " (label)", near: "", local: "", section: " (section)" };
  const NEAR_ZONES = ["label", "near"];

  // [class, regex, cue, weight, excludeRegex, {zones, flag}]  — zones restricts where a rule may match (default: all);
  // flag requires that structural flag (e.g. "editable": only for an input the visitor can type into).
  const TEXT_RULES = [
    ["deposit", /\bdeposit(?:s|ed|ing)?\b/, "deposit", 2.5],
    ["deposit", /\bdeposit (?:wallet )?address\b|\baddress (?:for|to) deposit\b/, "deposit address label", 1.5],
    ["deposit", /\bre-?charge\b|\btop[\s-]?up\b/, "recharge/top up", 2.5],
    ["deposit", /\bfund (?:your |the )?(?:account|wallet|balance)\b|\badd funds\b|\bfunding address\b/, "fund your account", 2.5],
    ["deposit", /\b(?:send|transfer|deposit) only\b|\bonly (?:send|transfer|deposit)\b/, "send only X to this address", 3],
    ["deposit", /\bmin(?:imum|\.)? (?:deposit|payment|amount)\b/, "minimum deposit", 2],
    ["deposit", /\b(?:send|transfer|pay)\b[^.\n]{0,60}?\bto (?:this|the following|the above|the below|our|the|this wallet) (?:address|wallet)\b/, "send to this address", 3],
    ["deposit", /\bpay(?:ment)? (?:to|address)\b|\bamount due\b|\bscan (?:to pay|the qr|this qr|qr code)\b|\bcomplete (?:your )?payment\b|\binvoice\b|\bcheckout\b|\breceiv(?:e|ing) (?:a )?payments?\b|\baccept(?:ing)? payments?\b/, "payment instruction", 2.5],
    ["deposit", /\b(?:send|transfer|pay)\b[^.\n]{0,40}?\bto\s*[:：]?\s*$/, "send … to (address follows)", 2.5, null, { zones: NEAR_ZONES, notFlag: "editable" }],
    ["deposit", /\breceiv(?:e|ing) address\b/, "receiving address", 1],
    ["deposit", /\bdonat(?:e|ion|ions)\b/, "donation", 1.5],
    ["deposit", /\bwill be credited\b|\bcredited (?:to|after)\b|\bconfirmations? (?:required|needed)\b/, "crediting notice", 1.2],
    ["withdrawal", /\bwithdraw(?:al|als|ing|n|s)?\b/, "withdraw", 3],
    ["withdrawal", /\b(?:your|my) (?:own |personal |external )?(?:[a-z0-9]+ ){0,2}?(?:wallet )?address\b/, "your wallet address", 2.5, /deposit|recharge|top ?up|pay|receiv|fund|\bour /],
    ["withdrawal", /\b(?:payout|pay[\s-]out|cash[\s-]?out|redeem|redemption|refund)\b/, "payout/refund", 2],
    ["withdrawal", /\b(?:enter|paste|input|type|provide|add) (?:your |a |the |an )?(?:[a-z0-9]+ ){0,2}?address\b/, "enter address", 2.5],
    ["withdrawal", /\bamount to withdraw\b|\bwithdraw(?:al)? (?:amount|fee)\b/, "withdraw amount", 1.5],
    ["withdrawal", /\bsaved address(?:es)?\b|\bwhitelist(?:ed)?\b|\baddress book\b|\blinked wallet\b|\bmy addresses\b|\bdestination address\b|\bbeneficiary\b/, "saved user address", 2],
    ["withdrawal", /\b(?:recipient|receiver|destination|send to|withdraw to|payee)\b|^\W*to\W*$/, "recipient field", 2.5, null, { zones: NEAR_ZONES, flag: "editable" }],
    ["example", /\be\.g\.|\beg:|\bexample\b|\bfor example\b/, "example label", 3],
    ["example", /\bsample\b|\bdemo\b|\bdummy\b|\btest(?:net)? address\b|\bmock(?:-?up)?\b|\bplaceholder\b|\bscreenshot\b|\billustration\b/, "sample/demo", 2.5],
    ["example", /\bsuch as\b|\bfor instance\b|\blooks? like\b/, "such as/looks like", 3],
    ["example", /\bformat(?:ted)?(?: like)?\b|\bvalid address(?:es)? (?:start|begin)\b|\b(?:addresses|address) (?:start|begin)s? with\b/, "address format", 2],
    ["example", /\b(?:documentation|api reference|request body|response body|curl|parameters?|endpoint|tutorial|readme)\b/, "documentation wording", 1],
    ["transaction_history", /\btx(?:id|n| ?hash|s)?\b|\btransaction (?:hash|id)\b|\bhash\b/, "tx hash label", 1.5],
    ["transaction_history", /^\W*(?:tx ?id|txn? ?hash|tx|transaction (?:hash|id)|hash)\b/, "transaction id label", 3.5, null, { zones: NEAR_ZONES }],
    ["transaction_history", /\b(?:transaction|transfer|payment|deposit|withdrawal|recharge|order) (?:history|records?|logs?)\b|\brecent (?:transactions|activity|deposits|withdrawals|transfers)\b|\btransactions\b|\bhistory\b/, "history heading", 2.5],
    ["transaction_history", /\bconfirmations?\b|\b(?:completed|confirmed|pending|successful|failed|expired)\b/, "tx status", 1],
    ["transaction_history", /\bblock(?: height)?\b|\btimestamp\b|\bgas\b/, "block/fee", 0.8],
    ["transaction_history", /\b(?:19|20)\d\d[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b|\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d\d\b|\b\d+ (?:secs?|mins?|minutes?|hours?|hrs?|days?|weeks?|months?) ago\b/, "dated entry", 1.5],
    ["contract", /\b(?:token |smart |erc-?20 |bep-?20 |trc-?20 |staking |pool |vault )?contract(?: address)?\b/, "contract address label", 3.5],
    ["contract", /\btoken (?:address|mint|id)\b|\bmint address\b|\btoken mint\b/, "token address label", 3.5],
    ["contract", /(?:^|[\s(|·])ca\s*[:：]/, "CA: (contract address)", 3.5, null, { zones: NEAR_ZONES }],
    ["contract", /\bliquidity pool\b|\b(?:pool|pair|lp|router) address\b|\blp token\b/, "pool/pair address", 3],
    ["contract", /\bdecimals\b|\btotal supply\b|\btoken (?:name|symbol)\b|\bholders\b|\bmarket cap\b|\btokenomics\b/, "token metadata", 1.5],
    ["contract", /\bbuy (?:on|via) (?:uniswap|pancakeswap|sushiswap|raydium|jupiter|sunswap|dex)\b|\b(?:dexscreener|dextools|add to metamask|import token)\b/, "DEX / token listing", 2],
    ["unrelated", /\b(?:blog|news|press release|article|posted (?:on|by)|published|read more|newsletter|all rights reserved|privacy policy|terms of (?:use|service)|cookie)\b|©/, "blog/news/footer wording", 1.2],
    ["unrelated", /\breport(?:ed|ing|s)?\b[^.\n]{0,24}\b(?:scam|fraud|address|wallet)|\b(?:scam|scammer|fraud(?:ulent)?|phishing|blacklisted|flagged|sanctioned|stolen funds?)\b[^.\n]{0,12}\b(?:address|wallet|reports?)\b/, "reported/scam address", 3],
    ["unrelated", /\b(?:partners?|sponsors?|affiliates?|team|marketing|treasury|dev(?:eloper)?|founders?|vesting|reserve|cold|hot|multi-?sig|owner|deployer|creator|ecosystem|burn)(?:'s)? (?:wallets?|address(?:es)?|account)\b|\bofficial partners?\b|\bproof of reserves?\b|\b(?:referr(?:er|al)|inviter|upline|ambassador|agent|promoter)(?:'s)? (?:wallets?|address(?:es)?|account|id)\b/, "partner/team/referrer wallet", 3]
  ];

  // [flag, class, cue, weight, near] — near: the flag is about the address itself (not its surroundings).
  const STRUCTURE_RULES = [
    ["qrMatch", "deposit", "QR next to address", 3, true],
    ["qrNearby", "deposit", "QR code in section", 1.5, false],
    ["copyControl", "deposit", "copy button next to address", 2, true],
    ["networkSelector", "deposit", "network selector", 1.2, false],
    ["readonly", "deposit", "read-only address field", 1, true],
    ["uriLink", "deposit", "payment URI", 2.5, true],
    ["uriTokenContract", "contract", "token contract in payment URI", 4, true],
    ["depositContainer", "deposit", "deposit/payment container", 1.5, false],
    ["userTyped", "withdrawal", "address typed by the user", 3.5, true],
    ["editable", "withdrawal", "editable address input", 1.5, true],
    ["amountField", "withdrawal", "amount field", 0.8, false],
    ["withdrawContainer", "withdrawal", "withdrawal container", 1.5, false],
    ["placeholder", "example", "placeholder", 6, true],
    ["inCode", "example", "code/pre block", 1.5, true],
    ["docs", "example", "documentation page", 2, false],
    ["exampleFigure", "example", "screenshot/figure", 2, true],
    ["txTable", "transaction_history", "transaction table", 3.5, true],
    ["inTable", "transaction_history", "table cell", 0.8, false],
    ["txLink", "transaction_history", "explorer /tx/ link", 3, true],
    ["datedRow", "transaction_history", "dated list row", 3, true],
    ["tokenLink", "contract", "explorer /token/ link", 3.5, true],
    ["footer", "unrelated", "footer", 3, true],
    ["nav", "unrelated", "navigation", 2, true],
    ["blog", "unrelated", "blog/news section", 2, false]
  ];

  function splitKeyWords(key) {
    return String(key || "")
      .replace(/\[\d*\]/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/[_\-.$:/]+/g, " ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  const KEY_RULES = {
    deposit: /\b(?:deposit|pay|payment|payto|receive|receiving|recipient|top ?up|recharge|fund|funding|invoice|checkout|merchant|donate|donation)\b/,
    withdrawal: /\b(?:withdraw|withdrawal|withdrawals|payout|refund|saved|whitelist|destination|beneficiary|external)\b/,
    userOwned: /\b(?:user|account|profile|me|my|own|customer)\b/,
    contract: /\b(?:contract|token address|token|mint|erc20|bep20|trc20|spl)\b/,
    txLast: /^(?:from|to|sender|receiver|counterparty|tx|txid|tx hash|hash|transaction hash|from address|to address)$/,
    txAncestor: /\b(?:transactions?|history|txs|transfers?|trades|orders|activity|ledger|logs?)\b/,
    example: /\b(?:example|examples|sample|demo|placeholder|dummy|mock|test)\b/,
    unrelated: /\b(?:partners?|sponsors?|affiliates?|referrals?|team|treasury|reports?|reported|scams?|blacklist|blocklist|explorer)\b/,
    generic: /\b(?:wallet|address|addr)\b/
  };

  function keyPathRules(keyPath) {
    const hits = [];
    if (!keyPath) return hits;
    const segments = String(keyPath).split(/\.|\[\d*\]/).filter(Boolean);
    const last = splitKeyWords(segments[segments.length - 1] || "");
    const ancestors = splitKeyWords(segments.slice(0, -1).join(" "));
    const lastName = segments[segments.length - 1] || "";
    const cue = text => `key path: ${text}`;
    let specific = false;
    if (KEY_RULES.deposit.test(last)) { hits.push(["deposit", cue(lastName), 3.5]); specific = true; }
    if (KEY_RULES.withdrawal.test(last)) { hits.push(["withdrawal", cue(lastName), 4]); specific = true; }
    if (KEY_RULES.contract.test(last)) { hits.push(["contract", cue(lastName), 4.5]); specific = true; }
    if (KEY_RULES.txLast.test(last)) { hits.push(["transaction_history", cue(lastName), 3]); specific = true; }
    if (KEY_RULES.example.test(last)) { hits.push(["example", cue(lastName), 3.5]); specific = true; }
    if (KEY_RULES.userOwned.test(last) && !KEY_RULES.deposit.test(last)) { hits.push(["withdrawal", cue(lastName), 2.5]); specific = true; }
    if (ancestors) {
      if (KEY_RULES.deposit.test(ancestors)) hits.push(["deposit", `key path ancestor: ${ancestors}`, 1.8]);
      if (KEY_RULES.withdrawal.test(ancestors)) hits.push(["withdrawal", `key path ancestor: ${ancestors}`, 2]);
      if (KEY_RULES.userOwned.test(ancestors) && !KEY_RULES.deposit.test(ancestors)) hits.push(["withdrawal", `user-owned key path: ${ancestors}`, 2]);
      if (/\b(?:token|tokens|contract|contracts|mint|asset|assets)\b/.test(ancestors) && !KEY_RULES.deposit.test(last)) hits.push(["contract", `key path ancestor: ${ancestors}`, 2.5]);
      if (KEY_RULES.txAncestor.test(ancestors)) hits.push(["transaction_history", `key path ancestor: ${ancestors}`, 3]);
      if (KEY_RULES.example.test(ancestors)) hits.push(["example", `key path ancestor: ${ancestors}`, 2.5]);
      if (KEY_RULES.unrelated.test(ancestors) && !KEY_RULES.deposit.test(last)) hits.push(["unrelated", `key path ancestor: ${ancestors}`, 3]);
    }
    const userOwnedAncestor = Boolean(ancestors) && KEY_RULES.userOwned.test(ancestors) && !KEY_RULES.deposit.test(ancestors);
    if (!specific && !userOwnedAncestor && KEY_RULES.generic.test(last)) hits.push(["deposit", `wallet/address key: ${lastName}`, 2.2]);
    return hits;
  }

  function lower(value) { return String(value || "").toLowerCase().replace(/\s+/g, " "); }
  function round2(value) { return Math.round(value * 100) / 100; }

  function snippetAround(text, address, limit = 600) {
    const value = cleanText(text, 20000);
    if (value.length <= limit) return value;
    const index = address ? value.indexOf(address) : -1;
    if (index < 0) return value.slice(0, limit);
    const start = Math.max(0, Math.min(value.length - limit, index - Math.floor((limit - address.length) / 2)));
    return value.slice(start, start + limit);
  }

  // The address's own line in `local` (plus the preceding line when the address line carries no words): used as the
  // "near" zone when the caller did not pass one.
  function nearLine(local, address) {
    const text = String(local || "");
    if (!text) return "";
    const index = address ? text.toLowerCase().indexOf(address.toLowerCase()) : -1;
    if (index < 0) return "";
    const start = text.lastIndexOf("\n", index - 1) + 1;
    const endBreak = text.indexOf("\n", index + address.length);
    const line = text.slice(start, endBreak < 0 ? text.length : endBreak);
    const words = line.split(address).join(" ").replace(/[^A-Za-z]+/g, "");
    if (words.length >= 4 || start === 0) return line;
    const previousStart = text.lastIndexOf("\n", start - 2) + 1;
    return text.slice(previousStart, endBreak < 0 ? text.length : endBreak);
  }

  // Non-deposit classes whose evidence close to the address outweighs weak/ambient deposit evidence.
  const NEAR_DOMINANCE_MIN = 3;

  /**
   * Classify the context in which an address was exposed.
   * input: {address, family, identity, formatCheck, method, heading, label, near, local, section, keyPath, flags:{...}}
   *   heading  — nearest heading / tab / modal title
   *   label    — field label, aria-label, title, attribute name, column header, figure caption, JSON sibling text
   *   near     — the smallest text block around the address (derived from `local` when absent)
   *   local    — text immediately around the address
   *   section  — text of the enclosing section (weak evidence)
   *   flags    — structural booleans (see STRUCTURE_RULES) plus hidden, modal, soleAddress (no other address in the section)
   * Decision (generic, in order):
   *   1. known token contracts / zero-burn addresses are forced;
   *   2. scores = Σ text rules (best zone each) + key-path rules + structural flags;
   *      near = the part of those scores that describes the address itself (label/near zones, address-level flags, key path);
   *   3. if deposit ranks first it must survive: placeholder → example, typed by the visitor → withdrawal,
   *      a failing checksum → unknown (wallets refuse it), a non-deposit class with near evidence ≥ 3 that is at least
   *      as strong as the near deposit evidence wins (a "Contract:"/"TxID"/"e.g."/"Withdrawal address" label beats a
   *      deposit heading, QR or network selector shared with the whole card), documentation/code context with example
   *      evidence wins unless a QR/payment URI encodes the address, and deposit evidence that is only ambient
   *      (section text, container class, selector, QR elsewhere — nothing in heading/label/near/local/key path, and the section also shows other
   *      addresses) → unknown.
   * Returns {class, confidence, cues, negativeCues, section, snippet, scores}.
   */
  function classifyContext(input = {}) {
    const flags = input.flags || {};
    const address = String(input.address || "");
    const identified = address ? identify(address, { allowInvalidChecksum: true }) : null;
    const identity = input.identity || identified?.identity || null;
    const formatCheck = input.formatCheck || identified?.formatCheck || null;
    const scores = Object.fromEntries(CONTEXT_CLASSES.map(name => [name, 0]));
    const near = Object.fromEntries(CONTEXT_CLASSES.map(name => [name, 0]));
    const cueMap = Object.fromEntries(CONTEXT_CLASSES.map(name => [name, []]));
    let anchorDeposit = 0; // deposit wording in the heading or the address's own container (not just the section)
    let sectionDeposit = 0;
    const add = (name, cue, weight, nearWeight = 0) => {
      if (!weight) return;
      scores[name] += weight;
      near[name] += nearWeight;
      if (!cueMap[name].includes(cue)) cueMap[name].push(cue);
    };
    const strip = value => {
      let text = lower(value);
      if (address) text = text.split(address.toLowerCase()).join(" ");
      return text;
    };
    const nearSource = input.near != null && input.near !== "" ? input.near : nearLine(cleanText(input.local, 2000), address);
    const zones = { heading: strip(input.heading), label: strip(input.label), near: strip(nearSource).trim(), local: strip(input.local), section: strip(input.section) };
    for (const [name, regex, cue, weight, exclude, opts] of TEXT_RULES) {
      if (opts?.flag && !flags[opts.flag]) continue;
      if (opts?.notFlag && flags[opts.notFlag]) continue;
      let best = 0;
      let bestZone = null;
      let bestNear = 0;
      for (const zone of opts?.zones || Object.keys(ZONES)) {
        const text = zones[zone];
        if (!text) continue;
        const match = regex.exec(text);
        if (!match || (exclude && exclude.test(match[0]))) continue;
        if (ZONES[zone] > best) { best = ZONES[zone]; bestZone = zone; }
        if (NEAR_ZONES.includes(zone) && ZONES[zone] > bestNear) bestNear = ZONES[zone];
        if ((zone === "heading" || zone === "local") && name === "deposit") anchorDeposit = Math.max(anchorDeposit, weight);
        if (zone === "section" && name === "deposit") sectionDeposit = Math.max(sectionDeposit, weight);
      }
      if (best) add(name, cue + ZONE_SUFFIX[bestZone], weight * best, weight * bestNear);
    }
    for (const [name, cue, weight] of keyPathRules(input.keyPath)) add(name, cue, weight, weight);
    for (const [flag, name, cue, weight, isNear] of STRUCTURE_RULES) if (flags[flag]) add(name, cue, weight, isNear ? weight : 0);
    if (flags.userTyped) { scores.withdrawal -= 1.5; near.withdrawal -= 1.5; cueMap.withdrawal = cueMap.withdrawal.filter(cue => cue !== "editable address input"); }

    const known = identity ? knownAddressInfo(identity) : null;
    if (known?.kind === "example") add("example", `well-known example address (${known.reason})`, 2.5, 2.5);

    const neutral = [];
    if (flags.modal) neutral.push("modal");
    if (flags.dynamic) neutral.push("inserted after load");
    if (flags.shadow) neutral.push("shadow DOM");
    if (flags.addressLink) neutral.push("explorer /address/ link");

    let chosen;
    let confidence;
    let forced = false;
    const extraCues = [];
    if (known?.kind === "token-contract") {
      chosen = "contract"; confidence = 0.95; forced = true;
      add("contract", `known ${known.token} token contract (${known.network})`, 10, 10);
    } else if (known?.kind === "forced-example") {
      chosen = "example"; confidence = 0.95; forced = true;
      add("example", `well-known ${known.reason}`, 10, 10);
    } else {
      const ranked = CONTEXT_CLASSES.filter(name => name !== "unknown").sort((a, b) => scores[b] - scores[a]);
      chosen = ranked[0];
      if (chosen !== "deposit") {
        // Same proximity rule between the non-deposit classes: what is said about this address beats its surroundings.
        const closer = ranked.filter(name => name !== "deposit" && name !== chosen && near[name] >= NEAR_DOMINANCE_MIN && near[name] > near[chosen]).sort((a, b) => near[b] - near[a]);
        if (closer.length) chosen = closer[0];
      }
      if (chosen === "deposit") {
        const others = CONTEXT_CLASSES.filter(name => name !== "deposit" && name !== "unknown");
        // (a) a specific non-deposit description of this very address beats deposit evidence that is not as close.
        const dominant = others.filter(name => near[name] >= NEAR_DOMINANCE_MIN && near[name] > near.deposit).sort((a, b) => near[b] - near[a] || scores[b] - scores[a]);
        // (b) totals close to each other: the non-deposit class wins when it has evidence about the address itself
        //     or deposit has none (the previous guards, now proximity-aware).
        const guards = [["example", 3, 2], ["contract", 3.5, 2], ["withdrawal", 3, 2], ["transaction_history", 3, 1.5]];
        const blocking = guards.filter(([name, min, margin]) => scores[name] >= min && scores.deposit - scores[name] < margin && (near[name] > 0 || near.deposit <= 0)).sort((a, b) => scores[b[0]] - scores[a[0]]);
        const hardDeposit = Boolean(flags.qrMatch || flags.uriLink);
        if (dominant.length) { chosen = dominant[0]; extraCues.push("specific label/text next to the address outweighs surrounding deposit cues"); }
        else if (blocking.length) chosen = blocking[0][0];
        else if ((flags.docs || flags.inCode || flags.exampleFigure) && scores.example >= 3 && !hardDeposit) chosen = "example";
        if (flags.placeholder) chosen = "example";
        else if (flags.userTyped) chosen = "withdrawal";
        if (chosen === "deposit" && scores.deposit >= 2 && near.deposit <= 0 && anchorDeposit <= 0 && !(flags.soleAddress && sectionDeposit > 0)) { chosen = "unknown"; extraCues.push("deposit cues only in the surrounding section"); }
        if (chosen === "deposit" && formatCheck === "checksum_invalid") { chosen = "unknown"; extraCues.push("address checksum fails (malformed)"); }
      }
      if (chosen !== "unknown" && scores[chosen] < 2) chosen = "unknown";
      const others = CONTEXT_CLASSES.filter(name => name !== chosen && name !== "unknown").map(name => scores[name]);
      const second = Math.max(0, ...others);
      if (chosen === "unknown") confidence = Math.min(0.35, 0.2 + 0.05 * Math.max(0, ...CONTEXT_CLASSES.map(name => scores[name])));
      else confidence = Math.max(0.3, Math.min(0.95, 0.35 + 0.06 * scores[chosen] + 0.05 * Math.min(4, Math.max(0, scores[chosen] - second))));
      // Calibration: a deposit call resting on weak near evidence is less certain.
      if (chosen === "deposit" && near.deposit < 2) confidence = Math.min(confidence, 0.6);
    }
    const cues = [...cueMap[chosen] || [], ...extraCues, ...neutral];
    if (flags.hidden) { cues.push("hidden-panel"); if (!forced) confidence *= 0.75; }
    if (!forced && (input.method === "network-response" || input.method === "script-config")) confidence *= 0.9;
    const negativeCues = [];
    for (const name of CONTEXT_CLASSES) if (name !== chosen && name !== "unknown" && scores[name] > 0) negativeCues.push(...cueMap[name]);
    return {
      class: chosen,
      confidence: round2(Math.max(0.05, Math.min(0.97, confidence))),
      cues: [...new Set(cues)].slice(0, 16),
      negativeCues: [...new Set(negativeCues)].slice(0, 16),
      section: cleanText(input.sectionTitle || input.heading || "", 160),
      snippet: snippetAround(input.snippet || [input.local, input.section].filter(Boolean).join("\n"), address),
      scores: Object.fromEntries(Object.entries(scores).map(([name, value]) => [name, round2(value)]))
    };
  }

  /** Rank used to pick the best observation of one wallet within one page view. */
  function contextRank(context) {
    if (!context) return -1;
    const penalty = { unknown: 0.45, unrelated: 0.2 }[context.class] || 0;
    const bonus = context.class === "deposit" ? 0.1 : 0;
    return Number(context.confidence || 0) + bonus - penalty;
  }

  /* ------------------------------------------------------------------ */
  /* Structured data (inline JSON, script config, network responses)      */
  /* ------------------------------------------------------------------ */

  const HINT_KEY_RE = /^(?:network|networks|chain|chainid|chain_id|chainname|chain_name|blockchain|protocol|coin|currency|token|symbol|asset|standard|type|net|network_name|networkname)$/i;

  function siblingHintText(parent) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) return "";
    const parts = [];
    let keys;
    try { keys = Object.keys(parent).slice(0, 60); } catch { return ""; }
    for (const key of keys) {
      if (!HINT_KEY_RE.test(key)) continue;
      let value;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (!descriptor || !("value" in descriptor)) continue;
        value = descriptor.value;
      } catch { continue; }
      if (typeof value === "number" && /chain/i.test(key) && CHAIN_IDS[value]) parts.push(`${key}: ${CHAIN_IDS[value]}`);
      else if (typeof value === "string" && value.length <= 48) parts.push(`${key}: ${/chain/i.test(key) && CHAIN_IDS[parseInt(value, value.startsWith("0x") ? 16 : 10)] ? CHAIN_IDS[parseInt(value, value.startsWith("0x") ? 16 : 10)] : value}`);
    }
    return parts.join(" ").slice(0, 300);
  }

  /**
   * Walk a JSON-like value (read-only: data properties only, getters are never invoked) and report addresses with their key path.
   * Returns [{address, family, normalized, identity, formatCheck, candidateNetworks, keyPath, hintText, snippet, uri}].
   */
  function scanJson(value, opts = {}) {
    const maxNodes = opts.maxNodes || 25000;
    const maxDepth = opts.maxDepth || 14;
    const maxFindings = opts.maxFindings || 200;
    const isNode = typeof opts.isForeignObject === "function" ? opts.isForeignObject : () => false;
    const findings = [];
    const seen = new WeakSet();
    let nodes = 0;
    const visit = (node, path, parent, depth) => {
      if (nodes >= maxNodes || findings.length >= maxFindings || depth > maxDepth) return;
      nodes += 1;
      if (/password|passwd|secret|credential|authorization|session|cookie|username|e.?mail|verification.?code|otp|private.?key|seed.?phrase|access.?token|auth.?token/i.test(path)) return;
      if (typeof node === "string") {
        if (node.length < 25 || node.length > 8192) return;
        for (const hit of extractAll(node, { context: splitKeyWords(path) })) {
          findings.push({ ...hit, keyPath: path.slice(0, 300), hintText: siblingHintText(parent), snippet: cleanText(`${path}: ${node.length > 260 ? snippetAround(node, hit.address, 260) : node} ${siblingHintText(parent)}`, 600) });
          if (findings.length >= maxFindings) return;
        }
        return;
      }
      if (!node || typeof node !== "object") return;
      try { if (isNode(node) || seen.has(node)) return; seen.add(node); } catch { return; }
      if (Array.isArray(node)) {
        const length = Math.min(node.length, 2000);
        for (let index = 0; index < length; index += 1) {
          let item;
          try {
            const descriptor = Object.getOwnPropertyDescriptor(node, index);
            if (!descriptor || !("value" in descriptor)) continue;
            item = descriptor.value;
          } catch { continue; }
          visit(item, `${path}[${index}]`, node, depth + 1);
        }
        return;
      }
      let keys;
      try { keys = Object.keys(node).slice(0, 2000); } catch { return; }
      for (const key of keys) {
        let item;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(node, key);
          if (!descriptor || !("value" in descriptor)) continue;
          item = descriptor.value;
        } catch { continue; }
        if (typeof item === "function") continue;
        visit(item, path ? `${path}.${key}` : key, node, depth + 1);
      }
    };
    visit(value, opts.rootPath || "", null, 0);
    return findings;
  }

  /** Approximate dotted key path of a position inside JS/JSON source text (used for non-JSON inline scripts). */
  function approximateKeyPath(text, index) {
    const keys = [];
    const before = text.slice(Math.max(0, index - 160), index);
    const immediate = /["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*(?:["'`]\s*)?(?:[a-z]+:)?$/.exec(before);
    if (immediate) keys.unshift(immediate[1]);
    let depth = 0;
    let budget = 60000;
    for (let position = index - 1; position >= 0 && budget > 0 && keys.length < 10; position -= 1, budget -= 1) {
      const char = text[position];
      if (char === "}" || char === "]") depth += 1;
      else if (char === "{" || char === "[") {
        if (depth > 0) { depth -= 1; continue; }
        const preceding = text.slice(Math.max(0, position - 120), position);
        const match = /["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*$/.exec(preceding);
        if (match) keys.unshift(match[1]);
        else if (char === "[") keys.unshift("[]");
        else if (/;\s*$|^\s*$/.test(preceding)) break;
      } else if (char === ";" && depth === 0 && keys.length) break;
    }
    return keys.join(".").replace(/\.\[\]/g, "[]").slice(0, 300);
  }

  /** Scan inline script text (JSON or JS). JSON is parsed; other text uses approximate key paths. */
  function scanScriptText(text, opts = {}) {
    const source = String(text || "").slice(0, opts.maxLength || 1_000_000);
    if (source.length < 25) return [];
    const trimmed = source.trim();
    if (opts.json || /^[[{]/.test(trimmed)) {
      try { return scanJson(JSON.parse(trimmed), opts); } catch {}
    }
    const findings = [];
    for (const hit of extractAll(source, { context: "" , trustSolana: false })) {
      const keyPath = approximateKeyPath(source, hit.index);
      if (/password|passwd|secret|credential|authorization|session|cookie|username|e.?mail|verification.?code|otp|private.?key|seed.?phrase|access.?token|auth.?token/i.test(keyPath)) continue;
      if (hit.family === "solana" && !SOLANA_CONTEXT_RE.test(splitKeyWords(keyPath)) && !SOLANA_CONTEXT_RE.test(source.slice(Math.max(0, hit.index - 120), hit.index))) continue;
      const near = source.slice(Math.max(0, hit.index - 160), Math.min(source.length, hit.end + 160));
      const hintText = (near.match(/["']?(?:network|chain(?:Id|_id)?|coin|currency|token|symbol|protocol)["']?\s*[:=]\s*["']?[\w .-]{2,24}/gi) || []).join(" ").slice(0, 300);
      findings.push({ ...hit, keyPath, hintText, snippet: cleanText(near, 600) });
      if (findings.length >= (opts.maxFindings || 200)) break;
    }
    return findings;
  }

  /* ------------------------------------------------------------------ */
  /* Legacy (v0.8) display labels — used by record/organization stores     */
  /* ------------------------------------------------------------------ */

  const EVM_NETWORK_LABEL = { ethereum: "Ethereum (ETH)", bsc: "BNB Smart Chain (BSC/BEP20)", polygon: "Polygon (POL)", arbitrum: "Arbitrum One", optimism: "Optimism (OP Mainnet)", base: "Base", avalanche: "Avalanche C-Chain" };
  const EVM_TOKEN_SUFFIX = { ethereum: "ERC20", bsc: "BEP20", polygon: "Polygon", arbitrum: "Arbitrum", optimism: "Optimism", base: "Base", avalanche: "AVAX C-Chain" };
  const LEGACY_NETWORK_SHORT = { tron: "TRC20", ethereum: "ERC20", bsc: "BEP20", polygon: "Polygon", arbitrum: "Arbitrum", optimism: "Optimism", base: "Base", avalanche: "AVAX C-Chain", solana: "Solana", bitcoin: "Bitcoin", litecoin: "Litecoin", dogecoin: "Dogecoin", xrp: "XRP" };

  function legacyNetworkLabel(family, hint) {
    const network = hint?.network || null;
    const token = hint?.token || null;
    if (family === "evm") {
      if (!network) return { network: "EVM address (network uncertain)", confidence: "review" };
      const native = { ethereum: "ETH", bsc: "BNB", polygon: "MATIC", avalanche: "AVAX" }[network];
      if (token && token !== "ETH" && token !== native) return { network: `${token} (${EVM_TOKEN_SUFFIX[network]})`, confidence: "high" };
      return { network: EVM_NETWORK_LABEL[network], confidence: "high" };
    }
    if (family === "tron") return { network: token && token !== "TRX" ? `${token} (TRC20)` : "TRON (TRC20)", confidence: "high" };
    if (family === "solana") return { network: token && !["SOL"].includes(token) ? `${token} (Solana/SPL)` : "Solana (SOL/SPL)", confidence: "high" };
    return { network: { bitcoin: "Bitcoin (BTC)", litecoin: "Litecoin (LTC)", dogecoin: "Dogecoin (DOGE)", xrp: "XRP Ledger (XRP)" }[family] || family, confidence: "high" };
  }

  /* ------------------------------------------------------------------ */
  /* Observation helpers                                                  */
  /* ------------------------------------------------------------------ */

  /** observationId = sha256 hex of family|normalisedAddress|pageUrl|method|contextClass (V4 contract §1). */
  function observationId(family, address, pageUrl, method, contextClass) {
    return sha256Hex([family, normalizeAddress(family, address), String(pageUrl || ""), method, contextClass].join("|"));
  }

  function stableStringify(value) {
    const stable = item => {
      if (Array.isArray(item)) return item.map(stable);
      if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]));
      return item;
    };
    return JSON.stringify(stable(value));
  }

  /** Content fingerprint used to decide whether an observation changed (excludes timestamps and counters). */
  function observationFingerprint(payload) {
    const comparable = JSON.parse(JSON.stringify(payload || {}));
    delete comparable.firstSeen; delete comparable.lastSeen; delete comparable.seenCount;
    return sha256Hex(stableStringify(comparable));
  }

  return Object.freeze({
    VERSION, FAMILIES, FAMILY_NETWORKS, NETWORK_FAMILY, CHAIN_IDS, CONTEXT_CLASSES, METHODS, LEGACY_NETWORK_SHORT,
    utf8, toHex, sha256, sha256Hex, keccak256, keccak256Hex,
    base58Decode, base58Check, bech32Decode, segwitDecode, eip55Checksum, evmFormatCheck,
    normalizeAddress, identify, knownAddressInfo, KNOWN_TOKEN_CONTRACTS, FORCED_EXAMPLES, KNOWN_EXAMPLES,
    cleanText, extractAddresses, parsePaymentUri, extractPaymentUris, extractAll,
    networksIn, tokensIn, extractNetworkHint,
    splitKeyWords, keyPathRules, classifyContext, contextRank, snippetAround,
    scanJson, scanScriptText, approximateKeyPath, siblingHintText,
    legacyNetworkLabel, observationId, observationFingerprint, stableStringify
  });
});
