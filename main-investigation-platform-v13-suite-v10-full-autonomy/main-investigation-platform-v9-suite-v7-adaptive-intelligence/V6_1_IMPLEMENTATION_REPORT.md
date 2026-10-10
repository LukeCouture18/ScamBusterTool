# v6.1 implementation report

Release status: **complete and frozen as the v7 baseline**.

The release completed Site Finder schema 3.0 passive observation, first-class triage, promotion, downstream job creation, push feedback, technique outcome recording, and changed future allocation. Compatibility translation remains only for explicitly negotiated legacy inputs.

Production hardening completed:

- Canonical internal and external investigation IDs resolve to the same stored investigation, preventing orphaned module results.
- Wallet Investigator receives direct canonical jobs, executes its real engine, ingests evidence/transactions/counterparties/relationships, and retains outbox rows until platform acknowledgement.
- Form Submitter publishes canonical event envelopes, uses its configured adapter, stores verified receipts before completion, and leaves uncertain confirmation as `VERIFICATION UNKNOWN` without blind resubmission.
- Normal `npm start` discovers and applies ordered local D1 migrations, aborts on failure, starts the built Worker, and preserves state over restart.
- Main scheduled recovery, feedback, and monitoring paths plus each separate module entry point have effect-based startup tests.
- Joined five-module golden and failure/recovery tests exercise all five supplied sources with localhost and deterministic external fixtures.
- Lint is zero errors; type checking and the production build pass.

No investigation intelligence, graph feature, UI redesign, or v7 concept was added.
