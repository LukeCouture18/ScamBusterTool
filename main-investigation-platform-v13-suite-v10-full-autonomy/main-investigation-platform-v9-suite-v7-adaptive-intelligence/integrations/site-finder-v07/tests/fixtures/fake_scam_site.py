"""
A minimal Flask app simulating a crypto scam site, used to integration-test
the real navigator against real HTTP behavior (redirects, dead links, a
CAPTCHA wall, a login page, wallet addresses, and a link loop) without
touching the network or any real website.

Design note: the main nav (shown on the homepage and content pages) only
links to legitimate-content pages (deposit/wallet/investment/login/signup).
The loop, dead-link, redirect, and access-control pages are real routes but
are NOT linked from the main nav — tests that need to exercise them point
`site["url"]` directly at that specific page, which keeps those tests
deterministic instead of depending on link-selection ranking to wander there
eventually (a real site's ranking-dependent crawl order shouldn't be baked
into what a test asserts).

Run standalone for manual poking: python3 fake_scam_site.py [port]
Used by tests/test_navigator_integration.py, which starts/stops it automatically.
"""
from flask import Flask, redirect

app = Flask(__name__)

MAIN_NAV = """<nav>
<a href="/">Home</a> | <a href="/deposit">Deposit</a> | <a href="/wallet">Wallet</a> |
<a href="/investment">Investment Plans</a> | <a href="/login">Login</a> |
<a href="/signup">Sign Up</a> |
<a href="https://external-other-site.invalid">External Site</a>
</nav>"""

# Kept separate from MAIN_NAV so tests exercising loop/dead-link/redirect/access-control
# behavior can target those specific pages deterministically (see module docstring).
NAV = MAIN_NAV


@app.route("/")
def home():
    return f"""<html><head><title>CryptoGrow Investments</title></head><body>
    {NAV}
    <h1>Welcome to CryptoGrow</h1>
    <p>Guaranteed daily returns on your investment. Join thousands of happy investors!</p>
    </body></html>"""


@app.route("/deposit")
def deposit():
    return f"""<html><head><title>Deposit Funds</title></head><body>
    {NAV}
    <h1>Deposit Address</h1>
    <p>Send USDT (ERC20) to the following deposit address:</p>
    <p>Deposit Address: 0x71C7656EC7ab88b098defB751B7401B5f6d8976a</p>
    <p>Network: ERC20</p>
    </body></html>"""


@app.route("/wallet")
def wallet():
    return f"""<html><head><title>My Wallet</title></head><body>
    {NAV}
    <h1>Wallet Balance</h1>
    <p>Your TRON wallet address for USDT-TRC20 deposits:</p>
    <p>Wallet Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
    </body></html>"""


@app.route("/investment")
def investment():
    return f"""<html><head><title>Investment Plans</title></head><body>
    {NAV}
    <h1>Investment Plans</h1>
    <p>Choose a plan: Bronze (5% daily), Silver (8% daily), Gold (12% daily).</p>
    </body></html>"""


@app.route("/login")
def login():
    return f"""<html><head><title>Login</title></head><body>
    {NAV}
    <h1>Login to Your Account</h1>
    <form><input type="email" placeholder="Email"><input type="password" placeholder="Password">
    <button type="submit">Log In</button></form>
    </body></html>"""


@app.route("/signup")
def signup():
    return f"""<html><head><title>Sign Up</title></head><body>
    {NAV}
    <h1>Create an Account</h1>
    <form><input type="email" name="email" placeholder="Email">
    <input type="text" name="username" placeholder="Username">
    <input type="password" placeholder="Password">
    <button type="submit">Register</button></form>
    </body></html>"""


@app.route("/verify")
def verify():
    """Simulates a payment-requirement access-control wall (withdrawal gated by a fee).
    Deliberately has NO nav links — tests target this page directly and must see the
    investigation stop here, not wander off to unrelated content first."""
    return """<html><head><title>Unlock Withdrawal</title></head><body>
    <h1>Withdrawal Verification Required</h1>
    <p>To unlock withdrawal, you must pay an activation fee of 0.05 BTC.</p>
    </body></html>"""


@app.route("/loop-a")
def loop_a():
    """Deliberately has NO main-nav links — only the loop-b link — so a test that
    targets this page directly exercises ONLY the loop-avoidance behavior."""
    return """<html><head><title>Loop Page A</title></head><body>
    <p>This links back to loop B, which links back here — must not crawl forever.</p>
    <a href="/loop-b">Go to Loop B</a>
    </body></html>"""


@app.route("/loop-b")
def loop_b():
    return """<html><head><title>Loop Page B</title></head><body>
    <p>This links back to loop A.</p>
    <a href="/loop-a">Go to Loop A</a>
    </body></html>"""


@app.route("/old-deposit")
def old_deposit():
    return redirect("/deposit", code=301)


@app.route("/dead-link")
def dead_link_target():
    return "Not Found", 404


@app.route("/has-dead-link")
def has_dead_link():
    """An isolated page whose only link is to a 404 — for testing dead-link handling
    without the main nav's other links muddying which page 'caused' the 404 visit."""
    return """<html><head><title>Page With A Broken Link</title></head><body>
    <p>Here is a broken link:</p>
    <a href="/dead-link">Broken Link</a>
    </body></html>"""


@app.route("/deposit-tabs")
def deposit_tabs():
    """
    A deposit page whose additional wallet addresses are only fetched (via a
    separate JSON endpoint) after clicking a currency tab — simulates the
    common real-world pattern of a scam site loading BTC/ETH/USDT-TRC20
    addresses on demand rather than shipping them all in the initial HTML.
    This matters for testing: wallet extraction scans both visible text AND
    raw HTML, so the non-default addresses must not appear ANYWHERE in this
    page's initial HTML source (not even inside a <script> block as a JS
    string literal — that would still be found by a raw-HTML scan without any
    click happening) for the test to actually prove the tab-click behavior
    is what surfaces them, rather than the extractor finding them regardless.
    Deliberately has NO nav links so tests that target this page directly
    exercise ONLY the tab-clicking wallet-hunt behavior.
    """
    return """<html><head><title>Deposit Funds</title></head><body>
    <h1>Deposit Address</h1>
    <div class="tabs">
      <button class="tab" onclick="showTab('btc')">BTC</button>
      <button class="tab" onclick="showTab('eth')">ETH</button>
      <button class="tab" onclick="showTab('usdt-trc20')">USDT-TRC20</button>
    </div>
    <div id="tab-container">
      <p>Bitcoin Deposit Address: 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2</p>
    </div>
    <script>
      function showTab(id) {
        fetch('/deposit-tabs/address/' + id)
          .then(function(r) { return r.text(); })
          .then(function(text) {
            document.getElementById('tab-container').innerHTML = '<p>' + text + '</p>';
          });
      }
    </script>
    </body></html>"""


@app.route("/deposit-tabs/address/<tab_id>")
def deposit_tabs_address(tab_id):
    """
    Backing endpoint for the tab-fetch above. The ETH/USDT-TRC20 addresses
    live ONLY here, never in /deposit-tabs' own HTML, so they can only be
    discovered by actually clicking the tab (which triggers the fetch) —
    exactly the real-world case this feature targets.
    """
    addresses = {
        "btc": "Bitcoin Deposit Address: 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "eth": "Ethereum Deposit Address: 0x8f317a1cE888D398DccAB715e42D161C05fF770a",
        "usdt-trc20": "USDT-TRC20 Deposit Address: TXYZq9K8mZaCVzWvBEwXaK5b7fRZ8g5xAB",
    }
    return addresses.get(tab_id, "Unknown network"), 200, {"Content-Type": "text/plain"}


@app.route("/signup-clean")
def signup_clean():
    """A signup page whose form submits cleanly to /account-dashboard with NO
    CAPTCHA or verification step — simulates a site where signup genuinely
    succeeds, to test the post-signup wallet hunt continuation. Deliberately
    isolated (no main nav) so tests target it directly."""
    return """<html><head><title>Sign Up</title></head><body>
    <h1>Create an Account</h1>
    <form action="/account-dashboard" method="get">
      <input type="email" name="email" placeholder="Email">
      <input type="text" name="username" placeholder="Username">
      <input type="password" placeholder="Password">
      <button type="submit">Register</button>
    </form>
    </body></html>"""


@app.route("/account-dashboard")
def account_dashboard():
    """Lands here after a clean signup. Links to a deposit page that is ONLY
    reachable post-signup, simulating a logged-in-only deposit page — this is
    exactly the case the post-signup wallet hunt is meant to reach."""
    return """<html><head><title>My Account</title></head><body>
    <h1>Welcome to your account</h1>
    <p>Manage your investments below.</p>
    <a href="/member-deposit">Deposit Funds</a>
    </body></html>"""


@app.route("/member-deposit")
def member_deposit():
    """A deposit page only linked from the post-signup account dashboard."""
    return """<html><head><title>Member Deposit</title></head><body>
    <h1>Deposit Address</h1>
    <p>Send USDT (TRC20) to: TAbcdEFGhJK345LMNopQRSTuvwxYZabc9X</p>
    </body></html>"""


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    app.run(port=port)


# ---------------- Quality-pipeline test pages ----------------

@app.route("/weak-keyword-only")
def weak_keyword_only():
    """A site with ONLY repeated keywords and nothing else — exactly the kind of
    weak result the quality gate must reject. No wallet, no deposit flow, no
    guarantee language, normal TLD."""
    body = "We are an investment company. " * 60
    return f"""<html><head><title>Investment Co</title></head><body>
    <h1>About Our Company</h1><p>{body}</p></body></html>"""


@app.route("/strong-multi-indicator")
def strong_multi_indicator():
    """A site tripping many INDEPENDENT indicator categories — the kind the
    pipeline should promote to deep analysis."""
    return """<html><head><title>CryptoGrow VIP Investments</title>
    <meta name="description" content="Guaranteed daily crypto returns with instant withdrawals">
    </head><body>
    <nav><a href="/">Home</a> | <a href="/deposit-strong">Deposit</a></nav>
    <h1>CryptoGrow VIP</h1>
    <p>Guaranteed 5% daily returns on your investment! Risk-free.</p>
    <p>VIP Level 3 plan with referral bonus. Minimum deposit 100 USDT.</p>
    <p>Deposit Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
    <p>Support only via Telegram: https://t.me/cryptogrow_support</p>
    <p>Follow us at https://twitter.com/cryptogrow</p>
    <p>Limited time offer - act now! We are 100% safe and fully insured.</p>
    </body></html>"""


@app.route("/deposit-strong")
def deposit_strong():
    return """<html><head><title>Deposit Funds</title></head><body>
    <h1>Deposit</h1>
    <p>Send USDT (TRC20) to: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
    <p>Bitcoin deposits: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa</p>
    <p>Minimum deposit 100 USDT. Withdrawals processed daily.</p>
    </body></html>"""


# ---------------- v2 correlation test pages ----------------
# Two "sibling" sites sharing a wallet, Telegram handle and analytics ID —
# the classic fingerprint of one operator running a fleet.

_SIBLING_COMMON = """
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SHARED12345"></script>
<script>gtag('config','G-SHARED12345');</script>
<p>Support: <a href="https://t.me/fleet_support">@fleet_support</a></p>
<p>Email: admin@fleet-ops.biz</p>
"""

@app.route("/fleet-a")
def fleet_a():
    return f"""<html><head><title>AlphaGrow Invest</title>
    <meta name="description" content="Guaranteed daily returns"></head><body>
    <h1>AlphaGrow</h1>
    <p>Guaranteed 5% daily returns! VIP Level plans with referral bonus.</p>
    <p>Minimum deposit: 50 USDT. Limited time offer - act now!</p>
    <p>USDT-TRC20 Deposit Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
    {_SIBLING_COMMON}
    </body></html>"""


@app.route("/fleet-b")
def fleet_b():
    return f"""<html><head><title>BetaGrow Invest</title>
    <meta name="description" content="Guaranteed daily returns"></head><body>
    <h1>BetaGrow</h1>
    <p>Guaranteed 8% daily returns! VIP Level plans with referral bonus.</p>
    <p>Minimum deposit: 50 USDT. Limited time offer - act now!</p>
    <p>USDT-TRC20 Deposit Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
    <p>Bitcoin Deposit Address: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa</p>
    {_SIBLING_COMMON}
    </body></html>"""
