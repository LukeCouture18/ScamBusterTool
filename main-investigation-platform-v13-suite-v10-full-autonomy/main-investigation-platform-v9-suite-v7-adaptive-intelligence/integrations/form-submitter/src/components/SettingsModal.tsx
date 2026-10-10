import React, { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  User,
  Key,
  ShieldAlert,
  CheckCircle,
  Sparkles,
  Zap,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Download,
} from 'lucide-react';
import { UserSettings, SubmissionMode } from '../types';

interface SettingsModalProps {
  settings: UserSettings;
  isFirstLaunch?: boolean;
  onSave: (updated: UserSettings) => void;
  onClose: () => void;
  openZipModal?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  isFirstLaunch = false,
  onSave,
  onClose,
  openZipModal,
}) => {
  const [username, setUsername] = useState(settings.username || '');
  const [teamInviteCode, setTeamInviteCode] = useState(settings.teamInviteCode || '');
  const [showCode, setShowCode] = useState(false);
  const [defaultFormUrl, setDefaultFormUrl] = useState(settings.defaultFormUrl || '');
  const [defaultSubmissionMode, setDefaultSubmissionMode] = useState<SubmissionMode>(
    settings.defaultSubmissionMode || 'VALIDATED_PREFILL'
  );
  const [strictEVMMode, setStrictEVMMode] = useState(settings.strictEVMMode ?? true);
  const [autoSubmitGlobalEnabled, setAutoSubmitGlobalEnabled] = useState(
    settings.autoSubmitGlobalEnabled ?? false
  );
  const [batchPacingSeconds, setBatchPacingSeconds] = useState(
    settings.batchPacingSeconds ?? 5
  );
  const [enableDuplicateGuard, setEnableDuplicateGuard] = useState(
    settings.enableDuplicateGuard ?? true
  );
  const [healthInfo, setHealthInfo] = useState<{ status: string; geminiConfigured: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => setHealthInfo(data))
      .catch(() => setHealthInfo(null));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      username: username.trim(),
      teamInviteCode: teamInviteCode.trim(),
      defaultFormUrl: defaultFormUrl.trim(),
      defaultSubmissionMode,
      strictEVMMode,
      isConfigured: Boolean(username.trim()),
      autoSubmitGlobalEnabled,
      batchPacingSeconds: Math.max(1, Number(batchPacingSeconds) || 5),
      enableDuplicateGuard,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="p-5 bg-slate-850 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <SettingsIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">
                {isFirstLaunch ? 'Initial Investigator Setup' : 'Investigator & Submitter Settings'}
              </h3>
              <p className="text-xs text-slate-400">
                {isFirstLaunch
                  ? 'Please confirm your defensive identity before operating.'
                  : 'Configure defensive attribution, Google Form link, and validation modes.'}
              </p>
            </div>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {/* Username */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Default Investigator Username <span className="text-rose-400">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. AlexDefensiveLead"
                id="settings-username-input"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500 text-xs"
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Required to populate the authorized investigator username question on the form.
            </p>
          </div>

          {/* Team Invite Code with Masking */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Team Invite Code <span className="text-rose-400">*</span>
            </label>
            <div className="relative">
              <Key className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showCode ? 'text' : 'password'}
                required
                value={teamInviteCode}
                onChange={(e) => setTeamInviteCode(e.target.value)}
                placeholder="e.g. SCAM-DEFENSE-2026-HQ"
                id="settings-team-code-input"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-10 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowCode(!showCode)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                title={showCode ? 'Hide Code' : 'Show Code'}
              >
                {showCode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Masked in the UI and audit logs for operational security.
            </p>
          </div>

          {/* Default Submission Mode */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Default Submission Mode
            </label>
            <select
              value={defaultSubmissionMode}
              onChange={(e) => setDefaultSubmissionMode(e.target.value as SubmissionMode)}
              id="settings-submission-mode-select"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-amber-500 text-xs"
            >
              <option value="VALIDATED_PREFILL">
                Validated Prefill Mode (Auto-populates fields, stops before submit for inspection)
              </option>
              <option value="MANUAL_REVIEW">
                Manual Review Mode (Field-by-field copy checklist)
              </option>
              <option value="AUTO_SUBMIT">
                Auto Submit Mode (Requires Master Switch & Strict Gate Pass)
              </option>
            </select>
          </div>

          {/* Auto Submit Master Switch */}
          <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800 space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoSubmitGlobalEnabled}
                onChange={(e) => setAutoSubmitGlobalEnabled(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-400 mt-0.5"
              />
              <div>
                <div className="flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <strong className="text-slate-200 block">Auto Submit Master Switch</strong>
                </div>
                <span className="text-[11px] text-slate-400 leading-relaxed block mt-0.5">
                  Allows automated submission strictly for findings passing the 10-point validation gate. Must be enabled here and confirmed for the current session.
                </span>
              </div>
            </label>

            {autoSubmitGlobalEnabled && (
              <div className="pt-2.5 border-t border-slate-850 flex items-center justify-between gap-4 pl-6">
                <div>
                  <span className="text-slate-300 font-semibold block">Submission Pacing (Seconds)</span>
                  <span className="text-[10px] text-slate-500">Delay between submissions to prevent duplicate triggers</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={batchPacingSeconds}
                    onChange={(e) => setBatchPacingSeconds(Number(e.target.value))}
                    className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-center font-mono text-xs text-slate-100"
                  />
                  <span className="text-slate-400 text-xs">sec</span>
                </div>
              </div>
            )}
          </div>

          {/* Duplicate Protection Switch */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={enableDuplicateGuard}
                onChange={(e) => setEnableDuplicateGuard(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-400 mt-0.5"
              />
              <div>
                <strong className="text-slate-200 block">Strong Duplicate Protection</strong>
                <span className="text-[11px] text-slate-400 leading-relaxed block">
                  Checks current queue, completed audit history, domain names, deposit wallets, and idempotency keys to prevent duplicate reporting.
                </span>
              </div>
            </label>
          </div>

          {/* Strict EVM Ambiguity Rule Policy */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={strictEVMMode}
                onChange={(e) => setStrictEVMMode(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-400 mt-0.5"
              />
              <div>
                <strong className="text-slate-200 block">Strict EVM Ambiguity Policy</strong>
                <span className="text-[11px] text-slate-400 leading-relaxed block">
                  Never guess token or chain from a bare 0x address. If no network is explicitly verified, mark as NEEDS REVIEW.
                </span>
              </div>
            </label>
          </div>

          {/* Gemini AI Status */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <div>
                <span className="font-semibold text-slate-300 block">Gemini 3.8 Flash Vision OCR</span>
                <span className="text-[11px] text-slate-500">
                  {healthInfo?.geminiConfigured
                    ? 'API Key configured & operational'
                    : 'API Key not detected in environment'}
                </span>
              </div>
            </div>

            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded font-bold ${
                healthInfo?.geminiConfigured
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-amber-500/20 text-amber-400'
              }`}
            >
              {healthInfo?.geminiConfigured ? 'ONLINE' : 'MANUAL REVIEW'}
            </span>
          </div>

          {/* Project Archive Export */}
          <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center">
                <Download className="w-4 h-4" />
              </div>
              <div>
                <span className="font-semibold text-slate-300 block text-xs">Export Codebase Archive (.zip)</span>
                <span className="text-[11px] text-slate-500">
                  Full project source, server, automated test suite &amp; configuration
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (openZipModal) {
                  openZipModal();
                } else {
                  window.open('/api/download-zip', '_blank');
                }
              }}
              id="settings-download-zip-btn"
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export ZIP</span>
            </button>
          </div>

          {/* Footer Save */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-3">
            {!isFirstLaunch && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              id="settings-save-btn"
              className="px-5 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg shadow transition-colors flex items-center gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              Save Configuration
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
