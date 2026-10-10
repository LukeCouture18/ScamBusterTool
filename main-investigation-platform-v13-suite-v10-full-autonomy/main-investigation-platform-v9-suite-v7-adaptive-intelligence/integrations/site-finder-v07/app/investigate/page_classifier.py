"""
Fallback (non-Claude) heuristics for:
1. Classifying a visited page's type from its URL/title/text.
2. Pre-filtering a page's links down to plausible candidates before either
   handing them to Claude or, if Claude is disabled, picking directly.
"""
from app.config import INTERESTING_PAGE_WORDS

PAGE_TYPE_KEYWORDS = {
    "deposit": ["deposit", "recharge", "top up", "topup", "top-up"],
    "wallet": ["wallet"],
    "funding": ["fund"],
    "investment": ["invest"],
    "trading": ["trading", "trade now", "exchange rate", "buy/sell", "spot trading"],
    "login": ["login", "log in", "sign in"],
}


def classify_page_keyword(url: str, title: str, text: str) -> str:
    """
    Classifies a page's type from its URL path and title only — signals
    specific to THIS page — deliberately NOT from general body text. Body
    text on most real sites (scam or legitimate) includes a persistent nav
    bar/header/footer repeated on every page; a page whose nav merely
    contains a "Deposit" link must not itself be classified as a deposit
    page just because that word appears somewhere on it. That's true of
    nearly every page on a typical scam site's shared-template nav.

    Returns "other" when URL/title give no signal — callers (see navigator.py)
    fall back to Claude's classify_page_type() in that case, which reads the
    actual page content and heading structure rather than a flat keyword scan.
    """
    url_title = f"{url} {title}".lower()

    for page_type, keywords in PAGE_TYPE_KEYWORDS.items():
        if any(kw in url_title for kw in keywords):
            return page_type

    return "other"


def filter_interesting_links(links: list[dict], max_links: int = 20) -> list[dict]:
    """Keep links whose text/href contains any interesting keyword, most-relevant first."""
    scored = []
    for link in links:
        haystack = f"{link.get('text','')} {link.get('href','')}".lower()
        hits = sum(1 for w in INTERESTING_PAGE_WORDS if w in haystack)
        if hits > 0:
            scored.append((hits, link))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [link for _, link in scored[:max_links]]


def filter_wallet_priority_links(links: list[dict], max_links: int = 20) -> list[dict]:
    """
    Like filter_interesting_links, but scored against WALLET_PAGE_PRIORITY_WORDS —
    the narrower set of words that specifically indicate a page will show an
    actual deposit address, rather than general account/finance content. Used
    in deep-wallet-hunt mode so the crawl budget goes toward pages that are
    actually likely to contain a wallet address, not just anything finance-adjacent.
    """
    from app.config import WALLET_PAGE_PRIORITY_WORDS
    scored = []
    for link in links:
        haystack = f"{link.get('text','')} {link.get('href','')}".lower()
        hits = sum(1 for w in WALLET_PAGE_PRIORITY_WORDS if w in haystack)
        if hits > 0:
            scored.append((hits, link))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [link for _, link in scored[:max_links]]
