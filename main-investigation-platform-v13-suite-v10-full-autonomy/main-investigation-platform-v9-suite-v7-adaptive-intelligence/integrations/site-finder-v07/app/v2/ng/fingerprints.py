"""
Page-build fingerprints taken from HTML Site Finder has already fetched (no extra requests).

    asset     a same-site script/stylesheet file name that looks like a build artefact
              (content hash in the name, app/main/vendor bundles). Scam kits are built
              once and deployed on many domains, so their bundles keep the same name.
    title     the page title with the site's own domain removed
    simhash   a 64-bit similarity hash of the visible text (near-duplicate detection)

These are DISCOVERY PIVOTS, not relationship evidence. The same vendor script can sit on
scams run by different people and on the vendor's own demo site; popular libraries sit on
most of the web. Nothing here is written to the investigation graph, so no campaign or
relationship can be formed from a fingerprint alone.
"""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit

_SRC = re.compile(r"""<(?:script|link)[^>]+(?:src|href)\s*=\s*['"]?([^'"\s>]+)""", re.I)
_HASHY = re.compile(r"(?:^|[.\-_])([0-9a-f]{6,}|[0-9a-z]{8,}(?=\.))", re.I)
_WORD = re.compile(r"[a-z0-9一-鿿]{2,}", re.I)
# Libraries and framework files that thousands of unrelated sites share.
GENERIC_ASSET = re.compile(
    r"(jquery|bootstrap|swiper|font-?awesome|vue(\.runtime)?(\.min)?\.js$|react(-dom)?(\.production)?|angular|"
    r"lodash|moment|axios|polyfill|modernizr|wp-(includes|content|emoji)|gtag|analytics|recaptcha|chunk-vendors|"
    r"animate(\.min)?\.css|normalize|tailwind|popper|select2|slick|owl\.carousel|layui|element-ui|vant)", re.I)
GENERIC_TITLES = {"", "home", "login", "log in", "index", "welcome", "loading", "loading...", "404", "403",
                  "not found", "coming soon", "under construction", "default page", "document", "app", "h5",
                  "just a moment...", "attention required!", "domain for sale", "parked domain"}


def assets(html: str, page_url: str) -> list[str]:
    """Distinctive same-origin build artefacts, as bare file names (query strings dropped)."""
    host = (urlsplit(page_url).hostname or "").lower()
    out = []
    for raw in _SRC.findall(html or ""):
        parts = urlsplit(raw)
        if parts.hostname and parts.hostname.lower().removeprefix("www.") != host.removeprefix("www."):
            continue                                   # third-party CDN: not the operator's build
        path = parts.path or ""
        name = path.rsplit("/", 1)[-1]
        if not name or not name.endswith((".js", ".css")) or GENERIC_ASSET.search(path):
            continue
        if not (_HASHY.search(name) or re.search(r"(app|main|index|vendor|bundle|runtime)[.\-]", name)):
            continue
        if name not in out:
            out.append(name[:120])
    return out[:8]


def title(html_title: str, domain: str) -> str:
    t = re.sub(r"\s+", " ", (html_title or "")).strip()
    label = domain.split(".")[0]
    t = re.sub(re.escape(domain), "", t, flags=re.I)
    t = t.strip(" -|·:")
    if t.lower() in GENERIC_TITLES or len(t) < 4 or t.lower() == label.lower():
        return ""
    return t[:120]


def simhash(text: str) -> str:
    words = [w.lower() for w in _WORD.findall(text or "")]
    if len(words) < 8:
        return ""
    shingles = [" ".join(words[i:i + 3]) for i in range(len(words) - 2)]
    v = [0] * 64
    for sh in shingles:
        h = int.from_bytes(hashlib.md5(sh.encode()).digest()[:8], "big")
        for i in range(64):
            v[i] += 1 if h >> i & 1 else -1
    return f"{sum(1 << i for i in range(64) if v[i] > 0):016x}"


def distance(a: str, b: str) -> int:
    if not a or not b:
        return 64
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def extract(html: str, text: str, page_title: str, url: str, domain: str) -> dict:
    return {"assets": assets(html, url), "title": title(page_title, domain), "simhash": simhash(text)}


def keys(fp: dict) -> list:
    out = [("asset", a) for a in fp.get("assets", [])]
    if fp.get("title"):
        out.append(("title", fp["title"].lower()))
    if fp.get("simhash"):
        out.append(("simhash", fp["simhash"]))
    return out
