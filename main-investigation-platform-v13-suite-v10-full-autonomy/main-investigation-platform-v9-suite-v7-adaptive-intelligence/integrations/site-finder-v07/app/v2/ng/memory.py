"""
Persistent discovery memory (schema version 5, additive).

    ng_external       sites Main or Operation Hunter already hold (pulled from Main); a lead
                      for one of them is a seed, never a new review slot
    ng_indicators     every pivot indicator ever searched: when, how many results, how many
                      were new, consecutive empty searches, generic/exhausted flags
    ng_lineage        how each domain was first reached: parent site, indicator, route, depth
    ng_action_stats   outcome ledger per route (delayed credit from probes and reviews)
    ng_seeds          sites to pivot from that Site Finder did not find itself (Main/Hunter
                      gap requests), with the operation they belong to
    ng_watches        fingerprints of useful sites that went dark: a later site with the same
                      build is flagged as a possible reappearance

Nothing is deleted from these tables in normal operation; rollback drops them only.
"""
from __future__ import annotations

import json
import time

from app.v2 import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS ng_external(
 domain TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'known',
 detail TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ng_indicators(
 kind TEXT NOT NULL, value TEXT NOT NULL, searches INTEGER NOT NULL DEFAULT 0,
 last_round INTEGER, last_total INTEGER NOT NULL DEFAULT 0, last_new INTEGER NOT NULL DEFAULT 0,
 total_new INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0,
 zero_streak INTEGER NOT NULL DEFAULT 0, generic INTEGER NOT NULL DEFAULT 0,
 cooldown_until INTEGER NOT NULL DEFAULT 0, exhausted INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL,
 PRIMARY KEY(kind,value));
CREATE TABLE IF NOT EXISTS ng_lineage(
 domain TEXT PRIMARY KEY, parent TEXT, via_kind TEXT NOT NULL, via_value TEXT NOT NULL,
 route TEXT NOT NULL, depth INTEGER NOT NULL, round INTEGER NOT NULL, operation TEXT,
 state TEXT NOT NULL DEFAULT 'lead', at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ng_lineage_parent ON ng_lineage(parent);
CREATE TABLE IF NOT EXISTS ng_action_stats(
 route TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, productive INTEGER NOT NULL DEFAULT 0,
 leads INTEGER NOT NULL DEFAULT 0, eligible REAL NOT NULL DEFAULT 0, useful REAL NOT NULL DEFAULT 0,
 skipped REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ng_seeds(
 domain TEXT PRIMARY KEY, source TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', operation TEXT,
 weight REAL NOT NULL DEFAULT 1, depth INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active',
 created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ng_watches(
 domain TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reason TEXT NOT NULL,
 created_at REAL NOT NULL, last_round INTEGER NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ng_rounds(
 round INTEGER PRIMARY KEY, summary TEXT NOT NULL, at REAL NOT NULL);
"""
_ready = set()
_external_cache: dict = {}


def ensure():
    from app.v2 import sources
    sources.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(5,?)", (time.time(),))
    _ready.add(key)
    _external_cache.pop(key, None)


# ------------------------------------------------------------- Main / Hunter knowledge

def note_external(items: list) -> int:
    """Records sites Main or Hunter already hold. Idempotent; returns rows written."""
    ensure()
    now = time.time()
    rows = []
    for it in items or []:
        from app.v2 import domains
        d = domains.registrable(str(it.get("domain") or ""))
        if d:
            rows.append((d, str(it.get("source") or "main")[:40], str(it.get("state") or "known")[:40],
                         str(it.get("detail") or "")[:300], now))
    if rows:
        with store.conn() as conn:
            conn.executemany("INSERT INTO ng_external(domain,source,state,detail,updated_at) VALUES(?,?,?,?,?) "
                             "ON CONFLICT(domain) DO UPDATE SET source=excluded.source,state=excluded.state,"
                             "detail=CASE WHEN excluded.detail!='' THEN excluded.detail ELSE ng_external.detail END,"
                             "updated_at=excluded.updated_at", rows)
    _external_cache.pop(str(store.db.DB_PATH), None)
    return len(rows)


def external_map() -> dict:
    ensure()
    key = str(store.db.DB_PATH)
    if key not in _external_cache:
        with store.conn() as conn:
            _external_cache[key] = {r["domain"]: dict(r) for r in conn.execute("SELECT * FROM ng_external")}
    return _external_cache[key]


def external(domain: str) -> dict | None:
    return external_map().get(domain)


# ------------------------------------------------------------- indicators

def indicator(kind: str, value: str) -> dict:
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT * FROM ng_indicators WHERE kind=? AND value=?", (kind, value)).fetchone()
    return dict(row) if row else {}


def indicators(pairs: list) -> dict:
    ensure()
    out = {}
    if not pairs:
        return out
    with store.conn() as conn:
        for kind, value in pairs:
            row = conn.execute("SELECT * FROM ng_indicators WHERE kind=? AND value=?", (kind, value)).fetchone()
            if row:
                out[(kind, value)] = dict(row)
    return out


def record_search(kind: str, value: str, round_no: int, total: int, new: int, generic: bool, conn=None):
    """One search of an indicator: saturation and cooldown are learned from what came back."""
    ensure()
    prev = indicator(kind, value)
    zero = (prev.get("zero_streak", 0) + 1) if new == 0 else 0
    # An empty search cools the indicator down for 1, 2, 4 rounds; three in a row exhausts it.
    cooldown = round_no + (2 ** min(zero, 3) if zero else 3)
    exhausted = int(zero >= 3 or generic)
    with (conn or store.conn()) as c:
        c.execute("INSERT INTO ng_indicators(kind,value,searches,last_round,last_total,last_new,total_new,zero_streak,"
                  "generic,cooldown_until,exhausted,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                  "ON CONFLICT(kind,value) DO UPDATE SET searches=searches+1,last_round=excluded.last_round,"
                  "last_total=excluded.last_total,last_new=excluded.last_new,total_new=total_new+excluded.last_new,"
                  "zero_streak=excluded.zero_streak,generic=MAX(generic,excluded.generic),"
                  "cooldown_until=excluded.cooldown_until,exhausted=MAX(exhausted,excluded.exhausted),"
                  "updated_at=excluded.updated_at",
                  (kind, value, 1, round_no, total, new, new, zero, int(generic), cooldown, exhausted, time.time()))


def credit_indicator(kind: str, value: str, field: str):
    if field not in ("eligible", "useful"):
        return
    with store.conn() as conn:
        conn.execute(f"UPDATE ng_indicators SET {field}={field}+1 WHERE kind=? AND value=?", (kind, value))


# ------------------------------------------------------------- lineage

def add_lineage(rows: list, conn=None):
    """rows: (domain, parent, via_kind, via_value, route, depth, round, operation). First route wins."""
    if not rows:
        return
    ensure()
    now = time.time()
    with (conn or store.conn()) as c:
        c.executemany("INSERT OR IGNORE INTO ng_lineage(domain,parent,via_kind,via_value,route,depth,round,operation,at) "
                      "VALUES(?,?,?,?,?,?,?,?,?)", [(*r, now) for r in rows])


def lineage(domain: str) -> dict | None:
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT * FROM ng_lineage WHERE domain=?", (domain,)).fetchone()
    return dict(row) if row else None


def chain(domain: str, limit: int = 6) -> list:
    """The discovery path back to where it started: [(domain, via, route), ...] newest first."""
    out, seen = [], set()
    cur = domain
    while cur and cur not in seen and len(out) < limit:
        seen.add(cur)
        row = lineage(cur)
        if not row:
            break
        out.append({"domain": cur, "parent": row["parent"], "via": f"{row['via_kind']}:{row['via_value'][:80]}",
                    "route": row["route"], "depth": row["depth"]})
        cur = row["parent"]
    return out


def set_lineage_state(domain: str, state: str):
    with store.conn() as conn:
        conn.execute("UPDATE ng_lineage SET state=? WHERE domain=?", (state, domain))


# ------------------------------------------------------------- route ledger

def bump_route(route: str, **d):
    ensure()
    cols = ("attempts", "productive", "leads", "eligible", "useful", "skipped", "cost")
    vals = [float(d.get(c, 0)) for c in cols]
    with store.conn() as conn:
        conn.execute(f"INSERT INTO ng_action_stats(route,{','.join(cols)},updated_at) VALUES(?,{','.join('?' * len(cols))},?) "
                     f"ON CONFLICT(route) DO UPDATE SET " + ",".join(f"{c}={c}+excluded.{c}" for c in cols) +
                     ",updated_at=excluded.updated_at", (route, *vals, time.time()))


def route_stats() -> dict:
    ensure()
    with store.conn() as conn:
        return {r["route"]: dict(r) for r in conn.execute("SELECT * FROM ng_action_stats")}


# ------------------------------------------------------------- seeds and watches

def add_seed(domain: str, source: str, reason: str = "", operation: str | None = None, weight: float = 1.0):
    ensure()
    from app.v2 import domains
    d = domains.registrable(domain or "")
    if not d:
        return None
    now = time.time()
    with store.conn() as conn:
        conn.execute("INSERT INTO ng_seeds(domain,source,reason,operation,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?) "
                     "ON CONFLICT(domain) DO UPDATE SET source=excluded.source,reason=excluded.reason,"
                     "operation=COALESCE(excluded.operation,ng_seeds.operation),weight=MAX(weight,excluded.weight),"
                     "state='active',updated_at=excluded.updated_at", (d, source[:40], reason[:300], operation, weight, now, now))
    return d


def seeds(state: str = "active") -> list:
    ensure()
    with store.conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM ng_seeds WHERE state=? ORDER BY weight DESC,updated_at DESC LIMIT 60", (state,))]


def watch(domain: str, fingerprint: dict, reason: str):
    ensure()
    with store.conn() as conn:
        conn.execute("INSERT OR IGNORE INTO ng_watches(domain,fingerprint,reason,created_at) VALUES(?,?,?,?)",
                     (domain, json.dumps(fingerprint), reason[:300], time.time()))


def watches() -> list:
    ensure()
    with store.conn() as conn:
        return [{**dict(r), "fingerprint": json.loads(r["fingerprint"])} for r in conn.execute("SELECT * FROM ng_watches LIMIT 200")]


def mark_dark(domain: str, reason: str):
    """A watched (useful) site stopped answering: later sites with its build may be its reappearance."""
    ensure()
    with store.conn() as conn:
        conn.execute("UPDATE ng_watches SET reason=? WHERE domain=?", (("dark: " + reason)[:300], domain))
    _dark_cache.pop(str(store.db.DB_PATH), None)


_dark_cache: dict = {}


def dark_watches() -> set:
    ensure()
    key = str(store.db.DB_PATH)
    if key not in _dark_cache:
        with store.conn() as conn:
            _dark_cache[key] = {r["domain"] for r in conn.execute("SELECT domain FROM ng_watches WHERE reason LIKE 'dark:%'")}
    return _dark_cache[key]


def depths(domains: list) -> dict:
    """Lineage depth for many domains in one statement."""
    ensure()
    if not domains:
        return {}
    out = {}
    with store.conn() as conn:
        for i in range(0, len(domains), 400):
            chunk = domains[i:i + 400]
            for r in conn.execute(f"SELECT domain,depth FROM ng_lineage WHERE domain IN ({','.join('?' * len(chunk))})", chunk):
                out[r["domain"]] = int(r["depth"])
    return out


def note_round(round_no: int, summary: dict):
    ensure()
    with store.conn() as conn:
        conn.execute("INSERT OR REPLACE INTO ng_rounds(round,summary,at) VALUES(?,?,?)",
                     (round_no, json.dumps(summary, default=str)[:20000], time.time()))


def rollback(*, confirm=False):
    """Drops only the next-generation tables; every earlier table and row stays."""
    if not confirm:
        raise ValueError("confirm=True required")
    ensure()
    with store.conn() as conn:
        for t in ("ng_external", "ng_indicators", "ng_lineage", "ng_action_stats", "ng_seeds", "ng_watches", "ng_rounds"):
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        conn.execute("DELETE FROM ig_schema WHERE version=5")
    _ready.discard(str(store.db.DB_PATH))
    _external_cache.pop(str(store.db.DB_PATH), None)
