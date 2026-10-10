"""
Site Finder v4: contextual strategy learning, bounded exploration, diminishing
returns and campaign pivots.

Run under the repo's standalone runner (no pytest needed):
    python3 run_tests_standalone.py test_v4_context.py
"""
import random
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.v2 import context, store  # noqa: E402


def _scratch(prefix="finder-test-"):
    """A temporary directory removed when the test process exits (best effort on Windows)."""
    import atexit, shutil, tempfile
    path = tempfile.mkdtemp(prefix=prefix)
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path

ARMS = ["known_keys", "cert_siblings", "pattern_siblings", "ct_learned"]


def _mean_shares(ctx, campaign, arms, n=200, seed=1):
    rng = random.Random(seed)
    tot = {a: 0.0 for a in arms}
    for _ in range(n):
        for a, v in context.allocate(ctx, campaign, arms, rng).items():
            tot[a] += v / n
    return tot


def test_contextual_learning_changes_allocation(temp_db):
    """The same arms get different budget in different contexts once outcomes differ."""
    store.ensure()
    a = context.context_key("favtmpl", "hot=1|big=1")
    b = context.context_key("san", "hot=0|big=0")
    for _ in range(12):
        context.credit(a, None, "pattern_siblings", attempts=1, new_unique=2, useful=1.0, cost=10)
        context.credit(a, None, "cert_siblings", attempts=1, cost=10, skipped=1.0)
        context.credit(b, None, "cert_siblings", attempts=1, new_unique=2, useful=1.0, cost=10)
        context.credit(b, None, "pattern_siblings", attempts=1, cost=10, skipped=1.0)
    sa, sb = _mean_shares(a, None, ARMS[1:3]), _mean_shares(b, None, ARMS[1:3])
    assert sa["pattern_siblings"] > sa["cert_siblings"] + 0.2, sa
    assert sb["cert_siblings"] > sb["pattern_siblings"] + 0.2, sb


def test_campaign_specific_learning_overrides_context_but_is_shrunk(temp_db):
    store.ensure()
    ctx = context.context_key("ip", "hot=1")
    for _ in range(10):                       # context-wide: known_keys is good
        context.credit(ctx, None, "known_keys", attempts=1, useful=1.0, new_unique=1)
        context.credit(ctx, None, "pattern_siblings", attempts=1, skipped=1.0, cost=10)
    one = context.arm_values(ctx, "camp-1", ["known_keys", "pattern_siblings"], sample=False)
    # campaign-1 alone finds the opposite, repeatedly
    for _ in range(15):
        context.credit(ctx, "camp-1", "pattern_siblings", attempts=1, useful=1.0, new_unique=2)
        context.credit(ctx, "camp-1", "known_keys", attempts=1, skipped=1.0)
    after = context.arm_values(ctx, "camp-1", ["known_keys", "pattern_siblings"], sample=False)
    other = context.arm_values(ctx, "camp-2", ["known_keys", "pattern_siblings"], sample=False)
    assert one["known_keys"] > one["pattern_siblings"]
    assert after["pattern_siblings"] > after["known_keys"], "campaign-specific evidence changes that campaign's allocation"
    # Credit at the campaign level also flows to the shared context, but another campaign stays shrunk
    # toward the context level rather than copying camp-1.
    assert abs(other["pattern_siblings"] - after["pattern_siblings"]) > 0.05


def test_exploration_is_bounded_but_active(temp_db):
    store.ensure()
    ctx = context.context_key("kit", "")
    for _ in range(200):
        context.credit(ctx, None, "pattern_siblings", attempts=1, useful=1.0, new_unique=3)
        context.credit(ctx, None, "cert_siblings", attempts=1, skipped=1.0, cost=20)
        context.credit(ctx, None, "ct_learned", attempts=1, skipped=1.0, cost=20)
    rng = random.Random(3)
    for _ in range(100):
        shares = context.allocate(ctx, None, ARMS[1:], rng)
        assert abs(sum(shares.values()) - 1) < 1e-3
        assert min(shares.values()) >= context.FLOOR - 1e-9, "every arm keeps an exploration floor"
        assert max(shares.values()) <= context.CEIL + 1e-9, "no arm can take the whole budget"


def test_diminishing_returns_reduce_effort_then_saturate(temp_db):
    store.ensure()
    path = "camp|ip:10.0.0.1"
    efforts = [context.note_path(path, 0)["effort"] for _ in range(3)]
    assert efforts == sorted(efforts, reverse=True) and efforts[0] < 1.0, efforts
    assert context.saturated(path)
    # a productive attempt restores full effort and clears saturation
    context.note_path(path, 2)
    assert not context.saturated(path) and context.path_state(path)["effort"] == 1.0


def test_saturated_pivot_returns_without_network(temp_db, monkeypatch):
    store.ensure()
    for _ in range(context.SATURATE_AFTER):
        context.note_path("c9|ip:10.9.9.9", 0)
    def boom(*a, **k):
        raise AssertionError("a saturated pivot must not run a discovery round")
    monkeypatch.setattr("app.v2.engine.run_round", boom)
    r = context.run_pivot({"pivot": {"kind": "ip", "value": "10.9.9.9"}, "campaign_id": "c9", "context": "hot=0"})
    assert r["saturated"] and r["skipped"] and r["new_candidates"] == []


def test_invalid_pivot_is_refused(temp_db):
    store.ensure()
    r = context.run_pivot({"pivot": {"kind": "password", "value": "x"}})
    assert r.get("error") and r["new_candidates"] == []


def test_downstream_credit_only_for_contextual_candidates(temp_db):
    store.ensure()
    store.insert_new("pivoted.example", "https://pivoted.example/", "pattern_siblings", 0.5)
    store.update("pivoted.example", status="delivered", details={"context": "type=kit", "campaign_id": "c1"})
    store.insert_new("plain.example", "https://plain.example/", "ct_terms", 0.5)
    assert context.credit_candidate(store.get("pivoted.example"), 1.0) is True
    assert context.credit_candidate(store.get("plain.example"), 1.0) is False
    stats = {(r["level"], r["arm"]): r for r in context.report()["context_stats"]}
    assert stats[("context", "pattern_siblings")]["useful"] == 1.0
    assert stats[("campaign", "pattern_siblings")]["useful"] == 1.0


def test_pivot_round_in_simulated_world(temp_db):
    """A real pivot against the benchmark's simulated internet: bounded, contextual, and it saturates."""
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    import logging
    logging.disable(logging.CRITICAL)
    from benchmark.world import World
    from benchmark.simnet import SimNet, installed
    from benchmark import run as bench
    from app.v2 import engine
    world = World(seed=11, split="dev")
    net = SimNet(world)
    with installed(net):
        bench._fresh_finder_state(Path(_scratch(prefix="finder-v4-ctx-")))
        engine.configure_for_benchmark(net.nameservers)
        first = engine.run_round(max_deliver=12)
        assert first["delivered"], "the seed round delivers candidates"
        # Pivot on the most repeated non-generic key among delivered candidates.
        counts = {}
        for d in first["delivered"]:
            for kt, kv in store.keys_for(d["domain"]):
                if kt in ("favtmpl", "ip", "ns", "favicon") and store.key_popularity(kt, kv) < 25:
                    counts[(kt, kv)] = counts.get((kt, kv), 0) + 1
        (kind, value), _ = max(counts.items(), key=lambda x: (x[1], x[0]))
        seen = [d["domain"] for d in first["delivered"]]
        results = []
        for _ in range(context.SATURATE_AFTER + 2):
            results.append(context.run_pivot({"pivot": {"kind": kind, "value": value}, "campaign_id": "sim", "context": "hot=1|big=0",
                                              "exclude": seen, "requested": 5}))
            seen += results[-1]["new_candidates"]
    for r in results:
        assert set(r.get("shared", [])) <= set(r["new_candidates"])
        assert not (set(r["new_candidates"]) & set(results[0].get("exclude", [])))
        if not r.get("skipped"):
            assert r["arms"] and abs(sum(r["arms"].values()) - 1) < 1e-2, "contextual shares cover the chosen arms"
            assert r["probed"] <= context.BASE_FETCH, "a pivot round is bounded"
    efforts = [r["effort"] for r in results]
    assert efforts[-1] <= efforts[0], f"effort never grows on an unproductive path: {efforts}"
    assert results[-1]["saturated"] or any(r["shared"] for r in results), "either the path produced shared sites or it saturated"
    if not any(r["shared"] for r in results[-context.SATURATE_AFTER - 1:-1]):
        assert results[-1].get("skipped"), "after saturation a further pivot does not touch the network"
