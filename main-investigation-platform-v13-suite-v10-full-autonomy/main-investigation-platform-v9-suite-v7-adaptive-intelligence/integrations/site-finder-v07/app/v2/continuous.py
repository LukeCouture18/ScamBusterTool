"""
Site Finder v5: continuous discovery.

A discovery *cycle* is one bounded, persisted unit of work that can run on a
schedule (standalone autopilot) or on request (the platform's DISCOVER_SITES
job with mode=continuous). A cycle:

  1. recovers    a cycle interrupted by a crash is marked `interrupted`; nothing it
                 wrote is lost or repeated (candidates are keyed by domain)
  2. budgets     stops before today's request budget is spent (per-day ledger)
  3. plans       rotates sources: Thompson-sampled strategy values (learned from
                 downstream outcomes) choose most of the sources, every source is
                 forced back in at least every ROTATE_EVERY cycles, and a source
                 that keeps finding nothing new cools down exponentially
  4. runs        one engine round restricted to the chosen sources, with an
                 ecosystem veto: a cluster that already delivered ECOSYSTEM_CAP
                 sites and never proved useful is not delivered again
  5. measures    novelty (new unique domains, new ecosystems, previously unseen
                 infrastructure), duplicates (re-sightings of known domains) and
                 rediscoveries (an aged candidate seen again is re-probed)
  6. ages        undecided candidates older than AGE_DAYS stop counting as supply
  7. watches     re-resolves delivered/useful sites on a backoff schedule; a real
                 change (resolves/stops resolving, new IP, new name servers) is
                 recorded and re-sent to the platform with a new batch id, where
                 temporal intelligence turns it into a change record. An unchanged
                 check only moves `last_checked`: it is not new evidence.

Everything here is passive and public (DNS, certificate transparency, public
pages via the existing engine). Nothing logs in, submits forms or bypasses any
check.
"""
from __future__ import annotations

import json
import logging
import random
import time

from app.v2 import adaptive, netio, store

logger = logging.getLogger("scamhunter.v5.continuous")

SOURCES = ["ct_terms", "cert_siblings", "ct_learned", "ct_frontier", "pattern_siblings", "brand_typos", "feeds", "mentions", "recheck"]
ROTATE_EVERY = 4          # every source runs at least once in this many cycles
PICK = 3                  # sources chosen by value per cycle (plus forced rotations)
COOLDOWN_AFTER = 2        # zero-new cycles before a source cools down
ECOSYSTEM_CAP = 3         # delivered sites per unproven ecosystem
AGE_DAYS = 14
WATCH_PER_CYCLE = 20
WATCH_BASE_HOURS = 12
DAILY_HTTP = 1500
DAILY_DNS = 6000
LEASE_SECONDS = 1800

SCHEMA = """
CREATE TABLE IF NOT EXISTS v5_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at REAL, finished_at REAL, status TEXT NOT NULL,
    reason TEXT, plan TEXT DEFAULT '{}', result TEXT DEFAULT '{}', lease_until REAL
);
CREATE TABLE IF NOT EXISTS v5_source_state (
    source TEXT PRIMARY KEY, cycles INTEGER DEFAULT 0, last_cycle INTEGER DEFAULT 0, zero_streak INTEGER DEFAULT 0,
    cooldown_until INTEGER DEFAULT 0, new_unique INTEGER DEFAULT 0, duplicates INTEGER DEFAULT 0, novel_ecosystems INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v5_budget (day TEXT PRIMARY KEY, http INTEGER DEFAULT 0, dns INTEGER DEFAULT 0, cycles INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS v5_ecosystems (
    cluster_id TEXT PRIMARY KEY, delivered INTEGER DEFAULT 0, first_cycle INTEGER, last_new_cycle INTEGER
);
CREATE TABLE IF NOT EXISTS v5_watch (
    domain TEXT PRIMARY KEY, ip TEXT, ns TEXT, status TEXT, first_checked REAL, last_checked REAL,
    checks INTEGER DEFAULT 0, changes INTEGER DEFAULT 0, next_check REAL
);
CREATE TABLE IF NOT EXISTS v5_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, facet TEXT NOT NULL, old TEXT, new TEXT, at REAL, cycle INTEGER, pushed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_v5_changes_domain ON v5_changes(domain);
"""
_ready: set = set()


def ensure():
    from app import db
    key = str(db.DB_PATH)
    if key in _ready:
        return
    store.ensure()
    with store.conn() as c:
        c.executescript(SCHEMA)
    _ready.add(key)


def _day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now))


def budget_left(now: float | None = None) -> dict:
    ensure()
    now = now or time.time()
    with store.conn() as c:
        r = c.execute("SELECT http,dns,cycles FROM v5_budget WHERE day=?", (_day(now),)).fetchone()
    used = dict(r) if r else {"http": 0, "dns": 0, "cycles": 0}
    return {"http": max(0, DAILY_HTTP - used["http"]), "dns": max(0, DAILY_DNS - used["dns"]), "used": used}


def _charge(now: float, http: int, dns: int, cycle: int = 0):
    with store.conn() as c:
        c.execute("INSERT INTO v5_budget(day,http,dns,cycles) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET "
                  "http=http+excluded.http,dns=dns+excluded.dns,cycles=cycles+excluded.cycles", (_day(now), http, dns, cycle))


def _source_state() -> dict:
    with store.conn() as c:
        return {r["source"]: dict(r) for r in c.execute("SELECT * FROM v5_source_state").fetchall()}


def plan(cycle_no: int, rng: random.Random, only: list | None = None) -> dict:
    """Which sources this cycle uses, and why. Pure apart from reading source state."""
    state = _source_state()
    values = adaptive.strategy_values(rng, sample=True)
    pool = [s for s in (only or SOURCES) if s in SOURCES]
    if "ct_frontier" in pool:
        from app.v2 import strategies
        searched = set(store.get_state("ct_frontier_done", []))
        if not any(stem not in searched for stem in strategies.frontier_stems()):
            pool.remove("ct_frontier")
    cooling = {s for s in pool if state.get(s, {}).get("cooldown_until", 0) > cycle_no}
    forced = [s for s in pool if s not in cooling and cycle_no - state.get(s, {}).get("last_cycle", 0) >= ROTATE_EVERY]
    # Reward strategies that actually reach unseen registrations. A source with
    # many rediscoveries loses share before its yield falls all the way to zero.
    novelty = {s: (state.get(s, {}).get("new_unique", 0) + 2) /
               (state.get(s, {}).get("new_unique", 0) + state.get(s, {}).get("duplicates", 0) + 4)
               for s in pool}
    ranked = sorted((s for s in pool if s not in cooling),
                    key=lambda s: -(values.get(s, 0.0) * (0.25 + 0.75 * novelty[s])))
    chosen = list(dict.fromkeys(ranked[:PICK] + forced))
    # Cold starts need a broad source. Several pivot arms are empty until a
    # useful candidate exists, so do not let sampling spend a cycle on them.
    if not any(s in chosen for s in ("ct_terms", "feeds", "brand_typos")):
        broad = next((s for s in ("ct_terms", "feeds", "brand_typos") if s in ranked), None)
        if broad:
            chosen = list(dict.fromkeys(chosen[:max(0, PICK - 1)] + [broad] + chosen[PICK:]))
    if not chosen and pool:                       # everything cooling: explore the least recently used source
        chosen = [min(pool, key=lambda s: state.get(s, {}).get("last_cycle", 0))]
    why = {s: ("rotation: not run for %d cycles" % (cycle_no - state.get(s, {}).get("last_cycle", 0)) if s in forced and s not in ranked[:PICK]
               else "learned value %.3f; new-domain yield %.0f%%" % (values.get(s, 0.0), novelty[s] * 100)) for s in chosen}
    return {"sources": chosen, "why": why, "cooling": sorted(cooling),
            "novelty": {k: round(v, 3) for k, v in novelty.items()},
            "values": {k: round(v, 4) for k, v in values.items() if k in pool}}


def _veto(cycle_no: int):
    def veto(cand: dict):
        cid = cand.get("cluster_id")
        if not cid:
            return None
        info = store.get_cluster(cid) or {}
        if info.get("useful"):
            return None                               # a proven ecosystem may still reveal new wallets
        with store.conn() as c:
            r = c.execute("SELECT delivered FROM v5_ecosystems WHERE cluster_id=?", (cid,)).fetchone()
        if r and r["delivered"] >= ECOSYSTEM_CAP:
            return f"ecosystem already represented by {r['delivered']} delivered sites"
        return None
    return veto


def _recover(now: float) -> int:
    with store.conn() as c:
        cur = c.execute("UPDATE v5_cycles SET status='interrupted', finished_at=? WHERE status='running' AND (lease_until IS NULL OR lease_until<?)", (now, now))
        return cur.rowcount


def run_cycle(requested: int = 10, http: int = 120, sources: list | None = None, reason: str = "scheduled",
              now: float | None = None, progress=None, request_limits: dict | None = None) -> dict:
    """Runs one continuous-discovery cycle. Safe to call after a crash or concurrently (lease)."""
    ensure()
    from app.v2 import engine
    now = now or time.time()
    recovered = _recover(now)
    with store.conn() as c:
        if c.execute("SELECT 1 FROM v5_cycles WHERE status='running' AND lease_until>=?", (now,)).fetchone():
            return {"ran": False, "reason": "another cycle is running", "delivered": 0, "recovered": recovered}
    left = budget_left(now)
    if left["http"] < 10 or left["dns"] < 30:
        with store.conn() as c:
            c.execute("INSERT INTO v5_cycles(started_at,finished_at,status,reason,result) VALUES(?,?,?,?,?)",
                      (now, now, "skipped", reason, json.dumps({"why": "daily discovery budget spent", "left": left})))
        return {"ran": False, "reason": "daily discovery budget spent", "delivered": 0, "budget_left": left, "recovered": recovered}
    with store.conn() as c:
        cycle_no = (c.execute("SELECT COALESCE(MAX(id),0) n FROM v5_cycles").fetchone()["n"] or 0) + 1
    rng = random.Random(f"v5:{cycle_no}:{store.counts().get('useful', 0)}")
    p = plan(cycle_no, rng, sources)
    with store.conn() as c:
        cur = c.execute("INSERT INTO v5_cycles(started_at,status,reason,plan,lease_until) VALUES(?,?,?,?,?)",
                        (now, "running", reason, json.dumps(p), now + LEASE_SECONDS))
        cycle_id = cur.lastrowid
    try:
        with store.conn() as c:
            known_before = {r["domain"] for r in c.execute("SELECT domain FROM v2_candidates").fetchall()}
            infra_before = {(r["key_type"], r["key_value"]) for r in c.execute("SELECT key_type,key_value FROM v2_keys WHERE key_type IN ('ip','san','favtmpl','service')").fetchall()}
            eco_before = {r["cluster_id"] for r in c.execute("SELECT cluster_id FROM v5_ecosystems").fetchall()}
            aged_before = {r["domain"] for r in c.execute("SELECT domain FROM v2_candidates WHERE status='aged'").fetchall()}
        summary = engine.run_round(fetch_budget=min(http, left["http"]), requested=requested, only_strategies=set(p["sources"]),
                                   deliver_veto=_veto(cycle_no), deliver_any_strategy=True, progress=progress, request_limits=request_limits)
        round_no = summary["round"]
        with store.conn() as c:
            sightings = c.execute("SELECT domain,strategy FROM v2_sight_events WHERE round=?", (round_no,)).fetchall()
            after = {r["domain"]: dict(r) for r in c.execute("SELECT domain,status,cluster_id FROM v2_candidates").fetchall()}
            infra_after = {(r["key_type"], r["key_value"]) for r in c.execute("SELECT key_type,key_value FROM v2_keys WHERE key_type IN ('ip','san','favtmpl','service')").fetchall()}
        new_domains = set(after) - known_before
        existing_clusters = {v["cluster_id"] for d, v in after.items() if d in known_before and v["cluster_id"]}
        near_duplicates = sum(bool(after[d]["cluster_id"] and after[d]["cluster_id"] in existing_clusters)
                              for d in new_domains)
        dup_by_source: dict = {}
        new_by_source: dict = {}
        rediscovered = set()
        for s in sightings:
            if s["domain"] in known_before:
                dup_by_source[s["strategy"]] = dup_by_source.get(s["strategy"], 0) + 1
                if s["domain"] in aged_before:
                    rediscovered.add(s["domain"])
            elif s["domain"] in new_domains:
                new_by_source[s["strategy"]] = new_by_source.get(s["strategy"], 0) + 1
        for d in rediscovered:                        # seen again after aging: still active, re-probe it
            store.update(d, status="new", recheck_round=None)
        novel_eco = 0
        with store.conn() as c:
            for d in summary["delivered"]:
                cid = (after.get(d["domain"]) or {}).get("cluster_id")
                if not cid:
                    continue
                if cid not in eco_before:
                    novel_eco += 1
                c.execute("INSERT INTO v5_ecosystems(cluster_id,delivered,first_cycle,last_new_cycle) VALUES(?,1,?,?) "
                          "ON CONFLICT(cluster_id) DO UPDATE SET delivered=delivered+1,last_new_cycle=excluded.last_new_cycle", (cid, cycle_no, cycle_no))
            for s in p["sources"]:
                new = new_by_source.get(s, 0)
                st = c.execute("SELECT zero_streak FROM v5_source_state WHERE source=?", (s,)).fetchone()
                streak = 0 if new else ((st["zero_streak"] if st else 0) + 1)
                cooldown = cycle_no + 2 ** min(streak - COOLDOWN_AFTER + 1, 4) if streak >= COOLDOWN_AFTER else 0
                c.execute("INSERT INTO v5_source_state(source,cycles,last_cycle,zero_streak,cooldown_until,new_unique,duplicates) VALUES(?,1,?,?,?,?,?) "
                          "ON CONFLICT(source) DO UPDATE SET cycles=cycles+1,last_cycle=excluded.last_cycle,zero_streak=excluded.zero_streak,"
                          "cooldown_until=excluded.cooldown_until,new_unique=new_unique+excluded.new_unique,duplicates=duplicates+excluded.duplicates",
                          (s, cycle_no, streak, cooldown, new, dup_by_source.get(s, 0)))
        aged = age_candidates(now)
        watch = watch_infrastructure(now, cycle_no, netio.Budget(http=0, dns=min(2 * WATCH_PER_CYCLE + 5, left["dns"])))
        used = summary["budget"]["used"]
        _charge(now, used.get("http", 0), used.get("dns", 0) + watch["dns_used"], 1)
        suppressed_eco = 0
        with store.conn() as c:
            suppressed_eco = c.execute("SELECT COUNT(*) n FROM v2_candidates WHERE status='suppressed' AND json_extract(details,'$.suppressed') LIKE 'ecosystem already%'").fetchone()["n"]
        duplicate_count = sum(dup_by_source.values())
        result = {"ran": True, "cycle": cycle_no, "round": round_no, "sources": p["sources"], "delivered": len(summary["delivered"]),
                  "delivered_domains": [d["domain"] for d in summary["delivered"]],
                  "new_unique": len(new_domains), "new_infrastructure": len(infra_after - infra_before), "novel_ecosystems": novel_eco,
                  "duplicate_sightings": duplicate_count,
                  "new_site_rate": round(len(new_domains) / max(1, len(new_domains) + duplicate_count), 3),
                  "duplicate_rate": round(duplicate_count / max(1, len(new_domains) + duplicate_count), 3),
                  "near_duplicate_new": near_duplicates,
                  "near_duplicate_rate": round(near_duplicates / max(1, len(new_domains)), 3),
                  "useful_new_site_rate_cumulative": round(sum(1 for c in after.values() if c["status"] == "useful") / max(1, len(after)), 3),
                  "source_novelty": {s: round(new_by_source.get(s, 0) / max(1, new_by_source.get(s, 0) + dup_by_source.get(s, 0)), 3) for s in p["sources"]},
                  "rediscovered": sorted(rediscovered), "aged": aged,
                  "ecosystem_suppressed_total": suppressed_eco, "watch": watch, "probed": summary["probed"], "budget": summary["budget"],
                  "recovered_interrupted": recovered, "saturated": len(new_domains) == 0}
        with store.conn() as c:
            c.execute("UPDATE v5_cycles SET status='done',finished_at=?,result=? WHERE id=?", (time.time(), json.dumps(result), cycle_id))
        return result
    except Exception as exc:
        with store.conn() as c:
            c.execute("UPDATE v5_cycles SET status='failed',finished_at=?,result=? WHERE id=?", (time.time(), json.dumps({"error": str(exc)[:300]}), cycle_id))
        raise


def age_candidates(now: float) -> int:
    """Undecided delivered candidates older than AGE_DAYS stop counting as waiting supply."""
    cutoff = now - AGE_DAYS * 86400
    with store.conn() as c:
        cur = c.execute("UPDATE v2_candidates SET status='aged' WHERE status IN ('ready','presented') AND decision IS NULL AND delivered_at IS NOT NULL AND delivered_at<?", (cutoff,))
        return cur.rowcount


def watch_infrastructure(now: float, cycle_no: int, budget: netio.Budget) -> dict:
    """
    Change detection for delivered and useful sites: DNS only, on a backoff
    schedule. Returns what it checked and what changed. Unchanged checks do not
    create records beyond `last_checked`.
    """
    checked = changed = 0
    changes = []
    with store.conn() as c:
        rows = c.execute("""SELECT v.domain, v.details, w.ip wip, w.ns wns, w.status wstatus, w.checks, w.next_check
                            FROM v2_candidates v LEFT JOIN v5_watch w ON w.domain=v.domain
                            WHERE v.status IN ('ready','presented','useful','delivered','aged')
                              AND (w.next_check IS NULL OR w.next_check<=?)
                            ORDER BY CASE v.status WHEN 'useful' THEN 0 ELSE 1 END, COALESCE(w.last_checked,0) LIMIT ?""",
                         (now, WATCH_PER_CYCLE)).fetchall()
    for r in rows:
        if not budget.take("dns", 2):
            break
        details = json.loads(r["details"] or "{}")
        ip = netio.resolve(r["domain"]) or ""
        ns = netio.nameservers(r["domain"]) if ip else []
        status = "live" if ip else "dead"
        checked += 1
        base_ip, base_ns, base_status = (r["wip"], r["wns"], r["wstatus"]) if r["wstatus"] else (details.get("ip") or "", json.dumps(sorted(details.get("ns") or [])), "live" if details.get("ip") else "dead")
        facets = []
        if status != base_status:
            facets.append(("status", base_status, status))
        if ip and base_ip and ip != base_ip:
            facets.append(("ip", base_ip, ip))
        if ns and base_ns and json.dumps(sorted(ns)) != base_ns and json.loads(base_ns or "[]"):
            facets.append(("nameservers", base_ns, json.dumps(sorted(ns))))
        checks = (r["checks"] or 0) + 1
        backoff = WATCH_BASE_HOURS * 3600 * (1 if facets else min(8, 2 ** min(checks - 1, 3)))
        with store.conn() as c:
            c.execute("INSERT INTO v5_watch(domain,ip,ns,status,first_checked,last_checked,checks,changes,next_check) VALUES(?,?,?,?,?,?,?,?,?) "
                      "ON CONFLICT(domain) DO UPDATE SET ip=excluded.ip,ns=excluded.ns,status=excluded.status,last_checked=excluded.last_checked,"
                      "checks=excluded.checks,changes=changes+?,next_check=excluded.next_check",
                      (r["domain"], ip or base_ip, json.dumps(sorted(ns)) if ns else base_ns, status, now, now, checks, len(facets), now + backoff, len(facets)))
            for f, old, new in facets:
                c.execute("INSERT INTO v5_changes(domain,facet,old,new,at,cycle) VALUES(?,?,?,?,?,?)", (r["domain"], f, old, new, now, cycle_no))
        if facets:
            changed += 1
            changes.append({"domain": r["domain"], "changes": [{"facet": f, "old": o, "new": n} for f, o, n in facets]})
            keys = [k for k in (details.get("keys") or []) if k and k[0] != "ip"] + ([["ip", ip]] if ip else [])
            details.update({"ip": ip or details.get("ip", ""), "ns": ns or details.get("ns", []), "site_status": status,
                            "watch_rev": int(details.get("watch_rev") or 0) + 1, "keys": keys[:20]})
            store.update(r["domain"], details=details)
            from app.v2 import intelligence
            intelligence.ingest(store.get(r["domain"]), recompute=False, observed_at=now)
            intelligence.suggest(store.get(r["domain"]))
            _push_change(r["domain"])
    if changed:
        from app.v2 import intelligence
        intelligence.rebuild()
    return {"checked": checked, "changed": changed, "changes": changes[:20], "dns_used": budget.used["dns"]}


def _push_change(domain: str):
    """Re-sends the candidate so the platform records the change (new batch id per watch revision)."""
    try:
        from app.v2 import platform_bridge
        cand = store.get(domain)
        if cand and cand.get("platform_state"):
            platform_bridge.queue_deliveries([cand])
            with store.conn() as c:
                c.execute("UPDATE v5_changes SET pushed=1 WHERE domain=? AND pushed=0", (domain,))
    except Exception as exc:                          # noqa: BLE001 - a failed push is retried on the next change
        logger.warning("could not queue change for %s: %s", domain, exc)


def report() -> dict:
    ensure()
    with store.conn() as c:
        cycles = [dict(r) for r in c.execute("SELECT id,started_at,finished_at,status,reason,result FROM v5_cycles ORDER BY id DESC LIMIT 20").fetchall()]
        sources = [dict(r) for r in c.execute("SELECT * FROM v5_source_state ORDER BY source").fetchall()]
        eco = c.execute("SELECT COUNT(*) n, SUM(CASE WHEN delivered>=? THEN 1 ELSE 0 END) sat FROM v5_ecosystems", (ECOSYSTEM_CAP,)).fetchone()
        changes = [dict(r) for r in c.execute("SELECT domain,facet,old,new,at,pushed FROM v5_changes ORDER BY id DESC LIMIT 30").fetchall()]
    for cy in cycles:
        cy["result"] = json.loads(cy["result"] or "{}")
    return {"cycles": cycles, "sources": sources, "ecosystems": {"known": eco["n"], "saturated": eco["sat"] or 0},
            "recent_changes": changes, "budget_today": budget_left()}
