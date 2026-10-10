"""Bounded, replayable investigation frontier over public observations.

Discovery provenance is stored separately from campaign relationships. A
passive pivot's output is only a lead: the ordinary probe and eligibility gate
must validate it before it can enter the review queue.
"""
from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

from app.config import USER_AGENT
from app.v2 import domains, intelligence, netio, store, strategies

MAX_DEPTH = 3
MAX_ACTIONS_PER_ROUND = 1
MAX_LEADS_PER_ACTION = 8
MAX_NEW_LEADS_PER_ROUND = 8
MAX_OPEN = 120
_ready = set()

SCHEMA = """
CREATE TABLE IF NOT EXISTS ig_paths (
 id INTEGER PRIMARY KEY, seed TEXT NOT NULL, campaign_id TEXT,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, state TEXT NOT NULL,
 used INTEGER NOT NULL DEFAULT 0, budget INTEGER NOT NULL DEFAULT 4);
CREATE INDEX IF NOT EXISTS ig_paths_seed ON ig_paths(seed,updated_at DESC);
CREATE TABLE IF NOT EXISTS ig_frontier (
 id INTEGER PRIMARY KEY, path_id INTEGER NOT NULL, parent_id INTEGER,
 kind TEXT NOT NULL, target TEXT NOT NULL, seed TEXT NOT NULL, campaign_id TEXT,
 reason TEXT NOT NULL, evidence TEXT NOT NULL, factors TEXT NOT NULL,
 expected REAL NOT NULL, cost REAL NOT NULL, depth INTEGER NOT NULL,
 budget INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'NEW',
 created_at REAL NOT NULL, expires_at REAL NOT NULL, updated_at REAL NOT NULL,
 UNIQUE(kind,target), FOREIGN KEY(path_id) REFERENCES ig_paths(id));
CREATE INDEX IF NOT EXISTS ig_frontier_ready ON ig_frontier(state,expected DESC,created_at);
CREATE TABLE IF NOT EXISTS ig_action_results (
 id INTEGER PRIMARY KEY, frontier_id INTEGER NOT NULL, discovered TEXT,
 source TEXT NOT NULL, observation TEXT NOT NULL, status TEXT NOT NULL,
 at REAL NOT NULL, FOREIGN KEY(frontier_id) REFERENCES ig_frontier(id));
CREATE INDEX IF NOT EXISTS ig_results_domain ON ig_action_results(discovered);
CREATE TABLE IF NOT EXISTS ig_hypotheses (
 id INTEGER PRIMARY KEY, campaign_id TEXT, claim TEXT NOT NULL,
 state TEXT NOT NULL, support TEXT NOT NULL, contradiction TEXT NOT NULL,
 created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ig_negative (
 id INTEGER PRIMARY KEY, left_domain TEXT NOT NULL, right_domain TEXT NOT NULL,
 kind TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL,
 observed_at REAL NOT NULL, UNIQUE(left_domain,right_domain,kind,value));
CREATE TABLE IF NOT EXISTS ig_technique_stats (
 kind TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
 discovered INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
 useful INTEGER NOT NULL DEFAULT 0, unique_campaigns INTEGER NOT NULL DEFAULT 0,
 duplicates INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
 latency REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
 last_attempt REAL);
CREATE TABLE IF NOT EXISTS ig_source_health (
 source TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
 success INTEGER NOT NULL DEFAULT 0, results INTEGER NOT NULL DEFAULT 0,
 unique_domains INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, latency REAL NOT NULL DEFAULT 0,
 last_success REAL, last_error TEXT, status TEXT NOT NULL DEFAULT 'untried');
"""


def ensure():
    intelligence.ensure()
    key = str(store.db.DB_PATH)
    if key not in _ready:
        with store.conn() as conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(2,?)", (time.time(),))
        _ready.add(key)


def _stats(kind):
    with store.conn() as conn:
        row = conn.execute("SELECT * FROM ig_technique_stats WHERE kind=?", (kind,)).fetchone()
    return dict(row) if row else {}


def _value(kind, quality, novelty, specificity):
    s = _stats(kind)
    # Shrunk reward: a few useful votes cannot monopolize the frontier.
    rate = (2 + s.get("useful", 0)) / (6 + s.get("eligible", 0) + s.get("failures", 0))
    return round(min(.95, .38 * quality + .24 * novelty + .22 * specificity + .16 * rate), 4)


def plan(candidate, parent_id=None, path_id=None, depth=0, manual=False, requested_kind=None):
    """Create at most three distinct actions using evidence actually observed."""
    ensure()
    domain = domains.registrable(candidate.get("domain", ""))
    if not domain or depth >= MAX_DEPTH:
        return []
    quality = float(candidate.get("p") or 0)
    if quality < .65 and not manual and candidate.get("status") != "useful":
        return []
    facts = intelligence._facts(candidate)
    options = [("ct_domain", domain, .7, f"Search certificate names observed for {domain}",
                [{"kind": "domain", "value": domain, "source_url": candidate.get("url") or f"https://{domain}/"}])]
    if requested_kind == "revisit":
        with store.conn() as conn:
            change = conn.execute("SELECT kind,evidence FROM ig_events WHERE domain=? ORDER BY observed_at DESC LIMIT 1",
                                  (domain,)).fetchone()
        if change:
            options.append(("revisit", domain, .6, f"Recheck {domain} after observed {change['kind']}",
                            [{"kind": change["kind"], "value": change["evidence"],
                              "source_url": candidate.get("url") or f"https://{domain}/"}]))
    for kind, value, source, source_url, klass in facts:
        if kind in ("wallet", "analytics", "email", "phone", "favicon", "favtmpl", "service", "san", "template", "ip", "nameserver"):
            if kind in ("ip", "nameserver") and not netio.PASSIVE_DNS_URL:
                continue
            if kind == "nameserver" and any(token in value for token in
                                             ("cloudflare", "domaincontrol", "registrar-servers", "awsdns")):
                continue
            if kind in ("ip", "nameserver"):
                action = "passive_ip" if kind == "ip" else "passive_ns"
            else:
                action = "known_indicator"
            with store.conn() as conn:
                degree = conn.execute("SELECT COUNT(DISTINCT e.domain) n FROM ig_evidence e "
                                      "JOIN ig_entities i ON i.id=e.entity_id WHERE i.kind=? AND i.value=?",
                                      (kind, value)).fetchone()["n"]
            if degree > intelligence.DEGREE_LIMIT.get(kind, 12):
                continue
            specificity = min(.9, intelligence.WEIGHTS.get(kind, .1)) / max(1, degree ** .5)
            options.append((action, f"{kind}:{value}", specificity,
                            f"Follow observed {kind} from {domain}; {degree} known site(s) share it",
                            [{"kind": kind, "value": value, "source": source,
                              "source_url": source_url, "evidence_class": klass}]))
    options.sort(key=lambda x: -x[2])
    if requested_kind:
        requested_kind = str(requested_kind).lower()
        options = [option for option in options if option[0] == requested_kind or
                   option[1].split(':', 1)[0] == requested_kind]
    selected = options[:3]
    if not requested_kind and all(option[0] != "ct_domain" for option in selected):
        # Reserve one independent public-source route instead of filling every
        # action with correlated local fingerprints from the same page.
        selected[-1:] = [next(option for option in options if option[0] == "ct_domain")]
    now = time.time()
    with store.conn() as conn:
        if path_id is None:
            existing = conn.execute("SELECT id FROM ig_paths WHERE seed=? AND state='ACTIVE' "
                                    "ORDER BY id DESC LIMIT 1", (domain,)).fetchone()
            if existing:
                path_id = existing["id"]
            else:
                campaign = intelligence.campaign_for(domain)
                path_id = conn.execute("INSERT INTO ig_paths(seed,campaign_id,created_at,updated_at,state) "
                                       "VALUES(?,?,?,?,?)", (domain, campaign, now, now, "ACTIVE")).lastrowid
        path = conn.execute("SELECT used,budget,state FROM ig_paths WHERE id=?", (path_id,)).fetchone()
        if not path or path["state"] != "ACTIVE" or path["used"] >= path["budget"]:
            return []
        campaign = intelligence.campaign_for(domain)
        created = []
        for kind, target, specificity, reason, evidence in selected:
            if conn.execute("SELECT COUNT(*) n FROM ig_frontier WHERE state IN ('NEW','QUEUED','RUNNING')").fetchone()["n"] >= MAX_OPEN:
                break
            expectation = _value(kind, quality, 1 if not store.exists(target) else .6, specificity)
            prior = conn.execute("SELECT id FROM ig_frontier WHERE kind=? AND target=?", (kind, target)).fetchone()
            if prior:
                continue
            factors = {"information_gain": round(specificity, 3), "novelty": .6,
                       "expected_yield": min(MAX_LEADS_PER_ACTION, 2),
                       "duplicate_risk": round(1-specificity, 3), "noise_risk": round(1-specificity, 3),
                       "relationship_strength": intelligence.WEIGHTS.get(evidence[0]["kind"], 0),
                       "cost": 1, "expansion_budget": MAX_LEADS_PER_ACTION}
            cursor = conn.execute("INSERT OR IGNORE INTO ig_frontier(path_id,parent_id,kind,target,seed,campaign_id,"
                                  "reason,evidence,factors,expected,cost,depth,budget,state,created_at,expires_at,updated_at) "
                                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                  (path_id, parent_id, kind, target, domain, campaign, reason,
                                   json.dumps(evidence), json.dumps(factors), expectation, 1, depth,
                                   MAX_LEADS_PER_ACTION, "NEW", now, now+7*86400, now))
            if cursor.rowcount:
                created.append(cursor.lastrowid)
        return created


def list_frontier(limit=25, state=None):
    ensure()
    with store.conn() as conn:
        rows = conn.execute("SELECT * FROM ig_frontier WHERE (? IS NULL OR state=?) "
                            "ORDER BY CASE state WHEN 'RUNNING' THEN 0 WHEN 'NEW' THEN 1 ELSE 2 END,"
                            " expected DESC,id DESC LIMIT ?", (state, state, max(1, min(int(limit), 100)))).fetchall()
    return [{**dict(row), "evidence": json.loads(row["evidence"]),
             "factors": json.loads(row["factors"])} for row in rows]


def path_detail(path_id):
    ensure()
    with store.conn() as conn:
        path = conn.execute("SELECT * FROM ig_paths WHERE id=?", (path_id,)).fetchone()
        if not path:
            raise KeyError(path_id)
        actions = conn.execute("SELECT * FROM ig_frontier WHERE path_id=? ORDER BY id LIMIT 60", (path_id,)).fetchall()
        results = conn.execute("SELECT * FROM ig_action_results WHERE frontier_id IN "
                               "(SELECT id FROM ig_frontier WHERE path_id=?) ORDER BY id LIMIT 120", (path_id,)).fetchall()
    return {"path": dict(path), "actions": [dict(x) for x in actions], "results": [dict(x) for x in results]}


def control(path_id, action):
    if action not in ("PAUSED", "STOPPED", "ACTIVE"):
        raise ValueError("unsupported path state")
    ensure()
    with store.conn() as conn:
        row = conn.execute("UPDATE ig_paths SET state=?,updated_at=? WHERE id=?", (action, time.time(), path_id))
    if not row.rowcount:
        raise KeyError(path_id)
    return {"ok": True, "state": action}


def investigate(domain, kind=None):
    ensure()
    domain = domains.registrable(domain)
    candidate = store.get(domain) if domain else None
    if not candidate:
        raise KeyError(domain)
    if kind not in (None, "ct_domain", "revisit", "wallet", "ip", "nameserver", "template", "favicon", "analytics", "email", "phone"):
        raise ValueError("unsupported investigation method")
    return {"ok": True, "actions": plan(candidate, manual=True, requested_kind=kind)}


def _ct(domain):
    """Public CT lookup with failure classification; no hidden empty-on-error."""
    import requests
    started = time.monotonic()
    try:
        with requests.get("https://crt.sh/", params={"q": domain, "output": "json"},
                          headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                          timeout=12, stream=True) as response:
            if response.status_code != 200:
                return [], "rate_limited" if response.status_code == 429 else f"http_{response.status_code}", time.monotonic()-started
            raw = response.raw.read(2_000_001, decode_content=True)
        if len(raw) > 2_000_000:
            return [], "oversized_response", time.monotonic()-started
        if not raw.strip():
            return [], "empty", time.monotonic()-started
        data = json.loads(raw)
        if not isinstance(data, list):
            return [], "parsing_failure", time.monotonic()-started
        return data[:300], "healthy" if data else "empty", time.monotonic()-started
    except requests.exceptions.RequestException as exc:
        status = netio._classify_exception(exc)
        return [], "dns_failure" if status == "dns" else "blocked" if status == "refused" else status, time.monotonic()-started
    except (ValueError, TypeError):
        return [], "parsing_failure", time.monotonic()-started


def _observe_source(conn, source, status, raw_count, unique_count, elapsed):
    failure = status not in ("healthy", "empty")
    conn.execute("INSERT INTO ig_source_health(source,attempts,success,results,unique_domains,failures,latency,"
                 "last_success,last_error,status) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET "
                 "attempts=attempts+1,success=success+excluded.success,results=results+excluded.results,"
                 "unique_domains=unique_domains+excluded.unique_domains,failures=failures+excluded.failures,"
                 "latency=latency+excluded.latency,last_success=COALESCE(excluded.last_success,last_success),"
                 "last_error=excluded.last_error,status=excluded.status",
                 (source, 1, int(not failure), raw_count, unique_count, int(failure), elapsed,
                  time.time() if status == "healthy" else None, status if failure else None, status))


def execute(budget, round_no, max_actions=MAX_ACTIONS_PER_ROUND):
    """Lease bounded work and return leads to the normal probe and review gates."""
    ensure()
    now = time.time()
    leads = []
    for _ in range(max(0, min(max_actions, 2))):
        with store.conn() as conn:
            stale = conn.execute("SELECT path_id FROM ig_frontier WHERE state='RUNNING' AND updated_at<?", (now-120,)).fetchall()
            conn.execute("UPDATE ig_frontier SET state='NEW' WHERE state='RUNNING' AND updated_at<?", (now-120,))
            for abandoned in stale:
                conn.execute("UPDATE ig_paths SET used=MAX(0,used-1) WHERE id=?", (abandoned["path_id"],))
            conn.execute("UPDATE ig_frontier SET state='EXPIRED' WHERE state IN ('NEW','QUEUED') AND expires_at<?", (now,))
            degraded = conn.execute("SELECT h.status,t.last_attempt FROM ig_source_health h "
                                    "JOIN ig_technique_stats t ON t.kind='ct_domain' WHERE h.source='crtsh'").fetchone()
            skip_ct = bool(degraded and degraded["status"] not in ("healthy", "empty") and
                           degraded["last_attempt"] and now - degraded["last_attempt"] < 300)
            row = conn.execute("SELECT f.* FROM ig_frontier f JOIN ig_paths p ON p.id=f.path_id "
                               "WHERE f.state IN ('NEW','QUEUED') AND p.state='ACTIVE' AND p.used<p.budget "
                               "AND (?=0 OR f.kind!='ct_domain') "
                               "ORDER BY f.expected DESC,f.created_at ASC LIMIT 1", (int(skip_ct),)).fetchone()
            if not row:
                break
            item = dict(row)
            if item["kind"] == "ct_domain" and not budget.take("crtsh"):
                break
            conn.execute("UPDATE ig_frontier SET state='RUNNING',updated_at=? WHERE id=?", (now, item["id"]))
            conn.execute("UPDATE ig_paths SET used=used+1,updated_at=? WHERE id=?", (now, item["path_id"]))
        source = {"ct_domain": "crtsh", "passive_ip": "passive_dns", "passive_ns": "passive_dns",
                  "known_indicator": "local_graph", "revisit": "local_recheck"}.get(item["kind"], "unsupported")
        raw = []
        status = "healthy"
        start = time.monotonic()
        if item["kind"] == "ct_domain":
            entries, status, elapsed = _ct(item["target"])
            raw = [h for entry in entries for h in strategies._names_from_cert(entry)]
        elif item["kind"] in ("passive_ip", "passive_ns"):
            kind, value = item["target"].split(":", 1)
            if not netio.PASSIVE_DNS_URL:
                status = "blocked"
            else:
                raw = netio.passive_dns("ip" if kind == "ip" else "ns", value) or []
                status = "healthy" if raw else "empty"
            elapsed = time.monotonic()-start
        elif item["kind"] == "known_indicator":
            kind, value = item["target"].split(":", 1)
            with store.conn() as conn:
                rows = conn.execute("SELECT e.domain FROM ig_evidence e JOIN ig_entities i ON i.id=e.entity_id "
                                    "WHERE i.kind=? AND i.value=? GROUP BY e.domain LIMIT 35", (kind, value)).fetchall()
            raw = [r["domain"] for r in rows]
            status = "healthy" if raw else "empty"
            elapsed = time.monotonic()-start
        elif item["kind"] == "revisit":
            raw = [item["seed"]]
            elapsed = time.monotonic()-start
        else:
            status = "unsupported"
            elapsed = time.monotonic()-start
        unique = sorted({domains.registrable(host) for host in raw if domains.registrable(host)
                         and not domains.is_allowlisted(host)} - {item["seed"]})
        if item["kind"] == "revisit":
            unique = [item["seed"]]
        # High-cardinality source is a discovery dead end; it cannot bind campaigns.
        if item["kind"] in ("passive_ip", "passive_ns") and len(unique) > 40:
            status, unique = "generic_infrastructure", []
        selected = unique[:min(MAX_LEADS_PER_ACTION, item["budget"], MAX_NEW_LEADS_PER_ROUND-len(leads))]
        with store.conn() as conn:
            _observe_source(conn, source, status, len(raw), len(unique), elapsed)
            old = sum(bool(store.exists(d)) for d in selected)
            conn.execute("INSERT INTO ig_technique_stats(kind,attempts,discovered,duplicates,failures,latency,cost,last_attempt) "
                         "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET attempts=attempts+1,"
                         "discovered=discovered+excluded.discovered,duplicates=duplicates+excluded.duplicates,"
                         "failures=failures+excluded.failures,latency=latency+excluded.latency,cost=cost+1,"
                         "last_attempt=excluded.last_attempt",
                         (item["kind"], 1, len(selected)-old, old, int(status not in ("healthy","empty")), elapsed, 1, time.time()))
            for domain in selected:
                conn.execute("INSERT INTO ig_action_results(frontier_id,discovered,source,observation,status,at) "
                             "VALUES(?,?,?,?,?,?)", (item["id"], domain, source,
                             json.dumps({"target": item["target"], "method": item["kind"],
                                         "seed": item["seed"], "evidence": json.loads(item["evidence"]),
                                         "raw_results": len(raw)}), "duplicate" if store.exists(domain) else "discovered", time.time()))
            conn.execute("UPDATE ig_frontier SET state=?,updated_at=? WHERE id=?",
                         ("FAILED" if status not in ("healthy","empty") else "COMPLETED", time.time(), item["id"]))
            usage = conn.execute("SELECT used,budget FROM ig_paths WHERE id=?", (item["path_id"],)).fetchone()
            if usage["used"] >= usage["budget"]:
                conn.execute("UPDATE ig_paths SET state='COMPLETED',updated_at=? WHERE id=?",
                             (time.time(), item["path_id"]))
                conn.execute("UPDATE ig_frontier SET state='SUPPRESSED',updated_at=? "
                             "WHERE path_id=? AND state IN ('NEW','QUEUED')", (time.time(), item["path_id"]))
        from app.v2 import operations
        operations.record_target(item["kind"], item["target"], selected, old, status)
        for domain in selected:
            leads.append(strategies.Lead(domain, "investigation_pivot",
                            f"path {item['path_id']} action {item['id']} via {source}: {item['target'][:90]}",
                            min(.65, .25 + item["expected"]*.3), "investigation_pivot"))
    return leads


def note_probe(domain, eligible):
    ensure()
    with store.conn() as conn:
        rows = conn.execute("SELECT DISTINCT f.kind,f.id frontier_id,f.path_id,f.depth,r.source,r.id FROM ig_action_results r JOIN ig_frontier f ON f.id=r.frontier_id "
                            "WHERE r.discovered=? AND r.status='discovered'", (domain,)).fetchall()
        parent = None
        for row in rows:
            conn.execute("UPDATE ig_action_results SET status=? WHERE id=?", ("eligible" if eligible else "gated", row["id"]))
            if eligible:
                conn.execute("UPDATE ig_technique_stats SET eligible=eligible+1 WHERE kind=?", (row["kind"],))
                conn.execute("UPDATE ig_source_health SET eligible=eligible+1 WHERE source=?", (row["source"],))
                if parent is None:
                    parent = {"id": row["frontier_id"], "path_id": row["path_id"], "depth": row["depth"]}
        return parent


def context_for(domain):
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT r.source,r.observation,f.kind,f.depth,f.path_id FROM ig_action_results r "
                           "JOIN ig_frontier f ON f.id=r.frontier_id WHERE r.discovered=? "
                           "AND r.status IN ('eligible','discovered','useful') ORDER BY f.depth DESC,r.id DESC LIMIT 1",
                           (domain,)).fetchone()
    if not row:
        return None
    observation = json.loads(row["observation"])
    return {"source": row["source"], "method": row["kind"], "depth": row["depth"]+1,
            "path_id": row["path_id"], "seed": observation["seed"],
            "target": observation["target"], "provenance": observation["evidence"]}


def note_decision(domain, useful):
    ensure()
    with store.conn() as conn:
        rows = conn.execute("SELECT DISTINCT f.kind,r.frontier_id FROM ig_action_results r "
                            "JOIN ig_frontier f ON f.id=r.frontier_id WHERE r.discovered=? AND r.status='eligible'", (domain,)).fetchall()
        for row in rows:
            campaign = intelligence.campaign_for(domain) if useful else None
            previously_useful = bool(campaign and conn.execute(
                "SELECT 1 FROM ig_action_results r JOIN ig_frontier f ON f.id=r.frontier_id "
                "JOIN ig_members m ON m.domain=r.discovered WHERE m.campaign_id=? AND r.status='useful' LIMIT 1",
                (campaign,)).fetchone())
            conn.execute("UPDATE ig_action_results SET status=? WHERE discovered=? AND frontier_id=?",
                         ("useful" if useful else "skipped", domain, row["frontier_id"]))
            if useful:
                conn.execute("UPDATE ig_technique_stats SET useful=useful+1,unique_campaigns=unique_campaigns+? "
                             "WHERE kind=?", (int(bool(campaign) and not previously_useful), row["kind"]))


def source_report():
    ensure()
    with store.conn() as conn:
        return {"sources": [dict(row) for row in conn.execute("SELECT * FROM ig_source_health ORDER BY attempts DESC")],
                "techniques": [dict(row) for row in conn.execute("SELECT * FROM ig_technique_stats ORDER BY attempts DESC")],
                "frontier": {row["state"]: row["n"] for row in conn.execute(
                    "SELECT state,COUNT(*) n FROM ig_frontier GROUP BY state")}}


def record_round_sources(report, new_domains=0, eligible=0):
    """Persist coarse source health without treating every NXDOMAIN as failure."""
    ensure()
    ct = report.get("crtsh") or {}
    dns = report.get("dns") or {}
    with store.conn() as conn:
        if ct.get("attempts"):
            status = ("degraded" if ct.get("failures") and ct.get("success") else
                      ct.get("status") if ct.get("failures") else
                      "healthy" if ct.get("raw_results") else "empty")
            conn.execute("INSERT INTO ig_source_health(source,attempts,success,results,unique_domains,eligible,"
                         "failures,latency,last_success,last_error,status) VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(source) DO UPDATE SET attempts=attempts+excluded.attempts,"
                         "success=success+excluded.success,results=results+excluded.results,"
                         "unique_domains=unique_domains+excluded.unique_domains,"
                         "eligible=eligible+excluded.eligible,failures=failures+excluded.failures,"
                         "latency=latency+excluded.latency,last_success=COALESCE(excluded.last_success,last_success),"
                         "last_error=excluded.last_error,status=excluded.status",
                         ("crtsh_discovery", ct["attempts"], ct.get("success", 0), ct.get("raw_results", 0),
                          new_domains, eligible, ct.get("failures", 0), ct.get("latency", 0),
                          time.time() if ct.get("raw_results") else None,
                          status if ct.get("failures") else None, status))
        if dns.get("attempts"):
            conn.execute("INSERT INTO ig_source_health(source,attempts,success,results,unique_domains,eligible,"
                         "failures,latency,last_success,last_error,status) VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(source) DO UPDATE SET attempts=attempts+excluded.attempts,"
                         "success=success+excluded.success,last_success=COALESCE(excluded.last_success,last_success),"
                         "status=excluded.status",
                         ("dns_resolution", dns["attempts"], dns.get("resolved", 0), dns.get("resolved", 0),
                          0, 0, 0, 0, time.time() if dns.get("resolved") else None, None,
                          "healthy" if dns.get("resolved") else "unresolved"))


def pause_campaign(campaign_id):
    """Stop scheduling active paths for an observed campaign without deleting history."""
    ensure()
    with store.conn() as conn:
        known = conn.execute("SELECT 1 FROM ig_campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not known:
            raise KeyError(campaign_id)
        ids = [row["id"] for row in conn.execute(
            "SELECT id FROM ig_paths WHERE campaign_id=? AND state='ACTIVE' LIMIT 100", (campaign_id,))]
    for path_id in ids:
        control(path_id, "PAUSED")
    return {"campaign_id": campaign_id, "paused_paths": len(ids)}


def hypothesis(left, right):
    """Test one relationship against stored support and explicit contradictions."""
    ensure()
    left, right = domains.registrable(left), domains.registrable(right)
    if left and right:
        left, right = sorted((left, right))
    if not left or not right or left == right or not store.get(left) or not store.get(right):
        raise ValueError("two distinct observed domains required")
    claim = f"{left} and {right} may share an operation"
    with store.conn() as conn:
        link = conn.execute("SELECT * FROM ig_relationships WHERE left_domain=? AND right_domain=?",
                            (left, right)).fetchone()
        negatives = [dict(row) for row in conn.execute(
            "SELECT kind,value,evidence,observed_at FROM ig_negative WHERE left_domain=? AND right_domain=?",
            (left, right))]
        excluded = conn.execute("SELECT reason FROM ig_exclusions WHERE left_domain=? AND right_domain=?",
                                (left, right)).fetchone()
        if excluded:
            state = "REJECTED"
        elif not link:
            state = "WEAKENED" if negatives else "INCONCLUSIVE"
        else:
            state = "WEAKENED" if negatives else "SUPPORTED"
        support = json.loads(link["evidence"]) if link else {}
        campaign = intelligence.campaign_for(left)
        now = time.time()
        old = conn.execute("SELECT id FROM ig_hypotheses WHERE claim=?", (claim,)).fetchone()
        if old:
            conn.execute("UPDATE ig_hypotheses SET campaign_id=?,state=?,support=?,contradiction=?,updated_at=? WHERE id=?",
                         (campaign, state, json.dumps(support), json.dumps(negatives), now, old["id"]))
            ident = old["id"]
        else:
            ident = conn.execute("INSERT INTO ig_hypotheses(campaign_id,claim,state,support,contradiction,created_at,updated_at) "
                                 "VALUES(?,?,?,?,?,?,?)",
                                 (campaign, claim, state, json.dumps(support), json.dumps(negatives), now, now)).lastrowid
    return {"id": ident, "claim": claim, "state": state, "campaign_id": campaign,
            "support": support, "contradictions": negatives,
            "next_evidence": "Look for an independent wallet, contact, or certificate observation" if state != "REJECTED" else None}
