# Site Investigator v0.1

A standalone, passive-first application for deep investigation of suspected cryptocurrency scam websites. It stores normalized evidence in SQLite so it can later become a module in a shared investigation platform.

## What works

- Public investigation: RDAP registration data, DNS, IPs, ASN hints, nameservers, MX, TLS certificate metadata, certificate names, passive subdomain sources, crawl/page discovery, technologies, template fingerprints, contacts, analytics IDs, company-name hints, cryptocurrency addresses, screenshots, important text, and relationship generation.
- Authenticated investigation: user-supplied credentials for one site, ordinary login through Playwright, success/failure/challenge detection, manual continuation for CAPTCHA/MFA/email verification, safe mapping of authorized pages, and wallet/deposit evidence capture.
- Cases, websites, pages, deposit options, wallets, evidence, observations, relationships, notes, tags, and timeline events use stable IDs and record provenance, confidence, and timestamps.
- Searchable browser UI, JSON API, job progress, case export, and an integration-ready event outbox.
- Financial actions are never initiated. Requests matching deposits, withdrawals, transfers, trades, purchases, or payments are blocked in authenticated browser mode.

## Windows quick start

1. Install Python 3.11 or newer.
2. Double-click `SETUP_WINDOWS.bat` once.
3. Double-click `START_WINDOWS.bat`.
4. Open <http://127.0.0.1:8765>.

Or in PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe run.py
```

Linux/macOS:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
python run.py
```

## Safety and scope

Only investigate sites you are authorized to access. Public collection uses GET/HEAD-style navigation and public metadata sources. Authenticated mode accepts one exact origin, does not guess credentials, and stops for challenges. Credentials are held in memory only and are not written to the database or logs. Screenshots and collected evidence may contain sensitive account information; protect the `data/` directory.

## API and integration

Open `/docs` for the API. The database schema is in `siteinvestigator/schema.sql`. Integration consumers can read `outbox_events`, or call `/api/cases/{case_id}/export`. Each entity uses a UUIDv7-like, time-sortable ID with a type prefix (`case_`, `site_`, `page_`, `wallet_`, `ev_`, etc.). The outbox pattern allows Scanner, CryptoWalletLogger, Wallet Investigator, and a future Main Platform to synchronize without manual file shuffling.

Configuration environment variables:

- `SI_DATA_DIR` (default `./data`)
- `SI_HOST` (default `127.0.0.1`)
- `SI_PORT` (default `8765`)
- `SI_MAX_PAGES` (default `35`)
- `SI_REQUEST_TIMEOUT` (default `12` seconds)
- `SI_USER_AGENT`

## Tests

```bash
python -m unittest discover -s tests -v
```

