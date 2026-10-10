#!/usr/bin/env python3
"""
Command-line entry point.

Usage:
    python cli.py init                     # create the database
    python cli.py collect                  # run collectors, add new candidate sites
    python cli.py rank                     # score all new sites
    python cli.py investigate [N] [flags]  # browser-investigate top N sites (default 5, sequential)
    python cli.py investigate-parallel [WORKERS] [MAX_SITES] [flags]
                                            # investigate using a concurrent worker pool
                                            # (use this once you have thousands of candidates)
    python cli.py full [N] [flags]         # collect + rank + investigate N sites
    python cli.py signup <site_id>         # attempt research signup on one site
    python cli.py serve                    # launch the web UI (v2 inbox at /, full dashboard at /advanced)
    python cli.py round [N]                # v2: run one discovery round (deliver at most N)
    python cli.py inbox                    # v2: work the inbox in the terminal (o=open, u=useful, s=skip, d=details)
    python cli.py v2-stats                 # v2: inbox precision and per-strategy performance
    python cli.py v3-stats                 # v3: learned strategy/signal ledgers and outcome cursor
    python cli.py pull-outcomes            # v3: pull downstream outcomes from the platform now
    python cli.py eval-v3 --split eval     # v2-vs-v3 evaluation
    python cli.py benchmark [--split eval] # v1 vs v2 on the simulated internet (see benchmark/run.py)

Flags (apply to investigate / investigate-parallel / full):
    --allow-signup       Attempt normal account registration on recognized signup
                          pages; still stops immediately at any CAPTCHA, phone
                          verification, or other access control.
    --deep-wallet-hunt    Raise page/link budgets, prioritize deposit-type pages,
                          and click through currency/network tabs to reveal
                          wallet addresses hidden behind a tab switch. If signup
                          is also allowed and succeeds cleanly, continues into
                          the account area looking for member-only deposit pages.
"""
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

from app import db
from app.pipeline import run_collection, run_ranking, run_investigation_batch, run_full_cycle


def _parse_flags(argv: list) -> tuple:
    """Extracts --allow-signup / --deep-wallet-hunt from argv, returning
    (allow_signup, deep_wallet_hunt, remaining_positional_args)."""
    allow_signup = "--allow-signup" in argv
    deep_wallet_hunt = "--deep-wallet-hunt" in argv
    positional = [a for a in argv if not a.startswith("--")]
    return allow_signup, deep_wallet_hunt, positional


def main():
    db.init_db()
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd == "init":
        print("Database initialized.")

    elif cmd == "collect":
        added = run_collection()
        print(f"Added {added} new candidate sites.")

    elif cmd == "rank":
        n = run_ranking()
        print(f"Ranked {n} sites.")

    elif cmd == "investigate":
        allow_signup, deep_wallet_hunt, positional = _parse_flags(rest)
        batch = int(positional[0]) if positional else 5
        results = run_investigation_batch(batch_size=batch, allow_signup=allow_signup,
                                           deep_wallet_hunt=deep_wallet_hunt)
        print(f"Investigated {len(results)} sites.")
        for r in results:
            print(f"  {r['site']['url']}: {r['result']}")

    elif cmd == "investigate-parallel":
        from app.investigate.queue_worker import run_worker_pool
        from app.pipeline import draft_finding_if_evidence
        from app.config import MAX_CONCURRENT_BROWSERS
        allow_signup, deep_wallet_hunt, positional = _parse_flags(rest)
        workers = int(positional[0]) if len(positional) > 0 else MAX_CONCURRENT_BROWSERS
        max_sites = int(positional[1]) if len(positional) > 1 else None
        print(f"Starting {workers} concurrent workers (max_sites={max_sites or 'unlimited'})...")
        results = run_worker_pool(num_workers=workers, headless=True, max_sites_total=max_sites,
                                   allow_signup=allow_signup, deep_wallet_hunt=deep_wallet_hunt)
        ok = sum(1 for r in results if r["ok"])
        print(f"Completed: {ok}/{len(results)} succeeded.")
        for r in results:
            status = "OK" if r["ok"] else f"ERROR: {r.get('error')}"
            print(f"  {r['url']}: {status}")
        drafted = sum(1 for r in results if r["ok"] and draft_finding_if_evidence(r["site_id"]))
        print(f"Drafted {drafted} findings for review.")

    elif cmd == "full":
        allow_signup, deep_wallet_hunt, positional = _parse_flags(rest)
        batch = int(positional[0]) if positional else 5
        summary = run_full_cycle(investigate_batch=batch, allow_signup=allow_signup,
                                  deep_wallet_hunt=deep_wallet_hunt)
        print(summary)

    elif cmd == "signup":
        if len(rest) < 1:
            print("Usage: python cli.py signup <site_id>")
            return
        from app.investigate.signup import attempt_signup
        site = db.get_site(int(rest[0]))
        if not site:
            print("Site not found.")
            return
        result = attempt_signup(site, headless=False)
        print(result)

    elif cmd == "serve":
        from app.review.server import app as flask_app
        from app.config import FINDER_V2
        if FINDER_V2 and os.getenv("V2_AUTOSTART", "1") != "0":
            from app.runner import controller
            ok, message = controller.start_autopilot()
            logging.getLogger("scamhunter").info("v2 autopilot: %s", message)
        # threaded=True is required: SSE holds one long-lived connection per
        # browser tab, so the dev server needs to handle multiple concurrent
        # requests rather than blocking on a single one.
        flask_app.run(debug=False, host=os.getenv("SITE_FINDER_HOST", "127.0.0.1"),
                      port=int(os.getenv("SITE_FINDER_PORT", "5000")), threaded=True)

    elif cmd == "round":
        from app.v2.engine import run_round
        requested = int(rest[0]) if rest else None
        summary = run_round(requested=requested)
        print(f"Round {summary['round']}: {summary['probed']} probed, {summary['gated']} filtered, "
              f"{len(summary['delivered'])} delivered.")
        for d in summary["delivered"]:
            print(f"  {d['p']:.2f}  {d['domain']}  —  {d['headline']}")

    elif cmd == "inbox":
        _terminal_inbox()

    elif cmd == "v2-stats":
        import json
        from app.v2 import inbox, store
        print(json.dumps({"inbox": inbox.stats(), "strategies": store.strategy_stats()}, indent=1, default=str))

    elif cmd == "v3-stats":
        import json
        from app.v2 import store
        cursor = store.get_state("platform_outcome_cursor", 0)
        print(json.dumps({"outcome_cursor": cursor, "strategies": store.strategy_stats(),
                          "signals": store.signal_stats()}, indent=1, default=str))

    elif cmd == "pull-outcomes":
        import json
        from app.v2.outcomes import pull_outcomes
        print(json.dumps(pull_outcomes(), indent=1, default=str))

    elif cmd == "eval-v3":
        import runpy
        sys.argv = ["benchmark.eval_v3"] + rest
        runpy.run_module("benchmark.eval_v3", run_name="__main__")

    elif cmd == "benchmark":
        import runpy
        sys.argv = ["benchmark.run"] + rest
        runpy.run_module("benchmark.run", run_name="__main__")

    else:
        print(__doc__)


def _terminal_inbox():
    import json
    import webbrowser
    from app.v2 import inbox
    while True:
        item = inbox.next_candidate()
        if not item:
            print("Inbox empty. Run `python cli.py round` or leave the autopilot running.")
            return
        print(f"\n{item['domain']}\n  {item['headline']}")
        while True:
            key = input("  [o]pen  [u]seful  [s]kip  [d]etails  [q]uit > ").strip().lower()
            if key == "o":
                inbox.opened(item["id"])
                webbrowser.open(item["url"])
            elif key == "d":
                print(json.dumps(inbox.details(item["id"]), indent=1, default=str)[:6000])
            elif key in ("u", "s"):
                result = inbox.decide(item["id"], "useful" if key == "u" else "skip")
                print(f"  recorded · {result['remaining']} waiting")
                break
            elif key == "q":
                return


if __name__ == "__main__":
    main()
