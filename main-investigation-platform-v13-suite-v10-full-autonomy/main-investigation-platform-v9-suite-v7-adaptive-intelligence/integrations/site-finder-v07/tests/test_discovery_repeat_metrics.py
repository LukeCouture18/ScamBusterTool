"""Repeated discovery must count resightings and steer the next source plan."""
import random

from app.v2 import continuous, store


def test_duplicate_events_survive_restart_and_reduce_source_priority(temp_db, monkeypatch):
    continuous.ensure()
    store.sight("repeat.example", "repeat.example", "feeds", "same feed", 0.3, 1)
    store.sight("repeat.example", "repeat.example", "feeds", "same feed", 0.3, 2)
    with store.conn() as c:
        assert c.execute("SELECT COUNT(*) n FROM v2_sightings").fetchone()["n"] == 1
        assert c.execute("SELECT COUNT(*) n FROM v2_sight_events").fetchone()["n"] == 2
        c.execute("INSERT INTO v5_source_state(source,cycles,last_cycle,new_unique,duplicates) VALUES('feeds',2,2,0,100)")
        c.execute("INSERT INTO v5_source_state(source,cycles,last_cycle,new_unique,duplicates) VALUES('mentions',2,2,40,0)")
    monkeypatch.setattr(continuous.adaptive, "strategy_values", lambda *a, **k: {"feeds": 0.2, "mentions": 0.2})
    before = continuous.plan(3, random.Random(10), only=["feeds", "mentions"])
    assert before["novelty"]["mentions"] > before["novelty"]["feeds"]
    assert before["sources"][0] == "mentions"
    continuous._ready.clear()
    continuous.ensure()
    after = continuous.plan(3, random.Random(10), only=["feeds", "mentions"])
    assert after["novelty"] == before["novelty"]
