(() => {
  "use strict";

  /*
   * Passive QR decoding of images the page already rendered.
   * 1. Native BarcodeDetector (when the browser supports qr_code).
   * 2. Fallback: vendored jsQR (vendor/jsQR.js, Apache-2.0) on a private canvas copy of the element.
   * Supported sources: <img>, <canvas> (copied with drawImage — the page canvas is never touched), <video> frames,
   * inline <svg> (serialised and rasterised from a data: URL) and CSS background-image (data:/blob: URLs, or URLs the
   * page already loaded according to the Resource Timing buffer — never a new fetch).
   * Cross-origin (tainted) pixels cannot be read; those images are skipped silently.
   */

  const QR_SELECTOR = "img,canvas,video,svg,[class*='qr' i],[id*='qr' i],[aria-label*='qr' i],[data-qr],[style*='background' i]";
  const DEPOSIT_WORDS = /\b(deposit|payment|pay|receive|receiving|wallet|address|funding|top[ -]?up|recharge|crypto|coin|token|network|chain|usdt|usdc|btc|bitcoin|eth|ethereum|trx|tron|sol|solana|bnb|xrp|ltc|doge|erc[- ]?20|trc[- ]?20|bep[- ]?20)\b/i;
  const QR_WORDS = /\b(qr|scan|copy|address)\b/i;
  const imageState = new WeakMap();
  let detectorPromise;
  let lastBatchAt = 0;

  function clean(value, limit = 1800) {
    return String(value || "").replace(/[​-‍﻿]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, limit);
  }

  function rendered(element) {
    if (!element?.isConnected) return false;
    if (typeof element.checkVisibility === "function") return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function visible(element) {
    if (!rendered(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 48 && rect.height >= 48;
  }

  function backgroundUrl(element) {
    try {
      const value = getComputedStyle(element).backgroundImage || "";
      const match = /url\(\s*["']?(.*?)["']?\s*\)/.exec(value);
      return match ? match[1] : null;
    } catch { return null; }
  }

  function imageLike(element) {
    const tag = element.tagName?.toUpperCase();
    if (["IMG", "CANVAS", "VIDEO", "SVG"].includes(tag)) return element;
    const inner = element.querySelector?.("img,canvas,video,svg");
    if (inner) return inner;
    if (backgroundUrl(element)) return element;
    return null;
  }

  function kindOf(element) {
    const tag = element.tagName?.toUpperCase();
    if (tag === "IMG" || tag === "CANVAS" || tag === "VIDEO") return tag.toLowerCase();
    if (tag === "SVG") return "svg";
    return "background";
  }

  function signature(element) {
    const kind = kindOf(element);
    if (kind === "img") return `${element.currentSrc || element.src}|${element.naturalWidth}x${element.naturalHeight}`;
    if (kind === "video") return `${element.currentSrc || element.src}|${element.videoWidth}x${element.videoHeight}|${Math.floor(element.currentTime || 0)}`;
    if (kind === "canvas") return `canvas:${element.width}x${element.height}`;
    if (kind === "background") return `bg:${backgroundUrl(element)}`;
    return `svg:${element.innerHTML?.length || 0}:${element.getAttribute?.("viewBox") || ""}`;
  }

  function nearbyText(element) {
    const container = element.closest?.("[role='dialog'],[role='tabpanel'],form,section,article,[class*='deposit' i],[id*='deposit' i],[class*='payment' i],[id*='payment' i],[class*='wallet' i],[id*='wallet' i]") || element.parentElement?.parentElement || element.parentElement;
    return clean([
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("alt"),
      element.getAttribute?.("title"),
      container?.innerText || container?.textContent
    ].filter(Boolean).join("\n"));
  }

  function candidateScore(element) {
    const text = nearbyText(element);
    let score = 0;
    if (DEPOSIT_WORDS.test(text)) score += 4;
    if (/\b(deposit|payment|receive|receiving|funding|top[ -]?up|recharge|scan to pay)\b/i.test(text)) score += 4;
    if (/\b(network|chain|token|coin|usdt|usdc|btc|eth|trx|sol|bnb|erc[- ]?20|trc[- ]?20|bep[- ]?20)\b/i.test(text)) score += 3;
    if (QR_WORDS.test(text)) score += 2;
    const attributes = `${element.id} ${element.className?.baseVal ?? element.className ?? ""} ${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("alt") || ""} ${element.getAttribute?.("title") || ""} ${element.parentElement?.className?.baseVal ?? element.parentElement?.className ?? ""}`;
    if (/qr/i.test(attributes)) score += 4;
    if (element.closest?.("[role='dialog'],[role='tabpanel'],[class*='modal' i],[class*='popup' i],[class*='drawer' i]")) score += 1;
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width >= 64 && rect.width <= 900 && Math.abs(rect.width - rect.height) <= rect.width * 0.15) score += 1;
    } catch {}
    return score;
  }

  async function nativeDetector() {
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
      if (typeof BarcodeDetector !== "function") return null;
      if (typeof BarcodeDetector.getSupportedFormats === "function") {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (!formats.includes("qr_code")) return null;
      }
      return new BarcodeDetector({ formats: ["qr_code"] });
    })().catch(() => null);
    return detectorPromise;
  }

  async function detectNative(source) {
    const detector = await nativeDetector();
    if (!detector || !source) return [];
    try {
      const decoded = await detector.detect(source);
      return decoded.map(result => clean(result.rawValue, 2048)).filter(Boolean);
    } catch { return []; }
  }

  function loadImage(url) {
    return new Promise(resolve => {
      const image = new Image();
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      image.onload = () => done(image);
      image.onerror = () => done(null);
      setTimeout(() => done(null), 3000);
      image.decoding = "async";
      image.src = url;
    });
  }

  function alreadyLoaded(url) {
    try {
      if (/^(data|blob):/i.test(url)) return true;
      const absolute = new URL(url, location.href).href;
      return performance.getEntriesByName(absolute).length > 0;
    } catch { return false; }
  }

  function svgDataUrl(svg) {
    const clone = svg.cloneNode(true);
    const rect = svg.getBoundingClientRect();
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(rect.width) || 256));
    if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(rect.height) || 256));
    const markup = new XMLSerializer().serializeToString(clone);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  }

  /** Draw the element onto a private canvas (white background). Returns the canvas or null. */
  async function rasterize(element) {
    const kind = kindOf(element);
    let source = null;
    let width = 0;
    let height = 0;
    if (kind === "img") {
      if (!element.complete || !element.naturalWidth) return null;
      source = element; width = element.naturalWidth; height = element.naturalHeight;
    } else if (kind === "canvas") {
      source = element; width = element.width; height = element.height;
    } else if (kind === "video") {
      if (element.readyState < 2) return null;
      source = element; width = element.videoWidth; height = element.videoHeight;
    } else if (kind === "svg") {
      const image = await loadImage(svgDataUrl(element));
      if (!image) return null;
      source = image; width = image.naturalWidth || 256; height = image.naturalHeight || 256;
    } else {
      const url = backgroundUrl(element);
      if (!url || !alreadyLoaded(url)) return null;
      const image = await loadImage(url);
      if (!image) return null;
      source = image; width = image.naturalWidth; height = image.naturalHeight;
    }
    if (!width || !height) return null;
    const longest = Math.max(width, height);
    const scale = longest < 240 ? Math.ceil(240 / longest) : longest > 1200 ? 1200 / longest : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale)) + 32;
    canvas.height = Math.max(1, Math.round(height * scale)) + 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = scale < 1;
    try { context.drawImage(source, 16, 16, canvas.width - 32, canvas.height - 32); } catch { return null; }
    return canvas;
  }

  function decodeJsQr(canvas) {
    if (typeof jsQR !== "function" || !canvas) return [];
    let data;
    try { data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height); }
    catch { return []; } // tainted cross-origin pixels: skip gracefully
    try {
      const code = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
      return code?.data ? [clean(code.data, 2048)] : [];
    } catch { return []; }
  }

  /** Native detector first, jsQR fallback. Returns decoded payload strings. */
  async function decodeElement(element) {
    const kind = kindOf(element);
    if (kind === "img" || kind === "canvas" || kind === "video") {
      const direct = await detectNative(element);
      if (direct.length) return direct;
    }
    const canvas = await rasterize(element);
    if (!canvas) return [];
    if (kind === "svg" || kind === "background") {
      const native = await detectNative(canvas);
      if (native.length) return native;
    }
    return decodeJsQr(canvas);
  }

  function collectCandidates(roots, limit = 12) {
    const ranked = [];
    const seen = new Set();
    for (const root of roots || []) {
      for (const match of root.querySelectorAll?.(QR_SELECTOR) || []) {
        const element = imageLike(match);
        if (!element || seen.has(element) || !visible(element)) continue;
        if (element.tagName?.toUpperCase() === "SVG" && element.closest?.("button,[role='button']") && element.getBoundingClientRect().width < 64) continue; // icons
        seen.add(element);
        const score = candidateScore(element);
        if (score >= 7) ranked.push({ element, score, context: nearbyText(element) });
      }
    }
    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async function scan({ roots, force = false, decodeElement: decoder = decodeElement, now = Date.now() } = {}) {
    if (!force && now - lastBatchAt < 1500) return [];
    lastBatchAt = now;
    const sources = [];
    for (const candidate of collectCandidates(roots)) {
      const { element, score, context } = candidate;
      const currentSignature = signature(element);
      const prior = imageState.get(element);
      const dynamicImage = element.tagName === "CANVAS" || element.tagName === "VIDEO";
      if (!force && prior?.signature === currentSignature && (!dynamicImage || now - prior.scannedAt < 12_000)) {
        for (const payload of prior.payloads || []) sources.push({ text: `${context}\nQR code payload: ${payload}`, type: "deposit-qr", priority: 20 + Math.min(8, score), evidenceItems: ["Address appeared beside deposit QR code"], payload, element, score, cached: true });
        continue;
      }
      const state = { signature: currentSignature, scannedAt: now, payloads: [] };
      imageState.set(element, state);
      try {
        const payloads = await decoder(element);
        for (const payload of [...new Set(payloads || [])].slice(0, 4)) {
          if (!payload || payload.length > 2048) continue;
          state.payloads.push(payload);
          sources.push({ text: `${context}\nQR code payload: ${payload}`, type: "deposit-qr", priority: 20 + Math.min(8, score), evidenceItems: ["Address appeared beside deposit QR code"], payload, element, score });
        }
      } catch {}
    }
    return sources;
  }

  function invalidate(element) {
    if (element) imageState.delete(element);
  }

  globalThis.QrWalletScanner = { scan, collectCandidates, candidateScore, invalidate, decodeElement, rasterize, isSupported: async () => Boolean(await nativeDetector()) || typeof jsQR === "function" };
})();
