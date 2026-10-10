import { FormMappingConfig, FormFieldMapping, InvestigationFinding } from '../types';

export const DEFAULT_GOOGLE_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSc_CryptoScamReportForm_v1/viewform';

export const DEFAULT_FIELD_MAPPINGS: FormFieldMapping[] = [
  {
    id: 'f-1',
    fieldKey: 'siteUrl',
    label: 'Scam Website URL / Domain',
    entryKey: 'entry.1849204812',
    pageIndex: 1,
    required: true,
    notes: 'Normalized URL or target website domain',
  },
  {
    id: 'f-2',
    fieldKey: 'walletsList',
    label: 'Cryptocurrency Deposit Wallets & Networks',
    entryKey: 'entry.2093847119',
    pageIndex: 1,
    required: true,
    notes: 'List of all detected deposit addresses with verified networks',
  },
  {
    id: 'f-3',
    fieldKey: 'username',
    label: 'Investigator Username',
    entryKey: 'entry.583920194',
    pageIndex: 1,
    required: true,
    notes: 'Authorized investigator alias',
  },
  {
    id: 'f-4',
    fieldKey: 'teamInviteCode',
    label: 'Team / Unit Invite Code',
    entryKey: 'entry.948201948',
    pageIndex: 1,
    required: true,
    notes: 'Authorization code for report tracking',
  },
  {
    id: 'f-5',
    fieldKey: 'evidenceNotes',
    label: 'Evidence & Investigation Notes',
    entryKey: 'entry.1029482741',
    pageIndex: 2,
    required: false,
    notes: 'Screenshot references, scam characteristics, or deposit instructions',
  },
  {
    id: 'f-6',
    fieldKey: 'investigationId',
    label: 'Investigation / Provenance ID',
    entryKey: 'entry.394820184',
    pageIndex: 2,
    required: false,
    notes: 'Main Investigation Platform tracking ID',
  },
];

export const DEFAULT_FORM_CONFIG: FormMappingConfig = {
  formUrl: DEFAULT_GOOGLE_FORM_URL,
  formId: '1FAIpQLSc_CryptoScamReportForm_v1',
  formTitle: 'Defensive Crypto Scam Intake Form',
  fieldMappings: DEFAULT_FIELD_MAPPINGS,
  multiWalletFormat: 'COMBINED_LIST',
};

/**
 * Extracts the Form ID from various Google Form URL formats:
 * - https://docs.google.com/forms/d/e/1FAIpQLScXXXX/viewform
 * - https://docs.google.com/forms/d/1FAIpQLScXXXX/edit
 * - https://forms.gle/XXXX
 */
export function extractGoogleFormId(url: string): string | null {
  if (!url) return null;
  const clean = url.trim();

  // Pattern 1: /forms/d/e/([a-zA-Z0-9_-]+)
  const matchE = clean.match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (matchE && matchE[1]) return matchE[1];

  // Pattern 2: /forms/d/([a-zA-Z0-9_-]+)
  const matchD = clean.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  if (matchD && matchD[1]) return matchD[1];

  // Pattern 3: forms.gle/([a-zA-Z0-9_-]+)
  const matchGle = clean.match(/forms\.gle\/([a-zA-Z0-9_-]+)/);
  if (matchGle && matchGle[1]) return matchGle[1];

  return null;
}

/**
 * Formats wallets for insertion into the Google Form field according to chosen strategy
 */
export function formatWalletsPayload(
  finding: InvestigationFinding,
  format: FormMappingConfig['multiWalletFormat']
): string {
  if (!finding.wallets || finding.wallets.length === 0) return '';

  if (format === 'PRIMARY_ONLY') {
    const primary = finding.wallets[0];
    return `[${primary.selectedNetwork}] ${primary.address}`;
  }

  if (format === 'LINE_BY_LINE_NETWORK') {
    return finding.wallets
      .map((w, i) => `${w.selectedNetwork}: ${w.address}`)
      .join('\n');
  }

  // DEFAULT: COMBINED_LIST with verification summary
  return finding.wallets
    .map((w, idx) => {
      const checksumLabel = w.checksumValid === true ? ' [Checksum Verified]' : '';
      return `${idx + 1}. [${w.selectedNetwork}] ${w.address}${checksumLabel}`;
    })
    .join('\n');
}

/**
 * Resolves the string value for a mapped field key
 */
export function resolveFieldValue(
  mapping: FormFieldMapping,
  finding: InvestigationFinding,
  config: FormMappingConfig
): string {
  switch (mapping.fieldKey) {
    case 'siteUrl':
      return finding.siteUrl || finding.domain || '';
    case 'domain':
      return finding.domain || '';
    case 'walletsList':
      return formatWalletsPayload(finding, config.multiWalletFormat);
    case 'primaryWallet':
      return finding.wallets[0]?.address || '';
    case 'primaryNetwork':
      return finding.wallets[0]?.selectedNetwork || '';
    case 'username':
      return finding.username || '';
    case 'teamInviteCode':
      return finding.teamInviteCode || '';
    case 'evidenceNotes': {
      const parts: string[] = [];
      if (finding.notes) parts.push(finding.notes);
      if (finding.screenshotUrls?.length > 0) {
        parts.push(`[${finding.screenshotUrls.length} screenshot(s) attached]`);
      }
      return parts.join('\n\n');
    }
    case 'investigationId':
      return finding.provenance?.investigationId || finding.id;
    case 'customNotes':
      return finding.notes || '';
    default:
      return '';
  }
}

export interface PrefillGenerationResult {
  success: boolean;
  prefillUrl: string;
  populatedFields: Record<string, { label: string; value: string; pageIndex: number }>;
  missingRequiredFields: string[];
  issues: string[];
  warnings: string[];
}

/**
 * Generates an authorized prefilled Google Form URL
 * format: https://docs.google.com/forms/d/e/{FORM_ID}/viewform?usp=pp_url&entry.123=VAL&entry.456=VAL
 */
export function generatePrefillUrl(
  finding: InvestigationFinding,
  config: FormMappingConfig
): PrefillGenerationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const missingRequiredFields: string[] = [];
  const populatedFields: Record<string, { label: string; value: string; pageIndex: number }> = {};

  const formId = extractGoogleFormId(config.formUrl) || config.formId;
  if (!formId) {
    issues.push('Could not extract a valid Google Form ID from the configured URL');
    return {
      success: false,
      prefillUrl: config.formUrl,
      populatedFields: {},
      missingRequiredFields: [],
      issues,
      warnings,
    };
  }

  // Base viewform URL
  const baseUrl = config.formUrl.includes('/viewform')
    ? config.formUrl.split('?')[0]
    : `https://docs.google.com/forms/d/e/${formId}/viewform`;

  const queryParams = new URLSearchParams();
  queryParams.set('usp', 'pp_url');

  for (const mapping of config.fieldMappings) {
    const val = resolveFieldValue(mapping, finding, config);

    if (mapping.required && (!val || !val.trim())) {
      missingRequiredFields.push(mapping.label);
    }

    if (mapping.entryKey && val) {
      queryParams.set(mapping.entryKey, val);
      populatedFields[mapping.entryKey] = {
        label: mapping.label,
        value: val,
        pageIndex: mapping.pageIndex,
      };
    } else if (mapping.required && !mapping.entryKey) {
      issues.push(`Required field "${mapping.label}" has no entry.XXXXXXX key configured`);
    }
  }

  if (missingRequiredFields.length > 0) {
    issues.push(`Missing required fields: ${missingRequiredFields.join(', ')}`);
  }

  const finalUrl = `${baseUrl}?${queryParams.toString()}`;

  return {
    success: issues.length === 0,
    prefillUrl: finalUrl,
    populatedFields,
    missingRequiredFields,
    issues,
    warnings,
  };
}
