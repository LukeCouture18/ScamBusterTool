"""
Typed, context-aware evidence.

v1 counted words: `withdraw` anywhere fired "deposit language", `telegram`
anywhere fired "off-platform contact", any 0x address fired "wallet". Every
legitimate exchange, DeFi project and crypto blog trips all three. v2 asks
narrower questions that legitimate sites rarely answer yes to:

    Does the page promise a fixed daily return?          (promise)
    Does withdrawing require paying first?               (withdrawal_trap)
    Is a checksum-valid address shown *as a place to send money*? (wallet)
    Does it ask for a recovery phrase?                   (seed_phrase)
    Is it a brand's name on a login page that isn't the brand's domain? (impersonation)
    Is it a login-gated trading-app kit?                 (app_kit)
    Does it sell recovery of stolen crypto?              (recovery)

Those are "core" signals: at least one must be present before anything
reaches the inbox. Weaker context (plan tiers, referral ladders, fake
counters, off-platform support, new registration) adds confidence but can
never carry a candidate on its own. Counter-signals (regulator registration,
statutory risk warnings, long-established domain, donation or contract-address
context) subtract.

Each signal carries a short human phrase; the inbox shows at most two.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict

from app.v2 import domains as dm
from app.v2.classify import LEGIT_REGULATED, RISK_DISCLOSURE

# group -> (weight, is_core)
GROUPS = {
    "promise": (2.6, True), "withdrawal_trap": (2.6, True), "wallet": (2.2, True),
    "seed_phrase": (3.4, True), "impersonation": (3.2, True), "app_kit": (3.0, True),
    "recovery": (3.0, True),
    "scheme": (1.4, False), "funnel": (1.1, False), "contact": (0.6, False), "trust": (0.4, False),
    "pressure": (0.35, False), "novelty": (1.0, False), "naming": (0.35, False),
    "legitimacy": (-2.2, False), "established": (-1.6, False),
}

DAILY_RATE = re.compile(
    r"(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:daily|per\s*day|a\s*day|/\s*day|every\s*(?:day|24\s*h(?:ours|rs)?)|each\s*day|"
    r"per\s*24\s*h|(?:for|over)\s*\d+\s*days)|(?:daily|每日收益?|每天|/day)\D{0,24}?(\d{1,2}(?:\.\d{1,2})?)\s*%", re.I)
PER_TRADE = re.compile(r"(profit|return|earn)[^.]{0,20}\bup to\s*\d{2,3}\s*%\s*(per|each|a)\s*(trade|order|round)", re.I)
MULTIPLIER = re.compile(r"(\d{3})\s*%\s*(after|in)\s*\d+\s*(days|hours)|double your (money|bitcoin|crypto|investment|deposit)", re.I)
DOLLAR_DAY = re.compile(r"\$\s?[\d.,]+\s*(/|per)\s*day", re.I)
GUARANTEE = re.compile(r"(guarantee\w*\s+(?:stable\s+|fixed\s+)?(?:daily\s+)?(?:profit|return|income|roi|earning)|"
                       r"risk[\s-]?free\s+(?:investment|profit|income|return)|principal\s+(?:return(?:ed)?|back|protected)|"
                       r"withdraw anytime|auto-?compound)", re.I)
WITHDRAW_TRAP = re.compile(
    r"((?:tax|fee|deposit)\s+(?:to|before)\s+(?:withdraw|release|unlock)|withdrawal\s+(?:fee|tax)\s+(?:is\s+)?required|"
    r"unlock\s+(?:your\s+)?withdrawal|pay(?:ment of)?\s+(?:the\s+)?\d{1,2}\s*%\s*(?:income\s+|capital\s+gains\s+)?tax|"
    r"security\s+deposit|reach\s+vip\s*\d\s+.{0,30}withdraw|to unlock withdrawal|activation fee|verification fee|"
    r"must (?:reach|upgrade)[^.]{0,30}vip|before (?:your )?withdrawal (?:can be|is) (?:processed|released))", re.I)
PLAN_TIERS = re.compile(r"(\b(starter|basic|advanced|premium|elite|trial|silver|gold|platinum|diamond|vip)\b[^.<]{0,40}?"
                        r"(\$\s?\d[\d,]*\s*-\s*\$?\s?\d|\bmin(imum)?\b|\d+\s*usdt|contract|plan|%))", re.I)
VIP_LADDER = re.compile(r"vip\s*[1-9]\b[^.]{0,60}vip\s*[2-9]\b|vip levels?\s*\d|vip\d\s*[—-]", re.I)
REFERRAL = re.compile(r"(referral (commission|bonus|reward)s?|invite friends|team (rewards?|commission)|"
                      r"\d{1,2}%\s*-\s*\d{1,2}%\s*-\s*\d{1,2}%|推荐奖励|earn \d{1,2}% of their)", re.I)
FAKE_STATS = re.compile(r"(total (accounts|deposit(ed|s)?|withdraw(als|n)|paid( out)?|members|investors|users)|"
                        r"online:?\s*\d|members online|last (deposits|withdrawals|payouts)|recent payouts)", re.I)
DEPOSIT_FUNNEL = re.compile(r"(\brecharge\b|top[\s-]?up|(deposit|recharge|payment) address|send (usdt|payment|btc|bitcoin|funds) to|"
                            r"upload (your )?(transfer|payment) (screenshot|receipt)|exclusive recharge address|"
                            r"transfer usdt|assets\s*→\s*deposit|充值)", re.I)
ACCOUNT_FUNNEL = re.compile(r"(\bsign\s*up\b|\bregister\b|\blog\s*in\b|\blogin\b|create (an )?account|get started|join now)", re.I)
INVITE = re.compile(r"(invitation code|invite code|邀请码|referral code \(|invitecode)", re.I)
APP_KIT_WORDS = re.compile(r"(seconds? contract|options? trad|contract trading|real-?name auth|online (customer )?service|"
                           r"download app|fund password|\bkline\b|\bmining\b|\bloan\b|quick trade|assets?\b)", re.I)
LIVECHAT = re.compile(r"(tawk\.to|meiqia|chatwoot|crisp\.chat|livechatinc|zopim|53kf|smartsupp|/chat\?cid=)", re.I)
SPA_CONFIG = re.compile(r"window\.__?config__?\s*=\s*\{[^}]*(service|kefu|chat)", re.I)
BUNDLE_APP = ("recharge", "withdraw", "invitationcode", "secondscontract", "realnameauth", "onlineservice",
              "fundpassword", "rechargerecord", "withdrawaddress", "optiontrade", "miningproducts", "loanapply", "kline")
SEED = re.compile(r"((recovery|seed|secret|mnemonic)\s+phrase|12\s*(or|/)\s*24[\s-]*word|(12|24)[\s-]word|private key|keystore|"
                  r"validate (your )?wallet|wallet (validation|sync|synchroni[sz]ation)|sync (your )?wallet|rectify)", re.I)
SEED_NEGATION = re.compile(r"never (share|give|enter|type)[^.]{0,40}(phrase|seed|private key)", re.I)
RESTRICTION = re.compile(r"(account (has been |is )?(restricted|suspended|locked|limited)|unusual activity|verify your identity|"
                         r"withdrawals? (have been |are )?(restricted|suspended|disabled))", re.I)
RECOVERY = re.compile(r"(recover (your )?(stolen|lost|scammed)?\s*(crypto|bitcoin|funds|usdt|money)|fund recovery|crypto recovery|"
                      r"(blockchain )?forensics? agents|no recovery,?\s*no fee|get (your )?(money|funds|crypto) back)", re.I)
SUPPORT_OFFPLATFORM = re.compile(r"((customer service|support|contact (our )?(agents|us|advisor)|online service|advisor|mentor|teacher)"
                                 r"[^.<]{0,60}(whatsapp|telegram|wa\.me|t\.me))|((whatsapp|telegram)[^.<]{0,40}(customer service|support|agent))", re.I)
FAKE_TRUST = re.compile(r"(licensed by us msb|fincen|licensed and regulated|fully insured|100%\s*(safe|secure|guaranteed)|"
                        r"registered company|company no\.|sec registered|fca regulated|government licen[cs]ed|uk registered)", re.I)
URGENCY = re.compile(r"(within 24 hours|offer ends|limited time|last chance|act now|hurry|only \d+ spots|ends soon)", re.I)
PAYMENT_METHODS = re.compile(r"(we accept|payment (methods|systems))[^.]{0,80}(bitcoin|usdt|tether|ethereum|litecoin|trc20)", re.I)
WALLET_BAD_CONTEXT = re.compile(r"(donat|contract address|router|token contract|reported by (users|victims)|audit|"
                                r"example|sample|do not send)", re.I)
PASSWORD_FORM = re.compile(r"type=['\"]?password|<textarea|placeholder=['\"][^'\"]*(password|phrase|private key)", re.I)


@dataclass
class Signal:
    name: str
    group: str
    strength: float
    phrase: str
    detail: str = ""

    def as_dict(self):
        return asdict(self)


def _wallets(text: str) -> list:
    from app.investigate.wallet_extractor import extract_wallets
    from app.analysis.wallet_validator import validate_format
    out = []
    for w in extract_wallets(text):
        if w["network"] in ("XRP", "SOL", "ADA", "DOGE", "DASH") and w["confidence"] < 0.9:
            continue
        v = validate_format(w["address"], w["network"])
        if not v.get("format_valid"):
            continue
        ctx = w.get("context", "")
        if WALLET_BAD_CONTEXT.search(ctx):
            continue
        out.append({**w, "validated": True, "deposit_context": w["confidence"] >= 0.9})
    return out


def extract(domain: str, html: str, text: str, title: str, bundle: str = "",
            registered_days: float | None = None, cert_age_days: float | None = None) -> list:
    """All signals for one page. Pure function: no network, no database."""
    sig: list[Signal] = []
    lower = (html or "").lower()
    t = f"{title} . {text}"

    def add(name, group, strength, phrase, detail=""):
        sig.append(Signal(name, group, round(strength, 3), phrase, detail))

    # --- promise -----------------------------------------------------------------
    rates = []
    for m in DAILY_RATE.finditer(t):
        raw = m.group(1) or m.group(2)
        try:
            rates.append(float(raw))
        except (TypeError, ValueError):
            pass
    rates = [r for r in rates if 0.3 <= r <= 60]
    if rates:
        top = max(rates)
        add("fixed_daily_return", "promise", 0.95 if top >= 0.8 else 0.7, f"promises {top:g}% daily",
            "A fixed percentage return per day.")
    if PER_TRADE.search(t):
        add("per_trade_profit", "promise", 0.75, "promises big per-trade profits")
    if MULTIPLIER.search(t) or DOLLAR_DAY.search(t):
        add("payout_multiplier", "promise", 0.7, "fixed payout schedule")
    g = GUARANTEE.search(t)
    if g:
        add("guaranteed_returns", "promise", 0.55, "guaranteed returns", g.group(0))

    # --- withdrawal trap ---------------------------------------------------------
    w = WITHDRAW_TRAP.search(t)
    if w:
        add("withdrawal_fee_trap", "withdrawal_trap", 0.9, "must pay before withdrawing", w.group(0)[:80])

    # --- wallet -----------------------------------------------------------------
    wallets = _wallets(text)
    if wallets:
        best = max(wallets, key=lambda x: (x["deposit_context"], x["confidence"]))
        add("deposit_address", "wallet", 0.95 if best["deposit_context"] else 0.7,
            f"deposit address shown ({best['network']})", best["address"])
    elif PAYMENT_METHODS.search(t):
        add("crypto_payment_methods", "funnel", 0.35, "takes crypto deposits")

    # --- seed phrase / impersonation / recovery --------------------------------
    seed = SEED.search(t)
    if seed and not SEED_NEGATION.search(t) and (PASSWORD_FORM.search(lower) or "<form" in lower or "<textarea" in lower):
        add("asks_recovery_phrase", "seed_phrase", 0.95, "asks for a wallet recovery phrase", seed.group(0))
    brand = dm.brand_lookalike(domain)
    if brand:
        brand_word = {"cryptocom": "crypto.com", "trustwallet": "trust"}.get(brand, brand)
        on_page = brand_word in t.lower() or brand in t.lower()
        creds = bool(PASSWORD_FORM.search(lower)) or bool(seed)
        if on_page and creds:
            add("brand_login_clone", "impersonation", 0.95, f"{brand.capitalize()} login page on a look-alike domain")
        elif on_page:
            add("brand_lookalike", "impersonation", 0.45, f"uses the {brand.capitalize()} name on a look-alike domain")
        else:
            add("brand_in_name", "naming", 0.6, f"domain imitates {brand.capitalize()}")
    if RESTRICTION.search(t) and PASSWORD_FORM.search(lower):
        add("account_restriction_lure", "pressure", 0.8, "'account restricted' lure")
    r = RECOVERY.search(t)
    if r:
        add("fund_recovery_offer", "recovery", 0.9, "sells 'recovery' of stolen crypto", r.group(0))

    # --- trading-app kit ---------------------------------------------------------
    kit_words = {m.group(0).lower() for m in APP_KIT_WORDS.finditer(t)}
    bundle_l = (bundle or "").lower()
    bundle_hits = [s for s in BUNDLE_APP if s in bundle_l]
    invite = bool(INVITE.search(t)) or "invitationcode" in bundle_l or "invitecode" in bundle_l
    chat = bool(LIVECHAT.search(lower)) or bool(SPA_CONFIG.search(lower))
    kit_score = 0.0
    strong_kit = len(bundle_hits) >= 3
    if strong_kit:
        kit_score = 0.9
    if invite and (kit_words or bundle_hits):
        kit_score = max(kit_score, 0.85 if (len(kit_words) >= 3 or chat) else 0.8)
        if strong_kit:
            kit_score = 0.95
    if len(kit_words) >= 3 and (invite or chat or DEPOSIT_FUNNEL.search(t)):
        kit_score = max(kit_score, 0.75)
    if kit_score:
        add("trading_app_kit", "app_kit", kit_score, "login-gated trading app kit",
            ", ".join(sorted(kit_words))[:120] + (f"; bundle: {', '.join(bundle_hits[:6])}" if bundle_hits else ""))
    if chat:
        add("embedded_support_chat", "contact", 0.4, "support via embedded chat")

    # --- scheme structure ---------------------------------------------------------
    tiers = len(PLAN_TIERS.findall(t)) + (2 if VIP_LADDER.search(t) else 0)
    if tiers >= 2:
        add("plan_tiers", "scheme", 0.7 if tiers >= 3 else 0.5, "tiered deposit plans")
    if REFERRAL.search(t):
        add("referral_ladder", "scheme", 0.45, "referral commissions")
    if FAKE_STATS.search(t):
        add("payout_counters", "scheme", 0.5, "live 'total paid' counters")

    # --- funnel -----------------------------------------------------------------
    if DEPOSIT_FUNNEL.search(t):
        add("deposit_instructions", "funnel", 0.55, "tells you where to deposit")
    if ACCOUNT_FUNNEL.search(t) or PASSWORD_FORM.search(lower):
        add("account_signup", "funnel", 0.3, "sign-up / login")
    if invite:
        add("invitation_code", "funnel", 0.5, "asks for an invitation code")

    # --- contact / trust / pressure ------------------------------------------------
    if SUPPORT_OFFPLATFORM.search(t):
        add("offplatform_support", "contact", 0.6, "support only via WhatsApp/Telegram")
    ft = FAKE_TRUST.search(t)
    if ft and not LEGIT_REGULATED.search(t):
        add("unverifiable_licence_claims", "trust", 0.6, "unverifiable licence/safety claims", ft.group(0))
    if URGENCY.search(t):
        add("urgency", "pressure", 0.4, "pressure to act fast")

    # --- novelty and naming -------------------------------------------------------
    if registered_days is not None:
        if registered_days <= 14:
            add("registered_days_ago", "novelty", 0.8, f"registered {max(1, int(registered_days))} days ago")
        elif registered_days <= 60:
            add("registered_days_ago", "novelty", 0.5, f"registered {int(registered_days)} days ago")
        elif registered_days >= 730:
            add("established_domain", "established", 0.8, f"registered {int(registered_days / 365)} years ago")
        elif registered_days >= 180:
            add("aging_domain", "established", 0.35, f"registered {int(registered_days / 30)} months ago")
    elif cert_age_days is not None and cert_age_days <= 14:
        add("new_certificate", "novelty", 0.35, "brand-new certificate")
    shape = dm.shape_features(domain)
    if shape["suspicious_tld"]:
        add("throwaway_tld", "naming", 0.35, f".{shape['tld']} domain")

    # --- counter-evidence -------------------------------------------------------------
    if LEGIT_REGULATED.search(t):
        add("regulator_registration", "legitimacy", 0.9, "shows a regulator registration")
    if RISK_DISCLOSURE.search(t):
        add("risk_disclosure", "legitimacy", 0.6, "statutory risk warnings")
    if SEED_NEGATION.search(t):
        add("security_education", "legitimacy", 0.5, "warns users never to share seed phrases")
    return sig


def core_groups(signals: list) -> set:
    return {s.group for s in signals if GROUPS.get(s.group, (0, False))[1] and s.strength >= 0.5}
