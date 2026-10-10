/**
 * v7 Adaptive Investigation Intelligence — the typed vocabulary.
 *
 * Pure data. No database, no network, no benchmark imports. A gap is a named piece of
 * missing knowledge about a subject; a test is a bounded, safe action executed by an
 * EXISTING specialist that can reduce one or more gap families.
 *
 * Nothing here is evidence. Gaps and tests are coordination metadata.
 */

export const GAP_FAMILIES = [
  'SITE_IDENTITY', 'SITE_REPLACEMENT', 'PAYMENT_INTERFACE', 'DEPOSIT_WALLET', 'WALLET_NETWORK', 'WALLET_VALIDATION',
  'BLOCKCHAIN_ACTIVITY', 'WALLET_REUSE', 'WALLET_ROTATION', 'PUBLIC_ARTIFACT_REUSE', 'CONTACT_REUSE',
  'INFRASTRUCTURE_SPECIFICITY', 'TEMPLATE_SPECIFICITY', 'DEPLOYMENT_TIMING', 'OPERATION_MEMBERSHIP',
  'HYPOTHESIS_DISCRIMINATION', 'CONTRADICTION_RESOLUTION', 'RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE',
  'REPORT_EVIDENCE', 'REPORT_DESTINATION',
  // Demonstrated by the existing architecture (human_checkpoints): knowledge that only a person can
  // unlock (login, CAPTCHA/MFA, analyst network choice). Distinct because no autonomous test exists.
  'HUMAN_BARRIER',
] as const;
export type GapFamily = (typeof GAP_FAMILIES)[number];

export const TEST_FAMILIES = [
  'PUBLIC_SITE_INSPECTION', 'LIKELY_WALLET_PAGE_INSPECTION', 'WALLET_VALIDATION', 'BLOCKCHAIN_REFRESH',
  'RELATED_SITE_HUNT', 'PUBLIC_ARTIFACT_SEARCH', 'REPLACEMENT_SITE_HUNT', 'HUNTER_HYPOTHESIS_TEST',
  'TEMPORAL_RECHECK', 'CORRELATION_REVIEW',
] as const;
export type TestFamily = (typeof TEST_FAMILIES)[number];

export const GAP_STATUSES = ['open', 'in_progress', 'blocked_by_dependency', 'waiting_for_evidence', 'waiting_for_human', 'waiting_for_provider', 'temporarily_low_value', 'exhausted', 'resolved'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

/** Conditions that wake parked work. Each one is checked against a cheap watermark, not a re-plan. */
export const WAKE_CONDITIONS = ['new_site_observation', 'wallet_changed', 'provider_recovered', 'new_independent_evidence', 'contradiction_appeared',
  'new_deployment_wave', 'scheduled_temporal_recheck', 'human_decision', 'hunter_model_changed', 'budget_refreshed'] as const;
export type WakeCondition = (typeof WAKE_CONDITIONS)[number];

/** The evidence classes a test can produce. Diagnosticity is defined per class (see model.ts). */
export const EVIDENCE_CLASSES = ['template_similarity', 'infrastructure_context', 'certificate_overlap', 'public_contact', 'public_artifact',
  'wallet_observation', 'validated_wallet_reuse', 'blockchain_relationship', 'site_observation', 'temporal_observation', 'hunter_reanalysis', 'hunter_pursuit'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type SafetyClass = 'public_passive' | 'normal_browsing' | 'read_only_chain' | 'local_read' | 'analytical';
export type Specialist = 'site_finder' | 'site_investigator' | 'wallet_investigator' | 'operation_hunter' | 'main_local';

/** Resource bounds are the maximum a test may consume; the actual-cost ledger records what it did consume. */
export type ResourceBounds = { jobs: number; http: number; dns: number; certificate: number; rdap: number; provider_calls: number; effort_seconds: number };

export type TestSpec = {
  family: TestFamily;
  title: string;
  specialist: Specialist;
  /** Existing work-item kind used for handoff (null = Main-local read of existing records). */
  work_kind: 'find_related_sites' | 'reconstruct_operation' | 'revisit_incomplete' | 'revisit_changed_site' | 'analyze_wallet' | 'wallet_pipeline' | null;
  answers: Partial<Record<GapFamily, number>>; // probability a successful run resolves that gap family (answer power)
  produces: EvidenceClass[];
  expected_outputs: string;
  prerequisites: string;
  bounds: ResourceBounds;
  safety: SafetyClass;
  success: string;
  exhaustion: string;
};

const B = (p: Partial<ResourceBounds>): ResourceBounds => ({ jobs: 1, http: 0, dns: 0, certificate: 0, rdap: 0, provider_calls: 0, effort_seconds: 180, ...p });

export const TESTS: Record<TestFamily, TestSpec> = {
  PUBLIC_SITE_INSPECTION: {
    family: 'PUBLIC_SITE_INSPECTION', title: 'Inspect the public site', specialist: 'site_investigator', work_kind: 'revisit_incomplete',
    answers: { SITE_IDENTITY: .9, PAYMENT_INTERFACE: .55, DEPOSIT_WALLET: .45, OPERATION_MEMBERSHIP: .4, PUBLIC_ARTIFACT_REUSE: .2, CONTACT_REUSE: .2 },
    produces: ['site_observation', 'wallet_observation', 'public_contact', 'public_artifact'],
    expected_outputs: 'Public pages, analytics/contact artifacts and any publicly displayed deposit address.',
    prerequisites: 'A site entity attached to an investigation; Site Investigator connected.',
    bounds: B({ http: 50, dns: 6, certificate: 1 }), safety: 'public_passive',
    success: 'New public evidence rows for the site.', exhaustion: 'Site already inspected with no material change, or fetch failed twice.',
  },
  LIKELY_WALLET_PAGE_INSPECTION: {
    family: 'LIKELY_WALLET_PAGE_INSPECTION', title: 'Re-check likely deposit pages', specialist: 'site_investigator', work_kind: 'revisit_incomplete',
    answers: { PAYMENT_INTERFACE: .5, DEPOSIT_WALLET: .55, WALLET_ROTATION: .3 },
    produces: ['wallet_observation', 'site_observation'],
    expected_outputs: 'Publicly reachable deposit/payment pages and wallet presentations (no login).',
    prerequisites: 'Site previously inspected; no human barrier blocking the deposit page.',
    bounds: B({ http: 50, dns: 2 }), safety: 'public_passive',
    success: 'A deposit-context wallet observation.', exhaustion: 'One focused re-check produced no deposit presentation.',
  },
  WALLET_VALIDATION: {
    family: 'WALLET_VALIDATION', title: 'Validate an observed wallet', specialist: 'wallet_investigator', work_kind: 'wallet_pipeline',
    answers: { WALLET_VALIDATION: .95, WALLET_NETWORK: .7, REPORT_EVIDENCE: .2 },
    produces: ['wallet_observation'],
    expected_outputs: 'Checksum/network validation from Wallet Investigator (authoritative).',
    prerequisites: 'A wallet candidate observed in deposit context.',
    bounds: B({ effort_seconds: 2 }), safety: 'local_read',
    success: 'Validation status valid/invalid/network_ambiguous recorded.', exhaustion: 'Unable to validate after the pipeline retry limit.',
  },
  BLOCKCHAIN_REFRESH: {
    family: 'BLOCKCHAIN_REFRESH', title: 'Refresh read-only chain activity', specialist: 'wallet_investigator', work_kind: 'analyze_wallet',
    answers: { BLOCKCHAIN_ACTIVITY: .85, REPORT_EVIDENCE: .7, WALLET_REUSE: .1 },
    produces: ['blockchain_relationship'],
    expected_outputs: 'Read-only transaction history and counterparties for a validated deposit wallet.',
    prerequisites: 'Validated deposit wallet; provider healthy or its backoff expired.',
    bounds: B({ provider_calls: 6 }), safety: 'read_only_chain',
    success: 'COMPLETE analysis ingested.', exhaustion: 'Provider retry limit reached or analysis already complete.',
  },
  RELATED_SITE_HUNT: {
    family: 'RELATED_SITE_HUNT', title: 'Hunt for related public deployments', specialist: 'site_finder', work_kind: 'find_related_sites',
    answers: { RELATED_SITE: .45, TEMPLATE_SPECIFICITY: .4, CAMPAIGN_WAVE: .35, OPERATION_MEMBERSHIP: .15 },
    produces: ['site_observation', 'template_similarity', 'infrastructure_context'],
    expected_outputs: 'New candidate sites from public/passive pivots (observations, not ownership).',
    prerequisites: 'At least one recorded seed site; Site Finder connected.',
    bounds: B({ http: 40, dns: 40, certificate: 4, rdap: 6 }), safety: 'public_passive',
    success: 'A new candidate site that is later investigated.', exhaustion: 'Repeated rounds with unchanged seeds/artifacts delivered nothing new.',
  },
  PUBLIC_ARTIFACT_SEARCH: {
    family: 'PUBLIC_ARTIFACT_SEARCH', title: 'Search for reuse of a distinctive public artifact', specialist: 'site_finder', work_kind: 'find_related_sites',
    answers: { PUBLIC_ARTIFACT_REUSE: .7, CONTACT_REUSE: .7, WALLET_REUSE: .55, HYPOTHESIS_DISCRIMINATION: .5, RELATED_SITE: .35, CONTRADICTION_RESOLUTION: .3 },
    produces: ['public_artifact', 'public_contact', 'site_observation'],
    expected_outputs: 'Sites that publicly display the same analytics id, contact handle or wallet.',
    prerequisites: 'A specific recorded artifact (analytics id, contact, title, wallet) with provenance.',
    bounds: B({ http: 40, dns: 30, certificate: 4, rdap: 2 }), safety: 'public_passive',
    success: 'An independent site reusing the artifact.', exhaustion: 'The artifact was searched once with no reuse and no new artifact since.',
  },
  REPLACEMENT_SITE_HUNT: {
    family: 'REPLACEMENT_SITE_HUNT', title: 'Hunt for a replacement deployment', specialist: 'site_finder', work_kind: 'find_related_sites',
    answers: { REPLACEMENT_SITE: .55, SITE_REPLACEMENT: .4, CAMPAIGN_WAVE: .3, RELATED_SITE: .25 },
    produces: ['site_observation', 'public_artifact'],
    expected_outputs: 'A live deployment reusing the disappeared site\'s distinctive artifacts.',
    prerequisites: 'A member site recorded as disappeared plus at least one recorded artifact.',
    bounds: B({ http: 40, dns: 30, certificate: 4, rdap: 2 }), safety: 'public_passive',
    success: 'A replacement candidate later investigated.', exhaustion: 'Searched once per disappearance with no candidate.',
  },
  HUNTER_HYPOTHESIS_TEST: {
    family: 'HUNTER_HYPOTHESIS_TEST', title: 'Ask Operation Hunter a structured question', specialist: 'operation_hunter', work_kind: 'reconstruct_operation',
    answers: { HYPOTHESIS_DISCRIMINATION: .35, CONTRADICTION_RESOLUTION: .45, DEPLOYMENT_TIMING: .5, CAMPAIGN_WAVE: .3, OPERATION_MEMBERSHIP: .25 },
    produces: ['hunter_reanalysis', 'temporal_observation'],
    expected_outputs: 'Hunter\'s evidence-bound answer (ACH update, contradiction state, waves). Hunter remains the inference authority.',
    prerequisites: 'An operation reconstructed by Hunter; new evidence since Hunter last analysed it (otherwise low value).',
    bounds: B({ http: 40, dns: 20, certificate: 2, rdap: 6 }), safety: 'analytical',
    success: 'Hunter synced a changed hypothesis or contradiction state.', exhaustion: 'Asked without new evidence since the last answer.',
  },
  TEMPORAL_RECHECK: {
    family: 'TEMPORAL_RECHECK', title: 'Re-check a changing site', specialist: 'site_investigator', work_kind: 'revisit_changed_site',
    answers: { SITE_REPLACEMENT: .55, WALLET_ROTATION: .55, DEPLOYMENT_TIMING: .3, SITE_IDENTITY: .2 },
    produces: ['temporal_observation', 'wallet_observation', 'site_observation'],
    expected_outputs: 'Whether the public site, its build or its deposit wallet changed since the last observation.',
    prerequisites: 'A previously inspected site with a recorded change, disappearance or scheduled recheck.',
    bounds: B({ http: 30, dns: 2 }), safety: 'public_passive',
    success: 'A recorded change (or a confirmed unchanged state).', exhaustion: 'Re-checked inside its cooldown with no change.',
  },
  CORRELATION_REVIEW: {
    family: 'CORRELATION_REVIEW', title: 'Review existing validated observations', specialist: 'main_local', work_kind: null,
    answers: { WALLET_REUSE: .6, INFRASTRUCTURE_SPECIFICITY: .7, OPERATION_MEMBERSHIP: .3, HYPOTHESIS_DISCRIMINATION: .25 },
    produces: ['validated_wallet_reuse', 'infrastructure_context'],
    expected_outputs: 'Where an already-validated wallet or infrastructure indicator appears across Main\'s existing records (no network access).',
    prerequisites: 'A validated deposit wallet or an infrastructure indicator in the operation.',
    bounds: B({ jobs: 0, effort_seconds: 1 }), safety: 'local_read',
    success: 'A validated cross-site observation or a generic-infrastructure determination.', exhaustion: 'Reviewed with the same inputs already.',
  },
};

export type GapSpec = {
  family: GapFamily;
  matters: string;
  /** Families that must be resolved first for this family's tests to be meaningful. */
  depends_on: GapFamily[];
  exhaustion: string;
  revisit: WakeCondition[];
  /** True when no autonomous test may resolve it. */
  human_only?: boolean;
};

const G = (family: GapFamily, matters: string, depends_on: GapFamily[], exhaustion: string, revisit: WakeCondition[], human_only = false): GapSpec => ({ family, matters, depends_on, exhaustion, revisit, human_only });

export const GAPS: Record<GapFamily, GapSpec> = {
  SITE_IDENTITY: G('SITE_IDENTITY', 'Without public evidence about a site, nothing else about it can be assessed.', [], 'Public inspection completed or failed twice.', ['new_site_observation']),
  SITE_REPLACEMENT: G('SITE_REPLACEMENT', 'A materially changed site may be a new deployment that needs its own report boundary.', ['SITE_IDENTITY'], 'Re-checked after the change.', ['new_site_observation', 'scheduled_temporal_recheck']),
  PAYMENT_INTERFACE: G('PAYMENT_INTERFACE', 'Reports need the public payment presentation that solicits deposits.', ['SITE_IDENTITY'], 'Focused public re-check found no payment presentation.', ['new_site_observation', 'human_decision']),
  DEPOSIT_WALLET: G('DEPOSIT_WALLET', 'A deposit wallet is the anchor for validation, chain evidence and reporting.', ['SITE_IDENTITY'], 'Public pages exhausted; only normal browsing can reveal it.', ['new_site_observation', 'wallet_changed', 'human_decision']),
  WALLET_NETWORK: G('WALLET_NETWORK', 'Chain evidence is only meaningful on the correct network.', ['DEPOSIT_WALLET'], 'Ambiguous network requires analyst judgment.', ['human_decision', 'wallet_changed'], true),
  WALLET_VALIDATION: G('WALLET_VALIDATION', 'Only Wallet Investigator validation makes an address reportable.', ['DEPOSIT_WALLET'], 'Unable to validate after bounded retries.', ['wallet_changed']),
  BLOCKCHAIN_ACTIVITY: G('BLOCKCHAIN_ACTIVITY', 'Read-only chain evidence is required for a complete wallet report.', ['WALLET_VALIDATION'], 'Provider retry limit reached.', ['provider_recovered', 'wallet_changed']),
  WALLET_REUSE: G('WALLET_REUSE', 'Independent reuse of a validated deposit wallet is strong, discriminating correlation evidence (not ownership).', ['WALLET_VALIDATION'], 'Existing records and one public search show no reuse.', ['new_site_observation', 'wallet_changed']),
  WALLET_ROTATION: G('WALLET_ROTATION', 'Rotated deposit wallets change what a report must contain.', ['WALLET_VALIDATION'], 'Re-checked with no change.', ['scheduled_temporal_recheck', 'wallet_changed']),
  PUBLIC_ARTIFACT_REUSE: G('PUBLIC_ARTIFACT_REUSE', 'Distinctive public identifiers can discriminate shared operation from shared kit.', ['SITE_IDENTITY'], 'Artifact searched with no reuse and no new artifact.', ['new_independent_evidence', 'new_site_observation']),
  CONTACT_REUSE: G('CONTACT_REUSE', 'A reused public support contact is distinctive, discriminating evidence.', ['SITE_IDENTITY'], 'Contact searched with no reuse.', ['new_independent_evidence']),
  INFRASTRUCTURE_SPECIFICITY: G('INFRASTRUCTURE_SPECIFICITY', 'Shared CDN/hosting is usually generic; it must not inflate correlation.', [], 'Specificity determined from existing records.', ['new_independent_evidence']),
  TEMPLATE_SPECIFICITY: G('TEMPLATE_SPECIFICITY', 'Kit/template similarity rarely separates an operation from other kit users.', [], 'Variant searched outside the operation once.', ['new_independent_evidence']),
  DEPLOYMENT_TIMING: G('DEPLOYMENT_TIMING', 'Deployment chronology can challenge or support continuity hypotheses.', ['SITE_IDENTITY'], 'Hunter timing analysis completed.', ['new_site_observation', 'hunter_model_changed']),
  OPERATION_MEMBERSHIP: G('OPERATION_MEMBERSHIP', 'A proposed member supported only by weak overlap may not belong in the operation.', ['SITE_IDENTITY'], 'No further strong evidence obtainable without new observations.', ['new_independent_evidence', 'human_decision']),
  HYPOTHESIS_DISCRIMINATION: G('HYPOTHESIS_DISCRIMINATION', 'Competing explanations remain open; only discriminating evidence separates them.', [], 'Every available discriminating test has been run.', ['new_independent_evidence', 'hunter_model_changed']),
  CONTRADICTION_RESOLUTION: G('CONTRADICTION_RESOLUTION', 'An unresolved contradiction can overturn the current explanation.', [], 'Contradiction explicitly resolved or no test can address it.', ['contradiction_appeared', 'new_independent_evidence', 'human_decision']),
  RELATED_SITE: G('RELATED_SITE', 'Undiscovered deployments leave victims unreported.', ['SITE_IDENTITY'], 'Related-site hunts saturated (duplicates/dead ends).', ['new_independent_evidence', 'new_deployment_wave']),
  REPLACEMENT_SITE: G('REPLACEMENT_SITE', 'A disappeared deployment may have been replaced; replacements are time-sensitive.', ['SITE_IDENTITY'], 'Replacement hunt for this disappearance completed.', ['new_site_observation', 'new_deployment_wave']),
  CAMPAIGN_WAVE: G('CAMPAIGN_WAVE', 'A new deployment wave can contain several unreported sites.', [], 'Wave hunted once.', ['new_deployment_wave']),
  REPORT_EVIDENCE: G('REPORT_EVIDENCE', 'A report blocked on missing evidence delays the only externally useful outcome.', ['BLOCKCHAIN_ACTIVITY'], 'Report ready or blockers require a person.', ['provider_recovered', 'wallet_changed', 'human_decision']),
  REPORT_DESTINATION: G('REPORT_DESTINATION', 'A ready report needs a configured submission destination and explicit approval.', ['REPORT_EVIDENCE'], 'Waiting for the analyst / Form Submitter destination.', ['human_decision'], true),
  HUMAN_BARRIER: G('HUMAN_BARRIER', 'Login, CAPTCHA/MFA or analyst judgment blocks further evidence.', [], 'Only a person can resolve it.', ['human_decision'], true),
};

/** Families whose resolution unlocks other families (transitively). Used for downstream opportunity. */
export function dependents(family: GapFamily): GapFamily[] {
  const out = new Set<GapFamily>();
  const visit = (f: GapFamily) => { for (const g of GAP_FAMILIES) if (GAPS[g].depends_on.includes(f) && !out.has(g)) { out.add(g); visit(g); } };
  visit(family);
  return [...out];
}

/** Families that only discriminate when evidence is independent; template/infrastructure are generic. */
export const WEAK_CATEGORIES = new Set(['infrastructure_context', 'template_similarity']);
