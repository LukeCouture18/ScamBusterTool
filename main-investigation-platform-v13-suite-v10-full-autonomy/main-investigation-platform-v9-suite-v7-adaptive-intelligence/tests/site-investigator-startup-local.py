"""Boot the supplied Site Investigator entry and observe its platform worker."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "integrations" / "site-investigator-v01"
job_id = "synthetic-site-startup-job"
received = {"registered": False, "claimed": False, "failure": None}


class PlatformReceiver(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.reply()

    def do_PATCH(self):
        self.reply()

    def do_GET(self):
        self.reply()

    def reply(self):
        assert self.headers.get("X-API-Key") == "synthetic-module-key"
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size)) if size else {}
        path = self.path
        if path.endswith("/register"):
            received["registered"] = True
            answer = {"registered": True}
        elif path.endswith("/jobs/claim"):
            answer = {"job": None if received["claimed"] else {
                "id": job_id, "job_type": "INVESTIGATE_SITE",
                "investigation_id": "synthetic-investigation", "target_entity_id": "synthetic-site"}}
            received["claimed"] = True
        elif path.endswith("/context?module=site_investigator"):
            answer = {"entities": [{"id": "synthetic-site", "entity_type": "site",
                                    "canonical_key": "invalid.localhost.invalid"}]}
        elif path.endswith("/jobs/" + job_id):
            received["failure"] = body
            answer = {"accepted": True}
        else:
            answer = {"alive": True}
        payload = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


server = ThreadingHTTPServer(("127.0.0.1", 0), PlatformReceiver)
threading.Thread(target=server.serve_forever, daemon=True).start()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    module_port = probe.getsockname()[1]
try:
    with tempfile.TemporaryDirectory(prefix="site-investigator-startup-") as data_dir:
        env = {**os.environ, "MAIN_PLATFORM_URL": f"http://127.0.0.1:{server.server_port}",
               "SITE_INVESTIGATOR_MODULE_KEY": "synthetic-module-key",
               "SI_DATA_DIR": data_dir, "SI_PORT": str(module_port),
               "PYTHONPATH": str(MODULE) + os.pathsep + os.environ.get("PYTHONPATH", "")}
        # The server's log goes to a file, not a pipe: nobody drains a pipe
        # while we poll, and a full pipe (4 KB on Windows) blocks the server.
        server_log = tempfile.TemporaryFile()
        process = subprocess.Popen([sys.executable, "run.py"], cwd=MODULE, env=env,
                                   stdout=subprocess.DEVNULL, stderr=server_log)

        def log_tail():
            server_log.seek(0)
            return server_log.read().decode("utf-8", "replace")[-4000:]

        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and received["failure"] is None:
                if process.poll() is not None:
                    raise AssertionError("Site Investigator server exited before claiming work:\n" + log_tail())
                time.sleep(.1)
            assert received["registered"] and received["claimed"], log_tail()
            assert received["failure"] is not None, "normal server startup did not run its bridge:\n" + log_tail()
            assert received["failure"]["action"] == "fail"
            assert received["failure"]["retry"] is True
            print(json.dumps({"ok": True, "real_module_entry": True,
                              "claimed_and_reported": job_id, "synthetic": True}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            server_log.close()
finally:
    server.shutdown()
    server.server_close()
