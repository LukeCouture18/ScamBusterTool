"""
Tests for app/discovery/cluster_watch.py — v0.4 family signatures.

The failure mode this module has to avoid is flagging half the internet. A
signature built from cheap infrastructure would match every customer of a
large host, and a tool that cries wolf that loudly is worse than no tool. So
the tests below are mostly about what must NOT match, and about the language
attached to the matches that do.
"""
from app.analysis import correlation
from app.discovery import cluster_watch as cw

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
TELEGRAM = "vaultsupportdesk"
TEMPLATE = "a" * 32


def _site(db, domain, indicators, confidence=0.85):
    site_id = db.add_site(f"http://{domain}", "test")
    db.save_deep_profile(site_id, {
        "status": "complete", "domain": domain, "full_url": f"http://{domain}",
        "confidence_score": confidence})
    for itype, value in indicators:
        db.record_observation(site_id, itype, value, f"http://{domain}/", "page_text", "x")
    return site_id


def _family(db):
    """Two sites sharing a wallet and a Telegram handle — a real family."""
    a = _site(db, "alpha.test", [("wallet", WALLET), ("telegram", TELEGRAM),
                                 ("template_hash", TEMPLATE)])
    b = _site(db, "beta.test", [("wallet", WALLET), ("telegram", TELEGRAM),
                                ("template_hash", TEMPLATE)])
    correlation.run_correlation("test-scan")
    cw.refresh_watches()
    return a, b


# ---------------------------------------------------------------------------
# Signatures
# ---------------------------------------------------------------------------

def test_signature_is_built_from_what_members_actually_share(temp_db):
    db = temp_db
    _family(db)
    cluster = db.list_clusters(min_sites=2)[0]
    signature = cw.build_signature(cluster["id"])

    values = {i["value"] for i in signature["indicators"]}
    assert WALLET in values and TELEGRAM in values
    assert "wallet" in signature["categories"] and "contact" in signature["categories"]


def test_signature_explains_itself(temp_db):
    db = temp_db
    _family(db)
    cluster = db.list_clusters(min_sites=2)[0]
    signature = cw.build_signature(cluster["id"])
    assert "shared by at least two" in signature["note"]
    assert signature["evidence_class"] == "derived"


def test_an_indicator_on_hundreds_of_sites_is_left_out_of_the_signature(temp_db):
    db = temp_db
    shared_ip = "198.51.100.7"
    a = _site(db, "alpha.test", [("wallet", WALLET), ("ip", shared_ip)])
    b = _site(db, "beta.test", [("wallet", WALLET), ("ip", shared_ip)])
    # The same IP also hosts a crowd of unrelated sites: it is a host, not a clue.
    for n in range(40):
        _site(db, f"unrelated{n}.test", [("ip", shared_ip)], confidence=0.1)

    correlation.run_correlation("test-scan")
    cw.refresh_watches()
    cluster = db.cluster_for_site(a)
    assert cluster, "the wallet should still have formed a family"
    signature = cw.build_signature(cluster["id"])

    types = {i["indicator_type"] for i in signature["indicators"]}
    assert "ip" not in types, "a heavily shared IP must not become part of a fingerprint"
    assert "too common" in signature["note"]
    assert b  # both members exist


def test_a_single_site_cluster_has_no_signature(temp_db):
    db = temp_db
    _site(db, "lonely.test", [("wallet", WALLET)])
    assert cw.build_signature(999)["indicators"] == []


# ---------------------------------------------------------------------------
# Matching — mostly about what must not match
# ---------------------------------------------------------------------------

def test_a_new_domain_sharing_a_wallet_matches_the_family(temp_db):
    db = temp_db
    _family(db)
    newcomer = _site(db, "gamma.test", [("wallet", WALLET)])

    matches = cw.match_site(newcomer)
    assert matches, "a site reusing the family's wallet should match"
    assert matches[0]["identity_bound_matches"] >= 1


def test_sharing_only_a_nameserver_does_not_match(temp_db):
    """The whole point of requiring a combination."""
    db = temp_db
    ns = "ns1.bighost.test"
    a = _site(db, "alpha.test", [("wallet", WALLET), ("telegram", TELEGRAM),
                                 ("nameserver", ns)])
    _site(db, "beta.test", [("wallet", WALLET), ("telegram", TELEGRAM), ("nameserver", ns)])
    correlation.run_correlation("test-scan")
    cw.refresh_watches()

    bystander = _site(db, "someone-elses-blog.test", [("nameserver", ns)], confidence=0.0)
    assert cw.match_site(bystander) == [], (
        "sharing one nameserver with a family must never be enough to flag a site")
    assert a


def test_two_independent_weak_categories_are_enough(temp_db):
    db = temp_db
    ip = "198.51.100.9"
    _site(db, "alpha.test", [("wallet", WALLET), ("ip", ip), ("template_hash", TEMPLATE)])
    _site(db, "beta.test", [("wallet", WALLET), ("ip", ip), ("template_hash", TEMPLATE)])
    correlation.run_correlation("test-scan")
    cw.refresh_watches()

    newcomer = _site(db, "gamma.test", [("ip", ip), ("template_hash", TEMPLATE)])
    matches = cw.match_site(newcomer)
    assert matches, "two independent categories should be enough to be worth a look"
    assert len(matches[0]["categories"]) >= cw.MIN_CATEGORIES_FOR_MATCH


def test_a_site_is_not_matched_against_its_own_family(temp_db):
    db = temp_db
    a, _b = _family(db)
    assert cw.match_site(a) == []


# ---------------------------------------------------------------------------
# What a match is allowed to say
# ---------------------------------------------------------------------------

def test_every_match_names_an_innocent_explanation(temp_db):
    db = temp_db
    _family(db)
    newcomer = _site(db, "gamma.test", [("wallet", WALLET)])
    match = cw.match_site(newcomer)[0]

    assert "Other explanations that fit the same evidence" in match["explanation"]
    assert "not as a finding about who runs the site" in match["explanation"]
    assert match["evidence_class"] == "derived"


def test_match_language_never_claims_shared_ownership(temp_db):
    import pathlib
    banned = ["same party", "owned by the same", "single operation", "same operator",
              "proves", "run by the same", "confirms they are"]
    source = pathlib.Path(cw.__file__).read_text(encoding="utf-8").lower()
    for phrase in banned:
        assert phrase not in source, f"cluster_watch.py overclaims: {phrase!r}"

    db = temp_db
    _family(db)
    newcomer = _site(db, "gamma.test", [("wallet", WALLET)])
    blob = " ".join(m["explanation"] for m in cw.match_site(newcomer)).lower()
    for phrase in banned:
        assert phrase not in blob, f"a match explanation overclaims: {phrase!r}"


# ---------------------------------------------------------------------------
# The watch itself
# ---------------------------------------------------------------------------

def test_watch_records_a_newly_appearing_related_domain(temp_db):
    db = temp_db
    _family(db)
    newcomer = _site(db, "gamma.test", [("wallet", WALLET), ("telegram", TELEGRAM)])

    result = cw.scan_for_new_family_members()
    assert result["new_domains"] >= 1

    recorded = db.list_cluster_new_domains()
    assert any(r["site_id"] == newcomer for r in recorded)
    assert recorded[0]["evidence_class"] == "derived"
    assert recorded[0]["match_explanation"]


def test_watch_does_not_record_the_same_domain_twice(temp_db):
    db = temp_db
    _family(db)
    _site(db, "gamma.test", [("wallet", WALLET)])

    first = cw.scan_for_new_family_members()
    second = cw.scan_for_new_family_members()
    assert first["new_domains"] >= 1
    assert second["new_domains"] == 0, "a domain already on record is not a new arrival"


def test_watch_reports_clearly_when_there_is_nothing_to_watch(temp_db):
    result = cw.scan_for_new_family_members()
    assert result["new_domains"] == 0
    assert "run correlation first" in result["note"].lower()


def test_watch_report_is_readable(temp_db):
    db = temp_db
    _family(db)
    _site(db, "gamma.test", [("wallet", WALLET)])
    cw.scan_for_new_family_members()

    report = cw.watch_report()
    assert report["watches"]
    assert report["watches"][0]["indicator_count"] > 0
    assert report["watches"][0]["evidence_class"] == "derived"
    assert db
