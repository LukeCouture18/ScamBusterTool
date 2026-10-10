"""
Site Finder v3: learning from downstream outcomes.

v2 already learned from your USEFUL/SKIP inbox decisions (adaptive.credit,
fed by platform_bridge.pull_decisions). v3 adds the richer signal the platform
now reports on GET /api/v1/finder/outcomes: what actually happened to a
candidate after it was surfaced — whether a module found meaningful evidence,
whether it found wallets, whether the investigation completed, whether the site
turned out dead, hit a login/CAPTCHA barrier, or was a duplicate.

These outcomes are credited to the same ledgers v2 uses (per strategy, per CT
arm, per signal, per operator cluster), so the next round's probe/query budget
shifts toward the strategies, terms and templates that lead to real evidence,
not merely to candidates that clear triage.

TWO RULES keep this honest:

  * Only outcomes whose `basis` is observed / deterministic / human are learned
    from. The platform never emits an ai_inference basis, and if one ever
    appeared it would be ignored here too — an AI conclusion never becomes a
    training label.

  * Rewards move budget; they never fabricate a delivery. The credit is applied
    as fractional useful/skipped counts, shrunk so a single downstream result
    cannot dominate, exactly like the decision ledger.

Each outcome is applied at most once (idempotent), tracked by the platform's
monotonic `seq` cursor plus a local guard.
"""
from __future__ import annotations

import logging

from app.v2 import adaptive, store

logger = logging.getLogger("scamhunter.v2.outcomes")

ALLOWED_BASIS = {"observed", "deterministic", "human"}

# (strategy_weight, signal_weight, cluster_delta) per outcome. Positive weights
# credit "useful"; negative credit "skipped" on the strategy/signal ledgers.
# Downstream evidence is the strongest positive signal a discovery route can get;
# a dead or duplicate site is a small cost, not evidence against the signals.
OUTCOME_WEIGHTS = {
    "wallet_evidence":         (1.0, 0.8, +1),   # led to a wallet: the best result
    "investigation_completed": (0.8, 0.5, +1),   # a full investigation ran to the end
    "meaningful_evidence":     (0.6, 0.4, +1),   # a module found real evidence
    "auth_barrier":            (-0.2, 0.0, 0),   # real, but needs a human; slightly less automation value
    "duplicate":               (-0.25, 0.0, 0),  # a real scam found twice: only a probe cost
    "dead_site":               (-0.5, 0.0, 0),   # wasted a probe; not the signals' fault
    "low_evidence":            (-0.5, -0.3, 0),  # surfaced, investigated, little to show: mild signal penalty
    # useful / skip already arrive through the decision ledger; ignored here to avoid double counting.
    "useful":                  (0.0, 0.0, 0),
    "skip":                    (0.0, 0.0, 0),
}


def _credit(candidate: dict, outcome: str):
    w_strategy, w_signal, cluster_delta = OUTCOME_WEIGHTS.get(outcome, (0.0, 0.0, 0))
    if w_strategy == 0 and w_signal == 0 and cluster_delta == 0:
        return
    strategies = candidate.get("strategies") or []
    arms = set(candidate.get("details", {}).get("arms", []))
    share = 1.0 / max(1, len(strategies))
    positive = w_strategy > 0
    for s in strategies:
        store.bump_strategy(s, **({"useful": share * w_strategy} if positive else {"skipped": share * -w_strategy}))
    for a in arms:
        store.bump_strategy(a, **({"useful": w_strategy} if positive else {"skipped": -w_strategy}))
    if w_signal:
        for sig in candidate.get("signals") or []:
            name = sig.get("name") if isinstance(sig, dict) else sig
            if name:
                store.bump_signal(name, w_signal > 0, weight=abs(w_signal))
    if cluster_delta and candidate.get("cluster_id"):
        store.bump_cluster_outcome(candidate["cluster_id"], cluster_delta > 0)


def apply_outcome(domain: str, outcome: str, basis: str) -> bool:
    """Credit one downstream outcome to the ledgers. Returns True if it was learned from."""
    if basis not in ALLOWED_BASIS:
        logger.debug("ignoring outcome %s for %s: basis %r is not learnable", outcome, domain, basis)
        return False
    candidate = store.get(domain)
    if not candidate:
        return False
    _credit(candidate, outcome)
    # v4: also credit the discovery context (pivot arm) that found this candidate.
    w_strategy = OUTCOME_WEIGHTS.get(outcome, (0.0, 0.0, 0))[0]
    if w_strategy:
        from app.v2 import context
        context.credit_candidate(candidate, w_strategy)
    # next gen: downstream evidence also credits the pivot route that found the site (bounded, observed basis only)
    try:
        from app.v2 import pursuit
        pursuit.on_outcome(domain, outcome)             # v3: delayed value for the hunt and route that found it
    except Exception:                                 # noqa: BLE001
        pass
    if w_strategy > 0:
        try:
            from app.v2.ng import memory
            row = memory.lineage(domain)
            if row:
                memory.bump_route(row["route"], useful=0.5 * w_strategy)
        except Exception:                             # noqa: BLE001
            pass
    return True


def pull_outcomes(client=None, limit: int = 200) -> dict:
    """
    Pull downstream outcomes from the platform and fold them into the ledgers.
    Idempotent via the platform's monotonic seq cursor and a local applied set.
    """
    from app.integration.v4.client import default_client
    client = client or default_client()
    if not getattr(client, "configured", False):
        return {"pulled": 0, "note": "No platform configured."}
    cursor = int(store.get_state("platform_outcome_cursor", 0) or 0)
    try:
        body = client.sdk.finder_outcomes(after=cursor, limit=limit) or {}
    except Exception as exc:                          # noqa: BLE001
        return {"pulled": 0, "error": str(exc)}
    applied = 0
    max_seq = cursor
    for row in body.get("outcomes") or []:
        seq = int(row.get("seq") or 0)
        max_seq = max(max_seq, seq)
        domain = row.get("domain")
        if not domain:
            continue
        # Local idempotency guard in addition to the cursor: a re-pull cannot double-credit.
        guard = f"outcome:{domain}:{row.get('outcome')}:{seq}"
        if store.get_state(guard):
            continue
        if apply_outcome(domain, str(row.get("outcome")), str(row.get("basis"))):
            applied += 1
            store.set_state(guard, "1")
    if max_seq > cursor:
        store.set_state("platform_outcome_cursor", max_seq)
    return {"pulled": applied, "cursor": max_seq}
