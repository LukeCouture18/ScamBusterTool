"""
Ties the pieces together:
  collect -> rank -> pick top N -> investigate with browser -> auto-draft a finding
Findings always land in 'pending' review status; nothing is ever auto-submitted.
"""
import logging

from app import db
from app.collectors import run_collectors
from app.ranker import rank_site
from app.investigate.navigator import investigate_site

logger = logging.getLogger("scamhunter.pipeline")


def run_collection():
    return run_collectors()


def run_ranking(limit: int = 500):
    """Score all unscored/new sites so the queue is ordered by suspicion."""
    sites = db.list_sites(status="new", limit=limit)
    for site in sites:
        score, reasons = rank_site(site)
        db.update_site_score(site["id"], score, reasons)
        db.set_site_status(site["id"], "queued")
    logger.info("Ranked %d sites.", len(sites))
    return len(sites)


def draft_finding_if_evidence(site_id: int) -> int | None:
    """
    Shared by both the sequential batch path and the parallel worker-pool path:
    given a site that's already been investigated, create a 'pending' finding if
    it has wallets or interesting pages, else return None.
    """
    site = db.get_site(site_id)
    wallets = db.wallets_for_site(site_id)
    pages = db.pages_for_site(site_id)
    interesting_pages = [p for p in pages if p["page_type"] in
                          ("deposit", "wallet", "funding", "investment", "trading")]

    if not (wallets or interesting_pages):
        return None

    investigation = db.latest_investigation_for_site(site_id)

    summary_lines = [
        f"Site: {site['url']}",
        f"Suspicion score: {site['score']} ({site['score_reasons']})",
        f"Pages visited: {len(pages)}",
        f"Wallets found: {len(wallets)}",
    ]
    if investigation:
        summary_lines.append(f"Investigation status: {investigation['status']}"
                              + (f" ({investigation['stop_reason']})" if investigation.get("stop_reason") else ""))
    for w in wallets:
        dup_sites = db.wallet_seen_elsewhere(w["address"], w["network"], site_id)
        dup_note = f" (also seen on {len(dup_sites)} other site(s))" if dup_sites else ""
        summary_lines.append(f"  - [{w['network']}] {w['address']}{dup_note}")
    for p in interesting_pages:
        summary_lines.append(f"  - {p['page_type'].upper()} page: {p['url']}")

    finding_id = db.create_finding(site_id, "\n".join(summary_lines))
    logger.info("Drafted finding #%d for %s", finding_id, site["url"])
    return finding_id


def run_investigation_batch(batch_size: int = 5, headless: bool = True, allow_signup: bool = False,
                             deep_wallet_hunt: bool = False):
    """Investigate the top-scored queued sites and draft findings for anything with evidence."""
    sites = db.next_sites_to_scan(limit=batch_size)
    results = []
    for site in sites:
        logger.info("Investigating site %s (score=%s)", site["url"], site["score"])
        result = investigate_site(site, headless=headless, allow_signup=allow_signup,
                                   deep_wallet_hunt=deep_wallet_hunt)
        results.append({"site": site, "result": result})
        draft_finding_if_evidence(site["id"])

    return results


def run_full_cycle(rank_limit=500, investigate_batch=5, headless=True, allow_signup=False,
                    deep_wallet_hunt=False):
    added = run_collection()
    ranked = run_ranking(limit=rank_limit)
    investigated = run_investigation_batch(batch_size=investigate_batch, headless=headless,
                                            allow_signup=allow_signup, deep_wallet_hunt=deep_wallet_hunt)
    return {"collected": added, "ranked": ranked, "investigated": len(investigated)}
