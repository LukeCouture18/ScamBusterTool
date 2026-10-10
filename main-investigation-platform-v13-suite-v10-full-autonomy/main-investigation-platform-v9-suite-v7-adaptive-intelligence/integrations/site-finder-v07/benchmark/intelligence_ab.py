"""Paired investigation benchmark against the Candidate Intelligence RC.

Both selectors receive the same eligible domains in every simulated round.
Graph-based campaign hypotheses are scored against the simulator's *hidden*
kit labels; the old selector does not see graph membership. This simulation
does not establish live correctness or downstream investigative value.
"""
import argparse
import json
import shutil
import tempfile
import time
from collections import Counter
from math import log2
from pathlib import Path
from unittest.mock import patch

from app.v2 import active, engine, inbox, intelligence, selection
from benchmark.run import Judge, _fresh_finder_state, _skip_reason, run_v2
from benchmark.simnet import SimNet, installed
from benchmark.world import World


def assess(pool, observations, world, judges, limit=5):
    baseline = selection.shortlist([{k: v for k, v in c.items() if k != "_campaign"}
                                    for c in pool], limit, observations)
    upgraded = selection.shortlist(pool, limit, observations)

    def metrics(items, judge):
        previously_seen_kits = set(judge.kit_wallets)
        results = [judge.judge(c["domain"]) for c in items]
        kits = {world.truth(c["domain"]).kit for c, verdict in zip(items, results)
                if verdict["useful"] and world.truth(c["domain"]).kit}
        cluster_ids = [(c.get("_campaign") or c.get("cluster_id") or c["domain"]) for c in items]
        return {"useful_at_3": sum(x["useful"] for x in results[:3]),
                "useful_at_5": sum(x["useful"] for x in results),
                "slots": len(items),
                "dcg_at_5": round(sum(int(x["useful"]) / log2(i + 2)
                                      for i, x in enumerate(results)), 4),
                "unique_useful_campaigns": len(kits - previously_seen_kits),
                "duplicate_cluster_slots": len(cluster_ids) - len(set(cluster_ids)),
                "evidence_categories": sum(len(c.get("selection", {}).get("evidence_groups", []))
                                           for c in items)}
    return {"pool": len(pool), "baseline": metrics(baseline, judges["baseline"]),
            "upgraded": metrics(upgraded, judges["upgraded"]),
            "baseline_domains": [c["domain"] for c in baseline],
            "upgraded_domains": [c["domain"] for c in upgraded]}


def run(seed, split, rounds=5):
    world = World(seed=seed, split=split)
    network = SimNet(world)
    path = Path(tempfile.mkdtemp(prefix="intelligence-ab-"))
    original = selection.shortlist
    records = []
    judges = {"baseline": Judge(world), "upgraded": Judge(world)}
    feedback_judge = Judge(world)
    try:
        with installed(network):
            _fresh_finder_state(path)
            engine.configure_for_benchmark(nameserver_fn=network.nameservers)

            def capture(candidates, limit, observations=None, existing=None):
                if existing is not None:
                    selection.shortlist = original
                    try:
                        records.append(assess(candidates, observations, world, judges, min(5, limit)))
                    finally:
                        selection.shortlist = capture
                return original(candidates, limit, observations, existing)

            selection.shortlist = capture
            for n in range(rounds):
                if n:
                    world.advance()
                start = time.monotonic()
                engine.run_round(max_deliver=5)
                records[-1]["seconds"] = round(time.monotonic() - start, 2)
                while (item := inbox.next_candidate()):
                    verdict = feedback_judge.judge(item["domain"])
                    inbox.decide(item["id"], "useful" if verdict["useful"] else "skip",
                                 reason=None if verdict["useful"] else _skip_reason(verdict))
            # Pair precision/recall across all hypothesized links, not just
            # campaign members that made the five-slot queue.
            with intelligence.store.conn() as conn:
                edges = [dict(x) for x in conn.execute("SELECT left_domain,right_domain FROM ig_relationships")]
                domains = [r["domain"] for r in conn.execute("SELECT DISTINCT domain FROM ig_evidence")]
            tp = sum(bool(world.truth(e["left_domain"]) and world.truth(e["right_domain"]) and
                          world.truth(e["left_domain"]).kit and
                          world.truth(e["left_domain"]).kit == world.truth(e["right_domain"]).kit) for e in edges)
            kits = Counter(world.truth(domain).kit for domain in domains
                           if world.truth(domain) and world.truth(domain).kit)
            possible_links = sum(n * (n - 1) // 2 for n in kits.values())
            return {"rounds": records, "relationship_precision": round(tp / len(edges), 3) if edges else None,
                    "false_relationships": len(edges) - tp, "relationships": len(edges),
                    "true_links": tp, "possible_links": possible_links}
    finally:
        selection.shortlist = original
        engine.configure_for_benchmark(nameserver_fn=None)
        shutil.rmtree(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", choices=("dev", "eval", "stress"), default="eval")
    parser.add_argument("--seeds", nargs="+", type=int, default=[101, 202, 303])
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--performance", action="store_true", help="Repeat rounds with graph processing disabled")
    args = parser.parse_args()
    runs = [run(seed, args.split, args.rounds) for seed in args.seeds]
    rounds = [r for item in runs for r in item["rounds"]]
    report = {"split": args.split, "rounds": len(rounds), "comparison": {
        version: {k: round(sum(r[version][k] for r in rounds), 3)
                  for k in ("useful_at_3", "useful_at_5", "unique_useful_campaigns",
                            "duplicate_cluster_slots", "slots", "dcg_at_5", "evidence_categories")}
        for version in ("baseline", "upgraded")},
        "graph": {"relationships": sum(r["relationships"] for r in runs),
                  "false_relationships": sum(r["false_relationships"] for r in runs),
                  "observed_kit_pair_recall": round(sum(r["true_links"] for r in runs) /
                                                    max(1, sum(r["possible_links"] for r in runs)), 4)},
        "round_seconds": round(sum(r["seconds"] for r in rounds), 2)}
    if not args.summary:
        report["runs"] = runs
    for row in report["comparison"].values():
        row["precision_at_5"] = round(row["useful_at_5"] / max(1, row["slots"]), 4)
        row["steps_per_useful"] = round(row["slots"] / max(1, row["useful_at_5"]), 4)
        row["evidence_diversity_per_slot"] = round(row["evidence_categories"] / max(1, row["slots"]), 3)
    if args.performance:
        started = time.monotonic()
        with patch.dict(engine.DEFAULTS, {"max_deliver": 5}), patch.object(intelligence, "ingest", return_value={}), patch.object(
                intelligence, "rebuild", return_value={}), patch.object(
                intelligence, "suggest", return_value=None), patch.object(
                intelligence, "campaign_for", return_value=None), patch.object(
                active, "execute", return_value=[]), patch.object(active, "plan", return_value=[]), patch.object(
                active, "note_decision", return_value=None), patch.object(active, "source_report", return_value={"sources": []}):
            baseline = [run_v2(World(seed=seed, split=args.split), args.rounds, decision_error=0)
                        for seed in args.seeds]
        report["performance"] = {"baseline_seconds": round(time.monotonic()-started, 2),
                                 "graph_round_seconds": report["round_seconds"],
                                 "baseline_useful": sum(x["total"]["useful"] for x in baseline)}
    print(json.dumps(report, indent=2))
