#!/usr/bin/env python3
"""
Pursuit benchmark: adversarial, independent discovery benchmark for Site Finder.

    python3 pursuit_bench.py --tree PATH [--compare PATH] [--seeds 1 2 3] [--rounds 10]
                             [--scenario all|NAME ...] [--difficulty hard] [--json OUT]
                             [--quick] [--jobs 2] [--no-noise-floor]

Every (tree, seed, scenario) run executes in its own subprocess with the chosen
engine tree first on sys.path, a fresh SQLite state directory and a fresh
PursuitWorld, so imports and module-level state never mix between trees or runs.
Both trees get identical budgets, identical starting knowledge, identical gap
requests and an identical simulated reviewer.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent
BUDGETS = {"fetch_budget": 60, "dns_budget": 220, "crtsh_budget": 6, "rdap_budget": 30, "max_deliver": 5}
REVIEW_SLOTS = 5
SEARCH_KINDS = ("crtsh", "page_search", "passive_dns")
PARKED_LIKE = {"parked", "for_sale", "dead", "placeholder", "suspended", "coming_soon"}
NOT_SCAM = {"legit_crypto", "brand_owned_redirect", "informational", "non_crypto", "generic", "script_demo", "pr_article"}
INFRA_LABELS = {"mail", "webmail", "cpanel", "webdisk", "cpcalendars", "cpcontacts", "autodiscover", "whm", "ftp"}
ALL_SCENARIOS = ["mixed", "cert_blackout", "cdn_maze", "copycat", "migration", "mirror_flood", "collapse", "dark_family"]


# =========================================================================== worker side

class Reviewer:
    """The simulated analyst: ground truth, but only for sites that are NEW to Main."""

    def __init__(self, world):
        self.world = world
        self.reviewed = set()
        self.useful = []                      # (round, domain)
        self.credited_groups = {}             # mirror group -> wallets seen
        self.verdicts = []

    def judge(self, domain: str, rnd: int, known_now: set) -> tuple[bool, str | None, str]:
        w = self.world
        host = (domain or "").lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        t = w.truth(host)
        if not t:
            return False, "not_useful", "unknown"
        if host != t.name and host.split(".")[0] in INFRA_LABELS:
            return False, "duplicate", "infra_subdomain"
        if t.name in self.reviewed:
            return False, "duplicate", "already_reviewed"
        self.reviewed.add(t.name)
        if t.name in known_now:
            return False, "duplicate", "main_known"
        g = w.gt.get(t.name, {})
        live = t.useful and t.resolves and not t.failure and g.get("kind") == "scam"
        if not live:
            if g.get("kind") == "infra":
                return False, "not_useful", "scam_infra"
            if g.get("kind") == "scam":
                return False, "dead_or_parked", "dead_scam"
            if t.cls in PARKED_LIKE:
                return False, "dead_or_parked", t.cls
            if t.cls in NOT_SCAM:
                return False, "not_a_scam", t.cls
            return False, "not_useful", t.cls
        if g.get("role") in ("mirror", "mirror_primary"):
            grp = g.get("mirror_of") or t.name
            wallets = {x[1] for x in g.get("wallets") or ()}
            seen = self.credited_groups.get(grp)
            if seen is None and grp in known_now:
                seen = wallets                # Main already holds the original
            if seen is not None and wallets <= seen:
                return False, "duplicate", "mirror"
            self.credited_groups[grp] = (seen or set()) | wallets
        return True, None, g.get("role", "scam")


class ContextClient:
    """Stub of Main's client: `finder_context` feeds the sites Main already holds."""

    def __init__(self):
        self.configured = True
        self.events = []
        self.sdk = self

    def add(self, domains, source="main"):
        have = {e["domain"] for e in self.events}
        for d in domains:
            if d not in have:
                self.events.append({"domain": d, "source": source, "state": "known"})
                have.add(d)

    def finder_context(self, since="", limit=1000):
        start = int(since) if str(since or "").isdigit() else 0
        chunk = self.events[start:start + limit]
        return {"known": chunk, "next_since": str(start + len(chunk))}


def _pct(xs, q=50):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(len(xs) * q / 100))]


def run_one(tree: str, seed: int, scenario: str, difficulty: str, rounds: int) -> dict:
    sys.path.insert(0, str(BENCH_DIR))
    sys.path.insert(0, tree)                   # the tree's `benchmark` and `app` win
    import logging
    logging.disable(logging.CRITICAL)
    from benchmark.simnet import SimNet, installed
    from benchmark.run import _fresh_finder_state
    from pursuit_world import PursuitWorld

    t0 = time.time()
    world = PursuitWorld(seed=seed, scenario=scenario, difficulty=difficulty, rounds=rounds)
    totals = world.totals()
    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix="pursuit-"))
    reviewer = Reviewer(world)
    ctx = ContextClient()
    errors = []
    trace = []
    first_useful = None
    due_outcomes = defaultdict(list)
    outcome_wallets = set()
    outcomes_sent = defaultdict(int)
    pending_investigation = []
    pool_rows = []
    rel_rows = []
    rel_note = ""

    def total_requests():
        return sum(net.counts.values())

    def safe(label, fn, *a, **k):
        try:
            return fn(*a, **k)
        except Exception as exc:                  # noqa: BLE001 - an engine crash is a result, not a bench crash
            errors.append(f"r{world.round} {label}: {type(exc).__name__}: {exc}"[:300])
            return None

    with installed(net):
        _fresh_finder_state(tmp)
        from app.v2 import engine, inbox, netio, outcomes, platform_bridge, store
        netio.PASSIVE_DNS_URL = "https://passivedns.example.test"
        engine.configure_for_benchmark(nameserver_fn=net.nameservers)
        for k, v in BUDGETS.items():
            if k in engine.DEFAULTS:
                engine.DEFAULTS[k] = v
        for rnd in range(rounds):
            if rnd:
                world.advance()
            # 1. Main tells Finder what it already holds (world knowledge + last round's confirmed sites)
            ctx.add(world.known_at(rnd))
            ctx.add([d for r_, d in reviewer.useful if r_ < rnd])
            safe("pull_context", platform_bridge.pull_context, ctx)
            known_now = {e["domain"] for e in ctx.events}
            # 2. delayed downstream investigation outcomes
            for dom in due_outcomes.pop(rnd, []):
                t = world.truth(dom)
                g = world.gt.get(dom, {})
                wallets = {x[1] for x in g.get("wallets") or ()}
                if not t or not t.resolves:
                    oc = "dead_site"
                elif g.get("hollow"):
                    oc = "low_evidence"
                elif wallets - outcome_wallets:
                    oc = "wallet_evidence"
                else:
                    oc = "meaningful_evidence" if g.get("value", 0) >= 3 else "investigation_completed"
                outcome_wallets |= wallets
                outcomes_sent[oc] += 1
                safe("apply_outcome", outcomes.apply_outcome, dom, oc, basis="observed")
            # 3. Hunter gap request (fixed rounds, identical for every engine)
            if rnd in world.gap_plan:
                safe("gap_job", platform_bridge.run_related_job, {"payload": dict(world.gap_plan[rnd])})
            # 4. investigation artifacts for the sites confirmed last round
            if pending_investigation:
                arts, seen = [], set()
                for d in pending_investigation:
                    for a in world.investigation_artifacts(d):
                        key = (a["kind"], a["value"])
                        if key not in seen:
                            seen.add(key)
                            arts.append(a)
                payload = {"domain": pending_investigation[0], "seeds": pending_investigation[1:5], "requested": 5,
                           "reason": "site investigation extracted public artifacts", "source": "investigation",
                           "artifacts": arts[:40]}
                safe("investigation_job", platform_bridge.run_related_job, {"payload": payload})
                pending_investigation = []
            # 5. the ordinary discovery round
            safe("run_round", engine.run_round, fetch_budget=BUDGETS["fetch_budget"], max_deliver=BUDGETS["max_deliver"])
            # 6. the analyst reviews up to five candidates
            reviewed_now = 0
            for _ in range(REVIEW_SLOTS):
                item = safe("next_candidate", inbox.next_candidate)
                if not item or not item.get("domain"):
                    break
                ok, reason, why = reviewer.judge(item["domain"], rnd, known_now)
                reviewed_now += 1
                g = world.gt.get((world.truth(item["domain"]).name if world.truth(item["domain"]) else ""), {})
                reviewer.verdicts.append({"r": rnd, "domain": item["domain"], "useful": ok, "why": why,
                                          "op": g.get("op"), "min_pivots": g.get("min_pivots")})
                safe("decide", inbox.decide, item["id"], "useful" if ok else "skip", reason=reason)
                if ok:
                    name = world.truth(item["domain"]).name
                    reviewer.useful.append((rnd, name))
                    pending_investigation.append(name)
                    due_outcomes[rnd + 2 + (int(world.gt[name]["value"] * 10) % 2)].append(name)
                    if first_useful is None:
                        first_useful = {"round": rnd, "requests": total_requests()}
            trace.append({"round": rnd, "reviewed": reviewed_now, "useful_cum": len(reviewer.useful),
                          "requests_cum": total_requests()})
        # ---- what the engine judged eligible, and the relationships it asserted
        try:
            with store.conn() as cx:
                pool_rows = [tuple(r) for r in cx.execute("SELECT domain, status FROM v2_candidates")]
                tables = {r[0] for r in cx.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "ig_relationships" in tables:
                    cols = [r[1] for r in cx.execute("PRAGMA table_info(ig_relationships)")]
                    if "left_domain" in cols and "right_domain" in cols:
                        rel_rows = [tuple(r) for r in cx.execute("SELECT left_domain, right_domain FROM ig_relationships")]
                    else:
                        rel_note = f"ig_relationships columns: {cols}"
                else:
                    rel_note = "no ig_relationships table"
        except Exception as exc:                  # noqa: BLE001
            rel_note = f"store query failed: {exc}"

    # =================================================================== metrics
    known_final = {e["domain"] for e in ctx.events} - {d for _, d in reviewer.useful}
    useful = [d for _, d in reviewer.useful]
    gt = world.gt
    pivots = [gt[d]["min_pivots"] for d in useful]
    log = world.log
    mirrors = {d for d, g in gt.items() if g.get("role") == "mirror"}
    scam_live = {d for d, g in gt.items() if g.get("kind") == "scam"}
    search = [e for e in log if e["kind"] in SEARCH_KINDS]
    dns = [e for e in log if e["kind"] == "dns"]
    http = [e for e in log if e["kind"] == "http"]
    eligible_status = {"ready", "presented", "useful", "delivered"}
    pool_useful, credited = set(), set()
    for dom, status in pool_rows:
        if status not in eligible_status:
            continue
        t = world.truth(dom)
        g = gt.get(t.name if t else "", {})
        if g.get("kind") != "scam" or (t.name in known_final):
            continue
        grp = g.get("mirror_of") or t.name
        if g.get("role") in ("mirror", "mirror_primary"):
            prim_known = grp in known_final
            if prim_known or grp in credited:
                continue
            credited.add(grp)
        pool_useful.add(t.name)
    rel_total = len(rel_rows)
    rel_false_cross = rel_nonscam = rel_true = 0
    for a, b in rel_rows:
        ta, tb = world.truth(a or ""), world.truth(b or "")
        ga, gb = gt.get(ta.name if ta else "", {}), gt.get(tb.name if tb else "", {})
        if ga.get("kind") != "scam" or gb.get("kind") != "scam":
            rel_nonscam += 1
        elif ga["op"] != gb["op"]:
            rel_false_cross += 1
        else:
            rel_true += 1
    reqs = dict(net.counts)
    total_req = sum(reqs.values())
    n_useful = len(useful)
    metrics = {
        "new_useful": n_useful,
        "found_share": round(n_useful / max(1, totals["useful_units"] - totals["by_min_pivots"].get("unreachable", 0)), 3),
        "reviewed": len(reviewer.verdicts),
        "precision": round(n_useful / len(reviewer.verdicts), 3) if reviewer.verdicts else 0.0,
        "multi_hop": sum(1 for p in pivots if p is not None and p >= 2),
        "median_pivots": _pct(pivots),
        "unreachable_found": sum(1 for p in pivots if p is None),
        "operations": len({gt[d]["op"] for d in useful}),
        "unknown_family": sum(1 for d in useful if gt[d].get("unknown_family")),
        "reappearances": sum(1 for d in useful if gt[d].get("returned_from")),
        "value": round(sum(gt[d]["value"] for d in useful), 2),
        "pool_useful": len(pool_useful),
        "requests": reqs,
        "requests_total": total_req,
        "queries_total": len(search),
        "requests_per_useful": round(total_req / n_useful, 1) if n_useful else None,
        "queries_per_useful": round(len(search) / n_useful, 1) if n_useful else None,
        "repeated_queries": sum(1 for e in search if e["repeat"]),
        "dead_end_queries": sum(1 for e in search if e["new"] == 0),
        "dead_end_dns": sum(1 for e in dns if e["new"] == 0),
        "junk_fetches": sum(1 for e in http if e.get("target") not in scam_live),
        "mirror_requests": sum(1 for e in log if e["kind"] in ("http", "dns") and e.get("target") in mirrors),
        "rel_total": rel_total, "rel_false_cross_op": rel_false_cross, "rel_non_scam": rel_nonscam,
        "rel_same_op": rel_true, "rel_note": rel_note,
        "first_useful_round": first_useful["round"] if first_useful else None,
        "first_useful_requests": first_useful["requests"] if first_useful else None,
        "skip_reasons": _count(v["why"] for v in reviewer.verdicts if not v["useful"]),
        "outcomes": dict(outcomes_sent),
        "engine_errors": len(errors),
    }
    return {"tree": tree, "seed": seed, "scenario": scenario, "difficulty": difficulty, "rounds": rounds,
            "hashseed": os.environ.get("PYTHONHASHSEED", ""), "seconds": round(time.time() - t0, 1),
            "world": totals, "metrics": metrics, "useful_domains": sorted(useful), "pool_useful": sorted(pool_useful),
            "verdicts": reviewer.verdicts, "trace": trace, "errors": errors[:20]}


def _count(it):
    out = defaultdict(int)
    for x in it:
        out[x] += 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


# =========================================================================== orchestration

def _label_trees(paths):
    parts = [Path(p).resolve().parts for p in paths]
    if len(paths) == 2:
        for a, b in zip(*parts):
            if a != b:
                return [a, b]
        return ["A", "B"]
    return [Path(paths[0]).resolve().parts[-3] if len(parts[0]) > 3 else "tree"]


def _launch(job, out_path, hashseed):
    env = dict(os.environ, PYTHONHASHSEED=str(hashseed), PYTHONDONTWRITEBYTECODE="1")
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", "--tree", job["tree"], "--seeds", str(job["seed"]),
           "--scenario", job["scenario"], "--difficulty", job["difficulty"], "--rounds", str(job["rounds"]),
           "--worker-out", str(out_path)]
    return subprocess.Popen(cmd, env=env, cwd=tempfile.gettempdir(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def run_jobs(jobs, n_parallel, timeout=1800):
    results = []
    tmpdir = Path(tempfile.mkdtemp(prefix="pursuit-bench-"))
    queue = list(enumerate(jobs))
    running = {}
    while queue or running:
        while queue and len(running) < n_parallel:
            i, job = queue.pop(0)
            out = tmpdir / f"run{i}.json"
            running[i] = (job, out, _launch(job, out, job.get("hashseed", 0)), time.time())
        time.sleep(0.2)
        for i, (job, out, proc, started) in list(running.items()):
            if proc.poll() is None and time.time() - started < timeout:
                continue
            if proc.poll() is None:
                proc.kill()
            err = proc.stderr.read().decode(errors="ignore")[-2000:] if proc.stderr else ""
            del running[i]
            if out.exists():
                res = json.loads(out.read_text())
                res["label"] = job["label"]
                results.append(res)
                print(f"  [{job['label']}] seed {job['seed']} {job['scenario']:<13} hash={job.get('hashseed', 0)} "
                      f"useful={res['metrics']['new_useful']:>2} prec={res['metrics']['precision']:.2f} "
                      f"req={res['metrics']['requests_total']:>5} {res['seconds']:>5.0f}s", flush=True)
            else:
                print(f"  [{job['label']}] seed {job['seed']} {job['scenario']} FAILED\n{err}", flush=True)
                results.append({"label": job["label"], "seed": job["seed"], "scenario": job["scenario"],
                                "hashseed": job.get("hashseed", 0), "failed": True, "stderr": err})
    return results


# =========================================================================== reporting

TABLE_COLS = [("new_useful", "useful", "{:.1f}"), ("found_share", "found%", "{:.0%}"), ("pool_useful", "pool", "{:.1f}"), ("precision", "prec", "{:.2f}"),
              ("multi_hop", "multihop", "{:.1f}"), ("median_pivots", "medpiv", "{:.1f}"),
              ("operations", "ops", "{:.1f}"), ("unknown_family", "unkfam", "{:.1f}"), ("reappearances", "return", "{:.1f}"),
              ("value", "value", "{:.1f}"), ("requests_total", "requests", "{:.0f}"), ("requests_per_useful", "req/use", "{:.0f}"),
              ("queries_per_useful", "q/use", "{:.1f}"), ("dead_end_queries", "deadQ", "{:.0f}"),
              ("repeated_queries", "repeatQ", "{:.0f}"), ("mirror_requests", "mirrorReq", "{:.0f}"),
              ("junk_fetches", "junkGET", "{:.0f}"), ("rel_false_cross_op", "falseRel", "{:.1f}"),
              ("first_useful_round", "1stR", "{:.1f}"), ("first_useful_requests", "1stReq", "{:.0f}")]
HIGHER_BETTER = {"new_useful", "found_share", "pool_useful", "precision", "multi_hop", "operations", "unknown_family", "reappearances", "value"}
LOWER_BETTER = {"requests_per_useful", "queries_per_useful", "dead_end_queries", "repeated_queries", "mirror_requests",
                "junk_fetches", "rel_false_cross_op", "first_useful_round", "first_useful_requests"}


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.fmean(xs) if xs else None


def aggregate(runs):
    agg = {}
    for key, _, _ in TABLE_COLS:
        agg[key] = _mean([r["metrics"].get(key) for r in runs])
    agg["runs"] = len(runs)
    agg["new_useful_sum"] = sum(r["metrics"]["new_useful"] for r in runs)
    agg["value_sum"] = round(sum(r["metrics"]["value"] for r in runs), 1)
    agg["requests_sum"] = sum(r["metrics"]["requests_total"] for r in runs)
    agg["engine_errors"] = sum(r["metrics"]["engine_errors"] for r in runs)
    agg["reachable_units"] = sum(r["world"]["useful_units"] - r["world"]["by_min_pivots"].get("unreachable", 0) for r in runs)
    agg["found_share_of_reachable"] = round(agg["new_useful_sum"] / agg["reachable_units"], 3) if agg["reachable_units"] else None
    return agg


def fmt_table(title, rows):
    """rows: list of (name, agg)"""
    head = f"{'':<14}" + "".join(f"{lbl:>10}" for _, lbl, _ in TABLE_COLS)
    lines = [title, head]
    for name, a in rows:
        cells = []
        for key, _, f in TABLE_COLS:
            v = a.get(key)
            cells.append(f"{(f.format(v) if v is not None else '-'):>10}")
        lines.append(f"{name:<14}" + "".join(cells))
    return "\n".join(lines)


def report(results, labels, args):
    ok = [r for r in results if not r.get("failed") and not r.get("noise_floor")]
    out = {"config": {"seeds": args.seeds, "rounds": args.rounds, "difficulty": args.difficulty,
                      "scenarios": args.scenarios, "budgets": BUDGETS, "review_slots": REVIEW_SLOTS},
           "trees": {}, "per_scenario": {}, "unique": {}, "wins": [], "world": {}, "noise_floor": {}}
    print("\n================ WORLD (ground truth; identical for every tree) ================")
    print(f"{'scenario':<14}{'units':>7}{'reach':>7}{'pivots dist (0/1/2/3/4/5+/unreach)':>40}{'unkfam':>8}{'return':>8}{'mirrors':>9}{'known0':>8}")
    for sc in args.scenarios:
        ws = [r["world"] for r in ok if r["scenario"] == sc and r["label"] == labels[0]]
        if not ws:
            continue
        tot = defaultdict(int)
        for w in ws:
            for k, v in w["by_min_pivots"].items():
                tot[k] += v
        dist = "/".join(str(tot.get(k, 0)) for k in ("0", "1", "2", "3", "4", "5+", "unreachable"))
        units = sum(w["useful_units"] for w in ws)
        out["world"][sc] = {"useful_units": units, "by_min_pivots": dict(tot), "unknown_family": sum(w["unknown_family"] for w in ws),
                            "returned": sum(w["returned"] for w in ws), "mirrors": sum(w["mirrors"] for w in ws),
                            "main_known_r0": sum(w["main_known_r0"] for w in ws), "seeds": len(ws)}
        print(f"{sc:<14}{units:>7}{units - tot.get('unreachable', 0):>7}{dist:>40}{out['world'][sc]['unknown_family']:>8}"
              f"{out['world'][sc]['returned']:>8}{out['world'][sc]['mirrors']:>9}{out['world'][sc]['main_known_r0']:>8}")
    for label in labels:
        runs = [r for r in ok if r["label"] == label]
        rows = []
        for sc in args.scenarios:
            sr = [r for r in runs if r["scenario"] == sc]
            if sr:
                a = aggregate(sr)
                out["per_scenario"].setdefault(sc, {})[label] = a
                rows.append((sc, a))
        a_all = aggregate(runs) if runs else {}
        out["trees"][label] = a_all
        rows.append(("ALL (mean)", a_all))
        print(f"\n================ TREE {label}: means per run ================")
        print(fmt_table("", rows))
        if runs:
            print(f"totals: useful={a_all['new_useful_sum']} of {a_all['reachable_units']} reachable units "
                  f"({(a_all['found_share_of_reachable'] or 0) * 100:.0f}%), value={a_all['value_sum']}, "
                  f"requests={a_all['requests_sum']}, engine errors={a_all['engine_errors']}, "
                  f"mean run time={_mean([r['seconds'] for r in runs]):.0f}s")
    if len(labels) == 2:
        A, B = labels
        print("\n================ UNIQUE DISCOVERIES (same seed & scenario) ================")
        ua = ub = pa = pb = 0
        per = defaultdict(lambda: [0, 0, 0, 0])
        for r in [x for x in ok if x["label"] == A]:
            other = next((x for x in ok if x["label"] == B and x["seed"] == r["seed"] and x["scenario"] == r["scenario"]), None)
            if not other:
                continue
            sa, sb = set(r["useful_domains"]), set(other["useful_domains"])
            qa, qb = set(r["pool_useful"]), set(other["pool_useful"])
            ua += len(sa - sb)
            ub += len(sb - sa)
            pa += len(qa - qb)
            pb += len(qb - qa)
            p = per[r["scenario"]]
            p[0] += len(sa - sb)
            p[1] += len(sb - sa)
            p[2] += len(qa - qb)
            p[3] += len(qb - qa)
        out["unique"] = {"reviewed": {A: ua, B: ub}, "eligible_pool": {A: pa, B: pb},
                         "per_scenario": {k: {"reviewed": {A: v[0], B: v[1]}, "pool": {A: v[2], B: v[3]}} for k, v in per.items()}}
        print(f"reviewed-useful only found by {A}: {ua}   only by {B}: {ub}")
        print(f"eligible-pool useful only in {A}: {pa}   only in {B}: {pb}")
        for sc, v in per.items():
            print(f"  {sc:<14} reviewed {A}:{v[0]} {B}:{v[1]}   pool {A}:{v[2]} {B}:{v[3]}")
        print("\n================ WINS / LOSSES (per scenario, beyond noise floor) ================")
        nf = noise_floor(results, labels)
        out["noise_floor"] = nf
        for sc in args.scenarios:
            pa_, pb_ = out["per_scenario"].get(sc, {}).get(A), out["per_scenario"].get(sc, {}).get(B)
            if not pa_ or not pb_:
                continue
            wins_a, wins_b = [], []
            for key, lbl, _ in TABLE_COLS:
                va, vb = pa_.get(key), pb_.get(key)
                if va is None or vb is None or key not in HIGHER_BETTER | LOWER_BETTER:
                    continue
                floor = max(nf.get(key, {}).get("max_abs_diff", 0) or 0, 1e-9)
                if abs(va - vb) <= floor:
                    continue
                better_a = (va > vb) if key in HIGHER_BETTER else (va < vb)
                (wins_a if better_a else wins_b).append(f"{lbl} {va:.2f} vs {vb:.2f}")
            out["wins"].append({"scenario": sc, A: wins_a, B: wins_b})
            print(f"{sc:<14} {A} better: {', '.join(wins_a) or '-'}")
            print(f"{'':<14} {B} better: {', '.join(wins_b) or '-'}")
    else:
        out["noise_floor"] = noise_floor(results, labels)
    if out["noise_floor"]:
        print("\n================ NOISE FLOOR (same tree, same seed, different PYTHONHASHSEED) ================")
        for key, v in out["noise_floor"].items():
            print(f"  {key:<24} values={v['values']}  max |diff|={v['max_abs_diff']}")
    return out


def noise_floor(results, labels):
    nf_runs = [r for r in results if r.get("noise_floor") and not r.get("failed")]
    out = {}
    for key, _, _ in TABLE_COLS:
        vals, diffs = [], []
        for label in labels:
            vs = [r["metrics"].get(key) for r in nf_runs if r["label"] == label]
            vs = [v for v in vs if v is not None]
            if len(vs) >= 2:
                vals.append(vs)
                diffs.append(max(vs) - min(vs))
        if vals:
            out[key] = {"values": vals, "max_abs_diff": round(max(diffs), 3)}
    return out


# =========================================================================== CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tree", required=True)
    ap.add_argument("--compare", default="")
    ap.add_argument("--labels", nargs=2, default=None)
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5, 6])
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--scenario", nargs="+", default=["all"])
    ap.add_argument("--difficulty", default="hard", choices=["normal", "hard", "brutal"])
    ap.add_argument("--json", default="")
    ap.add_argument("--quick", action="store_true", help="2 seeds, 4 scenarios, 8 rounds")
    ap.add_argument("--jobs", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    ap.add_argument("--no-noise-floor", action="store_true")
    ap.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--worker-out", default="", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.worker:
        res = run_one(args.tree, args.seeds[0], args.scenario[0], args.difficulty, args.rounds)
        Path(args.worker_out).write_text(json.dumps(res), encoding="utf-8")
        return

    scenarios = ALL_SCENARIOS if "all" in args.scenario else args.scenario
    for sc in scenarios:
        if sc not in ALL_SCENARIOS:
            ap.error(f"unknown scenario {sc}; choose from {ALL_SCENARIOS}")
    if args.quick:
        args.seeds = args.seeds[:2]
        if "all" in args.scenario:
            scenarios = ["mixed", "cdn_maze", "copycat", "mirror_flood"]
        args.rounds = min(args.rounds, 8)
    args.scenarios = scenarios
    trees = [str(Path(args.tree).resolve())] + ([str(Path(args.compare).resolve())] if args.compare else [])
    labels = args.labels or _label_trees(trees)
    jobs = []
    for seed in args.seeds:
        for sc in scenarios:
            for tree, label in zip(trees, labels):
                jobs.append({"tree": tree, "label": label, "seed": seed, "scenario": sc,
                             "difficulty": args.difficulty, "rounds": args.rounds, "hashseed": 0})
    if not args.no_noise_floor:
        for tree, label in zip(trees, labels):
            for hs in (1, 2):
                jobs.append({"tree": tree, "label": label, "seed": args.seeds[0], "scenario": scenarios[0],
                             "difficulty": args.difficulty, "rounds": args.rounds, "hashseed": hs, "noise_floor": True})
    print(f"pursuit bench: {len(jobs)} runs, trees={labels}, seeds={args.seeds}, scenarios={scenarios}, "
          f"rounds={args.rounds}, difficulty={args.difficulty}, jobs={args.jobs}", flush=True)
    t0 = time.time()
    results = run_jobs(jobs, args.jobs)
    # mark noise-floor runs (hashseed != 0 on the noise-floor seed/scenario); include the hashseed=0 run too
    for r in results:
        r["noise_floor"] = str(r.get("hashseed")) in ("1", "2")
    nf_base = [dict(r, noise_floor=True) for r in results
               if not r.get("failed") and str(r.get("hashseed")) == "0" and r["seed"] == args.seeds[0] and r["scenario"] == scenarios[0]]
    summary = report(results + nf_base, labels, args)
    summary["wall_seconds"] = round(time.time() - t0, 1)
    print(f"\nwall time {summary['wall_seconds']:.0f}s")
    if args.json:
        Path(args.json).write_text(json.dumps({"summary": summary, "runs": results}, indent=1), encoding="utf-8")
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
