# Site Finder → Main Investigation Platform v4: Contract Gap Report

Module: `site_finder`  
Ingest schema: `1.1`  
Event schema: `1.0`  
Capabilities: site:discover, site:relate

Site Finder adopts the v4 contract exactly and defines no wire format of its own. Everything below is something it needs that v4 does not express, with the in-contract workaround it uses instead.

## Real gaps — information is lost

### `discovery-quality-telemetry-has-no-home`

**Site Finder needs:** To report which discovery sources, pivots and indicator combinations are producing useful candidates, so the platform could see sensor quality alongside its own view of the pipeline.

**v4 position:** No record type carries per-technique performance. `module_activity.metrics` is free-form but is keyed to one activity row rather than to techniques.

**Workaround used:** Aggregate funnel counts go in `module_activity.metrics`. Per-technique detail stays local to Site Finder and is visible in its own Discovery Performance view.

**What is lost:** The platform cannot see which discovery techniques are productive, so it cannot weigh a Site Finder candidate by the track record of the route that found it.

**Would need:** A module-metrics record type keyed by technique, or agreed metric names inside module_activity.

### `site-finder-cannot-express-negative-triage`

**Site Finder needs:** To tell the platform that a candidate was examined and rejected, so the same domain is not rediscovered and re-queued by another sensor later.

**v4 position:** Ingesting a site record publishes site.discovered, which routes to INVESTIGATE_SITE. There is no way to record a candidate as considered and dismissed without also asking for it to be investigated.

**Workaround used:** Rejected candidates are simply not sent. They stay in Site Finder's local database, which prevents rediscovery by this sensor but not by another.

**What is lost:** Negative results never reach the platform, so the knowledge that a domain was checked and found thin is not shared between modules.

**Would need:** A way to ingest a site observation without triggering investigation — a `routing: false` hint, or a dismissed classification the router respects.

## Cosmetic gaps — expressible, but not queryable

### `triage-outcome-has-no-event`

**Site Finder needs:** To report that a candidate was triaged against public information and what that produced, as a distinct signal from the discovery itself.

**v4 position:** The event type list in lib/events.ts is closed and contains no triage event. site.discovered is the only site-related event a discovery module produces.

**Workaround used:** Triage becomes the `confidence` on the `sites` record, with `classification` and a `triage` object carried in the record's passthrough fields. The platform preserves unknown fields on the source observation (lib/ingestion.ts baseRecord is .passthrough()), so nothing is lost in storage.

**What is lost:** The platform cannot route or filter on triage outcome directly — it sees one confidence number. A reviewer reading the observation sees the full detail.

**Would need:** A `site.triaged` event type, or a first-class triage field on site records.

### `campaign-progress-has-no-event`

**Site Finder needs:** To report the progress and outcome of an autonomous discovery campaign.

**v4 position:** No campaign event type exists. `module_activity` is the contract's record type for a module reporting what it is doing, with a `metrics` object.

**Workaround used:** Campaign state is sent as a `module_activity` record with the campaign's counters in `metrics` and its key in `external_id`.

**What is lost:** The platform treats campaign progress as module telemetry rather than as a first-class object, so it cannot be queried as a campaign.

**Would need:** A campaign record type, or module_activity rows addressable by key.

### `downstream-feedback-is-pull-not-push`

**Site Finder needs:** To learn what Site Investigator found on a candidate, so discovery techniques can be measured against independent outcomes rather than Site Finder's own opinion.

**v4 position:** There is no event routed back to the discovering module. But GET /api/v1/investigations/{id}/context returns the entities, evidence, relationships and jobs every module contributed.

**Workaround used:** Site Finder polls the context of investigations it opened and counts what other modules added, on a timer. Outcome signals are derived from those counts.

**What is lost:** Latency and polling cost. Feedback arrives on the poll interval rather than when the investigation finishes.

**Would need:** Either a `site.investigated` delivery to the originating module, or a webhook on investigation completion.

## No gap — documented for completeness

### `priority-is-not-an-event`

**Site Finder needs:** To say that a candidate is strong enough to deserve investigation ahead of others.

**v4 position:** There is no high-priority event. But `priority` on a site record is copied into the auto-published event payload by the ingestion adapter and read by priorityValue() when INVESTIGATE_SITE is queued.

**Workaround used:** Site Finder sets `priority` to the contract's own vocabulary (high / normal / low) on the site record. The platform's profile selection then picks Deep Investigation for high priority, which is the intended behaviour.

**What is lost:** Nothing. This is the contract's own mechanism.

**Would need:** Nothing.

### `no-entity-id-for-direct-event-publishing`

**Site Finder needs:** To publish a routed site.discovered event directly through POST /api/v1/events.

**v4 position:** lib/events.ts skips job creation when investigation_id or entity_id is missing, and entity UUIDs are minted by the platform — a module cannot know one before the entity exists.

**Workaround used:** Site Finder uses POST /api/v1/ingest/site_finder as its primary channel. The compatibility adapter upserts the entity and publishes the event itself with the real entity_id, which is what gets it routed.

**What is lost:** Nothing. This is the documented path for a module in this position.

**Would need:** Nothing.

### `infrastructure-observations-do-not-route`

**Site Finder needs:** To report where a candidate is hosted.

**v4 position:** `infrastructure_indicators` is a record type; it publishes no event, so it triggers no downstream work.

**Workaround used:** Sent as records. No event is expected or wanted.

**What is lost:** Nothing, and routing on it would be wrong: shared hosting is not a reason to open work on a site.

**Would need:** Nothing.
