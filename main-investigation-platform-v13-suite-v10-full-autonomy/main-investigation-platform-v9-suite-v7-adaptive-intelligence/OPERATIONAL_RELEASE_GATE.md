# Main Platform Site Finder operational investigation RC: release gate

**Recommendation:** Package as a verification candidate. Do not call production verified or clear the release gate. Live discovery and browser-backed workflows could not be verified in this workspace; the matched full-workload graph overhead is 28%, above the 10–15% target.

## Architecture and capabilities

The existing Candidate Intelligence, graph, campaigns, frontier, provenance, Main Platform structure, launcher paths, and safety boundaries remain. The operational layer adds a scoped SQLite connection for each discovery round, batched strategy statistics, one-statement graph entity upserts, per-round SQL/network cost records, persistent bounded run state and campaign watches, target dead-end outcomes, certificate provider health with a circuit breaker and one-query configured HTTPS fallback, a DNS/HTTPS preflight, and compact controls in the existing investigation panel. The public-data pivot remains a lead; eligibility and campaign relationship gates are unchanged.

Persistent schema versions 3 and 4 add provider health, sustained runs, campaign watches, round cost, and target outcomes. An explicit rollback on a database copy drops only these operational tables. A prior RC database with one candidate, two graph entities, and one frontier action migrated from `[1,2]` to `[1,2,3,4]` without losing those records; a queued run remained visible after module reload. The scheduler caps rounds, time, requests, actions, fetches, and idle rounds. A 50-round deterministic run completed due to its round cap, used 3,600 simulated requests, recorded 50 round costs, and grew to 3.15 MB. It delivered zero candidates on that fixture; this is a scheduler endurance result, not evidence of useful lead yield.

## Matched deterministic evaluation

All comparisons used the restored Active Investigation RC and upgraded code on the same seeds 101, 202, 303, five rounds per seed, with unchanged simulation data and judgment.

| Metric | Prior RC | Operational RC |
| --- | ---: | ---: |
| Normal useful@5 | 74/75 | 74/75 |
| Normal unique useful campaigns | 70 | 70 |
| Normal graph true/false links | 61/0 | 61/0 |
| Normal engine round seconds, 15 rounds | 41.83 | 4.42 |
| Stress useful@5 | 75/75 | 75/75 |
| Stress unique useful campaigns | 72 | 72 |
| Stress graph true/false links | 34/0 | 34/0 |
| Stress engine round seconds, 15 rounds | 40.89 | 4.20 |
| Hidden useful domains found through pivots | 6 | 6 |
| Multi-hop useful endings | 3 | 3 |

The separate multi-hop fixture found nine useful sites with the active planner versus three with it disabled in both versions. The new operational layer improves speed; it did not improve shortlist quality or graph precision on these fixtures.

## Profile and performance

A single identical normal round was traced before changes: 3,268 connections, 11,558 SQL statements, 3.156 seconds. After the optimization: 41 connections (98.7% fewer), 7,467 statements (35.4% fewer), about 0.347 seconds. The top prior costs were repeated strategy stat writes, entity UPSERT plus ID lookup, candidate lookups, and transaction boundaries. These are instrumented measurements, not estimates.

On a separate matched 15-round full workload, the prior RC took 61.65 seconds graph enabled and 53.06 seconds graph disabled; the operational RC took 16.97 and 13.23 seconds respectively. Graph-enabled full runtime is 72.5% lower than the prior RC. Current graph overhead relative to its graph-disabled reference is 28.3%, so the requested 10–15% overhead target remains unmet. The two timing harnesses cover different work: the engine-only rounds and the full workload must not be compared as if identical. Internal per-round timing records separate SQL, connection, commit, and measured external waits; remaining wall time includes Python computation and fixture orchestration.

## Tests and integration

The first unfiltered Site Finder pytest run had 498 passes and 15 failures: 14 browser/navigator tests could not launch Playwright's browser runtime, and one new crash-recovery test failed before its fixture correction. The Chromium file available in the workspace segfaulted; a Playwright browser download returned a truncated archive. A focused six-test operational suite passed after correcting its fixture. The exact packaged ZIP was extracted into a clean directory and its non-browser subset passed **494/494** tests in 154.51 seconds. The 19 excluded tests live in the three browser suites and two navigator/wallet browser-backed suites. Exclusion is only diagnostic; the complete suite remains an open gate.

Ten of eleven Main Platform aggregate groups passed after restoring the local Python and Node dependencies: unit, migration matrix, v6 integration, v2, v3, v4, v5, five-module joined flow, five-module integration, and startup across Site Finder, Site Investigator, Wallet Investigator, and Form Submitter. The `site-finder` aggregate group could not clear its browser tests because Chromium was unavailable. The launcher and folder paths were not changed. The synthetic handoff/startup groups passed; real downstream network investigations were not exercised.

## Live-source diagnostic

A bounded live preflight failed before any discovery round. DNS lookup of both `chatgpt.com` and `crt.sh` returned `Temporary failure in name resolution`. HTTPS and certificate queries were therefore not attempted. Live rounds: 0; live eligible candidates: 0; live pivot discoveries: 0. The provider circuit breaker and configured fallback passed deterministic tests, but recovery against a real independent public source remains unverified. No fallback URL was configured; none was fabricated.

## VERIFIED / SIMULATED / LIVE-TESTED / STILL UNVERIFIED

- **Verified locally:** schema migration and restart persistence on a populated previous-RC database; scoped connection and statement reductions; six focused operational tests; 494/494 tests in the package’s non-browser regression subset; ten Main Platform aggregate groups; persisted 50-round scheduler run; launcher-facing path comparison.
- **Simulated:** normal and stress shortlist/graph precision; bounded multi-hop pivots; circuit-breaker fallback and recovery; source failures; 50-round endurance. These fixtures do not establish live source yield.
- **Live-tested:** network preflight only, which diagnosed DNS failure. There was no successful live discovery.
- **Still unverified:** real browser frontend → API → persistence workflows in this package; 11/11 aggregate groups; real certificate fallback and source recovery; sustained useful lead yield with reachable sources; production-scale concurrency/crash behavior; the 10–15% graph overhead target; production suitability.

The package preserves the Main Platform directory structure and launcher-facing paths. It is a **verification candidate**, pending a working browser and reachable public sources plus a repeat of the complete release gate.
