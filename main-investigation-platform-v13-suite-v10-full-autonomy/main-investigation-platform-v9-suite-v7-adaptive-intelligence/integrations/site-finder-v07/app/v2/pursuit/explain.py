"""
"How did you find this site?" — a short, evidence-backed path from the original clue to the site,
in plain words, plus the uncertainty that goes with it.

Each step names the site it started from, the public artifact that was followed and where it
was searched. Steps are observations and searches; the last line always says what the path does
NOT show (shared kits, hosting and scripts are similarities, not proof of the same operator).
"""
from __future__ import annotations

from app.v2.pursuit import ledger

KIND_WORDS = {
    "asset": "loads the build file", "title": "has the page title", "favicon": "shows the site icon",
    "apihost": "talks to the API host", "service": "uses the support chat at", "linked": "names",
    "host": "talks to", "ip": "is hosted on", "ns": "uses the private name server", "domain": "has the name",
    "wallet": "shows the wallet", "analytics": "carries the analytics id", "contact": "lists the contact",
    "dom": "has the same page structure", "flow": "has the same sign-up form", "favtmpl": "has the same icon and layout",
}
ROUTE_WORDS = {
    "page_asset": "a public page-scan search for that file", "page_title": "a public page-scan search for that title",
    "page_favicon": "a public page-scan search for that icon", "page_host": "a public page-scan search for sites using that host",
    "page_ip": "a public page-scan search for that server", "pdns_ip": "passive DNS for that address",
    "pdns_ns": "passive DNS for that name server", "ct_domain": "certificate logs", "ct_stem": "certificate logs for the name",
    "name_pattern": "trying variants of the name", "linked_site": "checking that domain directly",
    "local_join": "sites Site Finder had already seen",
}
ORIGIN_WORDS = {"clue": "you marked {s} useful", "campaign": "Main asked for more sites like {s}",
                "investigation": "the investigation of {s} returned public artifacts",
                "reappearance": "{s} went dark", "wave": "a burst of new sites appeared", "anchor": "Main already held {s}",
                "lead": "{s} looked like a scam", "explore": "Site Finder was exploring for new site families"}
CAVEAT = ("Every step is a public observation or search. Shared kits, hosting, scripts and chat services show a "
          "similarity; they do not prove the same people run these sites.")


def _value(kind: str, value: str) -> str:
    if kind == "favicon":
        return ""
    if kind in ("dom", "flow"):
        return ""
    return f" {value[:60]}" if value else ""


def chain(domain: str, limit: int = 6) -> list:
    """Steps from the clue to `domain`, oldest first."""
    steps, cur, seen = [], domain, set()
    while cur and cur not in seen and len(steps) < limit:
        seen.add(cur)
        n = ledger.node(cur)
        if not n:
            break
        steps.append({"site": cur, "from": n["parent"], "kind": n["kind"], "value": n["value"], "route": n["route"],
                      "depth": n["depth"], "hunt": n["hunt_id"]})
        cur = n["parent"]
    return list(reversed(steps))


def explain(domain: str) -> dict:
    steps = chain(domain)
    if not steps:
        return {}
    hunt = ledger.hunt(steps[0]["hunt"]) or {}
    origin = ORIGIN_WORDS.get(hunt.get("kind", ""), "a clue").format(s=steps[0]["from"] or "a site")
    art = (hunt.get("origin") or {}).get("artifact")
    if hunt.get("kind") == "wave" and isinstance(art, list) and len(art) == 2:
        what = KIND_WORDS.get(art[0], art[0]).replace("loads ", "").replace("has ", "").replace("talks to ", "")
        origin = f"a burst of new sites appeared sharing {what}{_value(art[0], str(art[1]))}"
    elif hunt.get("kind") == "campaign":
        who = "Operation Hunter" if (hunt.get("origin") or {}).get("source") == "hunter" else "Main"
        origin = f"{who} asked for more sites like those of {hunt.get('title', '').replace('Looking for new deployments related to ', '')}"
    lines = []
    for s in steps:
        how = KIND_WORDS.get(s["kind"], s["kind"])
        where = ROUTE_WORDS.get(s["route"], s["route"])
        lines.append(f"{s['from']} {how}{_value(s['kind'], s['value'])}; {where} led to {s['site']}.")
    hops = len(steps)
    uncertainty = "direct" if hops == 1 else f"{hops} pivots away from the clue"
    return {"because": f"Found this because {origin}.", "steps": lines, "hops": hops, "hunt": hunt.get("title", ""),
            "hunt_id": hunt.get("id"), "uncertainty": f"{uncertainty}; each step is a similarity, not an identity.",
            "caveat": CAVEAT}
