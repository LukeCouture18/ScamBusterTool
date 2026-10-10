# Site Finder v2 — implementation report

The full report covers Site Finder and the Main Platform together, since v2 is one workflow: see `../../../V2_IMPLEMENTATION_REPORT.md` (weaknesses found in v0.7 and how v2 fixes each), `../../../V2_BENCHMARK_REPORT.md` (v1 vs v2 results and method) and `../../../V2_MIGRATION_NOTES.md` (settings and rollback).

Site Finder-specific pointers:

* Code: `app/v2/`. `engine.py` runs a round. `strategies.py`, `classify.py` (gates), `signals.py` (evidence), `score.py`, `cluster.py`, `adaptive.py` (learning), `inbox.py`, `platform_bridge.py`, `autopilot.py`, `store.py` (tables `v2_*`), `netio.py` (every network touch), `domains.py`.
* UI: `/` is the v2 inbox; the v0.7 dashboard is at `/advanced`. CLI: `round`, `inbox`, `v2-stats`, `benchmark`.
* Tests: `tests/test_v2_precision.py` (29 tests). The v0.7 suite is unchanged and passes.
* Benchmark: `benchmark/world.py` (simulated internet), `benchmark/simnet.py` (routes `requests`/`socket` into it), `benchmark/run.py` (v1 vs v2), `benchmark/report.py`, `benchmark/live_ab.py` (blind live comparison), `benchmark/results/` (raw results behind the report).
* Fixes to v0.7 paths: confidence mapped into [0, 1] (`integration/v4/translator.py`, `emitter.py`); bundled SDK synced to the canonical schema 3.0 client (`integration/v4/main_investigation_client.py`); pre-triage observation batches off by default under v2 (`discovery/engine.py`); `DISCOVER_SITES` and v2 `FIND_RELATED_SITES` handling (`integration/v4/jobs.py`); the decision pull in the sync loop (`integration/v4/sync.py`).
