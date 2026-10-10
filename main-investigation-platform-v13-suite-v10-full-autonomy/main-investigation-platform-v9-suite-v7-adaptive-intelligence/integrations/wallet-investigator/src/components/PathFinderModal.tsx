import React, { useState } from 'react';
import { X, GitFork, ArrowRight, CheckCircle2, AlertCircle, ShieldAlert } from 'lucide-react';
import { PathResult } from '../types';

interface PathFinderModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSourceAddress?: string;
}

export const PathFinderModal: React.FC<PathFinderModalProps> = ({
  isOpen,
  onClose,
  initialSourceAddress = '',
}) => {
  const [sourceAddress, setSourceAddress] = useState(initialSourceAddress);
  const [targetAddress, setTargetAddress] = useState('');
  const [maxHops, setMaxHops] = useState(2);
  const [allowExpansion, setAllowExpansion] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState<PathResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceAddress.trim() || !targetAddress.trim()) return;

    setIsSearching(true);
    setResult(null);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/path-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_address: sourceAddress.trim(),
          target_address: targetAddress.trim(),
          max_hops: maxHops,
          allow_provider_expansion: allowExpansion,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed path search');
      setResult(data);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div id="path-finder-modal-backdrop" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div id="path-finder-modal-container" className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden my-8">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <GitFork className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Multi-Hop Path Finder</h2>
              <p className="text-xs text-slate-400">
                Is Wallet A connected to Wallet B within N hops on-chain?
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Investigative Caveat Banner */}
        <div className="px-6 py-2 bg-amber-950/30 border-b border-amber-500/20 text-amber-300 text-[11px] flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>
            <strong>Investigative Caution:</strong> A blockchain path indicates a transaction transfer chain. It does not prove common beneficial ownership.
          </span>
        </div>

        {/* Search Form */}
        <form onSubmit={handleSearch} className="p-6 space-y-4">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Source Address (Wallet A)
              </label>
              <input
                id="path-source-address-input"
                type="text"
                required
                placeholder="Enter starting wallet address"
                value={sourceAddress}
                onChange={(e) => setSourceAddress(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Target Address (Wallet B)
              </label>
              <input
                id="path-target-address-input"
                type="text"
                required
                placeholder="Enter destination / counterparty wallet address"
                value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <span>Max Hops:</span>
                <select
                  value={maxHops}
                  onChange={(e) => setMaxHops(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-cyan-300"
                >
                  <option value={1}>1 Hop (Direct Counterparty)</option>
                  <option value={2}>2 Hops (1 Intermediate)</option>
                  <option value={3}>3 Hops (2 Intermediates)</option>
                  <option value={4}>4 Hops (Budget Limited)</option>
                </select>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowExpansion}
                  onChange={(e) => setAllowExpansion(e.target.checked)}
                  className="rounded border-slate-700 text-cyan-500 bg-slate-950"
                />
                <span>Allow Provider Expansion</span>
              </label>
            </div>

            <button
              id="submit-path-finder-btn"
              type="submit"
              disabled={isSearching || !sourceAddress.trim() || !targetAddress.trim()}
              className="px-4 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg transition-colors disabled:opacity-50"
            >
              {isSearching ? 'Searching Path...' : 'Find Connection Path'}
            </button>
          </div>
        </form>

        {errorMsg && (
          <div className="mx-6 mb-4 p-3 bg-rose-950/40 border border-rose-500/30 rounded-lg text-rose-300 text-xs">
            {errorMsg}
          </div>
        )}

        {/* Results */}
        {result && (
          <div id="path-finder-result-panel" className="px-6 pb-6 border-t border-slate-800 pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.found ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-amber-400" />
                )}
                <span className="text-sm font-semibold text-slate-100">
                  {result.found ? `Path Discovered (${result.hops} Hops)` : 'No Path Discovered Within Hop Limit'}
                </span>
              </div>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                Data Completeness: {result.completeness}
              </span>
            </div>

            {result.found && (
              <div className="space-y-3">
                {/* Visual Step-by-Step Path */}
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Discovered Route
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                    {result.path_addresses.map((addr, idx) => (
                      <React.Fragment key={addr + idx}>
                        <span className={`px-2 py-1 rounded border ${
                          idx === 0
                            ? 'bg-cyan-950/60 border-cyan-500/40 text-cyan-300'
                            : idx === result.path_addresses.length - 1
                            ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                            : 'bg-slate-800 border-slate-700 text-slate-200'
                        }`}>
                          {addr.slice(0, 6)}...{addr.slice(-4)}
                        </span>
                        {idx < result.path_addresses.length - 1 && (
                          <ArrowRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* Edge Transactions Details */}
                {result.edges && result.edges.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      Supporting On-Chain Transfers
                    </div>
                    <div className="space-y-1.5">
                      {result.edges.map((edge, i) => (
                        <div key={i} className="p-2.5 bg-slate-950/60 border border-slate-800/80 rounded-md text-xs flex items-center justify-between">
                          <div>
                            <div className="font-mono text-slate-300 text-[11px]">
                              {edge.from.slice(0, 8)}... → {edge.to.slice(0, 8)}...
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                              tx: {edge.tx_hash.slice(0, 16)}...
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="font-mono font-semibold text-cyan-300">
                              {edge.amount_display} {edge.asset}
                            </span>
                            <div className="text-[10px] text-slate-500">
                              {new Date(edge.timestamp).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
};
