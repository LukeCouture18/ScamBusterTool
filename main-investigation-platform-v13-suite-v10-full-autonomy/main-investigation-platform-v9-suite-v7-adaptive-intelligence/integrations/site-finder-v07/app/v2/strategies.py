"""
Discovery strategies: independent, passive ways of finding candidate domains.

Each strategy returns Leads (a host, why it was found, and a prior guess of
how promising it is). Strategies never fetch pages themselves — probing is
the engine's job, so every strategy's output is judged by the same gates and
the same evidence rules, and its cost is metered by one budget.

    ct_terms          Certificate Transparency, scam-specific name fragments,
                      rotated so one noisy term can't eat the whole run
                      (v1 stopped after its first query every time)
    ct_learned        CT searches for name stems learned from sites you marked USEFUL
    ct_frontier       CT searches for fresh distinctive stems from newly discovered sites
    cert_siblings     other domains on the same certificates as USEFUL sites
    pattern_siblings  numbered / affixed / re-TLD'd variants of USEFUL names, DNS-checked
    brand_typos       brand look-alikes with scam affixes, rotated across brands
    feeds             configured public scam-report feeds (same feeds.txt as v1)
    mentions          domains named or linked by review / monitor / forum pages
    recheck           parked, placeholder and coming-soon crypto domains, re-probed
                      later (change detection: they are where new scams appear)
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from app.v2 import domains as dm
from app.v2 import netio, store

logger = logging.getLogger("scamhunter.v2.strategies")

CT_TERMS = ["usdt", "trc20", "invest", "profit", "earn", "yield", "mining", "arbitrage", "quant", "stake",
            "exchange", "trade", "wallet", "recover", "airdrop", "vip", "coin", "bit", "defi", "swap",
            "claim", "fx", "crypto", "finance", "capital", "h5"]
CT_MAX_CERT_AGE_DAYS = 30
GENERIC_STEMS = {"global", "pro", "app", "vip", "online", "plus", "club", "center", "hub", "the", "my", "get",
                 "www", "web", "h5", "api", "one", "max", "coin", "bit", "crypto", "trade", "invest", "exchange",
                 "mining", "wallet", "finance", "capital", "chain", "block", "swap", "earn"}
SCAM_TLDS = ["com", "net", "vip", "top", "xyz", "cc", "live", "pro", "io", "app", "co", "club", "shop", "icu", "cfd", "org"]
BRAND_AFFIXES = ["verify", "secure", "support", "wallet", "claim", "auth", "kyc", "unlock", "rewards", "login", "app",
                 "help", "airdrop", "sync", "validate", "connect", "restore"]
BRAND_TLDS = ["com", "net", "org", "xyz", "top", "live", "cc", "vip", "io", "app", "info", "pro"]
TYPO_BRANDS = ["binance", "coinbase", "kraken", "metamask", "trustwallet", "bybit", "okx", "kucoin", "bitget",
               "cryptocom", "ledger", "trezor", "phantom", "uniswap", "exodus"]


@dataclass
class Lead:
    host: str
    strategy: str
    detail: str
    prior: float
    arm: str = ""                 # finer-grained performance bucket, e.g. ct_terms:usdt
    san_group: tuple = ()         # registrable domains that shared the certificate

    @property
    def domain(self) -> str:
        return dm.registrable(self.host)


def name_prior(domain: str, base: float) -> float:
    f = dm.shape_features(domain)
    p = base
    if f["crypto_tokens"]:
        p += 0.12
    if f["scheme_tokens"]:
        p += 0.06
    if f["suspicious_tld"]:
        p += 0.06
    if f["brand"]:
        p += 0.08
    if f["length"] > 28 or f["hyphens"] > 3:
        p -= 0.05
    return round(max(0.01, min(0.95, p)), 3)


def _names_from_cert(entry: dict) -> list:
    names = []
    for raw in str(entry.get("name_value", "")).split("\n"):
        host = raw.strip().lower().lstrip("*.").strip(".")
        if host and " " not in host and "." in host and "@" not in host:
            names.append(host)
    return names


def _cert_leads(entries: list, strategy: str, arm: str, base: float, max_age: float = CT_MAX_CERT_AGE_DAYS,
                exclude: set | None = None, limit: int = 400) -> list:
    """Collapses certificate SANs to registrable domains; one lead per new registration."""
    out, seen = [], set(exclude or ())
    for entry in entries:
        age = netio.cert_age_days(entry)
        if max_age is not None and age is not None and age > max_age:
            continue
        regs = []
        for host in _names_from_cert(entry):
            reg = dm.registrable(host)
            if reg and reg not in regs:
                regs.append(reg)
        group = tuple(sorted(regs)) if 1 < len(regs) <= 12 else ()
        for reg in regs:
            if reg in seen or dm.is_allowlisted(reg):
                continue
            seen.add(reg)
            prior = name_prior(reg, base) + (0.05 if age is not None and age <= 7 else 0)
            out.append(Lead(reg, strategy, f"certificate {entry.get('id')} ({'%d' % age if age is not None else '?'}d old)",
                            round(min(0.95, prior), 3), arm or strategy, group))
            if len(out) >= limit:
                return out
    return out


class Context:
    """What strategies may consult: the round, the seeds, and the request budget."""

    def __init__(self, round_no: int, budget: netio.Budget, useful_seeds: list, known: callable):
        self.round_no = round_no
        self.budget = budget
        self.useful_seeds = useful_seeds          # list of candidate dicts marked USEFUL
        self.known = known                        # domain -> bool


# ------------------------------------------------------------------ strategies

def ct_terms(ctx: Context, queries: int, term_weights: dict) -> list:
    """Rotate CT terms across runs and cool down saturated queries persistently."""
    if queries <= 0:
        return []
    cursor = store.get_state("ct_terms_cursor", 0)
    used = store.get_state("ct_terms_last_used", {})
    yield_history = store.get_state("ct_terms_yield", {})
    # Cooldown applies even to high-scoring arms; otherwise the same top term
    # consumes half the CT requests every run regardless of new-domain yield.
    available = [t for t in CT_TERMS if ctx.round_no - used.get(t, -100) > 1]
    if not available:
        available = list(CT_TERMS)
    rotated = {t: (CT_TERMS.index(t) - cursor) % len(CT_TERMS) for t in available}
    def score(t):
        history = yield_history.get(t, {})
        attempts = history.get("queries", 0)
        novelty = (history.get("new", 0) + 1) / (history.get("seen", 0) + 2)
        # Keep unexplored terms competitive while rewarding observed new domains.
        return (term_weights.get(t, 0.5) * (0.4 + 0.6 * novelty)
                + 0.1 / (1 + attempts), -rotated[t])
    chosen = sorted(available, key=score, reverse=True)[:queries]
    store.set_state("ct_terms_cursor", (cursor + max(1, queries)) % len(CT_TERMS))
    for t in chosen:
        used[t] = ctx.round_no
    store.set_state("ct_terms_last_used", used)
    leads = []
    for term in chosen:
        if not ctx.budget.take("crtsh"):
            break
        entries = netio.crtsh(f"%{term}%")
        results = _cert_leads(entries, "ct_terms", f"ct_terms:{term}", 0.14)
        unique = {lead.domain for lead in results}
        fresh = sum(not ctx.known(domain) for domain in unique)
        prior = yield_history.get(term, {})
        yield_history[term] = {"queries": prior.get("queries", 0) + 1,
                               "seen": prior.get("seen", 0) + len(unique),
                               "new": prior.get("new", 0) + fresh}
        leads += results
    store.set_state("ct_terms_yield", yield_history)
    return leads


def learned_stems(seeds: list) -> list:
    stems = []
    for s in seeds:
        label = s["domain"].split(".")[0]
        base = re.sub(r"\d+$", "", label)
        for tok in [base] + [p for p in re.split(r"[-_]", base) if p]:
            if len(tok) >= 5 and tok not in GENERIC_STEMS and tok not in stems:
                stems.append(tok)
    return stems


def frontier_stems(limit: int = 80) -> list[str]:
    """Explore names beyond fixed keywords before a user has reviewed a site."""
    store.ensure()
    with store.conn() as c:
        rows = c.execute("SELECT domain FROM v2_candidates WHERE status IN ('held','ready','presented','useful') "
                         "ORDER BY first_seen DESC LIMIT ?", (limit,)).fetchall()
    return [s for s in learned_stems([dict(r) for r in rows])
            if 6 <= len(s) <= 22 and re.fullmatch(r"[a-z][a-z0-9-]*", s)]


def ct_frontier(ctx: Context, queries: int) -> list:
    """One-time searches of promising names, with persistent query history."""
    if queries <= 0:
        return []
    done = set(store.get_state("ct_frontier_done", []))
    leads = []
    for stem in frontier_stems():
        if queries <= 0:
            break
        if stem in done:
            continue
        if not ctx.budget.take("crtsh"):
            break
        queries -= 1
        done.add(stem)
        leads.extend(_cert_leads(netio.crtsh(f"%{stem}%"), "ct_frontier", f"ct_frontier:{stem}",
                                 0.25, max_age=120))
    store.set_state("ct_frontier_done", sorted(done)[-1000:])
    return leads


def ct_learned(ctx: Context, queries: int) -> list:
    if queries <= 0 or not ctx.useful_seeds:
        return []
    done = set(store.get_state("ct_learned_done", []))
    leads = []
    for stem in learned_stems(ctx.useful_seeds):
        if len(leads) > 300 or queries <= 0:
            break
        if stem in done:
            continue
        if not ctx.budget.take("crtsh"):
            break
        queries -= 1
        done.add(stem)
        leads += _cert_leads(netio.crtsh(f"%{stem}%"), "ct_learned", "ct_learned", 0.32, max_age=120)
    store.set_state("ct_learned_done", sorted(done)[-500:])
    return leads


def cert_siblings(ctx: Context, queries: int) -> list:
    if queries <= 0 or not ctx.useful_seeds:
        return []
    done = set(store.get_state("cert_siblings_done", []))
    leads = []
    for seed in ctx.useful_seeds:
        if queries <= 0:
            break
        if seed["domain"] in done:
            continue
        if not ctx.budget.take("crtsh"):
            break
        queries -= 1
        done.add(seed["domain"])
        entries = netio.crtsh(seed["domain"]) + []
        leads += _cert_leads(entries, "cert_siblings", "cert_siblings", 0.45, max_age=None,
                             exclude={seed["domain"]})
    store.set_state("cert_siblings_done", sorted(done)[-500:])
    return leads


def pattern_siblings(ctx: Context, dns_checks: int) -> list:
    if dns_checks <= 0 or not ctx.useful_seeds:
        return []
    done = set(store.get_state("pattern_done", []))
    leads = []
    for seed in ctx.useful_seeds:
        if seed["domain"] in done:
            continue
        done.add(seed["domain"])
        label, _, suffix = seed["domain"].partition(".")
        stem = re.sub(r"\d+$", "", label)
        variants = [f"{stem}{n}" for n in range(1, 6)] + [f"{stem}-{a}" for a in ("app", "pro", "vip", "global", "h5", "plus")] + \
                   [f"{stem}{a}" for a in ("x", "ex", "fx", "pro", "app")]
        names = [f"{v}.{suffix}" for v in variants] + [f"{stem}.{t}" for t in SCAM_TLDS if t != suffix]
        for name in names:
            if dns_checks <= 0 or not ctx.budget.take("dns"):
                break
            if ctx.known(name) or name == seed["domain"]:
                continue
            dns_checks -= 1
            if netio.resolve(name):
                leads.append(Lead(name, "pattern_siblings", f"name pattern of {seed['domain']}", 0.42, "pattern_siblings"))
    store.set_state("pattern_done", sorted(done)[-500:])
    return leads


def brand_typos(ctx: Context, dns_checks: int) -> list:
    if dns_checks <= 0:
        return []
    from app.discovery.similar_domains import generate_variants
    cursor = store.get_state("brand_cursor", {"brand": 0, "offset": 0})
    leads = []
    tried = 0
    while dns_checks > 0 and tried < len(TYPO_BRANDS):
        brand = TYPO_BRANDS[cursor["brand"] % len(TYPO_BRANDS)]
        names = [f"{brand}-{a}" for a in BRAND_AFFIXES] + [v for v in generate_variants(brand, max_variants=400)
                                                            if not v.endswith(tuple(BRAND_AFFIXES))]
        combos = [f"{n}.{t}" for n in names for t in BRAND_TLDS]
        start = cursor["offset"]
        chunk = combos[start:start + dns_checks]
        for name in chunk:
            if not ctx.budget.take("dns"):
                dns_checks = 0
                break
            dns_checks -= 1
            if ctx.known(name) or dm.is_allowlisted(name):
                continue
            if netio.resolve(name):
                leads.append(Lead(name, "brand_typos", f"look-alike of {brand}", name_prior(name, 0.2), "brand_typos"))
        cursor["offset"] = start + len(chunk)
        if cursor["offset"] >= len(combos):
            cursor = {"brand": cursor["brand"] + 1, "offset": 0}
            tried += 1
        else:
            break
    store.set_state("brand_cursor", cursor)
    return leads


def feeds(ctx: Context) -> list:
    from app.collectors.public_feeds import PublicFeedCollector
    leads = []
    try:
        for url, source in PublicFeedCollector().collect():
            host = dm.host_of(url)
            if host and not dm.is_allowlisted(host):
                leads.append(Lead(host, "feeds", source[:120], 0.3, "feeds"))
    except Exception as exc:                          # noqa: BLE001
        logger.warning("feed collection failed: %s", exc)
    return leads


def mentions(ctx: Context) -> list:
    queued = store.get_state("mention_queue", [])
    store.set_state("mention_queue", [])
    return [Lead(d, "mentions", f"named on {src}", 0.3, "mentions") for d, src in queued]


def queue_mentions(domains: list, source: str):
    if not domains:
        return
    queued = store.get_state("mention_queue", [])
    have = {d for d, _ in queued}
    queued += [(d, source) for d in domains if d not in have]
    store.set_state("mention_queue", queued[-300:])


REGISTRY = ["ct_terms", "ct_learned", "ct_frontier", "cert_siblings", "pattern_siblings", "brand_typos", "feeds", "mentions", "recheck"]
