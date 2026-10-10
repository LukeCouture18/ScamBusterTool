"""
Continuous background discovery.

Linked to the Main Platform, supply is demand-driven: the platform queues a
DISCOVER_SITES job whenever its inbox runs low, and the platform link runs it.
Standalone, this loop plays the same role against the local inbox: it runs a
v5 continuous-discovery cycle (app.v2.continuous; V5_CONTINUOUS=0 restores the
plain v2 round) whenever fewer than V2_INBOX_TARGET candidates are waiting, and
otherwise just applies your decisions and sleeps.
"""
from __future__ import annotations

import logging

from app.config import V2_AUTOPILOT_INTERVAL_SECONDS, V2_INBOX_TARGET, V5_CONTINUOUS

logger = logging.getLogger("scamhunter.v2.autopilot")


def tick(progress=None, platform_linked: bool = False) -> dict:
    from app.v2 import engine, inbox
    engine.apply_decisions()
    waiting = inbox.remaining()
    if platform_linked:
        return {"ran": False, "reason": "Platform-linked: rounds run when the platform asks (DISCOVER_SITES).",
                "waiting": waiting}
    if waiting >= V2_INBOX_TARGET:
        return {"ran": False, "reason": f"{waiting} candidates already waiting.", "waiting": waiting}
    if V5_CONTINUOUS:
        from app.v2 import continuous
        result = continuous.run_cycle(requested=max(1, V2_INBOX_TARGET - waiting), reason="standalone autopilot", progress=progress)
        return {**{k: result.get(k) for k in ("ran", "cycle", "round", "delivered", "new_unique", "sources", "reason")}, "waiting": inbox.remaining()}
    summary = engine.run_round(requested=max(1, V2_INBOX_TARGET - waiting), progress=progress)
    return {"ran": True, "round": summary["round"], "delivered": len(summary["delivered"]), "waiting": inbox.remaining()}


def run_forever(should_stop, progress=None, platform_linked=lambda: False, interval: int = None):
    import time
    interval = interval or V2_AUTOPILOT_INTERVAL_SECONDS
    while not should_stop():
        try:
            result = tick(progress, platform_linked=platform_linked())
            if progress:
                progress("v2_autopilot", result)
        except Exception as exc:                      # noqa: BLE001
            logger.exception("autopilot tick failed")
            if progress:
                progress("error", {"message": f"v2 autopilot: {exc}"})
        slept = 0
        while slept < interval and not should_stop():
            time.sleep(min(2, interval - slept))
            slept += 2
