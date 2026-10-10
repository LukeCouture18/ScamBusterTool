import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertTriangle, HelpCircle, FileText, Upload, Sparkles } from 'lucide-react';
import { AddressValidationResult } from '../../server/crypto/validation';

interface NewWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWalletCreated: (walletId: string) => void;
}

export const NewWalletModal: React.FC<NewWalletModalProps> = ({ isOpen, onClose, onWalletCreated }) => {
  const [activeTab, setActiveTab] = useState<'single' | 'bulk' | 'sample'>('single');
  
  // Single form state
  const [address, setAddress] = useState('');
  const [reportedNetwork, setReportedNetwork] = useState('');
  const [claimedAsset, setClaimedAsset] = useState('');
  const [websiteDomain, setWebsiteDomain] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [depositOption, setDepositOption] = useState('');
  const [investigationId, setInvestigationId] = useState('');
  const [sourceModule, setSourceModule] = useState<'manual_entry' | 'site_investigator' | 'crypto_wallet_logger' | 'main_platform'>('site_investigator');
  const [notes, setNotes] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [profile, setProfile] = useState<'QUICK' | 'STANDARD' | 'DEEP'>('STANDARD');
  const [autoAnalyze, setAutoAnalyze] = useState(true);

  // Bulk state
  const [bulkText, setBulkText] = useState('');

  // Live validation state
  const [validation, setValidation] = useState<AddressValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live address validation debounce
  useEffect(() => {
    if (!address.trim()) {
      const reset = window.setTimeout(() => setValidation(null), 0);
      return () => window.clearTimeout(reset);
    }

    const timer = setTimeout(async () => {
      setIsValidating(true);
      try {
        const res = await fetch('/api/wallets/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.trim(), reported_network: reportedNetwork }),
        });
        const data = await res.json();
        setValidation(data);
      } catch (err) {
        console.error(err);
      } finally {
        setIsValidating(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [address, reportedNetwork]);

  if (!isOpen) return null;

  const handleSubmitSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: address.trim(),
          reported_network: reportedNetwork || undefined,
          claimed_asset: claimedAsset || undefined,
          source_module: sourceModule,
          website_domain: websiteDomain || undefined,
          source_url: sourceUrl || undefined,
          deposit_option_context: depositOption || undefined,
          investigation_id: investigationId || undefined,
          notes: notes || undefined,
          tags,
          auto_analyze: autoAnalyze,
          profile,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to ingest wallet.');
      }

      onWalletCreated(data.wallet_id);
      onClose();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkText.trim()) return;

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const lines = bulkText.split('\n').map((l) => l.trim()).filter(Boolean);
      const entries = lines.map((line) => {
        // Can be "address" or "address,network,domain"
        const parts = line.split(/[,;\t]/).map((p) => p.trim());
        return {
          address: parts[0],
          reported_network: parts[1] || undefined,
          website_domain: parts[2] || undefined,
          investigation_id: investigationId || undefined,
        };
      });

      const res = await fetch('/api/wallets/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed bulk ingestion');

      if (data.items && data.items.length > 0) {
        onWalletCreated(data.items[0].wallet_id);
      }
      onClose();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const loadSampleFixture = (fixtureType: 'btc' | 'eth' | 'tron' | 'partial') => {
    if (fixtureType === 'btc') {
      setAddress('bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w');
      setReportedNetwork('bitcoin');
      setClaimedAsset('BTC');
      setWebsiteDomain('crypto-yield-apex24.live');
      setSourceUrl('https://crypto-yield-apex24.live/deposit/btc');
      setDepositOption('VIP Tier 1 Bitcoin Inbound Gateway');
      setInvestigationId('INV-2026-0842');
      setSourceModule('site_investigator');
      setNotes('Identified on clone deposit checkout interface.');
      setTagsInput('high_priority, scam_clone, btc');
    } else if (fixtureType === 'eth') {
      setAddress('0x71c841094df8cf7fa128565551f337f74c7dbb94');
      setReportedNetwork('ethereum');
      setClaimedAsset('USDT ERC20');
      setWebsiteDomain('arbitrage-vault-pro.com');
      setSourceUrl('https://arbitrage-vault-pro.com/checkout');
      setDepositOption('Ethereum USDT Smart Deposit');
      setInvestigationId('INV-2026-0911');
      setSourceModule('crypto_wallet_logger');
      setNotes('Captured from fraudulent staking portal web page.');
      setTagsInput('staking_fraud, usdt_erc20, pass_through');
    } else if (fixtureType === 'tron') {
      setAddress('TXxxScamDepositTronWallet99887766554');
      setReportedNetwork('tron');
      setClaimedAsset('USDT TRC20');
      setWebsiteDomain('quantum-tron-yield.org');
      setSourceUrl('https://quantum-tron-yield.org/pay');
      setDepositOption('TRON TRC20 Gateway');
      setInvestigationId('INV-2026-1044');
      setSourceModule('site_investigator');
      setNotes('Reported in victim wire dispute.');
      setTagsInput('tron, high_velocity, trc20');
    } else if (fixtureType === 'partial') {
      setAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
      setReportedNetwork('bitcoin');
      setClaimedAsset('BTC');
      setWebsiteDomain('legacy-crypto-trader.net');
      setInvestigationId('INV-2026-0412');
      setSourceModule('manual_entry');
      setNotes('Test case demonstrating PARTIAL data completeness warning.');
      setTagsInput('partial_data_test, btc_legacy');
    }
  };

  return (
    <div id="new-wallet-modal-backdrop" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div id="new-wallet-modal-container" className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden my-8">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>Ingest Wallet for Investigation</span>
              <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                Provenance Preserved
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Supports Site Investigator evidence, CryptoWalletLogger feeds, manual entries, or bulk imports.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-800 px-6 bg-slate-950/40">
          <button
            onClick={() => setActiveTab('single')}
            className={`py-2.5 px-4 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'single'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Single Intake (Evidence-First)
          </button>
          <button
            onClick={() => setActiveTab('bulk')}
            className={`py-2.5 px-4 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'bulk'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Bulk Paste / CSV
          </button>
          <button
            onClick={() => setActiveTab('sample')}
            className={`py-2.5 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'sample'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Load Test Scenarios</span>
          </button>
        </div>

        {errorMsg && (
          <div className="mx-6 mt-4 p-3 bg-rose-950/50 border border-rose-500/40 rounded-lg text-rose-300 text-xs">
            {errorMsg}
          </div>
        )}

        {/* Tab 1: Single Intake */}
        {activeTab === 'single' && (
          <form onSubmit={handleSubmitSingle} className="p-6 space-y-4">
            {/* Address Field */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Cryptocurrency Address <span className="text-rose-400">*</span>
              </label>
              <input
                id="input-wallet-address"
                type="text"
                required
                placeholder="e.g. bc1q..., 0x..., TXxx..., 9WzD..., rEb8..."
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
              />
            </div>

            {/* Live Address Validation Card */}
            {validation && (
              <div id="live-validation-result-card" className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {validation.is_valid ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    <span className="font-semibold text-slate-200">
                      {validation.is_valid ? 'Valid Address Format' : 'Invalid Address'}
                    </span>
                    <span className="px-1.5 py-0.2 text-[10px] font-mono rounded bg-slate-800 text-slate-300">
                      {validation.address_format}
                    </span>
                  </div>

                  <span className="text-[11px] font-mono text-cyan-400 font-medium">
                    Resolved: {validation.resolved_network}
                  </span>
                </div>

                {/* EVM Ambiguity Notice */}
                {validation.network_ambiguity && (
                  <div className="flex items-start gap-1.5 text-amber-300/90 text-[11px] bg-amber-950/30 p-2 rounded border border-amber-500/20">
                    <HelpCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>EVM Address — Network Uncertain:</strong> 0x address format matches Ethereum, BSC, Polygon, Arbitrum, and Base. Network context will be refined once blockchain data or reported token is confirmed.
                    </span>
                  </div>
                )}

                {/* Conflict Notice */}
                {validation.conflict_detected && (
                  <div className="flex items-start gap-1.5 text-rose-300/90 text-[11px] bg-rose-950/30 p-2 rounded border border-rose-500/20">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                    <span>{validation.conflict_notes}</span>
                  </div>
                )}
              </div>
            )}

            {/* Network & Asset Claims */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Reported / Claimed Network
                </label>
                <input
                  type="text"
                  placeholder="e.g. Bitcoin, Ethereum, TRON, BSC, Solana"
                  value={reportedNetwork}
                  onChange={(e) => setReportedNetwork(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Claimed Asset / Token
                </label>
                <input
                  type="text"
                  placeholder="e.g. BTC, ETH, USDT ERC20, USDT TRC20"
                  value={claimedAsset}
                  onChange={(e) => setClaimedAsset(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Provenance: Website & Source Context */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Suspected Scam Domain / Website
                </label>
                <input
                  type="text"
                  placeholder="e.g. crypto-wealth-vault.top"
                  value={websiteDomain}
                  onChange={(e) => setWebsiteDomain(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Source URL
                </label>
                <input
                  type="text"
                  placeholder="https://.../deposit"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Investigation & Source Module */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Source Module
                </label>
                <select
                  value={sourceModule}
                  onChange={(e) => setSourceModule(e.target.value as typeof sourceModule)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                >
                  <option value="site_investigator">Site Investigator</option>
                  <option value="crypto_wallet_logger">CryptoWalletLogger</option>
                  <option value="main_platform">Main Investigation Platform</option>
                  <option value="manual_entry">Manual Analyst Entry</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Investigation ID
                </label>
                <input
                  type="text"
                  placeholder="e.g. INV-2026-084"
                  value={investigationId}
                  onChange={(e) => setInvestigationId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Deposit Context
                </label>
                <input
                  type="text"
                  placeholder="e.g. Gold Tier deposit"
                  value={depositOption}
                  onChange={(e) => setDepositOption(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Notes & Tags */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Analyst Notes
                </label>
                <input
                  type="text"
                  placeholder="Internal investigative context..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  placeholder="pig_butchering, task_scam, urgent"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Analysis Profile & Auto-Run */}
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoAnalyze}
                    onChange={(e) => setAutoAnalyze(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-500 focus:ring-cyan-500 bg-slate-950"
                  />
                  <span>Auto-run analysis job</span>
                </label>

                {autoAnalyze && (
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>Profile:</span>
                    <select
                      value={profile}
                      onChange={(e) => setProfile(e.target.value as typeof profile)}
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs text-cyan-300"
                    >
                      <option value="QUICK">Quick (1 page, 0 hops)</option>
                      <option value="STANDARD">Standard (3 pages, 1 hop)</option>
                      <option value="DEEP">Deep (10 pages, 2 hops)</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  id="submit-new-wallet-btn"
                  type="submit"
                  disabled={isSubmitting || !address.trim()}
                  className="px-4 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Ingesting...' : 'Ingest & Investigate'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Tab 2: Bulk Paste */}
        {activeTab === 'bulk' && (
          <form onSubmit={handleBulkSubmit} className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Paste Addresses (One per line, or CSV with address, network, domain)
              </label>
              <textarea
                rows={8}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder="bc1q9x0z87q3y5w2u4p6k8m0n2b4v6c8x0z87q3y5w,bitcoin,scam-domain1.com&#10;0x71c841094df8cf7fa128565551f337f74c7dbb94,ethereum,fake-invest.xyz&#10;TXxxScamDepositTronWallet99887766554,tron,tron-doubler.net"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-800">
              <span className="text-xs text-slate-400">
                {bulkText.split('\n').filter((l) => l.trim()).length} address(es) parsed
              </span>
              <button
                type="submit"
                disabled={isSubmitting || !bulkText.trim()}
                className="px-4 py-1.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 rounded-lg shadow-sm transition-colors disabled:opacity-50"
              >
                {isSubmitting ? 'Importing...' : 'Import All Wallets'}
              </button>
            </div>
          </form>
        )}

        {/* Tab 3: Sample Scenarios */}
        {activeTab === 'sample' && (
          <div className="p-6 space-y-3">
            <p className="text-xs text-slate-400">
              Select a deterministic synthetic scenario to immediately test complete workflows, multi-token transfers, rapid pass-through detection, or data completeness warnings:
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  loadSampleFixture('btc');
                  setActiveTab('single');
                }}
                className="p-3 bg-slate-950 border border-slate-800 hover:border-cyan-500/50 rounded-lg text-left transition-colors"
              >
                <div className="font-semibold text-xs text-amber-300">Bitcoin UTXO Deposit Scam</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Multi-input & multi-output UTXO topology, change detection, and consolidation hub.
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  loadSampleFixture('eth');
                  setActiveTab('single');
                }}
                className="p-3 bg-slate-950 border border-slate-800 hover:border-cyan-500/50 rounded-lg text-left transition-colors"
              >
                <div className="font-semibold text-xs text-indigo-300">Ethereum + USDT ERC20</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Rapid 4-minute pass-through, smart contract token transfer, and destination convergence.
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  loadSampleFixture('tron');
                  setActiveTab('single');
                }}
                className="p-3 bg-slate-950 border border-slate-800 hover:border-cyan-500/50 rounded-lg text-left transition-colors"
              >
                <div className="font-semibold text-xs text-rose-300">TRON USDT TRC20 High Velocity</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Rapid 2-minute outbound transfer to laundering destination hub.
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  loadSampleFixture('partial');
                  setActiveTab('single');
                }}
                className="p-3 bg-slate-950 border border-slate-800 hover:border-amber-500/50 rounded-lg text-left transition-colors"
              >
                <div className="font-semibold text-xs text-amber-400">Partial Data Limitation Test</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Demonstrates PARTIAL completeness warning when provider pagination limit is hit.
                </div>
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
