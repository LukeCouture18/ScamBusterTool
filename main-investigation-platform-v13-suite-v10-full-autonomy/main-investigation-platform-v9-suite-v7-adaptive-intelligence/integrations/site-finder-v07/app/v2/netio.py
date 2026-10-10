"""
Every network touch v2 makes, in one place, each one passive and public.

    resolve()          one DNS A lookup
    nameservers()      one DNS NS lookup (dnspython if installed, else skipped)
    fetch()            one unauthenticated GET of a public URL, redirects followed,
                       size-capped, with the full redirect chain recorded
    rdap_registered()  one RDAP query for the registration date (rdap.org)
    crtsh()            one Certificate Transparency search on crt.sh

Each call is counted so the engine can hold itself to a request budget, and
nothing here ever sends credentials, cookies, form data or anything other than
a plain GET.
"""
from __future__ import annotations

import datetime as _dt
import copy
import hashlib
import json
import logging
import os
import re
import socket
import time
from dataclasses import dataclass, field

import requests

from app.config import USER_AGENT

logger = logging.getLogger("scamhunter.v2.netio")

MAX_BYTES = 400_000
TIMEOUT = 10
HEADERS = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
           "Accept-Language": "en-US,en;q=0.8"}

try:                                              # optional, as in v1
    import dns.resolver as _dns_resolver          # type: ignore
except ImportError:                               # pragma: no cover - depends on install
    _dns_resolver = None

_nameserver_override = None
_round_diagnostics = None
_round_dns = {}
_round_fetch = {}
_round_fetch_bytes = 0
_cache_active = False


def reset_round_diagnostics():
    global _round_diagnostics, _round_dns, _round_fetch, _round_fetch_bytes, _cache_active
    _cache_active = True
    _round_dns = {}
    _round_fetch = {}
    _round_fetch_bytes = 0
    _round_diagnostics = {"crtsh": {"attempts": 0, "success": 0, "failures": 0,
                                    "raw_results": 0, "status": "untried", "latency": 0},
                          "dns": {"attempts": 0, "resolved": 0, "status": "untried"}}
    from app.v2 import sources
    sources.reset_round()


def end_round_cache():
    global _cache_active, _round_dns, _round_fetch, _round_fetch_bytes
    _cache_active = False
    _round_dns = {}
    _round_fetch = {}
    _round_fetch_bytes = 0


def round_diagnostics():
    return {name: dict(values) for name, values in (_round_diagnostics or {}).items()}


class Budget:
    """A simple request meter shared by one discovery round."""

    def __init__(self, http: int = 200, dns: int = 600, crtsh: int = 12, rdap: int = 40):
        self.limits = {"http": http, "dns": dns, "crtsh": crtsh, "rdap": rdap}
        self.used = {k: 0 for k in self.limits}

    def take(self, kind: str, n: int = 1) -> bool:
        if self.used[kind] + n > self.limits[kind]:
            return False
        self.used[kind] += n
        return True

    def left(self, kind: str) -> int:
        return self.limits[kind] - self.used[kind]

    def as_dict(self) -> dict:
        return {"limits": dict(self.limits), "used": dict(self.used)}


class BudgetWindow:
    """An arm's allowance inside the same round meter; never a second budget."""
    def __init__(self, parent: Budget, caps: dict):
        self.parent = parent
        self.limits = {k: min(v, caps.get(k, v)) for k, v in parent.limits.items()}
        self.used = {k: 0 for k in self.limits}

    def take(self, kind: str, n: int = 1) -> bool:
        if n < 0 or self.used[kind] + n > self.limits[kind] or not self.parent.take(kind, n):
            return False
        self.used[kind] += n
        return True

    def left(self, kind: str) -> int:
        return min(self.parent.left(kind), self.limits[kind] - self.used[kind])

    def as_dict(self) -> dict:
        return {"limits": dict(self.limits), "used": dict(self.used)}


@dataclass
class Snapshot:
    requested_url: str
    final_url: str = ""
    status: int | None = None
    error: str = ""                        # dns | refused | timeout | tls | error
    html: str = ""
    headers: dict = field(default_factory=dict)
    redirects: list = field(default_factory=list)
    elapsed: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.error and self.status is not None and self.status < 400


def resolve(host: str) -> str | None:
    # Reuse DNS answers only inside one bounded discovery round. Reset before
    # every next round; failed lookups cannot establish long-term absence.
    if os.environ.get("SITE_FINDER_POLICY") == "v3" or not _cache_active:
        return _resolve_uncached(host)
    key = host.lower().rstrip(".")
    if key not in _round_dns:
        value = _resolve_uncached(host)
        if len(_round_dns) < 2048:
            _round_dns[key] = value
        return value
    return _round_dns[key]


def _resolve_uncached(host: str) -> str | None:
    started = time.monotonic()
    if _round_diagnostics is not None:
        _round_diagnostics["dns"]["attempts"] += 1
    try:
        result = socket.gethostbyname(host)
        if _round_diagnostics is not None:
            _round_diagnostics["dns"]["resolved"] += 1
            _round_diagnostics["dns"]["status"] = "healthy"
        return result
    except (socket.gaierror, socket.timeout, UnicodeError, OSError):
        if _round_diagnostics is not None and _round_diagnostics["dns"]["status"] != "healthy":
            _round_diagnostics["dns"]["status"] = "unresolved"
        return None
    finally:
        from app import db
        db.add_external_wait(time.monotonic()-started)


def nameservers(domain: str) -> list:
    if _nameserver_override:
        try:
            return sorted(n.lower().rstrip(".") for n in _nameserver_override(domain))
        except Exception:                             # noqa: BLE001
            return []
    if not _dns_resolver:
        return []
    try:
        answers = _dns_resolver.resolve(domain, "NS", lifetime=4)
        return sorted(str(r.target).rstrip(".").lower() for r in answers)
    except Exception:                                 # noqa: BLE001
        return []


def set_nameserver_function(fn):
    global _nameserver_override
    _nameserver_override = fn


def _classify_exception(exc: Exception) -> str:
    text = str(exc).lower()
    if isinstance(exc, requests.exceptions.SSLError) or "certificate" in text or "ssl" in text:
        return "tls"
    if isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout)) or "timed out" in text:
        return "timeout"
    if "name or service not known" in text or "failed to resolve" in text or "nodename" in text:
        return "dns"
    if "refused" in text:
        return "refused"
    return "error"


def fetch(url: str, timeout: int = TIMEOUT, max_bytes: int = MAX_BYTES) -> Snapshot:
    # Probe and page extraction often request the same public URL in one round.
    # Reuse successful snapshots only within that round, with an aggregate cap.
    # No cross-round cache: temporal reappearance and provider recovery remain fresh.
    global _round_fetch_bytes
    key = (url, max_bytes)
    cache_enabled = os.environ.get("SITE_FINDER_POLICY") != "v3" and _cache_active
    if cache_enabled and key in _round_fetch:
        result = copy.deepcopy(_round_fetch[key])
        result.elapsed = 0.0
        return result
    snap = _fetch_uncached(url, timeout, max_bytes)
    size = len(snap.html.encode("utf-8"))
    if cache_enabled and snap.ok and len(_round_fetch) < 256 and _round_fetch_bytes + size <= 32 * 1024 * 1024:
        _round_fetch[key] = copy.deepcopy(snap)
        _round_fetch_bytes += size
    return snap


def _fetch_uncached(url: str, timeout: int = TIMEOUT, max_bytes: int = MAX_BYTES) -> Snapshot:
    snap = Snapshot(requested_url=url)
    started = time.time()
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True, stream=True)
        body = resp.raw.read(max_bytes, decode_content=True) or b""
        snap.status = resp.status_code
        snap.final_url = resp.url or url
        snap.headers = {k.lower(): v for k, v in (resp.headers or {}).items()}
        snap.redirects = [getattr(h, "url", "") for h in (resp.history or [])]
        snap.html = body.decode(resp.encoding or "utf-8", errors="ignore")
        try:
            resp.close()
        except Exception:                             # noqa: BLE001
            pass
    except requests.exceptions.RequestException as exc:
        snap.error = _classify_exception(exc)
    except Exception as exc:                          # noqa: BLE001 - never raise into the engine
        snap.error = "error"
        logger.debug("fetch %s failed: %s", url, exc)
    snap.elapsed = round(time.time() - started, 3)
    from app import db
    db.add_external_wait(time.time()-started)
    return snap


def fetch_bytes(url: str, timeout: int = 8, max_bytes: int = 200_000) -> bytes | None:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True, stream=True)
        if resp.status_code >= 400:
            return None
        return resp.raw.read(max_bytes, decode_content=True) or b""
    except Exception:                                 # noqa: BLE001
        return None


def favicon_hash(base_url: str) -> str:
    from urllib.parse import urljoin
    data = fetch_bytes(urljoin(base_url, "/favicon.ico"), max_bytes=100_000)
    if not data or len(data) < 16 or data.lstrip()[:1] == b"<":
        return ""
    return hashlib.sha256(data).hexdigest()[:24]


def rdap_registered(domain: str) -> float | None:
    """Days since registration, from the public RDAP bootstrap service."""
    try:
        resp = requests.get(f"https://rdap.org/domain/{domain}", headers={"User-Agent": USER_AGENT,
                            "Accept": "application/rdap+json"}, timeout=10)
        if resp.status_code != 200:
            return None
        data = resp.json()
        for event in data.get("events") or []:
            if event.get("eventAction") == "registration" and event.get("eventDate"):
                ts = _dt.datetime.fromisoformat(event["eventDate"].replace("Z", "+00:00"))
                now = _dt.datetime.now(_dt.timezone.utc)
                return max(0.0, (now - ts).total_seconds() / 86400)
    except Exception:                                 # noqa: BLE001
        return None
    return None


def crtsh(pattern: str) -> list:
    """Capability-based public CT search with classified source failures."""
    from app.v2 import sources
    started = time.monotonic()
    if _round_diagnostics is not None:
        _round_diagnostics["crtsh"]["attempts"] += 1
    data, status, _ = sources.query_certificates(pattern)
    if _round_diagnostics is not None:
        _round_diagnostics["crtsh"]["status"] = status
        _round_diagnostics["crtsh"]["success"] += int(status in ("healthy", "empty"))
        _round_diagnostics["crtsh"]["failures"] += int(status not in ("healthy", "empty"))
        _round_diagnostics["crtsh"]["raw_results"] += len(data)
        _round_diagnostics["crtsh"]["latency"] += round(time.monotonic()-started, 3)
    return data


# v4: optional passive-DNS source for hosting pivots (co-hosted names on an IP, or
# names delegated to a nameserver set). This is public DNS metadata from a third
# party; it never touches the sites themselves. Unset -> the arm is unavailable.
PASSIVE_DNS_URL = os.environ.get("V4_PASSIVE_DNS_URL", "").rstrip("/")


def passive_dns(kind: str, value: str) -> list | None:
    """Hostnames seen on an IP (kind=ip) or nameserver (kind=ns). None when no source is configured. Never raises."""
    if not PASSIVE_DNS_URL or kind not in ("ip", "ns"):
        return None
    try:
        from urllib.parse import quote
        resp = requests.get(f"{PASSIVE_DNS_URL}/{kind}/{quote(value, safe='')}",
                            headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=15)
        if resp.status_code != 200:
            return []
        data = resp.json()
        return [str(h).lower() for h in data][:2000] if isinstance(data, list) else []
    except Exception as exc:                          # noqa: BLE001
        logger.debug("passive DNS %s %s failed: %s", kind, value, exc)
        return []


def cert_age_days(entry: dict) -> float | None:
    ts = entry.get("entry_timestamp") or entry.get("not_before")
    if not ts:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(str(ts).replace("Z", "").split(".")[0])
        return max(0.0, (_dt.datetime.utcnow() - parsed).total_seconds() / 86400)
    except (TypeError, ValueError):
        return None


_TAG_RE = re.compile(r"<(script|style|noscript|template)[^>]*>.*?</\1>", re.S | re.I)
_ANY_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def visible_text(html: str) -> str:
    text = _TAG_RE.sub(" ", html or "")
    text = _ANY_TAG.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&#39;", "'").replace("&quot;", '"'))
    return _WS.sub(" ", text).strip()


_ATTR_TEXT = re.compile(r"(?:placeholder|aria-label|alt|value|title)=['\"]([^'\"]{2,120})['\"]", re.I)


def attribute_text(html: str) -> str:
    """Form placeholders, button values, alt text: UI words that visible_text() drops."""
    return " ".join(_ATTR_TEXT.findall(html or ""))


def title_of(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.S | re.I)
    return _WS.sub(" ", m.group(1)).strip()[:200] if m else ""


def script_srcs(html: str) -> list:
    return re.findall(r"<script[^>]+src=['\"]?([^'\" >]+)", html or "", re.I)


def links(html: str) -> list:
    return re.findall(r"href=['\"]?(https?://[^'\" >]+)", html or "", re.I)


def dumps(value) -> str:
    return json.dumps(value, default=str, sort_keys=True)
