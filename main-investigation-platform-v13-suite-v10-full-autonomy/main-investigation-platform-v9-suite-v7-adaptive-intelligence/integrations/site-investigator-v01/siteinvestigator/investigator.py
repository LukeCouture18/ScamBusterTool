import asyncio, hashlib, json, os, socket, ssl
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin
import dns.resolver, httpx
from .db import Database, now, sid
from .detectors import parse_page, technologies, indicators, wallets, page_kind, fingerprint, PAGE_WORDS

class Investigator:
    def __init__(self, db:Database, max_requests=None):
        self.db=db; self.timeout=float(os.getenv("SI_REQUEST_TIMEOUT","12")); self.max_pages=int(os.getenv("SI_MAX_PAGES","35"))
        self.requests_remaining=None if max_requests is None else max(0,int(max_requests))
        self.ua=os.getenv("SI_USER_AGENT","SiteInvestigator/0.1 defensive research")

    def _take_request(self):
        if self.requests_remaining is None:return
        if self.requests_remaining<=0:raise RuntimeError("Main investigation request allowance exhausted")
        self.requests_remaining-=1

    async def _http_request(self, request):self._take_request()

    async def public(self, case_id, site_id, job_id):
        site=self.db.one("SELECT * FROM websites WHERE id=?",(site_id,)); domain=site["normalized_domain"]
        try:
            self._job(job_id,"running",5,"Collecting registration, DNS, and TLS metadata")
            await self._infrastructure(case_id,site_id,domain)
            self._job(job_id,"running",25,"Crawling public pages")
            await self._crawl(case_id,site_id,site["start_url"],"public")
            self._job(job_id,"running",75,"Capturing public-page screenshots")
            await self._screenshots(case_id,site_id)
            self._job(job_id,"running",85,"Building evidence relationships")
            self._relationships(case_id,site_id)
            self.db.execute("UPDATE websites SET status='investigated',last_seen=? WHERE id=?",(now(),site_id))
            self.db.timeline(case_id,site_id,"investigation.completed","public","Public investigation completed")
            self._job(job_id,"completed",100,"Investigation complete")
        except Exception as e:
            self._job(job_id,"failed",100,str(e)[:500]); self.db.timeline(case_id,site_id,"investigation.failed","software_derived",str(e)[:500])

    def _job(self,jid,status,progress,message): self.db.execute("UPDATE jobs SET status=?,progress=?,message=?,updated_at=? WHERE id=?",(status,progress,message,now(),jid))

    async def _infrastructure(self,case_id,site_id,domain):
        loop=asyncio.get_running_loop()
        dns_data={}
        for typ in ("A","AAAA","NS","MX","TXT","CNAME"):
            try:
                self._take_request()
                dns_data[typ]=[str(x).rstrip('.') for x in await loop.run_in_executor(None,lambda t=typ:list(dns.resolver.resolve(domain,t,lifetime=5)))]
            except Exception: dns_data[typ]=[]
        self.db.evidence(case_id,site_id,"dns",dns_data,confidence=.95,source_url=f"dns://{domain}")
        try:
            self._take_request()
            ctx=ssl.create_default_context()
            cert=await loop.run_in_executor(None,self._cert,domain,ctx)
            self.db.evidence(case_id,site_id,"tls_certificate",cert,confidence=.95,source_url=f"tls://{domain}:443")
        except Exception as e: self.db.evidence(case_id,site_id,"tls_error",{"error":str(e)},confidence=.9)
        async with httpx.AsyncClient(event_hooks={"request":[self._http_request]},timeout=self.timeout,headers={"User-Agent":self.ua},follow_redirects=True) as c:
            for endpoint,kind in [(f"https://rdap.org/domain/{domain}","rdap"),(f"https://crt.sh/?q=%25.{domain}&output=json","certificate_transparency")]:
                try:
                    r=await c.get(endpoint); r.raise_for_status(); data=r.json()
                    if kind=="certificate_transparency":
                        names=sorted({n.lower() for row in data[:1000] for n in row.get("name_value","").splitlines() if "*" not in n})
                        data={"names":names[:500],"count":len(names)}
                    self.db.evidence(case_id,site_id,kind,data,confidence=.9,source_url=endpoint)
                except Exception as e: self.db.evidence(case_id,site_id,kind+"_error",{"error":str(e)},confidence=.7,source_url=endpoint)
        ips=dns_data.get("A",[])
        for ip in ips:
            try:
                async with httpx.AsyncClient(event_hooks={"request":[self._http_request]},timeout=self.timeout,headers={"User-Agent":self.ua}) as c:
                    r=await c.get(f"https://rdap.org/ip/{ip}"); r.raise_for_status(); data=r.json()
                    self.db.evidence(case_id,site_id,"ip_rdap",{"ip":ip,"name":data.get("name"),"handle":data.get("handle"),"country":data.get("country"),"entities":data.get("entities",[])[:10]},confidence=.88,source_url=str(r.url))
            except Exception: pass

    @staticmethod
    def _cert(domain,ctx):
        with socket.create_connection((domain,443),timeout=7) as sock:
            with ctx.wrap_socket(sock,server_hostname=domain) as s:
                c=s.getpeercert()
                return {"subject":c.get("subject"),"issuer":c.get("issuer"),"serialNumber":c.get("serialNumber"),"notBefore":c.get("notBefore"),"notAfter":c.get("notAfter"),"subjectAltName":c.get("subjectAltName")}

    async def _crawl(self,case_id,site_id,start_url,scope):
        origin=urlparse(start_url); root=f"{origin.scheme}://{origin.netloc}"; queue=[start_url]
        for words in PAGE_WORDS.values():
            for word in words[:1]: queue.append(urljoin(root,"/"+word))
        seen=set(); combined={"technologies":set(),"emails":set(),"phones":set(),"socials":set(),"analytics_ids":set(),"fingerprints":set()}
        async with httpx.AsyncClient(event_hooks={"request":[self._http_request]},timeout=self.timeout,headers={"User-Agent":self.ua},follow_redirects=True,verify=True) as c:
            while queue and len(seen)<self.max_pages:
                url=queue.pop(0)
                if url in seen or urlparse(url).netloc.lower()!=origin.netloc.lower(): continue
                seen.add(url)
                try:
                    r=await c.get(url)
                    if "text/html" not in r.headers.get("content-type",""): continue
                    html=r.text[:3_000_000]; title,text,links,scripts=parse_page(str(r.url),html); kind=page_kind(str(r.url),text)
                    page_id=self._page(site_id,str(r.url),kind,title,r.status_code,scope,html)
                    self.db.evidence(case_id,site_id,"page_text",{"title":title,"kind":kind,"important_text":text[:12000]},scope,str(r.url),page_id,.9)
                    tech=technologies(dict(r.headers),html,scripts); ids=indicators(text,html); fp=fingerprint(html)
                    combined["technologies"].update(tech); combined["fingerprints"].add(fp)
                    for k,v in ids.items(): combined[k].update(v)
                    for w in wallets(text): self._wallet(case_id,site_id,page_id,w,scope,str(r.url),kind)
                    for u in links:
                        if u not in seen and any(x in u.lower() for ws in PAGE_WORDS.values() for x in ws): queue.append(u)
                    if len(seen)==1: self.db.execute("UPDATE websites SET title=? WHERE id=?",(title,site_id))
                except Exception as e:
                    self.db.evidence(case_id,site_id,"page_fetch_error",{"url":url,"error":str(e)},scope,url,confidence=.7)
        for kind,vals in combined.items(): self.db.evidence(case_id,site_id,kind,sorted(vals),"software_derived",start_url,confidence=.8)
        if not self.db.one("SELECT id FROM pages WHERE website_id=? AND auth_scope=? LIMIT 1",(site_id,scope)):
            raise RuntimeError("No public pages were collected; review fetch errors before retrying")

    def _page(self,site_id,url,kind,title,status,scope,html):
        old=self.db.one("SELECT id FROM pages WHERE website_id=? AND url=? AND auth_scope=?",(site_id,url,scope))
        if old:return old["id"]
        pid=sid("page"); t=now(); self.db.execute("INSERT INTO pages (id,website_id,url,kind,title,http_status,auth_scope,content_hash,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)",(pid,site_id,url,kind,title,status,scope,hashlib.sha256(html.encode(errors="ignore")).hexdigest(),t,t)); return pid

    def _wallet(self,case_id,site_id,page_id,w,scope,url,kind):
        old=self.db.one("SELECT id FROM wallets WHERE canonical_address=? AND network IS ? AND token IS ?",(w["address"],w["network"],w["token"]))
        wid=old["id"] if old else sid("wallet")
        if not old:self.db.execute("INSERT INTO wallets VALUES(?,?,?,?,?,?)",(wid,w["address"],w["network"],w["token"],w["confidence"],now()))
        eid=self.db.evidence(case_id,site_id,"wallet_display",w,scope,url,page_id,w["confidence"])
        if kind in ("deposit","wallet","payment"):
            did=sid("dep"); self.db.execute("INSERT INTO deposit_options VALUES(?,?,?,?,?,?,?,?,?)",(did,site_id,page_id,wid,w["token"],w["network"],kind,scope,now()))
        self.db.execute("INSERT INTO relationships VALUES(?,?,?,?,?,?,?,?,?,?,?)",(sid("rel"),case_id,"website",site_id,"wallet",wid,"displays_wallet",eid,w["confidence"],f"Address displayed on {url}",now()))
        self.db.emit("wallet",wid,"wallet.observed",{"case_id":case_id,"website_id":site_id,"page_id":page_id,"evidence_id":eid})

    def _relationships(self,case_id,site_id):
        kinds="'analytics_ids','fingerprints','emails','phones','socials','dns','tls_certificate','ip_rdap'"
        current=self.db.all(f"SELECT * FROM evidence WHERE website_id=? AND kind IN ({kinds})",(site_id,))
        others=self.db.all(f"SELECT * FROM evidence WHERE website_id<>? AND kind IN ({kinds})",(site_id,))
        for a in current:
            av=self._leaves(json.loads(a["value_json"]))
            for b in others:
                if a["kind"]!=b["kind"]: continue
                shared=av & self._leaves(json.loads(b["value_json"]))
                shared={x for x in shared if len(x)>2 and x.lower() not in {"none","null","true","false"}}
                if shared:
                    sample=", ".join(sorted(shared)[:5])
                    self.db.execute("INSERT INTO relationships VALUES(?,?,?,?,?,?,?,?,?,?,?)",(sid("rel"),case_id,"website",site_id,"website",b["website_id"],"shared_"+a["kind"],a["id"],.8,f"Shared {a['kind']}: {sample}",now()))

    @staticmethod
    def _leaves(value):
        if isinstance(value,dict): return {str(x) for v in value.values() for x in Investigator._leaves(v)}
        if isinstance(value,list): return {str(x) for v in value for x in Investigator._leaves(v)}
        return {str(value)} if value is not None else set()

    async def _screenshots(self,case_id,site_id):
        pages=self.db.all("SELECT * FROM pages WHERE website_id=? AND auth_scope='public' ORDER BY CASE kind WHEN 'deposit' THEN 0 WHEN 'wallet' THEN 1 WHEN 'login' THEN 2 ELSE 3 END LIMIT 12",(site_id,))
        if not pages:return
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser=await p.chromium.launch(headless=True); context=await browser.new_context()
                if self.requests_remaining is not None:
                    async def budget_route(route):
                        try:self._take_request()
                        except RuntimeError:await route.abort();return
                        await route.continue_()
                    await context.route("**/*",budget_route)
                page=await context.new_page()
                for row in pages:
                    try:
                        await page.goto(row["url"],wait_until="domcontentloaded",timeout=20000)
                        path=self.db.root/"artifacts"/f"{row['id']}.png"; await page.screenshot(path=str(path),full_page=True)
                        sha=hashlib.sha256(path.read_bytes()).hexdigest()
                        self.db.evidence(case_id,site_id,"screenshot",{"page_url":row["url"],"page_kind":row["kind"]},"public",row["url"],row["id"],.95,str(path),sha)
                    except Exception: pass
                await browser.close()
        except Exception as e:
            self.db.evidence(case_id,site_id,"screenshot_error",{"error":str(e)},"software_derived",confidence=.7)
