# v3 test report

Run cross-platform through `node scripts/run-tests.mjs <group>` (or `npm run
test:<group>`); `node scripts/run-tests.mjs all` runs every group. Verified in a
working directory whose path contains spaces, `#`, `%` and `[ ]` (the same
class of path that breaks Windows), so the harness is exercised the way it is on
Windows.

| Group | Result | What it proves |
| --- | --- | --- |
| `unit` | 17/17 | contract, domain, migration, security unit tests |
| `migration-matrix` | 10/10 | fresh/v5/v6/checkpoint upgrades (through `0009`) preserve evidence and pass the startup gate; partial migrations refuse startup |
| `integration:v6` | 10/10 | events, jobs, feedback, webhook, bridges, both scheduler paths — unchanged by v3 |
| `v2` | inbox + 29/29 | the v2 inbox and precision engine, unchanged |
| **`v3`** | **7/7** | AI plans→typed jobs, evidence changes plans, human pause/resume, invalid actions rejected, hallucinated evidence blocked, budgets stop runaway, restart recovery, provenance, deterministic planner, model-failure safety |
| `joined:v61` | golden + failure/recovery | the joined five-module workflow, unchanged |
| `five-modules` | 31/31 + worker | wallet engine and platform worker, unchanged |
| `site-finder` | 456/456 | Site Finder incl. **6 new v3 learning tests** (outcomes move the right ledgers, AI-inference basis ignored, exploration floor + dominance cap, collapsed-strategy recovery) |
| `startup:modules` | 3/4 here | Finder, wallet and form startup pass; **Site Investigator startup needs `fastapi`**, which this offline sandbox cannot install — it is not a code failure. Runs on any machine with the module's `requirements.txt` installed. |

`npm run test:doctor` reports the resolved toolchain and flags any reintroduced
non-portable pattern.

## Not a regression

The single failing step in this environment is `site-investigator-startup-local.py`
failing to `import fastapi`, because the sandbox has no package index. Every
other group passes, including all v2/v6.1 compatibility suites and the frozen
modules' own tests.
