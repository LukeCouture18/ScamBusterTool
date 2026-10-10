"""
Pursuit memory (schema version 6, additive; nothing earlier is changed).

    pu_hunts      one line of inquiry: what started it, what it is looking for, how much it has
                  spent and found, and why it stopped
    pu_branches   one pivot inside a hunt: (route, artifact) from a seed, its depth, its state
                  (open, cooling, parked, dead, exhausted) and what it returned
    pu_results    every search result set, kept so another hunt never pays for the same search
                  twice (a result is re-queried only when it is due for a revisit)
    pu_artifacts  every public artifact seen on every probed page, scam or not: the population
                  the tiers (generic / family / variant / deployment / operator) are learned from
    pu_routes     route ledger with decay, per (route, tier): what one action of that kind yields
                  now, not on average since the beginning (a route that stops working is noticed)
    pu_life       site lifecycle: first seen, last seen alive, fingerprint, state (active, changed,
                  gone, returned) and what it returned from
    pu_value      delayed downstream value per hunt/route: what investigations of the sites a hunt
                  found eventually produced (wallets, evidence), not just USEFUL clicks
"""
from __future__ import annotations

import json
import time

from app.v2 import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS pu_hunts(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '{}',
 operation TEXT, family TEXT, state TEXT NOT NULL DEFAULT 'active', priority REAL NOT NULL DEFAULT 1,
 created_round INTEGER NOT NULL DEFAULT 0, last_progress_round INTEGER NOT NULL DEFAULT 0,
 last_active_round INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0, spent REAL NOT NULL DEFAULT 0,
 leads INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0,
 value REAL NOT NULL DEFAULT 0, parked_times INTEGER NOT NULL DEFAULT 0, stop_reason TEXT NOT NULL DEFAULT '',
 updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS pu_hunts_state ON pu_hunts(state);
CREATE TABLE IF NOT EXISTS pu_branches(
 id INTEGER PRIMARY KEY, hunt_id TEXT NOT NULL, parent INTEGER, seed TEXT NOT NULL, kind TEXT NOT NULL,
 value TEXT NOT NULL, route TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'open', weight REAL NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
 results INTEGER NOT NULL DEFAULT 0, new INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
 useful INTEGER NOT NULL DEFAULT 0, junk INTEGER NOT NULL DEFAULT 0, created_round INTEGER NOT NULL DEFAULT 0,
 last_round INTEGER NOT NULL DEFAULT 0, next_round INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL DEFAULT '',
 UNIQUE(hunt_id, route, value));
CREATE INDEX IF NOT EXISTS pu_branches_state ON pu_branches(state, next_round);
CREATE TABLE IF NOT EXISTS pu_results(
 route TEXT NOT NULL, value TEXT NOT NULL, round INTEGER NOT NULL, total INTEGER NOT NULL,
 names TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(route, value));
CREATE TABLE IF NOT EXISTS pu_artifacts(
 domain TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, class TEXT NOT NULL DEFAULT 'unknown',
 round INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(domain, kind, value));
CREATE INDEX IF NOT EXISTS pu_artifacts_kv ON pu_artifacts(kind, value);
CREATE TABLE IF NOT EXISTS pu_routes(
 route TEXT NOT NULL, tier TEXT NOT NULL, attempts REAL NOT NULL DEFAULT 0, productive REAL NOT NULL DEFAULT 0,
 eligible REAL NOT NULL DEFAULT 0, useful REAL NOT NULL DEFAULT 0, skipped REAL NOT NULL DEFAULT 0,
 junk REAL NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0, last_round INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(route, tier));
CREATE TABLE IF NOT EXISTS pu_life(
 domain TEXT PRIMARY KEY, first_round INTEGER NOT NULL, last_live_round INTEGER NOT NULL DEFAULT 0,
 fingerprint TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'active', returned_from TEXT,
 changes INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pu_nodes(
 domain TEXT PRIMARY KEY, hunt_id TEXT NOT NULL, branch_id INTEGER, parent TEXT, kind TEXT NOT NULL,
 value TEXT NOT NULL, route TEXT NOT NULL, depth INTEGER NOT NULL, round INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'lead', at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS pu_nodes_hunt ON pu_nodes(hunt_id);
"""
_ready: set = set()
_leads: dict = {}                 # per database: domains that are pursuit leads not yet probed
_seeds: dict = {}                 # per database: seed sites of depth-0 branches (grow when probed)
DECAY = 0.85                 # per round: recent results count more; a route that stops paying is noticed within a few rounds


def ensure():
    from app.v2.ng import memory
    memory.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(6,?)", (time.time(),))
    _ready.add(key)


def _key() -> str:
    return str(store.db.DB_PATH)


def refresh():
    """Re-read the cached lead/seed sets (start of each round: another process may have written)."""
    _leads.pop(_key(), None)
    _seeds.pop(_key(), None)


def lead_domains() -> set:
    k = _key()
    if k not in _leads:
        with store.conn() as conn:
            _leads[k] = {r[0] for r in conn.execute("SELECT domain FROM pu_nodes WHERE state='lead'")}
    return _leads[k]


def seed_domains() -> set:
    k = _key()
    if k not in _seeds:
        with store.conn() as conn:
            _seeds[k] = {r[0] for r in conn.execute("SELECT DISTINCT seed FROM pu_branches WHERE depth=0")}
    return _seeds[k]


def rollback(*, confirm=False):
    if not confirm:
        raise ValueError("confirm=True required")
    ensure()
    with store.conn() as conn:
        for t in ("pu_hunts", "pu_branches", "pu_results", "pu_artifacts", "pu_routes", "pu_life", "pu_nodes"):
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        conn.execute("DELETE FROM ig_schema WHERE version=6")
    _ready.discard(str(store.db.DB_PATH))
    _leads.pop(_key(), None)
    _seeds.pop(_key(), None)


# ------------------------------------------------------------------ hunts

def hunt(hunt_id: str) -> dict | None:
    with store.conn() as conn:
        r = conn.execute("SELECT * FROM pu_hunts WHERE id=?", (hunt_id,)).fetchone()
    return _hunt(r) if r else None


def _hunt(r) -> dict:
    d = dict(r)
    try:
        d["origin"] = json.loads(d.get("origin") or "{}")
    except ValueError:
        d["origin"] = {}
    return d


def hunts(states=("active",), limit: int = 200) -> list:
    ph = ",".join("?" * len(states))
    with store.conn() as conn:
        return [_hunt(r) for r in conn.execute(
            f"SELECT * FROM pu_hunts WHERE state IN ({ph}) ORDER BY priority DESC, updated_at DESC LIMIT ?", (*states, limit))]


def upsert_hunt(hunt_id: str, kind: str, title: str, origin: dict, round_no: int, priority: float = 1.0,
                operation: str | None = None, family: str | None = None) -> tuple[dict, bool]:
    """Creates a hunt, or wakes an existing one with the same id. Returns (hunt, created)."""
    now = time.time()
    with store.conn() as conn:
        cur = conn.execute("SELECT * FROM pu_hunts WHERE id=?", (hunt_id,)).fetchone()
        if cur:
            wake = cur["state"] in ("parked", "exhausted")
            conn.execute("UPDATE pu_hunts SET priority=MAX(priority,?), operation=COALESCE(operation,?), "
                         "state=CASE WHEN ? THEN 'active' ELSE state END, stop_reason=CASE WHEN ? THEN '' ELSE stop_reason END, "
                         "last_progress_round=CASE WHEN ? THEN ? ELSE last_progress_round END, updated_at=? WHERE id=?",
                         (priority, operation, int(wake), int(wake), int(wake), round_no, now, hunt_id))
            return _hunt(conn.execute("SELECT * FROM pu_hunts WHERE id=?", (hunt_id,)).fetchone()), False
        conn.execute("INSERT INTO pu_hunts(id,kind,title,origin,operation,family,priority,created_round,last_progress_round,"
                     "last_active_round,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (hunt_id, kind, title[:200], json.dumps(origin, default=str)[:4000], operation, family, priority,
                      round_no, round_no, round_no, now))
        return _hunt(conn.execute("SELECT * FROM pu_hunts WHERE id=?", (hunt_id,)).fetchone()), True


def wake(hunt_id: str, round_no: int, conn=None):
    """New evidence for a parked or exhausted hunt: it becomes active again."""
    with (conn or store.conn()) as c:
        c.execute("UPDATE pu_hunts SET state='active', stop_reason='', last_progress_round=MAX(last_progress_round,?), "
                  "updated_at=? WHERE id=? AND state IN ('parked','exhausted')", (round_no, time.time(), hunt_id))


def bump_hunt(hunt_id: str, conn=None, **d):
    cols = [c for c in ("actions", "spent", "leads", "eligible", "useful", "value") if c in d]
    sets = [f"{c}={c}+?" for c in cols]
    args = [float(d[c]) for c in cols]
    for c in ("last_progress_round", "last_active_round"):
        if c in d:
            sets.append(f"{c}=MAX({c},?)")
            args.append(int(d[c]))
    if not sets:
        return
    with (conn or store.conn()) as c:
        c.execute(f"UPDATE pu_hunts SET {','.join(sets)},updated_at=? WHERE id=?", (*args, time.time(), hunt_id))


def set_hunt_state(hunt_id: str, state: str, reason: str = "", conn=None, count: bool = True):
    """count=False: a hunt waiting for its turn is not a hunt that ran dry (it is not counted as parked)."""
    with (conn or store.conn()) as c:
        c.execute("UPDATE pu_hunts SET state=?, stop_reason=?, parked_times=parked_times+? , updated_at=? WHERE id=?",
                  (state, reason[:300], 1 if state == "parked" and count else 0, time.time(), hunt_id))


# ------------------------------------------------------------------ branches

def add_branches(rows: list, conn=None) -> int:
    """rows: dict(hunt_id, parent, seed, kind, value, route, depth, tier, weight, round, why). Duplicates ignored."""
    if not rows:
        return 0
    with (conn or store.conn()) as c:
        before = c.total_changes
        c.executemany("INSERT OR IGNORE INTO pu_branches(hunt_id,parent,seed,kind,value,route,depth,tier,weight,"
                      "created_round,next_round,why) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(r["hunt_id"], r.get("parent"), r["seed"], r["kind"], r["value"][:300], r["route"], r["depth"],
                        r.get("tier", ""), r.get("weight", 1.0), r["round"], r["round"], r.get("why", "")[:300]) for r in rows])
        added = c.total_changes - before
    if _key() in _seeds:
        _seeds[_key()].update(r["seed"] for r in rows if int(r.get("depth") or 0) == 0 and r.get("seed"))
    return added


def open_branches(round_no: int, hunt_ids: list, limit: int = 400) -> list:
    if not hunt_ids:
        return []
    ph = ",".join("?" * len(hunt_ids))
    with store.conn() as conn:
        return [dict(r) for r in conn.execute(
            f"SELECT * FROM pu_branches WHERE hunt_id IN ({ph}) AND state IN ('open','cooling') AND next_round<=? "
            f"ORDER BY weight DESC, depth ASC LIMIT ?", (*hunt_ids, round_no, limit))]


def branch_counts(hunt_ids: list) -> dict:
    if not hunt_ids:
        return {}
    ph = ",".join("?" * len(hunt_ids))
    out = {}
    with store.conn() as conn:
        for r in conn.execute(f"SELECT hunt_id,state,COUNT(*) n FROM pu_branches WHERE hunt_id IN ({ph}) GROUP BY hunt_id,state", hunt_ids):
            out.setdefault(r["hunt_id"], {})[r["state"]] = r["n"]
    return out


def update_branch(branch_id: int, conn=None, **d):
    sets, args = [], []
    for k, v in d.items():
        if k in ("attempts", "results", "new", "eligible", "useful", "junk"):
            sets.append(f"{k}={k}+?")
        else:
            sets.append(f"{k}=?")
        args.append(v)
    if sets:
        with (conn or store.conn()) as c:
            c.execute(f"UPDATE pu_branches SET {','.join(sets)} WHERE id=?", (*args, branch_id))


def branches_with_value(kind: str, value: str) -> list:
    with store.conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM pu_branches WHERE kind=? AND value=?", (kind, value))]


# ------------------------------------------------------------------ result cache

def cached(route: str, value: str) -> dict | None:
    with store.conn() as conn:
        r = conn.execute("SELECT * FROM pu_results WHERE route=? AND value=?", (route, value)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["names"] = json.loads(d["names"] or "[]")
    return d


def cache(route: str, value: str, round_no: int, total: int, names: list, status: str, conn=None):
    with (conn or store.conn()) as c:
        c.execute("INSERT OR REPLACE INTO pu_results(route,value,round,total,names,status) VALUES(?,?,?,?,?,?)",
                  (route, value[:300], round_no, int(total), json.dumps(names[:200]), status))


# ------------------------------------------------------------------ artifacts

def note_artifacts(domain: str, keys: list, klass: str, round_no: int):
    """Records every artifact of a probed page with the page's class (scam / nonscam / unknown)."""
    rows = [(domain, k, str(v)[:300], klass, round_no) for k, v in keys if v and k not in ("simhash",)]
    if not rows:
        return
    with store.conn() as conn:
        conn.executemany("INSERT INTO pu_artifacts(domain,kind,value,class,round) VALUES(?,?,?,?,?) "
                         "ON CONFLICT(domain,kind,value) DO UPDATE SET class=CASE WHEN excluded.class!='unknown' "
                         "THEN excluded.class ELSE pu_artifacts.class END", rows)


def set_class(domain: str, klass: str):
    with store.conn() as conn:
        conn.execute("UPDATE pu_artifacts SET class=? WHERE domain=?", (klass, domain))


def artifacts_of(domains: list) -> dict:
    out = {d: [] for d in domains}
    if not domains:
        return out
    with store.conn() as conn:
        for i in range(0, len(domains), 400):
            chunk = domains[i:i + 400]
            for r in conn.execute(f"SELECT domain,kind,value FROM pu_artifacts WHERE domain IN ({','.join('?' * len(chunk))})", chunk):
                out[r["domain"]].append((r["kind"], r["value"]))
    return out


def artifact_domains(kind: str, value: str, limit: int = 200) -> list:
    with store.conn() as conn:
        return [r["domain"] for r in conn.execute("SELECT domain FROM pu_artifacts WHERE kind=? AND value=? LIMIT ?",
                                                   (kind, value, limit))]


def tier_stats(pairs: list) -> dict:
    """Population statistics of artifacts over every page seen (scam or not) + wallet independence."""
    from app.v2.pursuit import artifacts
    out = {}
    pairs = list(dict.fromkeys(pairs))
    if not pairs:
        return out
    doms: dict = {}
    klass: dict = {}
    with store.conn() as conn:
        for i in range(0, len(pairs), 300):
            chunk = pairs[i:i + 300]
            cond = " OR ".join("(kind=? AND value=?)" for _ in chunk)
            args = [x for kv in chunk for x in kv]
            for r in conn.execute(f"SELECT kind,value,domain,class FROM pu_artifacts WHERE {cond}", args):
                doms.setdefault((r["kind"], r["value"]), set()).add(r["domain"])
                klass[r["domain"]] = r["class"]
        all_d = sorted({d for s in doms.values() for d in s})
        wallets: dict = {}
        for i in range(0, len(all_d), 400):
            chunk = all_d[i:i + 400]
            for r in conn.execute(f"SELECT domain,key_value FROM v2_keys WHERE key_type='wallet' AND domain IN ({','.join('?' * len(chunk))})", chunk):
                wallets.setdefault(r["domain"], set()).add(r["key_value"])
    for kv in pairs:
        ds = doms.get(kv, set())
        groups, shared = artifacts._wallet_groups([wallets.get(d, set()) for d in ds])
        out[kv] = {"sites": len(ds), "scam": sum(1 for d in ds if klass.get(d) == "scam"),
                   "nonscam": sum(1 for d in ds if klass.get(d) == "nonscam"),
                   "wallet_groups": groups, "shared_wallet": shared}
    return out


# ------------------------------------------------------------------ route ledger (decayed)

def route_ledger() -> dict:
    with store.conn() as conn:
        return {(r["route"], r["tier"]): dict(r) for r in conn.execute("SELECT * FROM pu_routes")}


def bump_route(route: str, tier: str, round_no: int, conn=None, **d):
    """Adds to the ledger after decaying it to the current round."""
    cols = ("attempts", "productive", "eligible", "useful", "skipped", "junk", "value")
    with (conn or store.conn()) as c:
        r = c.execute("SELECT * FROM pu_routes WHERE route=? AND tier=?", (route, tier)).fetchone()
        base = {k: 0.0 for k in cols}
        if r:
            f = DECAY ** max(0, round_no - int(r["last_round"] or 0))
            base = {k: float(r[k]) * f for k in cols}
        for k in cols:
            base[k] += float(d.get(k, 0))
        c.execute("INSERT OR REPLACE INTO pu_routes(route,tier," + ",".join(cols) + ",last_round) VALUES(?,?," +
                  ",".join("?" * len(cols)) + ",?)", (route, tier, *[base[k] for k in cols], round_no))


# ------------------------------------------------------------------ nodes (lineage of pursuit leads)

def add_nodes(rows: list, conn=None):
    """rows: (domain, hunt_id, branch_id, parent, kind, value, route, depth, round). First discovery wins."""
    if not rows:
        return
    now = time.time()
    with (conn or store.conn()) as c:
        c.executemany("INSERT OR IGNORE INTO pu_nodes(domain,hunt_id,branch_id,parent,kind,value,route,depth,round,at) "
                      "VALUES(?,?,?,?,?,?,?,?,?,?)", [(*r, now) for r in rows])
    if _key() in _leads:
        _leads[_key()].update(r[0] for r in rows)


def node(domain: str) -> dict | None:
    with store.conn() as conn:
        r = conn.execute("SELECT * FROM pu_nodes WHERE domain=?", (domain,)).fetchone()
    return dict(r) if r else None


def nodes(domains: list) -> dict:
    out = {}
    if not domains:
        return out
    with store.conn() as conn:
        for i in range(0, len(domains), 400):
            chunk = domains[i:i + 400]
            for r in conn.execute(f"SELECT * FROM pu_nodes WHERE domain IN ({','.join('?' * len(chunk))})", chunk):
                out[r["domain"]] = dict(r)
    return out


def set_node_state(domain: str, state: str):
    with store.conn() as conn:
        conn.execute("UPDATE pu_nodes SET state=? WHERE domain=?", (state, domain))
    if state != "lead" and _key() in _leads:
        _leads[_key()].discard(domain)


# ------------------------------------------------------------------ lifecycle

def life(domain: str) -> dict | None:
    with store.conn() as conn:
        r = conn.execute("SELECT * FROM pu_life WHERE domain=?", (domain,)).fetchone()
    return dict(r) if r else None


def lives(states=("gone",)) -> list:
    ph = ",".join("?" * len(states))
    with store.conn() as conn:
        return [dict(r) for r in conn.execute(f"SELECT * FROM pu_life WHERE state IN ({ph}) LIMIT 500", states)]


def upsert_life(domain: str, round_no: int, fingerprint: str | None = None, state: str | None = None,
                returned_from: str | None = None) -> dict:
    now = time.time()
    with store.conn() as conn:
        cur = conn.execute("SELECT * FROM pu_life WHERE domain=?", (domain,)).fetchone()
        if not cur:
            conn.execute("INSERT INTO pu_life(domain,first_round,last_live_round,fingerprint,state,returned_from,updated_at) "
                         "VALUES(?,?,?,?,?,?,?)", (domain, round_no, round_no if state != "gone" else 0, fingerprint or "",
                                                  state or "active", returned_from, now))
            return {"new": True, "changed": False}
        changed = bool(fingerprint and cur["fingerprint"] and fingerprint != cur["fingerprint"])
        new_state = state or ("changed" if changed else ("active" if cur["state"] == "gone" else cur["state"]))
        conn.execute("UPDATE pu_life SET last_live_round=CASE WHEN ?!='gone' THEN ? ELSE last_live_round END, "
                     "fingerprint=COALESCE(NULLIF(?,''),fingerprint), state=?, returned_from=COALESCE(?,returned_from), "
                     "changes=changes+?, updated_at=? WHERE domain=?",
                     (new_state, round_no, fingerprint or "", new_state, returned_from, int(changed), now, domain))
        return {"new": False, "changed": changed, "was": cur["state"]}
