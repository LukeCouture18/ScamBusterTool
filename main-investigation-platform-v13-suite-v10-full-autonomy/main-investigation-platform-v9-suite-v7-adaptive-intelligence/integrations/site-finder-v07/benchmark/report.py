"""
Summarise benchmark JSON files (from `benchmark.run --json`) as Markdown.

    python -m benchmark.report eval.json stress.json dev.json > results.md
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

PIPELINES = [("v1", "v1 (v0.7 pipeline)"), ("v2", "v2"), ("v2_no_feedback", "v2, decisions withheld")]


def summarise(path: Path) -> str:
    rows = json.loads(path.read_text(encoding="utf-8"))
    split = rows[0]["split"]
    out = [f"### Split: `{split}` — {len(rows)} seeds × {len(rows[0]['v2']['rounds'])} rounds", ""]
    out.append("| Pipeline | Surfaced | Useful | Precision | Per-seed precision | What the noise was |")
    out.append("| --- | ---: | ---: | ---: | --- | --- |")
    for key, label in PIPELINES:
        if key not in rows[0]:
            continue
        s = sum(r[key]["total"]["surfaced"] for r in rows)
        u = sum(r[key]["total"]["useful"] for r in rows)
        noise = Counter()
        for r in rows:
            noise.update(r[key]["total"]["noise_breakdown"])
        per = ", ".join(f"{r[key]['total']['precision']:.2f}" for r in rows if r[key]["total"]["precision"] is not None)
        noise_s = ", ".join(f"{k} {v}" for k, v in noise.most_common()) or "none"
        out.append(f"| {label} | {s} | {u} | **{(u / s if s else 0):.1%}** | {per} | {noise_s} |")
    out.append("")
    out.append("Per round (all seeds pooled):")
    out.append("")
    n_rounds = len(rows[0]["v2"]["rounds"])
    out.append("| Round | " + " | ".join(str(i) for i in range(n_rounds)) + " |")
    out.append("| --- | " + " | ".join("---:" for _ in range(n_rounds)) + " |")
    for key, label in PIPELINES[:2]:
        cells = []
        for i in range(n_rounds):
            s = sum(r[key]["rounds"][i]["surfaced"] for r in rows)
            u = sum(r[key]["rounds"][i]["useful"] for r in rows)
            cells.append(f"{u}/{s} ({u / s:.0%})" if s else "0/0")
        out.append(f"| {label} useful/surfaced | " + " | ".join(cells) + " |")
    out.append("")
    req = {k: Counter() for k in ("v1", "v2")}
    for r in rows:
        for k in req:
            req[k].update(r[k].get("requests", {}))
    out.append("Requests made (all seeds): " + "; ".join(
        f"{k}: " + ", ".join(f"{kk} {vv}" for kk, vv in sorted(v.items())) for k, v in req.items()))
    out.append("")
    return "\n".join(out)


def main():
    parts = [summarise(Path(p)) for p in sys.argv[1:]]
    print("\n".join(parts))


if __name__ == "__main__":
    main()
