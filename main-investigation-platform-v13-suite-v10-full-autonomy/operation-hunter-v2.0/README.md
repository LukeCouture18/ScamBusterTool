# Operation Hunter v2.0 — Autonomous Reconstruction & Pursuit

Give Hunter almost any useful clue — a scam site, a wallet, an IP, an analytics ID — and it reconstructs the operation behind it, pursues it autonomously, and keeps a **living model** of it over time: which sites belong (and why), each site's life (registered → live → dark → back), how the infrastructure moved, how the kit evolved, where the money goes, whether the operation is running, dormant or mid-rotation, when its next wave is due, which explanations compete, what contradicts, what is still unknown, and where to look next. Standing hunts keep watching for the operation's return after you close the tab.

When you open an operation you see the **3–5 strongest discoveries**, one line on the operation's state, and the **3 most valuable next lookups** — each with why it matters, how uncertain it is and what it does *not* prove. Everything underneath (model history, membership explanations, evidence matrix, branches, hunts, graph, raw evidence) is one click away.

Hunter is a standalone application and the deep reconstruction/pursuit engine of the **Main Investigation Platform** (module `operation_hunter`). See `RELEASE_NOTES_v2.0.md` for what changed and `BENCHMARK_v2.0.md` for the ground-truth comparison with v1.0.

> **With Site Finder v3:** when Hunter asks the platform to find more sites like an operation, the request now carries the operation's operator-level indicators (wallets, API hosts, analytics IDs, contacts). Site Finder turns it into a hunt ("Looking for new deployments related to Operation X") and returns candidates with the chain that led to each one. Those are candidates only: a shared kit or host is never treated as the same operator.

## Quick start (Windows 11)

1. Install Node.js **22.13 or newer** (Hunter uses Node's built-in SQLite).
2. Run `setup.bat` (installs, builds the UI, creates `.env`).
3. Run `start.bat` and open http://localhost:3000.

Command line equivalent: `npm install && npm run build && npm start`. For development with hot reload: `npm run dev`.

**Upgrading from v1.0:** keep your `data/` folder. On first start the database migrates to schema 2 in place (additive; every operation, evidence record and pursuit is kept) and the living model is built on first analysis. **Upgrading from v0.x:** copy your old `data/hunter_store.json` into `data/`. On first start Hunter imports it into `data/hunter.db`, keeps a backup (`hunter_store.v0-backup-*.json`), and quarantines anything that came from the old simulated collectors. The v0.x screens remain available under **Classic views**.

## What's in the box

| Area | What Hunter does |
|---|---|
| Living model (v2) | Rebuilt after every change and versioned with readable diffs: members with explained probabilities, site lifecycles, deployment waves and next-wave forecast, infrastructure history from a temporal fact ledger (appeared / changed / disappeared / resurfaced / sources disagree), kit lineage, money pipeline and exits, other operator groups kept apart, competing explanations (ACH matrix with the test that would separate them), persisted contradictions, open unknowns. |
| Membership (v2) | Probabilistic, explainable inference: operator settings, wallets, per-deployment files, certificates, private hosting, redirects, timing and naming, negative evidence; indicator levels (operator / vendor / infrastructure / service / commodity); planted or copied settings detected; membership must chain back to your seed through non-kit evidence. Your verdicts (and Main inbox rejections) override it and calibrate it. |
| Autonomous pursuit | Durable, resumable runs. v2 allocates lookups by expected progress per unit of cost (a contextual learner with delayed credit — progress, not data volume), organises work into lines of inquiry that saturate, park and are revisited, runs hypothesis-driven naming/title searches, respects a daily lookup budget shared across operations, and stops on diminishing returns. |
| Standing hunts (v2) | Per operation: new domains on its private nameservers, names fitting its naming template, sites loading its per-deployment files or showing its page title, new money movements. Cadence tightens when a wave is due. New sites are verified and judged on operator-level evidence before being called a return. |
| Collection (passive, public) | DNS, certificate transparency (crt.sh), RDAP registration, RIPEstat routing, HackerTarget reverse lookups, existing urlscan.io scans (read-only), Blockscout (EVM networks), TronGrid, mempool.space, the Main Platform's own evidence. Per-host pacing, retries and a response cache. |
| Infrastructure | Core vs peripheral sites, hosting, private nameservers, registration waves, naming patterns, rotations after takedowns, standby/reserve domains; shared services (CDNs, big registrars) are recognised and never treated as ownership links. |
| Kits | Page-structure fingerprints, kit families and versions, capabilities; **kit/vendor-level** indicators separated from **operator-level** ones. |
| Money | Victim → collection → splitter → treasury/fee → exchange/mixer/bridge, sweep timing, splits, wallet rotations, deployers, cross-chain. |
| Reasoning | Competing hypotheses scored against evidence (with what would strengthen/weaken each), contradictions, evidence gaps with one-click fills, cross-operation comparison with capped kit/hosting scores. |
| Watching | Monitors re-check nameservers, seeds and operational wallets; new sites are compared with the operation's fingerprint — a "likely return" requires operator-level matches. |
| Evidence | Every observation stored once with source, time and SHA-256; relationships carry their evidence; invalidating a record recomputes everything that used it. Markdown dossier and JSON export. |

Safety boundaries are unchanged: discovery is passive and public, Hunter never logs in, submits forms, bypasses protections or moves funds, and shared infrastructure/kits/wallets are never presented as proof of shared ownership. Demo operations use a clearly labelled synthetic world and never mix with real data.

## Connecting to the Main Investigation Platform

1. In Main (Platform v5 · Operations with the Operation Hunter upgrade), add an `operation_hunter` key to `MODULE_API_KEYS` and apply the ordered D1 migrations (the upgrade adds `drizzle/0012_operation_hunter.sql`).
2. In Hunter → **Settings & sources**, enter the Main URL, that key, and the address Main should use to link back to Hunter. Press **Test**.

Main stays the coordinator; Hunter is its reconstruction and pursuit engine. What then happens automatically:

- **Main asks.** Main's scheduler proposes `reconstruct_operation` work for campaigns with enough sites and for sites where a module observed a wallet (you can also press **Reconstruct with Operation Hunter** on a campaign). It runs as a `HUNT_OPERATION` job within Main's budgets; Hunter claims it, adds every seed (a campaign's sites and wallets) and pursues.
- **Hunter reports.** Each operation with 2+ member sites gets its own Main investigation holding its member sites, operation wallets, indicators, evidence (with SHA-256) and relationships. Hunter then syncs its living model: state, forecast, competing explanations, unknowns, the 3–5 strongest discoveries, next lookups, members with the reason for each, open contradictions, and fresh site observations.
- **Main decides.** Hunter's proposals become Main's own typed work — member sites become inbox candidates and `investigate_candidate` work, operation wallets become `analyze_wallet` work, significant contradictions become human tasks — and Hunter's site observations flow through Main's temporal layer (a real change triggers Main's usual reactions; the same value again is nothing; a different source at the same moment is a contradiction). Nothing Hunter proposes runs without Main's scheduler, reviewer and budgets. Evidence gaps are proposals too: when an operation is mid-rotation, a wave is due or fewer than three members are known, Hunter proposes `find_related` ("find more sites like these"); Main turns it into a budgeted Site Finder discovery job seeded with the operation's sites. Hunter's screens share Main's palette (`src/v1/suite.css`, generated block from Main's `scripts/sync-ui-tokens.mjs`).
- **Both learn.** Rejecting a Hunter-proposed site in Main's inbox as *not a scam* teaches Hunter's membership calibration. A reconstruction's usefulness (members found) feeds Main's outcome learning. New Site Finder sites reach Hunter as events and are checked against every operation.

Deliveries go through a durable outbox with retries, so Hunter keeps working when Main is offline and catches up later. See `INTEGRATION.md` for the wire contract.

## Operations & data

- Data: `data/hunter.db` (SQLite, WAL). Daily backups in `data/backups/` (7 kept); **Settings → Back up now** for an immediate copy.
- Configuration: `.env` (see `.env.example`) or Settings. `HUNTER_NETWORK_MODE=offline` keeps Hunter off the public internet.
- Tests: `npm test` (45 tests: store and migrations incl. a real v1.0 database, collectors against recorded API formats, engine, scenarios, the living model, analyst verdicts, restart durability, performance, HTTP API, integration against a fake Main, ground truth on an adversarial world, and the **joined workflow against the real Main Platform v5 code** — `tests/main-joined.test.ts`, which needs the Main Platform folder beside this one (or `MAIN_DIR`) with its dependencies installed; it is skipped otherwise. Main runs the three-way Site Finder → Main → Hunter test from its side: `npm run test:joined:hunter`).
- Benchmark: `node --import tsx bench/run.ts --engines v2 --kinds domain,shared,wallet` (add `v1` with `V1_DIR` pointing at a v1.0 checkout).

## Layout

```
server.ts                  HTTP server, schedulers, recovery, backups
server/core                SQLite store, migrations, canonical keys, model
server/collectors          passive collectors + HTTP client + pivot catalogue
server/engine              ingest, planner, strategy learning, pursuit, monitors
server/model               v2 temporal facet ledger, living model (lifecycles, forecast, ACH, contradictions, versions), model findings
server/reasoning           v2 membership inference and verdict calibration
server/pursuit             v2 allocator, contextual learner, progress & delayed credit, branches, search patterns, resource governor, standing hunts
server/analysis            graph, infrastructure, money, kits, timeline, hypotheses, gaps, reappearance, findings
server/services            operations, views, report, compatibility with v0.x API
server/integration         Main Platform client + worker (outbox, jobs, events, decisions)
server/api                 router and routes (/api/v1/* and the v0.x endpoints)
src/v1                     UI (Brief with model strip and next lookups, Living model view, deep views, Settings)
bench                      ground-truth world generator, fake public APIs, v1/v2 benchmark
src/App.tsx, components    Classic v0.x views
tests                      node:test suites and fixtures
```
