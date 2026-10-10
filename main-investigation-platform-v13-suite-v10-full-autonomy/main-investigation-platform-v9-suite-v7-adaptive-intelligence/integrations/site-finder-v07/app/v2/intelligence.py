"""Persistent, evidence-backed public investigation graph.

Campaigns are hypotheses about related infrastructure, never identity claims.
All graph reads are bounded. No external lookup is performed by this module.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict
from urllib.parse import urlsplit, urlunsplit

from app.v2 import store

SCHEMA_VERSION = 1
SCHEMA = """
CREATE TABLE IF NOT EXISTS ig_schema(version INTEGER PRIMARY KEY, applied_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ig_entities(
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL,
 first_seen REAL NOT NULL, last_seen REAL NOT NULL, UNIQUE(kind,value));
CREATE TABLE IF NOT EXISTS ig_evidence(
 id INTEGER PRIMARY KEY, domain TEXT NOT NULL, entity_id INTEGER NOT NULL,
 source TEXT NOT NULL, source_url TEXT NOT NULL, evidence_class TEXT NOT NULL,
 strength REAL NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
 UNIQUE(domain,entity_id,source,source_url), FOREIGN KEY(entity_id) REFERENCES ig_entities(id));
CREATE INDEX IF NOT EXISTS ig_evidence_entity ON ig_evidence(entity_id,domain);
CREATE INDEX IF NOT EXISTS ig_evidence_domain ON ig_evidence(domain,entity_id);
CREATE TABLE IF NOT EXISTS ig_dirty(entity_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ig_relationships(
 left_domain TEXT NOT NULL, right_domain TEXT NOT NULL, confidence REAL NOT NULL,
 independent_categories INTEGER NOT NULL, evidence TEXT NOT NULL,
 first_seen REAL NOT NULL, last_seen REAL NOT NULL,
 PRIMARY KEY(left_domain,right_domain));
CREATE INDEX IF NOT EXISTS ig_relationships_right ON ig_relationships(right_domain);
CREATE TABLE IF NOT EXISTS ig_campaigns(
 id TEXT PRIMARY KEY, status TEXT NOT NULL, confidence REAL NOT NULL,
 first_seen REAL NOT NULL, last_seen REAL NOT NULL, updated_at REAL NOT NULL,
 label TEXT, notes TEXT DEFAULT '', tags TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS ig_members(
 campaign_id TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, joined_at REAL NOT NULL,
 PRIMARY KEY(campaign_id,domain));
CREATE INDEX IF NOT EXISTS ig_members_campaign ON ig_members(campaign_id);
CREATE TABLE IF NOT EXISTS ig_exclusions(
 left_domain TEXT NOT NULL, right_domain TEXT NOT NULL, reason TEXT NOT NULL,
 created_at REAL NOT NULL, PRIMARY KEY(left_domain,right_domain));
CREATE TABLE IF NOT EXISTS ig_manual_links(
 left_domain TEXT NOT NULL, right_domain TEXT NOT NULL, reason TEXT NOT NULL,
 source_url TEXT NOT NULL, created_at REAL NOT NULL,
 PRIMARY KEY(left_domain,right_domain));
CREATE TABLE IF NOT EXISTS ig_events(
 id INTEGER PRIMARY KEY, domain TEXT NOT NULL, campaign_id TEXT,
 kind TEXT NOT NULL, old_value TEXT, new_value TEXT, evidence TEXT NOT NULL,
 observed_at REAL NOT NULL, UNIQUE(domain,kind,old_value,new_value));
CREATE INDEX IF NOT EXISTS ig_events_domain ON ig_events(domain,observed_at DESC);
CREATE TABLE IF NOT EXISTS ig_snapshots(
 domain TEXT PRIMARY KEY, observed TEXT NOT NULL, state TEXT NOT NULL,
 first_seen REAL NOT NULL, last_seen REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ig_actions(
 id INTEGER PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL,
 target TEXT NOT NULL, campaign_id TEXT, value REAL NOT NULL,
 factors TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'suggested',
 created_at REAL NOT NULL, UNIQUE(domain,kind,target));
CREATE INDEX IF NOT EXISTS ig_actions_value ON ig_actions(state,value DESC);
CREATE TABLE IF NOT EXISTS ig_pivots(
 indicator_kind TEXT NOT NULL, indicator_value TEXT NOT NULL,
 attempted INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0,
 rejected INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
 updated_at REAL NOT NULL, PRIMARY KEY(indicator_kind,indicator_value));
CREATE TABLE IF NOT EXISTS ig_reviews(
 id INTEGER PRIMARY KEY, campaign_id TEXT NOT NULL, decision TEXT NOT NULL,
 detail TEXT, recorded_at REAL NOT NULL);
"""

# A popular wallet, favicon, or service loses specificity. Shared hosting and
# generic templates remain visible in the graph but never create campaigns.
WEIGHTS = {"wallet": .90, "service": .77, "san": .68, "favtmpl": .62,
           "favicon": .45, "email": .75, "phone": .75, "analytics": .65,
           "template": .18, "ip": .10, "nameserver": .07,
           "asn": .04, "hosting": .04, "javascript": .08, "source": .02,
           "page": .03, "certificate": .55, "certificate_fingerprint": .68,
           "tracking": .55, "js_bundle": .12, "visual": .18,
           "social": .60, "company": .12, "brand": .12,
           "crypto_network": .02, "deposit_page": .25, "payment_provider": .4,
           "redirect": .14, "referral": .3, "registration": .06}
KIT_LEVEL = {"favicon", "favtmpl", "template", "js_bundle", "visual", "page", "deposit_page", "crypto_network",
             "source", "redirect", "registration", "ip", "nameserver", "asn", "hosting", "brand", "company",
             "javascript", "certificate"}
DEGREE_LIMIT = {"wallet": 30, "service": 20, "san": 15, "favtmpl": 15,
                "favicon": 10, "email": 15, "phone": 15, "analytics": 12,
                "certificate_fingerprint": 15, "tracking": 12, "social": 12}
MAX_EVIDENCE_PER_DOMAIN = 50
MAX_NEIGHBORS = 40
MAX_CAMPAIGN_SIZE = 80
_ready = set()
_feedback_cache = {}


def ensure():
    store.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as conn:
        conn.executescript(SCHEMA)
        previous = conn.execute("SELECT version FROM ig_schema WHERE version=?", (SCHEMA_VERSION,)).fetchone()
        conn.execute("INSERT OR IGNORE INTO ig_schema(version,applied_at) VALUES(?,?)",
                     (SCHEMA_VERSION, time.time()))
    _ready.add(key)
    if not previous:
        backfill()


def _facts(candidate, conn=None):
    details = candidate.get("details") or {}
    url = candidate.get("url") or f"https://{candidate['domain']}/"
    facts = []

    def add(kind, value, source="public_probe", source_url=url, evidence_class="observed"):
        if kind not in WEIGHTS or not value:
            return
        value = str(value).strip().lower()[:300]
        if value and value not in ("none", "unknown"):
            facts.append((kind, value, source, str(source_url)[:500], evidence_class))

    keys = ([(r["key_type"], r["key_value"]) for r in conn.execute(
        "SELECT key_type,key_value FROM v2_keys WHERE domain=?", (candidate["domain"],))]
        if conn else store.keys_for(candidate["domain"]))
    for kind, value in keys:
        add("template" if kind == "tmpl" else kind, value, "v2_key")
    for kind, value in details.get("keys", []):
        add("template" if kind == "tmpl" else kind, value, "probe_key")
    try:
        parsed = urlsplit(url)
        safe_page = parsed.scheme in ("http", "https") and parsed.hostname
    except ValueError:
        safe_page = False
    if safe_page:
        clean_url = urlunsplit((parsed.scheme, parsed.hostname, parsed.path or "/", "", ""))
        add("page", clean_url, "public_probe", clean_url)
        if any(part in (parsed.path or "").lower() for part in ("deposit", "recharge", "payment")):
            add("deposit_page", clean_url, "public_probe", clean_url)
    add("redirect", details.get("redirected_to"))
    for key, kind in (("asn", "asn"), ("hosting_provider", "hosting"),
                      ("certificate_fingerprint", "certificate_fingerprint"),
                      ("analytics_id", "analytics"), ("visual_hash", "visual")):
        add(kind, details.get(key))
    add("ip", details.get("ip"))
    for ns in details.get("ns") or []:
        add("nameserver", ns)
    for signal in candidate.get("signals") or []:
        if signal.get("name") == "deposit_address":
            add("wallet", signal.get("detail"), "page_wallet", details.get("fetch", {}).get("final_url") or url)
            phrase = signal.get("phrase") or ""
            if "(" in phrase and phrase.endswith(")"):
                add("crypto_network", phrase.rsplit("(", 1)[-1][:-1], "page_wallet")
        elif signal.get("group") == "impersonation":
            from app.v2 import domains
            add("brand", domains.brand_lookalike(candidate["domain"]), "v2_signal", url, "derived")
    sightings = ([dict(r) for r in conn.execute(
        "SELECT strategy,host FROM v2_sightings WHERE domain=? LIMIT 20", (candidate["domain"],))]
        if conn else store.sightings(candidate["domain"])[:20])
    for sight in sightings:
        add("source", sight.get("strategy"), "discovery", sight.get("host") or url, "derived")
    # One fact/source pair is unique. Repeated identical signals do not add weight.
    return list(dict.fromkeys(facts))[:MAX_EVIDENCE_PER_DOMAIN]


def _event(conn, domain, kind, old, new, evidence, at):
    conn.execute("INSERT OR IGNORE INTO ig_events(domain,kind,old_value,new_value,evidence,observed_at) "
                 "VALUES(?,?,?,?,?,?)", (domain, kind, str(old or ""), str(new or ""), evidence, at))


def _snapshot(conn, candidate, at):
    domain = candidate["domain"]
    details = candidate.get("details") or {}
    observed = {
        "ip": details.get("ip") or "", "nameservers": sorted(details.get("ns") or []),
        "wallets": sorted({s.get("detail") for s in candidate.get("signals") or []
                            if s.get("name") == "deposit_address" and s.get("detail")}),
        "favicon": details.get("favicon") or "",
        "template": sorted(r["key_value"] for r in conn.execute(
            "SELECT key_value FROM v2_keys WHERE domain=? AND key_type='tmpl' LIMIT 5", (domain,))),
        "redirect": details.get("redirected_to") or "",
    }
    status = details.get("site_status") or ("new" if candidate.get("status") == "new" else
                                            "offline" if candidate.get("gate") == "dead" else "active")
    row = conn.execute("SELECT observed,state FROM ig_snapshots WHERE domain=?", (domain,)).fetchone()
    state_changed = bool(row and row["state"] != status)
    if row:
        previous = json.loads(row["observed"])
        for key, current in observed.items():
            earlier = previous.get(key)
            if current and current != earlier:
                # Avoid generating a change from absent evidence (unknown != changed).
                if isinstance(current, list):
                    added = set(current) - set(earlier if isinstance(earlier, list) else [])
                    if not added:
                        continue
                    for value in sorted(added)[:10]:
                        _event(conn, domain, "new_wallet" if key == "wallets" else f"new_{key}",
                               "", value, f"Observed {key} in public probe of {domain}", at)
                else:
                    _event(conn, domain, f"{key}_changed" if earlier else f"new_{key}", earlier, current,
                           f"Previous and current public observations for {domain}", at)
        if row["state"] in ("offline", "dormant") and status == "active":
            _event(conn, domain, "reactivated", row["state"], status,
                   f"Availability changed in public observation of {domain}", at)
        elif row["state"] == "active" and status == "offline":
            _event(conn, domain, "offline", row["state"], status,
                   f"Availability changed in public observation of {domain}", at)
        # Unknowns do not erase known facts.
        observed = {k: (v or previous.get(k)) for k, v in observed.items()}
    conn.execute("INSERT INTO ig_snapshots(domain,observed,state,first_seen,last_seen) VALUES(?,?,?,?,?) "
                 "ON CONFLICT(domain) DO UPDATE SET observed=excluded.observed,state=excluded.state,"
                 "last_seen=MAX(last_seen,excluded.last_seen)", (domain, json.dumps(observed), status,
                                                 candidate.get("first_seen") or at, at))
    return state_changed


def ingest(candidate, recompute=True, observed_at=None):
    """Idempotent ingestion of stored observations; safe for backfill/restart."""
    ensure()
    domain = candidate["domain"]
    at = float(observed_at or candidate.get("last_checked") or time.time())
    with store.conn() as conn:
        facts = _facts(candidate, conn)
        for kind, value, source, source_url, klass in facts:
            entity_id = conn.execute(
                "INSERT INTO ig_entities(kind,value,first_seen,last_seen) VALUES(?,?,?,?) "
                "ON CONFLICT(kind,value) DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen),"
                "last_seen=MAX(last_seen,excluded.last_seen) RETURNING id",
                (kind, value, at, at)).fetchone()["id"]
            added = conn.execute("INSERT OR IGNORE INTO ig_evidence(domain,entity_id,source,source_url,evidence_class,"
                                 "strength,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?)",
                                 (domain, entity_id, source, source_url, klass, WEIGHTS[kind], at, at))
            if added.rowcount:
                conn.execute("INSERT OR IGNORE INTO ig_dirty(entity_id) VALUES(?)", (entity_id,))
            else:
                conn.execute("UPDATE ig_evidence SET first_seen=MIN(first_seen,?),last_seen=MAX(last_seen,?) "
                             "WHERE domain=? AND entity_id=? AND source=? AND source_url=?",
                             (at, at, domain, entity_id, source, source_url))
        if _snapshot(conn, candidate, at):
            # Availability changes can alter campaign state without adding an entity.
            existing = conn.execute("SELECT entity_id FROM ig_evidence WHERE domain=? LIMIT 1", (domain,)).fetchone()
            if existing:
                conn.execute("INSERT OR IGNORE INTO ig_dirty(entity_id) VALUES(?)", (existing["entity_id"],))
    if recompute:
        rebuild()
    return {"domain": domain, "facts": len(facts)}


def mark_inactive(domain, state, observed_at=None):
    """Record an initial dead/parked probe without costly empty graph edges."""
    ensure()
    if state not in ("offline", "dormant"):
        raise ValueError("invalid inactive state")
    at = observed_at or time.time()
    with store.conn() as conn:
        conn.execute("INSERT OR IGNORE INTO ig_snapshots(domain,observed,state,first_seen,last_seen) "
                     "VALUES(?,?,?,?,?)", (domain, "{}", state, at, at))


def _pair(left, right):
    return tuple(sorted((left, right)))


def rebuild(force=False):
    """Recompute evidence-based links and campaign components, including splits.

    Bounded by the degree cap *before* pair generation. Existing campaign IDs
    survive where a component retains its previous members.
    """
    ensure()
    now = time.time()
    with store.conn() as conn:
        dirty = [r["entity_id"] for r in conn.execute("SELECT entity_id FROM ig_dirty LIMIT 40001")]
        if not force and not dirty:
            return {"campaigns": conn.execute("SELECT COUNT(*) n FROM ig_campaigns WHERE status IN ('active','dormant')").fetchone()["n"],
                    "relationships": conn.execute("SELECT COUNT(*) n FROM ig_relationships").fetchone()["n"],
                    "dirty_entities": 0}
        dirty_domains = {r["domain"] for r in conn.execute(
            "SELECT DISTINCT e.domain FROM ig_evidence e JOIN ig_dirty d ON d.entity_id=e.entity_id")}
        rows = conn.execute("SELECT e.id,e.kind,e.value,v.domain,v.source,v.source_url "
                            "FROM ig_entities e JOIN ig_evidence v ON v.entity_id=e.id "
                            "ORDER BY e.id,v.domain").fetchall()
        by_entity = defaultdict(list)
        for row in rows:
            by_entity[row["id"]].append(dict(row))
        pairs = defaultdict(lambda: defaultdict(list))
        for observations in by_entity.values():
            first = observations[0]
            kind = first["kind"]
            domains = sorted({o["domain"] for o in observations})
            if kind not in DEGREE_LIMIT or len(domains) < 2 or len(domains) > DEGREE_LIMIT[kind]:
                continue
            for i, a in enumerate(domains):
                for b in domains[i + 1:]:
                    if len(pairs) > 40000:
                        break
                    sources = {domain: [{"source": o["source"], "source_url": o["source_url"]}
                                        for o in observations if o["domain"] == domain][:3] for domain in (a, b)}
                    pairs[(a, b)][kind].append({"entity": first["value"], "entity_id": first["id"],
                                                 "observations": sources})
        exclusions = {_pair(r["left_domain"], r["right_domain"]) for r in
                      conn.execute("SELECT left_domain,right_domain FROM ig_exclusions")}
        contradiction = defaultdict(float)
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ig_negative'").fetchone():
            for row in conn.execute("SELECT left_domain,right_domain,kind FROM ig_negative"):
                contradiction[_pair(row["left_domain"], row["right_domain"])] += .13 if row["kind"] == "strong" else .07
        qualifying = {}
        for pair, categories in pairs.items():
            if pair in exclusions:
                continue
            # Multiple sightings of a single certificate remain one category.
            weights = sorted((WEIGHTS[k] for k in categories), reverse=True)
            confidence = max(0, min(.98, round(weights[0] + sum(weights[1:]) * .30 -
                                                min(.30, contradiction[pair]), 3)))
            independent = len(categories)
            # v3: a relationship needs OPERATOR-level evidence. Kit-level similarity (icon, layout,
            # template, bundles, hosting) is shared by unrelated operators who copy or buy the same kit,
            # so it can add confidence but never counts as independent evidence; and an icon plus
            # "icon and layout" is one observation, not two. A wallet links on its own; otherwise two
            # independent operator-level categories are required (a single shared support desk or
            # analytics account can be a vendor's).
            operator = {k for k in categories if k not in KIT_LEVEL}
            independent = len(operator)
            if confidence < .75 or not ("wallet" in operator or independent >= 2):
                continue
            qualifying[pair] = (confidence, independent, categories)
        for row in conn.execute("SELECT * FROM ig_manual_links"):
            pair = _pair(row["left_domain"], row["right_domain"])
            if pair not in exclusions:
                proof = {"analyst_review": [{"reason": row["reason"],
                                               "source_url": row["source_url"],
                                               "evidence_class": "human_annotation"}]}
                if pair in qualifying:
                    old_confidence, independent, categories = qualifying[pair]
                    qualifying[pair] = (max(old_confidence, .8), independent + 1, {**categories, **proof})
                else:
                    qualifying[pair] = (.8, 1, proof)
        old_members = defaultdict(set)
        for row in conn.execute("SELECT campaign_id,domain FROM ig_members"):
            old_members[row["campaign_id"]].add(row["domain"])
        previous_edges = {(r["left_domain"], r["right_domain"]): dict(r)
                          for r in conn.execute("SELECT * FROM ig_relationships")}
        removed = set(previous_edges) - set(qualifying)
        conn.executemany("DELETE FROM ig_relationships WHERE left_domain=? AND right_domain=?", sorted(removed))
        parent = {}
        sizes = {}

        def root(x):
            parent.setdefault(x, x)
            sizes.setdefault(x, 1)
            if parent[x] != x:
                parent[x] = root(parent[x])
            return parent[x]

        for (a, b), (confidence, independent, categories) in sorted(qualifying.items()):
            ra, rb = root(a), root(b)
            if ra != rb and sizes[ra] + sizes[rb] <= MAX_CAMPAIGN_SIZE:
                parent[max(ra, rb)] = min(ra, rb)
                sizes[min(ra, rb)] = sizes[ra] + sizes[rb]
            proof = json.dumps(categories, sort_keys=True)
            old = previous_edges.get((a, b))
            if not old or (old["confidence"], old["independent_categories"], old["evidence"]) != (confidence, independent, proof):
                conn.execute("INSERT INTO ig_relationships VALUES(?,?,?,?,?,?,?) "
                             "ON CONFLICT(left_domain,right_domain) DO UPDATE SET confidence=excluded.confidence,"
                             "independent_categories=excluded.independent_categories,evidence=excluded.evidence,"
                             "last_seen=excluded.last_seen",
                             (a, b, confidence, independent, proof, old["first_seen"] if old else now, now))
            if (a, b) not in previous_edges:
                _event(conn, a, "new_related_domain", "", b,
                       f"Independent recorded observations link {a} and {b}", now)
        groups = defaultdict(set)
        for domain in parent:
            groups[root(domain)].add(domain)
        assigned = set()
        assignments = {}
        for members in sorted(groups.values(), key=lambda m: (-len(m), sorted(m)[0])):
            overlaps = sorted(((len(members & prior), cid) for cid, prior in old_members.items()
                               if cid not in assigned), reverse=True)
            cid = overlaps[0][1] if overlaps and overlaps[0][0] else "campaign:" + hashlib.sha1(
                sorted(members)[0].encode()).hexdigest()[:12]
            assigned.add(cid)
            assignments[cid] = members
        changed = {cid for cid in set(old_members) | set(assignments)
                   if old_members.get(cid, set()) != assignments.get(cid, set())}
        conn.executemany("DELETE FROM ig_members WHERE campaign_id=?", [(cid,) for cid in sorted(changed)])
        for cid, members in assignments.items():
            confidence = min(qualifying[p][0] for p in qualifying if set(p) <= members)
            statuses = [r["state"] for r in conn.execute(
                "SELECT s.state FROM ig_snapshots s WHERE s.domain IN (" + ",".join("?" for _ in members) + ")",
                sorted(members))]
            state = "dormant" if len(statuses) == len(members) and all(s in ("offline", "dormant") for s in statuses) else "active"
            conn.execute("INSERT INTO ig_campaigns(id,status,confidence,first_seen,last_seen,updated_at) "
                         "VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,"
                         "confidence=excluded.confidence,last_seen=excluded.last_seen,updated_at=excluded.updated_at",
                         (cid, state, confidence, now, now, now))
            if cid in changed:
                conn.executemany("INSERT INTO ig_members(campaign_id,domain,joined_at) VALUES(?,?,?)",
                                 [(cid, domain, now) for domain in sorted(members)])
                added_members = members - old_members.get(cid, set())
                if old_members.get(cid) and added_members:
                    new_domain = sorted(added_members)[0]
                    evidence_pair = next((p for p in qualifying if new_domain in p and
                                          any(d in old_members[cid] for d in p)), None)
                    if evidence_pair:
                        _event(conn, new_domain, "campaign_expanding", str(len(old_members[cid])),
                               str(len(members)), f"Observed link to {cid}: " +
                               json.dumps(qualifying[evidence_pair][2])[:900], now)
            # A migration hypothesis requires at least two different members
            # with independently timestamped observed transitions. A lone IP
            # change (especially on shared hosting) never triggers this event.
            transitions = [dict(row) for row in conn.execute(
                "SELECT id,domain,kind,old_value,new_value,observed_at FROM ig_events "
                "WHERE domain IN (" + ",".join("?" for _ in members) + ") "
                "AND kind IN ('ip_changed','nameservers_changed') AND observed_at>? "
                "AND old_value!='' AND new_value!='' ORDER BY observed_at DESC LIMIT 20",
                (*sorted(members), now - 7*86400))] if members & dirty_domains or cid in changed else []
            if len({r["domain"] for r in transitions}) >= 2 and confidence >= .75:
                first_two = []
                for row in transitions:
                    if row["domain"] not in [x["domain"] for x in first_two]:
                        first_two.append(row)
                    if len(first_two) == 2:
                        break
                _event(conn, first_two[0]["domain"], "campaign_infrastructure_migrated",
                       ",".join(x["old_value"][:70] for x in first_two),
                       ",".join(x["new_value"][:70] for x in first_two),
                       f"Campaign {cid}: recorded transition events " +
                       ", ".join(f"#{x['id']} ({x['domain']}, {x['kind']})" for x in first_two), now)
        if assigned:
            conn.execute("UPDATE ig_campaigns SET status='split_or_inactive' WHERE id NOT IN (" +
                         ",".join("?" for _ in assigned) + ")", sorted(assigned))
        else:
            conn.execute("UPDATE ig_campaigns SET status='split_or_inactive'")
        conn.executemany("DELETE FROM ig_dirty WHERE entity_id=?", [(entity_id,) for entity_id in dirty])
    return {"campaigns": len(assignments), "relationships": len(qualifying), "dirty_entities": len(dirty)}


def record_negative(left, right, kind, value, evidence):
    """Record explicit observed contradiction with its provenance and recompute.

    A mismatch alone does not prove unrelated ownership. Its capped deduction
    can weaken a link, but a stronger independent observation can retain it.
    """
    from app.v2 import active
    active.ensure()
    if kind not in ("weak", "strong") or not evidence or not value:
        raise ValueError("observed contradiction, strength and evidence are required")
    left, right = _pair(left, right)
    if left == right or not store.get(left) or not store.get(right):
        raise ValueError("two distinct observed domains are required")
    with store.conn() as conn:
        conn.execute("INSERT OR IGNORE INTO ig_negative(left_domain,right_domain,kind,value,evidence,observed_at) "
                     "VALUES(?,?,?,?,?,?)", (left, right, kind, value[:200], evidence[:800], time.time()))
    return rebuild(force=True)


def backfill(batch_size=100, max_batches=None):
    """Repeatable migration from prior v2 records; does not delete original data."""
    ensure()
    processed = 0
    with store.conn() as conn:
        domains = [r["domain"] for r in conn.execute("SELECT domain FROM v2_candidates ORDER BY domain")]
    if max_batches is not None:
        domains = domains[:max(0, max_batches) * batch_size]
    for domain in domains:
        candidate = store.get(domain)
        if candidate:
            ingest(candidate, recompute=False)
            processed += 1
    legacy = _backfill_legacy()
    result = rebuild(force=True)
    return {"processed": processed, "legacy_observations": legacy, **result}


def rollback_graph_only(*, confirm=False):
    """Explicit graph and frontier rollback; original v1/v2 tables are untouched."""
    if not confirm:
        raise ValueError("confirm=True required to remove graph-only data")
    ensure()
    tables = ("ig_source_health", "ig_technique_stats", "ig_negative", "ig_hypotheses", "ig_dirty",
              "ig_action_results", "ig_frontier", "ig_paths",
              "ig_reviews", "ig_pivots", "ig_actions", "ig_snapshots", "ig_events",
              "ig_exclusions", "ig_manual_links", "ig_members", "ig_campaigns",
              "ig_relationships", "ig_evidence", "ig_entities", "ig_schema")
    with store.conn() as conn:
        for table in tables:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
    _ready.discard(str(store.db.DB_PATH))
    from app.v2 import active
    active._ready.discard(str(store.db.DB_PATH))
    _feedback_cache.pop(str(store.db.DB_PATH), None)
    return {"removed_graph_tables": len(tables), "original_data_preserved": True}


def _backfill_legacy():
    """Migrate v1 observed indicator and wallet sightings without inferred edges."""
    kinds = {"cert_sha256": "certificate_fingerprint", "template_hash": "template",
             "favicon_hash": "favicon", "analytics_id": "analytics",
             "social_handle": "social", "telegram": "social", "whatsapp": "social",
             "registrar": "registration", "cert_san": "san"}
    with store.conn() as conn:
        indicators = [dict(r) for r in conn.execute("SELECT s.domain,s.url site_url,i.indicator_type,i.value,"
                       "si.source_method,si.source_url,si.evidence_class,si.first_observed,si.last_observed "
                       "FROM site_indicators si JOIN indicators i ON i.id=si.indicator_id "
                       "JOIN sites s ON s.id=si.site_id")]
        wallets = [dict(r) for r in conn.execute("SELECT s.domain,s.url site_url,w.address value,"
                     "p.url source_url,ws.seen_at FROM wallet_sightings ws "
                     "JOIN wallets w ON w.id=ws.wallet_id JOIN sites s ON s.id=ws.site_id "
                     "LEFT JOIN pages p ON p.id=ws.page_id")]
        count = 0
        now = time.time()
        for row in indicators + wallets:
            kind = kinds.get(row.get("indicator_type"), row.get("indicator_type")) if "indicator_type" in row else "wallet"
            if kind not in WEIGHTS or not row["domain"] or not row["value"]:
                continue
            first = float(row.get("first_observed") or row.get("seen_at") or now)
            last = float(row.get("last_observed") or first)
            value = str(row["value"]).lower()[:300]
            conn.execute("INSERT INTO ig_entities(kind,value,first_seen,last_seen) VALUES(?,?,?,?) "
                         "ON CONFLICT(kind,value) DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen),"
                         "last_seen=MAX(last_seen,excluded.last_seen)", (kind, value, first, last))
            entity_id = conn.execute("SELECT id FROM ig_entities WHERE kind=? AND value=?", (kind, value)).fetchone()["id"]
            conn.execute("INSERT INTO ig_evidence(domain,entity_id,source,source_url,evidence_class,strength,first_seen,last_seen) "
                         "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(domain,entity_id,source,source_url) DO UPDATE SET "
                         "first_seen=MIN(first_seen,excluded.first_seen),last_seen=MAX(last_seen,excluded.last_seen)",
                         (row["domain"], entity_id, row.get("source_method") or "legacy_wallet_sighting",
                          row.get("source_url") or row["site_url"], row.get("evidence_class") or "observed",
                          WEIGHTS[kind], first, last))
            count += 1
    return count


def campaign_for(domain):
    ensure()
    with store.conn() as conn:
        row = conn.execute("SELECT campaign_id FROM ig_members WHERE domain=?", (domain,)).fetchone()
    return row["campaign_id"] if row else None


def list_campaigns(limit=20):
    ensure()
    with store.conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT c.*,COUNT(m.domain) domain_count FROM ig_campaigns c JOIN ig_members m ON m.campaign_id=c.id "
            "WHERE c.status IN ('active','dormant') GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?",
            (max(1, min(limit, 50)),))]


def detail(campaign_id, limit=60):
    ensure()
    with store.conn() as conn:
        campaign = conn.execute("SELECT * FROM ig_campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not campaign:
            return None
        members = [r["domain"] for r in conn.execute(
            "SELECT domain FROM ig_members WHERE campaign_id=? ORDER BY domain LIMIT ?",
            (campaign_id, min(limit, 100)))]
        links = [dict(r) for r in conn.execute(
            "SELECT * FROM ig_relationships WHERE left_domain IN (SELECT domain FROM ig_members WHERE campaign_id=?) "
            "AND right_domain IN (SELECT domain FROM ig_members WHERE campaign_id=?) LIMIT 150",
            (campaign_id, campaign_id))]
        events = [dict(r) for r in conn.execute(
            "SELECT * FROM ig_events WHERE domain IN (SELECT domain FROM ig_members WHERE campaign_id=?) "
            "ORDER BY observed_at DESC LIMIT 50", (campaign_id,))]
        reviews = [dict(r) for r in conn.execute(
            "SELECT * FROM ig_reviews WHERE campaign_id=? ORDER BY recorded_at DESC LIMIT 30", (campaign_id,))]
        indicators = [dict(r) for r in conn.execute(
            "SELECT e.kind,e.value,COUNT(DISTINCT v.domain) domain_count "
            "FROM ig_entities e JOIN ig_evidence v ON v.entity_id=e.id "
            "WHERE v.domain IN (SELECT domain FROM ig_members WHERE campaign_id=?) "
            "GROUP BY e.id ORDER BY domain_count DESC LIMIT 120", (campaign_id,))]
    return {**dict(campaign), "domains": members, "relationships": links,
            "timeline": events, "reviews": reviews,
            "wallets": [i for i in indicators if i["kind"] == "wallet"],
            "infrastructure": [i for i in indicators if i["kind"] in ("ip", "nameserver", "asn", "hosting", "san")],
            "templates": [i for i in indicators if i["kind"] in ("template", "favtmpl", "favicon")],
            "contacts": [i for i in indicators if i["kind"] in ("email", "phone", "social")],
            "source_history": [i for i in indicators if i["kind"] == "source"]}


def neighbors(domain, limit=25, min_confidence=0, at=None):
    ensure()
    with store.conn() as conn:
        edges = [dict(r) for r in conn.execute(
            "SELECT * FROM ig_relationships WHERE (left_domain=? OR right_domain=?) "
            "AND confidence>=? AND (? IS NULL OR last_seen>=?) ORDER BY confidence DESC LIMIT ?",
            (domain, domain, min_confidence, at, at, max(1, min(limit, MAX_NEIGHBORS))))]
        evidence = [dict(r) for r in conn.execute(
            "SELECT e.kind,e.value,v.source,v.source_url,v.evidence_class,v.strength "
            "FROM ig_evidence v JOIN ig_entities e ON e.id=v.entity_id WHERE v.domain=? "
            "ORDER BY v.strength DESC LIMIT 40", (domain,))]
    return {"domain": domain, "campaign": campaign_for(domain), "edges": edges, "evidence": evidence}


def actions(limit=15):
    """Rank suggested steps with separately capped gain, cost and duplication."""
    ensure()
    with store.conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM ig_actions WHERE state='suggested' ORDER BY value DESC LIMIT ?",
            (max(1, min(limit, 50)),))]


def source_report(limit=30):
    """Observed yield, with unknown latency/failure explicitly left unknown."""
    ensure()
    with store.conn() as conn:
        rows = conn.execute("""
            SELECT s.strategy, COUNT(DISTINCT s.domain) found,
                   COUNT(DISTINCT CASE WHEN c.status='useful' THEN s.domain END) useful,
                   COUNT(DISTINCT CASE WHEN c.status='skipped' THEN s.domain END) skipped,
                   COUNT(DISTINCT m.campaign_id) campaigns,
                   COUNT(DISTINCT CASE WHEN c.cluster_id IS NOT NULL THEN c.cluster_id END) clusters
            FROM v2_sightings s LEFT JOIN v2_candidates c ON c.domain=s.domain
            LEFT JOIN ig_members m ON m.domain=s.domain
            GROUP BY s.strategy ORDER BY useful DESC,found DESC LIMIT ?""",
            (max(1, min(limit, 50)),)).fetchall()
    stats = store.strategy_stats()
    return [{**dict(row), "cost": stats.get(row["strategy"], {}).get("cost", 0),
             "useful_rate": round(row["useful"] / max(1, row["useful"] + row["skipped"]), 3),
             "latency": None, "failure_rate": None} for row in rows]


def suggest(candidate):
    ensure()
    domain = candidate["domain"]
    campaign_id = campaign_for(domain)
    facts = _facts(candidate)
    quality = min(1., max(0., float(candidate.get("p") or 0)))
    with store.conn() as conn:
        changes = conn.execute("SELECT COUNT(*) n FROM ig_events WHERE domain=?", (domain,)).fetchone()["n"]
        state = conn.execute("SELECT state FROM ig_snapshots WHERE domain=?", (domain,)).fetchone()

        def save(kind, target, value, explanation, extra=None):
            factors = {"candidate_quality": quality, "meaningful_change": bool(changes),
                       "explanation": explanation, **(extra or {})}
            conn.execute("INSERT INTO ig_actions(domain,kind,target,campaign_id,value,factors,created_at) "
                         "VALUES(?,?,?,?,?,?,?) ON CONFLICT(domain,kind,target) DO UPDATE SET "
                         "value=excluded.value,factors=excluded.factors,campaign_id=excluded.campaign_id",
                         (domain, kind, target, campaign_id, round(min(1., max(0., value)), 4),
                          json.dumps(factors), time.time()))

        if quality >= .55:
            save("inspect_domain", domain, quality * .65 + (.12 if changes else 0) - .04,
                 f"Inspect {domain}: qualifying public evidence has been recorded.", {"cost": .04})
        if campaign_id:
            save("review_campaign", campaign_id, quality * .50 + .12 - .06,
                 f"Review {campaign_id}: this site connects to another observed domain.", {"cost": .06})
        if changes:
            save("check_change", domain, quality * .55 + .15 - .06,
                 f"Revisit {domain}: a meaningful observed change may add new evidence.", {"cost": .06})
        if state and state["state"] in ("offline", "dormant") and candidate.get("decision") == "useful":
            save("revisit", domain, quality * .5 + .16 - .10,
                 f"Recheck previously useful {domain} after an offline period.", {"cost": .10})
        if any(kind == "deposit_page" for kind, *_ in facts):
            save("inspect_deposit_page", domain, quality * .6 + .15 - .08,
                 f"Inspect a public deposit page of {domain} for new wallet evidence.", {"cost": .08})
        for kind, value, _, _, _ in facts:
            if kind not in DEGREE_LIMIT:
                continue
            degree = conn.execute("SELECT COUNT(DISTINCT domain) n FROM ig_evidence v JOIN ig_entities e "
                                  "ON v.entity_id=e.id WHERE e.kind=? AND e.value=?", (kind, value)).fetchone()["n"]
            if degree > DEGREE_LIMIT[kind]:
                continue
            target = f"{kind}:{value}"
            gain = min(.30, WEIGHTS[kind] * .30 / max(1, degree))
            novelty = .12 if changes else 0
            cost = .08 if kind in ("wallet", "service") else .14
            value_score = round(max(0, min(1., quality * .55 + gain + novelty - cost)), 4)
            save("pivot", target, value_score,
                 f"Inspect {kind} reuse around {domain}; {degree} observed site(s) share this indicator.",
                 {"information_gain": round(gain, 3), "cost": cost, "degree": degree})


def review_campaign(campaign_id, decision, detail_text=""):
    if decision not in ("useful", "skip", "watch", "investigate"):
        raise ValueError("unsupported campaign decision")
    if not detail(campaign_id):
        raise KeyError(campaign_id)
    with store.conn() as conn:
        conn.execute("INSERT INTO ig_reviews(campaign_id,decision,detail,recorded_at) VALUES(?,?,?,?)",
                     (campaign_id, decision, str(detail_text)[:500], time.time()))
    _feedback_cache.pop(str(store.db.DB_PATH), None)
    if decision == "watch":
        from app.v2 import operations
        operations.watch_campaign(campaign_id)
    # The bounded strategy prior reads the last vote per campaign once at least
    # five different campaigns have been judged. No domain decision is forged.
    return {"ok": True, "campaign_id": campaign_id, "decision": decision}


def annotate_campaign(campaign_id, notes, tags):
    ensure()
    if not isinstance(notes, str) or not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise ValueError("notes must be text and tags must be a list of strings")
    with store.conn() as conn:
        changed = conn.execute("UPDATE ig_campaigns SET notes=?,tags=?,updated_at=? WHERE id=?",
                               (notes[:3000], json.dumps([t[:40] for t in tags[:20]]), time.time(), campaign_id))
    if not changed.rowcount:
        raise KeyError(campaign_id)
    return {"ok": True, "campaign_id": campaign_id}


def campaign_feedback():
    """Conservative campaign votes for source learning, never domain votes."""
    ensure()
    key = str(store.db.DB_PATH)
    if key in _feedback_cache:
        return _feedback_cache[key]
    with store.conn() as conn:
        rows = conn.execute("""
            SELECT r.decision, v.strategies FROM ig_reviews r
            JOIN ig_members m ON m.campaign_id=r.campaign_id
            JOIN v2_candidates v ON v.domain=m.domain
            AND m.domain=(SELECT MIN(domain) FROM ig_members WHERE campaign_id=r.campaign_id)
            WHERE r.id IN (SELECT MAX(id) FROM ig_reviews
                           WHERE decision IN ('useful','skip') GROUP BY campaign_id)
            ORDER BY r.id""").fetchall()
    if len(rows) < 5:
        _feedback_cache[key] = {}
        return {}
    result = defaultdict(lambda: {"useful": 0., "skipped": 0.})
    for row in rows:
        for strategy in set(json.loads(row["strategies"] or "[]")):
            result[strategy]["useful" if row["decision"] == "useful" else "skipped"] += .25
    _feedback_cache[key] = dict(result)
    return _feedback_cache[key]


def reject_relationship(a, b, reason):
    if not reason or a == b:
        raise ValueError("two distinct domains and a reason are required")
    ensure()
    a, b = _pair(a, b)
    with store.conn() as conn:
        conn.execute("INSERT OR REPLACE INTO ig_exclusions VALUES(?,?,?,?)", (a, b, reason[:500], time.time()))
    return rebuild(force=True)


def split_campaign(campaign_id, separated_domains, reason):
    """Exclude all cross-group links; an alternate graph path cannot undo a split."""
    record = detail(campaign_id)
    if not record or not reason:
        raise ValueError("existing campaign and reason required")
    members = set(record["domains"])
    separated = set(separated_domains)
    if not separated or not separated < members or len(members) > 100:
        raise ValueError("select a non-empty proper subset of up to 100 members")
    with store.conn() as conn:
        conn.executemany("INSERT OR REPLACE INTO ig_exclusions VALUES(?,?,?,?)",
                         [(*_pair(a, b), reason[:500], time.time()) for a in separated for b in members - separated])
    return rebuild(force=True)


def merge_campaigns(first, second, reason, source_url):
    """An explicit analyst evidence citation supports a manual hypothesis."""
    a, b = detail(first), detail(second)
    if not a or not b or first == second or not reason or not source_url.startswith(("http://", "https://")):
        raise ValueError("two distinct campaigns, reason and public evidence URL required")
    left, right = _pair(a["domains"][0], b["domains"][0])
    with store.conn() as conn:
        conn.execute("INSERT OR REPLACE INTO ig_manual_links VALUES(?,?,?,?,?)",
                     (left, right, reason[:500], source_url[:500], time.time()))
        conn.execute("DELETE FROM ig_exclusions WHERE left_domain=? AND right_domain=?", (left, right))
    return rebuild(force=True)
