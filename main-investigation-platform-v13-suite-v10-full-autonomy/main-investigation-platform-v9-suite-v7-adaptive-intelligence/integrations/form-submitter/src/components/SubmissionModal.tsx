import React, { useState } from 'react';
import {
  X,
  FileCheck,
  ExternalLink,
  Copy,
  Check,
  AlertCircle,
  ShieldCheck,
  ArrowRight,
  ShieldAlert,
  ClipboardList,
  Eye,
  Edit3,
  Zap,
  Loader2,
  Lock,
} from 'lucide-react';
import {
  InvestigationFinding,
  FormMappingConfig,
  UserSettings,
  HistoryRecord,
  SubmissionMode,
} from '../types';
import { generatePrefillUrl } from '../utils/formMapping';
import {
  evaluateAutoSubmitGate,
  generateIdempotencyKey,
  maskSecret,
} from '../utils/autoSubmitGate';
import {
  executeRealFormSubmission,
  generateExactFormPreview,
} from '../utils/multiPageFormEngine';

interface SubmissionModalProps {
  finding: InvestigationFinding;
  formConfig: FormMappingConfig;
  settings: UserSettings;
  existingQueue?: InvestigationFinding[];
  history?: HistoryRecord[];
  onClose: () => void;
  onConfirmSubmitted: (record: HistoryRecord) => void;
  onEditFinding: (finding: InvestigationFinding) => void;
}

export const SubmissionModal: React.FC<SubmissionModalProps> = ({
  finding,
  formConfig,
  settings,
  existingQueue = [],
  history = [],
  onClose,
  onConfirmSubmitted,
  onEditFinding,
}) => {
  const [submissionMode, setSubmissionMode] = useState<SubmissionMode>(
    finding.submissionMode || settings.defaultSubmissionMode || 'VALIDATED_PREFILL'
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [hasOpenedForm, setHasOpenedForm] = useState(false);
  const [userNotesModification, setUserNotesModification] = useState('');
  const [confirmedByAnalyst, setConfirmedByAnalyst] = useState(false);

  // Auto-submit state
  const [isSubmittingAuto, setIsSubmittingAuto] = useState(false);
  const [autoSubmitStatus, setAutoSubmitStatus] = useState<string | null>(null);
  const [autoSubmitError, setAutoSubmitError] = useState<string | null>(null);
  const [historyId] = useState(() => `HIST-${crypto.randomUUID()}`);

  // Generate the prefilled data and exact preview
  const findingWithAttribution: InvestigationFinding = {
    ...finding,
    username: finding.username || settings.username,
    teamInviteCode: finding.teamInviteCode || settings.teamInviteCode,
  };

  const prefillResult = generatePrefillUrl(findingWithAttribution, formConfig);
  const exactPreview = generateExactFormPreview(findingWithAttribution, formConfig);

  // Auto-submit gate evaluation
  const gateEvaluation = evaluateAutoSubmitGate(
    findingWithAttribution,
    formConfig,
    settings,
    existingQueue,
    history,
    true
  );

  const idempotencyKey = generateIdempotencyKey(findingWithAttribution, formConfig);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleLaunchPrefilledForm = () => {
    window.open(prefillResult.prefillUrl, '_blank', 'noopener,noreferrer');
    setHasOpenedForm(true);
  };

  const handleExecuteAutoSubmit = async () => {
    setIsSubmittingAuto(true);
    setAutoSubmitStatus('Evaluating safety gates & verifying checksums...');
    setAutoSubmitError(null);

    try {
      setAutoSubmitStatus('Transmitting payload through authorized backend proxy...');
      const outcome = await executeRealFormSubmission(
        findingWithAttribution,
        formConfig,
        settings,
        idempotencyKey
      );

      if (outcome.success) {
        setAutoSubmitStatus('Verifying response confirmation header...');
        const record: HistoryRecord = {
          id: historyId,
          findingId: finding.id,
          timestamp: new Date().toISOString(),
          siteUrl: finding.siteUrl,
          domain: finding.domain,
          wallets: finding.wallets.map((w) => ({
            address: w.address,
            network: w.selectedNetwork,
            checksumStatus: w.checksumValid === true ? 'Verified' : 'Unchecked/Standard',
          })),
          username: findingWithAttribution.username,
          teamInviteCodeMasked: maskSecret(findingWithAttribution.teamInviteCode),
          populatedFields: Object.entries(prefillResult.populatedFields).reduce(
            (acc, [k, v]) => ({ ...acc, [k]: v.value }),
            {}
          ),
          userModifications: ['Automated Submission via Verified Gate'],
          submissionMode: 'AUTO_SUBMIT',
          manualSubmissionConfirmed: true,
          prefillUrl: prefillResult.prefillUrl,
          idempotencyKey,
          verificationOutcome: 'VERIFIED_COMPLETED',
          verificationDetails: outcome.confirmationMessage || 'Google Form response recorded.',
        };

        onConfirmSubmitted(record);
      } else {
        setAutoSubmitError(outcome.error || 'Submission could not be verified.');
      }
    } catch (err: unknown) {
      setAutoSubmitError(err instanceof Error ? err.message : 'Unknown network error during submission.');
    } finally {
      setIsSubmittingAuto(false);
    }
  };

  const handleCompleteManualSubmission = () => {
    const record: HistoryRecord = {
      id: historyId,
      findingId: finding.id,
      timestamp: new Date().toISOString(),
      siteUrl: finding.siteUrl,
      domain: finding.domain,
      wallets: finding.wallets.map((w) => ({
        address: w.address,
        network: w.selectedNetwork,
        checksumStatus: w.checksumValid === true ? 'Verified' : 'Unchecked/Standard',
      })),
      username: findingWithAttribution.username,
      teamInviteCodeMasked: maskSecret(findingWithAttribution.teamInviteCode),
      populatedFields: Object.entries(prefillResult.populatedFields).reduce(
        (acc, [k, v]) => ({ ...acc, [k]: v.value }),
        {}
      ),
      userModifications: userNotesModification.trim() ? [userNotesModification.trim()] : [],
      submissionMode,
      manualSubmissionConfirmed: true,
      prefillUrl: prefillResult.prefillUrl,
      idempotencyKey,
      verificationOutcome: 'VERIFIED_COMPLETED',
      verificationDetails: 'Analyst manual inspection & submit confirmed.',
    };

    onConfirmSubmitted(record);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="p-5 bg-slate-850 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
              <FileCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">
                Pre-Submission Inspector &amp; Authorized Form Submitter
              </h3>
              <p className="text-xs text-slate-400">
                Target: <span className="font-mono text-slate-200">{finding.domain || finding.siteUrl}</span>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {/* Mode Selector Toggle */}
          <div className="bg-slate-950 p-1.5 rounded-xl border border-slate-800 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSubmissionMode('VALIDATED_PREFILL')}
              id="mode-toggle-prefill"
              className={`flex-1 min-w-[140px] py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                submissionMode === 'VALIDATED_PREFILL'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Validated Prefill</span>
            </button>

            <button
              onClick={() => setSubmissionMode('MANUAL_REVIEW')}
              id="mode-toggle-manual"
              className={`flex-1 min-w-[140px] py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                submissionMode === 'MANUAL_REVIEW'
                  ? 'bg-slate-800 text-white shadow-xs border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              <span>Manual Review</span>
            </button>

            <button
              onClick={() => setSubmissionMode('AUTO_SUBMIT')}
              id="mode-toggle-auto"
              className={`flex-1 min-w-[140px] py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                submissionMode === 'AUTO_SUBMIT'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Zap className="w-4 h-4" />
              <span>Auto Submit (10-Point Gate)</span>
            </button>
          </div>

          {/* AUTO SUBMIT GATE VIEW */}
          {submissionMode === 'AUTO_SUBMIT' && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  <span className="font-bold text-xs text-slate-200">10-Point Safety Gate Verification</span>
                </div>
                <span
                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                    gateEvaluation.canAutoSubmit
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}
                >
                  {gateEvaluation.canAutoSubmit ? 'ALL 10 GATES PASSED' : 'GATE BLOCKED'}
                </span>
              </div>

              {/* Gate Checks Checklist */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {gateEvaluation.diagnostics.map((diag, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded bg-slate-900 border border-slate-800 flex items-start gap-2"
                  >
                    <span
                      className={`text-xs font-bold shrink-0 mt-0.5 ${
                        diag.passed ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {diag.passed ? '✓' : '✕'}
                    </span>
                    <div>
                      <span className="font-semibold text-slate-200 block text-[11px]">{diag.rule}</span>
                      <span className="text-[10px] text-slate-400 block">{diag.message}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Auto submit action */}
              <div className="pt-2 border-t border-slate-850 flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-[11px] text-slate-400">
                  <span className="font-mono text-slate-300">Idempotency: </span>
                  {idempotencyKey.slice(0, 18)}...
                </div>

                {gateEvaluation.canAutoSubmit ? (
                  <button
                    onClick={handleExecuteAutoSubmit}
                    disabled={isSubmittingAuto}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-md flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {isSubmittingAuto ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Submitting to Form...</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" />
                        <span>Execute Verified Auto-Submit</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="text-xs text-rose-400 font-medium">
                    Auto-submit blocked: Use Validated Prefill mode instead.
                  </div>
                )}
              </div>

              {autoSubmitStatus && (
                <div className="text-xs text-sky-400 bg-sky-950/40 p-2.5 rounded border border-sky-800 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{autoSubmitStatus}</span>
                </div>
              )}

              {autoSubmitError && (
                <div className="text-xs text-rose-300 bg-rose-950/40 p-2.5 rounded border border-rose-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{autoSubmitError}</span>
                </div>
              )}
            </div>
          )}

          {/* EXACT MULTI-PAGE PREVIEW */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-emerald-400" />
                Section-by-Section Form Preview
              </h4>
              <span className="text-[11px] font-mono text-slate-500">
                Form: {formConfig.formTitle || 'Authorized Google Form'}
              </span>
            </div>

            <div className="space-y-3">
              {exactPreview.sections.map((sec) => (
                <div key={sec.pageIndex} className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200 text-xs">{sec.pageTitle}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                      Page {sec.pageIndex}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {sec.items.map((q) => (
                      <div
                        key={q.entryKey}
                        className="bg-slate-950/70 p-2.5 rounded border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-300 font-medium text-xs">{q.questionTitle}</span>
                            {q.required && <span className="text-rose-400 text-xs">*</span>}
                            <span className="text-[10px] font-mono text-slate-500">({q.entryKey})</span>
                          </div>
                          <pre className="text-slate-200 font-mono text-xs whitespace-pre-wrap break-all bg-slate-900/60 p-1.5 rounded border border-slate-800">
                            {q.value || <span className="text-slate-500 italic">Empty</span>}
                          </pre>
                        </div>

                        <button
                          onClick={() => handleCopy(q.value, q.entryKey)}
                          className="self-end sm:self-center px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors shrink-0 flex items-center gap-1 text-[11px]"
                          title="Copy question value"
                        >
                          {copiedKey === q.entryKey ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="text-emerald-400">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Validated Prefill Actions */}
          {submissionMode === 'VALIDATED_PREFILL' && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-slate-300">
                Step 1: Open Google Form with Pre-populated Data
              </h4>
              <p className="text-xs text-slate-400">
                Click below to open the official Google Form in a new tab. All questions above will be populated for inspection.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleLaunchPrefilledForm}
                  id="launch-prefilled-form-button"
                  className="px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md flex items-center gap-2 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Open Pre-filled Google Form</span>
                </button>

                <button
                  onClick={() => handleCopy(prefillResult.prefillUrl, 'full-url')}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors"
                >
                  {copiedKey === 'full-url' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">URL Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Full Prefilled Link</span>
                    </>
                  )}
                </button>
              </div>

              {hasOpenedForm && (
                <div className="text-xs text-emerald-400 font-medium pt-1 flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  Form opened in browser tab. Inspect, complete submit, and check confirmation below.
                </div>
              )}
            </div>
          )}

          {/* Manual Review Actions */}
          {submissionMode === 'MANUAL_REVIEW' && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-slate-300">
                Manual Review Workflow
              </h4>
              <p className="text-xs text-slate-400">
                Open the blank form and use the copy buttons above to paste each field into the appropriate question.
              </p>
              <a
                href={formConfig.formUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg bg-slate-800 text-sky-400 hover:bg-slate-700 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Open Blank Google Form</span>
              </a>
            </div>
          )}

          {/* Step 2: Analyst Confirmation & History Log */}
          {submissionMode !== 'AUTO_SUBMIT' && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-slate-300">
                Step 2: Analyst Inspection Confirmation
              </h4>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Notes or modifications made during submission (logged in audit history):
                </label>
                <input
                  type="text"
                  value={userNotesModification}
                  onChange={(e) => setUserNotesModification(e.target.value)}
                  placeholder="e.g. Verified deposit minimum on page 2; confirmed TRC20 address"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500"
                />
              </div>

              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={confirmedByAnalyst}
                  onChange={(e) => setConfirmedByAnalyst(e.target.checked)}
                  id="analyst-confirmation-checkbox"
                  className="rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                />
                <span>
                  I confirm that I have inspected the form fields and verified submission.
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-5 bg-slate-850 border-b-0 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={() => onEditFinding(finding)}
            className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Edit Finding</span>
          </button>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
            >
              Close
            </button>

            {submissionMode !== 'AUTO_SUBMIT' && (
              <button
                onClick={handleCompleteManualSubmission}
                disabled={!confirmedByAnalyst}
                id="confirm-submitted-button"
                className={`px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                  confirmedByAnalyst
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md'
                    : 'bg-slate-850 text-slate-600 border border-slate-800 cursor-not-allowed'
                }`}
              >
                <Check className="w-4 h-4" />
                <span>Mark as Completed &amp; Record History</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
