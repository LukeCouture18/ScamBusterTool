import React, { useState } from 'react';
import {
  ShieldAlert,
  Search,
  Plus,
  GitFork,
  Activity,
  Server,
  Layers,
  ListOrdered,
  Share2,
  Clock,
  CheckSquare,
  Settings as SettingsIcon,
  Database,
  Download,
} from 'lucide-react';
import { MainPlatformIntegrationStatus } from '../types';

interface NavbarProps {
  activeView: string;
  onSelectView: (view: string) => void;
  onOpenNewWallet: () => void;
  onOpenPathFinder: () => void;
  pendingReviewCount: number;
  platformStatus?: MainPlatformIntegrationStatus;
  onGlobalSearch: (term: string) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView,
  onSelectView,
  onOpenNewWallet,
  onOpenPathFinder,
  pendingReviewCount,
  platformStatus,
  onGlobalSearch,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTerm.trim()) {
      onGlobalSearch(searchTerm.trim());
    }
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'wallets', label: 'Wallets', icon: Database },
    { id: 'transactions', label: 'Transactions', icon: ListOrdered },
    { id: 'connections', label: 'Connections', icon: Layers },
    { id: 'graph', label: 'Graph', icon: Share2 },
    { id: 'timeline', label: 'Timeline', icon: Clock },
    {
      id: 'review',
      label: 'Review',
      icon: CheckSquare,
      badge: pendingReviewCount > 0 ? pendingReviewCount : undefined,
    },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <header id="main-navigation-header" className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          
          {/* Logo & Defensive Badge */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => onSelectView('dashboard')}
              className="flex items-center gap-2.5 text-left focus:outline-none"
            >
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-slate-100 text-sm tracking-tight">Wallet Investigator</span>
                  <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30">
                    v1.0
                  </span>
                </div>
                <span className="text-[10px] text-slate-400 block -mt-0.5 tracking-wider uppercase font-mono">
                  Defensive • Read-Only
                </span>
              </div>
            </button>
          </div>

          {/* Nav Items */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  id={`nav-link-${item.id}`}
                  onClick={() => onSelectView(item.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors relative ${
                    isActive
                      ? 'bg-slate-800 text-cyan-300 shadow-sm border border-slate-700'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span className="ml-1 px-1.5 py-0.2 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-[10px] font-mono font-bold">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Search Bar & Actions */}
          <div className="flex items-center gap-2.5">
            <form onSubmit={handleSearchSubmit} className="relative hidden lg:block w-48 xl:w-64">
              <input
                id="global-search-input"
                type="text"
                placeholder="Search address, hash, domain..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-950/60 border border-slate-700 rounded-md pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
            </form>

            {/* Path Finder Button */}
            <button
              id="open-path-finder-btn"
              onClick={onOpenPathFinder}
              title="Find Path between Wallets"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors"
            >
              <GitFork className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Path Finder</span>
            </button>

            {/* Download Project ZIP Button */}
            <a
              id="download-project-zip-btn"
              href="/api/export-project-zip"
              download="wallet-investigator-project.zip"
              title="Download full project source code as ZIP"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/80 border border-emerald-500/30 rounded-md transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden md:inline">ZIP</span>
            </a>

            {/* New Wallet Button */}
            <button
              id="open-new-wallet-btn"
              onClick={onOpenNewWallet}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>New Wallet</span>
            </button>

            {/* Main Platform Status Indicator */}
            <div
              id="main-platform-v6-indicator"
              className="hidden sm:flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded bg-slate-950 border border-slate-800 text-slate-400"
              title="Main Investigation Platform v6 Integration Status"
            >
              <Server className="w-3 h-3 text-cyan-400" />
              <span>v6:</span>
              <span className="text-emerald-400 font-semibold">
                {platformStatus?.status || 'ONLINE'}
              </span>
            </div>

          </div>

        </div>
      </div>
    </header>
  );
};
