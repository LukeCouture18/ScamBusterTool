import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
url=os.environ['ADAPTIVE_UI_URL'];shots=Path(os.environ['ADAPTIVE_UI_SHOTS']);errors=[];checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True);ctx=b.new_context(viewport={'width':1280,'height':900});ctx.add_cookies([{'name':'mip_ui','value':'all','url':url}]);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(url+'/operations/ui-adaptive');expect(page.get_by_role('heading',name='Current understanding')).to_be_visible();expect(page.get_by_role('heading',name='Key findings')).to_be_visible();expect(page.get_by_role('heading',name='Leading hypotheses')).to_be_visible();expect(page.get_by_role('heading',name='Current test',exact=True)).to_be_visible()
 assert 'uncertainty_reduction' not in page.locator('body').inner_text();checks.append('Default briefing answers analyst questions without score internals')
 page.get_by_text('Why do you think this?',exact=True).first.click();expect(page.get_by_role('heading',name='Supporting observations').first).to_be_visible();checks.append('Provenance-backed explanation and alternatives')
 page.get_by_text('What could prove this wrong?',exact=True).first.click();expect(page.get_by_text('Strongly contradicts it:',exact=True).first).to_be_visible();checks.append('Falsification prediction and bounded test')
 page.get_by_role('button',name='Inspect source',exact=True).first.click();expect(page.get_by_role('heading',name='Hypothesis source evidence')).to_be_visible();checks.append('Evidence source clickthrough')
 page.get_by_text('Advanced: adaptive decisions and operation accounting',exact=True).click();expect(page.get_by_role('heading',name='Why Main chose its next test')).to_be_visible();page.get_by_text('Advanced: decision details',exact=True).click();assert 'uncertainty_reduction' in page.locator('body').inner_text();checks.append('Existing v7 diagnostics retained under Advanced')
 page.screenshot(path=str(shots/'desktop.png'),full_page=True);page.set_viewport_size({'width':375,'height':812});page.wait_for_timeout(150);assert page.evaluate('document.documentElement.scrollWidth-window.innerWidth')<=1;page.screenshot(path=str(shots/'mobile.png'),full_page=True);checks.append('375px responsive page')
 assert not errors,errors;b.close()
print(json.dumps({'ok':True,'checks':checks,'errors':errors,'scope':'Real components and APIs in the SSR/hydration harness; production worker is checked separately.'}))
