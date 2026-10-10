import asyncio, importlib.util, json, logging, os, threading
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, Field
from .db import Database, now, sid
from .investigator import Investigator
from .authenticated import AuthenticatedInvestigator

db=Database(); app=FastAPI(title="Site Investigator",version="0.1.0")
_platform_stop=threading.Event()
_platform_thread=None

@app.on_event("startup")
def start_platform_integration():
    """Normal server startup claims Main Platform work when configured."""
    global _platform_thread
    if not (os.environ.get("MAIN_PLATFORM_URL") and os.environ.get("SITE_INVESTIGATOR_MODULE_KEY")):
        return
    bridge_path=Path(__file__).resolve().parents[2]/"site_investigator_bridge.py"
    if not bridge_path.is_file():
        raise RuntimeError(f"Configured Main Platform bridge is missing: {bridge_path}")
    spec=importlib.util.spec_from_file_location("site_investigator_platform_bridge",bridge_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load configured Site Investigator bridge")
    bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
    _platform_stop.clear()
    def poll():
        while not _platform_stop.is_set():
            try:
                bridge.Platform().run_once(db)
            except Exception:
                logging.getLogger(__name__).exception("Site Investigator platform job poll failed")
            _platform_stop.wait(3)
    _platform_thread=threading.Thread(target=poll,daemon=True,name="site-investigator-platform")
    _platform_thread.start()

@app.on_event("shutdown")
def stop_platform_integration():
    _platform_stop.set()
    if _platform_thread:
        _platform_thread.join(timeout=5)

class CaseIn(BaseModel): name:str=Field(min_length=1,max_length=120)
class SiteIn(BaseModel): case_id:str; url:str
class AuthIn(BaseModel): login_url:str; username:str; password:str; manual:bool=False
class NoteIn(BaseModel): body:str=Field(min_length=1,max_length=10000)

def task(coro):
    def runner(): asyncio.run(coro)
    threading.Thread(target=runner,daemon=True).start()

@app.get("/",response_class=HTMLResponse)
def home(): return (Path(__file__).with_name("static")/"index.html").read_text(encoding="utf-8")

@app.get("/api/cases")
def cases(): return db.all("SELECT * FROM cases ORDER BY updated_at DESC")

@app.post("/api/cases")
def create_case(x:CaseIn):
    cid=sid("case"); t=now(); db.execute("INSERT INTO cases VALUES(?,?,?,?,?)",(cid,x.name,"open",t,t)); db.emit("case",cid,"case.created",{"name":x.name}); return db.one("SELECT * FROM cases WHERE id=?",(cid,))

@app.post("/api/sites")
def add_site(x:SiteIn):
    u=x.url.strip()
    if not u.startswith(("http://","https://")):u="https://"+u
    p=urlparse(u); domain=(p.hostname or "").lower().strip('.')
    if not domain or domain in ("localhost","127.0.0.1"): raise HTTPException(400,"Enter a public domain")
    old=db.one("SELECT * FROM websites WHERE case_id=? AND normalized_domain=?",(x.case_id,domain))
    if old:return old
    wid=sid("site"); t=now(); db.execute("INSERT INTO websites VALUES(?,?,?,?,?,?,?,?,?)",(wid,x.case_id,domain,u,None,"new",0,t,t)); db.emit("website",wid,"website.created",{"case_id":x.case_id,"url":u}); return db.one("SELECT * FROM websites WHERE id=?",(wid,))

@app.post("/api/sites/{site_id}/investigate")
def investigate(site_id:str):
    site=db.one("SELECT * FROM websites WHERE id=?",(site_id,))
    if not site:raise HTTPException(404,"Site not found")
    jid=sid("job"); t=now(); db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)",(jid,site["case_id"],site_id,"public_investigation","queued",0,"Queued",t,t)); task(Investigator(db).public(site["case_id"],site_id,jid)); return {"job_id":jid}

@app.post("/api/sites/{site_id}/authenticate")
def authenticate(site_id:str,x:AuthIn):
    site=db.one("SELECT * FROM websites WHERE id=?",(site_id,));
    if not site:raise HTTPException(404,"Site not found")
    if urlparse(x.login_url).hostname!=site["normalized_domain"]:raise HTTPException(400,"Login URL must use the investigated domain")
    jid=sid("job");t=now();db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)",(jid,site["case_id"],site_id,"authenticated_investigation","queued",0,"Credentials held in memory only",t,t));task(AuthenticatedInvestigator(db).run(site["case_id"],site_id,jid,x.login_url,x.username,x.password,x.manual));return {"job_id":jid}

@app.get("/api/jobs/{job_id}")
def job(job_id:str): return db.one("SELECT * FROM jobs WHERE id=?",(job_id,)) or (_ for _ in ()).throw(HTTPException(404,"Job not found"))

@app.get("/api/cases/{case_id}")
def case_detail(case_id:str):
    c=db.one("SELECT * FROM cases WHERE id=?",(case_id,));
    if not c:raise HTTPException(404,"Case not found")
    return {"case":c,"websites":db.all("SELECT * FROM websites WHERE case_id=? ORDER BY last_seen DESC",(case_id,)),"evidence":db.all("SELECT * FROM evidence WHERE case_id=? ORDER BY collected_at DESC LIMIT 500",(case_id,)),"relationships":db.all("SELECT * FROM relationships WHERE case_id=? ORDER BY created_at DESC",(case_id,)),"timeline":db.all("SELECT * FROM timeline WHERE case_id=? ORDER BY occurred_at DESC",(case_id,)),"notes":db.all("SELECT * FROM notes WHERE case_id=? ORDER BY created_at DESC",(case_id,))}

@app.get("/api/sites/{site_id}")
def site_detail(site_id:str): return {"site":db.one("SELECT * FROM websites WHERE id=?",(site_id,)),"pages":db.all("SELECT * FROM pages WHERE website_id=? ORDER BY last_seen DESC",(site_id,)),"evidence":db.all("SELECT * FROM evidence WHERE website_id=? ORDER BY collected_at DESC",(site_id,)),"deposits":db.all("SELECT d.*,w.canonical_address FROM deposit_options d LEFT JOIN wallets w ON w.id=d.wallet_id WHERE d.website_id=?",(site_id,)),"relationships":db.all("SELECT * FROM relationships WHERE from_id=? OR to_id=?",(site_id,site_id))}

@app.post("/api/cases/{case_id}/notes")
def note(case_id:str,x:NoteIn):
    nid=sid("note");t=now();db.execute("INSERT INTO notes VALUES(?,?,?,?,?,?)",(nid,case_id,None,x.body,t,t));db.timeline(case_id,None,"note.created","analyst_note",x.body[:200]);return {"id":nid}

@app.get("/api/search")
def search(q:str=""):
    like=f"%{q}%";return {"sites":db.all("SELECT * FROM websites WHERE normalized_domain LIKE ? OR title LIKE ? LIMIT 100",(like,like)),"evidence":db.all("SELECT * FROM evidence WHERE value_json LIKE ? LIMIT 100",(like,)),"notes":db.all("SELECT * FROM notes WHERE body LIKE ? LIMIT 100",(like,))}

@app.get("/api/cases/{case_id}/export")
def export(case_id:str):
    data=case_detail(case_id);data["pages"]=db.all("SELECT p.* FROM pages p JOIN websites w ON p.website_id=w.id WHERE w.case_id=?",(case_id,));data["wallets"]=db.all("SELECT DISTINCT w.* FROM wallets w JOIN relationships r ON (r.to_id=w.id OR r.from_id=w.id) WHERE r.case_id=?",(case_id,));return data

def run():
    import uvicorn
    uvicorn.run("siteinvestigator.app:app",host=os.getenv("SI_HOST","127.0.0.1"),port=int(os.getenv("SI_PORT","8765")),reload=False)
