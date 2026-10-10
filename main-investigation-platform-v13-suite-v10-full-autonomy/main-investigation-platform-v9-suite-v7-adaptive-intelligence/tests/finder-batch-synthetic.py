"""Build a real Site Finder v0.7 wire batch from synthetic source data."""
import json,sys,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'integrations'/'site-finder-v07'))
from app import db
from app.integration.v4 import emitter, translator
site={'domain':'synthetic.example','url':'https://synthetic.example','added_at':time.time(),'source':'synthetic-local-test','discovery_reason':'Two independent indicator categories','discovery_confidence':.8}
db.get_site=lambda _:site
db.paths_for_site=lambda _:[]
db.indicators_for_site=lambda *a,**kw:[]
emitter.should_send_site=lambda _:{'send':True,'high_priority':False,'reasons':['Synthetic public triage passed'],'blocked_by':[],'priority':{'priority':.7,'explanation':'Evidence categories passed.'},'categories':{'payment':[{'indicator_type':'wallet'}],'deposit':[{'method':'public label'}]},'triage':{'passed':True,'triage_score':.8,'http_status':200,'reject_reason':''}}
batch=emitter.build_candidate_batch(1,include_relationships=False)
assert len(batch['records']['evidence'])==1
assert batch['records']['evidence'][0]['evidence_type']=='public_triage'
observation=translator.empty_records()
observation['sites'].append(translator.site_record(site))
batch['unpromoted_observation']={'batch_id':translator.batch_id_for('observation',site['domain']),
                                 'records':observation}
print(json.dumps(batch))
