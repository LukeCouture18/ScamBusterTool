"""Site Finder v3 · discovery pursuit: artifacts and tiers, hunts, multi-hop growth, stop rules,
requests from Main/Hunter/investigations, explanation, mirrors, persistence, rollback and loops."""
import importlib

from app.v2 import engine, inbox, netio, ng, platform_bridge, pursuit, store, strategies
from app.v2.ng import memory, pagesearch
from app.v2.pursuit import artifacts, explain, ledger, planner, temporal

PAGE = ("<html><head><title>Lumora | Earn Daily</title><script src='/static/js/chunk-vendors.4e20b5d0.js'></script>"
        "<script>window.__CFG__={'apiUrl':'https://api.gw-a1c28.net','service':'https://kefu586.com/chat?cid=4463'};"
        "gtag('config','G-80C10C3D');</script></head><body><div class='login'><form><input placeholder='Mobile number'>"
        "<input type='password' placeholder='Password'><input placeholder='Invitation code'></form>"
        "<a href='https://t.me/lumora_cs'>Support</a></div><script src='/assets/index-68316118.js'></script></body></html>")


def _held(domain, keys=(), p=.92, status="held", arts=(), klass="scam"):
    store.insert_new(domain, f"https://{domain}/", "feeds", p)
    store.add_keys(domain, list(keys))
    store.update(domain, status=status, p=p, cluster_id=f"c:{domain}",
                 details={"ip": "192.0.2.9", "ns": [], "score": {"p": p, "p_gate": p, "core": ["x"]},
                          "fetch": {"final_url": f"https://{domain}/"}})
    ledger.ensure()
    ledger.note_artifacts(domain, list(keys) + list(arts), klass, 1)
    return store.get(domain)


def _search_world(results):
    """A fake page-search index: (kind, value) -> [domains]."""
    calls = []

    def search(kind, value):
        calls.append((kind, value))
        names = results.get((kind, value), [])
        return names, len(names), "healthy" if names else "empty"
    return search, calls


# ------------------------------------------------------------------ artifacts and tiers

def test_artifacts_extract_operator_identifiers_and_kit_structure():
    got = dict()
    for k, v in artifacts.extract("lumora.app", PAGE):
        got.setdefault(k, []).append(v)
    assert got["apihost"] == ["gw-a1c28.net"]
    assert got["service"] == ["kefu586.com"]
    assert got["analytics"] == ["ga4:g-80c10c3d"]
    assert got["contact"] == ["lumora_cs"]
    assert got["kitfile"] == ["chunk-vendors.4e20b5d0.js"]
    assert got["dom"][0].startswith("dom:") and got["flow"][0].startswith("flow:")
    # the site's own domain and shared web infrastructure are never artifacts
    assert not any("lumora.app" in v or "googletagmanager" in v for vs in got.values() for v in vs)


def test_tiers_separate_generic_family_variant_deployment_and_operator():
    assert artifacts.tier("asset", {"sites": 1}) == "deployment"
    assert artifacts.tier("asset", {"sites": 30, "nonscam": 5}) == "generic"            # also on ordinary sites
    assert artifacts.tier("dom", {"sites": 20, "wallet_groups": 6}) == "family"         # one kit, many operators
    assert artifacts.tier("asset", {"sites": 3, "wallet_groups": 2}) == "variant"
    assert artifacts.tier("apihost", {"sites": 4, "wallet_groups": 1, "shared_wallet": True}) == "operator"
    # an "operator" identifier spread over independent wallet groups is a vendor's, not one operator's
    assert artifacts.tier("service", {"sites": 9, "wallet_groups": 4}) == "family"
    # a mirror farm: hundreds of scam copies and nothing else is still not "generic technology"
    assert artifacts.tier("dom", {"sites": 300, "nonscam": 0}) == "family"
    assert artifacts.tier("service", {"sites": 300, "nonscam": 0, "wallet_groups": 1, "shared_wallet": True}) == "operator"


# ------------------------------------------------------------------ hunts and the tree

def test_one_useful_clue_grows_a_multi_hop_tree_with_lineage(temp_db, monkeypatch):
    _held("clue.test", [("asset", "app.aaaa1111.js")], status="useful", arts=[("apihost", "gw-one.net")])
    search, calls = _search_world({("asset", "app.aaaa1111.js"): ["hop1.test"], ("host", "gw-two.net"): ["hop2.test"]})
    monkeypatch.setattr(pagesearch, "search", search)
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")
    leads = pursuit.leads(netio.Budget(crtsh=0, dns=0), 1)
    assert "hop1.test" in {lead.domain for lead in leads}
    hunt = ledger.hunt("clue:clue.test")
    assert hunt and hunt["title"] == "Following up on clue.test"
    # hop1 turns out eligible and exposes its own API host: the tree grows one level
    store.insert_new("hop1.test", "https://hop1.test/", "ng_pivot", .5)
    pursuit.observe("hop1.test", [("apihost", "gw-two.net")], True, False, ["ng_pivot"], 1)
    leads = pursuit.leads(netio.Budget(crtsh=0, dns=0), 2)
    assert "hop2.test" in {lead.domain for lead in leads}
    node = ledger.node("hop2.test")
    assert node["parent"] == "hop1.test" and node["depth"] == 2 and node["hunt_id"] == "clue:clue.test"
    why = explain.explain("hop2.test")
    assert why["hops"] == 2 and why["because"] == "Found this because you marked clue.test useful."
    assert "hop1.test talks to the API host gw-two.net" in why["steps"][1]
    assert "not prove" in why["caveat"]


def test_depth_is_bounded_and_dead_branches_stop(temp_db, monkeypatch):
    _held("root.test", [("asset", "app.cccc0000.js")], status="useful")
    chain = {("asset", "app.cccc0000.js"): ["d1.test"]}
    for i in range(1, 9):
        chain[("host", f"gw-{i}.net")] = [f"d{i + 1}.test"]
    search, _ = _search_world(chain)
    monkeypatch.setattr(pagesearch, "search", search)
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")
    reached = set()
    for rnd in range(1, 12):
        for lead in pursuit.leads(netio.Budget(crtsh=0, dns=0), rnd):
            reached.add(lead.domain)
            store.insert_new(lead.domain, f"https://{lead.domain}/", "ng_pivot", .5)
            i = int(lead.domain[1:].split(".")[0])
            pursuit.observe(lead.domain, [("apihost", f"gw-{i}.net")], True, False, ["ng_pivot"], rnd)
    depths = [ledger.node(d)["depth"] for d in reached]
    assert max(depths) == planner.MAX_DEPTH                    # never deeper, however long the chain
    assert "d6.test" not in reached


def test_generic_and_junk_branches_die_and_idle_hunts_park_with_a_reason(temp_db, monkeypatch):
    _held("seed.test", [("asset", "app.dddd.js")], status="useful", arts=[("apihost", "gw-junk.net")])
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")

    def search(kind, value):
        if kind == "asset":
            return [f"s{i}.test" for i in range(100)], 9000, "healthy"          # generic: a shared library
        return (["plain1.test", "plain2.test", "plain3.test"], 3, "healthy") if kind == "host" else ([], 0, "empty")
    monkeypatch.setattr(pagesearch, "search", search)
    leads = pursuit.leads(netio.Budget(crtsh=0, dns=0), 1)
    assert not any(lead.domain.startswith("s") and lead.domain[1:2].isdigit() for lead in leads)
    with store.conn() as conn:
        dead = conn.execute("SELECT COUNT(*) FROM pu_branches WHERE route='page_asset' AND state='dead'").fetchone()[0]
    assert dead == 1
    # the host branch returns only ordinary websites: three non-scam pages kill it
    for d in ("plain1.test", "plain2.test", "plain3.test"):
        store.insert_new(d, f"https://{d}/", "ng_pivot", .4)
        pursuit.observe_gated(d, "not_crypto", "<html><title>Bakery</title></html>", 1)
    with store.conn() as conn:
        state = conn.execute("SELECT state,why FROM pu_branches WHERE route='page_host'").fetchone()
    assert state["state"] in ("dead", "done", "exhausted")
    states = []
    for rnd in range(2, 20):
        pursuit.leads(netio.Budget(crtsh=0, dns=0), rnd)
        states.append(ledger.hunt("clue:seed.test")["state"])
    assert "parked" in states                        # paused first, with one more look later
    h = ledger.hunt("clue:seed.test")
    assert h["state"] == "exhausted" and "no new site" in h["stop_reason"]


def test_requests_become_hunts_and_repeating_a_request_repeats_no_work(temp_db, monkeypatch):
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")
    payload = {"domain": "member.test", "seeds": ["member2.test"], "operation_id": "op-7", "source": "hunter",
               "reason": "thin operation", "artifacts": [{"kind": "apihost", "value": "gw-op7.net"},
                                                         {"kind": "analytics", "value": "ga4:g-abc12345"}]}
    first = pursuit.request(payload)
    assert first["hunt"] == "campaign:op-7" and "Operation op-7" in first["title"]
    with store.conn() as conn:
        n1 = conn.execute("SELECT COUNT(*) FROM pu_branches").fetchone()[0]
    assert pursuit.request(payload)["hunt"] == "campaign:op-7"
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM pu_branches").fetchone()[0] == n1
        assert conn.execute("SELECT COUNT(*) FROM pu_hunts").fetchone()[0] == 1
    inv = pursuit.request({"domain": "member.test", "source": "investigation", "artifacts": [{"kind": "contact", "value": "op7_cs"}]})
    assert inv["hunt"] == "investigation:member.test"
    # investigation -> discovery -> investigation cannot recurse beyond the depth limit
    ledger.add_nodes([("deep.test", "clue:x", 1, "p.test", "apihost", "gw.net", "page_host", planner.MAX_DEPTH, 1)])
    assert pursuit.request({"domain": "deep.test", "source": "investigation",
                            "artifacts": [{"kind": "apihost", "value": "gw-deep.net"}]})["hunt"] is None


def test_platform_job_carries_artifacts_into_a_hunt(temp_db, monkeypatch):
    monkeypatch.setattr(engine, "run_round", lambda **kw: {"round": 1, "delivered": []})
    out = platform_bridge.run_related_job({"payload": {"domain": "inv.test", "source": "investigation",
                                                       "artifacts": [{"kind": "title", "value": "Lumora | Earn Daily"}]}})
    assert out["hunt"] == "investigation:inv.test"


# ------------------------------------------------------------------ mirrors, deployments, gate evidence

def test_mirror_farm_copies_are_suppressed_but_a_different_operator_on_the_same_kit_is_not(temp_db):
    shared = [("asset", "index-07803142.js"), ("dom", "dom:5582e0222ab00f46")]
    _held("original.test", shared, status="skipped", arts=[("service", "cs442.com"), ("analytics", "ga4:g-bb0d4aeb")])
    _held("copy.test", shared, arts=[("service", "cs442.com"), ("analytics", "ga4:g-bb0d4aeb")])
    assert pursuit.mirror_of("copy.test") == "original.test"
    # same kit, same page, but its own chat and analytics account: another deployment, not a mirror
    _held("rival.test", shared, arts=[("service", "cs999.com"), ("analytics", "ga4:g-00000000")])
    assert pursuit.mirror_of("rival.test") is None
    assert pursuit.distinct_deployment("rival.test", ["original.test"]) is True
    assert pursuit.distinct_deployment("copy.test", ["original.test"]) is False
    # a copy of a site that has gone dark is a possible return, not a mirror
    ledger.upsert_life("original.test", 1, "fp", "gone")
    assert pursuit.mirror_of("copy.test") is None


def test_farm_memory_holds_back_leads_on_known_copy_stems(temp_db):
    for i in range(4):
        _held(f"marlesto{i}.live", [], klass="mirror", arts=[("dom", "dom:x")])
    leads = [strategies.Lead(f"marlesto{i}.cc", "ct_frontier", "", .3, "ct_frontier") for i in range(10, 16)]
    leads.append(strategies.Lead("unrelated.cc", "ct_frontier", "", .3, "ct_frontier"))
    kept, dropped = pursuit.filter_leads(leads)
    assert dropped == 5 and len(kept) == 2 and "unrelated.cc" in {x.domain for x in kept}


def test_gate_prior_is_bounded_and_needs_a_confirmed_parent(temp_db):
    _held("confirmed.test", status="useful")
    ledger.add_branches([{"hunt_id": "clue:confirmed.test", "seed": "confirmed.test", "kind": "apihost", "value": "gw.net",
                          "route": "page_host", "depth": 0, "round": 1}])
    with store.conn() as conn:
        bid = conn.execute("SELECT id FROM pu_branches").fetchone()[0]
        conn.execute("UPDATE pu_branches SET tier='operator' WHERE id=?", (bid,))
    ledger.add_nodes([("child.test", "clue:confirmed.test", bid, "confirmed.test", "apihost", "gw.net", "page_host", 1, 1)])
    z, why = pursuit.gate_prior("child.test")
    assert 0 < z <= 0.45 and "confirmed site" in why and "operator" in why
    assert pursuit.gate_prior("unrelated.test") == (0.0, "")


def test_reappearance_watch_starts_when_a_site_goes_dark_and_flags_the_return(temp_db, monkeypatch):
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")
    _held("gone.test", status="useful", arts=[("apihost", "gw-back.net"), ("asset", "index-1.js")])
    ledger.upsert_life("gone.test", 1, "fp1")
    pursuit.went_dark("gone.test", "stopped resolving")
    h = ledger.hunt("return:gone.test")
    assert h and h["kind"] == "reappearance" and "Watching for the gone.test site family to reappear" in h["title"]
    got = temporal.observe("back.test", [("apihost", "gw-back.net")], True, 3)
    ledger.note_artifacts("back.test", [("apihost", "gw-back.net")], "scam", 3)
    got = temporal.observe("back2.test", [("apihost", "gw-back.net")], True, 3)
    assert got.get("returned_from") == "gone.test"


def test_exploration_hunt_samples_scam_vocabulary_scans(temp_db, monkeypatch):
    monkeypatch.setattr(pagesearch, "available", lambda: True)
    monkeypatch.setattr(pagesearch, "endpoint", lambda: "https://urlscan.io/api/v1/search/")
    monkeypatch.setattr(pagesearch, "search", lambda kind, value: ([f"new{i}-{value[:4].lower()}.test" for i in range(50)], 4000, "healthy"))
    leads = pursuit.leads(netio.Budget(crtsh=0, dns=0), 1)
    explored = [lead for lead in leads if ledger.node(lead.domain) and ledger.node(lead.domain)["route"] == "page_term"]
    assert explored and len(explored) <= planner.MAX_LEADS_PER_ROUND
    per_action = {}
    for lead in explored:
        per_action.setdefault(ledger.node(lead.domain)["value"], []).append(lead.domain)
    assert max(len(v) for v in per_action.values()) <= round(planner.TERM_SAMPLE * 1.8)    # a sample, never the whole set


# ------------------------------------------------------------------ persistence, rollback, off switch, feedback

def test_hunts_survive_a_restart_and_rollback_drops_only_pursuit_tables(temp_db):
    _held("clue.test", status="useful")
    pursuit.leads(netio.Budget(crtsh=0, dns=0, http=0), 1)
    assert ledger.hunt("clue:clue.test")
    importlib.reload(ledger)
    ledger._ready.clear()
    ledger.ensure()
    assert ledger.hunt("clue:clue.test")["state"] in ("active", "parked", "exhausted")
    ledger.rollback(confirm=True)
    with store.conn() as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert not any(t.startswith("pu_") for t in tables)
    assert {"v2_candidates", "ng_lineage", "ig_relationships"} <= tables


def test_switching_pursuit_off_restores_the_previous_planner(temp_db, monkeypatch):
    called = []
    monkeypatch.setattr(ng.planner, "execute", lambda budget, round_no: called.append(round_no) or [])
    pursuit.configure(False)
    try:
        ng.leads(netio.Budget(crtsh=0, dns=0), 3)
        assert called == [3]
    finally:
        pursuit.configure(True)


def test_delayed_value_credits_the_hunt_and_route_that_found_the_site(temp_db):
    _held("found.test")
    ledger.upsert_hunt("clue:x.test", "clue", "Following up on x.test", {}, 1)
    ledger.add_branches([{"hunt_id": "clue:x.test", "seed": "x.test", "kind": "apihost", "value": "gw.net", "route": "page_host", "depth": 0, "round": 1}])
    ledger.add_nodes([("found.test", "clue:x.test", 1, "x.test", "apihost", "gw.net", "page_host", 1, 1)])
    from app.v2 import outcomes
    assert outcomes.apply_outcome("found.test", "wallet_evidence", "observed")
    assert ledger.hunt("clue:x.test")["value"] == 1.0
    assert outcomes.apply_outcome("found.test", "low_evidence", "ai_inference") is False    # never learned from
    assert ledger.hunt("clue:x.test")["value"] == 1.0


def test_hunts_view_is_plain_and_bounded(temp_db):
    _held("clue.test", status="useful")
    pursuit.leads(netio.Budget(crtsh=0, dns=0, http=0), 1)
    view = pursuit.hunts_view()
    assert view and all(set(h) >= {"title", "state", "found", "stop_reason", "open_pivots"} for h in view)
    assert all("{" not in h["title"] for h in view)


# ------------------------------------------------------------------ long-running pursuit and the loops

def test_long_running_pursuit_with_investigation_loop_is_bounded_and_does_not_rediscover(temp_db):
    """Finder -> review -> Investigation Mode -> Finder, for many rounds on a synthetic world:
    useful expansion, bounded state, no search repeated beyond its watch schedule, nothing found twice."""
    from benchmark.hard_world import HardWorld
    from benchmark.simnet import SimNet, installed
    world = HardWorld(seed=5, difficulty=0.7)
    net = SimNet(world)
    saved = dict(engine.DEFAULTS)
    engine.DEFAULTS.update({"fetch_budget": 60, "dns_budget": 220, "crtsh_budget": 6, "rdap_budget": 30})
    netio.PASSIVE_DNS_URL = "https://passivedns.example.test"
    pagesearch.configure("https://urlscan.io/api/v1/search/")
    useful_total, hunts_seen = 0, []
    try:
        with installed(net):
            engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            pending = []
            for n in range(14):
                if n:
                    world.advance()
                memory.note_external([{"domain": d, "source": "main"} for d in world.main_known_at(n)])
                for d in pending:                        # the investigation returns what it saw, every time
                    keys = store.keys_for(d)
                    arts = [{"kind": k, "value": v} for k, v in keys if k in ("asset", "title", "wallet")]
                    platform_bridge.run_related_job({"payload": {"domain": d, "source": "investigation", "artifacts": arts}})
                    platform_bridge.run_related_job({"payload": {"domain": d, "source": "investigation", "artifacts": arts}})
                pending = []
                engine.run_round(fetch_budget=60, max_deliver=5)
                while (item := inbox.next_candidate()):
                    t = world.truth(item["domain"])
                    ok = bool(t and t.useful)
                    inbox.decide(item["id"], "useful" if ok else "skip", reason=None if ok else "not_useful")
                    if ok:
                        useful_total += 1
                        pending.append(item["domain"])
                hunts_seen.append(len(ledger.hunts(("active",), limit=1000)))
        with store.conn() as conn:
            branches = conn.execute("SELECT COUNT(*) FROM pu_branches").fetchone()[0]
            inv_hunts = conn.execute("SELECT COUNT(*) FROM pu_hunts WHERE kind='investigation'").fetchone()[0]
            top = conn.execute("SELECT kind,value,searches FROM ng_indicators WHERE kind NOT IN ('page_term') ORDER BY searches DESC LIMIT 3").fetchall()
            max_repeat = top[0][2] if top else 0
            deepest = conn.execute("SELECT MAX(depth) FROM pu_nodes").fetchone()[0] or 0
            nodes = conn.execute("SELECT COUNT(*), COUNT(DISTINCT domain) FROM pu_nodes").fetchone()
        assert useful_total >= 5
        assert inv_hunts <= useful_total                                 # one per investigated site, however often it reports
        assert max_repeat <= planner.WATCH_MAX + 1, [tuple(t) for t in top]   # nothing searched over and over
        assert deepest <= planner.MAX_DEPTH
        assert nodes[0] == nodes[1]                                      # no site found twice
        with store.conn() as conn:
            kinds = [tuple(r) for r in conn.execute("SELECT kind,state,COUNT(*) FROM pu_hunts GROUP BY kind,state")]
        assert max(hunts_seen) <= 3 * planner.MAX_ACTIVE_HUNTS, (hunts_seen, kinds)    # hunts that do not get a turn wait parked
    finally:
        engine.DEFAULTS.clear()
        engine.DEFAULTS.update(saved)
        engine.configure_for_benchmark(nameserver_fn=None)
        netio.PASSIVE_DNS_URL = ""
        pagesearch.configure(None)


def test_hunts_endpoint_explains_the_pursuit(temp_db):
    from app.review.server import app
    body = app.test_client().get("/api/v2/discovery/hunts").json
    assert body["enabled"] is True
    assert set(body) >= {"hunts", "routes", "last_plan"}
