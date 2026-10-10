import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
url=os.environ['OPERATION_UI_URL'];shots=Path(os.environ['OPERATION_UI_SHOTS']);checks=[];errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 context=browser.new_context(viewport={'width':1280,'height':900})
 context.add_cookies([{'name':'mip_ui','value':'all','url':url}])
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(url+'/operations/ui-operation');expect(page.get_by_role('heading',name='Cautious operation briefing')).to_be_visible()
 page.get_by_text('Advanced: adaptive decisions and operation accounting',exact=True).click();expect(page.get_by_role('heading',name='What this operation contains')).to_be_visible();expect(page.get_by_text('1 site · proposed')).to_be_visible()
 page.get_by_role('button',name='Why connected: ui.example and ethereum:0x1111111111111111111111111111111111111111',exact=True).click();expect(page.get_by_role('heading',name='Why are these connected?')).to_be_visible();expect(page.get_by_text('Public deposit instruction',exact=True).first).to_be_visible()
 assert page.get_by_role('link',name='Original public source').first.get_attribute('href')=='https://ui.example/deposit';checks.append('stored connection evidence and public-source link')
 page.get_by_text('Advanced: original Hunter hypotheses',exact=True).click();page.get_by_role('button',name='Inspect source ui-evidence').click();expect(page.get_by_role('heading',name='Hypothesis source evidence')).to_be_visible();checks.append('hypothesis evidence clickthrough')
 for view in ['Wallet','Infrastructure','Timeline','Site']:
  page.get_by_role('button',name=view,exact=True).click();page.wait_for_timeout(200)
 checks.append('all four operation views')
 page.screenshot(path=str(shots/'desktop.png'),full_page=True)
 page.set_viewport_size({'width':375,'height':812});page.wait_for_timeout(200)
 overflow=page.evaluate('document.documentElement.scrollWidth-window.innerWidth');assert overflow<=1,(overflow,page.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,90),width:e.getBoundingClientRect().width}))"))
 page.screenshot(path=str(shots/'mobile.png'),full_page=True);checks.append('375px page has no document overflow')
 page.get_by_role('button',name='Use as review target',exact=True).click()
 expect(page.get_by_label('Boundary decision reason')).to_be_visible()
 expect(page.get_by_label('Target operation identifier')).to_have_value('ui-review-target')
 assert not page.request.get(url+'/api/v1/operations/ui-operation/intelligence').json()['decisions']
 checks.append('overlap review target opens the form without changing boundaries')
 page.get_by_label('Select ui.example for boundary review').check();page.get_by_label('Boundary decision reason').fill('Reviewed separate public deployment boundary.')
 page.get_by_role('button',name='Propose split',exact=True).click();expect(page.get_by_text('split proposal',exact=True)).to_be_visible()
 assert next(e for e in page.request.get(url+'/api/v1/operations/ui-operation/intelligence').json()['entities'] if e['canonical_key']=='ui.example')['association']!='excluded'
 checks.append('proposal alone preserves boundary')
 page.get_by_role('button',name='Confirm this reviewed boundary decision').click();expect(page.get_by_text('split proposal',exact=True)).not_to_be_visible();page.reload();expect(page.get_by_role('heading',name='Cautious operation briefing')).to_be_visible();checks.append('explicit reviewed split and refresh')
 assert not errors,errors
 browser.close()
print(json.dumps({'ok':True,'checks':checks,'errors':errors,'scope':'Real app page/components and API, SSR/hydration harness with file-backed SQLite. Production worker smoke is separate.'}))
