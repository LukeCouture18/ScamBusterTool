"""
Tests for app/investigate/queue_worker.py — specifically the atomic claim logic
that prevents two workers from investigating the same site twice. This is the
one place a subtle bug previously caused duplicate claims under concurrency
(fixed by using UPDATE...WHERE + rowcount instead of a read-then-write check).
"""
import threading

from app.investigate.queue_worker import _claim_site


def test_claim_returns_none_on_empty_queue(temp_db):
    assert _claim_site() is None


def test_claim_marks_site_as_scanning(temp_db):
    db = temp_db
    sid = db.add_site("http://scam.test", "test")
    db.set_site_status(sid, "queued")

    claimed = _claim_site()
    assert claimed is not None
    assert claimed["id"] == sid
    assert db.get_site(sid)["status"] == "scanning"


def test_claim_prefers_highest_score(temp_db):
    db = temp_db
    low = db.add_site("http://low.test", "test")
    high = db.add_site("http://high.test", "test")
    db.update_site_score(low, 1.0, "")
    db.update_site_score(high, 9.0, "")
    db.set_site_status(low, "queued")
    db.set_site_status(high, "queued")

    claimed = _claim_site()
    assert claimed["id"] == high


def test_concurrent_claims_never_duplicate(temp_db):
    """
    The critical regression test: spin up several threads hammering _claim_site()
    against a shared queue of N sites and verify every site is claimed exactly
    once, with no duplicates and none missed.
    """
    db = temp_db
    num_sites = 40
    for i in range(num_sites):
        sid = db.add_site(f"http://race-{i}.test", "test")
        db.set_site_status(sid, "queued")

    claimed_ids = []
    lock = threading.Lock()

    def worker():
        while True:
            site = _claim_site()
            if site is None:
                break
            with lock:
                claimed_ids.append(site["id"])

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(claimed_ids) == num_sites, (
        f"Expected {num_sites} claims, got {len(claimed_ids)} "
        "(some sites were never claimed)"
    )
    assert len(claimed_ids) == len(set(claimed_ids)), (
        "Duplicate claim detected: two workers claimed the same site. "
        "This means the atomic-claim guarantee is broken."
    )


def test_claim_skips_already_scanning_sites(temp_db):
    db = temp_db
    sid = db.add_site("http://already-scanning.test", "test")
    db.set_site_status(sid, "scanning")  # simulate another worker already owns this

    assert _claim_site() is None
