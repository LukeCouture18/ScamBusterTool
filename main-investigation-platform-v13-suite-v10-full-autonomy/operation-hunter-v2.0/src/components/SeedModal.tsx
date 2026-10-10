import React, { useState } from 'react';
import { X, Sparkles, Plus, AlertCircle } from 'lucide-react';
import { SeedType } from '../types';

interface SeedModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (seed: { type: SeedType; value: string; label?: string; notes?: string }, autoExpand: boolean) => Promise<void>;
}

export const SeedModal: React.FC<SeedModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [type, setType] = useState<SeedType>('domain');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [autoExpand, setAutoExpand] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setError('Please provide a seed value');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({ type, value: value.trim(), label: label.trim() || undefined, notes: notes.trim() || undefined }, autoExpand);
      setValue('');
      setLabel('');
      setNotes('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to ingest seed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPlaceholder = () => {
    switch (type) {
      case 'domain':
        return 'e.g. eth-recovery-claim.top or claim-revoke-portal.link';
      case 'wallet':
        return 'e.g. 0x71c8282929d0092e02e82110c49281a94b810b82';
      case 'ip':
        return 'e.g. 185.193.127.44';
      case 'certificate':
        return 'e.g. *.claim-asset-portal.com or SHA256:7f42a9b...';
      case 'template_fingerprint':
        return 'e.g. e79a9f24a1b02948 (CryptoDrainer-X)';
      case 'identifier':
        return 'e.g. G-99X4K21Z or @arctic_drain_support';
      case 'artifact':
        return 'e.g. hash:a9b1... / incident triage log';
      default:
        return 'Enter seed value...';
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[#0b0f19] border border-[#1a2337] rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-[#1a2337]">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Plus className="w-4 h-4 text-blue-400 stroke-[2.2]" />
              <span>Ingest Operational Seed Indicator</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Initiate the core loop: Seed → Expand → Correlate → Reconstruct.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-rose-950/50 border border-rose-800/40 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Indicator Classification
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['domain', 'wallet', 'ip', 'certificate', 'template_fingerprint', 'identifier'] as SeedType[]).map(t => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setType(t)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border font-mono transition-colors capitalize ${
                    type === t
                      ? 'bg-blue-950/60 border-blue-500/50 text-blue-300 font-bold'
                      : 'bg-[#0e1422] border-[#1b253b] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Seed Value <span className="text-blue-400">*</span>
            </label>
            <input
              type="text"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={getPlaceholder()}
              className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200 focus:outline-hidden focus:border-blue-500/70"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Analyst Label / Descriptor (Optional)
            </label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Primary phishing landing page from victim Discord report"
              className="w-full text-xs px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200 focus:outline-hidden focus:border-blue-500/70"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Intake Provenance Notes (Optional)
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Source context, referral channel, or initial triage metadata..."
              className="w-full text-xs px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200 focus:outline-hidden focus:border-blue-500/70"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="autoExpand"
              checked={autoExpand}
              onChange={e => setAutoExpand(e.target.checked)}
              className="rounded bg-[#080b11] border-slate-700 text-blue-600 focus:ring-0"
            />
            <label htmlFor="autoExpand" className="text-xs text-slate-300 cursor-pointer">
              Automatically trigger passive pivot expansion after ingestion
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-[#1a2337]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-all disabled:opacity-50"
            >
              {isSubmitting ? (
                <span>Ingesting & Pivoting...</span>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Ingest Indicator</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
