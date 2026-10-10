"""
A simple multi-worker pool for the investigation stage, built on top of the
existing SQLite queue (db.next_sites_to_scan / db.set_site_status) rather than
pulling in Redis/Celery — this keeps the project dependency-light while still
letting several browser sessions run concurrently.

Design:
- A pool of N worker threads, each running its own Playwright browser instance
  (Playwright's sync API is not thread-safe to share a single browser across
  threads, so each worker gets its own).
- Workers claim sites atomically (status flips to 'scanning' inside a single
  transaction) so two workers never investigate the same site twice.
- Safe to run alongside the single-batch functions in pipeline.py; both paths
  go through the same db.set_site_status() gate.

This is intentionally simple. If volume grows well beyond what a handful of
threads on one machine can handle, the natural next step is swapping this
queue claim/release logic for a real broker (Celery+Redis or RQ) while keeping
everything else (ranker, navigator, extractor) unchanged — they don't know or
care how they were invoked.
"""
import logging
import threading
import time
from queue import Queue, Empty

from app import db
from app.config import MAX_CONCURRENT_BROWSERS
from app.investigate.navigator import investigate_site

logger = logging.getLogger("scamhunter.queue_worker")


def _claim_site() -> dict | None:
    """
    Atomically claim the single highest-scored untouched site, or None if queue is empty.

    Uses an UPDATE...WHERE with a rowcount check as the atomicity boundary: SQLite
    serializes writers, so only one concurrent UPDATE can actually flip a given row's
    status from 'new'/'queued' to 'scanning' — the loser's rowcount will be 0. We loop
    over a few top candidates in case we lose the race on the first pick, since another
    worker may have already claimed it a moment earlier.
    """
    with db.get_conn() as conn:
        candidates = conn.execute(
            "SELECT id FROM sites WHERE status IN ('new','queued') ORDER BY score DESC, added_at ASC LIMIT 10"
        ).fetchall()
        for row in candidates:
            site_id = row["id"]
            cur = conn.execute(
                "UPDATE sites SET status='scanning' WHERE id=? AND status IN ('new','queued')",
                (site_id,),
            )
            if cur.rowcount > 0:
                conn.commit()  # release the write lock immediately so other workers can proceed
                site_row = conn.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone()
                return dict(site_row) if site_row else None
        return None


def _worker_loop(worker_id: int, headless: bool, stop_event: threading.Event,
                  results: Queue, max_sites: int | None, allow_signup: bool = False,
                  deep_wallet_hunt: bool = False):
    processed = 0
    while not stop_event.is_set():
        if max_sites is not None and processed >= max_sites:
            break
        site = _claim_site()
        if not site:
            time.sleep(2)  # queue momentarily empty; wait and check again
            if not db.next_sites_to_scan(limit=1):
                break  # genuinely nothing left
            continue

        logger.info("[worker %d] investigating %s (score=%s)", worker_id, site["url"], site["score"])
        try:
            result = investigate_site(site, headless=headless, allow_signup=allow_signup,
                                       deep_wallet_hunt=deep_wallet_hunt)
            results.put({"site_id": site["id"], "url": site["url"], "ok": True, "result": result})
        except Exception as e:
            logger.exception("[worker %d] failed on %s", worker_id, site["url"])
            db.set_site_status(site["id"], "error")
            results.put({"site_id": site["id"], "url": site["url"], "ok": False, "error": str(e)})
        processed += 1


def run_worker_pool(num_workers: int = MAX_CONCURRENT_BROWSERS,
                     headless: bool = True,
                     max_sites_total: int | None = None,
                     timeout_seconds: int | None = None,
                     allow_signup: bool = False,
                     deep_wallet_hunt: bool = False) -> list[dict]:
    """
    Runs `num_workers` browser workers concurrently, draining the queued/new sites
    (highest score first) until the queue is empty, `max_sites_total` is reached,
    or `timeout_seconds` elapses. Returns a list of per-site result dicts.

    This is the entry point to use once you have thousands of candidates queued —
    call it instead of pipeline.run_investigation_batch() for real throughput.
    """
    max_per_worker = None
    if max_sites_total is not None:
        max_per_worker = max(1, max_sites_total // num_workers + 1)

    stop_event = threading.Event()
    results: Queue = Queue()
    threads = []

    for i in range(num_workers):
        t = threading.Thread(
            target=_worker_loop,
            args=(i, headless, stop_event, results, max_per_worker, allow_signup, deep_wallet_hunt),
            daemon=True,
        )
        threads.append(t)
        t.start()

    start_time = time.time()
    for t in threads:
        remaining = None
        if timeout_seconds is not None:
            remaining = max(0, timeout_seconds - (time.time() - start_time))
        t.join(timeout=remaining)

    stop_event.set()

    collected = []
    while True:
        try:
            collected.append(results.get_nowait())
        except Empty:
            break

    logger.info("Worker pool finished: %d sites processed by %d workers.", len(collected), num_workers)
    return collected
