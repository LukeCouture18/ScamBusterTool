import React, { useState, useEffect } from 'react';
import {
  CheckSquare,
  AlertTriangle,
  HelpCircle,
  Layers,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { ReviewItem, ReviewStatus } from '../types';

interface ReviewQueueViewProps {
  onSelectWalletAddress: (address: string) => void;
  onPromoteWallet: (sourceWalletId: string, address: string) => void;
}

export const ReviewQueueView: React.FC<ReviewQueueViewProps> = ({
  onSelectWalletAddress,
  onPromoteWallet,
}) => {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [activeStatus, setActiveStatus] = useState<ReviewStatus>('PENDING');
  const [isLoading, setIsLoading] = useState(true);
  const [decisionNotes, setDecisionNotes] = useState<{ [id: string]: string }>({});

  const fetchQueue = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/review-queue?status=${activeStatus}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(fetchQueue, 0);
    return () => window.clearTimeout(initial);
  }, [activeStatus]);

  const handleDecision = async (itemId: string, status: ReviewStatus) => {
    try {
      await fetch(`/api/review-queue/${itemId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          decision_notes: decisionNotes[itemId] || 'Decision applied by analyst',
          decided_by: 'analyst',
        }),
      });
      fetchQueue();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div id="review-queue-view" className="space-y-4">
      
      {/* Header & Status Tabs */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <CheckSquare className="w-4 h-4 text-cyan-400" />
            <span>Analyst Review Queue</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Surfaced items requiring human verification before promoting, dismissing, or accepting into final report.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            {(['PENDING', 'REVIEWED', 'PROMOTED', 'DISMISSED', 'DEFERRED'] as ReviewStatus[]).map((st) => (
              <button
                key={st}
                onClick={() => setActiveStatus(st)}
                className={`px-3 py-1 rounded font-medium transition-colors ${
                  activeStatus === st
                    ? 'bg-slate-800 text-cyan-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <button
            onClick={fetchQueue}
            className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg hover:bg-slate-800"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Review Queue Items List */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-500 text-xs">
          Loading review items...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-xs">
          No items currently marked as {activeStatus}.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 shadow-sm hover:border-slate-700 transition-colors"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                    item.item_type === 'connected_wallet'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : item.item_type === 'network_conflict'
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'bg-amber-500/20 text-amber-300'
                  }`}>
                    {item.item_type.toUpperCase()}
                  </span>
                  <span className="text-xs font-bold text-slate-100">{item.title}</span>
                </div>

                <span className="text-[11px] text-slate-500 font-mono">
                  Created: {new Date(item.created_at).toLocaleString()}
                </span>
              </div>

              {/* Explicit "Why It Needs Review" Box */}
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs">
                <span className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider block mb-1">
                  Why It Needs Review:
                </span>
                <p className="text-slate-200 leading-relaxed font-sans">
                  {item.why_it_needs_review}
                </p>
                {item.target_address && (
                  <div className="mt-2 text-slate-400 font-mono text-[11px]">
                    Target Address: <span className="text-cyan-400">{item.target_address}</span>
                  </div>
                )}
              </div>

              {/* Actions Row */}
              {activeStatus === 'PENDING' && (
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <input
                    type="text"
                    placeholder="Add decision justification notes..."
                    value={decisionNotes[item.id] || ''}
                    onChange={(e) =>
                      setDecisionNotes({ ...decisionNotes, [item.id]: e.target.value })
                    }
                    className="flex-1 min-w-[200px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-1 text-xs text-slate-100 placeholder-slate-600 focus:outline-none"
                  />

                  <div className="flex items-center gap-2">
                    {item.target_address && item.item_type === 'connected_wallet' && (
                      <button
                        onClick={() => {
                          onPromoteWallet(item.target_wallet_id || '', item.target_address!);
                          handleDecision(item.id, 'PROMOTED');
                        }}
                        className="px-3 py-1 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm"
                      >
                        Promote to Investigation
                      </button>
                    )}

                    <button
                      onClick={() => handleDecision(item.id, 'REVIEWED')}
                      className="px-3 py-1 text-xs font-medium bg-emerald-950 hover:bg-emerald-900/60 border border-emerald-500/30 text-emerald-300 rounded-lg"
                    >
                      Accept & Review
                    </button>

                    <button
                      onClick={() => handleDecision(item.id, 'DEFERRED')}
                      className="px-3 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg"
                    >
                      Defer
                    </button>

                    <button
                      onClick={() => handleDecision(item.id, 'DISMISSED')}
                      className="px-3 py-1 text-xs font-medium bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/30 text-rose-300 rounded-lg"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
};
