"""
SQLite storage layer. One file, simple schema, WAL mode for concurrent workers.
Designed to comfortably hold thousands of candidate sites.
"""
import sqlite3
import hashlib
import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import threading
from urllib.parse import urlparse

from app.config import DB_PATH

logger = logging.getLogger("scamhunter.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    domain_hash TEXT UNIQUE NOT NULL,   -- dedup key
    source TEXT,                        -- where this candidate came from
    status TEXT DEFAULT 'new',          -- new, queued, scanning, scanned, error, skipped
    score REAL DEFAULT 0,
    score_reasons TEXT,
    added_at REAL,
    scanned_at REAL,
    notes TEXT,
    discovery_confidence REAL DEFAULT 0.5,  -- how confident the discoverer was this is worth checking
    discovery_reason TEXT,                  -- plain-language explanation of why/how it was found
    discovery_category TEXT                 -- e.g. investment_platform, fake_exchange, cloud_mining, brand_impersonation
);

CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_score ON sites(score DESC);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    url TEXT NOT NULL,
    title TEXT,
    page_type TEXT,             -- deposit, wallet, funding, investment, other
    screenshot_path TEXT,
    html_snapshot_path TEXT,
    visited_at REAL,
    claude_reasoning TEXT       -- why Claude chose to visit / what it found
);

CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    network TEXT,
    address_hash TEXT UNIQUE NOT NULL,  -- dedup key (network+address)
    first_seen_site_id INTEGER REFERENCES sites(id),
    confidence REAL DEFAULT 0.5,
    added_at REAL
);

CREATE TABLE IF NOT EXISTS wallet_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    site_id INTEGER NOT NULL REFERENCES sites(id),
    page_id INTEGER REFERENCES pages(id),
    context_snippet TEXT,
    seen_at REAL,
    UNIQUE(wallet_id, page_id)
);

CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    summary TEXT,
    review_status TEXT DEFAULT 'pending',  -- pending, approved, rejected
    reviewed_at REAL,
    reviewer_notes TEXT,
    submitted_to_form INTEGER DEFAULT 0,
    submitted_at REAL,
    created_at REAL
);

CREATE TABLE IF NOT EXISTS signup_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    status TEXT,             -- attempted, blocked_captcha, blocked_verification, success, failed
    detail TEXT,
    attempted_at REAL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- ============================================================
-- Quality-over-quantity pipeline
-- ============================================================
-- Sites move: discovered -> triaged (cheap filter) -> deep_analyzed.
-- Only sites that clear the triage gate get deep analysis, so the expensive
-- work is concentrated on the strongest candidates rather than spread thin
-- across every site containing a stray keyword.

-- Cheap, fast triage pass: one lightweight HTTP GET, no browser. Records WHY
-- a site passed or failed the gate so a rejected site isn't a black box.
CREATE TABLE IF NOT EXISTS triage_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    passed INTEGER DEFAULT 0,          -- 1 if it cleared the gate for deep analysis
    triage_score REAL DEFAULT 0,
    indicator_count INTEGER DEFAULT 0, -- how many DISTINCT indicator categories fired
    indicators TEXT,                   -- JSON list of {category, detail, weight}
    reject_reason TEXT,                -- set when passed=0
    http_status INTEGER,
    triaged_at REAL,
    UNIQUE(site_id)
);

CREATE INDEX IF NOT EXISTS idx_triage_passed ON triage_results(passed, triage_score DESC);

-- The deep-analysis profile: the rich, evidence-heavy record produced for each
-- site that clears triage. This is what the "high-confidence results" view
-- reads from, and what feeds the Google Form submission.
CREATE TABLE IF NOT EXISTS deep_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    status TEXT DEFAULT 'pending',     -- pending, running, complete, failed
    -- Identity
    domain TEXT,
    full_url TEXT,
    site_title TEXT,
    site_description TEXT,
    -- Scoring
    risk_score REAL DEFAULT 0,
    confidence_score REAL DEFAULT 0,
    flag_reasons TEXT,                 -- JSON list of plain-language reasons
    indicator_categories TEXT,         -- JSON list of distinct categories that fired
    -- Content evidence
    important_text TEXT,               -- key extracted page text
    keywords_found TEXT,               -- JSON list of {keyword, category, page_url}
    deposit_pages TEXT,                -- JSON list of {url, page_type, title}
    -- Infrastructure / relationships
    domain_age_days INTEGER,
    registration_info TEXT,            -- JSON: registrar, created, expires, nameservers
    related_domains TEXT,              -- JSON list of {domain, relation, detail}
    shared_infrastructure TEXT,        -- JSON: ip, asn, nameservers, matches
    template_matches TEXT,             -- JSON list of {domain, similarity}
    -- Contact / social
    contact_info TEXT,                 -- JSON: emails, phones, telegram, whatsapp
    social_links TEXT,                 -- JSON list of {platform, url}
    -- Threat intel
    threat_intel TEXT,                 -- JSON list of {source, verdict, detail}
    -- Provenance
    discovery_source TEXT,
    screenshots TEXT,                  -- JSON list of {path, label}
    evidence_summary TEXT,             -- human-readable "why this is a strong result"
    analyzed_at REAL,
    UNIQUE(site_id)
);

CREATE INDEX IF NOT EXISTS idx_deep_profiles_status ON deep_profiles(status);
CREATE INDEX IF NOT EXISTS idx_deep_profiles_conf ON deep_profiles(confidence_score DESC);

-- Wallet validation: checksum/format validation plus, when publicly available,
-- on-chain activity. Separate from the wallets table so a wallet can be
-- re-validated later without losing its original extraction record.
CREATE TABLE IF NOT EXISTS wallet_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    format_valid INTEGER DEFAULT 0,      -- passes checksum/format rules for its network
    validation_detail TEXT,              -- why it is/isn't valid
    network_confirmed TEXT,              -- network as confirmed by validation
    -- On-chain activity, when a public explorer was reachable
    activity_checked INTEGER DEFAULT 0,
    activity_available INTEGER DEFAULT 0,
    balance TEXT,
    tx_count INTEGER,
    first_seen_onchain TEXT,
    last_seen_onchain TEXT,
    total_received TEXT,
    activity_source TEXT,                -- which explorer answered
    activity_error TEXT,                 -- why activity lookup failed, if it did
    validated_at REAL,
    UNIQUE(wallet_id)
);

-- Google Form submission tracking, including the validation gate results that
-- were checked before a submission was allowed to proceed.
CREATE TABLE IF NOT EXISTS form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    finding_id INTEGER REFERENCES findings(id),
    mode TEXT,                         -- manual, review_before_submit, automatic
    status TEXT,                       -- validated, prefilled, awaiting_confirm, submitted, rejected, failed
    validation_passed INTEGER DEFAULT 0,
    validation_detail TEXT,            -- JSON list of {check, passed, detail}
    submitted_wallet_address TEXT,
    submitted_wallet_network TEXT,
    prefill_screenshot TEXT,
    confirmed_by_user_at REAL,
    created_at REAL,
    updated_at REAL
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_site ON form_submissions(site_id);

-- One row per site investigation *session* (a site can be investigated more than
-- once, e.g. re-checked later), giving the UI something to show live status/
-- progress against without overloading the sites table itself.
CREATE TABLE IF NOT EXISTS investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    status TEXT DEFAULT 'starting',
    -- starting, browsing, blocked, error, unreachable, completed, stopped
    stop_reason TEXT,            -- set when status is 'blocked'/'error'/'unreachable'/'stopped'
    pages_visited INTEGER DEFAULT 0,
    wallets_found INTEGER DEFAULT 0,
    current_url TEXT,
    started_at REAL,
    finished_at REAL
);

CREATE INDEX IF NOT EXISTS idx_investigations_site ON investigations(site_id);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);

-- A record of every meaningful navigation decision the agent made during an
-- investigation, in plain language, so a human reviewer can see *why* the
-- agent went where it went (or why it stopped) without re-watching a recording.
CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id INTEGER NOT NULL REFERENCES investigations(id),
    site_id INTEGER NOT NULL REFERENCES sites(id),
    decision_type TEXT,   -- navigate, skip, stop, login_detected, signup_attempted, error
    detail TEXT,
    url TEXT,
    made_at REAL
);

CREATE INDEX IF NOT EXISTS idx_decision_log_investigation ON decision_log(investigation_id);

-- Ties a specific wallet sighting to the full evidence bundle captured at the
-- moment it was found (its own screenshot + surrounding text), separate from
-- the page-level screenshot, so a wallet found deep in a page (after a scroll
-- or a modal) still has evidence that actually shows it.
CREATE TABLE IF NOT EXISTS wallet_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_sighting_id INTEGER NOT NULL REFERENCES wallet_sightings(id),
    screenshot_path TEXT,
    surrounding_text TEXT,
    created_at REAL
);

-- One row per (source, url) a discoverer ever surfaced — including ones that
-- turned out to be duplicates of an existing site. This is the permanent
-- discovery audit trail: "exactly why and where it was found," kept even for
-- candidates that didn't become a new sites row, so re-running discovery
-- doesn't lose the history of what a source has already suggested (used for
-- source-level dedup independent of the sites table's domain-level dedup).
CREATE TABLE IF NOT EXISTS discovery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    domain_hash TEXT NOT NULL,
    source TEXT NOT NULL,             -- discoverer name, e.g. 'certificate_transparency'
    category TEXT,                    -- investment_platform, fake_exchange, cloud_mining, etc.
    confidence REAL DEFAULT 0.5,
    reason TEXT,                      -- plain-language explanation
    pivot_from_site_id INTEGER REFERENCES sites(id),  -- set when found by pivoting off another site
    resulted_in_site_id INTEGER REFERENCES sites(id), -- set if this became a new sites row
    was_duplicate INTEGER DEFAULT 0,  -- 1 if the domain was already known when this event fired
    found_at REAL
);

CREATE INDEX IF NOT EXISTS idx_discovery_events_domain ON discovery_events(domain_hash);
CREATE INDEX IF NOT EXISTS idx_discovery_events_source ON discovery_events(source);
CREATE INDEX IF NOT EXISTS idx_discovery_events_found_at ON discovery_events(found_at DESC);

-- One row per discovery run (a single invocation of the discovery engine,
-- which may call several discoverer sources), for the UI's live stats and
-- run history — how many candidates each source produced, how long it took,
-- and whether it hit any errors (e.g. a rate limit).
CREATE TABLE IF NOT EXISTS discovery_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at REAL,
    finished_at REAL,
    sources_run TEXT,          -- comma-separated list of discoverer names invoked
    total_candidates INTEGER DEFAULT 0,
    total_new_sites INTEGER DEFAULT 0,
    total_duplicates INTEGER DEFAULT 0,
    errors TEXT                -- JSON-ish text summary of any per-source errors
);

CREATE TABLE IF NOT EXISTS discovery_run_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES discovery_runs(id),
    source TEXT NOT NULL,
    candidates_found INTEGER DEFAULT 0,
    new_sites INTEGER DEFAULT 0,
    duplicates INTEGER DEFAULT 0,
    error TEXT,
    duration_seconds REAL
);

CREATE INDEX IF NOT EXISTS idx_discovery_run_sources_run ON discovery_run_sources(run_id);

-- ============================================================
-- v2: Indicator graph, clustering, history, timeline
-- ============================================================
-- The organising idea of v2 is that scam operations reuse things. Every
-- reusable public artifact a site exposes becomes a normalised "indicator"
-- row, and any two sites sharing an indicator are connected by construction.
-- That turns a pile of separate findings into families with evidence.
--
-- A hard rule runs through all of this: every row records whether it is an
-- OBSERVED FACT (we saw this with our own eyes on the page / in DNS) or a
-- DERIVED CORRELATION (software concluded it by comparing observations).
-- The two are never mixed, because a human reviewer needs to know which
-- claims are measurements and which are inferences.

CREATE TABLE IF NOT EXISTS indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indicator_type TEXT NOT NULL,   -- wallet, ip, nameserver, cert_sha256, analytics_id,
                                     -- template_hash, email, telegram, whatsapp, phone,
                                     -- registrar, favicon_hash, asn, social_handle
    value TEXT NOT NULL,            -- normalised value (lowercased where case-insensitive)
    value_hash TEXT UNIQUE NOT NULL, -- dedup key: hash(type|value)
    first_seen REAL,
    last_seen REAL,
    site_count INTEGER DEFAULT 0,   -- denormalised for fast "how shared is this?" queries
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_indicators_type ON indicators(indicator_type);
CREATE INDEX IF NOT EXISTS idx_indicators_shared ON indicators(site_count DESC);

-- An OBSERVATION: this site exposed this indicator, here, at this time.
-- Purely factual — no inference lives in this table.
CREATE TABLE IF NOT EXISTS site_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    indicator_id INTEGER NOT NULL REFERENCES indicators(id),
    evidence_class TEXT DEFAULT 'observed',  -- always 'observed' here, kept explicit
    source_url TEXT,                -- exact page/endpoint it was observed on
    source_method TEXT,             -- page_text, html, dns_a, dns_ns, tls_cert, http_header...
    context_snippet TEXT,           -- surrounding text proving it was really there
    screenshot_path TEXT,
    first_observed REAL,
    last_observed REAL,
    still_present INTEGER DEFAULT 1, -- 0 once a later scan no longer finds it
    UNIQUE(site_id, indicator_id, source_method)
);

CREATE INDEX IF NOT EXISTS idx_site_indicators_site ON site_indicators(site_id);
CREATE INDEX IF NOT EXISTS idx_site_indicators_ind ON site_indicators(indicator_id);

-- A DERIVED CORRELATION: software concluded these two sites are related.
-- Always traceable back to the shared indicator(s) that justify it.
CREATE TABLE IF NOT EXISTS site_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_a_id INTEGER NOT NULL REFERENCES sites(id),
    site_b_id INTEGER NOT NULL REFERENCES sites(id),
    relation_type TEXT NOT NULL,     -- shared_wallet, shared_ip, shared_nameserver,
                                      -- shared_template, shared_contact, shared_analytics,
                                      -- shared_cert, similar_domain
    evidence_class TEXT DEFAULT 'derived',
    strength REAL DEFAULT 0.5,       -- how strongly this indicator implies same operator
    shared_indicator_id INTEGER REFERENCES indicators(id),
    explanation TEXT,                -- plain language: exactly why these are linked
    first_derived REAL,
    last_confirmed REAL,
    UNIQUE(site_a_id, site_b_id, relation_type, shared_indicator_id)
);

CREATE INDEX IF NOT EXISTS idx_rel_a ON site_relationships(site_a_id);
CREATE INDEX IF NOT EXISTS idx_rel_b ON site_relationships(site_b_id);

-- A CLUSTER (website family): a connected group of sites, with its own
-- priority driven by how many INDEPENDENT strong indicator types tie it
-- together — the cluster analogue of the per-site quality gate.
CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    site_count INTEGER DEFAULT 0,
    distinct_indicator_types INTEGER DEFAULT 0,
    strong_indicator_types INTEGER DEFAULT 0,
    priority_score REAL DEFAULT 0,
    max_site_confidence REAL DEFAULT 0,
    total_validated_wallets INTEGER DEFAULT 0,
    summary TEXT,                    -- human-readable "why this is one family"
    evidence_class TEXT DEFAULT 'derived',
    created_at REAL,
    updated_at REAL
);

CREATE INDEX IF NOT EXISTS idx_clusters_priority ON clusters(priority_score DESC);

CREATE TABLE IF NOT EXISTS cluster_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER NOT NULL REFERENCES clusters(id),
    site_id INTEGER NOT NULL REFERENCES sites(id),
    join_reason TEXT,                -- which shared indicator pulled this site in
    added_at REAL,
    UNIQUE(cluster_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_site ON cluster_members(site_id);

-- HISTORICAL TRACKING: what changed, when. Old observations are never
-- silently overwritten — they are closed out and kept, so a previous scan
-- informs correlation without being mistaken for current truth.
CREATE TABLE IF NOT EXISTS indicator_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    indicator_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    change_type TEXT,                -- appeared, disappeared, changed
    detected_at REAL,
    scan_id TEXT,                    -- which scan run noticed it
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_indicator_history_site ON indicator_history(site_id, detected_at DESC);

-- EVIDENCE TIMELINE: one chronological stream per site, mixing observations
-- and derived conclusions but always labelled, so the investigation reads as
-- a story rather than a pile of tables.
CREATE TABLE IF NOT EXISTS evidence_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    occurred_at REAL,
    event_type TEXT,                 -- discovered, triaged, page_captured, wallet_found,
                                      -- indicator_observed, relationship_derived,
                                      -- cluster_joined, changed, submitted
    evidence_class TEXT,             -- observed | derived
    title TEXT,
    detail TEXT,
    url TEXT,
    screenshot_path TEXT,
    ref_table TEXT,                  -- optional pointer to the underlying row
    ref_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_timeline_site ON evidence_timeline(site_id, occurred_at);

-- Deposit options: a first-class record of every way a site asks to be paid,
-- which is the operationally important part of these sites.
CREATE TABLE IF NOT EXISTS deposit_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    page_id INTEGER REFERENCES pages(id),
    page_url TEXT,
    method TEXT,                     -- crypto_address, qr_code, bank_transfer, payment_processor, unknown
    network TEXT,                    -- for crypto: BTC/TRON/ETH...
    wallet_id INTEGER REFERENCES wallets(id),
    label TEXT,                      -- the on-page label, e.g. "USDT-TRC20"
    min_amount TEXT,
    instructions TEXT,
    evidence_class TEXT DEFAULT 'observed',
    screenshot_path TEXT,
    first_seen REAL,
    last_seen REAL,
    still_present INTEGER DEFAULT 1,
    UNIQUE(site_id, page_url, method, network, label)
);

CREATE INDEX IF NOT EXISTS idx_deposit_options_site ON deposit_options(site_id);

-- Scan runs, so history can be attributed to a specific pass.

-- ============================================================
-- v0.3: Discovery Pivot Engine (branching expansion)
-- ============================================================
-- The engine expands outward in waves:
--   Seed -> Indicators -> Pivots -> New Sites -> New Indicators -> More Pivots
-- Each wave is one "depth". These tables record the expansion so that every
-- discovered site can explain exactly how it was reached, and so runaway
-- searching is bounded and auditable rather than open-ended.

CREATE TABLE IF NOT EXISTS pivot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT UNIQUE NOT NULL,
    started_at REAL,
    finished_at REAL,
    max_depth INTEGER,
    seed_count INTEGER DEFAULT 0,
    leads_generated INTEGER DEFAULT 0,
    leads_executed INTEGER DEFAULT 0,
    candidates_found INTEGER DEFAULT 0,
    new_sites INTEGER DEFAULT 0,
    stopped_reason TEXT,          -- completed | depth_limit | candidate_limit | time_limit | stopped
    config TEXT,                  -- JSON snapshot of the limits used for this run
    notes TEXT
);

-- A PIVOT LEAD: one indicator turned into a searchable question, e.g.
-- "which other domains present TLS cert sha256 X?" Leads are queued, then
-- executed against passive public sources.
CREATE TABLE IF NOT EXISTS pivot_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES pivot_runs(id),
    lead_key TEXT NOT NULL,       -- dedup key: pivot_type|normalised value
    pivot_type TEXT NOT NULL,     -- cert_san, analytics_id, wallet, template, domain_pattern...
    indicator_id INTEGER REFERENCES indicators(id),
    indicator_type TEXT,
    indicator_value TEXT,
    origin_site_id INTEGER REFERENCES sites(id),
    depth INTEGER DEFAULT 0,      -- 0 = directly off a seed
    strength REAL DEFAULT 0.5,    -- how discriminating this indicator is
    status TEXT DEFAULT 'queued', -- queued | executed | skipped | failed
    skip_reason TEXT,
    candidates_found INTEGER DEFAULT 0,
    new_sites INTEGER DEFAULT 0,
    executed_at REAL,
    created_at REAL,
    UNIQUE(run_id, lead_key)
);

CREATE INDEX IF NOT EXISTS idx_pivot_leads_status ON pivot_leads(status, depth, strength DESC);
CREATE INDEX IF NOT EXISTS idx_pivot_leads_key ON pivot_leads(lead_key);

-- A DISCOVERY PATH: one complete explanation of how a site was reached.
-- A site can have several, which is exactly the convergence signal we want.
CREATE TABLE IF NOT EXISTS discovery_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES pivot_runs(id),
    site_id INTEGER REFERENCES sites(id),
    domain TEXT,
    lead_id INTEGER REFERENCES pivot_leads(id),
    origin_site_id INTEGER REFERENCES sites(id),
    depth INTEGER DEFAULT 0,
    pivot_type TEXT,
    indicator_type TEXT,
    indicator_value TEXT,
    path_json TEXT,               -- ordered hop list: seed -> ... -> this site
    path_text TEXT,               -- human-readable one-line rendering
    evidence_class TEXT DEFAULT 'derived',
    link_strength REAL DEFAULT 0,
    found_at REAL,
    UNIQUE(site_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_discovery_paths_site ON discovery_paths(site_id);
CREATE INDEX IF NOT EXISTS idx_discovery_paths_run ON discovery_paths(run_id);

-- CONVERGENCE: when several INDEPENDENT pivots reach the same domain, that is
-- a meaningfully stronger lead than any single pivot. Recomputed from paths.
CREATE TABLE IF NOT EXISTS pivot_convergence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id),
    domain TEXT,
    path_count INTEGER DEFAULT 0,
    distinct_pivot_types INTEGER DEFAULT 0,
    distinct_origin_sites INTEGER DEFAULT 0,
    strongest_link REAL DEFAULT 0,
    connection_score REAL DEFAULT 0,
    min_depth INTEGER DEFAULT 0,
    summary TEXT,
    evidence_class TEXT DEFAULT 'derived',
    updated_at REAL,
    UNIQUE(site_id)
);

CREATE INDEX IF NOT EXISTS idx_convergence_score ON pivot_convergence(connection_score DESC);

-- ============================================================
-- v0.4: Autonomous Discovery Intelligence
-- ============================================================
-- v0.3 could pivot. v0.4 learns which pivots are worth running.
-- Every technique's history is recorded so future runs can prefer what has
-- actually produced useful, unique sites and throttle what produces noise.

-- Per-technique performance ledger: written after every executed lead, read
-- before choosing what to run next. This is the memory that makes the engine
-- adaptive rather than merely repetitive.
CREATE TABLE IF NOT EXISTS pivot_technique_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pivot_type TEXT UNIQUE NOT NULL,
    leads_executed INTEGER DEFAULT 0,
    candidates_returned INTEGER DEFAULT 0,
    unique_new_sites INTEGER DEFAULT 0,      -- sites this technique found first
    sites_passing_triage INTEGER DEFAULT 0,  -- of those, how many cleared the gate
    sites_high_confidence INTEGER DEFAULT 0, -- of those, how many reached the bar
    sites_sent_to_platform INTEGER DEFAULT 0, -- v0.5: cleared the send gate (the harder test)
    duplicate_candidates INTEGER DEFAULT 0,  -- already-known domains returned
    dead_candidates INTEGER DEFAULT 0,       -- unreachable / rejected at triage
    total_seconds REAL DEFAULT 0,
    yield_score REAL DEFAULT 0.5,            -- learned quality, 0..1
    throttle_state TEXT DEFAULT 'normal',    -- normal | reduced | suspended
    throttle_reason TEXT,
    last_updated REAL,
    evidence_note TEXT                       -- how the current score was arrived at
);

-- Discovery campaigns: a resumable, multi-stage investigation started from one
-- seed of any supported kind.
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_key TEXT UNIQUE NOT NULL,
    name TEXT,
    seed_kind TEXT,            -- domain | wallet | template | infrastructure | keyword
    seed_value TEXT,
    status TEXT DEFAULT 'pending',   -- pending|running|paused|completed|failed|stopped
    current_stage TEXT,              -- seed|pivot|candidate|validate|expand|done
    current_wave INTEGER DEFAULT 0,
    config TEXT,                     -- JSON budget snapshot
    stats TEXT,                      -- JSON rolling counters
    stopped_reason TEXT,
    created_at REAL,
    started_at REAL,
    updated_at REAL,
    finished_at REAL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Per-stage record, so a resumed campaign knows exactly what already finished.
CREATE TABLE IF NOT EXISTS campaign_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    wave INTEGER DEFAULT 0,
    stage TEXT NOT NULL,
    status TEXT DEFAULT 'pending',   -- pending|running|complete|skipped|failed
    input_count INTEGER DEFAULT 0,
    output_count INTEGER DEFAULT 0,
    detail TEXT,
    started_at REAL,
    finished_at REAL,
    UNIQUE(campaign_id, wave, stage)
);

-- Work already completed, so resume never repeats it.
CREATE TABLE IF NOT EXISTS campaign_completed_work (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    work_kind TEXT NOT NULL,     -- lead | validation | expansion
    work_key TEXT NOT NULL,
    result_summary TEXT,
    completed_at REAL,
    UNIQUE(campaign_id, work_kind, work_key)
);

CREATE INDEX IF NOT EXISTS idx_campaign_work ON campaign_completed_work(campaign_id, work_kind);

-- Budget ledger: every consumable a campaign spends, enforced from stored
-- state so limits survive a restart.
CREATE TABLE IF NOT EXISTS campaign_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    resource TEXT NOT NULL,      -- api_calls|candidates|leads|seconds|deep_analyses
    limit_value REAL,
    used_value REAL DEFAULT 0,
    UNIQUE(campaign_id, resource)
);

-- Cluster watch: remembers a family's indicator signature so newly-appearing
-- domains matching it can be spotted on later runs.
CREATE TABLE IF NOT EXISTS cluster_watch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER REFERENCES clusters(id),
    cluster_label TEXT,
    signature TEXT,              -- JSON: indicator types/values defining the family
    last_checked REAL,
    new_matches INTEGER DEFAULT 0,
    created_at REAL,
    UNIQUE(cluster_id)
);

-- Domains that appeared after a cluster was formed and match its signature.
CREATE TABLE IF NOT EXISTS cluster_new_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER REFERENCES clusters(id),
    site_id INTEGER REFERENCES sites(id),
    domain TEXT,
    matched_indicator_type TEXT,
    matched_indicator_value TEXT,
    match_explanation TEXT,
    first_seen REAL,
    evidence_class TEXT DEFAULT 'derived',
    UNIQUE(cluster_id, site_id)
);
-- ============================================================
-- v0.5: Main Platform integration
-- ============================================================

-- The offline queue. Everything Site Finder wants the platform to know goes
-- here FIRST and is sent from here, so an event is never lost to a network
-- failure and the send path is identical whether the platform is up or not.
CREATE TABLE IF NOT EXISTS integration_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,       -- idempotency key; duplicates never queue twice
    event_type TEXT NOT NULL,
    correlation_id TEXT,
    investigation_id TEXT,
    site_id INTEGER REFERENCES sites(id),
    payload TEXT NOT NULL,               -- the complete event envelope, as JSON
    status TEXT DEFAULT 'queued',        -- queued, sending, sent, failed, cancelled
    attempts INTEGER DEFAULT 0,
    next_attempt_at REAL DEFAULT 0,      -- backoff gate
    last_error TEXT,
    queued_at REAL,
    sent_at REAL,
    platform_receipt TEXT                -- what the platform said back, as JSON
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON integration_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_site ON integration_outbox(site_id);

-- Connection state, heartbeat history and the last handshake result. One row
-- per platform endpoint, so switching endpoints does not lose the old record.
CREATE TABLE IF NOT EXISTS integration_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    state TEXT DEFAULT 'unconfigured',   -- unconfigured, online, offline, incompatible, error
    platform_schema TEXT,
    compatible INTEGER DEFAULT 0,
    degraded INTEGER DEFAULT 0,
    compatibility_detail TEXT,
    last_heartbeat_at REAL,
    last_success_at REAL,
    last_error TEXT,
    last_error_at REAL,
    consecutive_failures INTEGER DEFAULT 0,
    platform_version TEXT,
    updated_at REAL
);

-- What the platform told us it did with each event. Kept so "was this sent,
-- and what did it become?" is answerable locally without asking the platform.
CREATE TABLE IF NOT EXISTS integration_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    site_id INTEGER REFERENCES sites(id),
    investigation_id TEXT,
    platform_status TEXT,                -- accepted, duplicate, rejected
    investigator_job_id TEXT,            -- set when Site Investigator work was triggered
    detail TEXT,
    received_at REAL,
    UNIQUE(event_id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_site ON integration_receipts(site_id);

-- The platform's handle for a site, once it has one. Lets later events about
-- the same site join the same investigation instead of starting a new one.
CREATE TABLE IF NOT EXISTS site_investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER UNIQUE NOT NULL REFERENCES sites(id),
    investigation_id TEXT,
    correlation_id TEXT,
    first_sent_at REAL,
    last_sent_at REAL,
    events_sent INTEGER DEFAULT 0,
    investigator_job_id TEXT,
    platform_state TEXT
);

-- Per-indicator pivot yield. Separate from technique stats: a technique can be
-- productive in general while one particular indicator value it keeps pivoting
-- on is pure noise, and that is the one worth retiring.
CREATE TABLE IF NOT EXISTS indicator_yield (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indicator_type TEXT NOT NULL,
    indicator_value TEXT NOT NULL,
    leads_executed INTEGER DEFAULT 0,
    candidates_returned INTEGER DEFAULT 0,
    unique_new_sites INTEGER DEFAULT 0,
    sites_passing_triage INTEGER DEFAULT 0,
    sites_sent_to_platform INTEGER DEFAULT 0,
    retired INTEGER DEFAULT 0,
    retired_reason TEXT,
    last_used_at REAL,
    UNIQUE(indicator_type, indicator_value)
);

CREATE INDEX IF NOT EXISTS idx_indicator_yield_retired ON indicator_yield(retired);

-- Which discovery SOURCE (not just which technique) produced candidates that
-- actually mattered. Answers "where is the useful work coming from?".
CREATE TABLE IF NOT EXISTS source_yield (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT UNIQUE NOT NULL,
    candidates INTEGER DEFAULT 0,
    passed_triage INTEGER DEFAULT 0,
    high_priority INTEGER DEFAULT 0,
    sent_to_platform INTEGER DEFAULT 0,
    last_seen_at REAL
);

-- ============================================================
-- v0.6: downstream feedback, path quality, rate limits, history
-- ============================================================

-- Neutral outcome signals returned by the Main Platform after Site
-- Investigator has examined one of our candidates. These are OBSERVATIONS
-- about what the investigator found, never verdicts: "a deposit page existed"
-- is useful for judging whether our discovery was worth someone's time, and
-- says nothing about whether the site is malicious.
CREATE TABLE IF NOT EXISTS downstream_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id TEXT UNIQUE NOT NULL,   -- idempotency key from the platform
    site_id INTEGER REFERENCES sites(id),
    domain TEXT,
    investigation_id TEXT,
    correlation_id TEXT,
    -- neutral signals, all counts of things observed downstream
    deposit_pages_found INTEGER DEFAULT 0,
    wallets_found INTEGER DEFAULT 0,
    infrastructure_evidence INTEGER DEFAULT 0,
    relationships_found INTEGER DEFAULT 0,
    pages_examined INTEGER DEFAULT 0,
    reachable INTEGER,                  -- was the site up when examined
    outcome TEXT,                       -- useful | thin | unreachable | unknown
    detail TEXT,
    received_at REAL,
    -- attribution snapshot: what produced this candidate, captured at feedback
    -- time so later changes to the site cannot rewrite the credit
    source TEXT,
    pivot_types TEXT,                   -- JSON list
    indicator_signature TEXT,           -- JSON list of (type,value) that led here
    campaign_key TEXT,
    evidence_class TEXT DEFAULT 'observed'
);

CREATE INDEX IF NOT EXISTS idx_feedback_site ON downstream_feedback(site_id);
CREATE INDEX IF NOT EXISTS idx_feedback_source ON downstream_feedback(source);

-- Rolled-up usefulness per attribution key (source / pivot / indicator combo /
-- campaign). Separate from technique stats because this measures the DOWNSTREAM
-- verdict, which is the only measure that reflects whether a discovery was
-- actually worth investigating.
CREATE TABLE IF NOT EXISTS feedback_attribution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_kind TEXT NOT NULL,             -- source | pivot | indicator_combo | campaign
    key_value TEXT NOT NULL,
    candidates_examined INTEGER DEFAULT 0,
    useful INTEGER DEFAULT 0,
    thin INTEGER DEFAULT 0,
    unreachable INTEGER DEFAULT 0,
    deposit_pages INTEGER DEFAULT 0,
    wallets INTEGER DEFAULT 0,
    infrastructure INTEGER DEFAULT 0,
    relationships INTEGER DEFAULT 0,
    usefulness_score REAL DEFAULT 0.5,
    budget_multiplier REAL DEFAULT 1.0,
    evidence_note TEXT,
    updated_at REAL,
    UNIQUE(key_kind, key_value)
);

-- How good a discovery path is, as a route rather than as a destination. A
-- short path resting on an identity-bound indicator is a different kind of
-- lead from a long one resting on shared hosting, and the difference should
-- be visible before anyone spends time on it.
CREATE TABLE IF NOT EXISTS path_quality (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path_id INTEGER UNIQUE REFERENCES discovery_paths(id),
    site_id INTEGER REFERENCES sites(id),
    quality_score REAL DEFAULT 0,
    depth_penalty REAL DEFAULT 0,
    indicator_quality REAL DEFAULT 0,
    technique_quality REAL DEFAULT 0,
    breadth_penalty REAL DEFAULT 0,
    feedback_bonus REAL DEFAULT 0,
    explanation TEXT,
    evidence_class TEXT DEFAULT 'derived',
    computed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_path_quality_site ON path_quality(site_id);

-- Cross-campaign candidate identity. One row per canonical domain, so the same
-- candidate surfacing in five campaigns is one candidate with five sightings
-- rather than five candidates.
CREATE TABLE IF NOT EXISTS candidate_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_domain TEXT UNIQUE NOT NULL,
    site_id INTEGER REFERENCES sites(id),
    first_campaign_key TEXT,
    first_seen_at REAL,
    times_rediscovered INTEGER DEFAULT 0,
    distinct_campaigns INTEGER DEFAULT 1,
    distinct_sources TEXT,              -- JSON list
    last_seen_at REAL
);

CREATE TABLE IF NOT EXISTS candidate_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_domain TEXT NOT NULL,
    campaign_key TEXT,
    source TEXT,
    pivot_type TEXT,
    seen_at REAL,
    was_new INTEGER DEFAULT 0,
    UNIQUE(canonical_domain, campaign_key, source, pivot_type)
);

CREATE INDEX IF NOT EXISTS idx_sightings_domain ON candidate_sightings(canonical_domain);

-- External API budgeting. One row per named service, enforcing both a hard
-- call ceiling and a rate limit, and honouring a server-supplied Retry-After.
CREATE TABLE IF NOT EXISTS api_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT UNIQUE NOT NULL,
    calls_per_window INTEGER DEFAULT 60,
    window_seconds REAL DEFAULT 60,
    daily_limit INTEGER DEFAULT 0,      -- 0 = no daily ceiling
    calls_in_window INTEGER DEFAULT 0,
    window_started_at REAL DEFAULT 0,
    calls_today INTEGER DEFAULT 0,
    day_started_at REAL DEFAULT 0,
    backoff_until REAL DEFAULT 0,       -- set from a 429/Retry-After
    consecutive_429 INTEGER DEFAULT 0,
    total_calls INTEGER DEFAULT 0,
    total_refused INTEGER DEFAULT 0,
    last_call_at REAL,
    last_refusal_reason TEXT
);

-- Historical discovery tracking: a dated record of the funnel, so "is this
-- installation getting better or worse?" is answerable rather than guessed.
CREATE TABLE IF NOT EXISTS discovery_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,                  -- YYYY-MM-DD
    discovered INTEGER DEFAULT 0,
    triaged INTEGER DEFAULT 0,
    passed_triage INTEGER DEFAULT 0,
    sent_to_platform INTEGER DEFAULT 0,
    feedback_useful INTEGER DEFAULT 0,
    feedback_thin INTEGER DEFAULT 0,
    campaigns_run INTEGER DEFAULT 0,
    leads_executed INTEGER DEFAULT 0,
    recorded_at REAL,
    UNIQUE(day)
);

-- Jobs claimed from the platform (FIND_RELATED_SITES, RECHECK_TARGET).
-- Persisted so a Site Finder restart resumes or fails them honestly rather
-- than leaving the platform's lease to expire silently.
CREATE TABLE IF NOT EXISTS platform_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,
    job_type TEXT NOT NULL,
    investigation_id TEXT,
    payload TEXT,
    status TEXT DEFAULT 'claimed',
    detail TEXT,
    result TEXT,
    trigger_reason TEXT,
    claimed_at REAL,
    updated_at REAL
);

CREATE INDEX IF NOT EXISTS idx_platform_jobs_status ON platform_jobs(status);

-- The per-technique lead budget a campaign is running under. Stored so a
-- resumed campaign spends the same plan, and so "why did cert_san stop?" has
-- an answer after the fact.
CREATE TABLE IF NOT EXISTS campaign_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER UNIQUE REFERENCES campaigns(id),
    allocation TEXT,
    explanation TEXT,
    decided_at REAL
);

-- Why a discovery branch stopped expanding. Recorded per branch so a
-- finished campaign is readable without reconstructing it from logs.
CREATE TABLE IF NOT EXISTS expansion_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER REFERENCES campaigns(id),
    pivot_type TEXT DEFAULT '',
    reason TEXT NOT NULL,
    explanation TEXT,
    metrics TEXT,
    recorded_at REAL,
    UNIQUE(campaign_id, pivot_type, reason)
);

-- What Site Finder decided about a candidate, and when. Kept so the same weak
-- candidate is not rediscovered and reprocessed forever, and so a decision can
-- be revisited when genuinely new evidence appears — with the original
-- decision preserved rather than overwritten.
CREATE TABLE IF NOT EXISTS candidate_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id),
    canonical_domain TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    evidence_snapshot TEXT,      -- what was known when the decision was made
    novelty_at_decision REAL,
    decided_at REAL,
    superseded_by INTEGER REFERENCES candidate_decisions(id),
    superseded_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidate_decisions_domain
    ON candidate_decisions(canonical_domain);

-- Snapshots of a cluster's membership and indicators over time, so "this
-- family just gained a domain" is answerable rather than inferred.
CREATE TABLE IF NOT EXISTS cluster_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER REFERENCES clusters(id),
    taken_at REAL,
    site_count INTEGER,
    domains TEXT,               -- JSON list
    indicator_signature TEXT,   -- JSON list of [type, value]
    UNIQUE(cluster_id, taken_at)
);

CREATE INDEX IF NOT EXISTS idx_cluster_snapshots_cluster
    ON cluster_snapshots(cluster_id, taken_at);

-- Live controls a running campaign honours at each wave boundary.
CREATE TABLE IF NOT EXISTS campaign_controls (
    campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id),
    paused INTEGER DEFAULT 0,
    stop_after_current INTEGER DEFAULT 0,
    budget_changes TEXT DEFAULT '{}',
    updated_at REAL
);

CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT UNIQUE NOT NULL,
    started_at REAL,
    finished_at REAL,
    sites_seen INTEGER DEFAULT 0,
    changes_detected INTEGER DEFAULT 0,
    notes TEXT
);
"""



def domain_of(url: str) -> str:
    netloc = urlparse(url if "://" in url else f"http://{url}").netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


def _hash(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8", "ignore")).hexdigest()


_wal_initialised: set[str] = set()
_connection_scope: ContextVar[dict | None] = ContextVar("site_finder_connection_scope", default=None)


@contextmanager
def reuse_connections():
    """Reuse one connection in this worker/thread without delaying commits.

    Each get_conn block retains its existing commit/rollback boundary. A nested
    block gets a separate connection, so nested calls cannot commit an outer
    operation early. The scope is local to the current execution context.
    """
    if _connection_scope.get() is not None:
        yield
        return
    scope = {"path": str(DB_PATH), "owner": threading.get_ident(), "conn": None, "busy": False,
             "metrics": {"connections": 0, "statements": 0, "writes": 0, "commits": 0,
                         "rollbacks": 0, "connect_seconds": 0.0, "sql_seconds": 0.0,
                         "commit_seconds": 0.0, "external_seconds": 0.0}}
    token = _connection_scope.set(scope)
    try:
        yield
    finally:
        if scope["conn"] is not None:
            scope["conn"].close()
        _connection_scope.reset(token)


def with_reused_connections(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with reuse_connections():
            return fn(*args, **kwargs)
    return wrapped


def round_metrics():
    scope = _connection_scope.get()
    return dict(scope["metrics"]) if scope else {}


def add_external_wait(seconds):
    scope = _connection_scope.get()
    if scope:
        scope["metrics"]["external_seconds"] += max(0.0, float(seconds))


class _TrackedConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.set_trace_callback(self._trace)

    @staticmethod
    def _metrics():
        scope = _connection_scope.get()
        return scope["metrics"] if scope else None

    def _trace(self, statement):
        metrics = self._metrics()
        if metrics:
            metrics["statements"] += 1
            metrics["writes"] += statement.lstrip().split(None, 1)[0].upper() in (
                "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP") if statement.strip() else False

    def execute(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            return super().execute(*args, **kwargs)
        finally:
            metrics = self._metrics()
            if metrics:
                metrics["sql_seconds"] += time.perf_counter() - started

    def executemany(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            return super().executemany(*args, **kwargs)
        finally:
            metrics = self._metrics()
            if metrics:
                metrics["sql_seconds"] += time.perf_counter() - started

    def executescript(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            return super().executescript(*args, **kwargs)
        finally:
            metrics = self._metrics()
            if metrics:
                metrics["sql_seconds"] += time.perf_counter() - started

    def commit(self):
        started = time.perf_counter()
        try:
            return super().commit()
        finally:
            metrics = self._metrics()
            if metrics:
                metrics["commits"] += 1
                metrics["commit_seconds"] += time.perf_counter() - started

    def rollback(self):
        metrics = self._metrics()
        if metrics:
            metrics["rollbacks"] += 1
        return super().rollback()


def _new_connection():
    scope = _connection_scope.get()
    instrument = bool(scope and scope["path"] == str(DB_PATH) and scope["owner"] == threading.get_ident())
    started = time.perf_counter()
    conn = sqlite3.connect(DB_PATH, timeout=30, factory=_TrackedConnection if instrument else sqlite3.Connection)
    if instrument:
        scope["metrics"]["connections"] += 1
        scope["metrics"]["connect_seconds"] += time.perf_counter() - started
    path = str(DB_PATH)
    if path not in _wal_initialised:
        conn.execute("PRAGMA journal_mode=WAL;")
        _wal_initialised.add(path)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def get_conn():
    scope = _connection_scope.get()
    reusable = bool(scope and scope["path"] == str(DB_PATH) and
                    scope["owner"] == threading.get_ident() and not scope["busy"])
    if reusable:
        if scope["conn"] is None:
            scope["conn"] = _new_connection()
        conn = scope["conn"]
        scope["busy"] = True
    else:
        conn = _new_connection()
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        if reusable:
            scope["busy"] = False
        else:
            conn.close()


def init_db() -> dict:
    """
    Creates anything missing, then migrates anything that exists but is out of
    date. Both halves are needed: CREATE TABLE IF NOT EXISTS builds a fresh
    database correctly but silently skips an existing table, so a column added
    in a later version would never appear without the migration pass.
    """
    from app.migrations import run_migrations
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        result = run_migrations(conn)
    if result["changed_schema"] or result["failed"]:
        logger.info("Schema: %s", result["note"])
    return result


def schema_status() -> dict:
    from app.migrations import schema_report
    with get_conn() as conn:
        return schema_report(conn)


# ---------- Sites ----------

def domain_known(domain: str) -> bool:
    """Cheap existence check used by discoverers to decide duplicate vs new before inserting."""
    dhash = _hash(domain)
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM sites WHERE domain_hash=?", (dhash,)).fetchone()
        return row is not None


def add_site(url: str, source: str, discovery_confidence: float = 0.5,
             discovery_reason: str = "", discovery_category: str = "") -> int | None:
    """Insert a candidate site if its domain isn't already known. Returns new id or None if duplicate."""
    domain = domain_of(url)
    if not domain:
        return None
    dhash = _hash(domain)
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO sites
               (url, domain, domain_hash, source, added_at,
                discovery_confidence, discovery_reason, discovery_category)
               VALUES (?,?,?,?,?,?,?,?)""",
            (url, domain, dhash, source, time.time(),
             discovery_confidence, discovery_reason, discovery_category),
        )
        if cur.rowcount == 0:
            return None
        return cur.lastrowid


def update_site_score(site_id: int, score: float, reasons: str):
    with get_conn() as conn:
        conn.execute("UPDATE sites SET score=?, score_reasons=? WHERE id=?", (score, reasons, site_id))


def set_site_status(site_id: int, status: str):
    with get_conn() as conn:
        conn.execute("UPDATE sites SET status=? WHERE id=?", (status, site_id))


def mark_scanned(site_id: int):
    with get_conn() as conn:
        conn.execute("UPDATE sites SET status='scanned', scanned_at=? WHERE id=?", (time.time(), site_id))


def next_sites_to_scan(limit: int = 10, min_score: float | None = None):
    """
    Returns the highest-scored not-yet-investigated sites, optionally restricted
    to those at or above `min_score` — used to implement "only auto-investigate
    high-risk sites" without touching the scoring/ranking logic itself.
    """
    with get_conn() as conn:
        if min_score is not None:
            rows = conn.execute(
                "SELECT * FROM sites WHERE status IN ('new','queued') AND score >= ? "
                "ORDER BY score DESC, added_at ASC LIMIT ?",
                (min_score, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM sites WHERE status IN ('new','queued') ORDER BY score DESC, added_at ASC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]


def get_site(site_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone()
        return dict(row) if row else None


def list_sites(status: str | None = None, limit: int = 200):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM sites WHERE status=? ORDER BY score DESC LIMIT ?", (status, limit)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM sites ORDER BY score DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Pages ----------

def add_page(site_id: int, url: str, title: str, page_type: str,
             screenshot_path: str, html_snapshot_path: str, claude_reasoning: str = "") -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO pages (site_id, url, title, page_type, screenshot_path,
               html_snapshot_path, visited_at, claude_reasoning) VALUES (?,?,?,?,?,?,?,?)""",
            (site_id, url, title, page_type, screenshot_path, html_snapshot_path,
             time.time(), claude_reasoning),
        )
        return cur.lastrowid


def pages_for_site(site_id: int):
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM pages WHERE site_id=? ORDER BY visited_at", (site_id,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Wallets ----------

def add_wallet_sighting(address: str, network: str, site_id: int, page_id: int | None,
                         context_snippet: str, confidence: float = 0.5) -> tuple[int, int | None]:
    """
    Returns (wallet_id, sighting_id). sighting_id is None only in the rare case
    this exact wallet+page sighting already existed (a harmless duplicate call) —
    the caller should treat that as "nothing new to attach evidence to".
    """
    ahash = _hash(network, address.lower())
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM wallets WHERE address_hash=?", (ahash,)).fetchone()
        if row:
            wallet_id = row["id"]
        else:
            cur = conn.execute(
                """INSERT INTO wallets (address, network, address_hash, first_seen_site_id,
                   confidence, added_at) VALUES (?,?,?,?,?,?)""",
                (address, network, ahash, site_id, confidence, time.time()),
            )
            wallet_id = cur.lastrowid
        sighting_id = None
        try:
            cur = conn.execute(
                """INSERT INTO wallet_sightings (wallet_id, site_id, page_id, context_snippet, seen_at)
                   VALUES (?,?,?,?,?)""",
                (wallet_id, site_id, page_id, context_snippet, time.time()),
            )
            sighting_id = cur.lastrowid
        except sqlite3.IntegrityError:
            pass  # already recorded this exact wallet+page sighting
        return wallet_id, sighting_id


def add_wallet_evidence(wallet_sighting_id: int, screenshot_path: str, surrounding_text: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO wallet_evidence (wallet_sighting_id, screenshot_path, surrounding_text, created_at)
               VALUES (?,?,?,?)""",
            (wallet_sighting_id, screenshot_path, surrounding_text, time.time()),
        )
        return cur.lastrowid


def wallet_evidence_for_site(site_id: int):
    """All wallet-specific evidence bundles for a site, joined with wallet + sighting info."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT we.*, ws.context_snippet, ws.page_id, w.address, w.network
               FROM wallet_evidence we
               JOIN wallet_sightings ws ON ws.id = we.wallet_sighting_id
               JOIN wallets w ON w.id = ws.wallet_id
               WHERE ws.site_id = ?
               ORDER BY we.created_at""",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def wallets_for_site(site_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT w.* FROM wallets w
               JOIN wallet_sightings s ON s.wallet_id = w.id
               WHERE s.site_id=?""",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def wallet_seen_elsewhere(address: str, network: str, exclude_site_id: int):
    ahash = _hash(network, address.lower())
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT s.id, s.url, s.domain FROM sites s
               JOIN wallet_sightings ws ON ws.site_id = s.id
               JOIN wallets w ON w.id = ws.wallet_id
               WHERE w.address_hash=? AND s.id != ?""",
            (ahash, exclude_site_id),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Findings ----------

def create_finding(site_id: int, summary: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO findings (site_id, summary, created_at) VALUES (?,?,?)",
            (site_id, summary, time.time()),
        )
        return cur.lastrowid


def list_findings(review_status: str | None = None):
    with get_conn() as conn:
        if review_status:
            rows = conn.execute(
                """SELECT f.*, s.url as site_url, s.domain, s.score FROM findings f
                   JOIN sites s ON s.id = f.site_id
                   WHERE f.review_status=? ORDER BY f.created_at DESC""",
                (review_status,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT f.*, s.url as site_url, s.domain, s.score FROM findings f
                   JOIN sites s ON s.id = f.site_id ORDER BY f.created_at DESC"""
            ).fetchall()
        return [dict(r) for r in rows]


def get_finding(finding_id: int):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT f.*, s.url as site_url, s.domain FROM findings f
               JOIN sites s ON s.id = f.site_id WHERE f.id=?""",
            (finding_id,),
        ).fetchone()
        return dict(row) if row else None


def set_finding_review(finding_id: int, status: str, notes: str = ""):
    with get_conn() as conn:
        conn.execute(
            "UPDATE findings SET review_status=?, reviewed_at=?, reviewer_notes=? WHERE id=?",
            (status, time.time(), notes, finding_id),
        )


def mark_finding_submitted(finding_id: int):
    with get_conn() as conn:
        conn.execute(
            "UPDATE findings SET submitted_to_form=1, submitted_at=? WHERE id=?",
            (time.time(), finding_id),
        )


# ---------- Signup attempts ----------

def log_signup_attempt(site_id: int, status: str, detail: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO signup_attempts (site_id, status, detail, attempted_at) VALUES (?,?,?,?)",
            (site_id, status, detail, time.time()),
        )


# ---------- Investigations (per-session live status for the UI) ----------

def create_investigation(site_id: int) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO investigations (site_id, status, started_at) VALUES (?, 'starting', ?)",
            (site_id, time.time()),
        )
        return cur.lastrowid


def update_investigation(investigation_id: int, **fields):
    """Generic partial update; only whitelisted columns are accepted to avoid SQL injection
    via a stray kwarg, since this is called from several places with varying field sets."""
    allowed = {"status", "stop_reason", "pages_visited", "wallets_found", "current_url", "finished_at"}
    sets = []
    params = []
    for key, value in fields.items():
        if key not in allowed:
            raise ValueError(f"Cannot update investigation field: {key}")
        sets.append(f"{key}=?")
        params.append(value)
    if not sets:
        return
    params.append(investigation_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE investigations SET {', '.join(sets)} WHERE id=?", params)


def finish_investigation(investigation_id: int, status: str, stop_reason: str | None = None):
    update_investigation(investigation_id, status=status, stop_reason=stop_reason, finished_at=time.time())


def get_investigation(investigation_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM investigations WHERE id=?", (investigation_id,)).fetchone()
        return dict(row) if row else None


def latest_investigation_for_site(site_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM investigations WHERE site_id=? ORDER BY started_at DESC LIMIT 1",
            (site_id,),
        ).fetchone()
        return dict(row) if row else None


def list_active_investigations():
    """Investigations currently in progress, for the live UI panel."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT inv.*, s.url as site_url, s.domain, s.score
               FROM investigations inv
               JOIN sites s ON s.id = inv.site_id
               WHERE inv.status IN ('starting', 'browsing')
               ORDER BY inv.started_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def list_recent_investigations(limit: int = 20):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT inv.*, s.url as site_url, s.domain, s.score
               FROM investigations inv
               JOIN sites s ON s.id = inv.site_id
               ORDER BY inv.started_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Decision log (navigation reasoning, for reviewer transparency) ----------

def log_decision(investigation_id: int, site_id: int, decision_type: str, detail: str, url: str = ""):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO decision_log (investigation_id, site_id, decision_type, detail, url, made_at)
               VALUES (?,?,?,?,?,?)""",
            (investigation_id, site_id, decision_type, detail, url, time.time()),
        )


def decisions_for_investigation(investigation_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM decision_log WHERE investigation_id=? ORDER BY made_at",
            (investigation_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def decisions_for_site(site_id: int, limit: int = 200):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM decision_log WHERE site_id=? ORDER BY made_at DESC LIMIT ?",
            (site_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Stats / dashboard aggregates ----------

def get_stats() -> dict:
    """One-shot aggregate query for the dashboard's summary cards."""
    with get_conn() as conn:
        total_sites = conn.execute("SELECT COUNT(*) c FROM sites").fetchone()["c"]
        by_status = {
            row["status"]: row["c"]
            for row in conn.execute("SELECT status, COUNT(*) c FROM sites GROUP BY status").fetchall()
        }
        high_risk = conn.execute(
            "SELECT COUNT(*) c FROM sites WHERE score >= 5"
        ).fetchone()["c"]
        total_wallets = conn.execute("SELECT COUNT(*) c FROM wallets").fetchone()["c"]
        total_pages = conn.execute("SELECT COUNT(*) c FROM pages").fetchone()["c"]
        pending_findings = conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE review_status='pending'"
        ).fetchone()["c"]
        approved_findings = conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE review_status='approved'"
        ).fetchone()["c"]
        submitted_findings = conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE submitted_to_form=1"
        ).fetchone()["c"]

        return {
            "total_sites": total_sites,
            "by_status": by_status,
            "high_risk_sites": high_risk,
            "total_wallets": total_wallets,
            "total_pages": total_pages,
            "pending_findings": pending_findings,
            "approved_findings": approved_findings,
            "submitted_findings": submitted_findings,
        }


def list_high_risk_sites(threshold: float = 5.0, limit: int = 50):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sites WHERE score >= ? ORDER BY score DESC LIMIT ?",
            (threshold, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def list_all_wallets(limit: int = 500):
    """All wallets with the count of distinct sites they've been seen on, for the wallets panel."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT w.*, COUNT(DISTINCT ws.site_id) as site_count
               FROM wallets w
               LEFT JOIN wallet_sightings ws ON ws.wallet_id = w.id
               GROUP BY w.id
               ORDER BY w.added_at DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def search_sites(query: str = "", status: str | None = None, min_score: float | None = None,
                  sort: str = "score_desc", limit: int = 500):
    """Flexible search/filter/sort for the Sites panel."""
    clauses = []
    params: list = []

    if query:
        clauses.append("(s.url LIKE ? OR s.domain LIKE ?)")
        like = f"%{query}%"
        params.extend([like, like])
    if status:
        clauses.append("s.status = ?")
        params.append(status)
    if min_score is not None:
        clauses.append("s.score >= ?")
        params.append(min_score)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    sort_map = {
        "score_desc": "s.score DESC",
        "score_asc": "s.score ASC",
        "newest": "s.added_at DESC",
        "oldest": "s.added_at ASC",
        "url": "s.url ASC",
    }
    order = sort_map.get(sort, "s.score DESC")

    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT s.*, COUNT(p.id) as page_count
                FROM sites s
                LEFT JOIN pages p ON p.site_id = s.id
                {where}
                GROUP BY s.id
                ORDER BY {order} LIMIT ?""",
            (*params, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- App settings (persisted key/value store) ----------

def get_setting(key: str, default=None):
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )


def get_all_settings() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}


# ---------- Discovery (audit trail, run stats) ----------

def log_discovery_event(url: str, source: str, confidence: float = 0.5, reason: str = "",
                         category: str = "", pivot_from_site_id: int | None = None,
                         resulted_in_site_id: int | None = None, was_duplicate: bool = False) -> int:
    """
    Records that a discoverer surfaced this URL, regardless of whether it ended
    up as a new sites row — this is the permanent "exactly why and where it was
    found" audit trail requested, independent of sites-table dedup.
    """
    domain = domain_of(url)
    dhash = _hash(domain) if domain else ""
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO discovery_events
               (url, domain, domain_hash, source, category, confidence, reason,
                pivot_from_site_id, resulted_in_site_id, was_duplicate, found_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (url, domain, dhash, source, category, confidence, reason,
             pivot_from_site_id, resulted_in_site_id, int(was_duplicate), time.time()),
        )
        return cur.lastrowid


def discovery_events_for_site(site_id: int):
    """All discovery events that ultimately resulted in this site, newest first —
    usually one, but a site can be independently re-suggested by multiple sources."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM discovery_events WHERE resulted_in_site_id=? ORDER BY found_at DESC",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def recent_discovery_events(limit: int = 100, source: str | None = None):
    with get_conn() as conn:
        if source:
            rows = conn.execute(
                "SELECT * FROM discovery_events WHERE source=? ORDER BY found_at DESC LIMIT ?",
                (source, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM discovery_events ORDER BY found_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


def discovery_domain_already_seen(domain: str, source: str | None = None) -> bool:
    """
    Whether this exact domain has already been surfaced (by any source, or a
    specific one) before — lets a discoverer skip re-emitting the same
    candidate on every run without needing its own separate dedup state.
    """
    dhash = _hash(domain)
    with get_conn() as conn:
        if source:
            row = conn.execute(
                "SELECT id FROM discovery_events WHERE domain_hash=? AND source=? LIMIT 1",
                (dhash, source),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM discovery_events WHERE domain_hash=? LIMIT 1", (dhash,)
            ).fetchone()
        return row is not None


def create_discovery_run(sources_run: list) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO discovery_runs (started_at, sources_run) VALUES (?, ?)",
            (time.time(), ",".join(sources_run)),
        )
        return cur.lastrowid


def finish_discovery_run(run_id: int, total_candidates: int, total_new_sites: int,
                          total_duplicates: int, errors: str = ""):
    with get_conn() as conn:
        conn.execute(
            """UPDATE discovery_runs SET finished_at=?, total_candidates=?, total_new_sites=?,
               total_duplicates=?, errors=? WHERE id=?""",
            (time.time(), total_candidates, total_new_sites, total_duplicates, errors, run_id),
        )


def log_discovery_run_source(run_id: int, source: str, candidates_found: int, new_sites: int,
                              duplicates: int, error: str = "", duration_seconds: float = 0.0):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO discovery_run_sources
               (run_id, source, candidates_found, new_sites, duplicates, error, duration_seconds)
               VALUES (?,?,?,?,?,?,?)""",
            (run_id, source, candidates_found, new_sites, duplicates, error, duration_seconds),
        )


def get_discovery_run(run_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM discovery_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        run = dict(row)
        sources = conn.execute(
            "SELECT * FROM discovery_run_sources WHERE run_id=? ORDER BY id", (run_id,)
        ).fetchall()
        run["sources"] = [dict(s) for s in sources]
        return run


def list_recent_discovery_runs(limit: int = 20):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_discovery_stats() -> dict:
    """Aggregate discovery stats for the dashboard's Discovery view."""
    with get_conn() as conn:
        total_events = conn.execute("SELECT COUNT(*) c FROM discovery_events").fetchone()["c"]
        by_source = {
            row["source"]: row["c"]
            for row in conn.execute(
                "SELECT source, COUNT(*) c FROM discovery_events GROUP BY source"
            ).fetchall()
        }
        by_category = {
            row["discovery_category"]: row["c"]
            for row in conn.execute(
                "SELECT discovery_category, COUNT(*) c FROM sites "
                "WHERE discovery_category IS NOT NULL AND discovery_category != '' "
                "GROUP BY discovery_category"
            ).fetchall()
        }
        sites_from_discovery = conn.execute(
            "SELECT COUNT(*) c FROM sites WHERE source NOT IN ('manual_ui','manual_import')"
        ).fetchone()["c"]
        pivoted_sites = conn.execute(
            "SELECT COUNT(*) c FROM discovery_events WHERE pivot_from_site_id IS NOT NULL "
            "AND resulted_in_site_id IS NOT NULL"
        ).fetchone()["c"]
        last_run = conn.execute(
            "SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()

        return {
            "total_discovery_events": total_events,
            "by_source": by_source,
            "by_category": by_category,
            "sites_from_discovery": sites_from_discovery,
            "pivoted_sites": pivoted_sites,
            "last_run": dict(last_run) if last_run else None,
        }


# ============================================================
# Quality-over-quantity pipeline: triage, deep profiles,
# wallet validation, form submissions
# ============================================================

import json as _json


def _dumps(value) -> str:
    """JSON-encode a value for storage, tolerating None."""
    return _json.dumps(value if value is not None else [])


def _loads(raw, default=None):
    """Decode a stored JSON column, never raising on bad/missing data."""
    if not raw:
        return default if default is not None else []
    try:
        return _json.loads(raw)
    except (ValueError, TypeError):
        return default if default is not None else []


# ---------- Triage ----------

def record_triage(site_id: int, passed: bool, triage_score: float, indicator_count: int,
                  indicators: list, reject_reason: str = "", http_status=None) -> int:
    """Upsert a triage result (a site can be re-triaged; we keep one row per site)."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO triage_results
               (site_id, passed, triage_score, indicator_count, indicators,
                reject_reason, http_status, triaged_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(site_id) DO UPDATE SET
                 passed=excluded.passed,
                 triage_score=excluded.triage_score,
                 indicator_count=excluded.indicator_count,
                 indicators=excluded.indicators,
                 reject_reason=excluded.reject_reason,
                 http_status=excluded.http_status,
                 triaged_at=excluded.triaged_at""",
            (site_id, int(passed), triage_score, indicator_count, _dumps(indicators),
             reject_reason, http_status, time.time()),
        )
        row = conn.execute("SELECT id FROM triage_results WHERE site_id=?", (site_id,)).fetchone()
        return row["id"] if row else None


def get_triage(site_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM triage_results WHERE site_id=?", (site_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["indicators"] = _loads(result.get("indicators"))
        return result


def sites_awaiting_triage(limit: int = 200):
    """Sites that have never been triaged yet, highest discovery confidence first."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT s.* FROM sites s
               LEFT JOIN triage_results t ON t.site_id = s.id
               WHERE t.id IS NULL
               ORDER BY s.discovery_confidence DESC, s.added_at ASC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def sites_passing_triage_awaiting_deep(limit: int = 25):
    """
    Sites that CLEARED triage but have no completed deep profile yet — the
    queue the deep-analysis stage pulls from, strongest candidates first.
    """
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT s.*, t.triage_score, t.indicator_count
               FROM sites s
               JOIN triage_results t ON t.site_id = s.id
               LEFT JOIN deep_profiles d ON d.site_id = s.id
               WHERE t.passed = 1
                 AND (d.id IS NULL OR d.status IN ('pending','failed'))
               -- s.score carries a campaign's promotion priority when one was
               -- set (with its reasoning stored in score_reasons); triage
               -- strength decides the order for everything else.
               ORDER BY t.indicator_count DESC, s.score DESC, t.triage_score DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def triage_stats() -> dict:
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM triage_results").fetchone()["c"]
        passed = conn.execute("SELECT COUNT(*) c FROM triage_results WHERE passed=1").fetchone()["c"]
        untriaged = conn.execute(
            """SELECT COUNT(*) c FROM sites s
               LEFT JOIN triage_results t ON t.site_id = s.id WHERE t.id IS NULL"""
        ).fetchone()["c"]
        return {
            "total_triaged": total,
            "passed_triage": passed,
            "rejected_at_triage": total - passed,
            "awaiting_triage": untriaged,
        }


# ---------- Deep profiles ----------

DEEP_PROFILE_JSON_FIELDS = (
    "flag_reasons", "indicator_categories", "keywords_found", "deposit_pages",
    "registration_info", "related_domains", "shared_infrastructure",
    "template_matches", "contact_info", "social_links", "threat_intel", "screenshots",
)


def start_deep_profile(site_id: int) -> int:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO deep_profiles (site_id, status, analyzed_at)
               VALUES (?, 'running', ?)
               ON CONFLICT(site_id) DO UPDATE SET status='running', analyzed_at=excluded.analyzed_at""",
            (site_id, time.time()),
        )
        row = conn.execute("SELECT id FROM deep_profiles WHERE site_id=?", (site_id,)).fetchone()
        return row["id"] if row else None


def save_deep_profile(site_id: int, profile: dict):
    """
    Persists a completed deep-analysis profile. JSON-typed fields are encoded
    here so callers can pass plain Python lists/dicts.
    """
    payload = dict(profile)
    for field in DEEP_PROFILE_JSON_FIELDS:
        if field in payload:
            payload[field] = _dumps(payload[field])

    columns = [
        "status", "domain", "full_url", "site_title", "site_description",
        "risk_score", "confidence_score", "flag_reasons", "indicator_categories",
        "important_text", "keywords_found", "deposit_pages", "domain_age_days",
        "registration_info", "related_domains", "shared_infrastructure",
        "template_matches", "contact_info", "social_links", "threat_intel",
        "discovery_source", "screenshots", "evidence_summary",
    ]
    values = [payload.get(c) for c in columns]
    assignments = ", ".join(f"{c}=?" for c in columns)

    with get_conn() as conn:
        conn.execute(
            f"""INSERT INTO deep_profiles (site_id, {', '.join(columns)}, analyzed_at)
                VALUES (?, {', '.join('?' for _ in columns)}, ?)
                ON CONFLICT(site_id) DO UPDATE SET {assignments}, analyzed_at=excluded.analyzed_at""",
            (site_id, *values, time.time(), *values),
        )


def fail_deep_profile(site_id: int, reason: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO deep_profiles (site_id, status, evidence_summary, analyzed_at)
               VALUES (?, 'failed', ?, ?)
               ON CONFLICT(site_id) DO UPDATE SET
                 status='failed', evidence_summary=excluded.evidence_summary,
                 analyzed_at=excluded.analyzed_at""",
            (site_id, reason, time.time()),
        )


def _decode_profile(row) -> dict:
    profile = dict(row)
    for field in DEEP_PROFILE_JSON_FIELDS:
        profile[field] = _loads(profile.get(field))
    return profile


def get_deep_profile(site_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM deep_profiles WHERE site_id=?", (site_id,)).fetchone()
        return _decode_profile(row) if row else None


def list_deep_profiles(min_confidence: float = 0.0, limit: int = 100, status: str = "complete"):
    """The high-confidence results view: completed profiles, strongest first."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT d.*, s.url as site_url, s.domain as site_domain, s.status as site_status
               FROM deep_profiles d
               JOIN sites s ON s.id = d.site_id
               WHERE d.status = ? AND d.confidence_score >= ?
               ORDER BY d.confidence_score DESC, d.risk_score DESC
               LIMIT ?""",
            (status, min_confidence, limit),
        ).fetchall()
        return [_decode_profile(r) for r in rows]


def deep_profile_stats() -> dict:
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM deep_profiles WHERE status='complete'").fetchone()["c"]
        high_conf = conn.execute(
            "SELECT COUNT(*) c FROM deep_profiles WHERE status='complete' AND confidence_score >= 0.7"
        ).fetchone()["c"]
        running = conn.execute("SELECT COUNT(*) c FROM deep_profiles WHERE status='running'").fetchone()["c"]
        failed = conn.execute("SELECT COUNT(*) c FROM deep_profiles WHERE status='failed'").fetchone()["c"]
        return {
            "total_profiles": total,
            "high_confidence_profiles": high_conf,
            "running": running,
            "failed": failed,
        }


# ---------- Wallet validation ----------

def save_wallet_validation(wallet_id: int, validation: dict):
    columns = [
        "format_valid", "validation_detail", "network_confirmed", "activity_checked",
        "activity_available", "balance", "tx_count", "first_seen_onchain",
        "last_seen_onchain", "total_received", "activity_source", "activity_error",
    ]
    values = [validation.get(c) for c in columns]
    assignments = ", ".join(f"{c}=?" for c in columns)
    with get_conn() as conn:
        conn.execute(
            f"""INSERT INTO wallet_validations (wallet_id, {', '.join(columns)}, validated_at)
                VALUES (?, {', '.join('?' for _ in columns)}, ?)
                ON CONFLICT(wallet_id) DO UPDATE SET {assignments}, validated_at=excluded.validated_at""",
            (wallet_id, *values, time.time(), *values),
        )


def get_wallet_validation(wallet_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM wallet_validations WHERE wallet_id=?", (wallet_id,)).fetchone()
        return dict(row) if row else None


def wallets_with_validation_for_site(site_id: int):
    """Wallets for a site, each joined with its validation record (if any)."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT w.*, v.format_valid, v.validation_detail, v.network_confirmed,
                      v.activity_checked, v.activity_available, v.balance, v.tx_count,
                      v.total_received, v.first_seen_onchain, v.last_seen_onchain,
                      v.activity_source, v.activity_error
               FROM wallets w
               JOIN wallet_sightings ws ON ws.wallet_id = w.id
               LEFT JOIN wallet_validations v ON v.wallet_id = w.id
               WHERE ws.site_id = ?""",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Form submissions ----------

def create_form_submission(site_id: int, finding_id, mode: str, status: str,
                            validation_passed: bool, validation_detail: list,
                            wallet_address: str = "", wallet_network: str = "",
                            prefill_screenshot: str = "") -> int:
    now = time.time()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO form_submissions
               (site_id, finding_id, mode, status, validation_passed, validation_detail,
                submitted_wallet_address, submitted_wallet_network, prefill_screenshot,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (site_id, finding_id, mode, status, int(validation_passed),
             _dumps(validation_detail), wallet_address, wallet_network,
             prefill_screenshot, now, now),
        )
        return cur.lastrowid


def update_form_submission(submission_id: int, **fields):
    allowed = {"status", "validation_passed", "validation_detail", "prefill_screenshot",
               "confirmed_by_user_at", "submitted_wallet_address", "submitted_wallet_network"}
    sets, params = [], []
    for key, value in fields.items():
        if key not in allowed:
            raise ValueError(f"Cannot update form_submission field: {key}")
        if key == "validation_detail":
            value = _dumps(value)
        if key == "validation_passed":
            value = int(value)
        sets.append(f"{key}=?")
        params.append(value)
    if not sets:
        return
    sets.append("updated_at=?")
    params.extend([time.time(), submission_id])
    with get_conn() as conn:
        conn.execute(f"UPDATE form_submissions SET {', '.join(sets)} WHERE id=?", params)


def get_form_submission(submission_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM form_submissions WHERE id=?", (submission_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["validation_detail"] = _loads(result.get("validation_detail"))
        return result


def list_form_submissions(limit: int = 50, status: str = None):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                """SELECT f.*, s.url as site_url, s.domain as site_domain
                   FROM form_submissions f JOIN sites s ON s.id = f.site_id
                   WHERE f.status=? ORDER BY f.created_at DESC LIMIT ?""",
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT f.*, s.url as site_url, s.domain as site_domain
                   FROM form_submissions f JOIN sites s ON s.id = f.site_id
                   ORDER BY f.created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        results = []
        for r in rows:
            item = dict(r)
            item["validation_detail"] = _loads(item.get("validation_detail"))
            results.append(item)
        return results


def site_already_submitted(site_id: int) -> bool:
    """Duplicate guard: has this site already been submitted to the form?"""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM form_submissions WHERE site_id=? AND status='submitted' LIMIT 1",
            (site_id,),
        ).fetchone()
        return row is not None


def wallet_already_submitted(address: str, network: str) -> bool:
    """Duplicate guard: has this exact wallet already been submitted?"""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT id FROM form_submissions
               WHERE lower(submitted_wallet_address)=lower(?) AND submitted_wallet_network=?
                 AND status='submitted' LIMIT 1""",
            (address, network),
        ).fetchone()
        return row is not None


# ============================================================
# v2: Indicator graph, relationships, clusters, history, timeline
# ============================================================
# The observed/derived split is enforced structurally here: functions that
# record what we SAW live under "Observations", functions that record what
# software CONCLUDED live under "Derived correlations". Nothing crosses over.

# How strongly each indicator type implies "same operator" when shared.
# Wallets are near-conclusive (money has to go somewhere the operator controls);
# a shared IP on budget shared hosting is weak on its own.
INDICATOR_STRENGTH = {
    "wallet": 0.95,
    "analytics_id": 0.90,     # a Google Analytics / GTM ID is account-bound
    "telegram": 0.85,
    "whatsapp": 0.85,
    "email": 0.80,
    "phone": 0.75,
    "cert_sha256": 0.75,
    "template_hash": 0.70,
    "favicon_hash": 0.60,
    "nameserver": 0.45,
    "ip": 0.40,               # shared hosting makes this weak alone
    "asn": 0.15,
    "registrar": 0.10,
}

# Indicator types strong enough that sharing one is meaningful evidence by itself.
STRONG_INDICATOR_TYPES = {
    "wallet", "analytics_id", "telegram", "whatsapp", "email", "phone",
    "cert_sha256", "template_hash",
}

CASE_SENSITIVE_INDICATORS = {"wallet", "template_hash", "cert_sha256", "favicon_hash"}


def normalize_indicator_value(indicator_type: str, value: str) -> str:
    """Canonical form so the same artifact always maps to one indicator row."""
    value = (value or "").strip()
    if indicator_type not in CASE_SENSITIVE_INDICATORS:
        value = value.lower()
    if indicator_type == "telegram":
        value = value.lstrip("@").replace("https://t.me/", "").replace("t.me/", "")
    if indicator_type in ("phone", "whatsapp"):
        value = "".join(ch for ch in value if ch.isdigit())
    return value


# ---------- Observations (facts we saw) ----------

def upsert_indicator(indicator_type: str, value: str, notes: str = "") -> int:
    """Creates or touches an indicator. Pure bookkeeping — no inference."""
    value = normalize_indicator_value(indicator_type, value)
    if not value:
        return None
    vhash = _hash(indicator_type, value)
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO indicators (indicator_type, value, value_hash, first_seen, last_seen, notes)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(value_hash) DO UPDATE SET last_seen=excluded.last_seen""",
            (indicator_type, value, vhash, now, now, notes),
        )
        row = conn.execute("SELECT id FROM indicators WHERE value_hash=?", (vhash,)).fetchone()
        return row["id"] if row else None


def record_observation(site_id: int, indicator_type: str, value: str, source_url: str = "",
                        source_method: str = "", context_snippet: str = "",
                        screenshot_path: str = "", scan_id: str = "") -> dict:
    """
    Records an OBSERVED FACT: this site exposed this indicator here.
    Returns {"indicator_id", "is_new_for_site", "changed"} so callers can
    drive history/timeline entries without re-querying.
    """
    indicator_id = upsert_indicator(indicator_type, value)
    if indicator_id is None:
        return {"indicator_id": None, "is_new_for_site": False, "changed": False}

    now = time.time()
    with get_conn() as conn:
        existing = conn.execute(
            """SELECT id FROM site_indicators
               WHERE site_id=? AND indicator_id=? AND source_method=?""",
            (site_id, indicator_id, source_method),
        ).fetchone()

        if existing:
            conn.execute(
                "UPDATE site_indicators SET last_observed=?, still_present=1 WHERE id=?",
                (now, existing["id"]),
            )
            is_new = False
        else:
            conn.execute(
                """INSERT INTO site_indicators
                   (site_id, indicator_id, evidence_class, source_url, source_method,
                    context_snippet, screenshot_path, first_observed, last_observed, still_present)
                   VALUES (?,?,'observed',?,?,?,?,?,?,1)""",
                (site_id, indicator_id, source_url, source_method, context_snippet,
                 screenshot_path, now, now),
            )
            is_new = True

        # Keep the denormalised share count honest.
        count = conn.execute(
            "SELECT COUNT(DISTINCT site_id) c FROM site_indicators WHERE indicator_id=?",
            (indicator_id,),
        ).fetchone()["c"]
        conn.execute("UPDATE indicators SET site_count=? WHERE id=?", (count, indicator_id))

    if is_new:
        record_history(site_id, indicator_type, None, value, "appeared", scan_id,
                       f"{indicator_type} {value!r} first observed on {source_url or 'this site'}")
        add_timeline_event(
            site_id, "indicator_observed", "observed",
            f"{indicator_type} observed: {value[:60]}",
            f"Observed via {source_method or 'scan'} on {source_url or 'site'}"
            + (f" — context: {context_snippet[:160]}" if context_snippet else ""),
            url=source_url, screenshot_path=screenshot_path,
            ref_table="indicators", ref_id=indicator_id,
        )

    return {"indicator_id": indicator_id, "is_new_for_site": is_new, "changed": is_new}


def mark_indicators_absent(site_id: int, indicator_type: str, still_present_values: list,
                            scan_id: str = ""):
    """
    Closes out indicators of this type that a fresh scan no longer sees. The row
    is kept (history matters) but flagged not-current, so old data informs
    correlation without being mistaken for the present state.
    """
    normalized = {normalize_indicator_value(indicator_type, v) for v in (still_present_values or [])}
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT si.id, si.indicator_id, i.value
               FROM site_indicators si JOIN indicators i ON i.id = si.indicator_id
               WHERE si.site_id=? AND i.indicator_type=? AND si.still_present=1""",
            (site_id, indicator_type),
        ).fetchall()
        disappeared = []
        for row in rows:
            if row["value"] not in normalized:
                conn.execute("UPDATE site_indicators SET still_present=0 WHERE id=?", (row["id"],))
                disappeared.append(row["value"])

    for value in disappeared:
        record_history(site_id, indicator_type, value, None, "disappeared", scan_id,
                       f"{indicator_type} {value!r} is no longer present on this site")
        add_timeline_event(
            site_id, "changed", "observed",
            f"{indicator_type} removed: {value[:60]}",
            "Present in an earlier scan but not found in the latest one. The historical "
            "record is kept for correlation but is no longer treated as current.",
        )
    return disappeared


def indicators_for_site(site_id: int, only_current: bool = False):
    clause = "AND si.still_present=1" if only_current else ""
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT si.*, i.indicator_type, i.value, i.site_count
                FROM site_indicators si JOIN indicators i ON i.id = si.indicator_id
                WHERE si.site_id=? {clause}
                ORDER BY i.indicator_type, si.first_observed""",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def sites_sharing_indicator(indicator_id: int, exclude_site_id: int = None):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT s.*, si.source_url, si.source_method, si.still_present
               FROM site_indicators si JOIN sites s ON s.id = si.site_id
               WHERE si.indicator_id=?""",
            (indicator_id,),
        ).fetchall()
        return [dict(r) for r in rows if r["id"] != exclude_site_id]


def shared_indicators_between(site_a: int, site_b: int):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT i.* FROM indicators i
               WHERE i.id IN (SELECT indicator_id FROM site_indicators WHERE site_id=?)
                 AND i.id IN (SELECT indicator_id FROM site_indicators WHERE site_id=?)""",
            (site_a, site_b),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Derived correlations (what software concluded) ----------

def record_relationship(site_a_id: int, site_b_id: int, relation_type: str,
                         shared_indicator_id: int, explanation: str,
                         strength: float = None) -> int:
    """
    Records a DERIVED correlation. Always anchored to the shared indicator that
    justifies it, so "why are these linked?" is answerable from the row alone.
    Site ids are ordered so an A-B link and a B-A link are the same row.
    """
    if site_a_id == site_b_id:
        return None
    low, high = sorted((site_a_id, site_b_id))
    if strength is None:
        strength = INDICATOR_STRENGTH.get(relation_type.replace("shared_", ""), 0.5)
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO site_relationships
               (site_a_id, site_b_id, relation_type, evidence_class, strength,
                shared_indicator_id, explanation, first_derived, last_confirmed)
               VALUES (?,?,?,'derived',?,?,?,?,?)
               ON CONFLICT(site_a_id, site_b_id, relation_type, shared_indicator_id)
               DO UPDATE SET last_confirmed=excluded.last_confirmed,
                             explanation=excluded.explanation""",
            (low, high, relation_type, strength, shared_indicator_id, explanation, now, now),
        )
        row = conn.execute(
            """SELECT id FROM site_relationships
               WHERE site_a_id=? AND site_b_id=? AND relation_type=?
                 AND shared_indicator_id IS ?""",
            (low, high, relation_type, shared_indicator_id),
        ).fetchone()
        return row["id"] if row else None


def relationships_for_site(site_id: int):
    """Every derived link touching this site, with the other site's details."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT r.*,
                      CASE WHEN r.site_a_id=? THEN r.site_b_id ELSE r.site_a_id END AS other_site_id,
                      i.indicator_type, i.value AS indicator_value
               FROM site_relationships r
               LEFT JOIN indicators i ON i.id = r.shared_indicator_id
               WHERE r.site_a_id=? OR r.site_b_id=?
               ORDER BY r.strength DESC""",
            (site_id, site_id, site_id),
        ).fetchall()
        results = []
        for row in rows:
            item = dict(row)
            other = get_site(item["other_site_id"])
            item["other_domain"] = other["domain"] if other else None
            item["other_url"] = other["url"] if other else None
            results.append(item)
        return results


def all_relationships(limit: int = 5000):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM site_relationships ORDER BY strength DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Clusters ----------

def replace_clusters(clusters: list):
    """
    Rewrites the cluster tables from a freshly computed grouping. Clusters are
    derived state — recomputed wholesale rather than patched, so they can never
    drift out of sync with the relationships they come from.
    """
    now = time.time()
    with get_conn() as conn:
        conn.execute("DELETE FROM cluster_members")
        conn.execute("DELETE FROM clusters")
        for cluster in clusters:
            cur = conn.execute(
                """INSERT INTO clusters
                   (label, site_count, distinct_indicator_types, strong_indicator_types,
                    priority_score, max_site_confidence, total_validated_wallets,
                    summary, evidence_class, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,'derived',?,?)""",
                (cluster["label"], cluster["site_count"], cluster["distinct_indicator_types"],
                 cluster["strong_indicator_types"], cluster["priority_score"],
                 cluster.get("max_site_confidence", 0), cluster.get("total_validated_wallets", 0),
                 cluster["summary"], now, now),
            )
            cluster_id = cur.lastrowid
            for member in cluster["members"]:
                conn.execute(
                    """INSERT OR IGNORE INTO cluster_members
                       (cluster_id, site_id, join_reason, added_at) VALUES (?,?,?,?)""",
                    (cluster_id, member["site_id"], member["join_reason"], now),
                )


def list_clusters(limit: int = 100, min_sites: int = 2):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM clusters WHERE site_count >= ?
               ORDER BY priority_score DESC LIMIT ?""",
            (min_sites, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_cluster(cluster_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM clusters WHERE id=?", (cluster_id,)).fetchone()
        if not row:
            return None
        cluster = dict(row)
        members = conn.execute(
            """SELECT cm.*, s.domain, s.url, s.status, d.confidence_score, d.risk_score
               FROM cluster_members cm
               JOIN sites s ON s.id = cm.site_id
               LEFT JOIN deep_profiles d ON d.site_id = cm.site_id
               WHERE cm.cluster_id=?
               ORDER BY COALESCE(d.confidence_score,0) DESC""",
            (cluster_id,),
        ).fetchall()
        cluster["members"] = [dict(m) for m in members]
        return cluster


def cluster_for_site(site_id: int):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT c.* FROM clusters c JOIN cluster_members cm ON cm.cluster_id = c.id
               WHERE cm.site_id=? LIMIT 1""",
            (site_id,),
        ).fetchone()
        return dict(row) if row else None


# ---------- History ----------

def record_history(site_id: int, indicator_type: str, old_value, new_value,
                    change_type: str, scan_id: str = "", detail: str = ""):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO indicator_history
               (site_id, indicator_type, old_value, new_value, change_type,
                detected_at, scan_id, detail)
               VALUES (?,?,?,?,?,?,?,?)""",
            (site_id, indicator_type, old_value, new_value, change_type,
             time.time(), scan_id, detail),
        )


def history_for_site(site_id: int, limit: int = 200):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM indicator_history WHERE site_id=?
               ORDER BY detected_at DESC LIMIT ?""",
            (site_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def recent_changes(limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT h.*, s.domain, s.url FROM indicator_history h
               JOIN sites s ON s.id = h.site_id
               ORDER BY h.detected_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Timeline ----------

def add_timeline_event(site_id: int, event_type: str, evidence_class: str, title: str,
                        detail: str = "", url: str = "", screenshot_path: str = "",
                        ref_table: str = "", ref_id: int = None, occurred_at: float = None):
    if evidence_class not in ("observed", "derived"):
        raise ValueError(f"evidence_class must be 'observed' or 'derived', got {evidence_class!r}")
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO evidence_timeline
               (site_id, occurred_at, event_type, evidence_class, title, detail,
                url, screenshot_path, ref_table, ref_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (site_id, occurred_at or time.time(), event_type, evidence_class, title,
             detail, url, screenshot_path, ref_table, ref_id),
        )


def timeline_for_site(site_id: int, limit: int = 500):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM evidence_timeline WHERE site_id=?
               ORDER BY occurred_at ASC LIMIT ?""",
            (site_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Deposit options ----------

def record_deposit_option(site_id: int, page_url: str, method: str, network: str = "",
                           wallet_id: int = None, label: str = "", min_amount: str = "",
                           instructions: str = "", page_id: int = None,
                           screenshot_path: str = "", scan_id: str = "") -> int:
    now = time.time()
    with get_conn() as conn:
        existing = conn.execute(
            """SELECT id FROM deposit_options
               WHERE site_id=? AND page_url=? AND method=? AND network=? AND label=?""",
            (site_id, page_url, method, network, label),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE deposit_options SET last_seen=?, still_present=1 WHERE id=?",
                (now, existing["id"]),
            )
            return existing["id"]
        cur = conn.execute(
            """INSERT INTO deposit_options
               (site_id, page_id, page_url, method, network, wallet_id, label, min_amount,
                instructions, evidence_class, screenshot_path, first_seen, last_seen, still_present)
               VALUES (?,?,?,?,?,?,?,?,?,'observed',?,?,?,1)""",
            (site_id, page_id, page_url, method, network, wallet_id, label, min_amount,
             instructions, screenshot_path, now, now),
        )
        option_id = cur.lastrowid

    add_timeline_event(
        site_id, "deposit_option_found", "observed",
        f"Deposit option: {label or method}" + (f" ({network})" if network else ""),
        f"Found on {page_url}" + (f" — {instructions[:160]}" if instructions else ""),
        url=page_url, screenshot_path=screenshot_path,
        ref_table="deposit_options", ref_id=option_id,
    )
    record_history(site_id, "deposit_option", None, f"{method}:{network}:{label}",
                   "appeared", scan_id, f"New deposit option on {page_url}")
    return option_id


def deposit_options_for_site(site_id: int, only_current: bool = False):
    clause = "AND still_present=1" if only_current else ""
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT d.*, w.address AS wallet_address, w.network AS wallet_network
                FROM deposit_options d LEFT JOIN wallets w ON w.id = d.wallet_id
                WHERE d.site_id=? {clause} ORDER BY d.first_seen""",
            (site_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Scan runs ----------

def start_scan_run(scan_id: str) -> int:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO scan_runs (scan_id, started_at) VALUES (?,?)",
            (scan_id, time.time()),
        )
        row = conn.execute("SELECT id FROM scan_runs WHERE scan_id=?", (scan_id,)).fetchone()
        return row["id"] if row else None


def finish_scan_run(scan_id: str, sites_seen: int = 0, changes_detected: int = 0, notes: str = ""):
    with get_conn() as conn:
        conn.execute(
            """UPDATE scan_runs SET finished_at=?, sites_seen=?, changes_detected=?, notes=?
               WHERE scan_id=?""",
            (time.time(), sites_seen, changes_detected, notes, scan_id),
        )


def list_scan_runs(limit: int = 20):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------- Global search ----------

def global_search(query: str, limit: int = 50) -> dict:
    """
    Searches across every kind of collected intelligence at once. Returns
    results grouped by what was matched, so a wallet address, a domain, a
    Telegram handle and a page title all find their way home.
    """
    q = f"%{query.strip()}%"
    out = {"sites": [], "wallets": [], "indicators": [], "pages": [], "clusters": [], "deposit_options": []}
    if not query.strip():
        return out

    with get_conn() as conn:
        out["sites"] = [dict(r) for r in conn.execute(
            """SELECT s.*, d.confidence_score FROM sites s
               LEFT JOIN deep_profiles d ON d.site_id = s.id
               WHERE s.url LIKE ? OR s.domain LIKE ? OR s.discovery_reason LIKE ?
               ORDER BY COALESCE(d.confidence_score,0) DESC LIMIT ?""",
            (q, q, q, limit)).fetchall()]

        out["wallets"] = [dict(r) for r in conn.execute(
            """SELECT w.*, v.format_valid, v.tx_count,
                      (SELECT COUNT(DISTINCT site_id) FROM wallet_sightings WHERE wallet_id=w.id) AS site_count
               FROM wallets w LEFT JOIN wallet_validations v ON v.wallet_id = w.id
               WHERE w.address LIKE ? OR w.network LIKE ? LIMIT ?""",
            (q, q, limit)).fetchall()]

        out["indicators"] = [dict(r) for r in conn.execute(
            """SELECT * FROM indicators WHERE value LIKE ? OR indicator_type LIKE ?
               ORDER BY site_count DESC LIMIT ?""", (q, q, limit)).fetchall()]

        out["pages"] = [dict(r) for r in conn.execute(
            """SELECT p.*, s.domain FROM pages p JOIN sites s ON s.id = p.site_id
               WHERE p.url LIKE ? OR p.title LIKE ? LIMIT ?""", (q, q, limit)).fetchall()]

        out["clusters"] = [dict(r) for r in conn.execute(
            """SELECT * FROM clusters WHERE label LIKE ? OR summary LIKE ?
               ORDER BY priority_score DESC LIMIT ?""", (q, q, limit)).fetchall()]

        out["deposit_options"] = [dict(r) for r in conn.execute(
            """SELECT d.*, s.domain FROM deposit_options d JOIN sites s ON s.id = d.site_id
               WHERE d.label LIKE ? OR d.network LIKE ? OR d.instructions LIKE ? LIMIT ?""",
            (q, q, q, limit)).fetchall()]

    out["total"] = sum(len(v) for v in out.values() if isinstance(v, list))
    return out


def intelligence_stats() -> dict:
    with get_conn() as conn:
        def count(sql, *params):
            return conn.execute(sql, params).fetchone()["c"]
        return {
            "sites": count("SELECT COUNT(*) c FROM sites"),
            "indicators": count("SELECT COUNT(*) c FROM indicators"),
            "shared_indicators": count("SELECT COUNT(*) c FROM indicators WHERE site_count > 1"),
            "relationships": count("SELECT COUNT(*) c FROM site_relationships"),
            "clusters": count("SELECT COUNT(*) c FROM clusters WHERE site_count > 1"),
            "deposit_options": count("SELECT COUNT(*) c FROM deposit_options"),
            "timeline_events": count("SELECT COUNT(*) c FROM evidence_timeline"),
            "tracked_changes": count("SELECT COUNT(*) c FROM indicator_history"),
        }


# ============================================================
# v0.3: Discovery Pivot Engine
# ============================================================

def create_pivot_run(run_key: str, max_depth: int, config: dict) -> int:
    with get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO pivot_runs (run_key, started_at, max_depth, config)
               VALUES (?,?,?,?)""",
            (run_key, time.time(), max_depth, _dumps(config)),
        )
        row = conn.execute("SELECT id FROM pivot_runs WHERE run_key=?", (run_key,)).fetchone()
        return row["id"] if row else None


def finish_pivot_run(run_id: int, **fields):
    allowed = {"seed_count", "leads_generated", "leads_executed", "candidates_found",
               "new_sites", "stopped_reason", "notes"}
    sets, params = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            params.append(v)
    sets.append("finished_at=?")
    params.extend([time.time(), run_id])
    with get_conn() as conn:
        conn.execute(f"UPDATE pivot_runs SET {', '.join(sets)} WHERE id=?", params)


def get_pivot_run(run_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM pivot_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        run = dict(row)
        run["config"] = _loads(run.get("config"), {})
        return run


def list_pivot_runs(limit: int = 20):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM pivot_runs ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["config"] = _loads(item.get("config"), {})
            out.append(item)
        return out


def add_pivot_lead(run_id: int, lead_key: str, pivot_type: str, indicator_type: str,
                    indicator_value: str, origin_site_id: int, depth: int,
                    strength: float, indicator_id: int = None) -> int:
    """
    Queues a lead. Returns the lead id, or None if this exact lead was already
    queued in this run — which is the primary defence against the engine
    chasing the same indicator round in circles.
    """
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO pivot_leads
               (run_id, lead_key, pivot_type, indicator_id, indicator_type, indicator_value,
                origin_site_id, depth, strength, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?, 'queued', ?)""",
            (run_id, lead_key, pivot_type, indicator_id, indicator_type, indicator_value,
             origin_site_id, depth, strength, time.time()),
        )
        return cur.lastrowid if cur.rowcount else None


def next_queued_leads(run_id: int, limit: int = 20, max_depth: int = 3):
    """Strongest, shallowest leads first — best evidence gets explored before noise."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM pivot_leads
               WHERE run_id=? AND status='queued' AND depth <= ?
               ORDER BY depth ASC, strength DESC LIMIT ?""",
            (run_id, max_depth, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def update_pivot_lead(lead_id: int, status: str, candidates_found: int = 0,
                       new_sites: int = 0, skip_reason: str = ""):
    with get_conn() as conn:
        conn.execute(
            """UPDATE pivot_leads SET status=?, candidates_found=?, new_sites=?,
               skip_reason=?, executed_at=? WHERE id=?""",
            (status, candidates_found, new_sites, skip_reason, time.time(), lead_id),
        )


def leads_for_run(run_id: int, limit: int = 500):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM pivot_leads WHERE run_id=?
               ORDER BY depth, strength DESC LIMIT ?""", (run_id, limit)).fetchall()
        return [dict(r) for r in rows]


def lead_already_seen(lead_key: str) -> bool:
    """Across ALL runs — so a later run doesn't redo work an earlier one did."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM pivot_leads WHERE lead_key=? AND status='executed' LIMIT 1",
            (lead_key,)).fetchone()
        return row is not None


def record_discovery_path(run_id: int, site_id: int, domain: str, lead_id: int,
                           origin_site_id: int, depth: int, pivot_type: str,
                           indicator_type: str, indicator_value: str,
                           path: list, path_text: str, link_strength: float) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO discovery_paths
               (run_id, site_id, domain, lead_id, origin_site_id, depth, pivot_type,
                indicator_type, indicator_value, path_json, path_text,
                evidence_class, link_strength, found_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?, 'derived', ?, ?)""",
            (run_id, site_id, domain, lead_id, origin_site_id, depth, pivot_type,
             indicator_type, indicator_value, _dumps(path), path_text,
             link_strength, time.time()),
        )
        return cur.lastrowid if cur.rowcount else None


def paths_for_site(site_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT dp.*, s.domain AS origin_domain
               FROM discovery_paths dp
               LEFT JOIN sites s ON s.id = dp.origin_site_id
               WHERE dp.site_id=? ORDER BY dp.link_strength DESC""",
            (site_id,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["path"] = _loads(item.get("path_json"))
            out.append(item)
        return out


def paths_for_run(run_id: int, limit: int = 500):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT dp.*, s.domain AS origin_domain FROM discovery_paths dp
               LEFT JOIN sites s ON s.id = dp.origin_site_id
               WHERE dp.run_id=? ORDER BY dp.link_strength DESC LIMIT ?""",
            (run_id, limit)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["path"] = _loads(item.get("path_json"))
            out.append(item)
        return out


def recompute_convergence() -> int:
    """
    Recomputes, for every site reached by pivoting, how many INDEPENDENT paths
    led to it. Independence is what matters: five paths that all rest on the
    same indicator are one piece of evidence, not five.
    """
    with get_conn() as conn:
        site_ids = [r["site_id"] for r in conn.execute(
            "SELECT DISTINCT site_id FROM discovery_paths WHERE site_id IS NOT NULL").fetchall()]

    updated = 0
    for site_id in site_ids:
        paths = paths_for_site(site_id)
        if not paths:
            continue
        pivot_types = {p["pivot_type"] for p in paths}
        origins = {p["origin_site_id"] for p in paths if p["origin_site_id"]}
        # Independence key: a distinct (pivot type, indicator value) pair.
        independent = {(p["pivot_type"], p["indicator_value"]) for p in paths}
        strongest = max((p["link_strength"] or 0) for p in paths)
        min_depth = min(p["depth"] for p in paths)

        # v0.6: independence is counted across INDICATOR TYPES as well as
        # pivot types. Two wallet_reuse paths resting on two different wallets
        # are more independent than two paths on the same wallet, and less
        # independent than a wallet path plus a certificate path — because a
        # wallet and a certificate fail for unrelated reasons while two
        # wallets can both come from one copied page.
        indicator_types = {p.get("indicator_type") for p in paths if p.get("indicator_type")}
        indicator_values = {(p.get("indicator_type"), p.get("indicator_value"))
                            for p in paths if p.get("indicator_value")}

        # v0.6: route quality, where it has been scored. A strong route to a
        # domain is worth more than a weak one, and before this the two looked
        # identical once they arrived.
        best_quality = best_path_quality(site_id)
        quality_factor = 1.0 if best_quality is None else (0.7 + 0.6 * best_quality)

        # Convergence bonus grows with INDEPENDENT routes, not raw path count,
        # and is damped by depth since distant hops are weaker evidence.
        depth_damping = 1.0 / (1.0 + 0.35 * min_depth)
        score = (strongest
                 + 0.25 * (len(independent) - 1)
                 + 0.15 * (len(pivot_types) - 1)
                 + 0.20 * (len(indicator_types) - 1)
                 + 0.08 * (len(indicator_values) - len(indicator_types))
                 + 0.10 * (len(origins) - 1)) * depth_damping * quality_factor
        score = round(max(0.0, min(score, 2.0)), 3)

        domain = paths[0]["domain"]
        if len(independent) > 1:
            summary = (
                f"Reached by {len(independent)} independent pivot(s) "
                f"({', '.join(sorted(pivot_types))}) across {len(indicator_types)} "
                f"indicator type(s) from {len(origins)} origin site(s)"
                + (f", best route quality {best_quality:.2f}. "
                   if best_quality is not None else ". ")
                + "Independent indicator types matter more than repeated routes: they fail "
                  "for unrelated reasons. "
                "Independent routes to the same domain make it a stronger lead and raise its "
                "investigation priority. This reflects shared indicators only — it is not a "
                "finding about ownership, control, or wrongdoing."
            )
        else:
            summary = (
                f"Reached by a single pivot ({', '.join(sorted(pivot_types))}) at depth "
                f"{min_depth}. A single shared indicator is a lead worth checking, nothing more."
            )

        with get_conn() as conn:
            conn.execute(
                """INSERT INTO pivot_convergence
                   (site_id, domain, path_count, distinct_pivot_types, distinct_origin_sites,
                    strongest_link, connection_score, min_depth, summary, evidence_class, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?, 'derived', ?)
                   ON CONFLICT(site_id) DO UPDATE SET
                     path_count=excluded.path_count,
                     distinct_pivot_types=excluded.distinct_pivot_types,
                     distinct_origin_sites=excluded.distinct_origin_sites,
                     strongest_link=excluded.strongest_link,
                     connection_score=excluded.connection_score,
                     min_depth=excluded.min_depth,
                     summary=excluded.summary,
                     updated_at=excluded.updated_at""",
                (site_id, domain, len(paths), len(pivot_types), len(origins),
                 strongest, score, min_depth, summary, time.time()),
            )
        updated += 1
    return updated


def list_convergence(limit: int = 100, min_paths: int = 1):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT pc.*, s.url, s.status, s.discovery_confidence,
                      d.confidence_score
               FROM pivot_convergence pc
               JOIN sites s ON s.id = pc.site_id
               LEFT JOIN deep_profiles d ON d.site_id = pc.site_id
               WHERE pc.path_count >= ?
               ORDER BY pc.connection_score DESC LIMIT ?""",
            (min_paths, limit)).fetchall()
        return [dict(r) for r in rows]


def get_convergence(site_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM pivot_convergence WHERE site_id=?", (site_id,)).fetchone()
        return dict(row) if row else None


def pivot_stats() -> dict:
    with get_conn() as conn:
        def c(sql, *p):
            return conn.execute(sql, p).fetchone()["c"]
        return {
            "runs": c("SELECT COUNT(*) c FROM pivot_runs"),
            "leads_total": c("SELECT COUNT(*) c FROM pivot_leads"),
            "leads_executed": c("SELECT COUNT(*) c FROM pivot_leads WHERE status='executed'"),
            "leads_skipped": c("SELECT COUNT(*) c FROM pivot_leads WHERE status='skipped'"),
            "paths": c("SELECT COUNT(*) c FROM discovery_paths"),
            "sites_reached": c("SELECT COUNT(DISTINCT site_id) c FROM discovery_paths"),
            "converged_sites": c("SELECT COUNT(*) c FROM pivot_convergence WHERE path_count > 1"),
            "max_depth_reached": (conn.execute(
                "SELECT COALESCE(MAX(depth),0) c FROM discovery_paths").fetchone()["c"]),
        }


# ============================================================
# v0.4: Technique learning, campaigns, cluster watch
# ============================================================

# ---------- Technique performance ledger ----------

def _ensure_technique(pivot_type: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO pivot_technique_stats (pivot_type, last_updated)
               VALUES (?, ?)""", (pivot_type, time.time()))


def record_technique_result(pivot_type: str, candidates: int = 0, unique_new: int = 0,
                             duplicates: int = 0, seconds: float = 0.0):
    """Called after every executed lead. Pure counting — scoring happens separately."""
    _ensure_technique(pivot_type)
    with get_conn() as conn:
        conn.execute(
            """UPDATE pivot_technique_stats SET
                 leads_executed = leads_executed + 1,
                 candidates_returned = candidates_returned + ?,
                 unique_new_sites = unique_new_sites + ?,
                 duplicate_candidates = duplicate_candidates + ?,
                 total_seconds = total_seconds + ?,
                 last_updated = ?
               WHERE pivot_type = ?""",
            (candidates, unique_new, duplicates, seconds, time.time(), pivot_type))


def record_technique_outcome(pivot_type: str, passed_triage: int = 0,
                              high_confidence: int = 0, dead: int = 0,
                              sent_to_platform: int = 0):
    """
    Called later, once a site this technique found has been through triage,
    deep analysis, or the v0.5 send gate. This is the feedback that turns raw
    counts into quality.
    """
    _ensure_technique(pivot_type)
    with get_conn() as conn:
        conn.execute(
            """UPDATE pivot_technique_stats SET
                 sites_passing_triage = sites_passing_triage + ?,
                 sites_high_confidence = sites_high_confidence + ?,
                 sites_sent_to_platform = sites_sent_to_platform + ?,
                 dead_candidates = dead_candidates + ?,
                 last_updated = ?
               WHERE pivot_type = ?""",
            (passed_triage, high_confidence, sent_to_platform, dead,
             time.time(), pivot_type))


def set_technique_score(pivot_type: str, yield_score: float, throttle_state: str,
                         throttle_reason: str, evidence_note: str):
    _ensure_technique(pivot_type)
    with get_conn() as conn:
        conn.execute(
            """UPDATE pivot_technique_stats SET yield_score=?, throttle_state=?,
               throttle_reason=?, evidence_note=?, last_updated=? WHERE pivot_type=?""",
            (yield_score, throttle_state, throttle_reason, evidence_note,
             time.time(), pivot_type))


def get_technique(pivot_type: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM pivot_technique_stats WHERE pivot_type=?", (pivot_type,)).fetchone()
        return dict(row) if row else None


def list_techniques():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM pivot_technique_stats ORDER BY yield_score DESC").fetchall()
        return [dict(r) for r in rows]


# ---------- Campaigns ----------

def create_campaign(campaign_key: str, name: str, seed_kind: str, seed_value: str,
                     config: dict) -> int:
    now = time.time()
    with get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO campaigns
               (campaign_key, name, seed_kind, seed_value, status, current_stage,
                config, stats, created_at, updated_at)
               VALUES (?,?,?,?, 'pending', 'seed', ?, ?, ?, ?)""",
            (campaign_key, name, seed_kind, seed_value, _dumps(config), _dumps({}), now, now))
        row = conn.execute("SELECT id FROM campaigns WHERE campaign_key=?", (campaign_key,)).fetchone()
        return row["id"] if row else None


def update_campaign(campaign_id: int, **fields):
    allowed = {"status", "current_stage", "current_wave", "stats", "stopped_reason",
               "started_at", "finished_at", "name"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            raise ValueError(f"Cannot update campaign field: {k}")
        if k == "stats":
            v = _dumps(v)
        sets.append(f"{k}=?"); params.append(v)
    if not sets:
        return
    sets.append("updated_at=?"); params.extend([time.time(), campaign_id])
    with get_conn() as conn:
        conn.execute(f"UPDATE campaigns SET {', '.join(sets)} WHERE id=?", params)


def _decode_campaign(row) -> dict:
    c = dict(row)
    c["config"] = _loads(c.get("config"), {})
    c["stats"] = _loads(c.get("stats"), {})
    return c


def get_campaign(campaign_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        return _decode_campaign(row) if row else None


def get_campaign_by_key(campaign_key: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM campaigns WHERE campaign_key=?", (campaign_key,)).fetchone()
        return _decode_campaign(row) if row else None


def list_campaigns(limit: int = 50, status: str = None):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM campaigns WHERE status=? ORDER BY created_at DESC LIMIT ?",
                (status, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [_decode_campaign(r) for r in rows]


def start_campaign_stage(campaign_id: int, wave: int, stage: str, input_count: int = 0) -> int:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO campaign_stages (campaign_id, wave, stage, status, input_count, started_at)
               VALUES (?,?,?, 'running', ?, ?)
               ON CONFLICT(campaign_id, wave, stage) DO UPDATE SET
                 status='running', input_count=excluded.input_count, started_at=excluded.started_at""",
            (campaign_id, wave, stage, input_count, time.time()))
        row = conn.execute(
            "SELECT id FROM campaign_stages WHERE campaign_id=? AND wave=? AND stage=?",
            (campaign_id, wave, stage)).fetchone()
        return row["id"] if row else None


def finish_campaign_stage(campaign_id: int, wave: int, stage: str, status: str,
                           output_count: int = 0, detail: str = ""):
    with get_conn() as conn:
        conn.execute(
            """UPDATE campaign_stages SET status=?, output_count=?, detail=?, finished_at=?
               WHERE campaign_id=? AND wave=? AND stage=?""",
            (status, output_count, detail, time.time(), campaign_id, wave, stage))


def campaign_stage_complete(campaign_id: int, wave: int, stage: str) -> bool:
    """Resume support: has this exact stage already finished?"""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT status FROM campaign_stages
               WHERE campaign_id=? AND wave=? AND stage=?""",
            (campaign_id, wave, stage)).fetchone()
        return bool(row and row["status"] in ("complete", "skipped"))


def stages_for_campaign(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_stages WHERE campaign_id=? ORDER BY wave, id",
            (campaign_id,)).fetchall()
        return [dict(r) for r in rows]


def mark_work_complete(campaign_id: int, work_kind: str, work_key: str, summary: str = "") -> bool:
    """Returns True if newly recorded, False if it was already done."""
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO campaign_completed_work
               (campaign_id, work_kind, work_key, result_summary, completed_at)
               VALUES (?,?,?,?,?)""",
            (campaign_id, work_kind, work_key, summary, time.time()))
        return cur.rowcount > 0


def work_already_done(campaign_id: int, work_kind: str, work_key: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            """SELECT id FROM campaign_completed_work
               WHERE campaign_id=? AND work_kind=? AND work_key=? LIMIT 1""",
            (campaign_id, work_kind, work_key)).fetchone()
        return row is not None


def completed_work_count(campaign_id: int, work_kind: str = None) -> int:
    with get_conn() as conn:
        if work_kind:
            return conn.execute(
                "SELECT COUNT(*) c FROM campaign_completed_work WHERE campaign_id=? AND work_kind=?",
                (campaign_id, work_kind)).fetchone()["c"]
        return conn.execute(
            "SELECT COUNT(*) c FROM campaign_completed_work WHERE campaign_id=?",
            (campaign_id,)).fetchone()["c"]


# ---------- Campaign budgets ----------

def set_campaign_budget(campaign_id: int, resource: str, limit_value: float):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO campaign_budget (campaign_id, resource, limit_value, used_value)
               VALUES (?,?,?,0)
               ON CONFLICT(campaign_id, resource) DO UPDATE SET limit_value=excluded.limit_value""",
            (campaign_id, resource, limit_value))


def spend_budget(campaign_id: int, resource: str, amount: float = 1.0) -> bool:
    """
    Spends from the ledger. Returns False if this would exceed the limit, in
    which case nothing is spent — so a refused spend can't silently overrun.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT limit_value, used_value FROM campaign_budget WHERE campaign_id=? AND resource=?",
            (campaign_id, resource)).fetchone()
        if not row:
            return True  # unbudgeted resource is unlimited by definition
        if row["used_value"] + amount > row["limit_value"]:
            return False
        conn.execute(
            "UPDATE campaign_budget SET used_value = used_value + ? WHERE campaign_id=? AND resource=?",
            (amount, campaign_id, resource))
        return True


def budget_exhausted(campaign_id: int) -> tuple:
    """Returns (exhausted, resource_name) for the first resource at its limit."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_budget WHERE campaign_id=?", (campaign_id,)).fetchall()
    for row in rows:
        if row["used_value"] >= row["limit_value"]:
            return True, row["resource"]
    return False, None


def campaign_budget_state(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_budget WHERE campaign_id=? ORDER BY resource",
            (campaign_id,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Cluster watch ----------

def save_cluster_watch(cluster_id: int, cluster_label: str, signature: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO cluster_watch (cluster_id, cluster_label, signature, created_at, last_checked)
               VALUES (?,?,?,?,?)
               ON CONFLICT(cluster_id) DO UPDATE SET
                 cluster_label=excluded.cluster_label, signature=excluded.signature,
                 last_checked=excluded.last_checked""",
            (cluster_id, cluster_label, _dumps(signature), time.time(), time.time()))


def list_cluster_watches():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM cluster_watch ORDER BY cluster_id").fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["signature"] = _loads(item.get("signature"), {})
            out.append(item)
        return out


def record_cluster_new_domain(cluster_id: int, site_id: int, domain: str,
                               indicator_type: str, indicator_value: str,
                               explanation: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO cluster_new_domains
               (cluster_id, site_id, domain, matched_indicator_type, matched_indicator_value,
                match_explanation, first_seen, evidence_class)
               VALUES (?,?,?,?,?,?,?, 'derived')""",
            (cluster_id, site_id, domain, indicator_type, indicator_value,
             explanation, time.time()))
        if cur.rowcount:
            conn.execute(
                "UPDATE cluster_watch SET new_matches = new_matches + 1 WHERE cluster_id=?",
                (cluster_id,))
        return cur.rowcount > 0


def list_cluster_new_domains(limit: int = 100, cluster_id: int = None):
    with get_conn() as conn:
        if cluster_id:
            rows = conn.execute(
                """SELECT n.*, c.label AS cluster_label FROM cluster_new_domains n
                   LEFT JOIN clusters c ON c.id = n.cluster_id
                   WHERE n.cluster_id=? ORDER BY n.first_seen DESC LIMIT ?""",
                (cluster_id, limit)).fetchall()
        else:
            rows = conn.execute(
                """SELECT n.*, c.label AS cluster_label FROM cluster_new_domains n
                   LEFT JOIN clusters c ON c.id = n.cluster_id
                   ORDER BY n.first_seen DESC LIMIT ?""", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ============================================================
# v0.5: Main Platform integration
# ============================================================

# ---------- Outbox ----------



def mark_outbox_sent(outbox_id: int, receipt: dict = None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE integration_outbox
               SET status='sent', sent_at=?, last_error=NULL, platform_receipt=?
               WHERE id=?""",
            (time.time(), _dumps(receipt or {}), outbox_id))


def mark_outbox_failed(outbox_id: int, error: str, next_attempt_at: float):
    with get_conn() as conn:
        conn.execute(
            """UPDATE integration_outbox
               SET status='failed', attempts = attempts + 1,
                   last_error=?, next_attempt_at=?
               WHERE id=?""",
            (str(error)[:500], next_attempt_at, outbox_id))


def cancel_outbox_event(outbox_id: int, reason: str = "cancelled by operator") -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE integration_outbox SET status='cancelled', last_error=? "
            "WHERE id=? AND status IN ('queued','failed')", (reason, outbox_id))
        return cur.rowcount > 0


def reset_stuck_outbox() -> int:
    """
    On startup, anything left in 'sending' was interrupted mid-flight. It goes
    back to 'queued' rather than being assumed sent — the receiving side
    deduplicates, so re-sending is safe while assuming success is not.
    """
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE integration_outbox SET status='queued', next_attempt_at=0 "
            "WHERE status='sending'")
        return cur.rowcount


def outbox_stats() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) c FROM integration_outbox GROUP BY status").fetchall()
        by_status = {r["status"]: r["c"] for r in rows}
        oldest = conn.execute(
            "SELECT MIN(queued_at) m FROM integration_outbox "
            "WHERE status IN ('queued','failed')").fetchone()["m"]
        return {
            "queued": by_status.get("queued", 0), "failed": by_status.get("failed", 0),
            "sent": by_status.get("sent", 0), "cancelled": by_status.get("cancelled", 0),
            "sending": by_status.get("sending", 0),
            "pending": by_status.get("queued", 0) + by_status.get("failed", 0),
            "oldest_pending_at": oldest,
        }


def list_outbox(status: str = None, limit: int = 100):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM integration_outbox WHERE status=? "
                "ORDER BY queued_at DESC LIMIT ?", (status, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM integration_outbox ORDER BY queued_at DESC LIMIT ?",
                (limit,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["payload"] = _loads(item.get("payload"), {})
            item["platform_receipt"] = _loads(item.get("platform_receipt"), {})
            out.append(item)
        return out



# ---------- Connection status ----------

def update_integration_status(endpoint: str, **fields):
    allowed = {"state", "platform_schema", "compatible", "degraded", "compatibility_detail",
               "last_heartbeat_at", "last_success_at", "last_error", "last_error_at",
               "consecutive_failures", "platform_version"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            raise ValueError(f"Cannot update integration status field: {k}")
        sets.append(f"{k}=?")
        params.append(int(v) if k in ("compatible", "degraded") and isinstance(v, bool) else v)
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO integration_status (endpoint, updated_at) VALUES (?,?)",
            (endpoint, time.time()))
        if sets:
            sets.append("updated_at=?")
            params.extend([time.time(), endpoint])
            conn.execute(
                f"UPDATE integration_status SET {', '.join(sets)} WHERE endpoint=?", params)


def get_integration_status(endpoint: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM integration_status WHERE endpoint=?", (endpoint,)).fetchone()
        return dict(row) if row else None


# ---------- Receipts and investigation handles ----------

def record_receipt(event_id: str, platform_status: str, site_id: int = None,
                    investigation_id: str = None, investigator_job_id: str = None,
                    detail: str = "") -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO integration_receipts
               (event_id, site_id, investigation_id, platform_status,
                investigator_job_id, detail, received_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(event_id) DO UPDATE SET
                 platform_status=excluded.platform_status,
                 investigation_id=COALESCE(excluded.investigation_id, integration_receipts.investigation_id),
                 investigator_job_id=COALESCE(excluded.investigator_job_id, integration_receipts.investigator_job_id),
                 detail=excluded.detail, received_at=excluded.received_at""",
            (event_id, site_id, investigation_id, platform_status,
             investigator_job_id, detail, time.time()))
        return cur.rowcount > 0


def receipts_for_site(site_id: int, limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM integration_receipts WHERE site_id=? "
            "ORDER BY received_at DESC LIMIT ?", (site_id, limit)).fetchall()
        return [dict(r) for r in rows]


def link_site_investigation(site_id: int, investigation_id: str = None,
                             correlation_id: str = None, investigator_job_id: str = None,
                             platform_state: str = None):
    """Records the platform's handle for a site so later events join the same thread."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO site_investigations
               (site_id, investigation_id, correlation_id, first_sent_at, last_sent_at,
                events_sent, investigator_job_id, platform_state)
               VALUES (?,?,?,?,?,1,?,?)
               ON CONFLICT(site_id) DO UPDATE SET
                 investigation_id=COALESCE(excluded.investigation_id, site_investigations.investigation_id),
                 correlation_id=COALESCE(site_investigations.correlation_id, excluded.correlation_id),
                 investigator_job_id=COALESCE(excluded.investigator_job_id, site_investigations.investigator_job_id),
                 platform_state=COALESCE(excluded.platform_state, site_investigations.platform_state),
                 last_sent_at=excluded.last_sent_at,
                 events_sent=site_investigations.events_sent + 1""",
            (site_id, investigation_id, correlation_id, time.time(), time.time(),
             investigator_job_id, platform_state))


def get_site_investigation(site_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM site_investigations WHERE site_id=?", (site_id,)).fetchone()
        return dict(row) if row else None


def sites_sent_to_platform(limit: int = 200):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT si.*, s.domain, s.url FROM site_investigations si
               JOIN sites s ON s.id = si.site_id
               ORDER BY si.last_sent_at DESC LIMIT ?""", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Indicator-level yield (budget protection) ----------

def record_indicator_yield(indicator_type: str, indicator_value: str, *,
                            leads: int = 0, candidates: int = 0, unique_new: int = 0,
                            passed_triage: int = 0, sent: int = 0):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO indicator_yield
               (indicator_type, indicator_value, leads_executed, candidates_returned,
                unique_new_sites, sites_passing_triage, sites_sent_to_platform, last_used_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(indicator_type, indicator_value) DO UPDATE SET
                 leads_executed = leads_executed + excluded.leads_executed,
                 candidates_returned = candidates_returned + excluded.candidates_returned,
                 unique_new_sites = unique_new_sites + excluded.unique_new_sites,
                 sites_passing_triage = sites_passing_triage + excluded.sites_passing_triage,
                 sites_sent_to_platform = sites_sent_to_platform + excluded.sites_sent_to_platform,
                 last_used_at = excluded.last_used_at""",
            (indicator_type, indicator_value, leads, candidates, unique_new,
             passed_triage, sent, time.time()))


def get_indicator_yield(indicator_type: str, indicator_value: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM indicator_yield WHERE indicator_type=? AND indicator_value=?",
            (indicator_type, indicator_value)).fetchone()
        return dict(row) if row else None


def retire_indicator(indicator_type: str, indicator_value: str, reason: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO indicator_yield (indicator_type, indicator_value, retired,
                                            retired_reason, last_used_at)
               VALUES (?,?,1,?,?)
               ON CONFLICT(indicator_type, indicator_value) DO UPDATE SET
                 retired=1, retired_reason=excluded.retired_reason""",
            (indicator_type, indicator_value, reason, time.time()))


def list_retired_indicators(limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM indicator_yield WHERE retired=1 "
            "ORDER BY candidates_returned DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Source-level yield ----------

def record_source_yield(source: str, *, candidates: int = 0, passed_triage: int = 0,
                         high_priority: int = 0, sent: int = 0):
    if not source:
        return
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO source_yield
               (source, candidates, passed_triage, high_priority, sent_to_platform, last_seen_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(source) DO UPDATE SET
                 candidates = candidates + excluded.candidates,
                 passed_triage = passed_triage + excluded.passed_triage,
                 high_priority = high_priority + excluded.high_priority,
                 sent_to_platform = sent_to_platform + excluded.sent_to_platform,
                 last_seen_at = excluded.last_seen_at""",
            (source, candidates, passed_triage, high_priority, sent, time.time()))


def list_source_yield(limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM source_yield ORDER BY sent_to_platform DESC, passed_triage DESC "
            "LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ============================================================
# v0.6: downstream feedback, path quality, dedup, rate limits, history
# ============================================================

# ---------- Downstream feedback ----------

def record_feedback(feedback_id: str, site_id: int = None, domain: str = "",
                     investigation_id: str = None, correlation_id: str = None,
                     deposit_pages: int = 0, wallets: int = 0,
                     infrastructure: int = 0, relationships: int = 0,
                     pages_examined: int = 0, reachable: bool = None,
                     outcome: str = "unknown", detail: str = "",
                     source: str = "", pivot_types: list = None,
                     indicator_signature: list = None, campaign_key: str = "") -> dict:
    """
    Stores one neutral outcome signal from downstream. Idempotent on
    feedback_id: the platform may redeliver, and a redelivery must not double
    the attribution counts.
    """
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM downstream_feedback WHERE feedback_id=?", (feedback_id,)).fetchone()
        if existing:
            return {"recorded": False, "reason": "already recorded", "id": existing["id"]}
        cur = conn.execute(
            """INSERT INTO downstream_feedback
               (feedback_id, site_id, domain, investigation_id, correlation_id,
                deposit_pages_found, wallets_found, infrastructure_evidence,
                relationships_found, pages_examined, reachable, outcome, detail,
                received_at, source, pivot_types, indicator_signature, campaign_key)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (feedback_id, site_id, domain, investigation_id, correlation_id,
             deposit_pages, wallets, infrastructure, relationships, pages_examined,
             None if reachable is None else int(bool(reachable)), outcome, detail,
             time.time(), source, _dumps(pivot_types or []),
             _dumps(indicator_signature or []), campaign_key))
        return {"recorded": True, "reason": "recorded", "id": cur.lastrowid}


def feedback_for_site(site_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM downstream_feedback WHERE site_id=? ORDER BY received_at DESC",
            (site_id,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["pivot_types"] = _loads(item.get("pivot_types"), [])
            item["indicator_signature"] = _loads(item.get("indicator_signature"), [])
            out.append(item)
        return out


def list_feedback(limit: int = 200, outcome: str = None):
    with get_conn() as conn:
        if outcome:
            rows = conn.execute(
                "SELECT * FROM downstream_feedback WHERE outcome=? "
                "ORDER BY received_at DESC LIMIT ?", (outcome, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM downstream_feedback ORDER BY received_at DESC LIMIT ?",
                (limit,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["pivot_types"] = _loads(item.get("pivot_types"), [])
            item["indicator_signature"] = _loads(item.get("indicator_signature"), [])
            out.append(item)
        return out


def feedback_exists(feedback_id: str) -> bool:
    with get_conn() as conn:
        return bool(conn.execute(
            "SELECT 1 FROM downstream_feedback WHERE feedback_id=?", (feedback_id,)).fetchone())


# ---------- Feedback attribution ----------

def record_attribution(key_kind: str, key_value: str, *, examined: int = 0,
                        useful: int = 0, thin: int = 0, unreachable: int = 0,
                        deposit_pages: int = 0, wallets: int = 0,
                        infrastructure: int = 0, relationships: int = 0):
    if not key_value:
        return
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO feedback_attribution
               (key_kind, key_value, candidates_examined, useful, thin, unreachable,
                deposit_pages, wallets, infrastructure, relationships, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(key_kind, key_value) DO UPDATE SET
                 candidates_examined = candidates_examined + excluded.candidates_examined,
                 useful = useful + excluded.useful,
                 thin = thin + excluded.thin,
                 unreachable = unreachable + excluded.unreachable,
                 deposit_pages = deposit_pages + excluded.deposit_pages,
                 wallets = wallets + excluded.wallets,
                 infrastructure = infrastructure + excluded.infrastructure,
                 relationships = relationships + excluded.relationships,
                 updated_at = excluded.updated_at""",
            (key_kind, key_value, examined, useful, thin, unreachable,
             deposit_pages, wallets, infrastructure, relationships, time.time()))


def set_attribution_score(key_kind: str, key_value: str, usefulness: float,
                           multiplier: float, note: str):
    with get_conn() as conn:
        conn.execute(
            """UPDATE feedback_attribution
               SET usefulness_score=?, budget_multiplier=?, evidence_note=?, updated_at=?
               WHERE key_kind=? AND key_value=?""",
            (usefulness, multiplier, note, time.time(), key_kind, key_value))


def get_attribution(key_kind: str, key_value: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM feedback_attribution WHERE key_kind=? AND key_value=?",
            (key_kind, key_value)).fetchone()
        return dict(row) if row else None


def list_attributions(key_kind: str = None, limit: int = 200):
    with get_conn() as conn:
        if key_kind:
            rows = conn.execute(
                "SELECT * FROM feedback_attribution WHERE key_kind=? "
                "ORDER BY usefulness_score DESC LIMIT ?", (key_kind, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM feedback_attribution ORDER BY key_kind, usefulness_score DESC "
                "LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


# ---------- Path quality ----------

def save_path_quality(path_id: int, site_id: int, scores: dict, explanation: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO path_quality
               (path_id, site_id, quality_score, depth_penalty, indicator_quality,
                technique_quality, breadth_penalty, feedback_bonus, explanation,
                evidence_class, computed_at)
               VALUES (?,?,?,?,?,?,?,?,?, 'derived', ?)
               ON CONFLICT(path_id) DO UPDATE SET
                 quality_score=excluded.quality_score,
                 depth_penalty=excluded.depth_penalty,
                 indicator_quality=excluded.indicator_quality,
                 technique_quality=excluded.technique_quality,
                 breadth_penalty=excluded.breadth_penalty,
                 feedback_bonus=excluded.feedback_bonus,
                 explanation=excluded.explanation,
                 computed_at=excluded.computed_at""",
            (path_id, site_id, scores.get("quality_score", 0),
             scores.get("depth_penalty", 0), scores.get("indicator_quality", 0),
             scores.get("technique_quality", 0), scores.get("breadth_penalty", 0),
             scores.get("feedback_bonus", 0), explanation, time.time()))


def path_quality_for_site(site_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT pq.*, dp.path_text, dp.pivot_type, dp.depth, dp.indicator_type,
                      dp.indicator_value
               FROM path_quality pq
               JOIN discovery_paths dp ON dp.id = pq.path_id
               WHERE pq.site_id=? ORDER BY pq.quality_score DESC""", (site_id,)).fetchall()
        return [dict(r) for r in rows]


def best_path_quality(site_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT MAX(quality_score) q FROM path_quality WHERE site_id=?",
            (site_id,)).fetchone()
        return row["q"] if row and row["q"] is not None else None


# ---------- Cross-campaign candidate registry ----------

def register_candidate(canonical_domain: str, site_id: int = None,
                        campaign_key: str = "", source: str = "",
                        pivot_type: str = "") -> dict:
    """
    Records a sighting of a candidate. Returns whether this was the first time
    it was ever seen, and how many distinct campaigns have now surfaced it.

    Rediscovery is information, not waste: a domain that three unrelated
    campaigns reach independently is a better lead than one only ever seen once.
    """
    now = time.time()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM candidate_registry WHERE canonical_domain=?",
            (canonical_domain,)).fetchone()

        cur = conn.execute(
            """INSERT OR IGNORE INTO candidate_sightings
               (canonical_domain, campaign_key, source, pivot_type, seen_at, was_new)
               VALUES (?,?,?,?,?,?)""",
            (canonical_domain, campaign_key, source, pivot_type, now,
             0 if existing else 1))
        new_sighting = cur.rowcount > 0

        if not existing:
            conn.execute(
                """INSERT INTO candidate_registry
                   (canonical_domain, site_id, first_campaign_key, first_seen_at,
                    times_rediscovered, distinct_campaigns, distinct_sources, last_seen_at)
                   VALUES (?,?,?,?,0,1,?,?)""",
                (canonical_domain, site_id, campaign_key, now,
                 _dumps([source] if source else []), now))
            return {"first_time": True, "new_sighting": True, "distinct_campaigns": 1,
                    "times_rediscovered": 0}

        sources = _loads(existing["distinct_sources"], [])
        if source and source not in sources:
            sources.append(source)
        campaigns = conn.execute(
            "SELECT COUNT(DISTINCT campaign_key) c FROM candidate_sightings "
            "WHERE canonical_domain=? AND campaign_key IS NOT NULL AND campaign_key != ''",
            (canonical_domain,)).fetchone()["c"]

        conn.execute(
            """UPDATE candidate_registry SET
                 site_id = COALESCE(?, site_id),
                 times_rediscovered = times_rediscovered + ?,
                 distinct_campaigns = ?, distinct_sources = ?, last_seen_at = ?
               WHERE canonical_domain=?""",
            (site_id, 1 if new_sighting else 0, max(1, campaigns),
             _dumps(sources), now, canonical_domain))

        return {"first_time": False, "new_sighting": new_sighting,
                "distinct_campaigns": max(1, campaigns),
                "times_rediscovered": (existing["times_rediscovered"] or 0)
                                      + (1 if new_sighting else 0)}


def get_candidate_registration(canonical_domain: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM candidate_registry WHERE canonical_domain=?",
            (canonical_domain,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["distinct_sources"] = _loads(item.get("distinct_sources"), [])
        return item


def sightings_for_candidate(canonical_domain: str):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM candidate_sightings WHERE canonical_domain=? ORDER BY seen_at",
            (canonical_domain,)).fetchall()
        return [dict(r) for r in rows]


def multi_campaign_candidates(min_campaigns: int = 2, limit: int = 100):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM candidate_registry WHERE distinct_campaigns >= ?
               ORDER BY distinct_campaigns DESC, times_rediscovered DESC LIMIT ?""",
            (min_campaigns, limit)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["distinct_sources"] = _loads(item.get("distinct_sources"), [])
            out.append(item)
        return out


# ---------- API budgets and rate limits ----------

def configure_api_budget(service: str, calls_per_window: int = 60,
                          window_seconds: float = 60, daily_limit: int = 0):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO api_budgets
               (service, calls_per_window, window_seconds, daily_limit, window_started_at,
                day_started_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(service) DO UPDATE SET
                 calls_per_window=excluded.calls_per_window,
                 window_seconds=excluded.window_seconds,
                 daily_limit=excluded.daily_limit""",
            (service, calls_per_window, window_seconds, daily_limit, time.time(), time.time()))


def get_api_budget(service: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM api_budgets WHERE service=?", (service,)).fetchone()
        return dict(row) if row else None


def list_api_budgets():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM api_budgets ORDER BY service").fetchall()
        return [dict(r) for r in rows]


def note_api_backoff(service: str, until: float, reason: str = ""):
    with get_conn() as conn:
        conn.execute(
            """UPDATE api_budgets SET backoff_until=?, consecutive_429 = consecutive_429 + 1,
                                      last_refusal_reason=?
               WHERE service=?""", (until, reason, service))


def clear_api_backoff(service: str):
    with get_conn() as conn:
        conn.execute(
            "UPDATE api_budgets SET backoff_until=0, consecutive_429=0 WHERE service=?",
            (service,))


# ---------- Historical tracking ----------

def snapshot_discovery_day(day: str = None) -> dict:
    """Records today's funnel. Safe to call repeatedly; the day row is replaced."""
    import datetime
    day = day or datetime.date.today().isoformat()
    with get_conn() as conn:
        def c(sql, *p):
            return conn.execute(sql, p).fetchone()["c"]
        stats = {
            "discovered": c("SELECT COUNT(*) c FROM sites"),
            "triaged": c("SELECT COUNT(*) c FROM triage_results"),
            "passed_triage": c("SELECT COUNT(*) c FROM triage_results WHERE passed=1"),
            "sent_to_platform": c("SELECT COUNT(*) c FROM site_investigations"),
            "feedback_useful": c("SELECT COUNT(*) c FROM downstream_feedback WHERE outcome='useful'"),
            "feedback_thin": c("SELECT COUNT(*) c FROM downstream_feedback WHERE outcome='thin'"),
            "campaigns_run": c("SELECT COUNT(*) c FROM campaigns"),
            "leads_executed": c("SELECT COUNT(*) c FROM pivot_leads WHERE status='executed'"),
        }
        conn.execute(
            """INSERT INTO discovery_history
               (day, discovered, triaged, passed_triage, sent_to_platform,
                feedback_useful, feedback_thin, campaigns_run, leads_executed, recorded_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(day) DO UPDATE SET
                 discovered=excluded.discovered, triaged=excluded.triaged,
                 passed_triage=excluded.passed_triage,
                 sent_to_platform=excluded.sent_to_platform,
                 feedback_useful=excluded.feedback_useful,
                 feedback_thin=excluded.feedback_thin,
                 campaigns_run=excluded.campaigns_run,
                 leads_executed=excluded.leads_executed,
                 recorded_at=excluded.recorded_at""",
            (day, stats["discovered"], stats["triaged"], stats["passed_triage"],
             stats["sent_to_platform"], stats["feedback_useful"], stats["feedback_thin"],
             stats["campaigns_run"], stats["leads_executed"], time.time()))
    return {"day": day, **stats}


def discovery_history(days: int = 60):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM discovery_history ORDER BY day DESC LIMIT ?", (days,)).fetchall()
        return [dict(r) for r in rows][::-1]


# ============================================================
# v0.6: the outbox holds canonical v4 ingest batches
# ============================================================
# The same table as v0.5, now carrying one v4 batch per row instead of one
# Site-Finder-shaped event. `event_id` holds the v4 batch_id, which is the
# contract's own idempotency unit (source_module + batch_id), and `event_type`
# holds the batch kind. Reusing the table keeps queued work across the upgrade
# rather than stranding it.

def queue_batch(batch_id: str, records: dict, site_id: int = None,
                 kind: str = "candidate", origin_job_id: str = None) -> dict:
    """
    Queues one canonical v4 ingest batch. Idempotent on batch_id: the same
    batch is never queued twice, which is the local half of the contract's
    batch idempotency guarantee.
    """
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id, status FROM integration_outbox WHERE event_id=?",
            (batch_id,)).fetchone()
        if existing:
            return {"queued": False, "reason": f"already {existing['status']}",
                    "outbox_id": existing["id"], "batch_id": batch_id}
        cur = conn.execute(
            """INSERT INTO integration_outbox
               (event_id, event_type, correlation_id, investigation_id, site_id,
                payload, status, queued_at, next_attempt_at)
               VALUES (?,?,?,?,?,?, 'queued', ?, 0)""",
            (batch_id, kind, None, origin_job_id, site_id,
             _dumps({"records": records, "origin_job_id": origin_job_id}), time.time()))
        return {"queued": True, "reason": "queued", "outbox_id": cur.lastrowid,
                "batch_id": batch_id}


def next_batches(limit: int = 10, now: float = None):
    """Batches due to be sent, oldest first, honouring per-batch backoff."""
    now = now if now is not None else time.time()
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM integration_outbox
               WHERE status IN ('queued','failed') AND COALESCE(next_attempt_at,0) <= ?
               ORDER BY queued_at ASC LIMIT ?""", (now, limit)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            body = _loads(item.get("payload"), {})
            item["records"] = body.get("records", {})
            item["origin_job_id"] = body.get("origin_job_id")
            item["batch_id"] = item["event_id"]
            item["kind"] = item["event_type"]
            out.append(item)
        return out


def batch_already_sent(batch_id: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT status FROM integration_outbox WHERE event_id=?", (batch_id,)).fetchone()
        return bool(row and row["status"] == "sent")


# ---------- v4 job handling ----------

def record_claimed_job(job_id: str, job_type: str, investigation_id: str = None,
                        payload: dict = None, status: str = "running",
                        trigger_reason: str = "") -> bool:
    """Stores a job claimed from the platform so a restart can resume it."""
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO platform_jobs
               (job_id, job_type, investigation_id, payload, status, trigger_reason,
                claimed_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(job_id) DO UPDATE SET
                 status=excluded.status, payload=excluded.payload,
                 updated_at=excluded.updated_at""",
            (job_id, job_type, investigation_id, _dumps(payload or {}), status,
             trigger_reason, time.time(), time.time()))
        return cur.rowcount > 0


def update_claimed_job(job_id: str, status: str, detail: str = "",
                        result: dict = None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE platform_jobs SET status=?, detail=?, result=?, updated_at=?
               WHERE job_id=?""",
            (status, detail, _dumps(result or {}), time.time(), job_id))


def get_claimed_job(job_id: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM platform_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["payload"] = _loads(item.get("payload"), {})
        item["result"] = _loads(item.get("result"), {})
        return item


def list_claimed_jobs(status: str = None, limit: int = 100):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM platform_jobs WHERE status=? ORDER BY claimed_at DESC LIMIT ?",
                (status, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM platform_jobs ORDER BY claimed_at DESC LIMIT ?",
                (limit,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["payload"] = _loads(item.get("payload"), {})
            item["result"] = _loads(item.get("result"), {})
            out.append(item)
        return out


def unfinished_jobs():
    """Jobs claimed but never reported complete — what a restart must resume."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM platform_jobs WHERE status IN ('running','claimed') "
            "ORDER BY claimed_at").fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["payload"] = _loads(item.get("payload"), {})
            out.append(item)
        return out


# ---------- Investigation identity from the platform ----------

def link_platform_investigation(site_id: int, investigation_external_id: str,
                                 platform_investigation_id: str = None,
                                 batch_id: str = None):
    """
    Permanently associates a site with the investigation it belongs to.

    `investigation_external_id` is the id Site Finder minted and the platform
    keys on; `platform_investigation_id` is the platform's own UUID once it is
    known from investigation context. Both are kept: the first is how Site
    Finder addresses the investigation, the second is how the platform does.
    """
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO site_investigations
               (site_id, investigation_id, correlation_id, first_sent_at, last_sent_at,
                events_sent, platform_state)
               VALUES (?,?,?,?,?,1,'sent')
               ON CONFLICT(site_id) DO UPDATE SET
                 investigation_id=COALESCE(excluded.investigation_id, site_investigations.investigation_id),
                 correlation_id=COALESCE(site_investigations.correlation_id, excluded.correlation_id),
                 last_sent_at=excluded.last_sent_at,
                 events_sent=site_investigations.events_sent + 1""",
            (site_id, platform_investigation_id or investigation_external_id,
             investigation_external_id, time.time(), time.time()))
        conn.execute(
            """UPDATE site_investigations SET platform_state=?
               WHERE site_id=? AND ? IS NOT NULL""",
            ("linked", site_id, platform_investigation_id))


def set_campaign_allocation(campaign_id: int, allocation: dict, explanation: str):
    """
    Stores the per-technique lead budget a campaign is running under, so a
    resumed campaign spends the same plan and an operator can see why a
    technique stopped.
    """
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO campaign_allocations
               (campaign_id, allocation, explanation, decided_at)
               VALUES (?,?,?,?)
               ON CONFLICT(campaign_id) DO UPDATE SET
                 allocation=excluded.allocation, explanation=excluded.explanation,
                 decided_at=excluded.decided_at""",
            (campaign_id, _dumps(allocation), explanation, time.time()))


def get_campaign_allocation(campaign_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM campaign_allocations WHERE campaign_id=?",
            (campaign_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["allocation"] = _loads(item.get("allocation"), {})
        return item


def set_technique_downstream(pivot_type: str, useful: int, examined: int):
    """
    Sets (not increments) a technique's downstream totals from the attribution
    ledger. Idempotent on purpose: refresh_scores runs on a timer, and an
    incrementing write there would inflate a technique every time it ran.
    """
    _ensure_technique(pivot_type)
    with get_conn() as conn:
        conn.execute(
            """UPDATE pivot_technique_stats
               SET sites_sent_to_platform = ?, last_updated = ?
               WHERE pivot_type = ?""",
            (max(0, int(useful)), time.time(), pivot_type))


def set_investigator_job(site_id: int, job_id: str, state: str = ""):
    """Records which Site Investigator job the platform opened for a candidate."""
    with get_conn() as conn:
        conn.execute(
            """UPDATE site_investigations
               SET investigator_job_id=?, platform_state=COALESCE(NULLIF(?,''), platform_state)
               WHERE site_id=?""",
            (job_id, state, site_id))


# ============================================================
# v0.7: saturation, candidate memory, cluster snapshots
# ============================================================

def record_expansion_stop(campaign_id: int, pivot_type: str, reason: str,
                           explanation: str, metrics: dict = None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO expansion_stops
               (campaign_id, pivot_type, reason, explanation, metrics, recorded_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(campaign_id, pivot_type, reason) DO UPDATE SET
                 explanation=excluded.explanation, metrics=excluded.metrics,
                 recorded_at=excluded.recorded_at""",
            (campaign_id, pivot_type or "", reason, explanation,
             _dumps(metrics or {}), time.time()))


def expansion_stops(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM expansion_stops WHERE campaign_id=? ORDER BY recorded_at",
            (campaign_id,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["metrics"] = _loads(item.get("metrics"), {})
            out.append(item)
        return out


# ---------- Candidate decisions ----------

def record_candidate_decision(site_id: int, canonical_domain: str, decision: str,
                               reason: str = "", evidence_snapshot: dict = None,
                               novelty: float = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO candidate_decisions
               (site_id, canonical_domain, decision, reason, evidence_snapshot,
                novelty_at_decision, decided_at)
               VALUES (?,?,?,?,?,?,?)""",
            (site_id, canonical_domain, decision, reason,
             _dumps(evidence_snapshot or {}), novelty, time.time()))
        conn.execute(
            "UPDATE candidate_registry SET last_decision=? WHERE canonical_domain=?",
            (decision, canonical_domain))
        return cur.lastrowid


def latest_candidate_decision(canonical_domain: str):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT * FROM candidate_decisions
               WHERE canonical_domain=? AND superseded_by IS NULL
               ORDER BY decided_at DESC LIMIT 1""", (canonical_domain,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["evidence_snapshot"] = _loads(item.get("evidence_snapshot"), {})
        return item


def candidate_decision_history(canonical_domain: str):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM candidate_decisions WHERE canonical_domain=? ORDER BY decided_at",
            (canonical_domain,)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["evidence_snapshot"] = _loads(item.get("evidence_snapshot"), {})
            out.append(item)
        return out


def supersede_decision(decision_id: int, new_decision_id: int, reason: str):
    """
    Marks an earlier decision as revisited. The original row is kept — the
    point of candidate memory is that the previous decision and the evidence
    that changed it are both on record.
    """
    with get_conn() as conn:
        conn.execute(
            "UPDATE candidate_decisions SET superseded_by=?, superseded_reason=? WHERE id=?",
            (new_decision_id, reason, decision_id))


def decisions_by_kind(decision: str, limit: int = 200):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM candidate_decisions
               WHERE decision=? AND superseded_by IS NULL
               ORDER BY decided_at DESC LIMIT ?""", (decision, limit)).fetchall()
        return [dict(r) for r in rows]


# ---------- Cluster snapshots ----------

def take_cluster_snapshot(cluster_id: int, domains: list, signature: list,
                           taken_at: float = None) -> bool:
    taken_at = taken_at if taken_at is not None else time.time()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO cluster_snapshots
               (cluster_id, taken_at, site_count, domains, indicator_signature)
               VALUES (?,?,?,?,?)""",
            (cluster_id, taken_at, len(domains), _dumps(sorted(domains)),
             _dumps(sorted(signature))))
        return cur.rowcount > 0


def latest_cluster_snapshot(cluster_id: int, before: float = None):
    with get_conn() as conn:
        if before is not None:
            row = conn.execute(
                """SELECT * FROM cluster_snapshots WHERE cluster_id=? AND taken_at < ?
                   ORDER BY taken_at DESC LIMIT 1""", (cluster_id, before)).fetchone()
        else:
            row = conn.execute(
                """SELECT * FROM cluster_snapshots WHERE cluster_id=?
                   ORDER BY taken_at DESC LIMIT 1""", (cluster_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["domains"] = _loads(item.get("domains"), [])
        item["indicator_signature"] = _loads(item.get("indicator_signature"), [])
        return item


def cluster_snapshots(cluster_id: int, limit: int = 30):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM cluster_snapshots WHERE cluster_id=? ORDER BY taken_at DESC LIMIT ?",
            (cluster_id, limit)).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["domains"] = _loads(item.get("domains"), [])
            item["indicator_signature"] = _loads(item.get("indicator_signature"), [])
            out.append(item)
        return out[::-1]


def set_candidate_novelty(canonical_domain: str, novelty: float, site_id: int = None):
    """
    Stores a candidate's novelty, creating the registry row if it does not
    exist yet. A plain UPDATE silently lost the score when novelty was computed
    before the candidate had been registered — which is the normal order when a
    site arrives from anywhere other than a campaign.
    """
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO candidate_registry
               (canonical_domain, site_id, first_seen_at, times_rediscovered,
                distinct_campaigns, distinct_sources, last_seen_at, novelty_score)
               VALUES (?,?,?,0,1,'[]',?,?)
               ON CONFLICT(canonical_domain) DO UPDATE SET
                 novelty_score=excluded.novelty_score,
                 site_id=COALESCE(candidate_registry.site_id, excluded.site_id)""",
            (canonical_domain, site_id, time.time(), time.time(), novelty))


# ---------- v0.7: live campaign controls ----------

def get_campaign_control(campaign_id: int) -> dict:
    """
    Controls a running campaign checks at each wave boundary: pause, stop after
    the current wave, or change a budget. Checked between waves rather than
    mid-stage so a control never leaves a stage half-done.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM campaign_controls WHERE campaign_id=?", (campaign_id,)).fetchone()
        if not row:
            return {"paused": False, "stop_after_current": False, "budget_changes": {}}
        item = dict(row)
        return {"paused": bool(item.get("paused")),
                "stop_after_current": bool(item.get("stop_after_current")),
                "budget_changes": _loads(item.get("budget_changes"), {})}


def set_campaign_control(campaign_id: int, **fields):
    allowed = {"paused", "stop_after_current", "budget_changes"}
    sets, params = [], []
    for key, value in fields.items():
        if key not in allowed:
            raise ValueError(f"Unknown campaign control: {key}")
        sets.append(f"{key}=?")
        params.append(_dumps(value) if key == "budget_changes" else int(bool(value)))
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO campaign_controls (campaign_id, updated_at) VALUES (?,?)",
            (campaign_id, time.time()))
        if sets:
            sets.append("updated_at=?")
            params.extend([time.time(), campaign_id])
            conn.execute(
                f"UPDATE campaign_controls SET {', '.join(sets)} WHERE campaign_id=?", params)


def clear_campaign_budget_changes(campaign_id: int):
    with get_conn() as conn:
        conn.execute(
            "UPDATE campaign_controls SET budget_changes='{}' WHERE campaign_id=?",
            (campaign_id,))
