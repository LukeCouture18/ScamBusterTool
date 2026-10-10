"""
How much of this candidate is actually new?

Novelty is deliberately a separate number from priority, confidence, evidence
strength and downstream usefulness. Collapsing them into one score destroys
information, because they answer different questions and routinely disagree:

    high novelty, low priority   a domain nobody has ever seen, carrying
                                 nothing worth investigating. Common, and
                                 correctly ignored.
    low novelty, high priority   a candidate we have seen many times, now
                                 carrying a wallet it did not have last month.
                                 The most valuable thing this module can find,
                                 and a single blended score buries it.

Keeping them apart is what lets a previously-dismissed candidate be
reconsidered on evidence rather than on a scoring accident.

NOVELTY IS ABOUT OUR KNOWLEDGE, NOT ABOUT THE SITE
--------------------------------------------------
"New" means new to this installation. A domain registered in 2009 that we have
simply never scanned is novel to us and not new in the world, and the score
says which it is rather than blurring them. Nothing here is a claim about the
site: a brand-new domain is not more suspicious for being new, it is just less
known.
"""
import logging
import time

from app import db
from app.config import NOVELTY_WEIGHTS, NOVELTY_RECONSIDER_THRESHOLD

logger = logging.getLogger("scamhunter.novelty")

INFRASTRUCTURE_TYPES = {"ip", "asn", "nameserver", "registrar",
                        "cert_sha256", "cert_issuer"}
TEMPLATE_TYPES = {"template_hash", "favicon_hash", "page_title"}


def score(site_id: int, since: float = None) -> dict:
    """
    Returns {"novelty": 0..1, "factors": [...], "explanation": str}.

    `since` scopes "new" to a point in time — used when reconsidering a
    previously-dismissed candidate, where the question is not "is any of this
    new?" but "is any of this new *since we decided*?".
    """
    site = db.get_site(site_id)
    if not site:
        return {"novelty": 0.0, "factors": [], "explanation": f"No site {site_id}."}

    domain = site["domain"]
    factors = []

    registration = db.get_candidate_registration(domain)
    decision = db.latest_candidate_decision(domain)
    cutoff = since if since is not None else (decision or {}).get("decided_at")

    # --- have we ever seen this domain before? ---
    if not registration or (registration.get("times_rediscovered") or 0) == 0:
        first_seen = (registration or {}).get("first_seen_at") or site.get("added_at") or 0
        if not cutoff or first_seen >= cutoff:
            factors.append({
                "factor": "unseen_domain", "weight": NOVELTY_WEIGHTS["unseen_domain"],
                "value": 1.0,
                "evidence": (f"{domain} had not been seen by this installation before"
                             + (" this decision." if cutoff else ".")),
                "evidence_class": "observed"})

    indicators = db.indicators_for_site(site_id)

    def _new_since(rows):
        if not cutoff:
            return rows
        return [r for r in rows if (r.get("first_observed") or 0) >= cutoff]

    # --- infrastructure we had not recorded ---
    infra = _new_since([r for r in indicators
                        if r["indicator_type"] in INFRASTRUCTURE_TYPES])
    fresh_infra = [r for r in infra if (r.get("site_count") or 0) <= 1]
    if fresh_infra:
        factors.append({
            "factor": "new_infrastructure", "weight": NOVELTY_WEIGHTS["new_infrastructure"],
            "value": round(min(1.0, len(fresh_infra) / 2.0), 3),
            "evidence": (f"{len(fresh_infra)} infrastructure indicator(s) "
                         f"({', '.join(sorted({r['indicator_type'] for r in fresh_infra}))}) "
                         "are not recorded on any other site we know."),
            "evidence_class": "observed"})

    # --- a payment address we had not recorded ---
    wallets = _new_since([r for r in indicators if r["indicator_type"] == "wallet"])
    fresh_wallets = [r for r in wallets if (r.get("site_count") or 0) <= 1]
    if fresh_wallets:
        factors.append({
            "factor": "new_wallet", "weight": NOVELTY_WEIGHTS["new_wallet"], "value": 1.0,
            "evidence": (f"{len(fresh_wallets)} payment address(es) observed here that we "
                         "have not seen anywhere else."),
            "evidence_class": "observed"})

    # --- a deposit route where there was none ---
    deposits = db.deposit_options_for_site(site_id, only_current=True)
    new_deposits = ([d for d in deposits if (d.get("first_seen") or 0) >= cutoff]
                    if cutoff else deposits)
    if new_deposits:
        factors.append({
            "factor": "new_deposit_route", "weight": NOVELTY_WEIGHTS["new_deposit_route"],
            "value": 1.0,
            "evidence": (f"{len(new_deposits)} deposit or payment route(s) found here"
                         + (" since the last decision." if cutoff else ".")
                         + " A site that now takes payments and did not before has "
                           "materially changed."),
            "evidence_class": "observed"})

    # --- a template shape we had not recorded ---
    templates = _new_since([r for r in indicators if r["indicator_type"] in TEMPLATE_TYPES])
    fresh_templates = [r for r in templates if (r.get("site_count") or 0) <= 1]
    if fresh_templates:
        factors.append({
            "factor": "new_template", "weight": NOVELTY_WEIGHTS["new_template"], "value": 1.0,
            "evidence": f"{len(fresh_templates)} template/appearance indicator(s) are new to us.",
            "evidence_class": "observed"})

    # --- newly part of a known family ---
    cluster = db.cluster_for_site(site_id)
    if cluster:
        snapshot = db.latest_cluster_snapshot(cluster["id"], before=cutoff)
        if snapshot and domain not in (snapshot.get("domains") or []):
            factors.append({
                "factor": "new_cluster_membership",
                "weight": NOVELTY_WEIGHTS["new_cluster_membership"], "value": 1.0,
                "evidence": (f"{domain} was not in family "
                             f"{cluster.get('label') or cluster['id']} when it was last "
                             "recorded; it is there now."),
                "evidence_class": "derived"})

    # --- a route to it we had not taken ---
    paths = db.paths_for_site(site_id)
    new_paths = [p for p in paths if not cutoff or (p.get("found_at") or 0) >= cutoff]
    distinct_new = {p["pivot_type"] for p in new_paths}
    if distinct_new and (cutoff or len(distinct_new) > 1):
        factors.append({
            "factor": "new_discovery_path", "weight": NOVELTY_WEIGHTS["new_discovery_path"],
            "value": round(min(1.0, len(distinct_new) / 2.0), 3),
            "evidence": (f"Reached by {len(distinct_new)} discovery technique(s) "
                         f"({', '.join(sorted(distinct_new))})"
                         + (" since the last decision." if cutoff else ".")),
            "evidence_class": "derived"})

    # --- evidence added since we last triaged it ---
    triage = db.get_triage(site_id)
    if triage and triage.get("triaged_at"):
        added_since = [r for r in indicators
                       if (r.get("first_observed") or 0) > triage["triaged_at"]]
        if added_since:
            factors.append({
                "factor": "new_evidence_since_triage",
                "weight": NOVELTY_WEIGHTS["new_evidence_since_triage"],
                "value": round(min(1.0, len(added_since) / 3.0), 3),
                "evidence": (f"{len(added_since)} indicator(s) were observed after this "
                             "candidate was last triaged, so the triage result is out of "
                             "date."),
                "evidence_class": "observed"})

    novelty = round(min(1.0, sum(f["weight"] * f["value"] for f in factors)), 3)

    if factors:
        explanation = (
            f"Novelty {novelty:.2f} from {len(factors)} factor(s): "
            + "; ".join(f"{f['factor']} ({f['weight'] * f['value']:.2f})" for f in factors)
            + ". Novelty measures how much of this is new TO US, kept separate from "
              "priority, confidence and evidence strength because those answer different "
              "questions and often disagree. Being new is not evidence of anything.")
    else:
        explanation = (
            f"Novelty {novelty:.2f}: nothing here is new to this installation"
            + (" since the last decision was made." if cutoff else ".")
            + " That is not a mark against the candidate — it means we already knew this.")

    db.set_candidate_novelty(domain, novelty, site_id=site_id)

    return {"site_id": site_id, "domain": domain, "novelty": novelty,
            "factors": factors, "explanation": explanation,
            "scoped_since": cutoff, "evidence_class": "derived"}


def worth_reconsidering(site_id: int) -> dict:
    """
    Should a previously-decided candidate be looked at again?

    The bar is new EVIDENCE, not elapsed time. A dismissed candidate that has
    since sprouted a wallet and a deposit route is a different proposition from
    the one that was dismissed; a dismissed candidate that has sat unchanged
    for a year is the same one, and re-triaging it would waste the budget that
    this whole module exists to protect.
    """
    site = db.get_site(site_id)
    if not site:
        return {"reconsider": False, "reason": f"No site {site_id}."}

    domain = site["domain"]
    decision = db.latest_candidate_decision(domain)
    if not decision:
        return {"reconsider": True, "reason": "No previous decision on record.",
                "previous_decision": None}

    if decision["decision"] == "promoted":
        return {"reconsider": False,
                "reason": ("Already promoted; it is with the platform and does not need "
                           "rediscovering."),
                "previous_decision": decision["decision"]}

    novelty_now = score(site_id, since=decision["decided_at"])

    if novelty_now["novelty"] >= NOVELTY_RECONSIDER_THRESHOLD:
        return {
            "reconsider": True,
            "previous_decision": decision["decision"],
            "previous_reason": decision.get("reason") or "",
            "decided_at": decision["decided_at"],
            "novelty_since": novelty_now["novelty"],
            "new_evidence": [f["evidence"] for f in novelty_now["factors"]],
            "reason": (
                f"Previously {decision['decision']}"
                + (f" ({decision.get('reason')})" if decision.get("reason") else "")
                + f", but {novelty_now['novelty']:.2f} of new evidence has appeared since: "
                + " ".join(f["evidence"] for f in novelty_now["factors"])
                + " The original decision stands on the record; this is a new look at "
                  "changed facts."),
        }

    return {
        "reconsider": False,
        "previous_decision": decision["decision"],
        "decided_at": decision["decided_at"],
        "novelty_since": novelty_now["novelty"],
        "reason": (
            f"Previously {decision['decision']} and only {novelty_now['novelty']:.2f} of "
            f"new evidence has appeared since (threshold "
            f"{NOVELTY_RECONSIDER_THRESHOLD:.2f}). Re-triaging it would spend budget to "
            "reach the same conclusion."),
    }


def novel_candidates(limit: int = 50, min_novelty: float = 0.4) -> list:
    """The most novel candidates on record, for the main screen."""
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT cr.*, s.url, s.status FROM candidate_registry cr
               LEFT JOIN sites s ON s.id = cr.site_id
               WHERE cr.novelty_score >= ?
               ORDER BY cr.novelty_score DESC LIMIT ?""",
            (min_novelty, limit)).fetchall()
        return [{"domain": r["canonical_domain"], "site_id": r["site_id"],
                 "url": r["url"], "novelty": r["novelty_score"],
                 "last_decision": r["last_decision"],
                 "distinct_campaigns": r["distinct_campaigns"],
                 "evidence_class": "derived"}
                for r in rows]
