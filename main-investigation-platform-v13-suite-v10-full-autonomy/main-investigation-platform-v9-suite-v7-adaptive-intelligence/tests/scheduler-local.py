import contextlib,json,sys,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'))
from local_scheduler import supply,tick
seen=[]
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  seen.append((self.path,self.headers.get('OAI-Sites-Authorization')))
  self.send_response(200);self.end_headers();self.wfile.write(b'{}')
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
 result=tick(f'http://127.0.0.1:{server.server_address[1]}','synthetic-site-token')
 assert len(result)==2
 assert {v[0] for v in seen}=={'/api/v1/feedback/dispatch','/api/v1/monitoring/tick'}
 assert all(v[1]=='Bearer synthetic-site-token' for v in seen)
 # v2 inbox supply is a separate call, so it cannot break the v6.1 maintenance tick above.
 seen.clear();inbox=supply(f'http://127.0.0.1:{server.server_address[1]}','synthetic-site-token')
 assert inbox['endpoint']=='/api/v1/inbox/supply' and [v[0] for v in seen]==['/api/v1/inbox/supply'] and seen[0][1]=='Bearer synthetic-site-token'
 try:tick('http://third-party.example')
 except ValueError:pass
 else:raise AssertionError('nonloopback HTTP accepted')
 print(json.dumps({'ok':True,'synthetic':True,'receiver':'127.0.0.1','feedback':True,'monitoring':True,'inbox_supply':True}))
finally:server.shutdown();server.server_close();thread.join()
