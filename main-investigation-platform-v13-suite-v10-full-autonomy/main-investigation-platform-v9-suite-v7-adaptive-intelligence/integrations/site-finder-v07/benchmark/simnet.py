"""
Routes the process's network calls into a World for the duration of a run.

Both pipelines are exercised through their real code paths: `requests.get` and
`socket.gethostbyname` (the only network primitives Site Finder uses) are
replaced with functions that answer from the simulated world. Every request is
counted per pipeline so cost can be compared as well as quality.
"""
from __future__ import annotations

import contextlib
import io
import socket
import time
from urllib.parse import urlencode, urljoin, urlparse

import requests

from benchmark.world import World


class _Raw(io.BytesIO):
    def read(self, amt=None, decode_content=True):   # noqa: D401 - urllib3 signature
        return super().read(amt if amt is not None else -1)


class FakeResponse:
    def __init__(self, url: str, status: int, headers: dict, body: bytes, history=None):
        self.url = url
        self.status_code = status
        self.headers = requests.structures.CaseInsensitiveDict(headers or {})
        self.content = body
        self.encoding = "utf-8"
        self.history = history or []
        self.raw = _Raw(body)
        self.ok = status < 400

    @property
    def text(self):
        return self.content.decode("utf-8", errors="ignore")

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code} for {self.url}", response=self)

    def iter_content(self, chunk_size=1024):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class SimNet:
    def __init__(self, world: World):
        self.world = world
        self.counts = {"http": 0, "dns": 0, "crtsh": 0, "rdap": 0, "feed": 0}
        self.by_label = {}
        self.label = "unlabelled"

    def _count(self, kind):
        self.counts[kind] = self.counts.get(kind, 0) + 1
        per = self.by_label.setdefault(self.label, {})
        per[kind] = per.get(kind, 0) + 1

    # --------------------------------------------------------------- requests
    def get(self, url, params=None, headers=None, timeout=None, allow_redirects=True, stream=False, **kw):
        if params:
            url = url + ("&" if "?" in url else "?") + urlencode(params)
        history = []
        for _ in range(10):
            host = (urlparse(url).hostname or "").lower()
            self._count("crtsh" if host == "crt.sh" else "rdap" if host == "rdap.org"
                        else "feed" if host.startswith("feeds.") else "page_search" if host == "urlscan.io"
                        else "passive_dns" if host.startswith("passivedns.") else "http")
            answer = self.world.http(url)
            err = answer.get("error")
            if err == "dns":
                raise requests.exceptions.ConnectionError(f"Failed to resolve '{host}' ([Errno -2] Name or service not known)")
            if err == "refused":
                raise requests.exceptions.ConnectionError(f"HTTPSConnectionPool(host='{host}'): [Errno 111] Connection refused")
            if err == "timeout":
                raise requests.exceptions.ConnectTimeout(f"HTTPSConnectionPool(host='{host}'): Read timed out.")
            if err == "tls":
                raise requests.exceptions.SSLError(f"HTTPSConnectionPool(host='{host}'): certificate verify failed")
            resp = FakeResponse(url, answer["status"], answer["headers"], answer["body"], history=list(history))
            if answer.get("redirect") and allow_redirects:
                history.append(resp)
                url = urljoin(url, answer["redirect"])
                continue
            return resp
        raise requests.exceptions.TooManyRedirects(url)

    def head(self, url, **kw):
        return self.get(url, **kw)

    # ------------------------------------------------------------------ DNS
    def gethostbyname(self, host):
        self._count("dns")
        ip = self.world.resolve(host)
        if not ip:
            raise socket.gaierror(-2, "Name or service not known")
        return ip

    def create_connection(self, *a, **kw):
        raise OSError("network disabled in simulation")

    def nameservers(self, host):
        self._count("dns")
        return self.world.nameservers(host)


def _no_real_dns(*_a, **_k):
    raise _dns_exception.DNSException("simulated network: no real DNS")


try:                                   # optional dependency (see requirements.txt)
    import dns.exception as _dns_exception
    import dns.resolver as _dns_resolver
except Exception:                      # noqa: BLE001
    _dns_resolver = None


@contextlib.contextmanager
def installed(net: SimNet):
    """Patches requests/socket (and sleeps) for the duration of the block.

    dnspython sends its own UDP queries, which the socket patches do not see. When it is installed,
    its `resolve` is also replaced so a simulated run never queries the real internet (and behaves
    exactly as without dnspython); nameserver answers come from the world only when a run asks for
    them (engine.configure_for_benchmark(nameserver_fn=net.nameservers)).
    """
    saved = (requests.get, requests.head, socket.gethostbyname, socket.create_connection, time.sleep)
    saved_dns = _dns_resolver.resolve if _dns_resolver else None
    requests.get = net.get
    requests.head = net.head
    socket.gethostbyname = net.gethostbyname
    socket.create_connection = net.create_connection
    time.sleep = lambda *_a, **_k: None
    if _dns_resolver:
        _dns_resolver.resolve = _no_real_dns
    try:
        yield net
    finally:
        requests.get, requests.head, socket.gethostbyname, socket.create_connection, time.sleep = saved
        if _dns_resolver:
            _dns_resolver.resolve = saved_dns
