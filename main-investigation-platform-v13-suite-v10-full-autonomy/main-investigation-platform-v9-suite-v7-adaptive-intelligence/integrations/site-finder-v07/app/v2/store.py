"""
v2 persistence: its own tables in the existing Site Finder SQLite database.

Nothing in v1's schema changes. v2 candidates are also mirrored into v1's
`sites`/`triage_results` rows so the existing dashboard, handoff views and
outbox keep working with them.

    v2_candidates       one row per registrable domain, with its current stage
    v2_sightings        every route that reached a candidate (provenance)
    v2_keys             clustering keys observed on a candidate
    v2_clusters         operator/kit clusters and their outcome counts
    v2_strategy_stats   per discovery strategy: cost, delivered, useful, skipped
    v2_signal_stats     per signal: how often it appeared on useful vs skipped
    v2_decisions        every USEFUL/SKIP decision, local or from the platform
    v2_infra            infrastructure learned to be noise (parking, CDN, shared)
    v2_state            cursors and counters
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

from app import db

SCHEMA = """
CREATE TABLE IF NOT EXISTS v2_candidates (
    domain TEXT PRIMARY KEY,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'new',   -- new|gated|held|ready|presented|useful|skipped|suppressed|delivered
    gate TEXT, gate_reason TEXT,
    p REAL DEFAULT 0, prior REAL DEFAULT 0,
    headline TEXT, category TEXT,
    cluster_id TEXT,
    strategies TEXT DEFAULT '[]',
    signals TEXT DEFAULT '[]',
    details TEXT DEFAULT '{}',
    site_id INTEGER,
    first_seen REAL, last_checked REAL, checks INTEGER DEFAULT 0,
    recheck_round INTEGER,
    delivered_at REAL, presented_at REAL, opened_at REAL,
    decision TEXT, decision_reason TEXT, decided_at REAL,
    platform_state TEXT, platform_investigation TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2c_status ON v2_candidates(status, p DESC);
CREATE INDEX IF NOT EXISTS idx_v2c_cluster ON v2_candidates(cluster_id);
CREATE TABLE IF NOT EXISTS v2_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL, host TEXT, strategy TEXT NOT NULL, detail TEXT, prior REAL,
    round INTEGER, seen_at REAL,
    UNIQUE(domain, strategy, detail)
);
CREATE INDEX IF NOT EXISTS idx_v2s_domain ON v2_sightings(domain);
CREATE TABLE IF NOT EXISTS v2_sight_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, strategy TEXT NOT NULL,
    round INTEGER NOT NULL, seen_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2se_round ON v2_sight_events(round);
CREATE TABLE IF NOT EXISTS v2_keys (
    domain TEXT NOT NULL, key_type TEXT NOT NULL, key_value TEXT NOT NULL,
    PRIMARY KEY(domain, key_type, key_value)
);
CREATE INDEX IF NOT EXISTS idx_v2k_value ON v2_keys(key_type, key_value);
CREATE TABLE IF NOT EXISTS v2_clusters (
    cluster_id TEXT PRIMARY KEY, representative TEXT, size INTEGER DEFAULT 1,
    useful INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS v2_strategy_stats (
    strategy TEXT PRIMARY KEY, found INTEGER DEFAULT 0, probed INTEGER DEFAULT 0, gated INTEGER DEFAULT 0,
    delivered INTEGER DEFAULT 0, useful REAL DEFAULT 0, skipped REAL DEFAULT 0, cost INTEGER DEFAULT 0,
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS v2_strategy_rounds (
    round INTEGER, strategy TEXT, share REAL, found INTEGER, probed INTEGER, delivered INTEGER,
    PRIMARY KEY(round, strategy)
);
CREATE TABLE IF NOT EXISTS v2_signal_stats (
    signal TEXT PRIMARY KEY, useful REAL DEFAULT 0, skipped REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v2_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
    source TEXT DEFAULT 'local', external_id TEXT UNIQUE, decided_at REAL, applied INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v2_infra (
    kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, count INTEGER DEFAULT 0,
    PRIMARY KEY(kind, value, label)
);
CREATE TABLE IF NOT EXISTS v2_state (key TEXT PRIMARY KEY, value TEXT);
"""

_ready = set()
_strategy_batch: ContextVar[dict | None] = ContextVar("site_finder_strategy_batch", default=None)
_STAT_COLUMNS = ("found", "probed", "gated", "delivered", "useful", "skipped", "cost")


def _flush_strategy_batch(batch):
    if not batch["pending"]:
        return
    ensure()
    now = time.time()
    rows = [(strategy, *(changes.get(col, 0) for col in _STAT_COLUMNS), now)
            for strategy, changes in batch["pending"].items()]
    columns = ",".join(_STAT_COLUMNS)
    placeholders = ",".join("?" for _ in range(len(_STAT_COLUMNS) + 2))
    updates = ",".join(f"{col}=v2_strategy_stats.{col}+excluded.{col}" for col in _STAT_COLUMNS)
    with conn() as c:
        c.executemany(f"INSERT INTO v2_strategy_stats(strategy,{columns},updated_at) VALUES({placeholders}) "
                      f"ON CONFLICT(strategy) DO UPDATE SET {updates},updated_at=excluded.updated_at", rows)
    batch["pending"].clear()
    batch["cache"] = None


@contextmanager
def batch_strategy_stats():
    if _strategy_batch.get() is not None:
        yield
        return
    batch = {"pending": defaultdict(lambda: defaultdict(float)), "cache": None}
    token = _strategy_batch.set(batch)
    try:
        yield
    finally:
        try:
            _flush_strategy_batch(batch)
        finally:
            _strategy_batch.reset(token)


def round_scope(fn):
    """Keep per-call transactions, but reuse the worker connection and batch stats."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with db.reuse_connections(), batch_strategy_stats():
            return fn(*args, **kwargs)
    return wrapped


def conn():
    return db.get_conn()


def ensure():
    key = str(db.DB_PATH)
    if key in _ready:
        return
    db.init_db()
    with conn() as c:
        c.executescript(SCHEMA)
    _ready.add(key)


def _loads(value, default):
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def row_to_candidate(row) -> dict:
    if not row:
        return None
    d = dict(row)
    d["strategies"] = _loads(d.get("strategies"), [])
    d["signals"] = _loads(d.get("signals"), [])
    d["details"] = _loads(d.get("details"), {})
    return d


# ------------------------------------------------------------------ state

def get_state(key: str, default=None):
    ensure()
    with conn() as c:
        row = c.execute("SELECT value FROM v2_state WHERE key=?", (key,)).fetchone()
    return _loads(row["value"], default) if row else default


def set_state(key: str, value):
    ensure()
    with conn() as c:
        c.execute("INSERT INTO v2_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (key, json.dumps(value)))


# ------------------------------------------------------------- candidates

def get(domain: str) -> dict | None:
    ensure()
    with conn() as c:
        return row_to_candidate(c.execute("SELECT * FROM v2_candidates WHERE domain=?", (domain,)).fetchone())


def exists(domain: str) -> bool:
    ensure()
    with conn() as c:
        return c.execute("SELECT 1 FROM v2_candidates WHERE domain=?", (domain,)).fetchone() is not None


def insert_new(domain: str, url: str, strategy: str, prior: float) -> bool:
    ensure()
    with conn() as c:
        cur = c.execute("INSERT OR IGNORE INTO v2_candidates(domain,url,status,prior,strategies,first_seen) VALUES(?,?,?,?,?,?)",
                        (domain, url, "new", prior, json.dumps([strategy]), time.time()))
        return cur.rowcount == 1


def add_strategy(domain: str, strategy: str):
    cand = get(domain)
    if not cand or strategy in cand["strategies"]:
        return
    update(domain, strategies=cand["strategies"] + [strategy])


def update(domain: str, **fields):
    if not fields:
        return
    ensure()
    for k in ("strategies", "signals", "details"):
        if k in fields and not isinstance(fields[k], str):
            fields[k] = json.dumps(fields[k], default=str)
    cols = ", ".join(f"{k}=?" for k in fields)
    with conn() as c:
        c.execute(f"UPDATE v2_candidates SET {cols} WHERE domain=?", (*fields.values(), domain))


def by_status(status: str, limit: int = 1000, order: str = "p DESC") -> list:
    ensure()
    with conn() as c:
        rows = c.execute(f"SELECT * FROM v2_candidates WHERE status=? ORDER BY {order} LIMIT ?", (status, limit)).fetchall()
    return [row_to_candidate(r) for r in rows]


def due_rechecks(round_no: int, limit: int = 40) -> list:
    ensure()
    with conn() as c:
        rows = c.execute("SELECT * FROM v2_candidates WHERE status='gated' AND recheck_round IS NOT NULL AND recheck_round<=? "
                         "ORDER BY prior DESC LIMIT ?", (round_no, limit)).fetchall()
    return [row_to_candidate(r) for r in rows]


def counts() -> dict:
    ensure()
    with conn() as c:
        rows = c.execute("SELECT status, COUNT(*) n FROM v2_candidates GROUP BY status").fetchall()
    return {r["status"]: r["n"] for r in rows}


# ---------------------------------------------------------------- sightings

def sight(domain: str, host: str, strategy: str, detail: str, prior: float, round_no: int) -> bool:
    ensure()
    with conn() as c:
        cur = c.execute("INSERT OR IGNORE INTO v2_sightings(domain,host,strategy,detail,prior,round,seen_at) VALUES(?,?,?,?,?,?,?)",
                        (domain, host, strategy, detail[:300], prior, round_no, time.time()))
        c.execute("INSERT INTO v2_sight_events(domain,strategy,round,seen_at) VALUES(?,?,?,?)",
                  (domain, strategy, round_no, time.time()))
        return cur.rowcount == 1


def sightings(domain: str) -> list:
    ensure()
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM v2_sightings WHERE domain=? ORDER BY id", (domain,)).fetchall()]


# ---------------------------------------------------------------------- keys

def add_keys(domain: str, keys: list):
    ensure()
    with conn() as c:
        c.executemany("INSERT OR IGNORE INTO v2_keys(domain,key_type,key_value) VALUES(?,?,?)",
                      [(domain, kt, kv) for kt, kv in keys if kv])


def keys_for(domain: str) -> list:
    ensure()
    with conn() as c:
        return [(r["key_type"], r["key_value"]) for r in
                c.execute("SELECT key_type,key_value FROM v2_keys WHERE domain=?", (domain,)).fetchall()]


def domains_with_key(key_type: str, key_value: str) -> list:
    ensure()
    with conn() as c:
        return [r["domain"] for r in c.execute("SELECT domain FROM v2_keys WHERE key_type=? AND key_value=?",
                                                (key_type, key_value)).fetchall()]


def key_popularity(key_type: str, key_value: str) -> int:
    ensure()
    with conn() as c:
        return c.execute("SELECT COUNT(*) n FROM v2_keys WHERE key_type=? AND key_value=?", (key_type, key_value)).fetchone()["n"]


# ------------------------------------------------------------------ clusters

def get_cluster(cluster_id: str) -> dict | None:
    ensure()
    with conn() as c:
        row = c.execute("SELECT * FROM v2_clusters WHERE cluster_id=?", (cluster_id,)).fetchone()
    return dict(row) if row else None


def upsert_cluster(cluster_id: str, representative: str, size: int):
    ensure()
    now = time.time()
    with conn() as c:
        c.execute("INSERT INTO v2_clusters(cluster_id,representative,size,created_at,updated_at) VALUES(?,?,?,?,?) "
                  "ON CONFLICT(cluster_id) DO UPDATE SET size=excluded.size, updated_at=excluded.updated_at, "
                  "representative=COALESCE(v2_clusters.representative, excluded.representative)",
                  (cluster_id, representative, size, now, now))


def cluster_members(cluster_id: str) -> list:
    ensure()
    with conn() as c:
        return [row_to_candidate(r) for r in c.execute("SELECT * FROM v2_candidates WHERE cluster_id=?", (cluster_id,)).fetchall()]


def bump_cluster_outcome(cluster_id: str, useful: bool):
    if not cluster_id:
        return
    ensure()
    col = "useful" if useful else "skipped"
    with conn() as c:
        c.execute(f"UPDATE v2_clusters SET {col}={col}+1, updated_at=? WHERE cluster_id=?", (time.time(), cluster_id))


def merge_clusters(keep: str, drop: str):
    if keep == drop:
        return
    ensure()
    with conn() as c:
        c.execute("UPDATE v2_candidates SET cluster_id=? WHERE cluster_id=?", (keep, drop))
        other = c.execute("SELECT useful, skipped FROM v2_clusters WHERE cluster_id=?", (drop,)).fetchone()
        if other:
            c.execute("UPDATE v2_clusters SET useful=useful+?, skipped=skipped+? WHERE cluster_id=?",
                      (other["useful"], other["skipped"], keep))
            c.execute("DELETE FROM v2_clusters WHERE cluster_id=?", (drop,))


# ------------------------------------------------------------ learning stats

def strategy_stats() -> dict:
    batch = _strategy_batch.get()
    if batch is not None:
        _flush_strategy_batch(batch)
        if batch["cache"] is not None:
            return batch["cache"]
    ensure()
    with conn() as c:
        stats = {r["strategy"]: dict(r) for r in c.execute("SELECT * FROM v2_strategy_stats").fetchall()}
    if batch is not None:
        batch["cache"] = stats
    return stats


def bump_strategy(strategy: str, **deltas):
    if not set(deltas) <= set(_STAT_COLUMNS):
        raise ValueError("unknown strategy statistic")
    batch = _strategy_batch.get()
    if batch is not None:
        for column, value in deltas.items():
            batch["pending"][strategy][column] += value
        batch["cache"] = None
        return
    ensure()
    with conn() as c:
        columns = ",".join(deltas)
        insert_cols = f",{columns}" if columns else ""
        placeholders = ",".join("?" for _ in range(len(deltas) + 2))
        sets = ",".join(f"{column}=v2_strategy_stats.{column}+excluded.{column}" for column in deltas)
        if sets:
            sets += ","
        c.execute(f"INSERT INTO v2_strategy_stats(strategy{insert_cols},updated_at) VALUES({placeholders}) "
                  f"ON CONFLICT(strategy) DO UPDATE SET {sets}updated_at=excluded.updated_at",
                  (strategy, *deltas.values(), time.time()))


def record_strategy_round(round_no: int, rows: dict):
    ensure()
    with conn() as c:
        for strategy, r in rows.items():
            c.execute("INSERT OR REPLACE INTO v2_strategy_rounds(round,strategy,share,found,probed,delivered) VALUES(?,?,?,?,?,?)",
                      (round_no, strategy, r.get("share", 0), r.get("found", 0), r.get("probed", 0), r.get("delivered", 0)))


def signal_stats() -> dict:
    ensure()
    with conn() as c:
        return {r["signal"]: dict(r) for r in c.execute("SELECT * FROM v2_signal_stats").fetchall()}


def bump_signal(signal: str, useful: bool, weight: float = 1.0):
    ensure()
    col = "useful" if useful else "skipped"
    with conn() as c:
        c.execute("INSERT OR IGNORE INTO v2_signal_stats(signal) VALUES(?)", (signal,))
        c.execute(f"UPDATE v2_signal_stats SET {col}={col}+? WHERE signal=?", (weight, signal))


def infra_label(kind: str, value: str) -> dict:
    ensure()
    with conn() as c:
        return {r["label"]: r["count"] for r in
                c.execute("SELECT label,count FROM v2_infra WHERE kind=? AND value=?", (kind, value)).fetchall()}


def bump_infra(kind: str, value: str, label: str):
    if not value:
        return
    ensure()
    with conn() as c:
        c.execute("INSERT INTO v2_infra(kind,value,label,count) VALUES(?,?,?,1) "
                  "ON CONFLICT(kind,value,label) DO UPDATE SET count=count+1", (kind, value, label))


# ----------------------------------------------------------------- decisions

def add_decision(domain: str, decision: str, reason: str = "", source: str = "local",
                 external_id: str = None) -> bool:
    ensure()
    with conn() as c:
        cur = c.execute("INSERT OR IGNORE INTO v2_decisions(domain,decision,reason,source,external_id,decided_at) VALUES(?,?,?,?,?,?)",
                        (domain, decision, reason or "", source, external_id, time.time()))
        return cur.rowcount == 1


def unapplied_decisions() -> list:
    ensure()
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM v2_decisions WHERE applied=0 ORDER BY id").fetchall()]


def mark_applied(decision_id: int):
    with conn() as c:
        c.execute("UPDATE v2_decisions SET applied=1 WHERE id=?", (decision_id,))
