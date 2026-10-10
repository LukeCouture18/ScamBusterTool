"""
Hard gates: the things that make a site not worth opening, whatever else it says.

v1 had no idea a page was parked, for sale, a server default page, a news
article, or a redirect to the brand's real site — and those pages carry
exactly the vocabulary triage counted (deposit, withdraw, Telegram, bonus,
VIP), so they sailed through. Each gate below is one of those failure modes,
with the reason recorded so the advanced view can show it and so a gate that
turns out wrong can be audited.

A gate is a verdict about whether a *person should look now*, never about
the site's legitimacy. Some gates schedule a recheck, because a parked or
coming-soon crypto domain that later goes live is one of the most valuable
things discovery can notice.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.v2 import domains as dm
from app.v2.netio import Snapshot, visible_text, title_of, links

PARKING_STRONG = (
    "sedoparking.com", "parking.bodiscdn.com", "bodiscdn.com", "parkingcrew.net", "above.com/marketplace",
    "parklogic", "is parked free, courtesy of godaddy", "this domain is parked", "domain is parked",
    "recently registered at namecheap", "this domain is registered at namecheap", "window.park",
    "/frmpark/", "domain is not connected to a website", "parked domain name on hostinger",
    "cashparking", "domainparking", "this web page is parked", "parked by", "skenzo",
)
PARKING_WEAK = ("related searches", "related links", "sponsored listings", "sponsored links",
                "privacy policy · this page is provided by the domain owner", "get this domain")
FOR_SALE = ("this domain may be for sale", "is for sale", "domain is for sale", "buy this domain",
            "make an offer", "buy now for $", "lease to own", "afternic", "dan.com", "hugedomains",
            "undeveloped.com", "domain for sale", "brandbucket", "squadhelp", "atom.com")
PARKING_NS = ("sedoparking", "bodis.com", "parkingcrew", "above.com", "dan.com", "afternic",
              "parklogic", "namebrightdns", "dnsowl", "uniregistrymarket", "huge-dns", "hugedomains",
              "ztomy.com", "domainnamesales")
MARKETPLACES = {"dan.com", "afternic.com", "sedo.com", "hugedomains.com", "godaddy.com", "atom.com",
                "undeveloped.com", "squadhelp.com", "brandbucket.com", "namecheap.com"}

PLACEHOLDER = (
    ("welcome to nginx", "server default page"), ("apache2 ubuntu default page", "server default page"),
    ("apache2 debian default page", "server default page"), ("it works!", "server default page"),
    ("iis windows server", "server default page"), ("web server's default page", "server default page"),
    ("default web site page", "hosting default page"), ("index of /", "directory listing"),
    ("just another wordpress site", "fresh WordPress install"), ("this account has been suspended", "hosting account suspended"),
    ("account suspended", "hosting account suspended"), ("website is under construction", "under construction"),
    ("under construction", "under construction"), ("future home of", "placeholder"),
    ("site not found", "not configured"), ("domain not configured", "not configured"),
    ("web server is down", "origin down"), ("error code 52", "origin down"),
    ("there is no website configured at this address", "not configured"),
    ("congratulations! your site is live", "fresh hosting page"), ("hello world!", "fresh WordPress install"),
)
COMING_SOON = ("coming soon", "launching soon", "launching shortly", "notify me", "stay tuned", "we'll be here soon")

INFO_TITLE = re.compile(r"\b(reviews?|is\s.{1,60}\s(legit|a scam|safe|real)|scam alert|warns?|warning|police|"
                        r"how to|guide|explained|news|forum|monitor|complaints?|report(ed)?|anyone used|scam\?)\b", re.I)
INFO_TEXT = ("red flags", "our verdict", "trust score", "reported by users", "report fraud", "never send crypto",
             "how to spot", "we monitor", "paying programs", "we do not guarantee any program", "read user comments",
             "reply:", "victims", "police said", "has been reported", "is a scam", "it's a scam", "beware of",
             "avoid it", "lost my", "report it", "user comments", "scam warning", "we are not affiliated",
             "invest only what you can afford to lose", "are scams", "scammers", "fraudsters", "red flag")

LEGIT_REGULATED = re.compile(
    r"(authori[sz]ed and regulated by the financial conduct authority|frn\s*\d{6}|registered with the fca|"
    r"sec file no|crd\s*#?\s*\d+|finra member|member sipc|regulated by (bafin|cysec|asic|mas)\b|"
    r"licen[cs]e (number|no\.?)\s*[a-z0-9-]{4,})", re.I)
RISK_DISCLOSURE = re.compile(
    r"(capital at risk|can fall as well as rise|you (may|could) lose all (of )?your money|crypto is high risk|"
    r"smart contracts carry risk|risk disclosure|no returns are guaranteed|past performance is not|"
    r"not financial advice)", re.I)

CRYPTO_VOCAB = re.compile(
    r"(bitcoin|\bbtc\b|usdt|tether|ethereum|\beth\b|crypto|blockchain|trc-?20|erc-?20|bep-?20|\btoken|"
    r"wallet|defi|\bnft|binance|coinbase|metamask|digital currency|数字货币|/usdt|satoshi|airdrop|"
    r"\bmining\b|staking|recovery phrase|seed phrase|web3|dapp|kraken|bybit|\bokx\b|kucoin|bitget|ledger|trezor|"
    r"trust ?wallet|phantom|uniswap|pancakeswap|walletconnect|exodus|gemini|bitfinex|huobi|opensea)", re.I)


@dataclass
class Gate:
    verdict: str = ""             # empty = passed
    reason: str = ""
    recheck_rounds: int = 0       # 0 = no scheduled recheck
    effective_url: str = ""       # set when the page lives at another registrable domain
    leads: list = field(default_factory=list)   # domains mentioned/linked (informational pages)
    shell: bool = False           # an SPA shell: evidence lives in the bundle

    @property
    def passed(self) -> bool:
        return not self.verdict


def is_spa_shell(html: str, text: str) -> bool:
    lower = (html or "").lower()
    has_mount = bool(re.search(r"<div[^>]+id=['\"]?(app|root|__nuxt|__next)['\"]?", lower))
    bundles = re.search(r"(chunk-vendors|/static/js/|/assets/index-|/h5/|app\.[0-9a-f]{4,}\.js|index\.[0-9a-f]{4,}\.js|main\.[0-9a-f]{6,}\.js)", lower)
    return has_mount and bool(bundles) and len(text) < 400


def mentioned_domains(html: str, text: str, own: str) -> list:
    found = set()
    for url in links(html):
        reg = dm.registrable(url)
        if reg and reg != own and not dm.is_allowlisted(reg):
            found.add(reg)
    for m in re.finditer(r"\b([a-z0-9][a-z0-9-]{2,40}\.(?:vip|top|xyz|com|net|cc|live|pro|io|org|app|co|club|shop|icu|cfd|finance))\b", text.lower()):
        reg = dm.registrable(m.group(1))
        if reg != own and not dm.is_allowlisted(reg):
            found.add(reg)
    return sorted(found)[:25]


def gate(snap: Snapshot, domain: str, ns: list | None = None, extra_text: str = "") -> Gate:
    ns = ns or []
    if snap.error:
        what = {"dns": "does not resolve", "refused": "refused the connection", "timeout": "timed out",
                "tls": "TLS handshake failed", "error": "could not be fetched"}.get(snap.error, snap.error)
        return Gate("dead", f"Site {what}.", recheck_rounds=4)
    if snap.status is not None and snap.status >= 400:
        return Gate("dead", f"HTTP {snap.status}.", recheck_rounds=4 if snap.status >= 500 else 6)

    final_reg = dm.registrable(snap.final_url or snap.requested_url)
    if final_reg and final_reg != dm.registrable(domain):
        if final_reg in MARKETPLACES:
            return Gate("for_sale", f"Redirects to the domain marketplace {final_reg}.", recheck_rounds=6)
        if dm.is_allowlisted(final_reg):
            return Gate("redirect_legit", f"Redirects to {final_reg}, a known legitimate site (likely a defensive registration).")
        effective = snap.final_url
    else:
        effective = ""

    html = snap.html or ""
    lower = html.lower()
    text = visible_text(html)
    tlower = text.lower()
    title = title_of(html).lower()

    if any(n and any(p in n for p in PARKING_NS) for n in ns):
        return Gate("parked", f"Nameservers belong to a parking service ({', '.join(ns[:2])}).", recheck_rounds=4)
    strong = [m for m in PARKING_STRONG if m in lower]
    sale = [m for m in FOR_SALE if m in lower]
    weak = [m for m in PARKING_WEAK if m in lower]
    if sale and (len(text) < 1500 or len(sale) >= 2):
        return Gate("for_sale", f"Domain-for-sale lander ({sale[0]!r}).", recheck_rounds=6)
    if strong or (len(weak) >= 2 and len(text) < 1200) or (weak and len(text) < 300):
        marker = (strong or weak)[0]
        return Gate("parked", f"Parking page ({marker!r}).", recheck_rounds=4)

    for marker, what in PLACEHOLDER:
        if marker in title or (marker in tlower and len(text) < 900):
            if what == "hosting account suspended":
                return Gate("suspended", "Hosting account suspended.", recheck_rounds=6)
            return Gate("placeholder", f"{what.capitalize()} ({marker!r}).", recheck_rounds=3)
    if any(m in tlower for m in COMING_SOON) and len(text) < 700:
        return Gate("coming_soon", "Coming-soon page; nothing to check yet.", recheck_rounds=2)

    info_hits = [m for m in INFO_TEXT if m in tlower]
    if (INFO_TITLE.search(title) and info_hits) or len(info_hits) >= 3:
        return Gate("informational", f"Article, review or forum page about scams ({info_hits[0]!r}).",
                    leads=mentioned_domains(html, text, dm.registrable(domain)))

    if LEGIT_REGULATED.search(text) and RISK_DISCLOSURE.search(text):
        return Gate("legit", "Carries a regulator registration and statutory risk warnings.")

    shell = is_spa_shell(html, text)
    vocab = CRYPTO_VOCAB.search(" ".join((title, text, extra_text, _meta(lower))))
    if not vocab and not shell:
        return Gate("not_crypto", "No cryptocurrency content on the page.")
    if not shell and len(text) < 60:
        return Gate("thin", "Almost no content.", recheck_rounds=3)
    return Gate(effective_url=effective, shell=shell)


def _meta(lower_html: str) -> str:
    return " ".join(re.findall(r"<meta[^>]+content=['\"]([^'\"]{0,300})", lower_html))
