"""Regression guards for problems first exposed by held-out v6 discovery."""
from app.v2.netio import Budget, BudgetWindow
from app.v2 import store,pursuit

def test_lead_generation_window_reserves_probe_capacity():
    parent=Budget(http=40,dns=40,crtsh=4,rdap=6)
    lead=BudgetWindow(parent,{'http':20,'dns':20})
    for _ in range(20):assert lead.take('dns')
    assert not lead.take('dns')
    assert parent.left('dns')==20
    for _ in range(20):assert parent.take('dns')
    assert not parent.take('dns')
    assert lead.left('dns')==0
    assert not lead.take('http',-1)
    assert parent.used['http']==0

def test_changed_public_build_and_structure_is_a_new_lead_not_ownership(temp_db):
    pursuit.configure(True)
    from app.v2.pursuit import ledger
    ledger.ensure()
    for d in ['first.example','variant.example','mirror.example']:
        store.insert_new(d,'https://'+d,'fixture',.9)
    store.add_keys('first.example',[('asset','app.111111aa.js'),('simhash','0000000000000000'),('telegram','shared_support')])
    store.add_keys('variant.example',[('asset','app.222222bb.js'),('simhash','ffffffffffffffff'),('telegram','shared_support')])
    store.add_keys('mirror.example',[('asset','app.333333cc.js'),('simhash','0000000000000001'),('telegram','shared_support')])
    assert pursuit.distinct_deployment('variant.example',['first.example'])
    assert not pursuit.distinct_deployment('mirror.example',['first.example'])
