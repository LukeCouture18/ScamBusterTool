"""
A reference implementation of the canonical Main Investigation Platform v4.

This is NOT the real platform. It is a faithful stand-in for the parts of the
v4 contract Site Finder touches, transcribed from the platform's own route
handlers and libraries, so the integration can be tested end to end without a
deployment.

It implements, with the platform's own semantics:

  POST /api/v1/modules/{module}/register     capability registration
  POST /api/v1/modules/{module}/heartbeat    health, schema compatibility (409)
  POST /api/v1/ingest/{module}               batch idempotency, per-record
                                             isolation, dead letters, AND the
                                             compatibility adapter that
                                             publishes v4 events with the
                                             entity ids it mints
  POST /api/v1/events                        direct publication, idempotent
  POST /api/v1/modules/{module}/jobs/claim   atomic lease
  PATCH /api/v1/modules/{module}/jobs/{id}   progress/complete/fail/needs-review
  GET  /api/v1/investigations/{id}/context   shared context
  GET  /api/v1/integration/status            module registry view

The behaviours that matter most for testing are the ones a naive mock would
get wrong, so they are implemented properly rather than stubbed:

  * `source_module + batch_id` replays return the ORIGINAL result with
    `replayed: true`, so a retry cannot double-ingest.
  * `source_module + record_type + external_id` updates one observation
    instead of inserting a second.
  * entities are keyed by `entity_type + canonical_key`, normalised with the
    platform's own rule.
  * ingesting a site from site_finder publishes `site.discovered` and routes
    it to `INVESTIGATE_SITE` — the real handoff path.
  * a bad record is dead-lettered and the batch comes back `partial`, rather
    than the whole batch failing.
  * an unknown top-level event field is rejected, because the real envelope is
    strict.
"""
import hashlib
import json
import threading
import time
import uuid

from app.integration.v4 import contract

PLATFORM_VERSION = "main-platform/4.0-reference"


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sha(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str)
                          .encode("utf-8", "ignore")).hexdigest()


class ReferencePlatform:
    """In-memory v4. Thread-safe: tests assert while a server thread serves."""

    def __init__(self, module_api_keys: dict = None,
                 supported_schema_major: int = contract.SUPPORTED_SCHEMA_MAJOR):
        self.module_api_keys = module_api_keys or {"site_finder": "test-key"}
        self.supported_schema_major = supported_schema_major
        self._lock = threading.Lock()

        self.module_registry = {}
        self.batches = {}            # (module, batch_id) -> result
        self.observations = {}       # (module, record_type, external_id) -> record
        self.entities = {}           # (entity_type, canonical_key) -> entity
        self.investigations = {}     # investigation uuid -> investigation
        self.investigation_by_external = {}
        self.events = {}             # event_id -> event
        self.event_order = []
        self.jobs = {}               # job id -> job
        self.dead_letters = []
        self.relationships = []
        self.evidence = []
        self.findings = []
        self.module_activity = []
        self.duplicate_events = 0
        self.heartbeats = 0
        self.registrations = 0

    # ---- auth -----------------------------------------------------------

    def authorize(self, module: str, headers: dict) -> bool:
        configured = self.module_api_keys.get(module)
        if not configured:
            return False
        supplied = headers.get("x-api-key") or ""
        if not supplied:
            auth = headers.get("authorization") or ""
            if auth.lower().startswith("bearer "):
                supplied = auth[7:]
        return supplied == configured

    # ---- module lifecycle -----------------------------------------------

    def register(self, module: str, body: dict) -> tuple:
        for field in ("module_version", "schema_version", "capabilities"):
            if field not in body:
                return {"error": {"code": "VALIDATION_ERROR",
                                  "message": f"missing {field}"}}, 400
        if body.get("schema_version") not in ("1.0", contract.REGISTER_SCHEMA_VERSION):
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "schema_version must be 1.0"}}, 400
        with self._lock:
            self.registrations += 1
            self.module_registry[module] = {
                "module_name": module, "connection_status": "connected",
                "runtime_status": "idle", "module_version": body["module_version"],
                "schema_version": body["schema_version"],
                "capabilities": list(body["capabilities"]),
                "supported_event_types": list(body.get("supported_event_types") or []),
                "registration_metadata": body.get("metadata") or {},
                "last_registered_at": _now_iso(), "last_heartbeat_at": time.time(),
            }
        return {"module_name": module, "registered": True,
                "capabilities": body["capabilities"],
                "supported_event_types": body.get("supported_event_types") or []}, 200

    def heartbeat(self, module: str, body: dict) -> tuple:
        if body.get("status") not in contract.HEARTBEAT_STATUSES:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "invalid status"}}, 400
        try:
            major = int(str(body.get("schema_version", "0")).split(".")[0])
        except ValueError:
            major = 0
        compatible = major == self.supported_schema_major or (self.supported_schema_major == 3 and major == 1)
        supported = f"{self.supported_schema_major}.x"

        with self._lock:
            self.heartbeats += 1
            entry = self.module_registry.setdefault(module, {"module_name": module})
            entry.update({
                "connection_status": "connected",
                "runtime_status": body["status"] if compatible else "error",
                "module_version": body.get("module_version"),
                "schema_version": body.get("schema_version"),
                "capabilities": list(body.get("capabilities") or []),
                "current_job_id": body.get("current_job_id"),
                "last_heartbeat_at": time.time(),
                "last_error": (None if compatible else
                               f"Incompatible schema {body.get('schema_version')}; "
                               f"expected {supported}"),
            })
            if body.get("current_job_id") and body["current_job_id"] in self.jobs:
                self.jobs[body["current_job_id"]]["lease_expires_at"] = time.time() + 300

        return ({"accepted": True, "module": module, "schema_compatible": compatible,
                 "supported_schema": supported, "server_time": _now_iso()},
                200 if compatible else contract.HEARTBEAT_INCOMPATIBLE_STATUS)

    # ---- ingestion -------------------------------------------------------

    def ingest(self, module: str, payload: dict) -> tuple:
        if payload.get("schema_version") not in contract.INGEST_SCHEMA_VERSIONS_ACCEPTED:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "schema_version must be 1.0 or 1.1"}}, 400
        for field in ("batch_id", "sent_at", "records"):
            if not payload.get(field):
                return {"error": {"code": "VALIDATION_ERROR",
                                  "message": f"missing {field}"}}, 400
        records = payload["records"]
        if not isinstance(records, dict):
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "records must be an object"}}, 400
        unknown = set(records) - set(contract.RECORD_TYPES)
        if unknown:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": f"unknown record types {sorted(unknown)}"}}, 400

        total = sum(len(rows) for rows in records.values())
        if total > contract.MAX_RECORDS_PER_BATCH:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "batch exceeds 1000 records"}}, 400

        batch_key = (module, payload["batch_id"])
        with self._lock:
            if batch_key in self.batches:
                return {**self.batches[batch_key], "replayed": True}, 200

        inserted = updated = duplicate = 0
        errors = []
        schema_version = payload["schema_version"]

        with self._lock:
            # Investigations first: later records reference them by external id.
            for row in records.get("investigations", []):
                try:
                    self._upsert_investigation(module, row)
                    inserted += 1
                except Exception as exc:        # noqa: BLE001
                    errors.append(self._dead_letter(module, payload["batch_id"],
                                                    "investigation", row, exc))

            entity_groups = [
                ("site", records.get("sites", [])),
                ("related_site", records.get("related_sites", [])),
                ("wallet", records.get("wallets", [])),
                ("infrastructure_indicator", records.get("infrastructure_indicators", [])),
                ("page", records.get("pages", [])),
                ("deposit_page", records.get("deposit_pages", [])),
            ]
            for record_type, rows in entity_groups:
                for row in rows:
                    try:
                        result = self._upsert_observation(module, schema_version,
                                                          record_type, row)
                        if result["status"] == "inserted":
                            inserted += 1
                        elif result["status"] == "updated":
                            updated += 1
                        else:
                            duplicate += 1

                        # The compatibility adapter: publish the v4 event, with
                        # the entity id the platform just minted.
                        if result["status"] != "duplicate" and record_type in (
                                "site", "related_site", "wallet"):
                            event_type = ("wallet.observed" if record_type == "wallet"
                                          else ("site.discovered" if module == "site_finder"
                                                else "site.investigated"))
                            self._publish(module, {
                                "event_id": (f"ingest:{module}:{record_type}:"
                                             f"{row['external_id']}:{result['content_hash']}"),
                                "event_type": event_type,
                                "schema_version": contract.EVENT_SCHEMA_VERSION,
                                "correlation_id": payload.get("origin_job_id")
                                                  or payload["batch_id"],
                                "investigation_id": result["investigation_id"],
                                "entity_id": result["entity_id"],
                                "occurred_at": row.get("observed_at") or _now_iso(),
                                "provenance": {**(row.get("provenance") or {}),
                                               "adapter": "legacy-ingestion",
                                               "batch_id": payload["batch_id"]},
                                "payload": {"canonical_key": result["canonical_key"],
                                            "confidence": row.get("confidence", 0.5),
                                            "classification": row.get("classification"),
                                            "priority": row.get("priority"),
                                            "source_record_id": row["external_id"]},
                                "hop_count": 0,
                            })
                    except Exception as exc:    # noqa: BLE001
                        errors.append(self._dead_letter(module, payload["batch_id"],
                                                        record_type, row, exc))

            for row in records.get("evidence", []):
                try:
                    self._validate_evidence(row)
                    self.evidence.append({**row, "source_module": module,
                                          "investigation_id": self._resolve_investigation(
                                              row.get("investigation_id"))})
                    inserted += 1
                except Exception as exc:        # noqa: BLE001
                    errors.append(self._dead_letter(module, payload["batch_id"],
                                                    "evidence", row, exc))

            known_evidence = {e["external_id"] for e in self.evidence
                              if e.get("source_module") == module}
            for row in records.get("relationships", []):
                try:
                    self._validate_relationship(row, schema_version, known_evidence)
                    self.relationships.append({**row, "source_module": module,
                                               "investigation_id": self._resolve_investigation(
                                                   row.get("investigation_id"))})
                    inserted += 1
                    self._publish(module, {
                        "event_id": (f"ingest:{module}:relationship:{row['external_id']}:"
                                     f"{_sha(row)[:16]}"),
                        "event_type": "relationship.discovered",
                        "schema_version": contract.EVENT_SCHEMA_VERSION,
                        "correlation_id": payload["batch_id"],
                        "investigation_id": self._resolve_investigation(
                            row.get("investigation_id")),
                        "occurred_at": row.get("observed_at") or _now_iso(),
                        "provenance": {**(row.get("provenance") or {}),
                                       "adapter": "legacy-ingestion"},
                        "payload": {"relationship_type": row["relationship_type"],
                                    "assertion_kind": row.get("assertion_kind"),
                                    "confidence": row.get("confidence"),
                                    "evidence_ids": row.get("evidence_ids")},
                        "hop_count": 0,
                    })
                except Exception as exc:        # noqa: BLE001
                    errors.append(self._dead_letter(module, payload["batch_id"],
                                                    "relationship", row, exc))

            for record_type, store in (("discovery_paths", None), ("findings", self.findings),
                                       ("notes", None),
                                       ("module_activity", self.module_activity)):
                for row in records.get(record_type, []):
                    try:
                        if not row.get("external_id"):
                            raise ValueError("external_id is required")
                        if record_type == "module_activity" and row.get("status") not in \
                                contract.MODULE_ACTIVITY_STATUSES:
                            raise ValueError(f"invalid activity status {row.get('status')}")
                        if record_type == "discovery_paths" and not row.get("steps"):
                            raise ValueError("steps must be a non-empty array")
                        if store is not None:
                            store.append({**row, "source_module": module})
                        inserted += 1
                    except Exception as exc:    # noqa: BLE001
                        errors.append(self._dead_letter(module, payload["batch_id"],
                                                        record_type, row, exc))

            received = total
            status = ("accepted" if not errors
                      else ("partial" if len(errors) < received else "failed"))
            result = {"batch_id": payload["batch_id"], "status": status,
                      "received_count": received, "inserted_count": inserted,
                      "updated_count": updated, "duplicate_count": duplicate,
                      "error_count": len(errors), "errors": errors, "replayed": False}
            self.batches[batch_key] = dict(result)

        return result, (422 if status == "failed" else 202)

    # ---- ingestion internals --------------------------------------------

    def _dead_letter(self, module, batch_id, record_type, row, error):
        entry = {"record": f"{record_type}:{(row or {}).get('external_id', 'unknown')}",
                 "message": str(error)}
        self.dead_letters.append({**entry, "source_module": module,
                                  "batch_id": batch_id, "record_type": record_type})
        return entry

    def _upsert_investigation(self, module, row):
        if not row.get("external_id"):
            raise ValueError("external_id is required")
        if not row.get("title"):
            raise ValueError("investigations require a title")
        existing = self.investigation_by_external.get(row["external_id"])
        if existing:
            self.investigations[existing].update({
                "title": row["title"], "status": row.get("status", "open"),
                "priority": row.get("priority", "normal")})
            return existing
        investigation_id = str(uuid.uuid4())
        self.investigations[investigation_id] = {
            "id": investigation_id, "external_id": row["external_id"],
            "title": row["title"], "status": row.get("status", "open"),
            "priority": row.get("priority", "normal"),
            "created_at": _now_iso(), "source_module": module,
        }
        self.investigation_by_external[row["external_id"]] = investigation_id
        return investigation_id

    def _resolve_investigation(self, value):
        if not value:
            return None
        if value in self.investigations:
            return value
        return self.investigation_by_external.get(value)

    def _upsert_observation(self, module, schema_version, record_type, row):
        if not row.get("external_id"):
            raise ValueError("external_id is required")
        confidence = row.get("confidence", 0.5)
        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")

        canonical_key = contract.normalize_canonical_key(record_type, row)
        if not canonical_key:
            raise ValueError("could not derive a canonical key")

        entity_key = (record_type, canonical_key)
        investigation_id = self._resolve_investigation(row.get("investigation_id"))
        entity = self.entities.get(entity_key)
        if not entity:
            entity = {"id": str(uuid.uuid4()), "entity_type": record_type,
                      "canonical_key": canonical_key,
                      "display_name": row.get("display_name") or canonical_key,
                      "investigation_id": investigation_id,
                      "source_module": module, "created_at": _now_iso()}
            self.entities[entity_key] = entity

        content_hash = _sha(row)[:32]
        observation_key = (module, record_type, row["external_id"])
        previous = self.observations.get(observation_key)
        self.observations[observation_key] = {
            "record": row, "entity_id": entity["id"], "content_hash": content_hash,
            "schema_version": schema_version, "source_module": module}

        if previous is None:
            status = "inserted"
        elif previous["content_hash"] == content_hash:
            status = "duplicate"
        else:
            status = "updated"

        return {"status": status, "entity_id": entity["id"],
                "canonical_key": canonical_key, "content_hash": content_hash,
                "investigation_id": investigation_id}

    def _validate_evidence(self, row):
        if not row.get("external_id"):
            raise ValueError("external_id is required")
        if not row.get("title"):
            raise ValueError("evidence requires a title")
        if not row.get("evidence_type"):
            raise ValueError("evidence requires an evidence_type")
        if row.get("evidence_class", "observed_website") not in contract.EVIDENCE_CLASSES:
            raise ValueError(f"evidence_class must be one of {contract.EVIDENCE_CLASSES}")
        if row.get("observation_scope", "public") not in contract.OBSERVATION_SCOPES:
            raise ValueError("observation_scope must be public or authenticated")

    def _validate_relationship(self, row, schema_version, known_evidence):
        if not row.get("external_id"):
            raise ValueError("external_id is required")
        if not row.get("relationship_type"):
            raise ValueError("relationship_type is required")
        for side in ("from", "to"):
            node = row.get(side) or {}
            if not node.get("entity_type") or not node.get("canonical_key"):
                raise ValueError(f"{side} requires entity_type and canonical_key")
        assertion = row.get("assertion_kind", "observed")
        if assertion not in contract.RELATIONSHIP_ASSERTION_KINDS:
            raise ValueError(f"assertion_kind must be one of "
                             f"{contract.RELATIONSHIP_ASSERTION_KINDS}")
        evidence_ids = row.get("evidence_ids") or []
        if schema_version in ("1.1", "3.0") and not evidence_ids:
            raise ValueError("Schema 1.1 relationships require supporting evidence_ids")
        if assertion == "derived" and not evidence_ids:
            raise ValueError("Derived relationships require at least one evidence_id")

    # ---- events ----------------------------------------------------------

    def publish_events(self, module: str, events: list) -> tuple:
        if not events:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "events must not be empty"}}, 400
        if len(events) > contract.MAX_EVENTS_PER_PUBLISH:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": "at most 250 events"}}, 400
        results = []
        with self._lock:
            for event in events:
                problems = contract.is_event_envelope_valid(event)
                if problems:
                    return {"error": {"code": "VALIDATION_ERROR",
                                      "message": "; ".join(problems)}}, 400
                results.append(self._publish(module, event))
        duplicates = sum(1 for r in results if r["duplicate"])
        return {"accepted": len(results), "duplicates": duplicates,
                "results": results}, 201

    def _publish(self, module: str, event: dict) -> dict:
        """Persists and routes. Reusing an event_id is idempotent."""
        event_id = event["event_id"]
        if event_id in self.events:
            self.duplicate_events += 1
            return {"duplicate": True, "event": self.events[event_id]}

        stored = {**event, "source_module": module,
                  "correlation_id": event.get("correlation_id") or event_id,
                  "received_at": time.time()}
        self.events[event_id] = stored
        self.event_order.append(event_id)
        self._route(stored)
        return {"duplicate": False, "event": stored}

    def _route(self, event: dict):
        """
        lib/events.ts plansFor(): site.discovered -> INVESTIGATE_SITE,
        site.investigated -> FIND_RELATED_SITES, wallet.observed ->
        LOG_WALLET_ACTIVITY. Routing is skipped without investigation_id and
        entity_id, exactly as the real router does.
        """
        plans = {
            "site.discovered": ("site:investigate", "INVESTIGATE_SITE", "site-analysis",
                                "A site.discovered event met the investigation threshold."),
            "site.investigated": ("site:relate", "FIND_RELATED_SITES", "site-analysis",
                                  "Site investigation completed with signals suitable for "
                                  "related-site discovery."),
            "wallet.observed": ("wallet:log", "LOG_WALLET_ACTIVITY", "wallet-capture",
                                "A wallet observation requires durable transaction capture."),
            "wallet.validated": ("wallet:analyze", "ANALYZE_WALLET", "wallet-analysis",
                                 "A validated wallet can be analyzed directly."),
        }
        plan = plans.get(event["event_type"])
        if not plan:
            return
        if not event.get("investigation_id") or not event.get("entity_id"):
            return      # the real router skips these too

        capability, job_type, stage, reason = plan
        target = self._module_for_capability(capability, event["source_module"])
        if not target:
            return

        dedupe = f"{job_type}:{event.get('investigation_id')}:{event.get('entity_id')}:{target}"
        for job in self.jobs.values():
            if job["dedupe_key"] == dedupe and job["status"] in (
                    "pending", "running", "retrying"):
                return

        job_id = str(uuid.uuid4())
        payload = dict(event.get("payload") or {})
        priority = payload.get("priority")
        self.jobs[job_id] = {
            "id": job_id, "job_type": job_type, "status": "pending",
            "investigation_id": event.get("investigation_id"),
            "target_entity_id": event.get("entity_id"), "target_module": target,
            "created_by_module": event["source_module"],
            "priority": self._priority_value(priority),
            "stage_key": stage, "trigger_reason": reason,
            "trigger_event_id": event["event_id"],
            "correlation_id": event.get("correlation_id"),
            "dedupe_key": dedupe, "attempt_count": 0, "max_attempts": 3,
            "lease_expires_at": None, "approval_status": "not_required",
            "created_at": time.time(),
            "payload": {**payload,
                        "event": {"id": event["event_id"], "type": event["event_type"],
                                  "correlation_id": event.get("correlation_id")},
                        "automation_policy": {
                            "credentials": "explicitly-provided-for-target-only",
                            "prohibited": ["credential-guessing", "brute-force",
                                           "captcha-bypass", "mfa-bypass",
                                           "financial-transactions"],
                            "financial_actions_allowed": False}},
        }

    @staticmethod
    def _priority_value(value):
        if isinstance(value, (int, float)):
            return max(0, min(100, value))
        return {"critical": 100, "high": 80, "low": 30}.get(value, 50)

    def _module_for_capability(self, capability: str, source_module: str):
        fallback = {"site_finder": ["site:discover", "site:relate"],
                    "site_investigator": ["site:investigate", "page:inspect",
                                          "wallet:observe"],
                    "crypto_wallet_logger": ["wallet:log", "transaction:collect"],
                    "wallet_investigator": ["wallet:analyze"]}
        preferred = {"site:discover": "site_finder", "site:relate": "site_finder",
                     "site:investigate": "site_investigator",
                     "page:inspect": "site_investigator",
                     "wallet:observe": "site_investigator",
                     "wallet:log": "crypto_wallet_logger",
                     "transaction:collect": "crypto_wallet_logger",
                     "wallet:analyze": "wallet_investigator"}
        healthy = [name for name, entry in self.module_registry.items()
                   if name != source_module
                   and capability in (entry.get("capabilities") or fallback.get(name, []))
                   and (time.time() - (entry.get("last_heartbeat_at") or 0)) < 120]
        if healthy:
            return healthy[0]
        candidate = preferred.get(capability)
        return candidate if candidate != source_module else None

    # ---- jobs ------------------------------------------------------------

    def claim_job(self, module: str, lease_seconds: int = 300) -> tuple:
        with self._lock:
            now = time.time()
            for job in self.jobs.values():
                if (job["target_module"] == module and job["status"] == "running"
                        and job.get("lease_expires_at") and job["lease_expires_at"] < now):
                    job["status"] = ("needs-review"
                                     if job["attempt_count"] >= job["max_attempts"]
                                     else "retrying")
                    job["lease_expires_at"] = None
                    job["last_error"] = "Worker lease expired; job recovered automatically"

            candidates = sorted(
                [j for j in self.jobs.values()
                 if j["target_module"] == module
                 and j["status"] in ("pending", "retrying")
                 and j["approval_status"] in ("not_required", "approved")
                 and (j.get("lease_expires_at") is None or j["lease_expires_at"] < now)],
                key=lambda j: (-j["priority"], j["created_at"]))
            if not candidates:
                return None, 204

            job = candidates[0]
            job["status"] = "running"
            job["claimed_by_module"] = module
            job["attempt_count"] += 1
            job["lease_expires_at"] = now + lease_seconds
            entry = self.module_registry.setdefault(module, {"module_name": module})
            entry["runtime_status"] = "running"
            entry["current_job_id"] = job["id"]
            return {"job": dict(job)}, 200

    def update_job(self, module: str, job_id: str, body: dict) -> tuple:
        action = body.get("action")
        if action not in contract.JOB_ACTIONS:
            return {"error": {"code": "VALIDATION_ERROR",
                              "message": f"action must be one of {contract.JOB_ACTIONS}"}}, 400
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                return {"error": {"code": "JOB_NOT_FOUND", "message": "Job not found."}}, 404
            if job.get("claimed_by_module") and job["claimed_by_module"] != module:
                return {"error": {"code": "JOB_NOT_OWNED",
                                  "message": "job not owned"}}, 409

            if action == "progress":
                job["current_progress"] = max(0.0, min(1.0, body.get("progress", 0)))
                job["progress_message"] = body.get("message", "")
                job["lease_expires_at"] = time.time() + 300
            elif action == "complete":
                job["status"] = "completed"
                job["result"] = body.get("result")
                job["current_progress"] = 1
                job["progress_message"] = body.get("message", "Completed")
                job["lease_expires_at"] = None
                entry = self.module_registry.setdefault(module, {"module_name": module})
                entry["runtime_status"] = "idle"
                entry["current_job_id"] = None
            elif action == "fail":
                retry = body.get("retry") is not False and \
                    job["attempt_count"] < job["max_attempts"]
                job["status"] = "retrying" if retry else "failed"
                job["last_error"] = body.get("error", "")
                job["lease_expires_at"] = None
            elif action == "needs-review":
                job["status"] = "needs-review"
                job["progress_message"] = body.get("message", "")
                job["lease_expires_at"] = None
            return {"job": dict(job)}, 200

    # ---- reads -----------------------------------------------------------

    def investigation_context(self, investigation_id: str, module: str) -> tuple:
        with self._lock:
            resolved = self._resolve_investigation(investigation_id)
            investigation = self.investigations.get(resolved) if resolved else None
            if not investigation:
                return {"error": {"code": "NOT_FOUND",
                                  "message": "Investigation not found."}}, 404
            entities = [e for e in self.entities.values()
                        if e.get("investigation_id") == resolved]
            return {
                "investigation": investigation,
                "entities": entities,
                "relationships": [r for r in self.relationships
                                  if r.get("investigation_id") == resolved],
                "evidence": [e for e in self.evidence
                             if e.get("investigation_id") == resolved],
                "findings": [f for f in self.findings],
                "notes": [],
                "jobs": [j for j in self.jobs.values()
                         if j.get("investigation_id") == resolved],
            }, 200

    def integration_status(self) -> tuple:
        with self._lock:
            return {
                "schema_version": "1.0",
                "event_schema_version": contract.EVENT_SCHEMA_VERSION,
                "generated_at": _now_iso(),
                "modules": [
                    {**entry,
                     "connection_status": (
                         "connected"
                         if time.time() - (entry.get("last_heartbeat_at") or 0) < 90
                         else "disconnected"),
                     "failed_records": sum(1 for d in self.dead_letters
                                           if d["source_module"] == name)}
                    for name, entry in self.module_registry.items()],
            }, 200

    # ---- test helpers ----------------------------------------------------

    def jobs_for_module(self, module: str) -> list:
        with self._lock:
            return [dict(j) for j in self.jobs.values() if j["target_module"] == module]

    def investigation_for_domain(self, domain: str):
        with self._lock:
            entity = self.entities.get(("site", domain))
            if not entity:
                return None
            return self.investigations.get(entity.get("investigation_id"))

    def entity_for(self, entity_type: str, canonical_key: str):
        with self._lock:
            return self.entities.get((entity_type, canonical_key))

    def events_of_type(self, event_type: str) -> list:
        with self._lock:
            return [self.events[e] for e in self.event_order
                    if self.events[e]["event_type"] == event_type]

    def state(self) -> dict:
        with self._lock:
            return {
                "registrations": self.registrations, "heartbeats": self.heartbeats,
                "batches": len(self.batches), "events": len(self.events),
                "duplicate_events": self.duplicate_events,
                "entities": len(self.entities),
                "investigations": len(self.investigations),
                "jobs": len(self.jobs), "dead_letters": len(self.dead_letters),
                "relationships": len(self.relationships),
                "evidence": len(self.evidence),
                "module_activity": len(self.module_activity),
                "event_types": [self.events[e]["event_type"] for e in self.event_order],
            }


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class DirectTransport:
    """
    Replaces the SDK's urllib calls with in-process calls to a
    ReferencePlatform, so tests exercise MainInvestigationClient's real request
    path — auth headers, retries, error handling — rather than a parallel
    test-only path that could drift from production.
    """

    def __init__(self, platform: ReferencePlatform, fail_with: Exception = None,
                 fail_status: int = None, fail_times: int = 0):
        self.platform = platform
        self.fail_with = fail_with
        self.fail_status = fail_status
        self.fail_times = fail_times      # fail this many calls, then succeed
        self.calls = []

    def _maybe_fail(self):
        import urllib.error
        if self.fail_times > 0:
            self.fail_times -= 1
            raise urllib.error.URLError("simulated transient failure")
        if self.fail_with:
            raise self.fail_with
        if self.fail_status:
            import io
            raise urllib.error.HTTPError(
                "http://platform.test", self.fail_status, "simulated", {},
                io.BytesIO(b'{"error":{"code":"SIMULATED","message":"simulated"}}'))

    def urlopen(self, request, timeout=None):
        import io
        import urllib.error

        self._maybe_fail()
        url = request.full_url
        path = url.split("/api/v1", 1)[1] if "/api/v1" in url else url
        path = "/api/v1" + path
        method = request.get_method()
        headers = {k.lower(): v for k, v in request.headers.items()}
        body = json.loads(request.data.decode()) if request.data else {}
        self.calls.append({"path": path, "method": method, "body": body})

        result, status = self._dispatch(path, method, headers, body)

        if status >= 400:
            raise urllib.error.HTTPError(
                url, status, "error", {},
                io.BytesIO(json.dumps(result or {}).encode()))

        payload = b"" if result is None else json.dumps(result).encode()
        return _FakeResponse(payload)

    def _dispatch(self, path, method, headers, body):
        parts = [p for p in path.split("/") if p]
        # /api/v1/...
        tail = parts[2:]

        if tail[:1] == ["modules"] and len(tail) >= 3:
            module = tail[1]
            if not self.platform.authorize(module, headers):
                return {"error": {"code": "UNAUTHORIZED", "message": "bad key"}}, 401
            if tail[2] == "register":
                return self.platform.register(module, body)
            if tail[2] == "heartbeat":
                return self.platform.heartbeat(module, body)
            if tail[2] == "jobs" and len(tail) >= 4:
                if tail[3] == "claim":
                    return self.platform.claim_job(module)
                return self.platform.update_job(module, tail[3], body)

        if tail[:1] == ["ingest"] and len(tail) >= 2:
            module = tail[1]
            if not self.platform.authorize(module, headers):
                return {"error": {"code": "UNAUTHORIZED", "message": "bad key"}}, 401
            return self.platform.ingest(module, body)

        if tail[:1] == ["events"]:
            module = body.get("source_module", "")
            if not self.platform.authorize(module, headers):
                return {"error": {"code": "UNAUTHORIZED", "message": "bad key"}}, 401
            return self.platform.publish_events(module, body.get("events") or [])

        if tail[:1] == ["investigations"] and len(tail) >= 3 and tail[2].startswith("context"):
            module = "site_finder"
            if "module=" in path:
                module = path.split("module=", 1)[1].split("&")[0]
            if not self.platform.authorize(module, headers):
                return {"error": {"code": "UNAUTHORIZED", "message": "bad key"}}, 401
            return self.platform.investigation_context(tail[1], module)

        if tail[:2] == ["integration", "status"]:
            return self.platform.integration_status()

        return {"error": {"code": "NOT_FOUND", "message": path}}, 404


class _FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def patched_sdk(platform: ReferencePlatform, api_key: str = "test-key", **kwargs):
    """
    A real MainInvestigationClient whose urllib is redirected at a
    ReferencePlatform. Everything inside the SDK — headers, retry policy,
    JSON handling — runs exactly as in production.
    """
    from app.integration.v4.client import MainInvestigationClient

    transport = DirectTransport(platform, **kwargs)
    client = MainInvestigationClient("http://platform.test",
                                     contract.MODULE_NAME, api_key)
    client._transport = transport

    original = client._request

    def request(path, method="GET", body=None):
        import urllib.request as urllib_request
        real_urlopen = urllib_request.urlopen
        urllib_request.urlopen = transport.urlopen
        try:
            return original(path, method, body)
        finally:
            urllib_request.urlopen = real_urlopen

    client._request = request
    return client, transport


def make_app(platform: ReferencePlatform = None):
    """A Flask app serving the v4 endpoints, for over-the-socket tests."""
    from flask import Flask, jsonify, request

    platform = platform or ReferencePlatform()
    app = Flask("reference_main_platform_v4")
    app.config["PLATFORM"] = platform

    def _headers():
        return {k.lower(): v for k, v in request.headers.items()}

    @app.route("/api/v1/modules/<module>/register", methods=["POST"])
    def register(module):
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.register(module, request.get_json(silent=True) or {})
        return jsonify(body), status

    @app.route("/api/v1/modules/<module>/heartbeat", methods=["POST"])
    def heartbeat(module):
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.heartbeat(module, request.get_json(silent=True) or {})
        return jsonify(body), status

    @app.route("/api/v1/ingest/<module>", methods=["POST"])
    def ingest(module):
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.ingest(module, request.get_json(silent=True) or {})
        return jsonify(body), status

    @app.route("/api/v1/events", methods=["POST"])
    def events():
        payload = request.get_json(silent=True) or {}
        module = payload.get("source_module", "")
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.publish_events(module, payload.get("events") or [])
        return jsonify(body), status

    @app.route("/api/v1/modules/<module>/jobs/claim", methods=["POST"])
    def claim(module):
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.claim_job(module)
        if status == 204:
            return "", 204
        return jsonify(body), status

    @app.route("/api/v1/modules/<module>/jobs/<job_id>", methods=["PATCH"])
    def update_job(module, job_id):
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.update_job(module, job_id,
                                           request.get_json(silent=True) or {})
        return jsonify(body), status

    @app.route("/api/v1/investigations/<investigation_id>/context")
    def context(investigation_id):
        module = request.args.get("module", "")
        if not platform.authorize(module, _headers()):
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "bad key"}}), 401
        body, status = platform.investigation_context(investigation_id, module)
        return jsonify(body), status

    @app.route("/api/v1/integration/status")
    def status():
        body, code = platform.integration_status()
        return jsonify(body), code

    return app
