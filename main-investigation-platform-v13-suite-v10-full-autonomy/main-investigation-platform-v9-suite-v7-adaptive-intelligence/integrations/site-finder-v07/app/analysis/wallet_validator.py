"""
Wallet validation: two independent layers.

1. FORMAT/CHECKSUM VALIDATION (offline, always runs, no network).
   Most crypto address formats carry an internal checksum, so a mistyped,
   truncated, or regex-false-positive "address" can be proven invalid without
   ever touching the network. This is what stops a random base58-looking string
   from being reported as a real wallet — important, because submitting a bogus
   address to a reporting form is worse than submitting nothing.

2. ON-CHAIN ACTIVITY (network, optional, degrades gracefully).
   Queries free public block explorers for balance/transaction count. This is
   what separates "an address appears on the page" from "an address that has
   actually received money" — the single most useful prioritization signal for
   a human reviewer. Any failure here (explorer down, rate limited, no network)
   is recorded as "activity unavailable" and never invalidates the address.
"""
import hashlib
import logging
import re

import requests

from app.config import (
    BLOCKCHAIN_EXPLORERS, WALLET_ACTIVITY_TIMEOUT_SECONDS,
    WALLET_ACTIVITY_ENABLED, USER_AGENT,
)

logger = logging.getLogger("scamhunter.analysis.wallet_validator")

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


# ---------------- Base58Check (BTC, TRON, LTC, DOGE, DASH) ----------------

def _b58_decode(value: str) -> bytes:
    num = 0
    for char in value:
        index = B58_ALPHABET.find(char)
        if index == -1:
            raise ValueError(f"invalid base58 character {char!r}")
        num = num * 58 + index
    raw = num.to_bytes((num.bit_length() + 7) // 8, "big")
    # Leading '1's in base58 represent leading zero bytes.
    pad = len(value) - len(value.lstrip("1"))
    return b"\x00" * pad + raw


def base58check_valid(address: str) -> tuple:
    """Returns (is_valid, detail). Verifies the trailing 4-byte double-SHA256 checksum."""
    try:
        decoded = _b58_decode(address)
    except ValueError as e:
        return False, f"not valid base58: {e}"
    if len(decoded) < 5:
        return False, "decoded payload too short to contain a checksum"
    payload, checksum = decoded[:-4], decoded[-4:]
    expected = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    if checksum != expected:
        return False, "base58check checksum mismatch (address is malformed or mistyped)"
    return True, "valid base58check checksum"


# ---------------- EVM (ETH, BNB, MATIC, and ERC-20 tokens) ----------------

def eip55_valid(address: str) -> tuple:
    """
    Validates an 0x address. If it's mixed-case it must satisfy the EIP-55
    checksum; all-lowercase or all-uppercase addresses are valid-but-unchecksummed
    (common in the wild), so those pass with a note rather than failing.
    """
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        return False, "not a 40-hex-character 0x address"

    body = address[2:]
    if body == body.lower() or body == body.upper():
        return True, "valid EVM address format (no mixed-case checksum to verify)"

    digest = hashlib.sha3_256  # keccak-256 is not in hashlib; see note below
    # NOTE: EIP-55 requires keccak-256, which differs from SHA3-256. Python's
    # stdlib has no keccak, and we deliberately avoid adding a dependency just
    # for this, so a mixed-case address is accepted as format-valid with an
    # explicit caveat rather than being wrongly rejected by the wrong hash.
    return True, ("valid EVM address format; mixed-case EIP-55 checksum not verified "
                  "(requires keccak-256, not available in the standard library)")


# ---------------- Bech32 (BTC bc1..., LTC ltc1...) ----------------

BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values):
    generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ value
        for i in range(5):
            chk ^= generator[i] if ((top >> i) & 1) else 0
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def bech32_valid(address: str) -> tuple:
    """Validates a bech32/bech32m segwit address checksum."""
    if address != address.lower() and address != address.upper():
        return False, "bech32 address must not be mixed case"
    addr = address.lower()
    pos = addr.rfind("1")
    if pos < 1 or pos + 7 > len(addr):
        return False, "malformed bech32 address (bad separator position)"
    hrp, data_part = addr[:pos], addr[pos + 1:]
    try:
        data = [BECH32_CHARSET.index(c) for c in data_part]
    except ValueError as e:
        return False, f"invalid bech32 character: {e}"
    checksum = _bech32_polymod(_bech32_hrp_expand(hrp) + data)
    if checksum == 1:
        return True, "valid bech32 checksum"
    if checksum == 0x2bc830a3:
        return True, "valid bech32m checksum"
    return False, "bech32 checksum mismatch"


# ---------------- Dispatcher ----------------

# Networks that share the EVM 0x format — a token label (USDT/USDC) still
# validates as an EVM address, since that's the underlying address format.
EVM_NETWORKS = {"ETH", "BNB", "MATIC", "USDT", "USDC"}
BASE58CHECK_NETWORKS = {"BTC", "TRON", "LTC", "DOGE", "DASH"}


def validate_format(address: str, network: str) -> dict:
    """
    Offline format/checksum validation. Always returns a dict; never raises.
    """
    network = (network or "").upper()

    if network in EVM_NETWORKS or address.startswith("0x"):
        valid, detail = eip55_valid(address)
        return {"format_valid": int(valid), "validation_detail": detail,
                "network_confirmed": network or "ETH"}

    if address.lower().startswith(("bc1", "ltc1", "tb1")):
        valid, detail = bech32_valid(address)
        return {"format_valid": int(valid), "validation_detail": detail,
                "network_confirmed": network or ("BTC" if address.lower().startswith("bc1") else "LTC")}

    if network in BASE58CHECK_NETWORKS or re.fullmatch(r"[" + B58_ALPHABET + r"]{25,40}", address or ""):
        valid, detail = base58check_valid(address)
        # TRON addresses always start with 'T' and decode to 21 bytes starting 0x41.
        if valid and network == "TRON" and not address.startswith("T"):
            return {"format_valid": 0,
                    "validation_detail": "checksum valid but not a TRON address (must start with 'T')",
                    "network_confirmed": network}
        return {"format_valid": int(valid), "validation_detail": detail,
                "network_confirmed": network}

    return {"format_valid": 0,
            "validation_detail": f"no validation rule available for network {network!r}",
            "network_confirmed": network}


# ---------------- On-chain activity (optional, public explorers) ----------------

def _fetch_activity(address: str, network: str) -> dict:
    """
    Queries a public block explorer. Returns a dict with activity fields.
    All failures are captured into activity_error rather than raised, because
    a wallet with unknown activity is still a perfectly valid finding.
    """
    network = (network or "").upper()
    # USDT/USDC on EVM use the same address space as ETH.
    lookup_network = "ETH" if network in {"USDT", "USDC", "BNB", "MATIC"} else network

    url_template = BLOCKCHAIN_EXPLORERS.get(lookup_network)
    if not url_template:
        return {"activity_checked": 1, "activity_available": 0,
                "activity_error": f"no public explorer configured for {network}"}

    url = url_template.format(address=address)
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT},
                             timeout=WALLET_ACTIVITY_TIMEOUT_SECONDS)
        if resp.status_code != 200:
            return {"activity_checked": 1, "activity_available": 0,
                    "activity_error": f"explorer returned HTTP {resp.status_code}",
                    "activity_source": lookup_network}
        data = resp.json()
    except requests.exceptions.RequestException as e:
        return {"activity_checked": 1, "activity_available": 0,
                "activity_error": f"explorer unreachable: {e}"}
    except ValueError as e:
        return {"activity_checked": 1, "activity_available": 0,
                "activity_error": f"explorer returned unparseable response: {e}"}

    try:
        return _parse_activity(lookup_network, data)
    except Exception as e:
        return {"activity_checked": 1, "activity_available": 0,
                "activity_error": f"could not interpret explorer response: {e}"}


def _parse_activity(network: str, data: dict) -> dict:
    """Normalizes each explorer's differing response shape into our common fields."""
    if network == "BTC":
        chain = data.get("chain_stats", {}) or {}
        funded = chain.get("funded_txo_sum", 0)
        spent = chain.get("spent_txo_sum", 0)
        return {
            "activity_checked": 1, "activity_available": 1,
            "balance": f"{(funded - spent) / 1e8:.8f} BTC",
            "total_received": f"{funded / 1e8:.8f} BTC",
            "tx_count": chain.get("tx_count", 0),
            "activity_source": "blockstream.info",
        }

    if network == "ETH":
        addresses = (data.get("data") or {})
        first = next(iter(addresses.values()), {}) if isinstance(addresses, dict) else {}
        info = (first or {}).get("address", {}) or {}
        return {
            "activity_checked": 1, "activity_available": 1,
            "balance": str(info.get("balance", "")),
            "total_received": str(info.get("received_approximate", "")),
            "tx_count": info.get("transaction_count", 0),
            "activity_source": "blockchair.com",
        }

    if network == "TRON":
        return {
            "activity_checked": 1, "activity_available": 1,
            "balance": str(data.get("balance", "")),
            "tx_count": data.get("transactions", 0),
            "total_received": str(data.get("totalReceived", "")),
            "activity_source": "tronscan.org",
        }

    return {"activity_checked": 1, "activity_available": 0,
            "activity_error": f"no parser for {network}"}


def validate_wallet(address: str, network: str, check_activity: bool = None) -> dict:
    """
    Full validation for one wallet: always does offline format validation,
    optionally adds on-chain activity. Returns a dict ready for
    db.save_wallet_validation().
    """
    result = validate_format(address, network)

    should_check = WALLET_ACTIVITY_ENABLED if check_activity is None else check_activity
    if should_check and result["format_valid"]:
        result.update(_fetch_activity(address, network))
    else:
        result.setdefault("activity_checked", 0)
        result.setdefault("activity_available", 0)
        if not result["format_valid"]:
            result["activity_error"] = "skipped: address failed format validation"

    return result
