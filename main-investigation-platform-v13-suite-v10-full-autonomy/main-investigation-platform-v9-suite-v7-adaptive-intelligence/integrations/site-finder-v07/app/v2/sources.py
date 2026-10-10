"""Bounded public-data providers, persistent health and circuit breakers."""
from __future__ import annotations

import json
import os
import socket
import time
from contextvars import ContextVar
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

from app.config import USER_AGENT
from app.v2 import active, store

FAILURE_LIMIT = 2
OPEN_SECONDS = 300
MAX_BYTES = 2_000_000
_ready = set()
_last_provider: ContextVar[str | None] = ContextVar("finder_last_provider", default=None)
_fallback_calls: ContextVar[int] = ContextVar("finder_fallback_calls", default=0)


@dataclass(frozen=True)
class Provider:
    name: str
    capability: str
    endpoint: str
    query_field: str = "q"
    expected: str = "certificate_json"
    max_results: int = 300


def providers():
    configured = os.environ.get("SITE_FINDER_CT_FALLBACK_URL", "").strip()
    result = [Provider("crtsh", "certificate", "https://crt.sh/")]
    if configured:
        parsed = urlsplit(configured)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("certificate fallback must be an HTTPS public-data endpoint")
        result.append(Provider("configured_ct_fallback", "certificate", configured))
    return result


def ensure():
    active.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS ig_provider_health(
          provider TEXT PRIMARY KEY, capability TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'HEALTHY',
          attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
          raw_results INTEGER NOT NULL DEFAULT 0, parsed_domains INTEGER NOT NULL DEFAULT 0,
          eligible INTEGER NOT NULL DEFAULT 0, latency REAL NOT NULL DEFAULT 0,
          last_attempt REAL, last_success REAL, last_error TEXT, next_retry REAL NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS ig_provider_state ON ig_provider_health(capability,state,next_retry);
        """)
        conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(3,?)", (time.time(),))
    _ready.add(key)


def reset_round():
    _fallback_calls.set(0)
    _last_provider.set(None)


def clear_last_provider():
    _last_provider.set(None)


def last_provider():
    return _last_provider.get()


def health():
    ensure()
    with store.conn() as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM ig_provider_health ORDER BY provider")]


def capability_available(capability="certificate"):
    ensure()
    now = time.time()
    current = {row["provider"]: row for row in health()}
    return any(provider.capability == capability and
               (provider.name not in current or current[provider.name]["state"] != "OPEN" or
                current[provider.name]["next_retry"] <= now) for provider in providers())


def _status(exception):
    if isinstance(exception, requests.exceptions.Timeout):
        return "timeout"
    message = str(exception).lower()
    if "name resolution" in message or "getaddrinfo" in message:
        return "dns_failure"
    return "network_unavailable"


def _record(provider, status, raw, parsed, elapsed):
    ensure()
    now = time.time()
    good = status in ("healthy", "empty")
    with store.conn() as conn:
        previous = conn.execute("SELECT consecutive_failures,state FROM ig_provider_health WHERE provider=?",
                                (provider.name,)).fetchone()
        streak = 0 if good else (previous["consecutive_failures"] if previous else 0) + 1
        state = ("RECOVERED" if good and previous and previous["state"] in ("OPEN", "HALF_OPEN", "DEGRADED") else
                 "HEALTHY" if good else "OPEN" if streak >= FAILURE_LIMIT else "DEGRADED")
        retry = now + OPEN_SECONDS * min(4, 2 ** max(0, streak-FAILURE_LIMIT)) if state == "OPEN" else 0
        conn.execute("INSERT INTO ig_provider_health(provider,capability,state,attempts,successes,failures,"
                     "consecutive_failures,raw_results,parsed_domains,latency,last_attempt,last_success,last_error,next_retry)"
                     " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET "
                     "state=excluded.state,attempts=attempts+1,successes=successes+excluded.successes,"
                     "failures=failures+excluded.failures,consecutive_failures=excluded.consecutive_failures,"
                     "raw_results=raw_results+excluded.raw_results,parsed_domains=parsed_domains+excluded.parsed_domains,"
                     "latency=latency+excluded.latency,last_attempt=excluded.last_attempt,"
                     "last_success=COALESCE(excluded.last_success,last_success),"
                     "last_error=excluded.last_error,next_retry=excluded.next_retry",
                     (provider.name, provider.capability, state, 1, int(good), int(not good), streak,
                      raw, parsed, elapsed, now, now if good and raw else None,
                      None if good else status, retry))


def _available(provider):
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT state,next_retry FROM ig_provider_health WHERE provider=?",
                           (provider.name,)).fetchone()
        if not row:
            return True
        if row["state"] == "HALF_OPEN":
            return False
        if row["state"] != "OPEN":
            return True
        if row["next_retry"] <= time.time():
            changed = conn.execute("UPDATE ig_provider_health SET state='HALF_OPEN' "
                                   "WHERE provider=? AND state='OPEN' AND next_retry<=?",
                                   (provider.name, time.time()))
            return changed.rowcount == 1
        return False


def _request(provider, pattern):
    started = time.monotonic()
    try:
        with requests.get(provider.endpoint, params={provider.query_field: pattern, "output": "json"},
                          headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                          timeout=8, stream=True) as response:
            if response.status_code != 200:
                status = "rate_limited" if response.status_code == 429 else f"http_{response.status_code}"
                return [], status, time.monotonic()-started, 0
            payload = response.raw.read(MAX_BYTES+1, decode_content=True)
        if len(payload) > MAX_BYTES:
            return [], "oversized_response", time.monotonic()-started, 0
        if not payload.strip():
            return [], "empty", time.monotonic()-started, 0
        data = json.loads(payload)
        if not isinstance(data, list):
            return [], "parsing_failure", time.monotonic()-started, 0
        entries = [entry for entry in data[:provider.max_results] if isinstance(entry, dict)]
        if len(entries) != min(len(data), provider.max_results):
            return [], "parsing_failure", time.monotonic()-started, len(data)
        return entries, "healthy" if entries else "empty", time.monotonic()-started, len(data)
    except (ValueError, TypeError):
        return [], "parsing_failure", time.monotonic()-started, 0
    except requests.exceptions.RequestException as exc:
        return [], _status(exc), time.monotonic()-started, 0
    finally:
        from app import db
        db.add_external_wait(time.monotonic()-started)


def query_certificates(pattern, *, allow_fallback=True):
    """At most one primary and one configured fallback request per query."""
    ensure()
    _last_provider.set(None)
    attempted = 0
    total_elapsed = 0.0
    for index, provider in enumerate(providers()):
        if index and (not allow_fallback or _fallback_calls.get() >= 1):
            break
        if not _available(provider):
            continue
        if index:
            _fallback_calls.set(_fallback_calls.get()+1)
        attempted += 1
        entries, status, elapsed, raw = _request(provider, pattern)
        total_elapsed += elapsed
        _record(provider, status, raw, len(entries), elapsed)
        _last_provider.set(provider.name)
        if status in ("healthy", "empty"):
            return entries, status, total_elapsed
    return [], "circuit_open" if attempted == 0 else status, total_elapsed


def preflight(*, dns_timeout=4):
    """A short real-network check. Never falls back to a simulation."""
    import threading
    def lookup(host):
        answer = {"host": host}
        def resolve():
            try:
                answer["address"] = socket.gethostbyname(host)
            except OSError as exc:
                answer["error"] = str(exc)[:120]
        thread = threading.Thread(target=resolve, daemon=True)
        thread.start()
        thread.join(dns_timeout)
        if thread.is_alive():
            answer["error"] = "dns_timeout"
        return answer
    control = lookup("chatgpt.com")
    provider_dns = lookup(urlsplit(providers()[0].endpoint).hostname)
    if "error" in control or "error" in provider_dns:
        return {"state": "LIVE ENVIRONMENT BLOCKED", "control_dns": control,
                "provider_dns": provider_dns, "https": "not_attempted", "certificate": "not_attempted",
                "configured_fallback": len(providers()) > 1}
    start = time.monotonic()
    try:
        response = requests.get("https://chatgpt.com/", timeout=5, stream=True)
        response.close()
        https = {"status": response.status_code, "seconds": round(time.monotonic()-start, 3)}
    except requests.exceptions.RequestException as exc:
        https = {"error": _status(exc), "seconds": round(time.monotonic()-start, 3)}
    if "error" in https:
        return {"state": "LIVE ENVIRONMENT BLOCKED", "control_dns": control,
                "provider_dns": provider_dns, "https": https, "certificate": "not_attempted",
                "configured_fallback": len(providers()) > 1}
    _, status, elapsed = query_certificates("example.com")
    return {"state": "LIVE ENVIRONMENT READY" if status in ("healthy", "empty") else "LIVE ENVIRONMENT BLOCKED",
            "control_dns": control, "provider_dns": provider_dns, "https": https,
            "certificate": {"status": status, "seconds": round(elapsed, 3), "provider": last_provider()},
            "configured_fallback": len(providers()) > 1}
