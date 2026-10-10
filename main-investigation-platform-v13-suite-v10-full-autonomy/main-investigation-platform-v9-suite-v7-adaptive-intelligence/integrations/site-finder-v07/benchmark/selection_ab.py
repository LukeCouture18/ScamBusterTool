"""Paired selector comparison on identical eligible pools from simulated rounds.

Run: python -m benchmark.selection_ab --seeds 101 202 303 --rounds 5
This is not a live-internet or human-labelled validation.
"""
import argparse
import json
import shutil
import tempfile
from pathlib import Path

from app.v2 import engine, inbox, selection, store
from benchmark.run import Judge, _fresh_finder_state, _skip_reason
from benchmark.simnet import SimNet, installed
from benchmark.world import World


def compare(pool, observations, world, slots=5):
    eligible = [c for c in pool if c["domain"] in world.domains]
    old = sorted(eligible, key=lambda c: (-c["p"], c["domain"]))[:slots]
    new = selection.shortlist(eligible, slots, observations)

    def measure(items):
        judge = Judge(world)
        verdicts = [judge.judge(c["domain"]) for c in items]
        useful = [int(v["useful"]) for v in verdicts]
        clusters = [c.get("cluster_id") or c["domain"] for c in items]
        # DCG discounts useful leads that are needlessly buried in a shortlist.
        from math import log2
        return {"useful_at_3": sum(useful[:3]), "useful_at_5": sum(useful[:5]),
                "precision_at_5": round(sum(useful) / len(items), 3) if items else None,
                "dcg_at_5": round(sum(u / log2(i + 2) for i, u in enumerate(useful)), 4),
                "near_duplicate_slots": len(clusters) - len(set(clusters)),
                "cluster_diversity": len(set(clusters)),
                "missed_useful": sum(1 for c in eligible if c["domain"] not in {i["domain"] for i in items}
                                     and world.truth(c["domain"]).useful)}
    return {"pool": len(eligible), "old": measure(old), "new": measure(new),
            "old_domains": [c["domain"] for c in old], "new_domains": [c["domain"] for c in new]}


def run(seed, split, rounds):
    world = World(seed=seed, split=split)
    network = SimNet(world)
    path = Path(tempfile.mkdtemp(prefix="selector-ab-"))
    original = selection.shortlist
    records = []
    try:
        with installed(network):
            _fresh_finder_state(path)
            engine.configure_for_benchmark(nameserver_fn=network.nameservers)

            def capture(candidates, limit, observations=None, existing=None):
                if existing is not None:  # delivery path, before any candidate is changed
                    records.append(compare(candidates, observations, world, min(limit, 5)))
                return original(candidates, limit, observations, existing)

            selection.shortlist = capture
            for n in range(rounds):
                if n:
                    world.advance()
                engine.run_round(max_deliver=5)
                # Same simulated feedback into subsequent rounds; no ground truth
                # is made available to either selector before scoring.
                while (item := inbox.next_candidate()):
                    truth = Judge(world).judge(item["domain"])
                    inbox.decide(item["id"], "useful" if truth["useful"] else "skip",
                                 reason=None if truth["useful"] else _skip_reason(truth))
    finally:
        selection.shortlist = original
        engine.configure_for_benchmark(nameserver_fn=None)
        shutil.rmtree(path)
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", nargs="+", type=int, default=[101, 202, 303])
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--split", choices=["dev", "eval", "stress"], default="eval")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    rows = [r for seed in args.seeds for r in run(seed, args.split, args.rounds)]
    report = {"split": args.split, "rounds": len(rows), "comparison": {
        version: {metric: round(sum(r[version][metric] for r in rows), 4)
                  for metric in ("useful_at_3", "useful_at_5", "dcg_at_5", "near_duplicate_slots",
                                 "cluster_diversity", "missed_useful")}
        for version in ("old", "new")}, "per_round": rows}
    if args.summary:
        report.pop("per_round")
    print(json.dumps(report, indent=2))
