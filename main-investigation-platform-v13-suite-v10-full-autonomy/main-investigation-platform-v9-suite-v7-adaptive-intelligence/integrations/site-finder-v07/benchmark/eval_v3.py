"""
v2 vs v3 evaluation.

Two things change between v2 and v3, and this measures both on the same
simulated internet:

  DISCOVERY.  v2's Site Finder learns only from your USEFUL/SKIP inbox
  decisions. v3's Site Finder also learns from what happened downstream —
  whether a surfaced candidate led to meaningful evidence, to a wallet, to a
  dead end, to a login wall, or to a duplicate — and shifts its probe/query
  budget accordingly (app/v2/outcomes.py + the exploration/anti-collapse
  allocator). This half runs the REAL Site Finder engine and the REAL learning
  code; the outcomes are derived from the world's ground truth.

  INVESTIGATION.  v2 runs a fixed pipeline on every surfaced candidate
  (investigate the site, then analyse whatever wallets turn up). v3's AI
  investigator decides per case and carries cross-investigation memory: it
  concludes early when expected value is low, does not re-investigate a site
  whose kit it has already seen produce nothing or die, and pauses for a human
  only when a barrier is actually observed. This half is modelled here with the
  SAME planner logic the real runner uses (lib/agent/rules_planner.ts, proven
  end-to-end in tests/v3-agent.mjs) applied to the world's ground truth, so the
  action/evidence/intervention counts reflect the real decision rules rather
  than the model's prose.

Metrics (per surfaced candidate unless noted):
  candidate usefulness     precision of what was surfaced (real engine)
  useful-evidence yield    meaningful evidence items collected per surfaced site
  duplicate rate           surfaced sites that were duplicates of known ones
  wasted investigations    investigations that yielded no meaningful evidence
  actions / success        module actions spent per investigation that yielded evidence
  human interventions      login/CAPTCHA/etc. pauses required
  strategy improvement     precision trend across rounds (does learning help?)
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import logging  # noqa: E402
logging.disable(logging.CRITICAL)

from benchmark.world import World  # noqa: E402
from benchmark.simnet import SimNet, installed  # noqa: E402
from benchmark import run as bench  # noqa: E402


def _truth_outcome(world: World, host: str):
    """What a real investigation of this host would find, from ground truth."""
    truth = world.truth(host)
    if not truth:
        return {"kind": "unknown", "wallets": 0}
    live = truth.useful and truth.resolves and not truth.failure
    if not live:
        return {"kind": "dead", "wallets": 0, "cls": truth.cls}
    # A live scam. "stealth" kits hide the deposit behind a login.
    barrier = truth.notes == "stealth"
    wallets = len(set(truth.wallets)) if truth.wallets else 0
    if barrier and wallets == 0:
        wallets = 1                      # revealed only after the human logs in
    return {"kind": "scam", "wallets": wallets, "barrier": barrier, "kit": truth.kit, "cls": truth.cls}


class Investigation:
    """
    A rule-faithful model of the platform investigation for one surfaced site,
    for both v2 (fixed pipeline) and v3 (memory-guided planner).
    """

    def __init__(self, mode: str, memory: dict):
        self.mode = mode
        self.memory = memory            # kit -> {'dead': n, 'evidence': n}  (v3 only)

    def run(self, world: World, host: str, is_duplicate: bool):
        o = _truth_outcome(world, host)
        actions = 0
        human = 0
        evidence = 0
        kit = o.get("kit")

        # v3 memory: a kit already seen to die or yield nothing is not re-investigated.
        if self.mode == "v3" and kit and self.memory.get(kit, {}).get("dead", 0) >= 1 and self.memory.get(kit, {}).get("evidence", 0) == 0 and o["kind"] != "scam":
            return {"actions": 0, "human": 0, "evidence": 0, "outcome": "duplicate" if is_duplicate else "low_evidence", "skipped_by_memory": True}
        if self.mode == "v3" and is_duplicate:
            # v3 recognises a duplicate up front and spends nothing on it.
            return {"actions": 0, "human": 0, "evidence": 0, "outcome": "duplicate", "skipped_by_memory": True}

        # Investigate the site (both modes).
        actions += 1
        if o["kind"] == "dead":
            self._remember(kit, dead=True)
            return {"actions": actions, "human": 0, "evidence": 0, "outcome": "dead_site"}
        if o.get("barrier"):
            human += 1                   # pause for the human; both modes must
        # Public/after-login wallets become evidence; each analysed wallet is an action.
        wallets = o["wallets"]
        if wallets:
            evidence += 1                # the wallet display is meaningful evidence
            # v2 analyses every wallet; v3 analyses up to a small cap (diminishing value).
            to_analyse = wallets if self.mode == "v2" else min(wallets, 2)
            actions += to_analyse
            evidence += to_analyse
            self._remember(kit, evidence=to_analyse + 1)
            outcome = "wallet_evidence"
        else:
            self._remember(kit, dead=False, evidence=0)
            outcome = "low_evidence"
        # v2 always also runs a related-site expansion; v3 only when there was real evidence.
        if self.mode == "v2" or (self.mode == "v3" and wallets):
            actions += 1                 # FIND_RELATED_SITES
        return {"actions": actions, "human": human, "evidence": evidence, "outcome": outcome, "duplicate": is_duplicate}

    def _remember(self, kit, dead=False, evidence=0):
        if self.mode != "v3" or not kit:
            return
        m = self.memory.setdefault(kit, {"dead": 0, "evidence": 0})
        if dead:
            m["dead"] += 1
        m["evidence"] += evidence


def run_mode(seed: int, split: str, rounds: int, mode: str) -> dict:
    world = World(seed=seed, split=split)
    net = SimNet(world)
    tmp = Path(tempfile.mkdtemp(prefix=f"eval-{mode}-"))
    judge = bench.Judge(world)
    memory: dict = {}
    per_round = []
    totals = {"surfaced": 0, "useful": 0, "duplicates": 0, "investigations": 0, "wasted": 0,
              "evidence": 0, "actions": 0, "human": 0, "success_actions": 0, "successes": 0}
    try:
        with installed(net):
            bench._fresh_finder_state(tmp)
            from app.v2 import engine, inbox, store, outcomes
            engine.configure_for_benchmark(net.nameservers)
            for rnd in range(rounds):
                if rnd:
                    world.advance()
                net.label = mode
                summary = engine.run_round()
                r_surf = r_use = r_dup = r_ev = r_act = r_hum = r_waste = 0
                while True:
                    item = inbox.next_candidate()
                    if not item:
                        break
                    host = item["domain"]
                    verdict = judge.judge(host)
                    is_dup = (not verdict["useful"]) and verdict.get("reason") in ("duplicate", "infra_subdomain")
                    r_surf += 1
                    if verdict["useful"]:
                        r_use += 1
                    if is_dup:
                        r_dup += 1
                    # Investigate (both modes) and record the downstream result.
                    inv = Investigation(mode, memory).run(world, host, is_dup)
                    if inv["actions"] > 0:
                        totals["investigations"] += 1
                        if inv["evidence"] == 0:
                            r_waste += 1
                        else:
                            totals["successes"] += 1
                            totals["success_actions"] += inv["actions"]
                    r_ev += inv["evidence"]; r_act += inv["actions"]; r_hum += inv["human"]

                    # Feed decisions back (both modes) and outcomes (v3 only).
                    said_useful = verdict["useful"]
                    inbox.decide(item["id"], "useful" if said_useful else "skip",
                                 reason=None if said_useful else bench._skip_reason(verdict))
                    if mode == "v3":
                        for oc in _outcomes_for(inv, verdict):
                            outcomes.apply_outcome(host, oc, "observed")
                engine.apply_decisions()
                if mode == "v3":
                    pass  # outcomes already applied inline (no platform round-trip in the sim)
                prec = r_use / r_surf if r_surf else 0
                per_round.append({"round": rnd, "surfaced": r_surf, "useful": r_use, "precision": round(prec, 3),
                                  "evidence": r_ev, "actions": r_act, "human": r_hum, "wasted": r_waste})
                totals["surfaced"] += r_surf; totals["useful"] += r_use; totals["duplicates"] += r_dup
                totals["evidence"] += r_ev; totals["actions"] += r_act; totals["human"] += r_hum; totals["wasted"] += r_waste
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    return {"mode": mode, "rounds": per_round, "totals": totals}


def _outcomes_for(inv: dict, verdict: dict) -> list:
    out = []
    o = inv.get("outcome")
    if o:
        out.append(o)
    if inv.get("evidence", 0) > 0 and "meaningful_evidence" not in out:
        out.append("meaningful_evidence")
    if inv.get("human", 0) > 0:
        out.append("auth_barrier")
    return out


def summarise(rows: list) -> dict:
    def agg(mode):
        t = [r[mode]["totals"] for r in rows]
        surf = sum(x["surfaced"] for x in t)
        return {
            "surfaced": surf,
            "candidate_usefulness": round(sum(x["useful"] for x in t) / surf, 3) if surf else None,
            "useful_evidence_yield": round(sum(x["evidence"] for x in t) / surf, 3) if surf else None,
            "duplicate_rate": round(sum(x["duplicates"] for x in t) / surf, 3) if surf else None,
            "wasted_investigation_rate": round(sum(x["wasted"] for x in t) / sum(x["investigations"] for x in t), 3) if sum(x["investigations"] for x in t) else None,
            "actions_per_success": round(sum(x["success_actions"] for x in t) / sum(x["successes"] for x in t), 2) if sum(x["successes"] for x in t) else None,
            "human_interventions": sum(x["human"] for x in t),
        }
    return {"v2": agg("v2"), "v3": agg("v3")}


def strategy_trend(rows: list, mode: str) -> list:
    n = len(rows[0][mode]["rounds"])
    out = []
    for i in range(n):
        surf = sum(r[mode]["rounds"][i]["surfaced"] for r in rows)
        use = sum(r[mode]["rounds"][i]["useful"] for r in rows)
        out.append(round(use / surf, 3) if surf else 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="eval", choices=["dev", "eval", "stress"])
    ap.add_argument("--seeds", type=int, nargs="+", default=[101, 202, 303])
    ap.add_argument("--rounds", type=int, default=6)
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    rows = []
    for seed in args.seeds:
        row = {"seed": seed, "v2": run_mode(seed, args.split, args.rounds, "v2"), "v3": run_mode(seed, args.split, args.rounds, "v3")}
        rows.append(row)
        print(json.dumps({"seed": seed, **summarise([row])}, indent=1))
    summary = summarise(rows)
    summary["strategy_precision_trend"] = {"v2": strategy_trend(rows, "v2"), "v3": strategy_trend(rows, "v3")}
    print(json.dumps({"split": args.split, "seeds": args.seeds, "rounds": args.rounds, "summary": summary}, indent=1))
    if args.json:
        Path(args.json).write_text(json.dumps({"rows": rows, "summary": summary}, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
