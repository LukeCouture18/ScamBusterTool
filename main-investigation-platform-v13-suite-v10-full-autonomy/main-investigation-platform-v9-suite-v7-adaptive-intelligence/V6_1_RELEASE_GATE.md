# Main Investigation Platform v6.1 release gate

Final status: **PASS — stable baseline approved**

| Requirement | Status | Direct evidence |
|---|---|---|
| Development/test dependencies | PASS | `.venv/bin/python -m pytest integrations/site-finder-v07/tests -q` → 421 passed; Playwright Chromium/headless shell v1187 installed |
| Lint | PASS | `npm run lint` → 0 errors, 172 warnings |
| Type checking | PASS | `npx tsc --noEmit` → exit 0 |
| Platform unit/contract tests | PASS | `npm test` → 17/17 |
| Site Finder schema 3.0 runtime migration | PASS | Finder tests plus `npm run test:integration:v6` prove passive observation → triage → promotion → job → feedback → changed allocation |
| Site Finder real source | PASS | 421/421 |
| Site Investigator real source | PASS | `(cd integrations/site-investigator-v01 && ../../.venv/bin/python -m pytest tests -q)` → 6/6 |
| Wallet Investigator real source | PASS | `npm run test:five-modules` → 31/31 engine checks and platform-worker integration passed |
| Form Submitter configured source path | PASS | Source/configured tests passed; one localhost submission, receipt verification, unknown handling, duplicate prevention |
| Main Platform scheduler | PASS | `npm run test:startup` → persisted scheduled event processed; generated build contains `*/5 * * * *` trigger |
| Separate module startup | PASS | `npm run test:startup:modules` → all four separate module entries processed persisted work |
| Normal production start and restart | PASS | `npm start` on clean persistence applied migrations, processed promoted work, restarted on the same D1 state, and retained 1 pipeline/1 entity |
| Migration upgrades and crash matrix | PASS | `npm run test:migration-matrix` → 10/10 |
| Joined five-module golden path | PASS | `npm run test:joined:v61` → all five real source integrations, verified receipt, one submission |
| Joined failure/recovery path | PASS | Same command with `V61_FAILURE_PATH=1` → outbox retry, platform restart, preserved evidence, one submission, `VERIFICATION UNKNOWN` |
| Integration/recovery suite | PASS | `npm run test:integration:v6` → 9 effect-based programs passed |
| Production build | PASS | `npm run build` → all five Vinext build stages completed |

The 172 lint warnings are advisory warnings in supplied module UI code (unused presentation imports, React hook advisories, and image/navigation advisories). There are zero lint errors; no rule was disabled or weakened.

## Test classification

- **Real module source tested:** Site Finder, Site Investigator, CryptoWalletLogger, Wallet Investigator, Form Submitter, Main Platform routing and persistence.
- **Synthetic external behavior tested:** deterministic blockchain fixtures, localhost webhook/form receivers, synthetic websites and evidence.
- **Live external behavior not tested:** hosted blockchain providers, real Google Forms, CAPTCHA/MFA/authenticated third-party sites, hosted Cloudflare D1 migration execution.
