"""Production build + actual worker and browser; portable local release smoke test."""
import json, os, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
log=(root/'production-browser-server.log').open('w')
process=subprocess.Popen(['node','scripts/start-production.mjs'],cwd=root,stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy())
result={'checks':[],'errors':[]}
try:
    deadline=time.time()+60
    while True:
        try:
            urllib.request.urlopen('http://127.0.0.1:8787/api/v1/health',timeout=1).read();break
        except Exception:
            if process.poll() is not None or time.time()>deadline:raise RuntimeError('Production server failed to start; inspect production-browser-server.log')
            time.sleep(.3)
    at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    event={'id':'production-browser-observation','type':'wallet.observation','schemaVersion':'2.0.0','occurredAt':at,'source':'CryptoWalletLogger','sourceVersion':'0.9.0','payload':{'observationId':'production-browser-observation','address':'0x'+'1'*40,'family':'evm','candidateNetworks':['ethereum'],'networkHint':{'network':'ethereum','source':'selected-option'},'context':{'class':'deposit','confidence':.95,'cues':['deposit address'],'negativeCues':[],'section':'Deposit ETH','snippet':'Your deposit address'},'detection':{'method':'text'},'page':{'domain':'production-qa.example','url':'https://production-qa.example/deposit'},'firstSeen':at,'lastSeen':at,'seenCount':1}}
    request=urllib.request.Request('http://127.0.0.1:8787/api/v1/compat/logger',data=json.dumps(event).encode(),headers={'Content-Type':'application/json','x-api-key':'production-fixture-logger'})
    response=urllib.request.urlopen(request);assert response.status in (200,202);response.read()
    with sync_playwright() as p:
        opts={'headless':True}
        if os.environ.get('MIP_BROWSER_EXECUTABLE'):opts['executable_path']=os.environ['MIP_BROWSER_EXECUTABLE']
        browser=p.chromium.launch(**opts);page=browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:result['errors'].append(str(e)))
        for route in ['/','/finder','/wallets','/logger','/reports','/hunter','/tasks','/api/v1/health']:
            r=page.goto('http://127.0.0.1:8787'+route,wait_until='networkidle');assert r.status==200,(route,r.status);result['checks'].append({'route':route,'status':r.status})
        page.goto('http://127.0.0.1:8787/tasks',wait_until='networkidle');page.get_by_role('heading',name='Needs You').wait_for()
        page.screenshot(path=str(root/'production-needs-you.png'),full_page=True)
        page.goto('http://127.0.0.1:8787/finder?site=production-qa.example',wait_until='networkidle');page.get_by_role('heading',name='Investigation briefing').wait_for();page.locator('[data-director]').wait_for()
        result['checks'].append({'populated_director_briefing':True})
        page.set_viewport_size({'width':375,'height':812});page.wait_for_timeout(300)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'Mobile director briefing overflows'
        page.screenshot(path=str(root/'production-director-mobile.png'),full_page=True);result['checks'].append({'mobile_director_no_overflow':True})
        assert not result['errors'],result['errors'];browser.close()
    (root/'production-browser.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
    process.terminate()
    try:process.wait(timeout=8)
    except subprocess.TimeoutExpired:process.kill();process.wait()
    log.close()
