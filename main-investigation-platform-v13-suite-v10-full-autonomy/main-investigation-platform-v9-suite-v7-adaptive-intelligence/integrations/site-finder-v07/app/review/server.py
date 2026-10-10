"""
Web UI server for ScamHunter: a single-page live dashboard plus supporting
JSON API routes, backed by Server-Sent Events for real-time updates (no
polling, no extra dependencies beyond Flask itself).

Run with: python cli.py serve   (or `python -m app.review.server`)
Then open http://127.0.0.1:5000
"""
import logging
import os
import threading

from flask import Flask, render_template, request, jsonify, send_from_directory, Response, redirect

from app import db
from app.config import BASE_DIR
from app.events import sse_stream, publish
from app.log_stream import install_ui_log_handler
from app.runner import controller
from app.form_filler import prepare_form_for_review

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("scamhunter.review")

# Route every "scamhunter.*" logger's output to the live activity panel too.
install_ui_log_handler()

app = Flask(__name__, template_folder="templates", static_folder="static")
_operational_worker_lock = threading.Lock()
_operational_worker = None


def _start_operational_worker(run_id):
    global _operational_worker
    from app.v2 import operations
    with _operational_worker_lock:
        if _operational_worker and _operational_worker.is_alive():
            raise ValueError("an operational worker is already running")
        def work():
            try:
                operations.run_sustained(run_id)
            except Exception:
                logger.exception("bounded operational run %s failed", run_id)
                operations.control(run_id, "STOPPED")
        _operational_worker = threading.Thread(target=work, daemon=True,
                                               name=f"finder-operational-{run_id}")
        _operational_worker.start()

# Creates anything missing AND migrates anything out of date. An upgraded
# database that skipped migrations would fail on its first write to a table
# that gained a column — which is exactly what v0.6 shipped with.
_schema = db.init_db()
if _schema.get("changed_schema"):
    logger.info("Database schema upgraded: %s", _schema["note"])
if _schema.get("failed"):
    logger.error("Schema migration failures: %s", _schema["failed"])


def _start_platform_link():
    """
    Bring the platform link up with the server when one is configured. v0.6
    required a human to press Connect for anything to be delivered at all.
    """
    from app.config import MAIN_PLATFORM_URL, MAIN_PLATFORM_TOKEN
    if not (MAIN_PLATFORM_URL and MAIN_PLATFORM_TOKEN):
        logger.info("No Main Platform configured; running standalone and queueing "
                    "everything locally.")
        return
    ok, message = controller.start_integration()
    logger.info("Platform link: %s", message)


_start_platform_link()

DEFAULT_SETTINGS = {
    "batch_size": 5,
    "headless": True,
    "rank_limit": 500,
    "run_collection": True,
    "run_ranking": True,
    "run_discovery": True,
    "max_pages_per_site": None,   # None = leave config.py default alone
    "risk_threshold": 5.0,
    "allow_signup": False,
    "deep_wallet_hunt": False,
}


def _load_settings() -> dict:
    stored = db.get_all_settings()
    merged = dict(DEFAULT_SETTINGS)
    for key, value in stored.items():
        if key not in merged:
            continue
        default = DEFAULT_SETTINGS[key]
        try:
            if isinstance(default, bool):
                merged[key] = value in ("true", "True", "1")
            elif isinstance(default, int):
                merged[key] = int(value)
            elif isinstance(default, float):
                merged[key] = float(value)
            else:
                merged[key] = value
        except (ValueError, TypeError):
            merged[key] = default
    return merged


# ---------- Page (SPA shell) ----------

@app.route("/")
def inbox_page():
    """v2: the investigation inbox. The full v0.7 dashboard lives at /advanced."""
    from app.config import MAIN_PLATFORM_URL
    return render_template("inbox.html", platform_url=MAIN_PLATFORM_URL or "")


@app.route("/advanced")
def dashboard():
    return redirect("/?advanced=1")


# ---------- v2 inbox API ----------

@app.route("/api/v2/next")
def api_v2_next():
    from app.v2 import inbox
    item = inbox.next_candidate()
    return jsonify({"item": item, "waiting": inbox.remaining(), "autopilot": controller.status()["state"]})


@app.route("/api/v2/candidates")
def api_v2_candidates():
    from app.v2 import inbox
    return jsonify({"items": inbox.top_candidates(), "waiting": inbox.remaining(),
                    "autopilot": controller.status()["state"]})


@app.route("/api/v2/investigation/frontier")
def api_investigation_frontier():
    from app.v2 import active
    return jsonify({"items": active.list_frontier(limit=30), "sources": active.source_report()})


@app.route("/api/v2/investigation/paths/<int:path_id>")
def api_investigation_path(path_id):
    from app.v2 import active
    try:
        return jsonify(active.path_detail(path_id))
    except KeyError:
        return jsonify({"error": "unknown investigation path"}), 404


@app.route("/api/v2/investigation/paths/<int:path_id>/control", methods=["POST"])
def api_investigation_control(path_id):
    from app.v2 import active
    try:
        return jsonify(active.control(path_id, str((request.get_json(silent=True) or {}).get("state", ""))))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except KeyError:
        return jsonify({"error": "unknown investigation path"}), 404


@app.route("/api/v2/investigation/investigate", methods=["POST"])
def api_investigation_investigate():
    from app.v2 import active
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(active.investigate(str(body.get("domain", "")), body.get("kind")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except KeyError:
        return jsonify({"error": "unknown observed domain"}), 404


@app.route("/api/v2/investigation/hypothesis")
def api_investigation_hypothesis():
    from app.v2 import active
    try:
        return jsonify(active.hypothesis(request.args.get("left", ""), request.args.get("right", "")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/investigation/campaigns/<campaign_id>/pause", methods=["POST"])
def api_investigation_pause_campaign(campaign_id):
    from app.v2 import active
    try:
        return jsonify(active.pause_campaign(campaign_id))
    except KeyError:
        return jsonify({"error": "unknown campaign"}), 404


@app.route("/api/v2/presented", methods=["POST"])
def api_v2_presented():
    from app.v2 import inbox
    body = request.get_json(silent=True) or {}
    ok = inbox.presented(str(body.get("id", "")))
    return jsonify({"ok": ok}), (200 if ok else 404)


@app.route("/api/v2/decide", methods=["POST"])
def api_v2_decide():
    from app.v2 import inbox
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(inbox.decide(str(body.get("id", "")), str(body.get("decision", "")), body.get("reason")))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.route("/api/v2/opened", methods=["POST"])
def api_v2_opened():
    from app.v2 import inbox
    body = request.get_json(silent=True) or {}
    inbox.opened(str(body.get("id", "")))
    return jsonify({"ok": True})


@app.route("/api/v2/details/<path:candidate_id>")
def api_v2_details(candidate_id):
    from app.v2 import inbox
    found = inbox.details(candidate_id)
    return (jsonify(found), 200) if found else (jsonify({"error": "not found"}), 404)


@app.route("/api/v2/stats")
def api_v2_stats():
    from app.v2 import inbox, store
    return jsonify({"inbox": inbox.stats(), "strategies": store.strategy_stats(),
                    "last_round": store.get_state("last_round", {})})


@app.route("/api/v2/discovery/next-generation")
def api_v2_next_generation():
    """How the next-generation planner is searching: routes, their yield, pending seeds, last plan."""
    from app.v2 import ng
    return jsonify(ng.status())


@app.route("/api/v2/discovery/hunts")
def api_v2_hunts():
    """v3 pursuit: every hunt (what it is looking for, its state and why it stopped) and the route ledger."""
    from app.v2 import pursuit
    return jsonify(pursuit.status())


@app.route("/api/v2/round", methods=["POST"])
def api_v2_round():
    if controller.status()["state"] == "running":
        return jsonify({"ok": True, "message": "Discovery is already running; new leads will appear here."})
    ok, message = controller.run_v2_round_now(requested=5, continuous=True)
    return jsonify({"ok": ok, "message": message}), (200 if ok else 409)


@app.route("/api/v2/campaigns")
def api_v2_campaigns():
    from app.v2 import intelligence
    return jsonify({"campaigns": intelligence.list_campaigns(limit=int(request.args.get("limit", 20))),
                    "actions": intelligence.actions(limit=10)})


@app.route("/api/v2/investigation/sources")
def api_v2_investigation_sources():
    from app.v2 import intelligence
    return jsonify({"sources": intelligence.source_report()})


@app.route("/api/v2/operations/status")
def api_v2_operations_status():
    from app.v2 import operations
    return jsonify(operations.status())


@app.route("/api/v2/operations/preflight", methods=["POST"])
def api_v2_operations_preflight():
    from app.v2 import sources
    return jsonify(sources.preflight())


@app.route("/api/v2/operations/runs", methods=["POST"])
def api_v2_operations_run():
    from app.v2 import operations
    try:
        body = request.get_json(silent=True) or {}
        if body.get("start") and controller.status()["state"] == "running":
            return jsonify({"error": "discovery is already running"}), 409
        run_id = operations.create_run(body.get("limits"))
        if body.get("start"):
            _start_operational_worker(run_id)
        return jsonify({"run_id": run_id, "state": "RUNNING" if body.get("start") else "QUEUED",
                        "worker_command": f"python -m app.v2.operations {run_id}"}), 201
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/operations/runs/<int:run_id>/<action>", methods=["POST"])
def api_v2_operations_control(run_id, action):
    from app.v2 import operations
    if action not in ("pause", "resume", "stop"):
        return jsonify({"error": "unknown action"}), 404
    try:
        result = operations.control(run_id, {"pause": "PAUSED", "resume": "RUNNING",
                                                  "stop": "STOPPED"}[action])
        if action == "resume" and (not _operational_worker or not _operational_worker.is_alive()):
            _start_operational_worker(run_id)
        return jsonify(result)
    except (ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/operations/watches/<campaign_id>", methods=["POST"])
def api_v2_operations_watch(campaign_id):
    from app.v2 import operations
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(operations.watch_campaign(campaign_id, enabled=body.get("enabled", True),
                                                 interval_seconds=body.get("interval_seconds", 86400)))
    except (KeyError, ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/selection/deferred")
def api_v2_selection_deferred():
    from app.v2 import store
    store.ensure()
    with store.conn() as conn:
        rows = conn.execute("SELECT domain,p,details FROM v2_candidates WHERE status='held' "
                            "AND json_extract(details,'$.selection_deferred') IS NOT NULL "
                            "ORDER BY p DESC LIMIT 30").fetchall()
    import json
    return jsonify({"candidates": [{"domain": r["domain"], "probability": r["p"],
                                   "reason": json.loads(r["details"])["selection_deferred"]} for r in rows]})


@app.route("/api/v2/campaigns/<campaign_id>")
def api_v2_campaign_detail(campaign_id):
    from app.v2 import intelligence
    result = intelligence.detail(campaign_id)
    return (jsonify(result), 200) if result else (jsonify({"error": "not found"}), 404)


@app.route("/api/v2/campaigns/<campaign_id>/review", methods=["POST"])
def api_v2_campaign_review(campaign_id):
    from app.v2 import intelligence
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(intelligence.review_campaign(campaign_id, body.get("decision"), body.get("detail", "")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except KeyError:
        return jsonify({"error": "not found"}), 404


@app.route("/api/v2/campaigns/<campaign_id>/notes", methods=["POST"])
def api_v2_campaign_notes(campaign_id):
    from app.v2 import intelligence
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(intelligence.annotate_campaign(campaign_id, body.get("notes", ""), body.get("tags", [])))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except KeyError:
        return jsonify({"error": "not found"}), 404


@app.route("/api/v2/graph/<path:domain>")
def api_v2_graph(domain):
    from app.v2 import intelligence
    try:
        confidence = max(0., min(1., float(request.args.get("confidence", 0))))
        timestamp = float(request.args["since"]) if "since" in request.args else None
        return jsonify(intelligence.neighbors(domain, limit=25, min_confidence=confidence, at=timestamp))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid graph filter"}), 400


@app.route("/api/v2/graph/reject", methods=["POST"])
def api_v2_reject_relationship():
    from app.v2 import intelligence
    body = request.get_json(silent=True) or {}
    if not body.get("left") or not body.get("right"):
        return jsonify({"error": "two domains are required"}), 400
    try:
        return jsonify({"ok": True, **intelligence.reject_relationship(
            str(body["left"]), str(body["right"]), str(body.get("reason") or ""))})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/campaigns/<campaign_id>/split", methods=["POST"])
def api_v2_split_campaign(campaign_id):
    from app.v2 import intelligence
    body = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, **intelligence.split_campaign(
            campaign_id, body.get("domains") or [], str(body.get("reason") or ""))})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/campaigns/merge", methods=["POST"])
def api_v2_merge_campaigns():
    from app.v2 import intelligence
    body = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, **intelligence.merge_campaigns(
            str(body.get("first") or ""), str(body.get("second") or ""),
            str(body.get("reason") or ""), str(body.get("source_url") or ""))})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/v2/autopilot/<action>", methods=["POST"])
def api_v2_autopilot(action):
    if action == "start":
        ok, message = controller.start_autopilot()
    elif action == "stop":
        ok, message = controller.stop()
    else:
        return jsonify({"ok": False, "message": "unknown action"}), 400
    return jsonify({"ok": ok, "message": message}), (200 if ok else 409)


# ---------- Live event stream ----------

@app.route("/events")
def events_stream():
    return Response(sse_stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # disable proxy buffering (e.g. nginx) for real-time delivery
        "Connection": "keep-alive",
    })


# ---------- Scan control ----------

@app.route("/api/scan/start", methods=["POST"])
def scan_start():
    body = request.get_json(silent=True) or {}
    overrides = {}
    for key in ("batch_size", "headless", "rank_limit", "run_collection", "run_ranking",
                "run_discovery", "risk_threshold", "allow_signup", "deep_wallet_hunt"):
        if key in body:
            overrides[key] = body[key]
    ok, msg = controller.start(**overrides)
    return jsonify({"ok": ok, "message": msg, "status": controller.status()}), (200 if ok else 409)


@app.route("/api/scan/pause", methods=["POST"])
def scan_pause():
    ok, msg = controller.pause()
    return jsonify({"ok": ok, "message": msg, "status": controller.status()}), (200 if ok else 409)


@app.route("/api/scan/resume", methods=["POST"])
def scan_resume():
    ok, msg = controller.resume()
    return jsonify({"ok": ok, "message": msg, "status": controller.status()}), (200 if ok else 409)


@app.route("/api/scan/stop", methods=["POST"])
def scan_stop():
    ok, msg = controller.stop()
    return jsonify({"ok": ok, "message": msg, "status": controller.status()}), (200 if ok else 409)


@app.route("/api/scan/status")
def scan_status():
    return jsonify(controller.status())


# ---------- Stats ----------

@app.route("/api/stats")
def api_stats():
    return jsonify(db.get_stats())


# ---------- Sites ----------

@app.route("/api/sites")
def api_sites():
    query = request.args.get("q", "")
    status = request.args.get("status") or None
    min_score = request.args.get("min_score")
    sort = request.args.get("sort", "score_desc")
    limit = int(request.args.get("limit", 200))
    min_score_val = float(min_score) if min_score not in (None, "",) else None
    sites = db.search_sites(query=query, status=status, min_score=min_score_val, sort=sort, limit=limit)
    return jsonify(sites)


@app.route("/api/sites/high_risk")
def api_high_risk_sites():
    threshold = float(request.args.get("threshold", 5.0))
    limit = int(request.args.get("limit", 50))
    return jsonify(db.list_high_risk_sites(threshold=threshold, limit=limit))


@app.route("/api/site/<int:site_id>")
def api_site_detail(site_id):
    site = db.get_site(site_id)
    if not site:
        return jsonify({"error": "Site not found"}), 404
    pages = db.pages_for_site(site_id)
    wallets = db.wallets_for_site(site_id)
    investigation = db.latest_investigation_for_site(site_id)
    decisions = db.decisions_for_site(site_id, limit=100)
    wallet_evidence = db.wallet_evidence_for_site(site_id)
    discovery_events = db.discovery_events_for_site(site_id)
    return jsonify({
        "site": site, "pages": pages, "wallets": wallets,
        "investigation": investigation, "decisions": decisions,
        "wallet_evidence": wallet_evidence, "discovery_events": discovery_events,
    })


@app.route("/api/add_url", methods=["POST"])
def api_add_url():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL is required"}), 400
    full_url = url if url.startswith("http") else f"http://{url}"
    new_id = db.add_site(full_url, "manual_ui")
    if new_id is None:
        return jsonify({"error": "This domain is already in the system (duplicate)."}), 409
    publish("site_added", {"site_id": new_id, "url": full_url})
    return jsonify({"ok": True, "site_id": new_id})


# ---------- Wallets ----------

@app.route("/api/wallets")
def api_wallets():
    limit = int(request.args.get("limit", 500))
    return jsonify(db.list_all_wallets(limit=limit))


# ---------- Investigations (live status + decision log) ----------

@app.route("/api/investigations/active")
def api_active_investigations():
    return jsonify(db.list_active_investigations())


@app.route("/api/investigations/recent")
def api_recent_investigations():
    limit = int(request.args.get("limit", 20))
    return jsonify(db.list_recent_investigations(limit=limit))


@app.route("/api/investigation/<int:investigation_id>")
def api_investigation_detail(investigation_id):
    investigation = db.get_investigation(investigation_id)
    if not investigation:
        return jsonify({"error": "Investigation not found"}), 404
    decisions = db.decisions_for_investigation(investigation_id)
    return jsonify({"investigation": investigation, "decisions": decisions})


@app.route("/api/site/<int:site_id>/decisions")
def api_site_decisions(site_id):
    limit = int(request.args.get("limit", 200))
    return jsonify(db.decisions_for_site(site_id, limit=limit))


@app.route("/api/site/<int:site_id>/wallet_evidence")
def api_site_wallet_evidence(site_id):
    return jsonify(db.wallet_evidence_for_site(site_id))


# ---------- Discovery (sources, live stats, run history, controls) ----------

@app.route("/api/discovery/stats")
def api_discovery_stats():
    return jsonify(db.get_discovery_stats())


@app.route("/api/discovery/runs")
def api_discovery_runs():
    limit = int(request.args.get("limit", 20))
    return jsonify(db.list_recent_discovery_runs(limit=limit))


@app.route("/api/discovery/run/<int:run_id>")
def api_discovery_run_detail(run_id):
    run = db.get_discovery_run(run_id)
    if not run:
        return jsonify({"error": "Discovery run not found"}), 404
    return jsonify(run)


@app.route("/api/discovery/events")
def api_discovery_events():
    limit = int(request.args.get("limit", 100))
    source = request.args.get("source") or None
    return jsonify(db.recent_discovery_events(limit=limit, source=source))


@app.route("/api/discovery/sources")
def api_discovery_sources():
    """Lists the registered discoverer names so the UI can offer per-source
    toggles without hardcoding the list — new sources appear automatically."""
    from app.discovery.engine import COLD_START_SOURCES
    sources = list(COLD_START_SOURCES.keys()) + ["pivots"]
    return jsonify({"sources": sources})


@app.route("/api/discovery/run", methods=["POST"])
def api_discovery_run_now():
    """Triggers a standalone discovery run (not a full scan cycle)."""
    body = request.get_json(silent=True) or {}
    sources = body.get("sources") or None
    ok, msg = controller.run_discovery_now(sources=sources)
    return jsonify({"ok": ok, "message": msg, "status": controller.status()}), (200 if ok else 409)


# ---------- Findings (review queue) ----------

@app.route("/api/findings")
def api_findings():
    status_filter = request.args.get("status", "pending")
    findings = db.list_findings(review_status=None if status_filter == "all" else status_filter)
    return jsonify(findings)


@app.route("/api/finding/<int:finding_id>")
def api_finding_detail(finding_id):
    finding = db.get_finding(finding_id)
    if not finding:
        return jsonify({"error": "Finding not found"}), 404
    wallets = db.wallets_for_site(finding["site_id"])
    pages = db.pages_for_site(finding["site_id"])
    return jsonify({"finding": finding, "wallets": wallets, "pages": pages})


@app.route("/api/finding/<int:finding_id>/approve", methods=["POST"])
def api_approve_finding(finding_id):
    body = request.get_json(silent=True) or {}
    db.set_finding_review(finding_id, "approved", body.get("notes", ""))
    publish("finding_updated", {"finding_id": finding_id, "review_status": "approved"})
    return jsonify({"ok": True})


@app.route("/api/finding/<int:finding_id>/reject", methods=["POST"])
def api_reject_finding(finding_id):
    body = request.get_json(silent=True) or {}
    db.set_finding_review(finding_id, "rejected", body.get("notes", ""))
    publish("finding_updated", {"finding_id": finding_id, "review_status": "rejected"})
    return jsonify({"ok": True})


@app.route("/api/finding/<int:finding_id>/prepare_form", methods=["POST"])
def api_prepare_form(finding_id):
    """Opens/fills the Google Form up through the last page. Never submits it."""
    finding = db.get_finding(finding_id)
    if not finding or finding["review_status"] != "approved":
        return jsonify({"error": "Finding must be approved before preparing a form submission."}), 400
    wallets = db.wallets_for_site(finding["site_id"])
    publish("log", {"level": "info", "logger": "scamhunter.form_filler",
                     "message": f"Opening report form for finding #{finding_id}..."})
    result = prepare_form_for_review(finding, wallets, headless=False)
    publish("form_status", {"finding_id": finding_id, **result})
    return jsonify(result)


@app.route("/api/finding/<int:finding_id>/confirm_manual_submit", methods=["POST"])
def api_confirm_manual_submit(finding_id):
    """
    Called ONLY after the user tells us, in this UI, that they personally clicked
    Submit in the browser window. This endpoint does not submit anything itself —
    it just records that you did.
    """
    db.mark_finding_submitted(finding_id)
    publish("finding_updated", {"finding_id": finding_id, "submitted_to_form": True})
    return jsonify({"ok": True})


# ---------- Quality pipeline: funnel, triage, deep analysis ----------

@app.route("/api/pipeline/funnel")
def api_pipeline_funnel():
    """The headline funnel numbers: discovered -> triaged -> deep -> high confidence."""
    from app.analysis.pipeline_v2 import funnel_stats
    return jsonify(funnel_stats())


@app.route("/api/pipeline/triage", methods=["POST"])
def api_run_triage():
    body = request.get_json(silent=True) or {}
    limit = int(body.get("limit", 200))
    ok, msg = controller.run_triage_now(limit=limit)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@app.route("/api/pipeline/deep", methods=["POST"])
def api_run_deep_analysis():
    body = request.get_json(silent=True) or {}
    limit = int(body.get("limit", 10))
    ok, msg = controller.run_deep_analysis_now(limit=limit)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@app.route("/api/triage/<int:site_id>")
def api_site_triage(site_id):
    result = db.get_triage(site_id)
    if not result:
        return jsonify({"error": "No triage result for this site"}), 404
    return jsonify(result)


# ---------- High-confidence results (the deliverable) ----------

@app.route("/api/results")
def api_results():
    """
    The main output of the tool: fully-enriched, high-confidence profiles only.
    Deliberately NOT a list of every site scanned.
    """
    from app.config import HIGH_CONFIDENCE_THRESHOLD
    min_conf = request.args.get("min_confidence")
    min_conf = float(min_conf) if min_conf not in (None, "") else HIGH_CONFIDENCE_THRESHOLD
    limit = int(request.args.get("limit", 100))
    return jsonify(db.list_deep_profiles(min_confidence=min_conf, limit=limit))


@app.route("/api/result/<int:site_id>")
def api_result_detail(site_id):
    """One complete evidence profile, with validated wallets attached."""
    profile = db.get_deep_profile(site_id)
    if not profile:
        return jsonify({"error": "No deep-analysis profile for this site"}), 404
    return jsonify({
        "profile": profile,
        "wallets": db.wallets_with_validation_for_site(site_id),
        "triage": db.get_triage(site_id),
        "site": db.get_site(site_id),
    })


# ---------- Google Form submission ----------

@app.route("/api/submission/settings", methods=["GET"])
def api_get_submission_settings():
    from app.submission import get_submission_settings
    settings = get_submission_settings()
    # Never echo the raw team code back in full — show only that it's set.
    return jsonify({
        "username": settings["username"],
        "team_code_set": bool(settings["team_code"]),
        "team_code_masked": ("•" * 8 + settings["team_code"][-4:]) if settings["team_code"] else "",
        "mode": settings["mode"],
        "configured": settings["configured"],
    })


@app.route("/api/submission/settings", methods=["POST"])
def api_save_submission_settings():
    from app.submission import save_submission_settings
    body = request.get_json(silent=True) or {}
    try:
        settings = save_submission_settings(
            username=body.get("username"),
            team_code=body.get("team_code"),
            mode=body.get("mode"),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    publish("submission_settings_updated", {"configured": settings["configured"],
                                             "mode": settings["mode"]})
    return jsonify({"ok": True, "configured": settings["configured"], "mode": settings["mode"]})


@app.route("/api/submission/validate/<int:site_id>")
def api_validate_submission(site_id):
    from app.submission import validate_for_submission
    return jsonify(validate_for_submission(site_id))


@app.route("/api/submission/prepare/<int:site_id>", methods=["POST"])
def api_prepare_submission(site_id):
    from app.submission import prepare_submission
    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    try:
        result = prepare_submission(site_id, mode=mode, headless=False)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    publish("submission_prepared", {"site_id": site_id, "status": result["status"],
                                     "mode": result["mode"]})
    return jsonify(result)


@app.route("/api/submission/confirm/<int:submission_id>", methods=["POST"])
def api_confirm_submission(submission_id):
    """Records that the operator personally clicked Submit in the form."""
    from app.submission import confirm_submitted
    result = confirm_submitted(submission_id)
    publish("submission_confirmed", {"submission_id": submission_id})
    return jsonify(result)


@app.route("/api/submission/history")
def api_submission_history():
    limit = int(request.args.get("limit", 50))
    return jsonify(db.list_form_submissions(limit=limit))



# ---------- v2: Intelligence graph, clusters, search, export ----------

@app.route("/api/intel/stats")
def api_intel_stats():
    return jsonify(db.intelligence_stats())


@app.route("/api/search")
def api_global_search():
    """Global search across every kind of collected intelligence."""
    query = request.args.get("q", "")
    limit = int(request.args.get("limit", 50))
    return jsonify(db.global_search(query, limit=limit))


@app.route("/api/clusters")
def api_clusters():
    """Website families, highest-priority first."""
    limit = int(request.args.get("limit", 100))
    min_sites = int(request.args.get("min_sites", 2))
    return jsonify(db.list_clusters(limit=limit, min_sites=min_sites))


@app.route("/api/cluster/<int:cluster_id>")
def api_cluster_detail(cluster_id):
    cluster = db.get_cluster(cluster_id)
    if not cluster:
        return jsonify({"error": "Cluster not found"}), 404
    return jsonify(cluster)


@app.route("/api/correlate", methods=["POST"])
def api_run_correlation():
    """Derive relationships from observations, then rebuild clusters."""
    from app.analysis.correlation import run_correlation
    return jsonify(run_correlation())


@app.route("/api/wallet_reuse")
def api_wallet_reuse():
    from app.analysis.correlation import wallet_reuse_report
    min_sites = int(request.args.get("min_sites", 2))
    return jsonify(wallet_reuse_report(min_sites=min_sites))


@app.route("/api/workspace/<int:site_id>")
def api_workspace(site_id):
    """
    The investigation workspace payload:
    Site -> Pages -> Deposit Options -> Wallets -> Related Sites,
    plus the evidence timeline and change history.
    """
    site = db.get_site(site_id)
    if not site:
        return jsonify({"error": "Site not found"}), 404
    profile = db.get_deep_profile(site_id)
    return jsonify({
        "site": site,
        "profile": profile,
        "pages": db.pages_for_site(site_id),
        "deposit_options": db.deposit_options_for_site(site_id),
        "wallets": db.wallets_with_validation_for_site(site_id),
        "related_sites": db.relationships_for_site(site_id),
        "indicators": db.indicators_for_site(site_id),
        "cluster": db.cluster_for_site(site_id),
        "timeline": db.timeline_for_site(site_id),
        "history": db.history_for_site(site_id),
        "triage": db.get_triage(site_id),
    })


@app.route("/api/site/<int:site_id>/timeline")
def api_site_timeline(site_id):
    return jsonify(db.timeline_for_site(site_id))


@app.route("/api/changes")
def api_recent_changes():
    """Historical tracking: what changed across all sites, most recent first."""
    return jsonify(db.recent_changes(limit=int(request.args.get("limit", 100))))


@app.route("/api/related/discover", methods=["POST"])
def api_discover_related():
    """Pivot from high-confidence sites to find more of the same operation."""
    from app.discovery.related_sites import discover_related_sites
    body = request.get_json(silent=True) or {}
    return jsonify(discover_related_sites(
        min_confidence=float(body.get("min_confidence", 0.70)),
        max_seeds=int(body.get("max_seeds", 10)),
    ))


@app.route("/api/export/<fmt>")
def api_export(fmt):
    """Export in CryptoWalletLogger or Wallet Investigator format."""
    from app.export import EXPORTERS
    if fmt not in EXPORTERS:
        return jsonify({"error": f"Unknown format. Available: {list(EXPORTERS)}"}), 400
    mimetype, ext, fn = EXPORTERS[fmt]
    min_conf = float(request.args.get("min_confidence", 0.70))
    body = fn(min_confidence=min_conf)
    return Response(body, mimetype=mimetype, headers={
        "Content-Disposition": f'attachment; filename="scamhunter_{fmt}.{ext}"'})


@app.route("/api/export/evidence/<int:site_id>")
def api_export_evidence(site_id):
    from app.export import export_evidence_bundle
    return Response(export_evidence_bundle(site_id), mimetype="application/json",
                    headers={"Content-Disposition":
                             f'attachment; filename="evidence_site_{site_id}.json"'})


@app.route("/api/export/cluster/<int:cluster_id>")
def api_export_cluster(cluster_id):
    from app.export import export_cluster
    return Response(export_cluster(cluster_id), mimetype="application/json",
                    headers={"Content-Disposition":
                             f'attachment; filename="cluster_{cluster_id}.json"'})



# ---------- v0.3: Discovery Pivot Engine ----------

@app.route("/api/pivot/stats")
def api_pivot_stats():
    return jsonify(db.pivot_stats())


@app.route("/api/pivot/runs")
def api_pivot_runs():
    return jsonify(db.list_pivot_runs(limit=int(request.args.get("limit", 20))))


@app.route("/api/pivot/run/<int:run_id>")
def api_pivot_run_detail(run_id):
    run = db.get_pivot_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    run["leads"] = db.leads_for_run(run_id)
    run["paths"] = db.paths_for_run(run_id)
    return jsonify(run)


@app.route("/api/pivot/leads")
def api_pivot_leads():
    """The engine's worklist: sites reached by pivoting, ranked by connection strength."""
    from app.discovery.pivot_engine import prioritized_leads
    return jsonify(prioritized_leads(limit=int(request.args.get("limit", 50))))


@app.route("/api/pivot/paths/<int:site_id>")
def api_pivot_paths(site_id):
    """Every Discovery Path that reached this site."""
    return jsonify({
        "site": db.get_site(site_id),
        "convergence": db.get_convergence(site_id),
        "paths": db.paths_for_site(site_id),
    })


@app.route("/api/pivot/expand", methods=["POST"])
def api_pivot_expand():
    body = request.get_json(silent=True) or {}
    ok, msg = controller.run_pivot_expansion_now(
        max_depth=int(body.get("max_depth", 2)),
        max_new_sites=int(body.get("max_new_sites", 50)),
        max_leads=int(body.get("max_leads", 200)),
        min_seed_confidence=float(body.get("min_seed_confidence", 0.70)),
        seed_site_ids=body.get("seed_site_ids"),
    )
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


# ---------- v0.4: Autonomous Discovery Intelligence ----------

@app.route("/api/campaigns")
def api_campaigns():
    return jsonify({"campaigns": db.list_campaigns(
        limit=int(request.args.get("limit", 50)),
        status=request.args.get("status") or None)})


@app.route("/api/campaign/<int:campaign_id>")
def api_campaign(campaign_id):
    from app.discovery.campaigns import campaign_report
    report = campaign_report(campaign_id)
    return jsonify(report), (404 if report.get("error") else 200)


@app.route("/api/campaign/create", methods=["POST"])
def api_campaign_create():
    from app.discovery.campaigns import create_campaign, SEED_KINDS
    body = request.get_json(silent=True) or {}
    seed_kind = (body.get("seed_kind") or "domain").strip()
    seed_value = (body.get("seed_value") or "").strip()
    if not seed_value:
        return jsonify({"ok": False, "message": "A seed value is required."}), 400
    if seed_kind not in SEED_KINDS:
        return jsonify({"ok": False,
                         "message": f"Seed kind must be one of: {', '.join(SEED_KINDS)}."}), 400

    kwargs = {}
    for key, cast in (("max_waves", int), ("max_candidates", int), ("max_leads", int),
                      ("max_api_calls", int), ("max_seconds", int),
                      ("max_deep_analyses", int), ("promote_min_connection", float)):
        if body.get(key) is not None:
            kwargs[key] = cast(body[key])

    created = create_campaign(body.get("name") or "", seed_kind, seed_value, **kwargs)
    publish("campaign_created", created)

    if body.get("start", True):
        ok, msg = controller.run_campaign_now(created["campaign_id"])
        return jsonify({"ok": ok, "message": msg, **created}), (200 if ok else 409)
    return jsonify({"ok": True, "message": "Campaign created but not started.", **created})


@app.route("/api/campaign/<int:campaign_id>/run", methods=["POST"])
def api_campaign_run(campaign_id):
    ok, msg = controller.run_campaign_now(campaign_id)
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@app.route("/api/campaign/<int:campaign_id>/budget")
def api_campaign_budget(campaign_id):
    return jsonify({"budget": db.campaign_budget_state(campaign_id),
                     "stages": db.stages_for_campaign(campaign_id)})


@app.route("/api/techniques")
def api_techniques():
    from app.discovery.technique_learning import learning_report
    return jsonify({
        "techniques": learning_report(),
        "note": ("Yield scores are derived from this installation's own results. A "
                 "suspended technique is paused to save budget, not disabled — it is "
                 "re-tried periodically."),
    })


@app.route("/api/techniques/recompute", methods=["POST"])
def api_techniques_recompute():
    from app.discovery.technique_learning import update_all_scores
    return jsonify({"ok": True, "updated": update_all_scores()})


@app.route("/api/families/watch")
def api_families_watch():
    from app.discovery.cluster_watch import watch_report
    return jsonify(watch_report())


@app.route("/api/families/scan", methods=["POST"])
def api_families_scan():
    ok, msg = controller.run_cluster_watch_now()
    return jsonify({"ok": ok, "message": msg}), (200 if ok else 409)


@app.route("/api/families/signature/<int:cluster_id>")
def api_family_signature(cluster_id):
    from app.discovery.cluster_watch import build_signature
    return jsonify(build_signature(cluster_id))


@app.route("/api/candidate/<int:site_id>/priority")
def api_candidate_priority(site_id):
    from app.discovery.candidate_priority import score_candidate
    return jsonify(score_candidate(site_id))


@app.route("/api/graph")
def api_graph():
    from app.discovery.knowledge_graph import build_graph
    return jsonify(build_graph(
        site_limit=int(request.args.get("limit", 300)),
        min_indicator_strength=float(request.args.get("min_strength", 0)),
        include_infrastructure=request.args.get("infrastructure", "1") != "0",
        observed_only=request.args.get("observed_only") == "1"))


@app.route("/api/graph/stats")
def api_graph_stats():
    from app.discovery.knowledge_graph import graph_stats
    return jsonify(graph_stats())


@app.route("/api/graph/site/<int:site_id>")
def api_graph_site(site_id):
    from app.discovery.knowledge_graph import neighbourhood
    result = neighbourhood(site_id, radius=int(request.args.get("radius", 1)))
    return jsonify(result), (404 if result.get("error") else 200)


@app.route("/api/graph/export")
def api_graph_export():
    from app.discovery.knowledge_graph import export_for_platform
    return jsonify(export_for_platform(site_limit=int(request.args.get("limit", 500))))


# ---------- v0.5: Main Platform integration ----------

@app.route("/api/integration/status")
def api_integration_status():
    from app.integration.v4.sync import sync_report
    return jsonify(sync_report())


@app.route("/api/integration/contract")
def api_integration_contract():
    from app.integration.v4.gap_report import report
    return jsonify(report())


@app.route("/api/integration/connect", methods=["POST"])
def api_integration_connect():
    """Handshake on demand — the button a person presses after fixing a URL."""
    from app.integration.v4.client import default_client
    return jsonify(default_client().register())


@app.route("/api/integration/heartbeat", methods=["POST"])
def api_integration_heartbeat():
    from app.integration.v4.client import default_client
    return jsonify(default_client().heartbeat())


@app.route("/api/integration/sync", methods=["POST"])
def api_integration_sync():
    from app.integration.v4.sync import sync_until_drained
    result = sync_until_drained(progress_cb=lambda e, d: publish(e, d))
    publish("integration_sync", result)
    return jsonify(result)


@app.route("/api/integration/outbox")
def api_integration_outbox():
    return jsonify({
        "stats": db.outbox_stats(),
        "events": db.list_outbox(status=request.args.get("status") or None,
                                  limit=int(request.args.get("limit", 100))),
    })


@app.route("/api/integration/outbox/<int:outbox_id>/cancel", methods=["POST"])
def api_integration_cancel(outbox_id):
    ok = db.cancel_outbox_event(outbox_id)
    return jsonify({"ok": ok,
                     "message": ("Event cancelled; it will not be sent."
                                 if ok else "That event is not cancellable.")})


@app.route("/api/integration/retry", methods=["POST"])
def api_integration_retry():
    """Clears backoff so everything waiting is tried on the next pass."""
    with db.get_conn() as conn:
        cur = conn.execute(
            "UPDATE integration_outbox SET next_attempt_at=0 WHERE status='failed'")
        cleared = cur.rowcount
    return jsonify({"ok": True, "cleared": cleared,
                     "message": f"{cleared} deferred event(s) will be retried immediately."})


@app.route("/api/integration/handoff")
def api_integration_handoff():
    from app.integration.handoff import handoff_report
    return jsonify(handoff_report())


@app.route("/api/integration/site/<int:site_id>")
def api_integration_site(site_id):
    from app.integration.v4.emitter import should_send_site
    decision = should_send_site(site_id)
    return jsonify({
        "decision": {k: v for k, v in decision.items() if k != "priority"},
        "priority": decision.get("priority"),
        "link": db.get_site_investigation(site_id),
        "receipts": db.receipts_for_site(site_id),
    })


@app.route("/api/integration/emit/<int:site_id>", methods=["POST"])
def api_integration_emit(site_id):
    from app.integration.v4.emitter import queue_candidate
    return jsonify(queue_candidate(site_id))


# ---------- v0.5: discovery statistics ----------

@app.route("/api/stats/overview")
def api_stats_overview():
    from app.discovery.discovery_stats import overview
    return jsonify(overview())


@app.route("/api/stats/sources")
def api_stats_sources():
    from app.discovery.discovery_stats import source_performance
    return jsonify(source_performance(limit=int(request.args.get("limit", 50))))


@app.route("/api/stats/pivots")
def api_stats_pivots():
    from app.discovery.discovery_stats import pivot_performance
    return jsonify(pivot_performance())


@app.route("/api/stats/campaigns")
def api_stats_campaigns():
    from app.discovery.discovery_stats import campaign_performance
    return jsonify(campaign_performance())


@app.route("/api/stats/indicators")
def api_stats_indicators():
    from app.discovery.discovery_stats import indicator_performance
    return jsonify(indicator_performance())


@app.route("/api/stats/indicators/sweep", methods=["POST"])
def api_stats_indicator_sweep():
    from app.discovery.indicator_noise import evaluate_and_retire
    result = evaluate_and_retire(progress_cb=lambda e, d: publish(e, d))
    return jsonify(result)


@app.route("/api/stats/indicators/reinstate", methods=["POST"])
def api_stats_indicator_reinstate():
    from app.discovery.indicator_noise import reinstate
    body = request.get_json(silent=True) or {}
    ok = reinstate(body.get("indicator_type", ""), body.get("value", ""))
    return jsonify({"ok": ok,
                     "message": ("Indicator is back in play."
                                 if ok else "No retired indicator matched.")})


# ---------- v0.7: adaptive discovery ----------

@app.route("/api/candidate/<int:site_id>/why")
def api_why_surfaced(site_id):
    """Everything behind one candidate, so an analyst never has to read logs."""
    from app.discovery.explain import why_surfaced
    result = why_surfaced(site_id)
    return jsonify(result), (404 if result.get("error") else 200)


@app.route("/api/candidate/<int:site_id>/novelty")
def api_candidate_novelty(site_id):
    from app.discovery.novelty import score
    return jsonify(score(site_id))


@app.route("/api/candidates/novel")
def api_novel_candidates():
    from app.discovery.novelty import novel_candidates
    return jsonify({"candidates": novel_candidates(
        limit=int(request.args.get("limit", 50)),
        min_novelty=float(request.args.get("min_novelty", 0.4)))})


@app.route("/api/memory")
def api_candidate_memory():
    from app.discovery.candidate_memory import memory_report
    return jsonify(memory_report())


@app.route("/api/memory/sweep", methods=["POST"])
def api_memory_sweep():
    """Revisit dismissed candidates whose evidence has since changed."""
    from app.discovery.candidate_memory import sweep_for_reconsideration
    return jsonify(sweep_for_reconsideration())


@app.route("/api/candidate/<int:site_id>/reconsider", methods=["POST"])
def api_candidate_reconsider(site_id):
    from app.discovery.candidate_memory import reconsider
    return jsonify(reconsider(site_id))


@app.route("/api/campaign/<int:campaign_id>/saturation")
def api_campaign_saturation(campaign_id):
    from app.discovery.saturation import assess, why_expansion_stopped
    return jsonify({"current": assess(campaign_id),
                     "why_stopped": why_expansion_stopped(campaign_id)})


@app.route("/api/campaign/<int:campaign_id>/control", methods=["POST"])
def api_campaign_control(campaign_id):
    """Pause, resume, stop after the current wave, or change a budget."""
    body = request.get_json(silent=True) or {}
    action = (body.get("action") or "").lower()

    if action == "pause":
        db.set_campaign_control(campaign_id, paused=True)
        message = "Campaign will pause at the end of the current wave."
    elif action == "resume":
        db.set_campaign_control(campaign_id, paused=False, stop_after_current=False)
        ok, message = controller.run_campaign_now(campaign_id)
        return jsonify({"ok": ok, "message": message}), (200 if ok else 409)
    elif action == "stop_after_current":
        db.set_campaign_control(campaign_id, stop_after_current=True)
        message = "Campaign will stop after finishing the wave in progress."
    elif action == "change_budget":
        changes = body.get("budget") or {}
        if not changes:
            return jsonify({"ok": False, "message": "No budget changes supplied."}), 400
        db.set_campaign_control(campaign_id, budget_changes=changes)
        message = (f"Budget change queued: {changes}. It takes effect at the next wave "
                   "boundary so no stage is left half-done.")
    else:
        return jsonify({"ok": False,
                         "message": ("action must be pause, resume, stop_after_current or "
                                     "change_budget.")}), 400

    return jsonify({"ok": True, "message": message,
                     "control": db.get_campaign_control(campaign_id)})


@app.route("/api/campaign/<int:campaign_id>/allocation")
def api_campaign_allocation(campaign_id):
    return jsonify(db.get_campaign_allocation(campaign_id) or
                    {"allocation": {}, "explanation": "No allocation recorded yet."})


@app.route("/api/main")
def api_main_screen():
    """
    The operational main screen: what is running, what needs attention, what
    was just found, and what went out. Counts and lists only — no vanity
    statistics.
    """
    from app.discovery.novelty import novel_candidates
    from app.discovery.candidate_memory import memory_report
    from app.discovery.discovery_stats import overview

    campaigns = [c for c in db.list_campaigns(limit=25)
                 if c.get("status") in ("running", "paused", "pending")]
    handed_over = db.sites_sent_to_platform(limit=15)
    memory = memory_report(limit=10)

    return jsonify({
        "active_campaigns": [
            {"campaign_id": c["id"], "name": c.get("name"), "status": c.get("status"),
             "wave": c.get("current_wave"), "stage": c.get("current_stage"),
             "seed": f"{c.get('seed_kind')}:{str(c.get('seed_value'))[:40]}",
             "stats": {k: v for k, v in (c.get("stats") or {}).items()
                       if k != "wave_seeds"},
             "control": db.get_campaign_control(c["id"])}
            for c in campaigns
        ],
        "high_priority": [
            {"site_id": r["site_id"], "domain": r["domain"],
             "investigation_id": r.get("investigation_id"),
             "state": r.get("platform_state")}
            for r in handed_over[:10]
        ],
        "new_discoveries": novel_candidates(limit=10, min_novelty=0.3),
        "needs_review": {
            "deferred_batches": db.outbox_stats()["failed"],
            "inconclusive": memory["counts"].get("inconclusive", 0),
            "unreachable": memory["counts"].get("unreachable", 0),
        },
        "recent_handoffs": [
            {"domain": r["domain"], "investigation_id": r.get("investigation_id"),
             "investigator_job_id": r.get("investigator_job_id"),
             "last_sent_at": r.get("last_sent_at")}
            for r in handed_over[:10]
        ],
        "performance": overview(),
        "integration": {"running": controller.integration_running()},
    })


# ---------- v0.7: platform link lifecycle ----------

@app.route("/api/integration/link/start", methods=["POST"])
def api_integration_link_start():
    ok, message = controller.start_integration()
    return jsonify({"ok": ok, "message": message,
                     "running": controller.integration_running()}), (200 if ok else 409)


@app.route("/api/integration/link/stop", methods=["POST"])
def api_integration_link_stop():
    ok, message = controller.stop_integration()
    return jsonify({"ok": ok, "message": message,
                     "running": controller.integration_running()}), (200 if ok else 409)


@app.route("/api/integration/link/status")
def api_integration_link_status():
    return jsonify({"running": controller.integration_running()})


@app.route("/api/schema")
def api_schema_status():
    return jsonify(db.schema_status())


# ---------- v0.6: Discovery Performance ----------

@app.route("/api/performance/overview")
def api_performance_overview():
    """The whole funnel, end to end, including downstream outcomes."""
    from app.discovery.discovery_stats import overview, source_performance, pivot_performance
    from app.discovery.feedback import feedback_report
    from app.discovery.budget_allocator import allocation_report
    feedback = feedback_report(limit=25)
    return jsonify({
        "funnel": overview(),
        "sources": source_performance(limit=25)["sources"],
        "pivots": pivot_performance()["pivots"],
        "feedback": {"recent": feedback["recent"][:25],
                      "by_outcome": feedback["by_outcome"],
                      "note": feedback["note"]},
        "attribution": feedback["attributions"],
        "allocation": allocation_report(),
        "history": db.discovery_history(days=30),
    })


@app.route("/api/performance/feedback")
def api_performance_feedback():
    from app.discovery.feedback import feedback_report
    return jsonify(feedback_report(limit=int(request.args.get("limit", 100))))


@app.route("/api/performance/feedback", methods=["POST"])
def api_performance_record_feedback():
    """
    Accepts a downstream outcome directly, for operators replaying a result or
    for a platform that pushes rather than waits to be polled.
    """
    from app.discovery.feedback import record_outcome
    body = request.get_json(silent=True) or {}
    if not body.get("feedback_id"):
        return jsonify({"ok": False, "message": "feedback_id is required."}), 400
    result = record_outcome(
        body["feedback_id"], domain=body.get("domain", ""),
        site_id=body.get("site_id"), investigation_id=body.get("investigation_id"),
        deposit_pages=int(body.get("deposit_pages", 0)),
        wallets=int(body.get("wallets", 0)),
        infrastructure=int(body.get("infrastructure", 0)),
        relationships=int(body.get("relationships", 0)),
        pages_examined=int(body.get("pages_examined", 0)),
        reachable=body.get("reachable"), outcome=body.get("outcome"),
        detail=body.get("detail", ""), campaign_key=body.get("campaign_key", ""))
    return jsonify(result)


@app.route("/api/performance/poll", methods=["POST"])
def api_performance_poll():
    from app.integration.v4.feedback_sync import poll_outcomes
    return jsonify(poll_outcomes())


@app.route("/api/performance/allocation")
def api_performance_allocation():
    from app.discovery.budget_allocator import allocation_report
    return jsonify(allocation_report())


@app.route("/api/performance/history")
def api_performance_history():
    return jsonify({"history": db.discovery_history(days=int(request.args.get("days", 60)))})


@app.route("/api/performance/snapshot", methods=["POST"])
def api_performance_snapshot():
    return jsonify(db.snapshot_discovery_day())


@app.route("/api/performance/paths/<int:site_id>")
def api_performance_paths(site_id):
    from app.discovery.path_quality import site_path_summary
    return jsonify(site_path_summary(site_id))


@app.route("/api/performance/dedup")
def api_performance_dedup():
    from app.discovery.dedup import dedup_report
    return jsonify(dedup_report())


@app.route("/api/performance/rate_limits")
def api_performance_rate_limits():
    from app.discovery.rate_limiter import budget_report
    return jsonify(budget_report())


# ---------- v0.6: v4 contract surface ----------

@app.route("/api/integration/gaps")
def api_integration_gaps():
    from app.integration.v4.gap_report import report
    return jsonify(report())


@app.route("/api/integration/gaps.md")
def api_integration_gaps_markdown():
    from app.integration.v4.gap_report import markdown
    return Response(markdown(), mimetype="text/markdown")


@app.route("/api/integration/jobs")
def api_integration_jobs():
    from app.integration.v4.jobs import jobs_report
    return jsonify(jobs_report())


@app.route("/api/integration/jobs/claim", methods=["POST"])
def api_integration_claim_job():
    from app.integration.v4.jobs import claim_and_run_one
    return jsonify(claim_and_run_one(progress_cb=lambda e, d: publish(e, d)))


@app.route("/api/integration/platform_status")
def api_integration_platform_status():
    """The platform's own view of this module, from GET /api/v1/integration/status."""
    from app.integration.v4.client import default_client
    return jsonify(default_client().integration_status())


# ---------- Settings ----------

@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(_load_settings())


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    body = request.get_json(silent=True) or {}
    current = _load_settings()
    for key in DEFAULT_SETTINGS:
        if key in body and body[key] is not None:
            db.set_setting(key, body[key])
            current[key] = body[key]
    publish("settings_updated", current)
    return jsonify({"ok": True, "settings": current})


# ---------- Evidence (screenshots / HTML snapshots) ----------

@app.route("/evidence/<path:filename>")
def evidence_file(filename):
    return send_from_directory(BASE_DIR / "evidence" / "screenshots", filename)


@app.route("/api/integration/platform-feedback",methods=["POST"])
def api_platform_feedback():
    from app.integration.v4.push_feedback import receive
    status,result=receive(request.get_data(cache=False),{k.lower():v for k,v in request.headers.items()})
    return jsonify(result),status


if __name__ == "__main__":
    app.run(debug=False, host=os.getenv("SITE_FINDER_HOST", "127.0.0.1"),
            port=int(os.getenv("SITE_FINDER_PORT", "5000")), threaded=True)
