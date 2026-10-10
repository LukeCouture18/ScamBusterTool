import contextlib,hashlib,hmac,json,os,sqlite3,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'/'site-finder-v07'))
from app import db
from app.integration.v4.push_feedback import receive
os.environ['MAIN_PLATFORM_FEEDBACK_SIGNING_KEY']='synthetic-only-key'
with tempfile.TemporaryDirectory(prefix='finder-push-test-') as temp:
 path=str(Path(temp)/'receipts.sqlite')
 @contextlib.contextmanager
 def get_conn():
  conn=sqlite3.connect(path)
  try:yield conn;conn.commit()
  finally:conn.close()
 db.get_conn=get_conn
 message={'delivery_id':'synthetic-delivery','event_id':'synthetic-event','event_type':'site.investigated','payload':{'summary':'synthetic only'}}
 body=json.dumps(message).encode();headers={'x-platform-delivery-id':'synthetic-delivery','x-platform-signature':'sha256='+hmac.new(b'synthetic-only-key',body,hashlib.sha256).hexdigest()}
 processed=[];acked=[]
 assert receive(body,{**headers,'x-platform-signature':'sha256=wrong'},lambda:processed.append(1),acked.append)[0]==401
 status,result=receive(body,headers,lambda:processed.append(1),acked.append)
 assert status==200 and not result['duplicate']
 status,result=receive(body,headers,lambda:processed.append(1),acked.append)
 assert status==200 and result['duplicate'] and processed==[1] and acked==['synthetic-delivery']*2
 print(json.dumps({'ok':True,'synthetic':True,'authenticated':True,'idempotent':True,'ack':True}))
