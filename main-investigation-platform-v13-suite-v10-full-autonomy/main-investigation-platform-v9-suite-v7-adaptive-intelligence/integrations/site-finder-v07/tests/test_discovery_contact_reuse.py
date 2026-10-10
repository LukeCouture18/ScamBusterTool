"""Tests for app/discovery/contact_reuse.py."""
from app.discovery.contact_reuse import extract_contacts, has_any_contacts, ContactReuseDiscoverer


def test_extracts_telegram_handle():
    contacts = extract_contacts("Contact us on Telegram: @cryptosupport2026")
    assert "cryptosupport2026" in contacts["telegram"]


def test_extracts_telegram_from_tme_link():
    contacts = extract_contacts("Chat with us: t.me/cryptosupport2026")
    assert "cryptosupport2026" in contacts["telegram"]


def test_extracts_whatsapp_number():
    contacts = extract_contacts("WhatsApp: wa.me/8613800138000")
    assert "8613800138000" in contacts["whatsapp"]


def test_extracts_distinctive_domain_email():
    contacts = extract_contacts("Email: support@definitelynotascam.biz")
    assert "support@definitelynotascam.biz" in contacts["email"]


def test_filters_generic_placeholder_email():
    contacts = extract_contacts("Contact us at info@gmail.com for help.")
    assert contacts["email"] == []


def test_keeps_generic_local_part_on_distinctive_domain():
    contacts = extract_contacts("Email: support@totallyfakebiz123.net")
    assert "support@totallyfakebiz123.net" in contacts["email"]


def test_telegram_regex_does_not_false_positive_on_email_domain():
    """
    Regression test for a real bug: the bare-'@' Telegram pattern was matching
    the domain half of an email address (e.g. 'user@somesite.com' produced a
    fake 'somesite' Telegram handle). This must not happen.
    """
    contacts = extract_contacts("Email: support@definitelynotascam.biz")
    assert contacts["telegram"] == [], f"false-positive telegram handle(s): {contacts['telegram']}"


def test_telegram_regex_does_not_false_positive_on_generic_email():
    contacts = extract_contacts("Contact us at info@gmail.com for help.")
    assert contacts["telegram"] == [], f"false-positive telegram handle(s): {contacts['telegram']}"


def test_phone_numbers_are_deduped_when_one_is_a_suffix_of_another():
    """
    Regression test for a real bug: the phone regex's optional country-code
    group caused a single real phone number to also match as a shorter
    suffix-only substring, recording it as two different 'contacts'. Only the
    longest (most complete) match should be kept.
    """
    contacts = extract_contacts("Call us at +86 138 0013 8000")
    assert len(contacts["phone"]) == 1, f"expected 1 deduped phone number, got {contacts['phone']}"


def test_has_any_contacts():
    assert has_any_contacts({"telegram": [], "whatsapp": [], "email": [], "phone": []}) is False
    assert has_any_contacts({"telegram": ["x"], "whatsapp": [], "email": [], "phone": []}) is True


def test_find_shared_contacts_matches_across_sites():
    disc = ContactReuseDiscoverer()
    site_a = extract_contacts("Telegram: @cryptosupport2026 Email: boss@scamring.biz")
    site_b = extract_contacts("Chat with us on Telegram @cryptosupport2026 or email boss@scamring.biz")
    site_c = extract_contacts("Totally different contact: @legitbusiness")

    matches = disc.find_shared_contacts(site_a, {"site_b": site_b, "site_c": site_c})
    match_labels = {m[0] for m in matches}

    assert "site_b" in match_labels
    assert "site_c" not in match_labels
    assert any(m[1] == "telegram" for m in matches if m[0] == "site_b")
    assert any(m[1] == "email" for m in matches if m[0] == "site_b")


def test_find_shared_contacts_returns_empty_when_nothing_matches():
    disc = ContactReuseDiscoverer()
    site_a = extract_contacts("Telegram: @cryptosupport2026")
    site_b = extract_contacts("Telegram: @completelydifferent")
    matches = disc.find_shared_contacts(site_a, {"site_b": site_b})
    assert matches == []
