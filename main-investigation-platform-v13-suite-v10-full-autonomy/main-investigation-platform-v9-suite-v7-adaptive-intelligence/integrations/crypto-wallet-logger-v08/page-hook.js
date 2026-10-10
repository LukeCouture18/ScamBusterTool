/*
 * CryptoWalletLogger v0.9 — page-hook.js
 * Runs in the page's MAIN world at document_start (manifest content_scripts "world": "MAIN"), after wallet-core.js.
 *
 * STRICTLY PASSIVE. This script never issues requests, never blocks/delays/modifies a request or response, never
 * changes page state and never calls page callbacks. It only reads:
 *   - a CLONE of text/JSON fetch() responses the page itself requested (<= 1 MB, opaque/streaming responses skipped),
 *   - XMLHttpRequest responses the page itself requested (text/json, <= 1 MB), after they finished loading,
 *   - strings the page itself writes with navigator.clipboard.writeText (the argument, before passing it on unchanged),
 *   - page-defined window globals (data properties only — getters are never invoked; size-capped).
 * Wrappers call the original function with the same `this`/arguments and return its exact result (same promise).
 * Every inspection is wrapped in try/catch so a failure can never surface in the page.
 * Findings go to the isolated content script with window.postMessage, tagged with a per-page random channel id that
 * is exchanged synchronously at document_start (before any page script runs) through a one-shot DOM event handshake.
 */
(() => {
  "use strict";
  let core = null;
  try {
    core = globalThis.WalletCore || null;
    delete globalThis.WalletCore; // do not leave a helper global visible to the page
  } catch {}
  if (!core) return;

  const W = window;
  const doc = document;
  // Capture the natives we use before any page script can replace them.
  const nativeFetch = typeof W.fetch === "function" ? W.fetch : null;
  const XHR = W.XMLHttpRequest;
  const nativeXhrOpen = XHR && XHR.prototype && XHR.prototype.open;
  const ClipboardProto = W.Clipboard && W.Clipboard.prototype;
  const nativeWriteText = ClipboardProto && ClipboardProto.writeText;
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const post = W.postMessage;
  const jsonParse = JSON.parse;
  const setTimer = W.setTimeout;
  const functionToString = Function.prototype.toString;
  const ResponseProto = W.Response && W.Response.prototype;
  const responseClone = ResponseProto && ResponseProto.clone;
  const getHeader = W.Headers && W.Headers.prototype.get;
  const Decoder = W.TextDecoder;
  const objectKeys = Object.getOwnPropertyNames;
  const describe = Object.getOwnPropertyDescriptor;
  const NodeCtor = W.Node;

  const CHANNEL = (W.crypto && typeof W.crypto.randomUUID === "function") ? W.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`.slice(0, 36);
  const MAX_BYTES = 1024 * 1024;
  const MAX_READ_MS = 15000;
  const TEXT_TYPES = /(?:json|text\/|javascript|ecmascript|xml|x-www-form-urlencoded)/i;
  const SKIP_TYPES = /event-stream|multipart\/x-mixed-replace/i;
  const QUICK_FILTER = /0x[0-9a-fA-F]{40}|bc1|ltc1|[13LMDTr9A][1-9A-HJ-NP-Za-km-z]{24,}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
  let processedBytes = 0;
  const MAX_TOTAL_BYTES = 40 * MAX_BYTES;
  const postedKeys = new Set();

  /* ---------- channel handshake (synchronous, document_start) ---------- */
  let delivered = false;
  const announce = () => {
    if (delivered) return;
    try { dispatch.call(doc, new CustomEvent("cwl-main-hello", { detail: CHANNEL })); } catch {}
  };
  const onBridgeHello = () => announce();
  const onBridgeAck = () => {
    delivered = true;
    try { removeListener.call(doc, "cwl-bridge-hello", onBridgeHello, true); removeListener.call(doc, "cwl-bridge-ack", onBridgeAck, true); } catch {}
  };
  try {
    addListener.call(doc, "cwl-bridge-hello", onBridgeHello, true);
    addListener.call(doc, "cwl-bridge-ack", onBridgeAck, true);
  } catch {}
  announce();

  const targetOrigin = (() => { try { return W.location.origin && W.location.origin !== "null" ? W.location.origin : "*"; } catch { return "*"; } })();
  function send(source, findings, extra = {}) {
    if (!findings || !findings.length) return;
    const fresh = [];
    for (const finding of findings) {
      const key = `${source}|${finding.identity}|${finding.keyPath || ""}|${extra.responseUrl || ""}`;
      if (postedKeys.has(key)) continue;
      postedKeys.add(key);
      fresh.push({
        address: String(finding.address).slice(0, 128),
        keyPath: String(finding.keyPath || "").slice(0, 300),
        hintText: String(finding.hintText || "").slice(0, 300),
        snippet: String(finding.snippet || "").slice(0, 600),
        uri: finding.uri && finding.uri.uri ? String(finding.uri.uri).slice(0, 600) : null
      });
      if (fresh.length >= 100) break;
    }
    if (!fresh.length) return;
    try {
      post.call(W, { __cwl: 2, channel: CHANNEL, kind: "findings", source, responseUrl: String(extra.responseUrl || "").slice(0, 2048), findings: fresh }, targetOrigin);
    } catch {}
  }

  function isForeignObject(value) {
    try {
      if (NodeCtor && value instanceof NodeCtor) return true;
      if (value === W || value === doc) return true;
      if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
      if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise || value instanceof RegExp || value instanceof Date) return true;
      if (typeof Event !== "undefined" && value instanceof Event) return true;
      if (typeof value.postMessage === "function" && value.window === value) return true; // other windows / frames
    } catch { return true; }
    return false;
  }

  function analyzeText(text, responseUrl, contentType) {
    if (typeof text !== "string" || text.length < 25 || !QUICK_FILTER.test(text)) return;
    let findings = [];
    const trimmed = text.trimStart();
    if (/json/i.test(contentType) || trimmed[0] === "{" || trimmed[0] === "[") {
      try { findings = core.scanJson(jsonParse(text), { isForeignObject }); }
      catch { findings = core.scanScriptText(text); }
    } else if (/html|xml/i.test(contentType) || trimmed[0] === "<") {
      findings = core.extractAll(text).slice(0, 100).map(hit => ({ ...hit, keyPath: "", hintText: "", snippet: core.cleanText(text.slice(Math.max(0, hit.index - 200), hit.end + 200).replace(/<[^>]+>/g, " "), 600) }));
    } else {
      findings = core.scanScriptText(text);
    }
    send("network-response", findings, { responseUrl });
  }

  async function readCapped(response) {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") return "";
    const reader = body.getReader();
    const decoder = new Decoder();
    const started = Date.now();
    let total = 0;
    let text = "";
    for (;;) {
      if (Date.now() - started > MAX_READ_MS) { try { reader.cancel(); } catch {} return null; }
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { try { reader.cancel(); } catch {} return null; }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  async function inspectResponse(response, requestUrl) {
    if (!response || processedBytes > MAX_TOTAL_BYTES) return;
    if (response.type === "opaque" || response.type === "opaqueredirect" || response.bodyUsed) return;
    const headers = response.headers;
    const contentType = (headers && getHeader.call(headers, "content-type")) || "";
    if (SKIP_TYPES.test(contentType) || (contentType && !TEXT_TYPES.test(contentType))) return;
    const declared = Number((headers && getHeader.call(headers, "content-length")) || 0);
    if (declared > MAX_BYTES) return;
    let copy;
    try { copy = responseClone.call(response); } catch { return; }
    const text = await readCapped(copy);
    if (text == null) return;
    processedBytes += text.length;
    analyzeText(text, response.url || requestUrl || "", contentType);
  }

  /* ---------- fetch (read a clone; return the original promise untouched) ---------- */
  if (nativeFetch && responseClone && getHeader && Decoder) {
    try {
      const wrappedFetch = function fetch(input, init) { // eslint-disable-line no-unused-vars
        const promise = nativeFetch.apply(this, arguments);
        try {
          let requestUrl = "";
          try { requestUrl = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : ""); } catch {}
          promise.then(response => { inspectResponse(response, requestUrl).catch(() => {}); }, () => {});
        } catch {}
        return promise;
      };
      Object.defineProperty(wrappedFetch, "length", { value: nativeFetch.length });
      Object.defineProperty(wrappedFetch, "toString", { value: function toString() { return functionToString.call(nativeFetch); }, configurable: true, writable: true });
      W.fetch = wrappedFetch;
    } catch {}
  }

  /* ---------- XMLHttpRequest (listen for load; never touch the request) ---------- */
  if (XHR && nativeXhrOpen) {
    try {
      const urls = new WeakMap();
      const onXhrLoad = function onXhrLoad() {
        setTimer.call(W, () => {
          try {
            if (processedBytes > MAX_TOTAL_BYTES) return;
            const type = this.responseType;
            const url = this.responseURL || urls.get(this) || "";
            if (type === "" || type === "text") {
              const contentType = this.getResponseHeader("content-type") || "";
              if (SKIP_TYPES.test(contentType) || (contentType && !TEXT_TYPES.test(contentType))) return;
              const text = this.responseText;
              if (typeof text !== "string" || text.length > MAX_BYTES) return;
              processedBytes += text.length;
              analyzeText(text, url, contentType);
            } else if (type === "json") {
              const value = this.response;
              if (value && typeof value === "object") send("network-response", core.scanJson(value, { isForeignObject }), { responseUrl: url });
            }
          } catch {}
        }, 0);
      };
      const wrappedOpen = function open(method, url) { // eslint-disable-line no-unused-vars
        try {
          urls.set(this, String(url));
          addListener.call(this, "load", onXhrLoad);
        } catch {}
        return nativeXhrOpen.apply(this, arguments);
      };
      Object.defineProperty(wrappedOpen, "length", { value: nativeXhrOpen.length });
      Object.defineProperty(wrappedOpen, "toString", { value: function toString() { return functionToString.call(nativeXhrOpen); }, configurable: true, writable: true });
      XHR.prototype.open = wrappedOpen;
    } catch {}
  }

  /* ---------- navigator.clipboard.writeText (read the string the page writes) ---------- */
  if (ClipboardProto && typeof nativeWriteText === "function") {
    try {
      const wrappedWriteText = function writeText(data) {
        try {
          if (typeof data === "string" && data.length <= 4096) {
            const hits = core.extractAll(data, { trustSolana: true }).slice(0, 10).map(hit => ({ ...hit, keyPath: "", hintText: "", snippet: core.cleanText(data, 600) }));
            send("clipboard", hits.map(hit => ({ ...hit, identity: `${hit.identity}|${Date.now()}` })));
          }
        } catch {}
        return nativeWriteText.apply(this, arguments);
      };
      Object.defineProperty(wrappedWriteText, "length", { value: nativeWriteText.length });
      Object.defineProperty(wrappedWriteText, "toString", { value: function toString() { return functionToString.call(nativeWriteText); }, configurable: true, writable: true });
      ClipboardProto.writeText = wrappedWriteText;
    } catch {}
  }

  /* ---------- page-defined window config objects (read-only, size-capped) ---------- */
  let baseline = null;
  try { baseline = new Set(objectKeys(W)); } catch {}
  let lastConfigScan = 0;
  function scanWindowConfig() {
    if (!baseline) return;
    const now = Date.now();
    if (now - lastConfigScan < 1500) return;
    lastConfigScan = now;
    try {
      const names = objectKeys(W).filter(name => !baseline.has(name)).slice(0, 400);
      let budget = 60000;
      const findings = [];
      for (const name of names) {
        if (budget <= 0) break;
        let value;
        try {
          const descriptor = describe(W, name);
          if (!descriptor || !("value" in descriptor)) continue; // never invoke getters
          value = descriptor.value;
        } catch { continue; }
        if (typeof value === "string") {
          if (value.length >= 25 && value.length <= 4096) for (const hit of core.extractAll(value, { context: core.splitKeyWords(name) })) findings.push({ ...hit, keyPath: name, hintText: "", snippet: core.cleanText(`${name}: ${value}`, 600) });
          continue;
        }
        if (!value || typeof value !== "object" || isForeignObject(value)) continue;
        const found = core.scanJson(value, { rootPath: name, maxNodes: Math.min(20000, budget), isForeignObject });
        budget -= 20000;
        findings.push(...found);
      }
      send("script-config", findings);
    } catch {}
  }
  try {
    addListener.call(doc, "DOMContentLoaded", () => setTimer.call(W, scanWindowConfig, 0), { once: true });
    addListener.call(W, "load", () => { setTimer.call(W, scanWindowConfig, 0); setTimer.call(W, scanWindowConfig, 2000); setTimer.call(W, scanWindowConfig, 8000); }, { once: true });
    addListener.call(W, "click", event => { if (event.isTrusted) setTimer.call(W, scanWindowConfig, 1200); }, { capture: true, passive: true });
  } catch {}
})();
