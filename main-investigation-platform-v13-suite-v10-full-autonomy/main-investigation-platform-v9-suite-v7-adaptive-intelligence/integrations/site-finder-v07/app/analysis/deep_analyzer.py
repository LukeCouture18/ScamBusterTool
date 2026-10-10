"""
Deep analysis: the expensive, evidence-heavy stage reserved for sites that
cleared triage.

Where triage answers "is this worth looking at?", this answers "what exactly
is this, and what can we prove about it?" — producing the full profile the
operator sees and the reporting form consumes.

It reuses the existing investigation machinery (the Playwright navigator with
all its safety rules intact) rather than re-implementing browsing, then layers
on the enrichment that turns a scan result into a report-grade record:
wallet validation, infrastructure/relationship correlation, registration data,
contact/social extraction, threat-intel matching, and a confidence score that
reflects how many independent lines of evidence agree.
"""
import json
import logging
import re
from urllib.parse import urlparse

from app import db
from app.config import (
    DEEP_ANALYSIS_MAX_PAGES, DEEP_ANALYSIS_IMPORTANT_TEXT_CHARS,
    DISCOVERY_KEYWORDS, HIGH_CONFIDENCE_THRESHOLD,
)
from app.analysis.wallet_validator import validate_wallet
from app.analysis.threat_intel import check_threat_intel
from app.investigate.navigator import investigate_site
from app.investigate.domain_age import domain_age_days
from app.investigate.contact_extractor import extract_contacts_and_socials
from app.discovery.shared_infrastructure import SharedInfrastructureDiscoverer
from app.discovery.template_similarity import TemplateSimilarityDiscoverer
from app.analysis.indicator_extractor import extract_all_indicators
from app.analysis.deposit_discovery import (
    extract_deposit_options, page_is_deposit_page,
)

logger = logging.getLogger("scamhunter.analysis.deep")


# ---------------- Confidence scoring ----------------
# Confidence answers: "how sure are we this is a real, reportable scam site,
# and how good is our evidence?" It is deliberately driven by the NUMBER OF
# INDEPENDENT EVIDENCE TYPES, so a site is only high-confidence when several
# unrelated things all point the same way.

EVIDENCE_WEIGHTS = {
    "validated_wallet": 0.30,       # a wallet that passes checksum validation
    "wallet_has_activity": 0.12,    # and has actually received funds on-chain
    "deposit_page": 0.15,           # a real deposit/withdrawal page was reached
    "multiple_triage_categories": 0.15,
    "new_domain": 0.08,             # registered very recently
    "shared_infrastructure": 0.10,  # hosted alongside other known scam sites
    "template_match": 0.08,         # same builder/template as a known scam site
    "threat_intel_hit": 0.12,       # flagged by an external/local intel source
    "offplatform_contact": 0.05,    # Telegram/WhatsApp-only support
}


def compute_confidence(evidence_present: dict) -> tuple:
    """
    Returns (confidence 0-1, list of contributing evidence labels).
    Capped at 1.0. Evidence types are independent, so agreement compounds.
    """
    score = 0.0
    contributing = []
    for key, weight in EVIDENCE_WEIGHTS.items():
        if evidence_present.get(key):
            score += weight
            contributing.append(key)
    return round(min(score, 1.0), 3), contributing


def _extract_meta_description(html: str) -> str:
    match = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']{0,400})',
        html, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    match = re.search(
        r'<meta[^>]+content=["\']([^"\']{0,400})["\'][^>]+name=["\']description["\']',
        html, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _collect_keywords(text: str, page_url: str) -> list:
    """Finds which scam-category keywords actually appear, with their category."""
    found = []
    lower = text.lower()
    for category, phrases in DISCOVERY_KEYWORDS.items():
        for phrase in phrases:
            if phrase.lower() in lower:
                found.append({"keyword": phrase, "category": category, "page_url": page_url})
    # Also surface the high-signal single terms that matter for reporting.
    for term in ("usdt", "trc20", "erc20", "deposit", "withdraw", "roi", "mining", "staking"):
        if re.search(rf"\b{re.escape(term)}\b", lower):
            found.append({"keyword": term, "category": "payment_terms", "page_url": page_url})
    return found


def _read_page_text(page_row: dict) -> str:
    """Best-effort read of a saved HTML snapshot, returning visible-ish text."""
    path = page_row.get("html_snapshot_path")
    if not path:
        return ""
    try:
        with open(path, "r", errors="ignore") as handle:
            html = handle.read()
    except OSError:
        return ""
    text = re.sub(r"<script.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _read_page_html(page_row: dict) -> str:
    path = page_row.get("html_snapshot_path")
    if not path:
        return ""
    try:
        with open(path, "r", errors="ignore") as handle:
            return handle.read()
    except OSError:
        return ""


def analyze_site(site: dict, progress_cb=None, should_stop=None,
                  allow_signup: bool = False, deep_wallet_hunt: bool = True,
                  scan_id: str = "") -> dict:
    """
    Runs full deep analysis on one site that has already cleared triage.
    Returns the profile dict (also persisted). Never raises — a failure is
    recorded as a failed profile so the pipeline keeps moving.
    """
    site_id = site["id"]
    progress = progress_cb or (lambda event, data: None)
    db.start_deep_profile(site_id)
    progress("deep_analysis_started", {"site_id": site_id, "url": site["url"]})

    try:
        # --- 1. Browse the site thoroughly (existing navigator, all safety rules intact) ---
        investigate_site(
            site, headless=True, progress_cb=progress_cb, should_stop=should_stop,
            allow_signup=allow_signup, deep_wallet_hunt=deep_wallet_hunt,
        )

        pages = db.pages_for_site(site_id)
        triage = db.get_triage(site_id) or {}

        # --- 2. Content evidence ---
        home_page = pages[0] if pages else {}
        home_html = _read_page_html(home_page)
        site_title = home_page.get("title", "") or ""
        site_description = _extract_meta_description(home_html)

        important_text_parts = []
        keywords_found = []
        page_texts = {}
        page_htmls = {}
        for page in pages:
            text = _read_page_text(page)
            page_html = _read_page_html(page)
            if page_html:
                page_htmls[page.get("url", "")] = page_html
            if not text:
                continue
            page_texts[page.get("url", "")] = text
            keywords_found.extend(_collect_keywords(text, page.get("url", "")))
            if page.get("page_type") in ("deposit", "wallet", "funding", "investment", "trading"):
                important_text_parts.append(f"[{page.get('page_type','').upper()}] {text[:1200]}")
            elif not important_text_parts:
                important_text_parts.append(f"[HOME] {text[:1200]}")

        important_text = "\n\n".join(important_text_parts)[:DEEP_ANALYSIS_IMPORTANT_TEXT_CHARS]

        # Dedupe keywords while preserving first-seen page attribution.
        seen_kw = set()
        deduped_keywords = []
        for item in keywords_found:
            key = (item["keyword"], item["category"])
            if key not in seen_kw:
                seen_kw.add(key)
                deduped_keywords.append(item)

        deposit_pages = [
            {"url": p.get("url"), "page_type": p.get("page_type"), "title": p.get("title")}
            for p in pages
            if p.get("page_type") in ("deposit", "wallet", "funding", "trading", "investment")
        ]

        # --- 2b. Harvest reusable public indicators into the correlation graph ---
        # Every value recorded here is an OBSERVED FACT with its own source URL
        # and method; the correlation engine later derives relationships from them.
        try:
            indicators_found = extract_all_indicators(
                site, pages, page_texts, page_htmls, scan_id=scan_id)
            progress("indicators_extracted", {
                "site_id": site_id, "count": indicators_found.get("total", 0)})
        except Exception as e:
            logger.warning("Indicator extraction failed for %s: %s", site.get("url"), e)
            indicators_found = {}

        # --- 2c. Structured deposit options per deposit-style page ---
        site_wallets_for_pages = db.wallets_for_site(site_id)
        deposit_option_count = 0
        for page in pages:
            page_url = page.get("url", "")
            text = page_texts.get(page_url, "")
            page_html = page_htmls.get(page_url, "")
            if not text and not page_html:
                continue
            is_deposit, signal = page_is_deposit_page(
                page_url, page.get("title", ""), text)
            if not (is_deposit or page.get("page_type") in
                    ("deposit", "wallet", "funding", "trading")):
                continue

            wallets_on_page = [
                {"address": w["address"], "network": w["network"], "wallet_id": w["id"]}
                for w in site_wallets_for_pages if w["address"] in text or w["address"] in page_html
            ]
            for option in extract_deposit_options(page_url, text, page_html, wallets_on_page):
                db.record_deposit_option(
                    site_id=site_id, page_url=option["page_url"], method=option["method"],
                    network=option.get("network", ""), wallet_id=option.get("wallet_id"),
                    label=option.get("label", ""), min_amount=option.get("min_amount", ""),
                    instructions=option.get("instructions", ""),
                    page_id=page.get("id"), screenshot_path=page.get("screenshot_path", ""),
                    scan_id=scan_id,
                )
                deposit_option_count += 1
        if deposit_option_count:
            progress("deposit_options_found", {
                "site_id": site_id, "count": deposit_option_count})

        # --- 3. Wallets + validation ---
        wallets = db.wallets_for_site(site_id)
        validated_wallets = []
        any_valid_wallet = False
        any_wallet_activity = False
        for wallet in wallets:
            validation = validate_wallet(wallet["address"], wallet["network"])
            db.save_wallet_validation(wallet["id"], validation)
            if validation.get("format_valid"):
                any_valid_wallet = True
            if validation.get("activity_available") and validation.get("tx_count"):
                any_wallet_activity = True
            validated_wallets.append({**wallet, **validation})
            progress("wallet_validated", {
                "site_id": site_id, "address": wallet["address"],
                "network": wallet["network"], "valid": bool(validation.get("format_valid")),
            })

        # --- 4. Infrastructure, relationships, registration ---
        domain = site.get("domain") or urlparse(site["url"]).netloc
        infra_disc = SharedInfrastructureDiscoverer()
        own_fingerprint = infra_disc._fingerprint(domain)

        other_sites = [s for s in db.list_sites(limit=500) if s["id"] != site_id]
        known_fingerprints = {}
        related_domains = []
        for other in other_sites[:40]:  # bounded: fingerprinting costs a DNS lookup each
            fingerprint = infra_disc._fingerprint(other["domain"])
            known_fingerprints[other["domain"]] = fingerprint
            if fingerprint.get("ip") and fingerprint["ip"] == own_fingerprint.get("ip"):
                related_domains.append({
                    "domain": other["domain"], "relation": "shared_ip",
                    "detail": f"resolves to the same IP ({fingerprint['ip']})",
                })

        # Wallet reuse is a very strong relationship signal.
        for wallet in wallets:
            for other in db.wallet_seen_elsewhere(wallet["address"], wallet["network"], site_id):
                related_domains.append({
                    "domain": other["domain"], "relation": "shared_wallet",
                    "detail": f"uses the same {wallet['network']} address {wallet['address']}",
                })

        shared_infrastructure = {
            "ip": own_fingerprint.get("ip"),
            "nameservers": own_fingerprint.get("nameservers", []),
            "matches": [r for r in related_domains if r["relation"] == "shared_ip"],
        }

        # Template similarity against other scanned sites.
        template_disc = TemplateSimilarityDiscoverer()
        template_matches = []
        own_pages_with_html = [p for p in pages if p.get("html_snapshot_path")]
        if own_pages_with_html:
            own_fp = template_disc.fingerprint_html_file(own_pages_with_html[0]["html_snapshot_path"])
            if own_fp:
                other_fps = {}
                for other in other_sites[:40]:
                    other_pages = [p for p in db.pages_for_site(other["id"])
                                    if p.get("html_snapshot_path")]
                    if other_pages:
                        fingerprint = template_disc.fingerprint_html_file(
                            other_pages[0]["html_snapshot_path"])
                        if fingerprint:
                            other_fps[other["domain"]] = fingerprint
                for matched_domain, similarity in template_disc.find_matches(own_fp, other_fps):
                    template_matches.append({"domain": matched_domain,
                                              "similarity": round(similarity, 3)})
                    related_domains.append({
                        "domain": matched_domain, "relation": "shared_template",
                        "detail": f"page structure {similarity:.0%} similar (likely same builder)",
                    })

        age_days = domain_age_days(domain)
        registration_info = {"domain_age_days": age_days}

        # --- 5. Contact info and social links ---
        combined_text = important_text + " " + home_html
        contact_info, social_links = extract_contacts_and_socials(combined_text)

        # --- 6. Threat intelligence ---
        threat_intel = check_threat_intel(domain, [w["address"] for w in wallets])

        # --- 7. Confidence + flag reasons ---
        triage_categories = [i["category"] for i in triage.get("indicators", [])]
        evidence_present = {
            "validated_wallet": any_valid_wallet,
            "wallet_has_activity": any_wallet_activity,
            "deposit_page": bool(deposit_pages),
            "multiple_triage_categories": triage.get("indicator_count", 0) >= 3,
            "new_domain": age_days is not None and age_days <= 90,
            "shared_infrastructure": bool(shared_infrastructure["matches"]),
            "template_match": bool(template_matches),
            "threat_intel_hit": any(t.get("verdict") in ("malicious", "suspicious")
                                     for t in threat_intel),
            "offplatform_contact": bool(contact_info.get("telegram") or contact_info.get("whatsapp")),
        }
        confidence, contributing = compute_confidence(evidence_present)

        flag_reasons = _build_flag_reasons(
            triage, validated_wallets, deposit_pages, age_days,
            shared_infrastructure, template_matches, threat_intel, contact_info)

        evidence_summary = _build_evidence_summary(
            domain, confidence, contributing, validated_wallets, deposit_pages,
            related_domains, threat_intel)

        screenshots = [
            {"path": p.get("screenshot_path"), "label": f"{p.get('page_type','page')}: {p.get('url','')}"}
            for p in pages if p.get("screenshot_path")
        ]

        profile = {
            "status": "complete",
            "domain": domain,
            "full_url": site["url"],
            "site_title": site_title,
            "site_description": site_description,
            "risk_score": site.get("score") or triage.get("triage_score", 0),
            "confidence_score": confidence,
            "flag_reasons": flag_reasons,
            "indicator_categories": sorted(set(triage_categories)),
            "important_text": important_text,
            "keywords_found": deduped_keywords,
            "deposit_pages": deposit_pages,
            "domain_age_days": age_days,
            "registration_info": registration_info,
            "related_domains": related_domains,
            "shared_infrastructure": shared_infrastructure,
            "template_matches": template_matches,
            "contact_info": contact_info,
            "social_links": social_links,
            "threat_intel": threat_intel,
            "discovery_source": site.get("source", ""),
            "screenshots": screenshots,
            "evidence_summary": evidence_summary,
        }

        db.save_deep_profile(site_id, profile)
        db.add_timeline_event(
            site_id, "deep_analysis_complete", "derived",
            f"Deep analysis complete — {confidence:.0%} confidence",
            evidence_summary, url=site["url"],
        )
        progress("deep_analysis_finished", {
            "site_id": site_id, "url": site["url"], "confidence": confidence,
            "high_confidence": confidence >= HIGH_CONFIDENCE_THRESHOLD,
            "wallets": len(validated_wallets),
        })
        return profile

    except Exception as e:
        logger.exception("Deep analysis failed for %s", site.get("url"))
        db.fail_deep_profile(site_id, f"Deep analysis error: {e}")
        progress("deep_analysis_failed", {"site_id": site_id, "error": str(e)})
        return {"status": "failed", "error": str(e)}


def _build_flag_reasons(triage, wallets, deposit_pages, age_days, infra,
                         templates, threat_intel, contacts) -> list:
    """Plain-language reasons a human reviewer can read at a glance."""
    reasons = []
    for indicator in triage.get("indicators", []):
        reasons.append(indicator.get("detail", indicator.get("category", "")))

    valid = [w for w in wallets if w.get("format_valid")]
    if valid:
        networks = sorted({w["network"] for w in valid})
        reasons.append(
            f"{len(valid)} checksum-validated wallet address(es) found ({', '.join(networks)})")
    active = [w for w in valid if w.get("tx_count")]
    if active:
        reasons.append(
            f"{len(active)} wallet(s) show on-chain activity — funds have actually moved through them")

    if deposit_pages:
        reasons.append(f"{len(deposit_pages)} deposit/withdrawal page(s) reached and captured")
    if age_days is not None and age_days <= 30:
        reasons.append(f"Domain registered only {age_days} days ago")
    elif age_days is not None and age_days <= 90:
        reasons.append(f"Domain is recent ({age_days} days old)")
    if infra.get("matches"):
        reasons.append(
            f"Shares hosting infrastructure with {len(infra['matches'])} other known site(s)")
    if templates:
        reasons.append(
            f"Page template matches {len(templates)} other site(s) — likely same operator/builder")
    for hit in threat_intel:
        if hit.get("verdict") in ("malicious", "suspicious"):
            reasons.append(f"Threat-intel match ({hit.get('source')}): {hit.get('detail')}")
    if contacts.get("telegram") or contacts.get("whatsapp"):
        reasons.append("Support offered only through off-platform messaging (Telegram/WhatsApp)")
    return reasons


def _build_evidence_summary(domain, confidence, contributing, wallets,
                             deposit_pages, related, threat_intel) -> str:
    valid_wallets = [w for w in wallets if w.get("format_valid")]
    parts = [
        f"{domain} scored {confidence:.0%} confidence based on "
        f"{len(contributing)} independent evidence type(s): {', '.join(contributing) or 'none'}."
    ]
    if valid_wallets:
        details = []
        for wallet in valid_wallets[:5]:
            activity = ""
            if wallet.get("tx_count"):
                activity = f", {wallet['tx_count']} txs"
                if wallet.get("total_received"):
                    activity += f", received {wallet['total_received']}"
            details.append(f"{wallet['network']}:{wallet['address']}{activity}")
        parts.append("Validated wallets — " + "; ".join(details) + ".")
    if deposit_pages:
        parts.append(f"Deposit/withdrawal pages captured: "
                      + ", ".join(p["url"] for p in deposit_pages[:5]) + ".")
    if related:
        parts.append(f"Linked to {len(related)} related domain(s) via shared "
                      "wallets/infrastructure/templates.")
    hits = [t for t in threat_intel if t.get("verdict") in ("malicious", "suspicious")]
    if hits:
        parts.append(f"{len(hits)} threat-intelligence match(es).")
    return " ".join(parts)
