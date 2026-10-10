"""Real Finder and Site Investigator workers over a held-out synthetic public transport.
Only transport is replaced. No candidate, site, wallet or evidence is inserted into Main here.
Logger's unchanged classifier reads rendered DOM; the extension lifecycle is tested separately.
"""
import asyncio, importlib, json, logging, os, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
ROOT=Path(__file__).resolve().parents[1]
cfg=json.loads(os.environ['OPERATION_HIDDEN_CONFIG'])
corpus=json.loads(Path(cfg['corpus']).read_text())
requests=[]

def public_response(url):
    requests.append(url)
    p=urlparse(url);host=p.hostname or '';query=unquote(url)
    if host in corpus['pages']:
        page=corpus['pages'][host]
        if page.get('dead'):return 404,{'content-type':'text/html'},b'Not found'
        return 200,{'content-type':'text/html; charset=utf-8'},page['html'].encode()
    if host=='crt.sh':
        sites=list(corpus['pages']) if cfg.get('discover_all') else []
        for domain,page in corpus['pages'].items():
            if domain in query:sites.extend([domain]+page.get('links',[]))
        from datetime import datetime,timezone
        observed_at=datetime.now(timezone.utc).isoformat() if cfg.get('discover_all') else '2026-09-01T00:00:00Z'
        return 200,{'content-type':'application/json'},json.dumps([{'name_value':d,'entry_timestamp':observed_at} for d in sorted(set(sites))]).encode()
    if host=='rdap.org':return 200,{'content-type':'application/json'},json.dumps({'events':[{'eventAction':'registration','eventDate':'2026-08-15T00:00:00Z'}],'status':['active'],'nameservers':[{'ldhName':'ns1.public-cdn.example'}]}).encode()
    if host=='urlscan.io':
        sites=[]
        for domain,page in corpus['pages'].items():
            if domain in query:sites.extend(page.get('links',[]))
        return 200,{'content-type':'application/json'},json.dumps({'results':[{'page':{'domain':d,'url':'https://'+d},'task':{'url':'https://'+d},'_id':d} for d in sorted(set(sites))],'has_more':False}).encode()
    return 200,{'content-type':'application/json'},b'[]'

async def browser_context(browser):
    context=await browser.new_context()
    async def route(r):
        status,headers,body=public_response(r.request.url)
        await r.fulfill(status=status,headers=headers,body=body)
    await context.route('**/*',route)
    return context

cmd=sys.argv[1]
if cmd=='finder':
    sf=ROOT/'integrations'/'site-finder-v07';sys.path.insert(0,str(sf));os.chdir(sf);logging.disable(logging.CRITICAL)
    import app.config as config
    config.DB_PATH=Path(cfg['dir'])/'finder.db'
    import app.db as db
    importlib.reload(db);db.init_db()
    from app.v2 import engine,netio,store
    from app.integration.v4.client import PlatformClient
    from app.integration.v4 import jobs,sync
    from benchmark.simnet import SimNet,installed
    class PublicWorld:
        def resolve(self,host):
            requests.append('dns://'+host)
            return '104.21.12.34' if host in corpus['pages'] else None
        def nameservers(self,host):return ['ns1.public-cdn.example','ns2.public-cdn.example'] if host in corpus['pages'] else []
        def http(self,url):
            status,headers,body=public_response(url)
            return {'status':status,'headers':headers,'body':body,'redirect':None,'error':None}
    world=PublicWorld();net=SimNet(world)
    import socket
    original=socket.create_connection;synthetic=net.create_connection
    net.create_connection=lambda address,*a,**kw:original(address,*a,**kw) if address[0] in ('127.0.0.1','localhost','::1') else synthetic(address,*a,**kw)
    client=PlatformClient(base_url=cfg['url'],api_key=cfg['key']);client.register()
    with installed(net):
        engine.configure_for_benchmark(nameserver_fn=world.nameservers)
        ran=jobs.claim_and_run_one(client)
        delivered=sync.sync_until_drained(client)
    candidates=[]
    for domain in corpus['pages']:
        c=store.get(domain)
        if c:candidates.append({'domain':domain,'status':c['status'],'p':c.get('p'),'gate':c.get('gate'),'suppressed':c.get('details',{}).get('suppressed'),'keys':store.keys_for(domain)})
    out={'ran':ran,'sync':delivered,'requests':requests,'costs':net.counts,'candidates':candidates}
elif cmd=='investigator':
    sys.path.insert(0,str(ROOT/'integrations'/'site-investigator-v01'));sys.path.insert(0,str(ROOT/'integrations'))
    os.environ.update({'MAIN_PLATFORM_URL':cfg['url'],'SITE_INVESTIGATOR_MODULE_KEY':cfg['key'],'SI_MAX_PAGES':'6','SI_REQUEST_TIMEOUT':'2'})
    import httpx,dns.resolver
    original_client=httpx.AsyncClient
    async def handler(request):
        status,headers,body=public_response(str(request.url));return httpx.Response(status,headers=headers,content=body)
    class TransportClient(original_client):
        def __init__(self,*args,**kw):kw['transport']=httpx.MockTransport(handler);super().__init__(*args,**kw)
    httpx.AsyncClient=TransportClient
    def resolve(domain,typ,**kw):
        requests.append('dns://'+domain+'/'+typ)
        return ['104.21.12.34'] if typ=='A' else ['ns1.public-cdn.example'] if typ=='NS' else []
    dns.resolver.resolve=resolve
    from siteinvestigator.db import Database
    from siteinvestigator.investigator import Investigator
    def certificate(domain,ctx):
        requests.append('tls://'+domain+':443')
        return {'subjectAltName':[('DNS',domain)],'issuer':[['CN','Public CDN']], 'serialNumber':'synthetic-'+domain}
    Investigator._cert=staticmethod(certificate)
    # Real screenshot pipeline; only browser HTTP transport is routed to the public corpus.
    from playwright.async_api import BrowserType
    original_launch=BrowserType.launch
    async def launch(self,*a,**kw):
        if cfg.get('chromium'):kw['executable_path']=cfg['chromium']
        browser=await original_launch(self,*a,**kw)
        original_context=browser.new_context
        async def context(*a,**kw):
            c=await original_context(*a,**kw)
            async def route(r):
                status,headers,body=public_response(r.request.url);await r.fulfill(status=status,headers=headers,body=body)
            await c.route('**/*',route);return c
        browser.new_context=context
        return browser
    BrowserType.launch=launch
    from site_investigator_bridge import Platform
    database=Database(Path(cfg['dir'])/'investigator');ran=Platform().run_once(database)
    out={'ran':ran,'sites':database.all('SELECT normalized_domain,status FROM websites'),'evidence':len(database.all('SELECT id FROM evidence')),'requests':requests}
elif cmd=='logger':
    from playwright.async_api import async_playwright
    async def scan():
        async with async_playwright() as p:
            args={'headless':True}
            if cfg.get('chromium'):args['executable_path']=cfg['chromium']
            browser=await p.chromium.launch(**args);context=await browser_context(browser);page=await context.new_page()
            await page.goto('https://'+cfg['domain']+'/deposit',wait_until='domcontentloaded')
            await page.add_script_tag(path=str(ROOT/'integrations'/'crypto-wallet-logger-v08'/'wallet-core.js'))
            found=await page.evaluate('''() => {const body=document.body.innerText, heading=document.querySelector('h1')?.innerText||'';return WalletCore.extractAll(body).map(hit=>({...hit,context:WalletCore.classifyContext({address:hit.address,heading,local:body,section:body,flags:{soleAddress:WalletCore.extractAll(body).length===1}})}));}''')
            await browser.close();return found
    out={'domain':cfg['domain'],'observations':asyncio.run(scan()),'requests':requests,'classifier':'unchanged wallet-core.js; rendered DOM; extension lifecycle not substituted'}
else:raise ValueError(cmd)
print(json.dumps(out,default=str))
