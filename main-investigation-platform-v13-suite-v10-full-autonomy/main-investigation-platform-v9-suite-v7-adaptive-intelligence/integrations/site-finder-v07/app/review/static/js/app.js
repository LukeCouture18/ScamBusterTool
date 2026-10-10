/* ScamHunter live dashboard. No build step, no framework — plain JS, talking
   to the Flask JSON API and an SSE stream for live updates. */

const API = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw await errorFromResponse(r);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw await errorFromResponse(r);
    return r.json();
  },
};

async function errorFromResponse(r) {
  let msg = `Request failed (${r.status})`;
  try {
    const data = await r.json();
    if (data.error) msg = data.error;
    else if (data.message) msg = data.message;
  } catch (e) { /* not JSON, use default */ }
  return new Error(msg);
}

function showError(message) {
  const banner = document.getElementById("error-banner");
  document.getElementById("error-banner-text").textContent = message;
  banner.style.display = "flex";
}
document.getElementById("error-banner-close").onclick = () => {
  document.getElementById("error-banner").style.display = "none";
};

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function riskClass(score) {
  if (score >= 7) return "risk-high";
  if (score >= 4) return "risk-med";
  return "risk-low";
}

function bump(el) {
  el.classList.remove("bump");
  void el.offsetWidth; // restart animation
  el.classList.add("bump");
}

const INVESTIGATION_STATUS_CLASS = {
  starting: "status-queued",
  browsing: "status-scanning",
  completed: "status-scanned",
  blocked: "status-error",
  error: "status-error",
  unreachable: "status-error",
  stopped: "status-queued",
};

function investigationStatusBadge(status) {
  const cls = INVESTIGATION_STATUS_CLASS[status] || "status-new";
  return `<span class="status-badge ${cls}">${escapeHtml(status)}</span>`;
}

/* ==================== VIEW ROUTING ==================== */

const views = ["overview", "results", "clusters", "performance", "platform", "campaigns", "pivot", "workspace", "discovery", "sites", "investigations", "highrisk", "wallets", "review", "settings"];

function switchView(name) {
  views.forEach((v) => {
    document.getElementById(`view-${v}`).style.display = v === name ? "block" : "none";
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "results") loadResultsView();
  if (name === "clusters") loadClustersView();
  if (name === "overview") loadMainScreen();
  if (name === "performance") loadPerformanceView();
  if (name === "platform") loadPlatformView();
  if (name === "campaigns") loadCampaignsView();
  if (name === "pivot") loadPivotView();
  if (name === "workspace") loadWorkspaceView();
  if (name === "discovery") loadDiscoveryView();
  if (name === "sites") loadSites();
  if (name === "investigations") loadInvestigations();
  if (name === "highrisk") loadHighRisk();
  if (name === "wallets") loadWallets();
  if (name === "review") loadReviewQueue();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

/* ==================== SCAN CONTROLS ==================== */

const btnStart = document.getElementById("btn-start");
const btnPause = document.getElementById("btn-pause");
const btnResume = document.getElementById("btn-resume");
const btnStop = document.getElementById("btn-stop");
const scanStateBadge = document.getElementById("scan-state-badge");
const currentSiteBox = document.getElementById("current-site-box");
const currentSiteUrl = document.getElementById("current-site-url");
const currentSiteMeta = document.getElementById("current-site-meta");
const progressFill = document.getElementById("progress-fill");

function applyScanState(state) {
  scanStateBadge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  scanStateBadge.className = "scan-state state-" + state;

  const running = state === "running";
  const paused = state === "paused";
  const stopping = state === "stopping";
  const idle = state === "idle";

  btnStart.disabled = !idle;
  btnPause.disabled = !running;
  btnPause.style.display = paused ? "none" : "inline-block";
  btnResume.style.display = paused ? "inline-block" : "none";
  btnResume.disabled = !paused;
  btnStop.disabled = idle;

  if (idle) {
    currentSiteBox.style.display = "none";
    progressFill.style.width = "0%";
  }
}

btnStart.addEventListener("click", async () => {
  try {
    const settings = await API.get("/api/settings");
    await API.post("/api/scan/start", {
      batch_size: settings.batch_size,
      headless: settings.headless,
      rank_limit: settings.rank_limit,
      run_collection: settings.run_collection,
      run_discovery: settings.run_discovery,
      run_ranking: settings.run_ranking,
      risk_threshold: settings.risk_threshold,
      allow_signup: settings.allow_signup,
      deep_wallet_hunt: settings.deep_wallet_hunt,
    });
  } catch (e) { showError(e.message); }
});
btnPause.addEventListener("click", async () => {
  try { await API.post("/api/scan/pause"); } catch (e) { showError(e.message); }
});
btnResume.addEventListener("click", async () => {
  try { await API.post("/api/scan/resume"); } catch (e) { showError(e.message); }
});
btnStop.addEventListener("click", async () => {
  try { await API.post("/api/scan/stop"); } catch (e) { showError(e.message); }
});

/* ==================== LIVE ACTIVITY LOG ==================== */

const logPanel = document.getElementById("log-panel");
let logCount = 0;
const MAX_LOG_LINES = 300;

function appendLog(level, message) {
  const line = document.createElement("div");
  line.className = "log-line log-" + (level || "info");
  line.textContent = message;
  logPanel.appendChild(line);
  logCount++;
  if (logCount > MAX_LOG_LINES) {
    logPanel.removeChild(logPanel.firstChild);
    logCount--;
  }
  logPanel.scrollTop = logPanel.scrollHeight;
}

document.getElementById("clear-log-btn").addEventListener("click", () => {
  logPanel.innerHTML = "";
  logCount = 0;
});

/* ==================== STATS (OVERVIEW) ==================== */

async function refreshStats() {
  try {
    const stats = await API.get("/api/stats");
    setStatValue("stat-total-sites", stats.total_sites);
    setStatValue("stat-scanned-sites", stats.by_status.scanned || 0);
    setStatValue("stat-high-risk", stats.high_risk_sites);
    setStatValue("stat-wallets", stats.total_wallets);
    setStatValue("stat-pending", stats.pending_findings);
    setStatValue("stat-submitted", stats.submitted_findings);

    // The v0.7 main screen replaced the stat tiles with operational panels, so
    // setStatValue is a no-op for the removed ids. The nav counts remain.
    const setNav = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || "";
    };
    setNav("nav-count-sites", stats.total_sites);
    setNav("nav-count-highrisk", stats.high_risk_sites);
    setNav("nav-count-wallets", stats.total_wallets);
    setNav("nav-count-review", stats.pending_findings);
  } catch (e) { /* stats failures are non-fatal; keep last known values */ }
}

const _statCache = {};
function setStatValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;      // the v0.7 main screen removed the stat tiles
  if (_statCache[id] !== value) {
    el.textContent = value;
    bump(el);
    _statCache[id] = value;
  }
}

async function refreshRecentSites() {
  try {
    const sites = await API.get("/api/sites?sort=newest&limit=8");
    const container = document.getElementById("recent-sites-list");
    if (!sites.length) {
      container.innerHTML = '<div class="empty-state">No sites yet — click Start Scan or add a URL.</div>';
      return;
    }
    container.innerHTML = sites.map((s) => `
      <div class="recent-site-row" onclick="openSiteDetail(${s.id})">
        <span class="risk-pill ${riskClass(s.score)}">${s.score.toFixed(1)}</span>
        <span class="recent-site-url">${escapeHtml(s.url)}</span>
        <span class="status-badge status-${s.status}">${s.status}</span>
      </div>
    `).join("");
  } catch (e) { /* non-fatal */ }
}

function openSiteDetail(siteId) {
  switchView("sites");
  document.getElementById("sites-search").value = "";
  loadSites().then(() => {
    const row = document.querySelector(`tr[data-site-id="${siteId}"]`);
    if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("active"); }
  });
}

/* ==================== SITES VIEW ==================== */

let sitesDebounce = null;
function debounceLoadSites() {
  clearTimeout(sitesDebounce);
  sitesDebounce = setTimeout(loadSites, 250);
}

document.getElementById("sites-search").addEventListener("input", debounceLoadSites);
document.getElementById("sites-status-filter").addEventListener("change", loadSites);
document.getElementById("sites-sort").addEventListener("change", loadSites);
document.getElementById("sites-min-score").addEventListener("input", debounceLoadSites);

async function loadSites() {
  const q = document.getElementById("sites-search").value;
  const status = document.getElementById("sites-status-filter").value;
  const sort = document.getElementById("sites-sort").value;
  const minScore = document.getElementById("sites-min-score").value;

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (sort) params.set("sort", sort);
  if (minScore) params.set("min_score", minScore);

  try {
    const sites = await API.get("/api/sites?" + params.toString());
    const tbody = document.getElementById("sites-tbody");
    if (!sites.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No sites match these filters.</div></td></tr>';
      return;
    }
    tbody.innerHTML = sites.map((s) => `
      <tr data-site-id="${s.id}" onclick="showSiteModal(${s.id})">
        <td class="url-cell" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</td>
        <td><span class="status-badge status-${s.status}">${s.status}</span></td>
        <td><span class="risk-pill ${riskClass(s.score)}">${s.score.toFixed(1)}</span></td>
        <td>${escapeHtml(s.source || "")}</td>
        <td>${s.page_count !== undefined ? s.page_count : "—"}</td>
      </tr>
    `).join("");
  } catch (e) { showError("Failed to load sites: " + e.message); }
}

document.getElementById("add-url-btn").addEventListener("click", addUrl);
document.getElementById("add-url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addUrl();
});

async function addUrl() {
  const input = document.getElementById("add-url-input");
  const url = input.value.trim();
  if (!url) return;
  try {
    await API.post("/api/add_url", { url });
    input.value = "";
    loadSites();
    refreshStats();
  } catch (e) {
    showError(e.message);
  }
}

async function showSiteModal(siteId) {
  try {
    const data = await API.get(`/api/site/${siteId}`);
    const { site, pages, wallets, investigation, decisions, wallet_evidence, discovery_events } = data;
    const reasons = (site.score_reasons || "").split(";").filter(Boolean);
    const pagesHtml = pages.length
      ? pages.map((p) => `
          <div class="evidence-thumb" onclick="event.stopPropagation(); openLightbox('/evidence/${encodeURIComponent(p.screenshot_path.split('/').pop())}')">
            ${p.screenshot_path ? `<img src="/evidence/${encodeURIComponent(p.screenshot_path.split('/').pop())}" loading="lazy">` : ""}
            <div class="evidence-thumb-label">${escapeHtml(p.page_type.toUpperCase())} — ${escapeHtml(p.url)}</div>
          </div>
        `).join("")
      : '<div class="empty-state">No pages visited yet.</div>';
    const walletsHtml = wallets.length
      ? wallets.map((w) => `<span class="wallet-chip"><span class="wallet-network-tag">${escapeHtml(w.network)}</span> <span class="mono">${escapeHtml(w.address)}</span></span>`).join("")
      : '<span style="color:var(--text-faint); font-size:13px;">No wallets found on this site.</span>';

    const walletEvidenceHtml = (wallet_evidence && wallet_evidence.length)
      ? wallet_evidence.map((e) => `
          <div class="evidence-thumb" onclick="event.stopPropagation(); openLightbox('/evidence/${encodeURIComponent((e.screenshot_path || '').split('/').pop())}')">
            ${e.screenshot_path ? `<img src="/evidence/${encodeURIComponent(e.screenshot_path.split('/').pop())}" loading="lazy">` : ""}
            <div class="evidence-thumb-label"><span class="wallet-network-tag">${escapeHtml(e.network)}</span> ${escapeHtml((e.address || '').slice(0, 16))}…</div>
          </div>
        `).join("")
      : "";

    let investigationHtml = "";
    if (investigation) {
      const cls = INVESTIGATION_STATUS_CLASS[investigation.status] || "status-new";
      investigationHtml = `
        <h3 style="font-size:13px;color:var(--text-dim);margin-top:20px;">Investigation</h3>
        <p><span class="status-badge ${cls}">${escapeHtml(investigation.status)}</span>
        ${investigation.stop_reason ? `<span style="color:var(--text-dim);font-size:12px;margin-left:8px;">${escapeHtml(investigation.stop_reason)}</span>` : ""}</p>
        <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); document.getElementById('site-modal').remove(); switchView('investigations'); showInvestigationDecisions(${investigation.id});">View full decision log (${decisions ? decisions.length : 0})</button>
      `;
    }

    let discoveryHtml = "";
    if (site.source && site.source !== "manual_ui" && site.source !== "manual_import") {
      const confidencePct = site.discovery_confidence != null ? Math.round(site.discovery_confidence * 100) : null;
      const eventsHtml = (discovery_events && discovery_events.length)
        ? discovery_events.map((ev) => `
            <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
              <span class="wallet-network-tag">${escapeHtml(ev.source)}</span>
              ${ev.category ? `<span style="color:var(--text-faint);"> · ${escapeHtml(ev.category)}</span>` : ""}
              <span style="color:var(--text-faint);"> · confidence ${Math.round(ev.confidence * 100)}%</span>
              <div style="color:var(--text-dim); margin-top:2px;">${escapeHtml(ev.reason)}</div>
            </div>
          `).join("")
        : "";
      discoveryHtml = `
        <h3 style="font-size:13px;color:var(--text-dim);margin-top:20px;">Discovery</h3>
        <p style="font-size:13px;">
          <span class="wallet-network-tag">${escapeHtml(site.source)}</span>
          ${confidencePct !== null ? `<span style="color:var(--text-dim);"> · ${confidencePct}% confidence</span>` : ""}
          ${site.discovery_category ? `<span style="color:var(--text-dim);"> · ${escapeHtml(site.discovery_category)}</span>` : ""}
        </p>
        ${site.discovery_reason ? `<p style="font-size:12.5px; color:var(--text-dim);">${escapeHtml(site.discovery_reason)}</p>` : ""}
        ${eventsHtml ? `<div style="margin-top:8px;">${eventsHtml}</div>` : ""}
      `;
    }

    const modalHtml = `
      <div style="position:fixed;inset:0;z-index:900;" id="site-modal">
        <div class="lightbox-backdrop" onclick="document.getElementById('site-modal').remove()"></div>
        <div style="position:relative;max-width:800px;margin:5vh auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-height:88vh;overflow-y:auto;">
          <button class="lightbox-close" style="top:16px;right:16px;position:absolute;" onclick="document.getElementById('site-modal').remove()">✕</button>
          <h2 style="margin-top:0;">${escapeHtml(site.url)}</h2>
          <p><span class="status-badge status-${site.status}">${site.status}</span>
             <span class="risk-pill ${riskClass(site.score)}" style="margin-left:8px;">Score: ${site.score.toFixed(1)}</span></p>
          <h3 style="font-size:13px;color:var(--text-dim);">Risk Reasons</h3>
          <div>${reasons.length ? reasons.map(r => `<span class="wallet-chip">${escapeHtml(r.trim())}</span>`).join("") : '<span style="color:var(--text-faint);font-size:13px;">No specific signals recorded.</span>'}</div>
          <h3 style="font-size:13px;color:var(--text-dim);margin-top:20px;">Wallets</h3>
          <div>${walletsHtml}</div>
          ${walletEvidenceHtml ? `<h3 style="font-size:13px;color:var(--text-dim);margin-top:20px;">Wallet Evidence</h3><div class="evidence-grid">${walletEvidenceHtml}</div>` : ""}
          ${discoveryHtml}
          ${investigationHtml}
          <h3 style="font-size:13px;color:var(--text-dim);margin-top:20px;">Pages &amp; Evidence (${pages.length})</h3>
          <div class="evidence-grid">${pagesHtml}</div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", modalHtml);
  } catch (e) {
    showError("Failed to load site details: " + e.message);
  }
}

/* ==================== HIGH RISK VIEW ==================== */

document.getElementById("highrisk-threshold").addEventListener("input", () => {
  clearTimeout(sitesDebounce);
  sitesDebounce = setTimeout(loadHighRisk, 250);
});

async function loadHighRisk() {
  const threshold = document.getElementById("highrisk-threshold").value || 5;
  try {
    const sites = await API.get(`/api/sites/high_risk?threshold=${threshold}`);
    const tbody = document.getElementById("highrisk-tbody");
    if (!sites.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">No sites above this threshold yet.</div></td></tr>';
      return;
    }
    tbody.innerHTML = sites.map((s) => `
      <tr onclick="showSiteModal(${s.id})">
        <td class="url-cell" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</td>
        <td><span class="risk-pill ${riskClass(s.score)}">${s.score.toFixed(1)}</span></td>
        <td style="font-size:12px;color:var(--text-dim);">${escapeHtml((s.score_reasons || "").slice(0, 100))}</td>
        <td><span class="status-badge status-${s.status}">${s.status}</span></td>
      </tr>
    `).join("");
  } catch (e) { showError("Failed to load high-risk sites: " + e.message); }
}

/* ==================== DISCOVERY VIEW ==================== */

function timeAgoLabel(unixSeconds) {
  if (!unixSeconds) return "";
  const diffSec = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

async function loadDiscoveryView() {
  await Promise.all([loadDiscoveryStats(), loadDiscoveryEvents(), loadDiscoveryRuns()]);
}

async function loadDiscoveryStats() {
  try {
    const stats = await API.get("/api/discovery/stats");

    setStatValue("stat-discovery-total", stats.total_discovery_events);
    setStatValue("stat-discovery-new-sites", stats.sites_from_discovery);
    setStatValue("stat-discovery-pivoted", stats.pivoted_sites);
    const lastRun = stats.last_run;
    setStatValue("stat-discovery-duplicates", lastRun ? lastRun.total_duplicates : 0);

    const sourceContainer = document.getElementById("discovery-by-source-list");
    const sourceEntries = Object.entries(stats.by_source || {});
    sourceContainer.innerHTML = sourceEntries.length
      ? sourceEntries.sort((a, b) => b[1] - a[1]).map(([source, count]) => `
          <div class="recent-site-row" style="cursor:default;">
            <span class="wallet-network-tag" style="min-width:170px;">${escapeHtml(source)}</span>
            <span style="flex:1; color:var(--text-dim); font-size:13px;">${count} candidate${count === 1 ? "" : "s"} surfaced</span>
          </div>
        `).join("")
      : '<div class="empty-state">No discovery runs yet.</div>';

    const categoryContainer = document.getElementById("discovery-by-category-list");
    const categoryEntries = Object.entries(stats.by_category || {});
    categoryContainer.innerHTML = categoryEntries.length
      ? categoryEntries.sort((a, b) => b[1] - a[1]).map(([category, count]) => `
          <div class="recent-site-row" style="cursor:default;">
            <span class="status-badge status-queued" style="min-width:170px; text-align:center;">${escapeHtml(category)}</span>
            <span style="flex:1; color:var(--text-dim); font-size:13px;">${count} site${count === 1 ? "" : "s"}</span>
          </div>
        `).join("")
      : '<div class="empty-state">No categorized discoveries yet.</div>';
  } catch (e) { showError("Failed to load discovery stats: " + e.message); }
}

async function loadDiscoveryEvents() {
  try {
    const events = await API.get("/api/discovery/events?limit=100");
    const container = document.getElementById("discovery-events-list");
    if (!events.length) {
      container.innerHTML = '<div class="empty-state">No discovery activity recorded yet.</div>';
      return;
    }
    container.innerHTML = events.map((ev) => `
      <div class="log-line ${ev.was_duplicate ? "log-debug" : "log-info"}">
        <span class="wallet-network-tag">${escapeHtml(ev.source)}</span>
        ${ev.category ? ` <span style="color:var(--text-faint);">· ${escapeHtml(ev.category)}</span>` : ""}
        <span style="color:var(--text-faint);"> · ${Math.round(ev.confidence * 100)}% confidence</span>
        ${ev.was_duplicate ? ' <span style="color:var(--text-faint);">· duplicate, already known</span>' : ' <span style="color:var(--success);">· new site</span>'}
        <div style="margin-top:2px;">${escapeHtml(ev.url)}</div>
        <div style="color:var(--text-dim); font-size:11.5px; margin-top:2px;">${escapeHtml(ev.reason || "")}</div>
        <div style="color:var(--text-faint); font-size:11px; margin-top:2px;">${timeAgoLabel(ev.found_at)}</div>
      </div>
    `).join("");
  } catch (e) { showError("Failed to load discovery events: " + e.message); }
}

async function loadDiscoveryRuns() {
  try {
    const runs = await API.get("/api/discovery/runs?limit=15");
    const container = document.getElementById("discovery-runs-list");
    if (!runs.length) {
      container.innerHTML = '<div class="empty-state">No discovery runs yet.</div>';
      return;
    }
    container.innerHTML = runs.map((run) => `
      <div class="recent-site-row" style="cursor:default;">
        <span style="min-width:90px; font-size:12px; color:var(--text-faint);">${timeAgoLabel(run.started_at)}</span>
        <span style="flex:1; font-size:13px;">${escapeHtml(run.sources_run || "")}</span>
        <span class="risk-pill risk-low">${run.total_candidates} found</span>
        <span class="status-badge status-scanned">${run.total_new_sites} new</span>
        ${run.errors ? `<span class="status-badge status-error" title="${escapeHtml(run.errors)}">error</span>` : ""}
      </div>
    `).join("");
  } catch (e) { showError("Failed to load discovery runs: " + e.message); }
}

document.getElementById("run-discovery-btn").addEventListener("click", async () => {
  const btn = document.getElementById("run-discovery-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    await API.post("/api/discovery/run", {});
    appendLog("info", "Discovery run started.");
  } catch (e) {
    showError(e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "🧭 Run Discovery Now"; }, 1500);
  }
});

/* ==================== INVESTIGATIONS VIEW ==================== */

let currentInvestigationId = null;

async function loadInvestigations() {
  await Promise.all([loadActiveInvestigations(), loadRecentInvestigations()]);
}

async function loadActiveInvestigations() {
  try {
    const active = await API.get("/api/investigations/active");
    const container = document.getElementById("active-investigations-list");
    document.getElementById("nav-count-active-investigations").textContent = active.length || "";

    if (!active.length) {
      container.innerHTML = '<div class="empty-state">No investigations currently running.</div>';
      return;
    }
    container.innerHTML = active.map((inv) => `
      <div class="recent-site-row" onclick="showInvestigationDecisions(${inv.id})">
        ${investigationStatusBadge(inv.status)}
        <span class="recent-site-url">${escapeHtml(inv.site_url)}</span>
        <span style="font-size:12px;color:var(--text-faint);">${inv.pages_visited || 0} page(s)</span>
        <span class="risk-pill ${riskClass(inv.score)}">${Number(inv.score).toFixed(1)}</span>
      </div>
    `).join("");
  } catch (e) { showError("Failed to load active investigations: " + e.message); }
}

async function loadRecentInvestigations() {
  try {
    const recent = await API.get("/api/investigations/recent?limit=25");
    const container = document.getElementById("recent-investigations-list");
    if (!recent.length) {
      container.innerHTML = '<div class="empty-state">No investigations have run yet.</div>';
      return;
    }
    container.innerHTML = recent.map((inv) => `
      <div class="recent-site-row ${inv.id === currentInvestigationId ? 'active' : ''}"
           onclick="showInvestigationDecisions(${inv.id})">
        ${investigationStatusBadge(inv.status)}
        <span class="recent-site-url">${escapeHtml(inv.site_url)}</span>
        ${inv.stop_reason ? `<span style="font-size:11px;color:var(--text-faint);">${escapeHtml(inv.stop_reason.slice(0, 40))}</span>` : ""}
      </div>
    `).join("");
  } catch (e) { showError("Failed to load recent investigations: " + e.message); }
}

async function showInvestigationDecisions(investigationId) {
  currentInvestigationId = investigationId;
  const panel = document.getElementById("investigation-decisions-panel");
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const data = await API.get(`/api/investigation/${investigationId}`);
    const { investigation, decisions } = data;

    const header = `
      <div style="padding:8px 10px; border-bottom:1px solid var(--border); margin-bottom:6px;">
        <div>${investigationStatusBadge(investigation.status)}
          ${investigation.stop_reason ? `<span style="color:var(--text-dim); font-size:12px; margin-left:8px;">${escapeHtml(investigation.stop_reason)}</span>` : ""}
        </div>
      </div>`;

    if (!decisions.length) {
      panel.innerHTML = header + '<div class="empty-state">No decisions recorded for this investigation.</div>';
      return;
    }

    const decisionIcons = {
      navigate: "→", skip: "⤫", stop: "■", error: "⚠",
      login_detected: "🔒", signup_detected: "✎", signup_attempted: "✎",
    };

    const rows = decisions.map((d) => {
      const icon = decisionIcons[d.decision_type] || "•";
      const levelClass = d.decision_type === "stop" || d.decision_type === "error" ? "log-error"
        : d.decision_type === "skip" ? "log-debug" : "log-info";
      return `<div class="log-line ${levelClass}">${icon} <strong>${escapeHtml(d.decision_type)}</strong> — ${escapeHtml(d.detail)}
        ${d.url ? `<div style="color:var(--text-faint); font-size:11px; margin-top:2px;">${escapeHtml(d.url)}</div>` : ""}</div>`;
    }).join("");

    panel.innerHTML = header + rows;
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">Failed to load decisions: ${escapeHtml(e.message)}</div>`;
  }
}

/* ==================== WALLETS VIEW ==================== */

document.getElementById("wallets-search").addEventListener("input", () => {
  clearTimeout(sitesDebounce);
  sitesDebounce = setTimeout(loadWallets, 250);
});

async function loadWallets() {
  try {
    const wallets = await API.get("/api/wallets");
    const q = document.getElementById("wallets-search").value.toLowerCase();
    const filtered = q
      ? wallets.filter((w) => w.address.toLowerCase().includes(q) || w.network.toLowerCase().includes(q))
      : wallets;
    const tbody = document.getElementById("wallets-tbody");
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">No wallets found yet.</div></td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map((w) => `
      <tr>
        <td><span class="wallet-network-tag">${escapeHtml(w.network)}</span></td>
        <td class="mono">${escapeHtml(w.address)}</td>
        <td>${(w.confidence * 100).toFixed(0)}%</td>
        <td>${w.site_count} site${w.site_count === 1 ? "" : "s"}</td>
      </tr>
    `).join("");
  } catch (e) { showError("Failed to load wallets: " + e.message); }
}

/* ==================== REVIEW QUEUE VIEW ==================== */

let currentReviewStatus = "pending";
let currentFindingId = null;

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentReviewStatus = btn.dataset.status;
    loadReviewQueue();
  });
});

async function loadReviewQueue() {
  try {
    const findings = await API.get(`/api/findings?status=${currentReviewStatus}`);
    const list = document.getElementById("review-list");
    if (!findings.length) {
      list.innerHTML = '<div class="empty-state">No findings here.</div>';
      return;
    }
    list.innerHTML = findings.map((f) => `
      <div class="review-item ${f.id === currentFindingId ? "active" : ""}" onclick="loadFindingDetail(${f.id})">
        <div class="review-item-domain">${escapeHtml(f.domain)}</div>
        <div class="review-item-url">${escapeHtml(f.site_url)}</div>
        <div class="review-item-meta">
          <span class="risk-pill ${riskClass(f.score)}">${f.score.toFixed(1)}</span>
          <span class="status-badge status-${f.review_status === 'approved' ? 'scanned' : f.review_status === 'rejected' ? 'error' : 'queued'}">${f.review_status}</span>
          ${f.submitted_to_form ? '<span class="submitted-badge">Submitted</span>' : ""}
        </div>
      </div>
    `).join("");
  } catch (e) { showError("Failed to load review queue: " + e.message); }
}

async function loadFindingDetail(findingId) {
  currentFindingId = findingId;
  document.querySelectorAll(".review-item").forEach((el) => el.classList.remove("active"));
  loadReviewQueue(); // re-render list to highlight selection (cheap; list is small)

  const detail = document.getElementById("review-detail");
  detail.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const data = await API.get(`/api/finding/${findingId}`);
    const { finding, wallets, pages } = data;
    const interestingPages = pages.filter((p) => ["deposit", "wallet", "funding", "investment"].includes(p.page_type));

    const walletsHtml = wallets.length
      ? wallets.map((w) => `<span class="wallet-chip"><span class="wallet-network-tag">${escapeHtml(w.network)}</span> <span class="mono">${escapeHtml(w.address)}</span></span>`).join("")
      : '<span style="color:var(--text-faint);font-size:13px;">No wallets recorded for this site.</span>';

    const evidenceHtml = interestingPages.length
      ? interestingPages.map((p) => `
          <div class="evidence-thumb" onclick="openLightbox('/evidence/${encodeURIComponent(p.screenshot_path.split('/').pop())}')">
            ${p.screenshot_path ? `<img src="/evidence/${encodeURIComponent(p.screenshot_path.split('/').pop())}" loading="lazy">` : ""}
            <div class="evidence-thumb-label">${escapeHtml(p.page_type.toUpperCase())}</div>
          </div>
        `).join("")
      : '<div class="empty-state">No deposit/wallet/funding pages captured.</div>';

    let actionsHtml = "";
    if (finding.review_status === "pending") {
      actionsHtml = `
        <div class="review-actions-block">
          <textarea id="review-notes" placeholder="Optional notes…"></textarea>
          <div class="review-actions">
            <button class="btn btn-primary" onclick="approveFinding(${finding.id})">✓ Approve</button>
            <button class="btn btn-danger" onclick="rejectFinding(${finding.id})">✕ Reject</button>
          </div>
        </div>`;
    } else if (finding.review_status === "approved" && !finding.submitted_to_form) {
      actionsHtml = `
        <div class="review-actions-block">
          <div style="background:var(--warn-dim);color:var(--warn);padding:12px;border-radius:8px;font-size:13px;margin-bottom:12px;">
            This will open a real browser window and fill the report form. It will <strong>never</strong> click Submit — you must review and submit it yourself.
          </div>
          <button class="btn btn-primary" onclick="prepareForm(${finding.id})">Open &amp; Fill Report Form</button>
          <div id="form-status-box"></div>
          <div style="margin-top:14px;">
            <button class="btn btn-secondary" onclick="confirmManualSubmit(${finding.id})">I manually submitted this form</button>
          </div>
        </div>`;
    } else if (finding.submitted_to_form) {
      actionsHtml = `<div class="submitted-badge" style="margin-top:16px;">✓ Submitted to report form</div>`;
    } else if (finding.review_status === "rejected") {
      actionsHtml = `<div class="status-badge status-error" style="margin-top:16px;">Rejected${finding.reviewer_notes ? ": " + escapeHtml(finding.reviewer_notes) : ""}</div>`;
    }

    detail.innerHTML = `
      <h2>${escapeHtml(finding.domain)}</h2>
      <p><a href="${escapeHtml(finding.site_url)}" target="_blank" style="color:var(--accent);">${escapeHtml(finding.site_url)}</a></p>
      <div class="finding-summary">${escapeHtml(finding.summary)}</div>
      <h3 style="font-size:13px;color:var(--text-dim);">Wallets</h3>
      <div>${walletsHtml}</div>
      <h3 style="font-size:13px;color:var(--text-dim);margin-top:18px;">Evidence Pages</h3>
      <div class="evidence-grid">${evidenceHtml}</div>
      ${actionsHtml}
    `;
  } catch (e) {
    detail.innerHTML = `<div class="empty-state">Failed to load finding: ${escapeHtml(e.message)}</div>`;
  }
}

async function approveFinding(findingId) {
  const notes = document.getElementById("review-notes")?.value || "";
  try {
    await API.post(`/api/finding/${findingId}/approve`, { notes });
    loadFindingDetail(findingId);
    loadReviewQueue();
    refreshStats();
  } catch (e) { showError(e.message); }
}

async function rejectFinding(findingId) {
  const notes = document.getElementById("review-notes")?.value || "";
  try {
    await API.post(`/api/finding/${findingId}/reject`, { notes });
    loadFindingDetail(findingId);
    loadReviewQueue();
    refreshStats();
  } catch (e) { showError(e.message); }
}

async function prepareForm(findingId) {
  const box = document.getElementById("form-status-box");
  box.innerHTML = '<div class="form-status-box">Opening browser and filling form…</div>';
  try {
    const result = await API.post(`/api/finding/${findingId}/prepare_form`);
    const stepsHtml = (result.steps || []).map((s) => `
      <div class="form-step-row"><span class="${s.ok ? "step-ok" : "step-fail"}">${s.ok ? "✓" : "⚠"}</span> ${escapeHtml(s.step)}</div>
    `).join("");
    box.innerHTML = `
      <div class="form-status-box">
        <div style="margin-bottom:8px;">${escapeHtml(result.note || "")}</div>
        ${stepsHtml}
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="form-status-box" style="color:var(--danger);">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

async function confirmManualSubmit(findingId) {
  try {
    await API.post(`/api/finding/${findingId}/confirm_manual_submit`);
    loadFindingDetail(findingId);
    loadReviewQueue();
    refreshStats();
  } catch (e) { showError(e.message); }
}

/* ==================== SETTINGS VIEW ==================== */

async function loadSettingsForm() {
  try {
    const s = await API.get("/api/settings");
    document.getElementById("setting-batch-size").value = s.batch_size;
    document.getElementById("setting-headless").checked = !!s.headless;
    document.getElementById("setting-run-collection").checked = !!s.run_collection;
    document.getElementById("setting-run-discovery").checked = !!s.run_discovery;
    document.getElementById("setting-run-ranking").checked = !!s.run_ranking;
    document.getElementById("setting-rank-limit").value = s.rank_limit;
    document.getElementById("setting-risk-threshold").value = s.risk_threshold;
    document.getElementById("setting-allow-signup").checked = !!s.allow_signup;
    document.getElementById("setting-deep-wallet-hunt").checked = !!s.deep_wallet_hunt;
  } catch (e) { showError("Failed to load settings: " + e.message); }
}

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const payload = {
    batch_size: parseInt(document.getElementById("setting-batch-size").value, 10),
    headless: document.getElementById("setting-headless").checked,
    run_collection: document.getElementById("setting-run-collection").checked,
    run_discovery: document.getElementById("setting-run-discovery").checked,
    run_ranking: document.getElementById("setting-run-ranking").checked,
    rank_limit: parseInt(document.getElementById("setting-rank-limit").value, 10),
    risk_threshold: parseFloat(document.getElementById("setting-risk-threshold").value),
    allow_signup: document.getElementById("setting-allow-signup").checked,
    deep_wallet_hunt: document.getElementById("setting-deep-wallet-hunt").checked,
  };
  try {
    await API.post("/api/settings", payload);
    const msg = document.getElementById("settings-saved-msg");
    msg.textContent = "Settings saved.";
    msg.classList.add("show");
    setTimeout(() => msg.classList.remove("show"), 2000);
  } catch (e) { showError("Failed to save settings: " + e.message); }
});

/* ==================== LIGHTBOX ==================== */

function openLightbox(src) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox").style.display = "block";
}
document.getElementById("lightbox-close").addEventListener("click", () => {
  document.getElementById("lightbox").style.display = "none";
});
document.querySelector(".lightbox-backdrop")?.addEventListener("click", () => {
  document.getElementById("lightbox").style.display = "none";
});

/* ==================== GLOBAL SEARCH ==================== */

document.getElementById("global-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = e.target.value.trim();
    if (!q) return;
    switchView("sites");
    document.getElementById("sites-search").value = q;
    loadSites();
  }
});

/* ==================== SSE LIVE CONNECTION ==================== */

const connIndicator = document.getElementById("conn-indicator");
const connLabel = document.getElementById("conn-label");

function setConnState(connected) {
  connIndicator.className = "conn-indicator " + (connected ? "connected" : "disconnected");
  connLabel.textContent = connected ? "Live" : "Reconnecting…";
}

function connectEventStream() {
  const es = new EventSource("/events");

  es.onopen = () => setConnState(true);
  es.onerror = () => {
    setConnState(false);
    // EventSource auto-reconnects; nothing else to do here.
  };

  es.onmessage = (evt) => {
    let payload;
    try { payload = JSON.parse(evt.data); } catch (e) { return; }
    handleServerEvent(payload.type, payload.data);
  };

  return es;
}

function handleServerEvent(type, data) {
  switch (type) {
    case "log":
      appendLog(data.level, data.message);
      break;

    case "scan_state":
      applyScanState(data.state);
      refreshStats();
      break;

    /* ---- v0.4 campaign events: the live branch view ---- */

    case "campaign_started":
      campaignLive.activePivots = 0;
      pushCampaignFeed("stage",
        `${data.resumed ? "Resumed" : "Started"} campaign: ${data.name}`,
        data.resumed ? `Picking up from wave ${data.from_wave}.` : "");
      renderCampaignCounters();
      break;

    case "campaign_stage":
      pushCampaignFeed("stage",
        `Wave ${data.wave} — ${data.stage} (${data.count})`, data.detail || "");
      break;

    case "campaign_lead_executing":
      campaignLive.activePivots += 1;
      campaignLive.branches += 1;
      pushCampaignFeed("pivot",
        `${data.pivot_type} from ${data.origin}`, data.indicator);
      renderCampaignCounters();
      break;

    case "campaign_lead_skipped":
      campaignLive.rejected += 1;
      pushCampaignFeed("noise", `Skipped ${data.pivot_type}`, data.reason);
      renderCampaignCounters();
      break;

    case "campaign_candidate_promoted":
      campaignLive.activePivots = Math.max(0, campaignLive.activePivots - 1);
      pushCampaignFeed("promoted",
        `Promoted ${data.domain} (connection ${Number(data.connection).toFixed(2)})`,
        data.reason);
      renderCampaignCounters();
      break;

    case "campaign_candidate_rejected":
      campaignLive.rejected += 1;
      pushCampaignFeed("noise", `Set aside ${data.domain}`, data.reason);
      renderCampaignCounters();
      break;

    case "campaign_finished":
      campaignLive.activePivots = 0;
      pushCampaignFeed("stage",
        `Campaign ${data.status} (${data.stopped_reason})`,
        `${data.leads_executed ?? 0} leads, ${data.new_sites ?? 0} new sites, ` +
        `${data.validated ?? 0} validated, ${data.promoted ?? 0} promoted, ` +
        `${data.rejected_noise ?? 0} set aside.`);
      renderCampaignCounters();
      if (document.getElementById("view-campaigns").style.display !== "none") loadCampaignsView();
      break;

    /* ---- v0.5 integration events ---- */

    case "integration_state":
      appendLog(data.compatible ? "info" : "warning",
        `⇄ Main Platform: ${data.state} — ${data.detail || ""}`);
      if (document.getElementById("view-platform").style.display !== "none") loadPlatformStatus();
      break;

    case "integration_heartbeat":
      if (!data.alive) {
        appendLog("warning", `⇄ Platform heartbeat failed: ${data.detail || "no response"}. ` +
          "Discovery continues; events are queued.");
      }
      if (document.getElementById("view-platform").style.display !== "none") loadPlatformStatus();
      break;

    case "integration_sync":
      appendLog("info", `⇄ Sync: ${data.note || ""}`);
      if (document.getElementById("view-platform").style.display !== "none") loadPlatformView();
      break;

    case "integration_event_sent":
      if (data.investigator_job_id) {
        appendLog("info", `⇄ ${data.event_type} → investigation ${data.investigation_id}; ` +
          `Site Investigator job ${data.investigator_job_id} requested.`);
      }
      break;

    case "integration_event_rejected":
      appendLog("warning", `⇄ Platform rejected ${data.event_type}: ${data.detail}`);
      break;

    case "integration_resumed":
      appendLog("info", `⇄ ${data.note}`);
      break;

    case "integration_error":
      appendLog("warning", `⇄ Integration error: ${data.message}`);
      break;

    case "platform_offer":
      if (data.queued) {
        appendLog("info", `⇄ Queued for the platform: ${data.summary || ""}`);
      }
      break;

    case "indicator_retired":
      appendLog("info", `⌀ Retired ${data.indicator_type} ${data.value} from pivoting — ` +
        "it was returning volume without results.");
      break;

    case "cluster_new_domain":
      pushCampaignFeed("family",
        `${data.domain} matches family ${data.cluster_label}`, data.reason);
      if (document.getElementById("view-campaigns").style.display !== "none") loadFamilyWatch();
      break;

    case "investigation_started":
      currentSiteBox.style.display = "block";
      currentSiteUrl.textContent = data.url;
      currentSiteMeta.textContent = `Risk score: ${Number(data.score).toFixed(1)}`;
      progressFill.style.width = "5%";
      if (document.getElementById("view-investigations").style.display !== "none") loadActiveInvestigations();
      break;

    case "page_loading":
      progressFill.style.width = "30%";
      break;

    case "page_error":
      appendLog("warning", `⚠ Page error on ${data.url}: ${data.error}`);
      break;

    case "page_visited":
      currentSiteMeta.textContent = `Pages visited: ${data.pages_visited} — last: ${data.page_type}`;
      progressFill.style.width = Math.min(90, 20 + data.pages_visited * 15) + "%";
      break;

    case "decision_logged":
      // Keep the log panel light — only surface the more notable decision types there;
      // the full trail (including routine "navigate"/"skip" entries) lives in the
      // Investigations view's decision log panel, loaded on demand per investigation.
      if (["stop", "error", "login_detected", "signup_detected", "signup_attempted"].includes(data.decision_type)) {
        appendLog(data.decision_type === "error" || data.decision_type === "stop" ? "warning" : "info",
                   `${data.decision_type}: ${data.detail}`);
      }
      if (currentInvestigationId === data.investigation_id &&
          document.getElementById("view-investigations").style.display !== "none") {
        showInvestigationDecisions(data.investigation_id);
      }
      break;

    case "investigation_blocked":
      appendLog("warning", `🛑 Investigation stopped at ${data.control_type.replace("_", " ")}: ${data.url}`);
      break;

    case "signup_starting":
      appendLog("info", `Attempting research account signup on ${data.url}…`);
      break;

    case "signup_result":
      appendLog(data.result.status === "success" ? "info" : "warning",
                 `Signup result: ${data.result.status} — ${data.result.detail}`);
      break;

    case "investigation_status":
      if (document.getElementById("view-investigations").style.display !== "none") {
        loadActiveInvestigations();
        loadRecentInvestigations();
      }
      break;

    case "wallet_found":
      appendLog("info", `💰 Wallet found: [${data.network}] ${data.address}`);
      refreshStats();
      if (document.getElementById("view-wallets").style.display !== "none") loadWallets();
      break;

    case "investigation_finished":
      progressFill.style.width = "100%";
      refreshStats();
      refreshRecentSites();
      if (document.getElementById("view-sites").style.display !== "none") loadSites();
      if (document.getElementById("view-investigations").style.display !== "none") loadInvestigations();
      if (data.finding_id && document.getElementById("view-review").style.display !== "none") loadReviewQueue();
      setTimeout(() => { currentSiteBox.style.display = "none"; progressFill.style.width = "0%"; }, 800);
      break;

    case "investigation_error":
      appendLog("error", `Investigation failed for ${data.url}: ${data.error}`);
      refreshStats();
      break;

    case "site_ranked":
      if (data.progress % 10 === 0 || data.progress === data.total) {
        appendLog("info", `Ranked ${data.progress}/${data.total} sites…`);
      }
      break;

    case "collection_done":
      appendLog("info", `Collected ${data.added} new candidate site(s).`);
      refreshStats();
      break;

    case "site_added":
      refreshStats();
      break;

    case "discovery_run_started":
      appendLog("info", `🧭 Discovery run started (sources: ${(data.sources || []).join(", ")})`);
      break;

    case "site_discovered":
      appendLog("info", `🧭 Discovered [${data.source}] ${data.url} (${Math.round(data.confidence * 100)}% confidence${data.category ? ", " + data.category : ""})`);
      refreshStats();
      if (String(data.source || "").startsWith("campaign:")) {
        campaignLive.candidates += 1;
        pushCampaignFeed("candidate", `Found ${data.url}`, data.reason || "");
        renderCampaignCounters();
      }
      if (document.getElementById("view-discovery").style.display !== "none") loadDiscoveryView();
      if (document.getElementById("view-sites").style.display !== "none") loadSites();
      break;

    case "discovery_correlation":
      appendLog("info", `🧭 Template match: '${data.site_a}' and '${data.site_b}' are ${Math.round(data.score * 100)}% structurally similar (likely same scam template)`);
      break;

    case "discovery_run_finished":
      appendLog("info", `🧭 Discovery run finished: ${data.total_new_sites} new site(s), ${data.total_duplicates} duplicate(s) skipped.`);
      refreshStats();
      if (document.getElementById("view-discovery").style.display !== "none") loadDiscoveryView();
      break;

    case "finding_updated":
      refreshStats();
      if (document.getElementById("view-review").style.display !== "none") loadReviewQueue();
      break;

    case "error":
      showError(data.message);
      break;

    default:
      break;
  }
}

/* ==================== INIT ==================== */

async function init() {
  connectEventStream();
  await Promise.all([refreshStats(), loadSettingsForm(),
                      loadActiveInvestigationsCount(), loadSubmissionSettings(),
                      // Overview is the default view and is never "switched to",
                      // so the main screen has to be loaded explicitly on boot.
                      loadMainScreen()]);
  try {
    const status = await API.get("/api/scan/status");
    applyScanState(status.state);
    if (status.current_site) {
      currentSiteBox.style.display = "block";
      currentSiteUrl.textContent = status.current_site.url;
    }
  } catch (e) { /* non-fatal on load */ }

  // Periodic light refresh as a safety net in case an SSE event was missed
  // (e.g. brief disconnect) — the UI should never go stale for long.
  setInterval(refreshStats, 8000);
  // Keep the operational screen current without waiting for an event.
  setInterval(() => {
    if (document.getElementById("view-overview").style.display !== "none") {
      loadMainScreen();
    }
  }, 15000);
}

async function loadActiveInvestigationsCount() {
  try {
    const active = await API.get("/api/investigations/active");
    document.getElementById("nav-count-active-investigations").textContent = active.length || "";
  } catch (e) { /* non-fatal */ }
}

init();

/* ==================== RESULTS VIEW (primary deliverable) ==================== */

function pct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function confidenceClass(confidence) {
  if (confidence >= 0.85) return "risk-high";
  if (confidence >= 0.70) return "risk-med";
  return "risk-low";
}

async function loadResultsView() {
  await Promise.all([loadFunnel(), loadResults()]);
}

async function loadFunnel() {
  try {
    const f = await API.get("/api/pipeline/funnel");
    document.getElementById("funnel-discovered").textContent = f.discovered;
    document.getElementById("funnel-triaged").textContent = f.triaged;
    document.getElementById("funnel-passed").textContent = f.passed_triage;
    document.getElementById("funnel-deep").textContent = f.deep_analyzed;
    document.getElementById("funnel-results").textContent = f.high_confidence_results;
    document.getElementById("nav-count-results").textContent = f.high_confidence_results || "";

    const caption = document.getElementById("funnel-caption");
    if (f.triaged > 0) {
      const keptPct = f.triaged ? Math.round((f.passed_triage / f.triaged) * 100) : 0;
      caption.textContent =
        `${f.rejected_at_triage} of ${f.triaged} triaged sites were rejected as too weak ` +
        `(${keptPct}% cleared the quality gate). ${f.awaiting_triage} still awaiting triage. ` +
        `Scanning time is concentrated on the survivors.`;
    } else {
      caption.textContent = "Run discovery, then triage, to start filling the funnel.";
    }
  } catch (e) { /* non-fatal */ }
}

async function loadResults() {
  const container = document.getElementById("results-list");
  const minConf = document.getElementById("results-min-confidence").value || 0.7;
  try {
    const results = await API.get(`/api/results?min_confidence=${minConf}`);
    if (!results.length) {
      container.innerHTML =
        '<div class="empty-state">No results at or above this confidence yet. ' +
        'Lower the threshold to inspect weaker profiles, or run more deep analysis.</div>';
      return;
    }
    container.innerHTML = results.map(renderResultCard).join("");
  } catch (e) {
    showError("Failed to load results: " + e.message);
  }
}

function renderResultCard(r) {
  const wallets = (r.deposit_pages || []).length;
  const reasons = (r.flag_reasons || []).slice(0, 6);
  const cats = r.indicator_categories || [];
  return `
    <div class="result-card">
      <div class="result-head">
        <div>
          <div class="result-domain">${escapeHtml(r.domain || "")}</div>
          <a class="result-url" href="${escapeHtml(r.full_url || "")}" target="_blank"
             rel="noopener noreferrer">${escapeHtml(r.full_url || "")}</a>
        </div>
        <div class="result-scores">
          <span class="risk-pill ${confidenceClass(r.confidence_score)}">
            ${pct(r.confidence_score)} confidence</span>
          <span class="risk-pill risk-low">risk ${Number(r.risk_score || 0).toFixed(1)}</span>
        </div>
      </div>

      ${r.site_title ? `<div class="result-title">${escapeHtml(r.site_title)}</div>` : ""}
      ${r.site_description ? `<div class="result-desc">${escapeHtml(r.site_description)}</div>` : ""}

      <div class="result-meta">
        <span>${(r.deposit_pages || []).length} deposit page(s)</span>
        <span>${(r.keywords_found || []).length} keyword hit(s)</span>
        <span>${(r.related_domains || []).length} related domain(s)</span>
        <span>${(r.screenshots || []).length} screenshot(s)</span>
        ${r.domain_age_days != null ? `<span>${r.domain_age_days}d old domain</span>` : ""}
        ${r.discovery_source ? `<span>via ${escapeHtml(r.discovery_source)}</span>` : ""}
      </div>

      ${cats.length ? `<div class="result-cats">${cats.map(c =>
        `<span class="wallet-chip">${escapeHtml(c)}</span>`).join("")}</div>` : ""}

      ${reasons.length ? `<ul class="result-reasons">${reasons.map(x =>
        `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}

      ${r.evidence_summary ? `<div class="result-evidence">${escapeHtml(r.evidence_summary)}</div>` : ""}

      <div class="result-actions">
        <button class="btn btn-secondary btn-small"
                onclick="showResultDetail(${r.site_id})">Full evidence</button>
        <button class="btn btn-primary btn-small"
                onclick="startSubmission(${r.site_id})">Prepare report</button>
      </div>
    </div>`;
}

async function showResultDetail(siteId) {
  try {
    const data = await API.get(`/api/result/${siteId}`);
    const p = data.profile;
    const wallets = data.wallets || [];

    const walletRows = wallets.length ? wallets.map(w => `
      <div class="detail-wallet">
        <div><span class="wallet-network-tag">${escapeHtml(w.network || "")}</span>
             <span class="mono">${escapeHtml(w.address || "")}</span></div>
        <div class="detail-sub">
          ${w.format_valid ? "✅ checksum valid" : "❌ checksum invalid"}
          ${w.validation_detail ? " — " + escapeHtml(w.validation_detail) : ""}
        </div>
        <div class="detail-sub">
          ${w.activity_available
            ? `On-chain: ${w.tx_count ?? "?"} txs${w.balance ? ", balance " + escapeHtml(String(w.balance)) : ""}${w.total_received ? ", received " + escapeHtml(String(w.total_received)) : ""} (${escapeHtml(w.activity_source || "")})`
            : `On-chain activity unavailable${w.activity_error ? " — " + escapeHtml(w.activity_error) : ""}`}
        </div>
      </div>`).join("") : '<div class="empty-state">No wallets recorded.</div>';

    const section = (title, body) =>
      body ? `<h3 class="detail-h">${title}</h3>${body}` : "";

    const listOf = (arr, fn) =>
      (arr && arr.length) ? `<ul class="detail-list">${arr.map(fn).join("")}</ul>` : "";

    const html = `
      <div style="position:fixed;inset:0;z-index:900;" id="result-modal">
        <div class="lightbox-backdrop" onclick="document.getElementById('result-modal').remove()"></div>
        <div class="detail-panel">
          <button class="lightbox-close" style="top:16px;right:16px;position:absolute;"
                  onclick="document.getElementById('result-modal').remove()">✕</button>
          <h2 style="margin-top:0;">${escapeHtml(p.domain || "")}</h2>
          <a href="${escapeHtml(p.full_url || "")}" target="_blank" rel="noopener noreferrer"
             class="result-url">${escapeHtml(p.full_url || "")}</a>
          <div class="result-scores" style="margin:10px 0;">
            <span class="risk-pill ${confidenceClass(p.confidence_score)}">${pct(p.confidence_score)} confidence</span>
            <span class="risk-pill risk-low">risk ${Number(p.risk_score || 0).toFixed(1)}</span>
          </div>

          ${section("Evidence summary", p.evidence_summary
            ? `<div class="result-evidence">${escapeHtml(p.evidence_summary)}</div>` : "")}

          ${section("Why it was flagged", listOf(p.flag_reasons, x => `<li>${escapeHtml(x)}</li>`))}

          ${section("Wallets & validation", walletRows)}

          ${section("Deposit / withdrawal pages", listOf(p.deposit_pages,
            d => `<li><span class="wallet-chip">${escapeHtml(d.page_type || "")}</span>
                  <span class="mono">${escapeHtml(d.url || "")}</span></li>`))}

          ${section("Keywords found", listOf((p.keywords_found || []).slice(0, 40),
            k => `<li><strong>${escapeHtml(k.keyword)}</strong>
                  <span class="detail-sub">(${escapeHtml(k.category || "")})</span></li>`))}

          ${section("Important page text", p.important_text
            ? `<pre class="detail-pre">${escapeHtml(p.important_text)}</pre>` : "")}

          ${section("Related domains", listOf(p.related_domains,
            d => `<li><span class="mono">${escapeHtml(d.domain)}</span>
                  <span class="detail-sub">${escapeHtml(d.relation)} — ${escapeHtml(d.detail || "")}</span></li>`))}

          ${section("Shared infrastructure", p.shared_infrastructure
            ? `<div class="detail-sub">IP: ${escapeHtml(String(p.shared_infrastructure.ip || "unknown"))}
               ${(p.shared_infrastructure.nameservers || []).length
                 ? " | NS: " + escapeHtml((p.shared_infrastructure.nameservers || []).join(", ")) : ""}</div>` : "")}

          ${section("Template matches", listOf(p.template_matches,
            t => `<li><span class="mono">${escapeHtml(t.domain)}</span>
                  <span class="detail-sub">${pct(t.similarity)} similar</span></li>`))}

          ${section("Registration", p.domain_age_days != null
            ? `<div class="detail-sub">Domain age: ${p.domain_age_days} days</div>` : "")}

          ${section("Contact information", p.contact_info
            ? `<div class="detail-sub">${escapeHtml(JSON.stringify(p.contact_info))}</div>` : "")}

          ${section("Social links", listOf(p.social_links,
            s => `<li><span class="wallet-chip">${escapeHtml(s.platform)}</span>
                  <span class="mono">${escapeHtml(s.url)}</span></li>`))}

          ${section("Threat intelligence", listOf(p.threat_intel,
            t => `<li><span class="wallet-chip">${escapeHtml(t.verdict || "")}</span>
                  ${escapeHtml(t.source || "")} — ${escapeHtml(t.detail || "")}</li>`))}

          ${section("Screenshots", (p.screenshots || []).length
            ? `<div class="evidence-grid">${(p.screenshots || []).map(s => {
                 const f = (s.path || "").split("/").pop();
                 return `<div class="evidence-thumb" onclick="openLightbox('/evidence/${encodeURIComponent(f)}')">
                           <img src="/evidence/${encodeURIComponent(f)}" loading="lazy">
                           <div class="evidence-thumb-label">${escapeHtml(s.label || "")}</div>
                         </div>`; }).join("")}</div>` : "")}

          <div class="result-actions" style="margin-top:18px;">
            <button class="btn btn-primary" onclick="startSubmission(${siteId})">Prepare report</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
  } catch (e) {
    showError("Failed to load result detail: " + e.message);
  }
}

document.getElementById("refresh-results-btn")?.addEventListener("click", loadResultsView);
document.getElementById("results-min-confidence")?.addEventListener("change", loadResults);

document.getElementById("run-triage-btn")?.addEventListener("click", async () => {
  try {
    const r = await API.post("/api/pipeline/triage", { limit: 200 });
    appendLog("info", r.message || "Triage started.");
  } catch (e) { showError(e.message); }
});

document.getElementById("run-deep-btn")?.addEventListener("click", async () => {
  try {
    const r = await API.post("/api/pipeline/deep", { limit: 10 });
    appendLog("info", r.message || "Deep analysis started.");
  } catch (e) { showError(e.message); }
});

/* ==================== SUBMISSION ==================== */

async function startSubmission(siteId) {
  try {
    const validation = await API.get(`/api/submission/validate/${siteId}`);
    showSubmissionModal(siteId, validation);
  } catch (e) {
    showError("Validation failed: " + e.message);
  }
}

function showSubmissionModal(siteId, validation) {
  const checks = (validation.checks || []).map(c => `
    <div class="check-row ${c.passed ? "check-ok" : "check-bad"}">
      <span>${c.passed ? "✅" : "⛔"}</span>
      <span class="check-name">${escapeHtml(c.check)}</span>
      <span class="check-detail">${escapeHtml(c.detail)}</span>
    </div>`).join("");

  const canProceed = validation.passed;
  const wallet = validation.wallet;

  const html = `
    <div style="position:fixed;inset:0;z-index:950;" id="submission-modal">
      <div class="lightbox-backdrop" onclick="document.getElementById('submission-modal').remove()"></div>
      <div class="detail-panel" style="max-width:720px;">
        <button class="lightbox-close" style="top:16px;right:16px;position:absolute;"
                onclick="document.getElementById('submission-modal').remove()">✕</button>
        <h2 style="margin-top:0;">Prepare report</h2>

        <h3 class="detail-h">Pre-submission validation</h3>
        <div class="check-list">${checks}</div>

        ${wallet ? `<h3 class="detail-h">Wallet to report</h3>
          <div class="detail-wallet">
            <div><span class="wallet-network-tag">${escapeHtml(wallet.network || "")}</span>
                 <span class="mono">${escapeHtml(wallet.address || "")}</span></div>
          </div>` : ""}

        ${canProceed ? `
          <div class="notice-box">
            The tool will open the form and fill in everything it can, then stop.
            <strong>You review the filled form and click Submit yourself.</strong>
          </div>
          <div class="result-actions">
            <button class="btn btn-primary" onclick="prepareSubmission(${siteId}, 'review_before_submit')">
              Open &amp; prefill form</button>
            <button class="btn btn-secondary" onclick="prepareSubmission(${siteId}, 'manual')">
              Manual (just show me the values)</button>
          </div>` : `
          <div class="notice-box notice-bad">
            Submission is blocked until every check above passes. This guard exists so a
            bogus or duplicate report never reaches the reporting project.
          </div>`}

        <div id="submission-result"></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
}

async function prepareSubmission(siteId, mode) {
  const box = document.getElementById("submission-result");
  box.innerHTML = '<div class="notice-box">Validating and preparing…</div>';
  try {
    const result = await API.post(`/api/submission/prepare/${siteId}`, { mode });
    if (result.status === "rejected") {
      box.innerHTML = `<div class="notice-box notice-bad">${escapeHtml(result.message)}</div>`;
      return;
    }
    const steps = (result.form_result?.steps || []).map(s =>
      `<div class="check-row ${s.ok ? "check-ok" : "check-bad"}">
         <span>${s.ok ? "✅" : "⚠️"}</span><span class="check-name">${escapeHtml(s.step)}</span></div>`).join("");

    box.innerHTML = `
      <div class="notice-box">${escapeHtml(result.message)}</div>
      ${steps ? `<h3 class="detail-h">Fill steps</h3><div class="check-list">${steps}</div>` : ""}
      ${mode !== "manual" ? `
        <div class="result-actions">
          <button class="btn btn-secondary"
                  onclick="confirmSubmitted(${result.submission_id})">
            I submitted it — record that</button>
        </div>` : ""}`;
  } catch (e) {
    box.innerHTML = `<div class="notice-box notice-bad">${escapeHtml(e.message)}</div>`;
  }
}

async function confirmSubmitted(submissionId) {
  try {
    const r = await API.post(`/api/submission/confirm/${submissionId}`, {});
    document.getElementById("submission-result").innerHTML =
      `<div class="notice-box">${escapeHtml(r.message)}</div>`;
    appendLog("info", "Submission recorded.");
    loadResultsView();
  } catch (e) { showError(e.message); }
}

/* ==================== SUBMISSION SETTINGS ==================== */

const SUB_MODE_HINTS = {
  manual: "The tool validates and shows you the values. You open and fill the form yourself.",
  review_before_submit: "The tool validates, opens the form and prefills it, then hands it to you to check and submit.",
  automatic: "The tool validates and prefills everything so confirming takes one click. You still click Submit — filing a report is a real action against a real project.",
};

async function loadSubmissionSettings() {
  try {
    const s = await API.get("/api/submission/settings");
    document.getElementById("setting-sub-username").value = s.username || "";
    document.getElementById("setting-sub-teamcode").placeholder =
      s.team_code_set ? s.team_code_masked : "TEAM-XXXX";
    document.getElementById("setting-sub-mode").value = s.mode || "review_before_submit";
    updateSubModeHint();
  } catch (e) { /* non-fatal */ }
}

function updateSubModeHint() {
  const mode = document.getElementById("setting-sub-mode")?.value;
  const hint = document.getElementById("sub-mode-hint");
  if (hint && mode) hint.textContent = SUB_MODE_HINTS[mode] || "";
}

document.getElementById("setting-sub-mode")?.addEventListener("change", updateSubModeHint);

document.getElementById("save-submission-settings-btn")?.addEventListener("click", async () => {
  const payload = {
    username: document.getElementById("setting-sub-username").value,
    mode: document.getElementById("setting-sub-mode").value,
  };
  const code = document.getElementById("setting-sub-teamcode").value;
  if (code) payload.team_code = code;

  try {
    const r = await API.post("/api/submission/settings", payload);
    const msg = document.getElementById("submission-settings-msg");
    msg.textContent = r.configured
      ? "Saved — these will be reused automatically."
      : "Saved (still missing username or team code).";
    msg.classList.add("show");
    setTimeout(() => msg.classList.remove("show"), 2500);
    document.getElementById("setting-sub-teamcode").value = "";
    loadSubmissionSettings();
  } catch (e) { showError("Failed to save: " + e.message); }
});

/* ==================== v2: FAMILIES (CLUSTERS) ==================== */

function evidenceBadge(cls) {
  const observed = cls === "observed";
  return `<span class="ev-badge ${observed ? "ev-observed" : "ev-derived"}">${
    observed ? "observed" : "derived"}</span>`;
}

async function loadClustersView() {
  await Promise.all([loadIntelStats(), loadClusters(), loadWalletReuse()]);
}

async function loadIntelStats() {
  try {
    const s = await API.get("/api/intel/stats");
    document.getElementById("intel-clusters").textContent = s.clusters;
    document.getElementById("intel-shared").textContent = s.shared_indicators;
    document.getElementById("intel-rels").textContent = s.relationships;
    document.getElementById("intel-indicators").textContent = s.indicators;
    const badge = document.getElementById("nav-count-clusters");
    if (badge) badge.textContent = s.clusters || "";
  } catch (e) { /* non-fatal */ }
}

async function loadClusters() {
  const box = document.getElementById("clusters-list");
  try {
    const clusters = await API.get("/api/clusters");
    if (!clusters.length) {
      box.innerHTML = '<div class="empty-state">No families yet. Run deep analysis on some ' +
        'sites, then click "Re-run Correlation".</div>';
      return;
    }
    box.innerHTML = clusters.map(renderClusterCard).join("");
  } catch (e) { showError("Failed to load families: " + e.message); }
}

function renderClusterCard(c) {
  const strong = c.strong_indicator_types;
  const tier = strong >= 3 ? "risk-high" : strong >= 1 ? "risk-med" : "risk-low";
  return `
    <div class="result-card">
      <div class="result-head">
        <div>
          <div class="result-domain">${escapeHtml(c.label || "Unnamed family")}</div>
          <div class="result-meta" style="margin-top:4px;">
            <span>${c.site_count} sites</span>
            <span>${c.distinct_indicator_types} indicator type(s)</span>
            <span><strong>${strong}</strong> strong</span>
            ${c.total_validated_wallets ? `<span>${c.total_validated_wallets} validated wallet(s)</span>` : ""}
          </div>
        </div>
        <div class="result-scores">
          <span class="risk-pill ${tier}">priority ${Number(c.priority_score).toFixed(1)}</span>
          ${evidenceBadge("derived")}
        </div>
      </div>
      <div class="result-evidence">${escapeHtml(c.summary || "")}</div>
      <div class="result-actions">
        <button class="btn btn-secondary btn-small" onclick="showClusterDetail(${c.id})">
          View family evidence</button>
        <a class="btn btn-secondary btn-small" href="/api/export/cluster/${c.id}">Export family</a>
      </div>
    </div>`;
}

async function showClusterDetail(clusterId) {
  try {
    const c = await API.get(`/api/cluster/${clusterId}`);
    const members = (c.members || []).map(m => `
      <div class="detail-wallet">
        <div>
          <strong>${escapeHtml(m.domain || "")}</strong>
          ${m.confidence_score != null
            ? `<span class="risk-pill ${confidenceClass(m.confidence_score)}" style="margin-left:6px;">
                 ${pct(m.confidence_score)}</span>` : ""}
        </div>
        <div class="detail-sub">${escapeHtml(m.join_reason || "")}</div>
        <div style="margin-top:6px;">
          <button class="btn btn-secondary btn-small"
                  onclick="document.getElementById('cluster-modal').remove(); openWorkspace(${m.site_id})">
            Open in workspace</button>
        </div>
      </div>`).join("");

    document.body.insertAdjacentHTML("beforeend", `
      <div style="position:fixed;inset:0;z-index:900;" id="cluster-modal">
        <div class="lightbox-backdrop" onclick="document.getElementById('cluster-modal').remove()"></div>
        <div class="detail-panel">
          <button class="lightbox-close" style="top:16px;right:16px;position:absolute;"
                  onclick="document.getElementById('cluster-modal').remove()">✕</button>
          <h2 style="margin-top:0;">${escapeHtml(c.label || "")}</h2>
          <div class="result-scores" style="margin:8px 0;">
            <span class="risk-pill risk-med">priority ${Number(c.priority_score).toFixed(1)}</span>
            <span class="risk-pill risk-low">${c.site_count} sites</span>
            ${evidenceBadge("derived")}
          </div>
          <div class="result-evidence">${escapeHtml(c.summary || "")}</div>
          <h3 class="detail-h">Members and why each joined</h3>
          ${members || '<div class="empty-state">No members.</div>'}
        </div>
      </div>`);
  } catch (e) { showError("Failed to load family: " + e.message); }
}

async function loadWalletReuse() {
  const box = document.getElementById("wallet-reuse-list");
  try {
    const items = await API.get("/api/wallet_reuse");
    if (!items.length) {
      box.innerHTML = '<div class="empty-state">No wallets seen on more than one site yet.</div>';
      return;
    }
    box.innerHTML = items.map(w => `
      <div class="detail-wallet">
        <div><span class="wallet-network-tag">${escapeHtml(w.network || "?")}</span>
             <span class="mono">${escapeHtml(w.address)}</span>
             <span class="risk-pill risk-high" style="margin-left:6px;">${w.site_count} sites</span>
             ${evidenceBadge("observed")}</div>
        <div class="detail-sub">${escapeHtml(w.explanation || "")}</div>
        <div class="detail-sub">On: ${w.sites.map(s =>
          `<a href="#" onclick="openWorkspace(${s.site_id});return false;">${escapeHtml(s.domain)}</a>`
        ).join(", ")}</div>
      </div>`).join("");
  } catch (e) { /* non-fatal */ }
}

document.getElementById("run-correlate-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("run-correlate-btn");
  btn.disabled = true; btn.textContent = "Correlating…";
  try {
    const r = await API.post("/api/correlate", {});
    appendLog("info", `Correlation complete: ${r.relationships.relationships_recorded} link(s), ` +
      `${r.clusters.clusters} family/families.`);
    loadClustersView();
  } catch (e) { showError(e.message); }
  finally { btn.disabled = false; btn.textContent = "Re-run Correlation"; }
});

document.getElementById("find-related-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("find-related-btn");
  btn.disabled = true; btn.textContent = "Pivoting…";
  try {
    const r = await API.post("/api/related/discover", {});
    appendLog("info", r.note ||
      `Pivoted from ${r.seeds} confirmed site(s): ${r.candidates} candidate(s), ${r.new_sites} new.`);
    loadClustersView();
  } catch (e) { showError(e.message); }
  finally { btn.disabled = false; btn.textContent = "Find Related Sites"; }
});

/* ==================== v2: INVESTIGATION WORKSPACE ==================== */

let currentWorkspaceSiteId = null;

async function loadWorkspaceView() {
  try {
    const sites = await API.get("/api/results?min_confidence=0");
    const picker = document.getElementById("workspace-site-picker");
    picker.innerHTML = '<option value="">— pick a site —</option>' +
      sites.map(s => `<option value="${s.site_id}">${escapeHtml(s.domain)} (${pct(s.confidence_score)})</option>`).join("");
    if (currentWorkspaceSiteId) {
      picker.value = currentWorkspaceSiteId;
      renderWorkspace(currentWorkspaceSiteId);
    }
  } catch (e) { /* non-fatal */ }
}

function openWorkspace(siteId) {
  currentWorkspaceSiteId = siteId;
  switchView("workspace");
  renderWorkspace(siteId);
}

document.getElementById("workspace-site-picker")?.addEventListener("change", (e) => {
  if (e.target.value) { currentWorkspaceSiteId = Number(e.target.value); renderWorkspace(e.target.value); }
});

document.getElementById("workspace-export-btn")?.addEventListener("click", () => {
  if (!currentWorkspaceSiteId) { showError("Pick a site first."); return; }
  window.location.href = `/api/export/evidence/${currentWorkspaceSiteId}`;
});

async function renderWorkspace(siteId) {
  const box = document.getElementById("workspace-body");
  box.innerHTML = '<div class="empty-state">Loading investigation…</div>';
  try {
    const w = await API.get(`/api/workspace/${siteId}`);
    const p = w.profile || {};

    const chain = `
      <div class="chain-bar">
        <div class="chain-step"><div class="chain-num">1</div><div>Site</div></div>
        <div class="chain-arrow">→</div>
        <div class="chain-step"><div class="chain-num">${w.pages.length}</div><div>Pages</div></div>
        <div class="chain-arrow">→</div>
        <div class="chain-step"><div class="chain-num">${w.deposit_options.length}</div><div>Deposit Options</div></div>
        <div class="chain-arrow">→</div>
        <div class="chain-step"><div class="chain-num">${w.wallets.length}</div><div>Wallets</div></div>
        <div class="chain-arrow">→</div>
        <div class="chain-step"><div class="chain-num">${w.related_sites.length}</div><div>Related Sites</div></div>
      </div>`;

    const pages = w.pages.length ? w.pages.map(pg => `
      <div class="ws-row">
        <span class="wallet-chip">${escapeHtml(pg.page_type || "page")}</span>
        <span class="mono">${escapeHtml(pg.url)}</span>
        ${pg.screenshot_path ? `<button class="btn-mini" onclick="openLightbox('/evidence/${
          encodeURIComponent(pg.screenshot_path.split('/').pop())}')">screenshot</button>` : ""}
      </div>`).join("") : '<div class="empty-state">No pages captured.</div>';

    const deposits = w.deposit_options.length ? w.deposit_options.map(d => `
      <div class="ws-row">
        <span class="wallet-chip">${escapeHtml(d.label || d.method)}</span>
        ${d.network ? `<span class="wallet-network-tag">${escapeHtml(d.network)}</span>` : ""}
        ${d.min_amount ? `<span class="detail-sub">min ${escapeHtml(d.min_amount)}</span>` : ""}
        ${evidenceBadge("observed")}
        ${!d.still_present ? '<span class="ev-badge ev-gone">no longer present</span>' : ""}
        <div class="detail-sub" style="flex-basis:100%;">${escapeHtml(d.page_url || "")}</div>
        ${d.instructions ? `<div class="detail-sub" style="flex-basis:100%;">${
          escapeHtml(d.instructions.slice(0,240))}</div>` : ""}
      </div>`).join("") : '<div class="empty-state">No deposit options found.</div>';

    const wallets = w.wallets.length ? w.wallets.map(x => `
      <div class="ws-row">
        <span class="wallet-network-tag">${escapeHtml(x.network || "?")}</span>
        <span class="mono">${escapeHtml(x.address)}</span>
        <span class="${x.format_valid ? "ok-tag" : "bad-tag"}">${
          x.format_valid ? "checksum valid" : "checksum INVALID"}</span>
        ${x.activity_available
          ? `<span class="detail-sub">${x.tx_count ?? "?"} txs${
              x.total_received ? ", received " + escapeHtml(String(x.total_received)) : ""}</span>`
          : `<span class="detail-sub">activity unavailable</span>`}
        ${evidenceBadge("observed")}
      </div>`).join("") : '<div class="empty-state">No wallets found.</div>';

    const related = w.related_sites.length ? w.related_sites.map(r => `
      <div class="ws-row ws-row-block">
        <div>
          <a href="#" onclick="openWorkspace(${r.other_site_id});return false;">
            <strong>${escapeHtml(r.other_domain || "")}</strong></a>
          <span class="wallet-chip">${escapeHtml(r.relation_type.replace("shared_",""))}</span>
          <span class="risk-pill risk-low">strength ${Number(r.strength).toFixed(2)}</span>
          ${evidenceBadge("derived")}
        </div>
        <div class="detail-sub">${escapeHtml(r.explanation || "")}</div>
      </div>`).join("") : '<div class="empty-state">No related sites derived yet. Run correlation.</div>';

    const indicators = w.indicators.length ? w.indicators.map(i => `
      <div class="ws-row">
        <span class="wallet-chip">${escapeHtml(i.indicator_type)}</span>
        <span class="mono">${escapeHtml(i.value.slice(0,54))}</span>
        ${i.site_count > 1 ? `<span class="risk-pill risk-high">on ${i.site_count} sites</span>` : ""}
        ${evidenceBadge("observed")}
        ${!i.still_present ? '<span class="ev-badge ev-gone">gone</span>' : ""}
        <div class="detail-sub" style="flex-basis:100%;">
          via ${escapeHtml(i.source_method || "scan")} at ${escapeHtml(i.source_url || "")}</div>
      </div>`).join("") : '<div class="empty-state">No indicators recorded.</div>';

    const timeline = w.timeline.length ? w.timeline.map(t => `
      <div class="tl-item ${t.evidence_class === "observed" ? "tl-observed" : "tl-derived"}">
        <div class="tl-dot"></div>
        <div class="tl-body">
          <div class="tl-title">${escapeHtml(t.title || "")} ${evidenceBadge(t.evidence_class)}</div>
          ${t.detail ? `<div class="detail-sub">${escapeHtml(t.detail.slice(0,400))}</div>` : ""}
          <div class="tl-time">${new Date((t.occurred_at || 0) * 1000).toLocaleString()}</div>
        </div>
      </div>`).join("") : '<div class="empty-state">No timeline events.</div>';

    const history = w.history.length ? w.history.map(h => `
      <div class="ws-row">
        <span class="wallet-chip">${escapeHtml(h.change_type)}</span>
        <span>${escapeHtml(h.indicator_type)}</span>
        <span class="detail-sub">${escapeHtml((h.new_value || h.old_value || "").slice(0,50))}</span>
        <span class="tl-time">${new Date((h.detected_at || 0) * 1000).toLocaleString()}</span>
      </div>`).join("") : '<div class="empty-state">No changes tracked yet.</div>';

    box.innerHTML = `
      <div class="result-card">
        <div class="result-head">
          <div>
            <div class="result-domain">${escapeHtml(w.site.domain)}</div>
            <a class="result-url" href="${escapeHtml(w.site.url)}" target="_blank"
               rel="noopener noreferrer">${escapeHtml(w.site.url)}</a>
          </div>
          <div class="result-scores">
            ${p.confidence_score != null
              ? `<span class="risk-pill ${confidenceClass(p.confidence_score)}">${
                  pct(p.confidence_score)} confidence</span>` : ""}
            ${w.cluster ? `<span class="risk-pill risk-med">${escapeHtml(w.cluster.label)}</span>` : ""}
          </div>
        </div>
        ${p.evidence_summary ? `<div class="result-evidence">${escapeHtml(p.evidence_summary)}</div>` : ""}
      </div>
      ${chain}
      <div class="ws-grid">
        <div class="panel"><div class="panel-header"><h3>Pages</h3></div>
             <div class="panel-body">${pages}</div></div>
        <div class="panel"><div class="panel-header"><h3>Deposit Options</h3></div>
             <div class="panel-body">${deposits}</div></div>
        <div class="panel"><div class="panel-header"><h3>Wallets</h3></div>
             <div class="panel-body">${wallets}</div></div>
        <div class="panel"><div class="panel-header"><h3>Related Sites</h3></div>
             <div class="panel-body">${related}</div></div>
        <div class="panel"><div class="panel-header"><h3>Indicators Observed</h3></div>
             <div class="panel-body">${indicators}</div></div>
        <div class="panel"><div class="panel-header"><h3>Change History</h3></div>
             <div class="panel-body">${history}</div></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <div class="panel-header"><h3>Evidence Timeline</h3>
          <span class="detail-sub">observed facts and derived conclusions, in order</span></div>
        <div class="panel-body">${timeline}</div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice-box notice-bad">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

/* ==================== v2: GLOBAL SEARCH ==================== */

let searchTimer = null;

document.getElementById("global-search")?.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { document.getElementById("search-overlay")?.remove(); return; }
  searchTimer = setTimeout(() => runGlobalSearch(q), 250);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("search-overlay")?.remove();
});

async function runGlobalSearch(query) {
  try {
    const r = await API.get(`/api/search?q=${encodeURIComponent(query)}`);
    document.getElementById("search-overlay")?.remove();

    const section = (title, items, render) =>
      items && items.length
        ? `<h3 class="detail-h">${title} (${items.length})</h3>
           <div>${items.slice(0, 12).map(render).join("")}</div>` : "";

    const body = `
      ${section("Sites", r.sites, s => `
        <div class="ws-row"><a href="#" onclick="document.getElementById('search-overlay').remove();
             openWorkspace(${s.id});return false;"><strong>${escapeHtml(s.domain)}</strong></a>
          ${s.confidence_score != null ? `<span class="risk-pill ${
            confidenceClass(s.confidence_score)}">${pct(s.confidence_score)}</span>` : ""}</div>`)}
      ${section("Wallets", r.wallets, w => `
        <div class="ws-row"><span class="wallet-network-tag">${escapeHtml(w.network || "?")}</span>
          <span class="mono">${escapeHtml(w.address)}</span>
          ${w.site_count > 1 ? `<span class="risk-pill risk-high">${w.site_count} sites</span>` : ""}</div>`)}
      ${section("Indicators", r.indicators, i => `
        <div class="ws-row"><span class="wallet-chip">${escapeHtml(i.indicator_type)}</span>
          <span class="mono">${escapeHtml(i.value.slice(0,60))}</span>
          ${i.site_count > 1 ? `<span class="risk-pill risk-high">${i.site_count} sites</span>` : ""}</div>`)}
      ${section("Deposit options", r.deposit_options, d => `
        <div class="ws-row"><span class="wallet-chip">${escapeHtml(d.label || d.method)}</span>
          <span class="detail-sub">${escapeHtml(d.domain || "")}</span></div>`)}
      ${section("Pages", r.pages, pg => `
        <div class="ws-row"><span class="detail-sub">${escapeHtml(pg.domain || "")}</span>
          <span class="mono">${escapeHtml((pg.title || pg.url || "").slice(0,70))}</span></div>`)}
      ${section("Families", r.clusters, c => `
        <div class="ws-row"><a href="#" onclick="document.getElementById('search-overlay').remove();
             switchView('clusters');showClusterDetail(${c.id});return false;">
             ${escapeHtml(c.label)}</a>
          <span class="detail-sub">${c.site_count} sites</span></div>`)}`;

    document.body.insertAdjacentHTML("beforeend", `
      <div id="search-overlay" style="position:fixed;inset:0;z-index:960;">
        <div class="lightbox-backdrop" onclick="document.getElementById('search-overlay').remove()"></div>
        <div class="detail-panel" style="max-width:780px;">
          <button class="lightbox-close" style="top:16px;right:16px;position:absolute;"
                  onclick="document.getElementById('search-overlay').remove()">✕</button>
          <h2 style="margin-top:0;">Search: ${escapeHtml(query)}</h2>
          <div class="detail-sub">${r.total} result(s) across all collected intelligence</div>
          ${body || '<div class="empty-state">Nothing matched.</div>'}
        </div>
      </div>`);
  } catch (e) { /* non-fatal */ }
}

/* ==================== v0.3: DISCOVERY PIVOT ENGINE ==================== */

async function loadPivotView() {
  await Promise.all([loadPivotStats(), loadPivotLeads()]);
}

async function loadPivotStats() {
  try {
    const s = await API.get("/api/pivot/stats");
    document.getElementById("pivot-runs").textContent = s.runs;
    document.getElementById("pivot-executed").textContent = s.leads_executed;
    document.getElementById("pivot-reached").textContent = s.sites_reached;
    document.getElementById("pivot-converged").textContent = s.converged_sites;
    document.getElementById("pivot-maxdepth").textContent = s.max_depth_reached;
    const badge = document.getElementById("nav-count-pivot");
    if (badge) badge.textContent = s.converged_sites || "";
  } catch (e) { /* non-fatal */ }
}

function connectionTier(score) {
  if (score >= 1.0) return "risk-high";
  if (score >= 0.6) return "risk-med";
  return "risk-low";
}

async function loadPivotLeads() {
  const box = document.getElementById("pivot-leads-list");
  try {
    const leads = await API.get("/api/pivot/leads");
    if (!leads.length) {
      box.innerHTML = '<div class="empty-state">No sites reached by pivoting yet.</div>';
      return;
    }
    box.innerHTML = leads.map(renderPivotLead).join("");
  } catch (e) { showError("Failed to load pivot leads: " + e.message); }
}

function renderPivotLead(L) {
  const multi = L.path_count > 1;
  const paths = L.paths.map(p => `
    <div class="path-row">
      <div class="path-text">${escapeHtml(p.path_text || "")}</div>
      <div class="detail-sub">${escapeHtml(p.why || "")}</div>
    </div>`).join("");

  return `
    <div class="result-card ${multi ? "card-converged" : ""}">
      <div class="result-head">
        <div>
          <div class="result-domain">${escapeHtml(L.domain || "")}
            ${multi ? '<span class="conv-flag">multi-path</span>' : ""}</div>
          ${L.url ? `<a class="result-url" href="${escapeHtml(L.url)}" target="_blank"
                        rel="noopener noreferrer">${escapeHtml(L.url)}</a>` : ""}
        </div>
        <div class="result-scores">
          <span class="risk-pill ${connectionTier(L.connection_score)}">
            connection ${Number(L.connection_score).toFixed(2)}</span>
          ${L.own_confidence != null
            ? `<span class="risk-pill ${confidenceClass(L.own_confidence)}">own ${pct(L.own_confidence)}</span>`
            : '<span class="risk-pill risk-low">not yet analysed</span>'}
          ${evidenceBadge("derived")}
        </div>
      </div>
      <div class="result-meta">
        <span>${L.path_count} path(s)</span>
        <span>${L.distinct_pivot_types} pivot type(s)</span>
        <span>${L.distinct_origin_sites} origin site(s)</span>
        <span>depth ${L.min_depth}</span>
      </div>
      <div class="result-evidence">${escapeHtml(L.summary || "")}</div>
      <h4 class="path-header">Discovery Path${L.path_count > 1 ? "s" : ""}</h4>
      ${paths}
      <div class="result-actions">
        <button class="btn btn-secondary btn-small" onclick="openWorkspace(${L.site_id})">
          Open in workspace</button>
      </div>
    </div>`;
}

document.getElementById("run-pivot-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("run-pivot-btn");
  btn.disabled = true; btn.textContent = "Expanding…";
  try {
    const r = await API.post("/api/pivot/expand", {
      max_depth: parseInt(document.getElementById("pivot-depth").value, 10),
      max_new_sites: parseInt(document.getElementById("pivot-max-new").value, 10),
    });
    appendLog("info", r.message || "Pivot expansion started.");
  } catch (e) { showError(e.message); }
  finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Expand from Strong Sites"; }, 1200);
  }
});

/* ==================== CAMPAIGNS (v0.4 Autonomous Discovery) ==================== */

// Live counters for the current campaign. These are per-run, not cumulative
// totals — the persisted numbers come back from the campaign list on refresh.
const campaignLive = {
  activePivots: 0, branches: 0, candidates: 0, rejected: 0, feed: [],
};

function renderCampaignCounters() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("camp-active", campaignLive.activePivots);
  set("camp-branches", campaignLive.branches);
  set("camp-candidates", campaignLive.candidates);
  set("camp-rejected", campaignLive.rejected);
}

function pushCampaignFeed(kind, title, detail) {
  campaignLive.feed.unshift({ kind, title, detail, at: new Date() });
  campaignLive.feed = campaignLive.feed.slice(0, 60);
  const box = document.getElementById("campaign-live-feed");
  if (!box) return;
  box.innerHTML = campaignLive.feed.map((row) => `
    <div class="feed-row feed-${row.kind}">
      <div class="feed-time">${row.at.toLocaleTimeString()}</div>
      <div class="feed-body">
        <div class="feed-title">${escapeHtml(row.title)}</div>
        ${row.detail ? `<div class="feed-detail">${escapeHtml(row.detail)}</div>` : ""}
      </div>
    </div>`).join("");
}

async function loadCampaignsView() {
  renderCampaignCounters();
  await Promise.all([loadCampaignList(), loadTechniques(), loadFamilyWatch(), loadCampaignStats()]);
}

async function loadCampaignStats() {
  try {
    const stats = await API.get("/api/graph/stats");
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("camp-clusters", stats.clusters ?? 0);
    const results = await API.get("/api/results?min_confidence=0.7&limit=200");
    set("camp-highconf", (results.results || []).length);
    const nav = document.getElementById("nav-count-campaigns");
    if (nav) nav.textContent = stats.campaigns ? stats.campaigns : "";
  } catch (e) { /* counters are decoration; never block the view */ }
}

async function loadCampaignList() {
  const box = document.getElementById("campaign-list");
  if (!box) return;
  try {
    const data = await API.get("/api/campaigns");
    const rows = data.campaigns || [];
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">No campaigns yet. Pick a seed above and start one.</div>`;
      return;
    }
    box.innerHTML = rows.map(renderCampaignRow).join("");
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load campaigns: ${escapeHtml(e.message)}</div>`;
  }
}

function renderCampaignRow(c) {
  const stats = c.stats || {};
  const statusCls = c.status === "running" ? "state-running"
    : (c.status === "completed" ? "state-idle" : "state-stopping");
  const resumable = c.status !== "running" && c.status !== "completed";
  return `
    <div class="result-card">
      <div class="result-head">
        <div>
          <div class="result-domain">${escapeHtml(c.name || c.campaign_key)}</div>
          <div class="result-sub">seed: ${escapeHtml(c.seed_kind)} — ${escapeHtml(String(c.seed_value).slice(0, 48))}</div>
        </div>
        <span class="scan-state ${statusCls}">${escapeHtml(c.status)}</span>
      </div>
      <div class="result-meta">
        <span>wave ${c.current_wave ?? 0}</span>
        <span>stage: ${escapeHtml(c.current_stage || "—")}</span>
        <span>${stats.leads_executed ?? 0} leads</span>
        <span>${stats.new_sites ?? 0} new sites</span>
        <span>${stats.validated ?? 0} validated</span>
        <span>${stats.promoted ?? 0} promoted</span>
        <span>${stats.rejected_noise ?? 0} set aside</span>
      </div>
      ${c.stopped_reason ? `<div class="result-evidence">Stopped: ${escapeHtml(c.stopped_reason)}</div>` : ""}
      <div class="result-actions">
        <button class="btn btn-secondary btn-small" onclick="showCampaignReport(${c.id})">View report</button>
        ${resumable ? `<button class="btn btn-primary btn-small" onclick="resumeCampaign(${c.id})">Resume</button>` : ""}
      </div>
      <div id="campaign-report-${c.id}"></div>
    </div>`;
}

async function showCampaignReport(campaignId) {
  const box = document.getElementById(`campaign-report-${campaignId}`);
  if (!box) return;
  if (box.innerHTML.trim()) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const r = await API.get(`/api/campaign/${campaignId}`);
    const stages = (r.stages || []).map((s) => `
      <tr><td>${s.wave}</td><td>${escapeHtml(s.stage)}</td>
      <td>${escapeHtml(s.status)}</td><td>${s.output_count ?? 0}</td>
      <td class="cell-wrap">${escapeHtml(s.detail || "")}</td></tr>`).join("");
    const budget = (r.budget || []).map((b) => `
      <tr><td>${escapeHtml(b.resource)}</td>
      <td>${Math.round(b.used_value)} / ${Math.round(b.limit_value)}</td></tr>`).join("");
    const candidates = (r.candidates || []).slice(0, 25).map((c) => `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(c.domain)}</strong>
          <span class="badge">connection ${Number(c.connection_score).toFixed(2)}</span>
          <span class="badge">${c.distinct_pivot_types} technique(s)</span>
          ${c.triage_passed === true ? `<span class="badge badge-good">cleared triage</span>` : ""}
          ${c.triage_passed === false ? `<span class="badge">did not clear triage</span>` : ""}
        </div>
        ${c.discovery_paths.map((p) => `<div class="path-step">${escapeHtml(p.path_text)}</div>`).join("")}
      </div>`).join("");

    box.innerHTML = `
      <div class="report-block">
        <h4 class="path-header">Stages</h4>
        <table class="mini-table"><thead><tr><th>Wave</th><th>Stage</th><th>Status</th><th>Out</th><th>Detail</th></tr></thead>
        <tbody>${stages || `<tr><td colspan="5">No stages recorded.</td></tr>`}</tbody></table>
        <h4 class="path-header">Budget</h4>
        <table class="mini-table"><thead><tr><th>Resource</th><th>Used</th></tr></thead>
        <tbody>${budget}</tbody></table>
        <h4 class="path-header">Candidates &amp; Discovery Paths</h4>
        ${candidates || `<div class="empty-state">No candidates recorded.</div>`}
        <div class="notice-box">${escapeHtml(r.note || "")}</div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load report: ${escapeHtml(e.message)}</div>`;
  }
}

async function resumeCampaign(campaignId) {
  try {
    const r = await API.post(`/api/campaign/${campaignId}/run`, {});
    appendLog(r.ok ? "info" : "warning", r.message);
    loadCampaignList();
  } catch (e) { showError(e.message); }
}

async function loadTechniques() {
  const box = document.getElementById("technique-list");
  if (!box) return;
  try {
    const data = await API.get("/api/techniques");
    const rows = data.techniques || [];
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">No techniques have run yet.</div>`;
      return;
    }
    box.innerHTML = rows.map((t) => {
      const cls = t.throttle_state === "suspended" ? "badge-bad"
        : (t.throttle_state === "reduced" ? "badge-warn" : "badge-good");
      return `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(t.pivot_type)}</strong>
          <span class="badge ${cls}">${escapeHtml(t.throttle_state)}</span>
          <span class="badge">yield ${Number(t.yield_score).toFixed(2)}</span>
          <span class="badge">priority ×${Number(t.priority_multiplier).toFixed(2)}</span>
        </div>
        <div class="lead-why">${escapeHtml(t.evidence_note || "")}</div>
        ${t.throttle_reason ? `<div class="lead-why">${escapeHtml(t.throttle_reason)}</div>` : ""}
      </div>`;
    }).join("") + `<div class="notice-box">${escapeHtml(data.note || "")}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load techniques: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadFamilyWatch() {
  const box = document.getElementById("family-matches");
  if (!box) return;
  try {
    const data = await API.get("/api/families/watch");
    const rows = data.new_domains || [];
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">No newly appearing domains have matched a known
        family yet.</div>`;
      return;
    }
    box.innerHTML = rows.map((n) => `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(n.domain)}</strong>
          <span class="badge">${escapeHtml(n.cluster_label || "family")}</span>
          <span class="badge">${escapeHtml(n.matched_indicator_type || "")}</span>
          <span class="badge">${escapeHtml(n.evidence_class)}</span>
        </div>
        <div class="lead-why">${escapeHtml(n.match_explanation || "")}</div>
        <div class="result-actions">
          <button class="btn btn-secondary btn-small" onclick="openWorkspace(${n.site_id})">
            Open in workspace</button>
        </div>
      </div>`).join("");
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load family matches: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("start-campaign-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("start-campaign-btn");
  const value = document.getElementById("campaign-seed-value").value.trim();
  if (!value) { showError("Enter a seed value first."); return; }
  btn.disabled = true; btn.textContent = "Starting…";
  campaignLive.activePivots = 0; campaignLive.branches = 0;
  campaignLive.candidates = 0; campaignLive.rejected = 0; campaignLive.feed = [];
  renderCampaignCounters();
  try {
    const r = await API.post("/api/campaign/create", {
      seed_kind: document.getElementById("campaign-seed-kind").value,
      seed_value: value,
      max_waves: parseInt(document.getElementById("campaign-waves").value, 10),
      start: true,
    });
    appendLog(r.ok ? "info" : "warning", r.message || "Campaign created.");
    loadCampaignList();
  } catch (e) { showError(e.message); }
  finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Start Campaign"; }, 1200);
  }
});

document.getElementById("watch-families-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("watch-families-btn");
  btn.disabled = true; btn.textContent = "Checking…";
  try {
    const r = await API.post("/api/families/scan", {});
    appendLog(r.ok ? "info" : "warning", r.message);
  } catch (e) { showError(e.message); }
  finally {
    setTimeout(() => {
      btn.disabled = false; btn.textContent = "Check Families"; loadFamilyWatch();
    }, 1500);
  }
});

/* ==================== PLATFORM INTEGRATION (v0.5) ==================== */

async function loadPlatformView() {
  await Promise.all([
    loadPlatformStatus(), loadPlatformHandoff(),
    loadStatsSources(), loadStatsPivots(), loadStatsIndicators(),
  ]);
}

function stateBadgeClass(state) {
  if (state === "online") return "badge-good";
  if (state === "offline" || state === "error") return "badge-bad";
  if (state === "incompatible") return "badge-warn";
  return "badge";
}

async function loadPlatformStatus() {
  try {
    const data = await API.get("/api/integration/status");
    const conn = data.connection || {};
    const box = data.outbox || {};

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("plat-queued", box.pending ?? 0);
    set("plat-sent", box.sent ?? 0);
    set("plat-failed", box.failed ?? 0);
    const nav = document.getElementById("nav-count-platform");
    if (nav) nav.textContent = box.pending ? box.pending : "";

    // The banner is the one-line answer to "is this working?".
    const bannerCls = conn.state === "online" ? "notice-box"
      : (conn.state === "offline" || conn.state === "error" || conn.state === "incompatible"
         ? "notice-box notice-bad" : "notice-box");
    document.getElementById("platform-banner").innerHTML =
      `<div class="${bannerCls}"><strong>${escapeHtml((conn.state || "unknown").toUpperCase())}</strong>
       — ${escapeHtml(conn.summary || "")}</div>`;

    document.getElementById("platform-connection").innerHTML = `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(conn.endpoint || "not configured")}</strong>
          <span class="badge ${stateBadgeClass(conn.state)}">${escapeHtml(conn.state || "")}</span>
          ${conn.degraded ? `<span class="badge badge-warn">degraded</span>` : ""}
        </div>
        <table class="mini-table">
          <tbody>
            <tr><td>Node</td><td>${escapeHtml(conn.node_id || "")}</td></tr>
            <tr><td>Our schema</td><td>${escapeHtml(conn.schema || "")}</td></tr>
            <tr><td>Platform schema</td><td>${escapeHtml(conn.platform_schema || "—")}</td></tr>
            <tr><td>Platform version</td><td>${escapeHtml(conn.platform_version || "—")}</td></tr>
            <tr><td>Last heartbeat</td><td>${conn.last_heartbeat_at ? new Date(conn.last_heartbeat_at * 1000).toLocaleString() : "never"}</td></tr>
            <tr><td>Consecutive failures</td><td>${conn.consecutive_failures ?? 0}</td></tr>
          </tbody>
        </table>
        ${conn.compatibility_detail ? `<div class="lead-why">${escapeHtml(conn.compatibility_detail)}</div>` : ""}
        ${conn.last_error ? `<div class="lead-why">Last error: ${escapeHtml(conn.last_error)}</div>` : ""}
      </div>`;

    const failures = data.recent_failures || [];
    document.getElementById("platform-failures").innerHTML = failures.length
      ? failures.map((f) => `
          <div class="lead-card">
            <div class="lead-head">
              <strong>${escapeHtml(f.event_type)}</strong>
              <span class="badge">${f.attempts} attempt(s)</span>
              <span class="badge">retry ${f.next_attempt_at ? new Date(f.next_attempt_at * 1000).toLocaleTimeString() : "—"}</span>
            </div>
            <div class="lead-why">${escapeHtml(f.last_error || "")}</div>
          </div>`).join("")
      : `<div class="empty-state">Nothing deferred.</div>`;

    const sent = data.recently_sent || [];
    document.getElementById("platform-sent").innerHTML = sent.length
      ? sent.map((s) => {
          const r = s.receipt || {};
          return `<div class="lead-card">
            <div class="lead-head">
              <strong>${escapeHtml(s.event_type)}</strong>
              ${r.investigation_id ? `<span class="badge badge-good">${escapeHtml(r.investigation_id)}</span>` : ""}
              ${r.investigator_job_id ? `<span class="badge">job ${escapeHtml(r.investigator_job_id)}</span>` : ""}
              <span class="badge">${s.sent_at ? new Date(s.sent_at * 1000).toLocaleTimeString() : ""}</span>
            </div>
          </div>`;
        }).join("")
      : `<div class="empty-state">Nothing sent yet.</div>`;

    document.getElementById("platform-failures").insertAdjacentHTML("beforeend",
      `<div class="notice-box">${escapeHtml(data.note || "")}</div>`);
  } catch (e) {
    document.getElementById("platform-banner").innerHTML =
      `<div class="notice-box notice-bad">Could not read integration status: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadPlatformHandoff() {
  const box = document.getElementById("platform-handoff");
  if (!box) return;
  try {
    const data = await API.get("/api/integration/handoff");
    const rows = data.handed_over || [];
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("plat-investigations", rows.filter((r) => r.investigation_id).length);
    set("plat-jobs", rows.filter((r) => r.investigator_job_id).length);

    box.innerHTML = `
      <div class="lead-card">
        <div class="lead-head">
          <strong>Deep investigation</strong>
          <span class="badge ${data.mode === "handoff" ? "badge-good" : "badge-warn"}">${escapeHtml(data.mode)}</span>
          <span class="badge">configured: ${escapeHtml(data.configured_mode || "auto")}</span>
        </div>
        <div class="lead-why">${escapeHtml(data.reason || "")}</div>
      </div>
      ${rows.slice(0, 20).map((r) => `
        <div class="lead-card">
          <div class="lead-head">
            <strong>${escapeHtml(r.domain)}</strong>
            ${r.investigation_id ? `<span class="badge badge-good">${escapeHtml(r.investigation_id)}</span>` : `<span class="badge">queued</span>`}
            ${r.investigator_job_id ? `<span class="badge">job</span>` : ""}
            <span class="badge">${r.events_sent ?? 0} event(s)</span>
          </div>
        </div>`).join("")}
      <div class="notice-box">${escapeHtml(data.note || "")}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load handoff state: ${escapeHtml(e.message)}</div>`;
  }
}

function funnelCells(row) {
  const pct = (v) => (v === null || v === undefined) ? "—" : `${Math.round(v * 100)}%`;
  return `
    <span class="badge">${row.candidates ?? 0} candidates</span>
    <span class="badge">${row.passed_triage ?? 0} triaged</span>
    <span class="badge">${row.sent_to_platform ?? 0} sent</span>
    <span class="badge">triage ${pct(row.triage_rate)}</span>
    <span class="badge">send ${pct(row.send_rate)}</span>`;
}

async function loadStatsSources() {
  const box = document.getElementById("stats-sources");
  if (!box) return;
  try {
    const data = await API.get("/api/stats/sources");
    const rows = data.sources || [];
    box.innerHTML = rows.length
      ? rows.map((r) => `
          <div class="lead-card">
            <div class="lead-head">
              <strong>${escapeHtml(r.source)}</strong>
              ${r.measured ? "" : `<span class="badge badge-warn">unmeasured</span>`}
              ${funnelCells(r)}
            </div>
            ${r.note ? `<div class="lead-why">${escapeHtml(r.note)}</div>` : ""}
          </div>`).join("") + `<div class="notice-box">${escapeHtml(data.note || "")}</div>`
      : `<div class="empty-state">No sources measured yet.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load sources: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadStatsPivots() {
  const box = document.getElementById("stats-pivots");
  if (!box) return;
  try {
    const data = await API.get("/api/stats/pivots");
    const rows = data.pivots || [];
    box.innerHTML = rows.length
      ? rows.map((r) => {
          const cls = r.throttle_state === "suspended" ? "badge-bad"
            : (r.throttle_state === "reduced" ? "badge-warn" : "badge-good");
          return `<div class="lead-card">
            <div class="lead-head">
              <strong>${escapeHtml(r.pivot_type)}</strong>
              <span class="badge ${cls}">${escapeHtml(r.throttle_state || "")}</span>
              ${r.measured ? "" : `<span class="badge badge-warn">unmeasured</span>`}
              <span class="badge">${r.unique_new ?? 0} new</span>
              <span class="badge">${r.sent_to_platform ?? 0} sent</span>
            </div>
            <div class="lead-why">${escapeHtml(r.evidence_note || "")}</div>
          </div>`;
        }).join("")
      : `<div class="empty-state">No pivots measured yet.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load pivots: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadStatsIndicators() {
  const box = document.getElementById("stats-indicators");
  if (!box) return;
  try {
    const data = await API.get("/api/stats/indicators");
    const retired = data.retired || [];
    box.innerHTML = retired.length
      ? retired.map((r) => `
          <div class="lead-card">
            <div class="lead-head">
              <strong>${escapeHtml(r.indicator_type)}</strong>
              <span class="badge">${escapeHtml(String(r.indicator_value).slice(0, 44))}</span>
              <span class="badge">${r.candidates_returned ?? 0} candidates</span>
              <span class="badge">${r.sites_passing_triage ?? 0} survived</span>
            </div>
            <div class="lead-why">${escapeHtml(r.retired_reason || "")}</div>
            <div class="result-actions">
              <button class="btn btn-secondary btn-small"
                onclick="reinstateIndicator('${escapeHtml(r.indicator_type)}', '${escapeHtml(String(r.indicator_value))}')">
                Put back in play</button>
            </div>
          </div>`).join("") + `<div class="notice-box">${escapeHtml(data.note || "")}</div>`
      : `<div class="empty-state">Nothing retired. ${escapeHtml(data.note || "")}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load indicators: ${escapeHtml(e.message)}</div>`;
  }
}

async function reinstateIndicator(indicatorType, value) {
  try {
    const r = await API.post("/api/stats/indicators/reinstate",
                             { indicator_type: indicatorType, value });
    appendLog(r.ok ? "info" : "warning", r.message);
    loadStatsIndicators();
  } catch (e) { showError(e.message); }
}

function wirePlatformButton(id, label, working, path, after) {
  document.getElementById(id)?.addEventListener("click", async () => {
    const btn = document.getElementById(id);
    btn.disabled = true; btn.textContent = working;
    try {
      const r = await API.post(path, {});
      appendLog("info", r.message || r.note || r.detail || `${label} done.`);
      if (after) after();
    } catch (e) { showError(e.message); }
    finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 900);
    }
  });
}

wirePlatformButton("platform-connect-btn", "Connect", "Connecting…",
                   "/api/integration/connect", loadPlatformStatus);
wirePlatformButton("platform-sync-btn", "Sync Now", "Syncing…",
                   "/api/integration/sync", loadPlatformView);
wirePlatformButton("platform-retry-btn", "Retry Deferred", "Retrying…",
                   "/api/integration/retry", loadPlatformStatus);
wirePlatformButton("sweep-indicators-btn", "Sweep Noisy Indicators", "Sweeping…",
                   "/api/stats/indicators/sweep", loadStatsIndicators);

/* ==================== DISCOVERY PERFORMANCE (v0.6) ==================== */

const perfPct = (v) => (v === null || v === undefined) ? "—" : `${Math.round(v * 100)}%`;

async function loadPerformanceView() {
  const box = document.getElementById("perf-funnel");
  try {
    const data = await API.get("/api/performance/overview");
    renderPerfFunnel(data.funnel);
    renderPerfSources(data.sources || []);
    renderPerfPivots(data.pivots || [], data.attribution || {});
    renderPerfFeedback(data.feedback || {});
    renderPerfAllocation(data.allocation || {});
    renderPerfHistory(data.history || []);
    loadPerfLimits();
    const nav = document.getElementById("nav-count-performance");
    const useful = (data.feedback?.by_outcome || {}).useful || 0;
    if (nav) nav.textContent = useful ? useful : "";
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty-state">Could not load performance: ${escapeHtml(e.message)}</div>`;
  }
}

function renderPerfFunnel(funnel) {
  const box = document.getElementById("perf-funnel");
  if (!box || !funnel) return;
  const f = funnel.funnel || {};
  const c = funnel.conversion || {};
  const stages = [
    ["Discovered", f.discovered ?? 0, null],
    ["Triaged", f.triaged ?? 0, null],
    ["Passed triage", f.passed_triage ?? 0, c.triage_rate],
    ["Sent to platform", f.sent_to_platform ?? 0, c.send_rate],
    ["Queued", f.queued_for_platform ?? 0, null],
  ];
  box.innerHTML = `
    <div class="chain-bar">
      ${stages.map((s, i) => `
        <div class="chain-step">
          <div class="chain-num">${s[1]}</div>
          <div>${escapeHtml(s[0])}</div>
          ${s[2] !== null && s[2] !== undefined ? `<div class="funnel-rate">${perfPct(s[2])}</div>` : ""}
        </div>
        ${i < stages.length - 1 ? `<div class="chain-arrow">→</div>` : ""}`).join("")}
    </div>
    ${funnel.best_pivot ? `<div class="notice-box">Best measured pivot:
      <strong>${escapeHtml(funnel.best_pivot.pivot_type)}</strong>.
      ${funnel.worst_pivot ? `Weakest: <strong>${escapeHtml(funnel.worst_pivot.pivot_type)}</strong>.` : ""}
      ${escapeHtml(funnel.note || "")}</div>` : ""}`;
}

function renderPerfSources(rows) {
  const box = document.getElementById("perf-sources");
  if (!box) return;
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="lead-card">
      <div class="lead-head">
        <strong>${escapeHtml(r.source)}</strong>
        ${r.measured ? "" : `<span class="badge badge-warn">unmeasured</span>`}
        <span class="badge">${r.candidates ?? 0} found</span>
        <span class="badge">${r.passed_triage ?? 0} triaged</span>
        <span class="badge">${r.sent_to_platform ?? 0} sent</span>
        <span class="badge">send ${perfPct(r.send_rate)}</span>
      </div>
      ${r.note ? `<div class="lead-why">${escapeHtml(r.note)}</div>` : ""}
    </div>`).join("") : `<div class="empty-state">No sources measured yet.</div>`;
}

function renderPerfPivots(rows, attribution) {
  const box = document.getElementById("perf-pivots");
  if (!box) return;
  const byPivot = {};
  (attribution.pivot || []).forEach((a) => { byPivot[a.key_value] = a; });
  box.innerHTML = rows.length ? rows.map((r) => {
    const a = byPivot[r.pivot_type];
    const cls = r.throttle_state === "suspended" ? "badge-bad"
      : (r.throttle_state === "reduced" ? "badge-warn" : "badge-good");
    return `<div class="lead-card">
      <div class="lead-head">
        <strong>${escapeHtml(r.pivot_type)}</strong>
        <span class="badge ${cls}">${escapeHtml(r.throttle_state || "")}</span>
        <span class="badge">${r.unique_new ?? 0} new</span>
        <span class="badge">${r.sent_to_platform ?? 0} sent</span>
        ${a ? `<span class="badge ${a.useful > a.thin ? "badge-good" : ""}">${a.useful ?? 0} useful / ${a.thin ?? 0} thin</span>` : ""}
        ${a && a.budget_multiplier !== 1 ? `<span class="badge">budget ×${Number(a.budget_multiplier).toFixed(2)}</span>` : ""}
      </div>
      <div class="lead-why">${escapeHtml(a?.evidence_note || r.evidence_note || "")}</div>
    </div>`;
  }).join("") : `<div class="empty-state">No pivots measured yet.</div>`;
}

function renderPerfFeedback(feedback) {
  const box = document.getElementById("perf-feedback");
  if (!box) return;
  const rows = feedback.recent || [];
  const counts = feedback.by_outcome || {};
  const summary = Object.entries(counts)
    .map(([k, v]) => `<span class="badge ${k === "useful" ? "badge-good" : (k === "thin" ? "badge-warn" : "")}">${escapeHtml(k)}: ${v}</span>`)
    .join(" ");
  box.innerHTML = (rows.length ? `<div class="lead-head" style="margin-bottom:8px;">${summary}</div>` : "")
    + (rows.length ? rows.map((r) => `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(r.domain || "")}</strong>
          <span class="badge ${r.outcome === "useful" ? "badge-good" : (r.outcome === "thin" ? "badge-warn" : "")}">${escapeHtml(r.outcome)}</span>
          ${r.deposit_pages ? `<span class="badge">${r.deposit_pages} deposit page(s)</span>` : ""}
          ${r.wallets ? `<span class="badge">${r.wallets} wallet(s)</span>` : ""}
          ${r.relationships ? `<span class="badge">${r.relationships} relationship(s)</span>` : ""}
          <span class="badge">${escapeHtml(r.source || "")}</span>
        </div>
        <div class="lead-why">${escapeHtml(r.detail || "")}</div>
      </div>`).join("") : `<div class="empty-state">No outcomes reported yet. Click "Poll Outcomes"
        once candidates have been investigated downstream.</div>`)
    + `<div class="notice-box">${escapeHtml(feedback.note || "")}</div>`;
}

function renderPerfAllocation(allocation) {
  const box = document.getElementById("perf-allocation");
  if (!box) return;
  const rows = allocation.pivots || [];
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="lead-card">
      <div class="lead-head">
        <strong>${escapeHtml(r.pivot_type)}</strong>
        <span class="badge">×${Number(r.budget_multiplier ?? 1).toFixed(2)}</span>
        <span class="badge">${r.candidates_examined ?? 0} examined</span>
        <span class="badge">${escapeHtml(r.status || "")}</span>
      </div>
      <div class="lead-why">${escapeHtml(r.evidence_note || "")}</div>
    </div>`).join("") + `<div class="notice-box">${escapeHtml(allocation.note || "")}</div>`
    : `<div class="empty-state">No downstream results yet, so no budget has moved.</div>`;
}

async function loadPerfLimits() {
  const box = document.getElementById("perf-limits");
  if (!box) return;
  try {
    const data = await API.get("/api/performance/rate_limits");
    const rows = data.services || [];
    box.innerHTML = rows.length ? rows.map((r) => `
      <div class="lead-card">
        <div class="lead-head">
          <strong>${escapeHtml(r.service)}</strong>
          <span class="badge ${r.available ? "badge-good" : "badge-warn"}">${r.available ? "available" : "waiting"}</span>
          <span class="badge">${r.calls_in_window}/${r.calls_per_window} per ${Math.round(r.window_seconds)}s</span>
          ${r.daily_limit ? `<span class="badge">${r.calls_today}/${r.daily_limit} today</span>` : ""}
          ${r.backing_off ? `<span class="badge badge-bad">backing off ${Math.round(r.backoff_remaining)}s</span>` : ""}
        </div>
        <div class="lead-why">${escapeHtml(r.status || "")}</div>
      </div>`).join("") + `<div class="notice-box">${escapeHtml(data.note || "")}</div>`
      : `<div class="empty-state">No external services used yet.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Could not load limits: ${escapeHtml(e.message)}</div>`;
  }
}

function renderPerfHistory(rows) {
  const box = document.getElementById("perf-history");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="empty-state">No history recorded yet. Click "Record Today".</div>`;
    return;
  }
  box.innerHTML = `
    <table class="mini-table">
      <thead><tr><th>Day</th><th>Discovered</th><th>Passed triage</th>
        <th>Sent</th><th>Useful</th><th>Thin</th><th>Leads</th></tr></thead>
      <tbody>${rows.slice().reverse().map((r) => `
        <tr><td>${escapeHtml(r.day)}</td><td>${r.discovered}</td><td>${r.passed_triage}</td>
        <td>${r.sent_to_platform}</td><td>${r.feedback_useful}</td>
        <td>${r.feedback_thin}</td><td>${r.leads_executed}</td></tr>`).join("")}</tbody>
    </table>`;
}

document.getElementById("perf-refresh-btn")?.addEventListener("click", loadPerformanceView);
wirePlatformButton("perf-poll-btn", "Poll Outcomes", "Polling…",
                   "/api/performance/poll", loadPerformanceView);
wirePlatformButton("perf-snapshot-btn", "Record Today", "Recording…",
                   "/api/performance/snapshot", loadPerformanceView);

/* ==================== MAIN SCREEN (v0.7) ==================== */

async function loadMainScreen() {
  try {
    const d = await API.get("/api/main");
    renderOpsCampaigns(d.active_campaigns || []);
    renderOpsList("ops-high-priority", (d.high_priority || []).map((r) => ({
      title: r.domain,
      badges: [r.investigation_id ? "investigation" : "queued", r.state || ""].filter(Boolean),
      siteId: r.site_id,
    })), "Nothing handed over yet.");
    renderOpsList("ops-new", (d.new_discoveries || []).map((r) => ({
      title: r.domain,
      badges: [`novelty ${Number(r.novelty ?? 0).toFixed(2)}`,
               r.last_decision || "", r.distinct_campaigns > 1 ? `${r.distinct_campaigns} campaigns` : ""].filter(Boolean),
      siteId: r.site_id,
    })), "No new candidates.");
    renderOpsReview(d.needs_review || {});
    renderOpsList("ops-handoffs", (d.recent_handoffs || []).map((r) => ({
      title: r.domain,
      badges: [r.investigator_job_id ? "investigator job" : "no job yet",
               r.last_sent_at ? new Date(r.last_sent_at * 1000).toLocaleTimeString() : ""].filter(Boolean),
    })), "Nothing sent yet.");
    renderOpsPerformance(d.performance || {});
  } catch (e) {
    const box = document.getElementById("ops-campaigns");
    if (box) box.innerHTML = `<div class="empty-state">Could not load: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOpsCampaigns(rows) {
  const box = document.getElementById("ops-campaigns");
  if (!box) return;
  box.innerHTML = rows.length ? rows.map((c) => `
    <div class="ops-row">
      <div>
        <div class="ops-title">${escapeHtml(c.name || "campaign")}</div>
        <div class="ops-sub">${escapeHtml(c.seed)} — wave ${c.wave ?? 0}, ${escapeHtml(c.stage || "—")}</div>
        <div class="ops-sub">${c.stats?.new_sites ?? 0} new · ${c.stats?.promoted ?? 0} promoted · ${c.stats?.rejected_noise ?? 0} set aside</div>
      </div>
      <div class="ops-actions">
        <span class="badge ${c.status === "running" ? "badge-good" : ""}">${escapeHtml(c.status)}</span>
        ${c.control?.paused ? `<span class="badge badge-warn">pause queued</span>` : ""}
        ${c.control?.stop_after_current ? `<span class="badge badge-warn">stopping</span>` : ""}
        <button class="btn-mini" onclick="campaignControl(${c.campaign_id}, 'pause')">Pause</button>
        <button class="btn-mini" onclick="campaignControl(${c.campaign_id}, 'stop_after_current')">Stop after wave</button>
        <button class="btn-mini" onclick="campaignControl(${c.campaign_id}, 'resume')">Resume</button>
      </div>
    </div>`).join("") : `<div class="empty-state">No campaigns running.</div>`;
}

function renderOpsList(id, rows, emptyText) {
  const box = document.getElementById(id);
  if (!box) return;
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="ops-row">
      <div>
        <div class="ops-title">${escapeHtml(r.title)}</div>
        <div class="ops-sub">${r.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")}</div>
      </div>
      ${r.siteId ? `<button class="btn-mini" onclick="showWhySurfaced(${r.siteId})">Why?</button>` : ""}
    </div>`).join("") : `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
}

function renderOpsReview(review) {
  const box = document.getElementById("ops-review");
  if (!box) return;
  const items = [
    ["Deferred deliveries", review.deferred_batches ?? 0],
    ["Inconclusive candidates", review.inconclusive ?? 0],
    ["Unreachable candidates", review.unreachable ?? 0],
  ].filter((i) => i[1] > 0);
  box.innerHTML = items.length ? items.map((i) => `
    <div class="ops-row"><div class="ops-title">${escapeHtml(i[0])}</div>
    <span class="badge badge-warn">${i[1]}</span></div>`).join("")
    + `<div class="ops-row"><button class="btn-mini" onclick="sweepMemory()">Recheck dismissed candidates for new evidence</button></div>`
    : `<div class="empty-state">Nothing waiting.</div>`;
}

function renderOpsPerformance(perf) {
  const box = document.getElementById("ops-performance");
  if (!box) return;
  const f = perf.funnel || {};
  const c = perf.conversion || {};
  box.innerHTML = `
    <div class="ops-row"><div class="ops-title">Discovered</div><span class="badge">${f.discovered ?? 0}</span></div>
    <div class="ops-row"><div class="ops-title">Passed triage</div><span class="badge">${f.passed_triage ?? 0} (${perfPct(c.triage_rate)})</span></div>
    <div class="ops-row"><div class="ops-title">Sent to platform</div><span class="badge">${f.sent_to_platform ?? 0} (${perfPct(c.send_rate)})</span></div>
    <div class="ops-row"><div class="ops-title">Queued</div><span class="badge">${f.queued_for_platform ?? 0}</span></div>
    ${perf.best_pivot ? `<div class="ops-row"><div class="ops-sub">Best measured pivot: <strong>${escapeHtml(perf.best_pivot.pivot_type)}</strong></div></div>` : ""}`;
}

async function campaignControl(campaignId, action) {
  try {
    const r = await API.post(`/api/campaign/${campaignId}/control`, { action });
    appendLog(r.ok ? "info" : "warning", r.message);
    loadMainScreen();
  } catch (e) { showError(e.message); }
}

async function sweepMemory() {
  try {
    const r = await API.post("/api/memory/sweep", {});
    appendLog("info", `${r.revisited} candidate(s) revisited, ${r.newly_promoted} newly promoted. ${r.note}`);
    loadMainScreen();
  } catch (e) { showError(e.message); }
}

/* ---- Why this site was surfaced ---- */

async function showWhySurfaced(siteId) {
  const drawer = document.getElementById("why-drawer");
  const body = document.getElementById("why-body");
  if (!drawer || !body) return;
  drawer.style.display = "flex";
  body.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const w = await API.get(`/api/candidate/${siteId}/why`);
    document.getElementById("why-title").textContent = `Why ${w.domain} was surfaced`;
    const factorList = (factors) => (factors || []).map((f) =>
      `<li><strong>${escapeHtml(f.factor)}</strong> (${(f.weight * f.value).toFixed(2)},
       ${escapeHtml(f.evidence_class)}) — ${escapeHtml(f.evidence)}</li>`).join("");

    body.innerHTML = `
      <h4 class="path-header">Origin</h4>
      <div class="lead-card">
        <div class="lead-why">Source: ${escapeHtml(w.origin.discovery_source || "—")}.
          ${escapeHtml(w.origin.discovery_reason || "")}
          ${w.origin.seed_domains?.length ? `Seed: ${escapeHtml(w.origin.seed_domains.join(", "))}.` : ""}</div>
      </div>

      <h4 class="path-header">Discovery paths (${w.discovery_paths.length})</h4>
      ${w.discovery_paths.map((p) => `<div class="path-step">${escapeHtml(p.path_text || "")}</div>`).join("")}
      <div class="lead-why">${escapeHtml(w.path_quality.note || "")}</div>

      <h4 class="path-header">Convergence</h4>
      <div class="lead-card"><div class="lead-why">${escapeHtml(w.convergence.interpretation)}</div></div>

      <h4 class="path-header">Priority ${Number(w.priority.score ?? 0).toFixed(2)}</h4>
      <ul class="detail-list">${factorList(w.priority.factors)}</ul>

      <h4 class="path-header">Novelty ${Number(w.novelty.score ?? 0).toFixed(2)}
        <span class="panel-sub">(kept separate from priority)</span></h4>
      <ul class="detail-list">${factorList(w.novelty.factors)}</ul>

      <h4 class="path-header">Observed indicators</h4>
      <ul class="detail-list">${w.observed_indicators.slice(0, 12).map((i) =>
        `<li>${escapeHtml(i.indicator_type)}: ${escapeHtml(String(i.value).slice(0, 60))}
         <span class="badge">${i.site_count ?? 0} site(s)</span></li>`).join("")}</ul>

      ${w.history.decisions?.length ? `<h4 class="path-header">Previous decisions</h4>
        <ul class="detail-list">${w.history.decisions.map((d) =>
          `<li><strong>${escapeHtml(d.decision)}</strong> — ${escapeHtml(d.reason || "")}
           ${d.superseded_reason ? `<em>Superseded: ${escapeHtml(d.superseded_reason)}</em>` : ""}</li>`).join("")}</ul>` : ""}

      ${w.history.downstream_outcomes?.length ? `<h4 class="path-header">Downstream outcomes</h4>
        <ul class="detail-list">${w.history.downstream_outcomes.map((o) =>
          `<li><strong>${escapeHtml(o.outcome)}</strong> — ${escapeHtml(o.detail || "")}</li>`).join("")}</ul>` : ""}

      <h4 class="path-header">Promotion decision</h4>
      <div class="lead-card"><div class="lead-why">
        ${(w.promotion.reasons_passed || []).map(escapeHtml).join(" ")}
        ${(w.promotion.blocked_by || []).map(escapeHtml).join(" ")}</div></div>

      <div class="notice-box">${escapeHtml(w.note)}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Could not load: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("why-close")?.addEventListener("click", () => {
  const d = document.getElementById("why-drawer");
  if (d) d.style.display = "none";
});
document.getElementById("ops-refresh-btn")?.addEventListener("click", loadMainScreen);
