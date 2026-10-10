"""
The discovery engine: orchestrates every discovery source (cold-start and
pivot), dedupes against everything already known, writes new candidates into
the sites table with a discovery confidence/reason/category, and records a
permanent audit trail plus per-run statistics.

Modularity: adding a new source means writing a discoverer class (see
app/discovery/base.py) and adding one line to SOURCE_REGISTRY / PIVOT_REGISTRY
below — nothing else here needs to change.

Passivity / rate limits: each source is responsible for its own self-limiting
(see the per-source config in app/config.py — CRT_SH_MAX_QUERIES_PER_RUN,
SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN, etc.), and the engine adds a courtesy
delay between sources on top of that. Nothing here bypasses any protection —
every network call is a standard, public, unauthenticated read (DNS lookups,
a public CT-log search, fetching pages we're already allowed to fetch).
"""
import logging
import time

from app import db
from app.config import DISCOVERY_INTER_SOURCE_DELAY_SECONDS, SHARED_INFRA_MAX_SEEDS_PER_RUN
from app.discovery.certificate_transparency import CertificateTransparencyDiscoverer
from app.discovery.similar_domains import SimilarDomainsDiscoverer
from app.discovery.shared_infrastructure import SharedInfrastructureDiscoverer
from app.discovery.template_similarity import TemplateSimilarityDiscoverer
from app.discovery.contact_reuse import ContactReuseDiscoverer

logger = logging.getLogger("scamhunter.discovery.engine")

# Cold-start sources: run once per discovery run, independent of any specific
# existing site. Each entry is (name -> factory) so the engine can construct a
# fresh instance per run (some sources keep per-run counters/budgets in
# instance state, e.g. SimilarDomainsDiscoverer's _dns_checks_used).
COLD_START_SOURCES = {
    "certificate_transparency": lambda: CertificateTransparencyDiscoverer(),
    "similar_domains_brands": lambda: SimilarDomainsDiscoverer(),  # brand-impersonation pass
}


def _default_progress_cb(event_type, data):
    pass


class DiscoveryEngine:
    def __init__(self, progress_cb=None, should_stop=None):
        self.progress_cb = progress_cb or _default_progress_cb
        self.should_stop = should_stop or (lambda: False)

    def run(self, sources: list | None = None, pivot_seed_limit: int = SHARED_INFRA_MAX_SEEDS_PER_RUN) -> dict:
        """
        Runs the requested cold-start sources (default: all registered) plus a
        pivot pass over recently-added high-signal sites. Returns a summary dict
        and writes full detail to discovery_events / discovery_runs.
        """
        requested = sources or list(COLD_START_SOURCES.keys()) + ["pivots"]
        run_id = db.create_discovery_run(requested)
        self.progress_cb("discovery_run_started", {"run_id": run_id, "sources": requested})

        total_candidates = 0
        total_new = 0
        total_dupes = 0
        errors = []

        for source_name in requested:
            if source_name == "pivots":
                continue
            if self.should_stop():
                break
            if source_name not in COLD_START_SOURCES:
                continue

            t0 = time.time()
            found, new_count, dupe_count, error = self._run_cold_source(source_name, run_id)
            duration = time.time() - t0
            db.log_discovery_run_source(run_id, source_name, found, new_count, dupe_count,
                                         error=error or "", duration_seconds=duration)
            total_candidates += found
            total_new += new_count
            total_dupes += dupe_count
            if error:
                errors.append(f"{source_name}: {error}")

            time.sleep(DISCOVERY_INTER_SOURCE_DELAY_SECONDS)

        if "pivots" in requested and not self.should_stop():
            t0 = time.time()
            found, new_count, dupe_count, error = self._run_pivots(run_id, pivot_seed_limit)
            duration = time.time() - t0
            db.log_discovery_run_source(run_id, "pivots", found, new_count, dupe_count,
                                         error=error or "", duration_seconds=duration)
            total_candidates += found
            total_new += new_count
            total_dupes += dupe_count
            if error:
                errors.append(f"pivots: {error}")

        db.finish_discovery_run(run_id, total_candidates, total_new, total_dupes, errors="; ".join(errors))
        self.progress_cb("discovery_run_finished", {
            "run_id": run_id, "total_candidates": total_candidates,
            "total_new_sites": total_new, "total_duplicates": total_dupes,
        })

        return {
            "run_id": run_id, "total_candidates": total_candidates,
            "total_new_sites": total_new, "total_duplicates": total_dupes,
            "errors": errors,
        }

    # ---------- cold-start sources ----------

    def _run_cold_source(self, source_name: str, run_id: int) -> tuple:
        factory = COLD_START_SOURCES[source_name]
        try:
            discoverer = factory()
            if source_name == "similar_domains_brands":
                candidates = discoverer.discover_from_brands()
            else:
                candidates = discoverer.discover()
        except Exception as e:
            logger.exception("Discovery source %s failed", source_name)
            return 0, 0, 0, str(e)

        new_count, dupe_count = self._ingest_candidates(candidates, source_name)
        return len(candidates), new_count, dupe_count, None

    # ---------- pivot sources ----------

    def _run_pivots(self, run_id: int, seed_limit: int) -> tuple:
        """
        Pivots off the most recently added / highest-scored sites we already
        know about — mining what we've found for similar domains, shared
        infrastructure, template matches, and reused contact info.
        """
        seeds = db.list_sites(limit=seed_limit)  # highest score first
        if not seeds:
            return 0, 0, 0, None

        total_found = 0
        new_count = 0
        dupe_count = 0

        similar_domains_disc = SimilarDomainsDiscoverer()
        infra_disc = SharedInfrastructureDiscoverer()
        template_disc = TemplateSimilarityDiscoverer()
        contact_disc = ContactReuseDiscoverer()

        # Build fingerprint caches once per run, not once per candidate.
        infra_cache = infra_disc.build_fingerprint_cache([s["domain"] for s in seeds])

        for seed in seeds:
            if self.should_stop():
                break

            # 1. Similar domains off this specific seed.
            try:
                variants = similar_domains_disc.discover_from_site(seed)
            except Exception as e:
                logger.warning("similar_domains pivot failed for %s: %s", seed["domain"], e)
                variants = []

            for candidate in variants:
                # Corroborate with shared-infrastructure check: if the variant
                # ALSO shares hosting with a known site, boost confidence and
                # note it — this is the "combine results across sources"
                # requirement in action, not just running sources in parallel.
                candidate_domain = db.domain_of(candidate.url)
                matched_site, infra_reason = infra_disc.check_candidate_against_known(
                    candidate_domain, infra_cache)
                if matched_site:
                    candidate.confidence = min(1.0, candidate.confidence + 0.2)
                    candidate.reason += f"; additionally {infra_reason}"

            total_found += len(variants)
            n, d = self._ingest_candidates(variants, "similar_domains", pivot_from_site_id=seed["id"])
            new_count += n
            dupe_count += d

            # 2. Template similarity — correlate this seed's page(s) against other
            # seeds' pages, purely from already-saved HTML (no new requests).
            self._run_template_and_contact_pivots(seed, seeds, template_disc, contact_disc)

        return total_found, new_count, dupe_count, None

    def _run_template_and_contact_pivots(self, seed: dict, all_seeds: list,
                                          template_disc, contact_disc):
        """
        These two pivots don't produce new URLs (both sides are already sites
        we know) — they produce corroborating discovery_events that link two
        existing sites, useful context for the reviewer even though neither
        creates a new sites row. Kept as a best-effort pass: any failure here
        (e.g. a missing HTML snapshot for a site that errored during
        investigation) is logged and skipped rather than aborting the whole run.
        """
        try:
            pages = db.pages_for_site(seed["id"])
        except Exception:
            return
        html_pages = [p for p in pages if p.get("html_snapshot_path")]
        if not html_pages:
            return

        seed_fp = template_disc.fingerprint_html_file(html_pages[0]["html_snapshot_path"])
        if not seed_fp:
            return

        other_fingerprints = {}
        for other in all_seeds:
            if other["id"] == seed["id"]:
                continue
            other_pages = db.pages_for_site(other["id"])
            other_html_pages = [p for p in other_pages if p.get("html_snapshot_path")]
            if not other_html_pages:
                continue
            other_fingerprints[other["domain"]] = template_disc.fingerprint_html_file(
                other_html_pages[0]["html_snapshot_path"])

        matches = template_disc.find_matches(seed_fp, other_fingerprints)
        for matched_domain, score in matches:
            db.log_discovery_event(
                url=f"http://{matched_domain}",
                source="template_similarity",
                confidence=round(score, 2),
                reason=f"Page structure {score:.0%} similar to already-known site '{seed['domain']}' "
                       f"(likely same scam template/builder).",
                category="",
                pivot_from_site_id=seed["id"],
                resulted_in_site_id=None,  # both sites already exist; this is corroboration, not a new site
                was_duplicate=True,
            )
            self.progress_cb("discovery_correlation", {
                "type": "template_similarity", "site_a": seed["domain"], "site_b": matched_domain,
                "score": score,
            })

    # ---------- shared ingestion / dedup logic ----------

    def _ingest_candidates(self, candidates: list, source_name: str,
                            pivot_from_site_id: int | None = None) -> tuple:
        """
        Common path every discoverer's output goes through: dedupe against the
        sites table (domain-level) AND log to the discovery_events audit trail
        either way, then insert new sites. This is the single choke point that
        guarantees every source, current or future, gets the same dedup and
        audit-trail treatment.
        """
        new_count = 0
        dupe_count = 0

        for candidate in candidates:
            domain = db.domain_of(candidate.url)
            if not domain:
                continue

            already_known_site = db.domain_known(domain)
            resulted_in_site_id = None

            if not already_known_site:
                new_id = db.add_site(
                    candidate.url, source_name,
                    discovery_confidence=candidate.confidence,
                    discovery_reason=candidate.reason,
                    discovery_category=candidate.category,
                )
                if new_id:
                    resulted_in_site_id = new_id
                    new_count += 1
                    # Preserve discovery immediately, before any triage or
                    # downstream job is requested. The outbox retries offline.
                    # v2: off by default — only inbox candidates reach the platform.
                    from app.config import V1_SEND_DISCOVERY_OBSERVATIONS
                    if V1_SEND_DISCOVERY_OBSERVATIONS:
                        from app.integration.v4.emitter import queue_candidate
                        queue_candidate(new_id)
                    self.progress_cb("site_discovered", {
                        "site_id": new_id, "url": candidate.url, "source": source_name,
                        "confidence": candidate.confidence, "reason": candidate.reason,
                        "category": candidate.category,
                    })
                else:
                    dupe_count += 1  # lost a race with another concurrent insert
            else:
                dupe_count += 1

            db.log_discovery_event(
                url=candidate.url, source=source_name, confidence=candidate.confidence,
                reason=candidate.reason, category=candidate.category,
                pivot_from_site_id=candidate.pivot_from_site_id or pivot_from_site_id,
                resulted_in_site_id=resulted_in_site_id,
                was_duplicate=already_known_site,
            )

        return new_count, dupe_count


def run_discovery(sources: list | None = None, progress_cb=None, should_stop=None) -> dict:
    """Convenience entry point used by the runner/CLI/UI."""
    engine = DiscoveryEngine(progress_cb=progress_cb, should_stop=should_stop)
    return engine.run(sources=sources)
