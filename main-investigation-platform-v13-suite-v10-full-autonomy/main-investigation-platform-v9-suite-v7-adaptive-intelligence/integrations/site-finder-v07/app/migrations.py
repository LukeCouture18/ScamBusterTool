"""
Schema migrations: making an existing database survive an upgrade.

THE BUG THIS EXISTS TO FIX
--------------------------
Every table in db.py is declared `CREATE TABLE IF NOT EXISTS`. That is correct
for a fresh install and silently wrong for an upgrade: if the table already
exists, SQLite skips the statement entirely, so a column added in a later
version never appears. The next write fails with "no such column", and it fails
in production rather than in tests — because tests always start from an empty
database, which is exactly the case `IF NOT EXISTS` handles correctly.

v0.6 shipped with this. Anyone upgrading a v0.5 database hit
`no such column: sites_sent_to_platform` the first time a technique outcome was
recorded. This module is the fix, and it is deliberately boring:

  * every migration is idempotent — running it twice is a no-op
  * every migration is checked against the live schema, not against a version
    number, so a database in any half-upgraded state converges to correct
  * applied migrations are recorded, so an upgrade reports what it did
  * a failure names the migration and leaves the rest applied, rather than
    rolling back to a state nobody tested

WHY NOT A VERSION COUNTER ALONE
-------------------------------
A counter assumes the database only ever got to its current state through this
code. Real ones have been restored from backups, hand-edited, or half-upgraded
by a crash. Checking the actual schema ("does this column exist?") converges
from any of those; a counter can be confidently wrong.
"""
import logging
import sqlite3

logger = logging.getLogger("scamhunter.migrations")


def _columns(conn, table: str) -> set:
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return set()


def _table_exists(conn, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    return bool(row)


def _add_column(conn, table: str, column: str, definition: str) -> bool:
    """Adds a column if the table exists and the column does not. Idempotent."""
    if not _table_exists(conn, table):
        return False          # a fresh install will CREATE it with the column already
    if column in _columns(conn, table):
        return False
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    logger.info("Migration: added %s.%s", table, column)
    return True


# ---------------------------------------------------------------------------
# The migrations. Each is (id, description, function(conn) -> bool changed).
# Append only; never renumber, never edit an applied one.
# ---------------------------------------------------------------------------

def _m001_technique_sent_to_platform(conn) -> bool:
    """v0.6 added the downstream-usefulness counter to technique stats."""
    return _add_column(conn, "pivot_technique_stats",
                       "sites_sent_to_platform", "INTEGER DEFAULT 0")


def _m002_site_discovery_columns(conn) -> bool:
    """v0.2 added discovery provenance to sites; older databases lack it."""
    changed = False
    for column, definition in (("discovery_confidence", "REAL DEFAULT 0.5"),
                               ("discovery_reason", "TEXT"),
                               ("discovery_category", "TEXT")):
        changed |= _add_column(conn, "sites", column, definition)
    return changed


def _m003_campaign_columns(conn) -> bool:
    """v0.4 campaign bookkeeping, in case a v0.3 database is upgraded."""
    changed = False
    for column, definition in (("stopped_reason", "TEXT"),
                               ("current_stage", "TEXT"),
                               ("finished_at", "REAL")):
        changed |= _add_column(conn, "campaigns", column, definition)
    return changed


def _m004_v07_adaptive_columns(conn) -> bool:
    """v0.7 additions to tables that v0.6 databases already have."""
    changed = False
    changed |= _add_column(conn, "feedback_attribution",
                           "novel_candidates", "INTEGER DEFAULT 0")
    changed |= _add_column(conn, "feedback_attribution",
                           "duplicate_candidates", "INTEGER DEFAULT 0")
    changed |= _add_column(conn, "feedback_attribution",
                           "api_cost", "REAL DEFAULT 0")
    changed |= _add_column(conn, "candidate_registry",
                           "novelty_score", "REAL")
    changed |= _add_column(conn, "candidate_registry",
                           "last_decision", "TEXT")
    changed |= _add_column(conn, "pivot_technique_stats",
                           "novel_candidates", "INTEGER DEFAULT 0")
    return changed


def _m005_backfill_candidate_registry(conn) -> bool:
    """
    v0.6 introduced the cross-campaign registry but only populated it going
    forward, so an upgraded installation's existing sites were invisible to
    deduplication and novelty. This backfills them once.
    """
    if not _table_exists(conn, "candidate_registry") or not _table_exists(conn, "sites"):
        return False
    row = conn.execute("SELECT COUNT(*) c FROM candidate_registry").fetchone()
    if row and row[0]:
        return False          # already populated; nothing to backfill
    cur = conn.execute(
        """INSERT OR IGNORE INTO candidate_registry
           (canonical_domain, site_id, first_campaign_key, first_seen_at,
            times_rediscovered, distinct_campaigns, distinct_sources, last_seen_at)
           SELECT domain, id, '', COALESCE(added_at, 0), 0, 1,
                  '[]', COALESCE(added_at, 0)
           FROM sites WHERE domain IS NOT NULL AND domain != ''""")
    if cur.rowcount:
        logger.info("Migration: backfilled %d candidate(s) into the registry", cur.rowcount)
    return cur.rowcount > 0


MIGRATIONS = (
    ("001_technique_sent_to_platform",
     "Add pivot_technique_stats.sites_sent_to_platform (v0.6)",
     _m001_technique_sent_to_platform),
    ("002_site_discovery_columns",
     "Add discovery provenance columns to sites (v0.2)",
     _m002_site_discovery_columns),
    ("003_campaign_columns",
     "Add campaign bookkeeping columns (v0.4)",
     _m003_campaign_columns),
    ("004_v07_adaptive_columns",
     "Add novelty and cost columns for adaptive discovery (v0.7)",
     _m004_v07_adaptive_columns),
    ("005_backfill_candidate_registry",
     "Backfill existing sites into the cross-campaign candidate registry (v0.7)",
     _m005_backfill_candidate_registry),
)


def run_migrations(conn) -> dict:
    """
    Applies every pending migration. Safe to call on every startup: each one
    checks the live schema first, so this is a no-op on an up-to-date database
    and converges a half-upgraded one.
    """
    conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        description TEXT,
        applied_at REAL,
        changed INTEGER DEFAULT 0
    )""")
    applied = {row[0] for row in conn.execute(
        "SELECT migration_id FROM schema_migrations")}

    ran, changed, failed = [], [], []
    import time

    for migration_id, description, fn in MIGRATIONS:
        if migration_id in applied:
            continue
        try:
            did_change = bool(fn(conn))
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations "
                "(migration_id, description, applied_at, changed) VALUES (?,?,?,?)",
                (migration_id, description, time.time(), int(did_change)))
            ran.append(migration_id)
            if did_change:
                changed.append(migration_id)
        except Exception as exc:                # noqa: BLE001
            # Record the failure and carry on. Stopping here would leave the
            # database in a state that is neither the old nor the new one, and
            # the later migrations are independent of this one.
            logger.error("Migration %s failed: %s", migration_id, exc)
            failed.append({"migration": migration_id, "error": str(exc)})

    return {
        "applied": ran, "changed_schema": changed, "failed": failed,
        "already_current": len(applied),
        "note": (f"{len(ran)} migration(s) run, {len(changed)} changed the schema."
                 + (f" {len(failed)} FAILED: fix these before relying on the affected "
                    "features." if failed else "")),
    }


def schema_report(conn) -> dict:
    """What has been applied, for the UI and for an upgrade check."""
    if not _table_exists(conn, "schema_migrations"):
        return {"migrations": [], "pending": [m[0] for m in MIGRATIONS],
                "note": "No migrations have ever run on this database."}
    rows = [dict(zip(("migration_id", "description", "applied_at", "changed"), row))
            for row in conn.execute(
                "SELECT migration_id, description, applied_at, changed "
                "FROM schema_migrations ORDER BY applied_at")]
    applied = {r["migration_id"] for r in rows}
    return {
        "migrations": rows,
        "pending": [m[0] for m in MIGRATIONS if m[0] not in applied],
        "note": ("Migrations check the live schema rather than a version number, so a "
                 "database restored from a backup or interrupted mid-upgrade converges "
                 "to the correct shape."),
    }
