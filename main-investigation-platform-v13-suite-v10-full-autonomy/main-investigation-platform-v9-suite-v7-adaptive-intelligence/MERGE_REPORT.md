# Merge report: Site Finder operational RC + Operation Hunter v2 integration

This folder is the single canonical Main Platform. It contains both of these:

- the Site Finder / Operational Investigation RC
- the Main side of the Operation Hunter v2.0 integration

Operation Hunter itself stays a separate sibling folder (`operation-hunter-v2.0`).

## How the branches relate

Both branches start from the same Main Platform v5 · Operations release. A three-way diff against that base shows two disjoint change sets:

| | Changed files outside `integrations/` | Changed files inside `integrations/` |
|---|---|---|
| Site Finder RC | none (plus `OPERATIONAL_RELEASE_GATE.md`) | `integrations/site-finder-v07/` only: app code (5 new modules, 12 modified files), 7 new benchmarks, 11 new and 1 modified test files, 3 docs, the standalone runner |
| Hunter branch | `lib/ops/*` (7 files + new `hunter.ts`), `lib/platform.ts`, `lib/domain.mjs`, `lib/schema-ready.ts`, 5 new routes, 3 UI components, migration `0012`, contract/SDK module lists, 2 tests, docs | none |

No file was changed by both branches, so no textual conflict had to be resolved by choosing one side. The merged tree is the RC tree with the Hunter branch's Main files applied. Every file in the RC package is present at the same path; nothing was renamed or moved.

## What came from the Site Finder RC (unchanged)

The RC's Site Finder layer is carried over byte for byte:

- Candidate Intelligence
- discovery improvements
- the persistent graph
- campaigns, the frontier and provenance
- the scoped SQLite connection per round and batched writes
- provider health and the circuit breaker, including the HTTPS fallback
- sustained bounded runs, campaign watches and round cost records
- target outcomes
- persistence and recovery (Site Finder schema versions 3 and 4)
- the investigation-panel controls and the existing Site Finder UI
- the integration paths

## What came from the Hunter branch (unchanged)

- Migration `0012_operation_hunter.sql`.
- `lib/ops/hunter.ts`, with sync, proposals, temporal observations, contradictions, the reconstruction generator/payload/reconciliation and the read models.
- The scheduler, executor, team, view, workitems and simulation hooks.
- The `HUNT_OPERATION` job with its `reconstruct_operation` work and `module_jobs` budget.
- The `/api/v1/operations*` routes.
- The "Reconstructed operations" card and the campaign **Operation** tab.
- The contract and SDK module entries.
- `tests/v5-hunter.test.mjs` and the migration-test update.

## Changes made during the merge (and why)

1. **`lib/ingestion.ts`: accept `origin_job_id: null` (same as absent). This is a real defect that the combined test found.**
   - The shared Python SDK (`sdk/python/main_investigation_client.py`) always sends `origin_job_id`, and sends `null` for batches that no platform job asked for. Every autonomous Site Finder v2 round produces such batches.
   - Main's ingest schema only allowed a string or an absent field, so it rejected every such batch with `400`. Site Finder then dead-lettered them.
   - This is identical in the unmodified v5 base and in the RC. The RC's own tests call the route with hand-built batches and never went through the SDK against real Main code, so they could not catch it.
   - I fixed it on Main's side (`.optional()` → `.nullish()`) rather than in the shared SDK that the frozen modules also use.
   - Batches the previous release dead-lettered are delivered once the operator presses "retry deferred" in Site Finder. The joined test verifies this.
2. **`integrations/site-finder-v07/run_tests_standalone.py`: harness only.**
   - It now puts `tests/` on `sys.path`, as pytest does.
   - Its monkeypatch fake gains `setenv`/`delenv`.
   - Before this, the RC's six operational-resilience tests were silently skipped by `npm run test:site-finder` ("need pytest"). They now run and pass.
3. **`tests/site-finder-startup-local.py`: race fixed.**
   - The fake platform records the batch before its HTTP response reaches Site Finder, so the outbox row can still read `queued` for a moment. This happened in 2 of about 25 runs, on the RC tree too.
   - The test now waits up to 10 s for the same `[("sent",)]` state. The assertion itself is unchanged.
4. **New combined test.** `tests/joined-finder-main-hunter.mjs` and `tests/finder-joined-bridge.py`, run by `npm run test:joined:hunter`. The new group is also part of `npm run test:all`.
5. **Docs.** `README.md` and `V5_OPERATION_HUNTER.md` now point here.

No test was weakened or removed.

## Migration path

- **Main D1.** The ordered migrations are `0000`–`0011` (unchanged in both branches), then `0012_operation_hunter.sql` (additive: 4 `hunter_*` tables and 3 `ops_state` settings). There is no numbering conflict, because the RC added no Main migration.
  - The upgrade is `wrangler d1 migrations apply DB`.
  - The joined test upgrades a populated `0011` database in place and checks that every existing row survives and that the schema gate passes. The migration matrix and `v5-migration` tests cover interrupted upgrades.
- **Existing Hunter-enabled Main databases** (from the earlier Hunter delivery) already have `0012`; nothing further applies.
- **Site Finder's own SQLite database** keeps the RC's own schema versioning (3 → 4), independent of Main.
- **Rollback:** drop the four `hunter_*` tables; the RC's Main code reads the database unchanged.

## Test results (this environment)

| Suite | Result |
|---|---|
| Main unit (`npm test`) | 26/26 |
| migration-matrix | 10/10 |
| integration:v6, v2, v3, v4, v5 | pass (v5: all 20 operations scenarios) |
| **joined:hunter** (Site Finder → Main → Operation Hunter) | **9/9** |
| site-finder (whole suite, standalone runner) | **515/515**, including the 4 browser-backed tests and the 6 operational-resilience tests |
| Operation Hunter `npm test` against this Main | 45/45, including its own joined test |
| Type-check of all changed Main files | no new errors (the 9 pre-existing ones are identical in the base) |
| joined:v61, five-modules, startup:modules | blocked by missing packages (see below) |

The RC gate could not run the browser-backed tests or clear the site-finder group. Both run and pass here, because a Playwright Chromium is available.

**Blocked groups:** `sql.js` (Wallet Investigator), `express` (Form Submitter) and `fastapi` (Site Investigator) cannot be installed here, because there is no package registry access. The RC tree fails identically. What does run:
- `joined:v61` runs and passes all its Site Finder, Site Investigator and CryptoWalletLogger → Main assertions. It stops at the Wallet Investigator import.
- `five-modules` steps 1–2 pass.
- `startup:modules` step 1 (Site Finder normal startup) passes.

The RC gate reports all three groups passing on a machine with those packages installed.

## Combined system verified (`joined:hunter`)

1. **Existing installation.** The RC's Main code runs on migrations 0000–0011. Real Site Finder delivers four candidates: three sites of one operation plus an unrelated site on the same IP. The previous release rejects them (the `null` defect above), and they are parked in Site Finder's outbox.
2. **Upgrade in place.** The merged code and `0012` are applied. Every row is preserved, the schema gate passes, and "retry deferred" delivers all four.
3. **Main → Hunter.**
   - The graph-supported group of three becomes a campaign. The co-hosted site is excluded, because a shared IP alone is not support.
   - The scheduler proposes `reconstruct_operation` for the campaign. It is charged to `module_jobs` for `operation_hunter` and dispatched as `HUNT_OPERATION`, with the three sites as seeds.
4. **Hunter → Main.**
   - Hunter finds 9 members, all true. The co-hosted site is not a member.
   - The reconstruction is linked to the campaign, and the campaign workspace shows it.
   - New members become inbox candidates with investigation work. No site gets two candidates, and Site Finder's sites are not re-proposed.
   - Wallets become `analyze_wallet` work.
   - Observations reach the temporal layer, and the two modules agree on the facts they both see.
5. **Duplicates.** A repeated Hunter snapshot, a re-delivered Site Finder batch (Main reports a replay) and a job re-claim create nothing.
6. **Restart.** Main and Hunter restart on their databases. The job reconciles as useful and the campaign is not reconstructed again.
7. **Feedback.**
   - An inbox rejection becomes a `not_member` verdict in Hunter.
   - A USEFUL decision reaches Site Finder's ledger.
   - Site Finder also records the decision on Hunter's candidate as decided (this is its existing behaviour for platform decisions).
8. **Scheduler control.** `module_limit:operation_hunter=1` holds a second reconstruction behind the running one, and `auto_reconstruct=false` stops proposals.

## Performance preserved

The RC's SQLite trace (`python -m benchmark.operational_profile --seed 101 --rounds 1`) measures **41 connections and 7,468 statements** on both the RC tree and the merged tree. The RC report says 7,467; the unmodified RC also measures 7,468 here. Site Finder's code is unchanged, and none of the merged Main changes touch its database path.

## Evidence and membership semantics

These are unchanged:
- Site Finder's observations still say they justify a look, not a conclusion.
- Main's formation still requires a shared wallet, a shared kit, or two kinds of non-generic infrastructure.
- Hunter's anchored membership still keeps shared hosting and shared kits from implying common ownership. The joined test asserts this for the co-hosted site at both the campaign level and the membership level.

## Launcher compatibility

The Main folder root contains `sdk/contracts/v6.json`, `integrations/` and `scripts/start-production.mjs`. There is no wrapper directory, and the Site Finder integration path is unchanged (`integrations/site-finder-v07`).

- The only content change to a launcher-facing file is one extra entry, `operation_hunter`, in `v6.json`'s `modules` list, which comes from the Hunter branch. No script in this folder reads that list, and Site Finder reads only the version fields.
- Frozen modules (Wallet Investigator, Site Investigator, CryptoWalletLogger, Form Submitter) are unmodified.

## Still unverified

- The three module groups blocked by missing packages (above).
- `npm run build` of the Next/vinext UI. The build dependencies are not installable here. The UI files are the RC's plus the Hunter branch's three components, unchanged from those branches.
- Your actual launcher executable. Only the folder layout it expects was checked.
- Live public sources, as in both branches.
