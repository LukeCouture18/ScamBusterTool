"""
Contact-info reuse discoverer.

Scam operations commonly reuse the same Telegram handle, WhatsApp number,
support email, or phone number across multiple fake sites — the "customer
service" contact is often the one piece of persistent infrastructure that
doesn't change between throwaway domains. This module extracts these from
page text and finds sites that share them, which is a strong signal of a
shared operator even when the domains, hosting, and content all differ.

Purely a local text-extraction + correlation step on page content we already
captured during investigation — no additional network requests to anyone.
"""
import logging
import re

logger = logging.getLogger("scamhunter.discovery.contact_reuse")

# Telegram: @handle or t.me/handle. The bare-@ form must NOT be immediately
# preceded by an email-local-part character (letter/digit/dot/underscore/hyphen)
# or it will match the domain half of an email address like "user@somesite.com"
# as if "somesite" were a Telegram handle — a real false-positive caught during
# testing. A negative lookbehind excludes that case while still matching a
# standalone "@handle" mention.
TELEGRAM_RE = re.compile(r"(?:t\.me/|telegram\.me/|(?<![\w.\-])@)([a-zA-Z][a-zA-Z0-9_]{4,31})\b")
# WhatsApp: wa.me/<digits> or explicit "whatsapp: +<digits>"
WHATSAPP_RE = re.compile(r"(?:wa\.me/|whatsapp[:\s]+\+?)(\d{7,15})", re.IGNORECASE)
# Email
EMAIL_RE = re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")
# Phone: loose international-format matcher (avoid over-matching; require a
# run of digits long enough that random small numbers don't qualify)
PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}[\s.-]?\d{2,4}\b")

# Common placeholder emails that appear on legitimate templates and shouldn't
# be treated as a meaningful shared-operator signal.
GENERIC_EMAIL_LOCALS = {"admin", "info", "support", "contact", "hello", "test", "example", "noreply"}
GENERIC_EMAIL_DOMAINS = {"example.com", "yourdomain.com", "domain.com", "email.com", "gmail.com"}


def extract_contacts(text: str) -> dict:
    """Returns {"telegram": [...], "whatsapp": [...], "email": [...], "phone": [...]},
    each a sorted list of unique, normalized values found in the text."""
    telegram = {m.group(1).lower() for m in TELEGRAM_RE.finditer(text)}
    whatsapp = {re.sub(r"\D", "", m.group(1)) for m in WHATSAPP_RE.finditer(text)}
    emails = {m.group(0).lower() for m in EMAIL_RE.finditer(text)}
    phones = set()
    raw_phone_matches = [re.sub(r"\D", "", m.group(0)) for m in PHONE_RE.finditer(text)]
    raw_phone_matches = [d for d in raw_phone_matches if len(d) >= 8]
    # The optional country-code group in PHONE_RE means a single real phone
    # number can also match as a shorter suffix-only substring (e.g. both
    # "8613800138000" and "13800138000" from the same text) — keep only the
    # longest match when one is a suffix of another, so a phone number isn't
    # recorded as two different "contacts."
    for digits in raw_phone_matches:
        if any(other != digits and other.endswith(digits) for other in raw_phone_matches):
            continue  # a longer match containing this one as a suffix exists
        phones.add(digits)

    # Only filter when BOTH the local part AND domain are generic/placeholder-like
    # (a shared "support@" on a distinctive domain is still a meaningful signal).
    filtered_emails = {
        e for e in emails
        if not (e.split("@")[0] in GENERIC_EMAIL_LOCALS and e.split("@")[-1] in GENERIC_EMAIL_DOMAINS)
    }

    return {
        "telegram": sorted(telegram),
        "whatsapp": sorted(whatsapp),
        "email": sorted(filtered_emails),
        "phone": sorted(phones),
    }


def has_any_contacts(contacts: dict) -> bool:
    return any(contacts.values())


class ContactReuseDiscoverer:
    """
    Like TemplateSimilarityDiscoverer, this is a correlation pass over sites
    we've already investigated rather than a cold-start URL generator — see
    app/discovery/engine.py for how matches become discovery_events and
    confidence boosts.
    """
    name = "contact_reuse"

    def extract(self, text: str) -> dict:
        return extract_contacts(text)

    def find_shared_contacts(self, target_contacts: dict, candidate_contacts: dict) -> list:
        """
        candidate_contacts: {label: contacts_dict} for other sites to compare
        against. Returns [(label, contact_type, value), ...] for every shared
        contact found (a site can match on multiple contact types/values).
        """
        matches = []
        for label, other in candidate_contacts.items():
            for contact_type in ("telegram", "whatsapp", "email", "phone"):
                shared = set(target_contacts.get(contact_type, [])) & set(other.get(contact_type, []))
                for value in shared:
                    matches.append((label, contact_type, value))
        return matches
