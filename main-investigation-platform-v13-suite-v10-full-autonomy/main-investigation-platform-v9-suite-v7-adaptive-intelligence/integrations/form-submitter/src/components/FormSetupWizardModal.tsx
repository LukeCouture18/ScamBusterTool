import React, { useState } from 'react';
import {
  Wand2,
  X,
  Search,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  ExternalLink,
  Layers,
  Sparkles,
  HelpCircle,
  ShieldAlert,
  Hash,
  FileSpreadsheet,
} from 'lucide-react';
import {
  FormMappingConfig,
  FormFieldMapping,
  ParsedFormSchema,
  StandardInvestigationFieldKey,
} from '../types';
import {
  inspectGoogleFormOnline,
  autoSuggestFieldMappings,
  evaluateFormMappings,
  DEFAULT_AUTHORIZED_FORM_SCHEMA,
} from '../utils/googleFormParser';

interface FormSetupWizardModalProps {
  currentConfig: FormMappingConfig;
  onSaveConfig: (newConfig: FormMappingConfig) => void;
  onClose: () => void;
}

const FIELD_DEFINITIONS: {
  key: StandardInvestigationFieldKey;
  label: string;
  description: string;
  requiredByDefault: boolean;
}[] = [
  {
    key: 'siteUrl',
    label: 'Scam Website URL / Domain',
    description: 'Target fraudulent website address or hostname',
    requiredByDefault: true,
  },
  {
    key: 'walletsList',
    label: 'Deposit Wallets List (Formatted)',
    description: 'Numbered or formatted list of all detected deposit wallets',
    requiredByDefault: true,
  },
  {
    key: 'primaryWallet',
    label: 'Primary Deposit Wallet Address',
    description: 'First or highest priority cryptocurrency wallet address',
    requiredByDefault: true,
  },
  {
    key: 'primaryNetwork',
    label: 'Primary Blockchain Network',
    description: 'Token or blockchain network (e.g. BTC, ETH, USDT_TRC20)',
    requiredByDefault: true,
  },
  {
    key: 'username',
    label: 'Investigator Username',
    description: 'Authorized investigator alias or handle',
    requiredByDefault: true,
  },
  {
    key: 'teamInviteCode',
    label: 'Team Invite Code',
    description: 'Authorized unit or defensive campaign identifier',
    requiredByDefault: true,
  },
  {
    key: 'evidenceNotes',
    label: 'Supporting Evidence & Notes',
    description: 'Contextual notes, OCR reasoning, or scam characteristics',
    requiredByDefault: false,
  },
  {
    key: 'investigationId',
    label: 'Investigation / Provenance ID',
    description: 'Main Platform reference tracking number',
    requiredByDefault: false,
  },
];

export const FormSetupWizardModal: React.FC<FormSetupWizardModalProps> = ({
  currentConfig,
  onSaveConfig,
  onClose,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [formUrl, setFormUrl] = useState(currentConfig.formUrl || DEFAULT_AUTHORIZED_FORM_SCHEMA.formUrl);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [parsedSchema, setParsedSchema] = useState<ParsedFormSchema>(
    currentConfig.parsedSchema || DEFAULT_AUTHORIZED_FORM_SCHEMA
  );

  const [fieldMappings, setFieldMappings] = useState<FormFieldMapping[]>(
    currentConfig.fieldMappings || []
  );

  const [multiWalletFormat, setMultiWalletFormat] = useState<FormMappingConfig['multiWalletFormat']>(
    currentConfig.multiWalletFormat || 'COMBINED_LIST'
  );

  // Step 1: Inspect form
  const handleInspectForm = async () => {
    if (!formUrl.trim()) return;
    setIsInspecting(true);
    setInspectError(null);

    try {
      const schema = await inspectGoogleFormOnline(formUrl.trim());
      setParsedSchema(schema);

      // Auto-suggest mappings for any fields not already mapped
      const suggested = autoSuggestFieldMappings(schema);
      setFieldMappings(suggested);
      setStep(2);
    } catch (err: unknown) {
      setInspectError(err instanceof Error ? err.message : 'Failed to inspect Google Form.');
    } finally {
      setIsInspecting(false);
    }
  };

  // Step 2 mapping adjustments
  const handleMapFieldToQuestion = (
    fieldKey: StandardInvestigationFieldKey,
    selectedEntryKey: string
  ) => {
    const question = parsedSchema.allQuestions.find((q) => q.entryKey === selectedEntryKey);
    const existingIdx = fieldMappings.findIndex((m) => m.fieldKey === fieldKey);

    const fieldDef = FIELD_DEFINITIONS.find((f) => f.key === fieldKey);
    const updatedMapping: FormFieldMapping = {
      id: `map-${fieldKey}`,
      fieldKey,
      label: fieldDef?.label || fieldKey,
      entryKey: selectedEntryKey,
      pageIndex: question?.pageIndex || 1,
      required: fieldDef?.requiredByDefault ?? Boolean(question?.required),
      matchedQuestionTitle: question?.title,
    };

    if (existingIdx >= 0) {
      const next = [...fieldMappings];
      next[existingIdx] = updatedMapping;
      setFieldMappings(next);
    } else {
      setFieldMappings([...fieldMappings, updatedMapping]);
    }
  };

  const handleAutoSuggestAll = () => {
    const suggested = autoSuggestFieldMappings(parsedSchema);
    setFieldMappings(suggested);
  };

  // Mapping evaluation
  const mappingEvaluation = evaluateFormMappings(parsedSchema, fieldMappings);

  // Step 3: Save configuration
  const handleFinalizeSave = () => {
    const isStructureChanged =
      currentConfig.formVersionHash &&
      currentConfig.formVersionHash !== parsedSchema.versionHash;

    const newConfig: FormMappingConfig = {
      formUrl: parsedSchema.formUrl,
      formId: parsedSchema.formId,
      formTitle: parsedSchema.formTitle,
      formVersionHash: parsedSchema.versionHash,
      verifiedAt: new Date().toISOString(),
      fieldMappings,
      multiWalletFormat,
      parsedSchema,
      isFormChanged: Boolean(isStructureChanged),
      previousVersionHash: currentConfig.formVersionHash,
    };

    onSaveConfig(newConfig);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden my-8">
        {/* Wizard Header */}
        <div className="p-5 bg-slate-850 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">Google Form Setup Wizard</h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                  v1.1 REAL INSPECTION
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Inspect authorized Google Form structure, extract entry IDs, and map investigation fields.
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

        {/* Wizard Progress Bar */}
        <div className="bg-slate-950 px-6 py-3 border-b border-slate-800 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step === 1
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              1
            </span>
            <span className={step === 1 ? 'font-bold text-slate-100' : 'text-slate-400'}>
              Form Connection &amp; Inspection
            </span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step === 2
                  ? 'bg-amber-500 text-slate-950'
                  : step > 2
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-slate-800 text-slate-500'
              }`}
            >
              2
            </span>
            <span className={step === 2 ? 'font-bold text-slate-100' : 'text-slate-400'}>
              Visual Field Mapping &amp; Multi-Wallet
            </span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step === 3
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-slate-800 text-slate-500'
              }`}
            >
              3
            </span>
            <span className={step === 3 ? 'font-bold text-slate-100' : 'text-slate-400'}>
              Verification &amp; Version Hash
            </span>
          </div>
        </div>

        {/* Wizard Step Content */}
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-6 text-xs">
          {/* ============================================================== */}
          {/* STEP 1: FORM URL & INSPECTION */}
          {/* ============================================================== */}
          {step === 1 && (
            <div className="space-y-5">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-bold text-slate-200 text-sm">Target Google Form URL</h4>
                <p className="text-slate-400 leading-relaxed">
                  Paste the public or viewform URL of the authorized Google Form you submit findings to. The wizard will inspect the form&apos;s HTML, detect all questions, field types, required indicators, and entry IDs.
                </p>

                <div className="pt-2">
                  <div className="relative">
                    <input
                      type="url"
                      value={formUrl}
                      onChange={(e) => setFormUrl(e.target.value)}
                      placeholder="https://docs.google.com/forms/d/e/1FAIpQLSc.../viewform"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-100 font-mono text-xs focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>
              </div>

              {inspectError && (
                <div className="bg-rose-950/50 border border-rose-600/40 p-3.5 rounded-lg flex items-start gap-2.5 text-rose-300">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="block font-semibold">Inspection Notice</strong>
                    <span>{inspectError}</span>
                  </div>
                </div>
              )}

              {/* Form Schema Preview Summary if available */}
              {parsedSchema && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h5 className="font-bold text-slate-200 text-xs">{parsedSchema.formTitle}</h5>
                      <span className="text-slate-500 font-mono text-[11px]">
                        Form ID: {parsedSchema.formId}
                      </span>
                    </div>

                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[11px] font-bold border border-emerald-500/30">
                      {parsedSchema.allQuestions.length} Questions Detected
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2">
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">Sections / Pages</span>
                      <span className="font-bold text-slate-200 text-sm">
                        {parsedSchema.sections.length} Pages
                      </span>
                    </div>
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">Required Questions</span>
                      <span className="font-bold text-amber-400 text-sm">
                        {parsedSchema.allQuestions.filter((q) => q.required).length} Required
                      </span>
                    </div>
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">Version Fingerprint</span>
                      <span className="font-mono text-sky-400 text-xs">
                        {parsedSchema.versionHash || 'Calculated'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* STEP 2: FIELD MAPPING & MULTI-WALLET FORMAT */}
          {/* ============================================================== */}
          {step === 2 && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-slate-100 text-sm">Map Investigation Data to Form Questions</h4>
                  <p className="text-slate-400">
                    Align your collected finding data to the exact form questions detected in the Google Form.
                  </p>
                </div>

                <button
                  onClick={handleAutoSuggestAll}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-semibold text-xs border border-amber-500/30 flex items-center gap-1.5 transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Auto-Suggest Mappings</span>
                </button>
              </div>

              {/* Mapping Status summary */}
              <div
                className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
                  mappingEvaluation.isFullyMatched
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  {mappingEvaluation.isFullyMatched ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                  )}
                  <span>
                    <strong>{mappingEvaluation.matchedCount} / {mappingEvaluation.totalRequiredCount}</strong> Required Form Questions Mapped
                  </span>
                </div>

                {!mappingEvaluation.isFullyMatched && (
                  <span className="text-[11px] text-amber-400 font-medium">
                    Unmapped: {mappingEvaluation.unmappedRequiredQuestions.map((u) => u.title).join(', ')}
                  </span>
                )}
              </div>

              {/* Mappings Table */}
              <div className="space-y-3">
                {FIELD_DEFINITIONS.map((def) => {
                  const mapped = fieldMappings.find((m) => m.fieldKey === def.key);

                  return (
                    <div
                      key={def.key}
                      className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 sm:max-w-xs space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-slate-200">{def.label}</span>
                          {def.requiredByDefault && (
                            <span className="text-rose-400 text-xs font-bold" title="Required field">*</span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400">{def.description}</p>
                      </div>

                      <div className="flex-1 min-w-0">
                        <select
                          value={mapped?.entryKey || ''}
                          onChange={(e) => handleMapFieldToQuestion(def.key, e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 text-xs font-mono focus:outline-none focus:border-amber-500"
                        >
                          <option value="">-- Select Target Question --</option>
                          {parsedSchema.allQuestions.map((q) => (
                            <option key={q.entryKey} value={q.entryKey}>
                              [P{q.pageIndex}] {q.title} {q.required ? '(Req)' : ''} ({q.entryKey})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Multi-Wallet Formatting Choice */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <h5 className="font-bold text-slate-200 text-xs">Multi-Wallet Formatting Preference</h5>
                <p className="text-slate-400 text-[11px]">
                  When a scam website advertises multiple deposit wallets, how should they be inserted into the wallets question?
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setMultiWalletFormat('COMBINED_LIST')}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      multiWalletFormat === 'COMBINED_LIST'
                        ? 'bg-amber-500/20 border-amber-500 text-slate-100'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <strong className="block text-slate-200 mb-1">Numbered List (Recommended)</strong>
                    <span className="text-[10px] text-slate-400 leading-relaxed block">
                      1. [BTC] 1A1zP... [Checksum Verified]<br />
                      2. [USDT_TRC20] TR7NH...
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMultiWalletFormat('LINE_BY_LINE_NETWORK')}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      multiWalletFormat === 'LINE_BY_LINE_NETWORK'
                        ? 'bg-amber-500/20 border-amber-500 text-slate-100'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <strong className="block text-slate-200 mb-1">Network Prefix Line-by-Line</strong>
                    <span className="text-[10px] text-slate-400 leading-relaxed block">
                      BTC: 1A1zP...<br />
                      USDT_TRC20: TR7NH...
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMultiWalletFormat('PRIMARY_ONLY')}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      multiWalletFormat === 'PRIMARY_ONLY'
                        ? 'bg-amber-500/20 border-amber-500 text-slate-100'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <strong className="block text-slate-200 mb-1">Primary Wallet Only</strong>
                    <span className="text-[10px] text-slate-400 leading-relaxed block">
                      [BTC] 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* STEP 3: VERIFICATION & VERSION HASH */}
          {/* ============================================================== */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-100 text-sm">Form Verification Summary</h4>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">
                    VERIFIED READY
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block font-mono">Form Title</span>
                    <span className="text-slate-200 font-bold block">{parsedSchema.formTitle}</span>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block font-mono">Version Fingerprint Hash</span>
                    <span className="text-sky-400 font-mono font-bold block">{parsedSchema.versionHash}</span>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block font-mono">Verified Form ID</span>
                    <span className="text-slate-200 font-mono block">{parsedSchema.formId}</span>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block font-mono">Multi-Wallet Format</span>
                    <span className="text-amber-400 font-bold block">{multiWalletFormat}</span>
                  </div>
                </div>
              </div>

              {/* Section Breakdown */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <h5 className="font-bold text-slate-200 text-xs">Inspected Form Pages / Sections</h5>
                <div className="space-y-2 text-xs">
                  {parsedSchema.sections.map((sec) => (
                    <div key={sec.pageIndex} className="p-2.5 bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded bg-slate-800 text-slate-300 font-bold text-[10px] flex items-center justify-center">
                          {sec.pageIndex}
                        </span>
                        <span className="text-slate-200 font-semibold">{sec.title}</span>
                      </div>
                      <span className="text-[11px] text-slate-400">
                        {sec.questions.length} questions
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Change Detection Notice */}
              <div className="bg-sky-950/40 border border-sky-500/30 rounded-xl p-3.5 text-xs text-sky-200 leading-relaxed flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="block text-white mb-0.5">Automated Change Guard Active</strong>
                  The version fingerprint (<span className="font-mono text-sky-300">{parsedSchema.versionHash}</span>) is permanently recorded. If the form administrator modifies, removes, or reorders questions, the submitter will warn you and halt automated submissions until you re-verify.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Wizard Footer Navigation */}
        <div className="p-5 bg-slate-850 border-t border-slate-800 flex items-center justify-between">
          <div>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(1, s - 1) as typeof s)}
                className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>

            {step === 1 && (
              <button
                type="button"
                onClick={handleInspectForm}
                disabled={isInspecting || !formUrl.trim()}
                className="px-5 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg shadow transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isInspecting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Inspecting Form...</span>
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    <span>Inspect Form Structure</span>
                  </>
                )}
              </button>
            )}

            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!mappingEvaluation.isFullyMatched}
                className={`px-5 py-2 text-xs font-semibold rounded-lg shadow transition-colors flex items-center gap-2 ${
                  mappingEvaluation.isFullyMatched
                    ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                }`}
              >
                <span>Continue to Verification</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={handleFinalizeSave}
                className="px-5 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg shadow transition-colors flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Save Verified Form Configuration</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
