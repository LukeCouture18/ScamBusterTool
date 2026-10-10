"""The single dashboard's actions reach the existing persisted inbox."""
from app.v2 import store


def test_review_and_discovery_routes(temp_db, monkeypatch):
    from app.review import server
    store.insert_new("first.example", "https://first.example/", "ct_terms", 0.6)
    store.insert_new("second.example", "https://second.example/", "feeds", 0.5)
    store.update("first.example", status="ready", p=0.9, headline="Deposit signal observed")
    store.update("second.example", status="ready", p=0.8, headline="New public listing")
    client = server.app.test_client()
    page = client.get("/")
    assert page.status_code == 200 and b"Best new sites" in page.data
    assert client.get("/advanced").status_code == 302
    queue = client.get("/api/v2/candidates").json["items"]
    assert [x["domain"] for x in queue] == ["first.example", "second.example"]
    assert client.post("/api/v2/presented", json={"id": "first.example"}).json["ok"]
    assert store.get("first.example")["status"] == "presented"
    assert client.get("/api/v2/details/first.example").status_code == 200
    assert client.post("/api/v2/opened", json={"id": "first.example"}).json["ok"]
    assert store.get("first.example")["opened_at"]
    assert client.post("/api/v2/decide", json={"id": "first.example", "decision": "useful"}).json["ok"]
    assert store.get("first.example")["status"] == "useful"
    assert client.post("/api/v2/decide", json={"id": "second.example", "decision": "skip", "reason": "not_useful"}).json["ok"]
    assert store.get("second.example")["status"] == "skipped"
    assert client.get("/api/v2/candidates").json["items"] == []
    calls = []
    monkeypatch.setattr(server.controller, "status", lambda: {"state": "idle"})
    monkeypatch.setattr(server.controller, "run_v2_round_now", lambda **kw: (calls.append(kw) or True, "started"))
    assert client.post("/api/v2/round").json["ok"]
    assert calls == [{"requested": 5, "continuous": True}]
