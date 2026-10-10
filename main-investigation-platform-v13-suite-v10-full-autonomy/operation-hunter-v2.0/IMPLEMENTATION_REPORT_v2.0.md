# Operation Hunter v2.0 — implementation report

## What actually changed

1. **A living model of every operation.** It's rebuilt from the evidence and a new temporal fact ledger after every change, and versioned with readable diffs. It covers members, site lifecycles, deployment waves and the next-wave forecast, infrastructure history, kit lineage, the money pipeline and exits, other operator groups, competing explanations with the test that would separate them, contradictions and unknowns.
2. **Membership inference replaces graph proximity.** Each member now has an explained probability. Indicators are graded by level. Planted or copied settings are detected, and a file that shows up under two operators' settings counts as shared tooling, not ownership. Every member must chain back to your seed through non-kit evidence. Your verdicts override the inference and calibrate it, and so do rejections in Main's inbox.
3. **Pursuit is allocated by expected progress per unit of cost.** It uses a learner that gets delayed credit and scores progress rather than data volume. Lines of inquiry saturate, park and come back later. The pursuit also runs hypothesis-driven naming and title searches, reads archived page source, stops on diminishing returns, and shares a fair daily lookup budget across operations.
4. **Standing hunts keep watching after the session.** They cover the operation's nameservers, naming template, per-deployment files, titles and wallets. The cadence tightens when a wave is due, and a "return" needs operator-level evidence.
5. **The Brief stays at 3–5 items.** Model findings (mid-rotation, next wave, undecided explanations, what changed) compete for those slots. Below them are a one-line model strip and the 3 best next lookups. A **Living model** view and membership explanations in the entity drawer let you drill down to the evidence.
6. **Main Platform v5 integration**, described in the next section.

## Main integration status: working, tested end to end

- **Main asks.** It proposes `reconstruct_operation` work for campaigns and wallet-bearing sites, or you request it. The work runs as a `HUNT_OPERATION` job within Main's budgets.
- **Hunter reports.** It creates the operation's Main investigation and ingests members, wallets and evidence. Then it syncs the model, discoveries, next leads, site observations and contradictions.
- **Main decides.** Proposals become Main's own work: inbox candidates with investigation work, and wallet analyses. Observations go into Main's temporal layer. Significant contradictions become human tasks.
- **Main learns from the outcome.** Usefulness is judged by the members Hunter reports.
- **Hunter learns from Main.** Rejections in Main's inbox become membership verdicts. New Site Finder sites are checked for returns.
- **Main UI.** A "Reconstructed operations" card on Operations home, and an **Operation** tab in each campaign.

Main-side changes:
- migration `0012` (additive, required by the schema gate)
- `lib/ops/hunter.ts`
- executor and scheduler hooks
- 5 routes
- 2 UI components
- docs in `V5_OPERATION_HUNTER.md`

## Tests

**Hunter: 45 of 45 pass** (v1.0 had 35). The new tests cover:
- the living model and its version diffs, and the forecast
- analyst verdicts and calibration
- every new API route
- migration of a real v1.0 database
- an adversarial ground-truth world
- restarting mid-pursuit
- hunts firing after a restart
- a 400-site performance check (analysis ≈ 0.25 s)
- **the joined workflow against Main v5's real route handlers over HTTP**

**Main: 26 of 26 unit tests pass**, including 6 new Hunter tests. The migration matrix and the `integration:v6`, `v2`, `v3`, `v4` and `v5` groups (20 operations scenarios) pass. One existing migration test was updated so it re-applies every migration after `0011`. `joined:v61`, `five-modules` and `startup:modules` can't run in this build environment because the bundled modules' dependencies (`sql.js`, `fastapi`) couldn't be installed. They fail the same way on the unmodified v5 bundle.

## Benchmark against v1.0

16 adversarial worlds, 90 lookups each (details in `BENCHMARK_v2.0.md`).

| Seed | Engine | Precision | Recall | False members per run | Operator IDs found | Treasury found | New wave caught |
|---|---|---|---|---|---|---|---|
| Private-NS site | v1.0 | 0.60 | 0.65 | 6.6 | 0 % | 0 % | 44 % |
| Private-NS site | v2.0 | 1.00 | 0.78 | 0 | 94 % | 100 % | 94 % |
| Cloudflare site | v1.0 | 0.95 | 0.21 | 0.75 | 0 % | 0 % | 9 % |
| Cloudflare site | v2.0 | 1.00 | 0.60 | 0 | 69 % | 88 % | 69 % |

Median lookups to reach 80 % recall: 60 for v1.0 against 45 for v2.0. The number of worlds that reach 80 % at all rises from 5 to 11 of 16.

## Genuine limitations

- **The benchmark worlds are synthetic.** Real operations will have adversarial patterns they don't encode.
- **A wallet seed reaches no websites in either version.** Neither the real nor the simulated public sources have a wallet-to-site index, so crossing back from money to sites needs Main or an analyst.
- **Some operations aren't publicly discoverable from the seed.** In 5 of 16 Cloudflare-seed worlds, v2 stops early at the seed alone.
- **The UI couldn't be built here with Vite.** No npm registry was available. It was checked by bundling it with esbuild and taking screenshots with stub icons, so run `npm run build` on your machine.
- **Some parts are still simpler than the rest.** Entity-alias resolution is basic (the table exists but is only lightly used). Kit lineage reuses the v1 family and variant analysis. The forecast is a median-interval rhythm model, not a learned one.
- **Operator-side tuning is still ahead of you.** Hunter's standing hunts and Main's `auto_reconstruct` generator run by default. Their volume and cadence haven't been tuned against live traffic, so check the daily lookup budget (`HUNTER_DAILY_LOOKUPS`) and `module_limit:operation_hunter` in the first week.
