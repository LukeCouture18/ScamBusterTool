import React, { useState } from 'react';
import { X, FileText, AlertCircle, Plus } from 'lucide-react';

interface EvidenceImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (evidence: {
    source: string;
    type: string;
    originalObservation: string;
    rawData?: any;
    provenance?: string;
    confidence?: number;
  }) => Promise<void>;
}

export const EvidenceImportModal: React.FC<EvidenceImportModalProps> = ({
  isOpen,
  onClose,
  onSubmit
}) => {
  const [source, setSource] = useState('manual_analyst');
  const [type, setType] = useState('analyst_triage_finding');
  const [observation, setObservation] = useState('');
  const [provenance, setProvenance] = useState('Manual forensic artifact review');
  const [confidence, setConfidence] = useState(0.9);
  const [rawJson, setRawJson] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!observation.trim()) {
      setError('Please provide the original observation');
      return;
    }

    let parsedRaw = {};
    if (rawJson.trim()) {
      try {
        parsedRaw = JSON.parse(rawJson);
      } catch {
        setError('Raw payload must be valid JSON');
        return;
      }
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({
        source,
        type,
        originalObservation: observation.trim(),
        provenance: provenance.trim(),
        confidence: Number(confidence),
        rawData: parsedRaw
      });
      setObservation('');
      setRawJson('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to import evidence');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[#0b0f19] border border-[#1a2337] rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-[#1a2337]">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400 stroke-[2]" />
              <span>Import External Evidence / Observation</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Record an immutable atomic observation with verifiable provenance and hash.
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Source Pipeline</label>
              <select
                value={source}
                onChange={e => setSource(e.target.value)}
                className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
              >
                <option value="manual_analyst">manual_analyst</option>
                <option value="passive_dns">passive_dns</option>
                <option value="cert_transparency">cert_transparency</option>
                <option value="dom_fingerprint">dom_fingerprint</option>
                <option value="onchain_indexer">onchain_indexer</option>
                <option value="whois_asn">whois_asn</option>
                <option value="imported_pcap_har">imported_pcap_har</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Observation Type</label>
              <input
                type="text"
                value={type}
                onChange={e => setType(e.target.value)}
                placeholder="e.g. dns_a_record, tx_hop"
                className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Original Observation Statement <span className="text-blue-400">*</span>
            </label>
            <textarea
              rows={3}
              value={observation}
              onChange={e => setObservation(e.target.value)}
              placeholder="State the exact factual observation without speculation..."
              className="w-full text-xs px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Provenance Signature</label>
              <input
                type="text"
                value={provenance}
                onChange={e => setProvenance(e.target.value)}
                placeholder="Collector tool, sensor URL, or ticket ID"
                className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Confidence Weight ({Math.round(confidence * 100)}%)
              </label>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={confidence}
                onChange={e => setConfidence(parseFloat(e.target.value))}
                className="w-full accent-blue-500 mt-2"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Raw Structured Payload (Optional JSON)
            </label>
            <textarea
              rows={2}
              value={rawJson}
              onChange={e => setRawJson(e.target.value)}
              placeholder='{ "ip": "185.193.127.44", "status": "active" }'
              className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
            />
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
              <Plus className="w-3.5 h-3.5" />
              <span>Record Evidence</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
