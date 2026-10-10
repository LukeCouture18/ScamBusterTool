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
  source: string;
  type: string;
  timestamp: string;
  originalObservation: string;
  rawData: Record<string, any>;
  sha256Hash: string;
  provenance: string;
  confidence: number;
  status: 'valid' | 'invalidated' | 'contradicted';
  invalidationReason?: string;
  relatedEntityIds: string[];
}

export interface Entity {
  id: string;
  operationId: string;
  type: 'domain' | 'ip' | 'asn' | 'nameserver' | 'certificate' | 'template' | 'identifier' | 'wallet' | 'contract' | 'artifact';
  value: string;
  label: string;
  metadata: Record<string, any>;
  firstSeen: string;
  lastSeen: string;
  isActive: boolean;
  isSeed?: boolean;
}

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
    | 'REAPPEARANCE_OF';
  state: RelationshipState;
  confidence: number;
  reasoning: string;
  evidenceIds: string[];
  firstObserved: string;
  lastObserved: string;
  contradictingEvidenceIds?: string[];
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
  priorityScore: number;
  reasoning: string;
  expectedInfoGain: number;
  noveltyScore: number;
  costEstimate: LeadCost;
  status: LeadStatus;
  relatedHypothesisIds: string[];
  executionActionKey?: string;
  createdAt: string;
}

export interface ReappearanceFingerprint {
  id: string;
  operationId: string;
  signatureType: 'template_dom_hash' | 'cert_profile' | 'wallet_settlement_cluster' | 'nameserver_pair' | 'tag_identifier';
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
  overallSimilarityScore: number;
  matchBreakdown: {
    fingerprintType: string;
    expected: string;
    observed: string;
    similarity: number;
  }[];
  reasoning: string;
  detectedAt: string;
  status: 'OPEN' | 'CONFIRMED_ROTATION' | 'NEW_CLUSTER' | 'FALSE_ALARM';
}

export interface OperationProfile {
  id: string;
  code: string;
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
}

export interface OperationBundle {
  operation: OperationProfile;
  briefing?: InvestigatorBriefing;
  pursuit?: PursuitState;
  clusters?: GraphCluster[];
  bridges?: GraphBridge[];
  strategyStats?: Record<string, PivotStrategyStat>;
  scamKitGenomes?: ScamKitGenome[];
  financialAnalysis?: FinancialAnalysis;
  crossOpSimilarities?: CrossOperationSimilarity[];
  contradictionReports?: ContradictionReport[];
  temporalSnapshots?: TemporalSnapshot[];
  temporalDiffs?: {
    fromStep: string;
    toStep: string;
    structuralChanges: string[];
  }[];
  operationGenomes?: OperationGenomeProfile[];
  predictiveRankings?: PredictiveLeadRanking[];
  learningOutcomes?: LearningOutcomeRecord[];
  seeds: Seed[];
  entities: Entity[];
  relationships: Relationship[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  leads: Lead[];
  fingerprints: ReappearanceFingerprint[];
  reappearanceLeads: ReappearanceLead[];
  monitoringProbes: MonitoringProbe[];
  auditLogs: {
    id: string;
    operationId: string;
    action: string;
    details: string;
    timestamp: string;
  }[];
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
  maxHops: number;
  budgetTotal: number;
  budgetRemaining: number;
  concurrency: number;
  minConfidenceThreshold: number;
  avoidSaturation: boolean;
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
  utilityScore: number;
}

export interface GraphCluster {
  id: string;
  operationId: string;
  name: string;
  category: 'HOSTING_INFRASTRUCTURE' | 'TEMPLATE_FAMILY' | 'FINANCIAL_PIPELINE' | 'TRACKER_SYNDICATE';
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
  confidence: number;
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
  topLeads: CuratedBriefingLead[];
  whatShouldIInvestigateNext: string;
  glossary?: Record<string, string>; // Contextual definitions for cybersecurity terms
}

// ==========================================
// V0.3 OPERATION INTELLIGENCE ENGINE TYPES
// ==========================================

export interface ScamKitGenome {
  id: string;
  operationId: string;
  kitFamily: string;
  variantVersion: string;
  domAstHash: string;
  faviconMurmurHash?: string;
  assetSignatures: string[];
  web3ProvidersDetected: string[];
  apiEndpointFingerprints: string[];
  depositInterfaceStyle: string;
  vendorVsOperatorAnalysis: {
    kitVendorIndicators: string[];
    operatorSpecificIndicators: string[];
    attributionBoundary: string;
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
  timingPatterns: string;
  counterpartyRecurrence: string[];
  ownershipDisclaimer: string;
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
  overallSimilarityScore: number;
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
  hopLevel: number;
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
  stepIndex: number;
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

export interface AIAnalysisResult {
  aiReasoning: string;
  proposedHypotheses: {
    title: string;
    description: string;
    category: string;
    confidence: number;
    challengePerspective: string;
  }[];
  uncoveredBlindspots: string[];
  recommendedSafeNextStep: string;
  isAiGenerated: true;
  engineUsed: string;
}
