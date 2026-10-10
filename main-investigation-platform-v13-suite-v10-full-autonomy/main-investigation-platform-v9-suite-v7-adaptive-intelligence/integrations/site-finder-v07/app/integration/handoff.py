"""
Who investigates a promoted candidate — and what happens when nobody can.

v0.5 narrows Site Finder's job. Deep website investigation (driving a browser,
crawling deposit flows, capturing page evidence) is Site Investigator's work,
reached through the Main Platform. Site Finder discovers, triages against
public information, correlates, prioritises, and hands over.

That is the right division when the platform is there. It would be a bad trade
if it meant Site Finder stopped working when the platform is not, so the
default mode is "auto":

    handoff   the platform is reachable and compatible -> emit the request and
              let Site Investigator do the deep work
    local     it is not -> run the local deep analysis Site Finder has always
              had, and still queue the handoff event so the platform learns
              about it when the link returns

The point of "auto" is that a disconnected Site Finder degrades to v0.4
behaviour rather than to no behaviour. Nothing is skipped because of a network
problem; at worst some work is done twice, and duplicate work is cheaper than
a missed candidate.

The decision is always recorded on the site's timeline, so "why was this site
never crawled?" has an answer months later.
"""
import logging

from app import db
from app.config import DEEP_ANALYSIS_MODE
from app.integration.v4 import emitter
from app.integration.v4.client import default_client

logger = logging.getLogger("scamhunter.integration.handoff")


def decide_mode(client=None) -> dict:
    """Returns {"mode": "handoff"|"local", "reason": str}."""
    configured = (DEEP_ANALYSIS_MODE or "auto").lower()

    if configured == "handoff":
        return {"mode": "handoff",
                "reason": ("DEEP_ANALYSIS_MODE is 'handoff': deep investigation is Site "
                           "Investigator's, and the request is queued whether or not the "
                           "platform is reachable right now.")}
    if configured == "local":
        return {"mode": "local",
                "reason": ("DEEP_ANALYSIS_MODE is 'local': Site Finder runs its own deep "
                           "analysis and does not delegate.")}

    client = client or default_client()
    if not client.configured:
        return {"mode": "local",
                "reason": ("No Main Platform is configured, so there is nobody to hand off "
                           "to. Site Finder investigates locally and the handoff event is "
                           "still queued for whenever a platform appears.")}
    if client.is_online():
        return {"mode": "handoff",
                "reason": ("The Main Platform is reachable and schema-compatible, so deep "
                           "investigation goes to Site Investigator.")}
    return {"mode": "local",
            "reason": ("The Main Platform is not reachable right now, so Site Finder falls "
                       "back to local analysis rather than leaving the candidate "
                       "uninvestigated. The handoff event is queued and will still be "
                       "delivered when the link returns.")}


def handoff_for_site(site_id: int, client=None) -> dict:
    """
    Hands one promoted candidate to whoever should take it. Always queues the
    outbound events — the queue is what makes the delivery independent of
    whether anything is listening at this moment.
    """
    site = db.get_site(site_id)
    if not site:
        return {"mode": "none", "summary": f"No site {site_id}."}

    decision = decide_mode(client)
    emitted = emitter.queue_candidate(site_id)

    if not emitted.get("sent"):
        # The send gate refused it. That is a decision about evidence, not about
        # connectivity, and it means no deep investigation is warranted yet.
        db.add_timeline_event(
            site_id, "handoff_declined", "derived",
            "Not handed to Site Investigator",
            emitted.get("summary") or "Did not meet the send thresholds.")
        return {"mode": "none", "sent": False,
                "blocked_by": emitted.get("blocked_by", []),
                "summary": ("Not handed over: " + (emitted.get("summary") or ""))}

    if decision["mode"] == "handoff":
        db.add_timeline_event(
            site_id, "handoff", "derived",
            "Deep investigation requested from Site Investigator",
            f"{decision['reason']} {emitted.get('summary', '')}")
        # The investigation link is written when the batch is accepted, from the
        # external id the platform keyed on — not guessed here.
        return {"mode": "handoff", "sent": True,
                "high_priority": emitted.get("high_priority"),
                "batch_id": emitted.get("batch_id"),
                "summary": ("Deep investigation handed to Site Investigator via the Main "
                            "Platform; Site Finder is not crawling this site."),
                "reason": decision["reason"]}

    db.add_timeline_event(
        site_id, "handoff_deferred", "derived",
        "Investigating locally; handoff queued",
        f"{decision['reason']} {emitted.get('summary', '')}")
    return {"mode": "local", "sent": True,
            "high_priority": emitted.get("high_priority"),
            "batch_id": emitted.get("batch_id"),
            "summary": ("Queued for the platform and kept in the local deep-analysis queue "
                        "as well, so the candidate is investigated either way."),
            "reason": decision["reason"]}


def local_deep_analysis_allowed(client=None) -> bool:
    """
    Whether the local deep-analysis stage should run at all. The pipeline asks
    this before spending browser time on work Site Investigator is already
    doing.
    """
    return decide_mode(client)["mode"] == "local"


def handoff_report() -> dict:
    """What has been handed over, and what is waiting."""
    sent = db.sites_sent_to_platform(limit=100)
    decision = decide_mode()
    return {
        "mode": decision["mode"], "reason": decision["reason"],
        "configured_mode": DEEP_ANALYSIS_MODE,
        "handed_over": [
            {"domain": row["domain"], "investigation_id": row.get("investigation_id"),
             "investigator_job_id": row.get("investigator_job_id"),
             "platform_state": row.get("platform_state"),
             "events_sent": row.get("events_sent"),
             "last_sent_at": row.get("last_sent_at")}
            for row in sent
        ],
        "note": ("Site Finder discovers, triages against public information, correlates and "
                 "prioritises. Deep website investigation belongs to Site Investigator. When "
                 "the platform is unreachable, Site Finder investigates locally instead of "
                 "leaving candidates untouched."),
    }
