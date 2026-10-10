# Main Platform v3 + Site Finder v3 — AI investigation & adaptive discovery

v3 adds an AI layer **above** the deterministic v2 platform, not in place of it.
Everything v2 did still runs and is unchanged; the AI can only act through
typed, permission-controlled capabilities, and every safety and provenance rule
lives outside the model. Nothing about the frozen modules changed.

## What was added

### The AI investigator (`lib/agent/`, `lib/ai/`)

An autonomous loop that, per investigation, understands the current state,
finds the missing evidence, chooses one approved next action, executes it
through the existing module job path, evaluates the result, and stops at a
meaningful point.

* **State digest** (`state.ts`) — the only thing the model sees, built by
  deterministic queries over the platform's own tables. Evidence IDs in the
  digest are the *only* IDs a plan may cite.
* **Capability registry** (`capabilities.ts`) — the exhaustive list of what the
  AI can do: `site.investigate`, `wallet.analyze`, `discovery.find_related`,
  `discovery.request`, `infrastructure.analyze`, `sites.compare`,
  `evidence.inspect`, `memory.search`, `report.request_draft`, `human.request`,
  `investigation.conclude`. Module capabilities go through the **same
  `enqueueJob` path** the v2 planner uses (dedupe, investigation budgets,
  capability routing, audit links), so an AI plan becomes exactly the kind of
  job v2 already creates. There is deliberately no capability that writes
  evidence, submits to a scam site, touches credentials, solves a CAPTCHA,
  moves funds, or runs code.
* **Policy** (`policy.ts`) — model output is untrusted structured input. A plan
  executes only if it parses the strict schema (unknown fields rejected),
  names an allowed capability, passes that capability's argument schema and
  preconditions, cites only evidence/entities that exist, contains no links or
  markup in free text, fits the run's budgets, and is not a repeat. Any failure
  rejects the whole plan; nothing partial runs. Safety is **structural** (the
  model can only pick a typed capability), not a keyword filter.
* **Model abstraction** (`ai/models.ts`) — a `ModelProvider` interface with
  adapters for Anthropic, OpenAI, Google and any OpenAI-compatible local
  server, plus a deterministic `rules` planner (`rules_planner.ts`) used when
  no model is configured, when the model's output is rejected past its retry
  budget, and as the evaluation baseline. Three model classes (fast / standard
  / deep) let each kind of work use an appropriately priced model; `deep` is
  used after a rejection or a low-value streak. A model failure costs at most a
  retry and never corrupts investigation state.
* **Human checkpoints** (`barriers.ts`, `checkpoints.ts`) — login, CAPTCHA,
  MFA and email-verification walls are detected deterministically from observed
  evidence. The run moves to `WAITING_FOR_HUMAN`, tells the person exactly what
  to do themselves (the platform never performs the step), and resumes
  automatically when new evidence past a watermark shows the step happened.
* **Budgets** (migration `0009`, enforced in `policy.ts`/`runner.ts`) — max
  actions, duration, discovery expansions, module calls, model calls, model
  tokens, retries, and a low-value-step cap. A run concludes `COMPLETE`,
  `INSUFFICIENT_EVIDENCE`, `WAITING_FOR_HUMAN` or `BUDGET_EXHAUSTED` rather than
  continuing indefinitely.
* **Knowledge classes** (`knowledge.ts`) — every item is classed `observed`,
  `deterministic`, `external_metadata`, `ai_inference` or `human`. AI
  inferences live only in `agent_inferences` with validated citations and are
  never evidence; analyst conclusions are their own class.
* **Cross-investigation memory** (`memory.ts`) — durable operational knowledge
  (sites, wallets, kits, infrastructure, strategy outcomes, your decisions),
  written only by deterministic code from observed/human/deterministic sources.

### Adaptive Site Finder v3 (`integrations/site-finder-v07/app/v2/outcomes.py`)

v2 learned from your USEFUL/SKIP decisions. v3 also learns from **downstream
outcomes** the platform now reports (`GET /api/v1/finder/outcomes`): meaningful
evidence, wallet evidence, completed investigation, dead site, auth barrier,
duplicate, low evidence. Each is credited to the same ledgers (strategy, CT
arm, signal, cluster) with outcome-specific weights, shifting the next round's
probe/query budget toward strategies that produce real evidence. Two rules keep
it honest: only `observed`/`deterministic`/`human` basis is ever learned from
(an AI conclusion never becomes a training label — enforced platform-side and
again in `outcomes.py`), and the allocator now reserves an exploration fraction
per strategy and caps any one strategy's share, so learning cannot collapse
onto a single strategy and a recovering strategy climbs back.

### UI (`components/agent-panel.tsx`)

The investigation view is centred on the current case: a status, a
plain-language activity stream, and the human step if one is needed. Every
technical detail — budgets, each plan and rejection, knowledge-class
breakdown, AI inferences labelled as opinion, model calls — is behind an
**Advanced** expander, off by default.

## Acceptance — proven, not asserted

`tests/v3-agent.mjs` drives the real route handlers, the real runner and the
real module job lifecycle with scripted and adversarial model providers:

| Proof point | How it is shown |
| --- | --- |
| AI plans → real typed module jobs | an accepted `site.investigate` step produces an `INVESTIGATE_SITE` job on the normal path, attributed to the agent step |
| returned evidence changes the plan | after a wallet is observed, the next accepted action is evidence-driven (analyse / relate), not a repeat |
| human checkpoint pauses & resumes | a login wall → `WAITING_FOR_HUMAN`; new evidence from the human step auto-resolves it and resumes |
| invalid AI actions rejected | unknown capability, bad args, wrong profile, links in free text — all rejected, only a valid action runs |
| hallucinated evidence blocked | a smuggled `new_evidence` field and citations to non-existent evidence are rejected; the evidence store is untouched |
| budgets stop runaway | a 1-action budget stops at `BUDGET_EXHAUSTED` with a wallet still unanalysed |
| loops/duplicates prevented | no accepted fingerprint repeats in a run |
| restart recovery | an expired lease is reclaimed and re-ticking never duplicates a step's job |
| provenance survives | the AI writes zero evidence rows; inferences stay `ai_inference`; knowledge classes intact |
| deterministic planner | the whole golden path runs to `COMPLETE` with no model configured |
| model failure safe | a throwing provider falls back to the rules planner without corrupting state |

Site Finder v3 learning is proven in `tests/test_v3_learning.py` (outcomes move
the right ledgers, AI-inference basis is ignored, exploration floor and
dominance cap hold, a collapsed strategy recovers).

All existing v2 / v6.1 suites still pass unchanged (see `V3_TEST_REPORT.md`).

## Not modified

CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter
are byte-identical to v6.1. The Launcher was not touched. Migration `0009` is
additive (new tables only). See `V3_MIGRATION_NOTES.md`.
