import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
const __dirname=path.dirname(fileURLToPath(import.meta.url));
"use strict";
// Unit tests for wallet-core.js. Run: node --test tests/*.test.js  (own fixtures only)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import core from "../wallet-core.js";

/* ------------------------------ hashing ------------------------------ */

test("sha256 matches node:crypto", () => {
  for (const input of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "€ unicode ✓", "x".repeat(10_000)]) {
    assert.equal(core.sha256Hex(input), crypto.createHash("sha256").update(input).digest("hex"));
  }
});

test("keccak-256 (Ethereum padding) known vectors", () => {
  assert.equal(core.keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(core.keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(core.keccak256Hex("The quick brown fox jumps over the lazy dog"), "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15");
  // multi-block (rate = 136 bytes) and exact-rate padding (0x81 in the last byte)
  assert.equal(core.keccak256Hex("a".repeat(135)).length, 64);
  assert.notEqual(core.keccak256Hex("a".repeat(135)), core.keccak256Hex("a".repeat(136)));
});

/* ------------------------------ EIP-55 ------------------------------ */

const EIP55_VECTORS = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26"
];

test("EIP-55 specification vectors", () => {
  // The specification's "all caps", "all lower" and "normal" vectors are all exact outputs of the checksum.
  for (const address of EIP55_VECTORS) assert.equal(core.eip55Checksum(address.toLowerCase()), address);
  assert.equal(core.identify("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").formatCheck, "checksum_valid");
  assert.equal(core.identify("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359").formatCheck, "checksum_valid");
  assert.equal(core.identify("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD").formatCheck, "checksum_invalid");
  assert.equal(core.identify("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").formatCheck, "format_valid");
  assert.equal(core.identify("0x52908400098527886E0F7030069857D2E4169EE7").formatCheck, "format_valid"); // all caps
});

test("built-in token contract list is internally valid", () => {
  for (const [identity, item] of core.KNOWN_TOKEN_CONTRACTS) {
    const info = core.identify(item.address);
    assert.ok(info, item.address);
    assert.equal(info.identity, identity);
    assert.notEqual(info.formatCheck, "checksum_invalid", `${item.address} has a bad checksum`);
  }
});

/* ------------------------------ BTC / LTC / DOGE ------------------------------ */

test("bitcoin base58check and bech32/bech32m with witness rules", () => {
  const genesis = core.identify("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  assert.equal(genesis.family, "bitcoin");
  assert.equal(genesis.formatCheck, "checksum_valid");
  assert.equal(core.identify("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"), null, "bad base58check rejected");
  assert.equal(core.identify("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").family, "bitcoin"); // P2SH

  const p2wpkh = core.identify("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  assert.deepEqual([p2wpkh.family, p2wpkh.encoding, p2wpkh.formatCheck], ["bitcoin", "bech32", "checksum_valid"]);
  assert.equal(core.identify("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4").normalized, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  assert.equal(core.identify("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3").family, "bitcoin"); // P2WSH
  const taproot = core.identify("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
  assert.deepEqual([taproot.encoding, taproot.formatCheck], ["bech32m", "checksum_valid"]);

  // BIP-350 invalid vectors: v0 with bech32m checksum, v1 with bech32 checksum, mixed case.
  assert.equal(core.segwitDecode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "bc").valid, false);
  assert.equal(core.segwitDecode("bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4", "bc").valid, false);
  assert.equal(core.identify("bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), null, "mixed case bech32 rejected");
  assert.equal(core.identify("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"), null, "bad checksum rejected by default");
  assert.equal(core.identify("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", { allowInvalidChecksum: true }).formatCheck, "checksum_invalid");
});

// Independent reference encoders (node:crypto + BIP-173 reference algorithm) to cross-check the decoders.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58CheckEncode(version, payload) {
  const body = Buffer.concat([Buffer.from([version]), Buffer.from(payload)]);
  const checksum = crypto.createHash("sha256").update(crypto.createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([body, checksum]);
  let number = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (number > 0n) { out = B58[Number(number % 58n)] + out; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) { const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1; for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i += 1) if ((b >>> i) & 1) chk ^= g[i]; } return chk >>> 0; }
function segwitEncode(hrp, version, program, bech32m) {
  const data = [version];
  let acc = 0; let bits = 0;
  for (const value of program) { acc = (acc << 8) | value; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const expanded = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  const mod = polymod(expanded.concat(data, [0, 0, 0, 0, 0, 0])) ^ (bech32m ? 0x2bc830a3 : 1);
  const checksum = [0, 1, 2, 3, 4, 5].map(i => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map(v => CHARSET[v]).join("")}`;
}

test("litecoin and dogecoin (generated with reference encoders)", () => {
  const program = crypto.createHash("sha256").update("cwl-test").digest().subarray(0, 20);
  const ltcLegacy = base58CheckEncode(0x30, program);
  const ltcP2sh = base58CheckEncode(0x32, program);
  const doge = base58CheckEncode(0x1e, program);
  const tron = base58CheckEncode(0x41, program);
  const ltcSegwit = segwitEncode("ltc", 0, program, false);
  const btcSegwit = segwitEncode("bc", 0, program, false);
  const btcTaproot = segwitEncode("bc", 1, crypto.createHash("sha256").update("cwl-taproot").digest(), true);
  assert.match(ltcLegacy, /^L/); assert.match(ltcP2sh, /^M/); assert.match(doge, /^D/); assert.match(tron, /^T/);
  assert.equal(core.identify(ltcLegacy).family, "litecoin");
  assert.equal(core.identify(ltcP2sh).family, "litecoin");
  assert.equal(core.identify(doge).family, "dogecoin");
  assert.equal(core.identify(tron).family, "tron");
  assert.deepEqual([core.identify(ltcSegwit).family, core.identify(ltcSegwit).formatCheck], ["litecoin", "checksum_valid"]);
  assert.equal(core.identify(btcSegwit).family, "bitcoin");
  assert.equal(core.identify(btcTaproot).encoding, "bech32m");
  assert.equal(core.identify(segwitEncode("bc", 1, program.subarray(0, 20), false)), null, "v1 with bech32 checksum is invalid");
  assert.equal(core.identify(segwitEncode("bc", 0, crypto.createHash("sha256").update("x").digest().subarray(0, 25), false)), null, "v0 program must be 20 or 32 bytes");
});

/* ------------------------------ TRON / XRP / SOL ------------------------------ */

test("tron, xrp, solana", () => {
  const usdt = core.identify("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.deepEqual([usdt.family, usdt.formatCheck, usdt.normalized], ["tron", "checksum_valid", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]);
  assert.equal(core.identify("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"), null);
  const xrp = core.identify("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  assert.deepEqual([xrp.family, xrp.formatCheck], ["xrp", "checksum_valid"]);
  const sol = core.identify("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  assert.deepEqual([sol.family, sol.formatCheck, sol.encoding], ["solana", "format_valid", "ed25519-length"]);
  assert.equal(core.base58Decode("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T").length, 32);
  assert.deepEqual(sol.candidateNetworks, ["solana"]);
  assert.deepEqual(core.identify("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").candidateNetworks, ["ethereum", "bsc", "polygon", "arbitrum", "optimism", "base", "avalanche"]);
});

/* ------------------------------ extraction ------------------------------ */

test("extraction rejects tx hashes and hex substrings, keeps case", () => {
  const txHash = "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b";
  const text = `Tx ${txHash}\nlonger 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed00\nprefixed ab0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nok: 0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359.`;
  const hits = core.extractAddresses(text);
  assert.deepEqual(hits.map(hit => hit.address), ["0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"]);
});

test("extraction across families with boundaries and zero-width characters", () => {
  const text = "BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa, TRON T​R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t; XRP (rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh) taproot bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0 and solana wallet 4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const families = core.extractAddresses(text).map(hit => `${hit.family}:${hit.address}`);
  assert.deepEqual(families, [
    "bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "xrp:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    "bitcoin:bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    "solana:4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"
  ]);
});

test("solana-length base58 needs wallet context and is rejected after signature/hash labels", () => {
  const sol = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  assert.equal(core.extractAddresses(`lorem ipsum ${sol} dolor sit amet`).length, 0);
  assert.equal(core.extractAddresses(`Send SOL to ${sol}`).length, 1);
  assert.equal(core.extractAddresses(`Wallet activity. Signature: ${sol}`).length, 0);
  assert.equal(core.extractAddresses("deposit address getElementsByClassNameForSomethingLongEnough").length, 0);
});

/* ------------------------------ payment URIs ------------------------------ */

test("EIP-681 URIs: chain id, value and ERC-20 transfer recipient", () => {
  const plain = core.parsePaymentUri("ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359@56?value=1e18");
  assert.deepEqual([plain.address, plain.chainId, plain.network, plain.amount], ["0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", 56, "bsc", "1e18"]);
  const pay = core.parsePaymentUri("ethereum:pay-0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359@0x89");
  assert.equal(pay.network, "polygon");
  const transfer = core.parsePaymentUri("ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359&uint256=2500000");
  assert.deepEqual([transfer.address, transfer.token, transfer.network, transfer.tokenContract, transfer.amount], ["0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "USDT", "ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "2500000"]);
  const unknownChain = core.parsePaymentUri("ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
  assert.equal(unknownChain.network, null, "no chain id = no network guess");
  assert.equal(core.parsePaymentUri("ethereum:0x1234"), null);
});

test("bitcoin/litecoin/dogecoin/tron/solana/xrp URIs", () => {
  const btc = core.parsePaymentUri("bitcoin:BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4?amount=0.015&label=Shop");
  assert.deepEqual([btc.family, btc.network, btc.amount, btc.params.label, btc.info.normalized], ["bitcoin", "bitcoin", "0.015", "Shop", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"]);
  assert.equal(core.parsePaymentUri("litecoin:LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz?amount=1").family, "litecoin");
  assert.equal(core.parsePaymentUri("dogecoin:DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L").family, "dogecoin");
  assert.equal(core.parsePaymentUri("bitcoin:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), null, "scheme/family mismatch");
  const tron = core.parsePaymentUri("tron:TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj?amount=25&token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.deepEqual([tron.family, tron.token, tron.amount], ["tron", "USDT", "25"]);
  const solana = core.parsePaymentUri("solana:4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T?amount=10&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=Store");
  assert.deepEqual([solana.family, solana.token, solana.amount], ["solana", "USDC", "10"]);
  const xrp = core.parsePaymentUri("xrp:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh?amount=20&dt=12345");
  assert.deepEqual([xrp.family, xrp.params.dt], ["xrp", "12345"]);
  assert.equal(core.parsePaymentUri("ripple:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh").family, "xrp");
});

test("extractAll: token contract inside a transfer URI is not the payment target", () => {
  const hits = core.extractAll("Pay: ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359&uint256=1");
  const recipient = hits.find(hit => hit.address === "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
  const contract = hits.find(hit => hit.address === "0xdAC17F958D2ee523a2206206994597C13D831ec7");
  assert.ok(recipient.uri && recipient.uri.token === "USDT");
  assert.equal(contract.uri, null);
  assert.ok(contract.uriTokenContract);
});

/* ------------------------------ network hints ------------------------------ */

test("network hints: canonical mapping and priority", () => {
  const hint = input => core.extractNetworkHint(input).hint;
  assert.deepEqual(hint({ family: "tron", nearby: "Deposit USDT (TRC20)" }), { network: "tron", token: "USDT", source: "nearby-text" });
  assert.deepEqual(hint({ family: "evm", selected: ["BEP20"], nearby: "ERC20 BEP20 Polygon" }), { network: "bsc", token: null, source: "selected-option" });
  assert.equal(hint({ family: "evm", labels: ["USDT · BNB Smart Chain"] }).network, "bsc");
  assert.equal(hint({ family: "evm", labels: ["Polygon"] }).network, "polygon");
  assert.equal(hint({ family: "evm", labels: ["MATIC"] }).network, "polygon");
  assert.equal(hint({ family: "evm", labels: ["Arbitrum One"] }).network, "arbitrum");
  assert.equal(hint({ family: "evm", labels: ["OP Mainnet"] }).network, "optimism");
  assert.equal(hint({ family: "evm", selected: ["Base"] }).network, "base");
  assert.equal(hint({ family: "evm", nearby: "USDC (Base)" }).network, "base");
  assert.equal(hint({ family: "evm", nearby: "the base fee is low" }), null, "'base' as an ordinary word is not a network");
  assert.equal(hint({ family: "evm", labels: ["AVAX C-Chain"] }).network, "avalanche");
  assert.deepEqual(hint({ family: "solana", labels: ["USDC (SPL)"] }), { network: "solana", token: "USDC", source: "label" });
  assert.equal(hint({ family: "evm", nearby: "We support ERC20 and BEP20" }), null, "never guess between EVM networks");
  const uri = core.parsePaymentUri("ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359@42161");
  assert.deepEqual(hint({ family: "evm", uri, selected: ["BEP20"] }), { network: "arbitrum", token: null, source: "uri" });
  const qr = core.parsePaymentUri("ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359@8453");
  assert.equal(hint({ family: "evm", qrUri: qr }).source, "qr-uri");
  const mismatch = core.extractNetworkHint({ family: "evm", selected: ["TRC20"] });
  assert.deepEqual([mismatch.hint, mismatch.mismatched], [null, ["tron"]]);
  assert.deepEqual(hint({ family: "evm", nearby: "Deposit USDT" }), { network: null, token: "USDT", source: "nearby-text" });
});

/* ------------------------------ context classification ------------------------------ */

const EVM = "0xBACBE1090cFe05317CCB34E549d3Cf25dDe147CC"; // neutral generated fixture (not a spec vector)
const classify = input => core.classifyContext({ address: EVM, ...input });

test("deposit: words + structure", () => {
  const result = classify({ heading: "Deposit USDT", local: `Your deposit address ${EVM} Copy`, section: "Send only USDT (BEP20) to this address. Minimum deposit: 10 USDT", flags: { copyControl: true, qrNearby: true, networkSelector: true } });
  assert.equal(result.class, "deposit");
  assert.ok(result.confidence >= 0.85);
  assert.ok(result.cues.includes("copy button next to address"));
  assert.ok(result.cues.some(cue => cue.startsWith("send only")));
  assert.equal(result.section, "Deposit USDT");
  assert.ok(result.snippet.includes(EVM) && result.snippet.length <= 600);
});

test("recharge / top up / fund your account / payment instruction", () => {
  assert.equal(classify({ heading: "Recharge", local: `Address ${EVM}`, flags: { copyControl: true } }).class, "deposit");
  assert.equal(classify({ local: `Top up your balance: send USDT to the following address ${EVM}` }).class, "deposit");
  assert.equal(classify({ heading: "Fund your account", local: EVM }).class, "deposit");
  assert.equal(classify({ heading: "Invoice #123", local: `Amount due 0.5 ETH. Pay to ${EVM}`, flags: { qrMatch: true } }).class, "deposit");
});

test("withdrawal never counts as deposit", () => {
  const typed = classify({ heading: "Withdraw USDT", label: "Your wallet address", local: EVM, section: "Amount to withdraw · Network BEP20 · Fee 1 USDT", flags: { editable: true, userTyped: true, amountField: true } });
  assert.equal(typed.class, "withdrawal");
  const prefilled = classify({ heading: "Withdrawal", label: "Saved address", local: EVM, flags: { editable: true } });
  assert.equal(prefilled.class, "withdrawal");
  // deposit words in a nav bar must not turn a withdrawal form into a deposit
  const mixed = classify({ heading: "Withdraw", label: "Enter your address", local: EVM, section: "Deposit · Withdraw · History", flags: { editable: true, userTyped: true, depositContainer: false } });
  assert.equal(mixed.class, "withdrawal");
  // user-typed address in a deposit page ("address you sent from") is not the site's deposit address
  assert.notEqual(classify({ heading: "Deposit", label: "Enter the address you sent from", local: EVM, flags: { editable: true, userTyped: true } }).class, "deposit");
});

test("examples: placeholder, e.g., docs code blocks, well-known addresses", () => {
  assert.equal(classify({ label: "Recipient", local: EVM, flags: { placeholder: true } }).class, "example");
  assert.equal(classify({ local: `Addresses look like this, e.g. ${EVM}` }).class, "example");
  assert.equal(classify({ heading: "API reference", local: `{"address": "${EVM}"}`, flags: { inCode: true, docs: true } }).class, "example");
  const zero = core.classifyContext({ address: "0x0000000000000000000000000000000000000000", heading: "Deposit", local: "Deposit to 0x0000000000000000000000000000000000000000", flags: { copyControl: true } });
  assert.deepEqual([zero.class, zero.confidence >= 0.9], ["example", true]);
  const spec = core.classifyContext({ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", local: "Checksum such as 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" });
  assert.equal(spec.class, "example");
});

test("transaction history and contract/token", () => {
  assert.equal(classify({ heading: "Recent transactions", local: `${EVM} 2026-01-02 50 USDT Completed`, flags: { inTable: true, txTable: true, txLink: true } }).class, "transaction_history");
  assert.equal(classify({ heading: "Deposit history", local: `From ${EVM} Confirmed`, flags: { inTable: true, txTable: true } }).class, "transaction_history");
  assert.equal(classify({ label: "Token contract address", local: EVM }).class, "contract");
  assert.equal(classify({ local: EVM, flags: { tokenLink: true }, label: "Token" }).class, "contract");
  const usdt = core.classifyContext({ address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", heading: "Deposit USDT", local: "Send only USDT", flags: { copyControl: true } });
  assert.deepEqual([usdt.class, usdt.confidence], ["contract", 0.95]);
  const tronUsdt = core.classifyContext({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", heading: "Deposit" });
  assert.equal(tronUsdt.class, "contract");
  for (const [identity, item] of core.KNOWN_TOKEN_CONTRACTS) assert.equal(core.classifyContext({ address: item.address, heading: "Deposit address" }).class, "contract", identity);
});

test("unrelated and unknown", () => {
  assert.equal(classify({ local: `Contact ${EVM}`, flags: { footer: true } }).class, "unrelated");
  assert.equal(classify({ heading: "Company news", local: `Posted on 2 May. Read more ${EVM}`, flags: { blog: true } }).class, "unrelated");
  const unknown = classify({ local: EVM });
  assert.equal(unknown.class, "unknown");
  assert.ok(unknown.confidence <= 0.35);
});

test("hidden-panel cue lowers confidence", () => {
  const visible = classify({ heading: "Deposit · ERC20", local: `Deposit address ${EVM}`, flags: { copyControl: true } });
  const hidden = classify({ heading: "Deposit · ERC20", local: `Deposit address ${EVM}`, flags: { copyControl: true, hidden: true } });
  assert.equal(hidden.class, "deposit");
  assert.ok(hidden.cues.includes("hidden-panel"));
  assert.ok(hidden.confidence < visible.confidence);
  assert.ok(core.contextRank(visible) > core.contextRank(hidden));
});

test("key paths from script config / network responses", () => {
  const byPath = (keyPath, method = "network-response") => core.classifyContext({ address: EVM, keyPath, method });
  assert.equal(byPath("data.depositAddress").class, "deposit");
  assert.equal(byPath("payment.payAddress").class, "deposit");
  assert.equal(byPath("walletAddress").class, "deposit");
  assert.ok(byPath("walletAddress").confidence < byPath("data.depositAddress").confidence);
  assert.equal(byPath("user.withdrawAddress").class, "withdrawal");
  assert.equal(byPath("profile.walletAddress").class, "withdrawal");
  assert.equal(byPath("token.contractAddress").class, "contract");
  assert.equal(byPath("transactions[3].from").class, "transaction_history");
  assert.equal(byPath("docs.exampleAddress").class, "example");
  assert.ok(byPath("data.depositAddress").cues.includes("key path: depositAddress"));
});

/* ------------------------------ structured data ------------------------------ */

test("scanJson records key paths, sibling hints and never invokes getters", () => {
  let getterCalled = false;
  const value = {
    wallet: { depositAddress: EVM, network: "BEP20", coin: "USDT" },
    withdrawAddress: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
    lastTx: { txHash: "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b" },
    get secret() { getterCalled = true; return EVM; }
  };
  const findings = core.scanJson(value);
  assert.equal(getterCalled, false);
  assert.deepEqual(findings.map(item => [item.keyPath, item.address]), [["wallet.depositAddress", EVM], ["withdrawAddress", "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"]]);
  assert.match(findings[0].hintText, /network: BEP20/);
  const cyclic = { a: {} }; cyclic.a.self = cyclic; cyclic.a.pay = EVM;
  assert.equal(core.scanJson(cyclic).length, 1);
});

test("scanScriptText: JS config with approximate key paths", () => {
  const findings = core.scanScriptText(`window.__APP_CONFIG__ = { theme: "dark", payment: { payAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", network: "bitcoin" } };`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].keyPath, "__APP_CONFIG__.payment.payAddress");
  const json = core.scanScriptText(`{"checkout":{"receivingAddress":"${EVM}","chainId":56}}`, { json: true });
  assert.equal(json[0].keyPath, "checkout.receivingAddress");
  assert.match(json[0].hintText, /bsc/);
});

/* ------------------------------ identity & observation id ------------------------------ */

test("canonical identity and observationId", () => {
  assert.equal(core.identify(EVM).identity, `evm:${EVM.toLowerCase()}`);
  assert.equal(core.identify(EVM.toLowerCase()).identity, core.identify(EVM).identity);
  assert.equal(core.identify("TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj").identity, "tron:TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj");
  const id = core.observationId("evm", EVM, "https://site.test/deposit", "text", "deposit");
  assert.equal(id, crypto.createHash("sha256").update(`evm|${EVM.toLowerCase()}|https://site.test/deposit|text|deposit`).digest("hex"));
  assert.equal(core.observationId("evm", EVM.toLowerCase(), "https://site.test/deposit", "text", "deposit"), id);
  assert.notEqual(core.observationId("evm", EVM, "https://site.test/deposit", "text", "unknown"), id);
});

test("legacy network labels keep v0.8 UI/verifier semantics", () => {
  assert.deepEqual(core.legacyNetworkLabel("tron", { network: "tron", token: "USDT" }), { network: "USDT (TRC20)", confidence: "high" });
  assert.deepEqual(core.legacyNetworkLabel("evm", { network: "bsc", token: "USDT" }), { network: "USDT (BEP20)", confidence: "high" });
  assert.deepEqual(core.legacyNetworkLabel("evm", null), { network: "EVM address (network uncertain)", confidence: "review" });
  assert.equal(core.legacyNetworkLabel("evm", { network: "ethereum", token: "ETH" }).network, "Ethereum (ETH)");
});

test("main-world/wallet-core.js is a byte-identical copy of wallet-core.js", () => {
  // Chrome injects a given script file only once per frame, even across worlds, so the MAIN-world content script
  // entry needs its own path. Keep it identical: cp wallet-core.js main-world/wallet-core.js
  const root = path.join(__dirname, "..");
  assert.equal(fs.readFileSync(path.join(root, "main-world", "wallet-core.js"), "utf8"), fs.readFileSync(path.join(root, "wallet-core.js"), "utf8"));
});
