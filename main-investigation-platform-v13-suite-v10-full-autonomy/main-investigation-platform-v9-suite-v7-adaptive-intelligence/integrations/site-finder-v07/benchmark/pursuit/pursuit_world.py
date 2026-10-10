"""
PursuitWorld: an adversarial simulated internet for Site Finder discovery.

Written independently of the engine being tested: only the simulation substrate
(benchmark.world / benchmark.simnet) and the engine's public entry points were
consulted. Import this module only after the chosen engine tree is first on
sys.path (the runner does that), because it subclasses that tree's World.

The world is deterministic in (seed, scenario, difficulty). It contains:

  * scam-kit FAMILIES (page template, kit bundle, default favicon, title
    template) that can be copied by several unrelated OPERATIONS;
  * OPERATIONS (operators) with their own infrastructure, wallets, support
    chat host, API backend, analytics id, build file and naming waves;
  * SITES belonging to an operation, each exposing a subset of the
    operation's artifacts in public HTML, script bundles, favicon, DNS and
    certificates;
  * hard structure: deep pivot chains, migrations (die and return elsewhere),
    naming mutation, mirror floods, copied kits, CDN-hidden hosting, DNS
    pivots that only lead to junk, certificate-search outages, a
    high-yield search field that collapses mid-run, unknown families;
  * ordinary noise inherited from the substrate (parked, dead, legit crypto,
    informational, non-crypto, vendor demos).

Ground truth for every scam-related domain lives in `world.gt[domain]`; the
minimum number of public pivots needed to reach each site from the starting
knowledge is computed from the world's own pivot graph (`min_pivots`).
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from collections import defaultdict, deque
from urllib.parse import parse_qs, unquote

from benchmark.world import (BRANDS, RENDERERS, Domain, World, btc_address, evm_address,  # noqa: F401
                             tron_address)

# --------------------------------------------------------------------------- knobs

BASE = dict(
    cdn_share=0.70,            # share of operation sites behind a big shared CDN
    crt="flaky",               # ok | flaky | down
    crt_fail=0.25,             # flaky failure rate
    families=4,                # known families (at least one member Main knows about)
    unknown_families=1,        # families nobody has seen (no seed, known site or gap request)
    ops=8,                     # operations in known families
    copy=2,                    # target operations per known family (copied kits when > 1)
    sites_per_op=(3, 6),
    known_ops=0.5,             # share of operations Main already tracks
    obvious_known=0.75,        # share of "obvious" (explore-reachable) sites Main learns by itself
    chain_ops=2, chain_len=(2, 4),
    migrate_ops=2,
    mutation=True,             # operations change naming stems / TLDs between waves
    collapse=[("filename", 5)],  # (strategy, round): a high-yield route stops working
    mirrors=[150],             # mirror cluster sizes (hundreds of identical clones)
    dns_junk=25,               # junk names parked on the old dedicated IPs of known operations
    scan_cov=0.70,             # share of sites present in the page-search index
    hollow=0.15,               # useful-looking sites whose investigation yields nothing
    noise_scale=0.6,
)

SCENARIOS = {
    "mixed": {},
    "cert_blackout": dict(crt="down", cdn_share=0.80, collapse=[("feed", 4)]),
    "cdn_maze": dict(cdn_share=0.92, chain_ops=4, chain_len=(3, 5), dns_junk=40),
    "copycat": dict(families=3, copy=4, ops=10, chain_ops=1),
    "migration": dict(migrate_ops=5, collapse=[("favicon", 4)]),
    "mirror_flood": dict(mirrors=[350, 220], obvious_known=0.9),
    "collapse": dict(collapse=[("filename", 3), ("feed", 3), ("crt", 5)]),
    "dark_family": dict(unknown_families=3, known_ops=0.35, obvious_known=0.85),
}

DIFFICULTY = ("normal", "hard", "brutal")

JQUERY = ["jquery-3.6.0.min.js", "jquery-3.7.1.min.js", "jquery-3.5.1.min.js", "jquery.min.js"]
GENERIC_FILES = JQUERY + [ "app.js", "main.js", "index.js", "vendor.js", "bundle.min.js",
                 "chunk-vendors.js", "runtime.js", "polyfills.js"]
ENTRY_KW = ["invest", "exchange", "mining", "trade", "wallet", "earn", "profit", "usdt", "stake", "yield"]
SYL_A = ["orbi", "kairo", "helio", "astra", "lumo", "zeni", "vanta", "corvi", "nexa", "quilo", "marle",
         "sorin", "talvo", "prax", "dexo", "ferro", "ilyo", "brava", "cyra", "doma", "elvo", "fyra", "gano",
         "hexa", "jorvo", "kesta", "lyra", "movi", "nuvo", "opra", "pelo", "riva", "sela", "tavi", "ulmo"]
SYL_B = ["ra", "vo", "lix", "ton", "dia", "sto", "men", "qua", "rel", "nor", "via", "pex", "ska", "dor", "lin"]
OP_TLDS = [".vip", ".top", ".cc", ".live", ".pro", ".app", ".club", ".shop", ".icu", ".cfd", ".com", ".net",
           ".xyz", ".io", ".co", ".org", ".bond", ".sbs", ".homes", ".lat"]
FAMILY_CLASSES = ["pig_shell", "fake_exchange", "hyip", "cloud_mining", "pig_shell", "fake_exchange", "recovery_scam"]
TITLE_TPL = {
    "pig_shell": ["{B}", "{B} Global", "{B} - Login"],
    "fake_exchange": ["{B} | Buy & Sell Crypto", "{B} Exchange"],
    "hyip": ["{B} | Earn Daily", "{B} AI - Smart Crypto Earnings"],
    "cloud_mining": ["{B} Cloud Mining"],
    "recovery_scam": ["{B} Crypto Recovery Experts"],
}
BASE_VALUE = {"pig_shell": 3.0, "fake_exchange": 3.0, "hyip": 2.0, "cloud_mining": 2.0, "recovery_scam": 1.5}
SEARCH_KINDS = ("title", "favicon", "kit", "build", "support", "api", "analytics")
GENERIC_LIMIT = 150        # an artifact matching more sites than this is not a usable pivot
PAGE_CAP = 100


def _h(*parts) -> str:
    return hashlib.sha256(":".join(str(p) for p in parts).encode()).hexdigest()


def resolve_config(scenario: str, difficulty: str) -> dict:
    cfg = dict(BASE)
    cfg.update(SCENARIOS[scenario])
    cfg["mirrors"] = list(cfg["mirrors"])
    lo, hi = cfg["chain_len"]
    if difficulty == "normal":
        cfg["cdn_share"] = max(0.3, cfg["cdn_share"] - 0.15)
        cfg["obvious_known"] = max(0.3, cfg["obvious_known"] - 0.2)
        cfg["mirrors"] = [max(20, m // 2) for m in cfg["mirrors"]]
        cfg["chain_len"] = (max(2, lo - 1), max(2, hi - 1))
        cfg["scan_cov"] = min(0.9, cfg["scan_cov"] + 0.1)
        cfg["hollow"] = 0.08
    elif difficulty == "brutal":
        cfg["cdn_share"] = min(0.97, cfg["cdn_share"] + 0.07)
        cfg["obvious_known"] = min(0.95, cfg["obvious_known"] + 0.1)
        cfg["mirrors"] = [int(m * 1.5) for m in cfg["mirrors"]]
        cfg["chain_len"] = (min(5, lo + 1), min(5, hi + 1))
        cfg["scan_cov"] = max(0.4, cfg["scan_cov"] - 0.15)
        cfg["hollow"] = 0.22
        cfg["chain_ops"] += 1
    return cfg


# --------------------------------------------------------------------------- world

class PursuitWorld(World):
    def __init__(self, seed: int = 1, scenario: str = "mixed", difficulty: str = "hard", rounds: int = 10):
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario}")
        self.scenario, self.difficulty = scenario, difficulty
        self.cfg = resolve_config(scenario, difficulty)
        self.prng = random.Random(f"pursuit:{seed}:{scenario}:{difficulty}")
        self.total_rounds = rounds
        self.gt: dict[str, dict] = {}                # scam-related domains -> ground truth
        self.families: dict[str, dict] = {}
        self.ops: dict[str, dict] = {}
        self.specs: list[dict] = []                  # every planned scam site (born later or now)
        self.main_known: dict[str, int] = {}         # domain -> round Main learns it
        self.feed_plan: dict[int, list] = defaultdict(list)
        self.gap_plan: dict[int, dict] = {}
        self.index: dict[tuple, list] = defaultdict(list)   # (field, value) -> [(domain, round)]
        self.backends: dict[str, str] = {}           # support/api host -> op
        self.log: list[dict] = []                    # every request the engine made (for work metrics)
        self.exposed: set[str] = set()               # registrable domains the engine has been shown
        self.query_seen: set[str] = set()
        self._crt_counter = 0
        self._planned = False
        super().__init__(seed=seed, split="eval", rounds=rounds, scale=self.cfg["noise_scale"])

    # ================================================================ build
    def _build_static(self):
        super()._build_static()
        # Brand typosquats are background: defensively owned, never counted as targets.
        for d in list(self.domains.values()):
            if d.useful:
                official = BRANDS.get(d.brand, "binance.com")
                d.cls, d.useful, d.redirect_to, d.kit, d.wallets = "brand_owned_redirect", False, f"https://www.{official}/", "", ()
        self._kits.clear()

    def _births(self, rnd: int, backlog: bool = False):
        if not self._planned:
            self._plan()
            self._planned = True
        self._noise(rnd, backlog)
        for spec in self.specs:
            if spec["born"] == rnd:
                self._materialise(spec)
        for name in self.feed_plan.get(rnd, ()):
            url = f"https://{name}/"
            if name in self.domains and url not in self.feed:
                self.feed.append(url)

    # ---------------------------------------------------------------- noise
    def _noise(self, rnd: int, backlog: bool):
        s = self.scale * (3.0 if backlog else 1.0)
        plan = {"parked": 45, "for_sale": 10, "dead": 35, "placeholder": 25, "suspended": 5, "coming_soon": 8,
                "legit_crypto": 8, "informational": 6, "non_crypto": 45, "generic": 20, "script_demo": 2,
                "pr_article": 2, "parked_unknown": 6}
        order = []
        for cls, n in plan.items():
            order += [cls] * int(round(n * s * self.rng.uniform(0.7, 1.3)))
        self.rng.shuffle(order)
        known = [d for d, r in self.main_known.items() if r <= rnd and d in self.domains] or ["novayield.vip"]
        for cls in order:
            d = self._negative(rnd, cls)
            d.transitions = {k: v for k, v in d.transitions.items() if "activate" not in v}
            if cls in ("informational", "pr_article"):
                # Reviews / monitors / PR only talk about sites Main already knows.
                d.subject = self.rng.choice(known)
                t = self.domains.get(d.subject)
                d.wallets = t.wallets[:1] if (t and d.notes == "review") else ()
                if d.extra_links:
                    d.extra_links = tuple(self.rng.sample(known, min(6, len(known))))
            if cls == "script_demo" and self.families:
                fam = self.families[self.rng.choice(sorted(self.families))]
                self.gt[d.name] = {"kind": "demo", "family": fam["id"], "op": None, "useful": False}
                self._demo_art(d, fam)

    def _demo_art(self, d: Domain, fam: dict):
        """Vendor demo of a kit: carries the kit bundle and default favicon, is not a scam."""
        d.favicon = fam["favicon"]
        art = {"kit": fam["kit"], "favicon": hashlib.sha256(fam["favicon"]).hexdigest(),
               "title": f"{fam['brand']} Demo — White-label Script"}
        self.gt[d.name]["art"] = art
        self._index_site(d.name, art, d.ip, self.round, scanned=True)

    # ---------------------------------------------------------------- plan
    def _stem(self) -> str:
        while True:
            s = self.prng.choice(SYL_A) + self.prng.choice(SYL_B)
            if s not in self._stems:
                self._stems.add(s)
                return s

    def _plan(self):
        cfg, r = self.cfg, self.prng
        R = self.total_rounds
        self._stems = set()
        # ---------------- families
        n_known_fam, n_unknown = cfg["families"], cfg["unknown_families"]
        for i in range(n_known_fam + n_unknown):
            cls = FAMILY_CLASSES[(i + r.randint(0, 6)) % len(FAMILY_CLASSES)]
            fid = f"F{i}"
            fingerprint = r.random() < 0.6
            fam = {"id": fid, "cls": cls, "variant": r.choice((0, 1, 2, 3)), "unknown": i >= n_known_fam,
                   "kit": f"chunk-vendors.{_h(self.seed, fid)[:8]}.js" if fingerprint else r.choice(GENERIC_FILES[len(JQUERY):]),
                   "fingerprint": fingerprint, "favicon": hashlib.sha256(f"fam{self.seed}{fid}".encode()).digest() * 2,
                   "title_tpl": r.choice(TITLE_TPL[cls]), "brand": self._stem().capitalize()}
            self.families[fid] = fam
        known_fams = [f for f in self.families.values() if not f["unknown"]]
        unknown_fams = [f for f in self.families.values() if f["unknown"]]
        # ---------------- operations
        op_fams = []
        for f in known_fams:
            op_fams += [f] * max(1, cfg["copy"])
        r.shuffle(op_fams)
        op_fams = op_fams[: max(cfg["ops"], len(known_fams))]
        for f in known_fams:                       # every known family keeps at least one op
            if f not in op_fams:
                op_fams.append(f)
        for f in unknown_fams:
            op_fams += [f] * r.choice((1, 2))
        n_known_ops = max(2, int(round(cfg["known_ops"] * sum(1 for f in op_fams if not f["unknown"]))))
        k = 0
        for j, fam in enumerate(op_fams):
            op = self._new_op(f"O{j}", fam)
            if not fam["unknown"] and k < n_known_ops:
                op["known"] = True
                k += 1
            self.ops[op["id"]] = op
        # ---------------- sites
        for op in self.ops.values():
            n = r.randint(*cfg["sites_per_op"]) + (2 if op["known"] else 0)
            for i in range(n):
                born = 0 if (i < max(1, n // 3) or r.random() < 0.2) else r.randint(1, R - 2)
                self._spec(op, born, role="member", first=(i == 0))
        # the known ops keep old dedicated infra that only hosts known sites + junk
        self._chains()
        self._migrations()
        self._mirrors()
        self._entries_and_knowledge()
        self._gaps()
        self._pivot_distances()

    def _new_op(self, oid: str, fam: dict) -> dict:
        r, cfg = self.prng, self.cfg
        R = self.total_rounds
        starts = [0]
        if cfg["mutation"]:
            pool = list(range(2, max(3, R - 1)))
            starts += sorted(r.sample(pool, min(2, len(pool))))
        waves = []
        for i, start in enumerate(starts):
            stem = self._stem()
            w = {"start": start, "stem": stem, "tlds": r.sample(OP_TLDS, 3), "brand": stem.capitalize(),
                 "build": f"index-{int(_h(self.seed, oid, 'build', i)[:8], 16) % 10**8:08d}.js",
                 "favicon": hashlib.sha256(f"op{self.seed}{oid}{i}".encode()).digest() * 2,
                 "support": f"{r.choice(['kefu', 'chat', 'service', 'help', 'cs', 'online'])}{r.randint(10, 999)}.{r.choice(['com', 'net', 'top', 'cc'])}",
                 "api": f"api.gw-{_h(self.seed, oid, 'api', i)[:5]}.{r.choice(['net', 'com', 'xyz'])}",
                 "analytics": f"G-{_h(self.seed, oid, 'ga', i)[:8].upper()}", "bridge": None}
            if waves:                                  # consecutive waves share exactly one artifact kind
                w["bridge"] = r.choice(["support", "analytics", "api", "favicon"])
                w[w["bridge"]] = waves[-1][w["bridge"]]
            waves.append(w)
        dedicated_ips = [f"45.{r.randint(8, 250)}.{r.randint(1, 250)}.{r.randint(1, 250)}" for _ in range(2)]
        op = {"id": oid, "family": fam["id"], "cls": fam["cls"], "known": False, "brand": waves[0]["brand"],
              "waves": waves, "cdn_share": cfg["cdn_share"],
              "old_ip": dedicated_ips[0], "new_ip": dedicated_ips[1],
              "old_ns": (f"ns1.{self._stem()}dns.net", f"ns2.{self._stem()}dns.net"),
              "wallets": [w for w in (self._wallet(r) for _ in range(r.randint(3, 6)))],
              "sites": []}
        for k in ("support", "api", "analytics", "build", "favicon"):
            op[k] = waves[0][k]
        for w in waves:
            for host in (w["support"], w["api"].split(".", 1)[1]):
                self.backends[host] = oid
        return op

    @staticmethod
    def _wallet(r):
        x = r.random()
        if x < 0.6:
            return ("USDT-TRC20", tron_address(r))
        if x < 0.8:
            return ("BTC", btc_address(r))
        return ("USDT-ERC20", evm_address(r))

    def _wave(self, op, rnd):
        w = op["waves"][0]
        for wave in op["waves"]:
            if wave["start"] <= rnd:
                w = wave
        return w

    def _name(self, base: str, tld: str) -> str:
        name, n = f"{base}{tld}", 2
        taken = {s["name"] for s in self.specs}
        while name in taken or name in self.domains:
            name = f"{base}{n}{tld}"
            n += 1
        return name

    def _spec(self, op: dict, born: int, role: str, first: bool = False, **over) -> dict:
        r, cfg = self.prng, self.cfg
        fam = self.families[op["family"]]
        wave = self._wave(op, born)
        stem, tlds = wave["stem"], wave["tlds"]
        roll = r.random()
        if over.get("stemless") or roll < 0.25:
            base, stem_used = self._stem() + r.choice(["", "", "x", "pro"]), None
        else:
            idx = sum(1 for s in op["sites"] if s.get("stem") == stem) + 1
            base = r.choice([f"{stem}{idx}", f"{stem}-{r.choice(['app', 'pro', 'vip', 'global', 'h5'])}",
                             f"{stem}{r.choice(['x', 'ex', 'fx'])}", stem])
            stem_used = stem
        name = self._name(base, r.choice(tlds))
        # hosting: known ops moved; old dedicated infra only carries the Main-known sites
        cdn = r.random() < cfg["cdn_share"]
        if cdn:
            ip, ns, hosting = None, None, "cdn"
        elif op["known"] and born == 0 and first:
            ip, ns, hosting = op["old_ip"], op["old_ns"], "old"
        else:
            ip, ns, hosting = op["new_ip"], (f"ns1.{op['id'].lower()}{_h(self.seed, op['id'])[:4]}.net", f"ns2.{op['id'].lower()}{_h(self.seed, op['id'])[:4]}.net"), "dedicated"
        favroll = r.random()
        collapse_fav = self._collapse_round("favicon")
        if collapse_fav is not None and born >= collapse_fav:
            favroll = 1.0                                         # operator now randomises favicons
        bridge = wave["bridge"]
        if bridge == "favicon" and r.random() > 0.35:
            favroll = max(favroll, 0.55)
        fav = wave["favicon"] if favroll < 0.55 else fam["favicon"] if favroll < 0.8 else _h("u", name).encode()[:32] * 2
        art = {"kit": fam["kit"],
               "title": fam["title_tpl"].format(B=wave["brand"]) if r.random() < 0.7 else fam["title_tpl"].format(B=self._stem().capitalize()),
               "build": wave["build"] if r.random() < 0.45 else f"index-{int(_h(name, 'b')[:8], 16) % 10**8:08d}.js"}
        for k, p_ in (("support", 0.6), ("api", 0.4), ("analytics", 0.35)):
            if k == bridge:
                p_ = 0.35                      # only some sites of a new wave still carry the old artifact
            if r.random() < p_:
                art[k] = wave[k]
        wallets = tuple(r.sample(op["wallets"], r.choice((1, 1, 2))))
        spec = {"name": name, "op": op["id"], "family": fam["id"], "cls": fam["cls"], "variant": fam["variant"],
                "born": born, "dies": None, "role": role, "stem": stem_used, "hosting": hosting, "ip": ip, "ns": ns,
                "fav": fav, "art": art, "wallets": wallets, "backup": [], "sans": [],
                "scanned": r.random() < cfg["scan_cov"], "hollow": r.random() < cfg["hollow"],
                "mirror_of": None, "returned_from": None, "entry": None, "feed_round": None}
        spec.update({k: v for k, v in over.items() if k != "stemless"})
        if hosting == "dedicated" and op["sites"] and r.random() < 0.2:
            spec["sans"] = [s["name"] for s in r.sample(op["sites"], min(2, len(op["sites"])))
                            if s["hosting"] == "dedicated" and s["born"] <= born]
        op["sites"].append(spec)
        self.specs.append(spec)
        return spec

    def _collapse_round(self, what):
        for kind, rnd in self.cfg["collapse"]:
            if kind == what:
                return rnd
        return None

    def _chains(self):
        """Deep pivots: each hop shares exactly one artifact with the previous hop and nothing else."""
        r, cfg = self.prng, self.cfg
        candidates = [o for o in self.ops.values() if not self.families[o["family"]]["unknown"]]
        r.shuffle(candidates)
        kinds = ["build", "support", "analytics", "favicon", "backup", "api", "title"]
        for op in candidates[: cfg["chain_ops"]]:
            anchor = next((s for s in op["sites"] if s["born"] == 0), op["sites"][0])
            anchor["role"] = "chain_anchor"
            prev = anchor
            length = r.randint(*cfg["chain_len"])
            start = r.randint(0, len(kinds) - 1)
            for hop in range(length):
                born = min(self.total_rounds - 2, prev["born"] + r.choice((0, 0, 1)))
                s = self._spec(op, born, role=f"chain{hop + 1}", stemless=True)
                # scrub every operation-level artifact, then share exactly one with prev
                s["art"] = {"kit": f"vendor.{_h(s['name'], 'k')[:6]}.js",
                            "title": f"{self._stem().capitalize()} {r.choice(['Global', 'Pro', 'Trade', 'Asset'])}",
                            "build": f"index-{int(_h(s['name'], 'b')[:8], 16) % 10**8:08d}.js",
                            "support": f"cs{_h(s['name'], 's')[:5]}.{r.choice(['top', 'net'])}"}
                s["fav"] = _h("chain", s["name"]).encode()[:32] * 2
                s["hosting"], s["ip"], s["ns"], s["sans"] = "cdn", None, None, []
                s["wallets"] = (self._wallet(r),)          # new evidence: fresh wallet
                s["scanned"] = True
                s["hollow"] = False
                kind = kinds[(start + hop) % len(kinds)]
                if kind == "backup":
                    prev["backup"].append(s["name"])
                elif kind == "favicon":
                    s["fav"] = prev["fav"]
                elif kind == "api":
                    host = prev["art"].get("api") or f"api.gw-{_h(prev['name'], 'a')[:5]}.net"
                    prev["art"]["api"] = s["art"]["api"] = host
                    self.backends[host.split(".", 1)[1]] = op["id"]
                elif kind == "analytics":
                    ga = prev["art"].get("analytics") or f"G-{_h(prev['name'], 'g')[:8].upper()}"
                    prev["art"]["analytics"] = s["art"]["analytics"] = ga
                else:
                    if kind == "support" and not prev["art"].get("support"):
                        prev["art"]["support"] = f"cs{_h(prev['name'], 's')[:5]}.top"
                    s["art"][kind] = prev["art"][kind]
                    if kind == "support":
                        self.backends[s["art"]["support"]] = op["id"]
                s["link_kind"] = kind
                prev = s

    def _migrations(self):
        r, cfg = self.prng, self.cfg
        R = self.total_rounds
        known = [o for o in self.ops.values() if o["known"]]
        r.shuffle(known)
        for op in known[: cfg["migrate_ops"]]:
            live = [s for s in op["sites"] if s["born"] == 0 and s["role"] == "member"]
            for old in live[: r.randint(1, 3)]:
                die = r.randint(2, max(2, R - 4))
                old["dies"] = die
                back = die + r.choice((1, 2))
                if back >= R:
                    continue
                new = self._spec(op, back, role="returned", returned_from=old["name"], stemless=r.random() < 0.4)
                # carried over: support host, some wallets, maybe analytics and title; changed: favicon, build, IP, name
                new["art"]["support"] = old["art"].get("support") or op["support"]
                if r.random() < 0.5 and "analytics" in old["art"]:
                    new["art"]["analytics"] = old["art"]["analytics"]
                else:
                    new["art"].pop("analytics", None)
                if r.random() < 0.5:
                    new["art"]["title"] = old["art"]["title"]
                new["fav"] = _h("mig", new["name"]).encode()[:32] * 2
                new["art"]["build"] = f"index-{int(_h(new['name'], 'b')[:8], 16) % 10**8:08d}.js"
                new["wallets"] = tuple(old["wallets"][:1]) + (self._wallet(r),)
                new["hosting"], new["ip"], new["ns"] = "cdn", None, None
                new["scanned"] = r.random() < 0.8

    def _mirrors(self):
        r = self.prng
        R = self.total_rounds
        fams = [f for f in self.families.values() if not f["unknown"]]
        for ci, size in enumerate(self.cfg["mirrors"]):
            fam = r.choice(fams)
            op = self._new_op(f"M{ci}", fam)
            op["known"] = ci % 2 == 1               # every second flood belongs to a site Main already has
            op["mirror"] = True
            self.ops[op["id"]] = op
            primary = self._spec(op, 0, role="mirror_primary", first=True)
            primary["hosting"], primary["ip"], primary["ns"] = "dedicated", op["new_ip"], op["old_ns"]
            primary["art"].update(support=op["support"], build=op["build"])
            primary["fav"] = op["favicon"]
            stem = op["waves"][0]["stem"]
            for i in range(size):
                born = 0 if r.random() < 0.4 else r.randint(1, R - 1)
                name = self._name(f"{stem}{i + 2}", r.choice(OP_TLDS))
                m = dict(primary, name=name, born=born, role="mirror", mirror_of=primary["name"], stem=stem,
                         ip=r.choice([op["new_ip"], op["old_ip"]]), scanned=r.random() < 0.6, hollow=False,
                         art=dict(primary["art"]), backup=[], sans=[], entry=None, feed_round=None)
                op["sites"].append(m)
                self.specs.append(m)

    def _entries_and_knowledge(self):
        """Exploration entry points (keyword names, feed reports) and what Main already knows."""
        r, cfg = self.prng, self.cfg
        R = self.total_rounds
        crt_ever = cfg["crt"] != "down"
        feed_stop = self._collapse_round("feed")
        for op in self.ops.values():
            fam = self.families[op["family"]]
            members = [s for s in op["sites"] if s["role"] in ("member", "mirror_primary", "chain_anchor")]
            # one or two "obvious" sites per operation: keyword name or community report
            for s in r.sample(members, min(len(members), r.choice((1, 1, 2)))):
                kw = r.choice(ENTRY_KW)
                if crt_ever and r.random() < 0.6:
                    self._rename(s, self._name(f"{kw}{s['stem'] or self._stem()}" if r.random() < .5 else f"{s['stem'] or self._stem()}{kw}",
                                           r.choice(OP_TLDS)))
                    s["entry"] = "keyword"
                else:
                    fr = min(R - 1, s["born"] + r.choice((0, 1)))
                    if feed_stop is not None and fr >= feed_stop:
                        fr = max(0, feed_stop - 1) if s["born"] < feed_stop else None
                    if fr is not None:
                        s["entry"], s["feed_round"] = "feed", fr
                        self.feed_plan[fr].append(s["name"])
            # Main's knowledge: the tracked operations' first sites, and most obvious sites (a round late)
            if op["known"]:
                for s in op["sites"]:
                    if s["role"] in ("member", "chain_anchor", "mirror_primary") and s["born"] == 0 and \
                            (s["hosting"] == "old" or r.random() < 0.5 or s["role"] == "chain_anchor"):
                        self.main_known[s["name"]] = 0
                if not any(self.main_known.get(s["name"]) == 0 for s in op["sites"]):
                    self.main_known[op["sites"][0]["name"]] = 0
            if not fam["unknown"]:
                for s in op["sites"]:
                    if s["entry"] and s["name"] not in self.main_known and r.random() < cfg["obvious_known"]:
                        self.main_known[s["name"]] = 0 if s["born"] == 0 else min(R - 1, s["born"] + 1)
        # mirrors get reported a lot (feed floods)
        for s in self.specs:
            if s["role"] == "mirror" and r.random() < 0.08 and (feed_stop is None or s["born"] < feed_stop):
                self.feed_plan[s["born"]].append(s["name"])
        # Main also reports the sites it knows to the feed
        for d, rnd in self.main_known.items():
            if r.random() < 0.4:
                self.feed_plan[rnd].append(d)
        # junk on the known operations' old dedicated IPs (DNS pivots exhausted)
        self._junk_hosts = [(op["old_ip"], op["old_ns"]) for op in self.ops.values() if op["known"]]
        # the gap operations are the known ops; the unknown families never appear in Main's knowledge
        for s in self.specs:
            if self.families[s["family"]]["unknown"]:
                self.main_known.pop(s["name"], None)

    def _rename(self, spec, new):
        old = spec["name"]
        spec["name"] = new
        for s in self.specs:
            s["sans"] = [new if x == old else x for x in s["sans"]]
            s["backup"] = [new if x == old else x for x in s["backup"]]
            if s["returned_from"] == old:
                s["returned_from"] = new
            if s["mirror_of"] == old:
                s["mirror_of"] = new

    def _gaps(self):
        """Hunter asks for more of a known operation at fixed rounds (identical for every engine)."""
        r = self.prng
        R = self.total_rounds
        known_ops = [o for o in self.ops.values() if o["known"] and not o.get("mirror")]
        # prefer operations with many sites Main does not know (and migrated ones)
        known_ops.sort(key=lambda o: (-sum(1 for s in o["sites"] if s["name"] not in self.main_known), o["id"]))
        rounds = [x for x in (1, 4, 7) if x < R]
        for i, rnd in enumerate(rounds):
            if not known_ops:
                break
            op = known_ops[i % len(known_ops)]
            seeds = [s["name"] for s in op["sites"] if self.main_known.get(s["name"], 99) <= rnd]
            if not seeds:
                continue
            dead = [s["name"] for s in op["sites"] if s["dies"] is not None and s["dies"] <= rnd]
            reason = ("Hunter gap: this operation's sites went offline, find where it moved" if dead else
                      "Hunter gap: operation has new victim reports but few known sites")
            self.gap_plan[rnd] = {"domain": seeds[0], "seeds": seeds[1:4], "requested": 5, "reason": reason,
                                  "source": "hunter", "operation_id": f"main-op-{_h(self.seed, op['id'])[:10]}"}

    # ------------------------------------------------------------ pivot graph
    def _obs_keys(self, s: dict) -> set:
        """Artifacts a visitor can learn from site s (page, scripts, favicon, DNS, cert)."""
        keys = {("title", s["art"]["title"].lower()), ("favicon", hashlib.sha256(s["fav"]).hexdigest()[:24]),
                ("build", s["art"]["build"])}
        if self.families[s["family"]]["fingerprint"] or s["role"].startswith("chain"):
            keys.add(("kit", s["art"]["kit"]))
        for k in ("support", "api", "analytics"):
            if s["art"].get(k):
                keys.add((k, s["art"][k]))
        if s["hosting"] in ("old", "dedicated"):
            keys.add(("ip", s["ip"]))
            keys.add(("ns", s["ns"][0]))
        if s["stem"]:
            keys.add(("stem", s["stem"]))
        for n in [s["name"]] + s["sans"]:
            keys.add(("cert", n))
        return keys

    def _searchable_keys(self, s: dict) -> set:
        """Artifacts through which a search can return site s."""
        keys = set()
        crt_ok = self.cfg["crt"] != "down"
        crt_stop = self._collapse_round("crt")
        if crt_stop is not None and s["born"] >= crt_stop:
            crt_ok = False
        fn_stop = self._collapse_round("filename")
        if s["scanned"]:
            for k in ("title", "favicon", "support", "api", "analytics", "kit", "build"):
                for kk in self._obs_keys(s):
                    if kk[0] == k:
                        if k in ("kit", "build") and fn_stop is not None and s["born"] >= fn_stop:
                            continue
                        keys.add(kk)
        if s["hosting"] in ("old", "dedicated"):
            keys.add(("ip", s["ip"]))
            keys.add(("ns", s["ns"][0]))
        if s["stem"] and (crt_ok or re.fullmatch(re.escape(s["stem"]) + r"(\d+|-?(app|pro|vip|global|h5|x|ex|fx))?",
                                                  s["name"].split(".")[0])):
            keys.add(("stem", s["stem"]))
        if crt_ok:
            keys.add(("cert", s["name"]))
            for other in s["sans"]:
                keys.add(("cert", other))
        return keys

    def _pivot_distances(self):
        specs = [s for s in self.specs]
        by_name = {s["name"]: s for s in specs}
        searchable = defaultdict(list)
        for s in specs:
            for k in self._searchable_keys(s):
                searchable[k].append(s["name"])
        # generic artifacts are not pivots (count only non-mirror sites; mirrors are one family of noise)
        generic = {k for k, v in searchable.items()
                   if sum(1 for n in v if by_name[n]["role"] != "mirror") > GENERIC_LIMIT}
        dist = {}
        dq = deque()
        for n, rnd in self.main_known.items():
            if n in by_name and rnd == 0:
                dist[n] = 0
                dq.append(n)
        for g in self.gap_plan.values():
            for n in [g["domain"]] + g["seeds"]:
                if n in by_name and n not in dist:
                    dist[n] = 0
                    dq.append(n)
        for s in specs:                                           # exploration entry points
            if s["entry"] and s["name"] not in dist:
                dist[s["name"]] = 1
        # BFS with the explore layer at distance 1 (0-1 BFS by processing in order of distance)
        frontier = sorted(dist, key=lambda n: dist[n])
        dq = deque(frontier)
        while dq:
            a = dq.popleft()
            sa = by_name[a]
            nxt = set(sa["backup"])
            for k in self._obs_keys(sa):
                if k in generic:
                    continue
                nxt.update(searchable.get(k, ()))
            for b in nxt:
                if b not in dist or dist[b] > dist[a] + 1:
                    dist[b] = dist[a] + 1
                    dq.append(b)
        self.generic_keys = generic
        for s in specs:
            s["min_pivots"] = dist.get(s["name"])

    # ------------------------------------------------------------ materialise
    def _materialise(self, s: dict):
        op = self.ops[s["op"]]
        d = Domain(s["name"], s["cls"], True, s["born"], self.prng.uniform(1, 25), variant=s["variant"],
                   kit=s["op"], wallets=s["wallets"], brand=op["brand"], favicon=s["fav"])
        if s["hosting"] == "cdn":
            self._hosting(d, "cdn")
        else:
            d.ip, d.ns = s["ip"], tuple(s["ns"])
        if s["hosting"] == "old":
            d.cpanel = False
        d.extra_sans = tuple(n for n in s["sans"] if n in self.domains)
        if s["dies"] is not None:
            d.transitions[s["dies"]] = {"cls": "dead", "useful": False, "resolves": False}
        self._add(d)
        s["ip"] = d.ip
        fam = self.families[s["family"]]
        self.gt[d.name] = {"kind": "scam", "op": s["op"], "family": s["family"], "variant": s["variant"],
                           "useful": True, "wallets": s["wallets"], "born": s["born"], "dies": s["dies"],
                           "returned_from": s["returned_from"], "mirror_of": s["mirror_of"], "role": s["role"],
                           "min_pivots": s["min_pivots"], "hollow": s["hollow"],
                           "unknown_family": fam["unknown"], "entry": s["entry"],
                           "value": 0.0 if s["role"] == "mirror" else
                           (0.3 if s["hollow"] else BASE_VALUE[s["cls"]] + 1.0 * len(s["wallets"])),
                           "art": dict(s["art"], favicon=hashlib.sha256(s["fav"]).hexdigest()),
                           "backup": list(s["backup"]), "scanned": s["scanned"]}
        self._index_site(d.name, self.gt[d.name]["art"], d.ip, s["born"], s["scanned"])
        # backends resolve (they are operator infrastructure, not scam pages)
        for host in (s["art"].get("support"), (s["art"].get("api") or "").split(".", 1)[-1] or None):
            if host and host not in self.domains:
                b = Domain(host, "scam_infra", False, s["born"], self.prng.uniform(30, 300))
                b.ip, b.ns = f"43.{self.prng.randint(1, 250)}.{self.prng.randint(1, 250)}.{self.prng.randint(1, 250)}", ("ns1.dnspod.net", "ns2.dnspod.net")
                self._add(b)
                self.gt[host] = {"kind": "infra", "op": s["op"], "family": s["family"], "useful": False}
        # junk that shares the old dedicated IP of known operations
        if s["hosting"] == "old" and not getattr(self, "_junked_" + s["op"], False):
            setattr(self, "_junked_" + s["op"], True)
            for _ in range(self.cfg["dns_junk"]):
                j = self._negative(s["born"], self.prng.choice(["parked", "placeholder", "dead", "generic"]))
                j.transitions = {}
                if j.resolves:
                    j.ip, j.ns = s["ip"], tuple(s["ns"])

    def _index_site(self, name, art, ip, rnd, scanned):
        if not scanned:
            return
        lag = int(_h(name, "lag")[:2], 16) % 2
        when = rnd + lag
        for k, v in art.items():
            if k in ("kit", "build"):
                self.index[("filename", v.lower())].append((name, when))
            elif k == "favicon":
                self.index[("hash", v[:24])].append((name, when))
            elif k == "title":
                self.index[("title", v.lower())].append((name, when))
            elif k in ("support", "api"):
                self.index[("domain", v.lower())].append((name, when))
                self.index[("domain", v.split(".", 1)[-1].lower())].append((name, when))
            elif k == "analytics":
                self.index[("text", v.lower())].append((name, when))
        self.index[("domain", name)].append((name, when))
        if ip:
            self.index[("ip", ip)].append((name, when))

    # ================================================================ knowledge for the runner
    def known_at(self, rnd: int) -> list:
        return sorted(d for d, r in self.main_known.items() if r <= rnd and (d in self.domains))

    def investigation_artifacts(self, domain: str) -> list:
        g = self.gt.get(domain)
        if not g or g.get("kind") != "scam":
            return []
        a = g["art"]
        out = [{"kind": "asset", "value": f"/assets/{a['build']}"}, {"kind": "asset", "value": f"/static/js/{a['kit']}"},
               {"kind": "title", "value": a["title"]}, {"kind": "favicon", "value": a["favicon"][:24]}]
        if a.get("support"):
            out.append({"kind": "support_host", "value": a["support"]})
        if a.get("api"):
            out.append({"kind": "api_host", "value": a["api"]})
        if a.get("analytics"):
            out.append({"kind": "analytics_id", "value": a["analytics"]})
        for _, w in g["wallets"]:
            out.append({"kind": "wallet", "value": w})
        for b in g.get("backup") or []:
            out.append({"kind": "linked_domain", "value": b})
        return out

    def totals(self) -> dict:
        """Useful units available to discover (not known to Main at round 0)."""
        units, by_pivots, unknown, returned, unreachable = 0, defaultdict(int), 0, 0, 0
        clusters = set()
        for s in self.specs:
            if self.main_known.get(s["name"]) == 0:
                continue
            if s["role"] == "mirror" or (s["role"] == "mirror_primary" and self.ops[s["op"]]["known"]):
                continue
            if s["dies"] is not None and s["dies"] <= s["born"]:
                continue
            units += 1
            mp = s["min_pivots"]
            if mp is None:
                unreachable += 1
                by_pivots["unreachable"] += 1
            else:
                by_pivots[str(min(mp, 5)) + ("+" if mp >= 5 else "")] += 1
            unknown += bool(self.families[s["family"]]["unknown"])
            returned += bool(s["returned_from"])
            clusters.add(s["op"])
        mirrors = sum(1 for s in self.specs if s["role"] == "mirror")
        return {"useful_units": units, "by_min_pivots": dict(sorted(by_pivots.items())), "unknown_family": unknown,
                "returned": returned, "operations": len(clusters), "mirrors": mirrors,
                "main_known_r0": sum(1 for r in self.main_known.values() if r == 0),
                "domains_total_r0": len(self.domains)}

    # ================================================================ network
    def _mark(self, kind, key, names, target=None):
        new = 0
        for n in names:
            t = self.truth(n)
            reg = t.name if t else n
            if reg not in self.exposed:
                self.exposed.add(reg)
                new += 1
        repeat = key in self.query_seen
        self.query_seen.add(key)
        self.log.append({"r": self.round, "kind": kind, "key": key, "new": new, "repeat": repeat, "target": target})

    def resolve(self, host):
        ip = super().resolve(host)
        if getattr(self, "_in_http", False):
            return ip
        t = self.truth(host)
        self._mark("dns", "dns:" + host.lower(), [host] if ip else [], target=t.name if t else host)
        return ip

    def nameservers(self, host):
        t = self.truth(host)
        self._mark("dns", "ns:" + host.lower(), [], target=t.name if t else host)
        return super().nameservers(host)

    def http(self, url: str) -> dict:
        self._in_http = True
        try:
            return self._http(url)
        finally:
            self._in_http = False

    def _http(self, url: str) -> dict:
        from urllib.parse import urlparse
        p = urlparse(url)
        host = (p.hostname or "").lower()
        if host == "urlscan.io":
            return self._urlscan(p, url)
        if host == "crt.sh":
            if self._crt_failing():
                self._mark("crtsh", url, [])
                self._crt_counter += 1
                if self._crt_counter % 3 == 0:
                    return {"error": "timeout"}
                return {"status": 502, "headers": {"content-type": "text/html"},
                        "body": b"<html><body><h1>502 Bad Gateway</h1></body></html>", "redirect": None, "error": None}
            ans = super().http(url)
            try:
                names = {n.lstrip("*.") for c in json.loads(ans["body"]) for n in c["name_value"].split("\n")}
            except Exception:                                     # noqa: BLE001
                names = set()
            self._mark("crtsh", url, names)
            return ans
        if host.startswith("passivedns."):
            ans = super().http(url)
            try:
                names = json.loads(ans["body"])
            except Exception:                                     # noqa: BLE001
                names = []
            self._mark("passive_dns", url, names)
            return ans
        if host.startswith("feeds."):
            stop = self._collapse_round("feed")
            if stop is not None and self.round >= stop:
                body = []
            else:
                body = [{"url": u, "reported": "community"} for u in self.feed]
            self._mark("feed", url, [u.split("//")[-1].split("/")[0] for u in self.feed] if body else [])
            return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(body).encode(),
                    "redirect": None, "error": None}
        if host == "rdap.org":
            name = p.path.rstrip("/").split("/")[-1].lower()
            self._mark("rdap", url, [], target=name)
            return super().http(url)
        t = self.truth(host)
        self._mark("http", url, [], target=t.name if t else host)
        if t is not None and t.name in self.gt and self.resolve_quiet(host):
            g = self.gt[t.name]
            sub = host[: -len(t.name)].rstrip(".")
            if g["kind"] == "infra":
                if host.startswith("api."):
                    return self._page(404, '{"code":404,"msg":"route not found"}')
                return self._page(200, "<html><head><title>Online Service</title></head><body><div id='chat'>"
                                       "Customer service is online. Please describe your problem.</div>"
                                       "<script src='/static/chat.min.js'></script></body></html>")
            if g["kind"] == "scam" and sub in ("", "www", "m", "h5"):
                if p.path.endswith("favicon.ico"):
                    return {"status": 200, "headers": {"content-type": "image/x-icon"}, "body": t.favicon,
                            "redirect": None, "error": None}
                if p.path.endswith(".js"):
                    return {"status": 200, "headers": {"content-type": "application/javascript"},
                            "body": self._site_js(t, g, p.path).encode(), "redirect": None, "error": None}
                return self._page(200, self._render_site(t, g, host))
            if g["kind"] == "demo" and not p.path.endswith((".js", ".ico")):
                ans = super().http(url)
                if ans.get("body") and b"</head>" in ans["body"]:
                    kit = g["art"]["kit"]
                    ans["body"] = ans["body"].replace(b"</head>", f"<link rel='icon' href='/favicon.ico'><script src='/static/js/{kit}'></script></head>".encode(), 1)
                return ans
        ans = super().http(url)
        # generic libraries are everywhere, not only on scam pages
        if t is not None and ans.get("status") == 200 and b"</head>" in (ans.get("body") or b"") \
                and int(_h(t.name, "lib")[:2], 16) < 140:
            lib = JQUERY[int(_h(t.name, "libv")[:2], 16) % len(JQUERY)]
            ans = dict(ans, body=ans["body"].replace(b"</head>", f"<script src='/js/{lib}'></script></head>".encode(), 1))
        return ans

    def resolve_quiet(self, host):
        return World.resolve(self, host)

    def _crt_failing(self) -> bool:
        mode = self.cfg["crt"]
        stop = self._collapse_round("crt")
        if mode == "down" or (stop is not None and self.round >= stop):
            return True
        if mode == "flaky":
            self._crt_counter += 1
            return int(_h(self.seed, "crt", self._crt_counter)[:4], 16) / 65535 < self.cfg["crt_fail"]
        return False

    # ------------------------------------------------------------ page search
    _Q = re.compile(r'([a-zA-Z_.]+):"([^"]*)"|([a-zA-Z_.]+):(\S+)|"([^"]*)"|(\S+)')

    def _urlscan(self, p, url) -> dict:
        q = unquote((parse_qs(p.query).get("q") or [""])[0])
        try:
            size = min(PAGE_CAP, int((parse_qs(p.query).get("size") or ["100"])[0]))
        except ValueError:
            size = PAGE_CAP
        terms = []
        for m in self._Q.finditer(q):
            f1, v1, f2, v2, v3, v4 = m.groups()
            if (v4 or "").upper() in ("AND", "OR"):
                continue
            field, value = (f1, v1) if f1 else (f2, v2) if f2 else ("text", v3 if v3 is not None else v4)
            terms.append((field.lower(), value.lower().strip()))
        hits, generic_total = None, 0
        for field, value in terms:
            h, g = self._search_term(field, value)
            generic_total = max(generic_total, g)
            hits = h if hits is None else {k: v for k, v in hits.items() if k in h}
        hits = hits or {}
        rows = sorted(hits.items(), key=lambda kv: -kv[1])
        # generic values: realistic huge totals, results mostly unrelated sites
        noise = []
        if generic_total:
            live_noise = [d for d in self._noise_sample() if d not in hits]
            rr = random.Random(_h(self.seed, q))
            noise = rr.sample(live_noise, min(len(live_noise), max(0, size - len(rows))))
        results = []
        for name, when in rows[:size]:
            results.append(self._scan_row(name, when))
        for name in noise[: max(0, size - len(results))]:
            results.append(self._scan_row(name, self.round))
        total = len(rows) + generic_total
        self._mark("page_search", url, [r["page"]["domain"] for r in results])
        body = {"results": results, "total": total, "took": 17, "has_more": total > len(results)}
        return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(body).encode(),
                "redirect": None, "error": None}

    def _noise_sample(self):
        if getattr(self, "_noise_cache_round", None) != self.round:
            self._noise_cache = [d.name for d in self.domains.values()
                                 if d.resolves and d.name not in self.gt and d.born_round <= self.round][:4000]
            self._noise_cache_round = self.round
        return self._noise_cache

    def _search_term(self, field, value):
        """-> ({domain: scan_round}, generic_extra_total)"""
        fmap = {"filename": "filename", "hash": "hash", "page.title": "title", "title": "title",
                "domain": "domain", "page.domain": "domain", "task.domain": "domain", "page.apexdomain": "domain",
                "page.ip": "ip", "ip": "ip", "text": "text", "page.url": "domain", "task.url": "domain"}
        f = fmap.get(field)
        out = {}
        if f is None:
            return out, 0
        fn_stop = self._collapse_round("filename")
        if f == "filename":
            value = value.rsplit("/", 1)[-1]
            if fn_stop is not None and self.round >= fn_stop:
                return {}, 0                        # the index stopped matching script file names
            if value in GENERIC_FILES:
                return self._collect(("filename", value)), 250000 + len(value) * 1000
        if f == "domain" and "/" in value:
            value = value.split("//")[-1].split("/")[0]
        if f == "title":
            for (kf, kv), lst in self.index.items():
                if kf == "title" and (kv == value or (len(value) >= 8 and value in kv)):
                    for n, w in lst:
                        if w <= self.round:
                            out[n] = max(out.get(n, -1), w)
            extra = 0 if len(value) >= 10 else 5000
            return out, extra
        if f == "hash":
            for (kf, kv), lst in self.index.items():
                if kf == "hash" and (kv.startswith(value) or value.startswith(kv)) and len(value) >= 16:
                    for n, w in lst:
                        if w <= self.round:
                            out[n] = max(out.get(n, -1), w)
            return out, 0
        if f == "ip":
            d_on_ip = [d.name for d in self.domains.values() if d.ip == value and d.born_round <= self.round]
            out = {n: w for n, w in self._collect(("ip", value)).items()}
            extra = max(0, len(d_on_ip) - len(out)) if len(d_on_ip) < 60 else 40000
            return out, extra
        if f == "text":
            return self._collect(("text", value)), (20000 if len(value) < 6 else 0)
        return self._collect((f, value)), 0

    def _collect(self, key):
        out = {}
        for n, w in self.index.get(key, ()):
            if w <= self.round:
                out[n] = max(out.get(n, -1), w)
        return out

    def _scan_row(self, name, when):
        d = self.truth(name)
        g = self.gt.get(name, {})
        title = (g.get("art") or {}).get("title") or name
        return {"task": {"domain": name, "url": f"https://{name}/", "time": f"round-{when}"},
                "page": {"domain": name, "apexDomain": name, "url": f"https://{name}/", "ip": d.ip if d else "",
                         "title": title, "status": "200"},
                "_id": _h("scan", name, when)[:32]}

    # ------------------------------------------------------------ rendering
    def _render_site(self, d: Domain, g: dict, host: str) -> str:
        rng = random.Random(f"{self.seed}:{d.name}:page")
        base = RENDERERS.get(d.cls)(self, d, rng)
        a = g["art"]
        base = re.sub(r"<title>.*?</title>", f"<title>{a['title']}</title>", base, count=1, flags=re.S)
        cfg = {}
        if a.get("api"):
            cfg["apiUrl"] = f"https://{a['api']}"
        if a.get("support"):
            cfg["service"] = f"https://{a['support']}/chat?cid={rng.randint(1000, 9999)}"
        head = "<link rel='icon' href='/favicon.ico'>"
        if int(_h(d.name, "lib")[:2], 16) < 150:
            head += f"<script src='/js/{JQUERY[int(_h(d.name, 'libv')[:2], 16) % len(JQUERY)]}'></script>"
        head += f"<script src='/static/js/{a['kit']}'></script>"
        if cfg:
            head += "<script>window.__CFG__=" + json.dumps(cfg).replace('"', "'") + "</script>"
        if a.get("analytics"):
            head += (f"<script async src='https://www.googletagmanager.com/gtag/js?id={a['analytics']}'></script>"
                     f"<script>gtag('config','{a['analytics']}');</script>")
        tail = f"<script src='/assets/{a['build']}'></script>"
        if "</head>" in base:
            base = base.replace("</head>", head + "</head>", 1)
        else:
            base = head + base
        return base.replace("</body>", tail + "</body>", 1) if "</body>" in base else base + tail

    def _site_js(self, d: Domain, g: dict, path: str) -> str:
        fname = path.rsplit("/", 1)[-1]
        a = g["art"]
        vendor = "!function(e){var t={};function n(r){if(t[r])return t[r].exports}}([]);" + "var a=1;" * 30
        if fname.startswith("jquery"):
            return "/*! jQuery v3.6.0 | (c) OpenJS Foundation */" + "var jq=1;" * 60
        if fname == a["kit"]:
            strings = {"pig_shell": ["recharge", "withdraw", "invitationCode", "secondsContract", "onlineService"],
                       "fake_exchange": ["spot", "futures", "withdrawFee", "kyc", "deposit"],
                       "hyip": ["plans", "dailyProfit", "referral", "withdraw", "deposit"],
                       "cloud_mining": ["hashrate", "contract", "dailyIncome", "withdraw"],
                       "recovery_scam": ["caseId", "consultation", "agent", "fee"]}.get(d.cls, ["home"])
            return vendor + "var i18n={" + ",".join(f"'{s}':'{s}'" for s in strings) + "};"
        if fname == a["build"]:
            parts = [vendor]
            if d.cls == "pig_shell":
                parts.append("var i18n={'recharge':'recharge','withdraw':'withdraw','USDT':'USDT','fundPassword':'fundPassword'};")
            cfg = {}
            if a.get("api"):
                cfg["baseURL"] = f"https://{a['api']}"
            if a.get("support"):
                cfg["kefu"] = f"https://{a['support']}/chat"
            if g.get("backup"):
                cfg["backupHosts"] = [f"https://{b}" for b in g["backup"]]
            parts.append("var appConfig=" + json.dumps(cfg) + ";")
            return "".join(parts)
        return vendor
