"""A new site's distinctive name opens a fresh CT search path across restarts."""
from app.v2 import store, strategies


def test_new_candidate_opens_one_persistent_frontier_query(temp_db, monkeypatch):
    store.insert_new("beamfinanceai.example", "https://beamfinanceai.example/", "ct_terms", 0.6)
    store.update("beamfinanceai.example", status="held")
    queries = []
    monkeypatch.setattr(strategies.netio, "crtsh", lambda query: queries.append(query) or [])
    class Budget:
        def take(self, kind):
            return True
    for round_no in (2, 3):
        strategies.ct_frontier(strategies.Context(round_no, Budget(), [], store.exists), 1)
    assert queries == ["%beamfinanceai%"]
    assert "beamfinanceai" in store.get_state("ct_frontier_done")
