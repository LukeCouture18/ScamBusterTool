"use strict";

const recordsEl = document.querySelector("#records");
let currentDomain = "";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch { return "#"; }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pageFor(record) {
  return record.evidencePageUrl || record.lastPageUrl || record.pageUrl || record.pageUrls?.[0]?.url || "";
}

function tagsFor(record) {
  const tags = Array.isArray(record.evidenceTags) ? record.evidenceTags : [];
  return tags.length ? `<div class="evidence-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : "";
}

function evidenceFor(record) {
  const items = Array.isArray(record.evidenceItems) ? record.evidenceItems : [];
  if (!items.length) return "";
  return `<div class="evidence"><strong>Evidence</strong><ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

function cardFor(record, newIds) {
  const page = pageFor(record);
  const isNew = newIds.has(record.id);
  const rating = WalletEvidenceScore.calculate(record);
  const activity = record.verification?.status || "UNKNOWN";
  return `
    <article class="card ${isNew ? "is-new" : ""}" data-id="${escapeHtml(record.id)}">
      <div class="card-top">
        <div class="badges">
          ${isNew ? '<span class="badge new-badge">NEW</span>' : ""}
          <span class="badge ${record.confidence === "review" ? "review" : ""}">${escapeHtml(record.network)}</span>
          <span class="badge confidence ${record.confidence === "review" ? "review" : ""}">${record.confidence === "review" ? "Needs review" : `${escapeHtml(record.confidence)} confidence`}</span>
          ${record.contextClass ? `<span class="badge context-${escapeHtml(record.contextClass)}" title="Context class (confidence ${escapeHtml(Number(record.contextConfidence || 0).toFixed(2))})">${escapeHtml(record.contextClass.replace("_", " "))}</span>` : ""}
          ${record.detectionMethod ? `<span class="badge" title="Detection method">${escapeHtml(record.detectionMethod)}</span>` : ""}
        </div>
        <span class="meta">Seen ${Number(record.seenCount) || 1}×</span>
      </div>
      <div class="wallet-address">${escapeHtml(record.address)}</div>
      <div class="wallet-summary"><span>Evidence <strong>${rating.score}/100</strong></span><span class="activity ${activity === "ACTIVE" ? "active" : activity === "VERIFICATION FAILED" ? "failed" : activity === "NO ACTIVITY FOUND" ? "none" : ""}">${escapeHtml(activity)}</span></div>
      ${page ? `<a class="page-link" href="${escapeHtml(safeUrl(page))}" target="_blank" rel="noreferrer" title="${escapeHtml(page)}">${escapeHtml(page)}</a>` : ""}
      <div class="context">${escapeHtml(record.context || "No nearby context saved.")}</div>
      ${evidenceFor(record)}
      ${tagsFor(record)}
      <div class="actions"><button data-details="${escapeHtml(record.id)}">Details</button><button data-verify="${escapeHtml(record.id)}">${record.verification ? "Refresh" : "Verify"}</button><button data-copy="${escapeHtml(record.address)}">Copy</button><button class="danger" data-delete="${escapeHtml(record.id)}">Delete</button></div>
    </article>`;
}

async function render() {
  const tab = await currentTab();
  try { currentDomain = new URL(tab.url).hostname; } catch { currentDomain = ""; }
  document.querySelector("#domain").textContent = currentDomain || "Unsupported browser page";

  const [localStored, sessionStored] = await Promise.all([
    chrome.storage.local.get(["walletRecords", "websiteRecords", "depositRecords"]),
    chrome.storage.session.get("walletSessionStats")
  ]);
  const { walletRecords = [], websiteRecords = [], depositRecords = [] } = localStored;
  const domainStats = sessionStored.walletSessionStats?.domains?.[currentDomain] || { pages: [], newWalletIds: [], lastScanAt: null };
  const records = walletRecords
    .filter(record => record.domain === currentDomain)
    .sort((a, b) => WalletEvidenceScore.calculate(b).score - WalletEvidenceScore.calculate(a).score || new Date(b.lastSeenAt || b.foundAt) - new Date(a.lastSeenAt || a.foundAt));
  const recordIds = new Set(records.map(record => record.id));
  const newIds = new Set((domainStats.newWalletIds || []).filter(id => recordIds.has(id)));
  const uncertain = records.filter(record => record.confidence === "review").length;
  const website = websiteRecords.find(record => record.domain === currentDomain);
  const depositPages = new Set(depositRecords.filter(record => record.domain === currentDomain).map(record => record.pageUrl)).size;
  const recentlyScanned = domainStats.lastScanAt && Date.now() - new Date(domainStats.lastScanAt).getTime() < 45_000;

  document.querySelector("#count").textContent = records.length;
  document.querySelector("#pagesScanned").textContent = website?.pageUrls?.length || domainStats.pages?.length || 0;
  document.querySelector("#depositPages").textContent = depositPages;
  document.querySelector("#siteWallets").textContent = records.length;
  document.querySelector("#highConfidence").textContent = records.filter(record => record.confidence === "high").length;
  document.querySelector("#newWallets").textContent = newIds.size;
  document.querySelector("#uncertainWallets").textContent = uncertain;
  document.querySelector("#statusDot").classList.toggle("live", Boolean(recentlyScanned));

  if (!records.length) {
    recordsEl.innerHTML = '<div class="empty">No wallet addresses saved from this website yet.<br><span class="muted">Open a deposit or payment page and the logger will watch for one.</span></div>';
    return;
  }

  const confirmed = records.filter(record => record.confidence !== "review");
  const review = records.filter(record => record.confidence === "review");
  recordsEl.innerHTML = `
    <section class="wallet-section">
      <h2>Detected wallets <span>${confirmed.length}</span></h2>
      ${confirmed.length ? confirmed.map(record => cardFor(record, newIds)).join("") : '<div class="section-empty">No confidently classified wallets yet.</div>'}
    </section>
    ${review.length ? `<section class="wallet-section review-section"><h2>Review <span>${review.length}</span></h2><p>Valid address format, but the exact token or network needs confirmation.</p>${review.map(record => cardFor(record, newIds)).join("")}</section>` : ""}`;
}

recordsEl.addEventListener("click", async event => {
  const details = event.target.closest("[data-details]");
  if (details) chrome.tabs.create({ url: `${chrome.runtime.getURL("details.html")}?id=${encodeURIComponent(details.dataset.details)}` });
  const verify = event.target.closest("[data-verify]");
  if (verify) {
    verify.disabled = true;
    verify.textContent = "Checking…";
    const { walletRecords = [] } = await chrome.storage.local.get("walletRecords");
    const record = walletRecords.find(item => item.id === verify.dataset.verify);
    const response = await chrome.runtime.sendMessage({ type: "VERIFY_WALLET", recordId: verify.dataset.verify, force: Boolean(record?.verification) });
    if (response?.error) alert(response.error);
    await render();
  }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy);
    const old = copy.textContent;
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = old; }, 900);
  }
  const remove = event.target.closest("[data-delete]");
  if (remove && confirm("Delete this wallet and its linked deposit evidence?")) {
    const response = await chrome.runtime.sendMessage({ type: "DELETE_RECORD", targetType: "wallet", targetId: remove.dataset.delete });
    if (response?.error) alert(response.error);
  }
});

document.querySelector("#openHistory").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html") }));
document.querySelector("#openWebsite").addEventListener("click", () => {
  if (currentDomain) chrome.tabs.create({ url: `${chrome.runtime.getURL("website.html")}?domain=${encodeURIComponent(currentDomain)}` });
});
document.querySelector("#rescan").addEventListener("click", async () => {
  const tab = await currentTab();
  try { await chrome.tabs.sendMessage(tab.id, { type: "RESCAN_PAGE" }); } catch {}
  setTimeout(render, 800);
});
chrome.storage.onChanged.addListener(render);
render();
