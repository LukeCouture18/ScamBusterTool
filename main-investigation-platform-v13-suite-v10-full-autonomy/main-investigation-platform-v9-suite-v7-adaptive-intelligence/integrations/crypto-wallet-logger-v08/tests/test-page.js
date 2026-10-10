"use strict";

const BTC = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const EVM = "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
const TRON = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SOL = "11111111111111111111111111111111";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function detected(text) {
  return WalletDetector.detect(text);
}

async function expectNetwork(text, network, confidence = "high") {
  const found = await detected(text);
  assert(found.length === 1, `Expected one wallet, found ${found.length}`);
  assert(found[0].network === network, `Expected ${network}, got ${found[0].network}`);
  assert(found[0].confidence === confidence, `Expected ${confidence}, got ${found[0].confidence}`);
  return found[0];
}

async function dynamicInsertionTest() {
  const fixture = document.querySelector("#dynamicFixture");
  fixture.querySelector("code")?.remove();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Dynamic address was not detected")); }, 1800);
    const observer = new MutationObserver(async () => {
      const found = await detected(fixture.innerText);
      if (found[0]?.network === "USDT (TRC20)") {
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(fixture, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      const code = document.createElement("code");
      code.textContent = TRON;
      fixture.append(code);
    }, 120);
  });
}

function fixtureText(selector) {
  const element = document.querySelector(selector);
  const fields = [...element.querySelectorAll("input,textarea,select")].map(field => field.value).join("\n");
  return `${element.innerText || element.textContent}\n${fields}`;
}

async function qrSources(selector) {
  return QrWalletScanner.scan({
    roots: [document.querySelector(selector)],
    force: true,
    decodeElement: async element => element.dataset.testQr ? [element.dataset.testQr] : []
  });
}

const shadowRoot = document.querySelector("#shadowHost").attachShadow({ mode: "open" });
shadowRoot.innerHTML = `<section class="deposit-widget"><h3>Solana deposit address</h3><input readonly value="${SOL}"></section>`;

const tests = [
  ["Bitcoin checksum", () => expectNetwork(`Bitcoin deposit address\n${BTC}`, "Bitcoin (BTC)")],
  ["Ethereum native", () => expectNetwork(`ETH deposit address\n${EVM}`, "Ethereum (ETH)")],
  ["Uncertain EVM", () => expectNetwork(`Deposit wallet address\n${EVM}`, "EVM address (network uncertain)", "review")],
  ["Wallet in normal text", () => expectNetwork(`Bitcoin deposit address\n${BTC}`, "Bitcoin (BTC)")],
  ["Wallet in read-only input", () => expectNetwork(fixtureText("#inputFixture"), "Ethereum (ETH)")],
  ["Wallet inside modal", () => expectNetwork(fixtureText("#modalFixture"), "USDT (TRC20)")],
  ["Wallet inside open Shadow DOM", () => expectNetwork(`${shadowRoot.textContent}\nfield value: ${shadowRoot.querySelector("input").value}`, "Solana (SOL/SPL)")],
  ["USDT ERC20", () => expectNetwork(`USDT\nSelected network: ERC20\nDeposit address\n${EVM}`, "USDT (ERC20)")],
  ["USDT BEP20", () => expectNetwork(`USDT\nSelected network: BEP20\nDeposit address\n${EVM}`, "USDT (BEP20)")],
  ["USDT TRC20", () => expectNetwork(`USDT TRC20 deposit address\n${TRON}`, "USDT (TRC20)")],
  ["XRP", () => expectNetwork(`XRP deposit address\n${XRP}`, "XRP Ledger (XRP)")],
  ["Solana", () => expectNetwork(`Solana deposit address\n${SOL}`, "Solana (SOL/SPL)")],
  ["Generic Base58 review", () => expectNetwork(`Deposit wallet address\n${SOL}`, "Possible Solana/Base58 address", "review")],
  ["Reject transaction hash", async () => assert((await detected(`Transaction signature\n${SOL}`)).length === 0, "Transaction-like Base58 value was accepted")],
  ["Reject invalid BTC", async () => assert((await detected("BTC deposit address\n1BoatSLRHtKNngkdXEeobR76b53LETtpyU")).length === 0, "Invalid checksum was accepted")],
  ["Token and network selectors", () => expectNetwork(`${fixtureText("#selectorFixture")}\n${EVM}`, "USDT (BEP20)")],
  ["Wallet represented by QR", async () => {
    const found = await WalletDetector.detectSources(await qrSources("#qrWalletFixture"));
    assert(found.length === 1, `Expected one QR wallet, found ${found.length}`);
    assert(found[0].network === "Bitcoin (BTC)", `Unexpected QR classification: ${found[0]?.network}`);
    assert(found[0].evidenceItems.includes("Address appeared beside deposit QR code"), "QR evidence was not kept");
  }],
  ["Invalid random QR ignored", async () => {
    const found = await WalletDetector.detectSources(await qrSources("#qrInvalidFixture"));
    assert(found.length === 0, "Random non-wallet QR was accepted");
  }],
  ["Same wallet from text and QR", async () => {
    const qr = await qrSources("#qrWalletFixture");
    const found = await WalletDetector.detectSources([{ text: `Bitcoin deposit address\n${BTC}`, type: "deposit-section", priority: 12 }, ...qr]);
    assert(found.length === 1, `Expected one merged wallet, found ${found.length}`);
    assert(found[0].evidenceItems.includes("Address appeared beside deposit QR code"), "Text and QR evidence did not merge");
  }],
  ["Evidence score explains points", async () => {
    const wallet = (await WalletDetector.detectSources([
      { text: `USDT\nSelected token: USDT\nSelected network: TRC20\nDeposit address\n${TRON}`, type: "deposit-section", priority: 12 },
      { text: `USDT TRC20 deposit\nQR code payload: tron:${TRON}`, type: "deposit-qr", priority: 24, evidenceItems: ["Address appeared beside deposit QR code"] }
    ]))[0];
    const score = WalletEvidenceScore.calculate({ ...wallet, seenCount: 2 });
    assert(score.score >= 70, `Expected strong evidence score, got ${score.score}`);
    assert(score.reasons.some(reason => /selected network/i.test(reason.label)), "Selected network reason missing");
    assert(score.reasons.some(reason => /QR/i.test(reason.label)), "QR reason missing");
    assert(score.methods.length >= 2, "Multiple detection methods were not preserved");
  }],
  ["Blockchain activity is only one score reason", () => {
    const score = WalletEvidenceScore.calculate({ evidenceItems: [], evidenceTags: [], detectionMethods: ["page"], seenCount: 1, verification: { status: "ACTIVE" } });
    assert(score.score === 27, `Unexpected activity-only score: ${score.score}`);
    assert(/not legitimacy/i.test(score.note), "Score disclaimer missing");
  }],
  ["Verification cache", () => {
    const now = Date.now();
    assert(BlockchainVerifier.cacheFresh({ cacheExpiresAt: new Date(now + 60_000).toISOString() }, now), "Fresh result was not cached");
    assert(!BlockchainVerifier.cacheFresh({ cacheExpiresAt: new Date(now - 1).toISOString() }, now), "Expired result was treated as fresh");
  }],
  ["Bitcoin verification normalization", async () => {
    const calls = [];
    const fetchImpl = async url => {
      calls.push(String(url));
      const payload = String(url).endsWith("/txs")
        ? [{ status: { block_time: 1_700_000_000 } }]
        : { chain_stats: { tx_count: 1, funded_txo_sum: 150_000_000, spent_txo_sum: 25_000_000 }, mempool_stats: { tx_count: 0, funded_txo_sum: 0, spent_txo_sum: 0 } };
      return { ok: true, json: async () => payload };
    };
    const record = { address: BTC, network: "Bitcoin (BTC)", domain: "private.example", context: "private page context" };
    const result = await BlockchainVerifier.verify(record, { fetchImpl, now: 1_800_000_000_000 });
    assert(result.status === "ACTIVE", `Expected ACTIVE, got ${result.status}`);
    assert(result.transactionCount === 1, "Transaction count missing");
    assert(result.balance.value === "1.25", `Unexpected balance ${result.balance.value}`);
    assert(!calls.join(" ").includes(record.domain) && !calls.join(" ").includes(record.context), "Private page data leaked into verification request");
  }],
  ["Prefer deposit evidence", async () => {
    const found = await WalletDetector.detectSources([
      { text: `Wallet ${EVM}`, type: "page-fallback", priority: 0 },
      { text: `USDT\nSelected network: ERC20\nDeposit address\n${EVM}`, type: "deposit-section", priority: 12 }
    ]);
    assert(found[0]?.network === "USDT (ERC20)", "Deposit classification did not win");
    assert(found[0]?.evidenceSource === "deposit-section", "Deposit evidence was not preserved");
  }],
  ["Duplicate merge", async () => {
    const pageA = { domain: "example.test", topPageUrl: "https://example.test/deposit", sourcePageUrl: "https://example.test/deposit", pageTitle: "Deposit" };
    const pageB = { ...pageA, topPageUrl: "https://example.test/fund", sourcePageUrl: "https://example.test/fund" };
    const weak = await expectNetwork(`Deposit wallet address\n${EVM}`, "EVM address (network uncertain)", "review");
    const strong = await expectNetwork(`USDT selected network: ERC20\nDeposit address\n${EVM}`, "USDT (ERC20)");
    let merged = WalletRecordStore.mergeSightings([], pageA, [weak], "2026-01-01T00:00:00.000Z", () => "test-id");
    merged = WalletRecordStore.mergeSightings(merged.records, pageB, [strong], "2026-01-01T00:01:00.000Z", () => "unused");
    const record = merged.records[0];
    assert(record.seenCount === 2, `Expected seenCount 2, got ${record.seenCount}`);
    assert(record.pageUrls.length === 2, `Expected 2 URLs, got ${record.pageUrls.length}`);
    assert(record.network === "USDT (ERC20)", "Stronger classification was not kept");
    assert(record.context.includes("USDT"), "Stronger evidence was not kept");
    assert(record.evidenceItems.some(item => item.includes("Selected network")), "Strong classification evidence was not preserved");
  }],
  ["Website grouping and session summary", () => {
    let id = 0;
    const makeId = () => `org-${++id}`;
    const wallet = { id: "wallet-1", address: BTC, domain: "example.test", network: "Bitcoin (BTC)", confidence: "high", seenCount: 3, foundAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:02:00.000Z", pageUrls: [] };
    let state = WalletOrganizationStore.migrate({}, [wallet], "2026-01-01T00:00:00.000Z", makeId);
    state = WalletOrganizationStore.applyPageScan(state, { domain: "example.test", topPageUrl: "https://example.test/home", pageTitle: "Home" }, "2026-01-01T00:01:00.000Z", makeId);
    state = WalletOrganizationStore.applyPageScan(state, { domain: "example.test", topPageUrl: "https://example.test/deposit", pageTitle: "Deposit" }, "2026-01-01T00:02:00.000Z", makeId);
    const summary = WalletOrganizationStore.websiteSummary(state.websiteRecords[0], [wallet], state.depositRecords);
    assert(summary.pagesObserved === 2, `Expected 2 grouped pages, got ${summary.pagesObserved}`);
    assert(summary.wallets === 1 && summary.totalDetections === 3, "Website wallet summary was incorrect");
  }],
  ["Separate deposit options preserved", () => {
    let id = 0;
    const makeId = () => `deposit-${++id}`;
    const page = { domain: "example.test", topPageUrl: "https://example.test/deposit", pageTitle: "Deposit" };
    let state = WalletOrganizationStore.applyDepositInterfaces({}, page, [
      { token: "USDT", network: "TRC20", depositLabels: ["Deposit Address"], detectionMethods: ["deposit-section"], confidence: "high" },
      { token: "USDT", network: "ERC20", depositLabels: ["Deposit Address"], detectionMethods: ["deposit-section"], confidence: "high" },
      { token: "BTC", network: "Bitcoin", depositLabels: ["Deposit Address"], detectionMethods: ["deposit-section"], confidence: "high" }
    ], "2026-01-01T00:00:00.000Z", makeId);
    assert(state.depositRecords.length === 3, `Expected 3 deposit options, got ${state.depositRecords.length}`);
    assert(new Set(state.depositRecords.map(record => `${record.token}|${record.network}`)).size === 3, "Deposit choices were collapsed");
  }],
  ["Text and QR strengthen one deposit record", () => {
    let id = 0;
    const makeId = () => `sighting-${++id}`;
    const page = { domain: "example.test", topPageUrl: "https://example.test/deposit", sourcePageUrl: "https://example.test/deposit", pageTitle: "Deposit" };
    const main = { id: "wallet-1", address: TRON, domain: "example.test", network: "USDT (TRC20)", confidence: "high", foundAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", pageUrls: [] };
    const text = { address: TRON, network: "USDT (TRC20)", confidence: "high", context: "USDT TRC20 Deposit Address", evidenceItems: ["Inside deposit/payment section"], detectionMethods: ["deposit-section"] };
    const qr = { ...text, evidenceItems: ["Address appeared beside deposit QR code"], detectionMethods: ["deposit-qr"] };
    let state = WalletOrganizationStore.applyWalletSightings({}, page, [text], [main], "2026-01-01T00:00:00.000Z", makeId);
    state = WalletOrganizationStore.applyWalletSightings(state, page, [qr], [main], "2026-01-01T00:01:00.000Z", makeId);
    assert(state.depositRecords.length === 1, "Text and QR created duplicate deposit records");
    assert(state.depositRecords[0].qrMatch, "QR match was not retained");
    assert(state.depositRecords[0].detectionMethods.includes("deposit-section") && state.depositRecords[0].detectionMethods.includes("deposit-qr"), "Detection methods were not merged");
    const walletEvents = state.evidenceEvents.filter(event => event.type === "WALLET_DETECTED");
    assert(walletEvents.length === 1 && walletEvents[0].occurrenceCount === 2, "Repeated timeline event was not smart-deduplicated");
  }],
  ["Notes labels and backup round trip", () => {
    const base = { websiteRecords: [{ id:"site-1", domain:"example.test", labels:[], notes:"", pageUrls:[], walletIds:[], depositRecordIds:[] }], depositRecords:[], evidenceEvents:[], settings:{} };
    const annotated = WalletOrganizationStore.updateAnnotation(base, "website", "site-1", "Review later", ["REVIEW", "CASE-7"]);
    const backup = WalletBackup.build({ ...annotated, walletRecords:[] }, "2026-01-01T00:00:00.000Z");
    const restored = WalletBackup.validate(backup);
    assert(restored.websiteRecords[0].notes === "Review later", "Notes were not backed up");
    assert(restored.settings.customLabels.includes("CASE-7"), "Custom label was not backed up");
    let rejected = false; try { WalletBackup.validate({ ...backup, schema:"wrong" }); } catch { rejected = true; }
    assert(rejected, "Invalid backup schema was accepted");
  }],
  ["Wallet Investigator export schema", () => {
    const wallet = { id:"wallet-1", address:TRON, domain:"example.test", network:"USDT (TRC20)", confidence:"high", context:"Original nearby text", foundAt:"2026-01-01T00:00:00.000Z", lastSeenAt:"2026-01-01T00:01:00.000Z", detectionMethods:["deposit-section"], notes:"Wallet note", labels:["VERIFIED"] };
    const deposit = { id:"deposit-1", walletId:"wallet-1", wallet:TRON, domain:"example.test", pageUrl:"https://example.test/deposit", pageTitle:"Deposit", token:"USDT", network:"TRC20", confidence:"high", nearbyEvidence:"Selected network: TRC20", detectionMethods:["deposit-section","deposit-qr"], evidenceItems:["Address appeared beside deposit QR code"], qrMatch:true, firstSeenAt:wallet.foundAt, lastSeenAt:wallet.lastSeenAt, notes:"Deposit note", labels:["REVIEW"] };
    const payload = WalletIntegrationExport.build({ walletRecords:[wallet], websiteRecords:[{ id:"site-1", domain:"example.test", notes:"Site note", labels:["NEW"] }], depositRecords:[deposit] }, "2026-01-01T00:02:00.000Z");
    assert(payload.schema === "wallet-investigator-import" && payload.schemaVersion === WalletIntegrationExport.SCHEMA_VERSION && payload.schemaVersion === "1.1.0", `Integration schema was not versioned (got ${payload.schemaVersion})`);
    assert(payload.records[0].context === deposit.nearbyEvidence, "Original deposit evidence was changed");
    assert(payload.records[0].qrEvidence.matched, "QR evidence was not exported");
  }],
  ["Dynamic insertion", dynamicInsertionTest]
];

async function runTests() {
  const results = document.querySelector("#results");
  const start = performance.now();
  results.innerHTML = "";
  let passed = 0;
  for (const [name, test] of tests) {
    const row = document.createElement("article");
    try {
      await test();
      passed += 1;
      row.className = "result pass";
      row.innerHTML = `<span class="icon">✓</span><strong>${name}</strong><span class="detail">Passed</span>`;
    } catch (error) {
      row.className = "result fail";
      row.innerHTML = `<span class="icon">✕</span><strong>${name}</strong><span class="detail"></span>`;
      row.querySelector(".detail").textContent = error.message;
    }
    results.append(row);
  }
  document.querySelector("#summary").textContent = `${passed}/${tests.length} tests passed`;
  document.querySelector("#timing").textContent = `${Math.round(performance.now() - start)} ms`;
}

document.querySelector("#runTests").addEventListener("click", runTests);
runTests();
