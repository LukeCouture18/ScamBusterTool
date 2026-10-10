"""
One candidate, however many campaigns found it.

Before v0.6, each campaign kept its own idea of what it had seen. A domain
surfacing in five campaigns was five candidates' worth of work: triaged five
times, scored five times, and — worse — counted five times when judging which
techniques were producing.

Deduplication fixes the waste. But the interesting half is the other
direction: *rediscovery is information*. A domain that three unrelated
campaigns reach independently, through different indicators, is better
corroborated than one only ever seen once. Collapsing duplicates without
recording that would throw away the strongest signal in the pile.

So every sighting is kept, the candidate is stored once, and the count of
INDEPENDENT campaigns that reached it becomes a corroboration signal.

WHAT COUNTS AS THE SAME CANDIDATE
---------------------------------
The registered domain, normalised: case folded, www stripped, port removed,
trailing dot removed, and IDN punycode left as-is (converting it would merge
domains that are genuinely different registrations). Subdomains are NOT merged
into their parent — app.example.test and example.test are separate sites that
can be operated by different people, and merging them would silently move
evidence between them.
"""
import logging

from app import db
from app.config import DEDUP_CORROBORATION_CAMPAIGNS

logger = logging.getLogger("scamhunter.dedup")


def canonical_domain(value: str) -> str:
    """
    Normalises a domain or URL to the key used for deduplication.
    Conservative on purpose: it only removes things that cannot change which
    registration is meant.
    """
    if not value:
        return ""
    domain = db.domain_of(value if "://" in value else f"http://{value}")
    domain = domain.split(":")[0].strip().strip(".").lower()
    if domain.startswith("www."):
        domain = domain[4:]
    return domain


def register(url_or_domain: str, site_id: int = None, campaign_key: str = "",
             source: str = "", pivot_type: str = "") -> dict:
    """
    Records that a campaign reached this candidate. Returns whether it is new,
    and how well corroborated it now is.
    """
    domain = canonical_domain(url_or_domain)
    if not domain:
        return {"domain": "", "first_time": False, "corroborated": False,
                "explanation": "Empty or unparseable domain."}

    result = db.register_candidate(domain, site_id=site_id, campaign_key=campaign_key,
                                   source=source, pivot_type=pivot_type)
    campaigns = result["distinct_campaigns"]
    corroborated = campaigns >= DEDUP_CORROBORATION_CAMPAIGNS

    if result["first_time"]:
        explanation = (f"First sighting of {domain}"
                       + (f", from campaign {campaign_key}" if campaign_key else "") + ".")
    elif result["new_sighting"]:
        explanation = (
            f"{domain} was already known and has now been reached again"
            + (f" by campaign {campaign_key}" if campaign_key else "")
            + (f" via {pivot_type}" if pivot_type else "")
            + f". {campaigns} independent campaign(s) have now reached it"
            + (" — independent routes to the same domain corroborate each other, which is "
               "worth more than the same route repeated." if corroborated else ".")
        )
    else:
        explanation = (f"{domain} has already been reached by this exact "
                       "campaign/source/technique combination; nothing new was recorded.")

    return {"domain": domain, "first_time": result["first_time"],
            "new_sighting": result["new_sighting"],
            "distinct_campaigns": campaigns,
            "times_rediscovered": result["times_rediscovered"],
            "corroborated": corroborated, "explanation": explanation,
            "evidence_class": "derived"}


def corroboration_bonus(url_or_domain: str) -> dict:
    """
    How much independent rediscovery should raise a candidate. Small and
    bounded: corroboration is real evidence but it is about our own coverage,
    not about the site, so it must not dominate the evidence actually observed
    on the page.
    """
    domain = canonical_domain(url_or_domain)
    record = db.get_candidate_registration(domain) if domain else None
    if not record:
        return {"bonus": 0.0, "explanation": "Not in the candidate registry."}

    campaigns = record.get("distinct_campaigns") or 1
    sources = record.get("distinct_sources") or []

    if campaigns < DEDUP_CORROBORATION_CAMPAIGNS and len(sources) < 2:
        return {"bonus": 0.0, "distinct_campaigns": campaigns,
                "explanation": (f"Reached by {campaigns} campaign(s) and {len(sources)} "
                                "source(s) — not independently corroborated, so no bonus.")}

    bonus = min(0.12, 0.04 * (campaigns - 1) + 0.03 * (len(sources) - 1))
    return {
        "bonus": round(bonus, 3), "distinct_campaigns": campaigns,
        "distinct_sources": sources,
        "explanation": (f"Reached independently by {campaigns} campaign(s) across "
                        f"{len(sources)} source(s), which corroborates the lead "
                        f"(+{bonus:.2f}). This reflects how many of our own routes "
                        "converged on the domain — it says nothing about the domain."),
        "evidence_class": "derived",
    }


def already_processed(url_or_domain: str, campaign_key: str) -> bool:
    """
    Whether this campaign has already handled this candidate — the cheap check
    that stops a campaign re-triaging what it has already been through.
    """
    domain = canonical_domain(url_or_domain)
    if not domain:
        return False
    return any(s.get("campaign_key") == campaign_key
               for s in db.sightings_for_candidate(domain))


def dedup_report(limit: int = 100) -> dict:
    """What has been seen more than once, and by how many independent routes."""
    multi = db.multi_campaign_candidates(
        min_campaigns=DEDUP_CORROBORATION_CAMPAIGNS, limit=limit)
    with db.get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM candidate_registry").fetchone()["c"]
        sightings = conn.execute("SELECT COUNT(*) c FROM candidate_sightings").fetchone()["c"]

    return {
        "unique_candidates": total,
        "total_sightings": sightings,
        "duplicate_sightings_avoided": max(0, sightings - total),
        "corroborated": [
            {"domain": r["canonical_domain"], "distinct_campaigns": r["distinct_campaigns"],
             "times_rediscovered": r["times_rediscovered"],
             "sources": r["distinct_sources"], "first_campaign": r["first_campaign_key"],
             "evidence_class": "derived"}
            for r in multi
        ],
        "note": ("Rediscovery is kept rather than discarded: a domain several independent "
                 "campaigns reach is better corroborated than one seen once. Corroboration "
                 "describes our coverage converging, not the domain itself."),
    }
