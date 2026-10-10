# Investigation Intelligence release gate

## Scope and architecture

The existing Candidate Intelligence selector and five-slot review workflow remain in place. A versioned SQLite investigation graph records typed indicators, provenance-bearing domain observations and relationships, campaign hypotheses and membership, temporal snapshots/events, bounded suggested investigation actions, manual corrections, and campaign feedback. Existing v1/v2 observations are backfilled on first use; rollback can remove graph tables without deleting legacy records. The existing review page adds a bounded campaign view, evidence-backed graph exploration, timeline, and campaign actions. Main Platform paths and existing API routes are preserved.

Graph relationships require a sufficiently specific shared indicator or independent corroboration; shared hosting, IPs, nameservers, generic templates and discovery sources alone cannot create campaigns. High-degree indicators and large clusters are bounded. Campaign-aware slot selection builds on the existing ranker and explains deferrals without discarding candidates. Campaign feedback enters the existing bounded learning prior only after enough distinct reviews.

## Evidence and release decision

| Category | Result |
| --- | --- |
| VERIFIED | Existing SQLite migration/backfill, restart persistence, graph relationship provenance and correction, split/merge, weak-signal rejection, bounded suggestions, campaign feedback threshold, API compatibility and real-browser campaign controls have automated coverage. Main Platform launcher paths were not edited. |
| SIMULATED | Paired normal and stress rounds use identical candidate pools for the Candidate Intelligence RC and upgraded selector. Graph link precision and recall use hidden simulation kit labels. |
| LIVE-TESTED | Three bounded public-source rounds ran without credentials; all produced zero eligible domains. No useful live campaigns or pivots could be evaluated. |
| STILL UNVERIFIED | Production campaign accuracy, real-world useful-campaign lift, external pivot success and source allocation, real investigator handoff of a live campaign, long-running historical migration on a large operational database, and sustained production performance. |

The complete Site Finder pytest run passed **495/495** tests, including the existing unified dashboard browser test and the new campaign graph browser test, in 457.83 seconds. An initial Main Platform aggregate run exposed missing `tmp_path` injection in its standalone Site Finder runner; the fixture adapter was corrected without skipping the test. The complete `npm run test:all` rerun then passed **all 11 groups**, including Site Finder standalone **495 passed, 0 failed**, five-module startup and handoff contracts, and Wallet Investigator **31 passed, 0 failed**. Existing launcher-facing paths remain unchanged.

### Paired simulation (three seeds, five rounds each)

| Split | Selector | Useful@3 | Useful@5 | Precision@5 | Unique useful simulated kits | Duplicate cluster slots |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Normal | Prior RC | 45/45 | 74/75 | 98.67% | 70 | 0 |
| Normal | Graph upgrade | 45/45 | 74/75 | 98.67% | 70 | 0 |
| Stress | Prior RC | 45/45 | 75/75 | 100% | 72 | 0 |
| Stress | Graph upgrade | 45/45 | 75/75 | 100% | 72 | 0 |

The candidate selection benchmark **does not show improved review usefulness** over the Candidate Intelligence RC. Normal graph evaluation found 61 true relationships and zero false relationships against simulated kit labels; observed-kit pair recall was 72.62%. Stress found 34 true relationships and zero false relationships, with 47.89% observed-kit pair recall. Both selectors had stress discounted ranking gain 44.227, 4.373 evidence categories per selected slot, and 1.0 review step per useful selection. Unrelated shared-host and generic-template cases are covered by adversarial tests. Graph evidence is derived from actually recorded observations, so unavailable certificate, screenshot, ASN or other fields are not inferred.

### Performance and live limits

The normal paired run took 130.25 seconds for 15 graph-enabled rounds versus 91.78 seconds in a separate graph-disabled reference run (about 42% extra wall time on this simulator; different sequential runs can vary). Performance does **not** yet meet a demonstrated no-slowdown gate. Three live-source rounds took 7.32, 5.11, and 20.56 seconds and yielded no candidates, hence no measured live false-link rate or investigation steps per useful finding.

### Implemented boundaries

Investigation pivots are budgeted **suggestions over observed graph indicators**, not a newly validated automatic external certificate, wallet, DNS, or public-search expansion engine. The source report records local discovery and review contributions, but full cost, latency and failure attribution is not yet observed for every source. Contradictory observations are retained and an operator can reject an edge, but automatic contradiction weighting and probabilistic source independence remain incomplete. Campaign merge/split and relationship rejection are explicit operator actions. The graph browser limits initial neighbors and allows expansion; it does not attempt to render all domains. No invasive collection, credential attacks, or authentication bypass was added.

This package is an **evaluation release candidate**, not a production-verified investigation intelligence system. Retain the existing Candidate Intelligence RC for production decisions until representative live data validates relationships, campaign actions, useful investigation paths, and operational performance.
