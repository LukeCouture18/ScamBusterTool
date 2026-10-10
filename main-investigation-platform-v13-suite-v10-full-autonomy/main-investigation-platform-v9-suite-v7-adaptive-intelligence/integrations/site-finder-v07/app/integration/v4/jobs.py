"""
Work the platform assigns to Site Finder.

v4 routes jobs by capability. Site Finder advertises `site:discover` and
`site:relate`, and `lib/events.ts` routes `site.investigated` →
`FIND_RELATED_SITES` → whichever healthy module offers `site:relate`. That is
this module. `RECHECK_TARGET` may also be queued against it.

So the integration is genuinely bidirectional: Site Finder pushes discoveries
up, and the platform pushes related-site work back down — a campaign request,
in the contract's own vocabulary.

THE AUTOMATION POLICY IS NOT ADVISORY
-------------------------------------
Every claimed job carries `automation_policy`. The SDK README states the
module MUST enforce it: use only credentials explicitly configured for that
specific target, never guess credentials, never bypass CAPTCHA or MFA, never
execute a financial transaction. Site Finder does none of those things by
construction — it makes unauthenticated public requests only — but the policy
is checked explicitly on every job anyway, and a job demanding anything outside
it is refused with `needs-review` rather than quietly reinterpreted.

LEASES AND HONESTY
------------------
A claimed job holds a lease. `lib/jobs.ts` recovers expired leases and, past
the attempt limit, moves them to review. So the worst thing Site Finder can do
is hold a job silently: it heartbeats with `current_job_id` while working, and
on restart it reports orphaned jobs as failed rather than letting a lease rot.
"""
import logging
import time

from app import db
from app.integration.v4 import contract
from app.integration.v4.client import PlatformClient, default_client

logger = logging.getLogger("scamhunter.integration.v4.jobs")

# Everything the platform's automation policy prohibits. Site Finder cannot do
# any of it, but the check is explicit so a job asking for it is refused loudly
# rather than being run by something that looks harmless.
PROHIBITED = ("credential-guessing", "brute-force", "captcha-bypass",
              "mfa-bypass", "financial-transactions")


def policy_permits(job: dict) -> tuple:
    """
    Returns (permitted, reason). Refuses anything asking for work outside what
    an unauthenticated public discovery module may do.
    """
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        import json
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}

    policy = payload.get("automation_policy") or {}
    if policy.get("financial_actions_allowed"):
        return False, ("The job permits financial actions. Site Finder never performs "
                       "transactions, so this is refused for review rather than run.")

    requested = str(payload.get("requested_work", "")).lower()
    for prohibited in PROHIBITED:
        if prohibited.replace("-", "") in requested.replace("-", "").replace("_", ""):
            return False, (f"The job requests {prohibited}, which the platform's own "
                           "automation policy prohibits and Site Finder does not do.")

    if payload.get("requires_authentication") or payload.get("credentials"):
        return False, ("The job requires authenticated access. Site Finder works only from "
                       "publicly accessible information; authenticated investigation "
                       "belongs to Site Investigator.")

    job_type = job.get("job_type")
    if job_type not in contract.SITE_FINDER_JOB_TYPES:
        return False, (f"{job_type} is not work this module performs. Site Finder handles "
                       f"{', '.join(contract.SITE_FINDER_JOB_TYPES)}.")

    return True, ("Within policy: unauthenticated public discovery only, no credentials, "
                  "no bypass, no transactions.")


def claim(client: PlatformClient = None) -> dict:
    """
    `POST /api/v1/modules/site_finder/jobs/claim`. Returns the claimed job or
    an empty result — 204 means nothing is waiting, which is not an error.
    """
    client = client or default_client()
    if not client.configured:
        return {"claimed": False, "reason": "No platform configured."}
    try:
        result = client.sdk.claim_job()
    except Exception as exc:                    # noqa: BLE001
        from app.integration.v4.client import _classify_exception
        return {"claimed": False, "reason": _classify_exception(exc).detail}

    job = (result or {}).get("job") if isinstance(result, dict) else None
    if not job:
        return {"claimed": False, "reason": "No work waiting."}

    db.record_claimed_job(
        job["id"], job.get("job_type", ""),
        investigation_id=job.get("investigation_id"),
        payload=job.get("payload"), status="running",
        trigger_reason=job.get("trigger_reason") or "")
    return {"claimed": True, "job": job}


def report_progress(job_id: str, progress: float, message: str,
                    client: PlatformClient = None) -> dict:
    client = client or default_client()
    try:
        client.sdk.update_job(job_id, "progress",
                              progress=max(0.0, min(1.0, progress)), message=message[:2000])
        db.update_claimed_job(job_id, "running", detail=message)
        return {"ok": True}
    except Exception as exc:                    # noqa: BLE001
        from app.integration.v4.client import _classify_exception
        return {"ok": False, "detail": _classify_exception(exc).detail}


def report_complete(job_id: str, result: dict, message: str = "Completed",
                    client: PlatformClient = None) -> dict:
    client = client or default_client()
    try:
        client.sdk.update_job(job_id, "complete", result=result, message=message[:2000])
        db.update_claimed_job(job_id, "completed", detail=message, result=result)
        return {"ok": True}
    except Exception as exc:                    # noqa: BLE001
        from app.integration.v4.client import _classify_exception
        detail = _classify_exception(exc).detail
        db.update_claimed_job(job_id, "completed_locally", detail=detail, result=result)
        return {"ok": False, "detail": detail}


def report_failure(job_id: str, error: str, retry: bool = True,
                   client: PlatformClient = None) -> dict:
    client = client or default_client()
    try:
        client.sdk.update_job(job_id, "fail", error=error[:4000], retry=retry)
        db.update_claimed_job(job_id, "failed", detail=error)
        return {"ok": True}
    except Exception as exc:                    # noqa: BLE001
        from app.integration.v4.client import _classify_exception
        return {"ok": False, "detail": _classify_exception(exc).detail}


def report_needs_review(job_id: str, reason: str,
                        client: PlatformClient = None) -> dict:
    """Hands a job back for a human. Used when policy refuses it."""
    client = client or default_client()
    try:
        client.sdk.update_job(job_id, "needs-review", message=reason[:2000])
        db.update_claimed_job(job_id, "needs-review", detail=reason)
        return {"ok": True}
    except Exception as exc:                    # noqa: BLE001
        from app.integration.v4.client import _classify_exception
        return {"ok": False, "detail": _classify_exception(exc).detail}


def run_find_related_sites(job: dict, client: PlatformClient = None,
                           progress_cb=None) -> dict:
    """
    Executes a FIND_RELATED_SITES job using Site Finder's own engine, then
    returns the discoveries through the canonical ingest path so they land on
    the same investigation the job belongs to.
    """
    progress = progress_cb or (lambda e, d: None)
    client = client or default_client()
    job_id = job["id"]
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        import json
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}

    seed_key = (payload.get("canonical_key") or payload.get("domain")
                or payload.get("target") or "")
    if not seed_key:
        return {"ok": False,
                "detail": "The job carries no canonical_key or domain to expand from."}

    report_progress(job_id, 0.1, f"Expanding from {seed_key}", client=client)
    progress("integration_job_running", {
        "job_id": job_id, "job_type": job.get("job_type"), "seed": seed_key})

    from app.discovery.campaigns import create_campaign, run_campaign
    created = create_campaign(f"platform job {job_id[:8]}", "domain", seed_key)
    campaign_id = created["campaign_id"]

    def campaign_progress(event, data):
        progress(event, data)
        if event == "campaign_stage":
            report_progress(job_id, min(0.9, 0.2 + 0.15 * (data.get("wave") or 0)),
                            f"wave {data.get('wave')} — {data.get('stage')}", client=client)

    outcome = run_campaign(campaign_id, progress_cb=campaign_progress)

    # Everything the campaign promoted goes up through the normal channel,
    # tagged with the job so the platform can tie the results to the request.
    from app.integration.v4.emitter import queue_candidate
    queued = []
    for path in db.paths_for_run(db.create_pivot_run(f"campaign-{campaign_id}", 3, {}),
                                 limit=200):
        if path.get("site_id"):
            result = queue_candidate(path["site_id"])
            if result.get("queued"):
                queued.append(result["batch_id"])

    result = {
        "campaign_key": created["campaign_key"],
        "status": outcome.get("status"),
        "stopped_reason": outcome.get("stopped_reason"),
        "leads_executed": outcome.get("leads_executed"),
        "new_sites": outcome.get("new_sites"),
        "validated": outcome.get("validated"),
        "promoted": outcome.get("promoted"),
        "batches_queued": len(set(queued)),
        "note": ("Candidates are leads with recorded discovery paths. Site Finder performed "
                 "unauthenticated public discovery and triage only."),
    }
    report_complete(job_id, result,
                    message=(f"Expansion from {seed_key} finished: "
                             f"{outcome.get('new_sites', 0)} new candidate(s), "
                             f"{outcome.get('promoted', 0)} promoted."),
                    client=client)
    return {"ok": True, "result": result}


def claim_and_run_one(client: PlatformClient = None, progress_cb=None) -> dict:
    """
    Claims at most one job and runs it. Called on the sync loop; one at a time
    on purpose, so a slow job cannot stall heartbeats or the outbox drain.
    """
    client = client or default_client()
    claimed = claim(client)
    if not claimed.get("claimed"):
        return claimed

    job = claimed["job"]
    job_id = job["id"]

    permitted, reason = policy_permits(job)
    if not permitted:
        report_needs_review(job_id, reason, client=client)
        return {"claimed": True, "job_id": job_id, "ran": False,
                "refused": True, "reason": reason}

    # Heartbeat with the job id so the platform extends the lease rather than
    # treating a slow job as a disconnected worker.
    client.heartbeat(status="running", current_job_id=job_id)

    try:
        from app.config import FINDER_V2
        if job.get("job_type") == "DISCOVER_SITES":
            from app.v2.platform_bridge import run_discover_job
            result = run_discover_job(job)
            report_complete(job_id, result, message=f"v2 round {result['round']}: {result['delivered']} candidate(s) delivered.",
                            client=client)
            outcome = {"v2": result}
        elif job.get("job_type") == "FIND_RELATED_SITES" and FINDER_V2:
            from app.v2.platform_bridge import run_related_job
            result = run_related_job(job)
            delivered = result.get('delivered', len(result.get('new_candidates') or []))
            report_complete(job_id, result, message=f"v2 related-site round from {result.get('seed') or 'recorded public pivot'}: "
                                                    f"{delivered} candidate(s) delivered.", client=client)
            outcome = {"v2": result}
        elif job.get("job_type") == "FIND_RELATED_SITES":
            outcome = run_find_related_sites(job, client=client, progress_cb=progress_cb)
        elif job.get("job_type") == "RECHECK_TARGET":
            outcome = _run_recheck(job, client=client)
        else:
            report_needs_review(job_id, f"{job.get('job_type')} is not handled by this "
                                        "module.", client=client)
            return {"claimed": True, "job_id": job_id, "ran": False, "refused": True}
    except Exception as exc:                    # noqa: BLE001
        logger.exception("Job %s failed", job_id)
        report_failure(job_id, str(exc), retry=True, client=client)
        client.heartbeat(status="idle")
        return {"claimed": True, "job_id": job_id, "ran": False, "error": str(exc)}

    client.heartbeat(status="idle")
    return {"claimed": True, "job_id": job_id, "job_type": job.get("job_type"),
            "ran": True, **outcome}


def _run_recheck(job: dict, client: PlatformClient = None) -> dict:
    """
    RECHECK_TARGET: re-triage a known candidate against public information and
    report what changed. Deliberately shallow — a recheck is still triage, not
    an investigation.
    """
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        import json
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}
    key = payload.get("canonical_key") or payload.get("domain") or ""
    if not key:
        report_failure(job["id"], "No canonical_key or domain to recheck.", retry=False,
                       client=client)
        return {"ok": False, "detail": "No target."}

    with db.get_conn() as conn:
        row = conn.execute("SELECT id FROM sites WHERE domain=? LIMIT 1", (key,)).fetchone()
    if not row:
        report_failure(job["id"], f"{key} is not a known candidate in this installation.",
                       retry=False, client=client)
        return {"ok": False, "detail": "Unknown target."}

    site_id = row["id"]
    from app.analysis.triage import triage_site
    site = db.get_site(site_id)
    before = db.get_triage(site_id) or {}
    result = triage_site(site)
    db.record_triage(site_id, passed=result["passed"], triage_score=result["triage_score"],
                     indicator_count=result["indicator_count"],
                     indicators=result["indicators"],
                     reject_reason=result["reject_reason"],
                     http_status=result["http_status"])

    from app.integration.v4.emitter import queue_candidate
    queued = queue_candidate(site_id)

    outcome = {
        "domain": key,
        "previous_score": before.get("triage_score"),
        "current_score": result["triage_score"],
        "previously_passed": bool(before.get("passed")) if before else None,
        "now_passes": result["passed"],
        "http_status": result["http_status"],
        "requeued": bool(queued.get("queued")),
        "method": "one unauthenticated HTTP GET; no browser, no crawl",
    }
    report_complete(job["id"], outcome,
                    message=f"Rechecked {key}: score {result['triage_score']:.2f}.",
                    client=client)
    return {"ok": True, "result": outcome}


def fail_orphaned_jobs(client: PlatformClient = None) -> dict:
    """
    On restart, tell the platform about jobs this process was holding. Letting
    a lease expire silently is worse: it delays the work by the lease timeout
    and looks like a hung worker rather than a restart.
    """
    client = client or default_client()
    orphans = db.unfinished_jobs()
    if not orphans or not client.configured:
        return {"reported": 0, "orphans": len(orphans)}

    reported = 0
    for job in orphans:
        result = report_failure(
            job["job_id"],
            "Site Finder restarted while holding this job; returning it for retry.",
            retry=True, client=client)
        if result.get("ok"):
            reported += 1
    return {"reported": reported, "orphans": len(orphans),
            "note": (f"{reported} interrupted job(s) returned to the platform for retry "
                     "instead of being left to time out.")}


def jobs_report() -> dict:
    return {
        "claimed": db.list_claimed_jobs(limit=50),
        "handled_types": list(contract.SITE_FINDER_JOB_TYPES),
        "capabilities": list(contract.SITE_FINDER_CAPABILITIES),
        "policy": {
            "prohibited": list(PROHIBITED),
            "note": ("Site Finder makes unauthenticated public requests only. A job "
                     "requiring credentials, authenticated access or a financial action is "
                     "returned for review rather than run."),
        },
    }
