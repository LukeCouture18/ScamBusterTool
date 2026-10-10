"""
Simplest, most reliable collector: import a plain text or CSV file of URLs
you gathered yourself from public sources (forums, Google dorks, Twitter/X
reports, Telegram scam-alert channels, etc). One URL per line, or a CSV with
a 'url' column.

This is the recommended way to seed the system for v1 — point-and-click
scam-report aggregators change constantly, but you copying URLs into a text
file always works.
"""
import csv
import logging
from pathlib import Path

from app.collectors.base import BaseCollector

logger = logging.getLogger("scamhunter.collectors.manual")


class ManualImportCollector(BaseCollector):
    name = "manual_import"

    def __init__(self, file_path: str):
        self.file_path = Path(file_path)

    def collect(self):
        if not self.file_path.exists():
            logger.warning("Import file not found: %s", self.file_path)
            return
        text = self.file_path.read_text(errors="ignore")
        if self.file_path.suffix.lower() == ".csv":
            reader = csv.DictReader(text.splitlines())
            for row in reader:
                url = row.get("url") or row.get("domain") or row.get("site")
                if url:
                    yield url.strip(), f"manual:{self.file_path.name}"
        else:
            for line in text.splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    yield line, f"manual:{self.file_path.name}"
