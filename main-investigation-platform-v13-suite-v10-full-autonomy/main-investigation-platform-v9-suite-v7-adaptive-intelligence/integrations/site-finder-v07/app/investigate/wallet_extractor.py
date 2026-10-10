"""
Finds cryptocurrency wallet addresses in page text/HTML and estimates a
confidence score based on surrounding context (e.g. "Deposit Address:" nearby
raises confidence; a bare address in unrelated text lowers it).

Special handling for EVM-format addresses (0x...40 hex chars): these are
ambiguous between ETH, BNB (BEP20), and MATIC (Polygon) purely from the address
string, and separately ambiguous between the native coin and a token riding on
that chain (USDT/USDC). We disambiguate using nearby context text and relabel
accordingly — see EVM_CHAIN_HINTS / TOKEN_HINTS in config.py.
"""
import re

from app.config import WALLET_REGEXES, WALLET_CONTEXT_HINTS, EVM_CHAIN_HINTS, TOKEN_HINTS

CONTEXT_WINDOW = 120  # chars before/after match to inspect for hint words


def _local_context(text: str, match_start: int, match_end: int) -> str:
    """
    Context window around a match, clipped at the nearest blank-line boundary on
    each side so labels from a neighboring, unrelated deposit-address block (e.g.
    a "USDT (BEP20)" heading a few lines above an unrelated address) don't bleed
    into this address's context.
    """
    raw_start = max(0, match_start - CONTEXT_WINDOW)
    raw_end = min(len(text), match_end + CONTEXT_WINDOW)

    blank_before = text.rfind("\n\n", raw_start, match_start)
    start = blank_before + 2 if blank_before != -1 else raw_start

    blank_after = text.find("\n\n", match_end, raw_end)
    end = blank_after if blank_after != -1 else raw_end

    return text[start:end].replace("\n", " ").strip()


def _relabel_evm_address(context_lower: str, default_network: str) -> str:
    """
    Given context text around an 0x-format address, decide the most useful label:
    prefer an explicit token (USDT/USDC) since that's what scammers usually ask for
    by name; otherwise fall back to the underlying chain (BNB/MATIC/ETH).
    """
    for token, hints in TOKEN_HINTS.items():
        if any(h in context_lower for h in hints):
            return token
    for chain, hints in EVM_CHAIN_HINTS.items():
        if any(h in context_lower for h in hints):
            return chain
    return default_network


def extract_wallets(text: str) -> list[dict]:
    """Returns list of {"address", "network", "confidence", "context"}; deduped within this text."""
    found = {}

    for network, pattern in WALLET_REGEXES.items():
        for m in re.finditer(pattern, text):
            addr = m.group(0)
            key = (network, addr.lower())
            if key in found:
                continue

            context = _local_context(text, m.start(), m.end())
            context_lower = context.lower()

            confidence = 0.3  # baseline: bare pattern match, could be a false positive
            if any(hint in context_lower for hint in WALLET_CONTEXT_HINTS):
                confidence = 0.9
            elif network in ("BTC", "ETH", "TRON", "LTC"):
                confidence = 0.5  # these regexes are precise enough to trust more by default

            # SOL regex is very noisy (matches many base58 strings) — only keep if context supports it
            if network == "SOL" and confidence < 0.9:
                continue

            # EVM-format addresses are ambiguous between ETH/BNB/MATIC and native-vs-token;
            # relabel using nearby context so the right form option gets picked later.
            # IMPORTANT: use a separate variable here rather than reassigning the outer
            # loop variable `network` — reassigning it would leak into later iterations
            # of this same inner for-loop (Python for-loops don't reset their target
            # variable between iterations), mislabeling every subsequent ETH match.
            resolved_network = network
            if network == "ETH":
                resolved_network = _relabel_evm_address(context_lower, default_network="ETH")

            key = (resolved_network, addr.lower())
            if key in found:
                continue

            found[key] = {
                "address": addr,
                "network": resolved_network,
                "confidence": confidence,
                "context": context,
            }

    return list(found.values())
