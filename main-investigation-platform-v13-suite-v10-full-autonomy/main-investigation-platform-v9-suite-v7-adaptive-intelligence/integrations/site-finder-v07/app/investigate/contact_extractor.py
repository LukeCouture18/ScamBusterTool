"""
Extracts contact information and social links from page content.

Builds on the existing contact_reuse discovery module's extraction (which
already handles Telegram/WhatsApp/email/phone with the false-positive fixes
baked in), and adds social-platform link detection, which is separately useful
for reporting: a scam site's social presence is often the recruitment channel
and is worth capturing alongside the site itself.
"""
import re

from app.discovery.contact_reuse import extract_contacts

SOCIAL_PATTERNS = {
    "telegram": r"https?://(?:t\.me|telegram\.me)/[A-Za-z0-9_+]+",
    "whatsapp": r"https?://(?:wa\.me|api\.whatsapp\.com)/[^\s\"'<>]+",
    "twitter": r"https?://(?:www\.)?(?:twitter\.com|x\.com)/[A-Za-z0-9_]+",
    "facebook": r"https?://(?:www\.)?facebook\.com/[A-Za-z0-9_.\-]+",
    "instagram": r"https?://(?:www\.)?instagram\.com/[A-Za-z0-9_.]+",
    "youtube": r"https?://(?:www\.)?youtube\.com/(?:channel/|c/|@)[A-Za-z0-9_\-]+",
    "tiktok": r"https?://(?:www\.)?tiktok\.com/@[A-Za-z0-9_.]+",
    "linkedin": r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[A-Za-z0-9_\-]+",
    "discord": r"https?://(?:discord\.gg|discord\.com/invite)/[A-Za-z0-9]+",
}


def extract_social_links(text: str) -> list:
    """Returns [{"platform":..., "url":...}], deduped, preserving first occurrence."""
    found = []
    seen = set()
    for platform, pattern in SOCIAL_PATTERNS.items():
        for match in re.finditer(pattern, text, re.IGNORECASE):
            url = match.group(0).rstrip(".,);\"'")
            key = url.lower()
            if key in seen:
                continue
            seen.add(key)
            found.append({"platform": platform, "url": url})
    return found


def extract_contacts_and_socials(text: str) -> tuple:
    """
    Returns (contact_info_dict, social_links_list).
    contact_info keys: telegram, whatsapp, email, phone.
    """
    contacts = extract_contacts(text)
    socials = extract_social_links(text)
    return contacts, socials
