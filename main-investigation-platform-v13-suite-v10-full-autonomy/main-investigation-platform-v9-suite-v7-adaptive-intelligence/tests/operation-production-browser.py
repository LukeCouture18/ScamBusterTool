"""Actual production bundle/Cloudflare worker, D1 migrations and browser smoke."""
import json,os,subprocess,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1];out=root/'verification'/'operation-v6';out.mkdir(parents=True,exist_ok=True)
settings=dict(line.split('=',1) for line in (root/'.dev.vars').read_text().splitlines() if '=' in line);keys=json.loads(settings['MODULE_API_KEYS']);base='http://127.0.0.1:8787'
log=(out/'production-server.log').open('w');server=subprocess.Popen(['node','scripts/start-production.mjs'],cwd=root,stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy());result={'ok':False,'checks':[],'errors':[]}
def call(path,body=None,module=None):
 headers={'Content-Type':'application/json'}
 if module:headers['x-api-key']=keys[module]
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
try:
 deadline=time.monotonic()+60
 while True:
  try:call('/api/v1/health');break
  except Exception:
   if server.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Production worker startup failed')
   time.sleep(.3)
 batch=json.loads(subprocess.check_output([os.environ.get('MIP_PYTHON','python'),'tests/site-bridge-synthetic.py'],cwd=root,env={**os.environ,'MIP_BATCH_JSON':'1'},text=True))['batch'];batch.pop('origin_job_id',None);batch['batch_id']='v6-production-source';batch=json.loads(json.dumps(batch).replace('synthetic.example','production-operation.example'))
 for rows in batch['records'].values():
  for row in rows:row['investigation_id']='v6-production-operation-inv'
 response=call('/api/v1/ingest/site_investigator',batch,'site_investigator');assert response.get('error_count',0)==0,response
 snap={'schema_version':'2.0','operation':{'external_id':'v6-production-operation','code':'PROD','name':'Production operation briefing','seed':'production-operation.example','investigation_id':'v6-production-operation-inv'},'members':[{'entity_type':'site','canonical_key':'production-operation.example','role':'seed','state':'live'}]}
 call('/api/v1/operations/sync',snap,'operation_hunter');brief=call('/api/v1/operations/v6-production-operation/intelligence');assert brief['edges'],brief
 edge=call('/api/v1/operations/v6-production-operation/intelligence/connections/'+brief['edges'][0]['relationship_id']);eid=edge['evidence'][0]['id']
 snap['model']={'hypotheses':[{'key':'public','question':'What explains the public deposit instruction?','hypotheses':[{'key':'reuse','label':'Shared public configuration','verdict':'viable'}],'evidence':[{'text':'Public deposit instruction','ratings':{'reuse':'C'},'evidenceIds':[eid]}],'discriminatingTest':'Seek independent contact and validated wallet evidence.'}]}
 call('/api/v1/operations/sync',snap,'operation_hunter');result['checks'].append('actual production worker accepted source records and operation model')
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1280,'height':900});page.on('pageerror',lambda e:result['errors'].append(str(e)))
  for route in ['/','/finder','/wallets','/logger','/reports','/hunter','/tasks','/operations/v6-production-operation']:
   r=page.goto(base+route,wait_until='networkidle');assert r.status==200,(route,r.status)
  expect(page.get_by_role('heading',name='Production operation briefing')).to_be_visible();page.get_by_role('button',name='Why connected:',exact=False).first.click();expect(page.get_by_role('heading',name='Why are these connected?')).to_be_visible()
  page.get_by_role('button',name='Inspect source',exact=False).first.click();expect(page.get_by_role('heading',name='Hypothesis source evidence')).to_be_visible();result['checks'].append('production hydration, map connection and hypothesis source evidence')
  page.screenshot(path=str(out/'production-desktop.png'),full_page=True);page.set_viewport_size({'width':375,'height':812});page.wait_for_timeout(200);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(out/'production-mobile.png'),full_page=True);result['checks'].append('production 375px operation briefing');assert not result['errors'],result['errors'];browser.close()
 result['ok']=True;(out/'production.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 server.terminate()
 try:server.wait(timeout=8)
 except subprocess.TimeoutExpired:server.kill();server.wait()
 log.close()
