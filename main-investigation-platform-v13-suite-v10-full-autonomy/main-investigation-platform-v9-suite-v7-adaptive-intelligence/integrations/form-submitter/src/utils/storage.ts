import {
  UserSettings,
  FormMappingConfig,
  InvestigationFinding,
  HistoryRecord,
  PlatformStatusEvent,
} from '../types';
import { DEFAULT_FORM_CONFIG } from './formMapping';
import { DEFAULT_AUTHORIZED_FORM_SCHEMA } from './googleFormParser';

const SETTINGS_KEY = 'crypto_scam_submitter_settings_v1_1';
const FORM_CONFIG_KEY = 'crypto_scam_submitter_form_config_v1_1';
const QUEUE_KEY = 'crypto_scam_submitter_queue_v1_1';
const HISTORY_KEY = 'crypto_scam_submitter_history_v1_1';

export const DEFAULT_SETTINGS: UserSettings = {
  username: '',
  teamInviteCode: '',
  defaultFormUrl: DEFAULT_AUTHORIZED_FORM_SCHEMA.formUrl,
  defaultSubmissionMode: 'VALIDATED_PREFILL',
  strictEVMMode: true,
  isConfigured: false,
  autoSubmitGlobalEnabled: false, // Default disabled for safety
  batchPacingSeconds: 5,
  enableDuplicateGuard: true,
};

export const INITIAL_FORM_CONFIG: FormMappingConfig = {
  formUrl: DEFAULT_AUTHORIZED_FORM_SCHEMA.formUrl,
  formId: DEFAULT_AUTHORIZED_FORM_SCHEMA.formId,
  formTitle: DEFAULT_AUTHORIZED_FORM_SCHEMA.formTitle,
  formVersionHash: DEFAULT_AUTHORIZED_FORM_SCHEMA.versionHash,
  verifiedAt: new Date().toISOString(),
  fieldMappings: [
    {
      id: 'map-siteUrl',
      fieldKey: 'siteUrl',
      label: 'Scam Website URL',
      entryKey: 'entry.1849204812',
      pageIndex: 1,
      required: true,
      matchedQuestionTitle: 'Scam Website URL / Domain',
    },
    {
      id: 'map-walletsList',
      fieldKey: 'walletsList',
      label: 'Cryptocurrency Deposit Wallets',
      entryKey: 'entry.928471029',
      pageIndex: 2,
      required: true,
      matchedQuestionTitle: 'Cryptocurrency Deposit Wallets',
    },
    {
      id: 'map-primaryWallet',
      fieldKey: 'primaryWallet',
      label: 'Primary Deposit Wallet Address',
      entryKey: 'entry.394820194',
      pageIndex: 2,
      required: true,
      matchedQuestionTitle: 'Primary Deposit Wallet Address',
    },
    {
      id: 'map-primaryNetwork',
      fieldKey: 'primaryNetwork',
      label: 'Primary Blockchain Network',
      entryKey: 'entry.582910482',
      pageIndex: 2,
      required: true,
      matchedQuestionTitle: 'Primary Blockchain Network',
    },
    {
      id: 'map-username',
      fieldKey: 'username',
      label: 'Investigator Username',
      entryKey: 'entry.749201847',
      pageIndex: 3,
      required: true,
      matchedQuestionTitle: 'Investigator Username',
    },
    {
      id: 'map-teamInviteCode',
      fieldKey: 'teamInviteCode',
      label: 'Team Invite Code',
      entryKey: 'entry.628491038',
      pageIndex: 3,
      required: true,
      matchedQuestionTitle: 'Team Invite Code',
    },
    {
      id: 'map-evidenceNotes',
      fieldKey: 'evidenceNotes',
      label: 'Supporting Evidence & Notes',
      entryKey: 'entry.482019482',
      pageIndex: 3,
      required: false,
      matchedQuestionTitle: 'Supporting Evidence & Notes',
    },
    {
      id: 'map-investigationId',
      fieldKey: 'investigationId',
      label: 'Investigation Provenance ID',
      entryKey: 'entry.102938475',
      pageIndex: 3,
      required: false,
      matchedQuestionTitle: 'Investigation Provenance ID',
    },
  ],
  multiWalletFormat: 'COMBINED_LIST',
  parsedSchema: DEFAULT_AUTHORIZED_FORM_SCHEMA,
  isFormChanged: false,
};

// Initial sample findings with complete v1.1 status
export const SAMPLE_FINDINGS: InvestigationFinding[] = [
  {
    id: 'FIND-8801',
    siteUrl: 'https://crypto-doubler-cloud.vip/invest',
    domain: 'crypto-doubler-cloud.vip',
    wallets: [
      {
        id: 'w-sample-1',
        address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        selectedNetwork: 'BTC',
        detectedNetworks: ['BTC'],
        checksumValid: true,
        isAmbiguous: false,
        validationNotes: ['Bitcoin Legacy P2PKH: Base58Check verified'],
        status: 'READY',
        confidence: 1.0,
      },
      {
        id: 'w-sample-2',
        address: 'TR7NHqjekqxGxSTvBgPnpxnx8pcEPU13xv',
        selectedNetwork: 'USDT_TRC20',
        detectedNetworks: ['TRX', 'USDT_TRC20'],
        checksumValid: true,
        isAmbiguous: false,
        validationNotes: ['TRON Base58Check double-SHA256 verified'],
        status: 'READY',
        confidence: 1.0,
      },
    ],
    screenshotUrls: [],
    notes: 'Fake cloud investment scam platform promising 200% returns in 24 hours. Harvested from deposit modal.',
    username: '',
    teamInviteCode: '',
    provenance: {
      investigationId: 'INV-2026-081',
      siteId: 'SITE-991',
      walletIds: ['w-sample-1', 'w-sample-2'],
      evidenceIds: ['EVID-101'],
      sourceModule: 'Site Investigator',
      timestamp: new Date().toISOString(),
      confidence: 0.95,
      mainPlatformSyncStatus: 'SYNCED',
      schemaVersion: '1.1.0',
    },
    overallStatus: 'READY',
    queueStatus: 'READY',
    submissionState: 'NOT_STARTED',
    validationDiagnostics: [
      {
        rule: 'Website URL Format',
        passed: true,
        status: 'READY',
        message: 'Valid domain: crypto-doubler-cloud.vip',
      },
      {
        rule: 'Wallet Integrity & Checksum',
        passed: true,
        status: 'READY',
        message: '2/2 deposit wallets verified with cryptographic checksum',
      },
    ],
    submissionMode: 'VALIDATED_PREFILL',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'FIND-8802',
    siteUrl: 'https://arbitrum-airdrop-claim-now.xyz/auth',
    domain: 'arbitrum-airdrop-claim-now.xyz',
    wallets: [
      {
        id: 'w-sample-3',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        selectedNetwork: 'UNKNOWN',
        detectedNetworks: ['ETH', 'USDT_ERC20', 'USDT_BEP20'],
        checksumValid: true,
        isAmbiguous: true,
        ambiguityReason: '0x... address without explicit chain/token selection. Ambiguous between ETH, ERC20, BSC.',
        validationNotes: [
          'EIP-55 valid checksum (40 hex chars)',
          'Requires explicit chain confirmation before reporting',
        ],
        status: 'NEEDS_REVIEW',
        confidence: 0.7,
      },
    ],
    screenshotUrls: [],
    notes: 'Phishing claim button prompts signature to drain tokens.',
    username: '',
    teamInviteCode: '',
    provenance: {
      investigationId: 'INV-2026-082',
      siteId: 'SITE-992',
      walletIds: ['w-sample-3'],
      evidenceIds: [],
      sourceModule: 'Site Finder',
      timestamp: new Date().toISOString(),
      confidence: 0.8,
      mainPlatformSyncStatus: 'PENDING_SYNC',
      schemaVersion: '1.1.0',
    },
    overallStatus: 'NEEDS_REVIEW',
    queueStatus: 'NEEDS_REVIEW',
    submissionState: 'NOT_STARTED',
    validationDiagnostics: [
      {
        rule: 'Token / Network Ambiguity',
        passed: false,
        status: 'NEEDS_REVIEW',
        message: 'EVM 0x address requires explicit chain confirmation.',
      },
    ],
    submissionMode: 'MANUAL_REVIEW',
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// ----------------------------------------------------
// Local & Durable Storage Accessors
// ----------------------------------------------------

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // Asynchronously push to durable server store
    fetch('/api/storage/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }).catch(() => {});
  } catch {}
}

export function loadFormConfig(): FormMappingConfig {
  try {
    const raw = localStorage.getItem(FORM_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.parsedSchema) {
        parsed.parsedSchema = DEFAULT_AUTHORIZED_FORM_SCHEMA;
      }
      return parsed;
    }
  } catch {}
  return INITIAL_FORM_CONFIG;
}

export function saveFormConfig(config: FormMappingConfig): void {
  try {
    localStorage.setItem(FORM_CONFIG_KEY, JSON.stringify(config));
    // Asynchronously push to durable server store
    fetch('/api/storage/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formConfig: config }),
    }).catch(() => {});
  } catch {}
}

export function loadQueue(): InvestigationFinding[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {}
  return SAMPLE_FINDINGS;
}

export function saveQueue(queue: InvestigationFinding[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    // Asynchronously push to durable server store
    fetch('/api/storage/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findings: queue }),
    }).catch(() => {});
  } catch {}
}

export function loadHistory(): HistoryRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function appendHistory(record: HistoryRecord): void {
  try {
    const existing = loadHistory();
    const updated = [record, ...existing];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));

    // Asynchronously push to durable server store
    fetch('/api/storage/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {});
  } catch {}
}

/**
 * Initializes and synchronizes state with the durable server-side database
 */
export async function syncWithDurableServer(): Promise<{
  findings?: InvestigationFinding[];
  settings?: UserSettings;
  formConfig?: FormMappingConfig;
  history?: HistoryRecord[];
  recoveryLogs: string[];
}> {
  try {
    const res = await fetch('/api/storage/state');
    if (!res.ok) return { recoveryLogs: [] };
    const data = await res.json();
    if (!data.success || !data.state) return { recoveryLogs: [] };

    const serverState = data.state;
    const recoveryLogs: string[] = data.recoveryLogs || [];

    // If server has stored findings, prioritize server state for crash recovery
    if (Array.isArray(serverState.findings) && serverState.findings.length > 0) {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(serverState.findings));
    }
    if (serverState.settings) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(serverState.settings));
    }
    if (serverState.formConfig) {
      localStorage.setItem(FORM_CONFIG_KEY, JSON.stringify(serverState.formConfig));
    }
    if (Array.isArray(serverState.auditHistory) && serverState.auditHistory.length > 0) {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(serverState.auditHistory));
    }

    return {
      findings: serverState.findings?.length ? serverState.findings : undefined,
      settings: serverState.settings || undefined,
      formConfig: serverState.formConfig || undefined,
      history: serverState.auditHistory || undefined,
      recoveryLogs,
    };
  } catch (err) {
    console.warn('[Sync] Offline or unable to contact server durable storage:', err);
    return { recoveryLogs: [] };
  }
}

/**
 * Emits a lifecycle status event to the Main Platform
 */
export async function emitPlatformEvent(event: PlatformStatusEvent): Promise<void> {
  try {
    await fetch('/api/platform/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {}
}
