# Main Investigation Platform v4 — Autonomous Investigation Campaigns

v4 adds a **campaign** layer above the v3 AI investigator. A campaign answers one question: *given everything we currently know, what is the most valuable safe investigation work to do next?* It then does that work through the existing machinery, one step at a time, and stops when nothing left is worth doing.

The v3 architecture is kept intact. **AI proposes. The deterministic platform validates. Existing modules execute. Evidence proves.** v4 adds no new way to act on a site. Every investigation is still a v3 run, and every discovery request is still a typed Site Finder job.

## What a campaign is

A campaign starts from one seed site in the inbox. **Association** (`lib/campaign/graph.ts`) expands it along *observable* links only:

- the same Site Finder kit/template cluster;
- a shared non-generic indicator (hosting IP, name-server set, certificate name group, favicon, page template, chat service);
- a shared wallet, either observed publicly by Site Finder or observed by a module inside an investigation;
- a site-to-site relationship that a module recorded.

Expansion is breadth-first, capped at 3 hops per pass and 80 members. An indicator seen on more than 25 candidates is treated as generic hosting (a CDN, a big shared host) and links nothing.

**Relationship is never ownership.** Edge kinds name what was observed: `same_kit`, `shares_indicator`, `displays_wallet`, `observed_relationship`, `investigates`. Member reasons say "shares a wallet with X", and no text anywhere claims common control.

## The campaign intelligence graph

`campaign_edges` holds the graph, and `addEdge` is its **only writer**. It refuses to write an edge when any of these is true:

- the basis is anything other than `observed` or `deterministic`;
- the source table is not on the allowlist (`evidence`, `relationships`, `inbox_candidates`, `investigation_entities`, `campaign_members`, `jobs`);
- the cited source row does not exist;
- either end is a hypothesis.

No code path leads from model output to `addEdge`.

The roles, and any model, see a **structured summary**, not the raw graph (`graphSummary`). It lists:

- repeated indicators;
- recurring wallets;
- kits;
- convergence (site pairs linked by two or more independent facts);
- unexplored highly connected nodes;
- isolated claims (hypotheses whose cited edges no longer exist).

## Roles and orchestration (`lib/campaign/campaign.ts`, `roles.ts`)

A campaign tick is leased. It runs the roles in a fixed order, and each role writes a zod-validated typed artifact to `campaign_artifacts`. The Advanced view shows these as the role traces.

| Role | Deterministic behaviour | Optional model help (untrusted) |
| --- | --- | --- |
| **Analyst** | Evaluates finished work against observed data. It covers v3 run outcomes, pivot results re-verified against the inbox, and human Useful/Skip decisions. It then updates hypotheses, experience, costs and member states. | – |
| **Researcher** | Association, then the graph summary. Writes the `brief` artifact. | – |
| **Discovery Strategist** | Proposes one hypothesis per repeated indicator, kit or recurring wallet. | May propose hypotheses. They go through the **same** validator and must cite existing edges and the indicator those edges point at. Called only when the graph grew. |
| **Planner** | Takes the top-priority open opportunity. | May choose among near-ties (within 10%), by id, from the list it was shown. At most one call per tick, fast model class. |
| **Reviewer** | Asks six questions before any work runs (see below). | May only *add* a rejection, using a fixed code list. Off by default (`campaign_model_reviewer`). |
| **Executor** | `startRun` + `tick` of the v3 investigator, or a typed `FIND_RELATED_SITES` pivot job. | – |

The campaign runs entirely without a model. When `AI_PROVIDER` is unset, every role runs deterministically.

Model calls are budgeted per campaign (`max_model_calls`, `max_model_tokens`) and recorded as costs whether they succeed or fail. A reply that is malformed, off-list or over budget falls back to the deterministic choice.

## The priority engine (`lib/campaign/priority.ts`)

Every piece of safe work is a row in `opportunities` with a priority built from named factors, all visible under Advanced:

| Factor | Meaning |
| --- | --- |
| information gain | New wallets or shared nodes the work could reveal, plus a link to a confirmed site |
| evidence strength | Site Finder's public-signal score |
| novelty | Share of the site's nodes not already covered by work done or in progress |
| relationship | Degree in the campaign graph |
| **proven link** | Shares a wallet (1.0) or infrastructure (0.5) with a site whose investigation found evidence, or that a person marked Useful |
| duplicate probability | 0.9 when the site's kit or template group is already covered and it brings no new wallet or shared node |
| experience | The learned prior for this action in this context |
| accessibility | Lowered by an observed dead site or sign-in wall |
| cost | Expected module jobs or discovery load |
| budget | A work item the campaign cannot afford scores −1 |
| saturation | Two unproductive pivots of the same type in a row |

The whole queue is **re-scored every tick**. A finished investigation, a new module observation or a person's decision therefore changes the order of everything still pending. In the acceptance test, a pending site's priority rose from 0.53 to 0.74 after Site Investigator found that site's wallet on the seed.

Near-identical candidates collapse to one representative. Twenty template mirrors of the seed are suppressed with a reason, and one highly connected site outranks all of them.

## Hypotheses (`lib/campaign/hypotheses.ts`)

Each hypothesis records **observation → hypothesis → proposed test → result → confidence change**, in its own table with a full history. It is reasoning, not evidence, and it never becomes a graph edge.

**How confidence moves**

- Every hypothesis starts at 0.5.
- The test is a bounded passive Site Finder pivot on the indicator.
- The Analyst **does not trust the module's claim** of new sites. It counts only domains that now exist in the inbox *and* observably carry the indicator.
- Each verified site adds 0.25, capped at 3 sites; the hypothesis is supported at 0.75 or above.
- Zero verified sites subtract 0.35; the hypothesis is disproved at 0.2 or below.
- Later, a person skipping a site that the test produced lowers confidence by 0.2. A supported hypothesis can become inconclusive; "supported" is never permanent.

## Self-critique: the Reviewer (`lib/campaign/reviewer.ts`)

Before anything runs, the Reviewer answers six questions from the database, plus the budget check:

1. **evidence:** is there an observed Finder record, or do all the cited edges exist with provenance?
2. **attempted:** is there already a run or site investigation, a person's skip, or the same pivot done or queued?
3. **yield:** is the expected information gain at least 0.35, is the work not a duplicate, and is the path not saturated?
4. **cheaper:** would investigating a comparable site first answer as much, without the discovery load?
5. **wrong:** have two hypotheses of this type already been disproved, is confidence below 0.3, or was there an earlier barrier or dead site?
6. **repetitive:** have three pivots of this type already run, or is one still in flight?

The outcome depends on which checks fail:

- **Rejected:** a failed evidence, attempted, yield, wrong or repetitive-limit check stops the work. The rejection is recorded on the opportunity with the full checklist.
- **Deferred:** a failed "cheaper", in-flight or budget check keeps the work queued.
- **Re-opened:** work rejected *only* for low yield comes back when new information raises its yield.

## Autonomous queue and human control

**Discover → Prioritize → Investigate → Evaluate → Learn → Reprioritize.** The loop runs in these ways:

- `worker.scheduled` runs `tickDueCampaigns` every 5 minutes.
- A completed campaign job, new evidence in a member investigation, or a person's decision on a member wakes the campaign immediately. A decision also re-opens a COMPLETE campaign so it can re-evaluate.
- No one presses Next Site.

**Human control**

- **Start, Pause, Resume, Stop and Set budget** are available in the UI and the API.
- **Pause and Stop** also pause or stop the campaign's own v3 runs, and Stop cancels its queued pivots.
- **Raising a spent budget** resumes a campaign that stopped at BUDGET_EXHAUSTED.

**Checkpoints stay per investigation.**

- A v3 run that hits a login, CAPTCHA, MFA or email wall moves its site to `waiting_human` and frees the slot. Only that site pauses; the rest of the campaign keeps going.
- The campaign's "Needs you" list shows every open checkpoint and every report awaiting approval.
- Checkpoint instructions are the same fixed v3 templates: the person always acts themselves.

## Learning v2: experience (`lib/campaign/experience.ts`)

Each experience row records `context → action → expected → actual → cost → usefulness` with a basis and a source reference. The table below lists each risk the requirement named and the safeguard that addresses it.

| Risk | Safeguard |
| --- | --- |
| Self-reinforcing AI conclusions; feedback loops on the system's own predictions | `ai_self` rows carry **weight 0**. Hypothesis confidence moves only on observed or human results. |
| Poisoned or low-quality observations | Every human, observed or deterministic row must cite a real row (a decision, job, run or evidence item), or it is refused. |
| Human vs AI weight | human 1.0 > observed 0.8 > deterministic 0.6 > AI 0 |
| One strategy dominating permanently | Priors are shrunk toward 0.5 (3 pseudo-observations) and clamped to [0.15, 0.85]. Finder arms keep exploration floors and a ceiling. |
| Repeated exploration | Reviewer "attempted" and "repetitive" checks, saturation, and one in-flight pivot per type |
| Catastrophic forgetting | Decay with a 30-day half-life and a 25% floor |

Priors are hierarchical: global → context → campaign, each level shrunk toward the one above.

## Cost awareness

`campaign_costs` records every model call (tokens and provider), module job, discovery request and investigation. The campaign's `used_*` counters are **recomputed from this table**, never trusted.

Each v3 run a campaign starts gets model and module allowances carved from the campaign's *unreserved* remainder. Campaign budgets therefore bound everything its investigations do; the adversarial test caps a campaign at 6 model calls and it stays within them.

Advanced shows cost per useful investigation and useful evidence per action. Routine work uses no model at all, and model help is fast-class only.

## Site Finder v4: discovery strategy intelligence

These changes are in `integrations/site-finder-v07/app/v2/context.py`, with small hooks in `engine.py`, `platform_bridge.py`, `outcomes.py` and `netio.py`.

**Pivot jobs.** A `FIND_RELATED_SITES` job whose payload carries `pivot: {kind, value}` runs a bounded *pivot round*:

- It uses only the pivot arms: `known_keys` (local key matches, no network), `hosting_neighbors` (passive DNS for ip/ns, available only when `V4_PASSIVE_DNS_URL` is set), `cert_siblings`, `pattern_siblings` and `ct_learned`.
- It delivers only what those arms found.
- It reports `new_candidates`, the subset `shared` that actually carries the indicator, and `saturated`.
- A hosting-neighbour list longer than 40 is treated as shared hosting and ignored.

**Contextual learning.** Arm values use the posterior of useful unique candidates per unit of effort (`useful + 0.25·new_unique` against `skipped + 0.05·cost`).

- Values are shrunk from campaign → context → global.
- The context carries the pivot type and the platform's campaign state (hot, big).
- Allocation keeps a floor and a ceiling (`EXPLORE`, `FLOOR`, `CEIL`), with Thompson sampling for diversity.
- A person's Useful/Skip decisions and observed downstream outcomes credit the arm and context that found the candidate. Candidates carry `details.context`.

**Diminishing returns.**

- Each unproductive attempt on a path (campaign + indicator) halves its effort, both the probe budget and the delivery cap.
- After 3 unproductive attempts the path is saturated. A further request returns immediately, without touching the network.
- A productive attempt restores full effort.

**Compatibility.** Without a `pivot` payload, `FIND_RELATED_SITES` and every v2/v3 round behave exactly as before.

**Also fixed.** `inbox_block` now passes the candidate's indicator `keys` (and `context`) to the platform, which v3's `infrastructure.analyze` already expected.

## UI

- **`/campaigns`:** a list plus a one-field Start form.
- **`/campaigns/{id}` default view:** status, **what the AI is doing** and **why it chose that work** (the winning factors in plain language), headline numbers, the **Needs you** list, a progress bar (investigated / in progress / waiting / queued / set aside), budget meters, **useful findings** (sites with wallets, supported and ruled-out hypotheses) and a short **Next up** list.
- **Relationships tab:** a deterministic force layout. By default it shows only shared links, and set-aside mirrors are shown small and grey. Clicking a node lists its links with basis and provenance (`table:row`). Hypotheses are shown beside the graph, labelled "reasoning, not evidence".
- **Advanced tab:** economics and costs, the opportunity queue with every factor, role traces, hypothesis histories, strategy and experience statistics, provenance counts, and raw module jobs.
- **Sidebar:** a "Campaigns" entry.

Screenshots are in `docs/screenshots/v4_campaign_*.png`.

## Changes to existing code (all additive or bug fixes)

| File | Change |
| --- | --- |
| `drizzle/0010_campaigns_v4.sql` (+ journal) | New tables: `campaigns`, `campaign_members`, `campaign_edges`, `opportunities`, `hypotheses`, `campaign_artifacts`, `experience`, `campaign_costs`. Nothing existing is altered. |
| `lib/schema-ready.ts` | Checks the v4 tables. |
| `lib/jobs.ts` | Optional `dedupe_scope`, so two different global pivots do not collide. It also wakes a campaign when its job finishes. |
| `lib/agent/hooks.ts` | Wakes the campaign on investigation activity and on inbox decisions. |
| `lib/agent/state.ts` | **Bug fix.** A wallet with a fresh analysis from *another* investigation now counts as analysed. The executor already refused to re-run it ("no change"), so the v3 rules planner could loop forever. Campaigns, which share wallets across investigations, exposed this. |
| `worker.ts` | Adds `tickDueCampaigns(5)` to the scheduled handler. |
| `components/platform-shell.tsx` | Campaigns navigation entry; version label. |
| `db/schema.ts` | Drizzle definitions for the v4 tables. |

**Frozen modules** (CryptoWalletLogger, Wallet Investigator, Site Investigator, Form Submitter, Launcher) are byte-identical to v6.1.

## Safety

These are unchanged from v3 and enforced structurally:

- There is no credential handling.
- There is no capability that logs in, creates accounts, solves challenges, exploits anything or moves funds.
- Checkpoint text comes only from fixed templates.
- Pivot jobs carry the same `automation_policy` as every other job.
- Site Finder pivots are passive: local data, DNS, Certificate Transparency and passive-DNS metadata.

The AI cannot:

- write evidence;
- create or alter a graph edge or its provenance;
- turn a hypothesis into a fact;
- exceed a budget;
- select work that was not offered to it.

The adversarial test proves each of these.
