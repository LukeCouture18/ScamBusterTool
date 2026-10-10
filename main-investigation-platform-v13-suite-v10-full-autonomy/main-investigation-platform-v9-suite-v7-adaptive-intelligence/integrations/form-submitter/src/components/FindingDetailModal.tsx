import React, { useState } from 'react';
import {
  X,
  Globe,
  Wallet,
  ShieldCheck,
  ShieldAlert,
  FileCheck,
  Copy,
  Check,
  ExternalLink,
  Edit2,
  Trash2,
  AlertTriangle,
  Layers,
  History as HistoryIcon,
} from 'lucide-react';
import { InvestigationFinding, CryptoNetwork } from '../types';

interface FindingDetailModalProps {
  finding: InvestigationFinding;
  onClose: () => void;
  onPrepareSubmission: (finding: InvestigationFinding) => void;
  onUpdateFinding: (updated: InvestigationFinding) => void;
}

export const FindingDetailModal: React.FC<FindingDetailModalProps> = ({
  finding,
  onClose,
  onPrepareSubmission,
  onUpdateFinding,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [editedNotes, setEditedNotes] = useState(finding.notes || '');

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSaveNotes = () => {
    onUpdateFinding({
      ...finding,
      notes: editedNotes,
      updatedAt: new Date().toISOString(),
    });
    setIsEditingNotes(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="p-5 bg-slate-850 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center justify-center">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white truncate max-w-md">
                  {finding.domain || finding.siteUrl}
                </h3>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                    finding.overallStatus === 'READY'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : finding.overallStatus === 'NEEDS_REVIEW'
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}
                >
                  {finding.overallStatus}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Finding ID: <span className="font-mono">{finding.id}</span> • Source: {finding.provenance?.sourceModule || 'Manual'}
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

        {/* Modal Body */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {/* Target Website Section */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Investigated Scam Website
              </span>
              <a
                href={finding.siteUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-sky-400 hover:underline flex items-center gap-1"
              >
                Open Site <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
            <div className="flex items-center justify-between bg-slate-900 p-2.5 rounded-lg border border-slate-800">
              <span className="font-mono text-xs text-slate-200 truncate">{finding.siteUrl}</span>
              <button
                onClick={() => handleCopy(finding.siteUrl, 'site-url')}
                className="p-1 text-slate-400 hover:text-white"
                title="Copy URL"
              >
                {copiedKey === 'site-url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Wallets & Checksums Breakdown */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                  Deposit Wallets ({finding.wallets.length})
                </span>
              </div>
            </div>

            <div className="space-y-2.5">
              {finding.wallets.map((wallet, idx) => (
                <div
                  key={idx}
                  className="bg-slate-900 border border-slate-800 rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 font-bold text-xs font-mono">
                        {wallet.selectedNetwork}
                      </span>
                      {wallet.status === 'READY' && (
                        <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" /> Checksum Validated
                        </span>
                      )}
                      {wallet.status === 'NEEDS_REVIEW' && (
                        <span className="text-[11px] font-semibold text-amber-400 flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Needs Review
                        </span>
                      )}
                      {wallet.status === 'BLOCKED' && (
                        <span className="text-[11px] font-semibold text-rose-400 flex items-center gap-1">
                          <ShieldAlert className="w-3.5 h-3.5" /> Blocked / Invalid
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => handleCopy(wallet.address, `w-${idx}`)}
                      className="p-1 text-slate-400 hover:text-white"
                      title="Copy wallet address"
                    >
                      {copiedKey === `w-${idx}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>

                  <div className="font-mono text-xs text-slate-100 bg-slate-950 p-2 rounded border border-slate-800/80 break-all select-all">
                    {wallet.address}
                  </div>

                  {/* Notes & Diagnostics */}
                  {wallet.validationNotes && wallet.validationNotes.length > 0 && (
                    <div className="text-[11px] text-slate-400 space-y-0.5">
                      {wallet.validationNotes.map((n, i) => (
                        <div key={i}>• {n}</div>
                      ))}
                    </div>
                  )}

                  {wallet.isAmbiguous && wallet.ambiguityReason && (
                    <div className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 p-2 rounded">
                      <strong>Ambiguity Rule:</strong> {wallet.ambiguityReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Validation Diagnostics List */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Diagnostic Rules Engine
            </span>
            <div className="space-y-1.5 text-xs">
              {finding.validationDiagnostics.map((d, i) => (
                <div key={i} className="flex items-start gap-2 bg-slate-900/60 p-2 rounded">
                  <span
                    className={`font-mono text-[10px] px-1.5 py-0.2 rounded font-bold ${
                      d.status === 'READY'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : d.status === 'NEEDS_REVIEW'
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}
                  >
                    {d.status}
                  </span>
                  <div>
                    <strong className="text-slate-200">{d.rule}: </strong>
                    <span className="text-slate-400">{d.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Provenance & Architecture Traceability */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-slate-300 text-xs font-bold uppercase tracking-wider">
              <Layers className="w-4 h-4 text-indigo-400" />
              <span>Pipeline Provenance &amp; Main Platform Metadata</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-900 p-3 rounded-lg border border-slate-800">
              <div>
                <span className="text-slate-500 block text-[10px]">Investigation ID</span>
                <span className="text-slate-200 font-mono font-medium truncate block">
                  {finding.provenance?.investigationId || finding.id}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">Site ID</span>
                <span className="text-slate-200 font-mono font-medium truncate block">
                  {finding.provenance?.siteId || 'N/A'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">Source Module</span>
                <span className="text-slate-200 font-medium truncate block">
                  {finding.provenance?.sourceModule || 'Manual'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">Confidence</span>
                <span className="text-emerald-400 font-medium">
                  {Math.round((finding.provenance?.confidence || 1.0) * 100)}%
                </span>
              </div>
            </div>
          </div>

          {/* Notes & Evidence */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Analyst Notes
              </span>
              {!isEditingNotes && (
                <button
                  onClick={() => setIsEditingNotes(true)}
                  className="text-xs text-sky-400 hover:underline flex items-center gap-1"
                >
                  <Edit2 className="w-3 h-3" /> Edit Notes
                </button>
              )}
            </div>

            {isEditingNotes ? (
              <div className="space-y-2">
                <textarea
                  rows={3}
                  value={editedNotes}
                  onChange={(e) => setEditedNotes(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setIsEditingNotes(false)}
                    className="px-2.5 py-1 text-xs rounded bg-slate-800 text-slate-400"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveNotes}
                    className="px-3 py-1 text-xs rounded bg-sky-600 text-white font-medium"
                  >
                    Save Notes
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                {finding.notes || 'No analyst notes recorded.'}
              </p>
            )}

            {finding.screenshotUrls && finding.screenshotUrls.length > 0 && (
              <div className="pt-2">
                <span className="text-xs font-semibold text-slate-400 block mb-2">
                  Attached Screenshots ({finding.screenshotUrls.length}):
                </span>
                <div className="flex flex-wrap gap-2">
                  {finding.screenshotUrls.map((sc, i) => (
                    <img
                      key={i}
                      src={sc}
                      alt={`Evidence ${i + 1}`}
                      className="w-24 h-20 object-cover rounded-lg border border-slate-800 cursor-pointer hover:border-slate-600"
                      onClick={() => window.open(sc, '_blank')}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 bg-slate-850 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
          >
            Close
          </button>

          <button
            onClick={() => {
              onClose();
              onPrepareSubmission(finding);
            }}
            disabled={finding.overallStatus === 'BLOCKED'}
            className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              finding.overallStatus === 'BLOCKED'
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md'
            }`}
          >
            <FileCheck className="w-4 h-4" />
            <span>Prepare Google Form</span>
          </button>
        </div>
      </div>
    </div>
  );
};
