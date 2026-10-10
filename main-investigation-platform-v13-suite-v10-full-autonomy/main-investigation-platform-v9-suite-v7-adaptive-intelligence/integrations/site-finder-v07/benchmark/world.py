"""
A deterministic simulated internet for comparing Site Finder pipelines.

WHY THIS EXISTS
---------------
Precision can only be measured against ground truth, and the live internet has
none. This module builds a synthetic slice of it that behaves the way the real
discovery surface behaves for crypto-scam hunting:

  * Certificate Transparency is dominated by noise: cPanel AutoSSL issues
    mail./cpanel./webmail./autodiscover. certificates for every hosted domain,
    and keyword fragments like "invest", "trading" and "exchange" match far more
    legitimate businesses than scams.
  * Most crypto-named new domains are parked, for sale, placeholders, or dead.
  * Parking landers carry crypto "related searches" ad links.
  * Brand typosquats are mostly owned by the brand and redirect to it.
  * News articles, scam-review sites and how-to guides use exactly the
    vocabulary scams use (and sometimes print a scam's wallet address).
  * Legitimate exchanges and DeFi projects mention deposits, withdrawals,
    staking rewards, Telegram and contract addresses.
  * Scam kits are cloned across many domains, sometimes with the same wallet.
  * Pig-butchering trading apps are often near-empty SPA shells.
  * CDN and shared-hosting IPs are shared by thousands of unrelated domains.
  * The world changes: parked domains go live, live scams die.

Every domain carries a ground-truth label. The simulator serves DNS, HTTP
(including redirects, TLS/connection failures, status codes), crt.sh JSON,
RDAP registration dates, favicons and a public scam-report feed.

STRESS SPLIT
------------
"stress" mixes every template variant and adds cases built to break v2's
rules: paid press releases that repeat a scam's promises, white-label
exchange-script vendor demos (they look exactly like a scam kit), parking
pages from providers v2 has no signature for, and "stealth" scams that show
almost nothing before login. It exists to show where v2 degrades.

HOLD-OUT
--------
Page templates come in variants. The "dev" split only uses variants 0-1; the
"eval" split uses variants 2-3, different brand vocabulary, and different
parking providers' wording where available. v2 was developed against "dev";
the headline numbers in the report come from "eval".

Everything is synthetic. Nothing here contacts the network.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import random
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse, parse_qs, unquote

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

POSITIVE_CLASSES = {"hyip", "pig_shell", "fake_exchange", "cloud_mining",
                    "phishing_impersonation", "recovery_scam"}

BRANDS = {
    "binance": "binance.com", "coinbase": "coinbase.com", "kraken": "kraken.com",
    "metamask": "metamask.io", "trustwallet": "trustwallet.com", "bybit": "bybit.com",
    "okx": "okx.com", "kucoin": "kucoin.com", "bitget": "bitget.com",
    "cryptocom": "crypto.com", "ledger": "ledger.com", "trezor": "trezor.io",
}

SYL_A_DEV = ["coin", "bit", "crypto", "block", "chain", "quant", "nova", "zen", "apex",
             "aurum", "lumi", "vex", "yield", "stake", "mint", "hash", "nex", "prime"]
SYL_B_DEV = ["vexa", "ora", "nix", "ium", "ex", "fy", "hub", "max", "base", "dex", "fin",
             "cap", "ai", "one", "plus", "gate", "flow", "wave"]
SYL_A_EVAL = ["orbi", "veri", "meta", "ultra", "gold", "luxe", "terra", "sol", "astra",
              "helio", "kairo", "omni", "pulse", "vault", "sigma", "fusion", "tron", "delta"]
SYL_B_EVAL = ["ix", "ara", "mint", "verse", "bitx", "trade", "labs", "pay", "coinx", "net",
              "lyte", "sphere", "quant", "chain", "fx", "port", "mark", "bank"]

SCAM_TLDS = [".vip", ".top", ".xyz", ".com", ".net", ".cc", ".live", ".pro", ".io",
             ".org", ".app", ".co", ".club", ".shop", ".icu", ".cfd"]
LEGIT_TLDS = [".com", ".com", ".com", ".net", ".org", ".co.uk", ".de", ".io", ".com.au"]


def _b58check(payload: bytes) -> str:
    data = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + out


def tron_address(rng: random.Random) -> str:
    return _b58check(b"\x41" + bytes(rng.getrandbits(8) for _ in range(20)))


def btc_address(rng: random.Random) -> str:
    return _b58check(b"\x00" + bytes(rng.getrandbits(8) for _ in range(20)))


def evm_address(rng: random.Random) -> str:
    return "0x" + "".join(rng.choice("0123456789abcdef") for _ in range(40))


# ---------------------------------------------------------------------------
# Domain model
# ---------------------------------------------------------------------------

@dataclass
class Domain:
    name: str
    cls: str
    useful: bool
    born_round: int
    registered_days_ago: float        # at birth
    resolves: bool = True
    ip: str = ""
    ns: tuple = ()
    variant: int = 0
    brand: str = ""
    kit: str = ""                     # operator/template family
    wallets: tuple = ()
    favicon: bytes | None = None
    redirect_to: str = ""
    failure: str = ""                 # refused | timeout | tls | http:<code>
    cpanel: bool = False              # AutoSSL SANs + cPanel subdomains
    extra_sans: tuple = ()            # other registrable domains on the same cert
    transitions: dict = field(default_factory=dict)  # round -> dict(changes)
    subject: str = ""                 # for informational pages: the scam they discuss
    extra_links: tuple = ()           # outbound links (e.g. a HYIP monitor listing)
    notes: str = ""

    def label(self) -> str:
        return "useful" if self.useful else self.cls


class World:
    def __init__(self, seed: int = 7, split: str = "eval", rounds: int = 6,
                 scale: float = 1.0):
        self.seed = seed
        self.split = split
        self.rounds = rounds
        self.scale = scale
        self.rng = random.Random(f"{seed}:{split}")
        self.now = _dt.datetime.utcnow()
        self.round = 0
        self.domains: dict[str, Domain] = {}
        self.certs: list[dict] = []       # crt.sh entries
        self.feed: list[str] = []
        self.request_log: list[tuple] = []
        self._cert_id = 1000000
        self._kits: dict[str, dict] = {}
        self.stress = split == "stress"
        self.variants = (0, 1) if split == "dev" else (0, 1, 2, 3) if self.stress else (2, 3)
        self.syl_a = SYL_A_DEV if split == "dev" else SYL_A_EVAL
        self.syl_b = SYL_B_DEV if split == "dev" else SYL_B_EVAL
        self._cdn_ips = [f"104.21.{self.rng.randint(1, 250)}.{self.rng.randint(1, 250)}" for _ in range(12)] + \
                        [f"172.67.{self.rng.randint(1, 250)}.{self.rng.randint(1, 250)}" for _ in range(12)]
        self._shared_ips = [f"198.54.{self.rng.randint(1, 250)}.{self.rng.randint(1, 250)}" for _ in range(25)]
        self._parking = {
            "sedo": {"ip": "64.190.63.111", "ns": ("ns1.sedoparking.com", "ns2.sedoparking.com")},
            "bodis": {"ip": "199.59.243.222", "ns": ("ns1.bodis.com", "ns2.bodis.com")},
            "parkingcrew": {"ip": "185.53.179.29", "ns": ("ns1.parkingcrew.net", "ns2.parkingcrew.net")},
            "godaddy": {"ip": "34.102.136.180", "ns": ("ns51.domaincontrol.com", "ns52.domaincontrol.com")},
            "namecheap": {"ip": "192.64.119.137", "ns": ("dns1.registrar-servers.com", "dns2.registrar-servers.com")},
            "dan": {"ip": "3.64.163.50", "ns": ("ns1.dan.com", "ns2.dan.com")},
            "afternic": {"ip": "76.223.54.146", "ns": ("ns1.afternic.com", "ns2.afternic.com")},
        }
        self._parking_favicons = {k: hashlib.md5(k.encode()).digest() * 4 for k in self._parking}
        self._build_static()
        self._births(0, backlog=True)

    # ------------------------------------------------------------------ names
    def _brandish(self) -> str:
        a = self.rng.choice(self.syl_a)
        b = self.rng.choice(self.syl_b)
        name = a + b
        roll = self.rng.random()
        if roll < 0.15:
            name += self.rng.choice(["-pro", "-global", "-app", "24", "-vip", "-fx", "-plus", "365"])
        elif roll < 0.25:
            name = self.rng.choice(["my", "the", "go", "get", "i"]) + name
        return name

    def _unique(self, base: str, tld: str) -> str:
        name = f"{base}{tld}"
        n = 2
        while name in self.domains:
            name = f"{base}{n}{tld}"
            n += 1
        return name

    def _fragment_name(self, kind: str) -> str:
        """Crypto-flavoured names that contain the kinds of fragments CT queries hit."""
        frag = {
            "invest": ["invest", "investment", "invest-pro", "usdtinvest", "investcoin"],
            "trading": ["trading", "trade-ai", "tradingbit", "fxtrading", "copytrading"],
            "exchange": ["exchange", "bitexchange", "coinexchange", "exchange-pro", "swapexchange"],
            "mining": ["cloudmining", "mining-pool", "cloudmine", "hashmining", "btcmining"],
            "wallet": ["wallet-recovery", "walletsync", "wallet-validate", "restorewallet", "dappfix"],
        }[kind]
        f = self.rng.choice(frag)
        style = self.rng.random()
        if style < 0.4:
            return f"{self.rng.choice(self.syl_a)}{f}"
        if style < 0.7:
            return f"{f}{self.rng.choice(self.syl_b)}"
        return f"{f}-{self.rng.choice(['global', 'pro', 'plus', 'hub', 'online', 'club', 'center', 'vip'])}"

    # --------------------------------------------------------------- hosting
    def _hosting(self, dom: Domain, mode: str):
        if mode == "cdn":
            dom.ip = self.rng.choice(self._cdn_ips)
            dom.ns = (f"{self.rng.choice(['ada','bob','kim','lia','max','zoe'])}.ns.cloudflare.com",
                      f"{self.rng.choice(['ian','jon','ray','sue','tom','uma'])}.ns.cloudflare.com")
        elif mode == "shared":
            dom.ip = self.rng.choice(self._shared_ips)
            dom.ns = ("ns1.hostinger-shared.net", "ns2.hostinger-shared.net") if self.rng.random() < .5 \
                else ("dns1.registrar-servers.com", "dns2.registrar-servers.com")
            dom.cpanel = True
        elif mode.startswith("parking:"):
            p = self._parking[mode.split(":")[1]]
            dom.ip, dom.ns = p["ip"], p["ns"]
        elif mode.startswith("kit:"):
            kit = self._kits[mode.split(":", 1)[1]]
            dom.ip = self.rng.choice(kit["ips"])
            dom.ns = kit["ns"]
            dom.cpanel = kit["cpanel"]

    def _add(self, dom: Domain, cert_names: list | None = None, cert_days_ago: float | None = None):
        self.domains[dom.name] = dom
        if cert_names is None:
            cert_names = [dom.name, "www." + dom.name]
            if dom.cpanel:
                cert_names += [f"{p}.{dom.name}" for p in ("mail", "cpanel", "webmail", "webdisk", "cpcalendars", "cpcontacts", "autodiscover")]
            cert_names += list(dom.extra_sans)
        age = dom.registered_days_ago if cert_days_ago is None else cert_days_ago
        if dom.resolves or self.rng.random() < 0.8:
            self._issue(cert_names, age)
        return dom

    def _issue(self, names: list, days_ago: float, wildcard: bool = False):
        self._cert_id += 1
        ts = self.now - _dt.timedelta(days=max(0.0, days_ago))
        issuer = self.rng.choice(["C=US, O=Let's Encrypt, CN=R3", "C=US, O=Let's Encrypt, CN=R11",
                                  "C=US, O=Google Trust Services, CN=WE1", "C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA",
                                  "C=US, O=\"cPanel, Inc.\", CN=\"cPanel, Inc. Certification Authority\""])
        self.certs.append({"id": self._cert_id, "issuer_name": issuer, "common_name": names[0],
                           "name_value": "\n".join(names),
                           "entry_timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3],
                           "not_before": ts.strftime("%Y-%m-%dT%H:%M:%S"),
                           "_born_round": self.round})

    # ------------------------------------------------------------- the world
    def _build_static(self):
        """Things that exist before round 0: brands, their typos, legit sites, old feed entries."""
        for brand, official in BRANDS.items():
            d = Domain(official, "legit_crypto", False, -1, 3000, brand=brand, notes="official")
            self._hosting(d, "cdn")
            d.favicon = hashlib.sha1(brand.encode()).digest() * 3
            self._add(d, cert_days_ago=self.rng.uniform(5, 80))
            # Typosquats of the brand, most of them defensively owned.
            from app.discovery.similar_domains import generate_variants
            variants = generate_variants(brand, max_variants=400)
            self.rng.shuffle(variants)
            for v in variants[: int(30 * self.scale)]:
                tld = self.rng.choice([".com", ".com", ".net", ".org", ".xyz", ".top", ".live", ".cc"])
                name = v + tld
                if name in self.domains:
                    continue
                roll = self.rng.random()
                if roll < 0.40:
                    t = Domain(name, "brand_owned_redirect", False, -1, self.rng.uniform(400, 3000),
                               brand=brand, redirect_to=f"https://www.{official}/")
                    self._hosting(t, "cdn")
                elif roll < 0.70:
                    prov = self.rng.choice(list(self._parking))
                    t = Domain(name, "parked", False, -1, self.rng.uniform(30, 2000), brand=brand,
                               notes=prov, variant=self.rng.choice(self.variants))
                    self._hosting(t, f"parking:{prov}")
                    t.favicon = self._parking_favicons[prov]
                elif roll < 0.92:
                    t = Domain(name, "dead", False, -1, self.rng.uniform(30, 900), brand=brand, resolves=False)
                else:
                    t = self._positive(-1, "phishing_impersonation", brand=brand, name=name)
                    continue
                self._add(t, cert_days_ago=self.rng.uniform(1, 400))
        # Old reported scams (for the feed): mostly dead or parked by now.
        for _ in range(int(40 * self.scale)):
            name = self._unique(self._brandish(), self.rng.choice(SCAM_TLDS))
            roll = self.rng.random()
            if roll < 0.55:
                d = Domain(name, "dead", False, -1, self.rng.uniform(200, 900), resolves=self.rng.random() < .3,
                           failure=self.rng.choice(["refused", "timeout", "http:404", "http:521"]))
                if d.resolves:
                    self._hosting(d, "cdn")
            elif roll < 0.85:
                prov = self.rng.choice(list(self._parking))
                d = Domain(name, "parked", False, -1, self.rng.uniform(200, 900), notes=prov,
                           variant=self.rng.choice(self.variants))
                self._hosting(d, f"parking:{prov}")
                d.favicon = self._parking_favicons[prov]
            else:
                d = Domain(name, "suspended", False, -1, self.rng.uniform(200, 900))
                self._hosting(d, "shared")
            self._add(d, cert_days_ago=self.rng.uniform(200, 800))
            self.feed.append(f"https://{name}/")

    def _new_kit(self, cls: str) -> str:
        kid = f"kit{len(self._kits) + 1}"
        cpanel = self.rng.random() < 0.35
        dedicated = self.rng.random() < 0.55
        ips = [f"45.{self.rng.randint(8, 250)}.{self.rng.randint(1, 250)}.{self.rng.randint(1, 250)}"
               for _ in range(self.rng.choice([1, 1, 2]))] if dedicated else self._cdn_ips[:]
        ns = ("ns1." + self.rng.choice(["njalla", "1984hosting", "hostkey", "veesp", "dnspod"]) + ".net",
              "ns2.same") if dedicated else ("amy.ns.cloudflare.com", "bob.ns.cloudflare.com")
        wallets = self._wallet_set()
        self._kits[kid] = {"cls": cls, "variant": self.rng.choice(self.variants), "ips": ips, "ns": ns,
                           "cpanel": cpanel, "favicon": hashlib.sha256(kid.encode()).digest() * 2,
                           "wallets": wallets, "dedicated": dedicated, "members": [],
                           "stem": self.rng.choice(self.syl_a) + self.rng.choice(self.syl_b),
                           "service": f"{self.rng.choice(['kefu', 'chat', 'service', 'help'])}{self.rng.randint(10, 99)}.{self.rng.choice(['com', 'net', 'top'])}"}
        return kid

    def _wallet_set(self) -> tuple:
        out = []
        if self.rng.random() < 0.8:
            out.append(("USDT-TRC20", tron_address(self.rng)))
        if self.rng.random() < 0.5:
            out.append(("BTC", btc_address(self.rng)))
        if self.rng.random() < 0.4:
            out.append(("USDT-ERC20", evm_address(self.rng)))
        return tuple(out)

    def _positive(self, born: int, cls: str, brand: str = "", name: str = "", kit: str = "",
                  same_wallets: bool | None = None) -> Domain:
        if not kit:
            kit = self._new_kit(cls)
        k = self._kits[kit]
        if not name:
            if cls == "phishing_impersonation":
                brand = brand or self.rng.choice(list(BRANDS))
                name = self._unique(f"{brand}-{self.rng.choice(['verify', 'secure', 'support', 'wallet', 'claim', 'auth', 'kyc', 'unlock', 'rewards'])}",
                                    self.rng.choice(SCAM_TLDS))
            else:
                roll = self.rng.random()
                if roll < 0.3 and cls in ("hyip", "fake_exchange", "cloud_mining"):
                    kind = {"hyip": "invest", "fake_exchange": "exchange", "cloud_mining": "mining"}[cls]
                    base = self._fragment_name(kind)
                elif roll < 0.55 and k["members"]:
                    # kits often number or affix their clones
                    stem = k["stem"]
                    base = self.rng.choice([f"{stem}{len(k['members']) + 1}", f"{stem}-{self.rng.choice(['app', 'pro', 'vip', 'global', 'h5'])}", f"{stem}{self.rng.choice(['x', 'ex', 'fx'])}"])
                else:
                    base = self._brandish()
                name = self._unique(base, self.rng.choice(SCAM_TLDS))
        if same_wallets is None:
            same_wallets = True
        wallets = k["wallets"] if same_wallets else self._wallet_set()
        d = Domain(name, cls, True, born, self.rng.uniform(1, 25), variant=k["variant"], kit=kit,
                   wallets=wallets, brand=brand or k["stem"].capitalize(), favicon=k["favicon"])
        if self.stress and cls in ("hyip", "fake_exchange", "cloud_mining", "pig_shell") and self.rng.random() < 0.3:
            d.notes = "stealth"
        self._hosting(d, f"kit:{kit}")
        # 20% of kit operators put several of their domains on one certificate
        if k["members"] and self.rng.random() < 0.2:
            d.extra_sans = tuple(self.rng.sample(k["members"], min(2, len(k["members"]))))
        k["members"].append(name)
        # some die later
        if self.rng.random() < 0.18:
            d.transitions[born + self.rng.randint(2, 4)] = {"cls": "dead", "useful": False, "resolves": False}
        return self._add(d)

    def _negative(self, born: int, cls: str) -> Domain:
        r = self.rng
        v = r.choice(self.variants)
        if cls in ("parked", "for_sale"):
            prov = r.choice(["sedo", "bodis", "parkingcrew", "godaddy", "namecheap"]) if cls == "parked" else r.choice(["dan", "afternic", "sedo"])
            kind = r.choice(["invest", "trading", "exchange", "mining", "wallet", None, None])
            base = self._fragment_name(kind) if kind else self._brandish()
            name = self._unique(base, r.choice(SCAM_TLDS))
            d = Domain(name, cls, False, born, r.uniform(0.5, 60), variant=v, notes=prov)
            self._hosting(d, f"parking:{prov}")
            d.favicon = self._parking_favicons[prov]
            # a parked crypto name is sometimes later turned into a live scam
            if kind and r.random() < 0.12:
                d.transitions[born + r.randint(1, 3)] = {"activate": r.choice(["hyip", "fake_exchange", "pig_shell"])}
            return self._add(d)
        if cls == "dead":
            kind = r.choice(["invest", "trading", "exchange", "mining", None])
            base = self._fragment_name(kind) if kind else self._brandish()
            name = self._unique(base, r.choice(SCAM_TLDS))
            fail = r.choice(["nx", "nx", "refused", "timeout", "tls", "http:404", "http:403", "http:500", "http:502", "http:521", "http:522"])
            d = Domain(name, "dead", False, born, r.uniform(0.5, 40), resolves=fail != "nx",
                       failure="" if fail == "nx" else fail)
            if d.resolves:
                self._hosting(d, r.choice(["cdn", "shared"]))
            return self._add(d)
        if cls in ("placeholder", "suspended", "coming_soon"):
            kind = r.choice(["invest", "trading", "exchange", "mining", None, None])
            base = self._fragment_name(kind) if kind else self._brandish()
            name = self._unique(base, r.choice(SCAM_TLDS + [".com", ".com"]))
            d = Domain(name, cls, False, born, r.uniform(0.5, 30), variant=v,
                       notes=r.choice(["nginx", "apache", "cpanel", "litespeed", "wordpress", "index", "hostinger"]))
            self._hosting(d, r.choice(["shared", "shared", "cdn"]))
            if cls == "coming_soon" and kind and r.random() < 0.35:
                d.transitions[born + r.randint(1, 3)] = {"activate": r.choice(["hyip", "fake_exchange", "cloud_mining"])}
            return self._add(d)
        if cls == "legit_crypto":
            sub = r.choice(["defi", "blog", "wallet_vendor", "exchange_small", "news_crypto"])
            base = self._fragment_name(r.choice(["invest", "trading", "exchange", "wallet"])) if r.random() < 0.4 else self._brandish().replace("-", "")
            name = self._unique(base, r.choice([".com", ".io", ".org", ".finance", ".xyz"]))
            d = Domain(name, "legit_crypto", False, born, r.uniform(200, 2500), variant=v, notes=sub,
                       wallets=(("ETH", evm_address(r)),) if sub in ("defi", "blog") else ())
            self._hosting(d, r.choice(["cdn", "cdn", "shared"]))
            d.favicon = hashlib.md5(name.encode()).digest() * 3
            return self._add(d, cert_days_ago=r.uniform(1, 80))
        if cls == "informational":
            sub = r.choice(["news", "review", "review", "education", "forum", "monitor"])
            first = r.choice(["scam", "crypto", "fraud", "bitcoin", "coin", "chain", "safe", "trust", "invest", "hyip", "trading"])
            name = self._unique(first + r.choice(["watch", "detector", "alert", "news", "report", "guide", "daily", "insider", "review", "monitor"]),
                                r.choice([".com", ".org", ".net", ".io"]))
            subjects = [x.name for x in self.domains.values() if x.useful]
            d = Domain(name, "informational", False, born, r.uniform(300, 4000), variant=v, notes=sub,
                       subject=r.choice(subjects) if subjects else "novayield.vip")
            if sub == "monitor" and subjects:
                d.extra_links = tuple(r.sample(subjects, min(8, len(subjects))))
            if sub == "review" and subjects:
                victim = self.domains[d.subject]
                d.wallets = victim.wallets[:1]
            self._hosting(d, r.choice(["cdn", "shared"]))
            return self._add(d, cert_days_ago=r.uniform(1, 80))
        if cls == "non_crypto":
            sub = r.choice(["realestate_invest", "trading_company", "currency_exchange", "student_exchange",
                            "wealth_management", "stock_education", "investor_relations"])
            words = {"realestate_invest": ["property", "estate", "homes", "land"], "trading_company": ["global", "import", "steel", "agro"],
                     "currency_exchange": ["fx", "money", "currency", "travel"], "student_exchange": ["student", "youth", "culture", "study"],
                     "wealth_management": ["wealth", "capital", "family", "private"], "stock_education": ["stock", "chart", "market", "swing"],
                     "investor_relations": ["corp", "holdings", "group", "industries"]}[sub]
            frag = {"realestate_invest": "invest", "trading_company": "trading", "currency_exchange": "exchange",
                    "student_exchange": "exchange", "wealth_management": "invest", "stock_education": "trading",
                    "investor_relations": "invest"}[sub]
            base = r.choice([f"{r.choice(words)}{frag}", f"{frag}{r.choice(words)}", f"{r.choice(words)}-{frag}"])
            name = self._unique(base + r.choice(["", "", "-ltd", "group", "partners"]), r.choice(LEGIT_TLDS))
            d = Domain(name, "non_crypto", False, born, r.uniform(100, 5000), variant=v, notes=sub)
            self._hosting(d, r.choice(["cdn", "shared", "shared"]))
            return self._add(d, cert_days_ago=r.uniform(1, 80))
        if cls == "pr_article":
            subjects = [x.name for x in self.domains.values() if x.useful]
            name = self._unique(r.choice(["crypto", "fintech", "coin", "market", "block"]) + r.choice(["wire", "press", "newsroom", "pr", "journal"]),
                                r.choice([".com", ".net", ".io"]))
            d = Domain(name, "pr_article", False, born, r.uniform(300, 3000), variant=v,
                       subject=r.choice(subjects) if subjects else "novayield.vip")
            self._hosting(d, "cdn")
            return self._add(d, cert_days_ago=r.uniform(1, 80))
        if cls == "script_demo":
            name = self._unique(r.choice(["exchange", "trading", "coin", "crypto"]) + r.choice(["script", "software", "whitelabel", "demo"]),
                                r.choice([".com", ".net", ".io", ".xyz"]))
            d = Domain(name, "script_demo", False, born, r.uniform(200, 1500), variant=v)
            self._hosting(d, r.choice(["cdn", "shared"]))
            return self._add(d, cert_days_ago=r.uniform(1, 80))
        if cls == "parked_unknown":
            kind = r.choice(["invest", "trading", "exchange", "mining", "wallet"])
            name = self._unique(self._fragment_name(kind), r.choice(SCAM_TLDS))
            d = Domain(name, "parked", False, born, r.uniform(0.5, 60), variant=v, notes="unknown")
            self._hosting(d, "shared")
            return self._add(d)
        if cls == "generic":
            name = self._unique(r.choice(["bakery", "plumbing", "studio", "photo", "garden", "dental", "yoga", "auto", "cafe", "design"]) +
                                r.choice(["hub", "pro", "house", "works", "co", "lab", "spot"]), r.choice(LEGIT_TLDS))
            d = Domain(name, "generic", False, born, r.uniform(1, 3000), variant=v)
            self._hosting(d, r.choice(["cdn", "shared", "shared"]))
            return self._add(d)
        raise ValueError(cls)

    def _births(self, rnd: int, backlog: bool = False):
        s = self.scale * (3.0 if backlog else 1.0)
        plan = {
            "hyip": 3, "pig_shell": 4, "fake_exchange": 3, "cloud_mining": 2,
            "phishing_impersonation": 2, "recovery_scam": 1,
            "parked": 45, "for_sale": 10, "dead": 35, "placeholder": 25, "suspended": 5, "coming_soon": 8,
            "legit_crypto": 8, "informational": 10, "non_crypto": 45, "generic": 20,
        }
        if self.stress:
            plan.update({"pr_article": 5, "script_demo": 3, "parked_unknown": 12})
        order = []
        for cls, n in plan.items():
            count = int(round(n * s * self.rng.uniform(0.7, 1.3)))
            order += [cls] * count
        self.rng.shuffle(order)
        for cls in order:
            if cls in POSITIVE_CLASSES:
                existing = [k for k, v in self._kits.items() if v["cls"] == cls and v["members"]]
                if existing and self.rng.random() < 0.45:
                    kid = self.rng.choice(existing)
                    self._positive(rnd, cls, kit=kid, same_wallets=self.rng.random() < 0.55)
                else:
                    self._positive(rnd, cls)
            else:
                self._negative(rnd, cls)
        # the feed learns about some live scams a round or two late
        live = [d for d in self.domains.values() if d.useful and d.born_round < rnd]
        for d in self.rng.sample(live, min(len(live), int(3 * self.scale))):
            url = f"https://{d.name}/"
            if url not in self.feed:
                self.feed.append(url)

    def advance(self):
        """Move to the next round (one simulated day): new registrations and state changes."""
        self.round += 1
        for d in list(self.domains.values()):
            change = d.transitions.pop(self.round, None)
            if not change:
                continue
            if "activate" in change:
                cls = change["activate"]
                kid = self._new_kit(cls)
                k = self._kits[kid]
                d.cls, d.useful, d.kit, d.variant = cls, True, kid, k["variant"]
                d.wallets, d.favicon = k["wallets"], k["favicon"]
                d.brand = k["stem"].capitalize()
                self._hosting(d, f"kit:{kid}")
                k["members"].append(d.name)
                d.notes = "activated"
                self._issue([d.name, "www." + d.name], 0.2)
            else:
                for key, value in change.items():
                    setattr(d, key, value)
        self._births(self.round)

    # ------------------------------------------------------------ ground truth
    def truth(self, domain: str) -> Domain | None:
        host = domain.lower().strip(".")
        if host in self.domains:
            return self.domains[host]
        parts = host.split(".")
        for i in range(1, len(parts) - 1):
            cand = ".".join(parts[i:])
            if cand in self.domains:
                return self.domains[cand]
        return None

    # ------------------------------------------------------------------ DNS
    def resolve(self, host: str) -> str | None:
        host = host.lower().rstrip(".")
        d = self.truth(host)
        if not d or not d.resolves:
            return None
        sub = host[: -len(d.name)].rstrip(".")
        if sub and sub not in ("www", "mail", "webmail", "cpanel", "webdisk", "cpcalendars", "cpcontacts", "autodiscover", "api", "m", "h5"):
            return None
        return d.ip

    def nameservers(self, host: str) -> list:
        d = self.truth(host)
        return list(d.ns) if d and d.resolves else []

    # ------------------------------------------------------------------ HTTP
    def http(self, url: str) -> dict:
        """Returns {status, headers, body(bytes), redirect(url|None), error(str|None)}."""
        p = urlparse(url)
        host = (p.hostname or "").lower()
        if host == "crt.sh":
            return self._crtsh(p)
        if host == "rdap.org":
            return self._rdap(p)
        if host == "passivedns.example.test":
            return self._passive_dns(p)
        if host == "feeds.example-reports.test":
            return {"status": 200, "headers": {"content-type": "application/json"},
                    "body": json.dumps([{"url": u, "reported": "community"} for u in self.feed]).encode(),
                    "redirect": None, "error": None}
        if not self.resolve(host):
            return {"error": "dns"}
        d = self.truth(host)
        sub = host[: -len(d.name)].rstrip(".")
        if d.failure == "refused":
            return {"error": "refused"}
        if d.failure == "timeout":
            return {"error": "timeout"}
        if d.failure == "tls" and p.scheme == "https":
            return {"error": "tls"}
        if d.failure.startswith("http:"):
            code = int(d.failure.split(":")[1])
            return {"status": code, "headers": {"content-type": "text/html"}, "body": self._error_page(code, host).encode(),
                    "redirect": None, "error": None}
        if p.path.endswith("favicon.ico"):
            if d.favicon:
                return {"status": 200, "headers": {"content-type": "image/x-icon"}, "body": d.favicon, "redirect": None, "error": None}
            return {"status": 404, "headers": {}, "body": b"not found", "redirect": None, "error": None}
        if p.path.endswith(".js"):
            return {"status": 200, "headers": {"content-type": "application/javascript"},
                    "body": _bundle(self, d).encode(), "redirect": None, "error": None}
        if d.redirect_to:
            return {"status": 301, "headers": {"location": d.redirect_to}, "body": b"", "redirect": d.redirect_to, "error": None}
        if sub in ("cpanel", "webdisk", "cpcalendars", "cpcontacts") and d.cpanel:
            return self._page(200, "<html><head><title>cPanel Login</title></head><body><div id='login-wrapper'><h1>cPanel</h1><form action='/login/?login_only=1' method='post'><label>Username</label><input name='user'><label>Password</label><input type='password' name='pass'><button>Log in</button></form><a href='/resetpass'>Reset Password</a></div></body></html>")
        if sub in ("webmail", "mail") and d.cpanel:
            return self._page(200, "<html><head><title>Roundcube Webmail :: Welcome to Roundcube Webmail</title></head><body><form><label>Username</label><input name='_user'><label>Password</label><input type='password'><button>Login</button></form><p>Roundcube Webmail</p></body></html>")
        if sub == "autodiscover":
            return {"status": 401, "headers": {}, "body": b"Unauthorized", "redirect": None, "error": None}
        return self._page(200, render(self, d, host))

    @staticmethod
    def _page(status, html):
        return {"status": status, "headers": {"content-type": "text/html; charset=utf-8"}, "body": html.encode("utf-8"), "redirect": None, "error": None}

    @staticmethod
    def _error_page(code, host):
        if code in (521, 522):
            return (f"<html><head><title>{host} | {code}: Web server is down</title></head><body><h1>Web server is down</h1>"
                    f"<span>Error code {code}</span><p>Visit cloudflare.com for more information.</p><p>Cloudflare Ray ID: 8a1b2c3d</p></body></html>")
        return f"<html><head><title>{code}</title></head><body><h1>{code}</h1><p>The requested URL was not found on this server.</p></body></html>"

    def _crtsh(self, p) -> dict:
        q = parse_qs(p.query)
        pattern = unquote((q.get("q") or q.get("identity") or [""])[0]).lower()
        if not pattern:
            return {"status": 200, "headers": {}, "body": b"[]", "redirect": None, "error": None}
        rx = re.compile("^" + re.escape(pattern).replace("%", ".*") + "$")
        out = []
        for cert in reversed(self.certs):          # newest first
            if cert["_born_round"] > self.round:
                continue
            names = cert["name_value"].split("\n")
            if any(rx.match(n) for n in names) or ("%" in pattern and any(rx.match(n.split(".", 1)[-1]) for n in names)):
                out.append({k: v for k, v in cert.items() if not k.startswith("_")})
            if len(out) >= 999:
                break
        return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(out).encode(), "redirect": None, "error": None}

    def _passive_dns(self, p) -> dict:
        """Simulated passive DNS: names seen resolving to an IP / delegated to a nameserver so far."""
        parts = [unquote(x) for x in p.path.strip("/").split("/")]
        kind, value = (parts + ["", ""])[:2]
        out = []
        for d in self.domains.values():
            if d.born_round > self.round or not d.resolves:
                continue
            if (kind == "ip" and d.ip == value) or (kind == "ns" and value in d.ns):
                out.append(d.name)
        return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(sorted(out)).encode(), "redirect": None, "error": None}

    def _rdap(self, p) -> dict:
        name = p.path.rstrip("/").split("/")[-1].lower()
        d = self.domains.get(name)
        if not d:
            return {"status": 404, "headers": {}, "body": b"{}", "redirect": None, "error": None}
        age = d.registered_days_ago + (self.round - max(0, d.born_round))
        created = (self.now - _dt.timedelta(days=age)).strftime("%Y-%m-%dT%H:%M:%SZ")
        body = {"objectClassName": "domain", "ldhName": name,
                "events": [{"eventAction": "registration", "eventDate": created}],
                "nameservers": [{"ldhName": n} for n in d.ns]}
        return {"status": 200, "headers": {"content-type": "application/rdap+json"}, "body": json.dumps(body).encode(), "redirect": None, "error": None}


# ---------------------------------------------------------------------------
# Page rendering
# ---------------------------------------------------------------------------

def _money(rng):
    return f"{rng.randint(1, 48)},{rng.randint(100, 999)},{rng.randint(100, 999)}"


def _wallet_block(d: Domain, rng, style: int) -> str:
    if not d.wallets:
        return ""
    net, addr = d.wallets[0]
    if style == 0:
        return f"<div class='pay'><h4>Deposit Address ({net})</h4><code>{addr}</code><button>Copy address</button><p>Only send {net.split('-')[0]} to this address. Minimum deposit 50 USDT.</p></div>"
    if style == 1:
        return f"<p>Send payment to our wallet address: <b>{addr}</b> (network: {net})</p>"
    return f"<div class='qr'><img src='/qr.png'><span>Recharge address</span><input value='{addr}' readonly> <small>{net}</small></div>"


def render(world: World, d: Domain, host: str) -> str:
    rng = random.Random(f"{world.seed}:{d.name}:{d.cls}:{d.kit}")
    if d.notes == "stealth":
        return _stealth(world, d, rng)
    if d.cls == "parked" and d.notes == "unknown":
        return _shell(d.name, f"<h1>{d.name}</h1><p>This domain is available for purchase. Contact the owner: owner@{d.name}</p>"
                              "<h3>Popular categories</h3><ul><li>Crypto Wallets</li><li>Bitcoin Investment</li><li>Trading Signals</li></ul>")
    fn = RENDERERS.get(d.cls, _render_generic)
    return fn(world, d, rng)


def _shell(title, body, head_extra=""):
    return (f"<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><title>{title}</title>"
            f"<meta name='viewport' content='width=device-width, initial-scale=1'>{head_extra}</head><body>{body}</body></html>")


def _render_hyip(w, d, rng):
    b = d.brand
    v = d.variant
    if v == 0:
        plans = "".join(f"<tr><td>{n}</td><td>${lo} - ${hi}</td><td>{p}% daily for {days} days</td></tr>" for n, lo, hi, p, days in
                        [("Starter", 50, 999, rng.choice([1.8, 2.2, 2.5]), 30), ("Advanced", 1000, 4999, rng.choice([3, 3.5]), 45), ("VIP", 5000, 50000, rng.choice([4.5, 5]), 60)])
        body = (f"<header><a href='/'>{b} Capital</a><a href='?a=signup'>Sign Up</a><a href='?a=login'>Login</a></header>"
                f"<h1>Welcome to {b} Capital Limited</h1><p>{b} is a UK registered company offering a profitable investment platform powered by crypto arbitrage and forex trading. "
                f"We guarantee stable daily profit for our investors.</p><table><tr><th>Plan</th><th>Deposit</th><th>Profit</th></tr>{plans}</table>"
                f"<p>Principal return: Yes. Referral commission 7% - 3% - 1%.</p><div class='stats'>Total Accounts: {rng.randint(3000, 90000)} · Total Deposited: ${_money(rng)} · Total Withdrawals: ${_money(rng)} · Online: {rng.randint(200, 3000)}</div>"
                f"<h3>Last Deposits</h3><ul><li>jam***{rng.randint(10, 99)} $500 Tether TRC20</li><li>alex***{rng.randint(10, 99)} $1,200 Bitcoin</li></ul>"
                f"<p>We accept: Bitcoin, Tether (USDT TRC20), Ethereum, Litecoin</p>{_wallet_block(d, rng, 1) if rng.random() < .5 else ''}"
                f"<footer>Company No. {rng.randint(10000000, 13999999)} · support@{d.name} · Telegram: @{b}Support</footer>")
        return _shell(f"{b} Capital - Profitable Investment Platform", body)
    if v == 1:
        body = (f"<nav>{b} AI <a href='/login'>Log in</a> <a href='/register'>Get started</a></nav>"
                f"<h1>AI-powered arbitrage. Earn up to {rng.choice(['3.2', '4.2', '5.5'])}% every day.</h1><p>Start with just 100 USDT. Our quantitative bots trade across 30 exchanges so you don't have to.</p>"
                f"<ul><li>Withdraw anytime, processed within 24 hours</li><li>Invite friends and get a 10% referral bonus</li><li>VIP levels unlock higher daily returns</li></ul>"
                f"<p>Contact our customer service on WhatsApp +44 7{rng.randint(100000000, 999999999)} or Telegram</p>"
                f"{_wallet_block(d, rng, 0) if rng.random() < .4 else ''}<p>Licensed and regulated. 100% safe and secure.</p>")
        return _shell(f"{b} AI - Smart Crypto Earnings", body)
    if v == 2:
        body = (f"<div class='hero'><h2>{b} Staking Pool</h2><p>Lock USDT and receive {rng.choice(['1.6', '1.8', '2.1'])}% every 24h. Principal returned at maturity.</p>"
                f"<a class='btn' href='/#/pages/login/register'>Join now</a></div>"
                f"<section><h3>Membership</h3><p>VIP1 — 100 USDT · VIP2 — 1,000 USDT · VIP3 — 5,000 USDT · VIP6 — 50,000 USDT</p><p>Invite friends and earn 12% of their income. Team rewards paid daily.</p></section>"
                f"<section><h3>How to recharge</h3><p>Transfer USDT (TRC20) to the platform address below, then upload your transfer screenshot.</p>{_wallet_block(d, rng, 2)}</section>"
                f"<p>Online service 24/7 · <a href='https://t.me/{b.lower()}_service'>Official Telegram</a></p>")
        return _shell(f"{b} | Earn Daily", body)
    body = (f"<h1>欢迎来到 {b} · Welcome to {b}</h1><p>USDT 理财 — 每日收益 {rng.choice(['2.5', '3.0', '1.9'])}% · Daily income, auto-compounding</p>"
            f"<p>产品 Products: 7天 7-day (1.5%/day) · 15天 15-day (2.2%/day) · 30天 30-day (3.0%/day)</p><p>提现 Withdrawal: 24h. 推荐奖励 Referral reward 15%.</p>"
            f"<p>在线客服 Online customer service</p>{_wallet_block(d, rng, 2) if rng.random() < .6 else ''}"
            f"<div id='app'></div><script src='/static/js/app.{rng.randint(1000, 9999)}.js'></script>")
    return _shell(f"{b} 理财", body)


def _render_pig_shell(w, d, rng):
    b = d.brand
    v = d.variant
    k = w._kits.get(d.kit, {})
    if v == 0:
        return (f"<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,user-scalable=no,initial-scale=1'>"
                f"<title>{b}</title><meta name='keywords' content='digital currency exchange,Bitcoin,contract trading,{b}'>"
                f"<link rel=stylesheet href=/h5/static/index.{rng.randint(1000, 9999)}.css></head><body>"
                f"<noscript><strong>Please enable JavaScript to continue.</strong></noscript><div id=app></div>"
                f"<script src=/h5/static/js/chunk-vendors.{rng.randint(10000, 99999)}.js></script><script src=/h5/static/js/index.{rng.randint(10000, 99999)}.js></script></body></html>")
    if v == 1:
        return _shell(f"{b} - Login",
                      f"<div class='login'><img src='/static/logo.png'><h2>Welcome to {b}</h2><form><input placeholder='Mobile number / Email'><input type='password' placeholder='Password'>"
                      f"<input placeholder='Invitation code (optional)'><button>Login</button></form><a href='/register'>Register</a> <a href='/forget'>Forgot password?</a>"
                      f"<div class='ticker'>BTC/USDT 67,213.4 +2.1% · ETH/USDT 3,412.8 -0.4% · SOL/USDT 171.2 +5.6%</div><a href='/service'>Online Customer Service</a> <a href='/download'>Download APP</a></div>")
    if v == 2:
        return _shell(f"{b} Global",
                      f"<div class='tabbar'><a>Home</a><a>Market</a><a>Seconds contract</a><a>Options</a><a>Assets</a></div>"
                      f"<div class='quick'><a href='/recharge'>Recharge</a><a href='/withdraw'>Withdraw</a><a href='/mining'>Mining</a><a href='/loan'>Loan</a><a href='/service'>Customer service</a></div>"
                      f"<div class='notice'>Welcome to {b}. Please complete real-name authentication before withdrawal.</div>"
                      f"<div class='markets'>BTC/USDT ETH/USDT DOGE/USDT</div><p>Invite code: {rng.randint(100000, 999999)}</p>")
    return (f"<!DOCTYPE html><html><head><meta charset=utf-8><title>{b}</title>"
            f"<script>window.__CONFIG__={{apiUrl:'https://api.{d.name}',ws:'wss://ws.{d.name}',service:'https://{k.get('service', 'chat.example.top')}/chat?cid={rng.randint(1000, 9999)}'}}</script>"
            f"<script src='https://embed.tawk.to/{rng.randint(10**15, 10**16)}/default'></script></head><body><div id='root'>Loading...</div>"
            f"<script src='/assets/index-{rng.randint(10**7, 10**8)}.js'></script></body></html>")


def _render_fake_exchange(w, d, rng):
    b = d.brand
    v = d.variant
    rows = "".join(f"<tr><td>{c}/USDT</td><td>{rng.uniform(0.1, 70000):.2f}</td><td>{rng.uniform(-5, 9):+.2f}%</td></tr>" for c in ["BTC", "ETH", "BNB", "XRP", "SOL"])
    if v in (0, 2):
        body = (f"<nav>{b}Ex · Markets · Futures · Earn · <a href='/login'>Log In</a> <a href='/register'>Register</a></nav>"
                f"<h1>Trade 300+ cryptocurrencies on {b}{'Ex' if v == 0 else ' Exchange'}</h1><table>{rows}</table>"
                f"<section><h3>FAQ</h3><p>Why is my withdrawal pending? Withdrawals above 5,000 USDT require payment of the {rng.choice([10, 15, 20])}% income tax before release.</p>"
                f"<p>How do I deposit? Go to Assets → Deposit and send USDT to your deposit address.</p></section>"
                f"<p>{b} is licensed by US MSB (FinCEN) and fully insured. VIP levels 1-8 with lower fees.</p>{_wallet_block(d, rng, 0) if rng.random() < .35 else ''}"
                f"<footer>Customer support: <a href='https://t.me/{b.lower()}_cs'>Telegram</a></footer>")
        return _shell(f"{b} | Buy & Sell Crypto", body)
    body = (f"<div id='header'><b>{b}</b> Exchange <a href='/#/login'>Sign in</a></div><div class='banner'>New user bonus: deposit 1,000 USDT and receive a 30% trading bonus!</div>"
            f"<table>{rows}</table><p>Smart contract trading with 1-minute settlement. Profit up to 85% per trade.</p>"
            f"<p>To unlock withdrawal, your account must reach VIP2 and pay the security deposit.</p><p>Contact customer service for your exclusive recharge address.</p>")
    return _shell(f"{b} Exchange", body)


def _render_cloud_mining(w, d, rng):
    b = d.brand
    plans = "".join(f"<li>{n}: ${p} contract — {days} days — ${daily}/day</li>" for n, p, days, daily in
                    [("Trial", 10, 1, "0.60"), ("Basic", 100, 2, "3.80"), ("Pro", 1000, 7, "42"), ("Elite", 10000, 30, "520")])
    body = (f"<h1>{b} Cloud Mining — start mining Bitcoin today</h1><p>No hardware needed. Register and get a free $10 bonus. Earnings paid daily to your account balance.</p>"
            f"<ul>{plans}</ul><p>Withdraw once your balance reaches $100. Refer friends and earn 3% commission.</p>"
            f"{_wallet_block(d, rng, 1) if rng.random() < .4 else ''}<p>Powered by renewable energy · Contact: support@{d.name}</p>")
    return _shell(f"{b} Cloud Mining", body)


def _render_phishing(w, d, rng):
    brand = d.brand if d.brand in BRANDS else rng.choice(list(BRANDS))
    title = brand.capitalize()
    if d.variant % 2 == 0:
        body = (f"<img src='/assets/{brand}-logo.svg'><h2>Account verification required</h2><p>Unusual activity was detected on your {title} account. "
                f"Your withdrawals have been restricted. Verify your identity within 24 hours to avoid permanent suspension.</p>"
                f"<form action='/api/verify' method='post'><input type='email' placeholder='Email'><input type='password' placeholder='Password'><button>Log In</button></form>")
        return _shell(f"{title} - Log In", body)
    body = (f"<h1>{title} Wallet Sync</h1><p>Your wallet requires validation to continue receiving rewards. Connect your wallet or import it manually.</p>"
            f"<form><textarea placeholder='Enter your 12 or 24 word recovery phrase'></textarea><button>Validate wallet</button></form>"
            f"<p>Claim your pending airdrop now — offer ends soon.</p>")
    return _shell(f"{title} | Validate Wallet", body)


def _render_recovery(w, d, rng):
    b = d.brand
    body = (f"<h1>{b} Recovery — get your stolen crypto back</h1><p>Lost funds to a fake investment platform? Our certified blockchain forensics agents recover Bitcoin and USDT from scammers.</p>"
            f"<p>98% success rate. No recovery, no fee. Contact our agents on WhatsApp or Telegram today.</p><p>Consultation fee payable in USDT to our wallet.</p>{_wallet_block(d, rng, 1) if rng.random() < .3 else ''}")
    return _shell(f"{b} Crypto Recovery Experts", body)


def _render_parked(w, d, rng):
    prov = d.notes
    name = d.name
    related = rng.sample(["Crypto Investment", "Bitcoin Trading", "Best Crypto Exchange", "Deposit Bonus Casino",
                          "Telegram Crypto Groups", "Daily Profit Apps", "USDT Wallet", "Online Trading Platform",
                          "Investment Plans", "Forex Signals", "Cloud Mining", "Withdraw Bitcoin"], 5)
    links = "".join(f"<li><a href='/?q={x.replace(' ', '+')}'>{x}</a></li>" for x in related)
    if prov == "sedo":
        return _shell(name, f"<div id='sedo'><h1>{name}</h1><p>This domain may be for sale!</p><h3>Related Searches</h3><ul>{links}</ul></div>"
                             f"<script src='https://www.sedoparking.com/frmpark/{name}/IN/park.js'></script><p>Buy this domain on Sedo</p>")
    if prov == "bodis":
        return _shell(name, f"<div id='target'></div><script>window.park = '{hashlib.md5(name.encode()).hexdigest()}';</script>"
                             f"<script src='https://parking.bodiscdn.com/js/main.js'></script>" + (f"<ul>{links}</ul>" if d.variant % 2 else ""))
    if prov == "parkingcrew":
        return _shell(name, f"<div class='container'><h1>{name}</h1><h2>Related Links</h2><ul>{links}</ul></div><script src='//www.parkingcrew.net/assets/scripts/parking.js'></script>"
                             f"<p>Privacy Policy · This page is provided by the domain owner.</p>")
    if prov == "godaddy":
        return _shell(name, f"<h1>{name}</h1><p>This domain is parked free, courtesy of GoDaddy.com.</p><a href='https://www.godaddy.com'>Get This Domain</a><h3>Sponsored Listings</h3><ul>{links}</ul>")
    if prov == "namecheap":
        return _shell(name, f"<h1>{name}</h1><p>This domain is registered at Namecheap. This domain was recently registered at Namecheap. Please check back later!</p>")
    if prov == "dan":
        return _shell(f"{name} is for sale", f"<h1>{name} is for sale!</h1><p>Buy now for ${rng.randint(9, 99)*100}</p><p>Or make an offer. Fast and safe transfer: Buyer Protection Program, risk-free transaction via escrow.</p><p>Secure checkout · Lease to own available</p>")
    if prov == "afternic":
        return _shell(f"{name} - domain for sale", f"<h1>The domain {name} is for sale</h1><p>Get this domain. Price: ${rng.randint(10, 90)*100}. Secure, hassle-free transfer. Money-back guarantee.</p><p>Powered by Afternic</p>")
    return _shell(name, f"<h1>{name}</h1><ul>{links}</ul>")


def _render_placeholder(w, d, rng):
    kind = d.notes
    if kind == "nginx":
        return "<!DOCTYPE html><html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p><p><em>Thank you for using nginx.</em></p></body></html>"
    if kind == "apache":
        return "<html><head><title>Apache2 Ubuntu Default Page: It works</title></head><body><h1>Apache2 Ubuntu Default Page</h1><p>It works!</p><p>This is the default welcome page used to test the correct operation of the Apache2 server after installation on Ubuntu systems.</p></body></html>"
    if kind == "cpanel":
        return "<html><head><title>Default Web Site Page</title></head><body><h1>Default Web Site Page</h1><p>If you are the owner of this website, please contact your hosting provider.</p><p>cPanel, L.L.C.</p></body></html>"
    if kind == "litespeed":
        return "<html><head><title>Web Server's Default Page</title></head><body><h1>Congratulations!</h1><p>This page is used to test the proper operation of the LiteSpeed Web Server.</p></body></html>"
    if kind == "wordpress":
        return _shell(f"{d.name.split('.')[0].title()} – Just another WordPress site", "<h2>Hello world!</h2><p>Welcome to WordPress. This is your first post. Edit or delete it, then start writing!</p><p>Proudly powered by WordPress</p>")
    if kind == "index":
        return f"<html><head><title>Index of /</title></head><body><h1>Index of /</h1><pre><a href='cgi-bin/'>cgi-bin/</a></pre><address>Apache Server at {d.name} Port 443</address></body></html>"
    return _shell("Parked Domain name on Hostinger DNS system", "<h1>This domain is parked</h1><p>Hostinger: the domain is not connected to a website yet.</p>")


def _render_coming_soon(w, d, rng):
    b = d.name.split(".")[0].replace("-", " ").title()
    if d.variant % 2 == 0:
        return _shell(f"{b} - Coming Soon", f"<h1>{b}</h1><h2>Coming soon</h2><p>The next generation crypto trading platform is launching soon. Limited time: first 500 users get VIP access.</p>"
                                           f"<p>Join our Telegram channel for early access: t.me/{b.replace(' ', '').lower()}</p><form><input placeholder='Email'><button>Notify me</button></form>")
    return _shell(f"{b} | Under Construction", f"<h1>Under construction</h1><p>Our website is under construction. We'll be here soon with our new awesome site.</p><div class='countdown'>12 days 04:11:09</div>")


def _render_suspended(w, d, rng):
    return "<html><head><title>Account Suspended</title></head><body><h1>Account Suspended</h1><p>This Account has been suspended.</p><p>Contact your hosting provider for more information.</p></body></html>"


def _render_legit_crypto(w, d, rng):
    if d.notes == "official":
        b = d.brand.capitalize()
        return _shell(f"{b} - The world's leading crypto platform",
                      f"<nav>Buy Crypto · Markets · Trade · Earn · <a href='/login'>Log In</a> <a href='/register'>Sign Up</a></nav><h1>Buy, trade and hold 350+ cryptocurrencies on {b}</h1>"
                      f"<p>Deposit with bank transfer or card. Withdraw to any wallet. Fees as low as 0.1%.</p><p>VIP program for high-volume traders. Referral program: invite friends and earn up to 40% commission.</p>"
                      f"<p>Simple Earn: staking rewards up to 8% APR on selected assets.</p><footer>Community: <a href='https://t.me/{d.brand}'>Telegram</a> · X · Discord · <a href='/legal'>Licenses</a></footer>")
    b = d.name.split(".")[0].title()
    sub = d.notes
    if sub == "defi":
        addr = d.wallets[0][1] if d.wallets else evm_address(rng)
        return _shell(f"{b} Docs", f"<h1>{b} Protocol</h1><p>{b} is a decentralized liquidity protocol. Deposit assets into pools to earn staking rewards (current APY {rng.uniform(2, 9):.1f}%). Withdraw at any time.</p>"
                                     f"<h3>Contract addresses</h3><p>Router: <code>{addr}</code></p><p>Audited by two independent firms. Join the community on Telegram and Discord.</p><p>Risk disclosure: smart contracts carry risk.</p>")
    if sub == "blog":
        addr = d.wallets[0][1] if d.wallets else evm_address(rng)
        return _shell(f"{b} — notes on Bitcoin and Ethereum", f"<article><h1>Understanding self-custody</h1><p>Hardware wallets, seed phrases and why you should never share your recovery phrase.</p></article>"
                                                            f"<aside>If you enjoy this blog, donations are welcome: <code>{addr}</code></aside><p>Follow me on Telegram for new posts.</p>")
    if sub == "wallet_vendor":
        return _shell(f"{b} Hardware Wallet", f"<h1>{b} — secure cold storage</h1><p>Buy the {b} One. Ships worldwide. 30-day money-back guarantee.</p><p>Deposit and withdraw directly from our companion app.</p>")
    if sub == "exchange_small":
        return _shell(f"{b} — regulated crypto broker", f"<h1>{b}</h1><p>Registered with the FCA as a cryptoasset firm (FRN {rng.randint(900000, 999999)}). Buy Bitcoin with GBP. Deposit by Faster Payments; withdraw to your bank.</p><p>Crypto is high risk; you may lose all your money.</p>")
    return _shell(f"{b} Crypto News", f"<h1>{b}: Bitcoin climbs as ETF inflows continue</h1><p>Markets overview, exchange listings and on-chain analysis. Subscribe to our Telegram channel.</p>")


def _render_informational(w, d, rng):
    b = d.name.split(".")[0].title()
    sub = d.notes
    subject = d.subject
    if sub == "news":
        return _shell(f"Police warn of 'pig butchering' crypto investment scams | {b}",
                      f"<article><h1>Police warn of 'pig butchering' crypto investment scams</h1><p>Victims are contacted on WhatsApp or Telegram and persuaded to deposit USDT on fake trading platforms promising guaranteed daily profit of 3%.</p>"
                      f"<p>When they try to withdraw, they are told to pay a 'tax fee to withdraw' or 'unlock withdrawal' fee. Police said sites such as {subject} had been reported.</p>"
                      f"<p>Never send crypto to someone you met online. Report fraud to your local police.</p></article>")
    if sub == "review":
        addr = d.wallets[0][1] if d.wallets else ""
        return _shell(f"Is {subject} a scam? Review & trust score | {b}",
                      f"<h1>{subject} review: is it legit or a scam?</h1><div class='score'>Trust score: {rng.randint(1, 20)}/100</div>"
                      f"<h3>Red flags</h3><ul><li>Promises guaranteed returns of 2.5% daily</li><li>Telegram support only</li><li>VIP level investment plans and referral bonus</li><li>Users report a withdrawal fee required before payout</li></ul>"
                      + (f"<p>Deposit address reported by users: <code>{addr}</code> (network: TRC20)</p>" if addr else "") +
                      "<p>Our verdict: avoid. Read user comments below.</p><div class='comments'>Lost 2000 USDT, they asked me to recharge again...</div>")
    if sub == "education":
        return _shell(f"How to deposit USDT (TRC20) to an exchange – {b}",
                      f"<h1>How to deposit USDT on TRC20 safely</h1><ol><li>Open the exchange and go to Wallet → Deposit.</li><li>Select USDT and the TRC20 network.</li><li>Copy your deposit address.</li><li>Paste it into your sending wallet; always double-check.</li></ol>"
                      f"<p>Warning: be careful with platforms promising daily profit or guaranteed returns — those are scams.</p>")
    if sub == "monitor":
        rows = "".join(f"<tr><td><a href='https://{x}/' rel='nofollow'>{x}</a></td><td>{rng.choice(['Paying', 'Paying', 'Waiting', 'Problem'])}</td><td>{rng.choice(['2.5% daily', '3% daily for 30 days', '120% after 7 days'])}</td></tr>" for x in d.extra_links)
        return _shell(f"{b} - HYIP Monitor | Paying programs",
                      f"<h1>HYIP Monitor</h1><p>We monitor high-yield investment programs and report their payout status. We do not guarantee any program. Invest only what you can afford to lose.</p>"
                      f"<table><tr><th>Program</th><th>Status</th><th>Plans</th></tr>{rows}</table><p>Add your program: listing from $50. Contact via Telegram.</p>")
    return _shell(f"Anyone used {subject}? - Crypto Forum", f"<h2>Anyone used {subject}? withdrawal stuck</h2><p>They keep asking me to pay a fee to withdraw. Customer service on telegram stopped replying.</p><p>Reply: it's a scam, report it.</p>")


def _render_non_crypto(w, d, rng):
    b = d.name.split(".")[0].replace("-", " ").title()
    sub = d.notes
    if sub == "realestate_invest":
        return _shell(f"{b} | Property Investment", f"<h1>{b}</h1><p>Buy-to-let property investment across the UK. Typical rental yields 5-7% per year. Book a call with our advisers.</p><p>Capital at risk. Contact us on WhatsApp.</p>")
    if sub == "trading_company":
        return _shell(f"{b} Co., Ltd", f"<h1>{b} Co., Ltd — import & export</h1><p>Steel, agricultural commodities and machinery. Deposit of 30% required on orders, balance before shipment.</p><p>WhatsApp: +86 13{rng.randint(100000000, 999999999)}</p>")
    if sub == "currency_exchange":
        return _shell(f"{b} Currency Exchange", f"<h1>Travel money at the best rates</h1><p>Exchange GBP to EUR and USD. Order online and collect in store. Rates guaranteed for 24 hours.</p>")
    if sub == "student_exchange":
        return _shell(f"{b} Student Exchange Programme", f"<h1>Study abroad for a semester</h1><p>Our youth exchange programme places students with host families. Deposit required to secure your place; refundable.</p>")
    if sub == "wealth_management":
        return _shell(f"{b} Wealth Management", f"<h1>Private wealth management</h1><p>Discretionary portfolio management for families and entrepreneurs. Authorised and regulated by the Financial Conduct Authority.</p><p>The value of investments can fall as well as rise.</p>")
    if sub == "stock_education":
        return _shell(f"{b} Trading Academy", f"<h1>Learn swing trading</h1><p>Courses on chart patterns and risk management. Limited time offer: 40% off. Join our Telegram group for daily analysis.</p><p>No returns are guaranteed.</p>")
    return _shell(f"{b} Investor Relations", f"<h1>Investor relations</h1><p>Annual report, dividend history and shareholder information.</p>")


def _render_pr_article(w, d, rng):
    subject = d.subject
    brand = subject.split(".")[0].replace("-", " ").title()
    return _shell(f"{brand} Launches AI Trading Platform Offering Daily Returns | {d.name.split('.')[0].title()}",
                  f"<article><p>PRESS RELEASE</p><h1>{brand} launches AI-powered crypto platform</h1>"
                  f"<p>{brand}, a leading fintech company, today announced the launch of its AI quantitative platform offering users "
                  f"up to {rng.choice(['1.8', '2.5', '3'])}% daily returns. Users can deposit USDT and withdraw anytime.</p>"
                  f"<p>Visit {subject} to register. Media contact: pr@{subject}</p><p>Disclaimer: this is a paid press release.</p></article>")


def _render_script_demo(w, d, rng):
    b = d.name.split(".")[0].title()
    return _shell(f"{b} — White-label Crypto Exchange Script",
                  f"<h1>Launch your own crypto exchange in 7 days</h1><p>{b} white-label exchange software: spot trading, seconds contract, "
                  f"options trading, mining products, loan module, recharge and withdraw, KYC, invitation code system, online customer service.</p>"
                  f"<p>License from $2,999. Try the live demo — login: demo / demo123.</p><form><input placeholder='Invitation code'></form>"
                  f"<p>Contact sales on Telegram.</p>")


def _stealth(w, d, rng):
    b = d.brand
    return _shell(b, f"<h1>Welcome to {b}</h1><p>Smart quantitative earnings for everyone. Register now and receive 20 USDT experience gold.</p>"
                     f"<a href='/login'>Login</a> <a href='/register'>Register</a><p>Online customer service 24h</p>")


def _bundle(w, d) -> str:
    """A same-origin JavaScript bundle. App shells carry their UI strings here."""
    rng = random.Random(f"{w.seed}:{d.name}:bundle")
    vendor = ("!function(e){var t={};function n(r){if(t[r])return t[r].exports}}([]);"
              "/*! Vue.js v2.6.14 (c) Evan You */" + "var a=1;" * 40)
    if d.cls == "pig_shell":
        strings = ["recharge", "withdraw", "invitationCode", "USDT", "secondsContract", "optionTrade",
                   "realNameAuth", "onlineService", "fundPassword", "assets.total", "kline", "BTC/USDT",
                   "withdrawAddress", "rechargeRecord", "miningProducts", "loanApply"]
        rng.shuffle(strings)
        return vendor + "var i18n={" + ",".join(f"'{s}':'{s}'" for s in strings[:11]) + "};"
    if d.cls in ("legit_crypto",):
        return vendor + "var i18n={'swap':'Swap','pool':'Pool','connectWallet':'Connect wallet','docs':'Docs'};"
    return vendor + "var i18n={'home':'Home','about':'About us','contact':'Contact'};"


def _render_generic(w, d, rng):
    b = d.name.split(".")[0].title()
    return _shell(b, f"<h1>{b}</h1><p>Family-run business since {rng.randint(1970, 2018)}. Call us or visit our shop.</p><p>Opening hours Mon–Sat 9–5.</p>")


def _render_dead(w, d, rng):
    return "<html><body><h1>Service unavailable</h1></body></html>"


RENDERERS = {
    "hyip": _render_hyip, "pig_shell": _render_pig_shell, "fake_exchange": _render_fake_exchange,
    "cloud_mining": _render_cloud_mining, "phishing_impersonation": _render_phishing,
    "recovery_scam": _render_recovery, "parked": _render_parked, "for_sale": _render_parked,
    "placeholder": _render_placeholder, "coming_soon": _render_coming_soon, "suspended": _render_suspended,
    "legit_crypto": _render_legit_crypto, "informational": _render_informational,
    "non_crypto": _render_non_crypto, "generic": _render_generic, "dead": _render_dead,
    "brand_owned_redirect": _render_generic, "pr_article": _render_pr_article, "script_demo": _render_script_demo,
}
