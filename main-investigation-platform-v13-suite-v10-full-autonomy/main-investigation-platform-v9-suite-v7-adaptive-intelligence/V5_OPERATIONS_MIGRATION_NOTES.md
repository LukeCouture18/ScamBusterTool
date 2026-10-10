# Platform v5 · Operations — Migration and Rollback Notes

## Upgrade from v4

1. **Stop workers.** This includes the cron trigger and module workers. Back up D1 (`wrangler d1 export`) and Site Finder's `data/scamhunter.db`.
2. **Apply migrations.** `npm run build && npm start` (or `wrangler d1 migrations apply`) applies **`0011_operations_v5.sql`**.
   - The migration is **purely additive**: 26 new tables and indexes, plus seeded defaults in `ops_state` and `budget_limits`. No v4 table, column, index or row is modified.
   - `tests/v5-migration.test.mjs` proves this. It seeds a v4 database across 14 tables and applies 0011. Every v4 row is byte-identical afterwards and every v4 schema object is unchanged.
3. **Startup gate.** A v5 build refuses to start (`SCHEMA_UPGRADE_INCOMPLETE`) until 0011 is applied.
   - An interrupted migration rolls back in its transaction and leaves no partial v5 table (tested). Re-applying the migration is the recovery.
4. **Start workers again.** The cron trigger now runs `schedulerTick()`, which also steps due v4 campaigns.
5. **Site Finder.** No migration step. Its v5 tables (`v5_cycles`, `v5_source_state`, `v5_budget`, `v5_ecosystems`, `v5_watch`, `v5_changes`) are created on first use. All v2/v3/v4 learning tables are untouched.

### What carries over
- **Records.** Investigations, campaigns, members, edges, opportunities, hypotheses, evidence, entities, relationships, inbox decisions, Site Finder learning, v3 AI decisions and model calls, campaign costs and experience are all used as they are.
- **Global intelligence graph.** Built incrementally from existing rows on the first scheduler ticks (cursors in `ops_state`).
- **Temporal facets.** Start from each entity's next observation. History before v5 has no snapshots, so the first v5 observation is a "first" value, never a change.
- **Gaps.** Derived the next time an investigation has module activity, or when the Evidence Analyst rechecks open gaps.

### Defaults you may want to review (`ops_state`, `budget_limits`)
| Setting | Default | Meaning |
| --- | --- | --- |
| `scheduler_paused` | false | Pause all new work (running module work finishes) |
| `discovery_paused` / `discovery_min_priority` | false / 0 | Pause discovery, or only discovery below a priority |
| `auto_investigate` / `auto_investigate_min_score` | true / 0.5 | Investigate Site Finder candidates at or above this score without a click |
| `max_concurrent_work`, `module_limit:*` | 6; 3/3/2/2 | Concurrency |
| `exploration_share` | 0.1 | Share of starts given to low-history contexts |
| `starvation_boost_per_hour` / `_cap` | 0.02 / 0.25 | Waiting work gains priority, bounded |
| `revisit_cooldown_hours` | 24 | Minimum time between revisits of one site (very significant changes bypass it) |
| `disagreement_window_seconds` | 3600 | Different sources disagreeing within this window is a contradiction, not a change |
| `auto_form_campaigns` / `auto_merge_campaigns` | true / true | Automatic campaign formation / merge |
| `ai_discovery_ordering` / `ai_graph_groupings` | true / false | Optional model assistance (only with a configured provider) |
| global daily budgets | 400 module jobs, 60 discovery requests, 80 investigations, 300 model calls, 600k tokens, $5 | `POST /api/v1/ops/budgets` or the Operations UI |

**To keep v4 behaviour** (a person starts campaigns; nothing is investigated without a click), set `auto_investigate=false` and `auto_form_campaigns=false`. Leave the scheduler running, because it steps campaigns.

## Rollback to v4

v5 only adds tables, so a v4 build runs against a v5 database unchanged: v4 code never reads the new tables. Tested: after dropping the v5 tables, the schema equals the v4 schema exactly and every v4 row is intact.

1. Stop workers.
2. Deploy the v4 build (`main-investigation-platform-v4.zip`). Its `worker.ts` calls `tickDueCampaigns()` again.
3. **Optionally**, drop the v5 tables to return to the exact v4 schema, and remove the `0011` row from `d1_migrations`:
   ```sql
   DROP TABLE IF EXISTS intel_nodes; DROP TABLE IF EXISTS intel_edges; DROP TABLE IF EXISTS intel_reasoning_links;
   DROP TABLE IF EXISTS entity_facets; DROP TABLE IF EXISTS entity_snapshots; DROP TABLE IF EXISTS entity_changes;
   DROP TABLE IF EXISTS work_items; DROP TABLE IF EXISTS work_item_events; DROP TABLE IF EXISTS ops_state; DROP TABLE IF EXISTS scheduler_ticks;
   DROP TABLE IF EXISTS budget_limits; DROP TABLE IF EXISTS budget_ledger; DROP TABLE IF EXISTS evidence_gaps; DROP TABLE IF EXISTS confidence_records;
   DROP TABLE IF EXISTS contradictions; DROP TABLE IF EXISTS strategy_experiments; DROP TABLE IF EXISTS experiment_assignments;
   DROP TABLE IF EXISTS campaign_meta; DROP TABLE IF EXISTS campaign_lineage; DROP TABLE IF EXISTS simulations; DROP TABLE IF EXISTS model_invocations;
   DROP TABLE IF EXISTS ai_decisions; DROP TABLE IF EXISTS ops_artifacts; DROP TABLE IF EXISTS operator_commands; DROP TABLE IF EXISTS ops_notifications;
   DROP TABLE IF EXISTS health_checks;
   ```
   Keep a backup first: dropping loses v5 history (changes, gaps, lineage, decisions, replays).
4. **Rows v5 wrote into v4 tables stay valid v4 data** and need no action:
   - campaigns formed, merged or split automatically, with their members and edges;
   - `experience` rows from v5 work;
   - `inbox_candidates` with status `operations` (v4 treats it like any non-ready status).
5. **Site Finder** rolls back by setting `V5_CONTINUOUS=0`, which restores the plain v2 autopilot round. Its `v5_*` tables can stay or be dropped.

### Ingestion change to be aware of
`lib/ingestion.ts` no longer re-publishes a `site.triaged` event that an **earlier batch** already published for the same site and evidence. The watch re-delivery would otherwise fail with `EVENT_ID_CONFLICT`. A retry of the *same* batch behaves as before. The v6.1, joined and integration suites are green with this change.
