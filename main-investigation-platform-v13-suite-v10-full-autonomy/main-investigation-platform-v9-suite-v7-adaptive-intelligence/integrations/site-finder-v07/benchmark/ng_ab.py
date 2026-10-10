"""
Site Finder: current release vs next generation, on identical hard worlds.

    python -m benchmark.ng_ab --seeds 11 12 13 --rounds 8                       # this tree
    python -m benchmark.ng_ab --compare /path/to/previous/site-finder-v07       # both trees, same worlds

Each engine runs in its own process on its own fresh database against the same
HardWorld (benchmark/hard_world.py), seed, difficulty, round count and per-round
request budget. The same Main/Hunter gap requests (FIND_RELATED_SITES jobs) are
issued to both at the same rounds. A simulated analyst reviews at most five sites
per round, in the order the inbox presents them, and answers with ground truth.

What counts:
  new useful     a live scam, not a duplicate/mirror of something already surfaced,
                 and not already held by Main when it is surfaced
  useful@3/@5    new useful sites among the first three / five reviewed each round
  hidden         unreachable by keyword certificate searches or feeds
  multi-hop      reached through a chain of two or more pivots
  gap            belongs to an operation Main asked about, surfaced after the request
  successor      the reappearance of a taken-down site on a new name
Requests are every simulated network call (HTTP, DNS, CT, RDAP, feed, passive DNS,
page search). Wasted queries are CT / passive-DNS / page-search queries that
returned no registrable domain any earlier query had not already returned.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

VARIANTS = ("ng", "ng_no_page_search")
BUDGET = {"fetch_budget": 60, "dns_budget": 220, "crtsh_budget": 6, "rdap_budget": 30}
REVIEWS_PER_ROUND = 5


class HardJudge:
    """Ground-truth reviewer: duplicates and mirrors are judged in review order."""

    def __init__(self, world):
        self.world = world
        self.seen = set()
        self.kit_wallets = {}

    def judge(self, domain: str, rnd: int) -> dict:
        w = self.world
        host = domain.lower().strip(".")
        host = host[4:] if host.startswith("www.") else host
        t = w.truth(host)
        if not t:
            return {"domain": host, "useful": False, "new": False, "reason": "unknown"}
        if t.name in self.seen:
            return {"domain": host, "useful": False, "new": False, "reason": "duplicate", "kit": t.kit}
        self.seen.add(t.name)
        if not (t.useful and t.resolves and not t.failure):
            return {"domain": host, "useful": False, "new": False, "reason": t.cls if not t.useful else "dead", "kit": t.kit}
        if w.known_to_main(t.name, rnd):
            return {"domain": host, "useful": False, "new": False, "reason": "already_in_main", "kit": t.kit}
        if t.kit in self.kit_wallets and (not t.wallets or t.wallets in self.kit_wallets[t.kit]):
            return {"domain": host, "useful": False, "new": False, "reason": "mirror", "kit": t.kit}
        self.kit_wallets.setdefault(t.kit, set()).add(t.wallets)
        return {"domain": host, "useful": True, "new": True, "reason": t.cls, "kit": t.kit,
                "hidden": w.is_hidden(t.name), "successor": t.name in w.successor_of,
                "wallets": [a for _, a in t.wallets]}


def skip_reason(v: dict) -> str:
    r = v.get("reason", "")
    if r in ("parked", "for_sale", "dead", "placeholder", "suspended", "coming_soon"):
        return "dead_or_parked"
    if r in ("duplicate", "mirror", "already_in_main"):
        return "duplicate"
    if r in ("legit_crypto", "brand_owned_redirect", "informational", "non_crypto", "generic", "script_demo", "pr_article"):
        return "not_a_scam"
    return "not_useful"


FEED_URL = "https://feeds.example-reports.test/reported.json"


def _fresh_finder_state(tmp: Path):
    """Same isolation as benchmark.run (not imported: it would put this tree's app on sys.path)."""
    from app import config, db
    from app.collectors import public_feeds
    db.DB_PATH = tmp / "scamhunter.db"
    config.DB_PATH = db.DB_PATH
    public_feeds.FEEDS_FILE = tmp / "feeds.txt"
    public_feeds.FEEDS_FILE.write_text(FEED_URL + "\n", encoding="utf-8")
    db.init_db()


def _depth(details: dict) -> int:
    ng = details.get("ng") or {}
    ctx = details.get("investigation_context") or {}
    return int(max(ng.get("depth") or 0, ctx.get("depth") or 0))


def run_one(seed: int, split: str, difficulty: float, rounds: int, variant: str, scenario: str = "hard") -> dict:
    """scenario: hard | no_ct (crt.sh down from round 2 and no passive DNS configured)."""
    import logging
    logging.disable(logging.CRITICAL)
    from benchmark.hard_world import HardWorld
    from benchmark.simnet import SimNet, installed
    from app.v2 import engine, inbox, netio, platform_bridge, store
    import app
    assert str(Path(app.__file__).resolve()).startswith(str(Path.cwd().resolve())), (app.__file__, Path.cwd())
    try:
        from app.v2 import ng                                  # next-generation layer (absent in older trees)
    except ImportError:
        ng = None
    engine_name = "next" if ng else "current"
    if ng:
        ng.configure(page_search_url="" if variant == "ng_no_page_search" else "https://urlscan.io/api/v1/search/")
    world = HardWorld(seed=seed, split=split, difficulty=difficulty, rounds=rounds,
                      ct_outage_from=2 if scenario == "no_ct" else None)
    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix="ng-ab-"))
    judge = HardJudge(world)
    saved = dict(engine.DEFAULTS)
    engine.DEFAULTS.update(BUDGET)
    netio.PASSIVE_DNS_URL = "" if scenario == "no_ct" else "https://passivedns.example.test"
    reviewed, first, first_hidden = [], None, None
    started = time.monotonic()
    rounds_out = []
    try:
        with installed(net):
            _fresh_finder_state(tmp)
            engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            for n in range(rounds):
                if n:
                    world.advance()
                if ng:
                    # What Main would hand Site Finder through GET /api/v1/finder/context.
                    ng.memory.note_external([{"domain": d, "source": "main", "state": "known"}
                                             for d in world.main_known_at(n)])
                gaps = [g for g in world.gaps if g["round"] == n]
                for g in gaps:
                    platform_bridge.run_related_job({"payload": {"domain": g["seed"], "requested": 5,
                                                                 "reason": "hunter_gap"}})
                engine.run_round(fetch_budget=BUDGET["fetch_budget"], max_deliver=5)
                this = []
                while len(this) < REVIEWS_PER_ROUND and (item := inbox.next_candidate()):
                    v = judge.judge(item["domain"], n)
                    cand = store.get(item["domain"]) or {}
                    v.update({"round": n, "position": len(this), "depth": _depth(cand.get("details") or {}),
                              "cluster": cand.get("cluster_id"), "ng_bonus": ((cand.get("details") or {}).get("ng") or {}).get("bonus"),
                              "p": cand.get("p"),
                              "requests_so_far": sum(net.counts.values()),
                              "gap": any(v.get("kit") == g["kit"] and g["round"] <= n for g in world.gaps)})
                    inbox.decide(item["id"], "useful" if v["new"] else "skip",
                                 reason=None if v["new"] else skip_reason(v))
                    this.append(v)
                    if v["new"] and first is None:
                        first = {"round": n, "requests": v["requests_so_far"]}
                    if v["new"] and v.get("hidden") and first_hidden is None:
                        first_hidden = {"round": n, "requests": v["requests_so_far"]}
                reviewed += this
                rounds_out.append({"round": n, "reviewed": len(this), "new_useful": sum(x["new"] for x in this)})
            with store.conn() as conn:
                edges = [tuple(r) for r in conn.execute("SELECT left_domain,right_domain FROM ig_relationships")]
                pool_rows = [store.row_to_candidate(r) for r in conn.execute(
                    "SELECT * FROM v2_candidates WHERE status NOT IN ('new','gated')")]
            # Discovery yield beyond the review cap: every truly useful site Finder found and
            # judged eligible (reviewed or still waiting), and the noise that reached eligibility.
            eligible = [c for c in pool_rows if (c.get("details") or {}).get("score", {}).get("core")
                        and float((c.get("details") or {}).get("score", {}).get("p_gate", c.get("p") or 0)) >= engine.DEFAULTS["threshold"]]
            routes = ng.memory.route_stats() if ng else {}
            pool_useful = [c["domain"] for c in eligible if world.truth(c["domain"]) and world.truth(c["domain"]).useful
                           and world.truth(c["domain"]).name not in world.main_known]
            pool = {"eligible": len(eligible), "useful_new": len(pool_useful),
                    "hidden": sum(world.is_hidden(d) for d in pool_useful),
                    "operations": len({world.truth(d).kit for d in pool_useful}),
                    "noise": sum(1 for c in eligible if not (world.truth(c["domain"]) and world.truth(c["domain"]).useful))}
    finally:
        engine.DEFAULTS.clear()
        engine.DEFAULTS.update(saved)
        shutil.rmtree(tmp, ignore_errors=True)
    seconds = time.monotonic() - started

    def kit(d):
        t = world.truth(d)
        return t.kit if t and t.useful or (t and t.kit) else None
    false_edges = sum(1 for a, b in edges if not kit(a) or kit(a) != kit(b))
    seen_regs, wasted, repeats, queries = set(), 0, 0, set()
    by_source = {}
    for source, query, regs in world.query_log:
        fresh = set(regs) - seen_regs
        wasted += int(not fresh)
        row = by_source.setdefault(source, [0, 0])
        row[0] += 1
        row[1] += int(not fresh)
        repeats += int((source, query) in queries)
        queries.add((source, query))
        seen_regs |= set(regs)
    new = [v for v in reviewed if v["new"]]
    total_requests = sum(net.counts.values())
    main_kits = {world.truth(d).kit for d in world.main_known if world.truth(d) and world.truth(d).kit}
    per_round = {}
    for v in reviewed:
        per_round.setdefault(v["round"], []).append(v)
    return {
        "engine": engine_name, "variant": variant if ng else "current", "seed": seed, "split": split, "scenario": scenario,
        "difficulty": difficulty, "rounds": rounds,
        "reviewed": len(reviewed),
        "useful_at_3": sum(sum(x["new"] for x in vs[:3]) for vs in per_round.values()),
        "useful_at_5": sum(sum(x["new"] for x in vs[:5]) for vs in per_round.values()),
        "new_useful": len(new),
        "unique_useful_operations": len({v["kit"] for v in new}),
        "hidden_useful": sum(bool(v.get("hidden")) for v in new),
        "multihop_useful": sum(v["depth"] >= 2 for v in new),
        "gap_useful": sum(bool(v["gap"]) for v in new),
        "successors_found": sum(bool(v.get("successor")) for v in new),
        "new_wallets": len({a for v in new for a in v.get("wallets", [])}),
        "operations_expanded": len({v["kit"] for v in new if v["kit"] in main_kits}),
        "duplicate_slots": sum(v["reason"] == "duplicate" for v in reviewed),
        "mirror_slots": sum(v["reason"] == "mirror" for v in reviewed),
        "already_in_main_slots": sum(v["reason"] == "already_in_main" for v in reviewed),
        "not_scam_slots": sum(skip_reason(v) == "not_a_scam" for v in reviewed if not v["new"]),
        "requests": total_requests, "requests_by_kind": dict(net.counts),
        "requests_per_new_useful": round(total_requests / max(1, len(new)), 1),
        "first_new_useful": first, "first_hidden_useful": first_hidden,
        "queries": len(world.query_log), "wasted_queries": wasted, "repeated_queries": repeats,
        "wasted_query_share": round(wasted / max(1, len(world.query_log)), 3),
        "queries_by_source": by_source,
        "relationships": len(edges), "false_relationships": false_edges,
        "pool_useful_new": pool["useful_new"], "pool_hidden": pool["hidden"], "pool_operations": pool["operations"],
        "pool_noise": pool["noise"],
        "world_hidden_sites": len(world.hidden), "world_successors": len(world.successor_of),
        "world_dark_operations": len(world.dark_ops),
        "routes": {k: {c: round(v.get(c, 0), 1) for c in ("attempts", "productive", "leads", "eligible", "useful", "skipped")}
                   for k, v in routes.items()},
        "seconds": round(seconds, 1),
        "per_round": rounds_out, "reviewed_items": reviewed,
    }


SUM_FIELDS = ("reviewed", "useful_at_3", "useful_at_5", "new_useful", "unique_useful_operations", "hidden_useful",
              "multihop_useful", "gap_useful", "successors_found", "new_wallets", "operations_expanded",
              "duplicate_slots", "mirror_slots", "already_in_main_slots", "not_scam_slots", "requests", "queries",
              "wasted_queries", "repeated_queries", "relationships", "false_relationships", "seconds",
              "pool_useful_new", "pool_hidden", "pool_operations", "pool_noise", "world_hidden_sites",
              "world_successors", "world_dark_operations")


def summarise(rows: list) -> dict:
    out = {k: round(sum(r[k] for r in rows), 1) for k in SUM_FIELDS}
    out["requests_per_new_useful"] = round(out["requests"] / max(1, out["new_useful"]), 1)
    out["wasted_query_share"] = round(out["wasted_queries"] / max(1, out["queries"]), 3)
    firsts = [r["first_new_useful"] for r in rows if r["first_new_useful"]]
    out["worlds_with_a_new_useful"] = f"{len(firsts)}/{len(rows)}"
    out["mean_round_to_first_new_useful"] = round(sum(f["round"] for f in firsts) / max(1, len(firsts)), 2)
    out["mean_requests_to_first_new_useful"] = round(sum(f["requests"] for f in firsts) / max(1, len(firsts)))
    fh = [r["first_hidden_useful"] for r in rows if r.get("first_hidden_useful")]
    out["worlds_with_a_hidden_useful"] = f"{len(fh)}/{len(rows)}"
    out["mean_round_to_first_hidden_useful"] = round(sum(f["round"] for f in fh) / max(1, len(fh)), 2)
    out["mean_requests_to_first_hidden_useful"] = round(sum(f["requests"] for f in fh) / max(1, len(fh)))
    out["useful_share_of_review_slots"] = round(out["new_useful"] / max(1, out["reviewed"]), 3)
    out["requests_per_pool_useful"] = round(out["requests"] / max(1, out["pool_useful_new"]), 1)
    return out


def _spawn(root: Path, args, variant: str) -> list:
    """Runs the given Site Finder tree (its own `app` package) against this tree's hard worlds."""
    boot = "\n".join([
        "import sys, json, importlib.util",
        f"sys.path.insert(0, {str(root)!r})",
        "import benchmark",
        f"benchmark.__path__.insert(0, {str(HERE)!r})",
        f"spec = importlib.util.spec_from_file_location('ng_ab_runner', {str(HERE / 'ng_ab.py')!r})",
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
        f"print(json.dumps([m.run_one(x, {args.split!r}, {args.difficulty!r}, {args.rounds!r}, {variant!r}, {args.scenario!r}) for x in {args.seeds!r}]))",
    ])
    out = subprocess.run([sys.executable, "-c", boot], cwd=str(root), capture_output=True, text=True, timeout=14400)
    if out.returncode:
        raise SystemExit(f"engine at {root} failed:\n{out.stderr[-4000:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, nargs="+", default=[11, 12, 13, 14, 15, 16])
    ap.add_argument("--split", default="eval", choices=["dev", "eval", "stress"])
    ap.add_argument("--difficulty", type=float, default=0.7)
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--compare", default="", help="path to the previous release's site-finder-v07 folder")
    ap.add_argument("--variants", nargs="+", default=list(VARIANTS))
    ap.add_argument("--json", default="")
    ap.add_argument("--scenario", default="hard", choices=["hard", "no_ct"])
    args = ap.parse_args()
    report = {"config": {"seeds": args.seeds, "split": args.split, "difficulty": args.difficulty, "scenario": args.scenario,
                         "rounds": args.rounds, "budget_per_round": BUDGET, "reviews_per_round": REVIEWS_PER_ROUND}}
    here_root = HERE.parent
    if args.compare:
        rows = _spawn(Path(args.compare).resolve(), args, "current")
        report["current"] = {"summary": summarise(rows), "runs": rows}
    for variant in args.variants:
        rows = _spawn(here_root, args, variant)
        report[variant] = {"summary": summarise(rows), "runs": rows}
    printable = {k: v["summary"] for k, v in report.items() if k != "config"}
    print(json.dumps({"config": report["config"], **printable}, indent=1))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
