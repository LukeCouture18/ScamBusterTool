import {
  InvestigationFinding,
  FormMappingConfig,
  UserSettings,
  AutoSubmitGateResult,
  DuplicateCheckResult,
  HistoryRecord,
} from '../types';
import { sha256Hex } from './cryptoChecksums';
import { evaluateFormMappings } from './googleFormParser';

/**
 * Masks sensitive secrets such as Team Invite Codes for safe UI rendering and log output
 */
export function maskSecret(val: string): string {
  if (!val || val.length <= 4) return '****';
  const prefix = val.slice(0, 4);
  const suffix = val.slice(-2);
  return `${prefix}***${suffix}`;
}

/**
 * Computes an Idempotency Key for a finding and form mapping to prevent duplicate submissions
 * even across application restarts or double clicks.
 */
export function generateIdempotencyKey(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig
): string {
  const domainPart = (finding.domain || '').toLowerCase().trim();
  const sortedWallets = (finding.wallets || [])
    .map((w) => `${w.address.trim()}:${w.selectedNetwork}`)
    .sort()
    .join(',');
  const formPart = formConfig.formId || 'default-form';

  const rawSeed = `${domainPart}##${sortedWallets}##${formPart}`;
  return `IDEMP-${sha256Hex(rawSeed).slice(0, 16)}`;
}

/**
 * Deep Duplicate Checker: Checks across active queue, completed audit history, and Main Platform history
 */
export function checkDuplicateFinding(
  finding: InvestigationFinding,
  currentQueue: InvestigationFinding[],
  auditHistory: HistoryRecord[]
): DuplicateCheckResult {
  const targetDomain = (finding.domain || '').toLowerCase().trim();
  const targetAddresses = new Set((finding.wallets || []).map((w) => w.address.toLowerCase().trim()));

  // 1. Check against active queue (other items)
  for (const item of currentQueue) {
    if (item.id === finding.id) continue;

    const itemDomain = (item.domain || '').toLowerCase().trim();
    if (targetDomain && itemDomain === targetDomain) {
      return {
        isDuplicate: true,
        matchedIn: 'CURRENT_QUEUE',
        reason: `Domain '${targetDomain}' already exists in active queue (ID: ${item.id}, Status: ${item.queueStatus}).`,
        matchedId: item.id,
        matchedTimestamp: item.createdAt,
      };
    }

    for (const w of item.wallets || []) {
      const addr = w.address.toLowerCase().trim();
      if (addr && targetAddresses.has(addr)) {
        return {
          isDuplicate: true,
          matchedIn: 'CURRENT_QUEUE',
          reason: `Wallet address '${w.address.slice(0, 10)}...' is already queued under domain '${item.domain}' (ID: ${item.id}).`,
          matchedId: item.id,
          matchedTimestamp: item.createdAt,
        };
      }
    }
  }

  // 2. Check against completed historical reports
  for (const h of auditHistory) {
    if (h.findingId === finding.id) continue;

    const histDomain = (h.domain || '').toLowerCase().trim();
    if (targetDomain && histDomain === targetDomain) {
      return {
        isDuplicate: true,
        matchedIn: 'AUDIT_HISTORY',
        reason: `Domain '${targetDomain}' was already reported and verified completed on ${new Date(h.timestamp).toLocaleDateString()} (Audit ID: ${h.id}).`,
        matchedId: h.id,
        matchedTimestamp: h.timestamp,
      };
    }

    for (const hw of h.wallets || []) {
      const addr = hw.address.toLowerCase().trim();
      if (addr && targetAddresses.has(addr)) {
        return {
          isDuplicate: true,
          matchedIn: 'AUDIT_HISTORY',
          reason: `Deposit wallet '${hw.address.slice(0, 10)}...' was already reported on ${new Date(h.timestamp).toLocaleDateString()} for target '${h.domain}'.`,
          matchedId: h.id,
          matchedTimestamp: h.timestamp,
        };
      }
    }
  }

  return {
    isDuplicate: false,
    matchedIn: 'NONE',
  };
}

/**
 * Strict Auto Submit Validation Gate
 * Enforces all 10 non-negotiable safety conditions before any automated submission is allowed
 */
export function evaluateAutoSubmitGate(
  finding: InvestigationFinding,
  formConfig: FormMappingConfig,
  settings: UserSettings,
  currentQueue: InvestigationFinding[],
  auditHistory: HistoryRecord[],
  batchSessionActive: boolean
): AutoSubmitGateResult {
  const reasons: string[] = [];

  // Gate 0: Settings & Session enablement
  if (!settings.autoSubmitGlobalEnabled) {
    reasons.push('Auto Submit is disabled in Investigator Settings (Master Safety Switch is OFF).');
  }

  if (!batchSessionActive) {
    reasons.push('Auto Submit is not currently activated for this batch session.');
  }

  // Gate 1: Finding overall status MUST be READY
  if (finding.overallStatus !== 'READY') {
    reasons.push(`Finding overall status is '${finding.overallStatus}' (must be strictly 'READY').`);
  }

  // Gate 2: Website / domain must be valid
  if (!finding.siteUrl || !finding.domain || finding.domain.includes('example.com') || finding.domain.includes('scam-site.com')) {
    reasons.push('Website URL or domain is invalid or placeholder.');
  }

  // Gate 3: Wallets must exist and pass format & checksum validation
  if (!finding.wallets || finding.wallets.length === 0) {
    reasons.push('No cryptocurrency deposit wallets present in finding.');
  } else {
    for (const w of finding.wallets) {
      if (w.status !== 'READY') {
        reasons.push(`Wallet ${w.address.slice(0, 8)}... is not READY (status: ${w.status}).`);
      }
      if (w.checksumValid === false) {
        reasons.push(`Wallet ${w.address.slice(0, 8)}... failed cryptographic checksum verification.`);
      }
      if (w.isAmbiguous) {
        reasons.push(`Wallet ${w.address.slice(0, 8)}... has ambiguous token/network classification.`);
      }
    }
  }

  // Gate 4: Investigator username and team invite code must be configured
  if (!finding.username || !finding.username.trim()) {
    reasons.push('Investigator Username is missing.');
  }
  if (!finding.teamInviteCode || !finding.teamInviteCode.trim()) {
    reasons.push('Team Invite Code is missing.');
  }

  // Gate 5: Form Schema Inspection & Required Form Fields Matched: X/X
  let requiredMatchedCount = 0;
  let totalRequiredCount = 0;

  if (!formConfig.parsedSchema) {
    reasons.push('Google Form has not been inspected by the Form Setup Wizard.');
  } else {
    const evalRes = evaluateFormMappings(formConfig.parsedSchema, formConfig.fieldMappings);
    requiredMatchedCount = evalRes.matchedCount;
    totalRequiredCount = evalRes.totalRequiredCount;

    if (!evalRes.isFullyMatched) {
      reasons.push(
        `Required Form Fields Matched: ${requiredMatchedCount}/${totalRequiredCount}. All required questions must have verified mappings.`
      );
      for (const u of evalRes.unmappedRequiredQuestions) {
        reasons.push(`Unmapped required form question: "${u.title}" (${u.entryKey})`);
      }
    }

    if (evalRes.missingOrChangedQuestions.length > 0) {
      for (const ch of evalRes.missingOrChangedQuestions) {
        reasons.push(ch);
      }
    }

    // Gate 6: Form version hash check
    if (formConfig.formVersionHash && formConfig.parsedSchema.versionHash) {
      if (formConfig.formVersionHash !== formConfig.parsedSchema.versionHash) {
        reasons.push(
          `Google Form structure has changed since last verification (Hash mismatch: ${formConfig.formVersionHash.slice(0, 6)} vs ${formConfig.parsedSchema.versionHash.slice(0, 6)}). Re-inspection required.`
        );
      }
    }
  }

  // Gate 7: Duplicate Check across Queue and Historical Submissions
  const dupCheck = checkDuplicateFinding(finding, currentQueue, auditHistory);
  if (dupCheck.isDuplicate) {
    reasons.push(`Duplicate Guard Blocked: ${dupCheck.reason}`);
  }

  // Gate 8: Submission State Guard (Never re-submit items already submitted or verifying)
  if (finding.submissionState === 'COMPLETED') {
    reasons.push('Finding has already been submitted and marked COMPLETED.');
  }
  if (finding.submissionState === 'SUBMITTING' || finding.submissionState === 'VERIFYING') {
    reasons.push(`Finding is currently in flight (${finding.submissionState}).`);
  }
  if (finding.submissionState === 'UNKNOWN') {
    reasons.push('Previous submission outcome was UNKNOWN. Manual review is required before retrying to prevent duplicate reports.');
  }

  const canAutoSubmit = reasons.length === 0;

  const diagnostics: { rule: string; passed: boolean; message: string }[] = [
    {
      rule: 'Master Safety Switch',
      passed: Boolean(settings.autoSubmitGlobalEnabled),
      message: settings.autoSubmitGlobalEnabled ? 'Global switch enabled in Settings' : 'Global switch is OFF',
    },
    {
      rule: 'Finding Status READY',
      passed: finding.overallStatus === 'READY',
      message: finding.overallStatus === 'READY' ? 'Status is READY' : `Current status: ${finding.overallStatus}`,
    },
    {
      rule: 'Target Domain & URL',
      passed: Boolean(finding.domain && !finding.domain.includes('example.com')),
      message: finding.domain || 'Missing target domain',
    },
    {
      rule: 'Wallets & Checksums',
      passed: Boolean(finding.wallets?.length > 0 && finding.wallets.every((w) => w.status === 'READY' && w.checksumValid !== false)),
      message: `${finding.wallets?.length || 0} wallet(s) format and checksum verified`,
    },
    {
      rule: 'Investigator Attribution',
      passed: Boolean(finding.username && finding.teamInviteCode),
      message: `${finding.username || 'No user'} | ${maskSecret(finding.teamInviteCode || '')}`,
    },
    {
      rule: 'Form Mapping Coverage',
      passed: requiredMatchedCount >= totalRequiredCount && totalRequiredCount > 0,
      message: `${requiredMatchedCount}/${totalRequiredCount} required form questions mapped`,
    },
    {
      rule: 'Form Structure Integrity',
      passed: !formConfig.formVersionHash || !formConfig.parsedSchema?.versionHash || formConfig.formVersionHash === formConfig.parsedSchema.versionHash,
      message: 'Form version hash verified match',
    },
    {
      rule: 'Duplicate Report Guard',
      passed: !dupCheck.isDuplicate,
      message: dupCheck.isDuplicate ? (dupCheck.reason || 'Duplicate detected') : 'No duplicate in queue or history',
    },
  ];

  return {
    canAutoSubmit,
    reasons,
    diagnostics,
    requiredMatchedCount,
    totalRequiredCount,
  };
}
