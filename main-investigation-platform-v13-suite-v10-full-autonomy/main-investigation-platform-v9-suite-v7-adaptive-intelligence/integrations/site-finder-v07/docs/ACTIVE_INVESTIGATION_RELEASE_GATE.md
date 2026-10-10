# Active Investigation release gate

This candidate extends the Investigation Intelligence RC. The Main Platform folder layout and launcher-facing paths are unchanged. Results below distinguish matched-pool ranking, fixture-driven multi-step discovery, and public-network observations.

## Architecture and capabilities

- Schema version 2 adds persistent paths, deduplicated frontier actions, results with source provenance, hypotheses, negative evidence, technique outcomes, and source health. Existing Candidate Intelligence, campaign evidence thresholds, and ordinary eligibility gates remain in force.
- One bounded investigation action runs per discovery round. Paths have a four-action budget and depth limit of three; each action has an eight-lead cap. Certificate discovery uses a public certificate-transparency lookup. Optional public passive DNS supports narrowly capped IP and nameserver pivots. Locally observed wallets, analytics IDs, templates, contacts, and fingerprints can seed known-indicator searches. A pivot result is a lead, never a campaign relationship by itself.
- The planner uses evidence specificity, site quality, novelty, bounded historical outcomes, cost, duplicate risk, and source health. Useful/Skip decisions update technique statistics. Paths and results remain inspectable after restart. An observed contradiction can weaken or reject a graph hypothesis.
- The existing dashboard adds a compact frontier and path history, bounded manual investigations, campaign expansion and pause controls, and a failure notice. The ordinary discovery and review controls remain available.
- Graph ingestion marks new evidence and availability changes dirty; clean repeat observations skip relationship recomputation. This still scans all evidence on a dirty rebuild. It is not a fully incremental graph algorithm.

## Matched-pool evaluation (simulated)

| Scenario, 15 rounds | Previous RC | Active Investigation |
| --- | ---: | ---: |
| Normal useful@3 | 45/45 | 45/45 |
| Normal useful@5 | 74/75 | 74/75 |
| Normal unique useful campaigns | 70 | 70 |
| Normal duplicate slots | 0 | 0 |
| Normal true/false graph links | 61/0 | 61/0 |
| Stress useful@3 | 45/45 | 45/45 |
| Stress useful@5 | 75/75 | 75/75 |
| Stress unique useful campaigns | 72 | 72 |
| Stress duplicate slots | 0 | 0 |
| Stress true/false graph links | 34/0 | 34/0 |

The matched-pool selector did not improve already strong review metrics. The graph precision requirement was preserved. These pools do not include the hidden sites in the next fixture.

## Bounded multi-step investigation (simulated)

Six isolated seeded runs (three normal, three stress) used the same candidate worlds for baseline and upgraded paths. Ordinary discovery arms were held equal so the incremental contribution of the investigation frontier could be measured. The fixture contains hidden sites reached through certificate pivots, dead ends, and noise. Baseline: six useful seed sites, zero hidden sites. Active: 18 useful sites, 12 hidden sites, six requiring multiple hops. In each three-seed scenario the counts were 3 to 9 useful, 0 to 6 hidden, 0 to 3 multi-hop. No graph relationships were inferred in these particular fixtures; zero false links here is not a graph precision measurement. The matched-pool normal and stress tests above exercise graph precision.

Fixture runtime was 1.099 to 2.311 seconds (normal three runs), 1.061 to 2.360 seconds (stress three runs). The additional actions and probes account for this higher cost; database size increased from 2,846,720 to 2,945,024 bytes across the three runs in each scenario. These measurements cannot establish live usefulness.

## Migration and persistence (verified locally)

A database created with the previous RC contained two useful domains, six evidence records, one campaign and its relationship. Applying schema version 2 preserved both candidate rows and the same campaign ID and relationship. A new two-action frontier survived a fresh process. A rollback on a copy removed graph/frontier tables and preserved the two original candidate rows. Automated restart, migration, and browser persistence tests also cover the current schema.

## Performance and diagnostics

A one-round profiler sampled approximately 7,700 SQLite statement executions and 3,400 connection openings. Cumulative SQLite execute time was 4.18 seconds in a 5.92-second profiled discovery round; strategy updates and candidate probes dominated. Planner time was about 0.24 seconds, graph ingestion about 0.20 seconds, inactive-state graph writes about 0.12 seconds, campaign lookup about 0.09 seconds, and graph rebuild about 0.01 seconds in that sampled round. External-source wait was zero in this simulator; the separate bounded live check spent 26.82 seconds awaiting the three certificate responses. Profiler overhead and overlapping inclusive times preclude treating those component times as an additive runtime breakdown.

| Clean matched normal run, 15 rounds | Graph disabled | Graph enabled | Overhead |
| --- | ---: | ---: | ---: |
| Previous RC | 62.58 s | 71.46 s | 14.2% |
| Active Investigation | 61.51 s | 65.94 s | 7.2% |

The upgrade measured 5.52 seconds (7.7%) faster on this normal workload and met the approximate 10–15% graph-disabled overhead target. These are sequential runs on the same simulator and seeds, not concurrent jobs. The graph-disabled baselines include normal discovery work and do not account for the extra probes in a successful multi-step investigation.

On an additional clean stress seed set (404/505/606), both versions selected 75/75 useful sites across 15 rounds, representing 75 labeled useful campaigns without duplicate slots. Both formed 27 true links and zero false links. The old RC took 71.43 seconds. Two sequential runs of the upgrade took 76.66 and 69.18 seconds; the graph-disabled reference in the second run was 63.13 seconds (9.6% overhead). The variation makes a claimed stress speedup or slowdown unsupported. This extra stress set is distinct from the stress seed set in the matched-pool table (101/202/303), which formed 34 true links in both versions. Fixture runtime increases substantially when the frontier actually follows hidden paths.

## Live source check (live-tested; discovery blocked)

Three bounded rounds: three certificate queries, zero certificate records; 24 DNS resolutions, zero resolved; zero fetched pages, zero eligible sites, zero pivot discoveries and zero review sites. The certificate service returned HTTP 502. A control lookup for `chatgpt.com` failed with temporary name-resolution failure. The source-health report persists these failures and distinguishes them from an empty healthy source. No live claim about improved discovery or campaign accuracy follows from this test.

## Verification status and release recommendation

**Verified locally:** schema migration and rollback on a previous-RC database, restart frontier persistence, browser/API/database path for manual action and pause, source diagnostics, bounded actions, compatibility of existing review and graph contracts.

**Simulated:** matched-pool normal and stress selection, graph precision, multi-step hidden-site discovery, dead-end handling, action cost and growth.

**Live-tested:** public-source attempts and failure diagnosis only; no eligible candidate was obtained in this environment.

**Still unverified:** useful live pivot yield, real campaign precision under infrastructure migration, external passive-DNS results without a configured source, live handoff outcomes after investigation actions, and large historical database latency. Hypothesis contradiction depends on observed negative evidence; the system cannot infer absence from a failed source. External wallet/analytics search providers are not available in this environment. No production verification is claimed.

**Regression gate:** 509/509 pytest; 509/509 standalone Site Finder tests; all 11 Main Platform aggregate groups passed. Existing synthetic Site Investigator and Wallet Investigator handoff checks passed in the aggregate groups; no live downstream result was produced by a pivot in this environment.

**Release recommendation:** release candidate for further controlled validation, not production verified. Simulation demonstrates new multi-step candidate yield while retaining prior graph precision and review results; the blocked public sources leave live yield and campaign accuracy unresolved.

## Packaging verification

The corrected archive retains the existing Main Platform root layout and launcher-facing paths. Archive integrity passed. It includes this report and excludes runtime databases, logs, caches, temporary files, test artifacts, documentation screenshots, and the local `.dev.vars` file. Project source, tests, and static assets remain included. This packaging correction did not modify application code or the benchmarked implementation.
