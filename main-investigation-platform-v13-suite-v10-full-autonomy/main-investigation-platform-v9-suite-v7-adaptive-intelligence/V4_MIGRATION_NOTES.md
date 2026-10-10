# Upgrading from v3 to v4

## Before you start

1. **Back up the database.** Local runs keep it in `MIP_PERSIST_TO` or the default persistence directory; remote runs use D1.
2. Stop the module workers.

## Upgrade the platform

`npm ci && npm run build && npm start` applies the migrations in order, through `drizzle/0010_campaigns_v4.sql`. For a remote deployment, apply the same ordered migrations with your controlled migration step.

- **What the migration changes.** It is purely additive, with eight new tables. It alters no existing table and rewrites no data.
- **If the migration has not run.** The startup schema gate refuses to serve until it has, with `SCHEMA_UPGRADE_INCOMPLETE`.

## Update Site Finder

Update Site Finder (`integrations/site-finder-v07`) in place.

- **New tables.** It creates its own tables on first use: `v4_context_stats`, `v4_paths` and `v4_pivot_log`.
- **Optional hosting pivots.** Set `V4_PASSIVE_DNS_URL` to enable the hosting-neighbour pivot arm. The endpoint must answer `GET {url}/{ip|ns}/{value}` with a JSON list of hostnames. Without it, that arm is simply unavailable.
- **Compatibility with v3.** `FIND_RELATED_SITES` jobs without a `pivot` payload behave exactly as in v3.

Restart the workers.

## What changes for you

- **Campaigns are opt-in.** The inbox and the v3 per-site investigator work exactly as before.
- **Starting a campaign.** Open **Campaigns** in the sidebar, enter a site that is already in your inbox, and press **Start campaign**.
- **What the campaign does.** It finds related sites through observable links, decides what is worth investigating, runs the v3 investigator on those sites, and asks Site Finder for bounded passive pivots.
- **When it stops.** It stops when nothing left is worth doing, or when a budget is reached.
- **When it needs you.** If it needs a person (a login, CAPTCHA, MFA or email step, or a report approval), the item appears under **Needs you**. Only that site waits; the rest of the campaign continues.
- **Sites a campaign is investigating.** They move out of the manual inbox queue, with status `campaign`, so you are not asked about them twice.
- **The scheduled Worker.** It now also ticks due campaigns (`tickDueCampaigns(5)`).

## Budgets (per campaign)

| Budget | Default |
| --- | --- |
| `max_investigations` | 20 |
| `max_parallel` | 3 |
| `max_discovery_requests` | 8 |
| `max_module_jobs` | 60 |
| `max_model_calls` | 40 |
| `max_model_tokens` | 120000 |
| `max_duration_seconds` | 86400 |

- **Setting budgets.** Set them at start (`POST /api/v1/campaigns` with `budgets`) or later (`PATCH /api/v1/campaigns/{id}/budget`, or the **Budget** button).
- **Resuming.** Raising a spent budget resumes a campaign that stopped at "Budget reached".
- **What the campaign budget covers.** Each v3 run a campaign starts is capped to its share of the campaign's remaining model and module budget.

## Settings (`PATCH /api/v1/agent/settings`)

| Setting | Default | Effect |
| --- | --- | --- |
| `campaign_model_strategist` | true | When a model provider is configured, lets a model propose extra hypotheses. They are validated exactly like deterministic ones. |
| `campaign_model_reviewer` | false | Lets a model *add* rejections before work runs. It can never approve anything. |

Model help needs `AI_PROVIDER`, as in v3. Without it, campaigns run fully deterministically.

Unset keys use the defaults above.

## Rollback

1. Stop the campaigns (**Stop** on each campaign, or `POST /api/v1/campaigns/{id}/control {"action":"stop"}`).
2. Stop the workers and deploy the v3 build.
3. The v3 code ignores the v4 tables. You can leave them, or restore the pre-upgrade backup.
4. Candidates left in inbox status `campaign` will not reappear in the v3 manual queue. To return them, run:

   ```sql
   UPDATE inbox_candidates SET status = 'ready'
     WHERE status = 'campaign' AND decision IS NULL;
   ```
