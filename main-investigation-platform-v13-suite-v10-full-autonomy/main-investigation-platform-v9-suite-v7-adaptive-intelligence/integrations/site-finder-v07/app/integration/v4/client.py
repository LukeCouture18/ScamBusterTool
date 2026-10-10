"""
Talking to the platform: the canonical SDK, plus the durability around it.

The wire calls themselves are the platform's own
`MainInvestigationClient` — vendored, unmodified, in this package. This module
does not reimplement a single request. What it adds is the three things a
production sensor needs that an SDK is not responsible for:

  offline durability   nothing is sent that was not first written to the
                       outbox, so a discovery survives the platform being down
  honest classification the SDK raises; the caller needs to know whether to
                       retry, and that is a different question from what went
                       wrong
  stored connection state so the UI and the sync worker read one answer rather
                       than each probing the network separately

WHY CLASSIFICATION IS SEPARATE FROM THE SDK
-------------------------------------------
The SDK already retries 429/502/503/504 internally, which is right for a
transient blip. What it cannot decide is what to do when that retry budget is
exhausted, or when the platform returns 400 because a record is malformed.
Those need opposite responses — keep trying versus stop and surface — and
getting them the wrong way round either loses discoveries or fills the queue
with events that will never be accepted. So every outcome here is classified
explicitly and tested.

A transport exception after the request left is AMBIGUOUS: the platform may
have it. That is what batch idempotency is for — API.md says to reuse the same
batch id on retry, and the platform returns the original result. So ambiguous
means retry, always.
"""
import logging
import time
import sys
from pathlib import Path

from app import db
from app.config import (
    MAIN_PLATFORM_URL, MAIN_PLATFORM_TOKEN, MAIN_PLATFORM_TIMEOUT_SECONDS,
    MAIN_PLATFORM_HEARTBEAT_STALE_AFTER, SITE_FINDER_MODULE_VERSION,
    MAIN_PLATFORM_SITES_TOKEN,
)
from app.integration.v4 import contract
_shared_sdk_root = Path(__file__).resolve().parents[5]
if (_shared_sdk_root / "sdk" / "python" / "main_investigation_client.py").is_file():
    sys.path.insert(0, str(_shared_sdk_root))
try:
    # In the five-module distribution all transport calls use the shared SDK.
    from sdk.python.main_investigation_client import MainInvestigationClient
except ModuleNotFoundError:
    # Standalone Site Finder installations retain their vendored v4-compatible
    # client until the canonical SDK is installed in that environment.
    from app.integration.v4.main_investigation_client import MainInvestigationClient

logger = logging.getLogger("scamhunter.integration.v4.client")


class Outcome:
    """
    What happened to one call. `retryable` is the only question the sync
    worker actually needs answered.
    """

    def __init__(self, ok: bool, kind: str, detail: str, body: dict = None,
                 status_code: int = None):
        self.ok = ok
        self.kind = kind    # accepted | partial | duplicate | rejected | unreachable | ambiguous
        self.detail = detail
        self.body = body or {}
        self.status_code = status_code

    @property
    def retryable(self) -> bool:
        return self.kind in ("unreachable", "ambiguous")

    def __repr__(self):
        return f"<Outcome {self.kind} ok={self.ok}>"


def _classify_exception(exc: Exception) -> Outcome:
    """
    Turns an SDK exception into a decision. The SDK raises urllib's HTTPError
    for a definite HTTP answer and other exceptions for transport failures,
    and those mean different things.
    """
    import urllib.error

    if isinstance(exc, urllib.error.HTTPError):
        code = exc.code
        try:
            detail = exc.read().decode("utf-8", "ignore")[:500]
        except Exception:                      # noqa: BLE001
            detail = ""
        if code in (401, 403):
            return Outcome(False, "rejected",
                           ("The platform rejected this module's API key. Check "
                            "MAIN_PLATFORM_TOKEN against the site_finder entry in the "
                            "platform's MODULE_API_KEYS."), status_code=code)
        if code == 404:
            return Outcome(False, "rejected",
                           f"The platform does not know this endpoint or module: {detail}",
                           status_code=code)
        if code in (400, 409, 422):
            return Outcome(False, "rejected",
                           (f"The platform rejected the payload (HTTP {code}): {detail}. "
                            "Retrying would send the same payload again, so this is "
                            "surfaced rather than requeued."), status_code=code)
        if code in contract.SDK_RETRY_STATUS_CODES:
            return Outcome(False, "unreachable",
                           (f"HTTP {code} after the SDK exhausted its own retries; "
                            "queued for a later attempt."), status_code=code)
        return Outcome(False, "unreachable", f"Unexpected HTTP {code}: {detail}",
                       status_code=code)

    # No HTTP answer at all. The request may or may not have arrived, so this
    # is ambiguous by definition and must be retried under the same batch id.
    return Outcome(False, "ambiguous",
                   f"No definite answer from the platform: {exc}")


class PlatformClient:
    """
    Site Finder's handle on the platform. `sdk` is injectable so tests drive
    the same code production does.
    """

    def __init__(self, base_url: str = None, api_key: str = None,
                 sites_bypass_token: str = None, sdk=None):
        self.base_url = (base_url if base_url is not None else MAIN_PLATFORM_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else MAIN_PLATFORM_TOKEN
        self.sites_bypass_token = (sites_bypass_token if sites_bypass_token is not None
                                   else MAIN_PLATFORM_SITES_TOKEN)
        self._sdk = sdk

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    @property
    def sdk(self) -> MainInvestigationClient:
        if self._sdk is None:
            self._sdk = MainInvestigationClient(
                self.base_url, contract.MODULE_NAME, self.api_key,
                sites_bypass_token=self.sites_bypass_token or None)
        return self._sdk

    @property
    def endpoint(self) -> str:
        return self.base_url or "unconfigured"

    # ---- registration and health -----------------------------------------

    def register(self) -> dict:
        """
        `POST /api/v1/modules/site_finder/register` — capability discovery.
        Called once at startup, as the SDK README instructs.
        """
        if not self.configured:
            db.update_integration_status(
                "unconfigured", state="unconfigured",
                compatibility_detail=("No platform URL or module API key configured. Site "
                                      "Finder runs standalone and queues everything it "
                                      "would send."))
            return {"registered": False, "state": "unconfigured",
                    "detail": "No MAIN_PLATFORM_URL / MAIN_PLATFORM_TOKEN configured."}
        try:
            body = self.sdk.register(
                SITE_FINDER_MODULE_VERSION,
                list(contract.SITE_FINDER_CAPABILITIES),
                supported_event_types=["site.investigated", "wallet.validated", "wallet.analyzed", "evidence.added", "relationship.discovered"],
                metadata={
                    **({"feedback_webhook_url": __import__("os").environ["MAIN_PLATFORM_FEEDBACK_WEBHOOK_URL"]} if __import__("os").environ.get("MAIN_PLATFORM_FEEDBACK_WEBHOOK_URL") else {}),
                    "ingest_schema_version": contract.INGEST_SCHEMA_VERSION,
                    "event_schema_version": contract.EVENT_SCHEMA_VERSION,
                    "record_types": list(contract.SITE_FINDER_RECORD_TYPES),
                    "job_types": list(contract.SITE_FINDER_JOB_TYPES),
                    "role": ("discovery, lightweight public triage, correlation and "
                             "prioritisation; no authenticated access, no page crawling, "
                             "no blockchain tracing"),
                }) or {}
        except Exception as exc:                # noqa: BLE001
            outcome = _classify_exception(exc)
            self._record_failure(outcome.detail)
            return {"registered": False, "state": "offline", "detail": outcome.detail}

        db.update_integration_status(
            self.endpoint, state="online", compatible=True, degraded=False,
            platform_schema=contract.EVENT_SCHEMA_VERSION,
            compatibility_detail=(
                f"Registered as {contract.MODULE_NAME} with capabilities "
                f"{', '.join(body.get('capabilities') or contract.SITE_FINDER_CAPABILITIES)}."),
            last_heartbeat_at=time.time(), last_success_at=time.time(),
            consecutive_failures=0, last_error=None)
        return {"registered": bool(body.get("registered", True)), "state": "online",
                "capabilities": body.get("capabilities"),
                "supported_event_types": body.get("supported_event_types"),
                "detail": "Registered with the platform."}

    def heartbeat(self, status: str = "idle", current_job_id: str = None,
                  error: str = None) -> dict:
        """
        `POST /api/v1/modules/site_finder/heartbeat`.

        The platform answers 409 when the schema is incompatible, and the SDK
        raises on that. That is a real answer, not an outage, so it is recorded
        as incompatible rather than offline — the difference decides whether
        anything should be sent.
        """
        if not self.configured:
            return {"alive": False, "state": "unconfigured",
                    "detail": "No platform URL or module API key configured."}

        body = {"module_version": SITE_FINDER_MODULE_VERSION,
                "schema_version": contract.INGEST_SCHEMA_VERSION,
                "status": status if status in contract.HEARTBEAT_STATUSES else "idle",
                "capabilities": list(contract.SITE_FINDER_CAPABILITIES)}
        if current_job_id:
            body["current_job_id"] = current_job_id
        if error:
            body["error"] = error[:1000]

        try:
            # Sent through the SDK's own request method so the auth headers,
            # retry policy and timeouts are the platform's, not ours.
            result = self.sdk._request(
                contract.ENDPOINTS["heartbeat"].format(module=contract.MODULE_NAME),
                "POST", body) or {}
        except Exception as exc:                # noqa: BLE001
            outcome = _classify_exception(exc)
            if outcome.status_code == contract.HEARTBEAT_INCOMPATIBLE_STATUS:
                db.update_integration_status(
                    self.endpoint, state="incompatible", compatible=False,
                    compatibility_detail=(
                        f"The platform rejected schema {contract.INGEST_SCHEMA_VERSION} as "
                        f"incompatible (HTTP 409). Nothing is being sent; events stay "
                        "queued until the versions line up."),
                    last_error=outcome.detail, last_error_at=time.time())
                return {"alive": False, "state": "incompatible", "detail": outcome.detail}
            self._record_failure(outcome.detail)
            return {"alive": False, "state": "offline", "detail": outcome.detail}

        compatible = bool(result.get("schema_compatible", True))
        db.update_integration_status(
            self.endpoint, state="online" if compatible else "incompatible",
            compatible=compatible, degraded=False,
            platform_schema=result.get("supported_schema") or contract.SUPPORTED_SCHEMA_LABEL,
            compatibility_detail=(
                f"Platform accepts {result.get('supported_schema', contract.SUPPORTED_SCHEMA_LABEL)}; "
                f"Site Finder sends {contract.INGEST_SCHEMA_VERSION}."
                if compatible else
                f"The platform reports schema {contract.INGEST_SCHEMA_VERSION} incompatible; "
                f"it supports {result.get('supported_schema')}."),
            last_heartbeat_at=time.time(),
            last_success_at=time.time() if compatible else None,
            consecutive_failures=0, last_error=None)
        return {"alive": True, "state": "online" if compatible else "incompatible",
                "schema_compatible": compatible,
                "supported_schema": result.get("supported_schema"),
                "server_time": result.get("server_time"),
                "detail": "Platform acknowledged the heartbeat."}

    def _record_failure(self, detail: str):
        status = db.get_integration_status(self.endpoint) or {}
        failures = (status.get("consecutive_failures") or 0) + 1
        db.update_integration_status(
            self.endpoint, state="offline", last_error=detail,
            last_error_at=time.time(), consecutive_failures=failures)

    def is_online(self) -> bool:
        """
        From stored state, with no network call. A heartbeat older than the
        staleness window is not online — a link that stopped answering does not
        become healthy because nobody checked.
        """
        if not self.configured:
            return False
        status = db.get_integration_status(self.endpoint)
        if not status or status.get("state") != "online" or not status.get("compatible"):
            return False
        return (time.time() - (status.get("last_heartbeat_at") or 0)) <= \
            MAIN_PLATFORM_HEARTBEAT_STALE_AFTER

    # ---- sending ----------------------------------------------------------

    def send_batch(self, records: dict, batch_id: str,
                   origin_job_id: str = None) -> Outcome:
        """
        `POST /api/v1/ingest/site_finder`. Never raises: the caller's job is to
        decide what happens next, and an exception type cannot tell it that.
        """
        if not self.configured:
            return Outcome(False, "unreachable",
                           "No platform configured; the batch stays queued.")

        from app.integration.v4.translator import validate_batch
        problems = validate_batch(records)
        if problems:
            return Outcome(False, "rejected",
                           "Batch is malformed and was not sent: " + "; ".join(problems))

        try:
            body = self.sdk.ingest(records, batch_id, origin_job_id=origin_job_id) or {}
        except Exception as exc:                # noqa: BLE001
            return _classify_exception(exc)

        status = (body.get("status") or "accepted").lower()
        if body.get("replayed"):
            return Outcome(True, "duplicate",
                           (f"The platform already had batch {batch_id} and returned its "
                            "original result — the retry changed nothing."), body)
        if status == "failed":
            return Outcome(False, "rejected",
                           (f"Every record in batch {batch_id} was rejected: "
                            f"{body.get('errors')}"), body)
        if status == "partial":
            return Outcome(True, "partial",
                           (f"{body.get('inserted_count', 0)} inserted, "
                            f"{body.get('updated_count', 0)} updated, "
                            f"{body.get('error_count', 0)} record(s) rejected and "
                            "dead-lettered by the platform."), body)
        return Outcome(True, "accepted",
                       (f"{body.get('inserted_count', 0)} inserted, "
                        f"{body.get('updated_count', 0)} updated, "
                        f"{body.get('duplicate_count', 0)} duplicate."), body)

    def publish_events(self, events: list) -> Outcome:
        """
        `POST /api/v1/events`.

        Site Finder rarely uses this: without a platform `entity_id` an event
        is persisted but not routed (lib/events.ts skips job creation), and
        entity IDs are minted by the platform. Ingesting records is the channel
        that gets Site Finder's discoveries routed. This exists for the cases
        where an entity id IS known — from a claimed job or investigation
        context.
        """
        if not self.configured:
            return Outcome(False, "unreachable", "No platform configured.")
        if len(events) > contract.MAX_EVENTS_PER_PUBLISH:
            return Outcome(False, "rejected",
                           f"{len(events)} events exceeds the v4 maximum of "
                           f"{contract.MAX_EVENTS_PER_PUBLISH} per publish.")
        for event in events:
            problems = contract.is_event_envelope_valid(event)
            if problems:
                return Outcome(False, "rejected",
                               f"Event {event.get('event_id')} is invalid: "
                               + "; ".join(problems))
        try:
            body = self.sdk.publish_events(events) or {}
        except Exception as exc:                # noqa: BLE001
            return _classify_exception(exc)
        duplicates = body.get("duplicates", 0)
        return Outcome(True, "duplicate" if duplicates == len(events) else "accepted",
                       f"{body.get('accepted', 0)} accepted, {duplicates} duplicate.", body)

    # ---- reading ----------------------------------------------------------

    def investigation_context(self, investigation_id: str) -> dict:
        """
        `GET /api/v1/investigations/{id}/context?module=site_finder`.

        This is the contract's channel for a worker to see shared context, and
        it is how Site Finder learns what happened downstream — the entities,
        evidence and relationships other modules added to an investigation it
        opened.
        """
        if not self.configured:
            return {"error": "No platform configured."}
        try:
            return self.sdk.investigation_context(investigation_id) or {}
        except Exception as exc:                # noqa: BLE001
            return {"error": _classify_exception(exc).detail}

    def integration_status(self) -> dict:
        """`GET /api/v1/integration/status` — the platform's own view of us."""
        if not self.configured:
            return {"error": "No platform configured."}
        try:
            return self.sdk._request(contract.ENDPOINTS["integration_status"]) or {}
        except Exception as exc:                # noqa: BLE001
            return {"error": _classify_exception(exc).detail}


def default_client() -> PlatformClient:
    return PlatformClient()


def connection_report() -> dict:
    """Everything needed to answer 'is the integration working?'."""
    client = default_client()
    status = db.get_integration_status(client.endpoint) or {}
    outbox = db.outbox_stats()

    if not client.configured:
        summary = ("Not configured. Site Finder is running standalone — discoveries are "
                   "queued locally and will sync once a platform URL and module API key "
                   "are set. Nothing is being lost.")
    elif status.get("state") == "online":
        summary = "Connected and registered."
    elif status.get("state") == "incompatible":
        summary = ("Reachable but the platform rejected this schema version, so nothing is "
                   "being sent. Batches are queued and will go out once the versions line "
                   "up.")
    elif status.get("state") == "offline":
        summary = (f"Offline ({status.get('consecutive_failures', 0)} failed check(s)). "
                   f"{outbox['pending']} batch(es) waiting; discovery is unaffected.")
    else:
        summary = status.get("last_error") or "Not yet connected."

    return {
        "endpoint": client.endpoint, "configured": client.configured,
        "module": contract.MODULE_NAME,
        "module_version": SITE_FINDER_MODULE_VERSION,
        "capabilities": list(contract.SITE_FINDER_CAPABILITIES),
        **({"feedback_webhook_url": __import__("os").environ["MAIN_PLATFORM_FEEDBACK_WEBHOOK_URL"]} if __import__("os").environ.get("MAIN_PLATFORM_FEEDBACK_WEBHOOK_URL") else {}),
                    "ingest_schema_version": contract.INGEST_SCHEMA_VERSION,
        "event_schema_version": contract.EVENT_SCHEMA_VERSION,
        "state": status.get("state", "unconfigured"),
        "compatible": bool(status.get("compatible")),
        "compatibility_detail": status.get("compatibility_detail", ""),
        "platform_schema": status.get("platform_schema"),
        "last_heartbeat_at": status.get("last_heartbeat_at"),
        "last_success_at": status.get("last_success_at"),
        "last_error": status.get("last_error"),
        "consecutive_failures": status.get("consecutive_failures", 0),
        "outbox": outbox,
        "summary": summary,
    }
