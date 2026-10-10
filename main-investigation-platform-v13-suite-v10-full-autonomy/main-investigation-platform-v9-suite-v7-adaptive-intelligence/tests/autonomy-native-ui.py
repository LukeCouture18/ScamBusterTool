"""Native production/static UI smoke with real servers, empty state and navigation controls."""
import json,os,subprocess,tempfile,time,socket,shutil,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1];hunter=root.parent/'operation-hunter-v2.0';out=root/'verification'/'autonomy-v9';out.mkdir(exist_ok=True,parents=True)
work=Path(tempfile.mkdtemp(prefix='v9-native-'));processes=[];logs=[];result={'ok':False,'views':[],'errors':[],'scope':'Real native empty-state production/static UIs, navigation activation and 1280/1024/375 layouts. Data-dependent detail/dialog controls are not a full native control certification. Logger integration is checked by the separate rendered-browser acceptance; this native smoke does not cover an installed extension.'}
def port():
 s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();return p
def start(name,cmd,cwd,env):
 p=port();e={**os.environ,'NODE_ENV':'production','PORT':str(p),'SI_PORT':str(p),'SI_HOST':'127.0.0.1','HOST':'127.0.0.1','MAIN_PLATFORM_URL':'','WALLET_INVESTIGATOR_MODULE_KEY':'','FORM_SUBMITTER_MODULE_KEY':'','SITE_INVESTIGATOR_MODULE_KEY':'','SITE_FINDER_MODULE_KEY':'',**env};f=(out/('native-'+name+'.log')).open('w');logs.append(f);proc=subprocess.Popen(cmd,cwd=cwd,env=e,stdout=f,stderr=subprocess.STDOUT);processes.append(proc);base='http://127.0.0.1:'+str(p)
 end=time.monotonic()+40
 while True:
  try:
   with urllib.request.urlopen(base,timeout=2):break
  except Exception:
   if proc.poll() is not None or time.monotonic()>end:raise RuntimeError(name+' failed startup')
   time.sleep(.1)
 return base
try:
 specs=[]
 for name in ['wallet-investigator','form-submitter']:
  source=root/'integrations'/name;cwd=work/name;cwd.mkdir();(cwd/'dist').symlink_to(source/'dist');(cwd/'node_modules').symlink_to(source/'node_modules')
  if name=='form-submitter':shutil.copytree(source/'scripts',cwd/'scripts');(cwd/'public').mkdir()
  specs.append((name,start(name,['node',str(source/'dist'/'server.cjs')],cwd,{})))
 specs.append(('hunter',start('hunter',['node','--import',str(hunter/'node_modules'/'tsx'/'dist'/'loader.mjs'),str(hunter/'server.ts'),'--production'],work,{'HUNTER_DATA_DIR':str(work/'hunter')})))
 sf=root/'integrations'/'site-finder-v07';sfcode="from pathlib import Path;from app import config;config.DB_PATH=Path('"+str(work/'finder.sqlite')+"');config.DATA_DIR=Path('"+str(work)+"');from app.review.server import app;import os;app.run(host='127.0.0.1',port=int(os.environ['PORT']),threaded=True)"
 specs.append(('finder',start('finder',['python3','-c',sfcode],sf,{})))
 si=root/'integrations'/'site-investigator-v01';specs.append(('site-investigator',start('site-investigator',['python3','run.py'],si,{'SI_DATA_DIR':str(work/'si')})))
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True)
  for name,base in specs:
   page=browser.new_page();
   if name=='form-submitter':page.add_init_script("localStorage.setItem('crypto_scam_submitter_settings_v1_1',JSON.stringify({isConfigured:true,username:'native-audit-fixture',teamInviteCode:'fixture',autoSubmitGlobalEnabled:false,strictEVMMode:true,enableDuplicateGuard:true,defaultSubmissionMode:'VALIDATED_PREFILL'}));")
   page.on('pageerror',lambda e,n=name:result['errors'].append({'tool':n,'error':str(e)}));page.on('dialog',lambda d:d.dismiss())
   page.goto(base,wait_until='domcontentloaded');page.wait_for_timeout(400)
   cancel=page.get_by_role('button',name='Cancel',exact=True)
   if cancel.count() and cancel.first.is_visible():cancel.first.click()
   controls=page.locator('nav a,nav button,aside a,aside button,[role=tab],.hx-nav a,.hx-nav button');navs=[]
   for el in controls.all():
    if el.is_visible() and el.is_enabled():navs.append({'text':' '.join(el.inner_text().split()),'href':el.get_attribute('href'),'id':el.get_attribute('id')})
   views=[('default',base)]
   for nav in navs:
    if nav['href'] and (nav['href'].startswith('http') or nav['href'].startswith('#')):continue
    page.set_viewport_size({'width':1280,'height':900});page.goto(base,wait_until='domcontentloaded');page.wait_for_timeout(200)
    cancel=page.get_by_role('button',name='Cancel',exact=True)
    if cancel.count() and cancel.first.is_visible():cancel.first.click()
    try:
     if nav.get('id'):page.locator('#'+nav['id']).click(timeout=3000)
     elif nav['href']:page.locator('a[href="'+nav['href']+'"]').first.click(timeout=3000)
     elif nav['text']:page.get_by_role('button',name=nav['text'],exact=True).first.click(timeout=3000)
     else:continue
     page.wait_for_timeout(100);views.append((nav['text'],page.url))
     for width in [1280,1024,375]:
      page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(50);overflow=page.evaluate('document.documentElement.scrollWidth-innerWidth');result['views'].append({'tool':name,'view':nav['text'],'width':width,'overflow':overflow,'controls':page.locator('button,a,summary,input,select').count()})
      if overflow>1:result['errors'].append({'tool':name,'view':nav['text'],'width':width,'overflow':overflow})
    except Exception as e:result['errors'].append({'tool':name,'view':nav['text'],'error':str(e)[:240]})
   page.goto(base,wait_until='domcontentloaded');page.wait_for_timeout(150)
   for width in [1280,1024,375]:
    page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(50);overflow=page.evaluate('document.documentElement.scrollWidth-innerWidth');result['views'].append({'tool':name,'view':'default','width':width,'overflow':overflow});page.screenshot(path=str(out/('native-'+name+'-'+str(width)+'.png')),full_page=True)
    if overflow>1:result['errors'].append({'tool':name,'view':'default','width':width,'overflow':overflow})
   page.close()
  browser.close()
 result['ok']=not result['errors'];(out/'native-ui.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));assert result['ok'],result['errors']
finally:
 for proc in processes:
  proc.terminate()
  try:proc.wait(timeout=5)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 for log in logs:log.close()
 shutil.rmtree(work,ignore_errors=True)
