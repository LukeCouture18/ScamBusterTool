# Main Platform v3 + Site Finder v3 — upgrade notes

## What changes for you

* The investigation screen now opens with an **AI investigator** panel: a
  status ("AI investigating…", "Waiting for you", "Investigation complete"), a
  plain-language activity stream, and — when a site needs a login, CAPTCHA, MFA
  or email step — a card telling you exactly what to do yourself. Do the human
  step normally; the investigation resumes on its own from the new evidence.
  Everything technical is behind the **Advanced** expander, off by default.
* When you mark a candidate **USEFUL** in the inbox, the AI investigator starts
  automatically (configurable). It plans one approved action at a time, waits
  for modules and for you, and stops at a meaningful point.
* The inbox and all of v2 are unchanged.

## Upgrade steps

1. **Back up** the platform database and Site Finder's `data/scamhunter.db`.
2. Replace the platform folder with this one. Site Finder stays at
   `integrations/site-finder-v07`, so the Launcher starts it exactly as before.
3. Platform: `npm ci`, `npm run build`, `npm start`. `npm start` applies pending
   D1 migrations, and **`0009_ai_investigator_v3`** is additive (new tables
   only; no existing table or column changes). The startup schema gate refuses
   requests until `0009` is present, so an unmigrated database fails safely.
4. Site Finder: no manual migration. v3 uses the existing `v2_*` tables and adds
   a couple of `v2_state` cursors on first use.

## Configuration

The AI investigator is **off unless a model is configured or you accept the
deterministic planner**. With no model configured it runs the deterministic
`rules` planner (labelled as such, never as AI). To use a model, set:

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `anthropic` \| `openai` \| `google` \| `local` \| `rules` (default `rules`) |
| `AI_<PROVIDER>_API_KEY` | provider key (also accepts `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) |
| `AI_<PROVIDER>_MODEL_FAST` / `_STANDARD` / `_DEEP` | model per class; Anthropic has defaults, others must be set |
| `AI_<PROVIDER>_BASE_URL` | optional; for `local`, point at any OpenAI-compatible server |

Run settings live in `agent_settings` (edit via `GET`/`PATCH
/api/v1/agent/settings`): `enabled`, `auto_start_on_useful`, and the budgets
`max_actions` (12), `max_duration_seconds` (21600), `max_discovery_expansions`
(1), `max_module_calls` (8), `max_model_calls` (24), `max_model_tokens`
(80000), `max_retries` (3), `max_low_value_steps` (3).

## New endpoints (all additive)

* `GET /api/v1/investigations/{id}/agent` — the simple view (status, activity,
  human steps).
* `GET /api/v1/investigations/{id}/agent/advanced` — full audit: steps,
  rejections, budgets, model calls, inferences, knowledge classes, provenance.
* `POST /api/v1/investigations/{id}/agent/start` \| `/stop` — start/stop a run.
* `POST /api/v1/investigations/{id}/agent/conclusion` — record a human analyst
  conclusion (its own knowledge class; never evidence or AI inference).
* `POST /api/v1/investigations/{id}/checkpoints/{cid}` — mark a human step done,
  or cancel it.
* `GET|PATCH /api/v1/agent/settings` — the investigator's settings and budgets.
* `GET /api/v1/finder/outcomes` — module-authenticated downstream-outcome feed
  for Site Finder's v3 learning. Every row's `basis` is observed / deterministic
  / human; an AI inference never enters it.

## Safety boundaries (unchanged and extended)

The AI never sees or touches credentials, logins, CAPTCHAs, MFA, email
verification or funds, and never writes evidence or module databases. It acts
only through the typed capabilities above, each validated by deterministic
policy before anything happens. Model output is untrusted structured input:
schema-checked, citation-checked against real evidence, budget-checked and
de-duplicated. A model failure costs a retry and falls back to the deterministic
planner; it never corrupts investigation state. Restarting the platform never
loses or duplicates autonomous work (leases + idempotent, fingerprinted steps).

## Rolling back

* Site Finder: `FINDER_V2=0` restores v0.7; the v3 outcome learning simply stops
  being fed. The `v2_*` tables are ignored by v0.7.
* Platform: restore the previous build. Migration `0009` only added tables, so a
  v2 build runs against a migrated database (its startup gate does not look for
  the v3 tables). Set `agent_settings.enabled=false` to turn the investigator
  off without rolling back.

## Not modified

CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter
are byte-identical to v6.1. The Launcher is not part of this bundle and was not
touched.
