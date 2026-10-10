import React from 'react';
import { OperationProfile, Seed, ReappearanceLead, Lead } from '../../types';
import {
  Inbox,
  AlertTriangle,
  ArrowRight,
  Shield,
  Layers,
  Clock,
  Compass,
  Radio,
  Plus,
  RefreshCw,
  CheckCircle2
} from 'lucide-react';

interface InboxViewProps {
  operations: OperationProfile[];
  currentOperation: OperationProfile | null;
  onSelectOperation: (op: OperationProfile) => void;
  seeds: Seed[];
  reappearanceLeads: ReappearanceLead[];
  pendingLeads: Lead[];
  onOpenSeedModal: () => void;
  onNavigateToTab: (tab: any) => void;
  onResetDemo: () => void;
  isProcessing: boolean;
}

export const InboxView: React.FC<InboxViewProps> = ({
  operations,
  currentOperation,
  onSelectOperation,
  seeds,
  reappearanceLeads,
  pendingLeads,
  onOpenSeedModal,
  onNavigateToTab,
  onResetDemo,
  isProcessing
}) => {
  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Banner */}
      <div className="p-6 rounded-2xl bg-[#0b0f19] border border-[#162035] flex items-center justify-between shadow-xl">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-bold">
              Autonomous Investigation Engine Active
            </span>
          </div>
          <h1 className="text-xl font-bold text-slate-100">
            Investigative Workspace & Operations Queue
          </h1>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Continuous passive reconnaissance platform for cryptocurrency scam syndicates. Start with one seed—domain, wallet, IP, certificate, or template fingerprint—and reconstruct the temporal operation graph.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onOpenSeedModal}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg transition-all"
          >
            <Plus className="w-4 h-4 stroke-[2.2]" />
            <span>Ingest New Seed</span>
          </button>

          <button
            onClick={onResetDemo}
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[#0e1422] border border-[#1d273f] text-slate-300 hover:text-white text-xs font-medium transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
            <span>Reset Demo Case</span>
          </button>
        </div>
      </div>

      {/* Operational Case Cards */}
      <div className="space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
          <span>Active Scam Syndicate Investigations ({operations.length})</span>
          <span className="text-[11px] font-normal text-slate-500">Autonomous Temporal Profiles</span>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {operations.map(op => {
            const isSelected = op.id === currentOperation?.id;
            return (
              <div
                key={op.id}
                onClick={() => onSelectOperation(op)}
                className={`p-5 rounded-2xl border transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-[#0e1422] border-blue-500/50 shadow-xl ring-1 ring-blue-500/20'
                    : 'bg-[#0b0f19] border-[#162035] hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded bg-blue-950/80 border border-blue-600/50 text-blue-300">
                        {op.code}
                      </span>
                      <span className="text-xs font-semibold text-slate-300">
                        {op.targetType.toUpperCase()} INVESTIGATION
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-600/50 text-emerald-400 font-bold uppercase">
                        {op.status}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-slate-100">{op.name}</h3>
                  </div>

                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onSelectOperation(op);
                      onNavigateToTab('overview');
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 text-xs font-semibold transition-colors"
                  >
                    <span>Open Case Console</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed mb-4 max-w-4xl">
                  {op.summary}
                </p>

                {/* Sub-metrics */}
                <div className="grid grid-cols-4 gap-3 pt-3 border-t border-slate-800/80 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80">
                    <span className="text-[10px] text-slate-500 block uppercase">Root Seed</span>
                    <span className="text-slate-200 font-bold truncate block">{op.initialSeed}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80">
                    <span className="text-[10px] text-slate-500 block uppercase">Established Facts</span>
                    <span className="text-emerald-400 font-bold">{op.establishedFacts.length} Verified</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80">
                    <span className="text-[10px] text-slate-500 block uppercase">Unresolved Gaps</span>
                    <span className="text-amber-400 font-bold">{op.evidenceGaps.length} Open</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80">
                    <span className="text-[10px] text-slate-500 block uppercase">Actionable Leads</span>
                    <span className="text-sky-400 font-bold">{pendingLeads.length} Pending Pivot</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Reappearance Alerts & Monitoring Queue */}
      {reappearanceLeads.length > 0 && (
        <div className="p-5 rounded-2xl bg-[#0b0f19] border border-[#162035] space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold text-slate-100">
                Newly Flagged Reappearance Leads ({reappearanceLeads.length})
              </h3>
            </div>
            <button
              onClick={() => onNavigateToTab('monitoring')}
              className="text-xs text-blue-400 hover:text-blue-300 font-mono flex items-center gap-1"
            >
              <span>View Reappearance Matrix</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-2">
            {reappearanceLeads.map(lead => (
              <div
                key={lead.id}
                className="p-3.5 rounded-xl bg-[#0e1422] border border-[#1d273f] flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3">
                  <span className="px-2 py-0.5 rounded bg-emerald-950 border border-emerald-700/50 text-emerald-300 font-mono text-[10px] font-bold">
                    {lead.status}
                  </span>
                  <span className="font-mono font-bold text-slate-200">{lead.candidateValue}</span>
                  <span className="text-slate-400 truncate max-w-md">{lead.reasoning}</span>
                </div>
                <div className="font-mono text-emerald-400 font-bold text-xs shrink-0">
                  {lead.overallSimilarityScore}% Similarity Match
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
