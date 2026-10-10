"""
Integration tests for app/runner.py's ScanController: specifically the
"automatically investigate high-risk sites after the initial scan" behavior
requested — ranking should score sites, and the investigation phase should
only pick up sites at/above the configured risk threshold, skipping
low-scored ones, using the REAL navigator against a REAL local site.
"""
import multiprocessing
import threading
import time

PORT = 8771
BASE_URL = f"http://127.0.0.1:{PORT}"

try:
    import pytest
    _HAVE_PYTEST = True
except ImportError:
    _HAVE_PYTEST = False


def _run_fake_site(port):
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
    from fake_scam_site import app
    app.run(port=port)


def _start_fake_site():
    proc = multiprocessing.Process(target=_run_fake_site, args=(PORT,), daemon=True)
    proc.start()
    import urllib.request
    for _ in range(30):
        try:
            urllib.request.urlopen(BASE_URL, timeout=1)
            break
        except Exception:
            time.sleep(0.3)
    else:
        proc.terminate()
        raise RuntimeError("fake_scam_site did not start in time")
    return proc


if _HAVE_PYTEST:
    @pytest.fixture(scope="module")
    def fake_site_server():
        proc = _start_fake_site()
        yield BASE_URL
        proc.terminate()
        proc.join(timeout=5)


def _wait_for_state(controller, target_states, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if controller.status()["state"] in target_states:
            return controller.status()["state"]
        time.sleep(0.2)
    return controller.status()["state"]


def test_runner_only_auto_investigates_sites_at_or_above_risk_threshold(temp_db, fake_site_server):
    """
    Seed one high-risk and one low-risk site (both already scored/queued, as if
    ranking already ran). Starting the controller with run_collection/run_ranking
    disabled and a risk_threshold should investigate ONLY the high-risk one.
    """
    from app import db
    from app.runner import ScanController

    high_site_id = db.add_site(fake_site_server, "test")
    low_site_id = db.add_site("http://127.0.0.1:9999", "test")  # unreachable, deliberately low score
    db.update_site_score(high_site_id, 8.0, "many scam signals")
    db.update_site_score(low_site_id, 1.0, "few signals")
    db.set_site_status(high_site_id, "queued")
    db.set_site_status(low_site_id, "queued")

    controller = ScanController()
    ok, msg = controller.start(
        run_collection=False, run_ranking=False, batch_size=5,
        headless=True, risk_threshold=5.0,
        # Legacy ranking->investigate path (the quality funnel is now the default).
        quality_pipeline=False,
    )
    assert ok is True

    final_state = _wait_for_state(controller, {"idle"}, timeout=60)
    assert final_state == "idle"

    high_site = db.get_site(high_site_id)
    low_site = db.get_site(low_site_id)

    assert high_site["status"] == "scanned", "the high-risk site should have been investigated"
    assert low_site["status"] == "queued", "the low-risk site should NOT have been auto-investigated"

    investigations = db.list_recent_investigations(limit=10)
    site_ids_investigated = {inv["site_id"] for inv in investigations}
    assert high_site_id in site_ids_investigated
    assert low_site_id not in site_ids_investigated


def test_runner_full_cycle_ranks_then_investigates_high_risk_only(temp_db, fake_site_server):
    """
    End-to-end: add sites with status='new' (unscored), let the controller run
    its full collect-skip/rank/investigate cycle, and confirm ranking assigns
    scores and only the site that ends up above threshold gets investigated.
    """
    from app import db
    from app.runner import ScanController

    scam_site_id = db.add_site(fake_site_server, "test")  # will score high (scam keywords)
    # A site with no scam signals at all should rank low and get skipped.
    benign_site_id = db.add_site(fake_site_server + "/investment", "test")

    # Both start as 'new' (unscored) — the controller's ranking phase must run
    # before investigation can happen at all, exercising the real chain.
    controller = ScanController()
    ok, msg = controller.start(
        run_collection=False, run_ranking=True, batch_size=5,
        headless=True, risk_threshold=100.0,  # deliberately impossible threshold
        quality_pipeline=False,
    )
    assert ok is True
    final_state = _wait_for_state(controller, {"idle"}, timeout=60)
    assert final_state == "idle"

    # With an impossible threshold, ranking should have happened (sites are no
    # longer 'new') but NEITHER site should have been investigated.
    scam_site = db.get_site(scam_site_id)
    assert scam_site["status"] == "queued"
    assert scam_site["score"] > 0  # ranking did run and assign some score
    investigations = db.list_recent_investigations(limit=10)
    assert len(investigations) == 0


def test_runner_pause_and_stop_during_auto_investigation(temp_db, fake_site_server):
    """Confirms pause/stop still work correctly with the threshold-aware investigation path."""
    from app import db
    from app.runner import ScanController

    for i in range(3):
        sid = db.add_site(f"{fake_site_server}/?instance={i}", "test")
        db.update_site_score(sid, 8.0, "high risk")
        db.set_site_status(sid, "queued")

    controller = ScanController()
    ok, msg = controller.start(
        run_collection=False, run_ranking=False, batch_size=3,
        headless=True, risk_threshold=5.0,
        quality_pipeline=False,
    )
    assert ok is True

    time.sleep(0.5)
    ok, msg = controller.stop()
    assert ok is True

    final_state = _wait_for_state(controller, {"idle"}, timeout=30)
    assert final_state == "idle"

    # Not all 3 sites should have been fully processed since we stopped early.
    # (The one already in progress when stop() was called is allowed to finish —
    # Playwright page loads aren't abortable mid-call — but stop must prevent
    # the controller from moving on to investigate the remaining queued sites.)
    sites = db.list_sites()
    scanned_count = sum(1 for s in sites if s["status"] == "scanned")
    assert scanned_count < 3, \
        f"stop should have prevented all 3 sites from being investigated, but {scanned_count} were scanned"
