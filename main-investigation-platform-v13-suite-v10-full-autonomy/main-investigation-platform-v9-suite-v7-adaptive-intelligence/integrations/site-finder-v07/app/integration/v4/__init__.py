"""
The canonical Main Investigation Platform v4 integration.

`main_investigation_client.py` in this package is the platform's own Python
SDK, vendored byte-for-byte from `sdk/python/main_investigation_client.py` in
the v4 distribution. It is NOT modified. Everything Site Finder needs from the
platform goes through it, so there is exactly one wire standard in this
codebase and it is the platform's.

Where Site Finder needs something the SDK does not expose, the addition lives
in `sdk_ext.py` as a documented extension built on the SDK's own request
method — never as a second client, and never as a different wire format.

Anything Site Finder needs that the v4 contract does not support at all is
recorded in `gap_report.py` rather than invented here.
"""
