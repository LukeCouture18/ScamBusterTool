"""Consecutive CT rounds must explore other terms even with a dominant arm."""
from app.v2 import strategies, store


def test_ct_queries_rotate_and_survive_restart(monkeypatch, tmp_path):
    from app import db
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "finder.db")
    queries = []
    monkeypatch.setattr(strategies.netio, "crtsh", lambda query: queries.append(query) or [])
    class Budget:
        def take(self, kind):
            return True
    weights = {term: 0.01 for term in strategies.CT_TERMS}
    weights["usdt"] = 1.0
    for round_no in range(1, 4):
        ctx = strategies.Context(round_no, Budget(), [], lambda domain: False)
        strategies.ct_terms(ctx, 3, weights)
    assert len(queries) == 9
    assert not set(queries[:3]) & set(queries[3:6])
    assert store.get_state("ct_terms_yield")["usdt"]["queries"] == 2
