# Suite v5 director upgrade

This package is an integration candidate. Read `V5_INVESTIGATION_DIRECTOR_REPORT.md` for verified behavior, release blocks and limitations before deployment.

Keep the existing launcher-facing paths and module configuration. Main and `operation-hunter-v2.0` are sibling directories in the archive. Migration `0016_investigation_director.sql` is additive; all earlier migrations are unchanged. Stop workers and back up existing persistence before replacing source. Run `npm ci`, install existing module dependencies, `npm run build`, then use the existing `MIP_PERSIST_TO` when starting Main so pending migrations apply to the used state. The normal Worker cron/local maintenance process runs the director; no operator click is needed for provider retries or report rebuild.

For rollback, restore backed-up v4 code and all pre-upgrade persistence. Removing the seven director tables alone does not undo report, approval, job or evidence changes made during runtime. External submissions are not undone by a database restore.

Tests: `npm run test:doctor`, `npm run test:director`, `npm run test:all`. The complete release gate is not certified: browser extension loading is environment-blocked, resource accounting remains partly estimated, and an end-to-end four-pivot discovery-to-report comparison is not measured.
