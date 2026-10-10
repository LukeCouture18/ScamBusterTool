"""
Site Finder v2: the precision engine.

Pure-function tests for normalisation, gates, evidence and scoring, then
integration tests that run real discovery rounds against the benchmark's
simulated internet (no network), the inbox/learning loop, and the platform
bridge.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.v2 import classify, domains as dm, score as sc, signals as sg  # noqa: E402
from app.v2.netio import Snapshot, visible_text, attribute_text, title_of  # noqa: E402


def _scratch(prefix="finder-test-"):
    """A temporary directory removed when the test process exits (best effort on Windows)."""
    import atexit, shutil, tempfile
    path = tempfile.mkdtemp(prefix=prefix)
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path

TRON = "TD7zhCbgo8G4TZHzunf3CuYsg61ZLkD633"   # checksum-valid, synthetic


def _page(html, url="https://example.test/", status=200, final=None):
    return Snapshot(requested_url=url, final_url=final or url, status=status, html=html)


def _signals(domain, html, bundle="", registered=None):
    return sg.extract(domain, html, f"{visible_text(html)} {attribute_text(html)}", title_of(html), bundle, registered)


# ------------------------------------------------------------ normalisation

def test_registrable_collapses_hostnames_but_not_hosting_platform_customers():
    assert dm.registrable("https://mail.scam-site.vip/login") == "scam-site.vip"
    assert dm.registrable("cpanel.example.co.uk") == "example.co.uk"
    assert dm.registrable("evil.pages.dev") == "evil.pages.dev"
    assert dm.registrable("a.b.netlify.app") == "b.netlify.app"
    assert dm.is_infra_host("autodiscover.example.com")
    assert not dm.is_infra_host("example.com")


def test_brand_matching_is_token_aware_and_catches_typos():
    assert dm.brand_lookalike("metamsk.live") == "metamask"
    assert dm.brand_lookalike("binance-verify.top") == "binance"
    assert dm.brand_lookalike("ledger-live-verify.top") == "ledger"
    assert dm.brand_lookalike("okxx.top") == "okx"
    assert dm.brand_lookalike("easyledgeraccounting.com") == ""      # ordinary word inside a name
    assert dm.brand_lookalike("binance.com") == ""                    # the brand itself
    assert dm.brand_lookalike("coinbase.cloud") == ""


# -------------------------------------------------------------------- gates

def test_parked_page_with_crypto_ad_links_is_gated():
    html = ("<html><title>binance-bonus.xyz</title><h1>binance-bonus.xyz</h1><p>This domain may be for sale!</p>"
            "<h3>Related Searches</h3><ul><li>Crypto Investment</li><li>Deposit Bonus</li><li>Telegram Crypto Groups</li></ul>"
            "<script src='https://www.sedoparking.com/frmpark/x/park.js'></script>")
    g = classify.gate(_page(html), "binance-bonus.xyz")
    assert g.verdict in ("parked", "for_sale")


def test_parking_nameservers_gate_even_a_script_only_lander():
    g = classify.gate(_page("<div id=target></div><script src=/js/x.js></script>"), "x.top", ns=["ns1.bodis.com"])
    assert g.verdict == "parked"


def test_server_default_suspended_and_coming_soon_pages_are_gated():
    assert classify.gate(_page("<title>Welcome to nginx!</title><h1>Welcome to nginx!</h1>"), "a.vip").verdict == "placeholder"
    assert classify.gate(_page("<title>Account Suspended</title><p>This Account has been suspended.</p>"), "a.vip").verdict == "suspended"
    g = classify.gate(_page("<h2>Coming soon</h2><p>Crypto trading platform launching soon. Join our Telegram.</p>"), "a.vip")
    assert g.verdict == "coming_soon" and g.recheck_rounds > 0


def test_redirect_to_official_brand_is_gated_not_scored_as_impersonation():
    g = classify.gate(_page("<h1>Binance</h1>deposit withdraw VIP referral telegram", url="http://binnance.com/",
                            final="https://www.binance.com/"), "binnance.com")
    assert g.verdict == "redirect_legit"


def test_scam_review_article_is_informational_and_yields_leads():
    html = ("<title>Is novayield.vip a scam? Review</title><h1>novayield.vip review</h1><h3>Red flags</h3>"
            "<ul><li>guaranteed returns of 2.5% daily</li><li>Telegram support only</li></ul>"
            f"<p>Deposit address reported by users: {TRON}</p><p>Our verdict: avoid.</p>")
    g = classify.gate(_page(html), "scamwatch.org")
    assert g.verdict == "informational"
    assert "novayield.vip" in g.leads


def test_dead_and_http_errors_are_gated_with_recheck():
    assert classify.gate(Snapshot("https://x.vip/", error="dns"), "x.vip").verdict == "dead"
    g = classify.gate(_page("<h1>521</h1>", status=521), "x.vip")
    assert g.verdict == "dead" and g.recheck_rounds


def test_regulated_site_with_statutory_warnings_is_gated_legit():
    html = ("<h1>Buy Bitcoin</h1><p>Registered with the FCA as a cryptoasset firm (FRN 912345).</p>"
            "<p>Crypto is high risk; you may lose all your money.</p>")
    assert classify.gate(_page(html), "broker.co.uk").verdict == "legit"


def test_non_crypto_business_is_gated():
    html = "<h1>Global Steel Trading Co</h1><p>Import and export. Deposit of 30% required on orders. WhatsApp us.</p>"
    assert classify.gate(_page(html), "steeltrading.com").verdict == "not_crypto"


# ----------------------------------------------------------------- evidence

def test_hyip_page_has_core_evidence_and_clears_the_bar():
    html = ("<h1>Welcome to Nova Capital</h1><p>Earn 3.5% daily for 30 days. Principal return: yes.</p>"
            "<table><tr><td>Starter</td><td>$50 - $999</td></tr><tr><td>VIP</td><td>$5000 - $50000</td></tr></table>"
            f"<p>Referral commission 7% - 3% - 1%. Total Deposited: $1,204,221</p><div>Deposit Address (USDT-TRC20) <code>{TRON}</code></div>"
            "<p>Customer service on Telegram @novasupport</p>")
    sigs = _signals("novacapital.vip", html, registered=6)
    names = {s.name for s in sigs}
    assert {"fixed_daily_return", "deposit_address", "plan_tiers", "referral_ladder"} <= names
    result = sc.score(sigs)
    assert {"promise", "wallet"} <= set(result["core"]) and result["p"] > 0.95


def test_legit_exchange_vocabulary_is_not_core_evidence():
    html = ("<h1>Buy, trade and hold 350+ cryptocurrencies</h1><p>Deposit with bank transfer. Withdraw to any wallet. "
            "VIP program. Referral program: invite friends and earn up to 40% commission. Simple Earn: up to 8% APR.</p>"
            "<footer>Community: Telegram · X · Discord</footer>")
    result = sc.score(_signals("somebroker.com", html, registered=2000))
    assert not result["core"]
    assert result["p"] < 0.2


def test_wallet_in_donation_or_contract_context_is_not_a_deposit_address():
    blog = f"<p>If you enjoy this blog, donations are welcome: <code>{TRON}</code></p>"
    assert not any(s.name == "deposit_address" for s in _signals("blog.io", blog))


def test_seed_phrase_request_is_core_but_security_advice_is_not():
    phish = "<h1>Wallet Sync</h1><form><textarea placeholder='Enter your 12 or 24 word recovery phrase'></textarea><button>Validate</button></form>"
    assert "seed_phrase" in sc.score(_signals("walletsync.app", phish))["core"]
    advice = "<article><h1>Self custody</h1><p>Never share your recovery phrase with anyone.</p></article>"
    assert "seed_phrase" not in sc.score(_signals("guide.org", advice))["core"]


def test_withdrawal_fee_trap_is_core():
    html = "<h1>BitEx</h1><p>Withdrawals above 5,000 USDT require payment of the 20% income tax before release.</p>"
    assert "withdrawal_trap" in sc.score(_signals("bitex.top", html))["core"]


def test_login_gated_trading_app_is_recognised_from_its_bundle():
    shell = ("<html><head><title>Coinvexa</title></head><body><div id=app></div>"
             "<script src=/h5/static/js/chunk-vendors.123.js></script></body></html>")
    assert classify.gate(_page(shell), "coinvexa.com").shell
    bundle = "var i18n={'recharge':'','withdraw':'','invitationCode':'','secondsContract':'','realNameAuth':''}"
    result = sc.score(_signals("coinvexa.com", shell, bundle=bundle, registered=5))
    assert "app_kit" in result["core"] and result["p"] >= sc.DELIVER_THRESHOLD


def test_headline_is_short_and_human():
    html = f"<p>Earn 2% daily.</p><p>Deposit address: {TRON}</p>"
    line = sc.headline(_signals("x.vip", html, registered=3))
    assert line.startswith("Investment scheme") and line.count("·") <= 3 and len(line) < 140


# ---------------------------------------------------------- v1 contract fix

def test_v1_triage_scores_are_mapped_into_the_platform_confidence_range():
    from app.integration.v4 import translator as tr
    assert tr.unit_confidence(9.5) == round(9.5 / 15, 4)
    assert tr.unit_confidence(30) == 1.0
    assert tr.unit_confidence(0.82) == 0.82
    site = {"domain": "a.test", "url": "https://a.test", "added_at": 0}
    record = tr.site_record(site, triage={"triage_score": 11.0})
    assert 0 <= record["confidence"] <= 1 and 0 <= record["triage"]["confidence"] <= 1


# ------------------------------------------------ rounds on the simulated web

def _world_round(temp_db, rounds=2, split="dev", seed=11, decide=True):
    from benchmark.world import World
    from benchmark.simnet import SimNet, installed
    from benchmark import run as bench
    from app.v2 import engine, inbox, store
    world = World(seed=seed, split=split)
    net = SimNet(world)
    judge = bench.Judge(world)
    judged = []
    with installed(net):
        from app.collectors import public_feeds
        public_feeds.FEEDS_FILE = Path(_scratch()) / "feeds.txt"
        public_feeds.FEEDS_FILE.write_text(bench.FEED_URL + "\n", encoding="utf-8")
        engine.configure_for_benchmark(net.nameservers)
        for r in range(rounds):
            if r:
                world.advance()
            engine.run_round()
            while decide:
                item = inbox.next_candidate()
                if not item:
                    break
                verdict = judge.judge(item["domain"])
                judged.append(verdict)
                inbox.decide(item["id"], "useful" if verdict["useful"] else "skip")
    return world, judged, store


def test_a_round_delivers_few_high_precision_candidates(temp_db):
    world, judged, store = _world_round(temp_db, rounds=2)
    assert len(judged) >= 10
    precision = sum(j["useful"] for j in judged) / len(judged)
    assert precision >= 0.85, judged
    counts = store.counts()
    assert counts.get("gated", 0) > 5 * len(judged), "most probed domains are filtered before they reach you"


def test_decisions_feed_strategy_and_signal_ledgers(temp_db):
    world, judged, store = _world_round(temp_db, rounds=1)
    stats = store.strategy_stats()
    assert sum(s.get("useful", 0) for s in stats.values()) > 0
    assert store.signal_stats()
    assert all((s.get("probed", 0) >= s.get("delivered", 0)) for s in stats.values())


def test_skip_reasons_change_what_is_learned(temp_db):
    from app.v2 import inbox, store
    store.ensure()
    sig = [{"name": "fixed_daily_return", "group": "promise", "strength": 0.95, "phrase": "x"}]
    for d in ("dup-a.vip", "dup-b.vip"):
        store.insert_new(d, f"https://{d}/", "ct_terms", 0.3)
        store.update(d, status="ready", p=0.9, cluster_id="c:dup-a.vip", signals=sig, details={"score": {"core": ["promise"]}})
    store.upsert_cluster("c:dup-a.vip", "dup-a.vip", 2)
    inbox.decide("dup-a.vip", "skip", reason="duplicate")
    assert store.get("dup-b.vip")["status"] == "ready", "a duplicate skip does not hide the rest of the kit"
    assert "fixed_daily_return" not in store.signal_stats(), "a duplicate is not evidence against the signals"
    assert store.strategy_stats()["ct_terms"]["skipped"] == 0.25


def test_skipping_a_cluster_member_suppresses_its_waiting_siblings(temp_db):
    from app.v2 import inbox, store, engine
    store.ensure()
    for d in ("kit-a.vip", "kit-b.vip"):
        store.insert_new(d, f"https://{d}/", "ct_terms", 0.3)
        store.update(d, status="ready", p=0.9, cluster_id="c:kit-a.vip", signals=[], details={"score": {"core": ["promise"]}})
    store.upsert_cluster("c:kit-a.vip", "kit-a.vip", 2)
    inbox.decide("kit-a.vip", "skip", reason="not_a_scam")
    assert store.get("kit-b.vip")["status"] == "suppressed"
    assert store.get_cluster("c:kit-a.vip")["skipped"] == 1


def test_inbox_batch_is_a_valid_schema_3_promotion(temp_db):
    from app.integration.v4 import translator as tr
    from app.v2 import platform_bridge, store
    world, judged, _ = _world_round(temp_db, rounds=1, decide=False)
    ready = store.by_status("ready", limit=3)
    assert ready
    built = platform_bridge.build_inbox_batch(ready[0])
    records = built["records"]
    assert not tr.validate_batch(records)
    site = records["sites"][0]
    assert 0 <= site["confidence"] <= 1
    assert site["triage"]["outcome"] == "promoted" and site["triage"]["request_downstream"] is False
    assert site["triage"]["evidence_ids"] == [records["evidence"][0]["external_id"]]
    assert site["inbox"]["version"] == "2" and site["inbox"]["headline"]
    assert len(set(site["triage"]["indicator_categories"])) >= 2


def test_platform_decisions_are_pulled_and_applied_once(temp_db):
    from app.v2 import platform_bridge, store
    store.ensure()
    store.insert_new("pulled.vip", "https://pulled.vip/", "feeds", 0.3)
    store.update("pulled.vip", status="ready", p=0.9, signals=[{"name": "fixed_daily_return", "group": "promise", "strength": 0.95, "phrase": "x"}])

    class FakeSDK:
        calls = 0

        def inbox_decisions(self, after="", limit=100):
            FakeSDK.calls += 1
            if after:
                return {"decisions": [], "next_cursor": after}
            return {"decisions": [{"id": "d1", "candidate_id": "pulled.vip", "decision": "useful"}], "next_cursor": "1"}

    class FakeClient:
        configured = True
        sdk = FakeSDK()

    assert platform_bridge.pull_decisions(FakeClient())["pulled"] == 1
    assert platform_bridge.pull_decisions(FakeClient())["pulled"] == 0
    cand = store.get("pulled.vip")
    assert cand["status"] == "useful" and cand["decision"] == "useful"
    assert store.signal_stats()["fixed_daily_return"]["useful"] == 1


def test_discover_sites_job_runs_a_round_and_completes(temp_db):
    from benchmark.world import World
    from benchmark.simnet import SimNet, installed
    from app.integration.v4 import jobs as v4jobs
    from app.integration.v4.client import PlatformClient
    from app.integration.v4.reference_platform import ReferencePlatform, patched_sdk
    from app.v2 import engine
    platform = ReferencePlatform()
    world = World(seed=5, split="dev")
    net = SimNet(world)
    sdk, _transport = patched_sdk(platform, api_key="test-key")
    client = PlatformClient(base_url="http://platform.test", api_key="test-key", sdk=sdk)
    client.register()
    client.heartbeat()
    if True:
        platform.jobs["job-disc"] = {
            "id": "job-disc", "job_type": "DISCOVER_SITES", "status": "pending", "target_module": "site_finder",
            "investigation_id": None, "attempt_count": 0, "max_attempts": 3, "priority": 40, "created_at": 0,
            "dedupe_key": "disc", "approval_status": "not_required", "lease_expires_at": None,
            "payload": {"requested": 5, "budget": {"http": 60},
                        "automation_policy": {"financial_actions_allowed": False, "prohibited": ["captcha-bypass"]}}}
        with installed(net):
            engine.configure_for_benchmark(net.nameservers)
            result = v4jobs.claim_and_run_one(client)
    assert result["claimed"] and result["ran"], result
    assert platform.jobs["job-disc"]["status"] == "completed"
    assert platform.jobs["job-disc"]["result"]["delivered"] <= 5


# --------------------------------------------------------------- learning rules

def test_one_stray_skip_does_not_demote_a_class_of_real_scams(temp_db):
    from app.v2 import adaptive, store
    store.ensure()
    for _ in range(40):
        store.bump_signal("fixed_daily_return", True)
    for _ in range(6):
        store.bump_signal("trading_app_kit", True)
    store.bump_signal("trading_app_kit", False)          # a single mistaken click
    assert adaptive.learned_signal_weights().get("trading_app_kit", 0.0) == 0.0


def test_a_signal_you_keep_rejecting_loses_weight(temp_db):
    from app.v2 import adaptive, store
    store.ensure()
    for _ in range(40):
        store.bump_signal("fixed_daily_return", True)
    for _ in range(5):
        store.bump_signal("per_trade_profit", False)      # e.g. press releases repeating a scam's promise
    store.bump_signal("per_trade_profit", True)
    assert adaptive.learned_signal_weights()["per_trade_profit"] < -0.5


def test_a_noisy_strategy_gets_less_of_the_probe_budget(temp_db):
    from app.v2 import adaptive, store
    store.ensure()
    store.bump_strategy("feeds", probed=50, delivered=10, useful=9, skipped=1)
    store.bump_strategy("brand_typos", probed=50, delivered=10, skipped=10)
    values = adaptive.strategy_values(sample=False)
    assert values["feeds"] > 3 * values["brand_typos"]
    shares = adaptive.allocation(["feeds", "brand_typos"])
    assert shares["brand_typos"] >= adaptive.FLOOR - 1e-9, "a noisy strategy shrinks to the floor, it is not switched off"


def test_learning_can_demote_but_barely_promote():
    sigs = [sg.Signal("guaranteed_returns", "promise", 0.55, "guaranteed returns")]
    base = sc.score(sigs)
    boosted = sc.score(sigs, learned={"guaranteed_returns": 5.0}, strategy_prior=5.0)
    assert boosted["p_gate"] == base["p_gate"], "upward learning never changes the delivery decision"
    demoted = sc.score(sigs, learned={"guaranteed_returns": -5.0})
    assert demoted["p_gate"] < base["p_gate"]
