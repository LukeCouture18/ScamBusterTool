import React, { useState, useEffect } from 'react';
import { Layers, Star, ArrowRight, ShieldCheck, RefreshCw, Filter } from 'lucide-react';
import { ConnectedWalletRecord } from '../types';

interface ConnectionsViewProps {
  onSelectWalletAddress: (address: string) => void;
  onPromoteWallet: (sourceWalletId: string, address: string) => void;
}

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  onSelectWalletAddress,
  onPromoteWallet,
}) => {
  const [connections, setConnections] = useState<ConnectedWalletRecord[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const fetchConnections = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/wallets');
      const data = await res.json();
      const allConns: ConnectedWalletRecord[] = [];
      for (const w of data.wallets || []) {
        const detailRes = await fetch(`/api/wallets/${w.id}`);
        const detailData = await detailRes.json();
        if (detailData.connected_wallets) {
          allConns.push(...detailData.connected_wallets);
        }
      }
      setConnections(allConns);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(fetchConnections, 0);
    return () => window.clearTimeout(initial);
  }, []);

  const filtered = connections.filter((c) => c.relevance_score >= minScore);

  return (
    <div id="connections-view" className="space-y-4">
      
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span>Cross-Investigation Connected Wallets</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Wallets surfaced by the discovery engine across all active investigation entities.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Min Score:</span>
            <select
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-cyan-300 text-xs"
            >
              <option value={0}>All Scores (0+)</option>
              <option value={30}>Moderate (30+)</option>
              <option value={60}>High Relevance (60+)</option>
              <option value={80}>Critical Relevance (80+)</option>
            </select>
          </div>

          <button
            onClick={fetchConnections}
            className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg hover:bg-slate-800"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Grid of Surfaced Wallets */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-500 text-xs">
          Scanning cross-investigation relationships...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-xs">
          No connected counterparties scored above the current threshold.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((cw) => (
            <div
              key={cw.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3 shadow-sm hover:border-slate-700 transition-colors"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-slate-100">
                    {cw.connected_wallet_address.slice(0, 12)}...{cw.connected_wallet_address.slice(-6)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono text-[10px] font-bold">
                      Score: {cw.relevance_score}/100
                    </span>
                    {cw.is_promoted && (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold">
                        PROMOTED
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-slate-400 space-y-1">
                  <div className="text-[11px] font-semibold text-slate-300">Why It Was Surfaced:</div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-slate-400">
                    {cw.reasons.map((r: string, i: number) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                <button
                  onClick={() => onSelectWalletAddress(cw.connected_wallet_address)}
                  className="text-xs text-cyan-400 hover:text-cyan-300 underline"
                >
                  View in Graph / Explorer
                </button>

                {!cw.is_promoted && (
                  <button
                    onClick={() => onPromoteWallet(cw.source_wallet_id, cw.connected_wallet_address)}
                    className="px-3 py-1 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors"
                  >
                    Promote to Investigation
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
};
