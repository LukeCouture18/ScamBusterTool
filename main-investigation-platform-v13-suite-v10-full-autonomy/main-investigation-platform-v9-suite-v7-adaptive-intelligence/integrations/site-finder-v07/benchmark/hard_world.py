"""
A harder simulated internet for measuring *new useful investigations per unit of effort*.

The base World (benchmark/world.py) is kept as it is. HardWorld adds the cases the
earlier fixtures did not contain, where the obvious routes run dry:

  * CT-dark operations. Their sites have ordinary brand-like names (no scam
    keyword a certificate search would hit), certificates that only list their
    own name, and CDN hosting (so passive DNS on the IP is generic). One site of
    each is reported somewhere public (a feed) or is already held by Main; the
    rest can only be reached through what the pages themselves expose: the
    operator's own asset file names, page titles, favicons, and what public page
    scanners have indexed.
  * Reappearance. Some sites of those operations are taken down and the same
    operation comes back on a new, unrelated name with the same page build.
  * Vendor fingerprints. Several operations buy their kit from one vendor; the
    vendor's script is shared by all of them and by the vendor's public demo
    sites (which are not scams). Searching the vendor script finds scams from
    several operations *and* demos; it never proves the operations are related.
  * Generic fingerprints. Popular libraries (jQuery, Bootstrap) appear on most
    live sites; searching them returns hundreds of unrelated results.
  * Mirror farms. The base world's clones that reuse a kit's wallets are exact
    duplicates for an investigator.
  * Main already knows some sites. A share of live scams is already held by Main
    (other analysts, earlier Hunter reconstructions). Surfacing them again costs a
    review slot and adds nothing.
  * Main/Hunter gap requests. Main asks Site Finder for more sites of an operation
    it holds (a FIND_RELATED_SITES job with the known site as seed).

A public page-search service (urlscan.io-compatible search API) indexes the pages
that public scanners have visited. Coverage is partial and lags a round.

Ground truth: `truth(domain).kit` identifies the operation; `hidden` holds the
sites that no ambient keyword/feed route can reach.
"""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import parse_qs, unquote

from benchmark.world import SCAM_TLDS, Domain, World, btc_address, evm_address, tron_address

CT_TERMS = ["usdt", "trc20", "invest", "profit", "earn", "yield", "mining", "arbitrage", "quant", "stake",
            "exchange", "trade", "wallet", "recover", "airdrop", "vip", "coin", "bit", "defi", "swap",
            "claim", "fx", "crypto", "finance", "capital", "h5"]
PAGE_SEARCH_HOST = "urlscan.io"
COMMON_LIBS = [("/js/jquery-3.6.0.min.js", 0.55), ("/css/bootstrap-5.3.2.min.css", 0.35),
               ("/js/swiper-bundle.min.js", 0.2)]
VENDORS = ["exscript", "coinkit", "tradepro"]
DARK_STEMS = ["lumora", "vantrix", "quorra", "zephyra", "kalvio", "ostrel", "brivon", "caldra", "fennix",
              "moravia", "tessaro", "quillon", "varesse", "nuvela", "orrin", "delvara", "sorvik", "haldor"]
DARK_TLDS = [".app", ".club", ".live", ".shop", ".cc", ".icu", ".cfd", ".top", ".xyz"]


def _tok(*parts) -> str:
    return hashlib.sha1(":".join(str(p) for p in parts).encode()).hexdigest()[:8]


def has_ct_term(name: str) -> bool:
    label = name.split(".")[0]
    return any(t in label for t in CT_TERMS)


class HardWorld(World):
    def __init__(self, seed: int = 7, split: str = "eval", difficulty: float = 0.7, rounds: int = 8,
                 scale: float = 1.0, ct_outage_from: int | None = None):
        self.difficulty = difficulty
        self.ct_outage_from = ct_outage_from        # from this round crt.sh answers 502 (the obvious route is gone)
        self.hidden: set[str] = set()
        self.main_known: dict[str, int] = {}     # domain -> round Main learned of it
        self.scans: dict[str, int] = {}          # domain -> first round a public scanner indexed it
        self.dark_ops: list[str] = []
        self.gaps: list[dict] = []               # {"round", "kit", "seed"}
        self.vendor_of: dict[str, str] = {}      # kit -> vendor
        self.successor_of: dict[str, str] = {}   # successor domain -> taken-down domain
        self.query_log: list[tuple] = []         # (source, query, [registrables returned])
        self.demo_vendor: dict[str, str] = {}    # script-demo domain -> vendor
        super().__init__(seed=seed, split=split, rounds=rounds, scale=scale)
        self._build_dark_ops()
        self._build_vendor_demos()
        self._index_initial()
        self._seed_main_knowledge(0)

    # ---------------------------------------------------------------- operations
    def _new_kit(self, cls: str) -> str:
        kid = super()._new_kit(cls)
        self.vendor_of[kid] = self.rng.choice(VENDORS)
        return kid

    def _dark_name(self, stem: str, used: set) -> str:
        for _ in range(50):
            base = stem if not used else self.rng.choice([
                f"{stem}{self.rng.randint(2, 99)}", f"{stem}{self.rng.choice(['a', 'x', 'o', 'y'])}",
                f"my{stem}", f"{stem}{self.rng.choice(['pay', 'go', 'one', 'net'])}"])
            name = self._unique(base, self.rng.choice(DARK_TLDS))
            if not has_ct_term(name):
                return name
        raise RuntimeError("could not name a dark site")

    def _dark_site(self, kid: str, born: int, name: str | None = None) -> Domain:
        k = self._kits[kid]
        name = name or self._dark_name(k["stem"], set(k["members"]))
        same = self.rng.random() < 0.5
        d = Domain(name, k["cls"], True, born, self.rng.uniform(1, 12), variant=k["variant"], kit=kid,
                   wallets=k["wallets"] if same else self._wallet_set(), brand=k["stem"].capitalize(),
                   favicon=k["favicon"])
        # CDN hosting: the IP and name servers are shared with thousands of sites.
        if self.rng.random() < self.difficulty:
            self._hosting(d, "cdn")
        else:
            self._hosting(d, f"kit:{kid}")
        d.cpanel = False
        k["members"].append(name)
        self._add(d, cert_names=[name, "www." + name])
        self.hidden.add(name)
        return d

    def _build_dark_ops(self):
        n = round(3 + 4 * self.difficulty)
        stems = self.rng.sample(DARK_STEMS, n)
        for i, stem in enumerate(stems):
            cls = self.rng.choice(["hyip", "pig_shell", "fake_exchange", "hyip"])
            kid = self._new_kit(cls)
            k = self._kits[kid]
            k["stem"] = stem
            k["cpanel"] = False
            k["variant"] = self.rng.choice(self.variants if cls != "pig_shell" else (1, 2))
            self.dark_ops.append(kid)
            members = [self._dark_site(kid, 0) for _ in range(self.rng.randint(3, 5))]
            entry = members[0]
            self.hidden.discard(entry.name)
            if i % 2 == 0:
                # reported publicly: the only ambient way in
                self.feed.append(f"https://{entry.name}/")
            else:
                # held by Main (earlier analyst work); Main asks Finder for the rest
                self.main_known[entry.name] = 0
                self.gaps.append({"round": 1 + (i % 3), "kit": kid, "seed": entry.name})
            # later waves and take-down successors
            k["waves"] = [(r, self.rng.randint(1, 2)) for r in (2, 4, 6) if self.rng.random() < 0.8]
            victim = self.rng.choice(members[1:])
            k["takedown"] = (victim.name, self.rng.randint(1, 3))

    def _build_vendor_demos(self):
        for vendor in VENDORS:
            for j in range(2):
                name = self._unique(f"{vendor}{self.rng.choice(['demo', 'script', 'soft', 'labs'])}", ".com")
                d = Domain(name, "script_demo", False, -1, self.rng.uniform(200, 1500),
                           variant=self.rng.choice(self.variants))
                self._hosting(d, "cdn")
                self.demo_vendor[name] = vendor
                self._add(d, cert_days_ago=self.rng.uniform(1, 60))

    def _births(self, rnd: int, backlog: bool = False):
        """Same generator as World, with fewer keyword-visible scams: the easy ones are rarer here."""
        from benchmark.world import POSITIVE_CLASSES
        s = self.scale * (3.0 if backlog else 1.0)
        keep = 1.0 - 0.55 * getattr(self, "difficulty", 0.0)
        plan = {
            "hyip": 3 * keep, "pig_shell": 4 * keep, "fake_exchange": 3 * keep, "cloud_mining": 2 * keep,
            "phishing_impersonation": 2 * keep, "recovery_scam": 1 * keep,
            "parked": 45, "for_sale": 10, "dead": 35, "placeholder": 25, "suspended": 5, "coming_soon": 8,
            "legit_crypto": 8, "informational": 10, "non_crypto": 45, "generic": 20,
        }
        if self.stress:
            plan.update({"pr_article": 5, "script_demo": 3, "parked_unknown": 12})
        order = []
        for cls, n in plan.items():
            order += [cls] * int(round(n * s * self.rng.uniform(0.7, 1.3)))
        self.rng.shuffle(order)
        for cls in order:
            if cls in POSITIVE_CLASSES:
                existing = [k for k, v in self._kits.items() if v["cls"] == cls and v["members"]
                            and k not in getattr(self, "dark_ops", [])]
                if existing and self.rng.random() < 0.45:
                    self._positive(rnd, cls, kit=self.rng.choice(existing), same_wallets=self.rng.random() < 0.55)
                else:
                    self._positive(rnd, cls)
            else:
                self._negative(rnd, cls)
        live = [d for d in self.domains.values() if d.useful and d.born_round < rnd
                and d.name not in getattr(self, "hidden", set())]
        for d in self.rng.sample(live, min(len(live), int(3 * self.scale))):
            url = f"https://{d.name}/"
            if url not in self.feed:
                self.feed.append(url)

    def _seed_main_knowledge(self, rnd: int):
        """Other analysts and earlier reconstructions: Main holds some live scams already."""
        pool = [d for d in self.domains.values() if d.useful and d.resolves and d.name not in self.main_known
                and d.born_round < rnd + (1 if rnd == 0 else 0) and d.name not in self.hidden]
        share = (0.25 + 0.3 * self.difficulty) if rnd == 0 else 0.1 + 0.15 * self.difficulty
        for d in self.rng.sample(pool, int(len(pool) * share)):
            self.main_known[d.name] = rnd

    def advance(self):
        super().advance()
        rnd = self.round
        for kid in self.dark_ops:
            k = self._kits[kid]
            for wave_round, count in k.get("waves", []):
                if wave_round == rnd:
                    for _ in range(count):
                        self._dark_site(kid, rnd)
            victim, when = k.get("takedown", ("", -1))
            if when == rnd and victim in self.domains and self.domains[victim].useful:
                dead = self.domains[victim]
                dead.cls, dead.useful, dead.resolves = "dead", False, False
                successor = self._dark_site(kid, rnd, name=self._dark_name(
                    self.rng.choice(DARK_STEMS), set()))
                self.successor_of[successor.name] = victim
        self._seed_main_knowledge(rnd)
        self._index(rnd)

    # ---------------------------------------------------------------- scanning
    def _index_initial(self):
        for d in self.domains.values():
            self._maybe_scan(d, 0, initial=True)

    def _index(self, rnd: int):
        for d in self.domains.values():
            if d.name not in self.scans:
                self._maybe_scan(d, rnd)

    def _maybe_scan(self, d: Domain, rnd: int, initial: bool = False):
        if not d.resolves:
            return
        if d.useful:
            p = 0.72
        elif d.cls in ("legit_crypto", "informational", "script_demo", "non_crypto", "generic"):
            p = 0.5
        else:
            p = 0.2
        lag = 0 if initial and d.born_round < 0 else 1
        if d.born_round + lag <= rnd and self.rng.random() < p:
            self.scans[d.name] = rnd

    # ---------------------------------------------------------------- page build
    def assets(self, d: Domain) -> list:
        rng = __import__("random").Random(f"{self.seed}:{d.name}:assets")
        out = [path for path, p in COMMON_LIBS if rng.random() < p]
        if d.kit and d.useful:
            vendor = self.vendor_of.get(d.kit, "exscript")
            out.append(f"/static/js/vendor.{_tok(self.seed, vendor)}.js")
            out.append(f"/static/js/app.{_tok(self.seed, d.kit)}.js")
            out.append(f"/static/css/main.{_tok(self.seed, d.kit, 'css')}.css")
        elif d.name in self.demo_vendor:
            out.append(f"/static/js/vendor.{_tok(self.seed, self.demo_vendor[d.name])}.js")
            out.append(f"/static/js/app.{_tok(self.seed, d.name)}.js")
        return out

    def title_of(self, d: Domain) -> str:
        from benchmark.world import render
        html = render(self, d, d.name)
        m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
        return (m.group(1).strip() if m else "")

    def http(self, url: str) -> dict:
        from urllib.parse import urlparse
        p = urlparse(url)
        host = (p.hostname or "").lower()
        if host == PAGE_SEARCH_HOST:
            return self._page_search(p)
        answer = super().http(url)
        if answer.get("error") or answer.get("status") != 200:
            return answer
        if "text/html" not in str(answer.get("headers", {}).get("content-type", "")):
            return answer
        d = self.truth(host)
        if not d or host != d.name and not host.startswith("www."):
            return answer
        tags = "".join(f"<script src='{a}'></script>" if a.endswith(".js") else f"<link rel='stylesheet' href='{a}'>"
                       for a in self.assets(d))
        body = answer["body"].decode("utf-8", "ignore")
        body = body.replace("</head>", tags + "</head>", 1) if "</head>" in body else tags + body
        return {**answer, "body": body.encode("utf-8")}

    # ---------------------------------------------------------------- APIs
    def _log(self, source: str, query: str, names: list):
        regs = sorted({(self.truth(n).name if self.truth(n) else n) for n in names})
        self.query_log.append((source, query, regs))

    def _crtsh(self, p) -> dict:
        if self.ct_outage_from is not None and self.round >= self.ct_outage_from:
            self._log("crtsh", "outage", [])
            return {"status": 502, "headers": {"content-type": "text/html"}, "body": b"<h1>502 Bad Gateway</h1>",
                    "redirect": None, "error": None}
        answer = super()._crtsh(p)
        q = parse_qs(p.query)
        pattern = unquote((q.get("q") or q.get("identity") or [""])[0]).lower()
        try:
            rows = json.loads(answer["body"])
        except ValueError:
            rows = []
        names = [n.strip().lstrip("*.") for r in rows for n in str(r.get("name_value", "")).split("\n")]
        self._log("crtsh", pattern, [n for n in names if n])
        return answer

    def _passive_dns(self, p) -> dict:
        answer = super()._passive_dns(p)
        try:
            names = json.loads(answer["body"])
        except ValueError:
            names = []
        self._log("passive_dns", p.path, names)
        return answer

    def _page_search(self, p) -> dict:
        """urlscan.io-compatible search over publicly scanned pages (GET /api/v1/search/?q=...)."""
        q = unquote((parse_qs(p.query).get("q") or [""])[0]).strip()
        m = re.match(r'^(filename|page\.title|hash|domain|page\.domain|ip|page\.ip):"?(.*?)"?$', q)
        results = []
        if m:
            field, value = m.group(1), m.group(2).lower()
            for name, when in self.scans.items():
                if when > self.round:
                    continue
                d = self.domains.get(name)
                if not d or not d.resolves:
                    continue
                if field == "filename":
                    hit = any(a.lower().endswith(value) or value in a.lower() for a in self.assets(d))
                elif field == "page.title":
                    hit = self.title_of(d).lower() == value
                elif field == "hash":
                    hit = bool(d.favicon) and hashlib.sha256(d.favicon).hexdigest()[:24] == value
                elif field in ("ip", "page.ip"):
                    hit = d.ip == value
                else:
                    hit = name == value or name.endswith("." + value)
                if hit:
                    results.append({"page": {"domain": name, "ip": d.ip, "title": self.title_of(d)[:120]},
                                    "task": {"domain": name, "time": f"round-{when}"}})
        total = len(results)
        results = results[:100]
        self._log("page_search", q, [r["page"]["domain"] for r in results])
        body = {"results": results, "total": total, "took": 3, "has_more": total > 100}
        return {"status": 200 if m else 400, "headers": {"content-type": "application/json"},
                "body": json.dumps(body).encode(), "redirect": None, "error": None}

    # ---------------------------------------------------------------- truth helpers
    def is_hidden(self, domain: str) -> bool:
        d = self.truth(domain)
        return bool(d) and d.name in self.hidden

    def known_to_main(self, domain: str, at_round: int) -> bool:
        d = self.truth(domain)
        return bool(d) and d.name in self.main_known and self.main_known[d.name] <= at_round

    def main_known_at(self, at_round: int) -> list:
        return sorted(n for n, r in self.main_known.items() if r <= at_round)


__all__ = ["HardWorld", "PAGE_SEARCH_HOST", "has_ct_term", "btc_address", "evm_address", "tron_address", "SCAM_TLDS"]
