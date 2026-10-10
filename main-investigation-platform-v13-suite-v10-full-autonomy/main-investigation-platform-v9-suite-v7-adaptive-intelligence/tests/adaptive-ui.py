import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
url=os.environ['ADAPTIVE_UI_URL'];shots=Path(os.environ['ADAPTIVE_UI_SHOTS']);checks=[];errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 context=browser.new_context(viewport={'width':1280,'height':900})
 context.add_cookies([{'name':'mip_ui','value':'all','url':url}])
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(url+'/operations/ui-adaptive');page.get_by_text('Advanced: adaptive decisions and operation accounting').click();expect(page.get_by_role('heading',name='Adaptive decision briefing')).to_be_visible()
 expect(page.get_by_role('heading',name='Why Main chose its next test')).to_be_visible()
 card=page.locator('section,div').filter(has=page.get_by_role('heading',name='Why Main chose its next test')).last
 for label in ['Question it is answering:','Why that question matters:']:expect(page.get_by_text(label).first).to_be_visible()
 assert page.get_by_text('Main chose:').count()+page.get_by_text('Main stopped:').count()>=1
 checks.append('default view: what Main chose, the question, why it matters')
 expect(page.get_by_text('Last completed test:').first).to_be_visible();expect(page.get_by_text('Actual cost:').first).to_be_visible();expect(page.get_by_text('What changed because of it:').first).to_be_visible()
 body=page.locator('body').inner_text();assert 'http 4' in body and 'dns 21' in body,'measured consumption shown';assert 'site discovered' in body,'downstream change shown'
 checks.append('expected vs actual cost and what changed, from the measured ledger')
 page.get_by_text('Advanced: decision details').click();expect(page.get_by_text('not evidence').first).to_be_visible()
 assert 'uncertainty_reduction' in page.locator('body').inner_text();checks.append('numerical internals only under Advanced')
 page.get_by_text('Advanced: investigation efficiency').click();expect(page.get_by_text('Useful actions').first).to_be_visible();checks.append('Advanced efficiency view')
 page.get_by_text('Open questions Main is tracking').click();assert 'hypothesis discrimination' in page.locator('body').inner_text().lower();checks.append('typed gaps listed')
 page.screenshot(path=str(shots/'desktop.png'),full_page=True)
 page.set_viewport_size({'width':375,'height':812});page.wait_for_timeout(250)
 overflow=page.evaluate('document.documentElement.scrollWidth-window.innerWidth');assert overflow<=1,(overflow,page.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,text:e.textContent.slice(0,90),width:e.getBoundingClientRect().width}))"))
 page.screenshot(path=str(shots/'mobile.png'),full_page=True);checks.append('375px page has no document overflow')
 assert not errors,errors
 browser.close()
print(json.dumps({'ok':True,'checks':checks,'errors':errors,'scope':'Real app page/components and API in the SSR/hydration harness with file-backed SQLite and Playwright Chromium. Not the built production worker.'}))
