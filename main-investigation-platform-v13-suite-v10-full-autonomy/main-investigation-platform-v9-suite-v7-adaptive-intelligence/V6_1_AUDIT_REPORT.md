# v6.1 final audit report

The audit traced produce → persist → route → claim → execute → ingest → acknowledge → downstream effect for all five modules.

| Audited defect class | Finding | Final status |
|---|---|---|
| Built but never called | Scheduler and module workers lacked normal-start proof | Fixed and effect-tested |
| Computed but discarded | Finder technique outcomes did not change later allocation | Fixed and effect-tested |
| Event never consumed | Evidence-backed wallet validation and Wallet outbox routing had gaps | Fixed and joined-tested |
| Queue never drained | Wallet/Form outbox durability and acknowledgement boundaries | Fixed and recovery-tested |
| Configuration ignored | Configured Form adapter was not proven through production path | Fixed and localhost-tested |
| IDs detached | Module jobs used internal investigation IDs while ingestion resolved only external IDs | Fixed; joined evidence remains associated |
| Migration not started | Generated D1 config lacked migration directory/start orchestration | Fixed; clean start/restart passed |
| Tests checked objects only | Startup, planner, feedback and reporting had construction-level checks | Replaced/augmented with persisted downstream effects |

Site Finder now stores non-routing schema 3.0 observations, records canonical triage, promotes only when requested and evidence-backed, creates canonical jobs, receives push feedback, records technique/campaign outcomes, and changes a subsequent campaign's persisted allocation.

The joined golden path confirms Site Finder → Main Platform → Site Investigator → CryptoWalletLogger → Wallet Investigator → Main Platform → Form Submitter with preserved investigation, entity, observation, evidence, correlation, job, event, report, idempotency, and provenance context. The joined recovery path confirms no duplicate report when confirmation is unavailable.
