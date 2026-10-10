# v6.1 final test report

| Suite/command | Result | Scope |
|---|---:|---|
| `npm run lint` | PASS | 0 errors, 172 advisory warnings |
| `npx tsc --noEmit` | PASS | Platform and integrated TypeScript |
| `npm test` | 17/17 | Unit, contract, auth, schema |
| Site Finder pytest | 421/421 | Includes real Playwright navigation and schema 3.0 effects |
| Site Investigator pytest | 6/6 | Real source |
| `npm run test:integration:v6` | 9/9 programs | Events, jobs, feedback, webhook, bridges, scheduler |
| `npm run test:startup` | PASS | Built scheduled entry processes persisted work |
| `npm run test:startup:modules` | 4/4 | Normal entries for Finder, Site Investigator, Wallet Investigator, Form Submitter |
| `npm run test:migration-matrix` | 10/10 | Fresh/v5/v6/checkpoint plus six interruption/restart cases |
| `npm run test:five-modules` | PASS | Wallet 31/31 plus worker; Form source/configured adapter |
| `npm run test:joined:v61` | PASS | Golden and failure/recovery joined paths |
| Normal production start/restart | PASS | Clean migration, promoted work, same-state restart |
| `npm run build` | PASS | Five Vinext production stages |

The failure path confirmed durable Wallet outbox replay, platform restart preservation, duplicate suppression, partial/uncertain behavior, exactly one form submission, and final `VERIFICATION UNKNOWN` when confirmation was unavailable. The golden path confirmed a verified receipt and `COMPLETED`.

**Real module source tested:** all five supplied modules and Main Platform routing/persistence.

**Synthetic external behavior tested:** deterministic blockchain providers, synthetic websites/evidence, localhost webhook and form receivers.

**Not tested live:** public/credentialed blockchain services, real Google Forms, CAPTCHA/MFA/authenticated third-party flows, hosted D1.
