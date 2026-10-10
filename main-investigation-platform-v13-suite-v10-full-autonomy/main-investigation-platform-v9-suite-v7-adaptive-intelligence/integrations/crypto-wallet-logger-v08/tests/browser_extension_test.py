#!/usr/bin/env python3
"""
CryptoWalletLogger v0.9 — real-extension browser test (Playwright, Chromium).

Loads the unpacked extension from this folder, points Main Platform sync at a local capture server, serves our own
fixture pages (generated below — NOT the shared benchmark), drives normal user interactions (clicks, typing into a
field) and asserts the captured `wallet.observation` (schemaVersion 2.0.0) events.

Run:
    /home/claude/h/venv/bin/python tests/browser_extension_test.py           # exit code 0 = pass
    CWL_KEEP=1 ... keeps the temp profile/fixtures and prints their paths
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT_DIR = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # Chrome refuses extension folders containing "_"-prefixed names such as __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
from qrcodegen import QrCode  # noqa: E402  (vendored, MIT — Project Nayuki)

# Own fixture addresses (valid encodings generated for this test; none are specification vectors).
A = {
    "TRON_A": "TJaZcuzVrGW5J4oPsk38fYY45GLsmHSvvm",
    "TRON_B": "TCiqjWoposQ2aMSvHzhzApA419grPVneG8",
    "TRON_C": "TDvuwSwB6pQguD5t6ixdAgf8DJ6q6f2kpJ",
    "TRON_SAVED": "TSohZTTxiain6wBPTeP22SZfSwoBzw74ui",
    "TRON_DOC": "TWSEQ2w143Quf98p2Xe1pvxRApkjb1c67i",
    "BTC_MODAL": "bc1q6mp6fws8hz93f9auc6mra73aus5g37j2479cwj",
    "BTC_QR": "bc1q4u5755w4fdczqrg8cpfrgl726npqmre0an2axt",
    "BTC_XHR": "bc1p4rns0uljru7xwn2px08qwn86al9ddwtgfsy86w0rqqgcrpy9wccsmvyzrf",
    "BTC_CFG": "bc1qwcahxel8n8z9kufaf4p5k6cs839da9d4y4h543",
    "LTC_A": "LTb9LFP2Aj67KKq4gdzxj8ifcG4aaVTDsz",
    "DOGE_A": "DQgzTvj8Az4EdWannkmuDNvw8ebDmk5xY2",
    "XRP_A": "rpXafmRWt74NEWdguURrADSYS5sPCU2X4C",
    "SOL_A": "E19gn1h1daBsatYktZZxJLRCEiRZzj7UnwGhk8Tg1oVH",
    "EVM_FOOTER": "0xEe0a57c30Ac28637F028BC18fFb14d4F1CD277C9",
    "EVM_DYN": "0x2901010e2B2f3866cb63909bAFCE3eD21Da531d3",
    "EVM_TAB": "0x9d90129271B1adb1809F76c3FA56e2C5b0008e7b",
    "EVM_CLOSED": "0x664BB16cC083947E779FC431CCB1c070C5F763D8",
    "EVM_FETCH": "0x4979AF8C33b86b3D4074438c8d18dd4664239234",
    "EVM_WD": "0xe41938083FBbb5Ce9Bb54bB346E995d02b9C4162",
    "EVM_TXFROM": "0xfa8A8D3e452f627D6f737F335cfD059b157ca8E4",
    "EVM_JSON": "0x7E426dF8Fca3Abc2390AB9c8CD3A91fe55165B42",
    "EVM_QR": "0xF306E535e6aFDDd17858a1b83e21581A909Ea1A1",
    "EVM_USER": "0x11c878a658eaf0E017B3944b3ac20E832E179E70",
    "EVM_DOC": "0x3A982Ac9CC52Bf298EEC66F7571badAe65ef86B3",
    "EVM_PH": "0x4709F2d76A1255fB92e2d184415c6cb62c4EfBB4",
    "EVM_H1": "0xAb307aFa70482356A1A212dE930018267116c95d",
    "EVM_H2": "0x80E4D5eBC09aFd35dd65C4a28494D21D1E1486Fe",
    "EVM_TOKEN": "0x2CC7E2F20DB7875b0Bd534794B0e12C9BC738864",
}
# Context-precision fixtures (fp/ pages): realistic pages that mix one real deposit address with decoys.
A.update({
    "FP_DEP1": "0xbca55675025082730C7b1DfA310c5251099897d1",
    "FP_DEP2": "0x5daB9b4c3337Ab2F3E54F58B31918dE9727C821f",
    "FP_DEP3": "0xE4Ad1E1998Be58Db252f12B1aa4436EEB3326c3b",
    "FP_DEP4": "0x04081D130B6E0E948f6A658cf39617B68Ba38AED",
    "FP_DEP5": "0x4DdC9983798b24893b652A0d515be8002758BBb8",
    "FP_DEP6": "0x696d301D9b7b00Bad67A83Dd68bA4836cb2ca1c7",
    "FP_DEP7": "0x34e891Cb7336aF376AF99a47DcD39c41D71276b2",
    "FP_TDEP1": "TNxU58azektgedLxLywNVnRB5oD8CULL3X",
    "FP_TDEP2": "TSdhipdK93t2adKRcFfccVY5JqDopBQAAT",
    "FP_BDEP1": "1237KVFxRLn4iqXXSiB6ETDDxytH14Dmyz",
    "FP_BDEP2": "114kvmhckYkaK7wyLq2r2Ubd6CqS9oQ2Nm",
    "FP_CON1": "0xFD69EFCB922a02734Eb2417fd0C527633FfF7241",
    "FP_CON2": "0x71d32E91531eBD6513D6A473E6f8848f32aD2448",
    "FP_CON3": "0xCbD12a57fa031d68001DaeF9da8C6aBAec233878",
    "FP_TCON1": "TCuXhE6BPmkBM1FGLrxBTag6e5PsthVeGr",
    "FP_EX1": "0xacFFA2cA4F4325B5119EC41f0F50D0BD2F14Dbe8",
    "FP_EX2": "0x8a34164e3CF928A786BB013ab5627DaD9282f467",
    "FP_EX3": "0xF158227A54D0EC9299193484293028CaCDbb3C5B",
    "FP_TEX1": "TJ5eeFfuQegBGBFpLk3eiSzMMUcjRuRx6u",
    "FP_BEX1": "1KDMS7ecPiuSwcjNc1XU8qHMR2zgbzNx9F",
    "FP_H1": "0x1C0728453c74Bf02EcBBFb3c54238637ccfc3fe6",
    "FP_H2": "0x8014985Ee82291e461814fe40e6251AA3F990847",
    "FP_H3": "0x0876380fb48cB522aDcb667119D2875e4548762E",
    "FP_H4": "0x932b17C26583bC70806Fc44D5CAB85eFFE4bCceb",
    "FP_H5": "0xB4D7fe5893346410984bD6Aec1c8A3B0848555a1",
    "FP_TH1": "TMaCNsTb4ik6nWGk3mDsjSBj6LNnffLGRB",
    "FP_TH2": "TBfqU4ToXNaM8U5j2nPiewVbikw8k7y99G",
    "FP_WD1": "0xA456d5892033F34dAc181E7eD46a04d700e65F9F",
    "FP_WD2": "0x8BC3dE01FE64A13e799f07781862714c0DE83151",
    "FP_WD3": "0x2b5cba0F0b5F379e57cBc8372Ac34Ecc4D61bB4a",
    "FP_TWD1": "TNpkDBLMb63AG4MZxChDy1Rv81j5KUS94r",
    "FP_WD4": "0x276c7f14Ebf86b7d8aaaae59ba09459C66528d9a",
    "FP_UN1": "0xbb70660f92fefb13E8Bd04651A7B18802A2BeD16",
    "FP_UN2": "0x2181a15774B7fa724b4Bb96971c13f0263b25433",
    "FP_UN3": "0xABb41e808C760FABDbDe7612BDA945Fa09D0c40a",
    "FP_UN4": "0x2731a5D488cA3623479B4F6fC84d97cCaBFaE617",
    "FP_UN5": "0x5228f03171F3bEfC921d35dbAaeBd95bf88f07A5",
    "FP_TUN1": "TEFrCEgi1n4j1K6DWhubNq3xo51tt6Wjcb",
    "FP_TXL": "0xeA4F6df7b79587785C037F59579842DFC60aF3E0",
    # malformed: EIP-55 checksum broken by one case flip; bech32 with a wrong final character
    "FP_MAL1": "0x5B52f2b633935C0d34F3B8101ab111dF1c0EBDC7",
    "FP_MAL2": "bc1q6mp6fws8hz93f9auc6mra73aus5g37j2479cwk",
})
USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
TX1 = "0x" + hashlib.sha256(b"cwl-tx-1").hexdigest()
TX2 = "0x" + hashlib.sha256(b"cwl-tx-2").hexdigest()
EVM_NETWORKS = ["ethereum", "bsc", "polygon", "arbitrum", "optimism", "base", "avalanche"]


def fill(template: str) -> str:
    for key, value in {**A, "USDT_ETH": USDT_ETH, "TX1": TX1, "TX2": TX2}.items():
        template = template.replace("{{" + key + "}}", value)
    assert "{{" not in template, template
    return template


def page_html(title: str, body: str) -> str:
    return fill(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>'
                '<style>body{font-family:sans-serif;margin:24px} .modal{border:1px solid #888;padding:12px}</style></head>'
                f'<body>{body}</body></html>')


# ----------------------------------------------------------------------------- QR fixtures

def qr_matrix(text: str):
    qr = QrCode.encode_text(text, QrCode.Ecc.MEDIUM)
    return qr, qr.get_size()


def qr_png(text: str, scale: int = 6, border: int = 4) -> bytes:
    qr, size = qr_matrix(text)
    width = (size + 2 * border) * scale
    rows = []
    for y in range(width):
        row = bytearray([0])
        for x in range(width):
            mx, my = x // scale - border, y // scale - border
            dark = 0 <= mx < size and 0 <= my < size and qr.get_module(mx, my)
            row.append(0 if dark else 255)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, width, 8, 0, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def qr_svg(text: str, border: int = 4) -> str:
    qr, size = qr_matrix(text)
    parts = [f"M{x + border},{y + border}h1v1h-1z" for y in range(size) for x in range(size) if qr.get_module(x, y)]
    dim = size + 2 * border
    return (f'<svg xmlns="http://www.w3.org/2000/svg" class="qr" width="220" height="220" viewBox="0 0 {dim} {dim}" '
            f'shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/>'
            f'<path d="{" ".join(parts)}" fill="#000000"/></svg>')


# ----------------------------------------------------------------------------- fixture site

FIXTURES = {
    "deposit-text.html": page_html("Deposit — Fixture Exchange", """
<nav><a href="#">Markets</a> · <a href="#">Deposit</a> · <a href="#">Withdraw</a></nav>
<main><section class="deposit-panel">
  <h1>Deposit USDT</h1>
  <div role="tablist" aria-label="Network"><button role="tab" aria-selected="true">TRC20</button> <button role="tab" aria-selected="false">ERC20</button></div>
  <p>Your deposit address</p>
  <div class="address-row"><span class="addr">{{TRON_A}}</span> <button class="copy-btn" type="button">Copy</button></div>
  <p>Send only USDT (TRC20) to this address. Minimum deposit: 10 USDT.</p>
</section></main>
<footer><p>Contact our partnerships team: {{EVM_FOOTER}}</p><p>© 2026 Fixture Exchange. All rights reserved.</p></footer>"""),

    "dynamic.html": page_html("Wallet", """
<h1>Wallet</h1><p>Fund your account to start trading.</p>
<button id="show">Show deposit address</button><div id="slot"></div>
<script>
document.getElementById('show').addEventListener('click', () => setTimeout(() => {
  document.getElementById('slot').innerHTML = '<section class="deposit-box"><h2>Deposit USDT</h2>' +
    '<label>Network <select><option>ERC20</option><option selected>BEP20</option></select></label>' +
    '<p>Deposit address: <code>{{EVM_DYN}}</code></p><p>Send only USDT (BEP20) to this address.</p></section>';
}, 300));
</script>"""),

    "modal.html": page_html("Account", """
<h1>Account</h1><p>Balance: 0.00 BTC</p><button id="open-deposit">Deposit BTC</button>
<div id="dlg" class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" style="display:none">
  <h2 id="dlg-title">Deposit Bitcoin</h2>
  <p>Send BTC to this address:</p>
  <p><span class="addr">{{BTC_MODAL}}</span> <button class="copy">Copy address</button></p>
  <p>Deposits are credited after 2 network confirmations.</p>
</div>
<script>document.getElementById('open-deposit').onclick = () => { document.getElementById('dlg').style.display = 'block'; };</script>"""),

    "tabs.html": page_html("Deposit", """
<h1>Deposit USDT</h1>
<div role="tablist" aria-label="Choose network">
  <button role="tab" id="tab-trc20" aria-selected="true" aria-controls="panel-trc20">TRC20</button>
  <button role="tab" id="tab-erc20" aria-selected="false" aria-controls="panel-erc20">ERC20</button>
</div>
<div role="tabpanel" id="panel-trc20" aria-labelledby="tab-trc20"><p>Deposit address</p><code>{{TRON_B}}</code> <button class="copy">Copy</button></div>
<div role="tabpanel" id="panel-erc20" aria-labelledby="tab-erc20" hidden><p>Deposit address</p><code>{{EVM_TAB}}</code> <button class="copy">Copy</button></div>
<script>
for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => {
  for (const t of document.querySelectorAll('[role=tab]')) { const on = t === tab; t.setAttribute('aria-selected', String(on)); document.getElementById(t.getAttribute('aria-controls')).hidden = !on; }
});
</script>"""),

    "input.html": page_html("Deposit LTC", """
<form class="deposit-form" onsubmit="return false"><h2>Deposit Litecoin</h2>
  <label for="addr">Your LTC deposit address</label>
  <input id="addr" readonly value="{{LTC_A}}" size="44"> <button type="button" class="copy">Copy</button>
  <p>Send only LTC to this address.</p></form>"""),

    "copy.html": page_html("Deposit", """
<section class="deposit"><h2>Deposit DOGE</h2><p>Deposit address: <span class="short">DQgz…k5xY2</span></p>
  <button id="copy-doge" data-clipboard-text="{{DOGE_A}}">Copy address</button></section>
<section class="deposit"><h2>Deposit XRP</h2><p>Deposit address: <span>rpXa…U2X4C</span> · Destination tag: 5521</p>
  <button id="copy-xrp">Copy address</button></section>
<script>
document.getElementById('copy-doge').addEventListener('click', event => {
  const value = event.currentTarget.dataset.clipboardText;
  document.addEventListener('copy', copyEvent => { copyEvent.clipboardData.setData('text/plain', value); copyEvent.preventDefault(); }, { once: true });
  document.execCommand('copy');
});
document.getElementById('copy-xrp').addEventListener('click', () => { navigator.clipboard.writeText('{{XRP_A}}').catch(() => {}); });
</script>"""),

    "shadow.html": page_html("Crypto deposit", """
<h1>Crypto deposit</h1>
<deposit-widget id="open-host"></deposit-widget>
<secure-deposit id="closed-host"></secure-deposit>
<script>
customElements.define('deposit-widget', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'open' });
  root.innerHTML = '<section class="deposit"><h2>Deposit SOL</h2><p>Your Solana deposit address</p><code>{{SOL_A}}</code> <button>Copy</button></section>'; } });
customElements.define('secure-deposit', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<section class="deposit"><h2>Deposit USDT (ERC20)</h2><p>Deposit address</p><code>{{EVM_CLOSED}}</code> <button>Copy</button></section>'; } });
window.__closedModeKept = document.getElementById('closed-host').shadowRoot === null;
</script>"""),

    "iframe.html": page_html("Checkout", """
<h1>Checkout</h1><p>Complete your payment below.</p>
<iframe src="/frame.html" width="640" height="260" title="payment"></iframe>"""),

    "frame.html": page_html("Payment frame", """
<section class="payment"><h2>Pay with USDT (TRC20)</h2><p>Send exactly 50 USDT to the following address:</p>
<p class="addr">{{TRON_C}}</p><button>Copy</button></section>"""),

    "fetch.html": page_html("Dashboard", """
<h1>Dashboard</h1><p id="balance">Loading…</p>
<script>
const pending = fetch('/api/account.json');
window.__fetchIsPromise = pending instanceof Promise;
pending.then(r => r.json()).then(d => { document.getElementById('balance').textContent = 'Balance: ' + d.balance + ' USDT'; window.__fetchBody = d; });
const xhr = new XMLHttpRequest(); xhr.open('GET', '/api/pay.json'); xhr.onload = () => { window.__xhrStatus = xhr.status; window.__xhrText = xhr.responseText.length; }; xhr.send();
</script>"""),

    "config.html": page_html("Checkout", """
<h1>Checkout</h1>
<script>window.__APP_CONFIG__ = { theme: "dark", payment: { payAddress: "{{BTC_CFG}}", network: "bitcoin" } };</script>
<script type="application/json" id="boot">{"checkout":{"receivingAddress":"{{EVM_JSON}}","chainId":137}}</script>
<p>Loading payment…</p>"""),

    "qr.html": page_html("Deposit", """
<section class="deposit"><h2>Deposit Bitcoin</h2><p>Scan the QR code with your wallet to deposit.</p>
  <img id="qr-btc" class="qr" src="/qr-btc.png" width="220" height="220" alt="Deposit QR code"></section>
<section class="deposit"><h2>Deposit USDT (BEP20)</h2><p>Deposit address: {{EVM_QR}}</p><div class="qr-box">__SVG__</div><button>Copy</button></section>"""),

    "withdraw.html": page_html("Withdraw", """
<form class="withdraw-form" onsubmit="return false"><h1>Withdraw USDT</h1>
  <label for="net">Network</label> <select id="net"><option>TRC20</option><option selected>BEP20</option></select><br>
  <label for="wallet">Your wallet address</label> <input id="wallet" type="text" size="50" placeholder="Enter your wallet address"><br>
  <label for="saved">Saved address</label> <input id="saved" type="text" size="50" value="{{TRON_SAVED}}"><br>
  <label for="amount">Amount to withdraw</label> <input id="amount" type="number"><br>
  <button type="button">Withdraw</button></form>"""),

    "docs/api.html": page_html("API reference", """
<article class="docs"><h1>API reference: create payout</h1>
<p>Request body example:</p>
<pre><code>{"address": "{{EVM_DOC}}", "amount": "10"}</code></pre>
<p>TRON addresses look like {{TRON_DOC}} (e.g. for TRC20 tokens).</p>
<label>Recipient <input placeholder="{{EVM_PH}}" size="50"></label></article>"""),

    "history.html": page_html("History", """
<h1>Transaction history</h1>
<table><thead><tr><th>Date</th><th>Tx Hash</th><th>From</th><th>To</th><th>Amount</th><th>Status</th></tr></thead>
<tbody>
<tr><td>2026-09-01</td><td><a href="https://etherscan.io/tx/{{TX1}}">{{TX1}}</a></td><td>{{EVM_H1}}</td><td>{{EVM_H2}}</td><td>120 USDT</td><td>Completed</td></tr>
<tr><td>2026-09-02</td><td><a href="https://etherscan.io/tx/{{TX2}}">{{TX2}}</a></td><td>{{EVM_H2}}</td><td>{{EVM_H1}}</td><td>5 USDT</td><td>Pending</td></tr>
</tbody></table>"""),

    "contract.html": page_html("Token", """
<h1>About our token</h1>
<p>USDT contract address: <code>{{USDT_ETH}}</code></p>
<p>Token address: <a href="https://etherscan.io/token/{{EVM_TOKEN}}">{{EVM_TOKEN}}</a></p>"""),
}

# ----------------------------------------------------------------------------- context-precision fixtures
# Each page mixes real deposit addresses with decoys the way real exchange / scam / help / explorer pages do.
# FP_EXPECT: (address key, page, acceptable classes). Decoys must never be emitted as "deposit" in any observation.

FP_FIXTURES = {
    "fp/exchange-deposit.html": page_html("Deposit Crypto | FixtureX", """
<header><nav><a href="/markets">Markets</a> <a href="#">Deposit</a> <a href="#">Withdraw</a> <a href="#">History</a></nav></header>
<main class="page deposit-page">
  <h1>Deposit Crypto</h1>
  <div class="deposit-layout">
    <div class="step"><span>1</span> Select coin <select><option selected>USDT</option><option>BTC</option></select></div>
    <div class="step"><span>2</span> Select network <select><option selected>ERC20</option><option>TRC20</option><option>BEP20</option></select></div>
    <div class="step address-card">
      <div class="label">Deposit Address</div>
      <div class="addr-row"><span class="addr">{{FP_DEP1}}</span><button class="btn-copy" aria-label="Copy">Copy</button></div>
      <svg class="qr-code" width="120" height="120"><rect width="120" height="120" fill="#eee"/></svg>
      <ul class="tips"><li>Send only USDT to this deposit address.</li><li>Minimum deposit: 10 USDT. Deposits are credited after 12 confirmations.</li></ul>
      <div class="contract-info"><span class="k">Contract Information</span>
        <span class="v">ending in <a href="https://etherscan.io/token/{{FP_CON1}}">{{FP_CON1}}</a></span></div>
    </div>
  </div>
  <section class="recent-deposits"><h2>Recent Deposits</h2>
    <table><thead><tr><th>Time</th><th>Coin</th><th>Amount</th><th>Address</th><th>TxID</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>2026-09-21 10:12</td><td>USDT</td><td>250</td><td>{{FP_H1}}</td><td><a href="https://etherscan.io/tx/{{TX1}}">0x5e1f…a91c</a></td><td>Completed</td></tr>
      <tr><td>2026-09-18 08:40</td><td>USDT</td><td>40</td><td>{{FP_H2}}</td><td><a href="https://etherscan.io/tx/{{TX2}}">0x77ab…0e12</a></td><td>Completed</td></tr>
    </tbody></table>
  </section>
  <section class="faq"><h2>FAQ</h2>
    <details open><summary>What does an ERC20 deposit address look like?</summary>
      <p>An ERC20 address starts with 0x and has 42 characters, for example {{FP_EX1}}.</p></details>
    <details open><summary>I sent to the wrong network</summary><p>Contact support with your TxID.</p></details>
  </section>
</main>
<footer class="site-footer"><p>Official partners: {{FP_UN1}}</p><p>© 2026 FixtureX</p></footer>"""),

    "fp/div-history.html": page_html("Assets", """
<div id="root"><div class="app deposit-page">
  <div class="panel deposit-box"><h2>Deposit USDT</h2>
    <div class="network-tabs"><button class="active">TRC20</button><button>ERC20</button></div>
    <p class="hint">Your USDT-TRC20 deposit address</p>
    <div class="address"><span>{{FP_TDEP1}}</span> <span class="copy-icon" title="Copy">⧉</span></div>
  </div>
  <div class="panel records"><div class="records-title">Deposit Records</div>
    <div class="record-item"><div class="col time">2026-09-12 14:03:22</div><div class="col amount">+250 USDT</div>
      <div class="col from">From <span>{{FP_TH1}}</span> <i class="copy-icon" title="Copy">⧉</i></div><div class="col status">Completed</div></div>
    <div class="record-item"><div class="col time">2026-09-10 09:41:07</div><div class="col amount">+100 USDT</div>
      <div class="col from">From <span>{{FP_TH2}}</span> <i class="copy-icon" title="Copy">⧉</i></div><div class="col status">Completed</div></div>
  </div>
</div></div>"""),

    "fp/wallet-tabs.html": page_html("Wallet", """
<main><h1>USDT Wallet</h1>
  <div class="tabs"><a class="tab active" href="#d">Deposit</a><a class="tab" href="#w">Withdraw</a></div>
  <div class="tab-content">
    <div class="tab-pane active" id="d"><div class="box"><p>ERC20 deposit address</p><p class="mono">{{FP_DEP2}}</p><button class="copy">Copy</button>
      <p>Send only USDT to this address.</p></div></div>
    <div class="tab-pane" id="w" style="display:none">
      <div class="form-row"><label for="wd-addr">Withdrawal address</label><input id="wd-addr" class="form-control" value="{{FP_WD1}}"></div>
      <div class="form-row"><label for="wd-amt">Amount</label><input id="wd-amt" type="number"></div>
      <button>Submit</button></div>
  </div>
  <section class="refund"><h3>Refund details</h3><label>Refund address (if the payment fails) <input id="refund" class="form-control" placeholder="0x…"></label></section>
</main>"""),

    "fp/send.html": page_html("Send", """
<main class="wallet-app"><div class="card"><h2>Send USDT</h2>
  <div class="field"><div class="field-label">Recipient address</div><input id="to" type="text" autocomplete="off"></div>
  <div class="field"><div class="field-label">Amount</div><input id="amt" type="text"></div>
  <p class="note">Network fee ≈ 1 USDT</p><button>Continue</button></div>
  <div class="card"><h2>Address book</h2><ul><li>Ledger · <span>{{FP_WD3}}</span></li></ul></div>
</main>"""),

    "fp/token.html": page_html("$FROGX — the next 100x", """
<header class="hero"><h1>$FROGX</h1><p>The most viral frog on Ethereum.</p></header>
<main>
  <section class="ca-box"><div class="ca"><b>CA:</b> <span id="ca">{{FP_CON2}}</span> <button class="copy-btn" data-clipboard-target="#ca">Copy</button></div>
    <a href="https://app.uniswap.org/swap?outputCurrency={{FP_CON2}}">Buy on Uniswap</a></section>
  <section class="presale"><h2>Presale is live</h2><p>Send ETH to the presale wallet below. Tokens are airdropped after the presale ends.</p>
    <p class="addr">{{FP_DEP3}}</p><button class="copy">Copy address</button><p>Min 0.1 ETH · Max 5 ETH</p></section>
  <section class="tokenomics"><h2>Tokenomics</h2><ul>
    <li>Total supply: 420,690,000,000</li><li>Liquidity pool: <span>{{FP_CON3}}</span></li>
    <li>Team wallet: {{FP_UN2}}</li><li>Marketing wallet: {{FP_UN3}}</li></ul></section>
</main>"""),

    "fp/help/how-to-deposit.html": page_html("How to deposit crypto – Help Center", """
<article class="help-article"><h1>How to deposit crypto</h1>
<ol><li>Open <b>Wallet → Deposit</b> and choose the coin and network.</li>
<li>Copy your deposit address. An ERC20 address looks like {{FP_EX2}}; a TRC20 address looks like {{FP_TEX1}}.</li>
<li>Paste it into the withdrawal page of the sending platform.</li></ol>
<figure class="screenshot"><div class="mock deposit-box"><div>Deposit address</div><div>{{FP_EX3}}</div><button>Copy</button></div>
<figcaption>Sample deposit screen</figcaption></figure>
<p>Bitcoin legacy addresses start with 1, e.g. {{FP_BEX1}}.</p>
</article>"""),

    "fp/explorer.html": page_html("Address 0x2731…E617 | FixtureScan", """
<main><h1>Address <span class="hash">{{FP_UN4}}</span></h1>
<div class="overview"><div>Balance: 1.204 ETH</div><div>Transactions: 2</div></div>
<table class="txs"><thead><tr><th>Txn Hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th></th><th>To</th><th>Value</th></tr></thead>
<tbody>
<tr><td><a href="/tx/{{TX1}}">0x5e1f…</a></td><td>Transfer</td><td>20831234</td><td>3 days ago</td><td><a href="/address/{{FP_H3}}">{{FP_H3}}</a></td><td>IN</td><td>{{FP_UN4}}</td><td>0.5 ETH</td></tr>
<tr><td><a href="/tx/{{TX2}}">0x77ab…</a></td><td>Transfer</td><td>20830001</td><td>4 days ago</td><td>{{FP_UN4}}</td><td>OUT</td><td><a href="/address/{{FP_H4}}">{{FP_H4}}</a></td><td>0.2 ETH</td></tr>
</tbody></table></main>"""),

    "fp/scam-report.html": page_html("Report a crypto scam", """
<main><h1>Report a crypto scam</h1>
<form onsubmit="return false"><label for="scam">Scam wallet address</label><input id="scam" size="50">
<label for="site">Website</label><input id="site"><button>Report</button></form>
<section class="recent"><h2>Recently reported addresses</h2><ul>
<li><span>{{FP_UN5}}</span> — fake exchange, 14 reports</li><li><span>{{FP_TUN1}}</span> — investment scam, 9 reports</li></ul></section>
</main>"""),

    "fp/malformed.html": page_html("Deposit", """
<section class="deposit"><h2>Deposit ETH</h2><p>Deposit address</p><p class="addr">{{FP_MAL1}}</p><button class="copy">Copy</button>
<p>Send only ETH to this address.</p></section>
<section class="deposit"><h2>Deposit BTC</h2><p>Deposit address: <code>{{FP_MAL2}}</code></p><button class="copy">Copy</button></section>"""),

    "fp/invoice.html": page_html("Checkout – FixturePay", """
<div class="checkout"><div class="merchant">Paying <b>LuxTrade Ltd</b></div>
<h2>Pay 120 USDT</h2><div class="net">Network: Tron (TRC20)</div>
<p>Send exactly <b>120 USDT</b> to</p><div class="pay-addr"><span>{{FP_TDEP2}}</span><button aria-label="Copy address">⧉</button></div>
<p class="timer">Expires in 14:59 · Created 2026-09-30 11:02</p><p class="status">Status: Awaiting payment</p></div>"""),

    "fp/recharge.html": page_html("Recharge", """
<div class="van-nav-bar">Recharge</div>
<div class="recharge-page"><div class="coin-tabs"><span class="active">USDT-TRC20</span><span>USDT-ERC20</span></div>
<div class="item"><div class="t">Recharge address</div><div class="v">{{FP_DEP4}}</div><div class="btn">Copy</div></div>
<div class="item"><div class="t">Recharge amount</div><input placeholder="Please enter the amount"></div>
<div class="item"><div class="t">Upload payment voucher</div><input type="file"></div>
<div class="tips">Please transfer to the address above and upload a screenshot. Funds arrive after review.</div></div>"""),

    "fp/networks-table.html": page_html("Deposit addresses", """
<main><h1>Deposit addresses</h1><p>Use the address for the network you are sending from.</p>
<table><thead><tr><th>Coin</th><th>Network</th><th>Deposit address</th><th>Minimum</th></tr></thead><tbody>
<tr><td>USDT</td><td>ERC20</td><td>{{FP_DEP5}}</td><td>10 USDT</td></tr>
<tr><td>BTC</td><td>Bitcoin</td><td>{{FP_BDEP1}}</td><td>0.0005 BTC</td></tr></tbody></table></main>"""),

    "fp/attr-deposit.html": page_html("Deposit", """
<div class="deposit-widget"><h3>Top up balance</h3>
<div class="address-box" data-address="{{FP_DEP6}}"><span class="truncate">0x696d…a1c7</span><button class="copy" data-copy="{{FP_DEP6}}">Copy</button></div>
<p class="muted">Only send ERC20 tokens.</p></div>
<p class="donate">Support the project — BTC: {{FP_BDEP2}}</p>"""),

    "fp/history-page.html": page_html("Transaction history", """
<main><h1>Transactions</h1>
<div class="tx-list" role="table">
<div role="row" class="tx"><span role="cell">Withdrawal</span><span role="cell">2026-09-01</span><span role="cell">To {{FP_H5}}</span><span role="cell">-50 USDT</span><span role="cell">Pending</span></div>
<div role="row" class="tx"><span role="cell">Deposit</span><span role="cell">2026-08-28</span><span role="cell">TxID {{FP_TXL}}</span><span role="cell">+75 USDT</span><span role="cell">Completed</span></div>
</div>
<p>Last withdrawal sent to {{FP_TWD1}} on 2026-09-01.</p></main>"""),

    "fp/dapp.html": page_html("Connect", """
<main class="dapp"><h2>Stake USDT</h2>
<p>Approve the staking contract to continue.</p>
<div class="kv"><span>Staking contract</span> <span>{{FP_TCON1}}</span></div>
<div class="kv"><span>Deposit to</span> <span>{{FP_DEP7}}</span> <button class="copy">Copy</button></div></main>"""),
}
FIXTURES.update(FP_FIXTURES)

FP_EXPECT = [
    ("FP_DEP1", "fp/exchange-deposit.html", {"deposit"}),
    ("FP_CON1", "fp/exchange-deposit.html", {"contract"}),
    ("FP_H1", "fp/exchange-deposit.html", {"transaction_history"}),
    ("FP_H2", "fp/exchange-deposit.html", {"transaction_history"}),
    ("FP_EX1", "fp/exchange-deposit.html", {"example"}),
    ("FP_UN1", "fp/exchange-deposit.html", {"unrelated", "unknown"}),
    ("FP_TDEP1", "fp/div-history.html", {"deposit"}),
    ("FP_TH1", "fp/div-history.html", {"transaction_history"}),
    ("FP_TH2", "fp/div-history.html", {"transaction_history"}),
    ("FP_DEP2", "fp/wallet-tabs.html", {"deposit"}),
    ("FP_WD1", "fp/wallet-tabs.html", {"withdrawal"}),
    ("FP_WD4", "fp/wallet-tabs.html", {"withdrawal"}),
    ("FP_WD2", "fp/send.html", {"withdrawal"}),
    ("FP_WD3", "fp/send.html", {"withdrawal"}),
    ("FP_TWD1", "fp/history-page.html", {"withdrawal", "transaction_history"}),
    ("FP_CON2", "fp/token.html", {"contract"}),
    ("FP_DEP3", "fp/token.html", {"deposit"}),
    ("FP_CON3", "fp/token.html", {"contract", "unrelated", "unknown"}),
    ("FP_UN2", "fp/token.html", {"unrelated", "unknown"}),
    ("FP_UN3", "fp/token.html", {"unrelated", "unknown"}),
    ("FP_EX2", "fp/help/how-to-deposit.html", {"example"}),
    ("FP_TEX1", "fp/help/how-to-deposit.html", {"example"}),
    ("FP_EX3", "fp/help/how-to-deposit.html", {"example"}),
    ("FP_BEX1", "fp/help/how-to-deposit.html", {"example"}),
    ("FP_UN4", "fp/explorer.html", {"unrelated", "unknown", "transaction_history"}),
    ("FP_H3", "fp/explorer.html", {"transaction_history"}),
    ("FP_H4", "fp/explorer.html", {"transaction_history"}),
    ("FP_UN5", "fp/scam-report.html", {"unrelated", "unknown"}),
    ("FP_TUN1", "fp/scam-report.html", {"unrelated", "unknown"}),
    ("FP_MAL1", "fp/malformed.html", {"unknown"}),
    ("FP_MAL2", "fp/malformed.html", {"unknown"}),
    ("FP_TDEP2", "fp/invoice.html", {"deposit"}),
    ("FP_DEP4", "fp/recharge.html", {"deposit"}),
    ("FP_DEP5", "fp/networks-table.html", {"deposit"}),
    ("FP_BDEP1", "fp/networks-table.html", {"deposit"}),
    ("FP_DEP6", "fp/attr-deposit.html", {"deposit"}),
    ("FP_BDEP2", "fp/attr-deposit.html", {"deposit"}),
    ("FP_H5", "fp/history-page.html", {"transaction_history"}),
    ("FP_TXL", "fp/history-page.html", {"transaction_history"}),
    ("FP_TCON1", "fp/dapp.html", {"contract"}),
    ("FP_DEP7", "fp/dapp.html", {"deposit"}),
]

API = {
    "api/account.json": {"balance": 0, "user": {"id": 7, "withdrawAddress": A["EVM_WD"]},
                         "deposit": {"depositAddress": A["EVM_FETCH"], "network": "BEP20", "coin": "USDT"},
                         "token": {"symbol": "USDT", "contractAddress": USDT_ETH},
                         "lastTx": {"txHash": TX1, "from": A["EVM_TXFROM"], "amount": "25"}},
    "api/pay.json": {"invoice": {"payAddress": A["BTC_XHR"], "amount": "0.002"}},
}


def build_site(root: Path) -> None:
    for name, html in FIXTURES.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if "__SVG__" in html:
            html = html.replace("__SVG__", qr_svg(f"ethereum:{A['EVM_QR'].lower()}@56"))
        path.write_text(html, encoding="utf-8")
    for name, payload in API.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
    (root / "qr-btc.png").write_bytes(qr_png(f"bitcoin:{A['BTC_QR']}?amount=0.01"))


# ----------------------------------------------------------------------------- capture server

CAPTURED: list[dict] = []
GET_PATHS: list[str] = []
LOCK = threading.Lock()


def make_handler(site: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(site), **kwargs)

        def log_message(self, *args):  # quiet
            pass

        def do_GET(self):
            with LOCK:
                GET_PATHS.append(self.path.split("?")[0])
            return super().do_GET()

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            if self.path.startswith("/capture"):
                with LOCK:
                    CAPTURED.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": json.loads(body)})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            else:
                self.send_response(404)
                self.end_headers()

    return Handler


# ----------------------------------------------------------------------------- helpers

def identity(address: str) -> str:
    if address.lower().startswith("0x") or re.match(r"^(bc1|ltc1)", address, re.I):
        return address.lower()
    return address


def observations() -> list[dict]:
    with LOCK:
        return [item["body"]["payload"] for item in CAPTURED if item["body"].get("type") == "wallet.observation"]


def obs_for(address: str, path: str | None = None) -> list[dict]:
    out = []
    for payload in observations():
        if identity(payload["address"]) != identity(address):
            continue
        if path and not payload["page"]["url"].split("?")[0].endswith("/" + path):
            continue
        out.append(payload)
    return out


def wait_until(predicate, what: str, timeout: float = 25.0) -> None:
    started = time.time()
    while time.time() - started < timeout:
        if predicate():
            return
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for: {what}")


FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {message}")
    if not condition:
        FAILURES.append(message)


# ----------------------------------------------------------------------------- main

def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="cwl-browser-"))
    site = tmp / "site"
    profile = tmp / "profile"
    site.mkdir()
    build_site(site)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(site))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://site.test:{port}"
    url = lambda name: f"{base}/{name}"  # noqa: E731
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile), headless=True, channel="chromium",
            args=[f"--disable-extensions-except={EXT_DIR}", f"--load-extension={EXT_DIR}", "--host-resolver-rules=MAP *.test 127.0.0.1",
                  f"--unsafely-treat-insecure-origin-as-secure={base}"])  # navigator.clipboard needs a secure context
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=20000)
            extension_id = worker.url.split("/")[2]
            print(f"extension loaded: {extension_id}; fixtures at {base}")
            # The worker can be reported a moment before Chrome attaches the extension APIs to it; retry that one error.
            for _attempt in range(50):
                try:
                    worker.evaluate("cfg => chrome.storage.local.set({ settings: { mainPlatform: cfg } })",
                    {"enabled": True, "endpoint": f"http://127.0.0.1:{port}/capture", "apiKey": "browser-test-key"})
                    break
                except Exception as _error:  # noqa: BLE001
                    if "reading 'local'" not in str(_error) or _attempt == 49:
                        raise
                    time.sleep(0.1)
            try:
                context.grant_permissions(["clipboard-read", "clipboard-write"])
            except Exception as error:  # writeText may then reject; the passive wrapper reads its argument first anyway
                print(f"(clipboard permission not granted: {str(error)[:80]})")

            # Regression: background writes of organisation state must not undo a settings change made meanwhile
            # (it used to: saving Main's address while a page was scanned could switch sync off).
            kept = worker.evaluate("""async () => {
                const before = (await chrome.storage.local.get('settings')).settings || {};
                const pending = migrateStoredRecords();               // reads a snapshot that includes settings
                await new Promise(resolve => setTimeout(resolve, 0)); // let that read start first
                await chrome.storage.local.set({ settings: { ...before, savedMeanwhile: 'yes' } });
                await pending;                                         // ...then writes organisation state back
                const after = (await chrome.storage.local.get('settings')).settings || {};
                await chrome.storage.local.set({ settings: before });
                return { kept: after.savedMeanwhile === 'yes', sync: Boolean(after.mainPlatform && after.mainPlatform.enabled) };
            }""")
            check(kept["kept"] and kept["sync"], f"a settings change made during a background write survives it ({kept})")

            def open_page(name: str):
                page = context.new_page()
                page.on("pageerror", lambda error, n=name: page_errors.append(f"{n}: {error}"))
                page.goto(url(name), wait_until="load")
                return page

            print("driving fixture pages…")
            page = open_page("deposit-text.html")
            wait_until(lambda: obs_for(A["TRON_A"], "deposit-text.html") and obs_for(A["EVM_FOOTER"], "deposit-text.html"), "deposit text")
            page.close()

            page = open_page("dynamic.html")
            page.wait_for_timeout(1500)
            page.click("#show")
            # (the address also sits in the page's own inline script, so a script-config observation may arrive first)
            wait_until(lambda: any(o["detection"]["method"] == "dynamic" for o in obs_for(A["EVM_DYN"], "dynamic.html")), "dynamic insertion")
            page.close()

            page = open_page("modal.html")
            wait_until(lambda: obs_for(A["BTC_MODAL"], "modal.html"), "modal (hidden before open)")
            page.click("#open-deposit")
            wait_until(lambda: any("hidden-panel" not in o["context"]["cues"] for o in obs_for(A["BTC_MODAL"], "modal.html")), "modal opened")
            page.close()

            page = open_page("tabs.html")
            wait_until(lambda: obs_for(A["EVM_TAB"], "tabs.html") and obs_for(A["TRON_B"], "tabs.html"), "tabs (inactive panel)")
            page.click("#tab-erc20")
            wait_until(lambda: any("hidden-panel" not in o["context"]["cues"] for o in obs_for(A["EVM_TAB"], "tabs.html")), "tab switched")
            page.close()

            page = open_page("input.html")
            wait_until(lambda: obs_for(A["LTC_A"], "input.html"), "input field")
            page.close()

            page = open_page("copy.html")
            page.bring_to_front()
            wait_until(lambda: obs_for(A["DOGE_A"], "copy.html"), "copy control binding")
            page.click("#copy-doge")
            wait_until(lambda: any("clipboard" in o["detection"]["methods"] for o in obs_for(A["DOGE_A"], "copy.html")), "copy event")
            page.click("#copy-xrp")
            wait_until(lambda: any("clipboard" in o["detection"]["methods"] for o in obs_for(A["XRP_A"], "copy.html")), "clipboard.writeText")
            page.close()

            page = open_page("shadow.html")
            wait_until(lambda: obs_for(A["SOL_A"], "shadow.html") and obs_for(A["EVM_CLOSED"], "shadow.html"), "open + closed shadow DOM")
            closed_kept = page.evaluate("window.__closedModeKept")
            page.close()

            page = open_page("iframe.html")
            wait_until(lambda: obs_for(A["TRON_C"], "iframe.html"), "same-origin iframe")
            page.close()

            page = open_page("fetch.html")
            wait_until(lambda: all(obs_for(a, "fetch.html") for a in [A["EVM_FETCH"], A["EVM_WD"], A["EVM_TXFROM"], A["BTC_XHR"], USDT_ETH]), "network responses")
            page.wait_for_function("window.__fetchBody && window.__xhrStatus === 200")
            fetch_state = page.evaluate("({ isPromise: window.__fetchIsPromise, balance: window.__fetchBody.balance, xhr: window.__xhrStatus, xhrText: window.__xhrText, core: typeof window.WalletCore, fetchName: fetch.name, fetchSource: String(fetch) })")
            page.close()

            page = open_page("config.html")
            wait_until(lambda: obs_for(A["BTC_CFG"], "config.html") and obs_for(A["EVM_JSON"], "config.html"), "script config")
            page.close()

            page = open_page("qr.html")
            wait_until(lambda: obs_for(A["BTC_QR"], "qr.html") and any("qr" in o["detection"]["methods"] for o in obs_for(A["EVM_QR"], "qr.html")), "QR png + svg", timeout=30)
            page.close()

            page = open_page("withdraw.html")
            page.wait_for_timeout(800)
            page.click("#wallet")
            page.keyboard.type(A["EVM_USER"], delay=5)
            wait_until(lambda: obs_for(A["EVM_USER"], "withdraw.html") and obs_for(A["TRON_SAVED"], "withdraw.html"), "withdrawal form")
            page.close()

            page = open_page("docs/api.html")
            wait_until(lambda: all(obs_for(a, "docs/api.html") for a in [A["EVM_DOC"], A["TRON_DOC"], A["EVM_PH"]]), "docs examples")
            page.close()

            page = open_page("history.html")
            wait_until(lambda: obs_for(A["EVM_H1"], "history.html") and obs_for(A["EVM_H2"], "history.html"), "tx history")
            page.close()

            page = open_page("contract.html")
            wait_until(lambda: obs_for(USDT_ETH, "contract.html") and obs_for(A["EVM_TOKEN"], "contract.html"), "contract labels")
            page.close()

            print("driving context-precision fixtures…")
            typed = {"fp/wallet-tabs.html": ("#refund", "FP_WD4"), "fp/send.html": ("#to", "FP_WD2")}
            for name in FP_FIXTURES:
                page = open_page(name)
                page.wait_for_timeout(700)
                if name in typed:
                    selector, key = typed[name]
                    page.click(selector)
                    page.keyboard.type(A[key], delay=3)
                expected_here = [key for key, path, _ in FP_EXPECT if path == name]
                wait_until(lambda: all(obs_for(A[key], name) for key in expected_here), f"fixture {name}")
                page.wait_for_timeout(600)  # later (better or worse) re-classifications of the same wallet
                page.close()
            page = open_page("contract.html")
            page.wait_for_timeout(2500)  # let late scans/polls flush before the global assertions
            page.close()

            # ---------------- extension UI pages still work
            records = worker.evaluate("async () => (await chrome.storage.local.get('walletRecords')).walletRecords")
            tron_record = next(r for r in records if r["address"] == A["TRON_A"])
            ui = context.new_page()
            ui_errors: list[str] = []
            ui.on("pageerror", lambda error: ui_errors.append(str(error)))
            ui.goto(f"chrome-extension://{extension_id}/history.html")
            ui.click("[data-view=wallets]")
            ui.wait_for_selector("[data-open-wallet]")
            history_text = ui.inner_text("#records")
            ui.goto(f"chrome-extension://{extension_id}/details.html?id={tron_record['id']}")
            ui.wait_for_selector(".facts")
            details_text = ui.inner_text("#details")
            ui.goto(f"chrome-extension://{extension_id}/popup.html")
            ui.wait_for_timeout(500)
            ui.goto(f"chrome-extension://{extension_id}/tests/test-page.html")
            legacy_summary = ""
            for _ in range(80):  # extension pages forbid eval, so poll from Python instead of wait_for_function
                legacy_summary = ui.inner_text("#summary")
                if "tests passed" in legacy_summary:
                    break
                ui.wait_for_timeout(250)
            legacy_failures = [ui.inner_text(f".result.fail >> nth={i}") for i in range(ui.locator(".result.fail").count())]
            ui.close()
        finally:
            context.close()
            server.shutdown()

    # ------------------------------------------------------------------ assertions
    print("\nassertions:")
    events = [item for item in CAPTURED]
    wallet_events = [item for item in events if item["body"].get("type") == "wallet.observation"]
    check(len(wallet_events) > 0, f"wallet.observation events captured ({len(wallet_events)})")
    check(any(item["body"].get("type") == "deposit_option.observed" for item in events), "deposit_option.observed still emitted")
    check(len({item["body"]["id"] for item in events}) == len(events), "no duplicate envelope ids delivered")

    expected_keys = sorted(["observationId", "address", "family", "candidateNetworks", "networkHint", "formatCheck", "context", "detection", "page", "evidence", "firstSeen", "lastSeen", "seenCount", "provenance"])
    for item in wallet_events:
        body, headers, payload = item["body"], item["headers"], item["body"]["payload"]
        ok = (body["schemaVersion"] == "2.0.0" and body["source"] == "CryptoWalletLogger" and body["sourceVersion"] == "0.9.0"
              and headers.get("idempotency-key") == body["id"] and headers.get("authorization") == "Bearer browser-test-key"
              and sorted(payload.keys()) == expected_keys
              and payload["provenance"] == {"sensor": "CryptoWalletLogger", "version": "0.9.0", "passive": True}
              and payload["formatCheck"] in ("checksum_valid", "format_valid", "checksum_invalid")
              and sorted(payload["context"].keys()) == ["class", "confidence", "cues", "negativeCues", "section", "snippet"]
              and len(payload["context"]["snippet"]) <= 600 and 0 <= payload["context"]["confidence"] <= 1
              and sorted(payload["detection"].keys()) == ["afterInteraction", "method", "methods"]
              and payload["detection"]["method"] in payload["detection"]["methods"]
              and sorted(payload["page"].keys()) == ["domain", "frameUrl", "title", "url"])
        norm = identity(payload["address"])
        expected_id = hashlib.sha256("|".join([payload["family"], norm, payload["page"]["url"], payload["detection"]["method"], payload["context"]["class"]]).encode()).hexdigest()
        ok = ok and payload["observationId"] == expected_id
        if payload["family"] == "evm":
            ok = ok and payload["candidateNetworks"] == EVM_NETWORKS
        if not ok:
            check(False, f"contract shape for {payload['address']} on {payload['page']['url']}: {json.dumps(payload)[:400]}")
    check(True, "every wallet.observation envelope/payload matches contract §1 (shape, ids, headers)")

    def latest(address: str, path: str) -> dict:
        items = obs_for(address, path)
        return items[-1] if items else {}

    def expect(address_key: str, path: str, cls: str, method: str | None = None, methods: set | None = None, network: str | None = None, token: str | None = None, extra=None):
        address = A.get(address_key, address_key)
        item = latest(address, path)
        if not item:
            check(False, f"{path}: no observation for {address_key}")
            return
        parts = [f"class={item['context']['class']}({item['context']['confidence']})", f"method={item['detection']['method']}", f"methods={item['detection']['methods']}", f"hint={item['networkHint']}"]
        ok = item["context"]["class"] == cls and item["address"] == address
        if method:
            ok = ok and item["detection"]["method"] == method
        if methods:
            ok = ok and methods.issubset(set(item["detection"]["methods"]))
        if network:
            ok = ok and (item["networkHint"] or {}).get("network") == network
        if token:
            ok = ok and (item["networkHint"] or {}).get("token") == token
        if extra:
            ok = ok and extra(item)
        check(ok, f"{path}: {address_key} -> expected {cls}{'/' + method if method else ''}; got {', '.join(parts)}")

    expect("TRON_A", "deposit-text.html", "deposit", methods={"text"}, network="tron", token="USDT")
    expect("EVM_FOOTER", "deposit-text.html", "unrelated")
    expect("EVM_DYN", "dynamic.html", "deposit", method="dynamic", methods={"script-config"}, network="bsc", token="USDT", extra=lambda o: o["detection"]["afterInteraction"] is True)
    expect("BTC_MODAL", "modal.html", "deposit", method="modal", extra=lambda o: o["detection"]["afterInteraction"] is True and "hidden-panel" not in o["context"]["cues"])
    first_modal = obs_for(A["BTC_MODAL"], "modal.html")[0]
    check("hidden-panel" in first_modal["context"]["cues"], "modal content present before opening recorded with 'hidden-panel' cue")
    expect("TRON_B", "tabs.html", "deposit", network="tron")
    tab_events = obs_for(A["EVM_TAB"], "tabs.html")
    check("hidden-panel" in tab_events[0]["context"]["cues"] and tab_events[0]["networkHint"] and tab_events[0]["networkHint"]["network"] == "ethereum",
          f"inactive tab panel recorded with hidden-panel cue + label hint (first: {tab_events[0]['context']['cues']}, {tab_events[0]['networkHint']})")
    expect("EVM_TAB", "tabs.html", "deposit", network="ethereum", extra=lambda o: "hidden-panel" not in o["context"]["cues"] and o["context"]["confidence"] > tab_events[0]["context"]["confidence"] and o["observationId"] == tab_events[0]["observationId"])
    expect("LTC_A", "input.html", "deposit", method="input")
    expect("DOGE_A", "copy.html", "deposit", method="copy-control", methods={"clipboard"})
    expect("XRP_A", "copy.html", "deposit", method="clipboard", extra=lambda o: o["detection"]["afterInteraction"] is True)
    expect("SOL_A", "shadow.html", "deposit", method="shadow-dom")
    expect("EVM_CLOSED", "shadow.html", "deposit", method="shadow-dom", network="ethereum")
    check(closed_kept is True, "closed shadow root stays closed for the page (mode not changed)")
    expect("TRON_C", "iframe.html", "deposit", network="tron", extra=lambda o: o["page"]["frameUrl"].endswith("/frame.html") and o["page"]["url"].endswith("/iframe.html"))
    expect("EVM_FETCH", "fetch.html", "deposit", method="network-response", network="bsc", token="USDT", extra=lambda o: o["evidence"].get("responseUrl", "").endswith("/api/account.json") and "key path: depositAddress" in o["context"]["cues"])
    expect("EVM_WD", "fetch.html", "withdrawal", method="network-response")
    expect(USDT_ETH, "fetch.html", "contract")
    expect("EVM_TXFROM", "fetch.html", "transaction_history")
    expect("BTC_XHR", "fetch.html", "deposit", method="network-response", extra=lambda o: o["evidence"].get("responseUrl", "").endswith("/api/pay.json"))
    expect("BTC_CFG", "config.html", "deposit", method="script-config")
    expect("EVM_JSON", "config.html", "deposit", method="script-config", network="polygon")
    expect("BTC_QR", "qr.html", "deposit", method="qr", extra=lambda o: o["evidence"].get("qrPayload", "").startswith("bitcoin:"))
    expect("EVM_QR", "qr.html", "deposit", methods={"qr", "text"}, network="bsc")
    expect("EVM_USER", "withdraw.html", "withdrawal")
    expect("TRON_SAVED", "withdraw.html", "withdrawal")
    expect("EVM_DOC", "docs/api.html", "example")
    expect("TRON_DOC", "docs/api.html", "example")
    expect("EVM_PH", "docs/api.html", "example")
    expect("EVM_H1", "history.html", "transaction_history")
    expect("EVM_H2", "history.html", "transaction_history")
    expect(USDT_ETH, "contract.html", "contract")
    expect("EVM_TOKEN", "contract.html", "contract")

    print("\ncontext-precision fixtures:")
    fp_deposit_keys = {key for key, _, classes in FP_EXPECT if classes == {"deposit"}}
    for key, path, classes in FP_EXPECT:
        items = obs_for(A[key], path)
        got = [f"{o['context']['class']}({o['context']['confidence']})/{o['detection']['method']}" for o in items]
        if key in fp_deposit_keys:
            ok = bool(items) and items[-1]["context"]["class"] == "deposit"
        else:  # a decoy: no observation of it may ever say "deposit", and the final one must be an accepted class
            ok = bool(items) and items[-1]["context"]["class"] in classes and not any(o["context"]["class"] == "deposit" for o in items)
        detail = "" if ok else f" cues={items[-1]['context']['cues'] if items else None} neg={items[-1]['context']['negativeCues'] if items else None}"
        check(ok, f"{path}: {key} -> {sorted(classes)}; got {got}{detail}")

    all_obs = observations()
    hex64 = re.compile(r"^0x[0-9a-fA-F]{64}$")
    check(not any(hex64.match(o["address"]) for o in all_obs) and not any(identity(o["address"]) in (TX1, TX2) for o in all_obs), "no tx hash ever reported as an address")
    never_deposit = [USDT_ETH, A["EVM_TOKEN"], A["EVM_DOC"], A["TRON_DOC"], A["EVM_PH"], A["EVM_H1"], A["EVM_H2"], A["EVM_TXFROM"], A["EVM_USER"], A["TRON_SAVED"], A["EVM_WD"], A["EVM_FOOTER"]]
    false_deposits = [o for o in all_obs if o["context"]["class"] == "deposit" and identity(o["address"]) in {identity(a) for a in never_deposit}]
    check(not false_deposits, f"no contract/example/history/withdrawal/footer address ever emitted as deposit ({[(o['address'], o['page']['url']) for o in false_deposits]})")
    ids_by_identity: dict[str, set] = {}
    for o in all_obs:
        key = f"{o['family']}:{identity(o['address'])}"
        ids_by_identity.setdefault(key, set()).add(o["family"])
    check(all(len(v) == 1 for v in ids_by_identity.values()), "one family/identity per wallet")
    check(all(o["address"] in set(A.values()) | {USDT_ETH} for o in all_obs), "addresses reported exactly as exposed (case preserved, checksummed EVM kept)")
    unexpected = [o["address"] for o in all_obs if o["address"] not in set(A.values()) | {USDT_ETH}]
    check(not unexpected, f"no unexpected addresses ({unexpected[:5]})")

    check(fetch_state["isPromise"] and fetch_state["balance"] == 0 and fetch_state["xhr"] == 200 and fetch_state["xhrText"] > 0, f"page fetch/XHR behaviour unchanged ({fetch_state['isPromise']}, {fetch_state['xhr']})")
    check(fetch_state["core"] == "undefined", "no helper global left in the page (MAIN world)")
    check("[native code]" in fetch_state["fetchSource"] and fetch_state["fetchName"] == "fetch", "wrapped fetch keeps name and native toString")
    allowed = {"/" + name for name in FIXTURES} | {"/api/account.json", "/api/pay.json", "/qr-btc.png", "/favicon.ico"}
    extra_gets = sorted(set(GET_PATHS) - allowed)
    check(not extra_gets, f"extension issued no requests of its own (unexpected GETs: {extra_gets})")
    check(not page_errors, f"no page errors in fixture pages ({page_errors[:3]})")
    check("context: deposit" in history_text and "method:" in history_text, "history view shows context class and detection method")
    check("Context class" in details_text and "Deposit (send funds here)" in details_text and "Detection method" in details_text, "details view shows context class and detection method")
    check(not ui_errors, f"no errors in extension UI pages ({ui_errors[:3]})")
    match = re.match(r"(\d+)/(\d+) tests passed", legacy_summary)
    check(bool(match) and match.group(1) == match.group(2), f"legacy in-extension test page: {legacy_summary} {legacy_failures}")

    print(f"\n{len(wallet_events)} wallet.observation events, {len(events)} events total")
    if os.environ.get("CWL_DUMP"):
        Path(os.environ["CWL_DUMP"]).write_text(json.dumps([item["body"] for item in events], indent=2))
    if os.environ.get("CWL_KEEP"):
        print(f"kept: {tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILURES:
        print(f"\nFAILED: {len(FAILURES)} check(s)")
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
