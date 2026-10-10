"""
Remembering what we already decided about a candidate.

A discovery engine with no memory of its own judgements rediscovers the same
weak domain every time a pivot brushes past it, re-triages it, re-scores it,
and dismisses it again — spending the budget that the whole quality apparatus
exists to protect. Worse, it does this most often to the domains that appear on
the most shared infrastructure, which are exactly the ones least worth the
attention.

So Site Finder records what it decided and why, and checks that record before
spending anything.

THE DECISION IS NOT PERMANENT
-----------------------------
The opposite failure is a system that dismisses a domain once and never looks
again — which is wrong, because sites change. A domain dismissed as an empty
parked page in March and carrying a deposit route and a payment address in
September is a different proposition.

The bar for reconsidering is NEW EVIDENCE, not elapsed time. Time alone tells
you nothing; a novelty score computed since the decision tells you whether
anything actually changed.

THE ORIGINAL DECISION SURVIVES
------------------------------
Reconsidering supersedes a decision, it does not overwrite it. The record keeps
what was decided, when, on what evidence, and what changed to justify a fresh
look. An analyst asking "why did this get dismissed and then promoted?" gets
both halves.

WHAT A DECISION IS NOT
----------------------
"Dismissed" means Site Finder judged the candidate not worth an investigator's
time on the evidence available. It is not a finding that the site is legitimate,
and "promoted" is not a finding that it is not — both are statements about
where limited attention should go.
"""
import logging
import time

from app import db
from app.config import CANDIDATE_DECISIONS, CANDIDATE_RECHECK_AFTER_DAYS
from app.discovery.dedup import canonical_domain

logger = logging.getLogger("scamhunter.candidate_memory")


def _evidence_snapshot(site_id: int) -> dict:
    """What was known at the moment of a decision, so 'what changed' is answerable."""
    indicators = db.indicators_for_site(site_id, only_current=True)
    triage = db.get_triage(site_id)
    return {
        "indicator_types": sorted({r["indicator_type"] for r in indicators}),
        "indicator_count": len(indicators),
        "wallets": sum(1 for r in indicators if r["indicator_type"] == "wallet"),
        "deposit_options": len(db.deposit_options_for_site(site_id, only_current=True)),
        "triage_passed": bool(triage["passed"]) if triage else None,
        "triage_score": (triage or {}).get("triage_score"),
        "paths": len(db.paths_for_site(site_id)),
        "taken_at": time.time(),
    }


def record(site_id: int, decision: str, reason: str = "",
           supersede: bool = False, supersede_reason: str = "") -> dict:
    """
    Records a decision about a candidate. `supersede` marks the previous one as
    revisited rather than replacing it.
    """
    if decision not in CANDIDATE_DECISIONS:
        raise ValueError(f"decision must be one of {CANDIDATE_DECISIONS}")

    site = db.get_site(site_id)
    if not site:
        return {"recorded": False, "reason": f"No site {site_id}."}

    from app.discovery.novelty import score as novelty_score
    domain = canonical_domain(site["url"])
    previous = db.latest_candidate_decision(domain)
    novelty = novelty_score(site_id)

    decision_id = db.record_candidate_decision(
        site_id, domain, decision, reason=reason,
        evidence_snapshot=_evidence_snapshot(site_id),
        novelty=novelty["novelty"])

    if supersede and previous:
        db.supersede_decision(
            previous["id"], decision_id,
            supersede_reason or (f"Revisited after new evidence: "
                                 f"novelty {novelty['novelty']:.2f} since the previous "
                                 "decision."))

    db.add_timeline_event(
        site_id, f"decision_{decision}", "derived",
        f"Candidate {decision}",
        (reason or "") + (f" This supersedes the earlier '{previous['decision']}' decision; "
                          "that decision and its evidence remain on record."
                          if supersede and previous else ""))

    return {"recorded": True, "decision_id": decision_id, "decision": decision,
            "domain": domain, "superseded": bool(supersede and previous),
            "previous_decision": (previous or {}).get("decision")}


def should_process(site_id: int) -> dict:
    """
    The gate: is it worth spending anything on this candidate again?

    Called before triage and before promotion, so a domain we have already
    judged does not consume the budget twice for the same answer.
    """
    from app.discovery.novelty import worth_reconsidering

    site = db.get_site(site_id)
    if not site:
        return {"process": False, "reason": f"No site {site_id}."}

    domain = canonical_domain(site["url"])
    previous = db.latest_candidate_decision(domain)

    if not previous:
        return {"process": True, "reason": "No previous decision on record.",
                "first_time": True}

    verdict = worth_reconsidering(site_id)
    age_days = (time.time() - previous["decided_at"]) / 86400

    if verdict["reconsider"]:
        return {
            "process": True, "first_time": False, "reconsidering": True,
            "previous_decision": previous["decision"],
            "previous_reason": previous.get("reason"),
            "new_evidence": verdict.get("new_evidence", []),
            "reason": verdict["reason"],
        }

    if previous["decision"] == "unreachable" and age_days >= CANDIDATE_RECHECK_AFTER_DAYS:
        return {
            "process": True, "first_time": False, "reconsidering": True,
            "previous_decision": previous["decision"],
            "reason": (f"Last seen unreachable {age_days:.0f} day(s) ago. A site being down "
                       "says nothing durable about it, so it is worth one cheap recheck "
                       f"after {CANDIDATE_RECHECK_AFTER_DAYS} days."),
        }

    return {
        "process": False, "first_time": False, "reconsidering": False,
        "previous_decision": previous["decision"],
        "decided_at": previous["decided_at"],
        "reason": verdict["reason"],
    }


def reconsider(site_id: int) -> dict:
    """
    Takes a fresh look at a previously-decided candidate, if the evidence has
    moved. Returns what changed and what the new decision would rest on.
    """
    from app.integration.v4.emitter import should_send_site
    from app.discovery.novelty import worth_reconsidering

    verdict = worth_reconsidering(site_id)
    if not verdict["reconsider"]:
        return {"reconsidered": False, **verdict}

    decision = should_send_site(site_id)
    new_decision = "promoted" if decision["send"] else "dismissed"

    result = record(
        site_id, new_decision,
        reason=(" ".join(decision["reasons"]) if decision["send"]
                else " ".join(decision["blocked_by"])),
        supersede=True,
        supersede_reason=verdict["reason"])

    return {
        "reconsidered": True,
        "previous_decision": verdict.get("previous_decision"),
        "new_decision": new_decision,
        "new_evidence": verdict.get("new_evidence", []),
        "novelty_since": verdict.get("novelty_since"),
        "explanation": (
            f"{verdict['reason']} On the current evidence the candidate is "
            f"{new_decision}: "
            + " ".join(decision["reasons"] if decision["send"] else decision["blocked_by"])),
        **result,
    }


def sweep_for_reconsideration(limit: int = 100) -> dict:
    """
    Finds previously-dismissed candidates that have since gained meaningful
    evidence. Run after a correlation pass, when new observations have landed.
    """
    candidates = db.decisions_by_kind("dismissed", limit=limit) + \
        db.decisions_by_kind("inconclusive", limit=limit)

    revisited, unchanged = [], 0
    for decision in candidates:
        site_id = decision.get("site_id")
        if not site_id:
            continue
        outcome = reconsider(site_id)
        if outcome.get("reconsidered"):
            revisited.append({
                "domain": decision["canonical_domain"],
                "was": outcome.get("previous_decision"),
                "now": outcome.get("new_decision"),
                "new_evidence": outcome.get("new_evidence", []),
                "explanation": outcome.get("explanation"),
            })
        else:
            unchanged += 1

    promoted = [r for r in revisited if r["now"] == "promoted"]
    return {
        "checked": len(candidates), "revisited": len(revisited),
        "newly_promoted": len(promoted), "unchanged": unchanged,
        "changes": revisited[:50],
        "note": ("Only candidates whose evidence actually changed were revisited. The "
                 "original decisions remain on record alongside the new ones."),
    }


def memory_report(limit: int = 100) -> dict:
    """What Site Finder remembers deciding, for the UI."""
    counts = {}
    with db.get_conn() as conn:
        for row in conn.execute(
                """SELECT decision, COUNT(*) c FROM candidate_decisions
                   WHERE superseded_by IS NULL GROUP BY decision"""):
            counts[row["decision"]] = row["c"]
        superseded = conn.execute(
            "SELECT COUNT(*) c FROM candidate_decisions WHERE superseded_by IS NOT NULL"
        ).fetchone()["c"]

    recent = []
    for kind in CANDIDATE_DECISIONS:
        for row in db.decisions_by_kind(kind, limit=10):
            recent.append({"domain": row["canonical_domain"], "decision": row["decision"],
                            "reason": row.get("reason"), "decided_at": row["decided_at"],
                            "novelty_at_decision": row.get("novelty_at_decision")})
    recent.sort(key=lambda r: r["decided_at"] or 0, reverse=True)

    return {
        "counts": counts, "superseded": superseded,
        "recent": recent[:limit],
        "note": ("A decision records where limited attention should go, not what a site is. "
                 "'Dismissed' is not a finding that a site is legitimate, and 'promoted' is "
                 "not a finding that it is not. Decisions are superseded by new evidence, "
                 "never deleted."),
    }
