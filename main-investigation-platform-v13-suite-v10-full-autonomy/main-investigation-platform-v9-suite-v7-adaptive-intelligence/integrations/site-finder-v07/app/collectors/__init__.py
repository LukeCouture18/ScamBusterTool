import logging

from app import db
from app.collectors.public_feeds import PublicFeedCollector

logger = logging.getLogger("scamhunter.collectors")


def run_collectors(extra_collectors=None):
    """
    Runs all registered collectors, normalizes/dedupes URLs, and inserts new
    candidate sites into the DB. Returns count of newly added sites.
    """
    collectors = [PublicFeedCollector()]
    if extra_collectors:
        collectors.extend(extra_collectors)

    added = 0
    for collector in collectors:
        for url, source in collector.collect():
            url = url.strip()
            if not url:
                continue
            if not url.startswith("http"):
                url = "http://" + url
            new_id = db.add_site(url, source)
            if new_id:
                added += 1
    logger.info("Collectors added %d new candidate sites.", added)
    return added
