"""Rendered production data hook/context: delayed transport and context changes."""
import json,sys,time,threading
from collections import Counter
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
starts=[];search_reads=[]
ROOT=Path(__file__).resolve().parents[1];counts=Counter();script=Path(sys.argv[1]).read_bytes()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path.startswith('/api/v1/autonomy/search/'):
            time.sleep(.1);identity=self.path.rsplit('/',1)[-1];search_reads.append(identity);content=json.dumps({'id':identity,'state':'Finding site'}).encode();kind='application/json'
        elif self.path=='/app.js':content=script;kind='text/javascript'
        elif self.path.startswith('/fixture/'):
            name=self.path.split('/')[-1];counts[name]+=1;time.sleep(1.2 if name=='a' else .55 if name=='slow' else .03);content=json.dumps({'value':name.upper()}).encode();kind='application/json'
        else:content=b'<html><body><div id="root"></div><script>sessionStorage.setItem("mip.context","null")</script><script src="/app.js"></script></body></html>';kind='text/html'
        try:self.send_response(200);self.send_header('Content-Type',kind);self.end_headers();self.wfile.write(content)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));starts.append(body['request_id']);status=503 if len(starts)==1 else 200
        content=json.dumps({'error':{'message':'Lost acknowledgement fixture'}} if status==503 else {'id':body['request_id'] if len(starts)==2 else 'existing-search-0001','state':'Finding site'}).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(content)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();errors=[]
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True);page=browser.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.add_init_script("Object.defineProperty(window,'localStorage',{value:{getItem(){throw Error('storage denied')},setItem(){throw Error('storage denied')},removeItem(){throw Error('storage denied')}}})");page.goto('http://127.0.0.1:'+str(server.server_port)+'/?site=url.example')
        expect(page.locator('#context')).to_contain_text('url.example');expect(page.locator('#contextLink')).to_have_attribute('href','/finder?site=url.example')
        page.get_by_role('button',name='Switch B').click();expect(page.locator('#result')).to_have_text('B');page.wait_for_timeout(1300);expect(page.locator('#result')).to_have_text('B')
        page.get_by_role('button',name='Slow',exact=True).click();expect(page.locator('#result')).to_have_text('SLOW');page.wait_for_timeout(600);assert 1<=counts['slow']<=3,counts
        page.get_by_role('button',name='Empty',exact=True).click();expect(page.locator('#result')).to_have_text('loading');before=dict(counts);page.wait_for_timeout(350);assert dict(counts)==before
        page.get_by_role('button',name='Set context').click();expect(page.locator('#context')).to_contain_text('next.example');expect(page.locator('#contextLink')).to_have_attribute('href','/finder?site=next.example&wallet=ethereum%3Afixture')
        page.get_by_role('button',name='Clear context').click();expect(page.locator('#context')).to_have_text('{}');page.get_by_role('button',name='Start Investigation',exact=True).click();expect(page.get_by_text('Lost acknowledgement fixture')).to_be_visible();page.get_by_role('button',name='Start Investigation',exact=True).click();expect(page.get_by_role('button',name='Finding site…')).to_be_disabled();assert len(starts)==2 and starts[0]==starts[1],starts;assert not errors,errors;page.close()
        # Main can coalesce a new request onto an already-active search. Persist its
        # returned canonical ID, then recover it after a genuine browser reload.
        page=browser.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://127.0.0.1:'+str(server.server_port))
        page.get_by_role('button',name='Start Investigation',exact=True).click();expect(page.get_by_role('button',name='Finding site…')).to_be_disabled()
        assert starts[-1]!='existing-search-0001';assert page.evaluate("localStorage.getItem('mip.startRequest')")=='existing-search-0001'
        page.reload();expect(page.get_by_role('button',name='Finding site…')).to_be_disabled();page.wait_for_timeout(200);assert search_reads[-1]=='existing-search-0001';assert not errors,errors;browser.close()
    result={'ok':True,'checks':['malformed stored context','URL context precedence','stale response rejected','slow polling completes without starvation','empty URL clears previous data and stops requests','context set/clear updates links','denied browser storage','lost Start acknowledgement preserves retry identity','coalesced active search saves canonical identity and reloads it'],'requests':dict(counts),'errors':errors};(ROOT/'verification/v10/request-lifecycle.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:server.shutdown();server.server_close()
