"""Dependency-free client for Main Investigation Platform API v1."""
import json, random, time, urllib.error, urllib.request

class MainInvestigationClient:
    def __init__(self, base_url, module, api_key, sites_bypass_token=None, max_retries=4):
        self.base_url=base_url.rstrip('/'); self.module=module; self.api_key=api_key; self.sites_bypass_token=sites_bypass_token; self.max_retries=max_retries
    def _request(self,path,method='GET',body=None):
        headers={'X-API-Key':self.api_key,'Content-Type':'application/json'}
        if self.sites_bypass_token: headers['OAI-Sites-Authorization']='Bearer '+self.sites_bypass_token
        data=None if body is None else json.dumps(body).encode()
        for attempt in range(self.max_retries+1):
            try:
                with urllib.request.urlopen(urllib.request.Request(self.base_url+path,data=data,headers=headers,method=method),timeout=30) as response:
                    raw=response.read(); return None if not raw else json.loads(raw)
            except urllib.error.HTTPError as error:
                if error.code not in (429,502,503,504): raise
                if attempt==self.max_retries: raise
            time.sleep(min(30,.5*(2**attempt)+random.random()*.25))
    def ingest_legacy_logger_event(self,event):
        if self.module!='crypto_wallet_logger': raise ValueError('CryptoWalletLogger only')
        return self._request('/api/v1/compat/logger','POST',event)
    def heartbeat(self,module_version,status='idle',capabilities=None,current_job_id=None): return self._request(f'/api/v1/modules/{self.module}/heartbeat','POST',{'module_version':module_version,'schema_version':'3.0','status':status,'capabilities':capabilities or [],'current_job_id':current_job_id})
    def register(self,module_version,capabilities,supported_event_types=None,metadata=None): return self._request(f'/api/v1/modules/{self.module}/register','POST',{'module_version':module_version,'schema_version':'3.0','capabilities':capabilities,'supported_event_types':supported_event_types or [],'metadata':metadata or {}})
    def pending_events(self,limit=50): return self._request(f'/api/v1/modules/{self.module}/events?limit={limit}')
    def acknowledge_event(self,delivery_id): return self._request(f'/api/v1/modules/{self.module}/events/{delivery_id}','POST')
    def submit_metrics(self,technique,campaign,window_start,window_end,metrics,provenance=None): return self._request(f'/api/v1/modules/{self.module}/metrics','POST',{'technique':technique,'campaign':campaign,'window_start':window_start,'window_end':window_end,'metrics':metrics,'provenance':provenance or {}})
    def get_metrics(self): return self._request(f'/api/v1/modules/{self.module}/metrics')
    def publish_events(self,events): return self._request('/api/v1/events','POST',{'source_module':self.module,'events':events})
    def publish_event(self,event): return self.publish_events([event])
    def ingest(self,records,batch_id,origin_job_id=None,schema_version="3.0"): return self._request(f'/api/v1/ingest/{self.module}','POST',{'schema_version':schema_version,'batch_id':batch_id,'sent_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'origin_job_id':origin_job_id,'records':records})
    def claim_job(self): return self._request(f'/api/v1/modules/{self.module}/jobs/claim','POST')
    def update_job(self,job_id,action,**fields): return self._request(f'/api/v1/modules/{self.module}/jobs/{job_id}','PATCH',{'action':action,**fields})
    def investigation_context(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/context?module={self.module}')

    def plan(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/plan')
    def update_budget(self,investigation_id,limits): return self._request(f'/api/v1/investigations/{investigation_id}/plan','PATCH',limits)
    def graph(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/graph')
    def resolved(self,investigation_id,entity_id): return self._request(f'/api/v1/investigations/{investigation_id}/resolve?entity_id={entity_id}')
    def monitoring(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/monitoring')
    def monitor(self,investigation_id,entity_id,kind,interval_seconds=86400): return self._request(f'/api/v1/investigations/{investigation_id}/monitoring','POST',{'entity_id':entity_id,'kind':kind,'interval_seconds':interval_seconds})
    def reports(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/report')
    def prepare_report(self,investigation_id): return self._request(f'/api/v1/investigations/{investigation_id}/report','POST')
    # v2 investigation inbox: decisions made in the Main Platform UI, for the discovery module's learning loop.
    def inbox_decisions(self,after='',limit=100): return self._request(f'/api/v1/inbox/decisions?module={self.module}&after={after}&limit={limit}')
    def finder_outcomes(self,after=0,limit=200): return self._request(f'/api/v1/finder/outcomes?module={self.module}&after={after}&limit={limit}')
    def finder_hunts(self,hunts):
        return self._request('/api/v1/finder/hunts',method='POST',body={'hunts':list(hunts)[:200]})
    def finder_context(self,since='',limit=1000):
        from urllib.parse import quote
        return self._request(f'/api/v1/finder/context?since={quote(str(since))}&limit={int(limit)}')
