import asyncio, hashlib, json, re
from pathlib import Path
from urllib.parse import urlparse
from .db import now, sid
from .detectors import wallets, page_kind, parse_page

BLOCK=re.compile(r"(?:withdraw|deposit|transfer|trade|buy|purchase|pay|send|swap|sell|stake|confirm)",re.I)
CHALLENGE=re.compile(r"captcha|recaptcha|hcaptcha|verification code|two.factor|2fa|mfa|one.time|check your email",re.I)

class AuthenticatedInvestigator:
    def __init__(self,db): self.db=db

    async def run(self,case_id,site_id,job_id,login_url,username,password,manual=False):
        site=self.db.one("SELECT * FROM websites WHERE id=?",(site_id,)); origin=urlparse(site["start_url"]); allowed=origin.netloc.lower()
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser=await p.chromium.launch(headless=not manual); context=await browser.new_context(); page=await context.new_page()
                async def guard(route):
                    req=route.request
                    if req.method not in ("GET","HEAD","OPTIONS") and BLOCK.search(req.url):
                        self.db.timeline(case_id,site_id,"financial_action.blocked","authenticated",f"Blocked {req.method} request",{"url":req.url}); await route.abort()
                    elif urlparse(req.url).netloc.lower()!=allowed and req.is_navigation_request(): await route.abort()
                    else: await route.continue_()
                await page.route("**/*",guard)
                await page.goto(login_url,wait_until="domcontentloaded",timeout=30000)
                body=(await page.locator("body").inner_text())[:20000]
                if CHALLENGE.search(body):
                    self._job(job_id,"needs_manual",35,"CAPTCHA, MFA, or email verification detected. Continue manually in the browser.")
                    if not manual: await browser.close(); return
                user=page.locator('input[type="email"], input[name*="user" i], input[name*="email" i]').first
                pwd=page.locator('input[type="password"]').first
                if await user.count() and await pwd.count():
                    await user.fill(username); await pwd.fill(password)
                    submit=page.locator('button[type="submit"], input[type="submit"]').first
                    if await submit.count(): await submit.click()
                    else: await pwd.press("Enter")
                    await page.wait_for_timeout(2500)
                else:
                    self._job(job_id,"needs_manual",30,"Login fields were not recognized. Continue manually.")
                    if not manual: await browser.close(); return
                body=(await page.locator("body").inner_text())[:30000]
                if CHALLENGE.search(body):
                    self._job(job_id,"needs_manual",45,"Authentication challenge detected. Complete it manually; no bypass attempted.")
                    if not manual: await browser.close(); return
                failed=bool(re.search(r"invalid|incorrect|login failed|try again",body,re.I))
                still_password=await page.locator('input[type="password"]').count()>0
                if failed or still_password:
                    self._job(job_id,"failed",100,"Login was not successful."); await browser.close(); return
                self.db.timeline(case_id,site_id,"login.succeeded","authenticated","Normal user-authorized login succeeded",{"url":page.url})
                self._job(job_id,"running",60,"Login succeeded; mapping authorized pages")
                urls={page.url}
                for a in await page.locator("a[href]").all():
                    u=await a.get_attribute("href")
                    if u:
                        from urllib.parse import urljoin
                        u=urljoin(page.url,u)
                        if urlparse(u).netloc.lower()==allowed and re.search(r"deposit|wallet|payment|invest|withdraw|transaction|history|account|dashboard",u,re.I): urls.add(u)
                for i,u in enumerate(list(urls)[:25]):
                    await page.goto(u,wait_until="domcontentloaded",timeout=30000); await page.wait_for_timeout(500)
                    html=await page.content(); title,text,_,_=parse_page(page.url,html); kind=page_kind(page.url,text)
                    pid=self._page(site_id,page.url,kind,title,html)
                    artifact=self.db.root/"artifacts"/f"{pid}.png"; await page.screenshot(path=str(artifact),full_page=True)
                    sha=hashlib.sha256(artifact.read_bytes()).hexdigest()
                    self.db.evidence(case_id,site_id,"authenticated_page",{"title":title,"kind":kind,"important_text":text[:12000]},"authenticated",page.url,pid,.95,str(artifact),sha)
                    for w in wallets(text):
                        from .investigator import Investigator
                        Investigator(self.db)._wallet(case_id,site_id,pid,w,"authenticated",page.url,kind)
                    self._job(job_id,"running",60+int(35*(i+1)/max(1,len(urls))),f"Captured {i+1}/{len(urls)} authorized pages")
                await browser.close(); self._job(job_id,"completed",100,"Authenticated mapping complete")
        except Exception as e: self._job(job_id,"failed",100,str(e)[:500])

    def _page(self,site_id,url,kind,title,html):
        old=self.db.one("SELECT id FROM pages WHERE website_id=? AND url=? AND auth_scope='authenticated'",(site_id,url))
        if old:return old["id"]
        pid=sid("page"); t=now(); self.db.execute("INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?,?,?)",(pid,site_id,url,kind,title,200,"authenticated",hashlib.sha256(html.encode()).hexdigest(),t,t)); return pid

    def _job(self,jid,status,progress,message): self.db.execute("UPDATE jobs SET status=?,progress=?,message=?,updated_at=? WHERE id=?",(status,progress,message,now(),jid))

