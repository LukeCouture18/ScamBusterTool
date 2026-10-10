"""
Indicator extraction: harvests every reusable public artifact a site exposes.

Everything here produces OBSERVED FACTS only. Each extractor returns the value
plus where and how it was seen, so the resulting observation can stand on its
own as evidence. No conclusions are drawn in this module — that's correlation's
job.

The indicator types are chosen because they're hard for an operator to vary
cheaply across a fleet of sites:
  - wallet         : where the money actually goes
  - analytics_id   : Google Analytics / GTM / Yandex IDs, bound to one account
  - telegram/whatsapp/email/phone : the support channel, usually shared fleet-wide
  - template_hash  : structural fingerprint of the page builder used
  - favicon_hash   : the icon, almost never regenerated per site
  - cert_sha256    : the TLS certificate, shared when one cert covers many domains
  - ip / nameserver: hosting, weak alone but corroborating
  - registrar      : who the domain was bought from
"""
import hashlib
import logging
import re
import socket
import ssl

import requests

from app import db
from app.config import USER_AGENT
from app.discovery.template_similarity import structural_fingerprint
from app.investigate.contact_extractor import extract_contacts_and_socials

logger = logging.getLogger("scamhunter.analysis.indicator_extractor")

# Analytics / tag manager IDs — account-bound, so extremely good fingerprints.
ANALYTICS_PATTERNS = [
    (r"\bUA-\d{4,10}-\d{1,4}\b", "google_analytics_ua"),
    (r"\bG-[A-Z0-9]{8,12}\b", "google_analytics_ga4"),
    (r"\bGTM-[A-Z0-9]{5,9}\b", "google_tag_manager"),
    (r"\bAW-\d{9,12}\b", "google_ads"),
    (r"yandex[_.]?metrika[^0-9]{0,20}(\d{6,10})", "yandex_metrika"),
    (r"fbq\(\s*['\"]init['\"]\s*,\s*['\"](\d{13,17})['\"]", "facebook_pixel"),
    (r"hotjar[^0-9]{0,20}(\d{6,9})", "hotjar"),
]


def extract_analytics_ids(html: str) -> list:
    """Returns [{"value", "kind"}] for every analytics/tag ID found."""
    found = []
    seen = set()
    for pattern, kind in ANALYTICS_PATTERNS:
        for match in re.finditer(pattern, html, re.IGNORECASE):
            value = match.group(1) if match.groups() else match.group(0)
            value = value.strip()
            if value and value.lower() not in seen:
                seen.add(value.lower())
                found.append({"value": value, "kind": kind})
    return found


def favicon_hash(base_url: str, timeout: int = 8) -> str:
    """
    SHA-256 of the site's favicon. Operators rarely bother changing the icon
    across a fleet, so this is a surprisingly durable fingerprint.
    Returns "" on any failure — a missing favicon is not an error.
    """
    from urllib.parse import urljoin
    try:
        resp = requests.get(urljoin(base_url, "/favicon.ico"),
                             headers={"User-Agent": USER_AGENT}, timeout=timeout)
        if resp.status_code != 200 or not resp.content:
            return ""
        if len(resp.content) < 32:  # empty/placeholder responses aren't fingerprints
            return ""
        return hashlib.sha256(resp.content).hexdigest()
    except requests.exceptions.RequestException:
        return ""
    except Exception as e:
        logger.debug("favicon fetch failed for %s: %s", base_url, e)
        return ""


def tls_cert_fingerprint(domain: str, timeout: int = 8) -> dict:
    """
    SHA-256 fingerprint of the served TLS certificate, plus its SANs. One cert
    covering many domains is direct evidence they were provisioned together.
    Returns {} when TLS isn't available.
    """
    try:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with socket.create_connection((domain, 443), timeout=timeout) as sock:
            with context.wrap_socket(sock, server_hostname=domain) as tls:
                der = tls.getpeercert(binary_form=True)
                cert = tls.getpeercert()
        if not der:
            return {}
        fingerprint = hashlib.sha256(der).hexdigest()
        sans = []
        for entry in (cert or {}).get("subjectAltName", ()):
            if entry[0] == "DNS":
                sans.append(entry[1].lower())
        return {"sha256": fingerprint, "sans": sans}
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, OSError, ssl.SSLError):
        return {}
    except Exception as e:
        logger.debug("TLS fingerprint failed for %s: %s", domain, e)
        return {}


def resolve_ip(domain: str) -> str:
    try:
        socket.setdefaulttimeout(4)
        return socket.gethostbyname(domain)
    except Exception:
        return ""


def resolve_nameservers(domain: str) -> list:
    try:
        import dns.resolver
        answers = dns.resolver.resolve(domain, "NS", lifetime=4)
        return sorted(str(r.target).rstrip(".").lower() for r in answers)
    except Exception:
        return []


def extract_all_indicators(site: dict, pages: list, page_texts: dict,
                            page_htmls: dict, scan_id: str = "") -> dict:
    """
    Harvests every indicator type from an already-scanned site and records each
    as an observation. Returns a summary of what was found.

    site        : the sites row
    pages       : list of pages rows
    page_texts  : {page_url: visible text}
    page_htmls  : {page_url: raw html}
    """
    site_id = site["id"]
    domain = site["domain"]
    found = {"wallet": [], "analytics_id": [], "telegram": [], "whatsapp": [],
             "email": [], "phone": [], "template_hash": [], "favicon_hash": [],
             "cert_sha256": [], "ip": [], "nameserver": []}

    home_url = site["url"]

    # --- Wallets (already extracted and validated elsewhere; mirrored into the graph) ---
    for wallet in db.wallets_for_site(site_id):
        sighting_url = home_url
        with db.get_conn() as conn:
            row = conn.execute(
                """SELECT p.url, ws.context_snippet FROM wallet_sightings ws
                   LEFT JOIN pages p ON p.id = ws.page_id
                   WHERE ws.wallet_id=? AND ws.site_id=? LIMIT 1""",
                (wallet["id"], site_id),
            ).fetchone()
            context = ""
            if row:
                sighting_url = row["url"] or home_url
                context = row["context_snippet"] or ""
        db.record_observation(site_id, "wallet", wallet["address"], sighting_url,
                               "page_text", context, scan_id=scan_id)
        found["wallet"].append(wallet["address"])

    # --- Analytics / tag IDs, per page ---
    for page_url, html in page_htmls.items():
        for item in extract_analytics_ids(html):
            db.record_observation(
                site_id, "analytics_id", item["value"], page_url, "html",
                f"{item['kind']} ID embedded in page source", scan_id=scan_id)
            found["analytics_id"].append(item["value"])

    # --- Contacts and socials, from combined page text ---
    combined = " ".join(page_texts.values()) + " " + " ".join(page_htmls.values())
    contacts, socials = extract_contacts_and_socials(combined)
    for kind in ("telegram", "whatsapp", "email", "phone"):
        for value in contacts.get(kind, []):
            db.record_observation(site_id, kind, value, home_url, "page_text",
                                   f"{kind} contact published on the site", scan_id=scan_id)
            found[kind].append(value)

    # --- Template fingerprint from the landing page ---
    if page_htmls:
        first_url = next(iter(page_htmls))
        fingerprint = structural_fingerprint(page_htmls[first_url])
        if fingerprint:
            # A frozenset of ints isn't stable as text; hash it deterministically.
            digest = hashlib.sha256(
                ",".join(str(x) for x in sorted(fingerprint)).encode()).hexdigest()
            db.record_observation(site_id, "template_hash", digest, first_url,
                                   "html_structure",
                                   "Structural fingerprint of the page's HTML tag sequence",
                                   scan_id=scan_id)
            found["template_hash"].append(digest)

    # --- Favicon ---
    icon = favicon_hash(home_url)
    if icon:
        db.record_observation(site_id, "favicon_hash", icon, home_url + "/favicon.ico",
                               "http_fetch", "SHA-256 of the served favicon", scan_id=scan_id)
        found["favicon_hash"].append(icon)

    # --- TLS certificate ---
    cert = tls_cert_fingerprint(domain)
    if cert.get("sha256"):
        san_note = ""
        if cert.get("sans"):
            san_note = f" Certificate also covers: {', '.join(cert['sans'][:8])}"
        db.record_observation(site_id, "cert_sha256", cert["sha256"], f"https://{domain}",
                               "tls_cert",
                               f"SHA-256 of the served TLS certificate.{san_note}",
                               scan_id=scan_id)
        found["cert_sha256"].append(cert["sha256"])
        found["cert_sans"] = cert.get("sans", [])

    # --- Hosting ---
    ip = resolve_ip(domain)
    if ip:
        db.record_observation(site_id, "ip", ip, domain, "dns_a",
                               f"{domain} resolves to {ip}", scan_id=scan_id)
        found["ip"].append(ip)

    for ns in resolve_nameservers(domain):
        db.record_observation(site_id, "nameserver", ns, domain, "dns_ns",
                               f"{domain} is served by nameserver {ns}", scan_id=scan_id)
        found["nameserver"].append(ns)

    # --- Close out anything a previous scan saw that is now gone ---
    for itype in ("wallet", "analytics_id", "telegram", "whatsapp", "email",
                   "phone", "template_hash", "favicon_hash", "cert_sha256", "ip", "nameserver"):
        db.mark_indicators_absent(site_id, itype, found.get(itype, []), scan_id=scan_id)

    found["total"] = sum(len(v) for v in found.values() if isinstance(v, list))
    return found
