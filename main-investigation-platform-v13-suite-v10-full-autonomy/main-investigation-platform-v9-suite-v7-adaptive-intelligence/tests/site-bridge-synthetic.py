"""Exercise the real Site Investigator v0.1 SQLite schema with synthetic evidence."""
import json
import os
import sys
import tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'integrations'/'site-investigator-v01'))
sys.path.insert(0,str(root/'integrations'))
sys.path.insert(0,str(root/'tests'/'lib'))
from siteinvestigator.db import now
from si_database import OwnedDatabase
from site_investigator_bridge import build_batch,public_domain
# The database is closed (every connection it opened) before the directory is removed; see tests/lib/si_database.py.
with tempfile.TemporaryDirectory(prefix='si-v6-synthetic-') as temp, OwnedDatabase(temp) as db:
 t=now();case='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';job='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';site='site_synthetic';wallet='wallet_synthetic';evidence='evidence_synthetic'
 db.execute('INSERT INTO cases VALUES (?,?,?,?,?)',(case,'Synthetic case','open',t,t))
 db.execute('INSERT INTO websites VALUES (?,?,?,?,?,?,?,?,?)',(site,case,'synthetic.example','https://synthetic.example','Synthetic page','investigated',0,t,t))
 db.execute('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?,?,?)',('page_synthetic',site,'https://synthetic.example/deposit','deposit','Deposit',200,'public','a'*64,t,t))
 fixture_wallet='0x71c841094df8cf7fa128565551f337f74c7dbb94'
 db.execute('INSERT INTO wallets VALUES (?,?,?,?,?,?)',(wallet,fixture_wallet,'ethereum','USDT',.85,t))
 db.execute('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',(evidence,case,site,'page_synthetic','wallet_display','public','https://synthetic.example/deposit',json.dumps({'wallet':fixture_wallet}),.85,t,None,None))
 db.execute('INSERT INTO relationships VALUES (?,?,?,?,?,?,?,?,?,?,?)',('rel_synthetic',case,'website',site,'wallet',wallet,'displays_wallet',evidence,.85,'Displayed on a public page',t))
 batch=build_batch(db,case,job,'synthetic.example')
 assert len(batch['records']['sites'])==len(batch['records']['wallets'])==len(batch['records']['relationships'])==1
 assert batch['records']['relationships'][0]['evidence_ids']==[evidence]
 assert batch['records']['evidence'][0]['context_text'].startswith('{"wallet"')
 assert batch['records']['wallets'][0]['network']=='ethereum'
 assert public_domain('synthetic.example')=='synthetic.example'
 try:public_domain('127.0.0.1')
 except ValueError:pass
 else:raise AssertionError('IP accepted')
 print(json.dumps({'batch':batch} if os.environ.get('MIP_BATCH_JSON')=='1' else {'ok':True,'synthetic':True,'record_types':{k:len(v) for k,v in batch['records'].items()}}))
