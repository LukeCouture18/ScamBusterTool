# Main Platform v2 + Site Finder v2 — upgrade notes

## What changes for you

* The Main Platform opens on the **Inbox** (`/`): one candidate at a time, OPEN SITE, SKIP, USEFUL. Keyboard: `O`, `S`, `U`.
* The v6 overview dashboard moved to `/overview`. Orchestrator, investigations, integration status and the API reference are unchanged under **Advanced** in the sidebar.
* Site Finder's own UI (`python cli.py serve`) also opens on an inbox. Its full v0.7 dashboard is at `/advanced`. When Site Finder is linked to the Main Platform, use the platform inbox. Decisions made in either place are shared.

## Upgrade steps

1. **Back up** the platform database (`.wrangler/state`, or your `MIP_PERSIST_TO` directory) and Site Finder's `data/scamhunter.db`.
2. Replace the platform folder with this one. The Site Finder folder is still `integrations/site-finder-v07`, so the Launcher and any scripts that start it keep working unchanged.
3. Platform: `npm ci`, `npm run build`, `npm start`. `npm start` applies pending D1 migrations, and **`0008_inbox_v2`** is additive (three new tables; no existing table or column changes). Remote deployments apply it through their usual migration step. The startup schema gate refuses requests until 0008 is present, so an unmigrated database fails safely.
4. Site Finder: no manual migration. v2 creates its own `v2_*` tables in the existing SQLite file on first use. `pip install -r requirements.txt` is unchanged. Installing `dnspython` is optional; it enables nameserver-based parking detection.
5. Start Site Finder as before (`python cli.py serve`). The v2 autopilot starts with it.

## Test harness on Windows

The acceptance harness runs the same under PowerShell/cmd.exe as under a POSIX shell:

* Tests import generated bundles and module files through `file:` URLs (`pathToFileURL`) and read their own location with `fileURLToPath`, the same way `scripts/sites-env.mjs` and `scripts/run-framework.mjs` already did. Raw `C:\...` paths and `URL.pathname` are no longer used anywhere in `tests/`. The shared helpers are in `tests/lib/portable.mjs`.
* Multi-step npm scripts run through `scripts/run-tests.mjs` instead of `VAR=1 cmd`, `( cd dir && ... )`, `python3` or `.venv/bin/python`. The script names, steps, order, flags and environment are unchanged.
* Python resolves in this order: `MIP_PYTHON`, `.venv\Scripts\python.exe` (Windows) or `.venv/bin/python`, an activated `VIRTUAL_ENV`, then `python` or `py -3` (Windows) or `python3` on PATH. Python children run with UTF-8 I/O (`PYTHONUTF8=1`).
* Startup tests now wait for module processes to exit before deleting their temporary folders. Server logs go to a file rather than an undrained pipe, and appear in the failure message. A SQLite handle that kept Site Finder's test database locked on Windows is now closed.
* `site-bridge-synthetic.py` and `site-bridge-worker.py` hit WinError 32 because of Site Investigator's `Database`. It opens a new `sqlite3` connection per query and uses it as a context manager, which commits but does not close. CPython's `sqlite3.Connection` also sits in a reference cycle with its statement cache, so the file stays open until the garbage collector happens to run (27 open handles per run of the synthetic test). The tests now use `tests/lib/si_database.py`'s `OwnedDatabase`: the frozen class, unchanged, except that it records every connection its own `connect()` opens and closes them before the temporary directory is removed. On Linux it also asserts that no handle under the directory is still open, so this leak now fails on every OS instead of only on Windows. Site Investigator itself is unchanged.
* `run_tests_standalone.py` can start its fixture server on Windows (spawn start method). It now fails, rather than passing with zero tests, when a file you name is missing or cannot be imported.
* Repeated runs exposed a real Site Finder v2 bug. After the probe-budget floor was applied, the shares were renormalised, which could push a weak strategy back below its 5% floor. The test that covers this failed intermittently. Every strategy now keeps exactly the floor and only the remainder is shared by value. Benchmarks re-run after the fix: eval and dev are unchanged; stress v2 is 347/347 (was 342/342).
* `npm run test:doctor` reports the interpreter and tools it resolved, and flags any reintroduced non-portable pattern. `npm run test:all` runs every group and prints PASS/FAIL for each.

## Configuration

Site Finder (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FINDER_V2` | `1` | `0` restores v0.7 behaviour (FIND_RELATED_SITES campaigns, pre-triage observation batches). |
| `V2_AUTOSTART` | `1` | Start the v2 autopilot with `cli.py serve`. |
| `V2_INBOX_TARGET` | `10` | Standalone only: keep this many candidates waiting. |
| `V2_AUTOPILOT_INTERVAL_SECONDS` | `1800` | Standalone only: how often to check whether a round is needed. |
| `V2_AUTO_INVESTIGATE` | `0` | `1` sends promoted candidates with `request_downstream=true`, so Site Investigator runs before you decide (v1 behaviour). With the default, it runs when you mark USEFUL. |
| `V1_SEND_DISCOVERY_OBSERVATIONS` | `0` with v2 | v0.7 queued a platform batch for every discovered domain before triage. |
| `SITE_FINDER_MODULE_VERSION` | `2.0.0` | Reported at registration. |

Main Platform (`PATCH /api/v1/inbox/settings`, stored in `inbox_settings`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `target_depth` | 10 | Queue `DISCOVER_SITES` for Site Finder when fewer than this many candidates are waiting. |
| `min_score` | 0.6 | Floor under Site Finder's own bar. |
| `investigate_on_useful` | true | USEFUL routes `INVESTIGATE_SITE` via the planner (normal budget, capability and freshness checks). |
| `find_related_on_useful` | true | USEFUL queues `FIND_RELATED_SITES` for Site Finder, seeded with that site. |
| `discovery_http_budget` | 200 | HTTP requests per discovery round requested from Site Finder. |
| `max_discovery_jobs_per_day` | 48 | Cap on inbox-driven discovery jobs. |
| `lease_minutes` | 15 | How long a shown candidate is reserved for you before it can be shown again. |

## Contract changes (all additive)

* Site Finder now sends ingest batches as **schema 3.0**, as the canonical SDK always did. The copy bundled inside Site Finder still sent `1.1`. Under 1.1, a promoted site could never produce `site.triaged`, so downstream work was never routed. This is fixed by syncing the bundled copy with `sdk/python`.
* Site Finder no longer sends raw v0.7 triage scores (6–20 points) as `confidence`. The platform's schema caps confidence at 1.0 and dead-lettered those records. Scores are now mapped into [0, 1].
* New passthrough block `sites[].inbox` (version `"2"`) on promoted Site Finder site records; see `API.md` → *v2 investigation inbox* and `sdk/contracts/v6.json` → `site_finder_v2_inbox`.
* New endpoints: `/api/v1/inbox*` (UI and module-authenticated decision feed). New Site Finder job type handled: `DISCOVER_SITES` (already in the contract's job list).
* `integrations/local_scheduler.py` (the no-browser maintenance loop) also calls `POST /api/v1/inbox/supply` after each maintenance tick, so discovery keeps the inbox stocked when nobody has it open. The deployed Worker's cron does the same. The supply call is a separate `supply()` step: `tick()` is unchanged from v6.1 (feedback dispatch, then monitoring), so a supply failure, or a platform without the endpoint, cannot stop feedback delivery. A failed supply call appears in the loop's output as `"inbox_supply": {"ok": false, ...}`.
* The WalletLogger compatibility adapter now matches `www.` hosts to the existing site investigation. WalletLogger evidence for a site you marked USEFUL therefore joins that investigation. CryptoWalletLogger itself is unchanged.

## Not modified

CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter are unchanged; their source folders in this bundle are byte-identical to v6.1. The Launcher is not part of this bundle and was not touched. Site Finder keeps its folder name and entry points (`cli.py serve`, `app/review/server.py`) so the Launcher starts it exactly as before.

## Rolling back

* Site Finder: `FINDER_V2=0` (v0.7 paths are intact), or restore the previous folder. The `v2_*` tables are ignored by v0.7.
* Platform: restore the previous build. Migration 0008 only added tables, so a v6.1 build runs against a migrated database, although its startup gate does not look for them.
