"""
Website-family intelligence: the passive artifacts a public page exposes, and what each one can
and cannot tell you.

Extraction (no extra requests: the page and the one script bundle the probe already fetched)

    apihost    hosts named in inline config (apiUrl, baseURL, wsUrl, socket, server, gateway, ...)
    service    customer-service / chat backends (kefu, chat, support, livechat widgets)
    analytics  analytics and tag ids (Google G-/UA-/GTM-, Yandex Metrica, Meta pixel, Baidu, CNZZ, 51.la)
    contact    public messenger handles (t.me/..., wa.me/...)
    linked     other registrable domains a page or its own bundle names (backup lines, app/download hosts)
    dom        the page skeleton: tag and class structure, text removed
    flow       the sign-up / deposit form structure: field placeholders and input types
    (asset, title, favicon, ip, wallet come from the existing probe and fingerprints)

Tiers (learned from what Site Finder has observed, re-evaluated every time)

    generic      shared web technology: on non-scam pages too, or on very many sites
    family       a scam-kit family: the same kit on many sites whose wallets never overlap
    variant      a specific kit build: a few sites, independent wallets
    deployment   seen on one site only so far
    operator     reuse that points at the same operator: an identifier of the kind operators own
                 (wallet, analytics id, private chat or API host, messenger handle, backup line)
                 shared by a few sites, not spread over independent wallet groups

Tiers decide how a pivot is used: family and variant artifacts are good for finding more sites
of a kit (campaign hunting, exploration); operator artifacts are good for finding more sites of
an operation. ONLY operator-tier artifacts may support a relationship between two sites, and
only together with independent evidence (see intelligence.rebuild). Using the same kit never
equals being the same operator.
"""
from __future__ import annotations

import hashlib
import re

from app.v2 import domains as dm

KINDS = ("apihost", "service", "analytics", "contact", "linked", "dom", "flow", "kitfile")
OPERATOR_KINDS = {"wallet", "analytics", "contact", "apihost", "service", "linked", "san"}
KIT_KINDS = {"asset", "kitfile", "dom", "flow", "tmpl", "favtmpl", "favicon", "title", "simhash"}
_KITFILE = re.compile(r"""(?:src|href)\s*=\s*['"]?[^'"\s>]*/((?:chunk-vendors|vendors?|runtime|polyfills|chunk-common|framework)[.~-][0-9a-f]{6,}(?:\.[a-z]+)?\.(?:js|css))""", re.I)

_CFG_HOST = re.compile(
    r"""['"]?(api(?:url|_url|base|host|server|domain)?|base_?url|ws(?:url|_url)?|socket(?:url)?|gateway|server(?:url)?|"""
    r"""host|domain|h5(?:url)?|appurl|download(?:url)?)['"]?\s*[:=]\s*['"]((?:https?|wss?)://[^'"\s]+)['"]""", re.I)
_SERVICE = re.compile(r"""['"]?(?:service|kefu|chat|support|customer_?service|cs_?url|livechat)['"]?\s*[:=]\s*['"](https?://[^'"\s]+)""", re.I)
_WIDGET = re.compile(r"""(?:src|href)\s*=\s*['"](https?://(?:embed\.tawk\.to|[a-z0-9.-]*(?:meiqia|chatwoot|crisp\.chat|livechatinc|tidio|jivosite|zopim|zendesk)[a-z0-9.-]*)/[^'"\s]*)""", re.I)
_ANALYTICS = [
    (re.compile(r"\b(G-[A-Z0-9]{6,12})\b"), "ga4"),
    (re.compile(r"\b(UA-\d{4,10}-\d{1,3})\b"), "ua"),
    (re.compile(r"\b(GTM-[A-Z0-9]{4,9})\b"), "gtm"),
    (re.compile(r"""ym\(\s*(\d{6,10})\s*,"""), "ym"),
    (re.compile(r"""mc\.yandex\.ru/watch/(\d{6,10})"""), "ym"),
    (re.compile(r"""fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]"""), "fb"),
    (re.compile(r"""hm\.baidu\.com/hm\.js\?([0-9a-f]{32})"""), "baidu"),
    (re.compile(r"""(?:cnzz\.com/(?:z_stat|stat)\.php\?id=|s\d+\.cnzz\.com/.*?web_id=)(\d{5,12})"""), "cnzz"),
    (re.compile(r"""js\.users\.51\.la/(\d{5,12})\.js"""), "51la"),
    (re.compile(r"""sdk\.51\.la/js-sdk-pro\.min\.js.*?id\s*:\s*['"]([A-Za-z0-9]{8,24})['"]""", re.S), "51la"),
]
_CONTACT = re.compile(r"""https?://(?:t\.me|telegram\.me|wa\.me|api\.whatsapp\.com/send\?phone=)/?([A-Za-z0-9_+]{4,40})""", re.I)
_HOSTLIKE = re.compile(r"""(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,15})(?![\w-])""", re.I)
_TAG = re.compile(r"<\s*([a-z][a-z0-9]*)([^>]*)>", re.I)
_CLASS = re.compile(r"""class\s*=\s*['"]([^'"]+)['"]""", re.I)
_INPUT = re.compile(r"<\s*input([^>]*)>", re.I)
_ATTR = re.compile(r"""(placeholder|type|name)\s*=\s*['"]([^'"]{0,60})['"]""", re.I)

# Hosts every kind of site talks to: never an operator artifact.
COMMON_HOSTS = {
    "googleapis.com", "gstatic.com", "google-analytics.com", "googletagmanager.com", "doubleclick.net",
    "cloudflare.com", "cloudflareinsights.com", "cdnjs.com", "jsdelivr.net", "unpkg.com", "bootstrapcdn.com",
    "jquery.com", "fontawesome.com", "w3.org", "schema.org", "facebook.net", "fbcdn.net", "yandex.ru",
    "baidu.com", "cnzz.com", "51.la", "tawk.to", "reactjs.org", "vuejs.org", "npmjs.com", "npmjs.org",
    "mozilla.org", "apple.com", "apache.org", "gnu.org", "opensource.org", "example.com", "example.org",
    "sentry.io", "sentry-cdn.com", "amazonaws.com", "cloudfront.net", "akamaihd.net", "aliyuncs.com",
    "qq.com", "microsoft.com", "windows.net", "github.io", "githubusercontent.com", "polyfill.io",
    "recaptcha.net", "hcaptcha.com", "stripe.com", "paypal.com", "binance.com", "coinbase.com",
    "tradingview.com", "coingecko.com", "coinmarketcap.com", "trustwallet.com", "metamask.io",
}
# File/API look-alikes the host regex would otherwise take for domains.
_NOT_HOST_TLD = {"js", "css", "png", "jpg", "jpeg", "gif", "svg", "ico", "json", "map", "vue", "ts", "min",
                 "html", "htm", "php", "txt", "woff", "woff2", "ttf", "eot", "webp", "mp4", "mp3", "prototype",
                 "length", "value", "push", "call", "apply", "then", "data", "name", "log", "exports", "default"}


# Top-level domains a host name found in page code must end in (any two-letter country code, plus
# the generic TLDs in common use). JavaScript like `assets.total` or `window.location` is not a host.
GTLDS = {
    "com", "net", "org", "info", "biz", "io", "co", "app", "dev", "xyz", "top", "vip", "live", "pro", "shop", "club",
    "icu", "cfd", "sbs", "bond", "homes", "lat", "online", "site", "store", "tech", "cloud", "fun", "space", "website",
    "world", "today", "life", "link", "click", "buzz", "monster", "rest", "cyou", "quest", "mobi", "asia", "tel", "name",
    "one", "global", "finance", "money", "capital", "exchange", "market", "markets", "trade", "trading", "investments",
    "fund", "gold", "ltd", "group", "company", "digital", "network", "systems", "services", "solutions", "center", "plus",
    "win", "bet", "games", "cash", "credit", "loans", "bank", "work", "email", "host", "press", "run", "wiki", "tokyo",
    "africa", "art", "blog", "best", "cool", "ink", "kim", "ltda", "mom", "pw", "red", "rocks", "sale", "xin", "wang",
    "ren", "fit", "gdn", "guru", "hk", "zone", "agency", "capital", "coin", "crypto", "exchange", "wallet", "pay",
}


def _reg(url_or_host: str) -> str:
    reg = dm.registrable(url_or_host or "")
    if not reg or dm.is_allowlisted(reg) or reg in COMMON_HOSTS:
        return ""
    tld = reg.rsplit(".", 1)[-1]
    if not (len(tld) == 2 and tld.isalpha()) and tld not in GTLDS:
        return ""
    return reg


def extract(domain: str, html: str, bundle: str = "") -> list[tuple[str, str]]:
    """Artifacts of one page as (kind, value) keys. Never raises on odd input."""
    html = html or ""
    bundle = (bundle or "")[:400_000]
    own = dm.registrable(domain)
    out: list[tuple[str, str]] = []

    def add(kind, value):
        value = (value or "").strip().lower()[:200]
        if value and (kind, value) not in out:
            out.append((kind, value))

    source = html + "\n" + bundle
    for m in _CFG_HOST.finditer(source):
        reg = _reg(m.group(2))
        if reg and reg != own:
            add("apihost", reg)
    for m in _SERVICE.finditer(source):
        reg = _reg(m.group(1))
        if reg and reg != own:
            add("service", reg)
    for m in _WIDGET.finditer(html):
        path = m.group(1).split("//", 1)[-1]
        parts = path.split("/")
        if parts[0].endswith("tawk.to") and len(parts) > 1 and parts[1]:
            add("service", "tawk:" + parts[1])            # the widget's property id identifies the account
    for rx, label in _ANALYTICS:
        for m in rx.finditer(source):
            add("analytics", f"{label}:{m.group(1)}")
    for m in _CONTACT.finditer(source):
        handle = m.group(1).lower()
        if handle not in ("share", "joinchat", "s", "iv", "addstickers", "proxy", "send"):
            add("contact", handle)
    # Other domains the page or its own bundle names: backup lines, app download hosts, mirrors.
    named = set()
    for m in _HOSTLIKE.finditer(bundle + "\n" + _inline_scripts(html)):
        host = m.group(1).lower()
        tld = host.rsplit(".", 1)[-1]
        if tld in _NOT_HOST_TLD or len(host) < 5:
            continue
        reg = _reg(host)
        if reg and reg != own and reg not in {v for k, v in out if k in ("apihost", "service")}:
            named.add(reg)
    for reg in sorted(named)[:12]:
        add("linked", reg)
    for m in _KITFILE.finditer(html):
        add("kitfile", m.group(1))                       # a hashed vendor bundle: the kit's build, shared across its deployments
    dom = dom_signature(html)
    if dom:
        add("dom", dom)
    flow = flow_signature(html)
    if flow:
        add("flow", flow)
    return out


def _inline_scripts(html: str) -> str:
    return " ".join(re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html or "", re.I | re.S))[:200_000]


def dom_signature(html: str) -> str:
    """The page skeleton (tags and class names in order, no text, no ids): same kit build, any brand."""
    parts = []
    for m in _TAG.finditer(html or ""):
        tag = m.group(1).lower()
        if tag in ("html", "head", "meta", "title", "br", "img", "span", "b", "i", "strong", "em"):
            continue
        cls = _CLASS.search(m.group(2) or "")
        parts.append(tag + ("." + ".".join(sorted(cls.group(1).split())[:3]) if cls else ""))
        if len(parts) >= 160:
            break
    if len(parts) < 6:
        return ""
    return "dom:" + hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def flow_signature(html: str) -> str:
    """The shape of the sign-up / deposit form: which fields are asked for, in order."""
    fields = []
    for m in _INPUT.finditer(html or ""):
        attrs = dict((k.lower(), v.strip().lower()) for k, v in _ATTR.findall(m.group(1) or ""))
        label = attrs.get("placeholder") or attrs.get("name") or attrs.get("type") or ""
        label = re.sub(r"[^a-z/ ]", "", label)[:30].strip()
        if label:
            fields.append(label)
    if len(fields) < 2:
        return ""
    return "flow:" + hashlib.sha1("|".join(fields).encode()).hexdigest()[:12]


# --------------------------------------------------------------------------- tiers

TIER_TEXT = {
    "generic": "shared web technology, seen well beyond scam sites",
    "family": "a scam-kit family: many sites use it, run by apparently different people",
    "variant": "a specific kit build shared by a few sites with independent wallets",
    "deployment": "seen on one site so far",
    "operator": "an identifier of the kind an operator owns, reused on a few sites",
}


def tier(kind: str, stats: dict) -> str:
    """stats: {"sites": n, "scam": n eligible/useful, "nonscam": n gated as not a scam page,
    "wallet_groups": number of disjoint wallet sets among its sites, "shared_wallet": bool}."""
    sites = int(stats.get("sites", 0))
    nonscam = int(stats.get("nonscam", 0))
    groups = int(stats.get("wallet_groups", 0))
    if sites <= 1:
        return "deployment"
    if nonscam >= 2 or nonscam > max(1, sites // 3):
        return "generic"
    if sites > 60 and nonscam == 0 and kind not in OPERATOR_KINDS:
        return "family"                                  # a kit on very many scam pages, never on others
    if sites > 60 and kind not in OPERATOR_KINDS:
        return "generic"
    if kind in OPERATOR_KINDS:
        # An operator identifier spread over several independent wallet groups is a vendor or
        # a copied kit, not one operator.
        if groups >= 3 and not stats.get("shared_wallet"):
            return "family"
        return "operator"
    if groups >= 3 or sites >= 12:
        return "family"
    return "variant"


MIRROR_KINDS = ("asset", "dom", "apihost", "service", "analytics", "contact", "title")


def mirror_signature(keys: list) -> tuple:
    """What a copy of the same deployment keeps: build files, page skeleton and operator identifiers."""
    return tuple(sorted({(k, v) for k, v in keys if k in MIRROR_KINDS and v}))


def stats_for(pairs: list, conn) -> dict:
    """Tier statistics for many (kind, value) artifacts in a few statements."""
    out = {}
    pairs = list(dict.fromkeys(pairs))
    if not pairs:
        return out
    doms_of: dict = {}
    for i in range(0, len(pairs), 300):
        chunk = pairs[i:i + 300]
        cond = " OR ".join("(key_type=? AND key_value=?)" for _ in chunk)
        args = [x for kv in chunk for x in kv]
        for r in conn.execute(f"SELECT key_type,key_value,domain FROM v2_keys WHERE {cond}", args):
            doms_of.setdefault((r["key_type"], r["key_value"]), set()).add(r["domain"])
    all_domains = sorted({d for ds in doms_of.values() for d in ds})
    status, wallets = {}, {}
    for i in range(0, len(all_domains), 400):
        chunk = all_domains[i:i + 400]
        ph = ",".join("?" * len(chunk))
        for r in conn.execute(f"SELECT domain,status,gate,decision_reason FROM v2_candidates WHERE domain IN ({ph})", chunk):
            status[r["domain"]] = (r["status"], r["gate"] or ("not_scam" if r["status"] == "skipped" and
                                                               (r["decision_reason"] or "") in ("not_a_scam", "not_crypto") else ""))
        for r in conn.execute(f"SELECT domain,key_value FROM v2_keys WHERE key_type='wallet' AND domain IN ({ph})", chunk):
            wallets.setdefault(r["domain"], set()).add(r["key_value"])
    for kv, ds in doms_of.items():
        scam = sum(1 for d in ds if (status.get(d) or ("",))[0] in ("held", "ready", "presented", "useful", "delivered"))
        nonscam = sum(1 for d in ds if (status.get(d) or ("", ""))[1] in ("not_crypto", "informational", "legit",
                                                                          "redirect_legit", "not_scam"))
        groups, shared = _wallet_groups([wallets.get(d, set()) for d in ds])
        out[kv] = {"sites": len(ds), "scam": scam, "nonscam": nonscam, "wallet_groups": groups, "shared_wallet": shared}
    for kv in pairs:
        out.setdefault(kv, {"sites": 0, "scam": 0, "nonscam": 0, "wallet_groups": 0, "shared_wallet": False})
    return out


def _wallet_groups(sets: list) -> tuple[int, bool]:
    """Number of disjoint groups among non-empty wallet sets, and whether any two sites share a wallet."""
    groups: list[set] = []
    shared = False
    for s in (x for x in sets if x):
        hit = [g for g in groups if g & s]
        if hit:
            shared = True
            merged = set(s)
            for g in hit:
                merged |= g
                groups.remove(g)
            groups.append(merged)
        else:
            groups.append(set(s))
    return len(groups), shared
