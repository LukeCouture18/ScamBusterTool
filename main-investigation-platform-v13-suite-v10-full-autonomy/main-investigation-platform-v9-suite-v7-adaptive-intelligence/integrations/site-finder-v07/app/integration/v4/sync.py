"""
Moving queued v4 batches to the platform, and surviving everything in between.

The sync worker is the only outbound thing that touches the network.
Everything upstream queues. That separation is what lets Site Finder keep
discovering while the platform is down, restart without losing work, and retry
safely.

RETRY REUSES THE BATCH ID
-------------------------
API.md: "Clients should retry 429 and transient 5xx responses with exponential
backoff and reuse the same batch ID." Site Finder derives the batch id from the
batch's content, so a retry is automatically the same id — and the platform
returns the original result with `replayed: true` instead of ingesting twice.
That is what makes the ambiguous case (request sent, answer lost) safe.

BACKOFF IS PER BATCH
--------------------
Each batch carries its own next-attempt time, so one permanently-rejected batch
cannot block everything queued behind it, and a burst of failures does not
reset the patience of batches that have waited longest. The delay comes from
the platform's own `retryDelaySeconds`, transcribed in contract.py, so both
sides back off on the same curve.

DEAD-LETTERING IS LOCAL AND VISIBLE
-----------------------------------
A batch the platform rejects on its merits is not retried forever — that would
fill the queue with something that can never succeed. It is moved to a local
dead-letter state and surfaced. Nothing is ever silently discarded: a
discovery that cannot be delivered stays visible.

RESTART SAFETY
--------------
Anything left mid-flight when the process died goes back in the queue rather
than being assumed delivered. The platform deduplicates on batch id, so a
re-send costs nothing, while assuming success could lose a discovery forever.
"""
import logging
import threading
import time

from app import db
from app.config import (
    SYNC_BATCH_SIZE, SYNC_INTERVAL_SECONDS, SYNC_MAX_ATTEMPTS,
    SYNC_RETRY_MAX_SECONDS, MAIN_PLATFORM_HEARTBEAT_SECONDS,
    FEEDBACK_POLL_INTERVAL_SECONDS,
)
from app.integration.v4 import contract
from app.integration.v4.client import PlatformClient, default_client

logger = logging.getLogger("scamhunter.integration.v4.sync")

# A batch rejected on its merits is parked far enough out that it stops
# consuming attempts, but not deleted — an operator can fix the cause and
# retry it from the UI.
DEAD_LETTER_PARK_SECONDS = 86400 * 365


def resume_after_restart() -> dict:
    """
    Called once at startup. Returns anything interrupted to the queue and
    reports unfinished platform jobs, so a restart is visible rather than
    silently absorbed.
    """
    requeued = db.reset_stuck_outbox()
    stats = db.outbox_stats()
    orphaned = db.unfinished_jobs()

    return {
        "requeued_interrupted": requeued,
        "pending": stats["pending"],
        "unfinished_jobs": [
            {"job_id": j["job_id"], "job_type": j["job_type"], "status": j["status"]}
            for j in orphaned
        ],
        "note": (
            (f"{requeued} batch(es) were interrupted mid-send and have been requeued. "
             "They are re-sent rather than assumed delivered; the platform deduplicates "
             "on batch_id, so a re-send costs nothing. "
             if requeued else "No batches were interrupted. ")
            + (f"{len(orphaned)} platform job(s) were claimed but never reported. Their "
               "leases will expire on the platform and the work will be re-offered; Site "
               "Finder reports them failed so that happens promptly rather than after a "
               "timeout." if orphaned else "No platform jobs were left unfinished.")),
    }


def sync_once(client: PlatformClient = None, limit: int = None,
              progress_cb=None) -> dict:
    """One drain pass. Safe to call as often as you like."""
    client = client or default_client()
    progress = progress_cb or (lambda e, d: None)
    limit = limit or SYNC_BATCH_SIZE

    if not client.configured:
        stats = db.outbox_stats()
        return {"sent": 0, "duplicates": 0, "failed": 0, "rejected": 0,
                "skipped": stats["pending"], "state": "unconfigured",
                "note": ("No platform URL or module API key is configured, so nothing was "
                         f"sent. {stats['pending']} batch(es) are queued and will go out "
                         "once both are set — none of them are lost.")}

    batches = db.next_batches(limit=limit)
    if not batches:
        return {"sent": 0, "duplicates": 0, "failed": 0, "rejected": 0,
                "state": "idle", "note": "Nothing queued."}

    sent = duplicates = failed = rejected = partial = 0
    errors = []

    for row in batches:
        outcome = client.send_batch(row["records"], row["batch_id"],
                                    origin_job_id=row.get("origin_job_id"))

        if outcome.ok:
            db.mark_outbox_sent(row["id"], outcome.body)
            db.record_receipt(row["batch_id"], outcome.kind,
                              site_id=row.get("site_id"), detail=outcome.detail)
            if row.get("site_id"):
                _link_investigation(row)
            if outcome.kind == "duplicate":
                duplicates += 1
            elif outcome.kind == "partial":
                partial += 1
                sent += 1
                errors.append({"batch_id": row["batch_id"], "kind": "partial",
                               "detail": outcome.detail, "retrying": False})
            else:
                sent += 1
            progress("integration_batch_sent", {
                "batch_id": row["batch_id"], "kind": row["kind"],
                "result": outcome.kind, "detail": outcome.detail,
                "counts": {k: outcome.body.get(k) for k in
                           ("inserted_count", "updated_count", "duplicate_count",
                            "error_count") if k in outcome.body}})
            continue

        attempts = (row.get("attempts") or 0) + 1

        if not outcome.retryable:
            rejected += 1
            db.mark_outbox_failed(row["id"], outcome.detail,
                                  next_attempt_at=time.time() + DEAD_LETTER_PARK_SECONDS)
            db.record_receipt(row["batch_id"], "rejected", site_id=row.get("site_id"),
                              detail=outcome.detail)
            errors.append({"batch_id": row["batch_id"], "kind": outcome.kind,
                           "detail": outcome.detail, "retrying": False,
                           "dead_lettered": True})
            progress("integration_batch_rejected", {
                "batch_id": row["batch_id"], "detail": outcome.detail})
            continue

        failed += 1
        delay = contract.retry_delay_seconds(attempts)
        if SYNC_MAX_ATTEMPTS and attempts >= SYNC_MAX_ATTEMPTS:
            db.mark_outbox_failed(
                row["id"], f"{outcome.detail} (gave up after {attempts} attempts)",
                next_attempt_at=time.time() + DEAD_LETTER_PARK_SECONDS)
        else:
            db.mark_outbox_failed(row["id"], outcome.detail,
                                  next_attempt_at=time.time() + min(delay, SYNC_RETRY_MAX_SECONDS))
        errors.append({"batch_id": row["batch_id"], "kind": outcome.kind,
                       "detail": outcome.detail, "retrying": True,
                       "next_attempt_in_seconds": round(min(delay, SYNC_RETRY_MAX_SECONDS))})

    stats = db.outbox_stats()
    return {
        "sent": sent, "duplicates": duplicates, "partial": partial,
        "failed": failed, "rejected": rejected,
        "still_pending": stats["pending"], "errors": errors[:20],
        "state": "online" if (sent or duplicates) else ("offline" if failed else "idle"),
        "note": (f"{sent} batch(es) accepted, {duplicates} already known to the platform, "
                 f"{failed} deferred for retry, {rejected} rejected and dead-lettered. "
                 f"{stats['pending']} still queued."),
    }


def _link_investigation(row: dict):
    """
    Records which investigation a site belongs to, permanently. The external
    id is Site Finder's own and deterministic, so the association survives
    restarts and is the same one the platform keyed on.
    """
    from app.integration.v4 import translator as tr
    site = db.get_site(row["site_id"])
    if not site:
        return
    db.link_platform_investigation(
        row["site_id"], tr.external_id("investigation", site["domain"]),
        batch_id=row["batch_id"])


def sync_until_drained(client: PlatformClient = None, max_passes: int = 20,
                        progress_cb=None) -> dict:
    """
    Drains everything currently due. Stops on an empty queue, on a pass that
    makes no progress, or at max_passes — so a platform failing every batch
    cannot spin this forever.
    """
    client = client or default_client()
    totals = {"sent": 0, "duplicates": 0, "failed": 0, "rejected": 0, "passes": 0}
    for _ in range(max_passes):
        result = sync_once(client, progress_cb=progress_cb)
        totals["passes"] += 1
        for key in ("sent", "duplicates", "failed", "rejected"):
            totals[key] += result.get(key, 0)
        if result.get("state") in ("idle", "unconfigured"):
            break
        if not (result.get("sent") or result.get("duplicates")):
            break
    totals["still_pending"] = db.outbox_stats()["pending"]
    totals["note"] = (f"{totals['sent']} batch(es) sent over {totals['passes']} pass(es); "
                      f"{totals['still_pending']} still queued.")
    return totals


def retry_deferred() -> dict:
    """
    Clears backoff on everything waiting, so an operator who has just fixed
    the cause does not have to wait out an exponential delay.
    """
    with db.get_conn() as conn:
        cur = conn.execute(
            "UPDATE integration_outbox SET next_attempt_at=0 WHERE status='failed'")
        cleared = cur.rowcount
    return {"cleared": cleared,
            "note": f"{cleared} deferred batch(es) will be tried on the next pass."}


class SyncWorker:
    """
    The background loop: register once, heartbeat, drain, claim jobs, poll for
    downstream feedback. Entirely optional — everything it does can be
    triggered by hand.
    """

    def __init__(self, client: PlatformClient = None, progress_cb=None):
        self.client = client or default_client()
        self.progress = progress_cb or (lambda e, d: None)
        self._thread = None
        self._stop = threading.Event()
        self._last_heartbeat = 0.0
        self._last_feedback_poll = 0.0
        self.last_result = {}

    def start(self):
        if self._thread and self._thread.is_alive():
            return False, "Sync worker is already running."
        resumed = resume_after_restart()
        if resumed["requeued_interrupted"] or resumed["unfinished_jobs"]:
            self.progress("integration_resumed", resumed)
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True, f"Sync worker started. {resumed['pending']} batch(es) pending."

    def stop(self):
        self._stop.set()
        return True, "Sync worker stopping."

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _loop(self):
        try:
            self.progress("integration_state", self.client.register())
        except Exception as exc:                # noqa: BLE001
            logger.warning("Registration failed at startup: %s", exc)

        while not self._stop.is_set():
            try:
                now = time.time()

                if now - self._last_heartbeat >= MAIN_PLATFORM_HEARTBEAT_SECONDS:
                    beat = self.client.heartbeat(status="idle")
                    self._last_heartbeat = now
                    self.progress("integration_heartbeat", beat)
                    # Coming back after an outage means re-registering: the
                    # platform may have restarted and lost our capabilities.
                    if beat.get("alive") and (beat.get("state") == "online"):
                        status = db.get_integration_status(self.client.endpoint) or {}
                        if (status.get("consecutive_failures") or 0) > 0:
                            self.progress("integration_state", self.client.register())

                if self.client.is_online():
                    self.last_result = sync_once(self.client, progress_cb=self.progress)
                    if self.last_result.get("sent") or self.last_result.get("rejected"):
                        self.progress("integration_sync", self.last_result)

                    from app.integration.v4.jobs import claim_and_run_one
                    job_result = claim_and_run_one(self.client, progress_cb=self.progress)
                    if job_result.get("claimed"):
                        self.progress("integration_job", job_result)

                    # v2: your inbox decisions are the primary feedback signal.
                    try:
                        from app.v2.platform_bridge import pull_decisions
                        pulled = pull_decisions(self.client)
                        if pulled.get("pulled"):
                            self.progress("v2_decisions", pulled)
                    except Exception as exc:    # noqa: BLE001
                        logger.warning("v2 decision pull failed: %s", exc)

                    # next gen: sites Main and Hunter already hold (discovery memory, gap seeds).
                    try:
                        from app.v2.platform_bridge import pull_context
                        ctx = pull_context(self.client)
                        if ctx.get("pulled"):
                            self.progress("ng_context", ctx)
                    except Exception as exc:    # noqa: BLE001
                        logger.warning("context pull failed: %s", exc)

                    # v3: Site Finder's hunts, for Main's Site Finder · Hunts view.
                    try:
                        from app.v2.platform_bridge import push_hunts
                        push_hunts(self.client)
                    except Exception as exc:    # noqa: BLE001
                        logger.warning("hunts push failed: %s", exc)

                    # v3: downstream outcomes (meaningful/wallet evidence, dead,
                    # barrier, duplicate, completed) steer discovery allocation.
                    try:
                        from app.v2.outcomes import pull_outcomes
                        out = pull_outcomes(self.client)
                        if out.get("pulled"):
                            self.progress("v3_outcomes", out)
                    except Exception as exc:    # noqa: BLE001
                        logger.warning("v3 outcome pull failed: %s", exc)

                    if now - self._last_feedback_poll >= FEEDBACK_POLL_INTERVAL_SECONDS:
                        from app.integration.v4.feedback_sync import poll_outcomes
                        self._last_feedback_poll = now
                        outcomes = poll_outcomes(self.client)
                        if outcomes.get("recorded"):
                            self.progress("integration_feedback", outcomes)

            except Exception as exc:            # noqa: BLE001
                logger.exception("Sync loop error")
                self.progress("integration_error", {"message": str(exc)})
            self._stop.wait(SYNC_INTERVAL_SECONDS)


def sync_report() -> dict:
    """Everything about the outbound path, for the UI."""
    from app.integration.v4.client import connection_report
    stats = db.outbox_stats()
    deferred = db.list_outbox(status="failed", limit=25)
    now = time.time()

    return {
        "connection": connection_report(),
        "outbox": stats,
        "deferred": [
            {"batch_id": row["event_id"], "kind": row["event_type"],
             "attempts": row["attempts"], "last_error": row["last_error"],
             "next_attempt_at": row["next_attempt_at"],
             "dead_lettered": bool(row["next_attempt_at"]
                                   and row["next_attempt_at"] - now > SYNC_RETRY_MAX_SECONDS),
             "queued_at": row["queued_at"]}
            for row in deferred
        ],
        "recently_sent": [
            {"batch_id": row["event_id"], "kind": row["event_type"],
             "sent_at": row["sent_at"], "receipt": row.get("platform_receipt")}
            for row in db.list_outbox(status="sent", limit=25)
        ],
        "jobs": db.list_claimed_jobs(limit=25),
        "note": ("Queued batches are never discarded for age. A batch the platform rejects "
                 "on its merits is dead-lettered locally and surfaced here rather than "
                 "retried forever or silently dropped."),
    }
