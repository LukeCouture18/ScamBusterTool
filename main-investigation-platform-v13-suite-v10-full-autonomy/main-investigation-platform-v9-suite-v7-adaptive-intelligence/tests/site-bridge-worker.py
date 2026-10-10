"""Exercise the real bridge job lifecycle with a synthetic local investigator."""
import json,sys,tempfile,types
from pathlib import Path
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'integrations'/'site-investigator-v01'));sys.path.insert(0,str(root/'integrations'));sys.path.insert(0,str(root/'tests'/'lib'))
from siteinvestigator.db import now
from si_database import OwnedDatabase
from site_investigator_bridge import Platform
inv='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';job='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';entity='cccccccc-cccc-4ccc-cccc-cccccccccccc'
class FakeInvestigator:
 def __init__(self,db):self.db=db
 async def public(self,case_id,site_id,local_id):
  self.db.evidence(case_id,site_id,'page_text',{'text':'Synthetic public page'},source_url='https://synthetic.example',confidence=.9)
  self.db.execute('UPDATE websites SET status=?,last_seen=? WHERE id=?',('investigated',now(),site_id))
  self.db.execute('UPDATE jobs SET status=?,updated_at=? WHERE id=?',('completed',now(),local_id))
sys.modules['siteinvestigator.investigator']=types.SimpleNamespace(Investigator=FakeInvestigator)
# The database is closed (every connection it opened) before the directory is removed; see tests/lib/si_database.py.
with tempfile.TemporaryDirectory(prefix='si-bridge-worker-') as directory, OwnedDatabase(directory) as db:
 calls=[];worker=Platform.__new__(Platform)
 def request(path,method='GET',data=None):
  calls.append((path,method,data))
  if path.endswith('/jobs/claim'):return {'job':{'id':job,'job_type':'INVESTIGATE_SITE','investigation_id':inv,'target_entity_id':entity}}
  if path.endswith('/context?module=site_investigator'):return {'entities':[{'id':entity,'entity_type':'site','canonical_key':'synthetic.example'}]}
  if path.endswith('/ingest/site_investigator'):
   assert data['origin_job_id']==job and len(data['records']['evidence'])==1
   return {'status':'accepted','error_count':0}
  return {'ok':True}
 worker.request=request
 assert worker.run_once(db) is True
 assert any(path.endswith('/jobs/'+job) and data['action']=='complete' for path,_,data in calls if data)
 assert db.one('SELECT status FROM websites WHERE case_id=?',(inv,))['status']=='investigated'
 class FailingInvestigator:
  def __init__(self,db):self.db=db
  async def public(self,*args):raise RuntimeError('Synthetic provider failure')
 sys.modules['siteinvestigator.investigator']=types.SimpleNamespace(Investigator=FailingInvestigator)
 calls.clear()
 assert worker.run_once(db) is False
 assert any(path.endswith('/jobs/'+job) and data['action']=='fail' and data['retry'] is True for path,_,data in calls if data)
 print(json.dumps({'ok':True,'synthetic':True,'registered':True,'claimed':True,'ingested':True,'completed':True,'provider_failure_retried':True}))
