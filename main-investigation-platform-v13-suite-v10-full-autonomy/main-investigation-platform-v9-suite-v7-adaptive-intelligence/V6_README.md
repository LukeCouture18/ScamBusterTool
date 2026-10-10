# Main suite v6 operation intelligence

This source release adds durable operation evidence memory, Hunter-supplied testable hypotheses, retained contradictions, temporal history, bounded operation hunts, evidence maps and analyst-reviewed boundaries to the supplied v5 suite.

Read `V6_OPERATION_INTELLIGENCE_REPORT.md` for measured results and exact scope. The release is **implemented but partially verified**. Native extension and Windows checks are environment-blocked; full global actual-cost accounting, richer causal outcome learning and some certification scenarios remain incomplete.

Keep `operation-hunter-v2.0` beside this Main directory. Install dependencies with the existing portable installers, configure legitimate module credentials, and apply all migrations in order through `0017_operation_intelligence.sql`. The normal production start applies migrations locally. Back up used state before upgrading; there is no automatic destructive down-migration.

Open an operation from Operation Hunter, or visit `/operations/{Hunter external ID}`. Evidence reuse and graph context do not prove ownership. Consequential association/split/consolidation changes require review confirmation. Site reports keep exact-content final approval.

Verification commands:

```text
npm run test:operation-intelligence
node scripts/run-tests.mjs all
npm run build
```

Set `HUNTER_DIR` if the sibling Hunter directory differs. Set `MIP_PYTHON` if needed; install module Python requirements and Playwright browsers for UI tests. The production smoke script is `tests/operation-production-browser.py` and uses the normal configured local worker plus synthetic source records. Measured JSON, logs and screenshots are in `verification/operation-v6`.

No local credential files, dependencies, runtime databases or generated builds are included in the archive. Earlier v5 verification evidence remains included with its original scope.
