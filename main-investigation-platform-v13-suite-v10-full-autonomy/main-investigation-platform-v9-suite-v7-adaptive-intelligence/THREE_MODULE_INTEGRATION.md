# Three supplied modules: integration acceptance

This bundle includes derived copies of the three supplied modules under `integrations/` and an unchanged v6 Main Platform foundation. The original uploaded ZIPs are not overwritten.

| Module | Runtime connection | Verified here |
| --- | --- | --- |
| Site Finder v0.7 | Existing schema 1.1 ingestion → persisted public triage evidence → explicit v6 promotion → registered Site Investigator job | Real Finder batch builder with synthetic public signals through route handlers, claim and DB asserts |
| Site Investigator v0.1 | Standalone bridge claims platform job → invokes original public collector → translates SQLite rows → ingest and job complete/retry | Synthetic SQLite rows, actual route handlers, synthetic worker lifecycle and failure retry; no public website contacted |
| CryptoWalletLogger v0.8 | Native `1.0.0` event → `/api/v1/compat/logger` → canonical observations and evidence | Actual `walletEvent` shape, replay, two-source wallet identity, passive routing, persistent queue idempotency |

The localhost receiver test makes real HTTP requests only to an ephemeral `127.0.0.1` port using synthetic data. It verifies HMAC, payload, stable delivery ID, 503 recovery, receiver deduplication, acknowledgement, and exhausted-delivery review. The separate Site Finder receiver verifies HMAC, deduplication and acknowledgement without network access.

Monitoring tests also exercise a new observation and entity evidence against a persisted baseline, inspect the recorded diff, and confirm repeated snapshots do not create alerts. Relationship versions and linked evidence participate in the same snapshot query.

Run `npm ci`, `npm test`, `npm run test:integration:v6`, `npx tsc --noEmit`, and `npm run build`. Python 3 is required for the bundled module bridge tests; the production Site Investigator additionally needs the dependencies and Playwright setup in its own `requirements.txt`.

The remaining Wallet Investigator and Form Submitter source ZIPs are now integrated. Their local real-source tests pass; hosted Cloudflare behavior, real external provider failures, browser automation, and production form verification remain untested and are explicitly separated in the implementation report.
