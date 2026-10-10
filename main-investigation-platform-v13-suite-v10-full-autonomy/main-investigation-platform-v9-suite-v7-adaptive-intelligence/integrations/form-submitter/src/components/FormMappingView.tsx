import React, { useState } from 'react';
import {
  FileCode2,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Play,
  Layers,
  Sparkles,
  Wand2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { FormMappingConfig, FormFieldMapping, InvestigationFinding } from '../types';
import {
  extractGoogleFormId,
  generatePrefillUrl,
  DEFAULT_FIELD_MAPPINGS,
  DEFAULT_GOOGLE_FORM_URL,
  DEFAULT_FORM_CONFIG,
} from '../utils/formMapping';

interface FormMappingViewProps {
  formConfig: FormMappingConfig;
  onSaveConfig: (config: FormMappingConfig) => void;
  onOpenWizard?: () => void;
  sampleFinding?: InvestigationFinding;
}

export const FormMappingView: React.FC<FormMappingViewProps> = ({
  formConfig,
  onSaveConfig,
  onOpenWizard,
  sampleFinding,
}) => {
  const [url, setUrl] = useState(formConfig.formUrl || DEFAULT_GOOGLE_FORM_URL);
  const [formTitle, setFormTitle] = useState(formConfig.formTitle || 'Crypto Scam Report Form');
  const [multiWalletFormat, setMultiWalletFormat] = useState<FormMappingConfig['multiWalletFormat']>(
    formConfig.multiWalletFormat || 'COMBINED_LIST'
  );
  const [mappings, setMappings] = useState<FormFieldMapping[]>(
    formConfig.fieldMappings?.length > 0 ? formConfig.fieldMappings : DEFAULT_FIELD_MAPPINGS
  );
  const [testResult, setTestResult] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);

  const detectedFormId = extractGoogleFormId(url);

  const handleUpdateMapping = <K extends keyof FormFieldMapping>(id: string, field: K, value: FormFieldMapping[K]) => {
    setMappings(
      mappings.map((m) => {
        if (m.id === id) {
          return { ...m, [field]: value };
        }
        return m;
      })
    );
  };

  const handleAddMapping = () => {
    const newField: FormFieldMapping = {
      id: `f-${Date.now()}`,
      fieldKey: 'customNotes',
      label: 'Custom Form Question',
      entryKey: `entry.${Math.floor(100000000 + Math.random() * 900000000)}`,
      pageIndex: 1,
      required: false,
      notes: 'Custom question mapped to form field',
    };
    setMappings([...mappings, newField]);
  };

  const handleRemoveMapping = (id: string) => {
    setMappings(mappings.filter((m) => m.id !== id));
  };

  const handleResetDefaults = () => {
    setUrl(DEFAULT_GOOGLE_FORM_URL);
    setMappings(DEFAULT_FIELD_MAPPINGS);
    setMultiWalletFormat('COMBINED_LIST');
  };

  const handleSave = () => {
    const updated: FormMappingConfig = {
      ...formConfig,
      formUrl: url.trim(),
      formId: detectedFormId || formConfig.formId,
      formTitle: formTitle.trim(),
      fieldMappings: mappings,
      multiWalletFormat,
    };
    onSaveConfig(updated);
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 3000);
  };

  const handleRunTestPrefill = () => {
    if (!sampleFinding) return;
    const configToTest: FormMappingConfig = {
      formUrl: url.trim(),
      formId: detectedFormId || 'test-form',
      formTitle,
      fieldMappings: mappings,
      multiWalletFormat,
    };
    const res = generatePrefillUrl(sampleFinding, configToTest);
    setTestResult(res.prefillUrl);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Structure Change Warning Banner */}
      {formConfig.isFormChanged && (
        <div className="bg-amber-950/40 border border-amber-500/50 p-4 rounded-xl flex items-start justify-between gap-3 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong className="text-white block font-bold text-sm">
                Google Form Structure Change Detected
              </strong>
              <span>
                The remote Google Form&apos;s version hash does not match your verified snapshot (
                <span className="font-mono text-amber-300">{formConfig.formVersionHash}</span> vs{' '}
                <span className="font-mono text-amber-300">{formConfig.previousVersionHash || 'New'}</span>).
                Questions may have been added, removed, or reordered.
              </span>
            </div>
          </div>

          {onOpenWizard && (
            <button
              onClick={onOpenWizard}
              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shrink-0 transition-colors"
            >
              Run Setup Wizard
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <FileCode2 className="w-6 h-6 text-indigo-400" />
            Google Form Dynamic Field Mapper
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Configure your authorized Google Form URL and question entry keys (<code className="text-sky-400">entry.XXXXXXXXX</code>). Small changes to the Google Form do not require rewriting any code.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onOpenWizard && (
            <button
              onClick={onOpenWizard}
              id="open-wizard-button-mapping"
              className="px-3.5 py-2 text-xs font-bold rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-colors flex items-center gap-1.5"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Setup Wizard</span>
            </button>
          )}

          <button
            onClick={handleResetDefaults}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Defaults
          </button>

          <button
            onClick={handleSave}
            id="save-form-config-button"
            className="px-4 py-2 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-colors flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            Save Configuration
          </button>
        </div>
      </div>

      {savedBanner && (
        <div className="bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs p-3 rounded-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          Google Form configuration and question mapping saved successfully.
        </div>
      )}

      {/* Google Form URL Configuration */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
          1. Authorized Google Form Endpoint
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Google Form URL (Viewform / Edit / Short Link) <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/forms/d/e/1FAIpQLSc.../viewform"
              id="google-form-url-input"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Form Name / Title
            </label>
            <input
              type="text"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="e.g. Unit Scam Intake Form"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
          {detectedFormId ? (
            <span className="text-emerald-400 flex items-center gap-1 font-mono">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Detected Form ID: {detectedFormId}
            </span>
          ) : (
            <span className="text-amber-400 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Please provide a valid Google Form URL containing /forms/d/e/...
            </span>
          )}

          {formConfig.formVersionHash && (
            <span className="text-sky-400 font-mono flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Verified Fingerprint: {formConfig.formVersionHash}
            </span>
          )}
        </div>
      </div>

      {/* Multi-Wallet Serialization Strategy */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
          2. Multi-Wallet Serialization Format
        </h3>
        <p className="text-xs text-slate-400">
          Determine how multiple deposit wallets belonging to the same website are serialized into the Google Form wallet field.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label
            className={`p-3 rounded-lg border cursor-pointer transition-all ${
              multiWalletFormat === 'COMBINED_LIST'
                ? 'bg-indigo-950/40 border-indigo-500/60 text-indigo-200'
                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            <input
              type="radio"
              name="walletFormat"
              checked={multiWalletFormat === 'COMBINED_LIST'}
              onChange={() => setMultiWalletFormat('COMBINED_LIST')}
              className="hidden"
            />
            <strong className="block text-xs text-white mb-1">Combined Numbered List</strong>
            <span className="text-[11px] block font-mono text-slate-400 leading-tight">
              1. [BTC] 1A1z... [Checksum OK]<br />
              2. [USDT TRC20] T...
            </span>
          </label>

          <label
            className={`p-3 rounded-lg border cursor-pointer transition-all ${
              multiWalletFormat === 'LINE_BY_LINE_NETWORK'
                ? 'bg-indigo-950/40 border-indigo-500/60 text-indigo-200'
                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            <input
              type="radio"
              name="walletFormat"
              checked={multiWalletFormat === 'LINE_BY_LINE_NETWORK'}
              onChange={() => setMultiWalletFormat('LINE_BY_LINE_NETWORK')}
              className="hidden"
            />
            <strong className="block text-xs text-white mb-1">Line-by-Line Network</strong>
            <span className="text-[11px] block font-mono text-slate-400 leading-tight">
              BTC: 1A1zP1eP5QG...<br />
              USDT_TRC20: TR7NHqjek...
            </span>
          </label>

          <label
            className={`p-3 rounded-lg border cursor-pointer transition-all ${
              multiWalletFormat === 'PRIMARY_ONLY'
                ? 'bg-indigo-950/40 border-indigo-500/60 text-indigo-200'
                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            <input
              type="radio"
              name="walletFormat"
              checked={multiWalletFormat === 'PRIMARY_ONLY'}
              onChange={() => setMultiWalletFormat('PRIMARY_ONLY')}
              className="hidden"
            />
            <strong className="block text-xs text-white mb-1">Primary Wallet Only</strong>
            <span className="text-[11px] block font-mono text-slate-400 leading-tight">
              [BTC] 1A1zP1eP5QG...
            </span>
          </label>
        </div>
      </div>

      {/* Field Mapping Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
              3. Question Entry Key Mappings (entry.XXXXXXXXX)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Inspect questions or run the Form Setup Wizard to automatically extract entries and field types.
            </p>
          </div>

          <button
            onClick={handleAddMapping}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 text-xs font-semibold flex items-center gap-1 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Field
          </button>
        </div>

        <div className="space-y-2">
          {mappings.map((m) => (
            <div
              key={m.id}
              className="bg-slate-800/70 border border-slate-700/80 rounded-lg p-3 grid grid-cols-1 md:grid-cols-12 gap-3 items-center text-xs"
            >
              <div className="md:col-span-3">
                <label className="block text-[10px] text-slate-400 font-mono">Field Key</label>
                <span className="font-semibold text-slate-200">{m.label}</span>
                <span className="text-[10px] text-slate-500 block font-mono">{m.fieldKey}</span>
              </div>

              <div className="md:col-span-4">
                <label className="block text-[10px] text-slate-400 font-mono">
                  Google Form Entry Key
                </label>
                <input
                  type="text"
                  value={m.entryKey}
                  onChange={(e) => handleUpdateMapping(m.id, 'entryKey', e.target.value)}
                  placeholder="entry.123456789"
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 font-mono text-xs focus:border-indigo-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-[10px] text-slate-400 font-mono">Form Page</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={m.pageIndex || 1}
                  onChange={(e) => handleUpdateMapping(m.id, 'pageIndex', parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100 text-xs focus:border-indigo-500"
                />
              </div>

              <div className="md:col-span-2 flex items-center gap-2 pt-3">
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={m.required}
                    onChange={(e) => handleUpdateMapping(m.id, 'required', e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>Required</span>
                </label>
              </div>

              <div className="md:col-span-1 flex justify-end">
                <button
                  onClick={() => handleRemoveMapping(m.id)}
                  className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                  title="Remove mapping"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
