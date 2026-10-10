"""Graph migration, evidence fusion, campaign correction, temporal state and API."""
import importlib
import json

from app.v2 import intelligence as ig, store


def candidate(domain, keys=(), p=.86, ip="192.0.2.3", status="held", wallet=""):
    store.insert_new(domain, f"https://{domain}/", "feeds", p)
    store.add_keys(domain, keys)
    signals = [{"name": "deposit_address", "group": "wallet", "strength": .9,
                "detail": wallet, "phrase": "Deposit address"}] if wallet else []
    store.update(domain, p=p, status=status, signals=signals,
                 details={"ip": ip, "ns": ["ns1.example.net"], "score": {"p_gate": p, "core": ["wallet"]},
                          "fetch": {"final_url": f"https://{domain}/"}})
    return store.get(domain)


def test_campaign_merge_split_and_provenance_survive_restart(temp_db):
    wallet = "0x" + "a" * 40
    a = candidate("a.test", [("wallet", wallet)])
    b = candidate("b.test", [("wallet", wallet)])
    ig.ingest(a)
    ig.ingest(b)
    cid = ig.campaign_for("a.test")
    assert cid == ig.campaign_for("b.test")
    evidence = ig.neighbors("a.test")["edges"][0]
    assert "https://a.test" in evidence["evidence"]
    assert "https://b.test" in evidence["evidence"]
    assert ig.detail(cid)["domains"] == ["a.test", "b.test"]
    c = candidate("c.test", [("wallet", wallet)])
    ig.ingest(c)
    assert len(ig.detail(cid)["domains"]) == 3
    # Reject two relationships: an independent third site must not bridge them.
    ig.reject_relationship("a.test", "b.test", "Different operators confirmed")
    ig.reject_relationship("a.test", "c.test", "Contradictory primary evidence")
    assert ig.campaign_for("a.test") is None
    assert ig.campaign_for("b.test") == ig.campaign_for("c.test")
    importlib.reload(ig)
    assert ig.campaign_for("b.test") == ig.campaign_for("c.test")
    assert len(ig.neighbors("a.test")["edges"]) == 0


def test_weak_shared_host_and_generic_template_never_form_campaign(temp_db):
    for n in range(65):
        c = candidate(f"shared-{n}.test", [("ip", "203.0.113.5"), ("tmpl", "wordpress-common")],
                      ip="203.0.113.5")
        ig.ingest(c, recompute=False)
    assert ig.rebuild()["relationships"] == 0
    assert not ig.list_campaigns()


def test_one_shared_support_service_alone_is_not_a_relationship(temp_db):
    # Third-party support desks are sold to unrelated operators: one shared service is a lead, not a link.
    ig.ingest(candidate("desk-a.test", [("service", "kefu-vendor.example")]), recompute=False)
    ig.ingest(candidate("desk-b.test", [("service", "kefu-vendor.example")]), recompute=False)
    assert ig.rebuild()["relationships"] == 0
    assert ig.campaign_for("desk-a.test") is None
    # Nor does a support desk plus the same kit icon and layout: the kit is not the operator.
    ig.ingest(candidate("desk-e.test", [("service", "vendor-desk"), ("favicon", "kit-icon"), ("favtmpl", "kit-icon|t")]), recompute=False)
    ig.ingest(candidate("desk-f.test", [("service", "vendor-desk"), ("favicon", "kit-icon"), ("favtmpl", "kit-icon|t")]), recompute=False)
    assert ig.rebuild()["relationships"] == 0
    # With a second, independent operator-level category (here a shared wallet) the pair is linked.
    ig.ingest(candidate("desk-c.test", [("service", "private-desk"), ("wallet", "0x" + "c" * 40)]), recompute=False)
    ig.ingest(candidate("desk-d.test", [("service", "private-desk"), ("wallet", "0x" + "c" * 40)]), recompute=False)
    assert ig.rebuild()["relationships"] == 1
    assert ig.campaign_for("desk-c.test") == ig.campaign_for("desk-d.test") is not None


def test_high_degree_wallet_does_not_explode_pivots_or_campaigns(temp_db):
    value = "0x" + "d" * 40
    for n in range(31):
        ig.ingest(candidate(f"public-{n}.test", [("wallet", value)]), recompute=False)
    assert ig.rebuild()["relationships"] == 0
    ig.suggest(store.get("public-0.test"))
    assert all(action["target"] != f"wallet:{value}" for action in ig.actions())


def test_independent_evidence_stronger_than_repeated_certificate(temp_db):
    # v3: two independent OPERATOR-level categories (a shared certificate and an analytics account);
    # kit-level similarity no longer counts as independent evidence (see the support-service test).
    a = candidate("a.test", [("san", "certificate-1"), ("analytics", "ua-12345-1")])
    b = candidate("b.test", [("san", "certificate-1"), ("analytics", "ua-12345-1")])
    ig.ingest(a)
    ig.ingest(b)
    assert ig.neighbors("a.test")["edges"][0]["independent_categories"] == 2
    c = candidate("c.test", [("san", "certificate-only")])
    d = candidate("d.test", [("san", "certificate-only")])
    ig.ingest(c)
    ig.ingest(d)
    assert not ig.neighbors("c.test")["edges"]


def test_temporal_wallet_and_reactivation_recorded_once(temp_db):
    cand = candidate("old.test", status="gated", ip="")
    store.update("old.test", gate="dead")
    ig.ingest(store.get("old.test"))
    store.update("old.test", status="held", gate=None, signals=[{"name": "deposit_address", "group": "wallet",
                  "strength": 1, "detail": "0x" + "f" * 40}],
                 details={"ip": "192.0.2.9", "site_status": "active", "ns": []})
    ig.ingest(store.get("old.test"))
    with store.conn() as conn:
        kinds = [r["kind"] for r in conn.execute("SELECT kind FROM ig_events WHERE domain='old.test'")]
    assert "reactivated" in kinds and "new_wallet" in kinds
    before = len(kinds)
    ig.ingest(store.get("old.test"))
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM ig_events WHERE domain='old.test'").fetchone()["n"] == before


def test_migration_backfills_existing_v2_without_mutating_candidates(temp_db):
    # The same deposit wallet: operator-level evidence on its own.
    a = candidate("historical-a.test", [("wallet", "0x" + "e" * 40), ("service", "private-chat")])
    b = candidate("historical-b.test", [("wallet", "0x" + "e" * 40), ("service", "private-chat")])
    # A DB created by the old release candidate has v2 rows, no graph tables.
    assert ig.backfill()["processed"] == 2
    assert ig.campaign_for(a["domain"]) is not None
    assert ig.campaign_for(a["domain"]) == ig.campaign_for(b["domain"])
    assert ig.backfill()["processed"] == 2
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM v2_candidates").fetchone()["n"] == 2
        assert conn.execute("SELECT COUNT(*) n FROM ig_schema WHERE version=1").fetchone()["n"] == 1


def test_migration_preserves_v1_observations_and_source_urls(temp_db):
    from app import db
    for domain in ("legacy-a.test", "legacy-b.test"):
        site_id = db.add_site(f"https://{domain}/", "legacy")
        db.record_observation(site_id, "cert_sha256", "fingerprint-example",
                              source_url=f"https://{domain}/", source_method="tls_cert")
        db.record_observation(site_id, "email", "unique@example.test",
                              source_url=f"https://{domain}/contact", source_method="page_text")
    result = ig.backfill()
    assert result["legacy_observations"] == 4
    edge = ig.neighbors("legacy-a.test")["edges"][0]
    assert edge["independent_categories"] == 2
    assert "https://legacy-b.test/contact" in edge["evidence"]
    assert ig.backfill()["legacy_observations"] == 4


def test_graph_schema_rollback_preserves_release_candidate_tables(temp_db):
    candidate("keep.test", [("wallet", "0x" + "a" * 40)])
    ig.backfill()
    assert ig.rollback_graph_only(confirm=True)["original_data_preserved"]
    assert store.get("keep.test")["domain"] == "keep.test"
    assert ig.backfill()["processed"] == 1


def test_actions_are_bounded_and_campaign_review_does_not_cast_domain_votes(temp_db):
    a = candidate("a.test", [("wallet", "0x" + "d" * 40)])
    b = candidate("b.test", [("wallet", "0x" + "d" * 40)])
    ig.ingest(a)
    ig.ingest(b)
    ig.suggest(a)
    action = next(x for x in ig.actions() if x["kind"] == "pivot")
    assert 0 <= action["value"] <= 1
    factors = json.loads(action["factors"])
    assert factors["cost"] and factors["information_gain"]
    ig.review_campaign(ig.campaign_for("a.test"), "watch", "Monitor infrastructure")
    assert not store.unapplied_decisions()


def test_campaign_feedback_requires_five_distinct_campaigns(temp_db):
    campaigns = []
    for n in range(5):
        wallet = "0x" + str(n) * 40
        ig.ingest(candidate(f"group-{n}-a.test", [("wallet", wallet)]))
        ig.ingest(candidate(f"group-{n}-b.test", [("wallet", wallet)]))
        campaigns.append(ig.campaign_for(f"group-{n}-a.test"))
    for cid in campaigns[:4]:
        ig.review_campaign(cid, "useful")
    assert ig.campaign_feedback() == {}
    ig.review_campaign(campaigns[4], "skip")
    assert ig.campaign_feedback()["feeds"] == {"useful": 1.0, "skipped": .25}
    # Repeated clicks on one campaign count only its latest judgment.
    ig.review_campaign(campaigns[4], "useful")
    assert ig.campaign_feedback()["feeds"] == {"useful": 1.25, "skipped": 0.0}


def test_campaign_api_compatible_with_existing_queue(temp_db):
    from app.review.server import app
    a = candidate("api-a.test", [("wallet", "0x" + "e" * 40)], status="ready")
    b = candidate("api-b.test", [("wallet", "0x" + "e" * 40)], status="ready")
    ig.ingest(a)
    ig.ingest(b)
    client = app.test_client()
    assert client.get('/api/v2/candidates').status_code == 200
    campaigns = client.get('/api/v2/campaigns').get_json()['campaigns']
    cid = campaigns[0]['id']
    assert client.get('/api/v2/campaigns/'+cid).get_json()['domains'] == ['api-a.test', 'api-b.test']
    assert client.get('/api/v2/graph/api-a.test').get_json()['edges']
    assert client.post('/api/v2/campaigns/'+cid+'/review', json={'decision': 'watch'}).status_code == 200
    assert client.post('/api/v2/graph/reject', json={'left':'api-a.test','right':'api-b.test',
                                                    'reason':'Separate campaigns'}).status_code == 200


def test_shortlist_defers_same_campaign_member_with_recorded_reason(temp_db):
    from app.v2 import engine
    from app.review.server import app
    wallet = "0x" + "a" * 40
    for domain, p in (("select-a.test", .93), ("select-b.test", .80)):
        ig.ingest(candidate(domain, [("wallet", wallet)], p=p))
    delivered = engine._deliver(round_no=1, threshold=.62, max_deliver=1)
    assert [c["domain"] for c in delivered] == ["select-a.test"]
    deferred = store.get("select-b.test")
    assert deferred["status"] == "held"
    assert "select-a.test" in deferred["details"]["selection_deferred"]
    result = app.test_client().get('/api/v2/selection/deferred').get_json()
    assert result["candidates"][0]["domain"] == "select-b.test"


def test_explicit_merge_and_split_preserve_analyst_evidence(temp_db):
    for domain, wallet in [("a.test", "0x" + "a" * 40), ("b.test", "0x" + "a" * 40),
                           ("c.test", "0x" + "b" * 40), ("d.test", "0x" + "b" * 40)]:
        ig.ingest(candidate(domain, [("wallet", wallet)]))
    first, second = ig.campaign_for("a.test"), ig.campaign_for("c.test")
    assert first != second
    ig.merge_campaigns(first, second, "Additional public evidence connects the groups",
                       "https://evidence.example/review")
    merged = ig.campaign_for("a.test")
    assert len(ig.detail(merged)["domains"]) == 4
    assert "evidence.example" in json.dumps(ig.detail(merged)["relationships"])
    ig.split_campaign(merged, ["c.test", "d.test"], "New observation contradicts the link")
    assert ig.campaign_for("a.test") != ig.campaign_for("c.test")
    assert len(ig.detail(ig.campaign_for("a.test"))["domains"]) == 2
