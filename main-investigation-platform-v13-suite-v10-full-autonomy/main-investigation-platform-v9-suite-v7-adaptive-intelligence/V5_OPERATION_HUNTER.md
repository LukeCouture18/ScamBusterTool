# Platform v5 · Operations + Operation Hunter v2.0

This upgrade makes Operation Hunter a first-class module of Platform v5 · Operations. **Main stays the coordinator; Hunter is its specialised engine for reconstructing and pursuing the operation behind a campaign, site or wallet.** Neither duplicates the other: Main decides and executes investigations through its modules; Hunter reconstructs, keeps a living model, hunts for returns, and proposes.

## What changed

| Area | Change |
|---|---|
| Contracts | `operation_hunter` added to `SOURCE_MODULES` (and the SDK module list / `sdk/contracts/v6.json`); job type `HUNT_OPERATION`; work kind `reconstruct_operation` (module `operation_hunter`, budget `module_jobs`, label "Reconstruct operation (Hunter)"). The frozen event type set is unchanged. |
| Migration | `drizzle/0012_operation_hunter.sql` (additive): `hunter_operations`, `hunter_operation_members`, `hunter_proposals`, `hunter_requests`; ops settings `module_limit:operation_hunter=1`, `auto_reconstruct=true`, `reconstruct_min_sites=2`. The schema gate requires it. |
| Coordination | `lib/ops/hunter.ts`: snapshot sync (idempotent), proposal mapping, temporal observations, contradictions, reconstruction generator/payload/reconciliation, read models. |
| Scheduler / executor | The scheduler's `generate` step proposes reconstructions (only while Hunter heartbeats); the executor runs `reconstruct_operation` as a `HUNT_OPERATION` job with the automation policy; `reconcileWork` scores it by the members Hunter reported. `investigate_candidate` for a Hunter-sourced candidate runs one Site Investigator `INVESTIGATE_SITE` job for that site (Hunter's member sites share the operation's investigation, so an investigation-wide AI run would be the wrong unit); its usefulness is judged by wallets/evidence observed. The Resource Manager allocates an `operation_hunter` slot. |
| Routes | `POST /api/v1/operations/sync` and `POST /api/v1/operations/{id}/requests` (module key `operation_hunter`); `GET /api/v1/operations`, `GET /api/v1/operations/{id}`; `POST /api/v1/operations/reconstruct` (operator). |
| UI | Operations home: **Reconstructed operations** card. Campaign workspace: **Operation** tab with the model summary, competing explanations, strongest discoveries, inferred members, and every Hunter proposal with what the platform did; **Reconstruct with Operation Hunter** button. Every surface repeats that membership is inference, not proof of common ownership. |

## How a proposal becomes work

| Hunter proposal | Main action |
|---|---|
| `investigate_site` for a site Main already tracks | `investigate_candidate` work (skipped sites are refused) |
| `investigate_site` for a site Main has never seen | inbox candidate (`source_module = operation_hunter`, in the operation's investigation, disclaimer in `details`) + `investigate_candidate` work — a person can still skip it, which cancels the work and teaches Hunter |
| `analyze_wallet` | `analyze_wallet` work on the wallet entity |
| site observations (`status`, `ip`, `nameservers`) | `observeFacet` → Main's own change reactions (or a contradiction when another source disagrees at the same moment) |
| open contradiction, severity ≥ 0.6 | `recordContradiction` → human task |
| anything else | recorded as not actionable, never executed |

## Upgrade

1. Stop workers and back up D1.
2. Apply ordered migrations (`wrangler d1 migrations apply DB`), which adds `0012_operation_hunter.sql`.
3. Add `"operation_hunter": "<key>"` to `MODULE_API_KEYS`.
4. In Operation Hunter v2.0 → Settings, enter the platform URL and that key; press **Test**.

Rollback: the migration is additive — v5 code without this upgrade reads the database unchanged; dropping the four `hunter_*` tables restores the previous schema exactly.

## Tests

- `tests/v5-hunter.test.mjs` (6 tests, part of `npm test`): additive migration and schema gate; contracts; idempotent sync; proposals → work (known site, unknown site, wallet, bogus kind, skipped site); temporal observations (first / unchanged / changed); contradictions → human task; demo operations create nothing; reconstruction proposed only while Hunter is registered, routed with the automation policy, reconciled by members; request and operator routes.
- `npm run test:joined:hunter` (also part of `test:all`): Site Finder → Main → Operation Hunter over HTTP with the real code of all three, including an in-place upgrade from the 0011 schema, campaign formation, dispatch under budgets and module slots, duplicate protection, restart of Main and Hunter, and inbox feedback to both modules. It needs the Operation Hunter folder beside this one (or `HUNTER_DIR`) and reports SKIP without it.
- The Hunter-side joined workflow lives in the Hunter folder (`tests/main-joined.test.ts`; it finds this folder beside it, or `MAIN_DIR`).
- `tests/v5-migration.test.mjs`: the interrupted-upgrade test now re-applies every ordered migration after 0011 (the gate correctly requires 0012).
- Unchanged and passing here: `npm test` (26), `migration-matrix`, `integration:v6`, `v2`, `v3`, `v4`, `v5` (20 operations scenarios). `joined:v61`, `five-modules` and `startup:modules` need the bundled modules' own dependencies (`sql.js`, Python/Playwright stacks) that could not be installed in the build environment; they fail identically on the unmodified v5 bundle there.
