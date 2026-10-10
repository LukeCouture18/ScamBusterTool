"""
Thin wrapper around the Anthropic API for the decision-making jobs this tool
needs an LLM for: given a page's visible links/buttons, decide which ones are
worth clicking next to find deposit/wallet/funding pages, and classify what
kind of page was just visited.

This never touches page content beyond what's needed for that decision, never
tells Claude to fill in forms or bypass anything, and is fully optional —
if no API key is configured, app/investigate/navigator.py falls back to a
pure keyword-matching link picker.
"""
import json
import logging

from app.config import ANTHROPIC_API_KEY, CLAUDE_MODEL, USE_CLAUDE

logger = logging.getLogger("scamhunter.claude")

_client = None
if USE_CLAUDE:
    try:
        import anthropic
        _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    except ImportError:
        logger.warning("anthropic package not installed; Claude features disabled.")
        _client = None


SYSTEM_PROMPT = """You are assisting a human researcher who investigates cryptocurrency \
scam websites for the purpose of documenting evidence (wallet addresses, deposit pages, \
scam mechanics) to report to authorities and blockchain analytics services.

You will be given a summary of the current page and a list of links/buttons found on it. \
Your only job is to select which ones are most likely to lead to pages showing: deposit \
instructions, wallet/recharge addresses, funding/investment/trading plans, or account \
balance/finance pages.

Rules you must follow:
- Only select links that are for NAVIGATING to a page (never suggest filling forms, \
  logging in with credentials, submitting transactions, or entering payment details).
- Never suggest attempting to bypass a login wall, CAPTCHA, KYC/identity verification, \
  phone verification, or any payment requirement — if the page already shows one of \
  these, do not select any link at all; just return an empty selection.
- For each link you pick, give a short, specific reason (this is logged for a human \
  reviewer, so make it genuinely informative — not a generic restatement of the link text).
- If nothing looks relevant, return an empty selection.
- Output strictly as JSON: {"selections": [{"text": "...", "href_hint": "...", "reason": "..."}]}
  where href_hint just repeats back distinguishing text from the href to help matching.
"""


def pick_links_to_investigate(page_url: str, links: list[dict], max_picks: int = 5,
                               page_context: str = "") -> list[dict]:
    """
    links: list of {"text": str, "href": str}
    page_context: optional short description of the current page (title, page type,
    what's been found so far) to give Claude better grounding for its choice.
    returns subset (with reasons) Claude thinks are worth visiting.
    """
    if not _client:
        return []
    if not links:
        return []

    trimmed = links[:150]  # keep prompt small even on link-heavy pages
    context_block = f"Page context: {page_context}\n\n" if page_context else ""
    user_content = (
        f"Current page: {page_url}\n\n{context_block}"
        f"Links found on this page (text -> href):\n"
        + "\n".join(f"- {l['text'][:80]!r} -> {l['href']}" for l in trimmed)
        + f"\n\nPick up to {max_picks} links most likely to lead to deposit, wallet, "
          "recharge, funding, investment, trading, or balance/finance pages."
    )

    try:
        resp = _client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=800,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
        )
        text = "".join(block.text for block in resp.content if block.type == "text")
        text = text.strip().strip("```json").strip("```").strip()
        data = json.loads(text)
        selections = data.get("selections", [])
        # Map back to full href by matching text (defensive against hallucinated hrefs)
        by_text = {l["text"]: l["href"] for l in trimmed}
        results = []
        for sel in selections:
            href = by_text.get(sel.get("text", ""))
            if href:
                results.append({"href": href, "text": sel.get("text"), "reason": sel.get("reason", "")})
        return results[:max_picks]
    except Exception as e:
        logger.warning("Claude link-picking failed, falling back to none: %s", e)
        return []


def classify_page_type(url: str, title: str, visible_text_sample: str) -> str:
    """Classify a visited page as deposit/wallet/funding/investment/trading/other."""
    if not _client:
        return "other"
    try:
        resp = _client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=50,
            system=(
                "Classify the page into exactly one label: deposit, wallet, funding, "
                "investment, trading, login, signup, other. Respond with only the single word label."
            ),
            messages=[{
                "role": "user",
                "content": f"URL: {url}\nTitle: {title}\nVisible text sample:\n{visible_text_sample[:2000]}",
            }],
        )
        label = "".join(b.text for b in resp.content if b.type == "text").strip().lower()
        allowed = {"deposit", "wallet", "funding", "investment", "trading", "login", "signup", "other"}
        return label if label in allowed else "other"
    except Exception as e:
        logger.warning("Claude page classification failed: %s", e)
        return "other"
