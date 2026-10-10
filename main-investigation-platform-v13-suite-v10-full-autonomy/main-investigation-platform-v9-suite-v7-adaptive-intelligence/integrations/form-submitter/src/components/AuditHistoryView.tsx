import React, { useState } from 'react';
import {
  History,
  CheckCircle2,
  ExternalLink,
  Download,
  Trash2,
  Search,
  Copy,
  Check,
  ShieldCheck,
  Calendar,
  User,
  Eye,
} from 'lucide-react';
import { HistoryRecord } from '../types';

interface AuditHistoryViewProps {
  history: HistoryRecord[];
  onClearHistory: () => void;
}

export const AuditHistoryView: React.FC<AuditHistoryViewProps> = ({
  history,
  onClearHistory,
}) => {
  const [search, setSearch] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<HistoryRecord | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const filteredHistory = history.filter((h) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const matchDomain = h.domain.toLowerCase().includes(q) || h.siteUrl.toLowerCase().includes(q);
    const matchWallets = h.wallets.some((w) => w.address.toLowerCase().includes(q) || w.network.toLowerCase().includes(q));
    const matchId = h.id.toLowerCase().includes(q) || h.findingId.toLowerCase().includes(q);
    return matchDomain || matchWallets || matchId;
  });

  const handleExportJSON = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(history, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `crypto_scam_submissions_audit_${Date.now()}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <History className="w-6 h-6 text-purple-400" />
            Audit History &amp; Submission Records
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Local audit trail of all processed findings, populated Google Form fields, and manual submission verifications.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportJSON}
            disabled={history.length === 0}
            className="px-3.5 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            Export Audit Log
          </button>

          <button
            onClick={onClearHistory}
            disabled={history.length === 0}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 border border-slate-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      {/* Search Filter */}
      <div className="flex items-center justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search domain, wallet, finding ID..."
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
          />
        </div>
        <span className="text-xs text-slate-500 font-medium">
          Total Recorded: {history.length}
        </span>
      </div>

      {/* History Records List */}
      {filteredHistory.length === 0 ? (
        <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-xl p-12 text-center">
          <History className="w-10 h-10 text-slate-600 mx-auto mb-2" />
          <h3 className="text-sm font-semibold text-slate-300">No Submissions Recorded Yet</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
            When you complete and manually confirm a Google Form report in Validated Prefill Mode, it will be securely logged here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredHistory.map((rec) => (
            <div
              key={rec.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors"
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      <CheckCircle2 className="w-3 h-3" />
                      Manually Verified &amp; Submitted
                    </span>

                    <span className="text-xs font-mono text-slate-400">
                      {new Date(rec.timestamp).toLocaleString()}
                    </span>

                    <span className="text-xs font-mono text-slate-500">ID: {rec.findingId}</span>
                  </div>

                  <h4 className="text-base font-bold text-white truncate">
                    {rec.domain}
                  </h4>

                  {/* Wallets summary */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {rec.wallets.map((w, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700"
                      >
                        <span className="font-bold text-sky-400">{w.network}</span>
                        <span>{w.address.slice(0, 8)}...{w.address.slice(-4)}</span>
                        <span className="text-emerald-400">✓</span>
                      </span>
                    ))}
                  </div>

                  {/* Analyst info & modifications */}
                  <div className="text-xs text-slate-400 flex items-center gap-3 pt-1">
                    <span className="flex items-center gap-1">
                      <User className="w-3.5 h-3.5 text-slate-500" />
                      {rec.username || 'Anonymous'} ({rec.teamInviteCodeMasked || 'No Code'})
                    </span>

                    {rec.userModifications && rec.userModifications.length > 0 && (
                      <span className="text-amber-400">
                        Notes: {rec.userModifications.join(', ')}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end md:self-center">
                  <button
                    onClick={() => setSelectedRecord(rec)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 flex items-center gap-1 transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>View Fields</span>
                  </button>

                  {rec.prefillUrl && (
                    <a
                      href={rec.prefillUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1 transition-colors"
                      title="Re-open original prefilled Google Form"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Re-Open Form</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Snapshot Modal for Populated Fields */}
      {selectedRecord && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white">
                  Audit Snapshot: {selectedRecord.domain}
                </h3>
                <span className="text-xs text-slate-400 font-mono">
                  Submitted at {new Date(selectedRecord.timestamp).toLocaleString()}
                </span>
              </div>
              <button
                onClick={() => setSelectedRecord(null)}
                className="text-slate-400 hover:text-white text-xs font-semibold px-2 py-1 bg-slate-800 rounded"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">
                Google Form Populated Parameters (entry.XXXX)
              </span>

              <div className="space-y-2 text-xs">
                {Object.entries(selectedRecord.populatedFields).map(([k, val]) => (
                  <div key={k} className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                    <span className="font-mono text-sky-400 block text-[11px] mb-1">{k}</span>
                    <pre className="font-mono text-slate-200 whitespace-pre-wrap break-all text-xs">
                      {val}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
