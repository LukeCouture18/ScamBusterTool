# Migration Report: v0.6 → v0.7

## Database

**v0.6 could not upgrade an existing database at all** (see
`V06-AUDIT-REPORT.md`, A0). v0.7 adds `app/migrations.py`; `init_db()` now
creates missing tables *and* migrates existing ones, on every startup.

Migrations check the **live schema**, not a version counter, so a database
restored from a backup or interrupted mid-upgrade converges rather than being
confidently wrong. Running them twice is a no-op.

| Migration | What it does |
|---|---|
| `001_technique_sent_to_platform` | Adds the v0.6 column whose absence broke every v0.5 upgrade |
| `002_site_discovery_columns` | Adds v0.2 discovery provenance to `sites` |
| `003_campaign_columns` | Adds v0.4 campaign bookkeeping |
| `004_v07_adaptive_columns` | Adds novelty and cost columns |
| `005_backfill_candidate_registry` | Backfills existing sites into the cross-campaign registry — v0.6 only populated it going forward |

New tables (created normally on fresh installs): `expansion_stops`,
`candidate_decisions`, `cluster_snapshots`, `campaign_allocations`,
`campaign_controls`, `schema_migrations`.

**Upgrading:** start the application. Migrations run automatically and log what
changed. `GET /api/schema` reports applied and pending migrations. No manual
step, no downtime, no data loss. Take a backup first regardless — this is a
schema change on a database you care about.

## Behaviour changes to expect

| Change | Effect |
|---|---|
| The platform link now starts automatically | With `MAIN_PLATFORM_URL` and `MAIN_PLATFORM_TOKEN` set, registration, heartbeat, outbox drain, job claiming and feedback polling begin at startup. Previously all of this required clicking Connect. |
| Budget allocation is enforced | Techniques that have earned less downstream usefulness now genuinely get fewer leads. Campaign composition will change. |
| Candidate memory gates reprocessing | Previously-dismissed candidates are skipped unless their evidence changed. Expect fewer candidates per campaign and a higher proportion worth looking at. |
| Saturation stops branches | Campaigns may finish earlier, with `stop_reason` saying whether the search finished or a budget ran out. |
| Downstream usefulness reaches technique learning | Technique yield scores will move on the first `refresh_scores()` after upgrade. |
| The main screen changed | Six vanity stat tiles replaced by six operational panels. |

## Rollback

v0.7's schema is additive — every migration adds columns or tables. v0.6 code
runs against a v0.7 database unchanged. The v0.6 defects come back with it,
including the inability to upgrade from v0.5.

## Configuration

New optional settings, all with defaults (see `app/config.py`):
`SATURATION_*`, `NOVELTY_WEIGHTS`, `NOVELTY_RECONSIDER_THRESHOLD`,
`CANDIDATE_RECHECK_AFTER_DAYS`, `PROVIDER_*`. No existing setting changed
meaning.
