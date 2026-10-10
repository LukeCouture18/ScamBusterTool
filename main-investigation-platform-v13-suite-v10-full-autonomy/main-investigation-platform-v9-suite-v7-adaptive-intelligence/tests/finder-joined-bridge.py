"""Site Finder side of the joined Site Finder -> Main -> Operation Hunter test.

Runs the real Site Finder code (v2 candidate store, platform bridge, durable
outbox, SyncWorker drain, decision pull and learning ledger) against a running
Main Platform over HTTP. Each invocation is a separate process on the same
Site Finder database, so every step after the first is also a restart.

Only the candidates' observed facts are synthetic (there is no public internet
here); everything that moves them to Main and back is Site Finder's own code.

  python tests/finder-joined-bridge.py deliver   (MIP_JOINED={"dir","url","key","candidates":[...]})
  python tests/finder-joined-bridge.py resend    (forget one delivered batch locally and send it again)
  python tests/finder-joined-bridge.py retry     (the operator's "retry deferred" action, then drain)
  python tests/finder-joined-bridge.py pull      (pull inbox decisions and fold them into the ledgers)
"""
import importlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "integrations" / "site-finder-v07"
sys.path.insert(0, str(ROOT))
cfg = json.loads(os.environ["MIP_JOINED"])

import app.config as config  # noqa: E402

config.DB_PATH = Path(cfg["dir"]) / "scamhunter.db"
import app.db as db  # noqa: E402

importlib.reload(db)
db.init_db()
from app.v2 import store, platform_bridge, engine  # noqa: E402
from app.integration.v4.client import PlatformClient  # noqa: E402
from app.integration.v4 import sync  # noqa: E402

client = PlatformClient(base_url=cfg["url"], api_key=cfg["key"])
cmd = sys.argv[1]
out = {"cmd": cmd}

if cmd == "deliver":
    out["register"] = client.register()
    delivered = []
    for c in cfg["candidates"]:
        domain = c["domain"]
        store.insert_new(domain, f"https://{domain}/", c.get("strategy", "ct_new_domain"), 0.5)
        signals = [{"name": "deposit_page", "group": "money", "strength": 0.7, "phrase": "deposit page with address"},
                   {"name": "crypto_brand", "group": "brand", "strength": 0.6, "phrase": "crypto investment platform"}]
        for w in c.get("wallets", []):
            signals.append({"name": "deposit_address", "group": "money", "strength": 0.9, "phrase": "deposit address (ethereum)", "detail": w})
        details = {"keys": c["keys"], "ip": c.get("ip", ""), "ns": c.get("ns", []), "fetch": {"status": 200},
                   "score": {"p": c["p"]}, "context": "synthetic public observation",
                   # what Site Finder's continuous watch records (v5): full name-server set and live/dead
                   **({"watch_rev": 1, "site_status": c["site_status"]} if c.get("site_status") else {})}
        store.update(domain, status="delivered", p=c["p"], headline=c.get("headline", f"{domain}: crypto deposit page"),
                     category="crypto_investment", signals=signals, details=details, delivered_at=time.time())
        delivered.append(store.get(domain))
    out["queued"] = platform_bridge.queue_deliveries(delivered)
    out["sync"] = sync.sync_until_drained(client)
elif cmd == "resend":
    # Simulates a crash after Main accepted a batch but before Site Finder recorded the ack:
    # the same batch is delivered again and Main must treat it as a replay, not new work.
    domain = cfg["domain"]
    built = platform_bridge.build_inbox_batch(store.get(domain))
    with db.get_conn() as conn:
        conn.execute("DELETE FROM integration_outbox WHERE event_id=?", (built["batch_id"],))
    out["queued"] = db.queue_batch(built["batch_id"], built["records"], kind="v2_inbox").get("queued")
    out["sync"] = sync.sync_until_drained(client)
elif cmd == "retry":
    # The operator's "retry deferred" action: parked batches go out on the next pass.
    out["retry"] = sync.retry_deferred()
    out["sync"] = sync.sync_until_drained(client)
elif cmd == "pull":
    out["pull"] = platform_bridge.pull_decisions(client)
    out["applied"] = engine.apply_decisions()
    out["candidates"] = {d: {k: (store.get(d) or {}).get(k) for k in ("status", "decision", "decision_reason")}
                         for d in cfg.get("domains", [])}
out["outbox"] = db.outbox_stats()
print(json.dumps(out, default=str))
