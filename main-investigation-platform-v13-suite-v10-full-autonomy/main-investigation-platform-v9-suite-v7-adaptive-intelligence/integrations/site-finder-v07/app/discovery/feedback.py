"""
Learning from what happened after we handed a candidate over.

Everything Site Finder measured before v0.6 was measured by Site Finder: did
our triage pass it, did our scoring like it, did our gate send it. All of that
grades the engine against its own opinion, which is exactly the measurement a
drifting system cannot use to notice it is drifting.

Downstream feedback breaks that loop. When Site Investigator examines one of
our candidates, the Main Platform can return neutral outcome signals: were
deposit pages present, were wallets present, was there infrastructure evidence,
were further relationships observed. That is an independent answer to the only
question that matters about a discovery — *was this worth someone's time?*

WHAT THESE SIGNALS ARE NOT
--------------------------
They are not verdicts about the site. "A deposit page was found" means a
deposit page was found. It does not mean the site is a scam, that anyone has
concluded anything about its operators, or that Site Finder was "right". A
legitimate exchange has deposit pages and wallets too. The signals are used
for exactly one purpose: judging whether a DISCOVERY TECHNIQUE produces leads
that turn out to contain something to investigate. Nothing in this module
writes a conclusion about a site, and `outcome` deliberately uses the words
useful / thin / unreachable rather than anything resembling guilt.

ATTRIBUTION IS SNAPSHOTTED
--------------------------
Credit is assigned to the source, pivots, indicator combination and campaign
that produced the candidate, captured at the moment the discovery was made and
stored with the feedback. A site whose indicators change later cannot
retroactively rewrite which technique deserved the credit.

SMALL SAMPLES ARE NOT EVIDENCE
------------------------------
Usefulness is shrunk toward neutral until there is enough feedback to trust
it, and budget is never reallocated on a handful of results. One unlucky
investigation must not be able to starve a good technique.
"""
import logging

from app import db
from app.config import (
    FEEDBACK_MIN_SAMPLES, FEEDBACK_PRIOR_STRENGTH, FEEDBACK_NEUTRAL_SCORE,
    FEEDBACK_SIGNAL_WEIGHTS,
)

logger = logging.getLogger("scamhunter.feedback")

# The outcome vocabulary. Deliberately about the usefulness of the LEAD, never
# about the nature of the site.
OUTCOMES = ("useful", "thin", "unreachable", "unknown")


def classify_outcome(deposit_pages: int = 0, wallets: int = 0,
                     infrastructure: int = 0, relationships: int = 0,
                     reachable: bool = None, pages_examined: int = 0) -> dict:
    """
    Turns raw downstream counts into one of the four outcome words, with the
    reasoning. Used when the platform sends counts without a classification.
    """
    if reachable is False:
        return {"outcome": "unreachable",
                "detail": ("The site did not respond when it was examined, so there is "
                           "nothing to learn about the candidate's quality either way — "
                           "only that it was not reachable at that moment.")}

    signals = {"deposit_pages": deposit_pages, "wallets": wallets,
               "infrastructure": infrastructure, "relationships": relationships}
    present = [name for name, count in signals.items() if count > 0]

    if not present:
        if pages_examined == 0:
            return {"outcome": "unknown",
                    "detail": "No pages were examined, so nothing was learned."}
        return {"outcome": "thin",
                "detail": (f"{pages_examined} page(s) were examined and none of the signals "
                           "we route candidates on were present. The lead did not carry "
                           "what it looked like it would — this is about the lead, not "
                           "about the site.")}

    found = ", ".join(f"{signals[name]} {name.replace('_', ' ')}" for name in present)
    return {"outcome": "useful",
            "detail": (f"Examination found {found}. That makes this a lead worth having "
                       "surfaced. It says nothing about whether the site is doing anything "
                       "wrong — legitimate services have deposit pages and wallets too.")}


def _attribution_keys(site_id: int, source: str = "", campaign_key: str = "") -> dict:
    """
    What produced this candidate: the source, the pivot types that reached it,
    the combination of indicator types involved, and the campaign. Captured
    from stored discovery paths at feedback time.
    """
    site = db.get_site(site_id) if site_id else None
    paths = db.paths_for_site(site_id) if site_id else []

    pivot_types = sorted({p["pivot_type"] for p in paths if p.get("pivot_type")})
    indicator_types = sorted({p["indicator_type"] for p in paths if p.get("indicator_type")})
    signature = [[p.get("indicator_type"), p.get("indicator_value")] for p in paths]

    return {
        "source": source or (site or {}).get("source") or "unknown",
        "pivot_types": pivot_types,
        "indicator_combo": "+".join(indicator_types) if indicator_types else "",
        "campaign_key": campaign_key,
        "indicator_signature": signature,
    }


def record_outcome(feedback_id: str, domain: str = "", site_id: int = None,
                   investigation_id: str = None, correlation_id: str = None,
                   deposit_pages: int = 0, wallets: int = 0,
                   infrastructure: int = 0, relationships: int = 0,
                   pages_examined: int = 0, reachable: bool = None,
                   outcome: str = None, detail: str = "",
                   campaign_key: str = "") -> dict:
    """
    Records one downstream outcome and credits the techniques behind it.

    Idempotent on feedback_id: the platform may redeliver, and a redelivery
    must not double the attribution counts — otherwise a flaky link would
    silently inflate whichever technique happened to be retried.
    """
    if site_id is None and domain:
        with db.get_conn() as conn:
            row = conn.execute("SELECT id FROM sites WHERE domain=? LIMIT 1",
                               (domain,)).fetchone()
            site_id = row["id"] if row else None

    if db.feedback_exists(feedback_id):
        return {"recorded": False, "reason": "already recorded — attribution not doubled",
                "feedback_id": feedback_id}

    if outcome not in OUTCOMES:
        classified = classify_outcome(deposit_pages, wallets, infrastructure,
                                      relationships, reachable, pages_examined)
        outcome = classified["outcome"]
        detail = detail or classified["detail"]

    keys = _attribution_keys(site_id, campaign_key=campaign_key)

    stored = db.record_feedback(
        feedback_id, site_id=site_id, domain=domain or (db.get_site(site_id) or {}).get("domain", ""),
        investigation_id=investigation_id, correlation_id=correlation_id,
        deposit_pages=deposit_pages, wallets=wallets, infrastructure=infrastructure,
        relationships=relationships, pages_examined=pages_examined, reachable=reachable,
        outcome=outcome, detail=detail, source=keys["source"],
        pivot_types=keys["pivot_types"], indicator_signature=keys["indicator_signature"],
        campaign_key=campaign_key)

    if not stored["recorded"]:
        return {"recorded": False, "reason": stored["reason"], "feedback_id": feedback_id}

    counts = {"examined": 1,
              "useful": 1 if outcome == "useful" else 0,
              "thin": 1 if outcome == "thin" else 0,
              "unreachable": 1 if outcome == "unreachable" else 0,
              "deposit_pages": deposit_pages, "wallets": wallets,
              "infrastructure": infrastructure, "relationships": relationships}

    db.record_attribution("source", keys["source"], **counts)
    for pivot_type in keys["pivot_types"]:
        db.record_attribution("pivot", pivot_type, **counts)
    if keys["indicator_combo"]:
        db.record_attribution("indicator_combo", keys["indicator_combo"], **counts)
    if campaign_key:
        db.record_attribution("campaign", campaign_key, **counts)

    # The site's own record keeps the signal too, as an observation about what
    # an investigator saw — never as a conclusion about the site.
    if site_id:
        db.add_timeline_event(
            site_id, "downstream_feedback", "observed",
            f"Investigation outcome reported: {outcome}",
            (detail or "") + " Recorded to measure whether this discovery route produces "
            "leads worth examining. It is not a finding about the site.")

    return {"recorded": True, "outcome": outcome, "attributed_to": {
        "source": keys["source"], "pivots": keys["pivot_types"],
        "indicator_combo": keys["indicator_combo"], "campaign": campaign_key}}


def compute_usefulness(stats: dict) -> dict:
    """
    Pure function over one attribution row. Returns the usefulness score and
    the arithmetic behind it.

    Two things are combined: how often examination found *something* (the
    useful rate) and how much it found (the weighted signal density). A
    technique whose candidates always have one thin signal is worth less than
    one whose candidates come loaded, and the rate alone cannot see that.
    """
    examined = stats.get("candidates_examined", 0) or 0
    useful = stats.get("useful", 0) or 0
    unreachable = stats.get("unreachable", 0) or 0

    # Unreachable sites teach nothing about the technique — the site was down.
    # Excluding them stops an outage being scored as a technique's failure.
    judgeable = max(0, examined - unreachable)
    useful_rate = (useful / judgeable) if judgeable else 0.0

    density = 0.0
    if judgeable:
        for signal, weight in FEEDBACK_SIGNAL_WEIGHTS.items():
            found = stats.get(signal, 0) or 0
            # Saturating: three deposit pages is not three times as informative
            # as one, it is the same fact observed more often.
            density += weight * min(1.0, (found / judgeable))

    raw = (0.6 * useful_rate) + (0.4 * density)

    weight = judgeable / (judgeable + FEEDBACK_PRIOR_STRENGTH) if judgeable else 0.0
    score = (weight * raw) + ((1 - weight) * FEEDBACK_NEUTRAL_SCORE)
    score = round(max(0.0, min(1.0, score)), 3)
    confident = judgeable >= FEEDBACK_MIN_SAMPLES

    note = (
        f"{examined} candidate(s) examined downstream"
        + (f", {unreachable} unreachable and excluded as uninformative" if unreachable else "")
        + f". Useful {useful}/{judgeable or 0} = {useful_rate:.2f}; "
        f"weighted signal density {density:.2f}. Raw {raw:.3f}, shrunk toward neutral by "
        f"evidence weight {weight:.2f} → {score:.3f}."
        + ("" if confident else
           f" Fewer than {FEEDBACK_MIN_SAMPLES} judgeable results, so this is provisional "
           "and no budget is moved on it.")
    )

    return {"usefulness_score": score, "raw": round(raw, 3), "confident": confident,
            "useful_rate": round(useful_rate, 3), "signal_density": round(density, 3),
            "judgeable": judgeable, "evidence_note": note}


def refresh_scores() -> dict:
    """Recomputes usefulness for every attribution key from stored counters."""
    from app.discovery.budget_allocator import multiplier_for

    updated = []
    for stats in db.list_attributions():
        result = compute_usefulness(stats)
        multiplier = multiplier_for(result)
        db.set_attribution_score(stats["key_kind"], stats["key_value"],
                                 result["usefulness_score"], multiplier,
                                 result["evidence_note"])
        updated.append({
            "key_kind": stats["key_kind"], "key_value": stats["key_value"],
            "usefulness_score": result["usefulness_score"],
            "budget_multiplier": multiplier, "confident": result["confident"],
            "evidence_note": result["evidence_note"],
        })

    # Feed the pivot-level verdict back into technique learning, so the two
    # systems agree rather than pulling against each other.
    #
    # v0.7 (fixes a v0.6 defect): this loop previously called
    # record_technique_outcome with high_confidence=0 and sent_to_platform=0,
    # which added nothing to either counter. It looked like the loop was
    # closed while downstream usefulness never actually reached technique
    # learning's payoff term. The ledger is now SET from the attribution
    # totals rather than incremented, so repeated refreshes converge instead
    # of accumulating.
    for row in updated:
        if row["key_kind"] != "pivot":
            continue
        stats = db.get_attribution("pivot", row["key_value"]) or {}
        db.set_technique_downstream(
            row["key_value"],
            useful=int(stats.get("useful") or 0),
            examined=int(stats.get("candidates_examined") or 0))

    return {"updated": len(updated), "scores": updated,
            "note": ("Usefulness measures whether a technique's candidates turn out to "
                     "contain something worth examining. It is not a measure of whether "
                     "any site is malicious.")}


def feedback_report(limit: int = 100) -> dict:
    """Everything learned from downstream, for the Discovery Performance view."""
    rows = db.list_feedback(limit=limit)
    by_outcome = {}
    for row in rows:
        by_outcome[row["outcome"]] = by_outcome.get(row["outcome"], 0) + 1

    return {
        "recent": [
            {"domain": r["domain"], "outcome": r["outcome"],
             "deposit_pages": r["deposit_pages_found"], "wallets": r["wallets_found"],
             "infrastructure": r["infrastructure_evidence"],
             "relationships": r["relationships_found"],
             "source": r["source"], "pivot_types": r["pivot_types"],
             "investigation_id": r["investigation_id"],
             "received_at": r["received_at"], "detail": r["detail"],
             "evidence_class": "observed"}
            for r in rows
        ],
        "by_outcome": by_outcome,
        "attributions": {
            kind: db.list_attributions(key_kind=kind)
            for kind in ("source", "pivot", "indicator_combo", "campaign")
        },
        "note": ("Outcome signals describe what an investigator observed, not what any site "
                 "is. 'Useful' means the lead contained something worth examining; it is "
                 "never a finding that a site is malicious."),
    }
