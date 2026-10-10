"""
Deciding which candidates deserve expensive attention.

Deep analysis is the costly stage — a browser, several page loads, screenshots.
A campaign routinely surfaces more candidates than its deep-analysis budget can
cover, so something has to choose. This module is that choice, made explicit.

WHAT RAISES A CANDIDATE
-----------------------
    categories    how many INDEPENDENT evidence categories fired (v0.5)
    connection    how strongly it ties back to the campaign's own evidence
    wallet        a payment address was actually observed on it
    deposit       a deposit or payment route was actually found
    recency       the domain is newly registered, where that is known
    activity      it responded, and cleared triage
    convergence   independent discovery methods arrived at it separately

INDEPENDENCE IS THE POINT (v0.5)
--------------------------------
The largest single factor is how many independent evidence categories fired,
not how many indicators did. Fifteen indicators from one category is one thing
shouting; a payment address plus a contact handle plus a deposit route is three
unrelated things agreeing, and only the second is worth expensive attention.
Categories were chosen to fail independently — a copied template says nothing
about whether the contact handle is real, and neither says anything about
whether a deposit route exists — so several firing together multiplies
confidence in a way that repetition within one never can.

EVERY FACTOR IS EVIDENCE-GATED
------------------------------
A factor contributes only when there is a stored observation behind it. An
unknown registration date scores zero, it does not score "probably new" — the
absence of evidence never becomes evidence. This matters because these scores
decide where the expensive attention goes, and a score built partly on
guesswork sends it to the wrong place while looking just as confident.

Each score comes with the list of factors that fired and what each was worth,
so "why was this one picked over that one?" is always answerable.
"""
import logging

from app import db

logger = logging.getLogger("scamhunter.candidate_priority")

# Weights. Connection to existing evidence dominates: inside a campaign, that
# is the thing the candidate is actually being judged on. A wallet is next —
# it is the single most useful artifact to come away with.
WEIGHTS = {
    "independent_categories": 0.22,   # v0.5: the strongest single signal
    "connection": 0.24,
    "wallet_observed": 0.18,
    "deposit_observed": 0.14,
    "convergence": 0.10,
    "newly_registered": 0.07,
    "responsive": 0.05,
}

# How many independent categories count as a full score. Three unrelated things
# agreeing is a strong candidate; demanding more than that would mean rejecting
# good leads for not being perfect ones.
CATEGORIES_FOR_FULL_SCORE = 3

# A domain registered within this many days is treated as new. Scam
# infrastructure is typically days-to-weeks old, so this is a real signal —
# but only where a registration date was actually retrieved.
NEW_DOMAIN_DAYS = 120


def score_candidate(site_id: int, connection_score: float = None) -> dict:
    """
    Returns {"priority": 0..1, "factors": [...], "explanation": str}.
    Factors list only what fired, each with the evidence behind it.
    """
    site = db.get_site(site_id)
    if not site:
        return {"priority": 0.0, "factors": [], "explanation": f"No site {site_id}."}

    factors = []

    # --- v0.5: how many INDEPENDENT evidence categories fired ---
    # Imported here rather than at module scope because the emitter imports
    # this module, and the category map lives with the send gate that uses it.
    from app.integration.v4.emitter import evidence_categories
    categories = evidence_categories(site_id)
    if len(categories) > 1:
        # One category is the baseline, not evidence of agreement — the score
        # measures corroboration, so it counts categories BEYOND the first.
        extra = len(categories) - 1
        factors.append({
            "factor": "independent_categories",
            "weight": WEIGHTS["independent_categories"],
            "value": round(min(1.0, extra / (CATEGORIES_FOR_FULL_SCORE - 1)), 3),
            "evidence": (f"{len(categories)} independent evidence categories fired "
                         f"({', '.join(sorted(categories))}). These fail independently of "
                         "each other, so several agreeing is stronger than any number of "
                         "indicators from one of them."),
            "evidence_class": "derived",
        })

    # --- connection back to the campaign's own evidence ---
    if connection_score is None:
        convergence = db.get_convergence(site_id)
        connection_score = convergence["connection_score"] if convergence else 0.0
    if connection_score > 0:
        factors.append({
            "factor": "connection", "weight": WEIGHTS["connection"],
            "value": round(min(1.0, connection_score), 3),
            "evidence": (f"Connection score {connection_score:.2f} from recorded discovery "
                         "paths back to this campaign's starting evidence."),
            "evidence_class": "derived",
        })

    indicators = db.indicators_for_site(site_id)
    by_type = {}
    for row in indicators:
        by_type.setdefault(row["indicator_type"], []).append(row)

    # --- a payment address was actually seen ---
    wallets = by_type.get("wallet", [])
    if wallets:
        factors.append({
            "factor": "wallet_observed", "weight": WEIGHTS["wallet_observed"], "value": 1.0,
            "evidence": (f"{len(wallets)} wallet address(es) observed on this site"
                         + (f", first at {wallets[0].get('source_url')}"
                            if wallets[0].get("source_url") else "") + "."),
            "evidence_class": "observed",
        })

    # --- a deposit route was actually found ---
    deposits = db.deposit_options_for_site(site_id, only_current=True)
    if deposits:
        factors.append({
            "factor": "deposit_observed", "weight": WEIGHTS["deposit_observed"], "value": 1.0,
            "evidence": (f"{len(deposits)} deposit or payment option(s) found, "
                         f"including {deposits[0].get('method') or 'a payment method'}"
                         + (f" on {deposits[0].get('network')}" if deposits[0].get("network") else "")
                         + "."),
            "evidence_class": "observed",
        })

    # --- independent methods arrived at it separately ---
    paths = db.paths_for_site(site_id)
    distinct = {p["pivot_type"] for p in paths}
    if len(distinct) > 1:
        factors.append({
            "factor": "convergence", "weight": WEIGHTS["convergence"],
            "value": round(min(1.0, (len(distinct) - 1) / 2.0), 3),
            "evidence": (f"Reached by {len(distinct)} different discovery techniques "
                         f"({', '.join(sorted(distinct))}), which is more informative than "
                         "several hits from one technique."),
            "evidence_class": "derived",
        })

    # --- newly registered, WHERE THAT IS KNOWN ---
    profile = db.get_deep_profile(site_id)
    age_days = (profile or {}).get("domain_age_days")
    if age_days is not None and age_days >= 0:
        if age_days <= NEW_DOMAIN_DAYS:
            factors.append({
                "factor": "newly_registered", "weight": WEIGHTS["newly_registered"],
                "value": round(1.0 - (age_days / NEW_DOMAIN_DAYS), 3),
                "evidence": (f"Domain registration is {int(age_days)} day(s) old, within the "
                             f"{NEW_DOMAIN_DAYS}-day window treated as newly created."),
                "evidence_class": "observed",
            })
    # No registration date: nothing is added. Unknown age is not young.

    # --- v0.7: independent rediscovery across campaigns (was dead code in
    # v0.6 — measured but never applied). Small and bounded: it describes our
    # own coverage converging, not the site.
    try:
        from app.discovery.dedup import corroboration_bonus
        corroboration = corroboration_bonus(site["url"])
        if corroboration.get("bonus"):
            factors.append({
                "factor": "cross_campaign_corroboration",
                "weight": 1.0, "value": corroboration["bonus"],
                "evidence": corroboration["explanation"],
                "evidence_class": "derived",
            })
    except Exception:                          # noqa: BLE001
        pass

    # --- it is actually up ---
    triage = db.get_triage(site_id)
    if triage and triage.get("http_status") and int(triage["http_status"]) < 400:
        factors.append({
            "factor": "responsive", "weight": WEIGHTS["responsive"], "value": 1.0,
            "evidence": (f"Responded with HTTP {triage['http_status']} during triage, so it is "
                         "live rather than parked or gone."),
            "evidence_class": "observed",
        })

    priority = round(min(1.0, sum(f["weight"] * f["value"] for f in factors)), 3)
    observed = [f for f in factors if f["evidence_class"] == "observed"]

    if factors:
        explanation = (
            f"Priority {priority:.2f} from {len(factors)} factor(s), "
            f"{len(observed)} of them observed directly: "
            + "; ".join(f"{f['factor']} ({f['weight'] * f['value']:.2f})" for f in factors)
            + ". Priority decides only where limited analysis time goes; it is not a "
              "judgement about the site, which still has to earn its own confidence."
        )
    else:
        explanation = (
            f"Priority {priority:.2f}: nothing has been observed on this candidate yet, so "
            "there is no evidence to raise it above any other. It is not ruled out — it has "
            "simply not earned expensive analysis ahead of candidates that have.")

    return {"site_id": site_id, "domain": site["domain"], "priority": priority,
            "factors": factors, "explanation": explanation, "evidence_class": "derived"}


def rank_candidates(site_ids: list, connection_scores: dict = None) -> list:
    """Highest priority first. Ties keep their original order, which is the
    order the campaign found them in — earlier means closer to the seed."""
    scores = connection_scores or {}
    ranked = [score_candidate(s, scores.get(s)) for s in site_ids]
    return sorted(ranked, key=lambda r: -r["priority"])
