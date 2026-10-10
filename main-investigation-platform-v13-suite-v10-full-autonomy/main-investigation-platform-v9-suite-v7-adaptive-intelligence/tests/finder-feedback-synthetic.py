import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'/'site-finder-v07'))
from app.integration.v4.feedback_sync import _summarise_context
context={'entities':[{'id':'own','entity_type':'wallet'},{'id':'other','entity_type':'wallet'}],'observation_versions':[{'entity_id':'own','source_module':'site_finder'},{'entity_id':'other','source_module':'site_finder'},{'entity_id':'other','source_module':'site_investigator'}],'relationships':[],'evidence':[],'jobs':[{'job_type':'INVESTIGATE_SITE','status':'completed'}]}
result=_summarise_context(context)
assert result['counts']['wallets']==1,result
assert result['contributing_modules']==['site_investigator'],result
print(json.dumps({'ok':True,'downstream_wallets':1,'self_report_excluded':True}))
