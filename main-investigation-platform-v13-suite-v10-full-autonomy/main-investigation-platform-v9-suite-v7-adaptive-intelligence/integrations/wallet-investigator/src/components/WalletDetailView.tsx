import React, { useState } from 'react';
import {
  ArrowLeft,
  Copy,
  Check,
  Star,
  Download,
  Play,
  RotateCw,
  GitFork,
  ExternalLink,
  ShieldAlert,
  AlertTriangle,
  Layers,
  ListOrdered,
  Share2,
  FileText,
  Clock,
  Tag,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import { DataQualityBanner } from './DataQualityBanner';
import {
  ConnectedWalletRecord,
  CounterpartyRecord,
  EvidenceRecord,
  FindingRecord,
  FundFlowPatternRecord,
  NormalizedTransaction,
  WalletEntity,
  WalletObservation,
} from '../types';

interface WalletDetailViewProps {
  wallet: WalletEntity;
  observations: WalletObservation[];
  transactions: NormalizedTransaction[];
  counterparties: CounterpartyRecord[];
  connectedWallets: ConnectedWalletRecord[];
  fundFlows: FundFlowPatternRecord[];
  findings: FindingRecord[];
  evidence: EvidenceRecord[];
  onBack: () => void;
  onToggleBookmark: (id: string) => void;
  onRunAnalysis: (id: string, profile: 'QUICK' | 'STANDARD' | 'DEEP') => void;
  onOpenExport: () => void;
  onOpenPathFinder: (sourceAddress: string) => void;
  onPromoteWallet: (connectedAddress: string) => void;
  onUpdateNotes: (notes: string, tags: string[]) => void;
}

export const WalletDetailView: React.FC<WalletDetailViewProps> = ({
  wallet,
  observations,
  transactions,
  counterparties,
  connectedWallets,
  fundFlows,
  findings,
  evidence,
  onBack,
  onToggleBookmark,
  onRunAnalysis,
  onOpenExport,
  onOpenPathFinder,
  onPromoteWallet,
  onUpdateNotes,
}) => {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'transactions' | 'counterparties' | 'fund_flows' | 'connections' | 'evidence' | 'timeline' | 'notes'
  >('overview');
  
  const [copied, setCopied] = useState(false);
  const [selectedTx, setSelectedTx] = useState<NormalizedTransaction | null>(null);
  const [txSearch, setTxSearch] = useState('');
  const [txDirection, setTxDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  
  // Notes / tags local state
  const [localNotes, setLocalNotes] = useState(wallet.notes || '');
  const [localTags, setLocalTags] = useState(wallet.tags.join(', '));
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveNotes = () => {
    setIsSavingNotes(true);
    const tagsArray = localTags.split(',').map((t) => t.trim()).filter(Boolean);
    onUpdateNotes(localNotes, tagsArray);
    setTimeout(() => setIsSavingNotes(false), 500);
  };

  const filteredTxs = transactions.filter((tx) => {
    if (txDirection !== 'all' && tx.direction !== txDirection) return false;
    if (txSearch) {
      const s = txSearch.toLowerCase();
      return (
        tx.tx_hash.toLowerCase().includes(s) ||
        tx.counterparty_address.toLowerCase().includes(s) ||
        tx.asset.toLowerCase().includes(s)
      );
    }
    return true;
  });

  return (
    <div id="wallet-investigation-workspace" className="space-y-6">
      
      {/* Top Breadcrumb & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors"
            title="Back to Wallets"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Investigating Target Address
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/30">
                {wallet.resolved_network.toUpperCase()}
              </span>
            </div>
            
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-sm sm:text-base font-mono font-bold text-slate-100">
                {wallet.address}
              </span>
              <button
                onClick={handleCopy}
                className="text-slate-400 hover:text-cyan-400 transition-colors p-1"
                title="Copy Address"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Bookmark */}
          <button
            onClick={() => onToggleBookmark(wallet.id)}
            className={`p-2 rounded-lg border transition-colors ${
              wallet.is_bookmarked
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Bookmark Target"
          >
            <Star className={`w-4 h-4 ${wallet.is_bookmarked ? 'fill-amber-400' : ''}`} />
          </button>

          {/* Path Finder */}
          <button
            onClick={() => onOpenPathFinder(wallet.address)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-lg transition-colors"
          >
            <GitFork className="w-3.5 h-3.5 text-cyan-400" />
            <span>Path Query</span>
          </button>

          {/* Trigger Analysis Profile */}
          <div className="flex items-center rounded-lg border border-slate-700 bg-slate-950 p-0.5">
            <button
              onClick={() => onRunAnalysis(wallet.id, 'STANDARD')}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-slate-200 hover:text-cyan-300 transition-colors"
              title="Run Standard Analysis (3 pages, 1 hop)"
            >
              <RotateCw className="w-3 h-3 text-cyan-400" />
              <span>Analyze</span>
            </button>
            <button
              onClick={() => onRunAnalysis(wallet.id, 'DEEP')}
              className="px-2 py-1 text-[11px] text-indigo-300 hover:text-indigo-200 border-l border-slate-800"
              title="Run Deep Multi-Hop Analysis (10 pages, 2 hops)"
            >
              Deep
            </button>
          </div>

          {/* Export Dossier */}
          <button
            id="export-dossier-btn"
            onClick={onOpenExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Dossier</span>
          </button>
        </div>
      </div>

      {/* Prominent Data Quality & Completeness Banner */}
      <DataQualityBanner
        completeness={wallet.completeness}
        details={wallet.completeness_details}
        network={wallet.resolved_network}
      />

      {/* EVM Ambiguity Banner if detected */}
      {wallet.network_ambiguity && (
        <div className="p-3 bg-amber-950/30 border border-amber-500/30 rounded-lg flex items-start gap-2.5 text-xs text-amber-300">
          <HelpCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-amber-200">EVM Network Ambiguity Warning:</span>
            <span className="text-amber-300/90 ml-1.5">
              This address uses the standard 0x hexadecimal format, which is identical across Ethereum, Binance Smart Chain (BSC), Polygon, Arbitrum, Base, and other EVM layers. The resolved network is currently listed as {wallet.resolved_network}. Verify deposit context or tokens involved before concluding specific chain custody.
            </span>
          </div>
        </div>
      )}

      {/* Workspace Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-slate-400 text-[11px] font-medium uppercase tracking-wider block">Current Balance</span>
          <span className="text-lg font-mono font-bold text-slate-100 mt-1 block">
            {wallet.balance_display} {wallet.balance_asset || 'native'}
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-slate-400 text-[11px] font-medium uppercase tracking-wider block">Total Transactions</span>
          <span className="text-lg font-mono font-bold text-slate-100 mt-1 block">
            {wallet.total_tx_count}
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {wallet.total_incoming_tx_count} in / {wallet.total_outgoing_tx_count} out
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-slate-400 text-[11px] font-medium uppercase tracking-wider block">Unique Counterparties</span>
          <span className="text-lg font-mono font-bold text-cyan-300 mt-1 block">
            {counterparties.length}
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl">
          <span className="text-slate-400 text-[11px] font-medium uppercase tracking-wider block">Website Observations</span>
          <span className="text-lg font-mono font-bold text-amber-300 mt-1 block">
            {observations.length}
          </span>
        </div>
      </div>

      {/* Primary Investigation Navigation Tabs */}
      <div className="border-b border-slate-800 flex flex-wrap gap-1">
        {[
          { id: 'overview', label: 'Overview & Findings', count: findings.length },
          { id: 'transactions', label: 'Transactions', count: transactions.length },
          { id: 'counterparties', label: 'Counterparties', count: counterparties.length },
          { id: 'fund_flows', label: 'Fund Flow Patterns', count: fundFlows.length },
          { id: 'connections', label: 'Surfaced Wallets', count: connectedWallets.length },
          { id: 'evidence', label: 'Supporting Evidence', count: evidence.length },
          { id: 'timeline', label: 'Timeline' },
          { id: 'notes', label: 'Notes & Tags' },
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`py-2.5 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                isActive
                  ? 'border-cyan-400 text-cyan-300 bg-slate-800/40'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] font-mono text-slate-400">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* TAB CONTENT */}

      {/* 1. Overview & Findings */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Key Findings Section */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Factual Findings Generated by Engine</span>
            </h3>

            {findings.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                No anomalous or multi-site patterns detected for this address yet. Run an analysis job to evaluate on-chain behavior.
              </p>
            ) : (
              <div className="space-y-3">
                {findings.map((f) => (
                  <div
                    key={f.id}
                    className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-100">{f.summary}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-cyan-400">
                          {f.finding_type}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                        Confidence: {Math.round(f.confidence * 100)}%
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">
                      {f.explanation}
                    </p>

                    <div className="text-[10px] text-slate-500 font-mono flex items-center gap-4 pt-1">
                      <span>Version: {f.analysis_version}</span>
                      <span>Completeness: {f.completeness}</span>
                      <span>Generated: {new Date(f.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Observed Website Evidence List */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Observed Website Evidence ({observations.length} source records)
            </h3>
            <div className="space-y-2">
              {observations.map((obs) => (
                <div key={obs.id} className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs space-y-1">
                  <div className="flex items-center justify-between font-mono">
                    <span className="font-semibold text-cyan-300">
                      {obs.website_domain || 'Internal Investigation Feed'}
                    </span>
                    <span className="text-slate-500 text-[11px]">
                      {new Date(obs.timestamp).toLocaleString()}
                    </span>
                  </div>
                  {obs.deposit_option_context && (
                    <div className="text-slate-400">
                      Context: <span className="text-slate-200">{obs.deposit_option_context}</span>
                    </div>
                  )}
                  {obs.source_url && (
                    <div className="text-slate-500 font-mono text-[11px] truncate">
                      URL: {obs.source_url}
                    </div>
                  )}
                  <div className="text-[10px] text-slate-500 font-mono pt-1">
                    Source: {obs.source_module} | Investigation: {obs.investigation_id || 'Global'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 2. Transactions */}
      {activeTab === 'transactions' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 p-3 rounded-xl">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search hash or counterparty..."
                value={txSearch}
                onChange={(e) => setTxSearch(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-64"
              />
              <select
                value={txDirection}
                onChange={(e) => setTxDirection(e.target.value as typeof txDirection)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none"
              >
                <option value="all">All Directions</option>
                <option value="incoming">Inbound Only</option>
                <option value="outgoing">Outbound Only</option>
              </select>
            </div>
            <span className="text-xs text-slate-500 font-mono">
              {filteredTxs.length} transactions shown
            </span>
          </div>

          {/* Transactions Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950/80 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                  <tr>
                    <th className="p-3">Direction</th>
                    <th className="p-3">Tx Hash</th>
                    <th className="p-3">Timestamp</th>
                    <th className="p-3">Counterparty</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3">Asset</th>
                    <th className="p-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {filteredTxs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        No transactions found for current filter.
                      </td>
                    </tr>
                  ) : (
                    filteredTxs.map((tx) => (
                      <tr key={tx.id} className="hover:bg-slate-800/40">
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            tx.direction === 'incoming'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-950 text-rose-300 border border-rose-500/30'
                          }`}>
                            {tx.direction.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-3 text-slate-200">
                          {tx.tx_hash.slice(0, 12)}...{tx.tx_hash.slice(-6)}
                        </td>
                        <td className="p-3 text-slate-400 font-sans text-[11px]">
                          {new Date(tx.timestamp).toLocaleString()}
                        </td>
                        <td className="p-3 text-slate-300">
                          {tx.counterparty_address ? `${tx.counterparty_address.slice(0, 8)}...${tx.counterparty_address.slice(-6)}` : 'Multi-Input / UTXO'}
                        </td>
                        <td className="p-3 text-right font-bold text-slate-100">
                          {tx.display_amount}
                        </td>
                        <td className="p-3 text-cyan-300">
                          {tx.asset}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => setSelectedTx(tx)}
                            className="text-xs text-cyan-400 hover:text-cyan-300 underline font-sans"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Transaction Inspection Drawer */}
          {selectedTx && (
            <div className="p-5 bg-slate-950 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Transaction Audit Record: <span className="font-mono text-cyan-400">{selectedTx.tx_hash}</span>
                </h4>
                <button
                  onClick={() => setSelectedTx(null)}
                  className="text-xs text-slate-400 hover:text-slate-200 font-sans"
                >
                  Close Inspection
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
                <div>
                  <span className="text-slate-500 block">Direction:</span>
                  <span className="text-slate-200">{selectedTx.direction}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Asset & Amount:</span>
                  <span className="text-slate-200">{selectedTx.display_amount} {selectedTx.asset}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Base Unit Raw Amount:</span>
                  <span className="text-slate-400 text-[11px] truncate block">{selectedTx.raw_amount}</span>
                </div>
              </div>

              {/* UTXO Inputs & Outputs Breakdown */}
              {selectedTx.utxo_inputs && selectedTx.utxo_inputs.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      UTXO Inputs ({selectedTx.utxo_inputs.length})
                    </div>
                    {selectedTx.utxo_inputs.map((inp, idx: number) => (
                      <div key={idx} className="text-xs font-mono flex justify-between">
                        <span className="text-slate-300">{inp.address.slice(0, 10)}...</span>
                        <span className="text-slate-400">{inp.display_amount} BTC</span>
                      </div>
                    ))}
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      UTXO Outputs ({selectedTx.utxo_outputs?.length || 0})
                    </div>
                    {selectedTx.utxo_outputs?.map((out, idx: number) => (
                      <div key={idx} className="text-xs font-mono flex justify-between">
                        <span className={out.is_change ? 'text-amber-400' : 'text-slate-300'}>
                          {out.address.slice(0, 10)}... {out.is_change ? '(Change)' : ''}
                        </span>
                        <span className="text-slate-400">{out.display_amount} BTC</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 3. Counterparties */}
      {activeTab === 'counterparties' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950/80 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                  <tr>
                    <th className="p-3">Counterparty Address</th>
                    <th className="p-3">Direction</th>
                    <th className="p-3 text-right">Transactions</th>
                    <th className="p-3">Assets</th>
                    <th className="p-3">Cross-Site Overlap</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-sans">
                  {counterparties.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-500">
                        No counterparties computed for this wallet yet.
                      </td>
                    </tr>
                  ) : (
                    counterparties.map((cp) => (
                      <tr key={cp.id} className="hover:bg-slate-800/40">
                        <td className="p-3 font-mono font-medium text-slate-100">
                          {cp.counterparty_address}
                        </td>
                        <td className="p-3 capitalize font-mono text-[11px]">
                          {cp.direction}
                        </td>
                        <td className="p-3 text-right font-mono font-semibold">
                          {cp.tx_count}
                        </td>
                        <td className="p-3 font-mono text-[11px] text-cyan-300">
                          {cp.assets_involved.join(', ')}
                        </td>
                        <td className="p-3">
                          {cp.associated_websites && cp.associated_websites.length > 1 ? (
                            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
                              Shared across {cp.associated_websites.length} websites
                            </span>
                          ) : (
                            <span className="text-slate-500 text-xs">—</span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => onPromoteWallet(cp.counterparty_address)}
                            className="px-2.5 py-1 text-xs font-medium text-cyan-400 bg-cyan-950/40 hover:bg-cyan-900/60 border border-cyan-500/30 rounded"
                          >
                            Promote
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 4. Fund Flow Patterns */}
      {activeTab === 'fund_flows' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Observed Fund-Flow Behavioral Patterns
            </h3>
            {fundFlows.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">
                No rapid pass-through or dormancy breaking detected in the current history window.
              </p>
            ) : (
              <div className="space-y-3">
                {fundFlows.map((ff) => (
                  <div key={ff.id} className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-100 uppercase tracking-wide">
                        {ff.pattern_type.replace('_', ' ')}
                      </span>
                      <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                        Confidence: {Math.round((ff.confidence ?? 0.85) * 100)}%
                      </span>
                    </div>
                    <p className="text-xs text-slate-300">{ff.description}</p>
                    <div className="text-[10px] text-slate-500 font-mono">
                      Detected: {new Date(ff.detected_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. Surfaced Connected Wallets */}
      {activeTab === 'connections' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Connected Wallets Surfaced for Review
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Scored by interaction frequency, volume, and multi-investigation correlation. Promoting creates an investigation workspace.
              </p>
            </div>

            {connectedWallets.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">
                No connected wallets surfaced. Perform an analysis job to evaluate counterparties.
              </p>
            ) : (
              <div className="space-y-3">
                {connectedWallets.map((cw) => (
                  <div
                    key={cw.id}
                    className="p-4 bg-slate-950 border border-slate-800 rounded-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-100">
                          {cw.connected_wallet_address}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono text-[10px] font-bold">
                          Score: {cw.relevance_score}/100
                        </span>
                        {cw.is_promoted && (
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold">
                            PROMOTED
                          </span>
                        )}
                      </div>

                      <ul className="text-xs text-slate-400 list-disc list-inside space-y-0.5">
                        {cw.reasons.map((r: string, i: number) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>

                    {!cw.is_promoted && (
                      <button
                        onClick={() => onPromoteWallet(cw.connected_wallet_address)}
                        className="px-3 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors self-start sm:self-auto shrink-0"
                      >
                        Promote to Investigation
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 6. Evidence Architecture */}
      {activeTab === 'evidence' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Segregated Evidence Vault ({evidence.length} items)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Strict separation between Observed Website Evidence, Observed Blockchain Evidence, Derived Software Analysis, and External Metadata.
              </p>
            </div>

            <div className="space-y-3">
              {evidence.map((ev) => (
                <div key={ev.id} className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-200">{ev.title}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-300">
                      {ev.category}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{ev.description}</p>
                  <div className="text-[10px] text-slate-500 font-mono flex items-center justify-between pt-1">
                    <span>Evidence ID: {ev.id}</span>
                    <span>Created: {new Date(ev.created_at).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 7. Timeline */}
      {activeTab === 'timeline' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Chronological Investigation Timeline
          </h3>
          <div className="relative border-l border-slate-800 ml-3 pl-4 space-y-4">
            {observations.map((o) => (
              <div key={o.id} className="relative text-xs space-y-0.5">
                <div className="w-2.5 h-2.5 bg-amber-400 rounded-full absolute -left-[21px] top-1" />
                <div className="text-[10px] text-slate-500 font-mono">
                  {new Date(o.timestamp).toLocaleString()}
                </div>
                <div className="font-semibold text-slate-200">
                  Website Observation: {o.website_domain || 'Source Site'}
                </div>
                <p className="text-slate-400">{o.notes || 'Recorded on page interface'}</p>
              </div>
            ))}

            {transactions.slice(0, 15).map((t) => (
              <div key={t.id} className="relative text-xs space-y-0.5">
                <div className={`w-2.5 h-2.5 rounded-full absolute -left-[21px] top-1 ${
                  t.direction === 'incoming' ? 'bg-emerald-400' : 'bg-rose-400'
                }`} />
                <div className="text-[10px] text-slate-500 font-mono">
                  {new Date(t.timestamp).toLocaleString()}
                </div>
                <div className="font-semibold text-slate-200">
                  {t.direction === 'incoming' ? 'Inbound Transfer' : 'Outbound Transfer'}: {t.display_amount} {t.asset}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  tx: {t.tx_hash.slice(0, 16)}...
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 8. Notes & Tags */}
      {activeTab === 'notes' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Analyst Working Notes & Tags
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Investigation Notes (Separate from immutable evidentiary facts)
              </label>
              <textarea
                rows={5}
                value={localNotes}
                onChange={(e) => setLocalNotes(e.target.value)}
                placeholder="Document hypotheses, law enforcement referral notes, or chain analysis thoughts..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Tags (Comma-separated)
              </label>
              <input
                type="text"
                value={localTags}
                onChange={(e) => setLocalTags(e.target.value)}
                placeholder="e.g. scam_cluster_a, pig_butchering, high_priority"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <button
              onClick={handleSaveNotes}
              disabled={isSavingNotes}
              className="px-4 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors disabled:opacity-50"
            >
              {isSavingNotes ? 'Saving...' : 'Save Notes & Tags'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
};
