# Deprecated Responsibilities

Functionality that remains in Site Finder for compatibility but belongs to
another module. None of it has been extended since v0.5, and none of it should
gain new features here.

| Component | Belongs to | Status |
|---|---|---|
| `app/investigate/navigator.py` — browser crawling, page evidence capture | **Site Investigator** | Deprecated. Runs only when `DEEP_ANALYSIS_MODE` resolves to `local`, i.e. when the platform is unreachable. Kept so a disconnected Site Finder still produces something. |
| `app/analysis/deep_analyzer.py` — full-browser profiling | **Site Investigator** | Deprecated, same condition. |
| `app/analysis/deposit_discovery.py` — deposit-page crawling | **Site Investigator** | Deprecated. Site Finder records a deposit route it happens to observe during triage; it should not go looking. |
| `app/form_filler.py`, signup attempts (`allow_signup`) | **Site Investigator** | Deprecated and off by default. Site Finder must not create accounts. |
| Deep wallet hunt (`deep_wallet_hunt`) | **CryptoWalletLogger** | Deprecated and off by default. Site Finder observes an address on a public page; it does not hunt. |
| `app/analysis/wallet_validator.py` — on-chain activity checks | **Wallet Investigator** | Retained for local triage only, in offline mode. No blockchain tracing. |
| `app/submission.py` — ScamBusters Google Form submission | (unchanged) | Not deprecated; this is reporting, not investigation. Still requires a human click. |

## The rule going forward

Site Finder may perform **lightweight public validation needed for triage** —
one unauthenticated HTTP GET, DNS, certificate reads. Anything requiring a
browser, credentials, authenticated access or chain data is a handoff, not a
feature.

## Removal plan

Each deprecated component can be deleted once the equivalent downstream
integration is confirmed working end to end — that is, once a
`site.investigated` event carrying the same evidence has been observed arriving
for a candidate Site Finder handed over. Until then they are the offline
fallback, and deleting them would make a disconnected Site Finder strictly
worse than v0.4.
