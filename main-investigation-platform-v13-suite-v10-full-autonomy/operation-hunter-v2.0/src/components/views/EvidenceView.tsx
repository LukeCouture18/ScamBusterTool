import React, { useState } from 'react';
import { Evidence } from '../../types';
import {
  FileText,
  Plus,
  Trash2,
  Database,
  Hash,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Filter
} from 'lucide-react';

interface EvidenceViewProps {
  evidenceList: Evidence[];
  onOpenImportModal: () => void;
  onInvalidateEvidence: (evidenceId: string, reason: string) => Promise<void>;
}

export const EvidenceView: React.FC<EvidenceViewProps> = ({
  evidenceList,
  onOpenImportModal,
  onInvalidateEvidence
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [targetToInvalidate, setTargetToInvalidate] = useState<string | null>(null);
  const [invalidationReason, setInvalidationReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filtered = evidenceList.filter(ev => {
    if (statusFilter !== 'all' && ev.status !== statusFilter) return false;
    if (sourceFilter !== 'all' && ev.source !== sourceFilter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      return (
        ev.originalObservation.toLowerCase().includes(q) ||
        ev.type.toLowerCase().includes(q) ||
        ev.provenance.toLowerCase().includes(q) ||
        ev.sha256Hash.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleInvalidate = async (id: string) => {
    if (!invalidationReason.trim()) return;
    try {
      setIsSubmitting(true);
      await onInvalidateEvidence(id, invalidationReason.trim());
      setTargetToInvalidate(null);
      setInvalidationReason('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Header & Actions */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-blue-400" />
            <span>Immutable Evidence & Provenance Archive</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Every conclusion is anchored to verifiable raw observations. Invalidating any evidence automatically recalculates all dependent hypotheses.
          </p>
        </div>

        <button
          onClick={onOpenImportModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/30 border border-blue-500/50 text-blue-300 hover:bg-blue-600/40 text-xs font-semibold transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Import External Evidence</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-3 rounded-xl bg-[#0b0f19] border border-[#162035] flex items-center justify-between gap-3">
        <div className="flex-1 relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search by observation text, type, provenance, or SHA-256 hash..."
            className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200 focus:outline-hidden focus:border-blue-500/60"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
          >
            <option value="all">All Statuses ({evidenceList.length})</option>
            <option value="valid">Valid Only</option>
            <option value="invalidated">Invalidated Only</option>
            <option value="contradicted">Contradicted Only</option>
          </select>

          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            className="text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
          >
            <option value="all">All Sources</option>
            <option value="passive_dns">passive_dns</option>
            <option value="cert_transparency">cert_transparency</option>
            <option value="dom_fingerprint">dom_fingerprint</option>
            <option value="onchain_indexer">onchain_indexer</option>
            <option value="manual_analyst">manual_analyst</option>
          </select>
        </div>
      </div>

      {/* Evidence Cards List */}
      <div className="space-y-3">
        {filtered.map(ev => {
          const isInvalidated = ev.status === 'invalidated';
          return (
            <div
              key={ev.id}
              className={`p-4 rounded-xl border transition-all ${
                isInvalidated
                  ? 'bg-rose-950/20 border-rose-900/50 opacity-75'
                  : 'bg-[#0b0f19] border-[#162035] hover:border-blue-500/40'
              }`}
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-slate-200 uppercase bg-[#0e1422] border border-[#1d273f] px-2 py-0.5 rounded">
                    {ev.type}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    Source: <strong className="text-slate-200 font-semibold">{ev.source}</strong>
                  </span>
                  {isInvalidated ? (
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-950 border border-rose-700/60 text-rose-300">
                      INVALIDATED
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/50 text-emerald-400">
                      VERIFIED VALID
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                  <span>Confidence: <strong className="text-blue-400 font-bold">{Math.round(ev.confidence * 100)}%</strong></span>
                  <span className="text-slate-600">|</span>
                  <span className="flex items-center gap-1 text-slate-400">
                    <Clock className="w-3 h-3 text-slate-500" />
                    {new Date(ev.timestamp).toLocaleString()}
                  </span>
                </div>
              </div>

              <p className="text-xs text-slate-200 leading-relaxed mb-3">
                {ev.originalObservation}
              </p>

              {/* Provenance & SHA-256 Box */}
              <div className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80 text-[11px] font-mono text-slate-400 grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 truncate">
                  <Database className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="text-slate-500">Provenance:</span>
                  <span className="text-slate-300 truncate">{ev.provenance}</span>
                </div>
                <div className="flex items-center gap-2 truncate">
                  <Hash className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="text-slate-500">SHA-256:</span>
                  <span className="text-slate-400 truncate">{ev.sha256Hash}</span>
                </div>
              </div>

              {/* Invalidation Reason or Action */}
              {isInvalidated ? (
                <div className="mt-3 p-2 rounded-lg bg-rose-950/50 border border-rose-800/40 text-[11px] text-rose-300">
                  <strong>Invalidation Reason:</strong> {ev.invalidationReason}
                </div>
              ) : (
                <div className="mt-3 flex justify-end">
                  {targetToInvalidate === ev.id ? (
                    <div className="w-full p-3 rounded-lg bg-[#141a29] border border-rose-900/60 space-y-2">
                      <label className="text-[11px] text-rose-300 font-semibold block">
                        Reason for invalidating / challenging this evidence:
                      </label>
                      <input
                        type="text"
                        value={invalidationReason}
                        onChange={e => setInvalidationReason(e.target.value)}
                        placeholder="e.g. Host confirmed multi-tenant shared proxy, or template default decoy"
                        className="w-full text-xs px-2.5 py-1.5 rounded bg-[#080b11] border border-slate-700 text-slate-200 focus:outline-hidden focus:border-rose-500"
                      />
                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          onClick={() => {
                            setTargetToInvalidate(null);
                            setInvalidationReason('');
                          }}
                          className="text-xs px-2.5 py-1 rounded text-slate-400 hover:text-slate-200"
                        >
                          Cancel
                        </button>
                        <button
                          disabled={isSubmitting || !invalidationReason.trim()}
                          onClick={() => handleInvalidate(ev.id)}
                          className="text-xs px-3 py-1 rounded bg-rose-900/80 border border-rose-700 text-rose-200 hover:bg-rose-800 disabled:opacity-50"
                        >
                          {isSubmitting ? 'Recalculating Graph...' : 'Confirm Invalidation'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setTargetToInvalidate(ev.id)}
                      className="flex items-center gap-1.5 text-xs text-rose-400/80 hover:text-rose-300 px-2 py-1 rounded hover:bg-rose-950/30 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Invalidate Evidence</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
