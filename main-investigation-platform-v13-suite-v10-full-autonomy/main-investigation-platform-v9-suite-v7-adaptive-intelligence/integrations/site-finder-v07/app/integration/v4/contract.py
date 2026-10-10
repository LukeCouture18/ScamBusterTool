"""Site Finder schema 3.0 binding to the Main Platform shared contract.

The authoritative schema and event vocabulary live in sdk/contracts/v6.json.
Standalone legacy installs retain local constants until the shared SDK is
available. Passive observations do not route; evidence-backed promotion does.
"""
import json
from pathlib import Path

_shared_contract_path = Path(__file__).resolve().parents[5] / "sdk" / "contracts" / "v6.json"
_canonical = (json.loads(_shared_contract_path.read_text(encoding="utf-8"))
              if _shared_contract_path.is_file() else {})

# ---------------------------------------------------------------------------
# Identity — lib/platform.ts SOURCE_MODULES
# ---------------------------------------------------------------------------

MODULE_NAME = "site_finder"

SOURCE_MODULES = ("site_finder", "site_investigator",
                  "crypto_wallet_logger", "wallet_investigator")

# ---------------------------------------------------------------------------
# Schema versions
# ---------------------------------------------------------------------------

# lib/ingestion.ts ingestSchema: z.enum(["1.0","1.1"]). API.md: "The recommended
# ingestion schema is 1.1".
INGEST_SCHEMA_VERSION = _canonical.get("contract_version", "3.0")
INGEST_SCHEMA_VERSIONS_ACCEPTED = tuple(_canonical.get("compatible_ingestion_versions", ("1.0", "1.1", "3.0")))

# lib/events.ts eventInputSchema: schema_version z.literal("1.0").
EVENT_SCHEMA_VERSION = "3.0"

# app/api/v1/modules/[module]/register/route.ts: schema_version z.literal("1.0").
REGISTER_SCHEMA_VERSION = "3.0"

# lib/domain.mjs schemaCompatibility(): compatible when major === 1, supported "1.x".
SUPPORTED_SCHEMA_MAJOR = 3
SUPPORTED_SCHEMA_LABEL = "3.x"

# ---------------------------------------------------------------------------
# Capabilities — lib/events.ts FALLBACK_CAPABILITIES / PREFERRED
# ---------------------------------------------------------------------------

SITE_FINDER_CAPABILITIES = ("site:discover", "site:relate")

ALL_CAPABILITIES = ("site:discover", "site:relate", "site:investigate",
                    "page:inspect", "wallet:observe", "wallet:log",
                    "transaction:collect", "wallet:analyze")

# ---------------------------------------------------------------------------
# Events — lib/events.ts EVENT_TYPES. This list is closed.
# ---------------------------------------------------------------------------

EVENT_TYPES = tuple(_canonical.get("event_types", ("site.discovered", "site.triaged", "site.investigated", "wallet.observed",
               "wallet.validated", "wallet.analyzed", "evidence.added",
               "relationship.discovered")))
TRIAGE_OUTCOMES = tuple(_canonical.get("triage_outcomes", ("observed", "triaged", "promoted", "dismissed", "inconclusive")))

# The event types site_finder is the natural producer of. Publishing anything
# else would be claiming another module's role.
SITE_FINDER_EVENT_TYPES = ("site.discovered", "wallet.observed",
                           "relationship.discovered", "evidence.added")

# lib/events.ts eventInputSchema is .strict() — additionalProperties are
# REJECTED. These are the only permitted top-level keys.
EVENT_ENVELOPE_FIELDS = ("event_id", "event_type", "schema_version",
                         "correlation_id", "causation_event_id",
                         "investigation_id", "entity_id", "occurred_at",
                         "provenance", "payload", "hop_count")

EVENT_HOP_LIMIT = 8   # lib/events.ts: hop_count max 8, EVENT_HOP_LIMIT_EXCEEDED

# ---------------------------------------------------------------------------
# Jobs — API.md, lib/jobs.ts
# ---------------------------------------------------------------------------

JOB_TYPES = ("INVESTIGATE_SITE", "LOG_WALLET_ACTIVITY", "ANALYZE_WALLET",
             "FIND_RELATED_SITES", "RECHECK_TARGET")

# Which job types route to site_finder, by capability (lib/events.ts PREFERRED
# plus plansFor()). site:relate -> FIND_RELATED_SITES is the one v4 routes to
# this module automatically.
SITE_FINDER_JOB_TYPES = ("FIND_RELATED_SITES", "RECHECK_TARGET", "DISCOVER_SITES")

JOB_STATUSES = ("pending", "running", "retrying", "needs-review",
                "completed", "failed")

# app/api/v1/modules/[module]/jobs/[id]/route.ts action enum.
JOB_ACTIONS = ("progress", "complete", "fail", "needs-review")

# ---------------------------------------------------------------------------
# Ingestion records — lib/ingestion.ts ingestSchema.records (.strict())
# ---------------------------------------------------------------------------

RECORD_TYPES = ("investigations", "sites", "related_sites", "pages",
                "deposit_pages", "wallets", "deposit_options", "transactions",
                "counterparties", "tokens", "networks",
                "infrastructure_indicators", "relationships", "evidence",
                "discovery_paths", "findings", "notes", "module_activity")

# The record types site_finder legitimately produces. It does not produce
# pages, deposit_pages, transactions, counterparties or tokens — those come
# from modules that actually crawl or trace.
SITE_FINDER_RECORD_TYPES = ("investigations", "sites", "related_sites",
                            "wallets", "infrastructure_indicators",
                            "relationships", "evidence", "discovery_paths",
                            "findings", "notes", "module_activity")

# lib/ingestion.ts baseRecord
BASE_RECORD_FIELDS = ("external_id", "investigation_id", "canonical_key",
                      "display_name", "confidence", "classification",
                      "observed_at", "provenance")

# baseRecord is .passthrough(): unknown fields are preserved in the source
# observation rather than rejected. That is the contract's own extension point
# and the only one Site Finder uses for its internal detail.

# lib/ingestion.ts relationshipRecord
RELATIONSHIP_ASSERTION_KINDS = ("observed", "blockchain_fact", "derived")

# lib/ingestion.ts evidenceRecord
EVIDENCE_CLASSES = ("observed_website", "blockchain_fact",
                    "derived_observation", "analyst_note")
OBSERVATION_SCOPES = ("public", "authenticated")

# lib/ingestion.ts activityRecord
MODULE_ACTIVITY_STATUSES = ("idle", "running", "success", "warning",
                            "error", "offline")

# lib/ingestion.ts noteRecord
NOTE_KINDS = ("analyst_note", "conclusion", "review")

# ingestSchema superRefine: at most 1000 records per batch.
MAX_RECORDS_PER_BATCH = 1000
# events route: z.array(eventInputSchema).min(1).max(250)
MAX_EVENTS_PER_PUBLISH = 250
# lib/platform.ts readJsonBody default maxBytes
MAX_REQUEST_BYTES = 5 * 1024 * 1024

# ---------------------------------------------------------------------------
# Which ingest record types cause the adapter to publish which event
# (lib/ingestion.ts, the `groups` loop and the relationship/evidence loops)
# ---------------------------------------------------------------------------

RECORD_TO_AUTO_EVENT = {
    "sites": "site.discovered",            # because module is site_finder
    "related_sites": "site.discovered",
    "wallets": "wallet.observed",
    "relationships": "relationship.discovered",
    "evidence": "evidence.added",
}

# ---------------------------------------------------------------------------
# Heartbeat / register / status — route handlers
# ---------------------------------------------------------------------------

HEARTBEAT_STATUSES = ("idle", "running", "error")

# app/api/v1/modules/[module]/heartbeat/route.ts returns 409 on an incompatible
# schema, 200 otherwise, with {accepted, module, schema_compatible,
# supported_schema, server_time}.
HEARTBEAT_INCOMPATIBLE_STATUS = 409

# ---------------------------------------------------------------------------
# Endpoints (base path /api/v1) — API.md
# ---------------------------------------------------------------------------

ENDPOINTS = {
    "register": "/api/v1/modules/{module}/register",
    "heartbeat": "/api/v1/modules/{module}/heartbeat",
    "events": "/api/v1/events",
    "event_replay": "/api/v1/events/{id}/replay",
    "ingest": "/api/v1/ingest/{module}",
    "claim_job": "/api/v1/modules/{module}/jobs/claim",
    "update_job": "/api/v1/modules/{module}/jobs/{id}",
    "create_job": "/api/v1/jobs",
    "investigation_context": "/api/v1/investigations/{id}/context",
    "evidence_upload": "/api/v1/evidence/upload",
    "dashboard": "/api/v1/dashboard",
    "integration_status": "/api/v1/integration/status",
    "search": "/api/v1/search",
    "orchestration": "/api/v1/orchestration",
}

# ---------------------------------------------------------------------------
# Auth — lib/platform.ts authorizeModule()
# ---------------------------------------------------------------------------

AUTH_HEADER = "X-API-Key"
AUTH_HEADER_ALTERNATE = "Authorization"     # "Bearer <key>"
SITES_BYPASS_HEADER = "OAI-Sites-Authorization"   # "Bearer <sites token>"

# ---------------------------------------------------------------------------
# Responses and retries
# ---------------------------------------------------------------------------

# lib/ingestion.ts ingest() return + route status codes:
#   accepted -> 202, partial -> 202, failed -> 422, replayed -> 200
INGEST_STATUSES = ("accepted", "partial", "failed")

# API.md: "Clients should retry 429 and transient 5xx responses with
# exponential backoff and reuse the same batch ID." The vendored SDK already
# retries exactly (429, 502, 503, 504).
SDK_RETRY_STATUS_CODES = (429, 502, 503, 504)

# lib/domain.mjs retryDelaySeconds(attempt, base=15, cap=3600)
RETRY_BASE_SECONDS = 15
RETRY_CAP_SECONDS = 3600


def retry_delay_seconds(attempt: int, base: int = RETRY_BASE_SECONDS,
                        cap: int = RETRY_CAP_SECONDS) -> float:
    """Transcribed from lib/domain.mjs so both sides back off identically."""
    return min(cap, base * (2 ** max(0, attempt - 1)))


def schema_compatibility(version: str) -> dict:
    """
    Transcribed from lib/domain.mjs schemaCompatibility(). Site Finder uses the
    platform's own rule rather than a rule of its own, so the two sides can
    never disagree about whether they are compatible.
    """
    try:
        major = int(str(version or "0").split(".")[0])
    except ValueError:
        major = 0
    return {"compatible": major == SUPPORTED_SCHEMA_MAJOR,
            "supported": SUPPORTED_SCHEMA_LABEL}


def normalize_canonical_key(record_type: str, record: dict) -> str:
    """
    Transcribed from lib/domain.mjs normalizeCanonicalKey(). Site Finder
    computes the same key the platform will, so a record it sends resolves to
    the entity it expects rather than creating a near-duplicate.
    """
    from urllib.parse import urlparse

    raw = (record.get("canonical_key") or record.get("url")
           or record.get("address") or record.get("tx_hash")
           or record.get("external_id"))
    key = str(raw).strip().lower().rstrip("/")

    if record_type in ("site", "related_site"):
        try:
            candidate = key if "://" in key else f"https://{key}"
            hostname = (urlparse(candidate).hostname or key).lower()
            key = hostname[4:] if hostname.startswith("www.") else hostname
        except ValueError:
            pass
    elif record_type in ("page", "deposit_page"):
        try:
            parsed = urlparse(key)
            key = parsed._replace(fragment="").geturl().rstrip("/")
        except ValueError:
            pass
    elif record_type in ("wallet", "token", "transaction", "counterparty"):
        network = str(record.get("network") or record.get("chain")
                      or record.get("chain_id") or "unknown").strip().lower()
        key = f"{network}:{key}"

    return key


def is_event_envelope_valid(event: dict) -> list:
    """
    Checks an event against the platform's .strict() envelope BEFORE sending.
    An unknown top-level key is a hard rejection at the platform, so catching
    it here turns a 400 into a local error with a useful message.
    """
    problems = []
    unknown = set(event) - set(EVENT_ENVELOPE_FIELDS)
    if unknown:
        problems.append(
            f"unknown top-level field(s) {sorted(unknown)} — the v4 event envelope is "
            "strict; module-specific detail belongs inside payload or provenance")
    if event.get("event_type") not in EVENT_TYPES:
        problems.append(f"event_type {event.get('event_type')!r} is not a v4 event type")
    if event.get("schema_version") != EVENT_SCHEMA_VERSION:
        problems.append(f"schema_version must be {EVENT_SCHEMA_VERSION!r}")
    if not event.get("event_id"):
        problems.append("event_id is required")
    hop = event.get("hop_count", 0)
    if not isinstance(hop, int) or hop < 0 or hop > EVENT_HOP_LIMIT:
        problems.append(f"hop_count must be an integer 0..{EVENT_HOP_LIMIT}")
    return problems
