"""
One discovery round, end to end.

    decisions in  ->  strategies  ->  intake  ->  probe (budgeted, best first)
                  ->  gate  ->  evidence  ->  enrich shortlisted  ->  cluster
                  ->  score  ->  deliver the few that clear the bar

The round is bounded by a request budget (HTTP fetches, DNS lookups, crt.sh
queries, RDAP lookups), and the budget is spent in the order the adaptive
allocator chooses, so a productive strategy gets more of it next time.

Everything a candidate went through is written to its `details` so the
advanced view can show the discovery path, the gate or evidence, each score
component and the budget it cost. None of it is shown by default.
"""
from __future__ import annotations

import logging
import random
import re
import time

from app.v2 import adaptive, classify, cluster, domains as dm, netio, ng, score as sc, selection, signals as sg, store, strategies as st

logger = logging.getLogger("scamhunter.v2.engine")

DEFAULTS = {
    "fetch_budget": 200,       # HTTP requests per round (page, bundle, favicon, http fallback)
    "dns_budget": 600,
    "crtsh_budget": 12,
    "rdap_budget": 60,
    "max_deliver": 20,         # never flood the inbox; the rest waits for the next round
    "threshold": sc.DELIVER_THRESHOLD,
    "enrich_at": 0.30,         # p at which a candidate earns RDAP + favicon lookups
    "brand_dns": 80,
    "pattern_dns": 60,
}
_SERVICE_RE = re.compile(r"(?:service|kefu|chat)\s*:\s*['\"](https?://[^'\"]+)", re.I)
_LIVECHAT_SRC = re.compile(r"src=['\"](https?://(?:embed\.tawk\.to|[a-z0-9.-]*meiqia[a-z0-9.-]*|[a-z0-9.-]*chatwoot[a-z0-9.-]*)/[^'\"]*)", re.I)


def configure_for_benchmark(nameserver_fn=None):
    """Lets the offline benchmark answer NS lookups; production uses dnspython if installed."""
    netio.set_nameserver_function(nameserver_fn)


# ---------------------------------------------------------------- decisions

def apply_decisions() -> int:
    """Folds every not-yet-applied USEFUL/SKIP decision into the ledgers."""
    applied = 0
    for d in store.unapplied_decisions():
        cand = store.get(d["domain"])
        if cand:
            useful = d["decision"] == "useful"
            if cand.get("decision") != d["decision"] or not cand.get("decided_at"):
                store.update(d["domain"], status="useful" if useful else "skipped", decision=d["decision"],
                             decision_reason=d.get("reason") or "", decided_at=d.get("decided_at") or time.time())
                cand = store.get(d["domain"])
            adaptive.credit(cand, useful, d.get("reason"))
            ng.after_decision(cand, useful, d.get("reason"))       # next gen: delayed route credit
            from app.v2 import active
            active.note_decision(d["domain"], useful)
            from app.v2 import context as v4context          # v4: contextual ledger (human basis)
            v4context.credit_candidate(cand, 1.0 if useful else -adaptive.skip_weights(d.get("reason"))[0])
            if not useful and cand.get("cluster_id") and adaptive.skip_weights(d.get("reason"))[2] >= 1.0:
                _suppress_cluster_siblings(cand)
        store.mark_applied(d["id"])
        applied += 1
    return applied


def _suppress_cluster_siblings(cand: dict):
    for m in store.cluster_members(cand["cluster_id"]):
        if m["domain"] != cand["domain"] and m["status"] in ("ready", "held"):
            store.update(m["domain"], status="suppressed",
                         details={**m["details"], "suppressed": f"sibling of {cand['domain']}, which you skipped"})


# ------------------------------------------------------------------ probing

def _page_text(snap) -> tuple:
    html = snap.html or ""
    text = netio.visible_text(html)
    return html, f"{text} {netio.attribute_text(html)}".strip(), netio.title_of(html)


def _bundle(snap, budget) -> str:
    srcs = [s for s in netio.script_srcs(snap.html) if not s.startswith(("http://", "https://", "//"))]
    if not srcs or not budget.take("http"):
        return ""
    from urllib.parse import urljoin
    data = netio.fetch_bytes(urljoin(snap.final_url or snap.requested_url, srcs[-1]), max_bytes=600_000)
    return (data or b"").decode("utf-8", errors="ignore")[:600_000]


def _keys(domain: str, html: str, signals: list, san_groups: list) -> list:
    keys = []
    for s in signals:
        if s.name == "deposit_address" and s.detail:
            keys.append(("wallet", s.detail))
    for m in _SERVICE_RE.finditer(html or ""):
        keys.append(("service", dm.registrable(m.group(1))))
    for m in _LIVECHAT_SRC.finditer(html or ""):
        path = m.group(1).split("//", 1)[-1]
        if "tawk.to/" in path:
            keys.append(("service", "tawk:" + path.split("/")[1]))
    tmpl = cluster.template_key(html)
    if tmpl:
        keys.append(("tmpl", tmpl))
    for group in san_groups:
        if len(group) >= 2:
            keys.append(("san", "|".join(sorted(group))[:400]))
    return keys


def probe(domain: str, info: dict, round_no: int, budget: netio.Budget, learned: dict) -> dict:
    """Probe one candidate. Returns a result dict and writes the candidate row."""
    details = {"strategies": sorted(info["strategies"]), "arms": sorted(info.get("arms", [])),
               "hosts": sorted(info.get("hosts", []))[:10], "round": round_no, "cost": {}}
    cost = details["cost"]

    def spend(kind):
        ok = budget.take(kind)
        if ok:
            cost[kind] = cost.get(kind, 0) + 1
        return ok

    if not spend("dns"):
        return {"status": "deferred"}
    ip = netio.resolve(domain) or (spend("dns") and netio.resolve("www." + domain))
    ns = netio.nameservers(domain) if spend("dns") else []
    details["ip"], details["ns"] = ip or "", ns
    if not ip:
        return _gated(domain, classify.Gate("dead", "Domain does not resolve.", recheck_rounds=5), details, round_no)
    parking_ip = store.infra_label("ip", ip).get("parking", 0)
    if parking_ip >= 3 and not store.infra_label("ip", ip).get("live", 0):
        return _gated(domain, classify.Gate("parked", f"Resolves to {ip}, which only serves parking pages.", recheck_rounds=5), details, round_no)

    if not spend("http"):
        return {"status": "deferred"}
    snap = netio.fetch(f"https://{domain}/")
    if snap.error in ("tls", "refused", "error") and spend("http"):
        alt = netio.fetch(f"http://{domain}/")
        if not alt.error:
            snap = alt
    html, text, title = _page_text(snap)
    details["fetch"] = {"url": snap.requested_url, "final_url": snap.final_url, "status": snap.status,
                        "error": snap.error, "redirects": snap.redirects[:5], "bytes": len(snap.html or ""),
                        "title": title[:160]}
    g = classify.gate(snap, domain, ns)
    if g.verdict:
        if g.verdict in ("parked", "for_sale"):
            store.bump_infra("ip", ip, "parking")
        if g.verdict == "informational" and g.leads:
            st.queue_mentions(g.leads, domain)
        ng.observe_gated(domain, g.verdict, html, round_no)    # v3: non-scam pages teach what is generic
        return _gated(domain, g, details, round_no)
    store.bump_infra("ip", ip, "live")

    effective = domain
    if g.effective_url:
        effective = dm.registrable(g.effective_url)
        details["redirected_to"] = effective
        if store.exists(effective) and effective != domain:
            store.add_strategy(effective, details["strategies"][0] if details["strategies"] else "redirect")
            return _gated(domain, classify.Gate("alias", f"Redirects to {effective}, already a candidate."), details, round_no)

    bundle = _bundle(snap, budget) if g.shell else ""
    if bundle:
        cost["http"] = cost.get("http", 0) + 1
        g2 = classify.gate(snap, domain, ns, extra_text=bundle[:20000])
        if g2.verdict == "not_crypto" and not re.search(r"recharge|withdraw|usdt|invit", bundle, re.I):
            return _gated(domain, g2, details, round_no)

    sigs = sg.extract(effective, html, text, title, bundle)
    first = sc.score(sigs, learned, adaptive.strategy_prior(details["strategies"] + details["arms"]))
    registered = None
    needs_enrichment = False
    if first["p"] >= DEFAULTS["enrich_at"] and first["core"]:
        if spend("rdap"):
            registered = netio.rdap_registered(effective)
        else:
            needs_enrichment = True          # never deliver on incomplete checks; enrich first next round
        if spend("http"):
            fav = netio.favicon_hash(f"https://{effective}/")
            if fav:
                details["favicon"] = fav
        if registered is not None:
            sigs = sg.extract(effective, html, text, title, bundle, registered_days=registered)
    details["needs_enrichment"] = needs_enrichment
    details["registered_days"] = None if registered is None else round(registered, 1)

    keys = _keys(effective, html, sigs, info.get("san_groups", []))
    # next gen: build files, page title and text similarity from the HTML already fetched
    _fp, ng_keys = ng.probe_keys(html, text, title, snap.final_url or f"https://{effective}/", effective, bundle)
    keys += ng_keys
    if details.get("favicon"):
        tmpl = next((v for k, v in keys if k == "tmpl"), "")
        keys.append(("favicon", details["favicon"]))
        if tmpl:
            keys.append(("favtmpl", f"{details['favicon']}|{tmpl}"))
    if ip:
        keys.append(("ip", ip))

    if effective != domain:
        store.insert_new(effective, snap.final_url, details["strategies"][0] if details["strategies"] else "redirect", info["prior"])
        _gated(domain, classify.Gate("alias", f"Redirects to {effective}."), details, round_no)
        domain = effective
    cid = cluster.assign(domain, keys) if first["core"] else None
    cprior, cverdict = adaptive.cluster_prior(cid)
    # v3: reached from a confirmed site through an operator- or build-level artifact (bounded; the
    # score caps it with the cluster prior, and delivery still needs the page's own core evidence)
    path_prior, path_why = ng.gate_prior(domain)
    if path_prior:
        details["pursuit_prior"] = {"z": path_prior, "why": path_why}
    final = sc.score(sigs, learned, adaptive.strategy_prior(details["strategies"] + details["arms"]), cprior + path_prior)
    details["score"] = final
    details["keys"] = [list(k) for k in keys if k[0] not in ("tmpl", "simhash")][:20]
    details["cluster_verdict"] = cverdict
    headline = sc.headline(sigs)
    store.update(domain, status="held", url=snap.final_url or f"https://{domain}/", gate=None, gate_reason=None,
                 p=final["p"], headline=headline, category=sc.category(sigs), signals=[s.as_dict() for s in sigs],
                 details=details, last_checked=time.time(), checks=(store.get(domain) or {}).get("checks", 0) + 1,
                 recheck_round=None)
    from app.v2 import intelligence
    intelligence.ingest(store.get(domain), recompute=False)
    ng.after_probe(domain, bool(final["core"] and final["p"] >= DEFAULTS["threshold"]), info["strategies"])
    ng.observe(domain, keys + ([("ip", ip)] if ip else []), bool(final["core"] and final["p"] >= DEFAULTS["threshold"]),
               bool(final["core"] and final["p"] >= 0.35), info["strategies"], round_no)
    if "investigation_pivot" in info["strategies"]:
        from app.v2 import active
        parent = active.note_probe(domain, bool(final["core"] and final["p"] >= DEFAULTS["threshold"]))
        context = active.context_for(domain)
        if context:
            store.update(domain, details={**store.get(domain)["details"], "investigation_context": context})
        if parent and final["core"]:
            active.plan(store.get(domain), parent_id=parent["id"], path_id=parent["path_id"],
                        depth=parent["depth"] + 1)
    return {"status": "held", "p": final["p"], "core": final["core"], "cluster": cid}


def _gated(domain: str, g: classify.Gate, details: dict, round_no: int) -> dict:
    details["gate"] = {"verdict": g.verdict, "reason": g.reason}
    recheck = round_no + g.recheck_rounds if g.recheck_rounds else None
    prev = store.get(domain) or {}
    # a crypto-looking name that keeps coming back dead is rechecked less often
    if recheck and prev.get("checks", 0) >= 2:
        recheck = round_no + g.recheck_rounds * 2
    if recheck and not (dm.shape_features(domain)["crypto_tokens"] or dm.shape_features(domain)["scheme_tokens"]
                        or "feeds" in details.get("strategies", []) or "mentions" in details.get("strategies", [])):
        recheck = None
    store.update(domain, status="gated", gate=g.verdict, gate_reason=g.reason, p=0, details=details,
                 last_checked=time.time(), checks=prev.get("checks", 0) + 1, recheck_round=recheck)
    from app.v2 import intelligence
    if prev.get("status") in (None, "new") and g.verdict in ("dead", "parked", "for_sale"):
        intelligence.mark_inactive(domain, "offline" if g.verdict == "dead" else "dormant")
    else:
        intelligence.ingest(store.get(domain), recompute=False)
    if "investigation_pivot" in details.get("strategies", []):
        from app.v2 import active
        active.note_probe(domain, False)
    ng.after_probe(domain, False, details.get("strategies", []))
    return {"status": "gated", "gate": g.verdict}


# ----------------------------------------------------------------- delivery

def _deliver(round_no: int, threshold: float, max_deliver: int, strategy_filter: set | None = None, veto=None) -> list:
    delivered = []
    eligible = []
    for cand in store.by_status("held", limit=500):
        if strategy_filter is not None and not (set(cand.get("strategies") or []) & strategy_filter):
            continue                                  # a pivot round delivers only what its own arms found
        score = cand["details"].get("score", {})
        if score.get("p_gate", cand["p"]) < threshold or not score.get("core") or cand["details"].get("needs_enrichment"):
            continue
        cid = cand.get("cluster_id")
        verdict = ""
        if cid:
            info = store.get_cluster(cid) or {}
            if info.get("skipped") and not info.get("useful"):
                verdict = "sibling of a site you skipped"
            else:
                shown = [m for m in store.cluster_members(cid) if m["domain"] != cand["domain"]
                         and m["status"] in ("ready", "presented", "useful", "skipped", "delivered")]
                if shown:
                    own = {kv for kt, kv in store.keys_for(cand["domain"]) if kt == "wallet"}
                    seen = set()
                    for m in shown:
                        seen |= {kv for kt, kv in store.keys_for(m["domain"]) if kt == "wallet"}
                    if not (own - seen) and not ng.distinct_deployment(cand["domain"], [m["domain"] for m in shown]):
                        verdict = f"mirror of {shown[0]['domain']} (same kit, no new wallet)"
        if not verdict and veto is not None:
            verdict = veto(cand) or ""                # v5 continuous discovery: e.g. an already-saturated ecosystem
        if not verdict:
            verdict = ng.veto(cand) or ""             # next gen: already held by Main/Hunter, or a near-duplicate
        if verdict:
            store.update(cand["domain"], status="suppressed", details={**cand["details"], "suppressed": verdict})
            continue
        novelty = ng.annotate(cand)
        if novelty:
            cand["details"] = {**cand["details"], "ng": novelty}
        eligible.append(cand)
    existing = store.by_status("ready", limit=100) + store.by_status("presented", limit=100)
    eligible, mirrors = ng.dedupe_batch(eligible)
    for cand, reason in mirrors:
        store.update(cand["domain"], status="suppressed", details={**cand["details"], "suppressed": reason})
    from app.v2 import intelligence
    for candidate in eligible + existing:
        candidate["_campaign"] = intelligence.campaign_for(candidate["domain"])
    ranked = selection.shortlist(eligible, max_deliver,
                                observations=lambda c: (store.sightings(c["domain"]), store.keys_for(c["domain"])),
                                existing=existing)
    selected_domains = {c["domain"] for c in ranked}
    for candidate in eligible:
        if candidate["domain"] in selected_domains:
            continue
        comparison = next((chosen for chosen in ranked if
                           (candidate.get("_campaign") and candidate["_campaign"] == chosen.get("_campaign")) or
                           (candidate.get("cluster_id") and candidate["cluster_id"] == chosen.get("cluster_id"))), None)
        if not comparison:
            continue
        own_wallets = {v for k, v in store.keys_for(candidate["domain"]) if k == "wallet"}
        shown_wallets = {v for k, v in store.keys_for(comparison["domain"]) if k == "wallet"}
        reason = (f"Review slot went to {comparison['domain']}, a stronger representative of "
                  f"{candidate.get('_campaign') or candidate.get('cluster_id')}. ")
        if own_wallets <= shown_wallets:
            reason += "No additional wallet was observed on this candidate. "
        reason += "It remains eligible for a later round if new evidence appears."
        store.update(candidate["domain"], details={**candidate["details"], "selection_deferred": reason})
    for cand in ranked:
        extras = []
        novelty = cand["details"].get("ng") or {}
        if novelty.get("reappearance_of"):
            extras.append(f"possible reappearance of {novelty['reappearance_of']}")
        elif (novelty.get("depth") or 0) >= 2:
            extras.append(f"{novelty['depth']} pivots from {novelty['chain'][-1]['parent']}")
        if cid:
            size = len(store.cluster_members(cid))
            if size > 1:
                extras.append(f"{size - 1} related site{'s' if size > 2 else ''}")
        headline = sc.headline([sg.Signal(**s) for s in cand["signals"]], extras)
        cand["details"] = {**cand["details"], "selection": cand["selection"]}
        cand["details"].pop("selection_deferred", None)
        store.update(cand["domain"], status="ready", delivered_at=time.time(), headline=headline,
                     details=cand["details"])
        delivered.append({**cand, "headline": headline})
        _mirror_to_v1(cand)
    return delivered


def _mirror_to_v1(cand: dict):
    """Keeps v1's sites/triage tables (and the dashboard that reads them) in step."""
    from app import db
    try:
        url = cand.get("url") or f"https://{cand['domain']}/"
        primary = (cand.get("strategies") or ["v2"])[0]
        site_id = db.add_site(url, f"v2:{primary}", discovery_confidence=cand["p"],
                              discovery_reason=cand.get("headline") or "", discovery_category=cand.get("category") or "")
        if not site_id:
            existing = db.domain_known(dm.host_of(url))
            if not existing:
                return
            with db.get_conn() as c:
                row = c.execute("SELECT id FROM sites WHERE domain=?", (db.domain_of(url),)).fetchone()
                site_id = row["id"] if row else None
        if site_id:
            db.record_triage(site_id, passed=True, triage_score=float(cand["p"]),
                             indicator_count=len(cand["details"].get("score", {}).get("core", [])),
                             indicators=[{"category": s["group"], "detail": s["phrase"], "weight": s["strength"]}
                                         for s in cand["signals"]],
                             reject_reason="", http_status=cand["details"].get("fetch", {}).get("status"))
            db.set_site_status(site_id, "queued")
            store.update(cand["domain"], site_id=site_id)
    except Exception as exc:                          # noqa: BLE001 - the mirror must never break a round
        logger.debug("v1 mirror failed for %s: %s", cand.get("domain"), exc)


# -------------------------------------------------------------------- round

@store.round_scope
def _run_round(fetch_budget: int | None = None, max_deliver: int | None = None, requested: int | None = None,
              seed_domains: list | None = None, progress=None, only_strategies: set | None = None,
              shares_override: dict | None = None, extra_leads: list | None = None,
              deliver_context: dict | None = None, seeds_only: bool = False,
              deliver_veto=None, deliver_any_strategy: bool = False,
              request_limits: dict | None = None) -> dict:
    """
    Runs one bounded discovery round. `requested` (from a platform DISCOVER_SITES
    job) caps delivery; `seed_domains` (from FIND_RELATED_SITES) are treated as
    confirmed-useful seeds for this round only.

    v4 pivot rounds (app.v2.context.run_pivot) additionally pass:
      only_strategies  lead generators allowed this round (the chosen pivot arms)
      shares_override  the contextual probe-budget shares for those arms
      extra_leads      leads found without network (e.g. local key matches)
      deliver_context  recorded on each delivered candidate so downstream
                       outcomes credit the context that found it
      seeds_only       use only `seed_domains` as seeds (not every useful site)
    v5 continuous cycles (app.v2.continuous) may also pass:
      deliver_veto          callable(candidate) -> reason | None; a reason suppresses it
      deliver_any_strategy  deliver any held candidate, not only those found by
                            `only_strategies` (a rotation cycle limits lead
                            generation, not what is ready to deliver)
    With none of these set the round behaves exactly as in v2/v3.
    """
    store.ensure()
    progress = progress or (lambda *a, **k: None)
    started = time.time()
    round_no = int(store.get_state("round", 0)) + 1
    store.set_state("round", round_no)
    rng = random.Random(f"{round_no}:{store.counts().get('useful', 0)}")
    limits = request_limits or {}
    budget = netio.Budget(http=limits.get("http", fetch_budget or DEFAULTS["fetch_budget"]),
                          dns=limits.get("dns", DEFAULTS["dns_budget"]),
                          crtsh=limits.get("crtsh", DEFAULTS["crtsh_budget"]),
                          rdap=limits.get("rdap", DEFAULTS["rdap_budget"]))
    netio.reset_round_diagnostics()
    # A bounded Main seed hunt reserves half its DNS/HTTP units for probing
    # evidence-backed candidates. Speculative name variants previously spent
    # the entire allowance before certificate siblings could be investigated.
    lead_budget = netio.BudgetWindow(budget, {k: max(0, budget.limits[k] // 2) for k in ("dns", "http")}) if request_limits and seed_domains else budget
    from app.v2 import active
    investigation_leads = active.execute(lead_budget, round_no) if only_strategies is None and not seeds_only else []
    ng_leads = ng.leads(lead_budget, round_no) if only_strategies is None else []
    decisions = apply_decisions()
    learned = adaptive.learned_signal_weights()

    seeds = [] if seeds_only else store.by_status("useful", limit=40, order="decided_at DESC")
    for d in seed_domains or []:
        reg = dm.registrable(d)
        if reg and all(s["domain"] != reg for s in seeds):
            seeds.insert(0, store.get(reg) or {"domain": reg, "strategies": [], "details": {}})
    ctx = st.Context(round_no, lead_budget, seeds, store.exists)

    # ---- generate leads (query budgets split by what can use them) ---------
    new_seed_cert = [s for s in seeds if s["domain"] not in set(store.get_state("cert_siblings_done", []))]
    new_stems = [x for x in st.learned_stems(seeds) if x not in set(store.get_state("ct_learned_done", []))]
    def allow(name):
        return only_strategies is None or name in only_strategies
    frontier_done = set(store.get_state("ct_frontier_done", []))
    new_frontier = [s for s in st.frontier_stems() if s not in frontier_done]
    eligible = {"ct_terms": DEFAULTS["crtsh_budget"], "cert_siblings": len(new_seed_cert),
                "ct_learned": len(new_stems), "ct_frontier": len(new_frontier)}
    from app.v2 import sources
    certificate_available = sources.capability_available()
    queries = adaptive.query_allocation(DEFAULTS["crtsh_budget"] if certificate_available else 0,
                                        {k: v for k, v in eligible.items() if allow(k)}, rng)
    cert_q, learned_q, terms_q = queries.get("cert_siblings", 0), queries.get("ct_learned", 0), queries.get("ct_terms", 0)
    frontier_q = queries.get("ct_frontier", 0)
    for name, q in queries.items():
        if q:
            store.bump_strategy(name, cost=q)
    term_weights = adaptive.arm_weights("ct_terms", st.CT_TERMS, rng,
                                        last_used=store.get_state("ct_terms_last_used", {}), round_no=round_no)
    leads = []
    leads += st.cert_siblings(ctx, cert_q) if allow("cert_siblings") else []
    leads += st.ct_learned(ctx, learned_q) if allow("ct_learned") else []
    leads += st.ct_frontier(ctx, frontier_q) if allow("ct_frontier") else []
    # Only a bounded share of otherwise-unused CT work moves to an independent
    # DNS arm when every configured certificate provider has an open circuit.
    pattern_budget = DEFAULTS["pattern_dns"] + (min(8, DEFAULTS["crtsh_budget"])
                                               if not certificate_available else 0)
    leads += st.pattern_siblings(ctx, pattern_budget) if allow("pattern_siblings") else []
    leads += st.ct_terms(ctx, terms_q, term_weights) if allow("ct_terms") else []
    leads += st.brand_typos(ctx, DEFAULTS["brand_dns"]) if allow("brand_typos") else []
    leads += st.feeds(ctx) if allow("feeds") else []
    leads += st.mentions(ctx) if allow("mentions") else []
    leads += investigation_leads
    leads += ng_leads
    for c in (store.due_rechecks(round_no, limit=30) if allow("recheck") else []):
        leads.append(st.Lead(c["domain"], "recheck", f"recheck after {c.get('gate')}", max(0.2, c.get("prior") or 0.2), "recheck"))
    leads += list(extra_leads or [])
    if only_strategies is not None:
        leads = [lead for lead in leads if lead.strategy in only_strategies]
    leads, farm_dropped = ng.filter_leads(leads)          # v3: memory of mirror farms applies to every arm
    ct_new_domains = set()

    # ---- intake: collapse to registrations, dedupe, remember provenance -----
    pool: dict[str, dict] = {}
    found = {}
    for lead in leads:
        domain = lead.domain
        if not domain or dm.is_allowlisted(domain):
            continue
        store.sight(domain, lead.host, lead.strategy, lead.detail, lead.prior, round_no)
        existing = store.get(domain)
        reprobe = lead.strategy == "recheck" or (lead.strategy == "investigation_pivot" and "revisit" in lead.detail) or (lead.strategy == "known_keys" and existing and existing["status"] == "gated")
        if existing and existing["status"] not in ("new",) and not reprobe:
            if lead.strategy not in existing["strategies"]:
                store.add_strategy(domain, lead.strategy)
            continue
        if not existing:
            if lead.strategy.startswith("ct_"):
                ct_new_domains.add(domain)
            store.insert_new(domain, f"https://{domain}/", lead.strategy, lead.prior)
            found[lead.strategy] = found.get(lead.strategy, 0) + 1
            store.bump_strategy(lead.strategy, found=1)
            if lead.arm and lead.arm != lead.strategy:
                store.bump_strategy(lead.arm, found=1)
        info = pool.setdefault(domain, {"strategies": set(), "arms": set(), "hosts": set(), "prior": 0.0, "san_groups": []})
        info["strategies"].add(lead.strategy)
        if lead.arm and lead.arm != lead.strategy:
            info["arms"].add(lead.arm)
        info["hosts"].add(lead.host)
        info["prior"] = max(info["prior"], lead.prior)
        if lead.san_group:
            info["san_groups"].append(lead.san_group)
    # carry over leads that were found but never probed in earlier rounds
    for c in store.by_status("new", limit=300, order="prior DESC"):
        if c["domain"] not in pool and (only_strategies is None or set(c["strategies"]) & only_strategies):
            pool[c["domain"]] = {"strategies": set(c["strategies"]), "arms": set(), "hosts": {c["domain"]},
                                 "prior": c.get("prior") or 0.1, "san_groups": []}

    # ---- finish checks on candidates that ran out of enrichment budget ------
    for cand in store.by_status("held", limit=200):
        if not cand["details"].get("needs_enrichment") or budget.left("rdap") <= 0 or budget.left("http") <= 5:
            continue
        pool.pop(cand["domain"], None)
        probe(cand["domain"], {"strategies": set(cand["strategies"]), "arms": set(cand["details"].get("arms", [])),
                               "hosts": {cand["domain"]}, "prior": cand.get("prior") or 0.3, "san_groups": []},
              round_no, budget, learned)

    # ---- probe in allocator order ------------------------------------------
    queues: dict[str, list] = {}
    for domain, info in pool.items():
        primary = max(info["strategies"], key=lambda s: adaptive.strategy_values(sample=False).get(s, 0)) \
            if len(info["strategies"]) > 1 else next(iter(info["strategies"]))
        # corroboration: reached by several independent strategies
        info["prior"] = min(0.95, info["prior"] + 0.08 * (len(info["strategies"]) - 1))
        queues.setdefault(primary, []).append((domain, info))
    for q in queues.values():
        q.sort(key=lambda x: -x[1]["prior"])
    shares = adaptive.allocation(list(queues), rng)
    if shares_override:
        raw = {k: max(adaptive.FLOOR, float(shares_override.get(k, 0.0))) for k in queues}
        total = sum(raw.values()) or 1.0
        shares = {k: round(v / total, 4) for k, v in raw.items()}
    credit = {k: 0.0 for k in queues}
    per_strategy = {k: {"share": shares.get(k, 0), "found": found.get(k, 0), "probed": 0, "gated": 0, "delivered": 0}
                    for k in set(queues) | set(found)}
    probed = gated = 0
    gates = {}
    while budget.left("http") > 0 and any(queues.values()):
        for k in credit:
            credit[k] += shares.get(k, 0)
        k = max((k for k in queues if queues[k]), key=lambda k: credit[k])
        credit[k] -= 1.0
        domain, info = queues[k].pop(0)
        result = probe(domain, info, round_no, budget, learned)
        if result["status"] == "deferred":
            break
        probed += 1
        per_strategy[k]["probed"] += 1
        for s in info["strategies"]:
            store.bump_strategy(s, probed=1)
        for a in info["arms"]:
            store.bump_strategy(a, probed=1)
        if result["status"] == "gated":
            gated += 1
            per_strategy[k]["gated"] += 1
            gates[result["gate"]] = gates.get(result["gate"], 0) + 1
            for s in list(info["strategies"]) + list(info["arms"]):
                store.bump_strategy(s, gated=1)
        progress("v2_probe", {"domain": domain, **result})

    # ---- derive relationships once for this round, after bounded probes -----
    from app.v2 import intelligence
    intelligence.rebuild()

    # ---- deliver ------------------------------------------------------------
    cap = max_deliver or DEFAULTS["max_deliver"]
    if requested:
        cap = min(cap, max(1, int(requested)))
    delivered = _deliver(round_no, DEFAULTS["threshold"], cap, strategy_filter=None if deliver_any_strategy else only_strategies, veto=deliver_veto)
    for candidate in delivered:
        intelligence.suggest(store.get(candidate["domain"]))
        active.plan(store.get(candidate["domain"]))
    if deliver_context:
        for cand in delivered:
            cand["details"] = {**cand["details"], **{k: v for k, v in deliver_context.items() if v not in (None, "")}}
            store.update(cand["domain"], details=cand["details"])
    for cand in delivered:
        for s in cand.get("strategies") or []:
            store.bump_strategy(s, delivered=1)
            if s in per_strategy:
                per_strategy[s]["delivered"] += 1
        for a in cand["details"].get("arms", []):
            store.bump_strategy(a, delivered=1)
    store.record_strategy_round(round_no, per_strategy)
    try:
        from app.v2 import platform_bridge
        platform_bridge.queue_deliveries(delivered)
    except Exception as exc:                          # noqa: BLE001 - never lose a round to the link
        logger.warning("could not queue v2 deliveries for the platform: %s", exc)
    summary = {"round": round_no, "decisions_applied": decisions, "leads": len(leads), "pool": len(pool),
               "probed": probed, "gated": gated, "gates": gates,
               "delivered": [{"domain": c["domain"], "p": c["p"], "headline": c["headline"]} for c in delivered],
               "allocation": shares, "strategies": per_strategy, "budget": budget.as_dict(),
               "seconds": round(time.time() - started, 2)}
    source_diagnostics = netio.round_diagnostics()
    ct_eligible = sum(max(0, values.get("probed", 0)-values.get("gated", 0))
                      for name, values in per_strategy.items() if name.startswith("ct_"))
    active.record_round_sources(source_diagnostics, new_domains=len(ct_new_domains), eligible=ct_eligible)
    summary["investigation"] = {"pivot_leads": len(investigation_leads),
                                 "sources": source_diagnostics,
                                 "source_status": active.source_report()["sources"][:5]}
    from app import db
    from app.v2 import operations
    cost = db.round_metrics()
    summary["cost"] = {k: round(v, 4) if isinstance(v, float) else v for k, v in cost.items()}
    store.set_state("last_round", summary)
    with store.conn() as conn:
        actions = conn.execute("SELECT COUNT(*) n FROM ig_frontier WHERE updated_at>=? AND "
                               "state IN ('COMPLETED','FAILED')", (started,)).fetchone()["n"]
    operations.record_round(summary, db.round_metrics(), actions=actions)
    progress("v2_round_finished", summary)
    return summary


def run_round(*args, **kwargs):
    try:
        return _run_round(*args, **kwargs)
    finally:
        netio.end_round_cache()
