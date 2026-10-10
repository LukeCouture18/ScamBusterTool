"""Actual Chromium DOM execution of isolated fill function. This is not an installed extension test."""
import asyncio,json
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
SCRIPT=(ROOT/'integrations/crypto-wallet-logger-v08/account-fill.js').read_text()
CREDS={'username':'fixture-user@example.com','password':'fixture-private-password','code':'123456'}
async def main():
    results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context()
        page=await context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        async def route(r):await r.fulfill(status=200,content_type='text/html',body='<body></body>')
        await page.route('https://site.example/**',route)
        await page.goto('https://site.example/login')
        cases=[
            ('login','<form><input name="email"><input type="password" autocomplete="current-password"><button>Submit</button></form>','login',2),
            ('signup','<form><input name="username"><input type="password" autocomplete="new-password"><input type="password" name="confirmPassword"></form>','signup',3),
            ('code','<form><input autocomplete="one-time-code"></form>','code',1),
            ('new-password-login','<form><input name="email"><input type="password" autocomplete="new-password"></form>','login',0),
            ('duplicate-forms','<form><input name="email"><input type="password"></form><form><input name="username"><input type="password"></form>','login',0),
            ('ambiguous-passwords','<form><input name="username"><input type="password"><input type="password"></form>','login',0),
            ('disabled','<form><input name="username" disabled><input type="password"></form>','login',0),
            ('readonly','<form><input name="username" readonly><input type="password"></form>','login',0),
            ('hidden','<form><input name="email" style="display:none"><input type="password"></form>','login',0),
            ('hidden-extra','<form><input name="email"><input type="password"><input name="username" hidden></form>','login',2),
            ('wrong-origin','<form><input name="email"><input type="password"></form>','login',0),
        ]
        for name,html,mode,expected in cases:
            await page.set_content(html)
            await page.evaluate("window.submits=0;window.changes=0;document.addEventListener('submit',e=>{submits++;e.preventDefault()});document.addEventListener('input',()=>changes++);")
            await page.evaluate(SCRIPT)
            result=await page.evaluate('([origin,c,mode])=>loggerFillAccount(origin,c,mode)',['https://wrong.example' if name=='wrong-origin' else 'https://site.example',CREDS,mode])
            assert result['filled']==expected,(name,result)
            assert await page.evaluate('submits')==0
            if expected:assert await page.evaluate('changes')>=expected
            else:assert await page.evaluate('Array.from(document.querySelectorAll("input")).every(e=>!e.value)')
            results.append({'case':name,'filled':expected,'submissions':0})
        await page.set_content('<iframe src="https://site.example/child"></iframe>')
        frame=page.frames[-1]
        await frame.wait_for_load_state()
        await frame.evaluate('document.body.innerHTML="<form><input name=email><input type=password></form>"')
        await frame.evaluate(SCRIPT)
        result=await frame.evaluate('(c)=>loggerFillAccount(location.origin,c,"login")',CREDS)
        assert result['filled']==0,result
        results.append({'case':'iframe','filled':0,'submissions':0})
        assert errors==[],errors
        await browser.close()
    out={'ok':True,'scope':'Rendered Chromium DOM, production fill function; no installed extension or browser API isolation certification','cases':results,'page_errors':errors}
    path=ROOT/'verification/v10/account-fill.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(out,indent=2));print(json.dumps(out))
asyncio.run(main())
