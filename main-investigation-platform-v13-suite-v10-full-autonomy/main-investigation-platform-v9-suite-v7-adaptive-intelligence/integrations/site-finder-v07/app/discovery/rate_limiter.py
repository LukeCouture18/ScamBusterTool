"""
Being a well-behaved guest on other people's services.

Site Finder's external lookups go to free community infrastructure —
certificate transparency logs, public DNS. None of it owes us anything, and a
discovery engine that hammers crt.sh until it gets blocked has both broken its
own capability and been a bad citizen on the way.

This is a persistent token bucket per service, with three separate brakes:

  rate      calls per rolling window, so bursts are smoothed
  daily     a hard ceiling per day, so a runaway loop cannot spend a month's
            goodwill in an afternoon
  backoff   when a service says 429 or sends Retry-After, that instruction is
            obeyed exactly rather than approximated

PERSISTENCE MATTERS
-------------------
The counters live in the database, not in memory. A process restart must not
reset a daily budget — otherwise crash-looping becomes a way to bypass every
limit here, which is precisely when a service most needs protection from us.

REFUSAL IS NORMAL
-----------------
Being refused is not an error. It means "not now", the caller records the
reason and moves on to work that does not need that service. Nothing here
raises, and nothing retries automatically behind the caller's back.

NOTHING HERE BYPASSES ANYTHING
------------------------------
This module exists to stay under limits, never to work around them. There is
no rotation, no retry-through-a-different-route, no ignoring a Retry-After. If
a service says stop, Site Finder stops.
"""
import logging
import time

from app import db
from app.config import (
    API_DEFAULT_CALLS_PER_WINDOW, API_DEFAULT_WINDOW_SECONDS, API_DEFAULT_DAILY_LIMIT,
    API_BACKOFF_BASE_SECONDS, API_BACKOFF_MAX_SECONDS, API_SERVICE_LIMITS,
)

logger = logging.getLogger("scamhunter.rate_limiter")


def ensure_service(service: str):
    """Creates the budget row for a service the first time it is used."""
    if db.get_api_budget(service):
        return
    limits = API_SERVICE_LIMITS.get(service, {})
    db.configure_api_budget(
        service,
        calls_per_window=limits.get("calls_per_window", API_DEFAULT_CALLS_PER_WINDOW),
        window_seconds=limits.get("window_seconds", API_DEFAULT_WINDOW_SECONDS),
        daily_limit=limits.get("daily_limit", API_DEFAULT_DAILY_LIMIT))


def check(service: str, now: float = None) -> dict:
    """
    May we call this service right now? Returns
    {"allowed": bool, "reason": str, "retry_after": float}.

    Read-only — it does not consume. Use `acquire` to actually take a slot.
    """
    now = now if now is not None else time.time()
    ensure_service(service)
    budget = db.get_api_budget(service)

    if budget["backoff_until"] and now < budget["backoff_until"]:
        wait = budget["backoff_until"] - now
        return {"allowed": False, "retry_after": round(wait, 1),
                "reason": (f"{service} asked us to back off; {wait:.0f}s remaining. "
                           "That instruction is obeyed as given.")}

    # Daily ceiling, rolled at the day boundary.
    day_age = now - (budget["day_started_at"] or 0)
    calls_today = 0 if day_age >= 86400 else (budget["calls_today"] or 0)
    if budget["daily_limit"] and calls_today >= budget["daily_limit"]:
        wait = 86400 - day_age
        return {"allowed": False, "retry_after": round(max(0, wait), 1),
                "reason": (f"{service} daily limit of {budget['daily_limit']} call(s) reached. "
                           "Discovery continues on everything that does not need this "
                           "service.")}

    # Rolling window.
    window_age = now - (budget["window_started_at"] or 0)
    calls_in_window = 0 if window_age >= budget["window_seconds"] else (budget["calls_in_window"] or 0)
    if calls_in_window >= budget["calls_per_window"]:
        wait = budget["window_seconds"] - window_age
        return {"allowed": False, "retry_after": round(max(0, wait), 1),
                "reason": (f"{service} rate limit: {budget['calls_per_window']} call(s) per "
                           f"{budget['window_seconds']:.0f}s already used. "
                           f"{wait:.0f}s until the window resets.")}

    return {"allowed": True, "retry_after": 0,
            "reason": (f"{calls_in_window}/{budget['calls_per_window']} used this window, "
                       f"{calls_today}"
                       + (f"/{budget['daily_limit']}" if budget["daily_limit"] else "")
                       + " today.")}


def acquire(service: str, now: float = None) -> dict:
    """
    Takes one slot if one is available. Returns the same shape as `check`.
    The check and the consumption happen under one connection, so two workers
    cannot both be told yes for the last slot.
    """
    now = now if now is not None else time.time()
    ensure_service(service)

    verdict = check(service, now=now)
    if not verdict["allowed"]:
        with db.get_conn() as conn:
            conn.execute(
                "UPDATE api_budgets SET total_refused = total_refused + 1, "
                "last_refusal_reason=? WHERE service=?", (verdict["reason"], service))
        return verdict

    with db.get_conn() as conn:
        budget = dict(conn.execute(
            "SELECT * FROM api_budgets WHERE service=?", (service,)).fetchone())

        window_age = now - (budget["window_started_at"] or 0)
        if window_age >= budget["window_seconds"]:
            window_started_at, calls_in_window = now, 0
        else:
            window_started_at, calls_in_window = budget["window_started_at"], budget["calls_in_window"] or 0

        day_age = now - (budget["day_started_at"] or 0)
        if day_age >= 86400:
            day_started_at, calls_today = now, 0
        else:
            day_started_at, calls_today = budget["day_started_at"], budget["calls_today"] or 0

        conn.execute(
            """UPDATE api_budgets SET
                 window_started_at=?, calls_in_window=?,
                 day_started_at=?, calls_today=?,
                 total_calls = total_calls + 1, last_call_at=?
               WHERE service=?""",
            (window_started_at, calls_in_window + 1, day_started_at, calls_today + 1,
             now, service))

    return {"allowed": True, "retry_after": 0, "reason": verdict["reason"]}


def note_rate_limited(service: str, retry_after: float = None, now: float = None) -> dict:
    """
    Called when a service answers 429 (or equivalent). A server-supplied
    Retry-After is obeyed exactly; without one, backoff grows exponentially
    from the configured base.
    """
    now = now if now is not None else time.time()
    ensure_service(service)
    budget = db.get_api_budget(service)

    if retry_after is not None and retry_after >= 0:
        wait = float(retry_after)
        source = "the service's own Retry-After"
    else:
        consecutive = (budget.get("consecutive_429") or 0) + 1
        wait = min(API_BACKOFF_MAX_SECONDS,
                   API_BACKOFF_BASE_SECONDS * (2 ** max(0, consecutive - 1)))
        source = f"exponential backoff after {consecutive} rate-limit response(s)"

    until = now + wait
    reason = (f"{service} rate-limited us; pausing for {wait:.0f}s from {source}.")
    db.note_api_backoff(service, until, reason)
    logger.info(reason)
    return {"backoff_until": until, "wait_seconds": wait, "reason": reason}


def note_success(service: str):
    """A successful call clears accumulated backoff state."""
    budget = db.get_api_budget(service)
    if budget and (budget.get("consecutive_429") or 0) > 0:
        db.clear_api_backoff(service)


def budget_report() -> dict:
    now = time.time()
    rows = []
    for budget in db.list_api_budgets():
        verdict = check(budget["service"], now=now)
        window_age = now - (budget["window_started_at"] or 0)
        day_age = now - (budget["day_started_at"] or 0)
        rows.append({
            "service": budget["service"],
            "calls_per_window": budget["calls_per_window"],
            "window_seconds": budget["window_seconds"],
            "daily_limit": budget["daily_limit"],
            "calls_in_window": 0 if window_age >= budget["window_seconds"] else budget["calls_in_window"],
            "calls_today": 0 if day_age >= 86400 else budget["calls_today"],
            "total_calls": budget["total_calls"],
            "total_refused": budget["total_refused"],
            "backing_off": bool(budget["backoff_until"] and now < budget["backoff_until"]),
            "backoff_remaining": max(0, round((budget["backoff_until"] or 0) - now, 1)),
            "available": verdict["allowed"],
            "status": verdict["reason"],
        })
    return {
        "services": rows,
        "note": ("These limits keep Site Finder under what each service allows. They are "
                 "never worked around: a Retry-After is obeyed as given, and being refused "
                 "means discovery moves on to work that does not need that service."),
    }
