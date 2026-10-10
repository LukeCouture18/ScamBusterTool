/*
 * CryptoWalletLogger v0.9 — content.js (isolated world, document_start, all frames)
 *
 * Wallet Discovery v2. STRICTLY PASSIVE: this script only reads what the browser already received or rendered while
 * the person browses. It never navigates, clicks, submits, fills fields, logs in, solves challenges, initiates
 * transactions, issues requests or alters the page. Event listeners are passive observers (capture phase, never
 * preventDefault/stopPropagation).
 *
 * Coverage: visible text (+ MutationObserver for dynamic content), modals/dialogs, tabs (inactive panels recorded with
 * a lower-confidence "hidden-panel" cue), form fields (value + placeholder), data-* / aria-* / title attributes,
 * copy-address controls + passive copy-event reading, open AND closed shadow roots (chrome.dom.openOrClosedShadowRoot,
 * read-only), same-origin and cross-origin frames (all_frames), payment URI links, QR codes (BarcodeDetector + jsQR),
 * inline <script>/JSON data, and findings from the MAIN-world passive hook (network responses, window config,
 * clipboard writes) received over a validated window.postMessage channel.
 */
(() => {
  "use strict";
  const core = globalThis.WalletCore;
  if (!core || globalThis.__cwlContentV09) return;
  globalThis.__cwlContentV09 = true; // isolated-world global; invisible to the page

  /* ================================================================== */
  /* MAIN-world bridge (set up synchronously at document_start)          */
  /* ================================================================== */

  let channel = null;
  const bridgeInbox = [];
  const CHANNEL_RE = /^[0-9a-f-]{20,40}$/i;
  const BRIDGE_SOURCES = new Set(["network-response", "script-config", "clipboard"]);
  document.addEventListener("cwl-main-hello", event => {
    if (channel) return;
    const detail = event.detail;
    if (typeof detail !== "string" || !CHANNEL_RE.test(detail)) return;
    channel = detail;
    try { document.dispatchEvent(new CustomEvent("cwl-bridge-ack")); } catch {}
  }, true);
  try { document.dispatchEvent(new CustomEvent("cwl-bridge-hello")); } catch {}

  function validBridgeMessage(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (data.__cwl !== 2 || data.channel !== channel || data.kind !== "findings") return false;
    if (!BRIDGE_SOURCES.has(data.source)) return false;
    if (typeof data.responseUrl !== "string" || data.responseUrl.length > 2048) return false;
    if (!Array.isArray(data.findings) || data.findings.length > 100) return false;
    return data.findings.every(item => item && typeof item === "object"
      && typeof item.address === "string" && item.address.length >= 25 && item.address.length <= 128
      && typeof item.keyPath === "string" && item.keyPath.length <= 300
      && typeof item.hintText === "string" && item.hintText.length <= 300
      && typeof item.snippet === "string" && item.snippet.length <= 600
      && (item.uri === null || (typeof item.uri === "string" && item.uri.length <= 600)));
  }

  addEventListener("message", event => {
    if (!channel || event.source !== window) return;
    let data;
    try { data = event.data; } catch { return; }
    if (!validBridgeMessage(data)) return;
    bridgeInbox.push({ source: data.source, responseUrl: data.responseUrl, findings: data.findings.map(item => ({ address: item.address, keyPath: item.keyPath, hintText: item.hintText, snippet: item.snippet, uri: item.uri })), at: Date.now(), afterInteraction: interacted });
    if (bridgeInbox.length > 200) bridgeInbox.splice(0, bridgeInbox.length - 200);
    if (started) scheduleScan(150, "targeted");
  });

  /* ================================================================== */
  /* Interaction / copy observation (passive listeners only)             */
  /* ================================================================== */

  let interacted = false;
  let lastClick = { element: null, at: 0 };
  const userEdited = new WeakSet();
  const clipboardInbox = [];
  const markInteraction = event => { if (event.isTrusted) interacted = true; };
  for (const type of ["pointerdown", "keydown", "touchstart"]) addEventListener(type, markInteraction, { capture: true, passive: true });
  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    interacted = true;
    lastClick = { element: event.target instanceof Element ? event.target : null, at: Date.now() };
    if (started) { scheduleScan(300, "targeted"); setTimeout(() => scheduleScan(0, "full"), 1200); }
  }, { capture: true, passive: true });
  document.addEventListener("input", event => {
    if (event.isTrusted && event.target instanceof Element) { userEdited.add(event.target); interacted = true; }
    if (started) { dirty.add(event.target); scheduleScan(250, "targeted"); }
  }, { capture: true, passive: true });
  document.addEventListener("change", event => { if (started) { dirty.add(event.target); scheduleScan(200, "targeted"); } }, { capture: true, passive: true });

  // Copy events: selection text is captured first; the page's own clipboardData (set by its handlers) is read last.
  let pendingCopy = null;
  document.addEventListener("copy", event => {
    let selection = "";
    try { selection = String(document.getSelection?.() || ""); } catch {}
    pendingCopy = { selection, target: event.target instanceof Element ? event.target : null, handled: false };
    setTimeout(() => {
      if (pendingCopy && !pendingCopy.handled && pendingCopy.selection) recordClipboard(pendingCopy.selection, pendingCopy.target, "selection");
      pendingCopy = null;
    }, 0);
  }, true);
  addEventListener("copy", event => {
    let data = "";
    try { data = event.clipboardData?.getData("text/plain") || ""; } catch {}
    const pending = pendingCopy;
    if (pending) pending.handled = true;
    const text = data || pending?.selection || "";
    if (text) recordClipboard(text, pending?.target || (event.target instanceof Element ? event.target : null), data ? "clipboard-data" : "selection");
  }, false);

  function recordClipboard(text, target, via) {
    if (typeof text !== "string" || text.length > 4096) return;
    const element = lastClick.element && Date.now() - lastClick.at < 4000 ? lastClick.element : target;
    clipboardInbox.push({ text, element, via, afterInteraction: interacted });
    if (clipboardInbox.length > 50) clipboardInbox.shift();
    if (started) scheduleScan(80, "targeted");
  }

  /* ================================================================== */
  /* DOM helpers                                                          */
  /* ================================================================== */

  const SKIP_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "IFRAME", "OBJECT"]);
  const INLINE_TAGS = new Set(["SPAN", "A", "B", "I", "EM", "STRONG", "CODE", "SMALL", "MARK", "U", "S", "SUB", "SUP", "FONT", "ABBR", "KBD", "SAMP", "VAR", "TT", "LABEL", "WBR", "BDI", "BDO", "CITE", "DFN", "Q", "TIME", "DATA", "INS", "DEL"]);
  const SECTION_SELECTOR = "dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true'],[role='tabpanel'],form,fieldset,section,article,aside,footer,nav,header,main,table,[role='table'],[role='grid'],[class*='modal' i],[class*='deposit' i],[id*='deposit' i],[class*='withdraw' i],[id*='withdraw' i],[class*='payment' i],[id*='payment' i],[class*='wallet' i],[class*='card' i],[class*='panel' i]";
  const MODAL_SELECTOR = "dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true'],[class*='modal' i],[class*='popup' i],[class*='drawer' i]";
  const COPY_SELECTOR = "[data-clipboard-text],[data-clipboard-target],[data-clipboard],[data-copy],[data-copy-text],[data-copy-value],[class*='copy' i],[id*='copy' i],[aria-label*='copy' i],[title*='copy' i]";
  const COPY_VALUE_ATTRIBUTES = new Set(["data-clipboard-text", "data-clipboard", "data-copy", "data-copy-text", "data-copy-value", "data-clipboard-value"]);
  const SELECTED_SELECTOR = "option:checked,[aria-selected='true'],[aria-checked='true'],[aria-pressed='true'],input:checked,.active,.selected,.is-active,.is-selected,[data-selected='true'],[data-state='active'],[data-active='true']";
  const TX_HEADER_RE = /\b(tx|txid|txn|hash|date|time|amount|status|from|to|type|confirm\w*|block|fee|asset|direction)\b/i;
  const LANDMARK_SELECTOR = "footer,nav,aside,header,[role='contentinfo'],[role='navigation'],[role='banner'],[role='complementary']";
  const SECTIONING_SELECTOR = "main,section,article,footer,nav,aside,header,form,dialog,table,[role='dialog'],[role='tabpanel'],[role='main'],[role='contentinfo'],[role='navigation']";
  const DOC_PATH_RE = /\/(?:docs?|documentation|api|developers?|guides?|help|reference|faq|tutorials?)(?:\/|$|\.)/i;

  function parentAcross(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.nodeType === 11 && parent.host ? parent.host : null;
  }
  function closestAcross(element, selector, maxDepth = 60) {
    let current = element;
    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      if (current.nodeType === 1 && current.matches?.(selector)) return current;
      current = parentAcross(current);
    }
    return null;
  }
  function inShadow(element) {
    const root = element?.getRootNode?.();
    return Boolean(root && root.nodeType === 11 && root.host);
  }

  function isRendered(element) {
    if (!element?.isConnected) return false;
    if (element.matches?.("input[type='hidden' i]")) return false;
    try {
      if (typeof element.checkVisibility === "function") return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      if (!element.getClientRects().length) return false;
      return getComputedStyle(element).visibility !== "hidden";
    } catch { return true; }
  }

  let textCache = new Map();
  let addressCache = new Map(); // element -> addresses it displays (same lifetime as textCache)
  function textOf(element) {
    if (!element) return "";
    if (textCache.has(element)) return textCache.get(element);
    let text = "";
    try { text = element.innerText ?? element.textContent ?? ""; } catch { text = element.textContent || ""; }
    if (!text.trim() && element.textContent) text = element.textContent;
    text = core.cleanText(text, 60000);
    textCache.set(element, text);
    return text;
  }
  function around(text, address, limit) {
    return core.snippetAround(text, address, limit);
  }
  function shortText(element, limit = 120) {
    return core.cleanText(element?.innerText || element?.textContent || "", limit);
  }

  function domPath(element) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 14; depth += 1) {
      if (current.nodeType !== 1) break;
      const tag = current.tagName.toLowerCase();
      let part = tag;
      if (current.id && /^[A-Za-z][\w-]{0,40}$/.test(current.id)) part += `#${current.id}`;
      else if (current.parentElement) {
        const siblings = [...current.parentElement.children].filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current.parentElement) current = current.parentElement;
      else {
        const root = current.parentNode;
        if (root && root.nodeType === 11 && root.host) { parts.unshift("::shadow"); current = root.host; }
        else break;
      }
    }
    return parts.join(">").replace(/>::shadow>/g, "::shadow>").slice(0, 400);
  }

  const dynamicNodes = new WeakSet();
  function isDynamic(element) {
    let current = element;
    for (let depth = 0; current && depth < 40; depth += 1) {
      if (dynamicNodes.has(current)) return true;
      current = parentAcross(current);
    }
    return false;
  }

  function headingFor(element, section) {
    const parts = [];
    const modal = closestAcross(element, MODAL_SELECTOR);
    if (modal) {
      const labelledBy = modal.getAttribute("aria-labelledby");
      const titled = labelledBy ? labelledBy.split(/\s+/).map(id => modal.getRootNode().getElementById?.(id)).filter(Boolean)[0] : null;
      const title = titled || modal.querySelector("h1,h2,h3,h4,[class*='title' i],[class*='header' i]");
      if (title) parts.push(shortText(title, 100));
      else if (modal.getAttribute("aria-label")) parts.push(modal.getAttribute("aria-label").slice(0, 100));
    }
    const panel = closestAcross(element, "[role='tabpanel']");
    const tabLabel = panel ? tabLabelFor(panel) : "";
    if (tabLabel) parts.push(tabLabel);
    // Nearest preceding heading in document order (walk up, then previous siblings).
    let current = element;
    for (let depth = 0; current && depth < 8 && parts.length < 3; depth += 1) {
      let sibling = current.previousElementSibling;
      for (let count = 0; sibling && count < 8; count += 1, sibling = sibling.previousElementSibling) {
        // Headings of other sections (a sibling <main>, <section>, <footer>…) do not describe this element.
        const heading = sibling.matches?.("h1,h2,h3,h4,h5,h6,[role='heading'],legend,caption,[class*='title' i],[class*='heading' i]") ? sibling : (sibling.matches?.(SECTIONING_SELECTOR) ? null : sibling.querySelector?.("h1,h2,h3,h4,h5,h6,[role='heading']"));
        if (heading) { const text = shortText(heading, 100); if (text) { parts.push(text); current = null; break; } }
      }
      if (!current) break;
      if (current.matches?.(LANDMARK_SELECTOR)) break; // never borrow a heading from outside a footer/nav/aside/header
      current = parentAcross(current);
      if (current && current.matches?.("fieldset")) { const legend = current.querySelector("legend"); if (legend) { parts.push(shortText(legend, 100)); break; } }
      if (current && section && current === parentAcross(section) && parts.length) break;
    }
    return [...new Set(parts.filter(Boolean))].join(" · ").slice(0, 240);
  }

  function tabLabelFor(panel) {
    const root = panel.getRootNode();
    const labelledBy = panel.getAttribute("aria-labelledby");
    if (labelledBy) {
      const tab = labelledBy.split(/\s+/).map(id => root.getElementById?.(id)).filter(Boolean)[0];
      if (tab) return shortText(tab, 80);
    }
    if (panel.id) {
      const tab = root.querySelector?.(`[aria-controls~="${CSS.escape(panel.id)}"]`);
      if (tab) return shortText(tab, 80);
    }
    return panel.getAttribute("aria-label")?.slice(0, 80) || "";
  }

  function labelFor(element) {
    const parts = [];
    if (!element || element.nodeType !== 1) return "";
    for (const label of element.labels || []) parts.push(shortText(label, 120));
    const aria = element.getAttribute("aria-label");
    if (aria) parts.push(aria.slice(0, 120));
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) for (const id of labelledBy.split(/\s+/)) { const target = element.getRootNode().getElementById?.(id); if (target) parts.push(shortText(target, 120)); }
    if (element.matches("input,textarea,select")) {
      const words = core.splitKeyWords(`${element.name || ""} ${element.id || ""}`);
      if (words) parts.push(words);
    }
    if (element.title) parts.push(element.title.slice(0, 120));
    // A short preceding label-like sibling ("Deposit address:", "Contract:").
    // (a sibling that itself shows an address is a neighbouring item — "Liquidity pool: 0x…" — not this one's label)
    const showsAddress = text => /[0-9A-Za-z]{25,}/.test(text) && core.extractAddresses(text, { trustSolana: true, limit: 2 }).length > 0;
    let sibling = element.previousElementSibling;
    for (let count = 0; sibling && count < 2; count += 1, sibling = sibling.previousElementSibling) {
      const text = shortText(sibling, 90);
      if (text && showsAddress(text)) break;
      if (text && text.length <= 80) { parts.push(text); break; }
    }
    // The parent's preceding block labels this element only when the parent has no words of its own around it
    // ("<p>Your address should look like this: <span>0x…</span></p>" is labelled by its own sentence, not the heading above).
    const parentOwnWords = element.parentElement ? textOf(element.parentElement).split(textOf(element)).join(" ").replace(/[^A-Za-z]+/g, "").length : 0;
    if (!parts.length && element.parentElement && parentOwnWords < 12) {
      const parentLabel = element.parentElement.getAttribute("aria-label") || element.parentElement.title;
      if (parentLabel) parts.push(parentLabel.slice(0, 120));
      let previous = element.parentElement.previousElementSibling;
      const text = previous ? shortText(previous, 90) : "";
      if (text && text.length <= 80 && !showsAddress(text)) parts.push(text);
    }
    return [...new Set(parts.filter(Boolean))].join(" · ").slice(0, 300);
  }

  /** Header of the table column holding the address ("TxID", "Deposit address", "From"…). */
  function columnHeaderFor(element) {
    try {
      const cell = closestAcross(element, "td,th,[role='cell'],[role='gridcell']", 6);
      if (!cell) return "";
      const table = closestAcross(cell, "table,[role='table'],[role='grid']");
      if (!table) return "";
      if (cell.matches("td,th")) {
        const row = cell.parentElement;
        let column = 0;
        for (const sibling of row.children) { if (sibling === cell) break; column += Math.max(1, Number(sibling.colSpan) || 1); }
        const headerRow = table.tHead?.rows?.[0] || (table.rows?.[0] !== row ? table.rows?.[0] : null);
        if (!headerRow) return "";
        let index = 0;
        for (const header of headerRow.cells) {
          if (index === column && header.matches("th")) return shortText(header, 60);
          index += Math.max(1, Number(header.colSpan) || 1);
        }
        return "";
      }
      const row = closestAcross(cell, "[role='row']");
      const position = row ? [...row.querySelectorAll("[role='cell'],[role='gridcell']")].indexOf(cell) : -1;
      const header = position >= 0 ? table.querySelectorAll("[role='columnheader']")[position] : null;
      return header ? shortText(header, 60) : "";
    } catch { return ""; }
  }

  /** Caption of an enclosing figure (a screenshot or illustration of a page). */
  function captionFor(element) {
    const figure = closestAcross(element, "figure");
    const caption = figure?.querySelector?.("figcaption");
    return caption ? shortText(caption, 100) : "";
  }

  /** Placeholder / hint text of an input ("Paste the recipient address"), unless it is itself an address. */
  function fieldHintFor(field, opts) {
    if (!field || opts.placeholder) return "";
    const hint = field.getAttribute?.("placeholder") || "";
    if (!hint || hint.length > 120 || core.extractAddresses(hint, { trustSolana: true }).length) return "";
    return hint;
  }

  function sectionFor(element) {
    const section = closestAcross(element, SECTION_SELECTOR);
    if (!section || section === document.body || section === document.documentElement) return null;
    return section;
  }

  function localContainer(element, section, address) {
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const text = textOf(current);
      if (text.replace(address, "").trim().length >= 50) return current;
      const parent = parentAcross(current);
      if (!parent || parent === document.body || parent === document.documentElement || current === section) return current;
      current = parent;
    }
    return current || element;
  }

  /** The smallest block around the address that carries words of its own (its line/row/cell), never one that also shows another address. */
  function nearText(element, section, address) {
    let current = element;
    let best = "";
    for (let depth = 0; current && depth < 4; depth += 1) {
      if (depth > 0 && holdsOtherAddress(current, address)) break;
      const text = textOf(current);
      best = text;
      if (text.split(address).join(" ").replace(/[^A-Za-z]+/g, "").length >= 3) break;
      if (current === section) break;
      const parent = parentAcross(current);
      if (!parent || parent === document.body || parent === document.documentElement) break;
      current = parent;
    }
    return around(best, address, 220);
  }

  function selectorScope(element, hidden) {
    // Hidden panels only trust selections inside themselves; visible content may use selectors above it.
    if (hidden) return [closestAcross(element, "[role='tabpanel'],[hidden],[aria-hidden='true']") || element];
    const scopes = [];
    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1) {
      current = parentAcross(current);
      if (!current || current === document.documentElement) break;
      scopes.push(current);
      if (current.matches?.(`dialog,[role='dialog'],form,main,body,${LANDMARK_SELECTOR}`)) break;
    }
    return scopes;
  }

  function relevantLabel(text) {
    return Boolean(text) && text.length <= 60 && (core.networksIn(text, true).size > 0 || core.tokensIn(text).length > 0);
  }

  function selectedLabels(scopes) {
    for (const scope of scopes) {
      const labels = [];
      let elements = [];
      try { elements = scope.querySelectorAll?.(SELECTED_SELECTOR) || []; } catch {}
      for (const element of elements) {
        let text = "";
        if (element.matches("option")) text = element.textContent;
        else if (element.matches("input")) text = element.labels?.[0]?.innerText || element.getAttribute("aria-label") || element.value;
        else text = element.innerText || element.textContent;
        text = core.cleanText(text, 80);
        if (relevantLabel(text)) labels.push(text);
        if (labels.length >= 6) break;
      }
      if (labels.length) return labels;
    }
    return [];
  }

  function hasNetworkSelector(scopes) {
    for (const scope of scopes.slice(0, 5)) {
      try {
        for (const select of scope.querySelectorAll?.("select") || []) {
          if ([...select.options].filter(option => core.networksIn(option.textContent, true).size).length >= 2) return true;
        }
        const choices = [...(scope.querySelectorAll?.("[role='tab'],[role='radio'],[role='option'],button,label,li") || [])].slice(0, 120);
        if (choices.filter(choice => { const text = core.cleanText(choice.innerText || choice.textContent, 60); return text.length <= 40 && core.networksIn(text, true).size; }).length >= 2) return true;
      } catch {}
    }
    return false;
  }

  // True when `element` displays an address other than `address` (its text or field values): a block that shows two
  // addresses is shared context, so per-address evidence (copy button, label line) must not be taken from it.
  function holdsOtherAddress(element, address) {
    if (!element || element.nodeType !== 1) return false;
    const own = String(address || "").toLowerCase();
    let shown = addressCache.get(element);
    if (!shown) {
      let text = textOf(element).slice(0, 6000);
      try { for (const field of element.querySelectorAll?.("input,textarea") || []) if (typeof field.value === "string" && field.value.length >= 25) text += `\n${field.value.slice(0, 200)}`; } catch {}
      try { shown = core.extractAddresses(text, { trustSolana: false, limit: 20 }).map(hit => hit.address.toLowerCase()); } catch { shown = []; }
      addressCache.set(element, shown);
    }
    return shown.some(value => value !== own);
  }

  function copyControlNear(element, section, address) {
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      if (depth > 0 && address && holdsOtherAddress(current, address)) break;
      try {
        if (current.matches?.(COPY_SELECTOR)) return true;
        for (const candidate of current.querySelectorAll?.(`${COPY_SELECTOR},button,[role='button']`) || []) {
          const descriptor = `${candidate.innerText || ""} ${candidate.getAttribute("aria-label") || ""} ${candidate.title || ""} ${candidate.className?.baseVal ?? candidate.className ?? ""} ${candidate.id || ""}`;
          if (/copy|clipboard/i.test(descriptor) || [...candidate.attributes].some(attribute => COPY_VALUE_ATTRIBUTES.has(attribute.name) || attribute.name === "data-clipboard-target")) return true;
        }
      } catch {}
      if (current === section) break;
      current = parentAcross(current);
    }
    return false;
  }

  function qrNear(element, section, identity) {
    if (pageView.qrAddresses.has(identity)) return { qrMatch: true, qrNearby: true };
    const scope = section || parentAcross(parentAcross(element));
    if (!scope) return { qrMatch: false, qrNearby: false };
    for (const qrElement of pageView.qrElements) if (qrElement.isConnected && scope.contains?.(qrElement)) return { qrMatch: false, qrNearby: true };
    try {
      const marked = scope.querySelector?.("img[alt*='qr' i],img[class*='qr' i],img[src*='qr' i],canvas[class*='qr' i],svg[class*='qr' i],[class*='qr' i] img,[class*='qr' i] canvas,[class*='qr' i] svg,[id*='qr' i]");
      return { qrMatch: false, qrNearby: Boolean(marked) };
    } catch { return { qrMatch: false, qrNearby: false }; }
  }

  function tableInfo(element) {
    const table = closestAcross(element, "table,[role='table'],[role='grid']");
    if (!table) return { inTable: false, txTable: false };
    const headers = [...table.querySelectorAll("thead th,th,[role='columnheader']")].slice(0, 20).map(header => shortText(header, 40));
    const matches = headers.filter(header => TX_HEADER_RE.test(header)).length;
    return { inTable: true, txTable: matches >= 2 };
  }

  const TOKEN_LINK_RE = /\/(?:token|tokens|token20|contract|contracts)\/[^/?#\s]{8,}|[?&#](?:outputcurrency|inputcurrency|tokenaddress|token_address|contractaddress|contract|outputmint|inputmint)=/i;
  function linkInfo(element, local, address) {
    const links = [];
    const anchor = closestAcross(element, "a[href]");
    if (anchor) links.push(anchor.getAttribute("href") || "");
    try { for (const link of local?.querySelectorAll?.("a[href]") || []) { links.push(link.getAttribute("href") || ""); if (links.length > 8) break; } } catch {}
    const own = String(address || "").toLowerCase();
    return {
      txLink: links.some(href => /\/(?:tx|txs|transaction|transactions)\/[^/?#\s]{8,}/i.test(href) || /#\/transaction\//i.test(href)),
      // a token page / swap link about THIS address (a token link elsewhere in the card describes another address)
      tokenLink: links.some(href => TOKEN_LINK_RE.test(href) && (!own || href.toLowerCase().includes(own))),
      addressLink: links.some(href => /\/(?:address|account|accounts|wallet)\/[^/?#\s]{8,}/i.test(href))
    };
  }

  // A repeated list/table row that carries a date or time stamp: a history/activity entry.
  const STAMP_RE = /\b(?:19|20)\d\d[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b|\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d\d\b|\b\d{1,2}:\d\d:\d\d\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2},? (?:19|20)\d\d\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* (?:19|20)\d\d\b|\b\d+ (?:secs?|mins?|minutes?|hours?|hrs?|days?|weeks?|months?) ago\b/i;
  function datedRow(element, section) {
    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (current.nodeType === 1 && current !== document.body) {
        const explicitRow = current.matches?.("tr,[role='row'],li");
        let repeated = false;
        if (!explicitRow && current.parentElement && typeof current.className === "string" && current.className.trim()) {
          const key = `${current.tagName}|${current.className}`;
          repeated = [...current.parentElement.children].some(child => child !== current && `${child.tagName}|${child.className}` === key);
        }
        if (explicitRow || repeated) {
          const text = textOf(current);
          if (text.length <= 600 && STAMP_RE.test(text)) return true;
          if (explicitRow) return false;
        }
      }
      if (current === section) break;
      current = parentAcross(current);
    }
    return false;
  }

  /**
   * Build classifier + hint inputs for an address found at `element`.
   * opts: {address, identity, family, method, field, placeholder, keyPath, extraLabel, uri}
   */
  function domContext(element, opts) {
    const address = opts.address;
    const hidden = !isRendered(element);
    const section = sectionFor(element);
    const local = localContainer(element, section, address);
    const localText = textOf(local);
    const sectionText = section ? textOf(section) : localText;
    const heading = headingFor(element, section);
    const field = opts.field || (element.matches?.("input,textarea") ? element : null);
    const label = [labelFor(field || element), columnHeaderFor(element), captionFor(element), fieldHintFor(field, opts), opts.extraLabel || ""].filter(Boolean).join(" · ").slice(0, 400);
    const scopes = selectorScope(element, hidden);
    const selected = selectedLabels(scopes);
    const qr = qrNear(element, section, opts.identity);
    const table = tableInfo(element);
    const links = linkInfo(element, local, address);
    const sectionScope = section || local;
    let amountField = false;
    try { amountField = [...(sectionScope.querySelectorAll?.("input") || [])].some(input => /amount|sum|quantity|qty/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.labels?.[0]?.innerText || ""}`)); } catch {}
    const editable = Boolean(field && !field.readOnly && !field.disabled && !opts.placeholder && field.matches("textarea,input:not([type]),input[type='text' i],input[type='search' i],input[type='url' i]"));
    const flags = {
      hidden,
      modal: Boolean(closestAcross(element, MODAL_SELECTOR)),
      shadow: inShadow(element),
      dynamic: isDynamic(element),
      qrMatch: qr.qrMatch,
      qrNearby: qr.qrNearby,
      copyControl: copyControlNear(element, section, address),
      networkSelector: hasNetworkSelector(scopes),
      readonly: Boolean(field && (field.readOnly || field.disabled)),
      editable,
      userTyped: Boolean(field && userEdited.has(field)),
      amountField,
      placeholder: Boolean(opts.placeholder),
      inCode: Boolean(closestAcross(element, "code,pre,kbd,samp")),
      docs: DOC_PATH_RE.test(location.pathname) || Boolean(closestAcross(element, "code,pre") && closestAcross(element, "[class*='doc' i],[class*='markdown' i],[class*='prose' i],[class*='api' i],article")),
      inTable: table.inTable,
      txTable: table.txTable,
      txLink: links.txLink,
      datedRow: datedRow(element, section),
      exampleFigure: Boolean(closestAcross(element, "figure,[class*='screenshot' i],[class*='mockup' i],[class*='example' i],[class*='sample' i]")),
      tokenLink: links.tokenLink,
      addressLink: links.addressLink,
      footer: Boolean(closestAcross(element, "footer,[role='contentinfo'],[class*='footer' i],[id*='footer' i]")),
      nav: Boolean(closestAcross(element, "nav,[role='navigation']")),
      blog: Boolean(closestAcross(element, "[class*='blog' i],[id*='blog' i],[class*='news' i],[id*='news' i],[class*='post-' i],article.post")),
      depositContainer: Boolean(closestAcross(element, "[class*='deposit' i],[id*='deposit' i],[class*='recharge' i],[class*='topup' i],[class*='top-up' i],[class*='payment' i],[id*='payment' i],[class*='checkout' i],[class*='invoice' i]")),
      withdrawContainer: Boolean(closestAcross(element, "[class*='withdraw' i],[id*='withdraw' i],[class*='payout' i]")),
      soleAddress: Boolean(section) && !holdsOtherAddress(section, address),
      uriLink: Boolean(opts.uri),
      uriTokenContract: Boolean(opts.uriTokenContract)
    };
    if (flags.footer || flags.nav) flags.depositContainer = flags.depositContainer && !/footer|nav/i.test(String(closestAcross(element, "[class*='deposit' i],[id*='deposit' i],[class*='payment' i]")?.className || ""));
    const localSnippet = around(localText, address, 320);
    const ctx = {
      heading,
      label,
      near: nearText(field || element, section, address),
      local: localSnippet,
      section: around(sectionText, address, 900),
      sectionTitle: heading || (section ? (section.getAttribute("aria-label") || section.id || section.tagName.toLowerCase()) : ""),
      keyPath: opts.keyPath || "",
      snippet: localText.length >= 120 ? around(localText, address, 600) : around(sectionText, address, 600),
      flags
    };
    const panel = hidden ? closestAcross(element, "[role='tabpanel']") : null;
    const hint = { selected, labels: [label, heading, panel ? tabLabelFor(panel) : ""].filter(Boolean), nearby: localSnippet, sectionText: around(sectionText, address, 900), uri: opts.uri || null };
    return { ctx, hint, evidence: { domPath: domPath(element) } };
  }

  /* ================================================================== */
  /* Page-view state and candidate aggregation                            */
  /* ================================================================== */

  let started = false;
  let pageView = newPageView();
  function newPageView() {
    return { url: location.href, wallets: new Map(), sent: new Map(), qrAddresses: new Set(), qrElements: new Set(), depositKeys: new Set(), scannedScripts: new WeakMap(), initialScanDone: false };
  }

  const FORMAT_RANK = { checksum_valid: 3, format_valid: 2, checksum_invalid: 1 };
  const METHOD_PRIORITY = ["qr", "copy-control", "uri-link", "clipboard", "shadow-dom", "modal", "dynamic", "input", "network-response", "script-config", "attribute", "text"];
  function primaryMethod(base, flags) {
    const modifiers = [];
    if (flags?.shadow) modifiers.push("shadow-dom");
    if (flags?.modal) modifiers.push("modal");
    if (flags?.dynamic) modifiers.push("dynamic");
    const all = [base, ...modifiers];
    return { method: all.sort((a, b) => METHOD_PRIORITY.indexOf(a) - METHOD_PRIORITY.indexOf(b))[0], methods: [base, ...modifiers] };
  }

  function resolveHint(family, hintInput) {
    const first = core.extractNetworkHint({ family, uri: hintInput.uri, qrUri: hintInput.qrUri, selected: hintInput.selected, labels: hintInput.labels, nearby: hintInput.nearby });
    if (first.hint?.network || !hintInput.sectionText) return first;
    const wider = core.extractNetworkHint({ family, nearby: hintInput.sectionText });
    if (wider.hint?.network) return { hint: { ...wider.hint, token: first.hint?.token || wider.hint.token }, mismatched: [...new Set([...first.mismatched, ...wider.mismatched])], ambiguous: first.ambiguous };
    return { hint: first.hint || wider.hint, mismatched: [...new Set([...first.mismatched, ...wider.mismatched])], ambiguous: [...new Set([...first.ambiguous, ...wider.ambiguous])] };
  }

  function consider(info, baseMethod, built, extra = {}) {
    if (!info?.identity) return;
    const { method, methods } = primaryMethod(baseMethod, built.ctx.flags);
    const context = core.classifyContext({ ...built.ctx, address: info.address, identity: info.identity, family: info.family, method });
    const hintResult = resolveHint(info.family, built.hint);
    if (hintResult.mismatched.length) context.negativeCues.push(`network label mismatch (${hintResult.mismatched.join(", ")})`);
    if (hintResult.ambiguous.length && !hintResult.hint?.network) context.negativeCues.push(`multiple networks listed (${hintResult.ambiguous.join(", ")})`);
    const hint = hintResult.hint;
    let entry = pageView.wallets.get(info.identity);
    if (!entry) {
      entry = { identity: info.identity, family: info.family, address: info.address, formatCheck: info.formatCheck, candidateNetworks: info.candidateNetworks, methods: new Set(), best: null, bestRank: -Infinity, evidence: {} };
      pageView.wallets.set(info.identity, entry);
    }
    for (const item of methods) entry.methods.add(item);
    if ((FORMAT_RANK[info.formatCheck] || 0) > (FORMAT_RANK[entry.formatCheck] || 0)) { entry.address = info.address; entry.formatCheck = info.formatCheck; }
    const evidence = { ...built.evidence, ...(extra.evidence || {}) };
    for (const [key, value] of Object.entries(evidence)) if (value && !entry.evidence[key]) entry.evidence[key] = value;
    const rank = core.contextRank(context) + (hint?.network ? 0.02 : 0) + (hint?.source === "selected-option" || hint?.source === "uri" ? 0.01 : 0);
    if (!entry.best || rank > entry.bestRank + 0.005) {
      entry.best = { method, context, hint, evidence, afterInteraction: Boolean(extra.afterInteraction ?? interacted) };
      entry.bestRank = rank;
    } else if (entry.best.context.class === context.class && !entry.best.hint?.network && hint?.network) {
      entry.best.hint = hint;
    }
  }

  /* ================================================================== */
  /* Scanners                                                             */
  /* ================================================================== */

  function collectText(root, budget = 3_000_000) {
    const map = [];
    let joined = "";
    let walker;
    try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); } catch { return { joined, map }; }
    let previousParent = null;
    let previousBlock = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || SKIP_TEXT_PARENTS.has(parent.tagName)) continue;
      const data = node.data.replace(/[​-‍⁠﻿­]/g, "");
      if (!data) continue;
      if (!data.trim()) { joined += " "; continue; }
      let block = parent;
      while (block && INLINE_TAGS.has(block.tagName)) block = block.parentElement;
      let separator = "\n";
      if (previousParent && block === previousBlock) separator = INLINE_TAGS.has(parent.tagName) && INLINE_TAGS.has(previousParent.tagName) ? "" : " ";
      joined += separator;
      map.push({ node, start: joined.length, end: joined.length + data.length });
      joined += data;
      previousParent = parent;
      previousBlock = block;
      if (joined.length > budget) break;
    }
    return { joined, map };
  }

  function nodesFor(map, start, end) {
    let low = 0;
    let high = map.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (map[middle].end <= start) low = middle + 1; else high = middle;
    }
    const nodes = [];
    for (let index = low; index < map.length && map[index].start < end; index += 1) nodes.push(map[index].node);
    return nodes;
  }

  function commonAncestor(a, b) {
    if (!a) return b;
    if (!b || a === b) return a;
    const ancestors = new Set();
    for (let current = a; current; current = current.parentElement) ancestors.add(current);
    for (let current = b; current; current = current.parentElement) if (ancestors.has(current)) return current;
    return a;
  }

  function scanTextRoot(root) {
    const { joined, map } = collectText(root);
    if (joined.length < 25) return;
    let count = 0;
    for (const hit of core.extractAll(joined)) {
      if (++count > 300) break;
      const nodes = nodesFor(map, hit.index, hit.end);
      if (!nodes.length) continue;
      const element = commonAncestor(nodes[0].parentElement, nodes[nodes.length - 1].parentElement);
      if (!element) continue;
      const built = domContext(element, { address: hit.address, identity: hit.identity, family: hit.family, uri: hit.uri, uriTokenContract: hit.uriTokenContract });
      if (hit.uri) built.evidence.uri = hit.uri.uri;
      consider(hit, "text", built);
    }
  }

  function scanFields(root) {
    let fields = [];
    try { fields = [...(root.querySelectorAll?.("input,textarea") || [])]; } catch {}
    if (root.nodeType === 1 && root.matches?.("input,textarea")) fields.unshift(root);
    for (const field of fields.slice(0, 2000)) {
      const type = (field.getAttribute("type") || "").toLowerCase();
      const privateField=[field.name,field.id,field.autocomplete,field.getAttribute('aria-label'),field.placeholder,type].join(' ');
      if (/password|email|username|user-name|one-time-code|verification|otp|secret|token|private.?key|seed.?phrase/i.test(privateField)) continue;
      const value = typeof field.value === "string" ? field.value : "";
      if (value.length >= 25 && value.length <= 4096) {
        for (const hit of core.extractAll(value, { context: labelFor(field) })) {
          const built = domContext(field, { address: hit.address, identity: hit.identity, family: hit.family, field, uri: hit.uri });
          consider(hit, type === "hidden" ? "attribute" : "input", built);
        }
      }
      const placeholder = field.getAttribute("placeholder") || "";
      if (placeholder.length >= 25) {
        for (const hit of core.extractAll(placeholder, { trustSolana: true })) {
          const built = domContext(field, { address: hit.address, identity: hit.identity, family: hit.family, field, placeholder: true });
          consider(hit, "input", built);
        }
      }
    }
  }

  const SKIP_ATTRIBUTES = new Set(["class", "style", "id", "value", "placeholder", "d", "points", "viewbox", "transform", "integrity", "nonce", "srcset", "sizes"]);
  function scanAttributes(root, budget = 25000) {
    let elements = [];
    try { elements = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch {}
    const list = root.nodeType === 1 ? [root, ...elements] : [...elements];
    let visited = 0;
    for (const element of list) {
      if (++visited > budget) break;
      const attributes = element.attributes;
      if (!attributes || !attributes.length) continue;
      for (const attribute of attributes) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (SKIP_ATTRIBUTES.has(name) || !value || value.length < 25 || value.length > 4096) continue;
        if (name.startsWith("on")) continue;
        if (name === "value" && element.matches("input,textarea")) continue;
        let hits;
        try { hits = core.extractAll(value, { context: core.splitKeyWords(name) }); } catch { continue; }
        for (const hit of hits) {
          let base = "attribute";
          if (name === "href" && hit.uri) base = "uri-link";
          else if (COPY_VALUE_ATTRIBUTES.has(name)) base = "copy-control";
          const built = domContext(element, { address: hit.address, identity: hit.identity, family: hit.family, uri: hit.uri, uriTokenContract: hit.uriTokenContract, keyPath: name.startsWith("data-") ? name : "", extraLabel: core.splitKeyWords(name) });
          if (base === "copy-control") built.ctx.flags.copyControl = true;
          if (hit.uri) built.evidence.uri = hit.uri.uri;
          if (/^(?:src|href)$/.test(name) && /qr|barcode|chart\.googleapis/i.test(value)) built.ctx.flags.qrNearby = true;
          consider(hit, base, built);
        }
      }
      // data-clipboard-target="#selector": the copy control is bound to another element's text/value.
      const target = element.getAttribute("data-clipboard-target");
      if (target && target.length < 200) {
        let bound = null;
        try { bound = element.getRootNode().querySelector(target); } catch {}
        const text = bound ? (typeof bound.value === "string" && bound.value ? bound.value : bound.textContent || "") : "";
        for (const hit of core.extractAll(text.slice(0, 4096), { trustSolana: true })) {
          const built = domContext(bound, { address: hit.address, identity: hit.identity, family: hit.family, field: bound.matches?.("input,textarea") ? bound : null });
          built.ctx.flags.copyControl = true;
          consider(hit, "copy-control", built);
        }
      }
    }
  }

  function scanScripts() {
    let total = 0;
    for (const script of document.querySelectorAll("script:not([src])")) {
      const type = (script.getAttribute("type") || "").toLowerCase();
      if (type && !/javascript|ecmascript|json|module|^text\/babel$|^$/.test(type)) continue;
      const text = script.textContent || "";
      if (text.length < 25 || text.length > 1_000_000) continue;
      if (pageView.scannedScripts.get(script) === text.length) continue;
      pageView.scannedScripts.set(script, text.length);
      total += text.length;
      if (total > 6_000_000) break;
      let findings = [];
      try { findings = core.scanScriptText(text, { json: /json/.test(type) }); } catch { continue; }
      for (const finding of findings) {
        const info = core.identify(finding.address, { allowInvalidChecksum: true });
        if (!info) continue;
        const built = jsonContext(finding, info);
        built.evidence.domPath = domPath(script);
        consider(info, "script-config", built);
      }
    }
  }

  function jsonContext(finding, info) {
    const uri = finding.uri ? (typeof finding.uri === "string" ? core.parsePaymentUri(finding.uri) : finding.uri) : null;
    const parentPath = String(finding.keyPath || "").replace(/(?:\.[^.[\]]+|\[\d*\])$/, "");
    return {
      ctx: { heading: "", label: finding.hintText || "", local: finding.snippet || "", section: "", sectionTitle: parentPath || finding.keyPath || "", keyPath: finding.keyPath || "", snippet: finding.snippet || "", flags: { uriLink: Boolean(uri && uri.info.identity === info.identity) } },
      hint: { uri: uri && uri.info.identity === info.identity ? uri : null, selected: [], labels: [finding.hintText || ""].filter(Boolean), nearby: finding.snippet || "" },
      evidence: { uri: uri?.uri || null }
    };
  }

  function processBridge() {
    const items = bridgeInbox.splice(0, bridgeInbox.length);
    for (const item of items) {
      for (const finding of item.findings) {
        const info = core.identify(finding.address, { allowInvalidChecksum: true });
        if (!info) continue;
        if (item.source === "clipboard") {
          const element = lastClick.element && Date.now() - lastClick.at < 4000 ? lastClick.element : null;
          considerClipboard(info, element, finding.snippet, item.afterInteraction, "writeText");
          continue;
        }
        const built = jsonContext(finding, info);
        if (item.source === "network-response") built.evidence.responseUrl = item.responseUrl;
        consider(info, item.source, built, { afterInteraction: item.afterInteraction });
      }
    }
  }

  function considerClipboard(info, element, text, afterInteraction, via) {
    let built;
    if (element?.isConnected) {
      built = domContext(element, { address: info.address, identity: info.identity, family: info.family });
      built.ctx.flags.copyControl = true;
      built.ctx.flags.hidden = false; // the person copied it: it was presented to them
    } else {
      built = { ctx: { heading: "", label: "", local: text || "", section: "", keyPath: "", snippet: text || "", flags: { copyControl: true } }, hint: { selected: [], labels: [], nearby: text || "" }, evidence: {} };
    }
    built.ctx.label = [built.ctx.label, `copied to clipboard (${via})`].filter(Boolean).join(" · ");
    consider(info, "clipboard", built, { afterInteraction });
  }

  function processClipboard() {
    const items = clipboardInbox.splice(0, clipboardInbox.length);
    for (const item of items) {
      for (const hit of core.extractAll(item.text, { trustSolana: true }).slice(0, 10)) considerClipboard(hit, item.element, item.text, item.afterInteraction, item.via);
    }
  }

  async function scanQr(roots, force) {
    if (typeof QrWalletScanner === "undefined") return;
    let sources = [];
    try { sources = await QrWalletScanner.scan({ roots, force }); } catch { return; }
    for (const source of sources) {
      const payload = String(source.payload || "").trim();
      if (!payload) continue;
      let uri = core.parsePaymentUri(payload);
      let info = uri ? uri.info : core.identify(payload, { allowInvalidChecksum: true });
      if (!info) {
        const hit = core.extractAll(payload, { trustSolana: true })[0];
        if (!hit) continue;
        info = hit; uri = hit.uri;
      }
      pageView.qrAddresses.add(info.identity);
      pageView.qrElements.add(source.element);
      const built = domContext(source.element, { address: info.address, identity: info.identity, family: info.family });
      built.ctx.flags.qrMatch = true;
      built.hint.qrUri = uri || null;
      built.hint.uri = null;
      built.ctx.label = [built.ctx.label, source.element.getAttribute?.("alt") || ""].filter(Boolean).join(" · ");
      consider(info, "qr", built, { evidence: { qrPayload: payload.slice(0, 600), uri: uri?.uri || null } });
    }
  }

  /* ---------- shadow roots (open + closed, read-only) ---------- */

  const knownRoots = new Set();
  const HOST_TAGS = new Set(["DIV", "SPAN", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "NAV", "MAIN", "P", "BLOCKQUOTE", "BODY", "H1", "H2", "H3", "H4", "H5", "H6"]);
  function shadowRootOf(element) {
    if (element.shadowRoot) return element.shadowRoot;
    if (!element.tagName.includes("-") && !HOST_TAGS.has(element.tagName)) return null;
    try { return chrome.dom?.openOrClosedShadowRoot?.(element) || null; } catch { return null; }
  }
  function discoverShadowRoots(start, budget = { left: 30000 }) {
    let elements;
    try { elements = start.querySelectorAll ? start.querySelectorAll("*") : []; } catch { return; }
    const list = start.nodeType === 1 ? [start, ...elements] : elements;
    for (const element of list) {
      if (--budget.left <= 0) return;
      const root = shadowRootOf(element);
      if (!root || knownRoots.has(root)) continue;
      knownRoots.add(root);
      observe(root);
      discoverShadowRoots(root, budget);
    }
  }
  function liveRoots() {
    const roots = [document];
    for (const root of knownRoots) { if (root.host?.isConnected) roots.push(root); else knownRoots.delete(root); }
    return roots;
  }

  /* ================================================================== */
  /* Scan orchestration                                                   */
  /* ================================================================== */

  const dirty = new Set();
  let scanTimer = null;
  let scanning = false;
  let rerun = null;
  let pendingMode = "targeted";
  let pendingForce = false;
  let lastFullScan = 0;

  function scanSubtree(root) {
    scanTextRoot(root);
    scanFields(root);
    scanAttributes(root);
  }

  async function scan(mode, force) {
    if (scanning) { rerun = { mode: rerun?.mode === "full" || mode === "full" ? "full" : "targeted", force: Boolean(rerun?.force || force) }; return; }
    scanning = true;
    textCache = new Map();
    addressCache = new Map();
    try {
      if (location.href !== pageView.url) resetPageView();
      if (mode === "full") {
        lastFullScan = Date.now();
        discoverShadowRoots(document.documentElement);
        dirty.clear();
        for (const root of liveRoots()) scanSubtree(root === document ? document.documentElement : root);
        scanScripts();
        await scanQr(liveRoots(), force);
        pageView.initialScanDone = true;
      } else {
        const targets = [...dirty].filter(node => node?.isConnected);
        dirty.clear();
        const roots = targets.map(node => (node.nodeType === 1 ? node : node.parentElement)).filter(Boolean);
        const unique = roots.filter(node => !roots.some(other => other !== node && other.contains?.(node)));
        if (unique.some(node => node === document.documentElement || node === document.body) || unique.length > 150) {
          if (Date.now() - lastFullScan > 1500) { scanning = false; return scan("full", force); }
        }
        for (const node of unique.slice(0, 150)) {
          discoverShadowRoots(node, { left: 5000 });
          scanSubtree(node);
          const root = node.getRootNode?.();
          if (root && root.nodeType === 11) observe(root);
        }
        if (unique.some(node => node.matches?.("img,canvas,svg,video,[class*='qr' i]") || node.querySelector?.("img,canvas,svg,video"))) await scanQr(liveRoots(), false);
      }
      processBridge();
      processClipboard();
      await flush();
    } catch (error) {
      console.debug("Crypto Wallet Logger scan skipped:", error);
    } finally {
      scanning = false;
      textCache = new Map();
      addressCache = new Map();
      if (rerun) { const next = rerun; rerun = null; scheduleScan(150, next.mode, next.force); }
    }
  }

  function scheduleScan(delay = 350, mode = "targeted", force = false) {
    if (mode === "full") pendingMode = "full";
    pendingForce ||= force;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const nextMode = pendingMode;
      const nextForce = pendingForce;
      pendingMode = "targeted";
      pendingForce = false;
      scan(nextMode, nextForce);
    }, delay);
  }

  function resetPageView() {
    pageView = newPageView();
    interacted = false;
  }

  /* ---------- reporting ---------- */

  function legacyEvidence(entry, best) {
    const items = [];
    const context = best.context;
    items.push(`Context: ${context.class} (${context.confidence})`);
    if (context.class === "deposit") items.push("Inside deposit/payment section");
    if (entry.methods.has("qr")) items.push(context.class === "deposit" ? "Address appeared beside deposit QR code" : "Address decoded from QR code");
    if (entry.methods.has("input")) items.push("Address found in input or read-only field");
    if (entry.methods.has("copy-control") || entry.methods.has("clipboard") || context.cues.includes("copy button next to address")) items.push("Copy-address control nearby");
    if (entry.methods.has("modal")) items.push("Address found in modal or popup");
    if (entry.methods.has("shadow-dom")) items.push("Address found in Shadow DOM section");
    if (entry.methods.has("network-response")) items.push("Address found in a network response the page loaded");
    if (entry.methods.has("script-config")) items.push("Address found in page script/config data");
    if (best.hint?.source === "selected-option" && best.hint.network) items.push(`Selected network: ${core.LEGACY_NETWORK_SHORT[best.hint.network] || best.hint.network}`);
    if (best.hint?.token && best.hint.source === "selected-option") items.push(`Selected token: ${best.hint.token}`);
    if (best.hint?.network && best.hint.source !== "selected-option") items.push(`Network label: ${core.LEGACY_NETWORK_SHORT[best.hint.network] || best.hint.network} (${best.hint.source})`);
    if (/deposit address label/.test(context.cues.join(" "))) items.push("Label: Deposit Address");
    if (entry.evidence.qrPayload) items.push(`QR payload scheme: ${String(entry.evidence.qrPayload).split(":")[0].slice(0, 20)}`);
    for (const cue of context.cues.slice(0, 6)) items.push(`Cue: ${cue}`);
    return [...new Set(items)].slice(0, 16);
  }

  function walletMessage(entry) {
    const best = entry.best;
    const context = best.context;
    const legacy = core.legacyNetworkLabel(entry.family, best.hint);
    const tags = [best.hint?.token, best.hint?.network ? core.LEGACY_NETWORK_SHORT[best.hint.network] : null, context.class === "deposit" ? "Payment/deposit label" : null, `class:${context.class}`].filter(Boolean);
    return {
      address: entry.address,
      network: legacy.network,
      confidence: legacy.confidence,
      classificationScore: (legacy.confidence === "high" ? 300 : 100) + (best.hint?.network ? 30 : 5) + (best.hint?.token ? 10 : 0) + (context.class === "deposit" ? 5 : 0),
      context: context.snippet,
      contextScore: Math.round(context.confidence * 30),
      evidenceScore: Math.round(context.confidence * 30) + (context.class === "deposit" ? 10 : 0),
      evidenceTags: [...new Set(tags)],
      evidenceItems: legacyEvidence(entry, best),
      evidenceSource: best.method,
      detectionMethods: [...entry.methods],
      contextClass: context.class,
      contextConfidence: context.confidence,
      observation: {
        address: entry.address,
        family: entry.family,
        candidateNetworks: entry.candidateNetworks,
        networkHint: best.hint ? { network: best.hint.network, token: best.hint.token, source: best.hint.source } : null,
        formatCheck: entry.formatCheck,
        context: { class: context.class, confidence: context.confidence, cues: context.cues, negativeCues: context.negativeCues, section: context.section, snippet: context.snippet },
        detection: { method: best.method, methods: [...entry.methods], afterInteraction: best.afterInteraction },
        evidence: Object.fromEntries(Object.entries({ domPath: best.evidence.domPath || entry.evidence.domPath, qrPayload: best.evidence.qrPayload || entry.evidence.qrPayload, responseUrl: best.evidence.responseUrl || entry.evidence.responseUrl, uri: best.evidence.uri || entry.evidence.uri }).filter(([, value]) => value)),
        frameUrl: location.href
      }
    };
  }

  function depositInterface(entry, message) {
    const best = entry.best;
    const network = best.hint?.network ? core.LEGACY_NETWORK_SHORT[best.hint.network] || best.hint.network : "";
    const token = best.hint?.token || "";
    return {
      token, network, canonicalNetwork: best.hint?.network || "", selectedToken: best.hint?.source === "selected-option" ? token : "", selectedNetwork: best.hint?.source === "selected-option" ? network : "",
      sectionIdentity: best.context.section || best.evidence.domPath || "deposit",
      pageUrl: location.href, sourcePageUrl: location.href,
      depositLabels: best.context.cues.slice(0, 8), nearbyEvidence: best.context.snippet,
      detectionMethods: [...entry.methods], evidenceItems: message.evidenceItems, evidenceTags: message.evidenceTags,
      qrMatch: entry.methods.has("qr"), wallet: entry.address, contextClass: "deposit", contextConfidence: best.context.confidence,
      confidence: token && network ? "high" : token || network ? "medium" : "review",
      uncertainReason: token && network ? "" : "Deposit context lacks a strong token/network pairing."
    };
  }

  function fingerprint(message) {
    const observation = message.observation;
    return JSON.stringify([observation.address, observation.formatCheck, observation.networkHint, observation.context.class, observation.context.confidence, observation.context.cues, observation.detection.method, [...observation.detection.methods].sort(), observation.evidence]);
  }

  let reportedFrame = null;
  async function flush() {
    const wallets = [];
    const interfaces = [];
    for (const entry of pageView.wallets.values()) {
      if (!entry.best) continue;
      const message = walletMessage(entry);
      const print = fingerprint(message);
      if (pageView.sent.get(entry.identity) === print) continue;
      pageView.sent.set(entry.identity, print);
      wallets.push(message);
      if (entry.best.context.class === "deposit") {
        const option = depositInterface(entry, message);
        const key = [option.sectionIdentity, option.token, option.network, entry.identity].join("|");
        if (!pageView.depositKeys.has(key)) { pageView.depositKeys.add(key); interfaces.push(option); }
      }
    }
    const page = { url: location.href, domain: location.hostname, title: document.title };
    try {
      if (reportedFrame !== location.href) { reportedFrame = location.href; await chrome.runtime.sendMessage({ type: "REPORT_SCAN", page }); }
      if (interfaces.length) await chrome.runtime.sendMessage({ type: "REPORT_DEPOSIT_INTERFACES", page, interfaces });
      for (let index = 0; index < wallets.length; index += 40) await chrome.runtime.sendMessage({ type: "SAVE_WALLETS", page, wallets: wallets.slice(index, index + 40) });
    } catch {
      // Extension context invalidated (reload/update): allow a resend after reconnect.
      for (const message of wallets) pageView.sent.delete(core.identify(message.address)?.identity);
    }
  }

  /* ---------- observers ---------- */

  const observedRoots = new WeakSet();
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target) dirty.add(target);
      if (mutation.type === "characterData" && pageView.initialScanDone && target) dynamicNodes.add(target);
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType === 1) {
          dirty.add(node);
          if (pageView.initialScanDone) dynamicNodes.add(node);
          discoverShadowRoots(node, { left: 3000 });
        } else if (node.parentElement) {
          dirty.add(node.parentElement);
          if (pageView.initialScanDone) dynamicNodes.add(node.parentElement);
        }
      }
    }
    if (started) scheduleScan(350, "targeted");
  });

  function observe(root) {
    if (!root || observedRoots.has(root)) return;
    const target = root === document ? document.documentElement : root;
    if (!target) return;
    try {
      observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
      root.addEventListener?.("load", event => {
        if (event.target?.matches?.("img,video")) { QrWalletScanner?.invalidate?.(event.target); dirty.add(event.target); scheduleScan(200, "targeted"); }
      }, true);
      observedRoots.add(root);
    } catch {}
  }

  function start() {
    if (started) return;
    started = true;
    observe(document);
    scheduleScan(80, "full");
    let polls = 0;
    const poll = () => {
      polls += 1;
      if (document.visibilityState === "visible") scheduleScan(0, polls <= 6 ? "full" : "targeted");
      setTimeout(poll, polls < 6 ? 4000 : 20000);
    };
    setTimeout(poll, 4000);
    setInterval(() => {
      if (location.href === pageView.url) return;
      resetPageView();
      scheduleScan(120, "full");
    }, 750);
    addEventListener("pageshow", () => scheduleScan(100, "full"), true);
    addEventListener("load", () => scheduleScan(200, "full"), { once: true });
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "RESCAN_PAGE") { pageView.sent.clear(); scheduleScan(0, "full", true); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
