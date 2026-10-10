# Main Investigation Platform v10 — Full Autonomous Investigation

Click **Start Investigation** without entering a URL. Main persists the search, asks Finder for supported candidates and enters the existing investigation pipeline. **Investigate This Site** remains the secondary supplied-URL path. Browse normally with the passive Wallet Logger and approve the exact report when Main says **Report ready. Submit?**

Read `V10_FULL_AUTONOMY_RELEASE_REPORT.md` for current verification and limitations. Earlier v9 results remain historical evidence in `V9_FULL_AUTONOMY_RELEASE_REPORT.md`. Read `V10_RECOVERY_AND_BASELINE.md` for reconstruction/recovery provenance and `V10_LIVE_CHECKPOINT.md` for saved progress. Passing synthetic workflow fixtures does not establish live-site classification accuracy or installed-extension/Windows certification.

The existing directory names are preserved for compatibility:

- `main-investigation-platform-v9-suite-v7-adaptive-intelligence` — Main and integrations.
- `operation-hunter-v2.0` — sibling specialist, or set `HUNTER_DIR` to its absolute path.

## Upgrade existing v8/v9 state

1. Stop Main and all specialists. Back up the complete old folders, including local configuration and databases.
2. Extract this bundle into a new directory with both sibling folders above. Keep the backup untouched.
3. Copy your old `.dev.vars`, `.wrangler/state` (or your existing `MIP_PERSIST_TO` directory), specialist `.env` files, specialist `data` and evidence directories, and Hunter data to their matching locations. Preserve the browser extension settings and Form Submitter's browser-local settings. Do not replace old databases with a new empty database.
4. Install/build below, then run `npm run start:suite`. Main applies ordered additive migrations through `0022_autonomous_missions.sql`, verifies the persisted migration ledger and mission/search tables, and retries pending local migrations at most once before starting the worker. If readiness still fails, it preserves the database and exits with a diagnostic. Migrations 0000–0020 remain unchanged; 0021 and 0022 add search and mission tables. Do not downgrade a used v10 database; restore the complete pre-upgrade backup for rollback.

The launcher preserves an existing `.dev.vars`. It requires nonempty keys for all six module names in `MODULE_API_KEYS`: `site_finder`, `site_investigator`, `crypto_wallet_logger`, `wallet_investigator`, `form_submitter`, `operation_hunter`. On a fresh install it generates six local random keys.

## Install and build

Requires Node.js **22.13+** (22.18 and 24.19 were exercised), npm, Python 3, and Chromium for browser checks. Run these commands from the Main folder. Linux/macOS:

```bash
npm ci
npm run build
npm --prefix integrations/wallet-investigator ci
npm --prefix integrations/wallet-investigator run build
npm --prefix integrations/form-submitter ci
npm --prefix integrations/form-submitter run build
npm --prefix ../operation-hunter-v2.0 ci
npm --prefix ../operation-hunter-v2.0 run build
python3 -m venv .venv
.venv/bin/python -m pip install -r integrations/site-finder-v07/requirements.txt -r integrations/site-investigator-v01/requirements.txt
.venv/bin/python -m playwright install chromium
npm run test:doctor
npm run start:suite
```

PowerShell uses the same npm commands, then:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r integrations/site-finder-v07/requirements.txt -r integrations/site-investigator-v01/requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
npm run test:doctor
npm run start:suite
```

These are portable commands; native Windows operation was not available for verification. Set `MIP_PYTHON` to an absolute Python interpreter if needed. For an existing custom database path retain `MIP_PERSIST_TO`.

## One local entry point

`npm run start:suite` starts Main at **http://127.0.0.1:8787**, Wallet Investigator :3001, Form Submitter :3002, Hunter :3003, Finder :5000, and Site Investigator :8765. It runs the shared Main maintenance entry every 15 seconds with no overlapping launcher calls. Existing server leases and budgets still apply. **Ctrl+C** stops the child services. Logs are in `logs/suite`.

Open Main and choose **Start Investigation**. To supply a public HTTP(S) URL, open **Investigate This Site** and choose **Investigate Site**. Browser login, CAPTCHA, MFA and email verification remain your actions. Do not give credentials or sessions to Main.

One-time local setup:

- Load the unpacked extension at `integrations/crypto-wallet-logger-v08` in Chromium developer mode. Set Main URL to `http://127.0.0.1:8787` and use only the `crypto_wallet_logger` key from `.dev.vars`. Enable passive observation. Its `wallet.observation` 2.0.0 interface remains compatible.
- Configure the authorized reporting destination and verified required field mapping in Form Submitter. Enable its approved-report automation if desired. Main still requires exact-content final approval. Local test receipts are not proof of an external form submission.
- Bitcoin uses the public bounded Blockstream Esplora read adapter. For the supported explicit EVM networks, put `BLOCKSCOUT_API_KEY=your_key` in **Wallet Investigator's own** `.env`; the launcher passes it only to that specialist. Ethereum, Optimism, Base, Arbitrum, Polygon and BSC have adapter definitions. Without a permitted provider, validation/analysis availability is shown honestly. EVM networks are never guessed. Other networks retain deterministic validation but do not have new live activity adapters in this release.

Do not enable `WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES` in a real investigation. Provider history is bounded and marked partial; common counterparties and transactions do not establish ownership.

## Verification

```bash
npm run test:all
npm run test:autonomy
npm run build
```

The broad runner continues through failed steps. Installed-extension checks may fail in a restricted browser environment; the report identifies the exact blocked checks. Scientific/Finder benchmarks produce measurements and need separate quality assessment. Current source ESLint passes with 0 errors and 231 retained warnings. Historical release notes are retained in `README_HISTORY.md` and the older versioned reports; they describe earlier versions, not the v10 release status.
