"""
Site Finder's integration with the Main Investigation Platform.

There is exactly one wire standard in this codebase and it is the platform's.
Everything lives in `app.integration.v4`, built on the platform's own vendored
Python SDK. The v0.5 modules that defined a Site-Finder-shaped contract
(`contract.py`, `client.py`, `emitter.py`, `sync.py`, `reference_platform.py`)
were removed in v0.6 rather than kept alongside it — two competing contracts is
the failure this release exists to prevent.

Anything Site Finder needs that v4 does not express is recorded in
`v4.gap_report`, not worked around with an invented event, field or endpoint.

`handoff.py` remains here: it decides WHO investigates a candidate, which is
Site Finder's own policy question, and then expresses the answer through the
v4 contract.
"""
from app.integration.v4 import (          # noqa: F401  (re-exported for callers)
    contract, client, emitter, sync, jobs, feedback_sync, gap_report, translator,
)
