/** Canonical v6 native-event contract. Legacy ingestion remains separately versioned. */
export const CONTRACT_VERSION="3.0" as const;
export const EVENT_TYPES=["site.discovered","site.triaged","site.investigated","investigation.updated","investigation.completed","wallet.observed","wallet.validated","wallet.analyzed","evidence.added","relationship.discovered","report.received","report.validating","report.needs_review","report.blocked","report.ready","report.prefilling","report.submitting","report.verifying","report.completed","report.failed"] as const;
export type EventType=(typeof EVENT_TYPES)[number];
