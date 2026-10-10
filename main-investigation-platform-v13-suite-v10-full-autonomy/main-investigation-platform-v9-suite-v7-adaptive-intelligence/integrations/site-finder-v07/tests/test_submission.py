"""
Tests for app/submission.py — credential storage, the validation gate, the
three submission modes, and the duplicate guards.

The validation gate is the safety-critical piece: it decides whether a report
gets prepared at all. Submitting a bogus or duplicate report to a real
third-party project is a real-world harm, so each guard is tested explicitly.
"""
from app.submission import (
    save_submission_settings, get_submission_settings, validate_for_submission,
    prepare_submission, confirm_submitted, SETTING_USERNAME, SETTING_TEAM_CODE,
)

VALID_TRON = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
VALID_BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


def _seed_submittable_site(db, url="http://strong.test", confidence=0.85,
                            address=VALID_TRON, network="TRON", tx_count=17):
    """Creates a site that should pass every validation check."""
    site_id = db.add_site(url, "certificate_transparency")
    db.save_deep_profile(site_id, {
        "status": "complete", "domain": url.replace("http://", ""),
        "full_url": url, "confidence_score": confidence, "risk_score": 9.0,
    })
    wallet_id, _ = db.add_wallet_sighting(address, network, site_id, None, "ctx", 0.9)
    db.save_wallet_validation(wallet_id, {
        "format_valid": 1, "validation_detail": "valid", "network_confirmed": network,
        "activity_checked": 1, "activity_available": 1, "tx_count": tx_count,
    })
    return site_id


def _configure_credentials():
    save_submission_settings(username="researcher1", team_code="TEAM-XYZ",
                              mode="review_before_submit")


def _check_named(validation, name):
    return next(c for c in validation["checks"] if c["check"] == name)


def test_credentials_saved_once_and_reused(temp_db):
    save_submission_settings(username="alice", team_code="CODE-123")
    settings = get_submission_settings()
    assert settings["username"] == "alice"
    assert settings["team_code"] == "CODE-123"
    assert settings["configured"] is True
    # A fresh read must return the same values — this is the "enter once" promise.
    assert get_submission_settings()["username"] == "alice"


def test_credentials_persist_in_settings_table(temp_db):
    save_submission_settings(username="bob", team_code="ZZZ")
    assert temp_db.get_setting(SETTING_USERNAME) == "bob"
    assert temp_db.get_setting(SETTING_TEAM_CODE) == "ZZZ"


def test_invalid_mode_rejected(temp_db):
    try:
        save_submission_settings(mode="fire_and_forget")
        assert False, "should have rejected an unknown mode"
    except ValueError as e:
        assert "fire_and_forget" in str(e)


def test_missing_credentials_block_submission(temp_db):
    site_id = _seed_submittable_site(temp_db)
    validation = validate_for_submission(site_id)
    assert validation["passed"] is False
    assert _check_named(validation, "username_configured")["passed"] is False
    assert _check_named(validation, "team_code_configured")["passed"] is False


def test_fully_prepared_site_passes_validation(temp_db):
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db)
    validation = validate_for_submission(site_id)
    assert validation["passed"] is True, [c for c in validation["checks"] if not c["passed"]]
    assert validation["wallet"]["address"] == VALID_TRON


def test_low_confidence_blocks_submission(temp_db):
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db, confidence=0.40)
    validation = validate_for_submission(site_id)
    assert validation["passed"] is False
    assert _check_named(validation, "confidence_threshold")["passed"] is False


def test_missing_deep_profile_blocks_submission(temp_db):
    _configure_credentials()
    site_id = temp_db.add_site("http://noprofile.test", "test")
    validation = validate_for_submission(site_id)
    assert validation["passed"] is False
    assert _check_named(validation, "deep_profile_complete")["passed"] is False


def test_checksum_invalid_wallet_blocks_submission(temp_db):
    """Never report an address that can't be real — that's worse than reporting nothing."""
    _configure_credentials()
    site_id = temp_db.add_site("http://badwallet.test", "test")
    temp_db.save_deep_profile(site_id, {
        "status": "complete", "domain": "badwallet.test",
        "full_url": "http://badwallet.test", "confidence_score": 0.95, "risk_score": 9.0,
    })
    wallet_id, _ = temp_db.add_wallet_sighting("1BadAddressThatFailsChecksum", "BTC",
                                                site_id, None, "ctx", 0.9)
    temp_db.save_wallet_validation(wallet_id, {
        "format_valid": 0, "validation_detail": "checksum mismatch", "network_confirmed": "BTC",
    })
    validation = validate_for_submission(site_id)
    assert validation["passed"] is False
    assert _check_named(validation, "wallet_validated")["passed"] is False


def test_unsupported_wallet_network_blocks_submission(temp_db):
    """The form only accepts certain networks; a valid address on an unlisted
    network still can't be submitted through it."""
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db, url="http://solsite.test",
                                      address="So11111111111111111111111111111111111111112",
                                      network="SOL")
    validation = validate_for_submission(site_id)
    assert _check_named(validation, "wallet_network_supported")["passed"] is False


def test_duplicate_site_guard(temp_db):
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db)
    result = prepare_submission(site_id, mode="manual")
    confirm_submitted(result["submission_id"])

    validation = validate_for_submission(site_id)
    assert validation["passed"] is False
    assert _check_named(validation, "not_duplicate_site")["passed"] is False


def test_duplicate_wallet_guard_across_different_sites(temp_db):
    """The same wallet reported from a second site is still a duplicate report."""
    _configure_credentials()
    first = _seed_submittable_site(temp_db, url="http://first.test")
    result = prepare_submission(first, mode="manual")
    confirm_submitted(result["submission_id"])

    second = _seed_submittable_site(temp_db, url="http://second.test", address=VALID_TRON)
    validation = validate_for_submission(second)
    assert _check_named(validation, "not_duplicate_wallet")["passed"] is False


def test_manual_mode_validates_without_opening_browser(temp_db):
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db)
    result = prepare_submission(site_id, mode="manual")
    assert result["status"] == "validated"
    assert result["mode"] == "manual"
    assert result["wallet"]["address"] == VALID_TRON


def test_failed_validation_is_recorded_for_audit(temp_db):
    """A blocked submission must still leave a record of what was attempted and why."""
    site_id = _seed_submittable_site(temp_db)  # no credentials configured
    result = prepare_submission(site_id, mode="manual")
    assert result["status"] == "rejected"

    history = temp_db.list_form_submissions()
    assert len(history) == 1
    assert history[0]["status"] == "rejected"
    assert any(not c["passed"] for c in history[0]["validation_detail"])


def test_confirm_submitted_records_human_confirmation(temp_db):
    """The tool never clicks Submit; this records that the human did."""
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db)
    result = prepare_submission(site_id, mode="manual")
    confirmation = confirm_submitted(result["submission_id"])
    assert confirmation["ok"] is True

    submission = temp_db.get_form_submission(result["submission_id"])
    assert submission["status"] == "submitted"
    assert submission["confirmed_by_user_at"] is not None


def test_wallet_with_activity_is_preferred_for_submission(temp_db):
    """Given a choice, report the wallet with demonstrated on-chain activity."""
    _configure_credentials()
    site_id = _seed_submittable_site(temp_db, address=VALID_TRON, network="TRON", tx_count=0)
    quiet_wallet_id, _ = temp_db.add_wallet_sighting(VALID_BTC, "BTC", site_id, None, "ctx", 0.9)
    temp_db.save_wallet_validation(quiet_wallet_id, {
        "format_valid": 1, "validation_detail": "valid", "network_confirmed": "BTC",
        "activity_checked": 1, "activity_available": 1, "tx_count": 500,
    })
    validation = validate_for_submission(site_id)
    assert validation["wallet"]["address"] == VALID_BTC  # the busier one
