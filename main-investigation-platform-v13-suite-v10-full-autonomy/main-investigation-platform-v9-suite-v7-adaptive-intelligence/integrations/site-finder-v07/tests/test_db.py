"""Tests for app/db.py: dedup, CRUD, and query helpers."""


def test_add_site_dedupes_by_domain(temp_db):
    db = temp_db
    sid1 = db.add_site("http://example-scam.test/page1", "test")
    assert sid1 is not None

    # Same domain, different path -> still a duplicate at the domain level
    sid2 = db.add_site("http://example-scam.test/different-page", "test")
    assert sid2 is None

    # www. prefix should normalize to the same domain
    sid3 = db.add_site("http://www.example-scam.test/", "test")
    assert sid3 is None


def test_add_site_allows_distinct_domains(temp_db):
    db = temp_db
    sid1 = db.add_site("http://site-a.test", "test")
    sid2 = db.add_site("http://site-b.test", "test")
    assert sid1 is not None
    assert sid2 is not None
    assert sid1 != sid2


def test_site_status_transitions(temp_db):
    db = temp_db
    sid = db.add_site("http://example.test", "test")
    site = db.get_site(sid)
    assert site["status"] == "new"

    db.set_site_status(sid, "queued")
    assert db.get_site(sid)["status"] == "queued"

    db.mark_scanned(sid)
    site = db.get_site(sid)
    assert site["status"] == "scanned"
    assert site["scanned_at"] is not None


def test_update_site_score_and_ordering(temp_db):
    db = temp_db
    low = db.add_site("http://low-score.test", "test")
    high = db.add_site("http://high-score.test", "test")
    db.update_site_score(low, 1.0, "few signals")
    db.update_site_score(high, 9.0, "many signals")
    db.set_site_status(low, "queued")
    db.set_site_status(high, "queued")

    next_up = db.next_sites_to_scan(limit=2)
    assert next_up[0]["id"] == high  # higher score comes first


def test_next_sites_to_scan_respects_min_score_threshold(temp_db):
    """Underpins 'automatically investigate high-risk sites' — the runner uses
    this threshold to skip low-scored sites during auto-investigation."""
    db = temp_db
    low = db.add_site("http://low.test", "test")
    high = db.add_site("http://high.test", "test")
    db.update_site_score(low, 2.0, "few signals")
    db.update_site_score(high, 8.0, "many signals")
    db.set_site_status(low, "queued")
    db.set_site_status(high, "queued")

    unfiltered = db.next_sites_to_scan(limit=10)
    assert len(unfiltered) == 2

    filtered = db.next_sites_to_scan(limit=10, min_score=5.0)
    assert len(filtered) == 1
    assert filtered[0]["id"] == high


def test_wallet_dedup_across_sightings(temp_db):
    db = temp_db
    site1 = db.add_site("http://scam1.test", "test")
    site2 = db.add_site("http://scam2.test", "test")

    wid1, sighting1 = db.add_wallet_sighting("0xABC123", "ETH", site1, None, "context on site1", 0.9)
    wid2, sighting2 = db.add_wallet_sighting("0xabc123", "ETH", site2, None, "context on site2", 0.9)

    # Same address (case-insensitive) + same network -> same wallet row
    assert wid1 == wid2
    # But each is a genuinely new sighting (different site), so both get sighting ids
    assert sighting1 is not None
    assert sighting2 is not None

    others = db.wallet_seen_elsewhere("0xABC123", "ETH", exclude_site_id=site1)
    assert len(others) == 1
    assert others[0]["id"] == site2


def test_wallet_sighting_dedup_same_page(temp_db):
    """Adding the exact same wallet+page sighting twice shouldn't create duplicate rows."""
    db = temp_db
    site = db.add_site("http://scam.test", "test")
    page_id = db.add_page(site, "http://scam.test/deposit", "Deposit", "deposit", "", "")

    wallet_id, sighting_id = db.add_wallet_sighting("0xDEF456", "ETH", site, page_id, "first mention", 0.9)
    wallet_id2, sighting_id2 = db.add_wallet_sighting(
        "0xDEF456", "ETH", site, page_id, "second mention same page", 0.9)

    assert wallet_id == wallet_id2
    assert sighting_id is not None
    assert sighting_id2 is None  # duplicate sighting: nothing new to attach evidence to

    wallets = db.wallets_for_site(site)
    assert len(wallets) == 1


def test_wallet_evidence_attached_to_sighting(temp_db):
    db = temp_db
    site = db.add_site("http://scam.test", "test")
    page_id = db.add_page(site, "http://scam.test/deposit", "Deposit", "deposit", "", "")
    wallet_id, sighting_id = db.add_wallet_sighting("0xEVIDENCE1", "ETH", site, page_id, "ctx", 0.9)

    evidence_id = db.add_wallet_evidence(sighting_id, "/shots/wallet1.png", "surrounding text")
    assert evidence_id is not None

    evidence = db.wallet_evidence_for_site(site)
    assert len(evidence) == 1
    assert evidence[0]["address"] == "0xEVIDENCE1"
    assert evidence[0]["screenshot_path"] == "/shots/wallet1.png"


def test_findings_lifecycle(temp_db):
    db = temp_db
    site = db.add_site("http://scam.test", "test")
    fid = db.create_finding(site, "summary text")

    finding = db.get_finding(fid)
    assert finding["review_status"] == "pending"

    db.set_finding_review(fid, "approved", "looks legit")
    finding = db.get_finding(fid)
    assert finding["review_status"] == "approved"
    assert finding["reviewer_notes"] == "looks legit"

    assert finding["submitted_to_form"] == 0
    db.mark_finding_submitted(fid)
    finding = db.get_finding(fid)
    assert finding["submitted_to_form"] == 1


def test_list_findings_filters_by_status(temp_db):
    db = temp_db
    site = db.add_site("http://scam.test", "test")
    f1 = db.create_finding(site, "finding 1")
    f2 = db.create_finding(site, "finding 2")
    db.set_finding_review(f1, "approved")
    db.set_finding_review(f2, "rejected")

    approved = db.list_findings(review_status="approved")
    rejected = db.list_findings(review_status="rejected")
    assert len(approved) == 1
    assert len(rejected) == 1
    assert approved[0]["id"] == f1
    assert rejected[0]["id"] == f2
