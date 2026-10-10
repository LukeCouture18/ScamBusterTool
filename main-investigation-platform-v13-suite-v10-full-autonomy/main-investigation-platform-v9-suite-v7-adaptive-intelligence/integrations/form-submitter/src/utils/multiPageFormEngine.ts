import {
  InvestigationFinding,
  FormMappingConfig,
  FormSection,
  SubmissionLifecycleState,
  UserSettings,
} from '../types';
import { formatWalletsPayload } from './formMapping';

export interface FormSubmissionPreviewItem {
  pageIndex: number;
  pageTitle: string;
  questionTitle: string;
  entryKey: string;
  required: boolean;
  value: string;
  isFieldMapped: boolean;
  validationStatus: 'VALID' | 'MISSING' | 'OPTIONAL_EMPTY';
}

/**
 * Computes exact field values for every mapped field in the form
 */
export function buildFieldValuesMap(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig
): Record<string, string> {
  const values: Record<string, string> = {};
  const walletsFormatted = formatWalletsPayload(
    finding,
    formConfig.multiWalletFormat
  );
  const primaryWallet = finding.wallets?.[0]?.address || '';
  const primaryNetwork = finding.wallets?.[0]?.selectedNetwork || '';

  for (const map of formConfig.fieldMappings) {
    if (!map.entryKey) continue;

    let val = '';
    switch (map.fieldKey) {
      case 'siteUrl':
        val = finding.siteUrl || '';
        break;
      case 'domain':
        val = finding.domain || '';
        break;
      case 'walletsList':
        val = walletsFormatted;
        break;
      case 'primaryWallet':
        val = primaryWallet;
        break;
      case 'primaryNetwork':
        val = primaryNetwork;
        break;
      case 'username':
        val = finding.username || '';
        break;
      case 'teamInviteCode':
        val = finding.teamInviteCode || '';
        break;
      case 'evidenceNotes':
        val = finding.notes || 'Defensive scam investigation deposit evidence.';
        break;
      case 'investigationId':
        val = finding.provenance?.investigationId || finding.id;
        break;
      case 'customNotes':
        val = finding.notes || '';
        break;
      default:
        val = '';
    }
    values[map.entryKey] = val;
  }

  return values;
}

/**
 * Generates an Exact Form Preview:
 * Form Question → Value That Will Be Entered
 * Organized page-by-page so the investigator sees precisely what will be submitted.
 */
export function generateExactFormPreview(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig
): {
  sections: {
    pageIndex: number;
    pageTitle: string;
    items: FormSubmissionPreviewItem[];
    pageValid: boolean;
  }[];
  totalRequiredFields: number;
  matchedRequiredFields: number;
  allValid: boolean;
} {
  const fieldValues = buildFieldValuesMap(finding, formConfig);
  const schema = formConfig.parsedSchema;

  // If we have parsed schema sections, use them
  const sectionsToProcess: FormSection[] = schema?.sections?.length
    ? schema.sections
    : [
        {
          pageIndex: 1,
          title: 'Form Section 1',
          questions: formConfig.fieldMappings.map((m) => ({
            id: m.id,
            entryKey: m.entryKey,
            title: m.label,
            type: 'SHORT_ANSWER',
            required: m.required,
            pageIndex: 1,
          })),
        },
      ];

  let totalRequiredFields = 0;
  let matchedRequiredFields = 0;
  let allValid = true;

  const renderedSections = sectionsToProcess.map((section) => {
    let pageValid = true;
    const items: FormSubmissionPreviewItem[] = [];

    for (const q of section.questions) {
      if (q.type === 'PAGE_BREAK') continue;

      const isMapped = Boolean(formConfig.fieldMappings.find((m) => m.entryKey === q.entryKey));
      const val = fieldValues[q.entryKey] ?? '';

      if (q.required) {
        totalRequiredFields++;
        if (isMapped && val.trim().length > 0) {
          matchedRequiredFields++;
        }
      }

      let status: FormSubmissionPreviewItem['validationStatus'] = 'VALID';
      if (q.required && (!isMapped || !val.trim())) {
        status = 'MISSING';
        pageValid = false;
        allValid = false;
      } else if (!q.required && !val.trim()) {
        status = 'OPTIONAL_EMPTY';
      }

      items.push({
        pageIndex: section.pageIndex,
        pageTitle: section.title,
        questionTitle: q.title,
        entryKey: q.entryKey,
        required: q.required,
        value: val,
        isFieldMapped: isMapped,
        validationStatus: status,
      });
    }

    return {
      pageIndex: section.pageIndex,
      pageTitle: section.title,
      items,
      pageValid,
    };
  });

  return {
    sections: renderedSections,
    totalRequiredFields,
    matchedRequiredFields,
    allValid,
  };
}

/**
 * Executes a real submission to the authorized Google Form via backend proxy
 */
export async function executeRealSubmission(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig,
  idempotencyKey: string
): Promise<{
  outcome: 'VERIFIED_COMPLETED' | 'VERIFICATION_UNKNOWN' | 'FAILED' | 'CHALLENGE_REQUIRED';
  details: string;
  statusCode?: number;
  confirmationMessage?: string;
}> {
  const fieldValues = buildFieldValuesMap(finding, formConfig);

  try {
    const res = await fetch('/api/forms/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        findingId: finding.id,
        formUrl: formConfig.formUrl,
        formId: formConfig.formId,
        formVersionHash: formConfig.formVersionHash,
        fieldValues,
        idempotencyKey,
        domain: finding.domain,
        username: finding.username,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      if (data.requiresChallenge || data.isCaptcha) {
        return {
          outcome: 'CHALLENGE_REQUIRED',
          details: data.error || 'Google Form requested authentication, CAPTCHA, or verification. Automated submission stopped.',
          statusCode: res.status,
        };
      }

      return {
        outcome: data.outcome === 'VERIFICATION_UNKNOWN' ? 'VERIFICATION_UNKNOWN' : 'FAILED',
        details: data.error || 'Google Forms returned an unexpected error response.',
        statusCode: res.status,
      };
    }

    return {
      outcome: 'VERIFIED_COMPLETED',
      details: data.message || 'Submission verified successfully. Google Forms confirmed receipt.',
      statusCode: res.status,
      confirmationMessage: data.confirmationMessage,
    };
  } catch (err: unknown) {
    return {
      outcome: 'VERIFICATION_UNKNOWN',
      details: `Network or communication timeout during submission verification: ${err instanceof Error ? err.message : String(err)}. Status marked UNKNOWN to prevent duplicates.`,
    };
  }
}

/**
 * Convenient wrapper for component submission actions
 */
export async function executeRealFormSubmission(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig,
  settings: UserSettings,
  idempotencyKey: string
): Promise<{
  success: boolean;
  outcome: 'VERIFIED_COMPLETED' | 'VERIFICATION_UNKNOWN' | 'FAILED' | 'CHALLENGE_REQUIRED';
  details?: string;
  error?: string;
  confirmationMessage?: string;
  isCaptcha?: boolean;
  requiresChallenge?: boolean;
}> {
  const result = await executeRealSubmission(finding, formConfig, idempotencyKey);
  const success = result.outcome === 'VERIFIED_COMPLETED';
  return {
    success,
    outcome: result.outcome,
    details: result.details,
    error: success ? undefined : result.details,
    confirmationMessage: result.confirmationMessage,
    isCaptcha: result.details?.toLowerCase().includes('captcha'),
    requiresChallenge: result.outcome === 'CHALLENGE_REQUIRED',
  };
}
