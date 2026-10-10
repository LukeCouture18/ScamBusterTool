"""Paired hidden-path simulation on identical worlds with/without execution.

The ambient discovery arms are held constant and empty in this *isolation*
benchmark. Only the investigation frontier can follow the custom CT chain;
ordinary gate, probe, ranking, review, graph and persistence stay real.
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from app.v2 import active, engine, inbox, intelligence, store, strategies
from benchmark.run import Judge, _fresh_finder_state
from benchmark.simnet import SimNet, installed
from benchmark.world import Domain, World, evm_address

AMBIENT = ("cert_siblings", "ct_learned", "ct_frontier", "pattern_siblings",
           "ct_terms", "brand_typos", "feeds", "mentions")


def add_hidden(world):
    names = [f"alpha-{world.seed}.test", f"bridge-{world.seed}.test", f"hidden-{world.seed}.test"]
    for i, name in enumerate(names):
        world.domains[name] = Domain(name=name, cls="hyip", useful=True, born_round=0,
                                     registered_days_ago=12, ip=f"198.51.100.{10+i}",
                                     ns=("ns1.research.test",), kit=f"hidden-{world.seed}-{i}",
                                     wallets=(("USDT-ERC20", evm_address(world.rng)),))
    for i, (source, target) in enumerate(zip(names, names[1:])):
        world.certs.append({"id": 9000000 + i, "name_value": f"{source}\n{target}",
                            "_born_round": 0, "entry_timestamp": world.now.isoformat()})
    # Adversarial public CT noise: unrelated, dead domains may share a source
    # entry but can never create graph edges or pass the site gate.
    for i in range(3):
        bogus = f"noise-{world.seed}-{i}.test"
        world.domains[bogus] = Domain(name=bogus, cls="dead", useful=False, born_round=0,
                                      registered_days_ago=8, resolves=False)
        world.certs.append({"id": 9100000+i, "name_value": f"{names[0]}\n{bogus}",
                            "_born_round": 0, "entry_timestamp": world.now.isoformat()})
    return names


def trial(seed, split, enabled):
    world = World(seed, split)
    chain = add_hidden(world)
    net = SimNet(world)
    path = Path(tempfile.mkdtemp(prefix="investigation-path-"))
    judge = Judge(world)
    deliveries = []
    useful = set()
    t0 = time.monotonic()
    try:
        with installed(net), patch.multiple(strategies, **{name: lambda *args, **kwargs: [] for name in AMBIENT}):
            _fresh_finder_state(path)
            engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            if enabled:
                turn_off = patch.object(active, "MAX_ACTIONS_PER_ROUND", 1)
            else:
                turn_off = patch.object(active, "execute", return_value=[])
            with turn_off:
                for n in range(6):
                    summary = engine.run_round(fetch_budget=25, max_deliver=5,
                                               extra_leads=[strategies.Lead(chain[0], "manual", "seed", .8)] if n == 0 else [])
                    deliveries.extend(x["domain"] for x in summary["delivered"])
                    while (cand := inbox.next_candidate()):
                        result = judge.judge(cand["domain"])
                        if result["useful"]:
                            useful.add(cand["domain"])
                        inbox.decide(cand["domain"], "useful" if result["useful"] else "skip",
                                     reason=None if result["useful"] else "not_useful")
            with store.conn() as conn:
                edges = [tuple(row) for row in conn.execute("SELECT left_domain,right_domain FROM ig_relationships")]
                paths = [dict(row) for row in conn.execute("SELECT * FROM ig_action_results")]
                depth = conn.execute("SELECT MAX(depth) FROM ig_frontier f JOIN ig_action_results r "
                                     "ON r.frontier_id=f.id WHERE r.status='useful'").fetchone()[0] or 0
                growth = conn.execute("SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()").fetchone()[0]
            false_edges = sum(bool(world.truth(a) and world.truth(b) and
                                   world.truth(a).kit != world.truth(b).kit) for a, b in edges)
            return {"seed": seed, "split": split, "enabled": enabled, "useful": len(useful),
                    "hidden_useful": sum(d in useful for d in chain[1:]),
                    "useful_at_5": sum(d in useful for d in deliveries[:5]),
                    "new_domains": len(deliveries), "unique_useful_campaigns": len(useful),
                    "multihop_useful": int(chain[-1] in useful),
                    "path_depth": depth,
                    "action_count": len({r["frontier_id"] for r in paths}),
                    "dead_end_rate": round(sum(r["status"] in ("gated", "duplicate") for r in paths) /
                                           max(1, len(paths)), 3),
                    "false_relationships": false_edges, "relationships": len(edges),
                    "runtime": round(time.monotonic()-t0, 3), "db_bytes": growth,
                    "sources": net.counts, "delivered": deliveries}
    finally:
        engine.configure_for_benchmark(nameserver_fn=None)
        shutil.rmtree(path)


def evaluate(seeds, split):
    pairs = [{"baseline": trial(seed, split, False), "active": trial(seed, split, True)} for seed in seeds]
    fields = ("useful", "hidden_useful", "multihop_useful", "false_relationships", "relationships", "runtime", "db_bytes")
    return {"split": split, "seeds": len(seeds),
            "baseline": {k: round(sum(p["baseline"][k] for p in pairs), 3) for k in fields},
            "active": {k: round(sum(p["active"][k] for p in pairs), 3) for k in fields},
            "runs": pairs}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", choices=("dev", "eval", "stress"), default="eval")
    parser.add_argument("--seeds", type=int, nargs="+", default=[101, 202, 303])
    args = parser.parse_args()
    print(json.dumps(evaluate(args.seeds, args.split), indent=2))
