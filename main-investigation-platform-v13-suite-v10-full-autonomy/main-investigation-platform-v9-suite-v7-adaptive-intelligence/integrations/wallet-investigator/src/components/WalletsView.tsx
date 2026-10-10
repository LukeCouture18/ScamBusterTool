import React, { useState } from 'react';
import {
  Search,
  Filter,
  Star,
  ExternalLink,
  Plus,
  HelpCircle,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Clock,
  ArrowUpDown,
} from 'lucide-react';
import { WalletEntity } from '../types';

interface WalletsViewProps {
  wallets: WalletEntity[];
  isLoading: boolean;
  onSelectWallet: (walletId: string) => void;
  onOpenNewWallet: () => void;
  onToggleBookmark: (walletId: string) => void;
  onRefreshList: () => void;
}

export const WalletsView: React.FC<WalletsViewProps> = ({
  wallets,
  isLoading,
  onSelectWallet,
  onOpenNewWallet,
  onToggleBookmark,
  onRefreshList,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [networkFilter, setNetworkFilter] = useState('');
  const [completenessFilter, setCompletenessFilter] = useState('');
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [sortField, setSortField] = useState<'updated_at' | 'total_tx_count' | 'observation_count'>('updated_at');
  const [sortAsc, setSortAsc] = useState(false);

  const filteredWallets = wallets
    .filter((w) => {
      if (bookmarkedOnly && !w.is_bookmarked) return false;
      if (networkFilter && w.resolved_network !== networkFilter) return false;
      if (completenessFilter && w.completeness !== completenessFilter) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        return (
          w.address.toLowerCase().includes(s) ||
          w.resolved_network.toLowerCase().includes(s) ||
          (w.notes && w.notes.toLowerCase().includes(s)) ||
          w.tags.some((t) => t.toLowerCase().includes(s))
        );
      }
      return true;
    })
    .sort((a, b) => {
      const valA = a[sortField] || 0;
      const valB = b[sortField] || 0;
      return sortAsc ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

  return (
    <div id="wallets-inventory-view" className="space-y-4">
      
      {/* Top Controls Bar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div className="flex flex-wrap items-center gap-2.5 flex-1">
          {/* Search */}
          <div className="relative min-w-[240px] flex-1 max-w-md">
            <input
              type="text"
              placeholder="Filter by address, tags, notes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
          </div>

          {/* Network Filter */}
          <select
            value={networkFilter}
            onChange={(e) => setNetworkFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="">All Networks</option>
            <option value="bitcoin">Bitcoin</option>
            <option value="ethereum">Ethereum</option>
            <option value="bsc">BNB Smart Chain</option>
            <option value="tron">TRON</option>
            <option value="solana">Solana</option>
            <option value="polygon">Polygon</option>
            <option value="arbitrum">Arbitrum</option>
            <option value="base">Base</option>
            <option value="litecoin">Litecoin</option>
            <option value="dogecoin">Dogecoin</option>
            <option value="xrpl">XRPL</option>
          </select>

          {/* Completeness Filter */}
          <select
            value={completenessFilter}
            onChange={(e) => setCompletenessFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="">All Completeness</option>
            <option value="COMPLETE">Complete History</option>
            <option value="PARTIAL">Partial History</option>
            <option value="LIMITED">Limited Budget</option>
            <option value="UNKNOWN">Pending Analysis</option>
          </select>

          {/* Bookmark Toggle */}
          <button
            onClick={() => setBookmarkedOnly(!bookmarkedOnly)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              bookmarkedOnly
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${bookmarkedOnly ? 'fill-amber-400 text-amber-400' : ''}`} />
            <span>Bookmarked</span>
          </button>
        </div>

        {/* Right Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshList}
            title="Refresh List"
            className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg hover:bg-slate-800"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            onClick={onOpenNewWallet}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Ingest Wallet</span>
          </button>
        </div>
      </div>

      {/* Wallets Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300 border-collapse">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
              <tr>
                <th className="p-3 w-8"></th>
                <th className="p-3">Target Wallet Address</th>
                <th className="p-3">Resolved Network</th>
                <th className="p-3 text-right">Transactions</th>
                <th className="p-3 text-right">Balance</th>
                <th className="p-3 text-center">Sites / Obs</th>
                <th className="p-3 text-center">Counterparties</th>
                <th className="p-3">Data Completeness</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    Loading tracked wallets...
                  </td>
                </tr>
              ) : filteredWallets.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    No cryptocurrency wallets match the applied filters.
                  </td>
                </tr>
              ) : (
                filteredWallets.map((wallet) => {
                  return (
                    <tr
                      key={wallet.id}
                      className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                      onClick={() => onSelectWallet(wallet.id)}
                    >
                      {/* Bookmark Icon */}
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => onToggleBookmark(wallet.id)}
                          className="text-slate-600 hover:text-amber-400 transition-colors"
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${
                              wallet.is_bookmarked ? 'fill-amber-400 text-amber-400' : ''
                            }`}
                          />
                        </button>
                      </td>

                      {/* Address & Ambiguity Badge */}
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-slate-100 group-hover:text-cyan-300 transition-colors">
                            {wallet.address.slice(0, 10)}...{wallet.address.slice(-6)}
                          </span>

                          {wallet.network_ambiguity && (
                            <span
                              title="EVM Address: Format matches Ethereum, BSC, Polygon, Arbitrum, Base"
                              className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30"
                            >
                              EVM Ambiguous
                            </span>
                          )}
                        </div>

                        {wallet.tags && wallet.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {wallet.tags.slice(0, 3).map((tag, idx) => (
                              <span
                                key={idx}
                                className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* Resolved Network */}
                      <td className="p-3">
                        <span className="capitalize text-slate-200 font-medium">
                          {wallet.resolved_network}
                        </span>
                        {wallet.reported_network && wallet.reported_network.toLowerCase() !== wallet.resolved_network.toLowerCase() && (
                          <div className="text-[10px] text-slate-500 font-mono">
                            Claimed: {wallet.reported_network}
                          </div>
                        )}
                      </td>

                      {/* Total Txs */}
                      <td className="p-3 text-right font-mono">
                        <div className="text-slate-100 font-semibold">{wallet.total_tx_count}</div>
                        <div className="text-[10px] text-slate-500">
                          {wallet.total_incoming_tx_count} in / {wallet.total_outgoing_tx_count} out
                        </div>
                      </td>

                      {/* Balance */}
                      <td className="p-3 text-right font-mono">
                        <div className="text-slate-100 font-medium">
                          {wallet.balance_display} {wallet.balance_asset}
                        </div>
                      </td>

                      {/* Observations Count */}
                      <td className="p-3 text-center font-mono">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                          {wallet.observation_count}
                        </span>
                      </td>

                      {/* Counterparty Count */}
                      <td className="p-3 text-center font-mono">
                        <span className="text-slate-300">
                          {wallet.unique_counterparty_count}
                        </span>
                      </td>

                      {/* Completeness Badge */}
                      <td className="p-3">
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold inline-flex items-center gap-1 ${
                            wallet.completeness === 'COMPLETE'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                              : wallet.completeness === 'PARTIAL'
                              ? 'bg-amber-950 text-amber-300 border border-amber-500/30'
                              : wallet.completeness === 'LIMITED'
                              ? 'bg-blue-950 text-blue-300 border border-blue-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {wallet.completeness === 'COMPLETE' && <CheckCircle2 className="w-3 h-3" />}
                          {wallet.completeness === 'PARTIAL' && <AlertTriangle className="w-3 h-3" />}
                          <span>{wallet.completeness}</span>
                        </span>
                      </td>

                      {/* Action */}
                      <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => onSelectWallet(wallet.id)}
                          className="px-2.5 py-1 text-xs font-medium text-cyan-400 bg-cyan-950/40 hover:bg-cyan-900/60 border border-cyan-500/30 rounded transition-colors"
                        >
                          Investigate
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer pagination info */}
        <div className="p-3 bg-slate-950/60 border-t border-slate-800 text-xs text-slate-500 flex items-center justify-between">
          <span>Showing {filteredWallets.length} of {wallets.length} tracked wallets</span>
          <span className="font-mono text-[11px]">Normalized Schema v1.0</span>
        </div>
      </div>

    </div>
  );
};
