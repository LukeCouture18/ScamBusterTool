"""Bounded frontier, provenance, source failure, feedback and restart checks."""
import importlib
import json

from app.v2 import active, intelligence as graph, netio, store


def observed(domain, keys=(), p=.91):
    store.insert_new(domain, f"https://{domain}/", "feeds", p)
    store.add_keys(domain, keys)
    store.update(domain, status="held", p=p, details={"ip": "192.0.2.3", "ns": [],
                  "fetch": {"final_url": f"https://{domain}/"}})
    candidate = store.get(domain)
    graph.ingest(candidate, recompute=False)
    return candidate


def test_frontier_migration_restart_dedupe_and_budget(temp_db, monkeypatch):
    cand = observed("start.test", [("wallet", "0x" + "a"*40)])
    ids = active.plan(cand)
    assert len(ids) == 2
    assert active.plan(cand) == []
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM ig_schema WHERE version=2").fetchone()["n"] == 1
        assert conn.execute("SELECT COUNT(*) n FROM ig_evidence").fetchone()["n"] > 0
    path = active.list_frontier()[0]["path_id"]
    importlib.reload(active)
    assert active.path_detail(path)["path"]["seed"] == "start.test"
    assert active.control(path, "PAUSED")["state"] == "PAUSED"
    assert active.control(path, "ACTIVE")["state"] == "ACTIVE"
    assert active.control(path, "STOPPED")["state"] == "STOPPED"


def test_two_step_ct_path_preserves_provenance_and_human_feedback(temp_db, monkeypatch):
    a = observed("alpha.test")
    first = active.plan(a, requested_kind="ct_domain")
    def lookup(domain):
        next_domain = {"alpha.test": "beta.test", "beta.test": "gamma.test"}.get(domain)
        return ([{"id": 77, "name_value": f"{domain}\n{next_domain}"}] if next_domain else [],
                "healthy" if next_domain else "empty", .001)
    monkeypatch.setattr(active, "_ct", lookup)
    one = active.execute(netio.Budget(crtsh=1), 1)
    assert [x.domain for x in one] == ["beta.test"]
    store.sight("beta.test", one[0].host, one[0].strategy, one[0].detail, one[0].prior, 1)
    b = observed("beta.test")
    parent = active.note_probe("beta.test", True)
    assert parent["id"] == first[0]
    second = active.plan(b, parent_id=parent["id"], path_id=parent["path_id"], depth=1, requested_kind="ct_domain")
    assert second
    two = active.execute(netio.Budget(crtsh=1), 2)
    assert [x.domain for x in two] == ["gamma.test"]
    observed("gamma.test")
    active.note_probe("gamma.test", True)
    active.note_decision("gamma.test", True)
    path = active.path_detail(parent["path_id"])
    assert len(path["actions"]) == 2
    assert any(r["discovered"] == "gamma.test" and r["status"] == "useful" for r in path["results"])
    proof = json.loads(next(r for r in path["results"] if r["discovered"] == "gamma.test")["observation"])
    assert proof["seed"] == "beta.test" and proof["method"] == "ct_domain"
    assert active.source_report()["techniques"][0]["useful"] == 1


def test_generic_infrastructure_is_discovery_only_and_bounded(temp_db, monkeypatch):
    a = observed("owner.test", [("ip", "192.0.2.3")])
    monkeypatch.setattr(netio, "PASSIVE_DNS_URL", "https://passivedns.example.test")
    ids = active.plan(a, requested_kind="ip")
    assert len(ids) == 1
    monkeypatch.setattr(netio, "passive_dns", lambda kind, value: [f"unrelated-{i}.test" for i in range(2000)])
    assert active.execute(netio.Budget(), 1) == []
    assert not graph.list_campaigns()
    assert active.source_report()["sources"][0]["status"] == "generic_infrastructure"


def test_source_failure_report_and_remaining_budget(temp_db, monkeypatch):
    a = observed("blocked.test", [("wallet", "0x" + "c"*40)])
    active.plan(a, requested_kind="ct_domain")
    monkeypatch.setattr(active, "_ct", lambda domain: ([], "dns_failure", .01))
    budget = netio.Budget(crtsh=2)
    active.execute(budget, 1)
    assert budget.left("crtsh") == 1
    assert active.source_report()["sources"][0]["status"] == "dns_failure"
    # A failed source cannot turn into a fictitious candidate or graph edge.
    assert not graph.list_campaigns()


def test_degraded_certificate_source_yields_to_local_pivot(temp_db, monkeypatch):
    a = observed("failover.test", [("wallet", "0x" + "c"*40)])
    active.plan(a, requested_kind="ct_domain")
    monkeypatch.setattr(active, "_ct", lambda domain: ([], "blocked", .01))
    active.execute(netio.Budget(crtsh=2), 1)
    active.plan(a, requested_kind="wallet")
    remaining = active.list_frontier(state="NEW")
    assert len(remaining) == 1 and remaining[0]["kind"] == "known_indicator"
    active.execute(netio.Budget(crtsh=2), 2)
    assert active.list_frontier(state="NEW") == []
    assert active.source_report()["sources"][0]["status"] == "blocked" or any(
        source["source"] == "crtsh" and source["status"] == "blocked"
        for source in active.source_report()["sources"])


def test_negative_evidence_weakens_not_invents_campaigns(temp_db):
    key = "0x" + "e"*40
    a = observed("one.test", [("wallet", key)])
    b = observed("two.test", [("wallet", key)])
    graph.rebuild()
    assert active.hypothesis("one.test", "two.test")["state"] == "SUPPORTED"
    before = graph.neighbors("one.test")["edges"][0]["confidence"]
    graph.record_negative("one.test", "two.test", "weak", "distinct deposits",
                          "https://one.test/deposit and https://two.test/deposit")
    after = graph.neighbors("one.test")["edges"][0]["confidence"]
    assert 0 < after < before
    assert graph.campaign_for("one.test") == graph.campaign_for("two.test")
    assert active.hypothesis("one.test", "two.test")["state"] == "WEAKENED"
    graph.reject_relationship("one.test", "two.test", "Independent evidence contradicts the link")
    assert active.hypothesis("one.test", "two.test")["state"] == "REJECTED"


def test_path_depth_and_manual_api_validation(temp_db):
    a = observed("safe.test")
    assert active.plan(a, depth=3) == []
    assert active.investigate("safe.test", "ct_domain")["actions"]
    try:
        active.investigate("safe.test", "brute_force")
    except ValueError:
        pass
    else:
        assert False, "unsafe method accepted"


def test_campaign_expansion_and_correlated_migration_use_recorded_changes(temp_db):
    wallet = "0x" + "a"*40
    observed("first.test", [("wallet", wallet)])
    observed("second.test", [("wallet", wallet)])
    graph.rebuild()
    observed("third.test", [("wallet", wallet)])
    graph.rebuild()
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM ig_events WHERE kind='campaign_expanding'").fetchone()["n"] >= 1
    for domain, address in (("first.test", "198.51.100.1"), ("second.test", "198.51.100.2")):
        row = store.get(domain)
        store.update(domain, details={**row["details"], "ip": address})
        graph.ingest(store.get(domain), recompute=False)
    graph.rebuild()
    with store.conn() as conn:
        migration = conn.execute("SELECT evidence FROM ig_events WHERE kind='campaign_infrastructure_migrated'").fetchone()
    assert migration and "transition events #" in migration["evidence"]


def test_repeated_observation_does_not_recompute_campaign_members(temp_db):
    a = observed("same.test", [("wallet", "0x"+"a"*40)])
    graph.rebuild()
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM ig_dirty").fetchone()["n"] == 0
    graph.ingest(a, recompute=False)
    assert graph.rebuild()["dirty_entities"] == 0


def test_recheck_accepts_legacy_snapshot_with_unknown_list_values(temp_db):
    a = observed("legacy-snapshot.test")
    with store.conn() as conn:
        conn.execute("UPDATE ig_snapshots SET observed=? WHERE domain=?",
                     ('{"wallets":null,"nameservers":null}', a["domain"]))
    store.update(a["domain"], signals=[{"name": "deposit_address", "group": "wallet",
                                        "detail": "0x"+"b"*40, "strength": .9}])
    graph.ingest(store.get(a["domain"]))
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM ig_events WHERE domain=? AND kind='new_wallet'",
                            (a["domain"],)).fetchone()["n"] == 1


def test_availability_change_marks_campaign_dirty_without_new_graph_fact(temp_db):
    wallet = "0x" + "d"*40
    for domain in ("resting-one.test", "resting-two.test"):
        observed(domain, [("wallet", wallet)])
    graph.rebuild()
    campaign = graph.campaign_for("resting-one.test")
    assert campaign
    for domain in ("resting-one.test", "resting-two.test"):
        candidate = store.get(domain)
        store.update(domain, details={**candidate["details"], "site_status": "offline"})
        graph.ingest(store.get(domain), recompute=False)
    assert graph.rebuild()["dirty_entities"] > 0
    with store.conn() as conn:
        assert conn.execute("SELECT status FROM ig_campaigns WHERE id=?", (campaign,)).fetchone()["status"] == "dormant"
    candidate = store.get("resting-one.test")
    store.update(candidate["domain"], details={**candidate["details"], "site_status": "active"})
    graph.ingest(store.get(candidate["domain"]))
    with store.conn() as conn:
        assert conn.execute("SELECT status FROM ig_campaigns WHERE id=?", (campaign,)).fetchone()["status"] == "active"
        assert conn.execute("SELECT COUNT(*) n FROM ig_events WHERE domain=? AND kind='reactivated'",
                            (candidate["domain"],)).fetchone()["n"] == 1


def test_ambient_discovery_source_failure_diagnostics_persist(temp_db):
    netio.reset_round_diagnostics()
    # This is an observed source failure, never a claim that no domains exist.
    report = {"crtsh": {"attempts": 2, "success": 0, "failures": 2,
                        "raw_results": 0, "status": "dns_failure", "latency": .2},
              "dns": {"attempts": 3, "resolved": 0}}
    active.record_round_sources(report)
    sources = {row["source"]: row for row in active.source_report()["sources"]}
    assert sources["crtsh_discovery"]["status"] == "dns_failure"
    assert sources["crtsh_discovery"]["failures"] == 2
    assert sources["dns_resolution"]["status"] == "unresolved"


def test_campaign_pause_keeps_frontier_history(temp_db):
    wallet = "0x" + "f"*40
    for domain in ("pause-a.test", "pause-b.test"):
        observed(domain, [("wallet", wallet)])
    graph.rebuild()
    campaign = graph.campaign_for("pause-a.test")
    ids = active.plan(store.get("pause-a.test"))
    assert ids
    result = active.pause_campaign(campaign)
    assert result["paused_paths"] == 1
    assert active.path_detail(active.list_frontier()[0]["path_id"])["path"]["state"] == "PAUSED"
    assert active.execute(netio.Budget(crtsh=1), 1) == []
