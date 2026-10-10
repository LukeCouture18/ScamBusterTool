"""
Deposit and payment discovery.

The deposit flow is the operationally important part of a scam investment site:
it's where the money is asked for, and it's the part a reporting body most needs
documented. This module does two things the generic crawler doesn't:

1. Finds deposit/payment pages aggressively, using a much wider vocabulary than
   the general "interesting link" filter — including the non-English and
   euphemistic terms these sites favour ("recharge", "top up", "add funds",
   "cashier", "fund account", "充值").

2. Extracts STRUCTURED deposit options rather than just noting "this page had a
   wallet on it". A single deposit page often offers several networks, each with
   its own address, label and minimum — and knowing a site accepts USDT-TRC20
   with a 50 USDT minimum is materially more useful than knowing an address
   appeared somewhere.

Everything recorded here is an observed fact tied to a specific page URL.
"""
import logging
import re

logger = logging.getLogger("scamhunter.analysis.deposit_discovery")

# Deliberately wide. Deposit flows hide behind a lot of different words, and
# missing the deposit page means missing the whole point of the investigation.
DEPOSIT_URL_HINTS = [
    "deposit", "recharge", "topup", "top-up", "top_up", "addfunds", "add-funds",
    "fund", "funding", "payment", "pay", "cashier", "wallet", "buy", "purchase",
    "checkout", "billing", "account/fund", "finance", "assets", "balance",
    "withdraw", "withdrawal", "transfer", "remit",
]

DEPOSIT_TEXT_HINTS = [
    "deposit", "recharge", "top up", "top-up", "add funds", "add money",
    "fund your account", "make a payment", "cashier", "minimum deposit",
    "deposit address", "payment address", "send payment", "wallet address",
    "scan the qr", "scan qr", "充值", "存款", "입금", "депозит",
]

# Network labels as they actually appear on these pages.
NETWORK_LABEL_PATTERNS = [
    (r"\bUSDT[\s\-–—]*(?:TRC[\s\-]?20|TRON)\b", "TRON", "USDT-TRC20"),
    (r"\bUSDT[\s\-–—]*(?:ERC[\s\-]?20|ETH(?:EREUM)?)\b", "ETH", "USDT-ERC20"),
    (r"\bUSDT[\s\-–—]*(?:BEP[\s\-]?20|BSC|BNB)\b", "BNB", "USDT-BEP20"),
    (r"\bUSDC\b", "ETH", "USDC"),
    (r"\bTRC[\s\-]?20\b", "TRON", "TRC20"),
    (r"\bERC[\s\-]?20\b", "ETH", "ERC20"),
    (r"\bBEP[\s\-]?20\b", "BNB", "BEP20"),
    (r"\bBITCOIN\b|\bBTC\b", "BTC", "Bitcoin"),
    (r"\bETHEREUM\b|\bETH\b", "ETH", "Ethereum"),
    (r"\bTRON\b|\bTRX\b", "TRON", "Tron"),
    (r"\bLITECOIN\b|\bLTC\b", "LTC", "Litecoin"),
    (r"\bDOGECOIN\b|\bDOGE\b", "DOGE", "Dogecoin"),
    (r"\bPOLYGON\b|\bMATIC\b", "MATIC", "Polygon"),
    (r"\bBNB\b|\bBINANCE\s+SMART\s+CHAIN\b", "BNB", "BNB"),
]

MIN_AMOUNT_PATTERNS = [
    r"min(?:imum)?\s*(?:deposit|amount|recharge)?\s*[:：]?\s*([0-9][0-9,.]*)\s*([A-Z]{3,5})?",
    r"at\s+least\s+([0-9][0-9,.]*)\s*([A-Z]{3,5})?",
]

# Non-crypto payment methods worth recording when present.
PAYMENT_PROCESSOR_HINTS = {
    "bank_transfer": [r"\bbank\s+transfer\b", r"\bwire\s+transfer\b", r"\biban\b", r"\bswift\b"],
    "payment_processor": [r"\bpaypal\b", r"\bstripe\b", r"\bskrill\b", r"\bneteller\b",
                           r"\bwestern\s+union\b", r"\bmoneygram\b"],
    "gift_card": [r"\bgift\s+card\b", r"\bitunes\s+card\b", r"\bsteam\s+card\b"],
}


def looks_like_deposit_link(text: str, href: str) -> bool:
    """Wide-net matcher for links likely to lead to a payment flow."""
    haystack = f"{text or ''} {href or ''}".lower()
    return any(hint in haystack for hint in DEPOSIT_URL_HINTS)


def page_is_deposit_page(url: str, title: str, text: str) -> tuple:
    """
    Returns (is_deposit, matched_signal). Checks URL and title first (page-specific),
    then falls back to distinctive body phrases — but only phrases that a
    navigation bar wouldn't contain, to avoid flagging every page on the site.
    """
    url_title = f"{url} {title}".lower()
    for hint in DEPOSIT_URL_HINTS:
        if hint in url_title:
            return True, f"URL/title contains {hint!r}"

    body = (text or "").lower()
    for phrase in ("minimum deposit", "deposit address", "payment address",
                    "scan the qr", "fund your account", "make a payment",
                    "send payment", "top up your"):
        if phrase in body:
            return True, f"page body contains {phrase!r}"
    return False, ""


def detect_networks(text: str) -> list:
    """Returns [{"network","label","matched"}] for every network label present."""
    found = []
    seen = set()
    for pattern, network, label in NETWORK_LABEL_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match and label not in seen:
            seen.add(label)
            found.append({"network": network, "label": label, "matched": match.group(0)})
    return found


def detect_min_amount(text: str) -> str:
    for pattern in MIN_AMOUNT_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            amount = match.group(1)
            currency = (match.group(2) or "").strip()
            return f"{amount} {currency}".strip()
    return ""


def detect_payment_methods(text: str) -> list:
    """Non-crypto payment methods offered, which are reportable in their own right."""
    found = []
    lower = text.lower()
    for method, patterns in PAYMENT_PROCESSOR_HINTS.items():
        for pattern in patterns:
            match = re.search(pattern, lower)
            if match:
                found.append({"method": method, "matched": match.group(0)})
                break
    return found


def detect_qr_codes(html: str) -> int:
    """Counts likely QR code images — a strong sign of a crypto payment flow."""
    hits = len(re.findall(r"qr[-_]?code|qrcode", html, re.IGNORECASE))
    hits += len(re.findall(r'<img[^>]+src=["\'][^"\']*qr[^"\']*["\']', html, re.IGNORECASE))
    return hits


def extract_deposit_options(page_url: str, text: str, html: str, wallets_on_page: list) -> list:
    """
    Builds structured deposit options for one page.

    wallets_on_page : [{"address","network","wallet_id"}] already extracted/validated.

    Pairs each wallet with the network label nearest to it in the text, so a page
    offering three networks produces three correctly-labelled options rather than
    one blurry one.
    """
    options = []
    networks = detect_networks(text)
    min_amount = detect_min_amount(text)
    qr_count = detect_qr_codes(html)

    for wallet in wallets_on_page:
        label = ""
        # Find the network label mentioned closest to this address, WITHOUT
        # bleeding across a neighbouring address's label. A deposit page listing
        # several networks puts each label just before its own address, so the
        # backward window is clipped at the previous address and the search runs
        # from nearest-to-the-address outward.
        position = text.find(wallet["address"])
        if position != -1:
            other_positions = [
                text.find(other["address"]) for other in wallets_on_page
                if other["address"] != wallet["address"]
            ]
            preceding = [p for p in other_positions if p != -1 and p < position]
            floor = (max(preceding) + 1) if preceding else max(0, position - 300)
            window_start = max(floor, position - 300)
            window = text[window_start:position]
            near = detect_networks(window)
            if near:
                # Prefer the label whose match ENDS nearest the address, and
                # where two labels end at the same spot (e.g. "USDT-TRC20" and
                # bare "TRC20" both end together), prefer the longer, more
                # specific one — it tells a reviewer the token as well as the
                # chain. Ranking on start position instead would wrongly favour
                # the bare suffix, since it starts later.
                def rank(n):
                    start = window.rfind(n["matched"])
                    return (start + len(n["matched"]), len(n["matched"]))
                label = max(near, key=rank)["label"]
        if not label:
            matching = [n for n in networks if n["network"] == wallet.get("network")]
            label = matching[0]["label"] if matching else (wallet.get("network") or "")

        options.append({
            "method": "crypto_address",
            "network": wallet.get("network", ""),
            "wallet_id": wallet.get("wallet_id"),
            "address": wallet["address"],
            "label": label,
            "min_amount": min_amount,
            "instructions": _nearby_instruction(text, wallet["address"]),
            "page_url": page_url,
        })

    # Networks advertised with no address captured — still worth recording, since
    # it tells a reviewer the site accepts that network even if the address was
    # behind a tab, a login, or an image.
    covered = {o["label"] for o in options}
    for net in networks:
        if net["label"] not in covered:
            options.append({
                "method": "crypto_network_advertised",
                "network": net["network"],
                "wallet_id": None,
                "address": "",
                "label": net["label"],
                "min_amount": min_amount,
                "instructions": (f"Page advertises {net['label']} but no address was "
                                  "captured here — it may be behind a tab, login, or image."),
                "page_url": page_url,
            })

    for method in detect_payment_methods(text):
        options.append({
            "method": method["method"], "network": "", "wallet_id": None, "address": "",
            "label": method["matched"], "min_amount": min_amount,
            "instructions": f"Non-crypto payment method offered: {method['matched']}",
            "page_url": page_url,
        })

    if qr_count and not any(o["method"] == "qr_code" for o in options):
        options.append({
            "method": "qr_code", "network": "", "wallet_id": None, "address": "",
            "label": f"{qr_count} QR code element(s)", "min_amount": min_amount,
            "instructions": ("Page presents QR code(s) for payment; the encoded address "
                              "may differ from any text address shown."),
            "page_url": page_url,
        })

    return options


def _nearby_instruction(text: str, address: str, window: int = 220) -> str:
    """The sentence around an address — the actual instruction given to victims."""
    position = text.find(address)
    if position == -1:
        return ""
    start = max(0, position - window)
    end = min(len(text), position + len(address) + window)
    snippet = text[start:end].replace("\n", " ")
    return re.sub(r"\s+", " ", snippet).strip()
