"""Run v6 maintenance while no browser is open. Requires a trusted platform URL.

Set MAIN_PLATFORM_URL and (for private Site hosting) MAIN_PLATFORM_SITES_TOKEN.
No investigation content is sent anywhere except the configured platform.
"""
import json
import os
import time
import urllib.error
import urllib.request

ENDPOINTS=("/api/v1/feedback/dispatch","/api/v1/monitoring/tick")
# v2 inbox supply is a separate step, not part of tick(): tick() keeps the v6.1
# maintenance contract (feedback dispatch and monitoring) that callers and
# checks depend on, and a supply failure cannot stop feedback or monitoring.
DIRECTOR_ENDPOINT="/api/v1/ops/tick"
SUPPLY_ENDPOINT="/api/v1/inbox/supply"

def _post(base,path,token,opener):
    if not base.startswith(("https://","http://127.0.0.1:","http://localhost:")):
        raise ValueError("Scheduler platform must use HTTPS or local loopback")
    headers={"content-type":"application/json"}
    if token:headers["OAI-Sites-Authorization"]="Bearer "+token
    req=urllib.request.Request(base.rstrip("/")+path,data=b"{}",headers=headers,method="POST")
    with opener(req,timeout=30) as response:
        return {"endpoint":path,"status":response.status,"result":json.loads(response.read())}

def tick(base,token="",opener=urllib.request.urlopen):
    """v6.1 maintenance: feedback dispatch, then monitoring. Raises on any failure."""
    return [_post(base,path,token,opener) for path in ENDPOINTS]

def supply(base,token="",opener=urllib.request.urlopen):
    """v2: queue Site Finder discovery when the inbox is below its target depth. Raises on failure."""
    return _post(base,SUPPLY_ENDPOINT,token,opener)

if __name__=="__main__":
    base=os.environ["MAIN_PLATFORM_URL"]
    token=os.environ.get("MAIN_PLATFORM_SITES_TOKEN","")
    interval=max(60,int(os.environ.get("MAIN_PLATFORM_TICK_SECONDS","300")))
    while True:
        try:
            results=tick(base,token)
            try:inbox={"ok":True,**supply(base,token)}
            except (urllib.error.URLError,TimeoutError) as error:
                # Reported, not hidden: maintenance succeeded, inbox supply did not.
                inbox={"ok":False,"endpoint":SUPPLY_ENDPOINT,"error":str(error)[:200]}
            try:director={"ok":True,**_post(base,DIRECTOR_ENDPOINT,token,urllib.request.urlopen)}
            except (urllib.error.URLError,TimeoutError) as error:director={"ok":False,"error":str(error)[:200]}
            print(json.dumps({"scheduler":"ok","results":results,"inbox_supply":inbox,"director":director}),flush=True)
            time.sleep(interval)
        except KeyboardInterrupt:break
        except (urllib.error.URLError,ValueError,TimeoutError) as error:
            print(json.dumps({"scheduler":"retry","error":str(error)[:200]}),flush=True)
            time.sleep(min(interval,60))
