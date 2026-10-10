import React, { useState } from 'react';
import {
  Globe,
  Wallet,
  ShieldCheck,
  FileText,
  Upload,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Sparkles,
  Eye,
  ArrowRight,
  Info,
  Check,
} from 'lucide-react';
import {
  CryptoNetwork,
  InvestigationFinding,
  WalletFinding,
  UserSettings,
  ExtractedCandidate,
} from '../types';
import { validateWallet, validateScamUrl, evaluateFinding } from '../utils/walletValidation';

interface NewFindingInputProps {
  settings: UserSettings;
  existingQueue: InvestigationFinding[];
  onAddFinding: (finding: InvestigationFinding) => void;
  onCancel: () => void;
}

const SUPPORTED_NETWORKS: { value: CryptoNetwork; label: string; description: string }[] = [
  { value: 'BTC', label: 'Bitcoin (BTC)', description: 'Legacy 1..., P2SH 3..., SegWit bc1q..., Taproot bc1p...' },
  { value: 'ETH', label: 'Ethereum / EVM (ETH)', description: '0x... 40-char hex with EIP-55 checksum' },
  { value: 'USDT_ERC20', label: 'USDT (ERC20 / Ethereum)', description: '0x... EVM address with ERC20 token context' },
  { value: 'USDT_TRC20', label: 'USDT (TRC20 / TRON)', description: 'T... 34-char TRON Base58Check with 0x41 prefix' },
  { value: 'USDT_BEP20', label: 'USDT (BEP20 / BSC)', description: '0x... Binance Smart Chain BEP20 token address' },
  { value: 'TRX', label: 'TRON (TRX)', description: 'T... 34-char native TRON Base58Check address' },
  { value: 'SOL', label: 'Solana (SOL)', description: '32-44 char Base58 Ed25519 public key' },
  { value: 'XRP', label: 'XRP (Ripple)', description: 'r... 25-35 char Base58 with checksum' },
  { value: 'LTC', label: 'Litecoin (LTC)', description: 'L..., M..., or ltc1... bech32' },
  { value: 'DOGE', label: 'Dogecoin (DOGE)', description: 'D..., 9..., or A... Base58Check' },
  { value: 'ADA', label: 'Cardano (ADA)', description: 'addr1... bech32' },
  { value: 'XMR', label: 'Monero (XMR)', description: '4... or 8... Base58' },
  { value: 'UNKNOWN', label: 'Unknown / Ambiguous', description: 'Requires manual analyst inspection' },
];

export const NewFindingInput: React.FC<NewFindingInputProps> = ({
  settings,
  existingQueue,
  onAddFinding,
  onCancel,
}) => {
  const [siteUrl, setSiteUrl] = useState('');
  const [wallets, setWallets] = useState<{ id: string; address: string; network: CryptoNetwork }[]>([
    { id: 'w-init-1', address: '', network: 'UNKNOWN' },
  ]);
  const [notes, setNotes] = useState('');
  const [screenshots, setScreenshots] = useState<{ name: string; dataUrl: string }[]>([]);

  // Extraction State
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedCandidate, setExtractedCandidate] = useState<ExtractedCandidate | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [draftIdentity] = useState(() => ({
    findingId: `FIND-${crypto.randomUUID()}`,
    investigationId: `INV-${crypto.randomUUID()}`,
    siteId: `SITE-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
  }));

  // Form helpers
  const handleAddWallet = () => {
    setWallets([...wallets, { id: `w-${Date.now()}`, address: '', network: 'UNKNOWN' }]);
  };

  const handleRemoveWallet = (id: string) => {
    if (wallets.length === 1) {
      setWallets([{ id: `w-${crypto.randomUUID()}`, address: '', network: 'UNKNOWN' }]);
    } else {
      setWallets(wallets.filter((w) => w.id !== id));
    }
  };

  const handleUpdateWallet = (id: string, field: 'address' | 'network', value: string | CryptoNetwork) => {
    setWallets(
      wallets.map((w) => {
        if (w.id === id) {
          return { ...w, [field]: value };
        }
        return w;
      })
    );
  };

  // Image Upload handler
  const handleScreenshotUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setScreenshots((prev) => [
            ...prev,
            { name: file.name, dataUrl: event.target!.result as string },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // Call Gemini Vision via backend
  const handleExtractFromScreenshot = async (dataUrl: string) => {
    setIsExtracting(true);
    setExtractionError(null);
    setExtractedCandidate(null);

    try {
      const res = await fetch('/api/extract-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: dataUrl,
          mimeType: 'image/png',
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.candidate) {
        setExtractedCandidate(data.candidate);
      } else {
        setExtractionError('No candidate information detected in screenshot.');
      }
    } catch (err: unknown) {
      setExtractionError(`Extraction error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExtracting(false);
    }
  };

  // Apply candidate values into input fields (explicit review pattern)
  const handleApplyExtractedCandidate = () => {
    if (!extractedCandidate) return;

    if (extractedCandidate.url && !siteUrl) {
      setSiteUrl(extractedCandidate.url);
    }

    if (extractedCandidate.wallets && extractedCandidate.wallets.length > 0) {
      const newWallets = extractedCandidate.wallets.map((w, idx) => ({
        id: `w-extracted-${Date.now()}-${idx}`,
        address: w.address,
        network: w.suggestedNetwork || 'UNKNOWN',
      }));
      setWallets(newWallets);
    }

    if (extractedCandidate.scamTypeIndicators && extractedCandidate.scamTypeIndicators.length > 0) {
      const extraNotes = `Scam indicators: ${extractedCandidate.scamTypeIndicators.join(', ')}. ${extractedCandidate.reasoning || ''}`;
      setNotes((prev) => (prev ? `${prev}\n\n${extraNotes}` : extraNotes));
    }

    // Dismiss review banner after applying
    setExtractedCandidate(null);
  };

  // Compute live validation for current input
  const tempWallets: WalletFinding[] = wallets.map((w) => {
    const val = validateWallet(w.address, w.network, {
      hasTokenContext: w.network !== 'UNKNOWN',
      sourceEvidence: notes,
    });
    return {
      id: w.id,
      address: w.address,
      selectedNetwork: w.network,
      detectedNetworks: val.detectedNetworks,
      checksumValid: val.checksumValid,
      isAmbiguous: val.isAmbiguous,
      ambiguityReason: val.ambiguityReason,
      validationNotes: val.notes,
      status: val.status,
      confidence: 1.0,
    };
  });

  const urlEval = validateScamUrl(siteUrl);

  const candidateFinding: InvestigationFinding = {
    id: draftIdentity.findingId,
    siteUrl: urlEval.normalizedUrl || siteUrl,
    domain: urlEval.domain,
    wallets: tempWallets,
    screenshotUrls: screenshots.map((s) => s.dataUrl),
    notes,
    username: settings.username,
    teamInviteCode: settings.teamInviteCode,
    provenance: {
      investigationId: draftIdentity.investigationId,
      siteId: draftIdentity.siteId,
      walletIds: tempWallets.map((w) => w.id),
      evidenceIds: [],
      sourceModule: 'Manual Input',
      timestamp: draftIdentity.timestamp,
      confidence: 1.0,
      mainPlatformSyncStatus: 'PENDING_SYNC',
    },
    overallStatus: 'BLOCKED',
    queueStatus: 'PENDING',
    submissionState: 'NOT_STARTED',
    validationDiagnostics: [],
    submissionMode: settings.defaultSubmissionMode,
    createdAt: draftIdentity.timestamp,
    updatedAt: draftIdentity.timestamp,
  };

  const evaluation = evaluateFinding(candidateFinding, existingQueue);

  // Submit to queue
  const handleSubmitFinding = (e: React.FormEvent) => {
    e.preventDefault();

    const finalizedFinding: InvestigationFinding = {
      ...candidateFinding,
      overallStatus: evaluation.overallStatus,
      queueStatus: evaluation.overallStatus === 'READY' ? 'READY' : evaluation.overallStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'PENDING',
      wallets: evaluation.updatedWallets,
      validationDiagnostics: evaluation.diagnostics,
    };

    onAddFinding(finalizedFinding);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Title & Simple Stepped Overview */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          New Scam Website Finding
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Follow the core 4-step workflow: input the scam website, specify deposit wallets, review cryptographic validation, and attach evidence.
        </p>

        {/* Stepped Process Indicator */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 pt-4 border-t border-slate-800 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">1</span>
            <span className="font-medium">Website</span>
          </div>
          <div className="flex items-center gap-2 text-slate-300">
            <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">2</span>
            <span className="font-medium">Wallets</span>
          </div>
          <div className="flex items-center gap-2 text-slate-300">
            <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">3</span>
            <span className="font-medium">Validation</span>
          </div>
          <div className="flex items-center gap-2 text-slate-300">
            <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold">4</span>
            <span className="font-medium">Evidence</span>
          </div>
        </div>
      </div>

      {/* Candidate Extraction Banner (If extracted, requires user confirmation) */}
      {extractedCandidate && (
        <div className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-5 text-amber-200">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <h4 className="text-sm font-bold text-amber-300">
                  Candidate Information Extracted (Analyst Review Required)
                </h4>
                <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">
                  Never Silently Trusted
                </span>
              </div>
              <p className="text-xs text-amber-200/90 leading-relaxed">
                {extractedCandidate.reasoning || 'Gemini Vision extracted the following candidate website and deposit wallets from your screenshot. Inspect and confirm before applying.'}
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-slate-900/80 p-3 rounded-lg border border-amber-500/20">
                <div>
                  <span className="text-slate-400 font-semibold block">Candidate Website:</span>
                  <span className="text-white font-mono">{extractedCandidate.url || 'Not detected'}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-semibold block">Candidate Wallets ({extractedCandidate.wallets?.length || 0}):</span>
                  {extractedCandidate.wallets?.map((cw, i) => (
                    <div key={i} className="font-mono text-white truncate">
                      [{cw.suggestedNetwork}] {cw.address}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 shrink-0">
              <button
                type="button"
                onClick={handleApplyExtractedCandidate}
                id="apply-candidate-button"
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
                Apply to Finding
              </button>
              <button
                type="button"
                onClick={() => setExtractedCandidate(null)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Input Form */}
      <form onSubmit={handleSubmitFinding} className="space-y-6">
        {/* Step 1: Website URL */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-slate-100 font-semibold text-base">
            <Globe className="w-5 h-5 text-sky-400" />
            <h3>Step 1: Scam Website URL / Domain</h3>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Website URL or Domain Name <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              required
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="e.g. https://scam-trading-platform.top/deposit or scam-trading.vip"
              id="scam-url-input"
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500 font-mono"
            />
            {siteUrl && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                {urlEval.valid ? (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Target Domain Normalized: <strong className="font-mono">{urlEval.domain}</strong>
                  </span>
                ) : (
                  <span className="text-rose-400 flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" />
                    {urlEval.issues.join(', ')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Cryptocurrency Deposit Wallets */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-100 font-semibold text-base">
              <Wallet className="w-5 h-5 text-amber-400" />
              <h3>Step 2: Cryptocurrency Deposit Wallets</h3>
            </div>
            <button
              type="button"
              onClick={handleAddWallet}
              id="add-wallet-button"
              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 flex items-center gap-1 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Another Wallet
            </button>
          </div>

          <p className="text-xs text-slate-400">
            Support multiple deposit wallets belonging to the same scam website. Checksum validation runs in real time.
          </p>

          <div className="space-y-3">
            {wallets.map((walletItem, idx) => {
              const liveValidation = validateWallet(walletItem.address, walletItem.network, {
                hasTokenContext: walletItem.network !== 'UNKNOWN',
              });

              return (
                <div
                  key={walletItem.id}
                  className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="font-semibold text-slate-300">Wallet #{idx + 1}</span>
                    {wallets.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveWallet(walletItem.id)}
                        className="text-slate-500 hover:text-rose-400 transition-colors flex items-center gap-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {/* Wallet Address */}
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Deposit Address <span className="text-rose-400">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={walletItem.address}
                        onChange={(e) => handleUpdateWallet(walletItem.id, 'address', e.target.value)}
                        placeholder="e.g. 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa or 0x... or T..."
                        id={`wallet-address-input-${idx}`}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
                      />
                    </div>

                    {/* Network / Token Selector */}
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Token / Network <span className="text-rose-400">*</span>
                      </label>
                      <select
                        value={walletItem.network}
                        onChange={(e) =>
                          handleUpdateWallet(walletItem.id, 'network', e.target.value as CryptoNetwork)
                        }
                        id={`wallet-network-select-${idx}`}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-amber-500"
                      >
                        {SUPPORTED_NETWORKS.map((net) => (
                          <option key={net.value} value={net.value}>
                            {net.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Real-Time Live Validation Diagnostic for this wallet */}
                  {walletItem.address && (
                    <div className="pt-2 border-t border-slate-700/50 text-xs flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {liveValidation.status === 'READY' && (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Checksum &amp; Network Verified
                          </span>
                        )}
                        {liveValidation.status === 'NEEDS_REVIEW' && (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Needs Review: Ambiguous Network
                          </span>
                        )}
                        {liveValidation.status === 'BLOCKED' && (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                            <XCircle className="w-3.5 h-3.5" />
                            Invalid Format or Checksum Error
                          </span>
                        )}

                        {liveValidation.checksumValid === true && (
                          <span className="px-2 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-mono">
                            Cryptographic Checksum OK
                          </span>
                        )}
                      </div>

                      {/* Diagnostic Notes */}
                      <div className="text-slate-400 text-[11px]">
                        {liveValidation.notes[0]}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 3: Real-Time Validation Status Summary */}
        <div
          className={`border rounded-xl p-5 ${
            evaluation.overallStatus === 'READY'
              ? 'bg-emerald-950/20 border-emerald-500/30'
              : evaluation.overallStatus === 'NEEDS_REVIEW'
              ? 'bg-amber-950/20 border-amber-500/30'
              : 'bg-rose-950/20 border-rose-500/30'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-slate-200" />
              <h3 className="font-semibold text-slate-100 text-sm">Step 3: Validation Engine Review</h3>
            </div>
            <div>
              {evaluation.overallStatus === 'READY' && (
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                  STATUS: READY
                </span>
              )}
              {evaluation.overallStatus === 'NEEDS_REVIEW' && (
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">
                  STATUS: NEEDS REVIEW
                </span>
              )}
              {evaluation.overallStatus === 'BLOCKED' && (
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40">
                  STATUS: BLOCKED
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1.5 text-xs">
            {evaluation.diagnostics.map((d, i) => (
              <div key={i} className="flex items-start gap-2">
                {d.status === 'READY' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                ) : d.status === 'NEEDS_REVIEW' ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <strong className="text-slate-200">{d.rule}: </strong>
                  <span className="text-slate-400">{d.message}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Step 4: Supporting Evidence & Screenshot */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-slate-100 font-semibold text-base">
            <FileText className="w-5 h-5 text-purple-400" />
            <h3>Step 4: Supporting Evidence &amp; Screenshots</h3>
          </div>

          {/* Screenshot Upload & Gemini Vision Extractor */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Attach Screenshot / Evidence (Optional Vision Extraction)
            </label>
            <div className="border-2 border-dashed border-slate-700 hover:border-slate-600 rounded-xl p-4 text-center bg-slate-800/40 transition-colors">
              <Upload className="w-6 h-6 text-slate-500 mx-auto mb-1.5" />
              <p className="text-xs text-slate-300">
                Drag and drop screenshot image, or <label className="text-sky-400 hover:underline cursor-pointer">browse file<input type="file" accept="image/*" multiple onChange={handleScreenshotUpload} className="hidden" /></label>
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                PNG, JPG, or WebP evidence screenshots
              </p>
            </div>

            {/* Thumbnail previews & analyze buttons */}
            {screenshots.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {screenshots.map((sc, i) => (
                  <div
                    key={i}
                    className="relative group border border-slate-700 rounded-lg overflow-hidden bg-slate-800 w-32"
                  >
                    <img
                      src={sc.dataUrl}
                      alt={sc.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-20 object-cover"
                    />
                    <div className="p-1 text-[10px] text-slate-400 truncate">{sc.name}</div>
                    <button
                      type="button"
                      onClick={() => handleExtractFromScreenshot(sc.dataUrl)}
                      disabled={isExtracting}
                      id={`extract-vision-button-${i}`}
                      className="w-full py-1 bg-amber-600/80 hover:bg-amber-500 text-white text-[10px] font-semibold flex items-center justify-center gap-1 transition-colors"
                      title="Analyze with Gemini Vision OCR for scam URL and deposit wallets"
                    >
                      <Sparkles className="w-3 h-3" />
                      {isExtracting ? 'Analyzing...' : 'Extract OCR'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {extractionError && (
              <p className="text-xs text-rose-400 mt-2">{extractionError}</p>
            )}
          </div>

          {/* Additional Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Investigation Notes &amp; Scam Context
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Fraudulent investment platform displaying 300% weekly return lure. Public deposit addresses captured from account funding modal."
              id="scam-notes-input"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
          >
            Cancel
          </button>

          <button
            type="submit"
            id="add-to-queue-button"
            className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition-colors flex items-center gap-2"
          >
            <span>Add Finding to Investigation Queue</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};
