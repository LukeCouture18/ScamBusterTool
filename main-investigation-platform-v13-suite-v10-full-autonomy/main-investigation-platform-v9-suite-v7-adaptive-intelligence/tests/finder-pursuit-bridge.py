"""Site Finder side of tests/joined-pursuit-loops.mjs.

Runs the real Site Finder code (job claim, run_related_job -> pursuit hunts, the v2 engine, the
durable outbox, the hunts report) against a running Main Platform over HTTP. The public internet
is Site Finder's own synthetic hard world (benchmark/hard_world.py), so no network is touched.
Each invocation is a separate process on the same Site Finder database (every step is a restart).

  python tests/finder-pursuit-bridge.py setup   (register; print one operation's sites from the world)
  python tests/finder-pursuit-bridge.py work    (claim and run every waiting job, deliver, report hunts)
"""
import importlib
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "integrations" / "site-finder-v07"
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
logging.disable(logging.CRITICAL)
cfg = json.loads(os.environ["MIP_JOINED"])

import app.config as config  # noqa: E402

config.DB_PATH = Path(cfg["dir"]) / "scamhunter.db"
import app.db as db  # noqa: E402

importlib.reload(db)
db.init_db()
from app.v2 import engine, netio, platform_bridge, pursuit, store  # noqa: E402
from app.integration.v4.client import PlatformClient  # noqa: E402
from app.integration.v4 import jobs, sync  # noqa: E402
from benchmark.hard_world import HardWorld  # noqa: E402
from benchmark.simnet import SimNet, installed  # noqa: E402

client = PlatformClient(base_url=cfg["url"], api_key=cfg["key"])
world = HardWorld(seed=int(cfg.get("seed", 5)), difficulty=0.7)
cmd = sys.argv[1]
out = {"cmd": cmd}

if cmd == "setup":
    out["register"] = bool(client.register())
    by_kit = {}
    for name, t in world.domains.items():
        if t.useful and t.kit and t.resolves and name not in world.main_known:
            by_kit.setdefault(t.kit, []).append(name)
    kit, sites = max(by_kit.items(), key=lambda kv: len(kv[1]))
    out["operation"] = kit
    out["sites"] = sorted(sites)[:3]
elif cmd == "work":
    net = SimNet(world)
    import socket
    real_connect = socket.create_connection

    def connect(address, *a, **kw):                    # Main (local) is reachable; the public internet is simulated
        if str(address[0]) in ("127.0.0.1", "localhost", "::1"):
            return real_connect(address, *a, **kw)
        return net_create(address, *a, **kw)
    net_create = net.create_connection
    net.create_connection = connect
    netio.PASSIVE_DNS_URL = "https://passivedns.example.test"
    engine.DEFAULTS.update({"fetch_budget": 40, "dns_budget": 150, "crtsh_budget": 4, "rdap_budget": 20})
    ran = []
    with installed(net):
        engine.configure_for_benchmark(nameserver_fn=net.nameservers)
        for _ in range(6):
            r = jobs.claim_and_run_one(client)
            if not r.get("claimed"):
                out["last_claim"] = r
                break
            ran.append({k: r.get(k) for k in ("job_id", "job_type", "ran", "refused", "error")} | {"v2": r.get("v2") or {}})
        out["sync"] = sync.sync_until_drained(client)
    out["ran"] = ran
    out["hunts_push"] = platform_bridge.push_hunts(client)
    out["hunts"] = pursuit.hunts_view(50)
    with store.conn() as conn:
        out["branches"] = conn.execute("SELECT COUNT(*) FROM pu_branches").fetchone()[0] if \
            conn.execute("SELECT 1 FROM sqlite_master WHERE name='pu_branches'").fetchone() else 0
out["outbox"] = db.outbox_stats()
print(json.dumps(out, default=str))
