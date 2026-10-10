"""Site Finder next generation: memory, fingerprints, planner, novelty, provider safety, rollback."""
import json

from app.v2 import engine, inbox, netio, ng, platform_bridge, store
from app.v2.ng import fingerprints, memory, novelty, pagesearch, planner


def _held(domain, keys=(), p=.92, cluster=None, status="held"):
    store.insert_new(domain, f"https://{domain}/", "feeds", p)
    store.add_keys(domain, list(keys))
    store.update(domain, status=status, p=p, cluster_id=cluster or f"c:{domain}",
                 details={"ip": "192.0.2.9", "ns": [], "score": {"p": p, "p_gate": p, "core": ["x"]},
                          "fetch": {"final_url": f"https://{domain}/"}})
    return store.get(domain)


# ------------------------------------------------------------------ fingerprints

def test_fingerprints_keep_operator_builds_and_drop_shared_libraries():
    html = ("<html><head><title>Lumora | Earn Daily - lumora.app</title>"
            "<script src='/js/jquery-3.6.0.min.js'></script>"
            "<script src='https://cdn.jsdelivr.net/npm/vue@2/dist/vue.min.js'></script>"
            "<script src='/static/js/app.9f3a2c1b.js?v=3'></script>"
            "<link rel='stylesheet' href='/static/css/main.44168ba7.css'></head><body></body></html>")
    fp = fingerprints.extract(html, "", "Lumora | Earn Daily - lumora.app", "https://lumora.app/", "lumora.app")
    assert fp["assets"] == ["app.9f3a2c1b.js", "main.44168ba7.css"]      # no jQuery, no third-party CDN
    assert fp["title"] == "Lumora | Earn Daily"
    assert fingerprints.title("Login", "x.test") == "" and fingerprints.title("x", "x.test") == ""


def test_simhash_separates_mirrors_from_different_pages():
    base = "Lock USDT and receive 1.8 percent every 24h principal returned at maturity invite friends earn 12 percent team rewards paid daily"
    near = base.replace("1.8", "2.1")
    other = "Family run bakery since 1980 fresh bread every morning cakes for weddings opening hours monday to saturday"
    a, b, c = fingerprints.simhash(base), fingerprints.simhash(near), fingerprints.simhash(other)
    assert fingerprints.distance(a, b) <= novelty.NEAR_DUP_BITS < fingerprints.distance(a, c)


# ------------------------------------------------------------------ memory

def test_memory_external_idempotent_and_search_saturation(temp_db):
    assert memory.note_external([{"domain": "www.Known.test", "source": "main"}, {"domain": "known.test"}]) == 2
    assert memory.external("known.test")["source"] == "main"
    memory.note_external([{"domain": "known.test", "source": "hunter", "state": "member"}])
    assert memory.external("known.test")["state"] == "member"
    for rnd in (1, 3, 7):
        memory.record_search("page_asset", "app.1.js", rnd, total=1, new=0, generic=False)
    st = memory.indicator("page_asset", "app.1.js")
    assert st["zero_streak"] == 3 and st["exhausted"] == 1
    memory.record_search("pdns_ip", "198.51.100.1", 1, total=900, new=12, generic=True)
    assert memory.indicator("pdns_ip", "198.51.100.1")["generic"] == 1


# ------------------------------------------------------------------ planner

def test_planner_pivots_from_eligible_site_before_review_and_credits_the_route(temp_db, monkeypatch):
    _held("seed.test", [("asset", "app.aaaa1111.js"), ("title", "seed capital earn daily")])
    calls = []

    def fake_search(kind, value):
        calls.append((kind, value))
        return (["sib-one.test", "sib-two.test", "seed.test"], 3, "healthy") if kind == "asset" else ([], 0, "empty")
    monkeypatch.setattr(pagesearch, "search", fake_search)
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    leads = planner.execute(netio.Budget(crtsh=0, dns=0), round_no=1)
    assert {lead.domain for lead in leads} == {"sib-one.test", "sib-two.test"}
    assert calls[0] == ("asset", "app.aaaa1111.js")
    assert all(lead.strategy == "ng_pivot" and "same build file" in lead.detail for lead in leads)
    row = memory.lineage("sib-one.test")
    assert row["parent"] == "seed.test" and row["depth"] == 1 and row["via_kind"] == "asset"
    # the site's title describes the same build: it shares this search's outcome instead of a second query
    assert memory.indicator("page_title", "seed capital earn daily")["searches"] == 1
    # delayed credit: probe says eligible, the review says useful
    planner.after_probe("sib-one.test", True)
    planner.after_decision("sib-one.test", True, None)
    stats = memory.route_stats()["page_asset"]
    assert stats["attempts"] == 1 and stats["productive"] == 1 and stats["useful"] == 1
    # the same indicator is not searched again while it cools down
    calls.clear()
    planner.execute(netio.Budget(crtsh=0, dns=0), round_no=2)
    assert ("asset", "app.aaaa1111.js") not in calls


def test_generic_result_sets_are_dead_ends_not_leads(temp_db, monkeypatch):
    _held("seed.test", [("asset", "app.bbbb2222.js")])
    monkeypatch.setattr(pagesearch, "search", lambda kind, value: ([f"site{i}.test" for i in range(100)], 5000, "healthy"))
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    assert planner.execute(netio.Budget(crtsh=0, dns=0), round_no=1) == []
    assert memory.indicator("page_asset", "app.bbbb2222.js")["generic"] == 1


def test_gap_request_becomes_a_seed_and_known_sites_never_take_a_review_slot(temp_db, monkeypatch):
    memory.note_external([{"domain": "held-by-main.test", "source": "main"}])
    assert ng.add_gap(["held-by-main.test"], operation="op-7", reason="hunter evidence gap") == ["held-by-main.test"]
    leads = ng.leads(netio.Budget(crtsh=0, dns=0, http=0), 1)
    assert any(lead.domain == "held-by-main.test" and lead.strategy == "ng_gap" for lead in leads)
    cand = _held("held-by-main.test")
    assert "Main already holds" in novelty.veto(cand)
    # a site Main learns about after delivery is suppressed when the inbox is next read
    _held("late.test", status="ready")
    memory.note_external([{"domain": "late.test", "source": "hunter"}])
    assert inbox.next_candidate() is None
    assert "Operation Hunter already holds" in store.get("late.test")["details"]["suppressed"]


def test_near_duplicates_and_batch_mirrors_are_suppressed_but_new_wallets_survive(temp_db):
    text = "Lock USDT and receive 1.8 percent every 24h principal returned at maturity invite friends earn 12 percent"
    h = fingerprints.simhash(text)
    _held("shown.test", [("simhash", h), ("wallet", "TA")], status="ready")
    copy = _held("copy.test", [("simhash", h), ("wallet", "TA")])
    assert "near-duplicate of shown.test" in novelty.veto(copy)
    fresh = _held("fresh.test", [("simhash", h), ("wallet", "TB")])
    assert novelty.veto(fresh) is None                          # new wallet: new evidence
    a = _held("a.test", [("wallet", "W1")], p=.95, cluster="c:kit")
    b = _held("b.test", [("wallet", "W1")], p=.90, cluster="c:kit")
    c = _held("c.test", [("wallet", "W2")], p=.85, cluster="c:kit")
    kept, dropped = novelty.dedupe_batch([a, b, c])
    assert [x["domain"] for x in kept] == ["a.test", "c.test"]
    assert dropped[0][0]["domain"] == "b.test" and "mirror of a.test" in dropped[0][1]


def test_reappearance_is_stated_as_similarity(temp_db):
    old = _held("gone.test", [("asset", "app.cccc3333.js")], status="useful")
    memory.watch("gone.test", {"assets": ["app.cccc3333.js"]}, "marked useful")
    memory.mark_dark("gone.test", "stopped resolving")
    new = _held("back.test", [("asset", "app.cccc3333.js")])
    info = novelty.annotate(new)
    assert info["reappearance_of"] == "gone.test" and info["bonus"] > 0
    assert "not proof of the same operator" in info["facts"][0]
    assert old["status"] == "useful"


# ------------------------------------------------------------------ provider safety

def test_page_search_uses_the_shared_circuit_breaker(temp_db, monkeypatch):
    import requests
    from app.v2 import sources
    pagesearch.configure("https://scan.example.test/api/v1/search/")
    try:
        def down(*a, **k):
            raise requests.exceptions.ConnectionError("Temporary failure in name resolution")
        monkeypatch.setattr(requests, "get", down)
        assert pagesearch.search("asset", "app.1.js")[2] == "dns_failure"
        assert pagesearch.search("asset", "app.1.js")[2] == "dns_failure"
        state = {r["provider"]: r["state"] for r in sources.health()}
        assert state["page_search"] == "OPEN"
        assert pagesearch.search("asset", "app.1.js")[2] == "circuit_open"      # no third request
        assert not pagesearch.available()
        pagesearch.configure("")
        assert pagesearch.search("asset", "app.1.js") == ([], 0, "unavailable")
    finally:
        pagesearch.configure(None)


def test_query_is_a_plain_public_search_request(temp_db, monkeypatch):
    import requests
    seen = {}

    class R:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        class raw:
            @staticmethod
            def read(n, decode_content=True):
                return json.dumps({"total": 2, "results": [{"page": {"domain": "www.one.test"}},
                                                           {"task": {"domain": "two.test"}}]}).encode()

    def get(url, params=None, headers=None, timeout=None, stream=None):
        seen.update(url=url, params=params, headers=headers)
        return R()
    pagesearch.configure("https://scan.example.test/api/v1/search/")
    try:
        monkeypatch.setattr(requests, "get", get)
        names, total, status = pagesearch.search("title", 'Lumora "Earn"')
        assert (names, total, status) == (["one.test", "two.test"], 2, "healthy")
        assert seen["params"]["q"] == 'page.title:"Lumora Earn"'
        assert "Cookie" not in seen["headers"] and "Authorization" not in seen["headers"]
    finally:
        pagesearch.configure(None)


# ------------------------------------------------------------------ rollback and off switch

def test_rollback_drops_only_next_generation_tables(temp_db):
    _held("keep.test")
    memory.note_external([{"domain": "x.test"}])
    memory.rollback(confirm=True)
    with store.conn() as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert not {n for n in names if n.startswith("ng_")}
    assert "ig_frontier" in names and store.get("keep.test")
    memory.ensure()                                           # re-applies cleanly
    assert memory.external("x.test") is None


def test_switching_the_layer_off_restores_previous_behaviour(temp_db, monkeypatch):
    _held("seed.test", [("asset", "app.dddd4444.js")])
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "search", lambda kind, value: (["sib.test"], 1, "healthy"))
    ng.configure(enabled_flag=False)
    try:
        assert ng.leads(netio.Budget(crtsh=0, dns=0), 1) == []
        assert ng.veto(_held("other.test")) is None and ng.annotate(store.get("other.test")) == {}
    finally:
        ng._state["enabled"] = None


# ------------------------------------------------------------------ the hard world, end to end

def test_hard_world_hidden_sites_found_through_pivots_without_false_links(temp_db):
    from benchmark.hard_world import HardWorld
    from benchmark.simnet import SimNet, installed
    world = HardWorld(seed=11, difficulty=0.7)
    net = SimNet(world)
    saved = dict(engine.DEFAULTS)
    engine.DEFAULTS.update({"fetch_budget": 60, "dns_budget": 220, "crtsh_budget": 6, "rdap_budget": 30})
    netio.PASSIVE_DNS_URL = "https://passivedns.example.test"
    pagesearch.configure("https://urlscan.io/api/v1/search/")
    try:
        with installed(net):
            engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            for n in range(4):
                if n:
                    world.advance()
                memory.note_external([{"domain": d, "source": "main"} for d in world.main_known_at(n)])
                for g in [g for g in world.gaps if g["round"] == n]:
                    platform_bridge.run_related_job({"payload": {"domain": g["seed"], "requested": 5}})
                engine.run_round(fetch_budget=60, max_deliver=5)
                while (item := inbox.next_candidate()):
                    t = world.truth(item["domain"])
                    inbox.decide(item["id"], "useful" if t and t.useful else "skip", reason=None if t and t.useful else "not_useful")
        with store.conn() as conn:
            eligible = [r["domain"] for r in conn.execute("SELECT domain FROM v2_candidates WHERE status IN ('held','ready','presented','useful')")]
            edges = [tuple(r) for r in conn.execute("SELECT left_domain,right_domain FROM ig_relationships")]
        hidden = [d for d in eligible if world.is_hidden(d) and world.truth(d).useful]
        assert len(hidden) >= 3, hidden
        assert any((memory.lineage(d) or {}).get("depth", 0) >= 1 for d in hidden)
        assert net.counts.get("page_search", 0) > 0
        held_from_start = set(world.main_known_at(0))
        assert not any(d in held_from_start and store.get(d)["status"] in ("ready", "presented", "useful") for d in eligible)
        for a, b in edges:
            ta, tb = world.truth(a), world.truth(b)
            assert ta and tb and ta.kit and ta.kit == tb.kit, (a, b)      # no link across operations or demos
    finally:
        engine.DEFAULTS.clear()
        engine.DEFAULTS.update(saved)
        engine.configure_for_benchmark(nameserver_fn=None)
        netio.PASSIVE_DNS_URL = ""
        pagesearch.configure(None)


def test_status_endpoint_explains_the_planner(temp_db):
    from app.review.server import app
    body = app.test_client().get("/api/v2/discovery/next-generation").json
    assert body["enabled"] is True
    assert set(body) >= {"routes", "seeds", "last_plan", "known_elsewhere"}
