import React, { useState, useEffect } from 'react';
import { Search, Filter, RefreshCw, ListOrdered, ArrowUpDown } from 'lucide-react';
import { NormalizedTransaction } from '../types';

interface TransactionExplorerViewProps {
  onSelectWalletAddress: (address: string) => void;
}

export const TransactionExplorerView: React.FC<TransactionExplorerViewProps> = ({
  onSelectWalletAddress,
}) => {
  const [transactions, setTransactions] = useState<NormalizedTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState('');
  const [asset, setAsset] = useState('');
  const [network, setNetwork] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const fetchTransactions = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search) params.append('search', search);
      if (direction) params.append('direction', direction);
      if (asset) params.append('asset', asset);
      if (network) params.append('network', network);

      const res = await fetch(`/api/transactions?${params.toString()}`);
      const data = await res.json();
      setTransactions(data.transactions || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(fetchTransactions, 0);
    return () => window.clearTimeout(initial);
  }, [page, direction, asset, network]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchTransactions();
  };

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div id="transaction-explorer-view" className="space-y-4">
      
      {/* Header and Filter Controls */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div className="flex flex-wrap items-center gap-2.5 flex-1">
          <form onSubmit={handleSearchSubmit} className="relative min-w-[240px] flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search by tx hash, counterparty, from, or to address..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
          </form>

          <select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setPage(1);
            }}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none"
          >
            <option value="">All Directions</option>
            <option value="incoming">Inbound Only</option>
            <option value="outgoing">Outbound Only</option>
          </select>

          <select
            value={network}
            onChange={(e) => {
              setNetwork(e.target.value);
              setPage(1);
            }}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none"
          >
            <option value="">All Networks</option>
            <option value="bitcoin">Bitcoin</option>
            <option value="ethereum">Ethereum</option>
            <option value="bsc">BSC</option>
            <option value="tron">TRON</option>
            <option value="solana">Solana</option>
          </select>
        </div>

        <button
          onClick={fetchTransactions}
          className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg hover:bg-slate-800 self-end md:self-auto"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Transactions Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
              <tr>
                <th className="p-3">Direction</th>
                <th className="p-3">Network</th>
                <th className="p-3">Tx Hash</th>
                <th className="p-3">Timestamp</th>
                <th className="p-3">Sender (From)</th>
                <th className="p-3">Recipient (To)</th>
                <th className="p-3 text-right">Amount</th>
                <th className="p-3">Asset</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500 font-sans">
                    Loading blockchain transactions...
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500 font-sans">
                    No transactions match the selected criteria.
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        tx.direction === 'incoming'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                          : 'bg-rose-950 text-rose-300 border border-rose-500/30'
                      }`}>
                        {tx.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3 uppercase text-slate-400 text-[10px]">
                      {tx.network}
                    </td>
                    <td className="p-3 text-slate-200">
                      {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)}
                    </td>
                    <td className="p-3 text-slate-400 font-sans text-[11px]">
                      {new Date(tx.timestamp).toLocaleString()}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => onSelectWalletAddress(tx.from_address)}
                        className="text-cyan-400 hover:text-cyan-300 hover:underline"
                      >
                        {tx.from_address ? `${tx.from_address.slice(0, 8)}...` : 'Coinbase'}
                      </button>
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => onSelectWalletAddress(tx.to_address)}
                        className="text-cyan-400 hover:text-cyan-300 hover:underline"
                      >
                        {tx.to_address ? `${tx.to_address.slice(0, 8)}...` : 'Multi-Output'}
                      </button>
                    </td>
                    <td className="p-3 text-right font-bold text-slate-100">
                      {tx.display_amount}
                    </td>
                    <td className="p-3 text-cyan-300">
                      {tx.asset}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-3 bg-slate-950/60 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
          <span>Showing page {page} of {totalPages} ({total} total transactions)</span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

    </div>
  );
};
