"""Real SI SQLite page insert and honest all-fetch-failed completion guard."""
import asyncio,json,sys,tempfile
from pathlib import Path
from unittest.mock import patch
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'/'site-investigator-v01'))
from siteinvestigator.db import Database,now
from siteinvestigator.investigator import Investigator
with tempfile.TemporaryDirectory() as root:
 db=Database(root);at=now()
 db.execute('INSERT INTO cases VALUES(?,?,?,?,?)',('case','Case','open',at,at))
 for d in ['good','bad']:db.execute('INSERT INTO websites(id,case_id,normalized_domain,start_url,first_seen,last_seen) VALUES(?,?,?,?,?,?)',(d,'case',d+'.example','https://'+d+'.example/',at,at))
 runner=Investigator(db,max_requests=40)
 page=runner._page('good','https://good.example/','home','Public page',200,'public','<h1>Collected public page</h1>')
 assert db.one('SELECT http_status FROM pages WHERE id=?',(page,))['http_status']==200
 assert runner._page('good','https://good.example/','home','Public page',200,'public','<h1>Collected public page</h1>')==page
 original=httpx.AsyncClient
 def failing(request):raise httpx.ConnectError('Synthetic inaccessible site',request=request)
 def client(**kwargs):return original(transport=httpx.MockTransport(failing),**kwargs)
 with patch('siteinvestigator.investigator.httpx.AsyncClient',client):
  try:asyncio.run(runner._crawl('case','bad','https://bad.example/','public'))
  except RuntimeError as e:assert 'No public pages' in str(e)
  else:raise AssertionError('Uncollected site must not complete successfully')
 assert not db.one('SELECT id FROM pages WHERE website_id=?',('bad',))
 assert db.one("SELECT id FROM evidence WHERE website_id='bad' AND kind='page_fetch_error'")
print(json.dumps({'ok':True,'checks':['real ten-column page insert','replayed page insert uses one record','all fetch failures remain failed with evidence']}))
