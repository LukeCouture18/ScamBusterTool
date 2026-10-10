export type CryptoNetwork =
  | 'BTC'
  | 'ETH'
  | 'USDT_ERC20'
  | 'USDT_TRC20'
  | 'USDT_BEP20'
  | 'TRX'
  | 'SOL'
  | 'XRP'
  | 'LTC'
  | 'DOGE'
  | 'ADA'
  | 'XMR'
  | 'UNKNOWN';

export type ValidationStatus = 'READY' | 'NEEDS_REVIEW' | 'BLOCKED';

export type QueueFilterStatus =
  | 'ALL'
  | 'PENDING'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'COMPLETED'
  | 'FAILED';

export type SubmissionMode = 'MANUAL_REVIEW' | 'VALIDATED_PREFILL' | 'AUTO_SUBMIT';

export type SubmissionLifecycleState =
  | 'NOT_STARTED'
  | 'SUBMITTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'UNKNOWN'
  | 'FAILED';

export type CrashRecoveryState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'VERIFICATION_UNKNOWN'
  | 'COMPLETED';

export interface WalletFinding {
  id: string;
  address: string;
  selectedNetwork: CryptoNetwork;
  detectedNetworks: CryptoNetwork[];
  checksumValid: boolean | null; // null = not applicable / format unsupported
  isAmbiguous: boolean;
  ambiguityReason?: string;
  validationNotes: string[];
  status: ValidationStatus;
  confidence: number; // 0.0 - 1.0
  sourceLabel?: string;
}

export interface PlatformProvenance {
  investigationId: string;
  siteId: string;
  walletIds: string[];
  evidenceIds: string[];
  correlationId?: string;
  sourceModule:
    | 'Site Finder'
    | 'Site Investigator'
    | 'CryptoWalletLogger'
    | 'Wallet Investigator'
    | 'Main Investigation Platform'
    | 'Manual Input';
  timestamp: string;
  confidence: number;
  mainPlatformSyncStatus: 'PENDING_SYNC' | 'SYNCED' | 'DISCONNECTED';
  schemaVersion?: string;
}

export interface InvestigationFinding {
  id: string;
  siteUrl: string;
  domain: string;
  wallets: WalletFinding[];
  screenshotUrls: string[]; // Base64 or image data URLs
  notes: string;
  username: string;
  teamInviteCode: string; // Stored securely, masked in UI
  idempotencyKey?: string;
  provenance: PlatformProvenance;
  overallStatus: ValidationStatus;
  queueStatus: 'PENDING' | 'READY' | 'NEEDS_REVIEW' | 'COMPLETED' | 'FAILED';
  submissionState: SubmissionLifecycleState;
  recoveryState?: CrashRecoveryState;
  formVersionHash?: string;
  validationDiagnostics: {
    rule: string;
    passed: boolean;
    status: ValidationStatus;
    message: string;
  }[];
  submissionMode: SubmissionMode;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  verificationNotes?: string;
}

// ----------------------------------------------------
// Real Google Form Inspection & Parser Types
// ----------------------------------------------------

export type FormQuestionType =
  | 'SHORT_ANSWER'
  | 'PARAGRAPH'
  | 'MULTIPLE_CHOICE'
  | 'CHECKBOXES'
  | 'DROPDOWN'
  | 'PAGE_BREAK'
  | 'SCALE'
  | 'DATE'
  | 'TIME'
  | 'UNKNOWN';

export interface FormQuestion {
  id: string;
  entryKey: string; // e.g. "entry.184729104"
  title: string;
  description?: string;
  type: FormQuestionType;
  required: boolean;
  choices?: string[];
  pageIndex: number;
}

export interface FormSection {
  pageIndex: number;
  title: string;
  description?: string;
  questions: FormQuestion[];
}

export interface ParsedFormSchema {
  formId: string;
  formTitle: string;
  formUrl: string;
  versionHash: string; // SHA-256 fingerprint of questions & requirements
  sections: FormSection[];
  allQuestions: FormQuestion[];
  parsedAt: string;
  rawInspectionSource?: 'GOOGLE_HTML_SCRAPE' | 'FALLBACK_SCHEMA';
}

export type StandardInvestigationFieldKey =
  | 'siteUrl'
  | 'domain'
  | 'walletsList'
  | 'primaryWallet'
  | 'primaryNetwork'
  | 'username'
  | 'teamInviteCode'
  | 'evidenceNotes'
  | 'investigationId'
  | 'customNotes';

export interface FormFieldMapping {
  id: string;
  fieldKey: StandardInvestigationFieldKey;
  label: string;
  entryKey: string; // e.g. "entry.184729104"
  pageIndex: number; // 1-based
  required: boolean;
  notes?: string;
  matchedQuestionTitle?: string;
}

export interface FormMappingConfig {
  formUrl: string;
  formId: string;
  formTitle: string;
  formVersionHash?: string;
  verifiedAt?: string;
  fieldMappings: FormFieldMapping[];
  multiWalletFormat: 'COMBINED_LIST' | 'PRIMARY_ONLY' | 'LINE_BY_LINE_NETWORK';
  parsedSchema?: ParsedFormSchema;
  isFormChanged?: boolean;
  previousVersionHash?: string;
}

export interface UserSettings {
  username: string;
  teamInviteCode: string;
  defaultFormUrl: string;
  defaultSubmissionMode: SubmissionMode;
  strictEVMMode: boolean; // Flag 0x as NEEDS REVIEW unless token context is selected
  isConfigured: boolean;
  autoSubmitGlobalEnabled: boolean; // Master safety switch in Settings
  batchPacingSeconds: number; // Delay in seconds between auto-submissions (e.g. 5)
  enableDuplicateGuard: boolean;
}

export interface HistoryRecord {
  id: string;
  findingId: string;
  idempotencyKey?: string;
  timestamp: string;
  siteUrl: string;
  domain: string;
  wallets: {
    address: string;
    network: CryptoNetwork;
    checksumStatus: string;
  }[];
  username: string;
  teamInviteCodeMasked: string; // e.g. SCAM-***-HQ (never store complete code repeatedly)
  populatedFields: Record<string, string>; // entryKey -> value (without sensitive secret query leaks)
  userModifications: string[];
  submissionMode: SubmissionMode;
  verificationOutcome: 'VERIFIED_COMPLETED' | 'MANUAL_CONFIRMED' | 'VERIFICATION_UNKNOWN' | 'FAILED';
  verificationDetails: string;
  formVersionHash?: string;
  prefillUrl?: string;
  prefillUrlSanitized?: string;
  manualSubmissionConfirmed?: boolean;
}

export interface ExtractedCandidate {
  url?: string;
  wallets: {
    address: string;
    suggestedNetwork: CryptoNetwork;
    confidence: number;
    rawContext?: string;
  }[];
  scamTypeIndicators?: string[];
  rawText?: string;
  reasoning: string;
}

// ----------------------------------------------------
// Auto Submit Engine & Duplicate Protection Types
// ----------------------------------------------------

export interface GateDiagnostic {
  rule: string;
  passed: boolean;
  message: string;
}

export interface AutoSubmitGateResult {
  canAutoSubmit: boolean;
  reasons: string[];
  diagnostics: GateDiagnostic[];
  requiredMatchedCount: number;
  totalRequiredCount: number;
}

export interface AutoSubmitSessionState {
  isActive: boolean;
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPING_AFTER_CURRENT' | 'EMERGENCY_STOPPED';
  currentFindingId: string | null;
  currentSiteUrl: string | null;
  processedCount: number;
  totalCount: number;
  completedCount: number;
  needsReviewCount: number;
  blockedCount: number;
  failedCount: number;
  pacingCountdown: number;
  logs: { timestamp: string; message: string; type: 'info' | 'warn' | 'error' | 'success' }[];
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedIn: 'CURRENT_QUEUE' | 'AUDIT_HISTORY' | 'MAIN_PLATFORM' | 'NONE';
  reason?: string;
  matchedId?: string;
  matchedTimestamp?: string;
}

// ----------------------------------------------------
// Main Investigation Platform Contract Events
// ----------------------------------------------------

export type PlatformEventType =
  | 'report.received'
  | 'report.validating'
  | 'report.needs_review'
  | 'report.blocked'
  | 'report.ready'
  | 'report.prefilling'
  | 'report.submitting'
  | 'report.verifying'
  | 'report.completed'
  | 'report.failed';

export interface PlatformStatusEvent {
  eventId: string;
  findingId: string;
  investigationId: string;
  correlationId?: string;
  eventType: PlatformEventType;
  timestamp: string;
  payload: {
    domain: string;
    status: ValidationStatus;
    submissionState?: SubmissionLifecycleState;
    walletsCount: number;
    diagnostics?: string[];
    notes?: string;
  };
}
