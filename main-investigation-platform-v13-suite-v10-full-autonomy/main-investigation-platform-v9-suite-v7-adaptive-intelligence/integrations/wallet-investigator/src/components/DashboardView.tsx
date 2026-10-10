import React from 'react';
import {
  Activity,
  Database,
  AlertTriangle,
  CheckSquare,
  Clock,
  ArrowRight,
  Server,
  Plus,
  GitFork,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import { DashboardStats } from '../types';

interface DashboardViewProps {
  stats: DashboardStats | null;
  isLoading: boolean;
  onNavigate: (view: string, filter?: string) => void;
  onOpenNewWallet: () => void;
  onOpenPathFinder: () => void;
  onSelectWallet: (walletId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  stats,
  isLoading,
  onNavigate,
  onOpenNewWallet,
  onOpenPathFinder,
  onSelectWallet,
}) => {
  return (
    <div id="dashboard-view-container" className="space-y-6">
      
      {/* Top Banner / Hero Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-100">Cryptocurrency Investigation Workspace</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                AUDIT COMPLIANT
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
              Defensive, read-only blockchain analysis and counterparty tracking. Every finding is linked to cryptographic provenance and observed website evidence.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onOpenPathFinder}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
            >
              <GitFork className="w-3.5 h-3.5 text-cyan-400" />
              <span>Multi-Hop Path Finder</span>
            </button>

            <button
              onClick={onOpenNewWallet}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Ingest Target Wallet</span>
            </button>
          </div>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Metric 1: Wallets */}
        <div
          onClick={() => onNavigate('wallets')}
          className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 p-4 rounded-xl cursor-pointer transition-all hover:bg-slate-800/40"
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Wallets Active</span>
            <Database className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-slate-100">
              {isLoading ? '...' : stats?.wallets_under_investigation ?? 0}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">tracked</span>
          </div>
        </div>

        {/* Metric 2: Active Analyses */}
        <div
          onClick={() => onNavigate('settings')}
          className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 p-4 rounded-xl cursor-pointer transition-all hover:bg-slate-800/40"
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Active Analyses</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-slate-100">
              {isLoading ? '...' : stats?.active_analyses ?? 0}
            </span>
            <span className="text-[10px] text-indigo-400 font-mono">background</span>
          </div>
        </div>

        {/* Metric 3: Needs Review */}
        <div
          onClick={() => onNavigate('review')}
          className={`border p-4 rounded-xl cursor-pointer transition-all ${
            (stats?.needs_review ?? 0) > 0
              ? 'bg-amber-950/20 border-amber-500/40 hover:bg-amber-950/30'
              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Needs Review</span>
            <CheckSquare className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-amber-300">
              {isLoading ? '...' : stats?.needs_review ?? 0}
            </span>
            <span className="text-[10px] text-amber-400/80 font-mono">pending</span>
          </div>
        </div>

        {/* Metric 4: Partial Data */}
        <div
          onClick={() => onNavigate('wallets', 'partial')}
          className={`border p-4 rounded-xl cursor-pointer transition-all ${
            (stats?.partial_analyses ?? 0) > 0
              ? 'bg-blue-950/20 border-blue-500/40 hover:bg-blue-950/30'
              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Partial History</span>
            <AlertTriangle className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-blue-300">
              {isLoading ? '...' : stats?.partial_analyses ?? 0}
            </span>
            <span className="text-[10px] text-blue-400/80 font-mono">truncated</span>
          </div>
        </div>

        {/* Metric 5: Factual Findings */}
        <div
          onClick={() => onNavigate('connections')}
          className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 p-4 rounded-xl cursor-pointer transition-all hover:bg-slate-800/40"
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Factual Findings</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-300">
              {isLoading ? '...' : stats?.total_findings ?? 0}
            </span>
            <span className="text-[10px] text-emerald-400/80 font-mono">evidence-linked</span>
          </div>
        </div>
      </div>

      {/* Main Content Split: Recent Activity & Integration Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left 2 Cols: Activity Feed & Quick Actions */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Quick Investigation Launchers */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
              Standard Investigation Workflows
            </h2>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={onOpenNewWallet}
                className="p-3 bg-slate-950/60 border border-slate-800 hover:border-cyan-500/50 rounded-lg text-left transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-slate-200 group-hover:text-cyan-300">
                    Investigate Website Deposit Wallet
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Ingest address with website URL, checkout context, and claimed tokens to establish chain of custody.
                </p>
              </button>

              <button
                onClick={onOpenPathFinder}
                className="p-3 bg-slate-950/60 border border-slate-800 hover:border-cyan-500/50 rounded-lg text-left transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-slate-200 group-hover:text-cyan-300">
                    Counterparty Path Query
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Evaluate whether two distinct wallets connect through multi-hop fund flows within budget bounds.
                </p>
              </button>
            </div>
          </div>

          {/* Real Recent Activity */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>Recent System Activity</span>
              </h2>
              <button
                onClick={() => onNavigate('settings')}
                className="text-[11px] text-cyan-400 hover:text-cyan-300"
              >
                View all jobs
              </button>
            </div>

            {stats?.recent_activity && stats.recent_activity.length > 0 ? (
              <div className="space-y-2">
                {stats.recent_activity.map((item, idx: number) => (
                  <div
                    key={idx}
                    className="p-2.5 bg-slate-950/50 border border-slate-800/80 rounded-lg flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`w-2 h-2 rounded-full ${
                        item.badge === 'COMPLETED' ? 'bg-emerald-400' : item.badge === 'PENDING' ? 'bg-amber-400' : 'bg-cyan-400'
                      }`} />
                      <div>
                        <span className="text-slate-200 font-medium">{item.title}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-right">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                        {item.badge}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {new Date(Number(item.timestamp)).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-xs text-slate-500">
                No recent activity recorded. Ingest a target wallet or load a test scenario to begin.
              </div>
            )}
          </div>

        </div>

        {/* Right Col: Main Investigation Platform v6 Integration Status */}
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Main Platform v6 Status
                </h3>
              </div>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {stats?.main_platform?.status || 'ONLINE'}
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Integrated with canonical Main Investigation Platform v6 schema, correlation IDs, and offline outbox replay.
            </p>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs space-y-2 font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Module ID:</span>
                <span className="text-slate-300">{stats?.main_platform?.module_id || 'wallet-investigator-v1'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Version:</span>
                <span className="text-slate-300">{stats?.main_platform?.version || '1.0.0'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Outbox Queued:</span>
                <span className="text-amber-400">{stats?.main_platform?.queued_outgoing_events_count ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Jobs Processed:</span>
                <span className="text-emerald-400">{stats?.main_platform?.processed_jobs_count ?? 0}</span>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-2">Registered Capabilities:</div>
              <div className="flex flex-wrap gap-1.5">
                {(stats?.main_platform?.capabilities || [
                  'blockchain-analysis',
                  'wallet-validation',
                  'counterparty-discovery',
                  'fund-flow-analysis',
                  'controlled-wallet-expansion',
                ]).map((cap: string) => (
                  <span key={cap} className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Defensive Investigative Safeguards Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Audit Safeguards Active
            </h3>
            <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
              <li>Read-only blockchain query operations</li>
              <li>Base-unit financial arithmetic without float drift</li>
              <li>Visible data completeness notifications</li>
              <li>Immutable evidence segregation</li>
              <li>Strictly objective, non-pejorative findings</li>
            </ul>
          </div>
        </div>

      </div>
    </div>
  );
};
