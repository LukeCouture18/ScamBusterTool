# v4 test report

## How the suite was run

`node scripts/run-tests.mjs all` ran from a copy of the repository at `/tmp/claude-0/win sim #1 %20 [x]/platform`. That path, and the `TMPDIR`, contain a space, `#`, `%20` and brackets, the same hostile-path setup used for the Windows portability fixes.

The copy was made without `node_modules` or Site Finder data, on Linux, Node 22.22 and Python 3.11. There is no npm or PyPI access here, so test-only shims (for zod, express, vite, sql.js, dotenv and @google/genai) stood in for missing packages. The shims are not shipped.

## Results

| Group | Result | Contents |
| --- | --- | --- |
| unit | PASS 17/17 | contract, migrations, auth, SDK |
| migration-matrix | PASS 10/10 | upgrades from fresh, v5, v6 and v6.1 all apply through `0010` and pass the startup schema gate; interrupted-migration cases roll back or refuse startup |
| integration:v6 | PASS | event backbone, three-module flows, feedback, bridge, scheduler |
| v2 | PASS (+ 29 Finder precision tests) | inbox |
| v3 | PASS 7/7 | AI investigator acceptance (unchanged tests) |
| **v4** | **PASS 10/10 scenarios + 8/8 Finder v4 tests** | this release |
| joined:v61 | PASS 31/31 | five-module joined workflow, success and failure paths |
| five-modules | PASS | Form Submitter and Wallet Investigator suites |
| site-finder | PASS 464/464 | the 456 existing tests plus 8 new v4 tests |
| startup:modules | FAIL (environment) | `site-investigator-startup-local.py` needs `fastapi`, which is not installable here. This is the same known limitation as in v3; no code in that path changed. |

**Frozen modules.** Each was checked with `diff -rq` against the v6.1 originals and the v3 delivery:

- CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter are identical.
- The Launcher files are unchanged since v3: `scripts/start-production.mjs`, `scripts/sites-env.mjs`, `integrations/local_scheduler.py` and `integrations/site_investigator_bridge.py`.

## v4 acceptance (`tests/v4-campaign.mjs`)

Every scenario drives the real route handlers, the real campaign orchestrator, the real v3 investigator and the real module job lifecycle. It uses an in-memory D1 and synthetic Site Finder / Site Investigator batches derived from the real fixtures. Each requirement maps to the scenario below that proves it.

| Requirement | Scenario | What is asserted |
| --- | --- | --- |
| Campaigns coordinate multiple real investigations | A | Association finds the linked sites through kit, IP, name-server, service and wallet links. An unrelated high-score site is *not* associated. At least 3 real v3 runs complete, each exactly once, with one site investigation per site. |
| One connected site beats twenty near-identical ones | A | The hub's priority is above every one of 20 template mirrors. At least 19 mirrors are suppressed as "Near-identical to …" (20 in practice), at most one is ever investigated, and the hub is investigated before any mirror. |
| New evidence reprioritizes pending work | A | Site Investigator finds a wallet on the seed that a pending site also shows. That site's `proven_link` becomes 1 and its priority rises (0.53 → 0.78). |
| Hypotheses supported or disproved | B | The IP hypothesis is supported by a verified new site. The certificate-name hypothesis is disproved, and Finder's claim of a site it never delivered is not counted. A person's later Skip of the new site lowers the supported hypothesis, which leaves "supported". |
| Unsupported AI relationships cannot enter the graph | I, A | `addEdge` refuses an AI basis, a fake source row, an unlisted table and a hypothesis endpoint. The edge count is unchanged after all adversarial input. Every edge in A cites an existing row. |
| Reviewer rejection prevents actions | C | Already-attempted work is rejected with all six questions plus budget recorded; no run and no job is created. A model critique adds a rejection that prevents the investigations. |
| Duplicate investigations suppressed | A, G | Mirrors are suppressed. At most one run per investigation, including after a crash. |
| Campaign budgets stop expansion | D | With `max_investigations=2`: exactly 2 runs, then BUDGET_EXHAUSTED. A negative budget is refused (400). Raising the budget to 3 resumes the campaign for exactly one more run. |
| Saturation stops low-value pivots | E | With three shared-IP hypotheses and Finder finding nothing, only 1–2 IP pivots run. The rest are `saturated` or rejected with a saturated/disproved reason. |
| Contextual Finder learning changes allocation | Finder v4 tests | The same arms receive opposite budget shares in two contexts after different outcomes. Campaign-level evidence overrides the context but stays shrunk for other campaigns. |
| Exploration bounded but active | Finder v4 tests | Every arm keeps at least the floor and none exceeds the ceiling, over 100 sampled allocations after 200 lopsided outcomes. Experience priors are clamped to 0.15–0.85 (J). |
| Human checkpoints pause only affected work | F | A login wall moves one site to `waiting_human` while the campaign stays RUNNING and two other sites complete. The task appears in the campaign's human-task list with do-it-yourself instructions. Logger evidence resumes the run. |
| Campaigns survive restart | G | A live lease blocks a second worker, and an expired lease is taken over. An investigation started just before a "crash" (with the opportunity not yet recorded) is **adopted**, not duplicated. The campaign then completes. |
| Provider failures recover safely | H | A timeout, garbage, truncated JSON and a 503 all fall back to deterministic choices. Failed calls are still counted as cost, and the campaign completes. |
| Deterministic fallback works | H | A campaign completes with no provider at all, making zero model calls. |
| Provenance survives | A | Every edge has an observed/deterministic basis and an existing source row. There are no hypothesis edges, and the campaign layer wrote no `evidence` rows. The graph view carries provenance on every edge and the ownership disclaimer. |

**Adversarial model and forged-input cases** (scenario I, plus parts of C and H). All were rejected by the deterministic platform:

- **Invalid capability:** the model planner returns `{capability: "site.exploit"}`, and a hypothesis tries the target `password:admin`.
- **Nonexistent evidence:** a hypothesis cites edge ids that do not exist.
- **Invented relationships:** direct edge writes with an AI basis or a forged source row; a smuggled `new_edge` field.
- **Repeated actions:** a duplicate hypothesis; the planner choosing a done or executing opportunity; the Reviewer asked to approve done work.
- **Budget excess:** 20 planner replies queued against `max_model_calls=6`. At most 6 calls happen, including the v3 runs' calls, which are carved from the campaign budget.
- **Contradicting observed evidence:** a hypothesis citing IP edges while claiming a wallet target.
- **Free-form commands:** an untyped role artifact; links or markup in a statement.
- **Forged learning:** `observed`/`human` experience rows citing nonexistent jobs or decisions. Separately, 50 `ai_self` rows leave the prior unchanged.

## Site Finder v4 tests (`integrations/site-finder-v07/tests/test_v4_context.py`)

1. Contextual learning changes allocation between contexts.
2. Campaign-specific learning overrides the context for that campaign and is shrunk for others.
3. Exploration stays bounded but active (floor and ceiling).
4. Diminishing returns halve effort per unproductive attempt; the path saturates after 3 and a productive attempt restores it.
5. A saturated pivot returns without running a discovery round (network forbidden in the test).
6. An unsupported pivot kind is refused.
7. Downstream credit applies only to candidates carrying a discovery context.
8. A real pivot runs against the simulated internet: bounded probes, shares covering the chosen arms, excluded domains never returned, effort that never grows on an unproductive path, and saturation followed by a network-free skip.

## Bugs found and fixed while building v4

- **v3 digest (`lib/agent/state.ts`).** A wallet already freshly analysed in another investigation was never counted as analysed. The executor refused to re-run it, so the rules planner could propose the same analysis forever. Campaigns exposed this because they share wallets across investigations.
- **Wallet keys.** The entity store lower-cases addresses while Site Finder keeps their original case, so the same wallet produced two graph nodes. Graph matching is now case-insensitive.

## Type checking

The v4 platform modules and routes were type-checked with `tsc --strict` against the repository's stubs. The only errors reported are pre-existing ones in untouched files, or artefacts of the test-only zod/lucide/react shims. The UI component was bundled with esbuild and rendered in Chromium with no console errors (`docs/screenshots/`).
