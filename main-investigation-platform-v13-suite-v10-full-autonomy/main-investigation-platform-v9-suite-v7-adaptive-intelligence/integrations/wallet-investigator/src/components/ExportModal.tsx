import React, { useState } from 'react';
import { X, Download, FileCode, FileSpreadsheet, FileText, AlertTriangle, ShieldCheck } from 'lucide-react';
import { DataCompleteness } from '../types';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletId: string;
  walletAddress: string;
  completeness: DataCompleteness;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  walletId,
  walletAddress,
  completeness,
}) => {
  const [selectedFormat, setSelectedFormat] = useState<'json' | 'csv' | 'report'>('report');

  if (!isOpen) return null;

  const handleDownload = () => {
    window.location.href = `/api/export/${walletId}?format=${selectedFormat}`;
    onClose();
  };

  return (
    <div id="export-modal-backdrop" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div id="export-modal-container" className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden my-8">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div>
            <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <span>Export Investigation Dossier</span>
            </h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Target: {walletAddress.slice(0, 10)}...{walletAddress.slice(-6)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Data Quality Notice */}
        <div className="p-4 mx-6 mt-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Data Completeness Certification:</span>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded font-bold ${
              completeness === 'COMPLETE'
                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30'
                : 'bg-amber-950/80 text-amber-300 border border-amber-500/30'
            }`}>
              {completeness}
            </span>
          </div>
          {completeness === 'PARTIAL' || completeness === 'LIMITED' ? (
            <p className="text-[11px] text-amber-300/80 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <span>
                <strong>Warning:</strong> Export metadata includes explicit caveat headers documenting that historical transactions were partially truncated by provider pagination boundaries.
              </span>
            </p>
          ) : (
            <p className="text-[11px] text-emerald-300/80 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Full transaction dataset confirmed through latest indexed block.</span>
            </p>
          )}
        </div>

        {/* Format Selector */}
        <div className="p-6 space-y-3">
          <label className="block text-xs font-medium text-slate-300">
            Select Export Package Format:
          </label>

          <div className="space-y-2">
            <label
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedFormat === 'report'
                  ? 'bg-slate-800 border-cyan-500 text-slate-100'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/40'
              }`}
            >
              <input
                type="radio"
                name="export_format"
                value="report"
                checked={selectedFormat === 'report'}
                onChange={() => setSelectedFormat('report')}
                className="mt-1 text-cyan-500 focus:ring-cyan-500"
              />
              <div>
                <div className="flex items-center gap-1.5 font-semibold text-xs text-slate-200">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  <span>Comprehensive Markdown Investigation Report (.md)</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Includes complete data completeness caveats, observed website evidence, factual findings, top counterparties, and methodology provenance.
                </p>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedFormat === 'json'
                  ? 'bg-slate-800 border-cyan-500 text-slate-100'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/40'
              }`}
            >
              <input
                type="radio"
                name="export_format"
                value="json"
                checked={selectedFormat === 'json'}
                onChange={() => setSelectedFormat('json')}
                className="mt-1 text-cyan-500 focus:ring-cyan-500"
              />
              <div>
                <div className="flex items-center gap-1.5 font-semibold text-xs text-slate-200">
                  <FileCode className="w-4 h-4 text-emerald-400" />
                  <span>Canonical JSON Dossier (.json)</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Raw normalized machine-readable schema formatted for Main Investigation Platform v6 ingestion, third-party SIEMs, or court discovery archiving.
                </p>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedFormat === 'csv'
                  ? 'bg-slate-800 border-cyan-500 text-slate-100'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/40'
              }`}
            >
              <input
                type="radio"
                name="export_format"
                value="csv"
                checked={selectedFormat === 'csv'}
                onChange={() => setSelectedFormat('csv')}
                className="mt-1 text-cyan-500 focus:ring-cyan-500"
              />
              <div>
                <div className="flex items-center gap-1.5 font-semibold text-xs text-slate-200">
                  <FileSpreadsheet className="w-4 h-4 text-amber-400" />
                  <span>Transaction Ledger CSV (.csv)</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Flat spreadsheet containing hash, timestamp, direction, counterparty, asset, display amounts, and verification statuses.
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-950/60 border-t border-slate-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            id="download-export-btn"
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Dossier</span>
          </button>
        </div>

      </div>
    </div>
  );
};
