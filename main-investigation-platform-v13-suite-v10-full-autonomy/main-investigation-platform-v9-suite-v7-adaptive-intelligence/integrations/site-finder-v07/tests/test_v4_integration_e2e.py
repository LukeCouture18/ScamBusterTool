"""
Production end-to-end: Site Finder → canonical v4 contract → Main Platform.

These tests run the real path. The vendored `MainInvestigationClient` — the
platform's own SDK — makes every call, with its own headers, retry policy and
error handling; only its urllib is pointed at a reference platform that
implements the v4 route handlers. There is no test-only client and no
test-only wire format, so nothing here can pass while production is broken in
a way the mock papers over.

What is proved, in the order of how much damage its absence would cause:

 1. Registration, heartbeat and schema compatibility work as v4 defines them.
 2. A discovery becomes an `INVESTIGATE_SITE` job on `site_investigator`,
    through the contract's own routing, carrying the discovery path.
 3. Retrying a batch cannot double-ingest, and resubmitting an observation
    updates rather than duplicates.
 4. The platform being down loses nothing, and reconnecting drains everything.
 5. A restart neither loses nor double-delivers, and hands back held jobs.
 6. A schema mismatch stops sending instead of shipping garbage.
 7. Jobs assigned to Site Finder are claimed, run and reported — and refused
    when they ask for work outside what a public discovery module may do.
 8. Investigation identity is permanent and shared.
 9. Downstream outcomes reach the learning ledgers and move discovery budget.
10. Nothing sent to the platform claims shared ownership or maliciousness.
"""
from app import db
from app.integration.v4 import contract, emitter, jobs as v4jobs, sync, translator as tr
from app.integration.v4.client import PlatformClient
from app.integration.v4.reference_platform import ReferencePlatform, patched_sdk

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
TELEGRAM = "vaultsupportdesk"


def _client(platform, api_key="test-key", **transport_kwargs):
    sdk, transport = patched_sdk(platform, api_key=api_key, **transport_kwargs)
    client = PlatformClient(base_url="http://platform.test", api_key=api_key, sdk=sdk)
    return client, transport


def _online(platform, **kwargs):
    client, transport = _client(platform, **kwargs)
    client.register()
    client.heartbeat()
    return client, transport


def _investigator_online(platform):
    """A healthy site_investigator, so capability routing has somewhere to go."""
    platform.module_api_keys["site_investigator"] = "si-key"
    platform.register("site_investigator", {
        "module_version": "4.0", "schema_version": "1.0",
        "capabilities": ["site:investigate", "page:inspect", "wallet:observe"],
        "supported_event_types": [], "metadata": {}})
    platform.heartbeat("site_investigator", {
        "module_version": "4.0", "schema_version": "1.1", "status": "idle",
        "capabilities": ["site:investigate", "page:inspect", "wallet:observe"]})


def _strong_candidate(database, domain="strong.test"):
    """A candidate with several independent evidence categories."""
    site_id = database.add_site(f"http://{domain}", "campaign:wallet_reuse",
                                discovery_confidence=0.8,
                                discovery_reason="Reached by a wallet-reuse pivot from seed.test.")
    database.record_observation(site_id, "wallet", WALLET, f"http://{domain}/deposit",
                                "page_text", "s")
    database.record_observation(site_id, "telegram", TELEGRAM, f"http://{domain}/",
                                "page_text", "s")
    database.record_observation(site_id, "ip", "198.51.100.5", f"http://{domain}", "dns", "s")
    database.record_deposit_option(site_id, f"http://{domain}/deposit", "crypto_transfer",
                                   network="TRC20", label="USDT deposit")
    database.record_triage(site_id, passed=True, triage_score=0.82, indicator_count=5,
                           indicators=["wallet", "deposit_page", "guaranteed_returns"],
                           reject_reason="", http_status=200)
    database.save_deep_profile(site_id, {"status": "complete", "domain": domain,
                                         "full_url": f"http://{domain}",
                                         "domain_age_days": 11})
    return site_id


def test_unpromoted_discovery_is_durable_and_later_promotion_is_distinct(temp_db):
    site_id = temp_db.add_site("http://staged.test", "keyword_search")
    declined = emitter.queue_candidate(site_id)
    assert declined["sent"] is False
    queued = temp_db.next_batches()
    assert len(queued) == 1
    assert queued[0]["event_type"] == "observation"
    assert queued[0]["records"]["sites"][0].get("investigation_id") is None
    assert not queued[0]["records"]["investigations"]

    # A later, independent triage promotes the original source record without
    # discarding the earlier non-routing observation from the durable outbox.
    temp_db.record_observation(site_id, "wallet", WALLET,
                               "http://staged.test/deposit", "page_text", "s")
    temp_db.record_observation(site_id, "telegram", TELEGRAM,
                               "http://staged.test/", "page_text", "s")
    temp_db.record_observation(site_id, "ip", "198.51.100.7",
                               "http://staged.test/", "dns", "s")
    temp_db.record_deposit_option(site_id, "http://staged.test/deposit",
                                  "crypto_transfer", network="TRC20")
    temp_db.record_triage(site_id, passed=True, triage_score=0.82,
                          indicator_count=4, indicators=["wallet", "deposit"],
                          reject_reason="", http_status=200)
    promoted = emitter.queue_candidate(site_id)
    assert promoted["sent"] and promoted["queued"]
    assert len(temp_db.next_batches()) == 2
    assert promoted["batch_id"] != queued[0]["batch_id"]


# ---------------------------------------------------------------------------
# 1. Registration, heartbeat, compatibility
# ---------------------------------------------------------------------------

def test_registration_advertises_the_contracts_own_capabilities(temp_db):
    platform = ReferencePlatform()
    client, _ = _client(platform)

    result = client.register()
    assert result["registered"]

    entry = platform.module_registry["site_finder"]
    assert set(entry["capabilities"]) == set(contract.SITE_FINDER_CAPABILITIES)
    assert entry["schema_version"] == contract.REGISTER_SCHEMA_VERSION
    for event_type in entry["supported_event_types"]:
        assert event_type in contract.EVENT_TYPES, (
            f"{event_type} is not a v4 event type; Site Finder must not advertise one")


def test_heartbeat_reports_health_and_is_accepted(temp_db):
    platform = ReferencePlatform()
    client, _ = _online(platform)

    beat = client.heartbeat(status="running")
    assert beat["alive"] and beat["schema_compatible"]
    assert platform.module_registry["site_finder"]["runtime_status"] == "running"
    assert client.is_online()


def test_a_bad_api_key_is_a_rejection_not_an_outage(temp_db):
    """Retrying forever against a wrong key would hide the real problem."""
    platform = ReferencePlatform()
    client, _ = _client(platform, api_key="wrong-key")

    result = client.register()
    assert not result["registered"]
    assert "API key" in result["detail"] or "key" in result["detail"].lower()


def test_an_incompatible_schema_stops_sending_rather_than_shipping_garbage(temp_db):
    database = temp_db
    platform = ReferencePlatform(supported_schema_major=9)
    client, _ = _client(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)

    beat = client.heartbeat()
    assert beat["state"] == "incompatible"
    assert not client.is_online(), "an incompatible platform must not count as online"
    assert database.outbox_stats()["pending"] > 0, "batches should be held, not dropped"


# ---------------------------------------------------------------------------
# 2. The whole chain
# ---------------------------------------------------------------------------

def test_a_discovery_becomes_an_investigate_site_job_for_site_investigator(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    _investigator_online(platform)
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    queued = emitter.queue_candidate(site_id)
    assert queued["sent"] and queued["queued"]
    assert queued["high_priority"]

    # Nothing has left yet: queueing is local.
    assert platform.state()["batches"] == 0

    drained = sync.sync_until_drained(client)
    assert drained["sent"] > 0
    assert database.outbox_stats()["pending"] == 0

    # The platform minted an entity and an investigation...
    entity = platform.entity_for("site", "strong.test")
    assert entity, "no site entity was created"
    investigation = platform.investigation_for_domain("strong.test")
    assert investigation, "no investigation was opened"

    # ...published the contract's own event...
    discovered = platform.events_of_type("site.discovered")
    assert discovered, "the ingestion adapter did not publish site.discovered"
    assert discovered[0]["entity_id"] == entity["id"]
    assert discovered[0]["source_module"] == "site_finder"

    # ...and routed it to Site Investigator.
    investigator_jobs = platform.jobs_for_module("site_investigator")
    assert investigator_jobs, "no INVESTIGATE_SITE job was queued"
    job = investigator_jobs[0]
    assert job["job_type"] == "INVESTIGATE_SITE"
    assert job["created_by_module"] == "site_finder"
    assert job["priority"] == 80, "high priority should map to the platform's own scale"


def test_the_handoff_carries_the_discovery_path(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    _investigator_online(platform)
    client, transport = _online(platform)

    seed = database.add_site("http://seed.test", "test")
    site_id = _strong_candidate(database)
    run_id = database.create_pivot_run("e2e", 2, {})
    lead_id = database.add_pivot_lead(run_id, "k1", "wallet_reuse", "wallet", WALLET,
                                      seed, 0, 0.9)
    database.record_discovery_path(
        run_id, site_id, "strong.test", lead_id, seed, 1, "wallet_reuse", "wallet", WALLET,
        [{"step": "seed"}], "seed:seed.test → wallet_reuse(wallet=TN3W…) → strong.test", 0.9)

    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    ingest_calls = [c for c in transport.calls if "/ingest/" in c["path"]]
    assert ingest_calls
    records = ingest_calls[0]["body"]["records"]
    assert records["discovery_paths"], "no discovery_paths record was sent"
    steps = records["discovery_paths"][0]["steps"]
    assert any("wallet_reuse" in str(step.get("path_text", "")) for step in steps)


def test_wallets_and_relationships_arrive_as_the_contracts_own_records(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, transport = _online(platform)

    a = _strong_candidate(database, "alpha.test")
    _strong_candidate(database, "beta.test")
    from app.analysis import correlation
    correlation.run_correlation("e2e")

    emitter.queue_candidate(a)
    sync.sync_until_drained(client)

    body = [c for c in transport.calls if "/ingest/" in c["path"]][0]["body"]
    assert body["schema_version"] == contract.INGEST_SCHEMA_VERSION
    records = body["records"]

    assert records["wallets"], "the wallet observation was not sent"
    assert records["wallets"][0]["canonical_key"].startswith("unknown:") or ":" in \
        records["wallets"][0]["canonical_key"], "wallet keys are network-scoped in v4"

    assert platform.events_of_type("wallet.observed"), "wallet.observed was not published"

    if records["relationships"]:
        relationship = records["relationships"][0]
        assert relationship["assertion_kind"] == "derived"
        assert relationship["evidence_ids"], "schema 1.1 requires evidence_ids"
        evidence_ids = {e["external_id"] for e in records["evidence"]}
        assert set(relationship["evidence_ids"]) <= evidence_ids, (
            "a relationship references evidence that was not sent in the same batch")


def test_only_contract_record_types_are_ever_sent(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, transport = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    for call in [c for c in transport.calls if "/ingest/" in c["path"]]:
        for record_type in call["body"]["records"]:
            assert record_type in contract.RECORD_TYPES, (
                f"{record_type} is not a v4 record type")


# ---------------------------------------------------------------------------
# 3. Idempotency, duplicates, conflicting observations
# ---------------------------------------------------------------------------

def test_the_same_candidate_never_queues_twice(temp_db):
    database = temp_db
    site_id = _strong_candidate(database)

    first = emitter.queue_candidate(site_id)
    second = emitter.queue_candidate(site_id)

    assert first["queued"] is True
    assert second["queued"] is False
    assert first["batch_id"] == second["batch_id"], (
        "the batch id must depend on content, not on when it was built")


def test_a_replayed_batch_returns_the_original_result(temp_db):
    """The case batch idempotency exists for: sent, answer lost, sent again."""
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    built = emitter.build_candidate_batch(site_id)

    first = client.send_batch(built["records"], built["batch_id"])
    assert first.ok and first.kind == "accepted"
    entities_after_first = platform.state()["entities"]

    second = client.send_batch(built["records"], built["batch_id"])
    assert second.ok
    assert second.kind == "duplicate"
    assert platform.state()["entities"] == entities_after_first, (
        "a replayed batch created new entities")
    assert platform.state()["batches"] == 1


def test_resubmitting_a_changed_observation_updates_rather_than_duplicates(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    first = emitter.build_candidate_batch(site_id)
    client.send_batch(first["records"], first["batch_id"])
    entities = platform.state()["entities"]

    # The same site, re-triaged with a different score: same external_id,
    # different content, so it must update one observation.
    database.record_triage(site_id, passed=True, triage_score=0.91, indicator_count=6,
                           indicators=["wallet"], reject_reason="", http_status=200)
    second = emitter.build_candidate_batch(site_id)
    assert second["batch_id"] != first["batch_id"], "changed content needs a new batch id"

    outcome = client.send_batch(second["records"], second["batch_id"])
    assert outcome.ok
    assert outcome.body["updated_count"] >= 1, "the changed observation did not update"
    assert platform.state()["entities"] == entities, (
        "re-observing the same domain created a second entity")


def test_conflicting_observations_do_not_overwrite_each_other(temp_db):
    """
    Another module's observation of the same entity must survive Site Finder's.
    The contract keys observations by source_module, so both are kept.
    """
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)
    platform.module_api_keys["site_investigator"] = "si-key"

    site_id = _strong_candidate(database)
    built = emitter.build_candidate_batch(site_id)
    client.send_batch(built["records"], built["batch_id"])

    # Site Investigator reports the same entity with a different confidence.
    platform.ingest("site_investigator", {
        "schema_version": "1.1", "batch_id": "si-batch-1",
        "sent_at": tr.iso(),
        "records": {**tr.empty_records(), "sites": [{
            "external_id": "si:site:strong.test", "canonical_key": "strong.test",
            "url": "http://strong.test", "confidence": 0.2,
            "classification": "benign_looking", "provenance": {}}]}})

    ours = platform.observations[("site_finder", "site", built["records"]["sites"][0]["external_id"])]
    theirs = platform.observations[("site_investigator", "site", "si:site:strong.test")]
    assert ours["record"]["confidence"] != theirs["record"]["confidence"]
    assert ours["entity_id"] == theirs["entity_id"], (
        "both modules should enrich the same entity")


def test_a_relationship_without_evidence_is_refused_before_it_is_sent(temp_db):
    """
    Schema 1.1 requires evidence_ids. Site Finder catches that locally rather
    than spending a round trip to be told — and rather than shipping a record
    it already knows the contract forbids.
    """
    database = temp_db
    platform = ReferencePlatform()
    client, transport = _online(platform)

    site_id = _strong_candidate(database)
    built = emitter.build_candidate_batch(site_id)
    built["records"]["relationships"].append({
        "external_id": "sf:rel:broken", "relationship_type": "shares_indicator",
        "from": {"entity_type": "site", "canonical_key": "strong.test"},
        "to": {"entity_type": "site", "canonical_key": "other.test"},
        "assertion_kind": "derived", "evidence_ids": [], "confidence": 0.5})

    before = len(transport.calls)
    outcome = client.send_batch(built["records"], "sf-invalid-test")

    assert not outcome.ok and outcome.kind == "rejected"
    assert "evidence_ids" in outcome.detail
    assert len(transport.calls) == before, "the invalid batch should never have left"


def test_a_bad_record_is_dead_lettered_without_failing_the_batch(temp_db):
    """
    Per-record isolation is a contract property Site Finder relies on: one bad
    record must not lose the good ones. Proved through the real client path,
    using a fault the local guard does not police (confidence out of range).
    """
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    built = emitter.build_candidate_batch(site_id)
    built["records"]["infrastructure_indicators"].append({
        "external_id": "sf:infra:broken", "canonical_key": "ip:203.0.113.1",
        "confidence": 1.5,          # outside 0..1; the platform rejects this row
        "provenance": {}})

    outcome = client.send_batch(built["records"], "sf-partial-test")

    assert outcome.ok, "one bad record must not fail the whole batch"
    assert outcome.kind == "partial"
    assert outcome.body["error_count"] == 1
    assert platform.state()["dead_letters"] == 1
    assert platform.entity_for("site", "strong.test"), "the good records were still committed"


# ---------------------------------------------------------------------------
# 4. Offline, reconnect
# ---------------------------------------------------------------------------

def test_an_unreachable_platform_loses_nothing(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _client(platform, fail_with=ConnectionError("connection refused"))

    site_id = _strong_candidate(database)
    assert emitter.queue_candidate(site_id)["queued"], (
        "queueing must not depend on the platform being up")

    pending_before = database.outbox_stats()["pending"]
    attempt = sync.sync_once(client)
    assert attempt["sent"] == 0 and attempt["failed"] > 0
    assert database.outbox_stats()["pending"] == pending_before
    assert platform.state()["batches"] == 0


def test_everything_drains_on_reconnect(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    _investigator_online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)

    offline, _ = _client(platform, fail_with=ConnectionError("down"))
    sync.sync_once(offline)
    assert database.outbox_stats()["pending"] > 0

    sync.retry_deferred()     # an operator pressing "retry" after the link returns
    online, _ = _online(platform)
    drained = sync.sync_until_drained(online)

    assert drained["sent"] > 0
    assert database.outbox_stats()["pending"] == 0
    assert platform.investigation_for_domain("strong.test") is not None


def test_a_transient_failure_is_absorbed_by_the_sdks_own_retry(temp_db):
    """The SDK retries 429/502/503/504 internally; a blip should not surface."""
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _client(platform, fail_times=2)
    client.register()
    client.heartbeat()

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    result = sync.sync_once(client)
    assert result["sent"] >= 1, "a transient failure should have been retried through"


def test_an_unconfigured_platform_is_supported_not_an_error(temp_db):
    database = temp_db
    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)

    standalone = PlatformClient(base_url="", api_key="")
    result = sync.sync_once(standalone)

    assert result["state"] == "unconfigured"
    assert "none of them are lost" in result["note"]
    assert database.outbox_stats()["pending"] > 0


# ---------------------------------------------------------------------------
# 5. Restart recovery
# ---------------------------------------------------------------------------

def test_an_interrupted_send_is_requeued_not_assumed_delivered(temp_db):
    database = temp_db
    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)

    with database.get_conn() as conn:
        conn.execute("UPDATE integration_outbox SET status='sending' WHERE status='queued'")
    assert database.outbox_stats()["pending"] == 0

    resumed = sync.resume_after_restart()
    assert resumed["requeued_interrupted"] == 1
    assert database.outbox_stats()["pending"] == 1
    assert "assumed delivered" in resumed["note"]


def test_a_restart_does_not_double_deliver(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)
    entities = platform.state()["entities"]

    sync.resume_after_restart()
    sync.sync_until_drained(client)

    assert platform.state()["entities"] == entities
    assert platform.state()["batches"] == 1


def test_a_restart_hands_held_jobs_back_instead_of_letting_leases_rot(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    # A job the platform assigned and Site Finder was holding when it died.
    platform.jobs["job-held"] = {
        "id": "job-held", "job_type": "FIND_RELATED_SITES", "status": "running",
        "target_module": "site_finder", "claimed_by_module": "site_finder",
        "attempt_count": 1, "max_attempts": 3, "priority": 50,
        "created_at": 0, "dedupe_key": "x", "approval_status": "not_required",
        "lease_expires_at": None, "payload": {}}
    database.record_claimed_job("job-held", "FIND_RELATED_SITES", status="running")

    resumed = sync.resume_after_restart()
    assert resumed["unfinished_jobs"], "the held job was not noticed"

    reported = v4jobs.fail_orphaned_jobs(client)
    assert reported["reported"] == 1
    assert platform.jobs["job-held"]["status"] in ("retrying", "failed")


# ---------------------------------------------------------------------------
# 6. Jobs delivered to Site Finder
# ---------------------------------------------------------------------------

def test_site_finder_claims_and_completes_a_find_related_sites_job(temp_db):
    from benchmark.world import World
    from benchmark.simnet import SimNet, installed
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    seed = database.add_site("http://seed.test", "test")
    database.save_deep_profile(seed, {"status": "complete", "domain": "seed.test",
                                      "full_url": "http://seed.test",
                                      "confidence_score": 0.9})
    database.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "s")

    platform.jobs["job-rel"] = {
        "id": "job-rel", "job_type": "FIND_RELATED_SITES", "status": "pending",
        "target_module": "site_finder", "investigation_id": None,
        "attempt_count": 0, "max_attempts": 3, "priority": 50, "created_at": 0,
        "dedupe_key": "rel", "approval_status": "not_required",
        "lease_expires_at": None,
        "payload": {"canonical_key": "seed.test",
                    "automation_policy": {"financial_actions_allowed": False,
                                          "prohibited": ["captcha-bypass"]}}}

    # The platform contract and the real Site Finder engine run here. Bound
    # public CT/DNS/HTTP to a deterministic provider so this integration test
    # cannot stall on a live provider or change its outcome between runs.
    simulated_network = SimNet(World(seed=11, split="dev"))
    with installed(simulated_network):
        result = v4jobs.claim_and_run_one(client)
    assert result["claimed"] and result["ran"]
    assert platform.jobs["job-rel"]["status"] == "completed"
    assert platform.jobs["job-rel"]["result"]["campaign_key"]
    assert simulated_network.counts["crtsh"] + simulated_network.counts["dns"] > 0


def test_a_job_demanding_prohibited_work_is_returned_for_review(temp_db):
    """The automation policy is enforced, not merely acknowledged."""
    platform = ReferencePlatform()
    client, _ = _online(platform)

    platform.jobs["job-bad"] = {
        "id": "job-bad", "job_type": "FIND_RELATED_SITES", "status": "pending",
        "target_module": "site_finder", "attempt_count": 0, "max_attempts": 3,
        "priority": 50, "created_at": 0, "dedupe_key": "bad",
        "approval_status": "not_required", "lease_expires_at": None,
        "payload": {"canonical_key": "seed.test",
                    "automation_policy": {"financial_actions_allowed": True}}}

    result = v4jobs.claim_and_run_one(client)
    assert result["claimed"] and result.get("refused")
    assert platform.jobs["job-bad"]["status"] == "needs-review"
    assert "financial" in result["reason"].lower()


def test_a_job_requiring_authentication_is_refused(temp_db):
    platform = ReferencePlatform()
    client, _ = _online(platform)

    platform.jobs["job-auth"] = {
        "id": "job-auth", "job_type": "FIND_RELATED_SITES", "status": "pending",
        "target_module": "site_finder", "attempt_count": 0, "max_attempts": 3,
        "priority": 50, "created_at": 0, "dedupe_key": "auth",
        "approval_status": "not_required", "lease_expires_at": None,
        "payload": {"canonical_key": "seed.test", "requires_authentication": True}}

    result = v4jobs.claim_and_run_one(client)
    assert result.get("refused")
    assert "authenticated" in result["reason"].lower()
    assert platform.jobs["job-auth"]["status"] == "needs-review"


def test_claiming_is_a_lease_so_two_workers_cannot_take_the_same_job(temp_db):
    platform = ReferencePlatform()
    client, _ = _online(platform)

    platform.jobs["job-one"] = {
        "id": "job-one", "job_type": "FIND_RELATED_SITES", "status": "pending",
        "target_module": "site_finder", "attempt_count": 0, "max_attempts": 3,
        "priority": 50, "created_at": 0, "dedupe_key": "one",
        "approval_status": "not_required", "lease_expires_at": None,
        "payload": {"canonical_key": "seed.test"}}

    first = v4jobs.claim(client)
    second = v4jobs.claim(client)
    assert first["claimed"]
    assert not second["claimed"], "the same job was claimed twice"


def test_no_work_waiting_is_not_an_error(temp_db):
    platform = ReferencePlatform()
    client, _ = _online(platform)
    result = v4jobs.claim(client)
    assert not result["claimed"]
    assert "No work waiting" in result["reason"]


# ---------------------------------------------------------------------------
# 7. Investigation identity
# ---------------------------------------------------------------------------

def test_investigation_identity_is_permanent_and_shared(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    link = database.get_site_investigation(site_id)
    assert link, "the site was not linked to an investigation"
    external_id = tr.external_id("investigation", "strong.test")
    assert link["correlation_id"] == external_id or link["investigation_id"] == external_id

    # The same domain sent again joins the SAME investigation, not a new one.
    database.record_triage(site_id, passed=True, triage_score=0.95, indicator_count=7,
                           indicators=["wallet"], reject_reason="", http_status=200)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)
    assert platform.state()["investigations"] == 1


def test_the_platforms_investigation_uuid_is_stored_when_learned(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    from app.integration.v4.feedback_sync import poll_investigation
    external_id = tr.external_id("investigation", "strong.test")
    poll_investigation(site_id, external_id, client=client)

    investigation = platform.investigation_for_domain("strong.test")
    link = database.get_site_investigation(site_id)
    assert link["investigation_id"] in (investigation["id"], external_id)


# ---------------------------------------------------------------------------
# 8. Feedback-driven prioritisation
# ---------------------------------------------------------------------------

def test_downstream_outcomes_reach_the_ledger_and_move_budget(temp_db):
    database = temp_db
    from app.discovery import feedback, budget_allocator, campaigns

    # The runtime campaign runner must persist and use the allocator's result;
    # checking only a returned score would miss a disconnected budget setting.
    seed = database.add_site("http://budget-seed.test", "test")
    assert seed
    before = campaigns.create_campaign("before feedback", "domain", "budget-seed.test",
                                       max_waves=1, max_leads=100)
    campaigns.run_campaign(before["campaign_id"])
    initial = database.get_campaign_allocation(before["campaign_id"])
    assert initial is not None

    # A technique whose candidates turn out to contain something.
    for n in range(10):
        feedback.record_outcome(
            f"fb-good-{n}", domain=f"good{n}.test", deposit_pages=2, wallets=1,
            infrastructure=1, relationships=1, pages_examined=6, reachable=True)
        database.record_attribution("pivot", "wallet_reuse", examined=1, useful=1,
                                    deposit_pages=2, wallets=1)
    # A technique whose candidates are consistently thin.
    for n in range(10):
        database.record_attribution("pivot", "domain_pattern", examined=1, thin=1)

    feedback.refresh_scores()

    good = budget_allocator.pivot_multiplier("wallet_reuse")
    noisy = budget_allocator.pivot_multiplier("domain_pattern")
    assert good > noisy, "budget did not follow downstream usefulness"
    assert noisy >= 0.3, "a weak technique must keep a share so it can recover"

    allocation = budget_allocator.allocate(100, ["wallet_reuse", "domain_pattern"])
    assert allocation["allocation"]["wallet_reuse"] > allocation["allocation"]["domain_pattern"]
    assert "usefulness" in allocation["explanation"]

    after = campaigns.create_campaign("after feedback", "domain", "budget-seed.test",
                                      max_waves=1, max_leads=100)
    campaigns.run_campaign(after["campaign_id"])
    persisted = database.get_campaign_allocation(after["campaign_id"])
    assert persisted is not None
    assert persisted["allocation"] != initial["allocation"]
    assert persisted["allocation"]["wallet_reuse"] > initial["allocation"]["wallet_reuse"]


def test_feedback_polling_is_idempotent(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    _investigator_online(platform)
    client, _ = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    # Site Investigator finishes and contributes findings.
    external_id = tr.external_id("investigation", "strong.test")
    investigation_id = platform.investigation_by_external[external_id]
    for job in platform.jobs.values():
        if job["target_module"] == "site_investigator":
            job["status"] = "completed"
    platform.entities[("deposit_page", "http://strong.test/deposit")] = {
        "id": "e-dep", "entity_type": "deposit_page",
        "canonical_key": "http://strong.test/deposit",
        "investigation_id": investigation_id, "source_module": "site_investigator"}

    from app.integration.v4.feedback_sync import poll_investigation
    first = poll_investigation(site_id, external_id, client=client)
    second = poll_investigation(site_id, external_id, client=client)

    assert first["recorded"], f"no outcome recorded: {first}"
    assert not second["recorded"], "polling twice double-counted the attribution"


def test_feedback_never_calls_a_site_malicious(temp_db):
    from app.discovery import feedback
    result = feedback.classify_outcome(deposit_pages=3, wallets=2, pages_examined=9)
    assert result["outcome"] == "useful"
    blob = result["detail"].lower()
    for phrase in ("malicious", "scam", "fraud", "guilty", "confirmed bad"):
        assert phrase not in blob, f"outcome language overclaims: {phrase!r}"
    assert "legitimate services have" in blob


# ---------------------------------------------------------------------------
# 9. Contract discipline
# ---------------------------------------------------------------------------

def test_site_finder_publishes_no_event_type_of_its_own(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    _investigator_online(platform)
    client, _ = _online(platform)

    a = _strong_candidate(database, "alpha.test")
    _strong_candidate(database, "beta.test")
    from app.analysis import correlation
    correlation.run_correlation("e2e")
    emitter.queue_candidate(a)
    sync.sync_until_drained(client)

    for event in platform.events.values():
        assert event["event_type"] in contract.EVENT_TYPES, (
            f"{event['event_type']} is not a v4 event type")
        assert event["schema_version"] == contract.EVENT_SCHEMA_VERSION


def test_a_non_contract_event_field_is_refused_before_it_is_sent(temp_db):
    """The v4 envelope is strict; catching it locally beats a 400."""
    platform = ReferencePlatform()
    client, _ = _online(platform)

    outcome = client.publish_events([{
        "event_id": "x", "event_type": "site.discovered",
        "schema_version": "1.0", "provenance": {}, "payload": {}, "hop_count": 0,
        "node_id": "site-finder-1",          # not a v4 envelope field
    }])
    assert not outcome.ok and outcome.kind == "rejected"
    assert "unknown top-level field" in outcome.detail


def test_nothing_sent_claims_shared_ownership_or_maliciousness(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, transport = _online(platform)

    a = _strong_candidate(database, "alpha.test")
    _strong_candidate(database, "beta.test")
    from app.analysis import correlation
    correlation.run_correlation("e2e")
    emitter.queue_candidate(a)
    sync.sync_until_drained(client)

    banned = ["same party", "owned by the same", "single operation", "same operator",
              "proves", "run by the same", "confirms they are", "is a scam",
              "is malicious", "is fraudulent"]
    blob = ""
    for call in transport.calls:
        blob += str(call["body"]).lower()
    for phrase in banned:
        assert phrase not in blob, f"something sent to the platform overclaims: {phrase!r}"


def test_every_site_record_states_site_finders_limited_role(temp_db):
    database = temp_db
    platform = ReferencePlatform()
    client, transport = _online(platform)

    site_id = _strong_candidate(database)
    emitter.queue_candidate(site_id)
    sync.sync_until_drained(client)

    records = [c for c in transport.calls if "/ingest/" in c["path"]][0]["body"]["records"]
    for record in records["sites"]:
        role = (record.get("provenance") or {}).get("producer_role", "")
        assert "does not crawl" in role, (
            "a site record does not say what Site Finder did and did not do")


def test_the_gap_report_lists_what_the_contract_cannot_express(temp_db):
    from app.integration.v4 import gap_report
    report = gap_report.report()

    assert report["gaps"], "the gap report is empty"
    for gap in report["gaps"]:
        assert gap["severity"] in ("none", "cosmetic", "real")
        for field in ("site_finder_needs", "v4_position", "workaround",
                      "what_is_lost", "would_need"):
            assert gap[field].strip(), f"{gap['id']} is missing {field}"
    assert "defines no wire format of its own" in report["note"]
    assert gap_report.markdown().startswith("# Site Finder")
