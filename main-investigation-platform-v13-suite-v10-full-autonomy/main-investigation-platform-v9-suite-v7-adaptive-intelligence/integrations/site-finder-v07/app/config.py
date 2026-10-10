"""
Central configuration for ScamHunter.
Edit values here rather than hardcoding paths/keys elsewhere.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
EVIDENCE_DIR = BASE_DIR / "evidence"
SCREENSHOT_DIR = EVIDENCE_DIR / "screenshots"
LOG_DIR = BASE_DIR / "logs"
DB_PATH = DATA_DIR / "scamhunter.db"

for d in (DATA_DIR, EVIDENCE_DIR, SCREENSHOT_DIR, LOG_DIR):
    d.mkdir(parents=True, exist_ok=True)

# --- Anthropic API ---
# Set this in your shell: export ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
USE_CLAUDE = bool(ANTHROPIC_API_KEY)  # auto-disable Claude features if no key set

# --- Crawl / safety limits ---
MAX_PAGES_PER_SITE = 25          # hard cap on pages visited per site
PAGE_LOAD_TIMEOUT_MS = 20000
NAV_DELAY_SECONDS = (1.0, 3.0)   # randomized delay range between navigations (politeness)
MAX_CONCURRENT_BROWSERS = 3      # for the queue worker, scale later for "thousands of sites"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ScamHunterResearch/1.0")

# --- Google Form submission (ScamBusters-style report form) ---
GOOGLE_FORM_URL = os.environ.get(
    "GOOGLE_FORM_URL",
    "https://docs.google.com/forms/d/e/1FAIpQLSf8ubGT2W3OA1yygsKWYj5WFSo_2QhXsBomn6IOYYWKOl266A/viewform",
)
# The target form requires a project username + team invite code (from the ScamBusters
# Discord /username and /team commands). Set these once via env vars or edit here.
FORM_USERNAME = os.environ.get("SCAMBUSTERS_USERNAME", "")
FORM_TEAM_INVITE_CODE = os.environ.get("SCAMBUSTERS_TEAM_CODE", "")

# Maps our internal network codes to the wallet-type option labels the form uses.
# Networks we detect but the form doesn't accept (e.g. SOL) are simply not submitted
# via the wallet-type dropdown; they still stay recorded locally as evidence.
FORM_NETWORK_LABELS = {
    "BTC": "Bitcoin (BTC)",
    "ETH": "Ethereum (ETH)",
    "TRON": "Tron (TRX)",
    "LTC": "Litecoin (LTC)",
    "DOGE": "Dogecoin (DOGE)",
    "XRP": "Ripple (XRP)",
    "ADA": "Cardano (ADA)",
    "DASH": "Dash (DASH)",
    "BCH": "Bitcoin Cash (BCH)",
    "BNB": "BNB (BNB)",
    "MATIC": "Polygon (MATIC)",
    "USDT": "Tether (USDT)",
    "USDC": "USD Coin (USDC)",
    # SOL has no matching form option as of this writing; it still stays recorded
    # locally as evidence, just isn't submitted through the wallet-type dropdown.
}

# --- Signup module ---
ALLOW_SIGNUP_DEFAULT = False     # per-site opt-in required; this is just the fallback default
SIGNUP_RESEARCH_EMAIL_DOMAIN = os.environ.get("SIGNUP_EMAIL_DOMAIN", "")  # e.g. your inbox-for-testing domain
SIGNUP_RESEARCH_PASSWORD = os.environ.get("SIGNUP_PASSWORD", "ResearchOnly!2026")

# --- Keyword lists used by ranker & page classifier ---
SCAM_KEYWORDS = [
    "guaranteed profit", "guaranteed return", "double your", "risk-free investment",
    "daily roi", "daily interest", "mining pool bonus", "airdrop claim now",
    "limited time investment", "recharge your account", "vip level", "invite bonus",
    "referral bonus", "customer service whatsapp", "telegram support only",
    "withdrawal fee required", "activation fee", "unlock withdrawal", "tax fee to withdraw",
]

INTERESTING_PAGE_WORDS = [
    "deposit", "recharge", "wallet", "fund", "funding", "invest", "investment",
    "top up", "topup", "top-up", "withdraw", "payment", "recharge-record",
    "asset", "balance", "cashier", "finance", "capital",
]

# A stricter subset used only in deep-wallet-hunt mode to rank links: these are
# the words most specifically associated with a page that will show an actual
# deposit address, as opposed to general account/finance pages.
WALLET_PAGE_PRIORITY_WORDS = [
    "deposit", "recharge", "wallet", "top up", "topup", "top-up", "receive",
    "add funds", "add money", "cashier", "usdt", "trc20", "erc20", "bep20",
]

WALLET_REGEXES = {
    "BTC": r"\b(bc1[a-zA-HJ-NP-Z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b",
    "ETH": r"\b0x[a-fA-F0-9]{40}\b",
    "TRON": r"\bT[a-km-zA-HJ-NP-Z1-9]{33}\b",
    "LTC": r"\b(ltc1[a-zA-HJ-NP-Z0-9]{25,90}|[ML][a-km-zA-HJ-NP-Z1-9]{26,33})\b",
    "DOGE": r"\bD{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}\b",
    "XRP": r"\br[0-9a-zA-Z]{24,34}\b",
    "ADA": r"\baddr1[a-z0-9]{20,120}\b",
    "DASH": r"\bX[1-9A-HJ-NP-Za-km-z]{33}\b",
    "BCH": r"\b(bitcoincash:)?q[a-z0-9]{41}\b",
    # SOL addresses are base58, 32-44 chars, but must not start with patterns that
    # collide with TRON ("T...") or BTC ("1"/"3"/"bc1") addresses — exclude those
    # leading chars here; extractor also requires strong context before keeping a SOL hit.
    "SOL": r"\b(?![13TDXq])[1-9A-HJ-NP-Za-km-z]{32,44}\b",
    # BNB (BEP20) and MATIC (Polygon) both use the same 0x...40-hex-char format as ETH.
    # We can't tell them apart from the address alone — only from context text nearby
    # (e.g. "BEP20" / "BSC" / "Polygon" / "MATIC"), so these share ETH's regex and get
    # relabeled post-match based on context. See _relabel_evm_address() below.
}

# Context substrings (checked near an ETH-format address) that indicate it's actually
# being used as a different EVM-compatible chain, and the token riding on it.
EVM_CHAIN_HINTS = {
    "BNB": ["bep20", "bep-20", "bsc", "binance smart chain", "binance chain"],
    "MATIC": ["polygon", "matic network", "erc20 (polygon)"],
}
TOKEN_HINTS = {
    "USDT": ["usdt", "tether"],
    "USDC": ["usdc", "usd coin"],
}


# Words near an address that raise our confidence it's really a deposit wallet vs random string
WALLET_CONTEXT_HINTS = [
    "deposit address", "send to this address", "wallet address", "payment address",
    "recharge address", "top up address", "scan qr", "network:", "chain:", "usdt-trc20",
    "usdt-erc20", "copy address",
]

# --- Access-control signals: the investigator STOPS (never bypasses) when it sees these ---
CAPTCHA_SIGNALS = [
    "recaptcha", "hcaptcha", "cf-turnstile", "turnstile", "verify you are human",
    "i'm not a robot", "captcha", "cloudflare challenge", "checking your browser",
]
KYC_SIGNALS = [
    "kyc verification", "know your customer", "upload your id", "upload a photo of your",
    "identity verification", "verify your identity", "proof of address", "passport number",
    "government-issued id", "selfie verification", "liveness check",
]
PHONE_VERIFICATION_SIGNALS = [
    "verify your phone", "enter the code we texted", "sms verification", "phone verification",
    "enter otp", "one-time code", "text message with a code", "verification code sent",
]
PAYMENT_REQUIREMENT_SIGNALS = [
    "unlock withdrawal", "activation fee", "pay to withdraw", "tax fee to withdraw",
    "insurance fee", "membership fee required", "pay to continue", "pay to unlock",
]
# Combined map used by the navigator to classify *why* it stopped.
ACCESS_CONTROL_SIGNAL_GROUPS = {
    "captcha": CAPTCHA_SIGNALS,
    "kyc": KYC_SIGNALS,
    "phone_verification": PHONE_VERIFICATION_SIGNALS,
    "payment_required": PAYMENT_REQUIREMENT_SIGNALS,
}

# --- Login/signup page recognition ---
LOGIN_PAGE_SIGNALS = ["log in", "login", "sign in", "signin"]
SIGNUP_PAGE_SIGNALS = ["sign up", "signup", "register", "create account", "create an account", "join now"]

# --- Navigation / loop-avoidance ---
MAX_PAGES_PER_INVESTIGATION = 15   # separate, slightly tighter cap than the legacy per-site crawl
MAX_LINKS_PER_PAGE_TO_CONSIDER = 8
MAX_REDIRECT_CHAIN = 5

# --- Deep wallet hunt mode ---
# When enabled, the investigator spends its whole budget trying to find every
# wallet address it can, rather than a balanced survey of the site: higher page
# and link caps, and it actively clicks through currency/network tabs on
# deposit-style pages (many scam sites hide separate BTC/ETH/USDT-TRC20/
# USDT-ERC20 addresses behind tab switches or dropdowns instead of showing them
# all at once).
DEEP_WALLET_HUNT_MAX_PAGES = 40
DEEP_WALLET_HUNT_MAX_LINKS_PER_PAGE = 15

# Clickable elements matched by their visible text (case-insensitive substring)
# that switch which wallet/network is displayed on a deposit-style page. Kept
# separate from FORBIDDEN_ACTION_SIGNALS in navigator.py — these only ever
# SWITCH which read-only address is displayed, never submit, pay, or connect
# anything, so they are safe to click even though the on-screen label often
# names a real cryptocurrency.
WALLET_TAB_SIGNALS = [
    "btc", "bitcoin", "eth", "ethereum", "usdt", "usdt-trc20", "usdt-erc20",
    "usdt-bep20", "trc20", "erc20", "bep20", "tron", "trx", "bnb", "matic",
    "polygon", "ltc", "litecoin", "doge", "dogecoin", "xrp", "ripple",
    "sol", "solana", "ada", "cardano", "dash", "bch", "usdc",
]
# A tab/label click is refused if it ALSO matches anything in this list, even
# though it matched WALLET_TAB_SIGNALS above — this guards against a button
# labeled e.g. "Buy BTC Now" or "Connect ETH Wallet" being misread as a plain
# currency-switch tab.
WALLET_TAB_EXCLUDE_SIGNALS = [
    "buy", "sell", "connect", "confirm", "send", "withdraw", "swap", "exchange now",
    "trade", "deposit now", "pay",
]

# --- Post-signup wallet hunt ---
# After a signup attempt reports "success" (no CAPTCHA/verification wall hit),
# the investigator can keep going into the freshly-authenticated area looking
# specifically for deposit/wallet pages, instead of treating signup as the end
# of that branch. This never happens unless attempt_signup_on_page() itself
# already reported a clean, non-blocked success.
POST_SIGNUP_MAX_PAGES = 10

# ============================================================
# Discovery: finding NEW candidate sites from public sources
# ============================================================

# Keyword groups used by search/certificate-transparency style discoverers to
# target specific scam categories. Kept as separate named groups (rather than
# one flat list) so discovery events can record which category a hit came
# from, and so the UI can show a by-category breakdown.
DISCOVERY_KEYWORDS = {
    "investment_platform": [
        "crypto investment platform", "daily profit crypto", "guaranteed roi crypto",
        "passive income crypto", "investment plan usdt", "high yield crypto investment",
    ],
    "trading_platform": [
        "crypto trading platform", "copy trading crypto", "ai trading bot crypto",
        "forex crypto trading signals", "automated trading profit",
    ],
    "fake_exchange": [
        "crypto exchange withdraw", "new crypto exchange 2026", "crypto exchange bonus",
    ],
    "fake_wallet": [
        "crypto wallet recovery", "wallet sync issue", "wallet validation required",
        "restore wallet phrase",
    ],
    "cloud_mining": [
        "cloud mining platform", "free cloud mining", "bitcoin cloud mining contract",
        "mining pool sign up bonus", "cloud mining daily payout",
    ],
    "usdt_deposit": [
        "usdt deposit bonus", "usdt investment platform", "usdt staking daily return",
        "trc20 deposit address investment",
    ],
    "pig_butchering": [
        "investment advisor whatsapp", "investment mentor telegram", "trading teacher guaranteed",
        "romance investment opportunity", "meet online investment platform",
    ],
}

# TLDs disproportionately used for throwaway scam infrastructure (cheap, fast
# registration, minimal verification) — used as a discovery signal, not a
# blocklist; a domain matching this alone isn't enough on its own.
DISCOVERY_SUSPICIOUS_TLDS = [".top", ".xyz", ".vip", ".live", ".cc", ".pw", ".click", ".buzz", ".cfd", ".icu"]

# Well-known crypto brand names commonly impersonated by scam sites (typosquats,
# fake "official" portals). Used by the similar-domains pivot discoverer to
# generate and check permutations, and by brand-impersonation detection when
# scoring a found site. Kept short and editable — add names relevant to your
# region/targets.
KNOWN_CRYPTO_BRANDS = [
    "binance", "coinbase", "kraken", "metamask", "trustwallet", "bybit",
    "okx", "kucoin", "bitget", "cryptocom", "ledger", "trezor",
]

# Certificate Transparency log search (crt.sh) is free and requires no API key,
# but is a shared public service — keep queries modest and spaced out.
CRT_SH_BASE_URL = "https://crt.sh/"
CRT_SH_TIMEOUT_SECONDS = 15
CRT_SH_MAX_QUERIES_PER_RUN = 12       # one query per keyword group by default
CRT_SH_REQUEST_DELAY_SECONDS = 2.0    # politeness delay between crt.sh queries

# Similar-domains (typosquat/permutation) pivot: how many character-level
# variants to try per seed domain/brand, and how many of those to actually
# resolve-check per run (DNS lookups are cheap but this still caps blast radius).
SIMILAR_DOMAIN_MAX_VARIANTS_PER_SEED = 40
SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN = 200
SIMILAR_DOMAIN_TLDS_TO_TRY = [".com", ".net", ".org", ".xyz", ".top", ".live", ".cc"]

# Shared-infrastructure pivot: how many known scam sites to pivot from per run,
# and a cap on candidate sibling domains returned per seed (reverse-IP/NS
# lookups can return large result sets on shared hosting).
SHARED_INFRA_MAX_SEEDS_PER_RUN = 10
SHARED_INFRA_MAX_SIBLINGS_PER_SEED = 15

# Discovery engine: overall pacing so this stays "passive" and respectful of
# public services rather than hammering them.
DISCOVERY_INTER_SOURCE_DELAY_SECONDS = 1.0


# ============================================================
# Quality-over-quantity pipeline
# ============================================================
# The triage gate is what turns a very large discovery pool into a small,
# strong candidate set. A site must trip MULTIPLE INDEPENDENT indicator
# categories — not just repeat one keyword — before it earns expensive deep
# analysis. Raising TRIAGE_MIN_INDICATOR_CATEGORIES makes results fewer and
# stronger; lowering it makes them more numerous and weaker.
TRIAGE_MIN_INDICATOR_CATEGORIES = 3
TRIAGE_MIN_SCORE = 6.0
TRIAGE_TIMEOUT_SECONDS = 8
TRIAGE_MAX_BYTES = 400_000      # cap per-page download so mass triage stays cheap
TRIAGE_BATCH_SIZE = 200         # how many sites to triage per pipeline pass

# Deep analysis: expensive, browser-driven, reserved for sites that cleared triage.
DEEP_ANALYSIS_BATCH_SIZE = 10           # how many strong candidates per pass
DEEP_ANALYSIS_MAX_PAGES = 30            # generous page budget — these are the good ones
DEEP_ANALYSIS_IMPORTANT_TEXT_CHARS = 4000

# Final results gate: a deep profile must reach this confidence to be surfaced
# as a "high-confidence result". Everything below still exists in the database
# but is not presented as a finished result.
HIGH_CONFIDENCE_THRESHOLD = 0.70

# ---- Wallet validation ----
# Public block explorers used for optional on-chain activity lookups. All are
# free, public, read-only endpoints; failures degrade gracefully to "activity
# unavailable" rather than breaking the profile.
WALLET_ACTIVITY_TIMEOUT_SECONDS = 10
WALLET_ACTIVITY_ENABLED = True
BLOCKCHAIN_EXPLORERS = {
    "BTC": "https://blockstream.info/api/address/{address}",
    "ETH": "https://api.blockchair.com/ethereum/dashboards/address/{address}",
    "TRON": "https://apilist.tronscanapi.com/api/accountv2?address={address}",
}

# ---- Google Form submission ----
# Submission modes:
#   manual                -> operator opens and fills the form themselves
#   review_before_submit  -> tool validates + prefills, operator reviews then confirms
#   automatic             -> tool validates + prefills and presents a one-click confirm
#                            (still requires the operator's click: filing a report is a
#                             real-world action, so a human always confirms it)
SUBMISSION_MODES = ("manual", "review_before_submit", "automatic")
DEFAULT_SUBMISSION_MODE = "review_before_submit"

# Minimum bar a result must clear before the tool will even prepare a submission.
SUBMISSION_MIN_CONFIDENCE = 0.70
SUBMISSION_REQUIRE_VALID_WALLET = True


# ============================================================
# v0.3: Discovery Pivot Engine
# ============================================================
# The engine expands outward from strong sites. These are the brakes that keep
# that expansion deliberate rather than runaway. Every one is independent — if
# any single limit is hit, the run stops and records which brake stopped it.

PIVOT_MAX_DEPTH = 2              # waves out from a seed (0 = seed's own indicators only)
PIVOT_MAX_NEW_SITES = 50         # total new candidate sites per run
PIVOT_MAX_LEADS = 200            # total pivots executed per run
PIVOT_MAX_SECONDS = 900          # wall-clock ceiling per run
PIVOT_MAX_CANDIDATES_PER_LEAD = 25   # stops one huge cert/IP flooding the run

# Only pivot from sites that already earned confidence on their own evidence.
PIVOT_MIN_SEED_CONFIDENCE = 0.70

# Evidence floor: an indicator has to be discriminating enough to be worth
# chasing. Below this strength it is evidence to record, not a lead to follow.
PIVOT_MIN_INDICATOR_STRENGTH = 0.40

# And it must not be so widespread that it describes the internet rather than
# this site. A cert on 30 domains is a hosting provider, not a fingerprint.
PIVOT_MAX_INDICATOR_SITE_COUNT = {
    "ip": 25,
    "nameserver": 60,
    "cert_sha256": 30,
    "template_hash": 40,
    "favicon_hash": 40,
    # Identity-bound indicators (wallet, analytics_id, contacts) have no cap —
    # a wallet on 200 sites is the most interesting thing we could find.
}

# Politeness: delay between active probes (DNS checks in shape-based pivots).
PIVOT_REQUEST_DELAY_SECONDS = 0.3


# ============================================================
# v0.4: Autonomous Discovery Intelligence
# ============================================================
# --- Technique learning ---
# How much evidence before the engine trusts a technique's measured yield
# enough to throttle on it. Below this, scores are provisional only.
TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE = 5
# Strength of the neutral prior: scores are shrunk toward 0.5 until roughly
# this many leads have run, so one unlucky run can't condemn a good technique.
TECHNIQUE_PRIOR_STRENGTH = 4.0
TECHNIQUE_REDUCED_THRESHOLD = 0.45     # below this -> lower priority
TECHNIQUE_SUSPENDED_THRESHOLD = 0.25   # below this -> paused (reversibly)
TECHNIQUE_RETRY_AFTER_LEADS = 25       # re-try a suspended technique this often

# --- Campaign defaults (all overridable per campaign) ---
CAMPAIGN_MAX_WAVES = 3                 # Seed->Pivot->Candidate->Validate->Expand cycles
CAMPAIGN_MAX_CANDIDATES = 100          # new candidate sites per campaign
CAMPAIGN_MAX_LEADS = 150               # pivots executed per campaign
CAMPAIGN_MAX_API_CALLS = 300           # external lookups per campaign
CAMPAIGN_MAX_SECONDS = 1800            # wall-clock ceiling
CAMPAIGN_MAX_DEEP_ANALYSES = 15        # expensive browser analyses per campaign
CAMPAIGN_MAX_CONCURRENCY = 3           # parallel workers
# Only candidates at or above this connection score are promoted to deep
# analysis. This is the gate that keeps the expensive stage selective.
CAMPAIGN_PROMOTE_MIN_CONNECTION = 0.55


# ============================================================
# v0.5: Main Platform Integration & Discovery Intelligence
# ============================================================
# Site Finder's job in the larger system is:
#   Discover -> Triage -> Correlate -> Prioritize -> Send to Main Platform
# Deep website investigation belongs to Site Investigator, reached through the
# Main Platform. Everything here is about that handoff.

# --- Connection ---
# Base URL of the Main Investigation Platform v4. Empty means "not configured",
# which is a supported state: Site Finder runs standalone and queues everything.
MAIN_PLATFORM_URL = os.environ.get("MAIN_PLATFORM_URL", "")
# The site_finder entry from the platform's MODULE_API_KEYS. Sent as
# X-API-Key, per lib/platform.ts authorizeModule().
MAIN_PLATFORM_TOKEN = os.environ.get("MAIN_PLATFORM_TOKEN", "")
# Only needed when the platform is a private hosted Site deployment; sent as
# OAI-Sites-Authorization to pass the deployment sign-in gate (API.md).
MAIN_PLATFORM_SITES_TOKEN = os.environ.get("MAIN_PLATFORM_SITES_TOKEN", "")
# Reported to the platform on register and heartbeat as module_version.
SITE_FINDER_MODULE_VERSION = os.environ.get("SITE_FINDER_MODULE_VERSION", "2.1.0")
# Retained for local bookkeeping only. The platform identifies this module by
# its module name (site_finder); it has no concept of a node id.
SITE_FINDER_NODE_ID = os.environ.get("SITE_FINDER_NODE_ID", "site-finder-1")

# How often to poll investigation context for downstream outcome signals.
FEEDBACK_POLL_INTERVAL_SECONDS = 300
FEEDBACK_POLL_BATCH = 20

MAIN_PLATFORM_TIMEOUT_SECONDS = 15
MAIN_PLATFORM_HEARTBEAT_SECONDS = 60      # how often to prove the link is alive
MAIN_PLATFORM_HEARTBEAT_STALE_AFTER = 180  # no successful beat for this long -> offline

# --- Retry / backoff ---
# Exponential with a ceiling. A queued event is never dropped for age; it is
# retried until it succeeds or a person cancels it.
SYNC_RETRY_BASE_SECONDS = 5
SYNC_RETRY_MAX_SECONDS = 900
SYNC_MAX_ATTEMPTS = 0           # 0 = never give up (queue, don't discard)
SYNC_BATCH_SIZE = 25            # events drained per sync pass
SYNC_INTERVAL_SECONDS = 30      # how often the background sync runs

# --- What is worth sending ---
# The whole point of v0.5 is to send fewer, better-evidenced discoveries. These
# thresholds are the gate; every one of them is configurable because the right
# setting depends on how much the platform wants to see.
SEND_MIN_TRIAGE_SCORE = 0.35          # below this a candidate stays local
SEND_MIN_EVIDENCE_CATEGORIES = 2      # independent categories, not indicator count
SEND_MIN_PRIORITY = 0.30              # candidate_priority score floor
SEND_HIGH_PRIORITY_THRESHOLD = 0.62   # at or above -> site.high_priority
SEND_UNTRIAGED_DISCOVERIES = False    # emit site.discovered before triage?
SEND_RELATIONSHIPS_MIN_STRENGTH = 0.45
SEND_WALLET_OBSERVATIONS = True
SEND_INFRASTRUCTURE_OBSERVATIONS = True
# Infrastructure shared this widely is a hosting fact, not a discovery. Sending
# it would bury the platform in noise that means nothing.
SEND_INFRASTRUCTURE_MAX_SITE_COUNT = 25

# --- Division of labour with Site Investigator ---
# "handoff": triage locally, then ask the platform to run deep investigation.
# "local":   run deep analysis here (v0.4 behaviour).
# "auto":    hand off when the platform is reachable, fall back to local when
#            it is not — so Site Finder stays independently usable.
DEEP_ANALYSIS_MODE = os.environ.get("DEEP_ANALYSIS_MODE", "auto")

# --- Indicator budget protection ---
# An indicator seen on more sites than this stops generating pivots at all: it
# is describing the hosting market rather than any particular operation, and
# every lead it produces spends budget for nothing.
INDICATOR_NOISE_SITE_COUNT = 40
# And one measured by its own results: an indicator whose leads have produced
# this many candidates with nothing surviving triage is retired from pivoting.
INDICATOR_NOISE_MIN_CANDIDATES = 30
INDICATOR_NOISE_MAX_SURVIVAL = 0.02


# ============================================================
# v0.6: Production Integration & Discovery Quality
# ============================================================
# --- Downstream feedback learning ---
# Outcome signals returned after Site Investigator examines one of our
# candidates. These are NEUTRAL observations about what was found, never
# verdicts about the site, and they are used only to judge whether a discovery
# technique is producing leads worth someone's time.
FEEDBACK_MIN_SAMPLES = 8          # below this, usefulness is provisional only
FEEDBACK_PRIOR_STRENGTH = 6.0     # shrinkage toward neutral, as with techniques
FEEDBACK_NEUTRAL_SCORE = 0.5

# What counts as a useful downstream outcome. Weighted by how much each signal
# tells us that our *discovery* was worth making — a deposit route found is the
# strongest confirmation that the candidate was worth an investigator's time.
FEEDBACK_SIGNAL_WEIGHTS = {
    "deposit_pages": 0.35,
    "wallets": 0.30,
    "relationships": 0.20,
    "infrastructure": 0.15,
}

# --- Dynamic budget allocation ---
# How far usefulness may move a technique's share of the discovery budget.
# Bounded on both sides: a runaway winner starves exploration, and a zeroed
# loser can never earn its way back.
BUDGET_MIN_MULTIPLIER = 0.35
BUDGET_MAX_MULTIPLIER = 2.0
BUDGET_EXPLORATION_FLOOR = 0.10   # share always reserved for unproven techniques

# --- Discovery path quality ---
PATH_DEPTH_PENALTY = 0.18         # per hop away from the seed
PATH_BREADTH_PENALTY_AT = 12      # indicator on this many sites starts costing
PATH_MIN_USEFUL_QUALITY = 0.30

# --- Cross-campaign deduplication ---
# A candidate reached independently by this many campaigns is corroborated
# rather than merely repeated.
DEDUP_CORROBORATION_CAMPAIGNS = 2

# --- API budgeting / rate limits ---
# Defaults per external service. Politeness first: these are well below what
# the services allow, because Site Finder is a guest on all of them.
API_DEFAULT_CALLS_PER_WINDOW = 30
API_DEFAULT_WINDOW_SECONDS = 60
API_DEFAULT_DAILY_LIMIT = 2000
API_BACKOFF_BASE_SECONDS = 30     # on a 429 with no Retry-After
API_BACKOFF_MAX_SECONDS = 3600
API_SERVICE_LIMITS = {
    # crt.sh is a free community service; be conservative.
    "crtsh": {"calls_per_window": 10, "window_seconds": 60, "daily_limit": 500},
    "dns": {"calls_per_window": 60, "window_seconds": 60, "daily_limit": 5000},
}


# ============================================================
# v0.7: Adaptive Discovery & Campaign Intelligence
# ============================================================
# --- Saturation detection ---
# Below this many candidates, a branch's rates are noise dressed as numbers.
SATURATION_MIN_SAMPLES = 15
SATURATION_DUPLICATE_RATE = 0.85    # this share already known -> duplicate saturation
SATURATION_NOVELTY_RATE = 0.10      # this share of indicators new -> low novelty
SATURATION_SURVIVAL_RATE = 0.05     # this share clearing triage -> low survival
SATURATION_DEAD_RATE = 0.80         # this share unreachable -> mostly dead
# Saturation is a gradient, so a branch is slowed before it is stopped.
SATURATION_SIGNALS_TO_THROTTLE = 2
SATURATION_SIGNALS_TO_STOP = 3

# --- Candidate novelty ---
# Kept deliberately separate from priority, confidence and evidence strength:
# a candidate can be very novel and not worth investigating, or utterly
# familiar and worth a second look because something changed.
NOVELTY_WEIGHTS = {
    "unseen_domain": 0.25,
    "new_infrastructure": 0.15,
    "new_cluster_membership": 0.15,
    "new_wallet": 0.20,
    # A deposit route appearing where there was none is the clearest sign a
    # candidate has changed since it was judged — it is the example the spec
    # gives for reconsidering a dismissal, and a wallet plus a deposit route
    # must clear NOVELTY_RECONSIDER_THRESHOLD on their own.
    "new_deposit_route": 0.15,
    "new_template": 0.10,
    "new_discovery_path": 0.10,
    "new_evidence_since_triage": 0.05,
}
NOVELTY_RECONSIDER_THRESHOLD = 0.35   # enough new evidence to revisit a decision

# --- Historical candidate memory ---
CANDIDATE_DECISIONS = ("promoted", "dismissed", "inconclusive", "unreachable", "deferred")
# Don't re-triage a dismissed candidate again within this window unless
# meaningful new evidence appears.
CANDIDATE_RECHECK_AFTER_DAYS = 30

# --- Provider intelligence ---
PROVIDER_FAILURE_RATE_BACKOFF = 0.5   # this failure rate -> stand down for a while
PROVIDER_MIN_CALLS_TO_JUDGE = 10

# ---------------------------------------------------------------------------
# v2 precision engine (app/v2/). On by default; FINDER_V2=0 restores the v0.7
# scan loop and v0.7 job handlers unchanged.
# ---------------------------------------------------------------------------
FINDER_V2 = os.environ.get("FINDER_V2", "1") != "0"
V2_INBOX_TARGET = int(os.environ.get("V2_INBOX_TARGET", "10"))          # standalone autopilot keeps this many ready
V2_AUTOPILOT_INTERVAL_SECONDS = int(os.environ.get("V2_AUTOPILOT_INTERVAL_SECONDS", "1800"))
# v5: standalone autopilot runs continuous-discovery cycles (rotation, novelty, change watch) instead of plain rounds.
V5_CONTINUOUS = os.environ.get("V5_CONTINUOUS", "1") not in ("0", "false", "no")
# v0.7 queued a non-routing observation batch for EVERY discovered domain,
# before triage. With v2 only inbox candidates go to the platform.
V1_SEND_DISCOVERY_OBSERVATIONS = os.environ.get("V1_SEND_DISCOVERY_OBSERVATIONS", "0" if FINDER_V2 else "1") == "1"
