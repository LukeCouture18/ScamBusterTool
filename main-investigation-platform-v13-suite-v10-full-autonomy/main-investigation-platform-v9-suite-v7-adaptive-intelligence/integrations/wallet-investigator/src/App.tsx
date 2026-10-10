import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { DashboardView } from './components/DashboardView';
import { WalletsView } from './components/WalletsView';
import { WalletDetailView } from './components/WalletDetailView';
import { TransactionExplorerView } from './components/TransactionExplorerView';
import { ConnectionsView } from './components/ConnectionsView';
import { GraphView } from './components/GraphView';
import { ReviewQueueView } from './components/ReviewQueueView';
import { SettingsView } from './components/SettingsView';
import { NewWalletModal } from './components/NewWalletModal';
import { PathFinderModal } from './components/PathFinderModal';
import { ExportModal } from './components/ExportModal';
import {
  ConnectedWalletRecord,
  CounterpartyRecord,
  DashboardStats,
  EvidenceRecord,
  FindingRecord,
  FundFlowPatternRecord,
  NormalizedTransaction,
  WalletEntity,
  WalletObservation,
} from './types';

export default function App() {
  const [activeView, setActiveView] = useState<string>('wallets');
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  // Core Data
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [wallets, setWallets] = useState<WalletEntity[]>([]);
  const [isLoadingWallets, setIsLoadingWallets] = useState(true);
  const [isLoadingStats, setIsLoadingStats] = useState(true);

  // Wallet Detail State
  const [activeWalletDetail, setActiveWalletDetail] = useState<{
    wallet: WalletEntity;
    observations: WalletObservation[];
    transactions: NormalizedTransaction[];
    counterparties: CounterpartyRecord[];
    connected_wallets: ConnectedWalletRecord[];
    fund_flows: FundFlowPatternRecord[];
    findings: FindingRecord[];
    evidence: EvidenceRecord[];
  } | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Modals
  const [isNewWalletOpen, setIsNewWalletOpen] = useState(false);
  const [isPathFinderOpen, setIsPathFinderOpen] = useState(false);
  const [pathFinderSource, setPathFinderSource] = useState<string>('');
  const [isExportOpen, setIsExportOpen] = useState(false);

  // Initial Load & Background Polling
  const fetchDashboardStats = async () => {
    try {
      const res = await fetch('/api/stats/dashboard');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Error fetching dashboard stats:', err);
    } finally {
      setIsLoadingStats(false);
    }
  };

  const fetchWallets = async () => {
    try {
      const res = await fetch('/api/wallets');
      if (res.ok) {
        const data = await res.json();
        setWallets(data.wallets || []);
      }
    } catch (err) {
      console.error('Error fetching wallets:', err);
    } finally {
      setIsLoadingWallets(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(() => { fetchDashboardStats(); fetchWallets(); }, 0);

    const interval = setInterval(() => {
      fetchDashboardStats();
    }, 4000);

    return () => { window.clearTimeout(initial); clearInterval(interval); };
  }, []);

  // Fetch Wallet Detail when selected
  useEffect(() => {
    if (!selectedWalletId) {
      const reset = window.setTimeout(() => setActiveWalletDetail(null), 0);
      return () => window.clearTimeout(reset);
    }

    const pending = window.setTimeout(() => setIsLoadingDetail(true), 0);
    fetch(`/api/wallets/${selectedWalletId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) {
          setActiveWalletDetail(data);
        }
      })
      .catch((err) => console.error(err))
      .finally(() => setIsLoadingDetail(false));
    return () => window.clearTimeout(pending);
  }, [selectedWalletId]);

  const handleSelectWallet = (walletId: string) => {
    setSelectedWalletId(walletId);
    setActiveView('wallet_detail');
  };

  const handleSelectWalletByAddress = async (address: string) => {
    try {
      const res = await fetch(`/api/wallets/${address}`);
      const data = await res.json();
      if (data && data.wallet) {
        setSelectedWalletId(data.wallet.id);
        setActiveView('wallet_detail');
      } else {
        // Fallback: switch to wallets list and search address
        setActiveView('wallets');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleBookmark = async (walletId: string) => {
    try {
      const res = await fetch(`/api/wallets/${walletId}/bookmark`, { method: 'POST' });
      const data = await res.json();
      setWallets((prev) =>
        prev.map((w) => (w.id === walletId ? { ...w, is_bookmarked: data.is_bookmarked } : w))
      );
      if (activeWalletDetail && activeWalletDetail.wallet.id === walletId) {
        setActiveWalletDetail({
          ...activeWalletDetail,
          wallet: { ...activeWalletDetail.wallet, is_bookmarked: data.is_bookmarked },
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleRunAnalysis = async (walletId: string, profile: 'QUICK' | 'STANDARD' | 'DEEP') => {
    try {
      await fetch(`/api/wallets/${walletId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      fetchDashboardStats();
      fetchWallets();
      if (selectedWalletId === walletId) {
        setTimeout(() => {
          setSelectedWalletId(walletId);
        }, 1200);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateNotes = async (notes: string, tags: string[]) => {
    if (!selectedWalletId) return;
    try {
      await fetch(`/api/wallets/${selectedWalletId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, tags }),
      });
      fetchWallets();
      if (activeWalletDetail) {
        setActiveWalletDetail({
          ...activeWalletDetail,
          wallet: { ...activeWalletDetail.wallet, notes, tags },
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handlePromoteWallet = async (sourceWalletId: string, address: string) => {
    try {
      const res = await fetch('/api/connected-wallets/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_wallet_id: sourceWalletId,
          connected_address: address,
          justification: 'Analyst promoted counterparty for investigation',
        }),
      });
      const data = await res.json();
      if (data.success && data.walletId) {
        fetchWallets();
        fetchDashboardStats();
        handleSelectWallet(data.walletId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenPathFinderWithSource = (address?: string) => {
    setPathFinderSource(address || '');
    setIsPathFinderOpen(true);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      
      {/* Top Main Navigation */}
      <Navbar
        activeView={activeView === 'wallet_detail' ? 'wallets' : activeView}
        onSelectView={(view) => {
          setActiveView(view);
          if (view !== 'wallet_detail') setSelectedWalletId(null);
        }}
        onOpenNewWallet={() => setIsNewWalletOpen(true)}
        onOpenPathFinder={() => handleOpenPathFinderWithSource()}
        pendingReviewCount={stats?.needs_review || 0}
        platformStatus={stats?.main_platform}
        onGlobalSearch={(term) => {
          setActiveView('wallets');
        }}
      />

      {/* Main Workspace Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        
        {/* VIEW 1: Dashboard */}
        {activeView === 'dashboard' && (
          <DashboardView
            stats={stats}
            isLoading={isLoadingStats}
            onNavigate={(view) => setActiveView(view)}
            onOpenNewWallet={() => setIsNewWalletOpen(true)}
            onOpenPathFinder={() => handleOpenPathFinderWithSource()}
            onSelectWallet={handleSelectWallet}
          />
        )}

        {/* VIEW 2: Wallets Inventory */}
        {activeView === 'wallets' && (
          <WalletsView
            wallets={wallets}
            isLoading={isLoadingWallets}
            onSelectWallet={handleSelectWallet}
            onOpenNewWallet={() => setIsNewWalletOpen(true)}
            onToggleBookmark={handleToggleBookmark}
            onRefreshList={() => {
              fetchWallets();
              fetchDashboardStats();
            }}
          />
        )}

        {/* VIEW 3: Detailed Wallet Workspace */}
        {activeView === 'wallet_detail' && (
          isLoadingDetail || !activeWalletDetail ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center text-slate-400 text-xs">
              Loading wallet investigation dossier...
            </div>
          ) : (
            <WalletDetailView
              wallet={activeWalletDetail.wallet}
              observations={activeWalletDetail.observations}
              transactions={activeWalletDetail.transactions}
              counterparties={activeWalletDetail.counterparties}
              connectedWallets={activeWalletDetail.connected_wallets}
              fundFlows={activeWalletDetail.fund_flows}
              findings={activeWalletDetail.findings}
              evidence={activeWalletDetail.evidence}
              onBack={() => {
                setActiveView('wallets');
                setSelectedWalletId(null);
              }}
              onToggleBookmark={handleToggleBookmark}
              onRunAnalysis={handleRunAnalysis}
              onOpenExport={() => setIsExportOpen(true)}
              onOpenPathFinder={handleOpenPathFinderWithSource}
              onPromoteWallet={(addr) => handlePromoteWallet(activeWalletDetail.wallet.id, addr)}
              onUpdateNotes={handleUpdateNotes}
            />
          )
        )}

        {/* VIEW 4: Transactions Explorer */}
        {activeView === 'transactions' && (
          <TransactionExplorerView
            onSelectWalletAddress={handleSelectWalletByAddress}
          />
        )}

        {/* VIEW 5: Connections */}
        {activeView === 'connections' && (
          <ConnectionsView
            onSelectWalletAddress={handleSelectWalletByAddress}
            onPromoteWallet={(srcId, addr) => handlePromoteWallet(srcId, addr)}
          />
        )}

        {/* VIEW 6: Graph Visualizer */}
        {activeView === 'graph' && (
          <GraphView
            wallets={wallets}
            selectedWalletId={selectedWalletId || undefined}
            onSelectWallet={handleSelectWallet}
          />
        )}

        {/* VIEW 7: Review Queue */}
        {activeView === 'review' && (
          <ReviewQueueView
            onSelectWalletAddress={handleSelectWalletByAddress}
            onPromoteWallet={(srcId, addr) => handlePromoteWallet(srcId, addr)}
          />
        )}

        {/* VIEW 8: Settings & Platform Health */}
        {activeView === 'settings' && (
          <SettingsView />
        )}

      </main>

      {/* Global Modals */}
      <NewWalletModal
        isOpen={isNewWalletOpen}
        onClose={() => setIsNewWalletOpen(false)}
        onWalletCreated={(id) => {
          fetchWallets();
          fetchDashboardStats();
          handleSelectWallet(id);
        }}
      />

      <PathFinderModal
        isOpen={isPathFinderOpen}
        onClose={() => setIsPathFinderOpen(false)}
        initialSourceAddress={pathFinderSource}
      />

      {activeWalletDetail && (
        <ExportModal
          isOpen={isExportOpen}
          onClose={() => setIsExportOpen(false)}
          walletId={activeWalletDetail.wallet.id}
          walletAddress={activeWalletDetail.wallet.address}
          completeness={activeWalletDetail.wallet.completeness}
        />
      )}

    </div>
  );
}
