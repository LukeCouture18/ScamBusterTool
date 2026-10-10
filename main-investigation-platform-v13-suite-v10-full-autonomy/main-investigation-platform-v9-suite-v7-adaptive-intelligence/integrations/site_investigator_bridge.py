"""Site Investigator 0.1 -> Main Platform v6 worker and evidence translator.

Run with PYTHONPATH pointing at the supplied Site-Investigator source. The public
investigator remains the evidence collector; this bridge only coordinates jobs.
"""
import asyncio
import hashlib
import ipaddress
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def now(): return datetime.now(timezone.utc).isoformat()


def public_domain(raw):
    host=urllib.parse.urlparse("https://"+raw).hostname or ""
    if host != raw.lower() or "." not in host or host.endswith(".invalid"):
        raise ValueError("Only public DNS names may be investigated")
    try: ipaddress.ip_address(host); raise ValueError("IP addresses are not accepted")
    except ValueError as error:
        if "not accepted" in str(error): raise
    return host


def build_batch(db, investigation_id, job_id, domain):
    """Translate actual v0.1 SQLite rows, retaining source IDs and provenance."""
    site=db.one("SELECT * FROM websites WHERE case_id=? AND normalized_domain=?",(investigation_id,domain))
    if not site: raise ValueError("Site Investigator case has no matching site")
    base={"investigation_id":investigation_id,"provenance":{"source":"site_investigator","local_case_id":investigation_id,"origin_job_id":job_id}}
    records={"sites":[],"pages":[],"wallets":[],"deposit_options":[],"evidence":[],"relationships":[]}
    records["sites"].append({**base,"external_id":site["id"],"canonical_key":domain,"display_name":site.get("title") or domain,"confidence":0.85,"status":site["status"],"observed_at":site["last_seen"]})
    pages=db.all("SELECT * FROM pages WHERE website_id=?",(site["id"],))
    for page in pages:records["pages"].append({**base,"external_id":page["id"],"canonical_key":page["url"],"display_name":page.get("title") or page["url"],"confidence":0.9,"auth_scope":page["auth_scope"],"observed_at":page["last_seen"]})
    evidence=db.all("SELECT * FROM evidence WHERE case_id=? AND website_id=?",(investigation_id,site["id"]))
    for item in evidence:
        evidence_class="observed_website" if item["source_class"] in ("public","authenticated") else "derived_observation"
        scope="authenticated" if item["source_class"]=="authenticated" else "public"
        records["evidence"].append({**base,"external_id":item["id"],"evidence_type":item["kind"],"evidence_class":evidence_class,"observation_scope":scope,"title":f"Site Investigator: {item['kind']}","context_text":item["value_json"][:100000],"confidence":item["confidence"],"uri":item.get("source_url"),"source_url":item.get("source_url"),"artifact_path":item.get("artifact_path"),"sha256":item.get("sha256"),"entity":{"entity_type":"site","canonical_key":domain},"observed_at":item["collected_at"],"provenance":{**base["provenance"],"local_evidence_id":item["id"],"source_class":item["source_class"]}})
    wallets={}
    for item in db.all("SELECT DISTINCT w.* FROM wallets w JOIN relationships r ON r.to_id=w.id WHERE r.case_id=? AND r.from_id=?",(investigation_id,site["id"])):
        wallets[item["id"]]=item
        records["wallets"].append({**base,"external_id":item["id"],"address":item["canonical_address"],"network":item.get("network") or "unknown","token":item.get("token"),"display_name":item["canonical_address"],"confidence":item["confidence"],"observed_at":item["first_seen"]})
    for item in db.all("SELECT * FROM deposit_options WHERE website_id=?",(site["id"],)):
        records["deposit_options"].append({**base,"external_id":item["id"],"canonical_key":f"{domain}:{item.get('page_id') or ''}:{item.get('wallet_id') or ''}:{item.get('network') or ''}","confidence":0.8,"token":item.get("token"),"network":item.get("network"),"observed_at":item["observed_at"]})
    evidence_ids={item["id"] for item in evidence}
    for item in db.all("SELECT * FROM relationships WHERE case_id=? AND from_id=?",(investigation_id,site["id"])):
        if item["evidence_id"] not in evidence_ids:continue
        if item["to_type"]=="wallet" and item["to_id"] in wallets:
            wallet=wallets[item["to_id"]];to={"entity_type":"wallet","canonical_key":wallet["canonical_address"],"network":wallet.get("network") or "unknown"}
        elif item["to_type"]=="website":
            related=db.one("SELECT normalized_domain FROM websites WHERE id=?",(item["to_id"],))
            if not related:continue
            to={"entity_type":"site","canonical_key":related["normalized_domain"]}
        else:continue
        records["relationships"].append({**base,"external_id":item["id"],"relationship_type":item["relationship_type"],"assertion_kind":"observed" if item["relationship_type"]=="displays_wallet" else "derived","from":{"entity_type":"site","canonical_key":domain},"to":to,"evidence_ids":[item["evidence_id"]],"confidence":item["confidence"],"observed_at":item["created_at"],"provenance":{**base["provenance"],"explanation":item["explanation"]}})
    marker=hashlib.sha256(json.dumps(records,sort_keys=True,default=str).encode()).hexdigest()[:32]
    return {"schema_version":"3.0","batch_id":f"si:{job_id}:{marker}","sent_at":now(),"origin_job_id":job_id,"records":records}


class Platform:
    def __init__(self):
        self.base=os.environ["MAIN_PLATFORM_URL"].rstrip("/")
        self.key=os.environ["SITE_INVESTIGATOR_MODULE_KEY"]
    def request(self,path,method="GET",data=None):
        headers={"X-API-Key":self.key,"Content-Type":"application/json"}
        req=urllib.request.Request(self.base+path,headers=headers,method=method,data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(req,timeout=20) as response:
                return json.loads(response.read()) if response.status!=204 else None
        except urllib.error.HTTPError as error:raise RuntimeError(f"Main Platform HTTP {error.code}: {error.read()[:200]!r}") from error
    def heartbeat(self,job_id=None):return self.request("/api/v1/modules/site_investigator/heartbeat","POST",{"module_version":"0.1.0-bridge-v6","schema_version":"3.0","status":"running" if job_id else "idle","capabilities":["site:investigate"],"current_job_id":job_id})
    def run_once(self,db):
        self.request("/api/v1/modules/site_investigator/register","POST",{"module_version":"0.1.0-bridge-v6","schema_version":"3.0","capabilities":["site:investigate"],"supported_event_types":[],"metadata":{"bridge":"site_investigator_bridge.py"}})
        self.heartbeat();answer=self.request("/api/v1/modules/site_investigator/jobs/claim","POST")
        if not answer:return False
        job=answer["job"];job_id=job["id"]
        stop=threading.Event()
        def heartbeat_loop():
            while not stop.wait(45):
                try:self.heartbeat(job_id)
                except Exception:pass
        worker=threading.Thread(target=heartbeat_loop,daemon=True);worker.start()
        try:
            if job["job_type"] not in ("INVESTIGATE_SITE","RECHECK_SITE"):raise ValueError("Unsupported job type")
            context=self.request(f"/api/v1/investigations/{job['investigation_id']}/context?module=site_investigator")
            target=next((e for e in context["entities"] if e["id"]==job["target_entity_id"] and e["entity_type"]=="site"),None)
            if not target:raise ValueError("Target site is missing from investigation context")
            domain=public_domain(target["canonical_key"])
            from siteinvestigator.db import Database,sid
            from siteinvestigator.investigator import Investigator
            case=db.one("SELECT id FROM cases WHERE id=?",(job["investigation_id"],))
            if not case:db.execute("INSERT INTO cases VALUES (?,?,?,?,?)",(job["investigation_id"],f"Platform investigation {job['investigation_id']}","open",now(),now()))
            site=db.one("SELECT * FROM websites WHERE case_id=? AND normalized_domain=?",(job["investigation_id"],domain))
            if not site:
                site_id=sid("site");db.execute("INSERT INTO websites VALUES (?,?,?,?,?,?,?,?,?)",(site_id,job["investigation_id"],domain,"https://"+domain,None,"new",0,now(),now()))
            else:site_id=site["id"]
            local_id=sid("job");db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",(local_id,job["investigation_id"],site_id,"public_investigation","queued",0,"Queued by Main Platform",now(),now()))
            raw_payload=job.get("payload") or {}
            payload=json.loads(raw_payload) if isinstance(raw_payload,str) else raw_payload
            limit=(payload.get("resource_limits") or {}).get("requests_per_attempt")
            investigator=Investigator(db) if limit is None else Investigator(db,max_requests=limit)
            asyncio.run(investigator.public(job["investigation_id"],site_id,local_id))
            outcome=db.one("SELECT status,message FROM jobs WHERE id=?",(local_id,))
            if outcome["status"]!="completed":raise RuntimeError(outcome["message"])
            batch=build_batch(db,job["investigation_id"],job_id,domain)
            result=self.request("/api/v1/ingest/site_investigator","POST",batch)
            if result.get("error_count") or result.get("status")!="accepted":raise RuntimeError(f"Platform ingest incomplete: {result}")
            self.request(f"/api/v1/modules/site_investigator/jobs/{job_id}","PATCH",{"action":"complete","result":{"batch_id":batch["batch_id"],"record_count":sum(map(len,batch["records"].values()))}})
            return True
        except Exception as error:
            self.request(f"/api/v1/modules/site_investigator/jobs/{job_id}","PATCH",{"action":"fail","error":str(error)[:500],"retry":True})
            return False
        finally:stop.set();worker.join(timeout=1);self.heartbeat()


if __name__=="__main__":
    from siteinvestigator.db import Database
    worker=Platform();local=Database()
    while True:
        try:
            if not worker.run_once(local):time.sleep(15)
        except KeyboardInterrupt:break
        except Exception as error:
            print(f"Site Investigator bridge: {error}",flush=True);time.sleep(30)
