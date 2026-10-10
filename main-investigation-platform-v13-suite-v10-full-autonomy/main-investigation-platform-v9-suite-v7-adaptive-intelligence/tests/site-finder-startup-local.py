"""The real review-server entry drains a persisted passive discovery batch."""
import contextlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "integrations" / "site-finder-v07"
accepted = []


class PlatformReceiver(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(size)) if size else {}
        assert self.headers.get("X-API-Key") == "synthetic-finder-key"
        if self.path.endswith("/ingest/site_finder"):
            assert payload["schema_version"] == "3.0"
            assert len(payload["records"]["sites"]) == 1
            assert not payload["records"]["investigations"]
            accepted.append(payload["batch_id"])
        answer = {"registered": True, "schema_compatible": True,
                  "supported_schema": "3.x", "status": "accepted",
                  "inserted_count": 1, "job": None}
        encoded = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


receiver = ThreadingHTTPServer(("127.0.0.1", 0), PlatformReceiver)
threading.Thread(target=receiver.serve_forever, daemon=True).start()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
try:
    with tempfile.TemporaryDirectory(prefix="site-finder-normal-startup-") as scratch:
        distribution = Path(scratch) / "v6"
        target = distribution / "integrations" / "site-finder-v07"
        shutil.copytree(SOURCE / "app", target / "app",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copytree(ROOT / "sdk", distribution / "sdk",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        env = {**os.environ, "PYTHONPATH": str(target) + os.pathsep + os.environ.get("PYTHONPATH", ""),
               "MAIN_PLATFORM_URL": f"http://127.0.0.1:{receiver.server_port}",
               "MAIN_PLATFORM_TOKEN": "synthetic-finder-key",
               "MAIN_PLATFORM_FEEDBACK_SIGNING_KEY": "synthetic-finder-signature",
               "SITE_FINDER_PORT": str(port), "SITE_FINDER_HOST": "127.0.0.1"}
        seed = "from app import db; from app.integration.v4.emitter import queue_candidate; db.init_db(); site=db.add_site('https://synthetic.example','synthetic-only'); result=queue_candidate(site); assert not result['sent']; assert db.next_batches()[0]['kind']=='observation'"
        seeded = subprocess.run([sys.executable, "-c", seed], cwd=target, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace")
        assert seeded.returncode == 0, seeded.stderr
        # The server's log goes to a file, not a pipe: nobody drains a pipe
        # while we poll, and a full pipe (4 KB on Windows) blocks the server.
        server_log = tempfile.TemporaryFile()
        process = subprocess.Popen([sys.executable, "-m", "app.review.server"], cwd=target,
                                   env=env, stdout=subprocess.DEVNULL, stderr=server_log)

        def log_tail():
            server_log.seek(0)
            return server_log.read().decode("utf-8", "replace")[-4000:]

        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not accepted:
                if process.poll() is not None:
                    raise AssertionError("Site Finder review server exited before outbox delivery:\n" + log_tail())
                time.sleep(.1)
            assert len(accepted) == 1, "normal entry did not deliver persisted passive batch:\n" + log_tail()
            # closing(): a sqlite3 connection used as a context manager only
            # commits. Left open, it keeps the file locked on Windows and the
            # temporary directory cannot be removed.
            # The receiver records the batch before its response reaches Site Finder, so the
            # outbox row turns 'sent' a moment later: wait for it (same assertion, no race).
            deadline = time.monotonic() + 10
            while True:
                with contextlib.closing(sqlite3.connect(target / "data" / "scamhunter.db")) as conn:
                    states = conn.execute("SELECT status FROM integration_outbox").fetchall()
                if states == [("sent",)] or time.monotonic() > deadline:
                    break
                time.sleep(.1)
            assert states == [("sent",)], states
            # Before the route-order fix, direct module entry blocked at
            # app.run before registering the signed feedback endpoint.
            invalid = Request(f"http://127.0.0.1:{port}/api/integration/platform-feedback",
                              data=b'{}', method="POST")
            try:
                urlopen(invalid, timeout=3)
            except HTTPError as error:
                assert error.code == 401, f"feedback receiver was not registered: {error.code}"
            print(json.dumps({"ok": True, "real_module_entry": True,
                              "outbox_sent": accepted[0], "feedback_route": True,
                              "synthetic": True}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            server_log.close()
finally:
    receiver.shutdown()
    receiver.server_close()
