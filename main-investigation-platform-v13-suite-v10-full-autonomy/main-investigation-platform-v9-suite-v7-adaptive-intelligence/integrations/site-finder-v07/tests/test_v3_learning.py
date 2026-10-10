"""
Site Finder v3: learning from downstream outcomes, and bounded exploration.

Run under the repo's standalone runner (no pytest needed):
    python3 run_tests_standalone.py test_v3_learning.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.v2 import adaptive, outcomes, store  # noqa: E402


def _seed_candidate(domain, strategy, signals=("guaranteed_returns",), cluster=None):
    store.insert_new(domain, f"https://{domain}/", strategy, 0.5)
    store.update(domain, status="delivered", signals=[{"name": s, "group": "promise", "strength": 0.5, "phrase": s} for s in signals],
                 details={"arms": [], "strategies": [strategy]}, cluster_id=cluster)


def test_wallet_outcome_rewards_the_finding_strategy(temp_db):
    store.ensure()
    _seed_candidate("scam-a.example", "ct_terms")
    before = store.strategy_stats().get("ct_terms", {}).get("useful", 0.0)
    assert outcomes.apply_outcome("scam-a.example", "wallet_evidence", "observed") is True
    after = store.strategy_stats().get("ct_terms", {}).get("useful", 0.0)
    assert after > before, "a wallet-evidence outcome credits the strategy that found the site"


def test_dead_site_penalises_strategy_but_not_signals(temp_db):
    store.ensure()
    _seed_candidate("dead-b.example", "brand_typos", signals=("guaranteed_returns",))
    outcomes.apply_outcome("dead-b.example", "dead_site", "observed")
    st = store.strategy_stats().get("brand_typos", {})
    sig = store.signal_stats().get("guaranteed_returns", {})
    assert st.get("skipped", 0.0) > 0, "a dead site is a probe cost against the strategy"
    assert sig.get("skipped", 0.0) == 0.0, "a dead site is not evidence against the signals"


def test_ai_inference_basis_is_never_learned_from(temp_db):
    store.ensure()
    _seed_candidate("scam-c.example", "feeds")
    before = store.strategy_stats().get("feeds", {})
    assert outcomes.apply_outcome("scam-c.example", "wallet_evidence", "ai_inference") is False
    after = store.strategy_stats().get("feeds", {})
    assert after.get("useful", 0.0) == before.get("useful", 0.0), "an AI-inference outcome must never move a ledger"


def test_pull_outcomes_is_idempotent(temp_db):
    store.ensure()
    _seed_candidate("scam-d.example", "cert_siblings")

    class FakeSdk:
        def __init__(self, rows):
            self.rows = rows; self.calls = 0
        def finder_outcomes(self, after=0, limit=200):
            self.calls += 1
            return {"outcomes": [r for r in self.rows if r["seq"] > after], "next_cursor": str(max((r["seq"] for r in self.rows), default=after))}

    class FakeClient:
        configured = True
        def __init__(self, sdk): self.sdk = sdk

    rows = [{"seq": 1, "domain": "scam-d.example", "outcome": "wallet_evidence", "basis": "observed", "detail": {}}]
    client = FakeClient(FakeSdk(rows))
    first = outcomes.pull_outcomes(client)
    useful_after_first = store.strategy_stats().get("cert_siblings", {}).get("useful", 0.0)
    second = outcomes.pull_outcomes(client)                 # same rows, higher cursor -> nothing new
    useful_after_second = store.strategy_stats().get("cert_siblings", {}).get("useful", 0.0)
    assert first["pulled"] == 1
    assert second["pulled"] == 0, "re-pulling the same outcomes must not double-credit"
    assert useful_after_first == useful_after_second


def test_allocation_reserves_exploration_and_caps_dominance(temp_db):
    store.ensure()
    # Make one strategy look overwhelmingly good and another worthless.
    store.bump_strategy("feeds", probed=200, delivered=100, useful=100, skipped=0)
    store.bump_strategy("brand_typos", probed=200, delivered=0, useful=0, skipped=100)
    import random
    shares = adaptive.allocation(["feeds", "brand_typos", "ct_terms"], random.Random(1))
    assert abs(sum(shares.values()) - 1.0) < 1e-3, "allocation is a distribution"
    assert shares["feeds"] <= adaptive.CEIL + 1e-9, "no strategy may exceed the dominance cap"
    # Even the worthless and the untried strategies keep an exploration floor.
    base = max(adaptive.FLOOR, adaptive.EXPLORE / 3)
    assert shares["brand_typos"] >= base - 1e-9, "a poor strategy still gets an exploration share"
    assert shares["ct_terms"] >= base - 1e-9, "an untried strategy still gets an exploration share"


def test_exploration_lets_a_collapsed_strategy_recover(temp_db):
    store.ensure()
    # feeds dominates; brand_typos has been zero. It still receives budget, so
    # if it starts producing useful candidates its value (and share) can climb.
    store.bump_strategy("feeds", probed=500, delivered=300, useful=300)
    import random
    before = adaptive.allocation(["feeds", "brand_typos"], random.Random(2))["brand_typos"]
    store.bump_strategy("brand_typos", probed=20, delivered=15, useful=15)   # it starts paying off
    after = adaptive.allocation(["feeds", "brand_typos"], random.Random(2))["brand_typos"]
    assert after > before, "a recovering strategy's share increases; learning does not lock it out"
