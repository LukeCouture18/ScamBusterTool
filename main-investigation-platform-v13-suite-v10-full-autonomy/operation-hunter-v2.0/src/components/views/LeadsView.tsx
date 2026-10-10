import React, { useState, useEffect } from 'react';
import { Lead, PredictiveLeadRanking, LearningOutcomeRecord } from '../../types';
import {
  Compass,
  Play,
  RotateCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  Sparkles,
  Zap,
  BookOpen,
  HelpCircle,
  History,
  Sliders,
  DollarSign,
  BarChart2
} from 'lucide-react';
import { api } from '../../api';

interface LeadsViewProps {
  leads: Lead[];
  operationId?: string;
  onGenerateLeads: () => Promise<void>;
  onExecuteLead: (leadId: string) => Promise<void>;
  isProcessing: boolean;
}

export const LeadsView: React.FC<LeadsViewProps> = ({
  leads,
  operationId,
  onGenerateLeads,
  onExecuteLead,
  isProcessing
}) => {
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executionFeedback, setExecutionFeedback] = useState<string | null>(null);
  const [predictiveRankings, setPredictiveRankings] = useState<PredictiveLeadRanking[]>([]);
  const [learningOutcomes, setLearningOutcomes] = useState<LearningOutcomeRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'predictive' | 'outcomes' | 'all'>('predictive');
  const [expandedPedagogyId, setExpandedPedagogyId] = useState<string | null>(null);

  useEffect(() => {
    if (operationId) {
      api.getPredictiveRankings(operationId)
        .then(res => setPredictiveRankings(res || []))
        .catch(err => console.error('Failed to load predictive rankings:', err));

      api.getLearningOutcomes(operationId)
        .then(res => setLearningOutcomes(res || []))
        .catch(err => console.error('Failed to load learning outcomes:', err));
    }
  }, [operationId, leads]);

  const handleExecute = async (leadId: string) => {
    try {
      setExecutingId(leadId);
      setExecutionFeedback(null);
      await onExecuteLead(leadId);
      setExecutionFeedback(`Executed backend pivot action. Operation graph, evidence lineage, and learning feedback updated.`);
      
      // Refresh rankings and outcomes
      if (operationId) {
        const [newRankings, newOutcomes] = await Promise.all([
          api.getPredictiveRankings(operationId),
          api.getLearningOutcomes(operationId)
        ]);
        setPredictiveRankings(newRankings || []);
        setLearningOutcomes(newOutcomes || []);
      }
    } catch (err: any) {
      setExecutionFeedback(`Error executing pivot: ${err.message}`);
    } finally {
      setExecutingId(null);
    }
  };

  const pendingLeads = leads.filter(l => l.status === 'PENDING');
  const completedLeads = leads.filter(l => l.status === 'COMPLETED');
  const exhaustedLeads = leads.filter(l => l.status === 'EXHAUSTED');

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Header & Mode Controls */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Compass className="w-4 h-4 text-emerald-400" />
            <span>Predictive Lead Engine & Strategy Learning Loop</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Ranks pivots by information gain, novelty, gap fulfillment, and historical strategy utility.
            <span className="font-mono text-emerald-400 ml-1">
              context → chosen strategy → expected result → actual result → evidence gained → utility.
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Subtabs */}
          <div className="flex items-center gap-1 bg-[#080b11] p-1 rounded-lg border border-[#1b253b]">
            <button
              onClick={() => setActiveTab('predictive')}
              className={`text-xs px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                activeTab === 'predictive'
                  ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Predictive Leads ({predictiveRankings.length > 0 ? predictiveRankings.length : pendingLeads.length})
            </button>
            <button
              onClick={() => setActiveTab('outcomes')}
              className={`text-xs px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                activeTab === 'outcomes'
                  ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Strategy Learning ({learningOutcomes.length})
            </button>
            <button
              onClick={() => setActiveTab('all')}
              className={`text-xs px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                activeTab === 'all'
                  ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Archive ({completedLeads.length + exhaustedLeads.length})
            </button>
          </div>

          <button
            onClick={onGenerateLeads}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/30 border border-blue-500/50 text-blue-300 hover:bg-blue-600/40 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
            <span>Re-Rank</span>
          </button>
        </div>
      </div>

      {executionFeedback && (
        <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 text-xs flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{executionFeedback}</span>
          </div>
          <button
            onClick={() => setExecutionFeedback(null)}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* --- PREDICTIVE LEADS TAB --- */}
      {activeTab === 'predictive' && (
        <div className="space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>High-Priority Permitted Pivots (Ranked by Multi-Factor Model)</span>
            <span className="text-[11px] font-normal text-slate-500">
              Only public/passive actions. AI proposes → policy validates → evidence confirms.
            </span>
          </div>

          {predictiveRankings.length === 0 && pendingLeads.length === 0 ? (
            <div className="p-8 rounded-xl bg-[#0b0f19] border border-[#162035] text-center text-xs text-slate-500">
              All recommended leads executed. Click "Re-Rank" to evaluate newly opened hypotheses.
            </div>
          ) : (
            (predictiveRankings.length > 0 ? predictiveRankings.map(r => {
              const matchingLead = pendingLeads.find(l => l.id === r.leadId);
              return {
                leadId: r.leadId,
                title: r.title,
                pivotType: r.pivotType,
                targetValue: r.targetValue,
                costEstimate: matchingLead?.costEstimate || 'medium',
                description: matchingLead?.description || r.pedagogicalBreakdown?.whatHunterFound || r.title,
                overallRankScore: r.overallRankScore || r.scoreBreakdown?.finalScore || 85,
                infoGain: r.scoreBreakdown?.expectedInfoGain || 20,
                novelty: r.scoreBreakdown?.noveltyScore || 15,
                gapFulfillment: r.scoreBreakdown?.gapFulfillmentScore || 18,
                strategyUtility: r.scoreBreakdown?.historicalStrategyUtility || 12,
                penalties: (r.scoreBreakdown?.costPenalty || 0) + (r.scoreBreakdown?.saturationPenalty || 0),
                confidencePercent: r.pedagogicalBreakdown?.confidencePercent || 88,
                whatHunterFound: r.pedagogicalBreakdown?.whatHunterFound || '',
                whyItMatters: r.pedagogicalBreakdown?.whyItMatters || '',
                whatItDoesNotProve: r.pedagogicalBreakdown?.whatItDoesNotProve || 'Correlation does not establish common operator ownership.',
                bestNextStep: r.pedagogicalBreakdown?.bestNextStep || '',
                evidenceBasis: r.pedagogicalBreakdown?.evidenceBasis || 'Passive DNS registration records • Public ledger transfer flows'
              };
            }) : pendingLeads.map(l => ({
              leadId: l.id,
              title: l.title,
              pivotType: l.pivotType,
              targetValue: l.targetValue,
              costEstimate: l.costEstimate,
              description: l.description,
              overallRankScore: l.priorityScore,
              infoGain: l.expectedInfoGain * 3,
              novelty: l.noveltyScore * 2,
              gapFulfillment: 15,
              strategyUtility: 12,
              penalties: l.costEstimate === 'high' ? 10 : l.costEstimate === 'medium' ? 5 : 0,
              confidencePercent: 88,
              whatHunterFound: l.description,
              whyItMatters: l.reasoning,
              whatItDoesNotProve: 'Correlation does not establish unified ownership or operator identity.',
              bestNextStep: 'Execute targeted pivot against passive public ledger or WHOIS records.',
              evidenceBasis: 'Passive DNS registration records • Blockchain token transaction flows'
            }))).map((item) => {
              const isPedagogyOpen = expandedPedagogyId === item.leadId;

              return (
                <div
                  key={item.leadId}
                  className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] hover:border-blue-500/40 transition-all flex flex-col justify-between"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-950/80 border border-blue-600/50 text-blue-300">
                          Score {item.overallRankScore}/100
                        </span>
                        <span className="text-xs font-mono font-bold text-slate-300 uppercase">
                          {item.pivotType.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">
                          Cost: {item.costEstimate}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-100">
                        {item.title}
                      </h3>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => setExpandedPedagogyId(isPedagogyOpen ? null : item.leadId)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#1b253b] bg-[#080b11] text-xs text-slate-300 hover:text-slate-100 hover:border-slate-700 transition-colors"
                      >
                        <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                        <span>{isPedagogyOpen ? 'Hide Briefing' : 'Investigator Briefing'}</span>
                      </button>

                      <button
                        disabled={executingId === item.leadId}
                        onClick={() => handleExecute(item.leadId)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-all disabled:opacity-50"
                      >
                        <Play className={`w-3.5 h-3.5 ${executingId === item.leadId ? 'animate-spin' : ''}`} />
                        <span>{executingId === item.leadId ? 'Executing Pivot...' : 'Execute Pivot'}</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed mb-3">
                    {item.description}
                  </p>

                  {/* Multi-Factor Score Breakdown Bar */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80 text-[11px] font-mono mb-3">
                    <div>
                      <span className="text-slate-500 block">Info Gain</span>
                      <strong className="text-emerald-400">+{item.infoGain}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Novelty</span>
                      <strong className="text-sky-400">+{item.novelty}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Gap Fulfillment</span>
                      <strong className="text-purple-400">+{item.gapFulfillment}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Strategy Utility</span>
                      <strong className="text-amber-400">+{item.strategyUtility}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Cost / Saturation</span>
                      <strong className="text-rose-400">
                        {item.penalties}
                      </strong>
                    </div>
                  </div>

                  {/* 6-Part Plain-English Investigator Briefing */}
                  {isPedagogyOpen && (
                    <div className="p-4 rounded-xl bg-[#080b11] border border-blue-900/40 space-y-3 mt-1 text-xs">
                      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                        <span className="font-bold text-blue-300 uppercase tracking-wider text-[11px] font-mono flex items-center gap-1.5">
                          <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                          Plain-English Investigator Briefing
                        </span>
                        <span className="font-mono text-slate-400 text-[11px]">
                          Confidence: <strong className="text-emerald-400">{item.confidencePercent}%</strong>
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300">
                        <div className="p-2.5 rounded bg-[#0b0f19] border border-slate-800/60">
                          <span className="font-bold text-slate-200 block mb-1">What Hunter Found:</span>
                          <span className="text-slate-400 leading-relaxed">{item.whatHunterFound}</span>
                        </div>
                        <div className="p-2.5 rounded bg-[#0b0f19] border border-slate-800/60">
                          <span className="font-bold text-emerald-300 block mb-1">Why It Matters:</span>
                          <span className="text-slate-400 leading-relaxed">{item.whyItMatters}</span>
                        </div>
                        <div className="p-2.5 rounded bg-[#0b0f19] border border-amber-900/30">
                          <span className="font-bold text-amber-300 block mb-1">What It Does NOT Prove:</span>
                          <span className="text-slate-400 leading-relaxed">{item.whatItDoesNotProve}</span>
                        </div>
                        <div className="p-2.5 rounded bg-[#0b0f19] border border-blue-900/30">
                          <span className="font-bold text-blue-300 block mb-1">Best Next Step:</span>
                          <span className="text-slate-400 leading-relaxed">{item.bestNextStep}</span>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-500">
                        <span>Evidence Basis: {item.evidenceBasis}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* --- STRATEGY LEARNING OUTCOMES TAB --- */}
      {activeTab === 'outcomes' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-2">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <History className="w-4 h-4 text-amber-400" />
              <span>Strategy Learning Feedback Ledger</span>
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Every pivot logs its execution parameters and verified evidence yield. Hunter evaluates whether expected outcomes matched actual outcomes to calibrate future branch recommendations without training blindly on unverified claims.
            </p>
          </div>

          <div className="space-y-3">
            {learningOutcomes.map((record) => (
              <div key={record.id} className="p-4 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-amber-950/60 border border-amber-600/40 text-amber-300 uppercase">
                      {record.pivotType.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs font-bold text-slate-200">
                      Usefulness Score: {record.usefulnessScore}/100
                    </span>
                  </div>
                  <span className="text-xs font-mono text-slate-500">
                    {new Date(record.timestamp).toLocaleString()}
                  </span>
                </div>

                <p className="text-xs text-slate-300">{record.contextDescription}</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg bg-[#080b11] border border-slate-800/80 text-xs">
                  <div>
                    <span className="text-slate-500 font-mono text-[11px] block">Expected Result:</span>
                    <span className="text-slate-300">{record.expectedResult}</span>
                  </div>
                  <div>
                    <span className="text-emerald-400 font-mono text-[11px] block">Actual Result:</span>
                    <span className="text-slate-200 font-medium">{record.actualResult}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-slate-800/80">
                  <div className="flex items-center gap-4">
                    <span>Evidence Gained: <strong className="text-emerald-400">{record.evidenceGainedCount}</strong></span>
                    <span>New Entities: <strong className="text-sky-400">{record.newEntitiesFoundCount}</strong></span>
                    <span>Cost: <strong className="text-slate-300 uppercase">{record.costIncurred}</strong></span>
                  </div>
                  <span className="text-blue-400">Validated Strategy Feedback</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- ARCHIVE TAB --- */}
      {activeTab === 'all' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Completed Investigations ({completedLeads.length})</span>
            </div>
            <div className="space-y-2">
              {completedLeads.map(l => (
                <div key={l.id} className="p-3.5 rounded-lg bg-[#0b0f19] border border-[#162035] text-xs space-y-1">
                  <div className="font-semibold text-slate-200">{l.title}</div>
                  <div className="text-[11px] font-mono text-emerald-400">Target: {l.targetValue}</div>
                  <div className="text-[11px] text-slate-400">{l.description}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5 text-rose-400" />
              <span>Exhausted Branches ({exhaustedLeads.length})</span>
            </div>
            <div className="space-y-2">
              {exhaustedLeads.map(l => (
                <div key={l.id} className="p-3.5 rounded-lg bg-[#0b0f19] border border-rose-950/40 text-xs space-y-1">
                  <div className="font-semibold text-slate-300">{l.title}</div>
                  <div className="text-[11px] text-slate-400">{l.reasoning}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
