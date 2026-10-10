"""
The discovery pursuit planner: turn one clue into a bounded investigation tree, and stop.

A HUNT is one line of inquiry with an origin people can read ("Following up on x.com, which you
marked useful", "Looking for new deployments of Operation O-7", "Watching for x.com to
reappear", "Exploring for site families not seen yet"). A BRANCH is one pivot inside a hunt:
an artifact observed on a seed site (a build file, a title, an icon, an API or chat host, a
private name server, a server address, the domain name itself) and the route used to search
for it (public page scans, passive DNS, certificate logs, name variants, sites already seen).

Every round:

  1. hunts are woken or created from what happened (sites marked useful, requests from Main
     or Operation Hunter, artifacts from site investigations, sites going dark, sites Main
     already holds, and eligible sites nobody has pursued yet);
  2. every open branch gets an expected information gain:

        EIG = P(new eligible site | route, artifact tier)     decayed ledger, Thompson-sampled to order,
                                                              its mean used to decide
            x P(useful | eligible, route, tier)               incl. delayed downstream value
            x specificity(tier)                               operator > variant > deployment > family > generic(0)
            x novelty (what earlier searches of it returned)  cached results are re-used for free
            x hunt weight x momentum x 0.9^depth              promising hunts get more budget
            + uncertainty bonus                                untried route classes are tried
            / sqrt(cost)

  3. the round's allowance is split between hunts by momentum, with a fixed share reserved for
     exploration (branches rooted in site families nobody has reviewed yet), and branches run
     best-first until the allowance or the value floor is reached;
  4. results become probe leads with their lineage (hunt, branch, parent, artifact, depth);
  5. when a lead is probed: an eligible site opens child branches from its own artifacts
     (depth + 1, up to MAX_DEPTH), a non-scam page counts against the branch (junk), and
     reviews and downstream outcomes credit the branch, route and hunt later;
  6. stop rules: a branch whose searches return nothing twice cools down, then is exhausted;
     one that returns a generic result set or keeps returning junk is dead; a hunt with no new
     eligible site for PATIENCE rounds and nothing worth searching is parked with a plain
     reason, and exhausted after it is parked twice. New evidence wakes it.

The planner only produces LEADS: every lead goes through the same probe, gates and evidence
rules as any other discovery. Nothing here writes a relationship.
"""
from __future__ import annotations

import math
import random
import re
import time

from app.v2 import domains as dm
from app.v2 import netio, store, strategies
from app.v2.ng import memory, pagesearch
from app.v2.pursuit import artifacts, ledger

# route: (provider, cost in requests, prior (a, b) that one action yields >= 1 new eligible site)
ROUTES = {
    "page_asset":   ("page_search", 1, (2.0, 3.0)),
    "page_title":   ("page_search", 1, (1.5, 3.0)),
    "page_favicon": ("page_search", 1, (2.0, 3.0)),
    "page_host":    ("page_search", 1, (2.0, 3.0)),
    "page_ip":      ("page_search", 1, (1.0, 4.0)),
    "page_term":    ("page_search", 1, (1.0, 4.0)),   # exploration: recent scans whose title uses scam vocabulary
    "pdns_ip":      ("passive_dns", 1, (1.5, 3.0)),
    "pdns_ns":      ("passive_dns", 1, (1.5, 3.0)),
    "ct_domain":    ("crtsh", 1, (1.5, 3.0)),
    "ct_stem":      ("crtsh", 1, (1.0, 3.0)),
    "name_pattern": ("dns", 12, (1.0, 4.0)),
    "linked_site":  ("local", 0.1, (2.0, 2.0)),
    "local_join":   ("local", 0.2, (2.0, 2.0)),
}
PAGE_KIND = {"page_asset": "asset", "page_title": "title", "page_favicon": "favicon", "page_host": "host", "page_ip": "ip",
             "page_term": "title"}
# Title vocabulary of investment, trading, mining and recovery scams. Searched as page titles in public
# scans (newest first), these reach sites of families nobody has reviewed yet, even with certificate
# search down. Result sets are large by design: they are sampled, never followed wholesale.
EXPLORE_PHRASES = ["Earn Daily", "Cloud Mining", "Crypto Recovery", "Quant Trading", "USDT Mining", "Staking Rewards",
                   "Arbitrage", "Invest Platform", "Buy & Sell Crypto", "Crypto Exchange", "Mining Pool", "Daily Profit",
                   "AI Trading", "Wealth Management", "Liquidity Mining", "Asset Recovery"]
TERM_SAMPLE = 3
WATCH_EVERY = 3                    # rounds between re-searches of a confirmed operation's own identifiers
WATCH_MAX = 4
ALLOWANCE = {"page_search": 10, "passive_dns": 5, "dns": 36, "local": 16}
EXPLORE_SHARE = 0.2               # of page-search and DNS allowances, reserved for unknown families
MAX_ACTIONS = 18
MAX_LEADS_PER_ACTION = 8
MAX_LEADS_PER_ROUND = 48
MAX_DEPTH = 5
MAX_ACTIVE_HUNTS = 40
PATIENCE = 3                      # rounds without a new eligible site before a hunt may be parked
GENERIC_TOTAL = 60
VALUE_FLOOR = 0.05
ANCHORS_PER_ROUND = 6             # sites Main already holds, fetched once to learn their artifacts
TIER_SPEC = {"operator": 1.0, "variant": 0.8, "deployment": 0.45, "family": 0.45, "generic": 0.0}
KIND_PRIORITY = {"campaign": 1.3, "investigation": 1.2, "clue": 1.0, "reappearance": 0.9, "wave": 1.1,
                 "explore": 0.8, "lead": 0.7, "anchor": 0.9}
CDN_PREFIXES = ("104.16.", "104.17.", "104.18.", "104.19.", "104.20.", "104.21.", "104.22.", "104.23.", "104.24.",
                "104.25.", "104.26.", "104.27.", "172.64.", "172.65.", "172.66.", "172.67.", "172.68.", "172.69.",
                "188.114.", "190.93.", "162.158.", "141.101.", "108.162.", "173.245.")
GENERIC_NS = ("cloudflare", "domaincontrol", "registrar-servers", "awsdns", "googledomains", "hostinger",
              "sedoparking", "bodis", "parkingcrew", "afternic", "dan.com", "nsone", "azure-dns", "digitalocean")

WHY = {
    "page_asset": "public page scans loading the same build file {v}",
    "page_title": "public page scans with the page title “{v}”",
    "page_favicon": "public page scans showing the same site icon",
    "page_host": "public page scans of sites that talk to {v}",
    "page_ip": "public page scans of sites on the server {v}",
    "page_term": "recent public page scans titled “{v}”",
    "pdns_ip": "passive DNS: other names that pointed at {v}",
    "pdns_ns": "passive DNS: other names using the private name server {v}",
    "ct_domain": "certificate logs: other names on certificates for {v}",
    "ct_stem": "certificate logs: names built on “{v}”",
    "name_pattern": "name variants of {v}",
    "linked_site": "{v} is named in the site's own code",
    "local_join": "sites already seen that share {v}",
}


# ======================================================================= hunts

def _hunt_title(kind: str, subject: str, extra: str = "") -> str:
    return {
        "clue": f"Following up on {subject}",
        "campaign": f"Looking for new deployments related to {subject}",
        "investigation": f"Following artifacts from the investigation of {subject}",
        "reappearance": f"Watching for the {subject} site family to reappear",
        "wave": f"Exploring a newly discovered pattern: {subject}",
        "explore": "Exploring for site families not seen yet",
        "lead": f"Following up on {subject} (not reviewed yet)",
        "anchor": f"Looking around {subject}, which Main already holds",
    }.get(kind, subject) + (f" — {extra}" if extra else "")


def start_hunt(kind: str, subject: str, round_no: int, origin: dict | None = None, operation: str | None = None,
               priority: float | None = None, seeds: list | None = None, artifacts_: list | None = None,
               hunt_id: str | None = None, extra: str = "") -> dict:
    """Creates or wakes a hunt and gives it branches from its seed sites and artifacts."""
    ledger.ensure()
    hid = hunt_id or f"{kind}:{subject}"[:160]
    h, created = ledger.upsert_hunt(hid, kind, _hunt_title(kind, subject, extra), origin or {}, round_no,
                                     priority if priority is not None else KIND_PRIORITY.get(kind, 1.0), operation)
    rows = []
    for d in seeds or []:
        rows += branches_for_site(hid, d, depth=0, round_no=round_no, weight=1.0)
    for a in artifacts_ or []:
        rows += branches_for_artifact(hid, a.get("seed") or subject, a["kind"], a["value"], depth=0,
                                      round_no=round_no, weight=1.0)
    ledger.add_branches(rows)
    return h


def branches_for_artifact(hunt_id: str, seed: str, kind: str, value: str, depth: int, round_no: int,
                          weight: float, parent: int | None = None) -> list:
    kind, value = (kind or "").lower(), str(value or "").strip()
    if not value:
        return []
    out = []

    def add(route, v, why_kind=None):
        out.append({"hunt_id": hunt_id, "parent": parent, "seed": seed, "kind": why_kind or kind, "value": v,
                    "route": route, "depth": depth, "weight": weight, "round": round_no,
                    "why": WHY[route].format(v=v[:70])})
    page = pagesearch.available() if pagesearch.endpoint() else False
    pdns = bool(netio.PASSIVE_DNS_URL)
    if kind in ("asset", "kitfile") and page:
        value = value.rsplit("/", 1)[-1].split("?", 1)[0]
        if value:
            add("page_asset", value)
    elif kind == "title" and page and len(value) >= 6:
        add("page_title", value)
    elif kind == "favicon" and page:
        add("page_favicon", value)
    elif kind in ("apihost", "service", "linked", "host") and "." in value and ":" not in value:
        host = dm.registrable(value)
        if host:
            if page:
                add("page_host", host, "host" if kind == "host" else kind)
            if kind == "linked":
                add("linked_site", host)
            add("local_join", f"{kind}:{value}")
    elif kind == "ip" and value and not value.startswith(CDN_PREFIXES) and (pdns or page):
        add("pdns_ip" if pdns else "page_ip", value)
    elif kind in ("ns", "nameserver") and pdns and not any(g in value for g in GENERIC_NS):
        add("pdns_ns", value, "ns")
    elif kind == "domain":
        reg = dm.registrable(value)
        if reg:
            add("ct_domain", reg)
            stems = strategies.learned_stems([{"domain": reg}])
            if stems and len(stems[0]) >= 6:
                add("ct_stem", stems[0])
            add("name_pattern", reg)
    elif kind in ("wallet", "analytics", "contact", "dom", "flow", "service", "favtmpl"):
        add("local_join", f"{kind}:{value}")
    return out


def branches_for_site(hunt_id: str, domain: str, depth: int, round_no: int, weight: float,
                      parent: int | None = None, keys: list | None = None) -> list:
    """Every pivot a probed site offers. An unprobed site offers its domain name only (probe first)."""
    domain = dm.registrable(domain) or domain
    cand = store.get(domain) or {}
    details = cand.get("details") or {}
    if keys is None:
        keys = list(dict.fromkeys(store.keys_for(domain) + ledger.artifacts_of([domain]).get(domain, [])))
    out = branches_for_artifact(hunt_id, domain, "domain", domain, depth, round_no, weight * 0.8, parent)
    assets = sorted((v for k, v in keys if k == "asset"),
                    key=lambda v: (0 if v.startswith(("app.", "index.", "main.", "bundle.")) else 1, v))[:2]
    for v in assets:
        out += branches_for_artifact(hunt_id, domain, "asset", v, depth, round_no, weight, parent)
    for k, v in keys:
        if k == "asset":
            continue
        if k in ("title", "kitfile", "favicon", "apihost", "service", "linked", "wallet", "analytics", "contact", "dom", "flow"):
            out += branches_for_artifact(hunt_id, domain, k, v, depth, round_no, weight, parent)
    if details.get("ip"):
        out += branches_for_artifact(hunt_id, domain, "ip", details["ip"], depth, round_no, weight * 0.7, parent)
    for ns in details.get("ns") or []:
        out += branches_for_artifact(hunt_id, domain, "ns", ns, depth, round_no, weight * 0.8, parent)
    return out


# ======================================================================= hunt intake each round

def intake(round_no: int) -> dict:
    """Creates/wakes hunts from what happened since the last round. Cheap: a few statements."""
    made = {"clue": 0, "lead": 0, "anchor_leads": []}
    active = {h["id"] for h in ledger.hunts(("active", "parked", "exhausted"), limit=2000)}
    nodes = {}
    # sites you marked useful: their own hunt (unless a hunt already found them: then it is credited there)
    useful = store.by_status("useful", limit=60, order="decided_at DESC")
    nodes = ledger.nodes([c["domain"] for c in useful])
    for c in useful:
        hid = f"clue:{c['domain']}"
        if hid in active:
            continue
        n = nodes.get(c["domain"])
        if n and n["hunt_id"] in active:
            # the site belongs to a hunt: it deepens that hunt instead of starting a new one
            ledger.add_branches(branches_for_site(n["hunt_id"], c["domain"], int(n["depth"]), round_no, 1.0))
            ledger.wake(n["hunt_id"], round_no)                                  # wakes it if parked
            active.add(hid)
            continue
        start_hunt("clue", c["domain"], round_no, origin={"site": c["domain"], "why": "marked useful"},
                   seeds=[c["domain"]], hunt_id=hid)
        active.add(hid)
        made["clue"] += 1
    # eligible sites nobody is pursuing yet (found by keyword/feed arms): a lower-priority hunt each
    eligible = []
    for status in ("ready", "presented", "held"):
        for c in store.by_status(status, limit=60):
            sc = (c.get("details") or {}).get("score") or {}
            if sc.get("core") and float(c.get("p") or 0) >= 0.5:
                eligible.append(c)
    en = ledger.nodes([c["domain"] for c in eligible])
    for c in eligible[:40]:
        if made["lead"] >= 5:
            break                                          # a few new lines of inquiry per round, best first
        if c["domain"] in en or f"lead:{c['domain']}" in active or memory.external(c["domain"]):
            continue
        start_hunt("lead", c["domain"], round_no, origin={"site": c["domain"], "why": "eligible, not reviewed yet"},
                   seeds=[c["domain"]], hunt_id=f"lead:{c['domain']}",
                   priority=KIND_PRIORITY["lead"] * (0.6 + 0.4 * float(c.get("p") or 0)))
        active.add(f"lead:{c['domain']}")
        made["lead"] += 1
    # exploration: one standing hunt for site families nobody has reviewed yet
    if "explore" not in active:
        start_hunt("explore", "new site families", round_no, origin={"why": "reserved exploration budget"}, hunt_id="explore")
        active.add("explore")
    if pagesearch.endpoint() and pagesearch.available():
        ledger.add_branches([{"hunt_id": "explore", "seed": "", "kind": "term", "value": v, "route": "page_term", "depth": 0,
                              "weight": 0.8, "round": round_no, "why": WHY["page_term"].format(v=v)}
                             for v in EXPLORE_PHRASES + _title_templates()])
    # sites Main already holds: fetch a few once so their artifacts can be pursued (never delivered)
    probed_anchor = set(store.get_state("pu_anchor_done", []))
    for d, row in list(memory.external_map().items()):
        if len(made["anchor_leads"]) >= ANCHORS_PER_ROUND:
            break
        if d in probed_anchor:
            continue
        if store.exists(d):
            probed_anchor.add(d)
            if f"anchor:{d}" not in active and (store.get(d) or {}).get("status") not in ("gated", "new"):
                start_hunt("anchor", d, round_no, origin={"site": d, "why": f"held by {row.get('source') or 'Main'}"},
                           seeds=[d], hunt_id=f"anchor:{d}")
                active.add(f"anchor:{d}")
            continue
        made["anchor_leads"].append(strategies.Lead(d, "pu_anchor", f"held by {row.get('source') or 'Main'}: "
                                                                     f"fetched once to learn its public artifacts", 0.5, "pu_anchor"))
        probed_anchor.add(d)
    store.set_state("pu_anchor_done", sorted(probed_anchor)[-3000:])
    return made


def _title_templates() -> list:
    """Title templates of confirmed sites with the brand removed ("X | Earn Daily" -> "Earn Daily"):
    other brands on the same template are other deployments of the same kind of kit."""
    out = []
    with store.conn() as conn:
        rows = conn.execute("SELECT DISTINCT a.value FROM pu_artifacts a JOIN v2_candidates c ON c.domain=a.domain "
                            "WHERE a.kind='title' AND c.status IN ('useful','ready','presented') LIMIT 60").fetchall()
    for (t,) in rows:
        parts = re.split(r"\s*[|\-–·:]\s*", t, maxsplit=1)
        rest = parts[1] if len(parts) == 2 else " ".join(t.split()[1:])
        rest = rest.strip()
        if 6 <= len(rest) <= 40 and len(rest.split()) >= 2 and rest.lower() not in ("log in", "sign in"):
            out.append(rest.title())
    return list(dict.fromkeys(out))[:20]


# ======================================================================= scoring

def _known_families() -> set:
    """Kit signatures (dom/flow) of sites you reviewed as useful or that Main/Hunter hold."""
    with store.conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT a.value FROM pu_artifacts a LEFT JOIN v2_candidates c ON c.domain=a.domain "
            "LEFT JOIN ng_external x ON x.domain=a.domain WHERE a.kind IN ('dom','flow') "
            "AND (c.status IN ('useful','skipped','ready','presented') OR x.domain IS NOT NULL)").fetchall()
    return {r[0] for r in rows}


def _family_of(domains: list) -> dict:
    fams = {}
    for d, arts in ledger.artifacts_of(domains).items():
        fams[d] = {v for k, v in arts if k in ("dom", "flow")}
    return fams


def score(branches: list, hunts: dict, round_no: int, rng: random.Random) -> list:
    if not branches:
        return []
    led = ledger.route_ledger()
    pairs = []
    for b in branches:
        k = _artifact_key(b)
        if k:
            pairs.append(k)
    tstats = ledger.tier_stats(pairs)
    state = memory.indicators([(b["route"], b["value"]) for b in branches])
    known_fams = _known_families()
    fams = _family_of(list({b["seed"] for b in branches}))
    out = []
    for b in branches:
        h = hunts.get(b["hunt_id"])
        if not h:
            continue
        k = _artifact_key(b)
        t = artifacts.tier(k[0], tstats.get(k, {})) if k else "deployment"
        if b["route"] in ("ct_domain", "ct_stem", "name_pattern"):
            t = "deployment"
        elif b["route"] == "page_term":
            t = "family"
        if t == "generic":
            ledger.update_branch(b["id"], state="dead", why=(b["why"] + " · generic technology, not searched")[:300])
            continue
        st = state.get((b["route"], b["value"]), {})
        if st.get("generic"):
            ledger.update_branch(b["id"], state="dead")
            continue
        provider, cost, (pa, pb) = ROUTES[b["route"]]
        r = led.get((b["route"], t), {})
        attempts, productive = float(r.get("attempts", 0)), float(r.get("productive", 0))
        success = rng.betavariate(pa + productive, pb + max(0.0, attempts - productive))
        mean = (pa + productive) / (pa + pb + attempts)
        useful, skipped, junk, value = (float(r.get(x, 0)) for x in ("useful", "skipped", "junk", "value"))
        quality = (1 + useful + max(0.0, value)) / (2 + useful + skipped + junk + max(0.0, -value))
        spec = TIER_SPEC[t]
        if t == "family" and h["kind"] in ("campaign", "explore", "wave", "reappearance"):
            spec = 0.75                                  # a kit family is what a campaign/explore hunt is after
        novelty = 1.0 if not st else max(0.15, (st.get("last_new", 0) + 1) / (st.get("last_total", 0) + 2))
        if b["route"] == "page_term":
            novelty = 1.0 if not st else max(0.2, (st.get("last_new", 0) + 1) / (TERM_SAMPLE + 1))
        momentum = (1 + h["eligible"] + 0.5 * h["useful"]) / (1 + h["eligible"] + 0.5 * h["useful"] +
                                                             0.35 * max(0, round_no - h["last_progress_round"]))
        weight = float(h["priority"]) * max(0.25, momentum) * float(b["weight"]) * (0.9 ** int(b["depth"]))
        explore = h["kind"] == "explore" or bool(fams.get(b["seed"]) and not (fams[b["seed"]] & known_fams))
        bonus = 0.12 / math.sqrt(1 + attempts)          # untried route classes are worth a look
        rest = (0.5 + quality) * spec * novelty * weight / max(0.2, cost) ** 0.5
        b["tier"], b["explore"] = t, explore
        b["score"] = round(success * rest + bonus * spec, 5)
        b["expected"] = round(mean * rest + 0.5 * bonus * spec, 5)
        out.append(b)
    return sorted(out, key=lambda b: -b["score"])


def _artifact_key(b: dict):
    if b["route"] == "local_join":
        kind, _, value = b["value"].partition(":")
        return (kind, value)
    if b["route"] == "page_term":
        return None
    kind = PAGE_KIND.get(b["route"])
    if kind == "host":
        return (b["kind"] if b["kind"] in ("apihost", "service", "linked") else "apihost", b["value"])
    if kind:
        return (kind, b["value"])
    if b["route"] in ("pdns_ip",):
        return ("ip", b["value"])
    if b["route"] == "linked_site":
        return ("linked", b["value"])
    return None


# ======================================================================= execution

def _run(b: dict, budget) -> tuple[list, int, str, bool]:
    """(names, total, status, paid) for one branch. Cached results are re-used without a request."""
    route, value = b["route"], b["value"]
    hit = ledger.cached(route, value)
    if hit and route not in ("name_pattern", "page_term"):
        # never pay twice for the same search: re-query only on a branch's own revisit, only when the
        # cached answer is a few rounds old, and never more than WATCH_MAX times in total
        stale = hit["round"] < b.get("_round", 0) - WATCH_EVERY + 1
        spent = int((memory.indicator(route, value) or {}).get("searches") or 0)
        if not (b.get("attempts") and stale and spent <= WATCH_MAX):
            return hit["names"], hit["total"], hit["status"], False
    if route in PAGE_KIND:
        kind = PAGE_KIND[route]
        names, total, status = pagesearch.search(kind, value)
        return names, total, status, True
    if route in ("ct_domain", "ct_stem"):
        if not budget.take("crtsh"):
            return [], 0, "no_budget", False
        entries = netio.crtsh(value if route == "ct_domain" else f"%{value}%")
        names = []
        for e in entries:
            if route == "ct_stem" and (netio.cert_age_days(e) or 0) > 120:
                continue
            names += strategies._names_from_cert(e)
        return names, len(entries), "healthy" if entries else "empty", True
    if route in ("pdns_ip", "pdns_ns"):
        names = netio.passive_dns("ip" if route == "pdns_ip" else "ns", value) or []
        return names, len(names), "healthy" if names else "empty", True
    if route == "local_join":
        kind, _, v = value.partition(":")
        names = list(dict.fromkeys(ledger.artifact_domains(kind, v) + store.domains_with_key(kind, v)))
        return names, len(names), "healthy" if names else "empty", False
    if route == "linked_site":
        return [value], 1, "healthy", False
    if route == "name_pattern":
        if _stem(value) in _farm_stems():
            return [], 0, "empty", False                 # variants of a mirror-farm name are more copies
        return _name_variants(value, budget), 0, "healthy", True
    return [], 0, "unsupported", False


def _name_variants(domain: str, budget) -> list:
    """Numbered, affixed and TLD variants of a name, plus the stems of the same operation's other names."""
    label, _, suffix = domain.partition(".")
    stem = re.sub(r"\d+$", "", label)
    stem = re.sub(r"^(my|go|the|get)", "", stem) or stem
    variants = [f"{stem}{n}.{suffix}" for n in (1, 2, 3, 5, 8, 24, 88)] + \
               [f"{stem}-{x}.{suffix}" for x in ("app", "pro", "vip", "global")] + \
               [f"{p}{stem}.{suffix}" for p in ("my", "go")] + \
               [f"{stem}.{t}" for t in ("com", "net", "top", "xyz", "vip", "app", "cc", "live", "io", "pro", "shop", "club")
                if t != suffix]
    found = []
    for name in variants:
        if name == domain or store.exists(name):
            continue
        if not budget.take("dns"):
            break
        if netio.resolve(name):
            found.append(name)
    return found


def execute(budget, round_no: int, rng: random.Random | None = None) -> list:
    """Plan, run the best branches within the round's allowance, and return probe leads."""
    ledger.ensure()
    rng = rng or random.Random(f"pu:{round_no}:{store.counts().get('useful', 0)}")
    made = intake(round_no)
    hunts = {h["id"]: h for h in ledger.hunts(("active",), limit=MAX_ACTIVE_HUNTS * 3)}
    # the most promising hunts only (momentum x priority); the rest wait their turn
    ranked = sorted(hunts.values(), key=lambda h: -float(h["priority"]) * (1 + h["eligible"]) /
                    (1 + 0.3 * max(0, round_no - h["last_progress_round"])))[:MAX_ACTIVE_HUNTS]
    hunts = {h["id"]: h for h in ranked}
    plan = score(ledger.open_branches(round_no, list(hunts)), hunts, round_no, rng)
    # Idle probe capacity last round means leads, not probes, were the bottleneck: search a little
    # more widely this round (more actions, lower floor, larger samples). Bounded at 1.8x.
    last = store.get_state("last_round", {}) or {}
    idle = 0.0
    if last.get("probed") is not None:
        cap_http = float(((last.get("budget") or {}).get("limits") or {}).get("http") or 60)
        idle = max(0.0, 1.0 - float(last.get("probed") or 0) / max(1.0, cap_http))
    widen = round(1.0 + 0.8 * idle, 2)
    external = memory.external_map()
    leads = list(made["anchor_leads"])
    spent = {k: 0.0 for k in ALLOWANCE}
    allowance = {k: v * (widen if k in ("page_search", "passive_dns") else 1.0) for k, v in ALLOWANCE.items()}
    max_actions = int(MAX_ACTIONS * widen)
    floor = VALUE_FLOOR / widen
    explore_allow = {k: max(1, int(round(v * EXPLORE_SHARE))) for k, v in ALLOWANCE.items() if k in ("page_search", "dns")}
    ct_allow = max(0, budget.left("crtsh") // 2)
    per_hunt: dict = {}
    hunt_cap = max(3, MAX_ACTIONS // max(1, min(len(hunts), 6)))
    done, seen_actions, claimed = [], set(), set()
    state = {"ran": 0, "ct_allow": ct_allow}

    def run_pass(branches, limits):
        for b in branches:
            if state["ran"] >= max_actions or len(leads) >= MAX_LEADS_PER_ROUND * widen:
                return
            if b["id"] in seen_actions or b["expected"] < floor:
                continue
            provider, cost, _ = ROUTES[b["route"]]
            hit = ledger.cached(b["route"], b["value"]) if provider not in ("local", "dns") and b["route"] != "page_term" else None
            free = provider == "local" or bool(hit and not (b.get("attempts") and hit["round"] < round_no - WATCH_EVERY + 1
                                                             and int((memory.indicator(b["route"], b["value"]) or {}).get("searches") or 0) <= WATCH_MAX))
            if not free:
                if per_hunt.get(b["hunt_id"], 0) >= hunt_cap:
                    continue
                if provider == "crtsh":
                    if state["ct_allow"] <= 0 or not _ct_available():
                        continue
                    state["ct_allow"] -= 1
                elif spent.get(provider, 0) + cost > limits.get(provider, 0):
                    continue
                spent[provider] = spent.get(provider, 0) + cost
                per_hunt[b["hunt_id"]] = per_hunt.get(b["hunt_id"], 0) + 1
            seen_actions.add(b["id"])
            b["_round"] = round_no
            names, total, status, paid = _run(b, budget)
            if paid:
                state["ran"] += 1
            got = _consume(b, names, total, status, paid, round_no, external, hunts, done, widen, claimed)
            claimed.update(x.domain for x in got)
            leads.extend(got)

    # the exploration reserve first (branches rooted in site families nobody has reviewed), then all by value
    reserve = {k: (explore_allow.get(k, 0) if k in explore_allow else ALLOWANCE[k]) for k in ALLOWANCE}
    run_pass([b for b in plan if b.get("explore")], reserve)
    run_pass(plan, allowance)
    # stop rules: park hunts that stopped producing, with a reason
    _stop_rules(round_no, hunts)
    memory.note_round(round_no, {"pursuit": done[:30], "leads": len(leads), "hunts": len(hunts)})
    store.set_state("pu_last_plan", {"round": round_no, "at": time.time(), "actions": done[:25], "hunts": len(hunts), "widen": widen,
                                     "next": [{"route": b["route"], "value": b["value"][:80], "seed": b["seed"], "why": b["why"],
                                               "expected": b["expected"]} for b in plan if b["id"] not in seen_actions][:6]})
    return leads


def _explore_pending(order: list, provider: str, done_ids: set) -> bool:
    return any(b.get("explore") and b["id"] not in done_ids and ROUTES[b["route"]][0] == provider
               and b["expected"] >= VALUE_FLOOR for b in order[:60])


def _ct_available() -> bool:
    try:
        from app.v2 import sources
        return sources.capability_available()
    except Exception:                                  # noqa: BLE001
        return False


def _consume(b, names, total, status, paid, round_no, external, hunts, done, widen: float = 1.0, claimed: set | None = None) -> list:
    claimed = claimed if claimed is not None else set()
    regs = []
    for n in names:
        r = dm.registrable(n)
        if r and r not in regs and r != b["seed"] and not dm.is_allowlisted(r):
            regs.append(r)
    term = b["route"] == "page_term"
    generic = not term and (total > GENERIC_TOTAL or (b["route"].startswith("pdns") and len(regs) > 40))
    fresh = [] if generic else [r for r in regs if not store.exists(r) and r not in external and r not in claimed]
    if term:
        fresh = _diverse(fresh, int(round(TERM_SAMPLE * widen)))   # a sample of the newest, never the whole set
    known_hits = sum(1 for r in regs if r in external)
    if b["route"] == "local_join":
        fresh = [r for r in regs if (store.get(r) or {}).get("status") == "new" and r not in external and r not in claimed]
    t = b.get("tier") or "deployment"
    if paid and status in ("healthy", "empty"):
        ledger.cache(b["route"], b["value"], round_no, total, regs if not generic else [], "generic" if generic else status)
        memory.record_search(b["route"], b["value"], round_no, total, len(fresh), generic)
    if paid:
        ledger.bump_route(b["route"], t, round_no, attempts=1)
    h = hunts.get(b["hunt_id"]) or {}
    farms = _farm_stems()
    if farms:
        # memory: names on the stem of a known mirror farm are copies until shown otherwise
        fresh = [r for r in fresh if _stem(r) not in farms] + [r for r in fresh if _stem(r) in farms][:1]
    take = _diverse(fresh, MAX_LEADS_PER_ACTION)
    key = _artifact_key(b)
    if key and take and _copies(key) >= 3:
        take = take[:1]                                  # a mirror farm: one more look, not eight more probes
    if generic:
        state, nxt = "dead", round_no
    else:
        # one search per branch; what it found is followed through the leads it produced
        state, nxt = ("done" if take else "exhausted"), round_no
    if h.get("kind") == "reappearance" and not generic:
        # a reappearance watch keeps looking, less and less often (3, 6, 12 rounds), then stops
        attempts = int(b["attempts"]) + 1
        state, nxt = ("cooling", round_no + 3 * 2 ** min(attempts - 1, 2)) if attempts < WATCH_MAX + 1 and t != "family" \
            else ("exhausted", round_no)                 # a kit-family file says nothing about this operation's return
    elif term and not generic:
        # a phrase that brought nothing new rests longer before the next look at the newest scans
        state, nxt = ("cooling", round_no + (3 if take else 6)) if int(b["attempts"]) < 6 else ("exhausted", round_no)
    elif (not generic and b["route"] in PAGE_KIND and t == "operator"
          and int(b["attempts"]) + 1 < WATCH_MAX and _confirmed(b["seed"])):
        # the identifiers of a confirmed operation are re-searched every few rounds: new deployments
        # that reuse its chat, API host or build appear in public scans later
        state, nxt = "cooling", round_no + WATCH_EVERY
    ledger.update_branch(b["id"], attempts=1, results=len(regs), new=len(take), state=state, next_round=nxt,
                         last_round=round_no, tier=t)
    ledger.bump_hunt(b["hunt_id"], actions=1 if paid else 0, spent=ROUTES[b["route"]][1] if paid else 0,
                     leads=len(take), last_active_round=round_no)
    depth = int(b["depth"]) + 1
    rows = [(r, b["hunt_id"], b["id"], b["seed"], b["kind"], b["value"][:300], b["route"], depth, round_no) for r in take]
    ledger.add_nodes(rows)
    memory.add_lineage([(r, b["seed"], b["kind"], b["value"][:300], f"pu:{b['route']}", depth, round_no, h.get("operation"))
                        for r in take])
    leads = []
    spec = TIER_SPEC.get(t, 0.5)
    for r in take:
        prior = min(0.85, max(strategies.name_prior(r, 0.25), 0.3 + 0.35 * spec) + (0.08 if h.get("kind") in ("clue", "campaign", "investigation") else 0))
        leads.append(strategies.Lead(r, "ng_pivot", f"{h.get('title', '')}: {b['why']}"[:280], round(prior, 3), f"pu:{b['route']}"))
    done.append({"hunt": b["hunt_id"], "route": b["route"], "value": b["value"][:120], "seed": b["seed"], "tier": t,
                 "why": b["why"], "status": "generic" if generic else status, "results": total, "known": known_hits,
                 "new": len(take), "paid": paid, "expected": b.get("expected")})
    return leads


def _confirmed(domain: str) -> bool:
    c = store.get(domain) or {}
    return c.get("status") == "useful" or bool(memory.external(domain))


def _copies(key) -> int:
    with store.conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM pu_artifacts WHERE kind=? AND value=? AND class='mirror'", key).fetchone()[0]


def _stem(name: str) -> str:
    return re.sub(r"[\d-]+$", "", name.split(".")[0])[:8]


def _farm_stems() -> set:
    """Name stems with three or more probed copies (mirror farms)."""
    with store.conn() as conn:
        rows = conn.execute("SELECT DISTINCT domain FROM pu_artifacts WHERE class='mirror' LIMIT 2000").fetchall()
    count: dict = {}
    for (d,) in rows:
        count[_stem(d)] = count.get(_stem(d), 0) + 1
    return {k for k, v in count.items() if v >= 3}


def _diverse(names: list, limit: int) -> list:
    """At most two names per stem first (copies tend to share a stem), then the rest."""
    first, rest, per = [], [], {}
    for n in names:
        stem = _stem(n)
        if per.get(stem, 0) < 2:
            per[stem] = per.get(stem, 0) + 1
            first.append(n)
        else:
            rest.append(n)
    return (first + rest)[:limit]


def _stop_rules(round_no: int, hunts: dict):
    # hunts that never got a turn (others were more promising) wait parked instead of piling up
    ranked_out = [h for h in ledger.hunts(("active",), limit=5000) if h["id"] not in hunts and h["kind"] != "explore"]
    for h in ranked_out:
        ledger.set_hunt_state(h["id"], "parked", "Waiting: other hunts were more promising. It gets another turn later.", count=False)
    counts = ledger.branch_counts(list(hunts))
    for hid, h in hunts.items():
        c = counts.get(hid, {})
        open_n = c.get("open", 0) + c.get("cooling", 0)
        idle = round_no - int(h["last_progress_round"])
        if h["kind"] == "explore":
            continue
        if h["kind"] == "reappearance":
            if idle >= 10:
                ledger.set_hunt_state(hid, "exhausted", f"No sign of a return in {idle} rounds of watching.")
            continue
        if open_n == 0 and idle >= 1:
            found = int(h["eligible"])
            reason = (f"Every pivot has been followed ({sum(c.values())} searched); nothing new came back."
                      if not found else f"Every pivot has been followed; it found {found} site{'s' if found != 1 else ''}.")
            ledger.set_hunt_state(hid, "exhausted", reason)
        elif idle >= PATIENCE and (h["actions"] or 0) >= 2:
            if int(h["parked_times"]) >= 1:
                ledger.set_hunt_state(hid, "exhausted", f"Parked twice: no new site in {idle} rounds.")
            else:
                ledger.set_hunt_state(hid, "parked", f"No new site in {idle} rounds; {open_n} pivots left. "
                                                     "It wakes up if new evidence arrives.")


def wake_parked(round_no: int):
    """Parked hunts get another turn after a while, as long as there is room among the active ones."""
    room = MAX_ACTIVE_HUNTS - len(ledger.hunts(("active",), limit=MAX_ACTIVE_HUNTS + 1))
    for h in ledger.hunts(("parked",), limit=200):
        if room <= 0:
            break
        if round_no - int(h["last_active_round"]) >= 6:
            ledger.wake(h["id"], round_no)
            room -= 1


# ======================================================================= feedback

def after_probe(domain: str, eligible: bool, keys: list, klass: str, round_no: int, weak: bool = False):
    """A pursued lead was probed: grow the tree from it, or count it against its branch."""
    if domain not in ledger.lead_domains():
        return                                           # not a pursuit lead (or already probed): nothing to grow
    n = ledger.node(domain)
    if not n:
        return
    b_id = n["branch_id"]
    hid = n["hunt_id"]
    with store.conn() as conn:
        br = conn.execute("SELECT * FROM pu_branches WHERE id=?", (b_id,)).fetchone()
    tier = (br["tier"] if br else "") or "deployment"
    route = n["route"]
    if eligible or weak:
        ledger.set_node_state(domain, "eligible" if eligible else "weak")
        if eligible:
            ledger.update_branch(b_id, eligible=1)
            ledger.bump_hunt(hid, eligible=1, last_progress_round=round_no)
            ledger.bump_route(route, tier, round_no, productive=1, eligible=1)
            memory.credit_indicator(route, n["value"], "eligible")
        ledger.wake(hid, round_no)                                 # new evidence wakes a parked hunt
        depth = int(n["depth"])
        if depth < MAX_DEPTH:
            ledger.add_branches(branches_for_site(hid, domain, depth, round_no, 1.0 if eligible else 0.5,
                                                  parent=b_id, keys=keys))
    else:
        ledger.set_node_state(domain, "gated")
        if klass in ("nonscam", "mirror"):
            ledger.update_branch(b_id, junk=1)
            ledger.bump_route(route, tier, round_no, junk=1)
            if br and int(br["junk"]) + 1 >= 3 and int(br["eligible"]) <= int(br["junk"]) // 3:
                what = "copies of sites already seen" if klass == "mirror" else "non-scam pages"
                ledger.update_branch(b_id, state="dead", why=(br["why"] + f" · keeps returning {what}")[:300])


def seed_probed(domain: str, keys: list, round_no: int):
    """A hunt's seed site (a request from Main/Hunter, a site Main holds) has just been fetched:
    its artifacts become the hunt's first real pivots."""
    if domain not in ledger.seed_domains():
        return
    with store.conn() as conn:
        hids = [r[0] for r in conn.execute("SELECT DISTINCT hunt_id FROM pu_branches WHERE seed=? AND depth=0", (domain,))]
    for hid in hids:
        ledger.add_branches(branches_for_site(hid, domain, 0, round_no, 1.0, keys=keys))
        ledger.wake(hid, round_no)


def after_decision(domain: str, useful: bool, reason: str | None, round_no: int):
    n = ledger.node(domain)
    if not n:
        return
    with store.conn() as conn:
        br = conn.execute("SELECT tier FROM pu_branches WHERE id=?", (n["branch_id"],)).fetchone()
    tier = (br["tier"] if br else "") or "deployment"
    if useful:
        ledger.update_branch(n["branch_id"], useful=1)
        ledger.bump_hunt(n["hunt_id"], useful=1, last_progress_round=round_no)
        ledger.bump_route(n["route"], tier, round_no, useful=1)
        ledger.set_node_state(domain, "useful")
    else:
        ledger.set_node_state(domain, "skipped")
        if (reason or "") in ("not_a_scam", "not_crypto", "not_useful", ""):
            ledger.bump_route(n["route"], tier, round_no, skipped=1)


OUTCOME_VALUE = {"wallet_evidence": 1.0, "investigation_completed": 0.4, "meaningful_evidence": 0.6,
                 "low_evidence": -0.5, "dead_site": -0.3, "duplicate": -0.2}


def after_outcome(domain: str, outcome: str, round_no: int):
    """Delayed value: what the investigation of a pursued site eventually produced (bounded, shrunk)."""
    n = ledger.node(domain)
    w = OUTCOME_VALUE.get(outcome, 0.0)
    if not n or not w:
        return
    with store.conn() as conn:
        br = conn.execute("SELECT tier FROM pu_branches WHERE id=?", (n["branch_id"],)).fetchone()
    tier = (br["tier"] if br else "") or "deployment"
    ledger.bump_hunt(n["hunt_id"], value=w)
    ledger.bump_route(n["route"], tier, round_no, value=0.5 * w)       # shrunk: one outcome never dominates
