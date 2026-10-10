import React from 'react';
import {
  Inbox,
  LayoutGrid,
  Network,
  History,
  FileText,
  HelpCircle,
  Compass,
  Radio,
  Database,
  ShieldCheck,
  Hexagon
} from 'lucide-react';

export type NavTab =
  | 'inbox'
  | 'overview'
  | 'graph'
  | 'timeline'
  | 'evidence'
  | 'hypotheses'
  | 'leads'
  | 'monitoring';

interface SidebarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  evidenceCount: number;
  leadsPendingCount: number;
  hypothesesCount: number;
  reappearanceCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  evidenceCount,
  leadsPendingCount,
  hypothesesCount,
  reappearanceCount
}) => {
  return (
    <aside className="w-64 h-screen bg-[#090d16] border-r border-[#151c2d] flex flex-col justify-between select-none shrink-0 text-slate-300">
      {/* Top Header */}
      <div>
        <div className="h-16 px-4 flex items-center gap-3 border-b border-[#151c2d]">
          <div className="w-8 h-8 rounded-lg bg-blue-950/60 border border-blue-600/30 flex items-center justify-center text-blue-400">
            <Hexagon className="w-4 h-4 stroke-[2.2]" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold tracking-wider text-slate-100 uppercase">MAIN</span>
            <span className="text-[11px] text-slate-500 font-medium">Investigation Platform</span>
          </div>
        </div>

        {/* WORKSPACE section */}
        <div className="px-3 pt-5">
          <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Workspace
          </div>
          <button
            onClick={() => setActiveTab('inbox')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'inbox'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Inbox className="w-4 h-4 stroke-[1.8]" />
              <span>Inbox</span>
            </div>
            {reappearanceCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-600/40 text-amber-300 font-semibold">
                {reappearanceCount}
              </span>
            )}
          </button>
        </div>

        {/* ADVANCED section */}
        <div className="px-3 pt-6 space-y-1">
          <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Advanced
          </div>

          <button
            onClick={() => setActiveTab('overview')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'overview'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <LayoutGrid className="w-4 h-4 stroke-[1.8]" />
              <span>Overview</span>
            </div>
          </button>

          <button
            onClick={() => setActiveTab('graph')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'graph'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Network className="w-4 h-4 stroke-[1.8]" />
              <span>Operation Graph</span>
            </div>
          </button>

          <button
            onClick={() => setActiveTab('timeline')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'timeline'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <History className="w-4 h-4 stroke-[1.8]" />
              <span>Timeline</span>
            </div>
          </button>

          <button
            onClick={() => setActiveTab('evidence')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'evidence'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 stroke-[1.8]" />
              <span>Evidence</span>
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              {evidenceCount}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('hypotheses')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'hypotheses'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <HelpCircle className="w-4 h-4 stroke-[1.8]" />
              <span>Hypotheses</span>
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              {hypothesesCount}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('leads')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'leads'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Compass className="w-4 h-4 stroke-[1.8]" />
              <span>Leads</span>
            </div>
            {leadsPendingCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-950/80 border border-blue-500/30 text-blue-300 font-semibold">
                {leadsPendingCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('monitoring')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'monitoring'
                ? 'bg-blue-950/40 text-blue-300 border border-blue-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#111728]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Radio className="w-4 h-4 stroke-[1.8]" />
              <span>Monitoring</span>
            </div>
          </button>
        </div>
      </div>

      {/* Bottom Footer Section (matches screenshot) */}
      <div className="p-3 border-t border-[#151c2d] space-y-2">
        <div className="px-3 py-2.5 rounded-lg bg-[#0e1422] border border-[#1c263c] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-slate-400 stroke-[1.8]" />
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-slate-200">Central datastore</span>
              <span className="text-[10px] text-slate-500">D1 + evidence storage</span>
            </div>
          </div>
          <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"></span>
        </div>

        <div className="px-3 py-2 flex items-center gap-2.5 text-slate-400 text-xs hover:text-slate-300 transition-colors">
          <ShieldCheck className="w-4 h-4 stroke-[1.8]" />
          <span>API protection</span>
        </div>
      </div>
    </aside>
  );
};
