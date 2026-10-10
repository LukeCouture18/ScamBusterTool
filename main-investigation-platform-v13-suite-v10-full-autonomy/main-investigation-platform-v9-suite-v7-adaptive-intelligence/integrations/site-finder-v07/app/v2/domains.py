"""
Domain normalisation for v2: one candidate per registration, never per hostname.

v1 deduplicated on the full hostname, so mail.x, cpanel.x, webmail.x and
www2.x each became separate candidates — and cPanel AutoSSL puts exactly those
names on a certificate for every hosted domain, which is where most of
Certificate Transparency's volume comes from. v2 collapses every hostname to
its registrable domain (eTLD+1), treats well-known infrastructure labels as
sightings of the parent, and keeps hosting-platform subdomains (x.pages.dev)
separate because there the subdomain *is* the registration.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

# Multi-label public suffixes that matter in practice. Not the whole PSL — the
# goal is to never merge two different registrants, and these are the suffixes
# under which the merge would otherwise go wrong.
MULTI_SUFFIXES = {
    "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk",
    "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.za", "com.br", "com.cn", "net.cn",
    "org.cn", "com.hk", "com.tw", "com.sg", "com.my", "com.ph", "com.vn", "co.id", "co.in",
    "net.in", "org.in", "co.jp", "ne.jp", "or.jp", "co.kr", "or.kr", "com.tr", "com.mx",
    "com.ar", "com.co", "com.pe", "com.ng", "com.pk", "com.ua", "co.il", "com.sa", "com.eg",
    "com.bd", "co.th", "in.th", "com.es", "com.pl", "co.ke", "co.ug", "co.tz",
}
# Hosting platforms where each subdomain is a separate customer.
HOSTING_SUFFIXES = {
    "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "web.app",
    "firebaseapp.com", "herokuapp.com", "blogspot.com", "wixsite.com", "weebly.com",
    "azurewebsites.net", "cloudfront.net", "onrender.com", "glitch.me", "repl.co", "surge.sh",
    "000webhostapp.com", "ngrok.io", "ngrok-free.app", "fly.dev", "railway.app", "webflow.io",
    "myshopify.com", "square.site", "wordpress.com", "carrd.co", "framer.website", "godaddysites.com",
    "sites.google.com", "r2.dev", "ipfs.io", "dweb.link", "translate.goog",
}
# Labels that mean "infrastructure of the parent", not a separate site.
INFRA_LABELS = {
    "www", "www2", "www3", "mail", "webmail", "cpanel", "whm", "webdisk", "cpcalendars",
    "cpcontacts", "autodiscover", "autoconfig", "ftp", "smtp", "imap", "pop", "pop3", "mx",
    "ns1", "ns2", "ns3", "dns", "email", "remote", "vpn", "_dmarc", "lyncdiscover", "sip",
    "owa", "exchange-mail", "static", "cdn", "img", "images", "assets", "api", "ws", "wss",
    "m", "h5", "app", "admin", "dashboard", "panel", "portal", "status",
}

# Official domains of the brands scammers impersonate most, and other large
# legitimate operators that CT keyword searches keep returning. A hit here is
# never surfaced; it can still be a redirect target (see classify.py).
BRAND_OFFICIAL = {
    "binance": {"binance.com", "binance.us", "binance.info", "binance.org", "bnbchain.org", "binance.me"},
    "coinbase": {"coinbase.com", "coinbase.cloud", "base.org", "cb.com"},
    "kraken": {"kraken.com", "kraken.io"},
    "metamask": {"metamask.io", "consensys.io", "consensys.net"},
    "trustwallet": {"trustwallet.com", "trust.com"},
    "bybit": {"bybit.com", "bybitglobal.com"},
    "okx": {"okx.com", "okex.com", "okcoin.com"},
    "kucoin": {"kucoin.com"},
    "bitget": {"bitget.com"},
    "cryptocom": {"crypto.com"},
    "ledger": {"ledger.com", "ledger.fr"},
    "trezor": {"trezor.io"},
    "gemini": {"gemini.com"},
    "bitfinex": {"bitfinex.com"},
    "huobi": {"huobi.com", "htx.com"},
    "gateio": {"gate.io", "gate.com"},
    "phantom": {"phantom.app", "phantom.com"},
    "uniswap": {"uniswap.org", "app.uniswap.org"},
    "pancakeswap": {"pancakeswap.finance"},
    "exodus": {"exodus.com"},
    "blockchain": {"blockchain.com"},
    "walletconnect": {"walletconnect.com", "walletconnect.org", "reown.com"},
    "opensea": {"opensea.io"},
    "tether": {"tether.to"},
}
OFFICIAL_DOMAINS = {d for ds in BRAND_OFFICIAL.values() for d in ds}
# Brand tokens that are also ordinary words need a stricter match.
AMBIGUOUS_BRANDS = {"ledger", "gemini", "kraken", "exodus", "blockchain", "phantom", "base", "gate"}

LEGIT_ALLOWLIST = OFFICIAL_DOMAINS | {
    "google.com", "youtube.com", "facebook.com", "twitter.com", "x.com", "t.me", "telegram.org",
    "whatsapp.com", "wa.me", "instagram.com", "linkedin.com", "github.com", "medium.com",
    "reddit.com", "wikipedia.org", "coinmarketcap.com", "coingecko.com", "etherscan.io",
    "tronscan.org", "bscscan.com", "blockchair.com", "investopedia.com", "investing.com",
    "tradingview.com", "cloudflare.com", "amazon.com", "microsoft.com", "apple.com",
    "godaddy.com", "namecheap.com", "sedo.com", "dan.com", "afternic.com", "hugedomains.com",
    "wordpress.org", "wix.com", "shopify.com", "paypal.com", "stripe.com",
}

SUSPICIOUS_TLDS = {"vip", "top", "xyz", "live", "cc", "pw", "click", "buzz", "cfd", "icu", "shop",
                   "club", "sbs", "cyou", "bond", "lol", "rest", "monster", "quest", "work", "fun",
                   "site", "online", "store", "asia", "win", "bid", "loan", "pro", "app", "cn"}

CRYPTO_TOKENS = ("coin", "bit", "crypto", "btc", "eth", "usdt", "usdc", "trc", "erc", "bnb", "tron",
                 "chain", "block", "token", "defi", "nft", "mining", "miner", "hash", "stake", "staking",
                 "swap", "dex", "wallet", "ledger", "satoshi", "doge", "sol", "web3", "dapp", "airdrop")
SCHEME_TOKENS = ("invest", "profit", "earn", "yield", "income", "capital", "fund", "trade", "trading",
                 "quant", "arbitrage", "fx", "forex", "exchange", "vip", "bonus", "wealth", "finance",
                 "global", "pro", "plus", "ai", "recovery", "recover", "verify", "secure", "claim",
                 "support", "validate", "sync", "rectify", "unlock", "reward")


def host_of(value: str) -> str:
    if not value:
        return ""
    value = value.strip()
    if "://" not in value:
        value = "http://" + value
    host = (urlparse(value).hostname or "").lower().strip(".")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        pass
    return host


def registrable(host_or_url: str) -> str:
    """eTLD+1 for ordinary domains; label+platform suffix for hosting platforms."""
    host = host_of(host_or_url)
    if not host or re.fullmatch(r"[\d.]+", host):
        return host
    labels = host.split(".")
    for n in (3, 2):
        if len(labels) > n and ".".join(labels[-n:]) in HOSTING_SUFFIXES:
            return ".".join(labels[-(n + 1):])
    if len(labels) >= 3 and ".".join(labels[-2:]) in MULTI_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def subdomain_part(host: str) -> str:
    host = host_of(host)
    reg = registrable(host)
    return host[: -len(reg)].rstrip(".") if host != reg else ""


def is_infra_host(host: str) -> bool:
    """mail.x / cpanel.x / autodiscover.x / www.x — a sighting of x, not a site."""
    sub = subdomain_part(host)
    return bool(sub) and sub.split(".")[0] in INFRA_LABELS


def tld(domain: str) -> str:
    return domain.rsplit(".", 1)[-1] if "." in domain else ""


def is_allowlisted(domain_or_url: str) -> bool:
    reg = registrable(domain_or_url)
    host = host_of(domain_or_url)
    return reg in LEGIT_ALLOWLIST or host in LEGIT_ALLOWLIST


def label_tokens(domain: str) -> list:
    """The registrable label split on hyphens and digits: 'bit-exchange24' -> ['bit', 'exchange']."""
    reg = registrable(domain)
    label = reg.split(".")[0]
    return [t for t in re.split(r"[-_\d]+", label) if t]


def brand_in_domain(domain: str) -> str:
    """
    Returns the impersonated brand if the domain carries a brand token and is not
    that brand's own domain. Ambiguous brand words (ledger, gemini, kraken…)
    must be a whole hyphen-delimited token or the entire label, so
    'easyledger-accounting.com' does not count while 'ledger-live-verify.top' does.
    """
    reg = registrable(domain)
    if reg in OFFICIAL_DOMAINS:
        return ""
    label = reg.split(".")[0]
    parts = [p for p in re.split(r"[-_.]", label) if p]
    compact = label.replace("-", "").replace("_", "")
    for brand, officials in BRAND_OFFICIAL.items():
        if reg in officials:
            return ""
        if brand in AMBIGUOUS_BRANDS:
            if brand in parts or compact == brand:
                return brand
            continue
        if brand in compact:
            return brand
    return ""


def _edit_distance(a: str, b: str, limit: int = 3) -> int:
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev[j - 2] + 1 if j >= 2 else cur[j])
        prev = cur
    return prev[-1]


def brand_lookalike(domain: str) -> str:
    """
    Typosquats that do not contain the brand verbatim: metamsk, trustwallwt,
    okxx, binnance. A label (or hyphen-part) within one edit of a brand of five
    or more letters, or two edits of one with nine or more, counts. Exact brand
    tokens are handled by brand_in_domain().
    """
    reg = registrable(domain)
    if reg in OFFICIAL_DOMAINS:
        return ""
    exact = brand_in_domain(reg)
    if exact:
        return exact
    label = reg.split(".")[0]
    candidates = {label.replace("-", "")} | {p for p in re.split(r"[-_]", label) if len(p) >= 3}
    for brand, officials in BRAND_OFFICIAL.items():
        if reg in officials or len(brand) < 3:
            continue
        allowed = 2 if len(brand) >= 9 else 1
        for c in candidates:
            if c == brand:
                continue
            if len(brand) <= 4:
                # short brands (okx): only a doubled/extra character right next to the brand
                if c.startswith(brand) and len(c) == len(brand) + 1:
                    return brand
                continue
            if _edit_distance(c, brand, allowed) <= allowed:
                return brand
    return ""


def shape_features(domain: str) -> dict:
    """Lexical features of the name itself. Weak on their own; used to order work."""
    reg = registrable(domain)
    label = reg.split(".")[0]
    toks = label_tokens(reg)
    joined = label.replace("-", "")
    crypto = [t for t in CRYPTO_TOKENS if t in joined]
    scheme = [t for t in SCHEME_TOKENS if t in joined]
    return {
        "tld": tld(reg), "suspicious_tld": tld(reg) in SUSPICIOUS_TLDS,
        "crypto_tokens": crypto, "scheme_tokens": scheme,
        "digits": sum(c.isdigit() for c in label), "hyphens": label.count("-"),
        "length": len(label), "tokens": toks, "brand": brand_lookalike(reg),
    }
