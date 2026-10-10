"""
Site Finder v5: continuous discovery (rotation, adaptive allocation, budgets,
novelty and ecosystem saturation, aging and rediscovery, change watch, restart).

    python3 run_tests_standalone.py test_v5_continuous.py
"""
import json
import logging
import random
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.v2 import continuous, store  # noqa: E402


def _scratch(prefix="finder-test-"):
    """A temporary directory removed when the test process exits (best effort on Windows)."""
    import atexit, shutil, tempfile
    path = tempfile.mkdtemp(prefix=prefix)
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path


def _world(seed=11):
    logging.disable(logging.CRITICAL)
    from benchmark.world import World
    from benchmark.simnet import SimNet
    world = World(seed=seed, split="dev")
    return world, SimNet(world)


def _fresh(net):
    from benchmark import run as bench
    from app.v2 import engine
    bench._fresh_finder_state(Path(_scratch(prefix="finder-v5-")))
    engine.configure_for_benchmark(net.nameservers)
    continuous._ready.clear()
    store._ready.clear() if hasattr(store, "_ready") else None
    continuous.ensure()


def test_rotation_forces_every_source_back_and_cooldown_excludes(temp_db):
    continuous.ensure()
    rng = random.Random(1)
    with store.conn() as c:
        for s in continuous.SOURCES:
            c.execute("INSERT INTO v5_source_state(source,last_cycle) VALUES(?,?)", (s, 10))
        c.execute("UPDATE v5_source_state SET last_cycle=1 WHERE source='mentions'")
        c.execute("UPDATE v5_source_state SET cooldown_until=50, last_cycle=1 WHERE source='feeds'")
    p = continuous.plan(11, rng)
    assert "mentions" in p["sources"], "a source unused for ROTATE_EVERY cycles is forced back in"
    assert "rotation" in p["why"]["mentions"] or "value" in p["why"]["mentions"]
    assert "feeds" not in p["sources"] and "feeds" in p["cooling"], "a cooling source is excluded even if overdue"
    assert len(p["sources"]) <= continuous.PICK + len(continuous.SOURCES)


def test_learning_changes_allocation(temp_db):
    """Downstream outcomes credited to a strategy move it up the plan; a source that was skipped moves down."""
    continuous.ensure()
    def top(n=60):
        wins = {}
        for i in range(n):
            p = continuous.plan(1, random.Random(i))
            for s in p["sources"]:
                wins[s] = wins.get(s, 0) + 1
        return wins
    before = top()
    store.bump_strategy("brand_typos", probed=40, delivered=30, useful=25.0)
    store.bump_strategy("cert_siblings", probed=40, delivered=2, skipped=10.0)
    after = top()
    assert after.get("brand_typos", 0) > before.get("brand_typos", 0) + 15, (before, after)
    assert after.get("cert_siblings", 0) < before.get("cert_siblings", 0), (before, after)


def test_ecosystem_veto_only_for_unproven_saturated_clusters(temp_db):
    continuous.ensure()
    store.upsert_cluster("k1", "a.example", 5)
    store.upsert_cluster("k2", "b.example", 5)
    with store.conn() as c:
        c.execute("INSERT INTO v5_ecosystems(cluster_id,delivered) VALUES('k1',3),('k2',3)")
    store.bump_cluster_outcome("k2", True)
    veto = continuous._veto(1)
    assert "ecosystem already represented" in (veto({"cluster_id": "k1"}) or "")
    assert veto({"cluster_id": "k2"}) is None, "a proven ecosystem may still reveal new wallets"
    assert veto({"cluster_id": None}) is None


def test_daily_budget_stops_cycles_without_network(temp_db):
    world, net = _world()
    from benchmark.simnet import installed
    with installed(net):
        _fresh(net)
        with store.conn() as c:
            c.execute("INSERT INTO v5_budget(day,http,dns,cycles) VALUES(?,?,?,0)", (continuous._day(time.time()), continuous.DAILY_HTTP, 0))
        before = dict(net.counts)
        r = continuous.run_cycle(requested=5)
        assert r["ran"] is False and "budget" in r["reason"]
        assert net.counts == before, "a budget-stopped cycle makes no request"
        with store.conn() as c:
            assert c.execute("SELECT status FROM v5_cycles ORDER BY id DESC LIMIT 1").fetchone()["status"] == "skipped"


def test_cycles_survive_restart_and_never_redeliver(temp_db):
    world, net = _world()
    from benchmark.simnet import installed
    with installed(net):
        _fresh(net)
        first = continuous.run_cycle(requested=8, http=150)
        assert first["ran"] and first["new_unique"] > 0
        # A crash mid-cycle leaves a 'running' row with an expired lease.
        with store.conn() as c:
            c.execute("INSERT INTO v5_cycles(started_at,status,reason,lease_until) VALUES(?,?,?,?)", (time.time() - 4000, "running", "crashed", time.time() - 10))
        delivered = list(first["delivered_domains"])
        results = [first]
        for _ in range(4):
            world.advance()
            r = continuous.run_cycle(requested=8, http=150)
            results.append(r)
            delivered += r["delivered_domains"]
        assert results[1]["recovered_interrupted"] == 1, "the interrupted cycle is recovered, not resumed twice"
        assert len(delivered) == len(set(delivered)), "no candidate is delivered twice across cycles"
        with store.conn() as c:
            statuses = [r["status"] for r in c.execute("SELECT status FROM v5_cycles ORDER BY id").fetchall()]
            used = {r["source"]: r["cycles"] for r in c.execute("SELECT source,cycles FROM v5_source_state").fetchall()}
        assert statuses.count("interrupted") == 1 and statuses.count("done") == 5
        assert len(used) >= 5, f"sources rotate across cycles: {used}"
        # A concurrent cycle while one holds the lease does nothing.
        with store.conn() as c:
            c.execute("INSERT INTO v5_cycles(started_at,status,reason,lease_until) VALUES(?,?,?,?)", (time.time(), "running", "other worker", time.time() + 600))
        assert continuous.run_cycle(requested=3)["reason"] == "another cycle is running"


def test_watch_records_real_changes_only_and_pushes_them(temp_db):
    world, net = _world()
    from benchmark.simnet import installed
    with installed(net):
        _fresh(net)
        r = continuous.run_cycle(requested=10, http=160)
        assert r["delivered"], "cycle delivered candidates to watch"
        # First pass establishes baselines (or confirms the probe's): no change.
        base = continuous.watch_infrastructure(time.time(), 99, __import__("app.v2.netio", fromlist=["Budget"]).Budget(http=0, dns=200))
        assert base["changed"] == 0, base
        # The world changes one site's hosting and takes another offline.
        a, b = r["delivered_domains"][0], r["delivered_domains"][-1]
        world.domains[a].ip = "203.0.113.77"
        if b != a:
            world.domains[b].resolves = False
        later = time.time() + 30 * 86400
        from app.v2 import netio
        res = continuous.watch_infrastructure(later, 100, netio.Budget(http=0, dns=200))
        changed = {c["domain"]: {x["facet"] for x in c["changes"]} for c in res["changes"]}
        assert "ip" in changed.get(a, set()), res
        if b != a:
            assert "status" in changed.get(b, set()), res
        cand = store.get(a)
        assert cand["details"]["watch_rev"] == 1 and cand["details"]["site_status"] == "live"
        # Checking again with nothing new records no further change.
        again = continuous.watch_infrastructure(later + 60 * 86400, 101, netio.Budget(http=0, dns=200))
        assert again["changed"] == 0, again
        with store.conn() as c:
            n = c.execute("SELECT COUNT(*) n FROM v5_changes").fetchone()["n"]
        assert n == sum(len(x["changes"]) for x in res["changes"])


def test_inbox_block_carries_watch_state_and_new_batch_id(temp_db):
    from app.v2 import platform_bridge
    cand = {"domain": "watch.example", "p": 0.8, "signals": [], "details": {"keys": [["ip", "1.2.3.4"]], "ns": ["ns1.x.net"]}}
    b1 = platform_bridge.inbox_block(cand)
    assert "site_status" not in b1 and "nameservers" not in b1, "unchanged v4 block when nothing was watched"
    cand2 = {**cand, "details": {**cand["details"], "site_status": "dead", "watch_rev": 2}}
    b2 = platform_bridge.inbox_block(cand2)
    assert b2["site_status"] == "dead" and b2["nameservers"] == ["ns1.x.net"]


def test_aging_and_rediscovery(temp_db):
    continuous.ensure()
    store.insert_new("old.example", "https://old.example/", "feeds", 0.3)
    store.update("old.example", status="ready", delivered_at=time.time() - 30 * 86400)
    store.insert_new("fresh.example", "https://fresh.example/", "feeds", 0.3)
    store.update("fresh.example", status="ready", delivered_at=time.time() - 86400)
    assert continuous.age_candidates(time.time()) == 1
    assert store.get("old.example")["status"] == "aged" and store.get("fresh.example")["status"] == "ready"
    from app.v2 import inbox
    assert inbox.remaining() == 1, "aged candidates stop counting as waiting supply"
