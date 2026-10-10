"""
Collector for structured public scam-report feeds.

Real-world note: CryptoScamDB's original hosted API/site went offline; the project
lives on now mainly as a static GitHub-hosted dataset. Rather than hardcode a URL
that may move or vanish, this collector pulls from a small, editable list of feed
URLs (JSON or CSV) in `feeds.txt`, so you can drop in whatever public feed you trust
and it Just Works. It's deliberately format-tolerant.
"""
import csv
import io
import json
import logging
from pathlib import Path

import requests

from app.config import DATA_DIR
from app.collectors.base import BaseCollector

logger = logging.getLogger("scamhunter.collectors.public_feeds")

FEEDS_FILE = DATA_DIR / "feeds.txt"

DEFAULT_FEEDS_FILE_CONTENT = """\
# One feed URL per line. Lines starting with # are ignored.
# Add public scam-report feeds you trust here (JSON array of objects with a "url"
# field, or CSV with a "url" column). Examples of the kind of source that fits:
# - Community-maintained GitHub-hosted scam URL lists (raw.githubusercontent.com/.../urls.json)
# - CSV exports you've manually gathered from public scam-report sites
#
# This file ships empty on purpose: verify a feed's trustworthiness and legality
# before pointing this tool at it.
"""


def _ensure_feeds_file():
    if not FEEDS_FILE.exists():
        FEEDS_FILE.write_text(DEFAULT_FEEDS_FILE_CONTENT, encoding="utf-8")


def _read_feed_urls():
    _ensure_feeds_file()
    urls = []
    for line in FEEDS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


class PublicFeedCollector(BaseCollector):
    name = "public_feed"

    def collect(self):
        feed_urls = _read_feed_urls()
        if not feed_urls:
            logger.info("No feeds configured in %s — skipping public feed collection.", FEEDS_FILE)
            return
        for feed_url in feed_urls:
            try:
                yield from self._pull_feed(feed_url)
            except Exception as e:
                logger.warning("Feed failed (%s): %s", feed_url, e)

    def _pull_feed(self, feed_url: str):
        resp = requests.get(feed_url, timeout=20)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        text = resp.text

        if "json" in content_type or feed_url.endswith(".json"):
            data = json.loads(text)
            for item in data:
                url = item.get("url") or item.get("domain") or item.get("site")
                if url:
                    yield url, f"feed:{feed_url}"
        else:
            reader = csv.DictReader(io.StringIO(text))
            for row in reader:
                url = row.get("url") or row.get("domain") or row.get("site")
                if url:
                    yield url, f"feed:{feed_url}"
