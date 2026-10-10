"""
The scan controller: the single source of truth for "is a scan running right
now", and the thing the UI's Start/Pause/Stop buttons talk to.

Runs the collect -> rank -> investigate cycle in a background thread, using
the existing pipeline/navigator/queue_worker code unchanged except for the
optional progress_cb/should_stop hooks added to SiteInvestigation. Every
meaningful step publishes an event on the shared event bus (app/events.py)
so any number of connected browser tabs see live progress without polling.

States: idle -> running -> (paused <-> running) -> idle
                         -> stopping -> idle

Pause works by blocking the worker loop between sites (and between pages
within a site, via should_stop/should_pause checks) rather than freezing an
in-flight browser action — Playwright actions themselves aren't interruptible
mid-call, so "pause" takes effect at the next safe checkpoint, typically
within a second or two.
"""
import logging
import threading
import time

from app import db
from app.events import publish
from app.collectors import run_collectors
from app.ranker import rank_site
from app.investigate.navigator import investigate_site
from app.pipeline import draft_finding_if_evidence
from app.discovery.engine import DiscoveryEngine

logger = logging.getLogger("scamhunter.runner")


class ScanController:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._sync_worker = None      # v0.7: the background Main Platform link
        self._stop_event = threading.Event()
        self._pause_event = threading.Event()  # set = paused
        self.state = "idle"  # idle | running | paused | stopping
        self.current_site: dict | None = None
        self.settings = {
            "batch_size": 5,
            "headless": True,
            "rank_limit": 500,
            "run_collection": True,
            "run_ranking": True,
            "run_discovery": True,
            "discovery_sources": None,  # None = all registered sources
            "risk_threshold": 5.0,   # only auto-investigate sites scoring at/above this
            "allow_signup": False,
            "deep_wallet_hunt": False,
            "quality_pipeline": True,   # quality-over-quantity funnel is the default path
            "triage_limit": 200,        # how many sites to fast-triage per scan
            "deep_limit": 10,           # how many strong candidates to deep-analyze per scan  # more aggressive wallet-only crawl: bigger page/link
                                        # budgets, prioritizes deposit-type pages, clicks
                                        # through currency tabs, continues into the account
                                        # area after a signup that succeeds cleanly
        }

    # ---------- public control API ----------

    def start(self, **overrides):
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running."
            self.settings.update({k: v for k, v in overrides.items() if v is not None})
            self._stop_event.clear()
            self._pause_event.clear()
            self.state = "running"
            self._thread = threading.Thread(target=self._run_loop, daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state, "settings": self.settings})
        return True, "Scan started."

    def pause(self):
        with self._lock:
            if self.state != "running":
                return False, "No active scan to pause."
            self._pause_event.set()
            self.state = "paused"
        publish("scan_state", {"state": self.state})
        publish("log", {"level": "info", "logger": "scamhunter.runner", "message": "Scan paused."})
        return True, "Scan paused."

    def resume(self):
        with self._lock:
            if self.state != "paused":
                return False, "Scan is not paused."
            self._pause_event.clear()
            self.state = "running"
        publish("scan_state", {"state": self.state})
        publish("log", {"level": "info", "logger": "scamhunter.runner", "message": "Scan resumed."})
        return True, "Scan resumed."

    def stop(self):
        with self._lock:
            if self.state not in ("running", "paused"):
                return False, "No active scan to stop."
            self.state = "stopping"
            self._stop_event.set()
            self._pause_event.clear()  # release any pause-wait so the loop can see the stop flag
        publish("scan_state", {"state": self.state})
        publish("log", {"level": "info", "logger": "scamhunter.runner", "message": "Stopping scan..."})
        return True, "Stopping scan."

    def run_discovery_now(self, sources=None):
        """
        Standalone discovery trigger for the UI's 'Run Discovery Now' button —
        runs just the discovery phase in the background without starting a full
        scan cycle. Uses the same busy-check as start() so it can't overlap with
        a running scan or another discovery run.
        """
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._pause_event.clear()
            self._thread = threading.Thread(
                target=self._run_discovery_only, args=(sources,), daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, "Discovery started."

    def _run_discovery_only(self, sources):
        try:
            self._run_discovery_with_events(sources=sources)
        except Exception as e:
            logger.exception("Standalone discovery run crashed")
            publish("error", {"message": f"Discovery run failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})
            publish("log", {"level": "info", "logger": "scamhunter.runner", "message": "Discovery finished."})

    def run_triage_now(self, limit: int = 200):
        """
        Standalone fast-triage pass over the discovery pool. Cheap and wide —
        safe to run across thousands of sites, since each one costs a single
        small HTTP GET.
        """
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._pause_event.clear()
            self._thread = threading.Thread(target=self._run_triage_only, args=(limit,), daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, f"Triage started (up to {limit} sites)."

    def _run_triage_only(self, limit):
        from app.analysis.pipeline_v2 import run_triage_stage
        try:
            summary = run_triage_stage(
                limit=limit,
                progress_cb=lambda event, data: publish(event, data),
                should_stop=self._should_stop,
            )
            publish("log", {"level": "info", "logger": "scamhunter.runner",
                             "message": (f"Triage complete: {summary['passed']} of "
                                         f"{summary['triaged']} sites cleared the quality gate "
                                         f"({summary['rejected']} rejected as too weak).")})
        except Exception as e:
            logger.exception("Triage run crashed")
            publish("error", {"message": f"Triage failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    def run_deep_analysis_now(self, limit: int = 10):
        """
        Standalone deep-analysis pass over the strongest triage survivors.
        Expensive and narrow — this is where scanning time is concentrated.
        """
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._pause_event.clear()
            self._thread = threading.Thread(target=self._run_deep_only, args=(limit,), daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, f"Deep analysis started (up to {limit} strongest candidates)."

    def _run_deep_only(self, limit):
        from app.analysis.pipeline_v2 import run_deep_analysis_stage
        try:
            summary = run_deep_analysis_stage(
                limit=limit,
                progress_cb=lambda event, data: publish(event, data),
                should_stop=self._should_stop,
                allow_signup=self.settings.get("allow_signup", False),
            )
            publish("log", {"level": "info", "logger": "scamhunter.runner",
                             "message": (f"Deep analysis complete: {summary['analyzed']} analyzed, "
                                         f"{summary['high_confidence']} reached high confidence.")})
        except Exception as e:
            logger.exception("Deep analysis run crashed")
            publish("error", {"message": f"Deep analysis failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    def run_pivot_expansion_now(self, max_depth=2, max_new_sites=50, max_leads=200,
                                 min_seed_confidence=0.70, seed_site_ids=None):
        """Standalone Discovery Pivot Engine run, in the background."""
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._pause_event.clear()
            self._thread = threading.Thread(
                target=self._run_pivot_only,
                args=(max_depth, max_new_sites, max_leads, min_seed_confidence, seed_site_ids),
                daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, f"Pivot expansion started (depth {max_depth}, up to {max_new_sites} new sites)."

    def _run_pivot_only(self, max_depth, max_new_sites, max_leads, min_seed_confidence, seed_site_ids):
        from app.discovery.pivot_engine import run_pivot_expansion
        try:
            result = run_pivot_expansion(
                seed_site_ids=seed_site_ids, min_seed_confidence=min_seed_confidence,
                max_depth=max_depth, max_new_sites=max_new_sites, max_leads=max_leads,
                progress_cb=lambda e, d: publish(e, d), should_stop=self._should_stop)
            if result.get("note"):
                publish("log", {"level": "warning", "logger": "scamhunter.pivot",
                                 "message": result["note"]})
            else:
                publish("log", {"level": "info", "logger": "scamhunter.pivot",
                                 "message": (f"Pivot expansion finished ({result['stopped_reason']}): "
                                             f"{result['leads_executed']} pivot(s) run from "
                                             f"{result['seeds']} seed(s), {result['new_sites']} new "
                                             f"candidate site(s), {result['converged_sites']} site(s) "
                                             "with a connection score.")})
        except Exception as e:
            logger.exception("Pivot expansion crashed")
            publish("error", {"message": f"Pivot expansion failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    # ---------- v0.4: autonomous discovery campaigns ----------

    def run_campaign_now(self, campaign_id: int):
        """
        Runs or resumes one discovery campaign in the background. Resuming is
        the same call as starting: completed stages are skipped, not repeated.
        """
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._pause_event.clear()
            self._thread = threading.Thread(
                target=self._run_campaign_only, args=(campaign_id,), daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, f"Campaign {campaign_id} started."

    def _run_campaign_only(self, campaign_id: int):
        from app.discovery.campaigns import run_campaign
        try:
            result = run_campaign(
                campaign_id, progress_cb=lambda e, d: publish(e, d),
                should_stop=self._should_stop)
            if result.get("error"):
                publish("error", {"message": result["error"]})
            else:
                publish("log", {"level": "info", "logger": "scamhunter.campaigns",
                                 "message": (
                                     f"Campaign {campaign_id} {result['status']} "
                                     f"({result['stopped_reason']}): "
                                     f"{result.get('leads_executed', 0)} lead(s) run, "
                                     f"{result.get('new_sites', 0)} new candidate site(s), "
                                     f"{result.get('validated', 0)} validated, "
                                     f"{result.get('promoted', 0)} promoted to deep analysis, "
                                     f"{result.get('rejected_noise', 0)} set aside as "
                                     "too weakly connected or low-yield.")})
        except Exception as e:
            logger.exception("Campaign crashed")
            publish("error", {"message": f"Campaign failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    def run_cluster_watch_now(self):
        """Checks recently-seen domains against every known family signature."""
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run_cluster_watch_only, daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, "Family watch started."

    def _run_cluster_watch_only(self):
        from app.discovery import cluster_watch
        try:
            built = cluster_watch.refresh_watches()
            result = cluster_watch.scan_for_new_family_members(
                progress_cb=lambda e, d: publish(e, d))
            publish("log", {"level": "info", "logger": "scamhunter.cluster_watch",
                             "message": (
                                 f"Family watch finished: {built['watches_built']} signature(s) "
                                 f"refreshed, {result['checked']} site(s) checked, "
                                 f"{result['new_domains']} newly appearing domain(s) matching a "
                                 "known family. A match means shared public indicators only — "
                                 "each one still has to be checked on its own evidence.")})
        except Exception as e:
            logger.exception("Family watch crashed")
            publish("error", {"message": f"Family watch failed: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    # ---------- v0.7: the integration actually runs ----------

    def start_integration(self):
        """
        Starts the background link to the Main Platform: register, heartbeat,
        drain the outbox, claim jobs, poll for downstream outcomes.

        v0.6 built all of this and never started it. Nothing called SyncWorker,
        so in a real deployment none of it happened unless a person clicked a
        button — no heartbeat, no automatic delivery, no job claiming, no
        feedback. That is the single largest reliability defect the v0.6 audit
        found, and this is the fix.
        """
        from app.integration.v4.sync import SyncWorker
        from app.integration.v4.jobs import fail_orphaned_jobs

        with self._lock:
            if self._sync_worker and self._sync_worker.running:
                return False, "The platform link is already running."
            self._sync_worker = SyncWorker(progress_cb=lambda e, d: publish(e, d))

        ok, message = self._sync_worker.start()

        # Hand back anything this process was holding when it died. v0.6
        # noticed orphaned jobs and never told the platform, so their leases
        # had to time out before the work was re-offered.
        try:
            recovered = fail_orphaned_jobs()
            if recovered.get("reported"):
                publish("log", {"level": "info", "logger": "scamhunter.integration",
                                 "message": recovered["note"]})
        except Exception as exc:                # noqa: BLE001
            logger.warning("Could not return orphaned jobs: %s", exc)

        return ok, message

    def stop_integration(self):
        with self._lock:
            if not self._sync_worker or not self._sync_worker.running:
                return False, "The platform link is not running."
            worker = self._sync_worker
        return worker.stop()

    def integration_running(self) -> bool:
        return bool(self._sync_worker and self._sync_worker.running)

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "current_site": self.current_site,
                "settings": dict(self.settings),
            }

    # ---------- v2: precision engine ----------

    def start_autopilot(self):
        """
        v2: continuous background discovery that only delivers candidates
        clearing the precision bar. The v0.7 scan loop (start()) is unchanged.
        """
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "Already running."
            self._stop_event.clear()
            self._pause_event.clear()
            self.state = "running"
            self._thread = threading.Thread(target=self._run_v2_autopilot, daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state, "mode": "v2_autopilot"})
        return True, "Autopilot started."

    def _run_v2_autopilot(self):
        from app.v2 import autopilot
        try:
            publish("log", {"level": "info", "logger": "scamhunter.v2",
                             "message": "Site Finder v2 autopilot running: discovering in the background, "
                                        "delivering only candidates that clear the precision bar."})
            autopilot.run_forever(self._should_stop, progress=lambda e, d: publish(e, d),
                                  platform_linked=self.integration_running)
        except Exception as e:
            logger.exception("v2 autopilot crashed")
            publish("error", {"message": f"v2 autopilot stopped: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
            publish("scan_state", {"state": "idle"})

    def run_v2_round_now(self, requested: int = None, continuous: bool = False):
        with self._lock:
            if self.state in ("running", "paused"):
                return False, "A scan is already running; wait for it to finish or stop it first."
            self.state = "running"
            self._stop_event.clear()

            def work():
                try:
                    if continuous:
                        from app.v2.continuous import run_cycle
                        summary = run_cycle(requested=requested or 5, reason="user", progress=lambda e, d: publish(e, d))
                        description = (f"Discovery cycle: {summary.get('new_unique', 0)} new domains, "
                                       f"{summary.get('delivered', 0)} leads ready for review.")
                    else:
                        from app.v2.engine import run_round
                        summary = run_round(requested=requested, progress=lambda e, d: publish(e, d))
                        description = (f"v2 round {summary['round']}: {summary['probed']} probed, "
                                       f"{summary['gated']} filtered out, {len(summary['delivered'])} delivered.")
                    publish("log", {"level": "info", "logger": "scamhunter.v2", "message": description})
                except Exception as e:
                    logger.exception("v2 round failed")
                    publish("error", {"message": f"v2 round failed: {e}"})
                finally:
                    with self._lock:
                        self.state = "idle"
                    publish("scan_state", {"state": "idle"})
            self._thread = threading.Thread(target=work, daemon=True)
            self._thread.start()
        publish("scan_state", {"state": self.state})
        return True, "v2 round started."

    # ---------- internal ----------

    def _should_stop(self) -> bool:
        return self._stop_event.is_set()

    def _wait_if_paused(self):
        """Blocks the worker loop (between safe checkpoints) while paused."""
        while self._pause_event.is_set() and not self._stop_event.is_set():
            time.sleep(0.3)

    def _run_loop(self):
        try:
            settings = dict(self.settings)

            if settings.get("run_discovery") and not self._should_stop():
                publish("log", {"level": "info", "logger": "scamhunter.runner",
                                 "message": "Running discovery sources..."})
                self._run_discovery_with_events(sources=settings.get("discovery_sources"))
                self._wait_if_paused()

            if settings.get("run_collection") and not self._should_stop():
                publish("log", {"level": "info", "logger": "scamhunter.runner",
                                 "message": "Collecting candidate sites..."})
                added = run_collectors()
                publish("collection_done", {"added": added})
                self._wait_if_paused()

            if settings.get("quality_pipeline", True):
                # Quality-over-quantity path: cheap triage across the whole pool,
                # then expensive deep analysis on only the strongest survivors.
                if not self._should_stop():
                    publish("log", {"level": "info", "logger": "scamhunter.runner",
                                     "message": "Fast-triaging the discovery pool..."})
                    self._run_triage_stage_inline(limit=settings.get("triage_limit", 200))
                    self._wait_if_paused()

                if not self._should_stop():
                    publish("log", {"level": "info", "logger": "scamhunter.runner",
                                     "message": "Deep-analyzing the strongest candidates..."})
                    self._run_deep_stage_inline(
                        limit=settings.get("deep_limit", 10),
                        allow_signup=settings.get("allow_signup", False),
                    )
            else:
                # Legacy path, preserved so existing behavior remains available.
                if settings.get("run_ranking") and not self._should_stop():
                    publish("log", {"level": "info", "logger": "scamhunter.runner",
                                     "message": "Ranking candidate sites..."})
                    self._run_ranking_with_events(limit=settings.get("rank_limit", 500))
                    self._wait_if_paused()

                if not self._should_stop():
                    self._run_investigation_with_events(
                        batch_size=settings.get("batch_size", 5),
                        headless=settings.get("headless", True),
                        risk_threshold=settings.get("risk_threshold", 5.0),
                        allow_signup=settings.get("allow_signup", False),
                        deep_wallet_hunt=settings.get("deep_wallet_hunt", False),
                    )

        except Exception as e:
            logger.exception("Scan loop crashed")
            publish("error", {"message": f"Scan stopped due to an unexpected error: {e}"})
        finally:
            with self._lock:
                self.state = "idle"
                self.current_site = None
            publish("scan_state", {"state": "idle"})
            publish("log", {"level": "info", "logger": "scamhunter.runner", "message": "Scan finished."})

    def _run_discovery_with_events(self, sources=None):
        def progress_cb(event_type, data):
            publish(event_type, data)

        engine = DiscoveryEngine(progress_cb=progress_cb, should_stop=self._should_stop)
        try:
            result = engine.run(sources=sources)
            publish("log", {
                "level": "info", "logger": "scamhunter.runner",
                "message": (f"Discovery run complete: {result['total_new_sites']} new sites found "
                            f"({result['total_duplicates']} duplicates skipped)."),
            })
            if result["errors"]:
                for err in result["errors"]:
                    publish("log", {"level": "warning", "logger": "scamhunter.discovery",
                                     "message": f"Discovery source error: {err}"})
        except Exception as e:
            logger.exception("Discovery run crashed")
            publish("log", {"level": "error", "logger": "scamhunter.runner",
                             "message": f"Discovery run failed: {e}"})

    def _run_triage_stage_inline(self, limit: int):
        from app.analysis.pipeline_v2 import run_triage_stage
        summary = run_triage_stage(
            limit=limit,
            progress_cb=lambda event, data: publish(event, data),
            should_stop=self._should_stop,
        )
        publish("log", {"level": "info", "logger": "scamhunter.runner",
                         "message": (f"Triage: {summary['passed']} of {summary['triaged']} sites "
                                     f"cleared the quality gate ({summary['rejected']} rejected).")})
        return summary

    def _run_deep_stage_inline(self, limit: int, allow_signup: bool = False):
        from app.analysis.pipeline_v2 import run_deep_analysis_stage
        summary = run_deep_analysis_stage(
            limit=limit,
            progress_cb=lambda event, data: publish(event, data),
            should_stop=self._should_stop,
            allow_signup=allow_signup,
        )
        publish("log", {"level": "info", "logger": "scamhunter.runner",
                         "message": (f"Deep analysis: {summary['analyzed']} analyzed, "
                                     f"{summary['high_confidence']} high-confidence results.")})
        return summary

    def _run_ranking_with_events(self, limit: int):
        sites = db.list_sites(status="new", limit=limit)
        total = len(sites)
        for i, site in enumerate(sites, 1):
            if self._should_stop():
                return
            self._wait_if_paused()
            score, reasons = rank_site(site)
            db.update_site_score(site["id"], score, reasons)
            db.set_site_status(site["id"], "queued")
            publish("site_ranked", {
                "site_id": site["id"], "url": site["url"], "score": score,
                "reasons": reasons, "progress": i, "total": total,
            })

    def _run_investigation_with_events(self, batch_size: int, headless: bool,
                                        risk_threshold: float = 5.0, allow_signup: bool = False,
                                        deep_wallet_hunt: bool = False):
        processed = 0
        while not self._should_stop():
            self._wait_if_paused()
            if self._should_stop():
                return

            sites = db.next_sites_to_scan(limit=1, min_score=risk_threshold)
            if not sites:
                publish("log", {"level": "info", "logger": "scamhunter.runner",
                                 "message": f"No more high-risk sites (score >= {risk_threshold}) to investigate."})
                return
            if batch_size is not None and batch_size > 0 and processed >= batch_size:
                return

            site = sites[0]
            with self._lock:
                self.current_site = site
            publish("investigation_started", {"site_id": site["id"], "url": site["url"], "score": site["score"]})

            def progress_cb(event_type, data):
                publish(event_type, data)

            def should_stop_inner():
                # Investigation of the CURRENT site always finishes its current page
                # (Playwright calls aren't interruptible mid-flight) but a pause/stop
                # request will stop it from visiting further pages within this site.
                return self._should_stop() or self._pause_event.is_set()

            try:
                result = investigate_site(site, headless=headless, allow_signup=allow_signup,
                                           deep_wallet_hunt=deep_wallet_hunt,
                                           progress_cb=progress_cb, should_stop=should_stop_inner)
                finding_id = draft_finding_if_evidence(site["id"])
                publish("investigation_finished", {
                    "site_id": site["id"], "url": site["url"], "result": result,
                    "finding_id": finding_id,
                })
            except Exception as e:
                logger.exception("Investigation failed for %s", site["url"])
                db.set_site_status(site["id"], "error")
                publish("investigation_error", {"site_id": site["id"], "url": site["url"], "error": str(e)})

            with self._lock:
                self.current_site = None
            processed += 1


# Module-level singleton: the Flask app and any other code share one controller.
controller = ScanController()
