# CryptoWalletLogger v0.9 — "Wallet Discovery v2"

A Manifest V3 extension for Chrome/Edge (Chrome 111+). While an investigator browses normally, it finds wallet
addresses that the site legitimately exposed to the browser, works out **how the address is presented** (a place the
victim should send funds, a withdrawal field, documentation, transaction history, a token contract, …) and records
precise observations locally. Optionally it synchronises them to the Main Investigation Platform as
`wallet.observation` events (schema `2.0.0`, see `../../V4_CONTRACT.md` §1).

> The folder keeps its historical name `crypto-wallet-logger-v08` because launcher paths depend on it.

**Detection is not validation.** The logger's `formatCheck` (EIP-55, base58check, bech32/bech32m + witness rules,
Solana 32-byte length) is a quick pre-filter. Wallet Investigator validates authoritatively.

## The passive boundary

The extension only observes what the browser already received or rendered while the person navigates and interacts.
It never navigates, clicks, submits forms, fills fields, logs in, creates accounts, solves or bypasses CAPTCHA/MFA,
initiates transactions, sends crypto, crawls, issues requests, or alters requests/responses.

* **Network responses** are read from a *clone* of `fetch()` responses the page itself requested (text/JSON only,
  ≤ 1 MB, opaque and streaming responses skipped) and from finished `XMLHttpRequest`s (`load` listener). The wrappers
  call the original with the same `this`/arguments and return the very same promise/result; nothing is blocked,
  delayed or modified. Every inspection is inside `try/catch`.
* **Clipboard**: the string a page writes with `navigator.clipboard.writeText` is read before being passed on
  unchanged; `copy` events are read passively (selection + the `clipboardData` the page's own handler set).
* **Window config objects** are walked read-only (data properties only — getters are never invoked; size-capped).
* **Closed shadow roots** are read with `chrome.dom.openOrClosedShadowRoot` from the isolated world; the page's
  `attachShadow` is not wrapped and the root mode is never changed.
* **QR images** are copied onto a private canvas; the page canvas is never touched. Cross-origin (tainted) images are
  skipped. CSS background images are only decoded from `data:`/`blob:` URLs or URLs the page already loaded.
* Only the Main Platform sync (optional, user-configured) and the optional "Verify blockchain data" button make
  requests, both from the extension, never on the page's behalf.
* Known side effect: because the fetch wrapper observes the returned promise, an *unhandled* fetch rejection in page
  code no longer raises `unhandledrejection` (the rejection itself still reaches the page unchanged).

## What is observed

| Source | Detection method |
|---|---|
| Visible text, including content inserted later (MutationObserver) | `text`, `dynamic` |
| Modals / dialogs | `modal` |
| Tabs — the active panel, and inactive-but-present panels (recorded with a lower-confidence `hidden-panel` cue) | `text` (+ cue) |
| Form fields: value (`input`) and placeholder (`input`, *example* cue) | `input` |
| All `data-*`, `aria-*`, `title`, `alt`, `href`, `src` attributes | `attribute` |
| Copy controls (`data-clipboard-text`, `data-copy`, `data-clipboard-target`, …) and copy events / `writeText` | `copy-control`, `clipboard` |
| Open and closed Shadow DOM | `shadow-dom` |
| Same-origin and cross-origin frames (`all_frames`) | any; `page.frameUrl` is the frame |
| Payment URI links: `ethereum:` (EIP-681 incl. `@chainId` and ERC-20 `transfer`), `bitcoin:`, `litecoin:`, `dogecoin:`, `tron:`, `solana:` (Solana Pay `spl-token`), `xrp:`/`ripple:` | `uri-link` |
| QR codes in `<img>`, `<canvas>`, `<video>`, inline `<svg>`, CSS `background-image` (native `BarcodeDetector`, fallback vendored **jsQR**) | `qr` |
| Inline `<script>` text, `application/json` / `ld+json` scripts, page-defined `window` config objects | `script-config` |
| Text/JSON network responses the page fetched | `network-response` |

Families: `evm` (lowercase identity), `tron`, `bitcoin` (bech32 lowercase, base58 case preserved), `litecoin`,
`dogecoin`, `solana`, `xrp`. Wallet identity is `family:normalisedAddress` — the same wallet seen by several methods
on one page view is **one** observation whose `detection.methods` lists every method. The reported `address` is the
exact string exposed (an EIP-55 checksummed form is preferred over a lowercase QR payload of the same wallet).

Rejected: tx hashes and hex substrings of longer hex runs (boundary-anchored patterns), base58 strings failing
checksums, Solana-length base58 without wallet context or right after `signature:`/`hash:`-style labels.

### Context classes

`deposit | withdrawal | example | transaction_history | contract | unrelated | unknown`, with `confidence`, `cues`,
`negativeCues`, `section` (nearest heading / tab / modal title) and a ≤ 600-character `snippet`. The classifier
(`wallet-core.js → classifyContext`) scores words by zone (heading, label, local text, section text) *and*
structure:

* **deposit** — deposit / recharge / top up / fund your account / send only X to this address / minimum deposit /
  your deposit address / payment instructions; QR next to (or encoding) the address; copy button next to it;
  network selector; read-only field; payment URI; deposit/payment container.
* **withdrawal** — withdraw, "your wallet address", "enter your address", saved/whitelisted addresses, amount to
  withdraw, an editable input — especially one the user typed into. Withdrawal never counts as deposit: when
  withdrawal/example/contract/history evidence is close to the deposit evidence, the non-deposit class wins.
* **example** — e.g./example/sample/such as/looks like, `placeholder` attributes, code/pre blocks on documentation
  pages; zero/burn/placeholder addresses are forced to `example`; specification test vectors are an example cue.
* **transaction_history** — tables whose headers look like tx hash/date/amount/status/from/to, explorer `/tx/` links,
  history headings.
* **contract** — "contract"/"token address" labels, explorer `/token/` links, the token contract inside a payment URI,
  and a built-in list of major token contracts/mints (USDT/USDC on Ethereum, TRON, BSC, Polygon, Arbitrum, Optimism,
  Base, Avalanche, Solana; WETH, WBTC, DAI, BUSD, WBNB), which are always `contract`.
* **unrelated** — footer, navigation, blog/news sections.
* **Closest evidence wins.** Evidence about the address itself (its label, its own line or table cell, a copy button
  or QR/payment URI that belongs to it alone, its JSON key path) is weighed separately from evidence about the whole
  card or section. A strong non-deposit statement about the address ("Contract:", "TxID", "e.g.", "Withdrawal
  address", "Team wallet") beats a deposit heading shared by the card. Deposit wording found only in the wider section
  gives `unknown` when that section also shows other addresses. Weak deposit calls are capped at confidence 0.6.
* Mixed-case EVM addresses with a broken EIP-55 checksum are never `deposit` (wallets refuse them); Wallet
  Investigator makes the final validity call.
* For script/network data the **JSON key path** is the label (`depositAddress`, `payAddress`, `walletAddress` →
  deposit; `withdrawAddress`, `user.*`, `profile.*` → withdrawal; `contractAddress`, `token.*` → contract;
  `transactions[].from`, `txHash` → history) and is recorded as a cue (`key path: depositAddress`).

### Network hints

`networkHint = {network, token, source}` with canonical networks only (`TRC20`→`tron`, `ERC20`→`ethereum`,
`BEP20`/`BSC`/`BNB Smart Chain`→`bsc`, `Polygon`/`MATIC`→`polygon`, `Arbitrum`→`arbitrum`, `OP`/`Optimism`→`optimism`,
`Base`→`base`, `AVAX C-Chain`→`avalanche`, `SPL`→`solana`, EIP-681 `@chainId`). Sources by priority: `uri` /
`qr-uri` > `selected-option` (selected `<option>`, `aria-selected` tab, checked radio, `.active`) > `label` > `nearby-text`.
The logger never guesses between EVM networks: several networks listed without a selection → no network
(`negativeCues: multiple networks listed`); a label inconsistent with the address family → `network label mismatch`.
For EVM with only a token known, `network` is `null`.

## Events

Same transport as v0.8 (`POST <endpoint>`, `Idempotency-Key`, optional `Authorization: Bearer`). Envelope:
`{id, type, schemaVersion, occurredAt, source:"CryptoWalletLogger", sourceVersion:"0.9.0", payload}`.

* `wallet.observation` (`2.0.0`) — exactly the payload of contract §1. `observationId` =
  `sha256(family|normalisedAddress|pageUrl|method|contextClass)`, so replays dedupe; when context or methods improve
  (e.g. a hidden tab is opened, a QR confirms the address) an updated observation is sent. The envelope `id` hashes the
  payload without `firstSeen`/`lastSeen`/`seenCount`, so identical content is idempotent.
* `deposit_option.observed` (`1.0.0`) — still emitted for deposit-class sections (adds `canonicalNetwork`, `wallet`,
  `contextClass`).
* v0.8 `wallet.observed` / `evidence.added` for wallets are only sent if `settings.mainPlatform.legacyWalletEvents`
  is `true` (for an older Main).

Queue fixes in v0.9: all queue writes are serialised (an enqueue during a drain can no longer be overwritten by the
drain's stale snapshot), the drain loops until no eligible item remains (an item enqueued mid-drain is delivered in
the same drain instead of waiting for the next enqueue), and HTTP 400/409/413/415/422 rejections move to
`mainPlatformSyncRejected` instead of blocking the queue head forever.

## Install

1. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Optional: **All findings → Configure** to set the Main Platform endpoint and API key.

The popup, website, wallet and deposit views work as in v0.8; wallet cards/details now also show the **context
class** (with confidence, cues and negative cues), the **detection method(s)**, the address family, network hint and
the logger's format check.

## Files

* `wallet-core.js` — UMD core shared by the service worker, the isolated content script, the MAIN-world hook and Node:
  SHA-256 and Keccak-256 (own implementations), validators, extraction, payment URIs, network hints, context
  classifier, JSON/script scanning, observation ids.
* `main-world/wallet-core.js` — **byte-identical copy** used by the MAIN-world entry. Chrome injects a given script
  file only once per frame even across worlds, so each world needs its own path. After editing the core run
  `cp wallet-core.js main-world/wallet-core.js`; `node --test` fails if they differ.
* `page-hook.js` — MAIN world, `document_start`: passive fetch/XHR/clipboard readers and window-config scan; posts
  findings over `window.postMessage` using a per-page random channel id exchanged at `document_start`; the isolated
  side validates every message strictly and re-validates every address.
* `content.js` — isolated world, `document_start`, all frames: DOM scanning, context building, aggregation, reporting.
* `qr-scanner.js` + `vendor/jsQR.js` (cozmo/jsQR 1.4.0, Apache-2.0, `vendor/jsQR.LICENSE`).
* `detector.js` — the v0.8 detector, kept only for the legacy in-extension test page (`tests/test-page.html`).

## Tests

Run from this folder (or run `node scripts/run-tests.mjs wallet-pipeline` from Main's folder, which runs these plus the
Main ↔ Wallet Investigator ↔ Form Submitter pipeline tests):

```sh
# Unit tests (wallet-core vectors, URIs, hints, classifier, context precision, JSON scanning, sync queue)
node --test tests/wallet-core.test.js tests/sync-queue.test.js tests/context-precision.test.js

# Real-extension browser test (Playwright + Chromium, own fixtures, local capture server)
python tests/browser_extension_test.py
```
(List the files explicitly: `cmd.exe` does not expand `tests/*.test.js`.)

The browser test loads this folder as an unpacked extension (`launch_persistent_context(..., headless=True,
channel="chromium", args=["--disable-extensions-except=DIR", "--load-extension=DIR", "--host-resolver-rules=MAP *.test
127.0.0.1"])`), sets `settings.mainPlatform` through the service worker to a local capture server, serves generated
fixture pages on `http://site.test:<port>/` (deposit text, dynamic insertion after a click, modal, tabs, read-only
input, copy button + `writeText`, open + closed shadow DOM, iframe, fetch/XHR JSON, inline script config, QR PNG +
SVG, withdrawal form, API docs, tx table, contract labels), drives normal clicks/typing and asserts every captured
`wallet.observation` (classes, methods, hints, case-preserved addresses, no tx-hash/contract/example/withdrawal false
deposits, one identity per wallet, contract §1 shape and ids, no extension-initiated page requests, page behaviour
unchanged). It also opens the history/details pages and the legacy `tests/test-page.html` suite. QR fixtures are
generated with the vendored `tests/tools/qrcodegen.py` (Project Nayuki, MIT). `CWL_DUMP=events.json` writes all
captured envelopes; `CWL_KEEP=1` keeps the temporary profile and fixture site.

The legacy page (**All findings → Tools → Test detector**) still runs the v0.8 detector/store/score/backup checks.

## Known limitations

* Cross-origin images that taint the canvas cannot be QR-decoded; video QR codes rely on `BarcodeDetector`.
* Cross-origin iframes are scanned, but the network/config hook only sees requests made by the frame it runs in;
  `fetch` inside workers/service workers of the page, WebSockets, EventSource and `navigator.clipboard.write()` with
  `ClipboardItem`s are not observed.
* Context classification is heuristic (English wording plus structure); unusual layouts or other languages fall back
  to structural cues and may yield `unknown`.
* Inline-script key paths for non-JSON JavaScript are approximate.
* Addresses split across sibling block elements, or rendered only as images of text, are not reconstructed.
* The postMessage channel id is visible to page `message` listeners once findings are posted; a hostile page could
  forge findings for its own page (every address is re-validated; such data was already the page's to show).
* XRP X-addresses, Bitcoin Cash/CashAddr and other chains are not extracted.

## Optional blockchain verification

Unchanged from v0.8: nothing is queried automatically. **Verify** sends only the wallet address to the named public
provider (Blockstream, BlockCypher, public ETH/BSC RPC, TRONGrid, XRPL, Solana RPC); page URLs, text and browsing data
are never included. Activity states: ACTIVE, NO ACTIVITY FOUND, UNKNOWN, VERIFICATION FAILED. Activity does not prove
legitimacy or maliciousness; the 0–100 evidence score measures detection strength only (a non-deposit context class
now subtracts points).

The Wallet Investigator export (`wallet-investigator-import`, schema `1.1.0`) and the validated backup/restore are
unchanged apart from `sourceVersion`/`appVersion` 0.9.0.
