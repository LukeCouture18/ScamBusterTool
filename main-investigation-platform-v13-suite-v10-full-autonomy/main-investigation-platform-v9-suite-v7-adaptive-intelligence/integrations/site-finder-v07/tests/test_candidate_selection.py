"""Adversarial review-slot selection cases (no network)."""
from app.v2 import selection


def _candidate(domain, p, cluster, groups, routes):
    return {"domain": domain, "p": p, "cluster_id": cluster, "strategies": routes,
            "details": {"score": {"p_gate": p}},
            "signals": [{"group": g, "strength": .9} for g in groups]}


def test_repetition_cannot_beat_independent_evidence():
    weak = _candidate("repeat.test", .72, "a", ["promise"] * 30, ["feeds"])
    strong = _candidate("corroborated.test", .71, "b", ["promise", "wallet", "recovery"], ["feeds", "ct_terms"])
    assert selection.shortlist([weak, strong], 1)[0]["domain"] == "corroborated.test"


def test_diversity_breaks_close_cluster_ties_but_not_large_quality_gap():
    a = _candidate("a.test", .85, "one", ["wallet"], ["feeds"])
    clone = _candidate("clone.test", .84, "one", ["wallet"], ["feeds"])
    b = _candidate("b.test", .82, "two", ["wallet"], ["ct_terms"])
    assert [x["domain"] for x in selection.shortlist([a, clone, b], 2)] == ["a.test", "b.test"]
    clone["p"] = .99
    a["p"] = .95
    assert [x["domain"] for x in selection.shortlist([a, clone, b], 2)] == ["clone.test", "a.test"]


def test_repeated_sightings_from_noisy_source_are_not_independent():
    noisy = _candidate("noisy.test", .72, "one", ["wallet"], ["feeds"])
    clean = _candidate("clean.test", .72, "two", ["wallet"], ["feeds"])
    obs = lambda c: ([{"strategy": "feeds"}] * 100 if c["domain"] == "noisy.test" else [], [])
    assert selection.evaluate(noisy, *obs(noisy))["quality"] == selection.evaluate(clean, *obs(clean))["quality"]


def test_selection_explanation_and_existing_queue():
    a = _candidate("a.test", .82, "same", ["wallet"], ["feeds"])
    b = _candidate("b.test", .80, "other", ["wallet", "promise"], ["ct_terms"])
    chosen = selection.shortlist([a, b], 1, existing=[a])
    assert chosen[0]["domain"] == "b.test"
    assert "distinct evidence types" in chosen[0]["selection"]["why_selected"]
