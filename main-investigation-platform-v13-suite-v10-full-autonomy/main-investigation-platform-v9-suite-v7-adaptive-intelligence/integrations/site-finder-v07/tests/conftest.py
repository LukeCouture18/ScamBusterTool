"""
Shared fixtures. Each test gets its own temp SQLite file so tests never
interfere with each other or with your real data/scamhunter.db.
"""
import importlib
import sys
from pathlib import Path
import os
os.environ.setdefault("SITE_FINDER_PAGE_SEARCH_URL", "")  # tests never reach the public page-search service

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """Points app.db at a fresh temp file for the duration of one test."""
    import app.config as config
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)

    import app.db as db
    importlib.reload(db)  # rebind db.DB_PATH-dependent state to the patched config
    db.init_db()
    yield db
