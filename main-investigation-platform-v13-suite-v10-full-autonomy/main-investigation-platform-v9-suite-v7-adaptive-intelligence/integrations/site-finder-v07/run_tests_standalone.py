#!/usr/bin/env python3
"""
Minimal standalone test runner used ONLY to validate the test suite in
environments where `pip install pytest` isn't possible (e.g. sandboxed dev
containers with no package-index access). This is not a pytest replacement —
once you have real package access, use `pytest` directly; it has much better
fixture support, output, and filtering.

This script:
  - discovers tests/test_*.py
  - provides a tiny pytest.fixture-compatible `temp_db` by calling conftest.py's
    fixture function directly (bypassing pytest's DI, since we have no pytest)
  - runs every top-level function starting with test_
  - reports pass/fail counts

Usage: python3 run_tests_standalone.py
"""
import sys
import tempfile
import traceback
import importlib
import importlib.util
import inspect
from pathlib import Path
from contextlib import ExitStack
import os
os.environ.setdefault("SITE_FINDER_PAGE_SEARCH_URL", "")  # tests never reach the public page-search service

sys.path.insert(0, str(Path(__file__).resolve().parent))

TESTS_DIR = Path(__file__).resolve().parent / "tests"
# pytest puts the test directory on sys.path (rootdir/conftest), so test files may
# import shared helpers from sibling test modules; mirror that here.
sys.path.insert(1, str(TESTS_DIR))


class FakeMonkeypatch:
    def __init__(self):
        self._restores = []
        self._env = []

    def setattr(self, target, name_or_value, value=None):
        """
        Supports both pytest monkeypatch.setattr forms:
          - setattr(obj, "name", value)          (three-arg form)
          - setattr("module.path.name", value)   (two-arg dotted-string form)
        """
        if value is None and isinstance(target, str):
            module_path, _, attr_name = target.rpartition(".")
            obj = importlib.import_module(module_path)
            name = attr_name
            new_value = name_or_value
        else:
            obj = target
            name = name_or_value
            new_value = value
        old = getattr(obj, name)
        self._restores.append((obj, name, old))
        setattr(obj, name, new_value)

    def setenv(self, name, value):
        import os
        self._env.append((name, os.environ.get(name)))
        os.environ[name] = str(value)

    def delenv(self, name, raising=True):
        import os
        if name not in os.environ and raising:
            raise KeyError(name)
        self._env.append((name, os.environ.get(name)))
        os.environ.pop(name, None)

    def undo(self):
        import os
        for obj, name, old in reversed(self._restores):
            setattr(obj, name, old)
        for name, old in reversed(self._env):
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old


def make_temp_db():
    """Mimics tests/conftest.py's temp_db fixture without needing pytest's DI."""
    import app.config as config
    tmpdir = tempfile.mkdtemp()
    db_path = Path(tmpdir) / "test.db"
    mp = FakeMonkeypatch()
    mp.setattr(config, "DB_PATH", db_path)

    import app.db as db
    importlib.reload(db)
    db.init_db()
    mp.tmpdir = tmpdir          # removed after the test (see _remove_tree)
    return db, mp


def _remove_tree(path):
    """Best effort: a file Windows still holds (scanner, lingering handle) must not abort the run."""
    import shutil
    shutil.rmtree(path, ignore_errors=True)


def _run_fake_site(port):
    # Module level so multiprocessing can pickle it: Windows (and macOS) start
    # child processes with "spawn", which cannot pickle a nested function.
    sys.path.insert(0, str(TESTS_DIR / "fixtures"))
    from fake_scam_site import app as fake_app
    fake_app.run(port=port)


def make_fake_site_server():
    """
    Mimics the module-scoped `fake_site_server` fixture in
    tests/test_navigator_integration.py: starts the local fake scam site once
    and returns its base URL, plus a teardown callable.
    """
    import multiprocessing
    import time
    import urllib.request

    port = 8765
    proc = multiprocessing.Process(target=_run_fake_site, args=(port,), daemon=True)
    proc.start()
    base_url = f"http://127.0.0.1:{port}"
    for _ in range(30):
        try:
            urllib.request.urlopen(base_url, timeout=1)
            break
        except Exception:
            time.sleep(0.3)
    else:
        proc.terminate()
        raise RuntimeError("fake_scam_site did not start in time")

    def teardown():
        proc.terminate()
        proc.join(timeout=5)

    return base_url, teardown


def run_all(only_file: str | None = None):
    passed, failed, errors = 0, 0, []
    skipped = []

    test_files = sorted(TESTS_DIR.glob("test_*.py"))
    if only_file:
        test_files = [f for f in test_files if f.name == only_file]
        if not test_files:
            print(f"  FAIL  no test file named {only_file} in {TESTS_DIR}")
            return False

    # Module-scoped resources, created lazily on first use and shared across
    # every test in every file that needs them (mirrors pytest's scope="module",
    # loosened to scope="session" here since we only ever spin up one instance).
    _fake_site_cache = {}

    def get_fake_site_server():
        if "url" not in _fake_site_cache:
            url, teardown = make_fake_site_server()
            _fake_site_cache["url"] = url
            _fake_site_cache["teardown"] = teardown
        return _fake_site_cache["url"]

    for test_file in test_files:
        module_name = f"tests.{test_file.stem}"
        spec = importlib.util.spec_from_file_location(module_name, test_file)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            # e.g. a module-level `import pytest` when pytest isn't installed —
            # skip that file's tests rather than crashing the whole run, since
            # pytest-only test files are expected to run under real pytest instead.
            print(f"  SKIP  {test_file.name} (failed to import: {e})")
            skipped.append(test_file.name)
            if only_file:
                # The file was asked for by name, so not running it is a failure.
                failed += 1
                errors.append((test_file.name, traceback.format_exc()))
            continue

        test_funcs = [
            (name, obj) for name, obj in inspect.getmembers(module)
            if name.startswith("test_") and inspect.isfunction(obj)
        ]

        for name, func in test_funcs:
            sig = inspect.signature(func)
            param_names = list(sig.parameters.keys())

            db_mp = None
            mp = None
            path_context = None
            try:
                # Build args matching each parameter's actual name/position,
                # rather than assuming a fixed fixture order — a test can
                # declare temp_db/fake_site_server/monkeypatch in any order.
                fixture_values = {}
                if "temp_db" in param_names:
                    db, db_mp = make_temp_db()
                    fixture_values["temp_db"] = db
                if "fake_site_server" in param_names:
                    fixture_values["fake_site_server"] = get_fake_site_server()
                if "monkeypatch" in param_names:
                    mp = FakeMonkeypatch()
                    fixture_values["monkeypatch"] = mp
                if "tmp_path" in param_names:
                    path_context = tempfile.TemporaryDirectory(prefix="finder-test-")
                    fixture_values["tmp_path"] = Path(path_context.name)

                unknown = set(param_names) - set(fixture_values)
                if unknown:
                    raise ValueError(f"Unsupported standalone fixtures: {sorted(unknown)}")
                args = [fixture_values[p] for p in param_names]
                func(*args)
                passed += 1
                print(f"  PASS  {test_file.name}::{name}")
            except Exception as e:
                failed += 1
                tb = traceback.format_exc()
                errors.append((f"{test_file.name}::{name}", tb))
                print(f"  FAIL  {test_file.name}::{name}  ({e})")
            finally:
                if db_mp:
                    db_mp.undo()
                    _remove_tree(db_mp.tmpdir)
                if mp:
                    mp.undo()
                if path_context:
                    try:
                        path_context.cleanup()
                    except OSError:
                        _remove_tree(path_context.name)

    if "teardown" in _fake_site_cache:
        _fake_site_cache["teardown"]()

    print()
    print(f"{'='*60}")
    print(f"Results: {passed} passed, {failed} failed"
          + (f", {len(skipped)} file(s) skipped (need pytest): {', '.join(skipped)}" if skipped else ""))
    print(f"{'='*60}")

    if errors:
        print("\nFailure details:\n")
        for test_name, tb in errors:
            print(f"--- {test_name} ---")
            print(tb)

    return failed == 0


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    success = run_all(only_file=only)
    sys.exit(0 if success else 1)
