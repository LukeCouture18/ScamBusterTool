"""
Contract Gap Report: what Site Finder needs that v4 does not express.

The rule for v0.6 is that Site Finder has no wire standard of its own. When
something it needs has no home in the canonical contract, the answer is to say
so here — not to add an event type, a field, an endpoint or a status value.

Each gap records what Site Finder wanted, what it does instead within the
contract, and what the contract would need for the gap to close. The
workarounds are all inside the contract: the `.passthrough()` extension point
on base records, `module_activity` for module reporting, `findings` and `notes`
for written detail, and `priority` on a site record for ordering. None of them
invents anything.

Severity is about what is lost, not about how much Site Finder would like it:

  none      fully expressible; recorded only so the mapping is documented
  cosmetic  expressible, but the platform cannot query or route on it
  real      information is genuinely lost or must be inferred downstream
"""
from app.integration.v4 import contract

GAPS = [
    {
        "id": "triage-outcome-has-no-event",
        "severity": "cosmetic",
        "site_finder_needs": (
            "To report that a candidate was triaged against public information and what "
            "that produced, as a distinct signal from the discovery itself."),
        "v4_position": (
            "The event type list in lib/events.ts is closed and contains no triage event. "
            "site.discovered is the only site-related event a discovery module produces."),
        "workaround": (
            "Triage becomes the `confidence` on the `sites` record, with `classification` "
            "and a `triage` object carried in the record's passthrough fields. The platform "
            "preserves unknown fields on the source observation (lib/ingestion.ts baseRecord "
            "is .passthrough()), so nothing is lost in storage."),
        "what_is_lost": (
            "The platform cannot route or filter on triage outcome directly — it sees one "
            "confidence number. A reviewer reading the observation sees the full detail."),
        "would_need": "A `site.triaged` event type, or a first-class triage field on site records.",
    },
    {
        "id": "priority-is-not-an-event",
        "severity": "none",
        "site_finder_needs": (
            "To say that a candidate is strong enough to deserve investigation ahead of "
            "others."),
        "v4_position": (
            "There is no high-priority event. But `priority` on a site record is copied "
            "into the auto-published event payload by the ingestion adapter and read by "
            "priorityValue() when INVESTIGATE_SITE is queued."),
        "workaround": (
            "Site Finder sets `priority` to the contract's own vocabulary (high / normal / "
            "low) on the site record. The platform's profile selection then picks Deep "
            "Investigation for high priority, which is the intended behaviour."),
        "what_is_lost": "Nothing. This is the contract's own mechanism.",
        "would_need": "Nothing.",
    },
    {
        "id": "campaign-progress-has-no-event",
        "severity": "cosmetic",
        "site_finder_needs": (
            "To report the progress and outcome of an autonomous discovery campaign."),
        "v4_position": (
            "No campaign event type exists. `module_activity` is the contract's record type "
            "for a module reporting what it is doing, with a `metrics` object."),
        "workaround": (
            "Campaign state is sent as a `module_activity` record with the campaign's "
            "counters in `metrics` and its key in `external_id`."),
        "what_is_lost": (
            "The platform treats campaign progress as module telemetry rather than as a "
            "first-class object, so it cannot be queried as a campaign."),
        "would_need": "A campaign record type, or module_activity rows addressable by key.",
    },
    {
        "id": "downstream-feedback-is-pull-not-push",
        "severity": "cosmetic",
        "site_finder_needs": (
            "To learn what Site Investigator found on a candidate, so discovery techniques "
            "can be measured against independent outcomes rather than Site Finder's own "
            "opinion."),
        "v4_position": (
            "There is no event routed back to the discovering module. But "
            "GET /api/v1/investigations/{id}/context returns the entities, evidence, "
            "relationships and jobs every module contributed."),
        "workaround": (
            "Site Finder polls the context of investigations it opened and counts what "
            "other modules added, on a timer. Outcome signals are derived from those "
            "counts."),
        "what_is_lost": (
            "Latency and polling cost. Feedback arrives on the poll interval rather than "
            "when the investigation finishes."),
        "would_need": (
            "Either a `site.investigated` delivery to the originating module, or a webhook "
            "on investigation completion."),
    },
    {
        "id": "no-entity-id-for-direct-event-publishing",
        "severity": "none",
        "site_finder_needs": (
            "To publish a routed site.discovered event directly through POST /api/v1/events."),
        "v4_position": (
            "lib/events.ts skips job creation when investigation_id or entity_id is "
            "missing, and entity UUIDs are minted by the platform — a module cannot know "
            "one before the entity exists."),
        "workaround": (
            "Site Finder uses POST /api/v1/ingest/site_finder as its primary channel. The "
            "compatibility adapter upserts the entity and publishes the event itself with "
            "the real entity_id, which is what gets it routed."),
        "what_is_lost": "Nothing. This is the documented path for a module in this position.",
        "would_need": "Nothing.",
    },
    {
        "id": "infrastructure-observations-do-not-route",
        "severity": "none",
        "site_finder_needs": "To report where a candidate is hosted.",
        "v4_position": (
            "`infrastructure_indicators` is a record type; it publishes no event, so it "
            "triggers no downstream work."),
        "workaround": "Sent as records. No event is expected or wanted.",
        "what_is_lost": (
            "Nothing, and routing on it would be wrong: shared hosting is not a reason to "
            "open work on a site."),
        "would_need": "Nothing.",
    },
    {
        "id": "discovery-quality-telemetry-has-no-home",
        "severity": "real",
        "site_finder_needs": (
            "To report which discovery sources, pivots and indicator combinations are "
            "producing useful candidates, so the platform could see sensor quality "
            "alongside its own view of the pipeline."),
        "v4_position": (
            "No record type carries per-technique performance. `module_activity.metrics` "
            "is free-form but is keyed to one activity row rather than to techniques."),
        "workaround": (
            "Aggregate funnel counts go in `module_activity.metrics`. Per-technique detail "
            "stays local to Site Finder and is visible in its own Discovery Performance "
            "view."),
        "what_is_lost": (
            "The platform cannot see which discovery techniques are productive, so it "
            "cannot weigh a Site Finder candidate by the track record of the route that "
            "found it."),
        "would_need": (
            "A module-metrics record type keyed by technique, or agreed metric names inside "
            "module_activity."),
    },
    {
        "id": "site-finder-cannot-express-negative-triage",
        "severity": "real",
        "site_finder_needs": (
            "To tell the platform that a candidate was examined and rejected, so the same "
            "domain is not rediscovered and re-queued by another sensor later."),
        "v4_position": (
            "Ingesting a site record publishes site.discovered, which routes to "
            "INVESTIGATE_SITE. There is no way to record a candidate as considered and "
            "dismissed without also asking for it to be investigated."),
        "workaround": (
            "Rejected candidates are simply not sent. They stay in Site Finder's local "
            "database, which prevents rediscovery by this sensor but not by another."),
        "what_is_lost": (
            "Negative results never reach the platform, so the knowledge that a domain was "
            "checked and found thin is not shared between modules."),
        "would_need": (
            "A way to ingest a site observation without triggering investigation — a "
            "`routing: false` hint, or a dismissed classification the router respects."),
    },
]


def report() -> dict:
    by_severity = {}
    for gap in GAPS:
        by_severity.setdefault(gap["severity"], []).append(gap["id"])

    return {
        "contract": {
            "module": contract.MODULE_NAME,
            "ingest_schema_version": contract.INGEST_SCHEMA_VERSION,
            "event_schema_version": contract.EVENT_SCHEMA_VERSION,
            "capabilities": list(contract.SITE_FINDER_CAPABILITIES),
            "event_types_available": list(contract.EVENT_TYPES),
            "event_types_produced": list(contract.SITE_FINDER_EVENT_TYPES),
            "record_types_produced": list(contract.SITE_FINDER_RECORD_TYPES),
            "job_types_handled": list(contract.SITE_FINDER_JOB_TYPES),
        },
        "gaps": GAPS,
        "counts": {severity: len(ids) for severity, ids in by_severity.items()},
        "real_gaps": [g for g in GAPS if g["severity"] == "real"],
        "note": (
            "Site Finder defines no wire format of its own. Every item here is something "
            "the canonical v4 contract does not express, together with what Site Finder "
            "does instead within the contract. Nothing on this list has been worked around "
            "by adding an event type, field, endpoint or status value."),
    }


def markdown() -> str:
    """The report as a document, for pasting into a contract discussion."""
    data = report()
    lines = [
        "# Site Finder → Main Investigation Platform v4: Contract Gap Report",
        "",
        f"Module: `{data['contract']['module']}`  ",
        f"Ingest schema: `{data['contract']['ingest_schema_version']}`  ",
        f"Event schema: `{data['contract']['event_schema_version']}`  ",
        f"Capabilities: {', '.join(data['contract']['capabilities'])}",
        "",
        "Site Finder adopts the v4 contract exactly and defines no wire format of its "
        "own. Everything below is something it needs that v4 does not express, with the "
        "in-contract workaround it uses instead.",
        "",
    ]
    for severity in ("real", "cosmetic", "none"):
        gaps = [g for g in data["gaps"] if g["severity"] == severity]
        if not gaps:
            continue
        heading = {"real": "Real gaps — information is lost",
                   "cosmetic": "Cosmetic gaps — expressible, but not queryable",
                   "none": "No gap — documented for completeness"}[severity]
        lines += [f"## {heading}", ""]
        for gap in gaps:
            lines += [
                f"### `{gap['id']}`", "",
                f"**Site Finder needs:** {gap['site_finder_needs']}", "",
                f"**v4 position:** {gap['v4_position']}", "",
                f"**Workaround used:** {gap['workaround']}", "",
                f"**What is lost:** {gap['what_is_lost']}", "",
                f"**Would need:** {gap['would_need']}", "",
            ]
    return "\n".join(lines)
