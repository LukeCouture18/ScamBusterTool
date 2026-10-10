import React, { useState } from 'react';
import { Hypothesis, AIAnalysisResult } from '../../types';
import {
  HelpCircle,
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  RotateCw,
  Plus,
  ArrowRight,
  Brain,
  Scale,
  CheckCircle2,
  XCircle
} from 'lucide-react';

interface HypothesesViewProps {
  hypotheses: Hypothesis[];
  onEvaluateHypotheses: () => Promise<void>;
  onCreateHypothesis: (data: { title: string; description: string; category?: string }) => Promise<void>;
  onRunAiAnalysis: () => Promise<AIAnalysisResult>;
  isProcessing: boolean;
}

export const HypothesesView: React.FC<HypothesesViewProps> = ({
  hypotheses,
  onEvaluateHypotheses,
  onCreateHypothesis,
  onRunAiAnalysis,
  isProcessing
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('SHARED_BULLETPROOF_HOSTING');
  const [aiResult, setAiResult] = useState<AIAnalysisResult | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newDesc.trim()) return;
    await onCreateHypothesis({ title: newTitle.trim(), description: newDesc.trim(), category: newCategory });
    setNewTitle('');
    setNewDesc('');
    setShowCreateModal(false);
  };

  const handleAiChallenge = async () => {
    try {
      setIsAiLoading(true);
      const res = await onRunAiAnalysis();
      setAiResult(res);
    } finally {
      setIsAiLoading(false);
    }
  };

  const getStatusBadge = (status: Hypothesis['status']) => {
    switch (status) {
      case 'STRONGLY_SUPPORTED':
        return { label: 'STRONGLY SUPPORTED', color: 'bg-emerald-950/70 border-emerald-600/50 text-emerald-400' };
      case 'WEAKENED':
        return { label: 'WEAKENED', color: 'bg-amber-950/70 border-amber-600/50 text-amber-300' };
      case 'CONTRADICTED':
        return { label: 'CONTRADICTED', color: 'bg-rose-950/70 border-rose-600/50 text-rose-400' };
      default:
        return { label: 'FORMULATED', color: 'bg-blue-950/70 border-blue-600/50 text-blue-300' };
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Header */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Scale className="w-4 h-4 text-amber-400" />
            <span>Hypothesis Engine: Competing Explanations & Falsification</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Actively counter confirmation bias by generating competing theories. Track what strengthens, weakens, or resolves each hypothesis.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAiChallenge}
            disabled={isAiLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-950/50 border border-purple-700/50 text-purple-300 hover:bg-purple-950/80 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            <Brain className={`w-3.5 h-3.5 ${isAiLoading ? 'animate-spin' : ''}`} />
            <span>{isAiLoading ? 'Challenging Theories...' : 'AI Devil\'s Advocate Challenge'}</span>
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/30 border border-blue-500/50 text-blue-300 hover:bg-blue-600/40 text-xs font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Propose Alternative Theory</span>
          </button>
        </div>
      </div>

      {/* AI Analytical Assessment Box (Strictly labeled as Analytical Assessment, Never Evidence) */}
      {aiResult && (
        <div className="p-5 rounded-xl bg-[#120d22] border border-purple-800/50 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-purple-900/50">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span className="text-xs font-bold text-purple-200">
                AI Analytical Assessment ({aiResult.engineUsed})
              </span>
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-purple-950 border border-purple-700/60 text-purple-300 font-bold">
                Analytical Reasoning — Never Factual Evidence
              </span>
            </div>
            <button
              onClick={() => setAiResult(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Dismiss
            </button>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            {aiResult.aiReasoning}
          </p>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="p-3 rounded-lg bg-[#0b0f19] border border-purple-900/40 space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-purple-400 block">
                Uncovered Investigation Blindspots
              </span>
              <ul className="text-xs text-slate-300 space-y-1 list-disc list-inside">
                {aiResult.uncoveredBlindspots.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>

            <div className="p-3 rounded-lg bg-[#0b0f19] border border-purple-900/40 space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 block">
                Recommended Safe Next Investigation Step
              </span>
              <p className="text-xs text-slate-300 leading-relaxed">
                {aiResult.recommendedSafeNextStep}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Competing Hypotheses Cards Grid */}
      <div className="grid grid-cols-2 gap-4">
        {hypotheses.map(hyp => {
          const badge = getStatusBadge(hyp.status);
          return (
            <div
              key={hyp.id}
              className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex flex-col justify-between hover:border-blue-500/40 transition-colors"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${badge.color}`}>
                    {badge.label}
                  </span>
                  <div className="flex items-center gap-1.5 text-xs font-mono">
                    <span className="text-slate-400">Confidence:</span>
                    <strong className="text-blue-400 font-bold">{Math.round(hyp.confidenceScore * 100)}%</strong>
                  </div>
                </div>

                <h3 className="text-sm font-bold text-slate-100 mb-2 leading-snug">
                  {hyp.title}
                </h3>

                <p className="text-xs text-slate-300 leading-relaxed mb-4">
                  {hyp.description}
                </p>

                {/* Supporting Observations */}
                <div className="space-y-2 mb-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Supporting Observations ({hyp.supportingObservations.length})</span>
                  </div>
                  <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                    {hyp.supportingObservations.map((obs, i) => (
                      <li key={i} className="leading-relaxed">{obs}</li>
                    ))}
                  </ul>
                </div>

                {/* Contradicting Observations */}
                {hyp.contradictingObservations.length > 0 && (
                  <div className="space-y-2 mb-3">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Contradicting Observations ({hyp.contradictingObservations.length})</span>
                    </div>
                    <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                      {hyp.contradictingObservations.map((obs, i) => (
                        <li key={i} className="leading-relaxed text-rose-300/90">{obs}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Falsification Criteria Box */}
              <div className="pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-400 space-y-1.5 bg-[#080b11] p-3 rounded-lg mt-2">
                <div>
                  <span className="text-slate-500">Conditions to Strengthen: </span>
                  <span className="text-slate-300">{hyp.conditionsToStrengthen[0] || 'Corroborating technical artifact required.'}</span>
                </div>
                <div>
                  <span className="text-slate-500">Conditions to Weaken: </span>
                  <span className="text-slate-300">{hyp.conditionsToWeaken[0] || 'Evidence of external operator key control.'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Propose Hypothesis Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#0b0f19] border border-[#1a2337] rounded-2xl p-6 shadow-2xl">
            <h3 className="text-base font-bold text-slate-100 mb-1">
              Propose Competing Hypothesis
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              Formulate an alternative explanation for observable infrastructure or financial relationships.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Theory Classification</label>
                <select
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
                >
                  <option value="COMMON_OPERATOR">COMMON_OPERATOR (Same Threat Group)</option>
                  <option value="SHARED_BULLETPROOF_HOSTING">SHARED_BULLETPROOF_HOSTING (Co-Tenancy Neighbor)</option>
                  <option value="SCAM_KIT_SYNDICATION">SCAM_KIT_SYNDICATION (Turnkey DaaS Customer)</option>
                  <option value="CASH_OUT_SERVICE">CASH_OUT_SERVICE (Third-Party Laundering Service)</option>
                  <option value="FALSE_POSITIVE">FALSE_POSITIVE (Coincidental Pattern)</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Hypothesis Title</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="e.g. Syndicated Phishing Franchisee utilizing Shared Bulletproof Proxy"
                  className="w-full text-xs px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Detailed Explanation & Reasoning</label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="Explain why this theory accounts for current observations..."
                  className="w-full text-xs px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#1a2337]">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                >
                  Register Hypothesis
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
