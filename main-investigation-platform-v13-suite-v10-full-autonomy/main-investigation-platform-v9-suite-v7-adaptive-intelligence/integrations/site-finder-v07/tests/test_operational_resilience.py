"""Operational persistence, circuit state, cost, restart and API compatibility."""
import importlib
import time

from app.v2 import active, operations, sources, store, netio
from test_active_investigation import observed


def test_provider_failure_fallback_recovery_and_half_open_lease(temp_db, monkeypatch):
    monkeypatch.setenv('SITE_FINDER_CT_FALLBACK_URL', 'https://fallback.example.test/ct')
    calls = []
    def request(provider, pattern):
        calls.append(provider.name)
        if provider.name == 'crtsh' and len([x for x in calls if x == 'crtsh']) <= 2:
            return [], 'dns_failure', .001, 0
        return ([{'name_value': 'found.test'}], 'healthy', .001, 1)
    monkeypatch.setattr(sources, '_request', request)
    assert sources.query_certificates('seed.test')[1] == 'healthy'
    sources.reset_round()
    assert sources.query_certificates('seed.test')[1] == 'healthy'
    assert [x['state'] for x in sources.health() if x['provider'] == 'crtsh'] == ['OPEN']
    sources.reset_round()
    assert sources.query_certificates('seed.test')[1] == 'healthy'
    assert calls.count('crtsh') == 2
    with store.conn() as conn:
        conn.execute("UPDATE ig_provider_health SET next_retry=? WHERE provider='crtsh'", (time.time()-1,))
    assert sources._available(sources.providers()[0])
    assert not sources._available(sources.providers()[0])
    sources.reset_round()
    assert sources.query_certificates('seed.test')[1] == 'healthy'  # fallback while primary lease is held
    with store.conn() as conn:
        conn.execute("UPDATE ig_provider_health SET state='OPEN',next_retry=? WHERE provider='crtsh'", (time.time()-1,))
    sources.reset_round()
    assert sources.query_certificates('seed.test')[1] == 'healthy'
    assert sources.health()[1 if sources.health()[0]['provider'] != 'crtsh' else 0]['state'] == 'RECOVERED'


def test_interrupted_frontier_lease_retries_without_spending_path_budget(temp_db, monkeypatch):
    candidate = observed('lease.test')
    item = active.plan(candidate, requested_kind='ct_domain')[0]
    with store.conn() as conn:
        path = conn.execute('SELECT path_id FROM ig_frontier WHERE id=?', (item,)).fetchone()['path_id']
        conn.execute("UPDATE ig_frontier SET state='RUNNING',updated_at=? WHERE id=?", (time.time()-130, item))
        conn.execute('UPDATE ig_paths SET used=1 WHERE id=?', (path,))
    with store.conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM ig_frontier WHERE state='RUNNING' AND updated_at<?", (time.time()-120,)).fetchone()[0] == 1
    monkeypatch.setattr(active, '_ct', lambda _: ([], 'empty', .001))
    active.execute(netio.Budget(crtsh=1), 1, max_actions=1)
    with store.conn() as conn:
        assert conn.execute('SELECT used FROM ig_paths WHERE id=?', (path,)).fetchone()['used'] == 1
        assert conn.execute('SELECT state FROM ig_frontier WHERE id=?', (item,)).fetchone()['state'] == 'COMPLETED'
        assert conn.execute('SELECT dead_ends FROM ig_target_outcomes WHERE kind=? AND target=?',
                            ('ct_domain', 'lease.test')).fetchone()['dead_ends'] == 1


def test_round_cost_restart_and_rollback_preserve_candidate(temp_db):
    observed('persist.test')
    operations.ensure()
    rid = operations.create_run({'max_rounds': 2, 'max_requests': 8})
    assert operations.status(rid)['run']['state'] == 'QUEUED'
    operations.record_round({'round': 1, 'seconds': .3, 'budget': {'used': {'http': 2}},
                             'pool': 2, 'probed': 2, 'gated': 0, 'delivered': []},
                            {'connections': 4, 'statements': 8}, actions=1)
    importlib.reload(operations)
    assert operations.status(rid)['rounds'][0]['connections'] == 4
    assert operations.control(rid, 'PAUSED')['run']['state'] == 'PAUSED'
    assert operations.rollback_to_active_rc(confirm=True)['preserved_active_rc']
    assert store.get('persist.test')
    assert operations.status()['run'] is None


def test_operations_api_status_create_and_control(temp_db, monkeypatch):
    from app.review import server
    from app.review.server import app
    # Resuming starts the background worker; record that instead of running a real discovery round
    # in a thread that would outlive this test and race the next ones (provider health, run state).
    started = []
    monkeypatch.setattr(server, "_start_operational_worker", lambda run_id: started.append(run_id))
    client = app.test_client()
    assert client.get('/api/v2/operations/status').status_code == 200
    result = client.post('/api/v2/operations/runs', json={'limits': {'max_rounds': 1}})
    assert result.status_code == 201
    rid = result.json['run_id']
    assert client.post(f'/api/v2/operations/runs/{rid}/pause').json['run']['state'] == 'PAUSED'
    assert client.post(f'/api/v2/operations/runs/{rid}/resume').json['run']['state'] == 'RUNNING'
    assert client.post(f'/api/v2/operations/runs/{rid}/stop').json['run']['state'] == 'STOPPED'
    assert started == [rid], 'resume asks for the worker'


def test_sustained_run_caps_requests_and_recovers_committed_round(temp_db, monkeypatch):
    from app.v2 import engine
    calls = []
    def round_stub(*args, **kwargs):
        limits = kwargs['request_limits']
        assert sum(limits.values()) <= 5 - sum(x['used'] for x in calls)
        number = len(calls) + 1
        used = min(2, sum(limits.values()))
        summary = {'round': number, 'seconds': .1, 'budget': {'used': {'http': used}},
                   'pool': 0, 'probed': 0, 'gated': 0, 'delivered': []}
        operations.record_round(summary, {'connections': 1, 'statements': 2})
        calls.append({'used': used})
        return summary
    monkeypatch.setattr(engine, 'run_round', round_stub)
    run_id = operations.create_run({'max_rounds': 3, 'idle_stop': 3, 'max_requests': 5})
    result = operations.run_sustained(run_id)
    assert result['run']['rounds'] == 3
    assert result['run']['requests'] <= 5
    assert result['run']['state'] == 'COMPLETED'
    assert result['run']['reason'] == 'round_limit'


def test_start_from_dashboard_api_launches_bounded_worker(temp_db, monkeypatch):
    from app.review import server
    app = server.app
    import threading
    monkeypatch.setattr(server, "_operational_worker", None)
    monkeypatch.setattr(server.controller, "status", lambda: {"state": "idle"})
    called = threading.Event()
    monkeypatch.setattr(operations, 'run_sustained', lambda run_id: called.set())
    result = app.test_client().post('/api/v2/operations/runs', json={
        'start': True, 'limits': {'max_rounds': 1, 'max_seconds': 30}})
    assert result.status_code == 201
    assert called.wait(2)
    assert operations.status(result.json['run_id'])['run']['limits']['max_rounds'] == 1
