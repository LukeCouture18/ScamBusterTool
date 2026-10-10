export type SeedType = 'domain' | 'wallet' | 'ip' | 'certificate' | 'template_fingerprint' | 'identifier' | 'artifact';

export type RelationshipState =
  | 'OBSERVED'
  | 'CORRELATED'
  | 'HYPOTHESIZED'
  | 'SUPPORTED'
  | 'CONTRADICTED'
  | 'UNRESOLVED';

export type HypothesisStatus =
  | 'FORMULATED'
  | 'STRONGLY_SUPPORTED'
  | 'WEAKENED'
  | 'CONTRADICTED'
  | 'RESOLVED';

export type HypothesisCategory =
  | 'COMMON_OPERATOR'
  | 'SHARED_BULLETPROOF_HOSTING'
  | 'SCAM_KIT_SYNDICATION'
  | 'CASH_OUT_SERVICE'
  | 'INFRASTRUCTURE_ROTATION'
  | 'FALSE_POSITIVE';

export type LeadStatus = 'PENDING' | 'INVESTIGATING' | 'COMPLETED' | 'DISCARDED' | 'EXHAUSTED';

export type LeadCost = 'low' | 'medium' | 'high';

export interface Seed {
  id: string;
  operationId: string;
  type: SeedType;
  value: string;
  label?: string;
  addedAt: string;
  status: 'pending' | 'expanded' | 'exhausted';
  notes?: string;
}

export interface Evidence {
  id: string;
  operationId: string;
  source: string; // e.g. 'passive_dns', 'cert_transparency', 'dom_hash', 'onchain_indexer', 'whois_asn', 'manual_import'
  type: string;   // e.g. 'dns_a_record', 'ssl_san', 'drainer_signature', 'tx_hop', 'ga_tracking_id'
  timestamp: string;
  originalObservation: string;
  rawData: Record<string, any>;
  sha256Hash: string;
  provenance: string; // origin URL, collector tool, or analyst signature
  confidence: number; // 0.0 - 1.0
  status: 'valid' | 'invalidated' | 'contradicted';
  invalidationReason?: string;
  relatedEntityIds: string[];
  // v1.0 fields
  collector?: string;          // collector id that produced this observation
  assertion?: EvidenceAssertion;
  synthetic?: boolean;         // produced by the demo world or a legacy simulator — never real
  collectedAt?: string;        // when Hunter collected it (timestamp = when it was true)
  pivotId?: string;            // pivot execution that produced it
}

export type EvidenceAssertion = 'observed' | 'blockchain_fact' | 'derived' | 'analyst' | 'imported';

export interface Entity {
  id: string;
  operationId: string;
  type: EntityType;
  value: string;
  label: string;
  metadata: Record<string, any>;
  firstSeen: string;
  lastSeen: string;
  isActive: boolean;
  isSeed?: boolean;
  // v1.0 fields
  canonical?: string;
  depth?: number;          // hops from the nearest seed
  ubiquity?: number;       // 0..1 — how common/shared this indicator is on the internet (1 = commodity)
  discoveredVia?: string;  // pivot id
  tags?: string[];
}

export type EntityType =
  | 'domain' | 'ip' | 'asn' | 'nameserver' | 'certificate' | 'template' | 'identifier'
  | 'wallet' | 'contract' | 'artifact' | 'registrar' | 'email' | 'hostname' | 'pattern';

export interface Relationship {
  id: string;
  operationId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type:
    | 'RESOLVES_TO'
    | 'SERVED_BY'
    | 'CERTIFIED_BY'
    | 'USES_IDENTIFIER'
    | 'EXECUTES_TEMPLATE'
    | 'CONTROLS_WALLET'
    | 'FUNDS_TRANSFER'
    | 'SHARED_INFRASTRUCTURE'
    | 'ROTATED_TO'
    | 'REAPPEARANCE_OF'
    // v1.0 relationship vocabulary (all evidence-backed)
    | 'DELEGATED_TO'
    | 'COVERS'
    | 'REFERENCES_WALLET'
    | 'HOSTS'
    | 'SUBDOMAIN_OF'
    | 'MENTIONS'
    | 'REGISTERED_WITH'
    | 'CREATED_BY'
    | 'USES_MAIL_SERVER'
    | 'REDIRECTS_TO'
    | 'SHARES_RESOURCE'
    | 'ANNOUNCED_BY'
    // v2.0
    | 'MATCHES_PATTERN';
  state: RelationshipState;
  confidence: number; // 0.0 - 1.0
  reasoning: string;
  evidenceIds: string[];
  firstObserved: string;
  lastObserved: string;
  contradictingEvidenceIds?: string[];
  assertion?: EvidenceAssertion;
  sources?: string[]; // distinct collectors/sources that support it
}

export interface Hypothesis {
  id: string;
  operationId: string;
  title: string;
  description: string;
  category: HypothesisCategory;
  status: HypothesisStatus;
  confidenceScore: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  supportingObservations: string[];
  contradictingObservations: string[];
  conditionsToStrengthen: string[];
  conditionsToWeaken: string[];
  conditionsToResolve: string[];
  competingHypothesisIds: string[];
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Lead {
  id: string;
  operationId: string;
  title: string;
  description: string;
  targetType: string;
  targetValue: string;
  pivotType: string;
  priorityScore: number; // 0 - 100
  reasoning: string;
  expectedInfoGain: number; // 1 - 10
  noveltyScore: number;     // 1 - 10
  costEstimate: LeadCost;
  status: LeadStatus;
  relatedHypothesisIds: string[];
  executionActionKey?: string;
  createdAt: string;
  // v1.0 fields
  key?: string;
  entityId?: string;
  depth?: number;
  collector?: string;
  source?: 'planner' | 'analyst' | 'legacy' | 'gap' | 'finding';
  plain?: { what: string; why: string; doesNotProve: string };
  scoreBreakdown?: LeadScoreBreakdown;
  updatedAt?: string;
  blockedReason?: string;   // why no collector can run it right now (e.g. offline, needs API key)
  lastError?: string;
}

export interface LeadScoreBreakdown {
  expectedInfoGain: number;
  noveltyScore: number;
  gapFulfillmentScore: number;
  historicalStrategyUtility: number;
  relevanceWeight: number;
  costPenalty: number;
  saturationPenalty: number;
  finalScore: number;
}

export interface ReappearanceFingerprint {
  id: string;
  operationId: string;
  signatureType: 'template_dom_hash' | 'cert_profile' | 'wallet_settlement_cluster' | 'nameserver_pair' | 'tag_identifier'
    | 'favicon_hash' | 'naming_pattern' | 'registrar_ns_combo' | 'kit_family' | 'cert_san_base' | 'wallet' | 'hosting_asn' | 'resource_hash';
  signatureValue: string;
  description: string;
  activeWindow: string;
  confidenceWeight: number;
}

export interface ReappearanceLead {
  id: string;
  operationId: string;
  candidateValue: string;
  candidateType: string;
  matchedFingerprintIds: string[];
  overallSimilarityScore: number; // 0 - 100%
  matchBreakdown: {
    fingerprintType: string;
    expected: string;
    observed: string;
    similarity: number;
  }[];
  reasoning: string;
  detectedAt: string;
  status: 'OPEN' | 'CONFIRMED_ROTATION' | 'NEW_CLUSTER' | 'FALSE_ALARM';
  source?: string; // where the candidate came from (manual, monitor, main:site_finder, ...)
}

export interface OperationProfile {
  id: string;
  code: string; // e.g. "OP-ARCTIC-DRAINER"
  name: string;
  targetType: string;
  initialSeed: string;
  status: 'ACTIVE_RECONSTRUCTION' | 'MONITORING' | 'CONCLUDED';
  summary: string;
  establishedFacts: string[];
  uncertainties: string[];
  recentChanges: string[];
  evidenceGaps: string[];
  unresolvedQuestions: string[];
  recommendedNextSteps: string[];
  createdAt: string;
  updatedAt: string;
  // v1.0 fields
  isDemo?: boolean;
  mainInvestigationId?: string | null;
  lastViewedAt?: string | null;
  revision?: number;
  tags?: string[];
  narrative?: string;
}

export interface MonitoringProbe {
  id: string;
  operationId: string;
  targetType: string;
  targetValue: string;
  frequencyMinutes: number;
  lastCheckedAt: string;
  status: 'ACTIVE' | 'PAUSED' | 'ALERTING';
  matchesFound: number;
  notes: string;
  // v1.0 fields
  pivotType?: string;
  entityId?: string;
  nextRunAt?: string;
  lastHash?: string;
  lastChange?: string;
  runs?: number;
}

// ==========================================
// V0.2 AUTONOMOUS PURSUIT & GRAPH INTELLIGENCE
// ==========================================

export type PursuitStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'BUDGET_EXHAUSTED'
  | 'SATURATED';

export interface PursuitConfig {
  maxHops: number;                 // e.g. 4 hops deep
  budgetTotal: number;             // max pivots allowed
  budgetRemaining: number;
  concurrency: number;
  minConfidenceThreshold: number;  // minimum confidence to expand
  avoidSaturation: boolean;        // stop branch when no new high-value info
}

export interface PursuitHopLog {
  id: string;
  hopNumber: number;
  timestamp: string;
  pivotType: string;
  sourceEntityValue: string;
  actionSummary: string;
  simpleExplanation: string;
  whyItMatters: string;
  discoveredEntitiesCount: number;
  newEvidenceCount: number;
  branchStatus: 'EXPANDED' | 'SATURATED' | 'ABANDONED_DEAD_END' | 'CYCLE_DETECTED';
  confidence: number;
}

export interface PursuitState {
  operationId: string;
  status: PursuitStatus;
  currentHop: number;
  pivotsExecuted: number;
  config: PursuitConfig;
  visitedEntityIds: string[];
  visitedPivotSignatures: string[];
  abandonedBranches: { entityId: string; reason: string }[];
  logs: PursuitHopLog[];
  lastActiveAt: string;
}

export interface PivotStrategyStat {
  pivotType: string;
  sourceCategory: string;
  attempts: number;
  successes: number;
  usefulEvidenceYield: number;
  contradictionCount: number;
  avgConfidence: number;
  utilityScore: number; // 0 - 100 calculated efficiency
}

export interface GraphCluster {
  id: string;
  operationId: string;
  name: string;
  category: 'HOSTING_INFRASTRUCTURE' | 'TEMPLATE_FAMILY' | 'FINANCIAL_PIPELINE' | 'TRACKER_SYNDICATE' | 'CERTIFICATE_GROUP';
  description: string;
  entityIds: string[];
  confidence: number;
  reasoning: string;
}

export interface GraphBridge {
  id: string;
  operationId: string;
  title: string;
  entityId: string;
  entityValue: string;
  entityType: string;
  connectedClusters: string[];
  bridgeSignificance: string;
  riskAssessment: string;
}

export interface CuratedBriefingLead {
  id: string;
  title: string;
  whatHunterNoticed: string;  // Plain English: What Hunter noticed
  whyItMatters: string;       // Plain English: Operational importance
  whatItDoesNotProve: string; // Plain English: Anti-premature attribution guardrail
  simpleExplanation: string; // Backward compatibility
  targetValue: string;
  targetType: string;
  pivotType: string;
  confidence: number;         // 0 - 100%
  supportingEvidenceCount: number;
  contradictingEvidenceCount: number;
  evidenceSummary: string;
  recommendedNextStep: string;
  bestNextStep: string;       // Recommended next step
  priorityScore: number;
  executionActionKey?: string;
  status: LeadStatus;
}

export interface InvestigatorBriefing {
  operationId: string;
  generatedAt: string;
  whatDidWeFind: string;
  whyDoesItMatter: string;
  howConfidentAreWe: {
    percentage: number;
    assessment: string;
    evidenceCount: number;
  };
  importantDiscovery: {
    title: string;
    description: string;
    whyItMatters: string;
    discoveredAt: string;
  } | null;
  whatChanged: string[];
  uncertaintiesAndContradictions: string[];
  topLeads: CuratedBriefingLead[]; // Strictly 3-5 best curated leads
  whatShouldIInvestigateNext: string;
  glossary?: Record<string, string>; // Contextual definitions for cybersecurity terms
}

// ==========================================
// V0.3 OPERATION INTELLIGENCE ENGINE TYPES
// ==========================================

export interface ScamKitGenome {
  id: string;
  operationId: string;
  kitFamily: string;            // e.g. "CryptoDrainer-X"
  variantVersion: string;       // e.g. "v2.4-obfuscated"
  domAstHash: string;           // AST structural signature
  faviconMurmurHash?: string;   // Favicon hash
  assetSignatures: string[];    // Obfuscated JS chunks, logos, modal templates
  web3ProvidersDetected: string[]; // e.g. ["WalletConnect-v2", "CoinbaseSDK", "MetaMaskInjected"]
  apiEndpointFingerprints: string[]; // backend telemetry endpoints
  depositInterfaceStyle: string; // "batch-permit2-drain", "direct-eth-transfer"
  vendorVsOperatorAnalysis: {
    kitVendorIndicators: string[];    // Identifies commercial software maker
    operatorSpecificIndicators: string[]; // Identifies campaign actor (wallets, analytics)
    attributionBoundary: string;       // Warning distinguishing software sale from perpetrator
  };
  firstSeen: string;
  lastSeen: string;
}

export interface FinancialAnalysis {
  id: string;
  operationId: string;
  monitoredWallets: string[];
  totalVolumeObservedEth: number;
  convergenceNodes: {
    walletAddress: string;
    incomingFlowsCount: number;
    totalReceivedEth: number;
    role: 'SPLITTER_INTERMEDIARY' | 'TREASURY_AGGREGATOR';
  }[];
  divergenceNodes: {
    destinationAddress: string;
    outflowCount: number;
    totalSentEth: number;
    destinationType: 'MIXER_RELAY' | 'CEX_DEPOSIT' | 'UNIDENTIFIED_EOA';
  }[];
  timingPatterns: string;      // e.g. "Automated sweep within 180 seconds of victim drain"
  counterpartyRecurrence: string[]; // recurring off-ramps or splitter contracts
  ownershipDisclaimer: string; // Explains transactions != common ownership
  // V0.4 Deep Financial Intelligence fields
  transactions?: FinancialTransaction[];
  timeline?: FinancialTimelineEvent[];
  addressRotations?: AddressRotationRecord[];
  crossChainObservations?: CrossChainObservation[];
}

export interface CrossOperationSimilarity {
  operationAId: string;
  operationBId: string;
  operationBName: string;
  sharedInfrastructure: string[];
  sharedGenomes: string[];
  sharedFinancialNodes: string[];
  overallSimilarityScore: number; // 0 - 100
  analyticalDistinction: 'COMMON_OPERATOR_HIGH_CONFIDENCE' | 'SHARED_COMMERCIAL_KIT' | 'SHARED_BULLETPROOF_HOSTING' | 'COINCIDENTAL_CORRELATION';
  reasoning: string;
}

export interface ContradictionReport {
  hypothesisId: string;
  hypothesisTitle: string;
  disprovalHypothesis: string;
  contradictingEvidence: {
    evidenceId: string;
    observation: string;
    source: string;
  }[];
  unresolvedGaps: string[];
  devilAdvocateAssessment: string;
}

// ==========================================
// V0.4 DEEP OPERATION INTELLIGENCE TYPES
// ==========================================

export type BlockchainNetwork = 'ethereum' | 'arbitrum' | 'bsc' | 'polygon' | 'tron';

export interface FinancialTransaction {
  id: string;
  txHash: string;
  network: BlockchainNetwork;
  fromAddress: string;
  toAddress: string;
  value: string;
  tokenSymbol: string;
  usdEquivalent: number;
  timestamp: string;
  blockNumber: number;
  method: 'permit2_sweep' | 'erc20_transfer' | 'native_transfer' | 'contract_execution' | 'bridge_transit';
  hopLevel: number; // 1 to 4
  isConvergenceHub?: boolean;
  isDivergenceExit?: boolean;
  classificationTag: 'VICTIM_DRAIN' | 'SPLITTER_DISTRIBUTION' | 'TREASURY_CONSOLIDATION' | 'MIXER_ROUTING' | 'CEX_DEPOSIT' | 'CROSS_CHAIN_BRIDGE';
  verifiedCounterparty?: string;
}

export interface FinancialTimelineEvent {
  id: string;
  timestamp: string;
  network: BlockchainNetwork;
  eventType: 'APPROVAL_EXPLOIT' | 'AUTOMATED_SWEEP' | 'ROYALTY_SPLIT' | 'TREASURY_TRANSFER' | 'OFFRAMP_EXIT' | 'CROSS_CHAIN_BRIDGE';
  title: string;
  description: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
  txHash: string;
}

export interface AddressRotationRecord {
  originalAddress: string;
  rotatedAddress: string;
  rotationTimestamp: string;
  network: BlockchainNetwork;
  transferTxHash: string;
  reason: string;
}

export interface CrossChainObservation {
  network: BlockchainNetwork;
  observedContracts: string[];
  bridgedVolumeUsd: number;
  bridgeProtocol: string;
}

export interface TemporalSnapshot {
  id: string;
  operationId: string;
  stepIndex: number; // 0, 1, 2, 3, 4
  stepLabel: string;
  timestamp: string;
  summary: string;
  activeDomains: string[];
  activeIps: string[];
  activeCertificates: string[];
  activeWallets: string[];
  activeNameservers: string[];
  addedSincePrevious: {
    entityType: string;
    value: string;
    reason: string;
  }[];
  removedOrDecommissioned: {
    entityType: string;
    value: string;
    reason: string;
  }[];
  mutations: string[];
}

export interface TemporalReconstructionReport {
  operationId: string;
  generatedAt: string;
  snapshots: TemporalSnapshot[];
  timelineDiffs: {
    fromStep: string;
    toStep: string;
    structuralChanges: string[];
  }[];
}

export type TaxonomyClassificationTier =
  | 'SAME_OBSERVATION'
  | 'SIMILARITY'
  | 'CORRELATION'
  | 'HYPOTHESIS'
  | 'SUPPORTED_RELATIONSHIP'
  | 'ATTRIBUTION';

export interface OperationGenomeProfile {
  id: string;
  operationId: string;
  version: string;
  createdAt: string;
  scamKitFamily: string;
  variantVersion: string;
  domAstSignature: string;
  faviconMurmurHash?: string;
  trackerSignatures: string[];
  infraPatternSignature: string;
  financialBehaviorSignature: string;
  networkFootprint: BlockchainNetwork[];
  confidenceCalibration: number;
  categorizationTaxonomy: {
    tier: TaxonomyClassificationTier;
    levelDescription: string;
    criteriaMet: string[];
    prohibitedClaims: string[];
  };
  forkEvolution?: {
    parentGenomeId?: string;
    divergedAt?: string;
    mutationType: 'INFRASTRUCTURE_MIGRATION' | 'PAYLOAD_OBFUSCATION' | 'TOKEN_DRAINER_EXPANSION' | 'COUNTERPARTY_ROTATION';
    description: string;
  };
}

export interface ReasoningTraceChain {
  conclusionId: string;
  claim: string;
  conclusion?: string;
  confidenceScore: number;
  leadingHypothesis: {
    id: string;
    title: string;
    category: HypothesisCategory;
    confidence: number;
    confidenceScore?: number;
  };
  competingHypotheses: {
    id: string;
    title: string;
    category: HypothesisCategory;
    confidence: number;
    whyNotFavored: string;
  }[];
  supportingRelationships: {
    id: string;
    type: string;
    reasoning: string;
    source: string;
    target: string;
    confidence: number;
  }[];
  observations: {
    evidenceId: string;
    source: string;
    originalObservation: string;
    confidence: number;
  }[];
  originalEvidence: {
    id: string;
    type: string;
    provenance: string;
    sha256Hash: string;
    rawDataSummary: string;
  }[];
  activeContradictions: {
    contradictionTitle: string;
    disprovalReason: string;
    unresolvedGaps: string[];
  }[];
  devilAdvocateCounterTheory: string;
  devilsAdvocateCondition?: string;
  alternativeExplanations?: string[];
}

export interface PredictiveLeadRanking {
  leadId: string;
  title: string;
  targetType: string;
  targetValue: string;
  pivotType: string;
  overallRankScore?: number;
  scoreBreakdown: {
    expectedInfoGain: number;
    noveltyScore: number;
    gapFulfillmentScore: number;
    historicalStrategyUtility: number;
    relevanceWeight: number;
    costPenalty: number;
    saturationPenalty: number;
    finalScore: number;
  };
  pedagogicalBreakdown: {
    whatHunterFound: string;
    whyItMatters: string;
    whatItDoesNotProve: string;
    evidenceBasis: string;
    confidencePercent: number;
    bestNextStep: string;
  };
}

export interface LearningOutcomeRecord {
  id: string;
  operationId: string;
  leadId: string;
  pivotType: string;
  contextDescription: string;
  expectedResult: string;
  actualResult: string;
  evidenceGainedCount: number;
  newEntitiesFoundCount: number;
  costIncurred: LeadCost;
  usefulnessScore: number;
  timestamp: string;
}

export interface SystemStore {
  version: number;
  operations: OperationProfile[];
  seeds: Seed[];
  evidence: Evidence[];
  entities: Entity[];
  relationships: Relationship[];
  hypotheses: Hypothesis[];
  leads: Lead[];
  reappearanceFingerprints: ReappearanceFingerprint[];
  reappearanceLeads: ReappearanceLead[];
  monitoringProbes: MonitoringProbe[];
  pursuitStates: Record<string, PursuitState>;
  strategyStats: Record<string, PivotStrategyStat>;
  clusters: GraphCluster[];
  bridges: GraphBridge[];
  scamKitGenomes: ScamKitGenome[];
  financialAnalyses: Record<string, FinancialAnalysis>;
  crossOpSimilarities: CrossOperationSimilarity[];
  temporalSnapshots?: Record<string, TemporalSnapshot[]>;
  operationGenomes?: Record<string, OperationGenomeProfile[]>;
  learningOutcomes?: LearningOutcomeRecord[];
  auditLogs: {
    id: string;
    operationId: string;
    action: string;
    details: string;
    timestamp: string;
  }[];
}
