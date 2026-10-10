"""Bounded passive live discovery check in a throwaway SQLite database."""
import argparse
import json
import tempfile
import time
import socket
from pathlib import Path
from unittest.mock import patch


def main(rounds=3):
    from app import config, db
    from app.collectors import public_feeds
    from app.v2 import active, engine, intelligence, netio, sources, store

    preflight = sources.preflight()
    if preflight["state"] != "LIVE ENVIRONMENT READY":
        print(json.dumps({"live": False, "status": "LIVE ENVIRONMENT BLOCKED",
                          "preflight": preflight, "rounds": [], "eligible": 0,
                          "reason": "Network preflight failed; no discovery rounds were run."}, indent=2))
        return

    with tempfile.TemporaryDirectory(prefix="finder-live-") as folder:
        db.DB_PATH = config.DB_PATH = Path(folder) / "site-finder.db"
        public_feeds.FEEDS_FILE = Path(folder) / "feeds.txt"
        public_feeds.FEEDS_FILE.write_text("", encoding="utf-8")
        db.init_db()
        old = dict(engine.DEFAULTS)
        engine.DEFAULTS.update({"fetch_budget": 25, "dns_budget": 70, "crtsh_budget": 1,
                                "rdap_budget": 5, "brand_dns": 8, "pattern_dns": 8})
        results = []
        counters = {"ct_queries": 0, "ct_raw_records": 0, "dns_queries": 0,
                    "dns_resolved": 0, "http_fetches": 0, "http_ok": 0}
        original_ct, original_dns, original_fetch = netio.crtsh, netio.resolve, netio.fetch

        def count_ct(pattern):
            counters["ct_queries"] += 1
            found = original_ct(pattern)
            counters["ct_raw_records"] += len(found)
            return found

        def count_dns(host):
            counters["dns_queries"] += 1
            value = original_dns(host)
            counters["dns_resolved"] += bool(value)
            return value

        def count_fetch(*args, **kwargs):
            counters["http_fetches"] += 1
            result = original_fetch(*args, **kwargs)
            counters["http_ok"] += bool(result.ok)
            return result
        try:
            with patch.object(netio, "crtsh", count_ct), patch.object(netio, "resolve", count_dns), patch.object(netio, "fetch", count_fetch):
                for _ in range(rounds):
                    start = time.monotonic()
                    result = engine.run_round(fetch_budget=25, max_deliver=5)
                    results.append({"round": result["round"], "pool": result["pool"],
                                    "probed": result["probed"], "gated": result["gated"],
                                    "eligibility_failures": result["gates"],
                                    "delivered": len(result["delivered"]),
                                    "strategies": result["strategies"],
                                    "budget": result["budget"],
                                    "investigation": result["investigation"],
                                    "seconds": round(time.monotonic()-start, 2)})
            try:
                control_dns = {"host": "chatgpt.com", "address": socket.gethostbyname("chatgpt.com")}
            except OSError as exc:
                control_dns = {"host": "chatgpt.com", "error": str(exc)[:150]}
            diagnostic_entries, ct_status, ct_latency = active._ct("example.com")
            source_health = active.source_report()
            report = {"live": True, "preflight": preflight, "rounds": results, "candidates": store.counts(),
                      "campaigns": len(intelligence.list_campaigns()),
                      "source_checks": {"control_dns": control_dns, "certificate_search": {
                          "status": ct_status, "raw_records": len(diagnostic_entries),
                          "latency_seconds": round(ct_latency, 2)}, "observed": counters,
                          "frontier": source_health, "provider_health": sources.health()},
                      "unique_domains": len(store.by_status("new", 100000)) +
                      sum(v for k, v in store.counts().items() if k != "new")}
            print(json.dumps(report, indent=2))
        finally:
            engine.DEFAULTS.clear()
            engine.DEFAULTS.update(old)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args()
    main(max(1, min(args.rounds, 3)))
