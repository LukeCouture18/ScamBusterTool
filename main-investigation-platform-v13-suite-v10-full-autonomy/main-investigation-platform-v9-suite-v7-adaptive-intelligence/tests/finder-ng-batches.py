"""Emit real Site Finder inbox batches from the next-generation discovery engine.

Runs the real v2 engine (with the NG planner, page-build fingerprints and discovery memory) for a
few rounds on the synthetic hard world (benchmark/hard_world.py): no network access. Earlier rounds
are reviewed with the world's ground truth so later rounds pivot from useful sites; the batches of
the last round are printed for Main (the same wire shape platform_bridge sends).
"""
import json, logging, os, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1] / "integrations" / "site-finder-v07"
sys.path.insert(0, str(root))
os.chdir(root)
logging.disable(logging.CRITICAL)
from benchmark.hard_world import HardWorld
from benchmark.simnet import SimNet, installed
from benchmark.ng_ab import _fresh_finder_state, HardJudge, BUDGET
from app.v2 import engine, inbox, netio, ng, platform_bridge, store
import atexit, shutil


def _scratch():
    """A temporary Site Finder state directory, removed when this script exits (best effort on Windows)."""
    path = Path(tempfile.mkdtemp(prefix="finder-ng-batches-"))
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path


seed = int(os.environ.get("NG_BATCH_SEED", "3"))
rounds = 3
ng.configure(enabled_flag=True, page_search_url="https://urlscan.io/api/v1/search/")
world = HardWorld(seed=seed, split="dev", difficulty=0.7, rounds=rounds)
net = SimNet(world)
judge = HardJudge(world)
engine.DEFAULTS.update(BUDGET)
netio.PASSIVE_DNS_URL = "https://passivedns.example.test"
batches = []
with installed(net):
    _fresh_finder_state(_scratch())
    engine.configure_for_benchmark(nameserver_fn=net.nameservers)
    for n in range(rounds):
        if n:
            world.advance()
        summary = engine.run_round(fetch_budget=BUDGET["fetch_budget"], max_deliver=6)
        if n < rounds - 1:
            while (item := inbox.next_candidate()):
                v = judge.judge(item["domain"], n)
                inbox.decide(item["id"], "useful" if v["new"] else "skip", reason=None if v["new"] else "not_scam")
            continue
        for d in summary["delivered"]:
            cand = store.get(d["domain"])
            built = platform_bridge.build_inbox_batch(cand)
            batches.append({"batch_id": built["batch_id"], "records": built["records"], "domain": d["domain"],
                            "pivot": bool(((cand.get("details") or {}).get("ng") or {}).get("route") or
                                          any(s in ("ng_pivot", "ng_gap") for s in (cand.get("strategies") or []))),
                            "truth": world.truth(d["domain"]).cls if hasattr(world, "truth") else None})
from app.v2 import pursuit
print(json.dumps({"batches": batches, "hunts": pursuit.hunts_view(40)}, default=str))
