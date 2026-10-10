"""
The Discovery Pivot Engine.

Ordinary discovery runs the searches you thought of in advance. This engine
learns new searches from what it finds:

    Seed -> Indicators -> Pivots -> New Sites -> New Indicators -> More Pivots

Each arrow is one wave. The engine starts from sites you already trust, turns
their observable indicators into searchable questions, runs those questions
against passive public sources, and feeds anything it finds back in as a new
seed — bounded by depth, budget and evidence requirements so it expands
deliberately rather than endlessly.

WHAT THIS DOES AND DOESN'T CLAIM
--------------------------------
Every output of this engine is a LEAD, not a verdict. Finding that two domains
present the same TLS certificate, analytics ID or wallet address is an observed
fact about shared indicators. It is *not* a finding that the domains have the
same owner, that anyone controls both, or that the newly-found domain is
malicious — shared hosting, shared templates, CDN reuse, recycled certificates,
compromised sites and plain coincidence all produce the same signals.

So discovered sites enter the normal pipeline as candidates and must earn their
own confidence through triage and deep analysis, exactly like any other site.
The pivot engine decides what to *look at next*. It never decides what is true.

RUNAWAY PREVENTION
------------------
Five independent brakes, all configurable:
  1. depth limit        — how many waves out from the seed
  2. candidate budget   — total new sites per run
  3. lead budget        — total pivots executed per run
  4. deduplication      — a lead key is executed once, ever, across all runs
  5. evidence floor     — indicators too weak or too common never become pivots
Plus per-source rate limiting and a wall-clock time limit.
"""
import logging
import re
import socket
import time
import uuid

from app import db
from app.config import (
    PIVOT_MAX_DEPTH, PIVOT_MAX_NEW_SITES, PIVOT_MAX_LEADS, PIVOT_MAX_SECONDS,
    PIVOT_MIN_INDICATOR_STRENGTH, PIVOT_MAX_INDICATOR_SITE_COUNT,
    PIVOT_MIN_SEED_CONFIDENCE, PIVOT_REQUEST_DELAY_SECONDS,
    PIVOT_MAX_CANDIDATES_PER_LEAD,
)
from app.db import INDICATOR_STRENGTH

logger = logging.getLogger("scamhunter.pivot_engine")


# ---------------------------------------------------------------------------
# Which indicator types can become pivots, and how we search each one.
# An indicator is only pivotable if there is a PASSIVE public way to ask
# "what else shows this?" — otherwise it is evidence, not a lead generator.
# ---------------------------------------------------------------------------

PIVOTABLE = {
    # indicator_type: (pivot_type, human question)
    "cert_sha256":   ("cert_san", "which other domains appear on this TLS certificate?"),
    "wallet":        ("wallet_reuse", "which other known sites show this same address?"),
    "analytics_id":  ("analytics_reuse", "which other known sites embed this same tag ID?"),
    "telegram":      ("contact_reuse", "which other known sites publish this same handle?"),
    "whatsapp":      ("contact_reuse", "which other known sites publish this same number?"),
    "email":         ("contact_reuse", "which other known sites publish this same address?"),
    "template_hash": ("template_reuse", "which other known sites use this same page structure?"),
    "favicon_hash":  ("favicon_reuse", "which other known sites serve this same icon?"),
    "ip":            ("ip_neighbour", "which other known sites resolve to this same IP?"),
    "nameserver":    ("ns_neighbour", "which other known sites use these same nameservers?"),
}

# Domain-shape pivots don't come from an indicator row; they come from the
# seed's own name. Kept separate because they generate *guesses* to verify,
# not lookups of recorded facts.
DOMAIN_SHAPE_PIVOTS = ("domain_pattern",)


def _resolves(domain: str) -> bool:
    """
    v0.6: every outbound lookup is metered. Being refused is not an error —
    it means "not now", and the caller treats the name as unresolved rather
    than working around the limit.
    """
    from app.discovery.rate_limiter import acquire, note_success
    verdict = acquire("dns")
    if not verdict["allowed"]:
        logger.debug("DNS lookup for %s skipped: %s", domain, verdict["reason"])
        return False
    try:
        socket.setdefaulttimeout(3)
        socket.gethostbyname(domain)
        note_success("dns")
        return True
    except Exception:
        return False


def _lead_key(pivot_type: str, value: str) -> str:
    return f"{pivot_type}|{(value or '').strip().lower()}"


class PivotBudget:
    """Tracks every brake in one place so limits can't be bypassed piecemeal."""

    def __init__(self, max_depth, max_new_sites, max_leads, max_seconds):
        self.max_depth = max_depth
        self.max_new_sites = max_new_sites
        self.max_leads = max_leads
        self.max_seconds = max_seconds
        self.started = time.time()
        self.new_sites = 0
        self.leads_executed = 0
        self.stop_reason = None

    def exhausted(self) -> bool:
        if self.new_sites >= self.max_new_sites:
            self.stop_reason = "candidate_limit"
            return True
        if self.leads_executed >= self.max_leads:
            self.stop_reason = "lead_limit"
            return True
        if (time.time() - self.started) >= self.max_seconds:
            self.stop_reason = "time_limit"
            return True
        return False

    def remaining_sites(self) -> int:
        return max(0, self.max_new_sites - self.new_sites)


# ---------------------------------------------------------------------------
# Lead generation: turn a site's indicators into searchable pivots
# ---------------------------------------------------------------------------

def generate_leads_for_site(run_id: int, site: dict, depth: int,
                             min_strength: float = PIVOT_MIN_INDICATOR_STRENGTH) -> dict:
    """
    Converts one site's observed indicators into queued pivot leads.

    The evidence floor lives here: an indicator becomes a lead only if it is
    discriminating enough to be worth chasing (strength) and not so widespread
    that it describes the internet rather than this site (site_count).
    """
    created = 0
    skipped = []

    for indicator in db.indicators_for_site(site["id"]):
        itype = indicator["indicator_type"]
        mapping = PIVOTABLE.get(itype)
        if not mapping:
            continue
        pivot_type, _question = mapping

        strength = INDICATOR_STRENGTH.get(itype, 0.3)
        if strength < min_strength:
            skipped.append(f"{itype} (strength {strength:.2f} below floor)")
            continue

        # v0.5: the static site-count caps plus the measured gate — an indicator
        # that has returned volume without results stops consuming budget even
        # when its shape still looks discriminating.
        from app.discovery.indicator_noise import should_pivot_on
        allowed, refusal = should_pivot_on(itype, indicator["value"],
                                            site_count=indicator["site_count"])
        if not allowed:
            skipped.append(f"{itype} {str(indicator['value'])[:24]}: {refusal}")
            continue

        key = _lead_key(pivot_type, indicator["value"])
        if db.lead_already_seen(key):
            skipped.append(f"{itype} {indicator['value'][:24]} already explored in a previous run")
            continue

        lead_id = db.add_pivot_lead(
            run_id, key, pivot_type, itype, indicator["value"],
            site["id"], depth, strength, indicator_id=indicator.get("indicator_id"))
        if lead_id:
            created += 1

    # Domain-shape lead (one per site, generated from the name itself).
    domain = (site.get("domain") or "").split(":")[0]
    if domain:
        key = _lead_key("domain_pattern", domain)
        if not db.lead_already_seen(key):
            if db.add_pivot_lead(run_id, key, "domain_pattern", "domain", domain,
                                  site["id"], depth, 0.45):
                created += 1

    return {"created": created, "skipped": skipped}


# ---------------------------------------------------------------------------
# Lead execution: run one pivot against passive public sources
# ---------------------------------------------------------------------------

def execute_lead(lead: dict, budget: PivotBudget) -> list:
    """
    Runs one pivot. Returns candidate dicts:
      {"domain","url","why","link_strength"}
    Never raises — a failing source degrades to "no results".
    """
    pivot_type = lead["pivot_type"]
    value = lead["indicator_value"]

    try:
        if pivot_type == "cert_san":
            return _pivot_cert_san(lead)
        if pivot_type == "domain_pattern":
            return _pivot_domain_pattern(lead, budget)
        # The remaining pivots ask "what else in our own recorded observations
        # shows this indicator?" — passive by construction, no new requests.
        return _pivot_known_indicator(lead)
    except Exception as e:
        logger.warning("Pivot %s failed for %r: %s", pivot_type, value[:40], e)
        return []


def _pivot_cert_san(lead: dict) -> list:
    """
    Domains listed on the same TLS certificate as the origin site.

    Certificate contents are public by design (that's the point of CT logs), so
    reading the SANs off a cert the origin site already served is passive.
    """
    from app.analysis.indicator_extractor import tls_cert_fingerprint

    from app.discovery.rate_limiter import acquire, note_success

    origin = db.get_site(lead["origin_site_id"])
    if not origin:
        return []
    domain = (origin.get("domain") or "").split(":")[0]

    verdict = acquire("crtsh")
    if not verdict["allowed"]:
        logger.info("Certificate pivot on %s deferred: %s", domain, verdict["reason"])
        return []
    cert = tls_cert_fingerprint(domain)
    note_success("crtsh")
    out = []
    for san in (cert.get("sans") or []):
        san = san.lstrip("*.").strip().lower()
        if not san or san == domain or "." not in san:
            continue
        out.append({
            "domain": san,
            "url": f"https://{san}",
            "why": (f"Listed as a Subject Alternative Name on the TLS certificate served by "
                    f"{domain}. Appearing on the same certificate means the two names were "
                    "covered by one issuance — worth checking, though certificates are also "
                    "shared by hosting providers and CDNs across unrelated customers."),
            "link_strength": 0.75,
        })
    return out


def _pivot_known_indicator(lead: dict) -> list:
    """
    Other sites in our own database that recorded the same indicator.

    This is the cheapest and most reliable pivot: it surfaces links that already
    exist in collected evidence but hadn't been connected yet. No network calls.
    """
    itype = lead["indicator_type"]
    value = lead["indicator_value"]
    indicator_id = db.upsert_indicator(itype, value)
    if not indicator_id:
        return []

    out = []
    for site in db.sites_sharing_indicator(indicator_id, exclude_site_id=lead["origin_site_id"]):
        out.append({
            "domain": site["domain"],
            "url": site["url"],
            "site_id": site["id"],
            "why": (f"Also recorded the same {itype} ({value[:48]}) during an earlier scan. "
                    "Both sightings are observed facts; what they imply about any relationship "
                    "between the sites still has to be assessed."),
            "link_strength": INDICATOR_STRENGTH.get(itype, 0.4),
        })
    return out


def _pivot_domain_pattern(lead: dict, budget: PivotBudget) -> list:
    """
    Sibling domain names following the origin's naming shape, DNS-checked.

    These are *guesses*, so they're deliberately the weakest pivot: a resolving
    name that fits a pattern is only a candidate worth a look. Many legitimate
    businesses register numbered or suffixed variants of their own name.
    """
    domain = (lead["indicator_value"] or "").split(":")[0]
    if "." not in domain:
        return []
    root, tld = domain.rsplit(".", 1)
    out = []
    checks = 0

    def try_sibling(candidate, why, strength):
        nonlocal checks
        if checks >= 12 or len(out) >= PIVOT_MAX_CANDIDATES_PER_LEAD:
            return
        checks += 1
        time.sleep(PIVOT_REQUEST_DELAY_SECONDS)
        if _resolves(candidate):
            out.append({"domain": candidate, "url": f"http://{candidate}",
                        "why": why, "link_strength": strength})

    match = re.match(r"^(.*?)(\d{1,3})$", root)
    if match:
        stem, number = match.group(1), int(match.group(2))
        for delta in (1, 2, 3, -1):
            n = number + delta
            if n < 1:
                continue
            try_sibling(f"{stem}{n}.{tld}",
                        f"Numeric sibling of {domain} that resolves in DNS. Sequential naming is "
                        "common in site fleets, but also in ordinary staging/regional setups.",
                        0.40)
    else:
        for suffix in ("1", "2", "pro", "vip", "app"):
            try_sibling(f"{root}{suffix}.{tld}",
                        f"Shares the root name of {domain} with the suffix {suffix!r} and resolves "
                        "in DNS. A weak, shape-based lead only.",
                        0.35)
    return out


# ---------------------------------------------------------------------------
# Path construction
# ---------------------------------------------------------------------------

def build_path(origin_site: dict, lead: dict, candidate: dict, depth: int,
                parent_path: list = None) -> tuple:
    """
    Builds the Discovery Path: the ordered list of hops from an original seed
    to this candidate, plus a one-line rendering for display.
    """
    path = list(parent_path or [])
    if not path:
        path.append({
            "hop": 0, "kind": "seed",
            "domain": origin_site.get("domain"),
            "detail": "Starting point: a site that already reached high confidence on its own evidence.",
        })
    path.append({
        "hop": len(path),
        "kind": "pivot",
        "pivot_type": lead["pivot_type"],
        "indicator_type": lead["indicator_type"],
        "indicator_value": lead["indicator_value"],
        "from_domain": origin_site.get("domain"),
        "detail": candidate["why"],
    })
    path.append({
        "hop": len(path),
        "kind": "candidate",
        "domain": candidate["domain"],
        "detail": f"Reached at depth {depth}.",
    })

    hops = []
    for step in path:
        if step["kind"] == "seed":
            hops.append(f"seed:{step['domain']}")
        elif step["kind"] == "pivot":
            hops.append(f"{step['pivot_type']}({step['indicator_type']}="
                        f"{str(step['indicator_value'])[:28]})")
        else:
            hops.append(step["domain"])
    return path, " → ".join(hops)


# ---------------------------------------------------------------------------
# The expansion loop
# ---------------------------------------------------------------------------

def run_pivot_expansion(seed_site_ids: list = None,
                         min_seed_confidence: float = PIVOT_MIN_SEED_CONFIDENCE,
                         max_depth: int = PIVOT_MAX_DEPTH,
                         max_new_sites: int = PIVOT_MAX_NEW_SITES,
                         max_leads: int = PIVOT_MAX_LEADS,
                         max_seconds: int = PIVOT_MAX_SECONDS,
                         progress_cb=None, should_stop=None) -> dict:
    """
    Runs one full branching expansion.

    Seeds default to sites that already reached high confidence through normal
    analysis. Pivoting from unconfirmed sites would compound uncertainty at
    every hop, which is the opposite of what this is for.
    """
    progress = progress_cb or (lambda e, d: None)
    stop = should_stop or (lambda: False)

    run_key = f"pivot-{uuid.uuid4().hex[:10]}"
    config = {
        "max_depth": max_depth, "max_new_sites": max_new_sites, "max_leads": max_leads,
        "max_seconds": max_seconds, "min_seed_confidence": min_seed_confidence,
        "min_indicator_strength": PIVOT_MIN_INDICATOR_STRENGTH,
    }
    run_id = db.create_pivot_run(run_key, max_depth, config)
    budget = PivotBudget(max_depth, max_new_sites, max_leads, max_seconds)

    # --- Seeds ---
    if seed_site_ids:
        seeds = [db.get_site(sid) for sid in seed_site_ids]
        seeds = [s for s in seeds if s]
    else:
        seeds = []
        for profile in db.list_deep_profiles(min_confidence=min_seed_confidence, limit=25):
            site = db.get_site(profile["site_id"])
            if site:
                seeds.append(site)

    if not seeds:
        db.finish_pivot_run(run_id, stopped_reason="no_seeds", seed_count=0,
                            notes=f"No sites at or above {min_seed_confidence:.0%} confidence.")
        return {
            "run_id": run_id, "run_key": run_key, "seeds": 0, "new_sites": 0,
            "note": (f"No sites at or above {min_seed_confidence:.0%} confidence to pivot from. "
                     "Run deep analysis first — expanding from unconfirmed sites would compound "
                     "uncertainty at every hop."),
        }

    progress("pivot_run_started", {"run_id": run_id, "run_key": run_key,
                                    "seeds": len(seeds), "max_depth": max_depth})

    # --- Wave 0: seed indicators become leads ---
    leads_generated = 0
    for site in seeds:
        result = generate_leads_for_site(run_id, site, depth=0)
        leads_generated += result["created"]
        progress("pivot_leads_generated", {
            "site_id": site["id"], "domain": site["domain"],
            "created": result["created"], "depth": 0})

    # Paths are inherited hop-to-hop so depth-2 sites can explain their full route.
    site_paths = {s["id"]: [{"hop": 0, "kind": "seed", "domain": s["domain"],
                              "detail": "Starting point: already high-confidence on its own evidence."}]
                   for s in seeds}

    candidates_found = 0
    new_sites = 0
    leads_executed = 0
    # Sites whose indicators have already been turned into leads in this run.
    # Seeds count as expanded, since wave 0 above already did exactly that.
    expanded_sites = {s["id"] for s in seeds}

    # --- Expansion waves ---
    # max_depth is expressed in HOPS FROM THE SEED for a discovered site, which
    # is what a user means by "depth 2". Since a lead sitting at depth d yields
    # sites at depth d+1, only leads at depth <= max_depth-1 may execute —
    # capping lead depth at max_depth instead would quietly reach one hop
    # further than configured (caught in testing: max_depth=1 reached depth 2).
    for depth in range(0, max_depth):
        if stop():
            budget.stop_reason = "stopped"
            break
        if budget.exhausted():
            break

        while True:
            if stop():
                budget.stop_reason = "stopped"
                break
            if budget.exhausted():
                break

            batch = db.next_queued_leads(run_id, limit=10, max_depth=depth)
            # Defence in depth: never execute a lead that would place a site
            # beyond the configured hop limit, whatever the loop bounds say.
            batch = [b for b in batch if b["depth"] + 1 <= max_depth]
            if not batch:
                break

            for lead in batch:
                if stop() or budget.exhausted():
                    break

                origin = db.get_site(lead["origin_site_id"])
                if not origin:
                    db.update_pivot_lead(lead["id"], "skipped", skip_reason="origin site missing")
                    continue

                progress("pivot_lead_executing", {
                    "lead_id": lead["id"], "pivot_type": lead["pivot_type"],
                    "indicator": f"{lead['indicator_type']}={lead['indicator_value'][:40]}",
                    "depth": lead["depth"], "origin": origin["domain"]})

                results = execute_lead(lead, budget)
                budget.leads_executed += 1
                leads_executed += 1

                lead_new = 0
                for candidate in results[:PIVOT_MAX_CANDIDATES_PER_LEAD]:
                    if budget.exhausted():
                        break
                    candidates_found += 1

                    domain = candidate["domain"]
                    existing_id = candidate.get("site_id")
                    already_known = bool(existing_id) or db.domain_known(domain)

                    site_id = existing_id
                    if not already_known:
                        site_id = db.add_site(
                            candidate["url"], f"pivot:{lead['pivot_type']}",
                            discovery_confidence=min(0.75, candidate["link_strength"]),
                            discovery_reason=candidate["why"],
                            discovery_category="",
                        )
                        if site_id:
                            new_sites += 1
                            lead_new += 1
                            budget.new_sites += 1
                            progress("site_discovered", {
                                "site_id": site_id, "url": candidate["url"],
                                "source": f"pivot:{lead['pivot_type']}",
                                "confidence": candidate["link_strength"],
                                "reason": candidate["why"]})
                    elif not site_id:
                        with db.get_conn() as conn:
                            row = conn.execute(
                                "SELECT id FROM sites WHERE domain=? LIMIT 1", (domain,)).fetchone()
                            site_id = row["id"] if row else None

                    if not site_id:
                        continue

                    parent = site_paths.get(origin["id"])
                    path, path_text = build_path(origin, lead, candidate,
                                                  lead["depth"] + 1, parent)
                    db.record_discovery_path(
                        run_id, site_id, domain, lead["id"], origin["id"],
                        lead["depth"] + 1, lead["pivot_type"], lead["indicator_type"],
                        lead["indicator_value"], path, path_text, candidate["link_strength"])

                    site_paths.setdefault(site_id, path)

                    db.add_timeline_event(
                        site_id, "discovered", "derived",
                        f"Reached by pivot from {origin['domain']}",
                        f"{candidate['why']} Discovery path: {path_text}",
                        url=candidate["url"])

                    db.log_discovery_event(
                        url=candidate["url"], source=f"pivot:{lead['pivot_type']}",
                        confidence=candidate["link_strength"], reason=candidate["why"],
                        pivot_from_site_id=origin["id"],
                        resulted_in_site_id=(None if already_known else site_id),
                        was_duplicate=already_known)

                    # Feed the next wave. The guard here is "have we already
                    # expanded this site during THIS run?", not "is it new?" —
                    # a site that was already in the database can still be an
                    # unexplored bridge to further candidates, and skipping it
                    # silently truncated the branch (caught in testing: a
                    # known site sharing a Telegram handle with a fourth domain
                    # meant that fourth domain was never reached at all).
                    if lead["depth"] + 1 < max_depth and site_id not in expanded_sites:
                        expanded_sites.add(site_id)
                        child = db.get_site(site_id)
                        if child:
                            gen = generate_leads_for_site(run_id, child, depth=lead["depth"] + 1)
                            leads_generated += gen["created"]

                db.update_pivot_lead(lead["id"], "executed",
                                      candidates_found=len(results), new_sites=lead_new)

            if budget.exhausted() or stop():
                break

    converged = db.recompute_convergence()

    stopped_reason = budget.stop_reason or "completed"
    db.finish_pivot_run(
        run_id, seed_count=len(seeds), leads_generated=leads_generated,
        leads_executed=leads_executed, candidates_found=candidates_found,
        new_sites=new_sites, stopped_reason=stopped_reason)

    progress("pivot_run_finished", {
        "run_id": run_id, "new_sites": new_sites, "leads_executed": leads_executed,
        "stopped_reason": stopped_reason})

    return {
        "run_id": run_id,
        "run_key": run_key,
        "seeds": len(seeds),
        "leads_generated": leads_generated,
        "leads_executed": leads_executed,
        "candidates_found": candidates_found,
        "new_sites": new_sites,
        "converged_sites": converged,
        "stopped_reason": stopped_reason,
        "max_depth": max_depth,
    }


def prioritized_leads(limit: int = 50) -> list:
    """
    Sites reached by pivoting, ranked by how strongly they connect back to the
    original evidence. This is the engine's actual output: a worklist, ordered
    by how much reason there is to look — explicitly not a list of confirmed
    anything.
    """
    rows = db.list_convergence(limit=limit)
    out = []
    for row in rows:
        paths = db.paths_for_site(row["site_id"])
        out.append({
            "site_id": row["site_id"],
            "domain": row["domain"],
            "url": row.get("url"),
            "connection_score": row["connection_score"],
            "path_count": row["path_count"],
            "distinct_pivot_types": row["distinct_pivot_types"],
            "distinct_origin_sites": row["distinct_origin_sites"],
            "min_depth": row["min_depth"],
            "own_confidence": row.get("confidence_score"),
            "summary": row["summary"],
            "evidence_class": "derived",
            "paths": [{
                "pivot_type": p["pivot_type"],
                "indicator_type": p["indicator_type"],
                "indicator_value": p["indicator_value"],
                "origin_domain": p.get("origin_domain"),
                "depth": p["depth"],
                "path_text": p["path_text"],
                "why": (p["path"][1]["detail"] if len(p.get("path") or []) > 1 else ""),
            } for p in paths],
        })
    return out
