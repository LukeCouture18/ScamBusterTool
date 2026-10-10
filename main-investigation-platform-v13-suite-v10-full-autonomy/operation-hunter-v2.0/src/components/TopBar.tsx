import React from 'react';
import { OperationProfile } from '../types';
import { Plus, RefreshCw, ChevronDown, Download } from 'lucide-react';

interface TopBarProps {
  currentOperation: OperationProfile | null;
  operations: OperationProfile[];
  onSelectOperation: (op: OperationProfile) => void;
  onOpenSeedModal: () => void;
  onResetDemo: () => void;
  isProcessing: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  currentOperation,
  operations,
  onSelectOperation,
  onOpenSeedModal,
  onResetDemo,
  isProcessing
}) => {
  const [dropdownOpen, setDropdownOpen] = React.useState(false);

  return (
    <header className="h-16 px-6 bg-[#080b11] border-b border-[#151c2d] flex items-center justify-between select-none shrink-0 z-20">
      {/* Left: Status Pill matching screenshot */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
          <span className="text-xs text-slate-300 font-medium">Central hub</span>
          <span className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/50 text-emerald-400 uppercase">
            LIVE
          </span>
        </div>

        <div className="h-4 w-[1px] bg-slate-800" />

        {/* Operation Selector */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0e1422] border border-[#1d273f] text-xs font-medium text-slate-200 hover:border-blue-500/50 transition-colors"
          >
            <span className="font-mono text-blue-400 font-bold">{currentOperation?.code || 'NO OPERATION'}</span>
            <span className="text-slate-400 truncate max-w-[200px]">{currentOperation?.name}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-1" />
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 mt-2 w-72 bg-[#0e1422] border border-[#1d273f] rounded-lg shadow-2xl py-1 z-50">
              <div className="px-3 py-1.5 text-[10px] font-bold uppercase text-slate-500 tracking-wider">
                Reconstructed Operations
              </div>
              {operations.map(op => (
                <button
                  key={op.id}
                  onClick={() => {
                    onSelectOperation(op);
                    setDropdownOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs flex flex-col hover:bg-blue-950/30 transition-colors ${
                    op.id === currentOperation?.id ? 'bg-blue-950/40 text-blue-300' : 'text-slate-300'
                  }`}
                >
                  <span className="font-mono font-bold text-[11px] text-blue-400">{op.code}</span>
                  <span className="truncate text-slate-400">{op.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Actions, Platform Label & OP user pill */}
      <div className="flex items-center gap-4">
        {/* Core Quick Buttons */}
        <button
          onClick={onOpenSeedModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 text-xs font-semibold transition-all shadow-sm"
        >
          <Plus className="w-3.5 h-3.5 stroke-[2.2]" />
          <span>Ingest Seed</span>
        </button>

        <button
          onClick={onResetDemo}
          title="Reset to pristine reference investigation dataset"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0e1422] border border-[#1d273f] text-slate-400 hover:text-slate-200 text-xs transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
          <span>Reset Demo</span>
        </button>

        <a
          href="#/"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-950/40 border border-blue-700/50 text-blue-300 hover:bg-blue-900/40 text-xs font-medium transition-colors"
        >
          <span>← Back to Hunter v1.0</span>
        </a>

        <a
          href="/api/download-zip"
          download="operation-hunter-v1.0.zip"
          title="Download complete project source code and data as ZIP archive"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/40 text-xs font-medium transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Download ZIP</span>
        </a>

        <div className="h-4 w-[1px] bg-slate-800" />

        <span className="text-xs text-slate-500 font-medium font-mono">Classic views · v1.0</span>

        {/* User Pill matching screenshot OP badge */}
        <div className="w-8 h-8 rounded-lg bg-[#141b2c] border border-blue-700/40 flex items-center justify-center text-blue-300 font-mono text-xs font-bold shadow-inner">
          OP
        </div>
      </div>
    </header>
  );
};
