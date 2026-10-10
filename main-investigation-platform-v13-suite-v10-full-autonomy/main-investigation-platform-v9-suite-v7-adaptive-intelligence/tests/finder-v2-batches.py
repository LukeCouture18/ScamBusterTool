"""Emit real Site Finder v2 inbox batches (JSON) from a simulated discovery round.

Everything is synthetic: the benchmark's simulated internet answers every DNS,
HTTP, crt.sh and RDAP request. No network access.
"""
import json, sys, tempfile, logging
from pathlib import Path
root = Path(__file__).resolve().parents[1] / "integrations" / "site-finder-v07"
sys.path.insert(0, str(root))
logging.disable(logging.CRITICAL)
from benchmark.world import World
from benchmark.simnet import SimNet, installed
from benchmark import run as bench
from app.v2 import engine, platform_bridge, store
import atexit, shutil


def _scratch():
    """A temporary Site Finder state directory, removed when this script exits (best effort on Windows)."""
    path = Path(tempfile.mkdtemp(prefix="finder-v2-batches-"))
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path


world = World(seed=7, split="dev")
net = SimNet(world)
with installed(net):
    bench._fresh_finder_state(_scratch())
    engine.configure_for_benchmark(net.nameservers)
    summary = engine.run_round(max_deliver=12)
    batches = []
    for d in summary["delivered"]:
        cand = store.get(d["domain"])
        built = platform_bridge.build_inbox_batch(cand)
        batches.append({"batch_id": built["batch_id"], "records": built["records"], "domain": d["domain"],
                        "truth": world.truth(d["domain"]).cls})
print(json.dumps({"batches": batches, "probed": summary["probed"], "gated": summary["gated"]}))
