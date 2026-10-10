"""
Public page-scan search: which *already publicly scanned* pages share a build file,
title, favicon or IP with a site Site Finder has seen.

The default endpoint is the urlscan.io search API (GET /api/v1/search/?q=...), which
answers from scans that other people and services already published. Site Finder
never submits a scan, never visits the result pages here (they go through the normal
probe and gate like any other lead), and sends no credentials beyond an optional API
key header the operator configures (URLSCAN_API_KEY).

The provider shares Site Finder's persistent provider-health table and circuit
breaker (app.v2.sources), so an outage is recorded, retried after a cooldown and
never retried in a tight loop.

    SITE_FINDER_PAGE_SEARCH_URL   default https://urlscan.io/api/v1/search/ ; "" disables
    URLSCAN_API_KEY               optional
"""
from __future__ import annotations

import json
import os
import time

import requests

from app.config import USER_AGENT

DEFAULT_URL = "https://urlscan.io/api/v1/search/"
MAX_BYTES = 1_500_000
FIELDS = {"asset": "filename", "title": "page.title", "favicon": "hash", "ip": "page.ip", "host": "domain"}
_override: dict = {}


def endpoint() -> str:
    if "url" in _override:
        return _override["url"]
    return os.environ.get("SITE_FINDER_PAGE_SEARCH_URL", DEFAULT_URL).strip()


def configure(url: str | None):
    """Tests and benchmarks: set an endpoint ("" disables); None restores the environment."""
    if url is None:
        _override.pop("url", None)
    else:
        _override["url"] = url


def provider():
    from app.v2.sources import Provider
    return Provider("page_search", "page_search", endpoint(), expected="urlscan_json", max_results=100)


def available() -> bool:
    if not endpoint():
        return False
    from app.v2 import sources
    return sources._available(provider())


def query_for(kind: str, value: str) -> str:
    field = FIELDS[kind]
    value = value.replace('"', "")
    return f'{field}:"{value}"'


def search(kind: str, value: str) -> tuple[list, int, str]:
    """(registrable domains, total matches, status). Never raises."""
    from app.v2 import domains, sources
    if kind not in FIELDS or not endpoint():
        return [], 0, "unavailable"
    prov = provider()
    if not sources._available(prov):
        return [], 0, "circuit_open"
    started = time.monotonic()
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if os.environ.get("URLSCAN_API_KEY"):
        headers["API-Key"] = os.environ["URLSCAN_API_KEY"]
    status, names, total = "healthy", [], 0
    try:
        with requests.get(prov.endpoint, params={"q": query_for(kind, value), "size": 100},
                          headers=headers, timeout=10, stream=True) as resp:
            if resp.status_code != 200:
                status = "rate_limited" if resp.status_code == 429 else f"http_{resp.status_code}"
            else:
                raw = resp.raw.read(MAX_BYTES + 1, decode_content=True)
                if len(raw) > MAX_BYTES:
                    status = "oversized_response"
                else:
                    data = json.loads(raw or b"{}")
                    results = data.get("results") if isinstance(data, dict) else None
                    if not isinstance(results, list):
                        status = "parsing_failure"
                    else:
                        total = int(data.get("total") or len(results))
                        for r in results:
                            page = (r or {}).get("page") or {}
                            host = str(page.get("domain") or (r.get("task") or {}).get("domain") or "").lower()
                            reg = domains.registrable(host)
                            if reg and reg not in names and not domains.is_allowlisted(reg):
                                names.append(reg)
                        status = "healthy" if names else "empty"
    except (ValueError, TypeError):
        status = "parsing_failure"
    except requests.exceptions.RequestException as exc:
        status = sources._status(exc)
    finally:
        from app import db
        db.add_external_wait(time.monotonic() - started)
    sources._record(prov, status, total, len(names), time.monotonic() - started)
    return names, total, status
