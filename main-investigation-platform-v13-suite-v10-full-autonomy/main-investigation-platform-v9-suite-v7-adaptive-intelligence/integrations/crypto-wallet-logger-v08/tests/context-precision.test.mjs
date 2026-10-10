"use strict";
// Context-precision fixtures for classifyContext: each case is the classifier input content.js builds for an address on a
// realistic page (the HTML is sketched above each case; the same pages run for real in tests/browser_extension_test.py,
// fp/*.html). Built from first principles — not from the shared benchmark.
// Run: /opt/node24/bin/node --test tests/context-precision.test.js
import test from "node:test";
import assert from "node:assert/strict";
import core from "../wallet-core.js";

const DEP = "0xbca55675025082730C7b1DfA310c5251099897d1";
const DECOY = "0xFD69EFCB922a02734Eb2417fd0C527633FfF7241";
const TRON_DEP = "TNxU58azektgedLxLywNVnRB5oD8CULL3X";
const TRON_DECOY = "TMaCNsTb4ik6nWGk3mDsjSBj6LNnffLGRB";
const classify = (address, input) => core.classifyContext({ address, ...input });

// The surroundings every address of an exchange deposit card shares (heading, card text, QR, selector, container).
const CARD_SECTION = "Deposit Crypto Select network ERC20 TRC20 Deposit Address Copy Send only USDT to this deposit address. Minimum deposit: 10 USDT. Deposits are credited after 12 confirmations.";
const cardFlags = extra => ({ qrNearby: true, networkSelector: true, depositContainer: true, ...extra });

/* ------------------------------ real deposit addresses stay deposit ------------------------------ */

test("deposit card: address with its own label, copy button and QR", () => {
  // <div class="label">Deposit Address</div><div class="addr-row"><span>0x…</span><button>Copy</button></div>
  const result = classify(DEP, { heading: "Deposit Crypto", label: "Deposit Address", near: `${DEP} Copy`, local: `Deposit Address\n${DEP} Copy\nSend only USDT to this deposit address.`, section: CARD_SECTION, flags: cardFlags({ copyControl: true }) });
  assert.equal(result.class, "deposit");
  assert.ok(result.confidence >= 0.85);
});

test("deposit wording only in a heading, or only in the address's own sentence, is still deposit", () => {
  assert.equal(classify(DEP, { heading: "Deposit", local: DEP }).class, "deposit");
  assert.equal(classify(DEP, { local: `To activate your account, send 100 USDT (ERC20) to the following wallet: ${DEP}. Your balance will be updated automatically.` }).class, "deposit");
  // <p>Please transfer USDT to:</p><p>T…</p>
  assert.equal(classify(TRON_DEP, { heading: "Receive payment", label: "Please transfer USDT to:", near: TRON_DEP, local: `Please transfer USDT to:\n${TRON_DEP}` }).class, "deposit");
  // scam "investment" recharge page
  assert.equal(classify(DEP, { label: "Recharge address", near: `Recharge address ${DEP} Copy`, local: `Recharge address\n${DEP}\nCopy`, flags: { copyControl: true } }).class, "deposit");
});

test("a lone address in a deposit section (no other address there) keeps the section's deposit wording", () => {
  const input = { heading: "USDT · TRC20", near: TRON_DEP, local: `USDT · TRC20 ${TRON_DEP}`, section: `Deposit Please deposit only USDT-TRC20. ${TRON_DEP}` };
  assert.equal(classify(TRON_DEP, { ...input, flags: { soleAddress: true } }).class, "deposit");
  assert.equal(classify(TRON_DEP, { ...input, flags: { soleAddress: false } }).class, "unknown");
});

test("deposit next to a contract mention stays deposit (contract evidence is not about this address)", () => {
  // <div class="kv"><span>Staking contract</span> T…</div><div class="kv"><span>Deposit to</span> <span>0x…</span><button>Copy</button></div>
  const result = classify(DEP, { heading: "Stake USDT", label: "Deposit to", near: `Deposit to ${DEP} Copy`, local: `Approve the staking contract to continue.\nStaking contract ${TRON_DECOY}\nDeposit to ${DEP} Copy`, flags: { copyControl: true } });
  assert.equal(result.class, "deposit");
  // deposit address in a multi-network table: the column header is its label
  assert.equal(classify(DEP, { heading: "Deposit addresses", label: "USDT · Deposit address", near: DEP, local: `USDT ERC20 ${DEP} 10 USDT`, flags: { inTable: true } }).class, "deposit");
});

test("network responses and script config keep their key-path evidence", () => {
  assert.equal(core.classifyContext({ address: DEP, keyPath: "deposit.depositAddress", method: "network-response" }).class, "deposit");
  assert.equal(core.classifyContext({ address: DEP, keyPath: "state.wallet.address", method: "script-config" }).class, "deposit");
  assert.equal(core.classifyContext({ address: DEP, keyPath: "partners[0].wallet", method: "network-response" }).class, "unrelated");
});

/* ------------------------------ decoys on the same page are not deposit ------------------------------ */

test("token contract inside the deposit card: its own label beats the card's deposit cues", () => {
  // <div class="contract-info"><span>Contract Information</span><span>ending in <a href="https://etherscan.io/token/0x…">0x…</a></span></div>
  const result = classify(DECOY, { heading: "Deposit Crypto", label: "Contract Information", near: `ending in ${DECOY}`, local: `Deposit Address\n${DEP} Copy\nSend only USDT to this deposit address.\nContract Information ending in ${DECOY}`, section: CARD_SECTION, flags: cardFlags({ tokenLink: true }) });
  assert.equal(result.class, "contract");
  assert.ok(result.negativeCues.some(cue => cue.startsWith("deposit")));
  // meme-coin page: "CA: 0x… [Copy]"
  assert.equal(classify(DECOY, { heading: "$FROGX", near: `CA: ${DECOY} Copy`, local: `CA: ${DECOY} Copy Buy on Uniswap`, flags: { copyControl: true } }).class, "contract");
  // <dl><dt>Contract address</dt><dd>0x…</dd></dl> inside a deposit panel
  assert.equal(classify(DECOY, { heading: "Deposit USDT", label: "Contract address", near: DECOY, local: `Contract address ${DECOY} Network BEP20`, section: `Deposit USDT Deposit address: ${DEP} Copy`, flags: { depositContainer: true } }).class, "contract");
});

test("transaction history rows (table or div list) inside a deposit page", () => {
  // table with a TxID column and the address in the "Address" column
  assert.equal(classify(DECOY, { heading: "Recent Deposits", label: "Address · 250", near: DECOY, local: `2026-09-21 10:12 USDT 250 ${DECOY} 0x5e1f…a91c Completed`, flags: { inTable: true, txTable: true, txLink: true, depositContainer: true } }).class, "transaction_history");
  // React list: <div class="record-item"><div>2026-09-12 14:03:22</div><div>+250 USDT</div><div>From <span>T…</span> ⧉</div>…
  const row = classify(TRON_DECOY, { heading: "Deposit Records", label: "+250 USDT", near: `From ${TRON_DECOY} ⧉`, local: `2026-09-12 14:03:22 +250 USDT From ${TRON_DECOY} ⧉ Completed`, section: `Deposit Records ${TRON_DECOY}`, flags: { copyControl: true, datedRow: true, depositContainer: true, networkSelector: true } });
  assert.equal(row.class, "transaction_history");
  // an address-shaped value labelled as a transaction id
  assert.equal(classify(DECOY, { heading: "Transactions", near: `TxID ${DECOY}`, local: `Deposit 2026-08-28 TxID ${DECOY} +75 USDT Completed` }).class, "transaction_history");
});

test("example / documentation addresses", () => {
  // FAQ on the deposit page: "<summary>What does an ERC20 deposit address look like?</summary><p>…, for example 0x….</p>"
  const faq = classify(DECOY, { heading: "FAQ", label: "What does an ERC20 deposit address look like?", near: `An ERC20 address starts with 0x and has 42 characters, for example ${DECOY}.`, local: `An ERC20 address starts with 0x and has 42 characters, for example ${DECOY}.`, section: CARD_SECTION, flags: { networkSelector: true, depositContainer: true } });
  assert.equal(faq.class, "example");
  assert.equal(classify(DECOY, { heading: "Deposit ETH", near: `Your address should look like this: ${DECOY}`, local: `Your address should look like this: ${DECOY} Generate your personal address below.`, flags: { depositContainer: true } }).class, "example");
  // help-center screenshot: <figure><div class="mock">Deposit address 0x… Copy</div><figcaption>Sample deposit screen</figcaption></figure>
  assert.equal(classify(DECOY, { heading: "How to deposit crypto", label: "Deposit address · Sample deposit screen", near: DECOY, local: `Deposit address\n${DECOY}\nCopy`, flags: { copyControl: true, depositContainer: true, docs: true, exampleFigure: true } }).class, "example");
});

test("withdrawal inputs and the visitor's own addresses", () => {
  // hidden "Withdraw" tab next to the active "Deposit" tab: prefilled, editable input
  const tab = classify(DECOY, { heading: "USDT Wallet", label: "Withdrawal address · wd addr", near: "Withdrawal address", local: `ERC20 deposit address ${DEP} Copy Send only USDT to this address. Withdrawal address Amount Submit`, flags: { editable: true, amountField: true, hidden: true } });
  assert.equal(tab.class, "withdrawal");
  // "Recipient address" input, prefilled (not typed)
  assert.equal(classify(DECOY, { heading: "Send USDT", label: "Recipient address", near: "Recipient address", local: "Recipient address Amount Network fee ≈ 1 USDT", flags: { editable: true, amountField: true } }).class, "withdrawal");
  // "Verify your sending wallet" input on a deposit page, placeholder "Your wallet address"
  assert.notEqual(classify(DECOY, { heading: "Deposit", label: "Your wallet address", near: "Verify your sending wallet", local: "Verify your sending wallet", flags: { editable: true, depositContainer: true } }).class, "deposit");
  // "Your … recharge address" is the site's deposit address, not the visitor's
  assert.equal(classify(DEP, { label: "Your exclusive recharge address", near: DEP, local: `Your exclusive recharge address ${DEP}`, flags: { copyControl: true } }).class, "deposit");
});

test("unrelated addresses: partners, team wallets, referrers, reported scam addresses", () => {
  assert.notEqual(classify(DECOY, { heading: "Tokenomics", near: `Team wallet: ${DECOY}`, local: `Team wallet: ${DECOY}`, section: `Liquidity pool: ${DEP} Team wallet: ${DECOY}` }).class, "deposit");
  assert.equal(classify(TRON_DECOY, { heading: "Deposit", near: `Referrer wallet: ${TRON_DECOY}`, local: `${TRON_DEP} Copy Referrer wallet: ${TRON_DECOY}`, flags: { depositContainer: true } }).class, "unrelated");
  assert.equal(classify(DECOY, { heading: "Recently reported addresses", near: `${DECOY} — fake exchange, 14 reports`, local: `${DECOY} — fake exchange, 14 reports` }).class, "unrelated");
});

test("deposit cues that only describe the surrounding section give unknown, not deposit", () => {
  const result = classify(DECOY, { near: DECOY, local: `${DECOY}`, section: CARD_SECTION, flags: cardFlags({}) });
  assert.equal(result.class, "unknown");
  assert.ok(result.cues.includes("deposit cues only in the surrounding section"));
});

test("malformed addresses (failing checksum) are never called deposit", () => {
  const badCase = "0x5B52f2b633935C0d34F3B8101ab111dF1c0EBDC7"; // one letter's case flipped: EIP-55 fails
  assert.equal(core.identify(badCase).formatCheck, "checksum_invalid");
  const evm = classify(badCase, { heading: "Deposit ETH", label: "Deposit address", near: `${badCase} Copy`, local: `Deposit address ${badCase} Copy Send only ETH to this address.`, flags: { copyControl: true } });
  assert.equal(evm.class, "unknown");
  assert.ok(evm.cues.includes("address checksum fails (malformed)"));
  const bech = classify("bc1q6mp6fws8hz93f9auc6mra73aus5g37j2479cwk", { heading: "Deposit BTC", label: "Deposit address:", local: "Deposit address: bc1q6mp6fws8hz93f9auc6mra73aus5g37j2479cwk", flags: { copyControl: true } });
  assert.equal(bech.class, "unknown");
  // the all-lowercase form of a valid address has no checksum to fail and stays deposit
  assert.equal(classify(DEP.toLowerCase(), { heading: "Deposit", label: "Deposit address", local: DEP.toLowerCase(), flags: { copyControl: true } }).class, "deposit");
});

test("near zone is derived from `local` when the caller passes none", () => {
  const input = { heading: "Deposit Crypto", local: `Deposit Address\n${DEP} Copy\nContract\n${DECOY}\nSend only USDT to this address.`, section: CARD_SECTION, flags: cardFlags({}) };
  assert.equal(classify(DECOY, input).class, "contract");
  assert.equal(classify(DEP, { ...input, flags: cardFlags({ copyControl: true }) }).class, "deposit");
});

test("a weakly supported deposit call gets a lower confidence than a well-supported one", () => {
  const weak = classify(DEP, { heading: "Deposit", local: DEP });
  const strong = classify(DEP, { heading: "Deposit", label: "Deposit address", local: `Deposit address ${DEP} Copy`, flags: { copyControl: true, qrMatch: true } });
  assert.equal(weak.class, "deposit");
  assert.ok(weak.confidence <= 0.6 && strong.confidence > weak.confidence);
});
