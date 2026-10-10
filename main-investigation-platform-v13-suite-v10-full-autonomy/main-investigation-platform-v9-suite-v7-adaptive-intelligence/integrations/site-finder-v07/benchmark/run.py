"""
Side-by-side discovery benchmark: Site Finder v1 (v0.7 pipeline, unchanged)
versus Site Finder v2 (precision engine), on the same simulated internet.

    python -m benchmark.run                   # eval split, 3 seeds, 6 rounds
    python -m benchmark.run --split dev
    python -m benchmark.run --seeds 11 12 13 --rounds 8 --json out.json

WHAT "SURFACED" MEANS
---------------------
v1 has no inbox. What v1 puts in front of a person is every site that clears
its triage quality gate: those are set to "queued", offered to the platform
and listed as high-priority candidates. That is the set measured for v1.
v1 at the same volume as v2 (top-N by v1's own score) is reported too, so the
comparison is not just "v2 shows fewer things".

v2 surfaces exactly what its inbox would show you.

WHAT "USEFUL" MEANS
-------------------
A surfaced site is useful when the simulated site is a live crypto scam at the
time it is surfaced AND it is not a duplicate of something already surfaced
(same registrable domain, an infrastructure subdomain like mail./cpanel., or
a clone of an already-surfaced kit that carries no wallets beyond the ones
already surfaced for that kit). A clone with new wallets is useful: it is new
evidence.

The simulated user's decisions (fed back to v2 only, since v1 has no channel
for them) are the ground truth with a small error rate.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from benchmark.world import World  # noqa: E402
from benchmark.simnet import SimNet, installed  # noqa: E402

INFRA_LABELS = {"mail", "webmail", "cpanel", "webdisk", "cpcalendars", "cpcontacts", "autodiscover", "whm", "ftp"}
FEED_URL = "https://feeds.example-reports.test/reported.json"


# ---------------------------------------------------------------------------
# Scoring surfaced candidates against ground truth
# ---------------------------------------------------------------------------

class Judge:
    """Tracks what has been surfaced so duplicates are judged in order."""

    def __init__(self, world: World):
        self.world = world
        self.seen_domains = set()
        self.kit_wallets = {}           # kit -> set of wallet sets already surfaced

    def judge(self, url_or_host: str) -> dict:
        host = url_or_host.split("://")[-1].split("/")[0].split(":")[0].lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        truth = self.world.truth(host)
        if not truth:
            return {"host": host, "useful": False, "reason": "unknown"}
        first = host.split(".")[0]
        if host != truth.name and first in INFRA_LABELS:
            return {"host": host, "useful": False, "reason": "infra_subdomain", "cls": truth.cls}
        if truth.name in self.seen_domains:
            return {"host": host, "useful": False, "reason": "duplicate", "cls": truth.cls}
        self.seen_domains.add(truth.name)
        live = truth.useful and truth.resolves and not truth.failure
        if not live:
            reason = truth.cls if not truth.useful else "dead"
            return {"host": host, "useful": False, "reason": reason, "cls": truth.cls}
        # A clone of a kit already surfaced is only worth another look if it
        # carries wallets not seen on that kit before (new evidence).
        if truth.kit in self.kit_wallets:
            seen = self.kit_wallets[truth.kit]
            if not truth.wallets or truth.wallets in seen:
                return {"host": host, "useful": False, "reason": "duplicate", "cls": truth.cls}
        self.kit_wallets.setdefault(truth.kit, set()).add(truth.wallets)
        return {"host": host, "useful": True, "reason": truth.cls, "cls": truth.cls}


def summarise(judged: list) -> dict:
    n = len(judged)
    useful = sum(1 for j in judged if j["useful"])
    reasons = {}
    for j in judged:
        if not j["useful"]:
            reasons[j["reason"]] = reasons.get(j["reason"], 0) + 1
    return {"surfaced": n, "useful": useful, "precision": round(useful / n, 3) if n else None,
            "noise_breakdown": dict(sorted(reasons.items(), key=lambda kv: -kv[1]))}


# ---------------------------------------------------------------------------
# Isolation helpers
# ---------------------------------------------------------------------------

def _fresh_finder_state(tmp: Path):
    from app import db, config
    from app.collectors import public_feeds
    db.DB_PATH = tmp / "scamhunter.db"
    config.DB_PATH = db.DB_PATH
    public_feeds.FEEDS_FILE = tmp / "feeds.txt"
    public_feeds.FEEDS_FILE.write_text(FEED_URL + "\n", encoding="utf-8")
    db.init_db()


# ---------------------------------------------------------------------------
# v1: the v0.7 pipeline exactly as the runner drives it
# ---------------------------------------------------------------------------

def run_v1(world: World, rounds: int, triage_limit: int = 200) -> dict:
    from app import db
    from app.discovery.engine import DiscoveryEngine
    from app.collectors import run_collectors
    from app.analysis.pipeline_v2 import run_triage_stage

    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix="bench-v1-"))
    judge = Judge(world)
    per_round, all_judged, topn_judged = [], [], []
    sent_to_platform = 0
    try:
        with installed(net):
            _fresh_finder_state(tmp)
            for rnd in range(rounds):
                if rnd:
                    world.advance()
                net.label = "v1"
                DiscoveryEngine().run()
                run_collectors()
                passed = []
                progress = lambda e, d: passed.append(d) if e == "triage_passed" else None  # noqa: E731
                summary = run_triage_stage(limit=triage_limit, progress_cb=progress)
                sent_to_platform += summary.get("offered_to_platform", 0)
                passed.sort(key=lambda d: -d["score"])
                judged = [judge.judge(d["url"]) for d in passed]
                all_judged += judged
                per_round.append({"round": rnd, **summarise(judged)})
    finally:
        shutil.rmtree(tmp)
    return {"pipeline": "v1", "rounds": per_round, "total": summarise(all_judged),
            "sent_to_platform": sent_to_platform, "requests": net.by_label.get("v1", {})}


def run_v1_topn(world_factory, rounds: int, n_per_round: list) -> dict:
    """v1 limited to the same number of candidates per round as v2 surfaced (its own top-N)."""
    world = world_factory()
    from app.discovery.engine import DiscoveryEngine
    from app.collectors import run_collectors
    from app.analysis.pipeline_v2 import run_triage_stage
    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix="bench-v1n-"))
    judge = Judge(world)
    judged_all, per_round = [], []
    try:
        with installed(net):
            _fresh_finder_state(tmp)
            for rnd in range(rounds):
                if rnd:
                    world.advance()
                net.label = "v1"
                DiscoveryEngine().run()
                run_collectors()
                passed = []
                run_triage_stage(limit=200, progress_cb=lambda e, d: passed.append(d) if e == "triage_passed" else None)
                passed.sort(key=lambda d: -d["score"])
                take = passed[: n_per_round[rnd] if rnd < len(n_per_round) else 0]
                judged = [judge.judge(d["url"]) for d in take]
                judged_all += judged
                per_round.append({"round": rnd, **summarise(judged)})
    finally:
        shutil.rmtree(tmp)
    return {"pipeline": "v1_top_n", "rounds": per_round, "total": summarise(judged_all)}


# ---------------------------------------------------------------------------
# v2: the precision engine with the simulated person answering the inbox
# ---------------------------------------------------------------------------

def run_v2(world: World, rounds: int, decision_error: float = 0.03, fetch_budget: int = 200,
           feedback: bool = True, crtsh_budget: int | None = None) -> dict:
    from app.v2 import engine as v2engine
    from app.v2 import inbox as v2inbox
    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix="bench-v2-"))
    judge = Judge(world)
    rng = random.Random(f"decisions:{world.seed}")
    per_round, all_judged, strategy_trace = [], [], []
    saved_crtsh = v2engine.DEFAULTS["crtsh_budget"]
    if crtsh_budget is not None:
        v2engine.DEFAULTS["crtsh_budget"] = crtsh_budget
    try:
        with installed(net):
            _fresh_finder_state(tmp)
            v2engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            for rnd in range(rounds):
                if rnd:
                    world.advance()
                net.label = "v2"
                result = v2engine.run_round(fetch_budget=fetch_budget)
                strategy_trace.append({"round": rnd, "allocation": result.get("allocation"),
                                       "delivered": result.get("delivered")})
                judged = []
                while True:
                    item = v2inbox.next_candidate()
                    if not item:
                        break
                    verdict = judge.judge(item["domain"])
                    judged.append(verdict)
                    truth_useful = verdict["useful"]
                    said_useful = truth_useful if rng.random() > decision_error else not truth_useful
                    if feedback:
                        v2inbox.decide(item["id"], "useful" if said_useful else "skip",
                                       reason=None if said_useful else _skip_reason(verdict))
                all_judged += judged
                per_round.append({"round": rnd, **summarise(judged)})
    finally:
        v2engine.DEFAULTS["crtsh_budget"] = saved_crtsh
        shutil.rmtree(tmp)
    return {"pipeline": "v2" if feedback else "v2_no_feedback", "rounds": per_round, "total": summarise(all_judged),
            "requests": net.by_label.get("v2", {}), "strategies": strategy_trace}


def _skip_reason(verdict: dict) -> str:
    r = verdict.get("reason", "")
    if r in ("parked", "for_sale", "dead", "placeholder", "suspended", "coming_soon"):
        return "dead_or_parked"
    if r in ("duplicate", "infra_subdomain"):
        return "duplicate"
    if r in ("legit_crypto", "brand_owned_redirect", "informational", "non_crypto", "generic"):
        return "not_a_scam"
    return "not_useful"


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="eval", choices=["dev", "eval", "stress"])
    ap.add_argument("--seeds", type=int, nargs="+", default=[101, 202, 303])
    ap.add_argument("--rounds", type=int, default=6)
    ap.add_argument("--only", choices=["v1", "v2"], default=None)
    ap.add_argument("--json", default="")
    ap.add_argument("--ablation", action="store_true", help="also run v2 with your decisions withheld (no learning)")
    ap.add_argument("--v2-crtsh", type=int, default=None, help="crt.sh queries per v2 round (default 12; v1 effectively makes 1)")
    args = ap.parse_args()

    results = []
    for seed in args.seeds:
        row = {"seed": seed, "split": args.split}
        t0 = time.time()
        if args.only != "v2":
            row["v1"] = run_v1(World(seed=seed, split=args.split), args.rounds)
        if args.only != "v1":
            row["v2"] = run_v2(World(seed=seed, split=args.split), args.rounds, crtsh_budget=args.v2_crtsh)
        if args.ablation:
            row["v2_no_feedback"] = run_v2(World(seed=seed, split=args.split), args.rounds, feedback=False)
        if not args.only:
            n = [r["surfaced"] for r in row["v2"]["rounds"]]
            row["v1_top_n"] = run_v1_topn(lambda: World(seed=seed, split=args.split), args.rounds, n)
        row["seconds"] = round(time.time() - t0, 1)
        results.append(row)
        print(json.dumps({k: (v["total"] if isinstance(v, dict) and "total" in v else v) for k, v in row.items()}, indent=1))

    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
