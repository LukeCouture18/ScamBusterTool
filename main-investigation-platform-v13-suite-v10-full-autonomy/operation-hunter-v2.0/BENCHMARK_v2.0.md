# Operation Hunter v2.0 — ground-truth benchmark against v1.0

## Method

`bench/` generates **procedural adversarial worlds** with known ground truth and serves them through the real public API formats Hunter's collectors parse (crt.sh incl. `%` pattern search, rdap.org, DNS, RIPEstat, HackerTarget, urlscan search/result/DOM, Blockscout). Both engines run unmodified against the same worlds; nothing is mocked inside Hunter.

Each world contains:

- the **target operation**: 3 deployment waves (days 5 / 40 / 80), a naming template, a private nameserver on some sites and Cloudflare on others, per-deployment config files, analytics ID + Telegram handle, a collection → splitter → treasury → exchange-deposit money pipeline, a reserve domain parked on its infrastructure, and a **future wave** launched 30 days after the session;
- a **sibling operation** — another customer of the *same kit vendor* (same kit files, same vendor fee wallet and WalletConnect ID, different operator settings); at difficulty ≥ 0.3 one sibling site carries a **planted copy** of the target's Telegram handle;
- an **unrelated operation** on the target's bulletproof IP, legitimate co-hosted sites, legitimate look-alike domains, and stale scans of moved hosting.

Grid: seeds 1–8 × difficulty 0.3 / 0.8 = **16 worlds per seed kind**, budget **90 lookups**, identical for both engines. Exploration is seeded, so runs are reproducible (`node --import tsx bench/run.ts --engines v1,v2 --kinds domain,shared,wallet --budget 90`; v1 is loaded from `V1_DIR`, default `../../hunter-v1-ref`). Raw results: `bench/results/final-v1.json`, `final-v2.json`.

Seed kinds:
- **domain** — a wave-2 site on the operation's private nameserver (the easier, common case);
- **shared** — a wave-2 site on Cloudflare (no private-infrastructure pivot from the seed: the realistic hard case);
- **wallet** — a collection wallet.

## Results (16 worlds each)

| Seed | Engine | Precision | Recall | F1 | False members / run | Planted site absorbed | Operator IDs found | Treasury | Exchange deposit | Reached 80 % recall | Median lookups to 80 % | Recall after 45 lookups | New wave detected | False "returns" |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| domain | v1.0 | 0.60 | 0.65 | 0.55 | 6.6 | 0 % | 0 % | 0 % | 0 % | 5/16 | 60 | 0.53 | 44 % | 6.6 |
| domain | **v2.0** | **1.00** | **0.78** | **0.86** | **0** | 0 % | **94 %** | **100 %** | **81 %** | **11/16** | **45** | **0.72** | **94 %** | **0** |
| shared | v1.0 | 0.95 | 0.21 | 0.27 | 0.75 | 0 % | 0 % | 0 % | 0 % | 2/16 | 52 | 0.19 | 9 % | 0.75 |
| shared | **v2.0** | **1.00** | **0.60** | **0.68** | **0** | 0 % | **69 %** | **88 %** | **88 %** | **9/16** | **45** | **0.51** | **69 %** | **0** |
| wallet | v1.0 | – | 0 | – | 0 | – | – | 100 % | 100 % | – | – | – | – | 0 |
| wallet | v2.0 | – | 0 | – | 0 | – | – | 100 % | 100 % | – | – | – | – | 0 |

"New wave detected" = share of the future wave's sites flagged after the world advances 30 days (standing hunts in v2, monitors in v1). "False returns" = non-operation sites flagged as returns.

What moved the numbers:
- **Precision 0.60 → 1.00**: probabilistic membership with indicator levels (operator / vendor / infrastructure / service / commodity), inconsistent-carrier detection for planted settings, an **anchoring rule** (a group of sites that only corroborate each other — another kit customer — cannot join), and population-scaled hosting weights.
- **Recall and speed**: value-of-information allocation per unit cost, branch saturation and revisits, hypothesis-driven naming/title searches, archived-DOM analysis, and provisional corroboration between probable sites when the seed itself shows no content.
- **Money**: the pipeline is followed from displayed wallets through operation wallets to exits, so treasury and deposit are found from a domain seed.
- **Returns**: standing hunts (private nameserver, naming pattern, per-deployment files, titles, wallets) verify new domains and judge them by operator-level evidence.

## Honest limits of this benchmark

- The worlds are synthetic. They encode the adversarial patterns we know about (shared kits, planted handles, bulletproof co-hosting, look-alikes, stale scans); real operations will have others.
- **Wallet seeds reach no sites in either engine**: the synthetic public sources, like the real ones, have no wallet → website reverse index. Hunter traces the money fully but needs a site, a Main Platform observation or an analyst to cross from money back to infrastructure.
- Some worlds are **not fully discoverable at any budget** (e.g. a Cloudflare-hosted seed whose siblings share no certificate, private nameserver, archived scan or reverse-searchable setting). v2 stops early on these by design (diminishing returns) instead of spending the budget on noise; 5 of the 16 shared-seed worlds (and 1 domain-seed world) end at recall 0.1 — the seed alone — for this reason; in the other 11 shared-seed worlds v2 averages recall 0.82.
- Recall is capped by what the world exposes publicly within 90 lookups; at budget 250 earlier runs showed v2 flattening rather than climbing, i.e. the ceiling is discoverability, not effort.
- Seconds per run (≈1.3–1.7 s for v2 vs 0.2–0.4 s for v1) are in-process with zero network latency; in live use pacing of public APIs dominates.
