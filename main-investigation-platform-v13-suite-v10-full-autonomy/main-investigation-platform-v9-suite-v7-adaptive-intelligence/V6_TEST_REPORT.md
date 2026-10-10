# Main Investigation Platform v6 test report

## Passed

- 17 platform contract/unit tests.
- Existing v6 SQLite integration, three-module integration, failure/recovery, feedback, scheduler, migration, and production build checks.
- Supplied Wallet Investigator source suite: 31 passed.
- Supplied Wallet Investigator platform worker: real engine returned 4 transactions, 10 evidence records, and 3 counterparties from opt-in deterministic fixtures; investigation and correlation IDs were preserved.
- Supplied Form Submitter worker: real validation/storage/form service exercised against an ephemeral `127.0.0.1` receiver; confirmed receipt, verification-unknown, provenance, and duplicate prevention passed.
- TypeScript check for the Main Platform and production build.

## Five-module path covered

Site Finder → Main Platform → Site Investigator → CryptoWalletLogger → Wallet Investigator → Main Platform → Form Submitter.

The tests cover same-wallet deduplication across Site Investigator and Logger, conflicting network handling, wallet analysis routing, returned evidence/relationships, bounded expansion inputs, report approval binding, event replay, retries, stale/unknown outcomes, authentication rejection, and localhost webhook delivery.

## Test classification

Real module integration tested: supplied source code and workers for all five modules, including the Wallet Investigator analysis engine and Form Submitter validation/durable state.

Synthetic external behavior tested: deterministic blockchain provider fixtures and a localhost-only synthetic form confirmation receiver. No real investigation evidence was sent to an external endpoint.

Not tested: real public blockchain APIs, real browser automation, CAPTCHA or authenticated form flows, hosted Cloudflare deployment, production credentials, and external reporting acceptance.
