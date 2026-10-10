# v0.6 Audit Report

Findings from tracing v0.6's workflows end to end rather than checking that
classes, schemas and UI existed. **All nine were fixed as part of v0.7**, and
each now has a regression test in `tests/test_v06_audit_fixes.py`.

Every one of these passed v0.6's 375-test suite while being broken. They share
one shape, which is the shape to look for next time:

> something was **built and never called**, or called with arguments that made
> it a no-op, or **computed and then discarded**.

A test asserting that a function returns the right value catches none of that.
The new tests assert on *effects* — did the schema change, did the budget bind,
did the counter move, is the worker running.

---

## A0 — Release blocker: v0.6 could not upgrade an existing database

**Severity: critical.** Every table is declared `CREATE TABLE IF NOT EXISTS`.
That is correct for a fresh install and silently wrong for an upgrade: SQLite
skips the statement entirely when the table exists, so a column added in a
later version never appears.

v0.6 added `pivot_technique_stats.sites_sent_to_platform`. Upgrading a v0.5
database and recording any technique outcome produced:

```
sqlite3.OperationalError: no such column: sites_sent_to_platform
```

Tests never caught it because **every test starts from an empty database**,
which is exactly the case `IF NOT EXISTS` handles correctly.

**Fix:** `app/migrations.py`. Migrations check the *live schema* rather than a
version counter, so a database restored from a backup or interrupted
mid-upgrade converges rather than being confidently wrong. `init_db()` now
creates and then migrates, and reports what changed. Five migrations ship,
including a backfill of pre-existing sites into the candidate registry — v0.6
introduced that registry but only populated it going forward, leaving an
upgraded installation's existing sites invisible to dedup and novelty.

## A1 — Budget allocation was computed, announced, and thrown away

`allocate()` was called at campaign start, published as a progress event, and
discarded. Every technique still ran until the flat lead budget ran out, so the
entire adaptive-allocation feature changed nothing about what actually ran.

**Fix:** the allocation is persisted (`campaign_allocations`) and **enforced**
per technique inside the candidate stage. A technique that has spent its share
stops running in that campaign, with the refusal recorded on the lead.

## A2 — The feedback → technique-learning loop was a no-op

`refresh_scores()` ended with:

```python
db.record_technique_outcome(row["key_value"], high_confidence=0, sent_to_platform=0)
```

which adds zero to both counters. The loop *looked* closed while downstream
usefulness never reached technique learning's payoff term.

**Fix:** `db.set_technique_downstream()` **sets** the counter from the
attribution total rather than incrementing. Idempotent on purpose —
`refresh_scores` runs on a timer, and an incrementing write there would inflate
a technique every time the timer fired.

## A3 — The platform link was never started

Nothing in `runner.py` or `server.py` ever constructed a `SyncWorker`. In a real
deployment that meant **no registration, no heartbeat, no automatic delivery,
no job claiming and no feedback polling** unless a human clicked a button. The
single largest reliability defect found.

**Fix:** `ScanController.start_integration()` / `stop_integration()`, started
automatically when a platform URL and module key are configured.

## A4 — Cross-campaign corroboration was measured and never applied

`dedup.corroboration_bonus()` was built in v0.6 and called by nothing.

**Fix:** wired into `candidate_priority` as a bounded factor.

## A5 — Campaign progress and module health never left the building

`queue_campaign_update()` and `queue_health_update()` were both built and never
called, so the platform never heard about a campaign at all — despite
`module_activity` being the documented workaround for the missing
`campaign.updated` event.

**Fix:** both are queued when a campaign finishes.

## A6 — Orphaned jobs were noticed and never handed back

`resume_after_restart()` *reported* jobs held at crash time;
`fail_orphaned_jobs()` existed but was called only from tests. Leases had to
time out on the platform before the work was re-offered.

**Fix:** called on `start_integration()`.

## A7 — Dead code from the deleted v0.5 standard

`db.queue_event`, `db.next_outbox_batch` and `db.event_already_sent` survived
the v0.5 contract they belonged to. Two competing standards is the failure v0.6
existed to prevent, even as dead code.

**Fix:** removed, with a test asserting they stay gone.

## A8 — The v4 path never stored the investigator job id

`handoff_report()` read `site_investigations.investigator_job_id`, which only
v0.5's receipt-based linking ever populated. Under v4 it was always empty, so
the Platform view could not show what had actually been assigned.

**Fix:** `db.set_investigator_job()`, populated from investigation context.

## A9 — Novelty scores were silently lost

`set_candidate_novelty()` was a plain `UPDATE`, so scoring a candidate before
it had been registered wrote nothing — the normal order for a site arriving
from anywhere other than a campaign. Found by browser-testing the main screen,
where the "New Discoveries" panel was empty with novel candidates in the
database.

**Fix:** upsert.

---

## Not defects

Checked and found correct, recorded so they are not re-investigated:

- `link_site_investigation`'s `WHERE site_id=? AND ? IS NOT NULL` looks like a
  bug and is valid — the third parameter is the null check.
- `app/review/server.py`, `reference_platform.py`, `collectors/manual_import.py`
  and `investigate/queue_worker.py` are imported by nothing, and should be:
  they are entrypoints, test infrastructure, and CLI-invoked modules.
