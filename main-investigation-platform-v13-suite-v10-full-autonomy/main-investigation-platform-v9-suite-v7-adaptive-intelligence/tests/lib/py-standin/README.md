Test-only Python stand-ins, used ONLY when the real packages are not installed
(for example a sandbox where PyPI is unreachable). Put this directory on PYTHONPATH.

* `httpx`  -> re-exports the installed `httpx2` fork (same AsyncClient/MockTransport API).
* `dns.resolver` -> raises on use. Every test that uses it (the hidden-corpus bridge)
  replaces `dns.resolver.resolve` with its synthetic fixture resolver first, so no
  real DNS answer is ever invented here.

Production installs must use the real `httpx` and `dnspython` packages.
