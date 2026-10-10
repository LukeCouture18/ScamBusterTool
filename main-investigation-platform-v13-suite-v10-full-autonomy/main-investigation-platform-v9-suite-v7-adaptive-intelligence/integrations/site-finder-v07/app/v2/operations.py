"""Persistent, bounded scheduling and cost accounting for investigation rounds."""
from __future__ import annotations

import json
import time

from app.v2 import active, intelligence, sources, store

_ready = set()
LIMITS = {"max_rounds": 100, "max_seconds": 3600, "max_actions": 100,
          "max_requests": 10000, "idle_stop": 5, "fetch_budget": 60}
MAX_LIMITS = {**LIMITS, "idle_stop": 100}

SCHEMA = """
CREATE TABLE IF NOT EXISTS ig_sustained_runs(
 id INTEGER PRIMARY KEY, state TEXT NOT NULL, limits TEXT NOT NULL,
 rounds INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0,
 requests INTEGER NOT NULL DEFAULT 0, idle_rounds INTEGER NOT NULL DEFAULT 0,
 last_round INTEGER NOT NULL DEFAULT 0, started_at REAL NOT NULL,
 updated_at REAL NOT NULL, ended_at REAL, reason TEXT);
CREATE INDEX IF NOT EXISTS ig_runs_state ON ig_sustained_runs(state,updated_at);
CREATE TABLE IF NOT EXISTS ig_watches(
 campaign_id TEXT PRIMARY KEY, state TEXT NOT NULL, interval_seconds INTEGER NOT NULL,
 last_checked REAL, next_due REAL NOT NULL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ig_watches_due ON ig_watches(state,next_due);
CREATE TABLE IF NOT EXISTS ig_round_cost(
 round INTEGER PRIMARY KEY, elapsed REAL NOT NULL, external_seconds REAL NOT NULL,
 sql_seconds REAL NOT NULL, connect_seconds REAL NOT NULL, commit_seconds REAL NOT NULL,
 connections INTEGER NOT NULL, statements INTEGER NOT NULL, writes INTEGER NOT NULL,
 commits INTEGER NOT NULL, rollbacks INTEGER NOT NULL, external_requests INTEGER NOT NULL,
 actions INTEGER NOT NULL, candidates INTEGER NOT NULL, eligible INTEGER NOT NULL,
 delivered INTEGER NOT NULL, observed_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ig_target_outcomes(
 kind TEXT NOT NULL,target TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 useful INTEGER NOT NULL DEFAULT 0,duplicates INTEGER NOT NULL DEFAULT 0,
 dead_ends INTEGER NOT NULL DEFAULT 0,last_reason TEXT,last_attempt REAL,
 PRIMARY KEY(kind,target));
"""


def ensure():
    active.ensure()
    sources.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(4,?)", (time.time(),))
    _ready.add(key)


def record_round(summary, metrics, *, actions=0):
    ensure()
    network = summary["budget"]["used"]
    external = sum(network.get(k, 0) for k in ("http", "dns", "crtsh", "rdap"))
    elapsed = float(summary.get("seconds", 0))
    with store.conn() as conn:
        conn.execute("INSERT INTO ig_round_cost(round,elapsed,external_seconds,sql_seconds,connect_seconds,"
                     "commit_seconds,connections,statements,writes,commits,rollbacks,external_requests,"
                     "actions,candidates,eligible,delivered,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                     "ON CONFLICT(round) DO NOTHING",
                     (summary["round"], elapsed, metrics.get("external_seconds", 0),
                      metrics.get("sql_seconds", 0), metrics.get("connect_seconds", 0),
                      metrics.get("commit_seconds", 0), metrics.get("connections", 0),
                      metrics.get("statements", 0), metrics.get("writes", 0),
                      metrics.get("commits", 0), metrics.get("rollbacks", 0), external, actions,
                      summary.get("pool", 0), max(0, summary.get("probed", 0)-summary.get("gated", 0)),
                      len(summary.get("delivered", [])), time.time()))


def record_target(kind, target, selected, duplicates, status):
    """Record dead ends separately from failed sources and rediscoveries."""
    ensure()
    reason = status if status not in ("healthy", "empty") else (
        "duplicate" if selected and len(selected) == duplicates else
        "dead_end" if not selected else "new_leads")
    with store.conn() as conn:
        conn.execute("INSERT INTO ig_target_outcomes(kind,target,attempts,duplicates,dead_ends,last_reason,last_attempt) "
                     "VALUES(?,?,1,?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET "
                     "attempts=attempts+1,duplicates=duplicates+excluded.duplicates,"
                     "dead_ends=dead_ends+excluded.dead_ends,last_reason=excluded.last_reason,"
                     "last_attempt=excluded.last_attempt",
                     (kind, target, duplicates, int(reason == "dead_end"), reason, time.time()))


def watch_campaign(campaign_id, *, enabled=True, interval_seconds=86400):
    ensure()
    if not intelligence.detail(campaign_id):
        raise KeyError(campaign_id)
    interval = max(3600, min(30*86400, int(interval_seconds)))
    with store.conn() as conn:
        conn.execute("INSERT INTO ig_watches(campaign_id,state,interval_seconds,next_due,created_at) "
                     "VALUES(?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET state=excluded.state,"
                     "interval_seconds=excluded.interval_seconds,next_due=excluded.next_due",
                     (campaign_id, "WATCHING" if enabled else "PAUSED", interval, time.time(), time.time()))
    return {"campaign_id": campaign_id, "state": "WATCHING" if enabled else "PAUSED", "interval_seconds": interval}


def schedule_watch(now=None):
    """At most one watched campaign member is rechecked per scheduler tick."""
    ensure()
    now = now or time.time()
    with store.conn() as conn:
        row = conn.execute("SELECT * FROM ig_watches WHERE state='WATCHING' AND next_due<=? "
                           "ORDER BY next_due LIMIT 1", (now,)).fetchone()
        if not row:
            return []
        domain = conn.execute("SELECT domain FROM ig_members WHERE campaign_id=? "
                              "ORDER BY joined_at DESC LIMIT 1", (row["campaign_id"],)).fetchone()
        conn.execute("UPDATE ig_watches SET last_checked=?,next_due=? WHERE campaign_id=?",
                     (now, now+row["interval_seconds"], row["campaign_id"]))
    candidate = store.get(domain["domain"]) if domain else None
    if not candidate:
        return []
    return active.plan(candidate, manual=True, requested_kind="revisit") or active.plan(
        candidate, manual=True, requested_kind="ct_domain")


def create_run(limits=None):
    ensure()
    chosen = dict(LIMITS)
    for key, value in (limits or {}).items():
        if key not in LIMITS:
            raise ValueError(f"unknown limit: {key}")
        chosen[key] = max(1, min(int(value), MAX_LIMITS[key]))
    with store.conn() as conn:
        if conn.execute("SELECT 1 FROM ig_sustained_runs WHERE state IN ('QUEUED','RUNNING') LIMIT 1").fetchone():
            raise ValueError("another sustained run is active")
        now = time.time()
        last = conn.execute("SELECT COALESCE(MAX(round),0) n FROM ig_round_cost").fetchone()["n"]
        run_id = conn.execute("INSERT INTO ig_sustained_runs(state,limits,last_round,started_at,updated_at) "
                              "VALUES('QUEUED',?,?,?,?)", (json.dumps(chosen), last, now, now)).lastrowid
    return run_id


def control(run_id, state):
    if state not in ("PAUSED", "RUNNING", "STOPPED"):
        raise ValueError("invalid sustained run state")
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT state FROM ig_sustained_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise KeyError(run_id)
        if row["state"] in ("COMPLETED", "STOPPED") and state != "STOPPED":
            raise ValueError("finished run cannot resume")
        conn.execute("UPDATE ig_sustained_runs SET state=?,updated_at=? WHERE id=?",
                     (state, time.time(), run_id))
    return status(run_id)


def status(run_id=None):
    ensure()
    with store.conn() as conn:
        if run_id is None:
            run = conn.execute("SELECT * FROM ig_sustained_runs ORDER BY id DESC LIMIT 1").fetchone()
        else:
            run = conn.execute("SELECT * FROM ig_sustained_runs WHERE id=?", (run_id,)).fetchone()
        watches = [dict(row) for row in conn.execute("SELECT * FROM ig_watches ORDER BY next_due LIMIT 15")]
        recent = [dict(row) for row in conn.execute("SELECT * FROM ig_round_cost ORDER BY round DESC LIMIT 15")]
    return {"run": {**dict(run), "limits": json.loads(run["limits"])} if run else None,
            "watches": watches, "rounds": recent, "sources": sources.health(),
            "frontier": active.source_report()["frontier"]}


def run_sustained(run_id):
    """Resume a persisted run; each engine round keeps its own transaction bounds."""
    from app.v2 import engine
    ensure()
    with store.conn() as conn:
        run = conn.execute("SELECT * FROM ig_sustained_runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            raise KeyError(run_id)
        if run["state"] not in ("QUEUED", "RUNNING"):
            return status(run_id)
        conn.execute("UPDATE ig_sustained_runs SET state='RUNNING',updated_at=? WHERE id=?", (time.time(), run_id))
    limits = json.loads(run["limits"])
    while True:
        with store.conn() as conn:
            run = conn.execute("SELECT * FROM ig_sustained_runs WHERE id=?", (run_id,)).fetchone()
            # A round may have committed before interruption while this cursor did not.
            missing = conn.execute("SELECT * FROM ig_round_cost WHERE round>? AND observed_at>=? ORDER BY round",
                                   (run["last_round"], run["started_at"])).fetchall()
            for row in missing:
                conn.execute("UPDATE ig_sustained_runs SET rounds=rounds+1,actions=actions+?,"
                             "requests=requests+?,last_round=? WHERE id=?",
                             (row["actions"], row["external_requests"], row["round"], run_id))
            run = conn.execute("SELECT * FROM ig_sustained_runs WHERE id=?", (run_id,)).fetchone()
            if run["state"] != "RUNNING":
                break
            reason = ("round_limit" if run["rounds"] >= limits["max_rounds"] else
                      "runtime_limit" if time.time()-run["started_at"] >= limits["max_seconds"] else
                      "action_limit" if run["actions"] >= limits["max_actions"] else
                      "request_limit" if run["requests"] >= limits["max_requests"] else
                      "idle" if run["idle_rounds"] >= limits["idle_stop"] else None)
            if reason:
                conn.execute("UPDATE ig_sustained_runs SET state='COMPLETED',reason=?,ended_at=?,updated_at=? WHERE id=?",
                             (reason, time.time(), time.time(), run_id))
                break
        schedule_watch()
        remaining = min(limits["max_requests"]-run["requests"], limits["fetch_budget"])
        if remaining <= 0:
            control(run_id, "STOPPED")
            break
        # The round has several independent request budgets. Reserve room for
        # the frontier and keep the total under the persisted global cap.
        left = limits["max_requests"]-run["requests"]
        allocations = {}
        for name, desired in (("http", limits["fetch_budget"]), ("dns", 70),
                              ("crtsh", 2), ("rdap", 5)):
            allocations[name] = min(desired, max(0, left))
            left -= allocations[name]
        summary = engine.run_round(max_deliver=5, request_limits=allocations)
        with store.conn() as conn:
            row = conn.execute("SELECT * FROM ig_round_cost WHERE round=?", (summary["round"],)).fetchone()
            if not row:
                raise RuntimeError("round completed without cost record")
            productive = bool(summary.get("delivered") or summary.get("investigation", {}).get("pivot_leads"))
            conn.execute("UPDATE ig_sustained_runs SET rounds=rounds+1,actions=actions+?,"
                         "requests=requests+?,idle_rounds=?,last_round=?,updated_at=? WHERE id=?",
                         (row["actions"], row["external_requests"],
                          0 if productive else run["idle_rounds"]+1, row["round"], time.time(), run_id))
    return status(run_id)


def rollback_to_active_rc(*, confirm=False):
    """On a database copy, remove only v3/v4 operational state.

    Candidates, graph, frontier, paths, feedback and schema 1/2 survive.
    """
    if not confirm:
        raise ValueError("confirm=True required")
    ensure()
    tables = ("ig_target_outcomes", "ig_round_cost", "ig_watches", "ig_sustained_runs",
              "ig_provider_health")
    with store.conn() as conn:
        for table in tables:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        conn.execute("DELETE FROM ig_schema WHERE version>=3")
    _ready.discard(str(store.db.DB_PATH))
    sources._ready.discard(str(store.db.DB_PATH))
    return {"removed_operational_tables": list(tables), "preserved_active_rc": True}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Run a bounded persistent Site Finder investigation")
    parser.add_argument("run_id", type=int)
    args = parser.parse_args()
    print(json.dumps(run_sustained(args.run_id), indent=2))
