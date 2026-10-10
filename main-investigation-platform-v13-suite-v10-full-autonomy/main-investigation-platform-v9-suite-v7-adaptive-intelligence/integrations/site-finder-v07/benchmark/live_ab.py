"""
Live A/B: v1 vs v2 on the real internet, judged by you, blind.

The simulated benchmark (benchmark/run.py) has ground truth but is a model of
the world. This script measures the thing that actually matters — how often
what each pipeline surfaces is worth your time — on live discovery, with you
as the judge and without telling you which pipeline surfaced what.

    python -m benchmark.live_ab run [--rounds 1] [--out live_ab]
        Runs v1 (discovery + triage, exactly as the v0.7 runner does) and one or
        more v2 rounds, each in its own throwaway database (your real
        data/scamhunter.db is not touched), with the same public feeds. Writes:
          live_ab/sheet.csv   shuffled, pipeline-blind: id, url, label, notes
          live_ab/key.json    which pipeline(s) surfaced each id (don't open it
                              until you've labelled)

    Fill in the `label` column with `useful` or `skip` (open each site the way
    you normally would; log in only if you normally would).

    python -m benchmark.live_ab score live_ab/sheet.csv
        Prints precision for v1, v2, and v1 limited to v2's volume.

Everything both pipelines do here is passive and public: DNS, crt.sh, RDAP and
unauthenticated GETs of public pages. Nothing logs in or submits anything.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _isolated_db(tag: str) -> Path:
    from app import db, config
    from app.collectors import public_feeds
    tmp = Path(tempfile.mkdtemp(prefix=f"live-ab-{tag}-"))
    real_feeds = public_feeds.FEEDS_FILE
    db.DB_PATH = tmp / "scamhunter.db"
    config.DB_PATH = db.DB_PATH
    feeds = tmp / "feeds.txt"
    if Path(real_feeds).exists():
        shutil.copy(real_feeds, feeds)
    public_feeds.FEEDS_FILE = feeds
    db.init_db()
    return tmp


def run(rounds: int, out: Path):
    from app.discovery.engine import DiscoveryEngine
    from app.collectors import run_collectors
    from app.analysis.pipeline_v2 import run_triage_stage
    from app.v2 import engine, inbox
    from app.v2.domains import registrable

    out.mkdir(parents=True, exist_ok=True)
    surfaced = {}

    print("v1: discovery + triage …")
    _isolated_db("v1")
    for _ in range(rounds):
        DiscoveryEngine().run()
        run_collectors()
        passed = []
        run_triage_stage(limit=200, progress_cb=lambda e, d: passed.append(d) if e == "triage_passed" else None)
        for rank, d in enumerate(sorted(passed, key=lambda x: -x["score"])):
            key = registrable(d["url"])
            surfaced.setdefault(key, {"url": d["url"]})["v1"] = {"rank": rank, "score": d["score"]}

    print("v2: precision engine …")
    _isolated_db("v2")
    for _ in range(rounds):
        engine.run_round()
    rank = 0
    while True:
        item = inbox.next_candidate()
        if not item:
            break
        surfaced.setdefault(item["domain"], {"url": item["url"]})["v2"] = {"rank": rank, "p": item["p"], "headline": item["headline"]}
        inbox.decide(item["id"], "skip", reason="not_useful")   # throwaway DB; keeps the inbox moving
        rank += 1

    ids = list(surfaced)
    random.shuffle(ids)
    key = {}
    with open(out / "sheet.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "url", "label", "notes"])
        for i, dom in enumerate(ids, 1):
            w.writerow([i, surfaced[dom]["url"], "", ""])
            key[str(i)] = {"domain": dom, **{k: v for k, v in surfaced[dom].items() if k in ("v1", "v2")}}
    (out / "key.json").write_text(json.dumps(key, indent=1), encoding="utf-8")
    n1 = sum(1 for v in key.values() if "v1" in v)
    n2 = sum(1 for v in key.values() if "v2" in v)
    print(f"Wrote {len(ids)} sites to {out/'sheet.csv'} (v1 surfaced {n1}, v2 surfaced {n2}; overlap "
          f"{sum(1 for v in key.values() if 'v1' in v and 'v2' in v)}). Label each row useful/skip, then run "
          f"`python -m benchmark.live_ab score {out/'sheet.csv'}`.")


def score(sheet: Path):
    key = json.loads((sheet.parent / "key.json").read_text(encoding="utf-8"))
    labels = {}
    with open(sheet, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            lab = (row.get("label") or "").strip().lower()
            if lab in ("useful", "skip", "u", "s"):
                labels[row["id"]] = lab in ("useful", "u")

    def prec(ids):
        judged = [labels[i] for i in ids if i in labels]
        return {"surfaced": len(ids), "labelled": len(judged), "useful": sum(judged),
                "precision": round(sum(judged) / len(judged), 3) if judged else None}

    v1 = [i for i, v in key.items() if "v1" in v]
    v2 = [i for i, v in key.items() if "v2" in v]
    v1_top = sorted(v1, key=lambda i: key[i]["v1"]["rank"])[: len(v2)]
    print(json.dumps({"v1": prec(v1), "v2": prec(v2), "v1_at_v2_volume": prec(v1_top)}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--rounds", type=int, default=1)
    r.add_argument("--out", default="live_ab")
    s = sub.add_parser("score")
    s.add_argument("sheet")
    args = ap.parse_args()
    if args.cmd == "run":
        run(args.rounds, Path(args.out))
    else:
        score(Path(args.sheet))


if __name__ == "__main__":
    main()
