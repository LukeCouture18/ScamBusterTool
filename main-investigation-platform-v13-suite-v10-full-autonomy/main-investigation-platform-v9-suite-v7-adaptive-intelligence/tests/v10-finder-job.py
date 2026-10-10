"""Worker boundary: a successful public pivot need not carry a seed field."""
import sys,json,unittest
from pathlib import Path
from unittest.mock import Mock,patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'integrations/site-finder-v07'))
from app.integration.v4 import jobs
from app.v2 import platform_bridge
client=Mock();result={'new_candidates':[],'round':1,'pivot':{'kind':'ip','value':'192.0.2.1'}}
job={'id':'v10-public-pivot','job_type':'FIND_RELATED_SITES','payload':{'pivot':result['pivot']}}
with patch('app.config.FINDER_V2',True),patch.object(jobs,'claim',return_value={'claimed':True,'job':job}),patch.object(jobs,'policy_permits',return_value=(True,'permitted fixture')),patch.object(platform_bridge,'run_related_job',return_value=result),patch.object(jobs,'report_complete') as completed,patch.object(jobs,'report_failure') as failed:
    outcome=jobs.claim_and_run_one(client);completed.assert_called_once();failed.assert_not_called();assert completed.call_args.args[:2]==('v10-public-pivot',result);assert 'recorded public pivot' in completed.call_args.kwargs['message'];assert outcome.get('ran'),outcome
out={'ok':True,'scope':'Production worker completion boundary with successful bounded public pivot result and stubbed transport/policy; policy and real discovery are separately exercised.'};(ROOT/'verification/v10/finder-job.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
