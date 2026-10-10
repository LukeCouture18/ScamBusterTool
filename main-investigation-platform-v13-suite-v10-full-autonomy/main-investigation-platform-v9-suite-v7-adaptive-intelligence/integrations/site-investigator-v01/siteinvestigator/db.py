import json, os, sqlite3, threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path

def now(): return datetime.now(timezone.utc).isoformat()

def sid(prefix):
    ms = int(time.time() * 1000)
    return f"{prefix}_{ms:013x}{uuid.uuid4().hex[:19]}"

class Database:
    def __init__(self, data_dir=None):
        self.root = Path(data_dir or os.getenv("SI_DATA_DIR", "data")).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "artifacts").mkdir(exist_ok=True)
        self.path = self.root / "site_investigator.db"
        self.local = threading.local()
        with self.connect() as c:
            c.executescript((Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8"))

    def connect(self):
        c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def execute(self, sql, args=()):
        with self.connect() as c:
            cur = c.execute(sql, args); return cur.lastrowid

    def one(self, sql, args=()):
        with self.connect() as c:
            r=c.execute(sql,args).fetchone(); return dict(r) if r else None

    def all(self, sql, args=()):
        with self.connect() as c: return [dict(r) for r in c.execute(sql,args).fetchall()]

    def emit(self, aggregate_type, aggregate_id, event_type, payload):
        self.execute("INSERT INTO outbox_events VALUES(?,?,?,?,?,?,NULL)", (sid("evt"),aggregate_type,aggregate_id,event_type,json.dumps(payload),now()))

    def evidence(self, case_id, website_id, kind, value, source_class="public", source_url=None, page_id=None, confidence=.8, artifact_path=None, sha256=None):
        eid=sid("ev")
        self.execute("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(eid,case_id,website_id,page_id,kind,source_class,source_url,json.dumps(value,ensure_ascii=False),confidence,now(),artifact_path,sha256))
        self.emit("evidence",eid,"evidence.created",{"case_id":case_id,"website_id":website_id,"kind":kind,"source_class":source_class})
        return eid

    def timeline(self, case_id, website_id, event_type, source_class, summary, data=None):
        self.execute("INSERT INTO timeline VALUES(?,?,?,?,?,?,?,?)",(sid("time"),case_id,website_id,event_type,source_class,summary,json.dumps(data or {}),now()))

