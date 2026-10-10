"""
The pivot planner: what to search next, why, and when a line of inquiry is finished.

Every round the planner looks at the sites worth pivoting from:

    reviewed USEFUL sites                         (weight 1.0)
    eligible sites not reviewed yet               (0.5 + 0.5 x probability; this is what makes
                                                   multi-hop chains possible before a person looks)
    sites Main or Hunter asked about (gap seeds)  (1.0, plus a gap bonus)

and at the indicators actually observed on them (build files, page title, favicon, hosting
IP, private name server, certificate names, name template, wallets and chat services).
Each (route, indicator) becomes a candidate action and gets an expected value:

    value = P(route yields a new eligible site)       Thompson-sampled from the route ledger
          x P(what it yields is useful)                shrunk towards neutral
          x specificity(indicator)                     popular / generic indicators score ~0
          x novelty(indicator)                         what earlier searches of it returned
          x seed weight x coverage discount            more of an operation already well
                                                       covered is worth less ("more data is
                                                       not more progress")
          / cost in requests

Actions run best-first until the per-round allowances are spent or the next action is worth
less than a floor. A search that returns nothing new cools its indicator down (1, 2, 4
rounds); three empty searches in a row, or a result set so large it is plainly generic
(shared CDN, popular library), exhaust it for good. A route whose leads keep being skipped
loses value; one whose leads are confirmed gains it (delayed credit from probes and reviews).

The planner only produces LEADS. Every lead is fetched and judged by the same probe, gate
and evidence rules as any other discovery, and nothing here writes a relationship: a shared
build file or title is a reason to look, never a claim that two sites share an operator.
"""
from __future__ import annotations

import random
import re
import time

from app.v2 import domains as dm
from app.v2 import netio, store, strategies
from app.v2.ng import fingerprints, memory, pagesearch

# route: (provider, requests per action, prior (a, b) that one action yields >=1 new eligible site)
ROUTES = {
    "page_asset":   ("page_search", 1, (2.0, 3.0)),
    "page_title":   ("page_search", 1, (2.0, 2.0)),
    "page_favicon": ("page_search", 1, (2.0, 3.0)),
    "page_ip":      ("page_search", 1, (1.0, 4.0)),
    "ct_domain":    ("crtsh", 1, (2.0, 3.0)),
    "ct_stem":      ("crtsh", 1, (1.5, 3.0)),
    "pdns_ip":      ("passive_dns", 1, (1.5, 3.0)),
    "pdns_ns":      ("passive_dns", 1, (1.5, 3.0)),
    "local_join":   ("local", 0.2, (2.0, 2.0)),
    "name_pattern": ("dns", 10, (1.0, 4.0)),
}
ALLOWANCE = {"page_search": 8, "passive_dns": 4, "dns": 30, "local": 12}
MAX_ACTIONS = 14
MAX_LEADS_PER_ACTION = 8
MAX_LEADS_PER_ROUND = 40
MAX_DEPTH = 4
GENERIC_TOTAL = 60              # a search matching more pages than this is infrastructure, not an operation
VALUE_FLOOR = 0.05          # below this a search is expected to cost more than it finds; learned routes drop under it
CDN_PREFIXES = ("104.16.", "104.17.", "104.18.", "104.19.", "104.20.", "104.21.", "104.22.", "104.23.", "104.24.",
                "104.25.", "104.26.", "104.27.", "172.64.", "172.65.", "172.66.", "172.67.", "172.68.", "172.69.",
                "188.114.", "190.93.", "162.158.", "141.101.", "108.162.", "173.245.")
GENERIC_NS = ("cloudflare", "domaincontrol", "registrar-servers", "awsdns", "googledomains", "hostinger",
              "sedoparking", "bodis", "parkingcrew", "afternic", "dan.com", "nsone", "azure-dns", "digitalocean")
SPECIFICITY = {"page_asset": 0.9, "page_title": 0.6, "page_favicon": 0.6, "page_ip": 0.35, "ct_domain": 0.55,
               "ct_stem": 0.4, "pdns_ip": 0.45, "pdns_ns": 0.55, "local_join": 0.8, "name_pattern": 0.35}
WHY = {
    "page_asset": "Search public page scans for other sites loading the same build file {v}",
    "page_title": "Search public page scans for other sites with the page title “{v}”",
    "page_favicon": "Search public page scans for other sites with the same favicon",
    "page_ip": "Search public page scans for other sites hosted on {v}",
    "ct_domain": "Search certificate logs for other names on certificates issued for {v}",
    "ct_stem": "Search certificate logs for names built on “{v}”",
    "pdns_ip": "Ask passive DNS which names have pointed at {v}",
    "pdns_ns": "Ask passive DNS which names use the private name server {v}",
    "local_join": "Re-check sites already seen that share {v}",
    "name_pattern": "Try numbered and affixed variants of {v}",
}


class Action:
    __slots__ = ("route", "value", "seed", "weight", "depth", "operation", "score", "why", "spec", "kind", "stat", "expected")

    def __init__(self, route, value, seed, weight, depth, operation, spec, kind="", stat=""):
        self.route, self.value, self.seed, self.weight = route, value, seed, weight
        self.depth, self.operation, self.spec, self.kind = depth, operation, spec, kind
        self.stat = stat or route                      # ledger bucket, e.g. page_asset+shared
        self.score, self.why, self.expected = 0.0, "", 0.0

    @property
    def key(self):
        return (self.route, self.value)


# ------------------------------------------------------------------ seeds

def _depth_of(domain: str) -> int:
    row = memory.lineage(domain)
    return int(row["depth"]) if row else 0


def seeds(threshold: float = 0.55) -> list:
    """(domain, weight, depth, operation, source) for every site worth pivoting from."""
    raw, seen = [], set()
    for s in memory.seeds():
        raw.append((s["domain"], min(1.3, float(s["weight"]) + 0.3), int(s["depth"]), s.get("operation"), "gap"))
        seen.add(s["domain"])
    for c in store.by_status("useful", limit=60, order="decided_at DESC"):
        if c["domain"] not in seen:
            raw.append((c["domain"], 1.0, None, c.get("cluster_id"), "useful"))
            seen.add(c["domain"])
    for status in ("ready", "presented", "held"):
        for c in store.by_status(status, limit=60):
            score = (c.get("details") or {}).get("score") or {}
            if c["domain"] in seen or not score.get("core") or float(c.get("p") or 0) < threshold:
                continue
            raw.append((c["domain"], 0.5 + 0.5 * float(c.get("p") or 0), None, c.get("cluster_id"), "eligible"))
            seen.add(c["domain"])
    depth = memory.depths([r[0] for r in raw if r[2] is None])
    return [(d, w, dep if dep is not None else depth.get(d, 0), op, src) for d, w, dep, op, src in raw]


def _coverage(cluster_id: str | None) -> int:
    if not cluster_id:
        return 0
    return sum(1 for m in store.cluster_members(cluster_id) if m["status"] in ("ready", "presented", "useful", "skipped"))


# ------------------------------------------------------------------ candidate actions

def _is_cdn_ip(ip: str, popularity: int | None = None) -> bool:
    pop = store.key_popularity("ip", ip) if popularity is None else popularity
    return ip.startswith(CDN_PREFIXES) or pop > 6 or bool(store.infra_label("ip", ip).get("parking"))


def _key_snapshot(domains: list) -> tuple[dict, dict]:
    """Keys of all seeds and the popularity of each of those keys, in two statements."""
    keys, pop = {d: [] for d in domains}, {}
    if not domains:
        return keys, pop
    with store.conn() as conn:
        for i in range(0, len(domains), 400):
            chunk = domains[i:i + 400]
            for r in conn.execute(f"SELECT domain,key_type,key_value FROM v2_keys WHERE domain IN ({','.join('?' * len(chunk))})", chunk):
                keys[r["domain"]].append((r["key_type"], r["key_value"]))
        wanted = sorted({kv for ks in keys.values() for kv in ks if kv[0] in ("asset", "title", "favicon", "ip", "wallet", "service", "favtmpl")})
        for i in range(0, len(wanted), 300):
            chunk = wanted[i:i + 300]
            cond = " OR ".join("(key_type=? AND key_value=?)" for _ in chunk)
            args = [x for kv in chunk for x in kv]
            for r in conn.execute(f"SELECT key_type,key_value,COUNT(*) n FROM v2_keys WHERE {cond} GROUP BY key_type,key_value", args):
                pop[(r["key_type"], r["key_value"])] = r["n"]
    return keys, pop


def candidate_actions(seed_rows: list, round_no: int) -> list:
    actions = []
    all_keys, popularity = _key_snapshot([r[0] for r in seed_rows])

    def key_popularity(kind, value):
        return popularity.get((kind, value), 0)
    pdns = bool(netio.PASSIVE_DNS_URL)
    page = pagesearch.available()
    ct = _ct_available()
    pattern_done = set(store.get_state("pattern_done", []))
    for domain, weight, depth, operation, source in seed_rows:
        if depth >= MAX_DEPTH:
            continue
        cand = store.get(domain) or {}
        keys = all_keys.get(domain, [])
        details = cand.get("details") or {}
        covered = _coverage(cand.get("cluster_id"))
        if source != "gap" and covered > 2:
            weight = weight / (1 + 0.25 * (covered - 2))

        def add(route, value, kind=""):
            if route in SPECIFICITY and value:
                spec, stat = SPECIFICITY[route], route
                if route in ("page_asset", "page_title", "page_favicon"):
                    # a build file / title / icon already seen on another site is a shared build:
                    # its search is far more likely to find siblings than a one-off file name
                    shared = key_popularity(kind, value) >= 2
                    spec, stat = (spec, route + "+shared") if shared else (spec * 0.55, route)
                actions.append(Action(route, value, domain, weight, depth, operation, spec, kind, stat))

        if ct:
            add("ct_domain", domain)
            stems = strategies.learned_stems([{"domain": domain}])
            if stems and len(stems[0]) >= 6:
                add("ct_stem", stems[0])
        if domain not in pattern_done:
            add("name_pattern", domain)
        # The build files and title of one page mostly point at the same sites: search the most
        # distinctive build files (the app bundle before a vendor script), and the title only
        # when the page exposes no build file at all.
        assets = sorted((kv for kt, kv in keys if kt == "asset" and key_popularity("asset", kv) <= 15),
                        key=lambda v: (0 if v.startswith(("app.", "index.", "main.", "bundle.")) else 1, v))
        if page:
            for kv in assets[:2]:
                add("page_asset", kv, "asset")
        for kt, kv in keys:
            if kt == "asset":
                pass
            elif kt == "title" and page and not assets and key_popularity("title", kv) <= 12 and len(kv) >= 8:
                add("page_title", kv, "title")
            elif kt == "favicon" and page and key_popularity("favicon", kv) <= 10:
                add("page_favicon", kv, "favicon")
            elif kt == "ip" and not _is_cdn_ip(kv, key_popularity("ip", kv)):
                if pdns:
                    add("pdns_ip", kv, "ip")
                elif page:
                    add("page_ip", kv, "ip")
            if kt in ("wallet", "service", "asset", "favtmpl", "title") and key_popularity(kt, kv) > 1 and \
                    any((store.get(o) or {}).get("status") == "new" for o in store.domains_with_key(kt, kv)[:20]):
                add("local_join", f"{kt}:{kv}", kt)            # only when an unprobed site shares it
        for ns in details.get("ns") or []:
            if pdns and not any(g in ns for g in GENERIC_NS):
                add("pdns_ns", ns, "nameserver")
    # one action per (route, indicator): keep the heaviest seed's copy
    best = {}
    for a in actions:
        if a.key not in best or a.weight > best[a.key].weight:
            best[a.key] = a
    return list(best.values())


def _ct_available() -> bool:
    try:
        from app.v2 import sources
        return sources.capability_available()
    except Exception:                                  # noqa: BLE001
        return False


# ------------------------------------------------------------------ scoring

def score(actions: list, round_no: int, rng: random.Random) -> list:
    stats = memory.route_stats()
    dark_set = memory.dark_watches()
    state = memory.indicators([a.key for a in actions])
    for a in actions:
        st = state.get(a.key, {})
        revisit = False
        if st.get("generic"):
            continue
        if st.get("exhausted") or (st and st.get("cooldown_until", 0) > round_no):
            # Reappearance hunt: the build or title of a site you confirmed is searched again every
            # few rounds even after it ran dry, because a taken-down kit tends to come back on a
            # new name with the same build (public scanners index it a little later).
            dark = a.seed in dark_set
            if not (a.weight >= 1.0 and a.route in ("page_asset", "page_title", "page_favicon")
                    and round_no - (st.get("last_round") or 0) >= (2 if dark else 3)):
                continue
            revisit = True
        provider, cost, (pa, pb) = ROUTES[a.route]
        s = stats.get(a.stat, {})
        attempts, productive = s.get("attempts", 0), s.get("productive", 0)
        success = rng.betavariate(pa + productive, pb + max(0.0, attempts - productive))
        useful, skipped = s.get("useful", 0), s.get("skipped", 0)
        quality = (1 + useful) / (2 + useful + skipped)
        novelty = 1.0 if not st else max(0.15, (st.get("last_new", 0) + 1) / (st.get("last_total", 0) + 2))
        if revisit:
            novelty = 0.6 if a.seed in dark_set else 0.3
        rest = (0.5 + quality) * a.spec * novelty * a.weight / max(0.2, cost) ** 0.5
        import os
        if os.environ.get("SITE_FINDER_POLICY") != "v3":
            from app.v2.discovery_v4 import branch_factor
            factor = branch_factor(st, temporal=revisit or a.seed in dark_set, round_no=round_no)
            if not factor:
                continue
            rest *= factor / max(.05, novelty)
            # Shrink stochastic exploration as observations accrue; fresh routes
            # retain exploration, repeatedly measured routes spend by marginal yield.
            mean = (pa + productive) / (pa + pb + attempts)
            success = mean + (success - mean) / (1 + attempts / 3)
        a.score = round(success * rest, 5)                      # sampled: orders the plan (exploration)
        mean = (pa + productive) / (pa + pb + attempts)
        a.expected = round(mean * rest, 5)                      # expected: decides whether it is worth running
        shown = a.value.split(":", 1)[-1] if a.route == "local_join" else a.value
        a.why = WHY[a.route].format(v=shown[:70])
    return sorted([a for a in actions if a.expected > 0], key=lambda a: -a.score)


# ------------------------------------------------------------------ execution

def _run(a: Action, budget) -> tuple[list, int, str]:
    """(names, total matches, status) for one action."""
    if a.route in ("page_asset", "page_title", "page_favicon", "page_ip"):
        kind = {"page_asset": "asset", "page_title": "title", "page_favicon": "favicon", "page_ip": "ip"}[a.route]
        return pagesearch.search(kind, a.value)
    if a.route in ("ct_domain", "ct_stem"):
        if not budget.take("crtsh"):
            return [], 0, "no_budget"
        entries = netio.crtsh(a.value if a.route == "ct_domain" else f"%{a.value}%")
        names = []
        for e in entries:
            if a.route == "ct_stem" and (netio.cert_age_days(e) or 0) > 120:
                continue
            names += strategies._names_from_cert(e)
        return names, len(entries), "healthy" if entries else "empty"
    if a.route in ("pdns_ip", "pdns_ns"):
        names = netio.passive_dns("ip" if a.route == "pdns_ip" else "ns", a.value) or []
        return names, len(names), "healthy" if names else "empty"
    if a.route == "local_join":
        kt, kv = a.value.split(":", 1)
        names = [d for d in store.domains_with_key(kt, kv)]
        return names, len(names), "healthy" if names else "empty"
    if a.route == "name_pattern":
        label, _, suffix = a.value.partition(".")
        stem = re.sub(r"\d+$", "", label)
        variants = [f"{stem}{n}.{suffix}" for n in range(2, 6)] + [f"{stem}-{x}.{suffix}" for x in ("app", "pro", "vip")] + \
                   [f"{stem}.{t}" for t in ("com", "net", "top", "xyz", "vip", "app", "cc", "live") if t != suffix]
        found = []
        for name in variants:
            if store.exists(name):
                continue
            if not budget.take("dns"):
                break
            if netio.resolve(name):
                found.append(name)
        done = set(store.get_state("pattern_done", []))
        done.add(a.value)
        store.set_state("pattern_done", sorted(done)[-500:])
        return found, len(found), "healthy" if found else "empty"
    return [], 0, "unsupported"


def _ambient_ct_rate() -> float:
    """Eligible sites per certificate query for the keyword/learned CT arms (what a query spent here displaces)."""
    stats = store.strategy_stats()
    q = sum(stats.get(k, {}).get("cost", 0) for k in ("ct_terms", "ct_learned", "ct_frontier", "cert_siblings"))
    got = sum(stats.get(k, {}).get("probed", 0) - stats.get(k, {}).get("gated", 0)
              for k in ("ct_terms", "ct_learned", "ct_frontier", "cert_siblings"))
    return (got + 1) / (q + 4)


def _route_rate(route: str) -> float:
    s = memory.route_stats().get(route, {})
    pa, pb = ROUTES[route][2]
    return (pa + s.get("productive", 0)) / (pa + pb + s.get("attempts", 0))


def liveness(budget, round_no: int, limit: int = 4) -> list:
    """Cheap change intelligence for confirmed sites: one DNS lookup every few rounds.

    A useful site that stops resolving is marked dark; its build and title then drive the
    reappearance hunt, and a later site with the same build is flagged as a possible return.
    """
    checked = store.get_state("ng_live_checked", {})
    went_dark = []
    for c in store.by_status("useful", limit=80, order="decided_at DESC"):
        d = c["domain"]
        if round_no - int(checked.get(d, -99)) < 3 or (c.get("details") or {}).get("site_status") == "dead":
            continue
        if limit <= 0 or not budget.take("dns"):
            break
        limit -= 1
        checked[d] = round_no
        if not netio.resolve(d):
            store.update(d, details={**(c.get("details") or {}), "site_status": "dead"})
            memory.mark_dark(d, f"stopped resolving (round {round_no})")
            went_dark.append(d)
    store.set_state("ng_live_checked", dict(list(checked.items())[-500:]))
    return went_dark


def execute(budget, round_no: int, rng: random.Random | None = None) -> list:
    """Plan, run the best actions within the round's allowances, and return probe leads."""
    memory.ensure()
    went_dark = liveness(budget, round_no)
    rng = rng or random.Random(f"ng:{round_no}:{store.counts().get('useful', 0)}")
    plan = score(candidate_actions(seeds(), round_no), round_no, rng)
    spent = {k: 0 for k in ALLOWANCE}
    ct_allow = max(1, budget.left("crtsh") // 2)
    # A certificate query spent on a pivot is one the keyword arms do not get: only take it
    # while pivots have been at least as productive per query.
    ambient = _ambient_ct_rate()
    ct_rate = {r: _route_rate(r) for r in ("ct_domain", "ct_stem")}
    external = memory.external_map()
    leads, done, ran = [], [], 0
    searched_seed, covered = set(), set()
    for a in plan:
        if ran >= MAX_ACTIONS or len(leads) >= MAX_LEADS_PER_ROUND:
            break
        if a.expected < VALUE_FLOOR:
            continue
        provider, cost, _ = ROUTES[a.route]
        if provider == "page_search" and (a.seed in searched_seed or a.seed in covered):
            continue                                   # one scan search per site per round; its siblings too
        if provider == "crtsh":
            if ct_allow <= 0 or ct_rate[a.route] < ambient * 0.8:
                continue
            ct_allow -= 1
        elif provider == "dns":
            if spent["dns"] + cost > ALLOWANCE["dns"]:
                continue
        elif spent.get(provider, 0) + 1 > ALLOWANCE.get(provider, 0):
            continue
        spent[provider] = spent.get(provider, 0) + (cost if provider == "dns" else 1)
        names, total, status = _run(a, budget)
        ran += 1
        if provider == "page_search":
            searched_seed.add(a.seed)
        regs = []
        for n in names:
            r = dm.registrable(n)
            if r and r not in regs and r != a.seed and not dm.is_allowlisted(r):
                regs.append(r)
        generic = total > GENERIC_TOTAL or (a.route.startswith("pdns") and len(regs) > 40)
        if provider == "page_search" and not generic:
            covered.update(regs)                       # sites in the same result set need no search of their own now
        fresh = [] if generic else [r for r in regs if not store.exists(r) and r not in external]
        if a.route == "local_join":
            # sites seen before but never probed are worth a probe now that they share a strong indicator
            fresh = [r for r in regs if (store.get(r) or {}).get("status") == "new" and r not in external]
        if status in ("healthy", "empty"):
            memory.record_search(a.route, a.value, round_no, total, len(fresh), generic)
            if provider == "page_search":
                # the seed's other page indicators describe the same build: searching them now
                # would return the same pages, so they share this search's outcome
                for kt, kv in store.keys_for(a.seed):
                    route = {"asset": "page_asset", "title": "page_title", "favicon": "page_favicon"}.get(kt)
                    if route and (route, kv) != a.key and not store.key_popularity(kt, kv) > 15:
                        memory.record_search(route, kv, round_no, total, len(fresh), False)
        memory.bump_route(a.stat, attempts=1, leads=len(fresh), cost=cost)
        take = fresh[:MAX_LEADS_PER_ACTION]
        depth = a.depth + 1
        memory.add_lineage([(r, a.seed, a.kind or a.route, a.value[:300], a.stat, depth, round_no, a.operation) for r in take])
        for r in take:
            prior = min(0.85, max(strategies.name_prior(r, 0.25), 0.3 + 0.35 * a.spec) + (0.08 if a.weight >= 1 else 0))
            leads.append(strategies.Lead(r, "ng_pivot", f"{a.why} (from {a.seed})"[:280], round(prior, 3), f"ng:{a.route}"))
        done.append({"route": a.route, "value": a.value[:120], "seed": a.seed, "score": a.score, "why": a.why,
                     "status": "generic" if generic else status, "results": total, "new": len(fresh), "leads": len(take)})
    memory.note_round(round_no, {"planned": len(plan), "ran": done, "leads": len(leads), "went_dark": went_dark,
                                 "skipped_low_value": sum(1 for a in plan if a.expected < VALUE_FLOOR)})
    store.set_state("ng_last_plan", {"round": round_no, "at": time.time(), "actions": done[:20],
                                     "next": [{"route": a.route, "value": a.value[:80], "seed": a.seed, "why": a.why,
                                               "score": a.expected} for a in plan if a.expected >= VALUE_FLOOR][ran:ran + 5]})
    return leads


# ------------------------------------------------------------------ delayed credit

def after_probe(domain: str, eligible: bool):
    row = memory.lineage(domain)
    if not row:
        return
    base = row["route"].split("+", 1)[0]
    ind = memory.indicator(base, row["via_value"])
    if eligible:
        if ind and not ind.get("eligible"):
            memory.bump_route(row["route"], productive=1)
        memory.bump_route(row["route"], eligible=1)
        memory.credit_indicator(base, row["via_value"], "eligible")
        memory.set_lineage_state(domain, "eligible")
    else:
        memory.set_lineage_state(domain, "gated")


def after_decision(domain: str, useful: bool, reason: str | None):
    row = memory.lineage(domain)
    if not row:
        return
    if useful:
        memory.bump_route(row["route"], useful=1)
        memory.credit_indicator(row["route"].split("+", 1)[0], row["via_value"], "useful")
        memory.set_lineage_state(domain, "useful")
    elif (reason or "") in ("not_a_scam", "not_crypto", "not_useful", ""):
        memory.bump_route(row["route"], skipped=1)
        memory.set_lineage_state(domain, "skipped")
    else:
        memory.set_lineage_state(domain, "skipped")
