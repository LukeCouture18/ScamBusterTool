import React from 'react';
import {
  ShieldAlert,
  ListOrdered,
  PlusCircle,
  FileCode2,
  Network,
  History,
  CheckCircle2,
  Settings as SettingsIcon,
  User,
  Zap,
  Wand2,
  Download,
} from 'lucide-react';
import { UserSettings, InvestigationFinding } from '../types';
import { maskSecret } from '../utils/autoSubmitGate';

interface NavbarProps {
  activeTab: 'queue' | 'new' | 'form-mapping' | 'platform' | 'history' | 'tests';
  setActiveTab: (tab: 'queue' | 'new' | 'form-mapping' | 'platform' | 'history' | 'tests') => void;
  settings: UserSettings;
  openSettings: () => void;
  openFormWizard: () => void;
  openZipModal: () => void;
  queue: InvestigationFinding[];
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  settings,
  openSettings,
  openFormWizard,
  openZipModal,
  queue,
}) => {
  const readyCount = queue.filter((f) => f.overallStatus === 'READY').length;
  const reviewCount = queue.filter((f) => f.overallStatus === 'NEEDS_REVIEW').length;
  const blockedCount = queue.filter((f) => f.overallStatus === 'BLOCKED').length;

  return (
    <header className="sticky top-0 z-40 bg-slate-900 border-b border-slate-800 text-slate-100 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Title */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-rose-600 flex items-center justify-center shadow-lg shadow-amber-500/20 text-white font-bold">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-lg tracking-tight text-white">
                  Form Submitter
                </span>
                <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  Main suite · v9
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Real Google Form inspection, multi-page submission engine &amp; durable crash recovery
              </p>
            </div>
          </div>

          {/* Quick Investigator Credentials Badge, Wizard Button & Settings */}
          <div className="flex items-center gap-2.5">
            {/* Auto Submit Indicator Badge */}
            <div
              onClick={openSettings}
              className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                settings.autoSubmitGlobalEnabled
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                  : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:bg-slate-800'
              }`}
              title="Click to toggle Auto Submit Master Switch in Settings"
            >
              <Zap className={`w-3.5 h-3.5 ${settings.autoSubmitGlobalEnabled ? 'text-amber-400' : 'text-slate-500'}`} />
              <span>Auto-Submit: {settings.autoSubmitGlobalEnabled ? 'ARMED' : 'OFF'}</span>
            </div>

            {/* Form Setup Wizard Launch Button */}
            <button
              onClick={openFormWizard}
              id="navbar-form-wizard-button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 text-xs font-semibold transition-colors"
              title="Inspect authorized Google Form URL and setup visual mappings"
            >
              <Wand2 className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden md:inline">Form Setup Wizard</span>
            </button>

            {/* Download Project ZIP */}
            <button
              type="button"
              onClick={openZipModal}
              id="navbar-download-zip-button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition-colors"
              title="Export project archive ZIP via multiple download methods"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">Export ZIP</span>
            </button>

            {settings.username ? (
              <div
                onClick={openSettings}
                id="investigator-credential-badge"
                className="cursor-pointer hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 hover:border-slate-600 text-xs transition-colors"
                title="Click to edit Username or Team Invite Code"
              >
                <User className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-slate-300 font-medium">{settings.username}</span>
                <span className="text-slate-500">|</span>
                <span className="font-mono text-slate-400">
                  {settings.teamInviteCode ? maskSecret(settings.teamInviteCode) : 'No Code'}
                </span>
              </div>
            ) : (
              <button
                onClick={openSettings}
                id="setup-required-badge"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-medium animate-pulse hover:bg-amber-500/30 transition-colors"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Setup Required</span>
              </button>
            )}

            <button
              onClick={openSettings}
              id="open-settings-button"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title="Settings & Submitter Preferences"
            >
              <SettingsIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 overflow-x-auto py-2 border-t border-slate-800/60 no-scrollbar text-sm font-medium">
          <button
            onClick={() => setActiveTab('queue')}
            id="tab-queue"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'queue'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <ListOrdered className="w-4 h-4" />
            <span>Reports</span>
            {readyCount > 0 && (
              <span className={`text-xs px-1.5 py-0.2 rounded-full font-mono ${
                activeTab === 'queue' ? 'bg-slate-950 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {readyCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('new')}
            id="tab-new"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'new'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <PlusCircle className="w-4 h-4" />
            <span>New Finding</span>
          </button>

          <button
            onClick={() => setActiveTab('form-mapping')}
            id="tab-form-mapping"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'form-mapping'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>Form Mappings</span>
          </button>

          <button
            onClick={() => setActiveTab('platform')}
            id="tab-platform"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'platform'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Network className="w-4 h-4" />
            <span>Platform Integration</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            id="tab-history"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'history'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Audit History</span>
          </button>

          <details className="relative"><summary className="px-3 py-1.5 cursor-pointer">Advanced</summary><button
            onClick={() => setActiveTab('tests')}
            id="tab-tests"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all ${
              activeTab === 'tests'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Automated Tests</span>
          </button></details>
        </nav>
      </div>
    </header>
  );
};
