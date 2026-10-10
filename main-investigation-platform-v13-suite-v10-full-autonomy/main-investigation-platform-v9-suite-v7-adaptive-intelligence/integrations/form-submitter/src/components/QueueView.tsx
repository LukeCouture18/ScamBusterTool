import React, { useState, useEffect } from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Trash2,
  FileCheck,
  ChevronRight,
  ShieldAlert,
  Download,
  Upload,
  RefreshCw,
  Zap,
  Play,
  Pause,
  StopCircle,
  Loader2,
  ShieldCheck,
  AlertOctagon,
} from 'lucide-react';
import {
  InvestigationFinding,
  QueueFilterStatus,
  FormMappingConfig,
  UserSettings,
  HistoryRecord,
  AutoSubmitSessionState,
} from '../types';
import { evaluateAutoSubmitGate, generateIdempotencyKey, maskSecret } from '../utils/autoSubmitGate';
import { executeRealFormSubmission } from '../utils/multiPageFormEngine';
import { generatePrefillUrl } from '../utils/formMapping';

interface QueueViewProps {
  queue: InvestigationFinding[];
  formConfig: FormMappingConfig;
  settings: UserSettings;
  history: HistoryRecord[];
  onSelectFinding: (finding: InvestigationFinding) => void;
  onDeleteFinding: (id: string) => void;
  onValidateAll: () => void;
  onClearCompleted: () => void;
  onExportQueue: () => void;
  onImportQueue: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrepareSubmission: (finding: InvestigationFinding) => void;
  onAddNew: () => void;
  onFindingCompleted: (record: HistoryRecord) => void;
  onUpdateFindingState: (id: string, updates: Partial<InvestigationFinding>) => void;
}

export const QueueView: React.FC<QueueViewProps> = ({
  queue,
  formConfig,
  settings,
  history,
  onSelectFinding,
  onDeleteFinding,
  onValidateAll,
  onClearCompleted,
  onExportQueue,
  onImportQueue,
  onPrepareSubmission,
  onAddNew,
  onFindingCompleted,
  onUpdateFindingState,
}) => {
  const [filter, setFilter] = useState<QueueFilterStatus | 'RECOVERY'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Auto Submit Batch Engine State
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchPaused, setBatchPaused] = useState(false);
  const [currentBatchIndex, setCurrentBatchIndex] = useState(0);
  const [batchItems, setBatchItems] = useState<InvestigationFinding[]>([]);
  const [pacingCountdown, setPacingCountdown] = useState<number>(0);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [batchHaltedReason, setBatchHaltedReason] = useState<string | null>(null);

  // Crash / Interrupted findings count
  const recoveredFindings = queue.filter(
    (f) => f.submissionState === 'UNKNOWN' || f.recoveryState === 'VERIFICATION_UNKNOWN'
  );

  const readyFindings = queue.filter((f) => {
    if (f.overallStatus !== 'READY') return false;
    if (f.queueStatus === 'COMPLETED') return false;
    if (f.submissionState === 'UNKNOWN') return false;
    const gate = evaluateAutoSubmitGate(f, formConfig, settings, queue, history, true);
    return gate.canAutoSubmit;
  });

  const filteredQueue = queue.filter((item) => {
    if (filter === 'RECOVERY') {
      return item.submissionState === 'UNKNOWN' || item.recoveryState === 'VERIFICATION_UNKNOWN';
    }
    if (filter === 'READY' && item.overallStatus !== 'READY') return false;
    if (filter === 'NEEDS_REVIEW' && item.overallStatus !== 'NEEDS_REVIEW') return false;
    if (filter === 'PENDING' && item.queueStatus !== 'PENDING') return false;
    if (filter === 'COMPLETED' && item.queueStatus !== 'COMPLETED') return false;
    if (filter === 'FAILED' && item.queueStatus !== 'FAILED') return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchUrl = item.siteUrl.toLowerCase().includes(q) || item.domain.toLowerCase().includes(q);
      const matchWallets = item.wallets.some(
        (w) => w.address.toLowerCase().includes(q) || w.selectedNetwork.toLowerCase().includes(q)
      );
      const matchNotes = item.notes?.toLowerCase().includes(q);
      const matchId = item.id.toLowerCase().includes(q) || item.provenance?.investigationId?.toLowerCase().includes(q);
      return matchUrl || matchWallets || matchNotes || matchId;
    }

    return true;
  });

  const counts = {
    ALL: queue.length,
    READY: queue.filter((f) => f.overallStatus === 'READY').length,
    NEEDS_REVIEW: queue.filter((f) => f.overallStatus === 'NEEDS_REVIEW').length,
    PENDING: queue.filter((f) => f.queueStatus === 'PENDING').length,
    COMPLETED: queue.filter((f) => f.queueStatus === 'COMPLETED').length,
    FAILED: queue.filter((f) => f.queueStatus === 'FAILED').length,
    RECOVERY: recoveredFindings.length,
  };

  // Start batch auto submit
  const handleStartBatch = () => {
    if (!settings.autoSubmitGlobalEnabled) {
      alert('Auto Submit Master Switch is currently disabled in Settings. Please enable it first.');
      return;
    }
    if (readyFindings.length === 0) {
      alert('No findings currently qualify for automated submission.');
      return;
    }

    setBatchItems(readyFindings);
    setCurrentBatchIndex(0);
    setIsBatchRunning(true);
    setBatchPaused(false);
    setBatchHaltedReason(null);
    setBatchLogs([`Initialized batch Auto Submit session for ${readyFindings.length} qualifying findings.`]);
  };

  // Batch Auto Submit Execution Loop
  useEffect(() => {
    if (!isBatchRunning || batchPaused) return;

    if (currentBatchIndex >= batchItems.length) {
      const complete = window.setTimeout(() => {
        setIsBatchRunning(false);
        setBatchLogs((prev) => [`Batch completed: All ${batchItems.length} findings submitted.`, ...prev]);
      }, 0);
      return () => window.clearTimeout(complete);
    }

    const currentFinding = batchItems[currentBatchIndex];
    let isCancelled = false;

    const runSubmission = async () => {
      // 1. Strict pre-submission gate check
      const gate = evaluateAutoSubmitGate(currentFinding, formConfig, settings, queue, history, true);
      if (!gate.canAutoSubmit) {
        setIsBatchRunning(false);
        setBatchHaltedReason(`Safety Gate Failed on ${currentFinding.domain}: ${gate.reasons.join(', ')}`);
        return;
      }

      onUpdateFindingState(currentFinding.id, { submissionState: 'SUBMITTING' });
      setBatchLogs((prev) => [
        `[${currentBatchIndex + 1}/${batchItems.length}] Submitting ${currentFinding.domain}...`,
        ...prev,
      ]);

      const idempotencyKey = generateIdempotencyKey(currentFinding, formConfig);

      try {
        const result = await executeRealFormSubmission(
          currentFinding,
          formConfig,
          settings,
          idempotencyKey
        );

        if (isCancelled) return;

        if (result.isCaptcha || result.requiresChallenge) {
          setIsBatchRunning(false);
          setBatchHaltedReason(
            `HALTED: Google Form presented ${result.isCaptcha ? 'CAPTCHA' : 'Authentication requirement'}. Automated submission stopped immediately.`
          );
          onUpdateFindingState(currentFinding.id, {
            submissionState: 'FAILED',
            verificationNotes: result.error,
          });
          return;
        }

        if (result.success) {
          onUpdateFindingState(currentFinding.id, {
            submissionState: 'COMPLETED',
            queueStatus: 'COMPLETED',
            completedAt: new Date().toISOString(),
          });

          const prefill = generatePrefillUrl(currentFinding, formConfig);
          const historyRecord: HistoryRecord = {
            id: `HIST-${Date.now()}`,
            findingId: currentFinding.id,
            timestamp: new Date().toISOString(),
            siteUrl: currentFinding.siteUrl,
            domain: currentFinding.domain,
            wallets: currentFinding.wallets.map((w) => ({
              address: w.address,
              network: w.selectedNetwork,
              checksumStatus: w.checksumValid === true ? 'Verified' : 'Unchecked/Standard',
            })),
            username: currentFinding.username || settings.username,
            teamInviteCodeMasked: maskSecret(currentFinding.teamInviteCode || settings.teamInviteCode),
            populatedFields: Object.entries(prefill.populatedFields).reduce(
              (acc, [k, v]) => ({ ...acc, [k]: v.value }),
              {}
            ),
            userModifications: ['Batch Auto Submit Engine'],
            submissionMode: 'AUTO_SUBMIT',
            manualSubmissionConfirmed: true,
            prefillUrl: prefill.prefillUrl,
            idempotencyKey,
            verificationOutcome: 'VERIFIED_COMPLETED',
            verificationDetails: result.confirmationMessage || 'Google Form response recorded.',
          };

          onFindingCompleted(historyRecord);
          setBatchLogs((prev) => [
            `✓ [${currentBatchIndex + 1}/${batchItems.length}] ${currentFinding.domain}: Confirmed & Recorded`,
            ...prev,
          ]);

          // Pacing countdown before next item
          const delaySec = settings.batchPacingSeconds || 5;
          let remaining = delaySec;
          setPacingCountdown(remaining);

          const interval = setInterval(() => {
            remaining -= 1;
            setPacingCountdown(remaining);
            if (remaining <= 0) {
              clearInterval(interval);
              setCurrentBatchIndex((idx) => idx + 1);
            }
          }, 1000);
        } else {
          setIsBatchRunning(false);
          setBatchHaltedReason(`Submission failed on ${currentFinding.domain}: ${result.error}`);
          onUpdateFindingState(currentFinding.id, {
            submissionState: 'UNKNOWN',
            recoveryState: 'VERIFICATION_UNKNOWN',
            verificationNotes: result.error,
          });
        }
      } catch (err: unknown) {
        setIsBatchRunning(false);
        setBatchHaltedReason(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    runSubmission();

    return () => {
      isCancelled = true;
    };
  }, [isBatchRunning, batchPaused, currentBatchIndex]);

  return (
    <div className="space-y-6">
      {/* Interruption / Crash Recovery Alert Banner */}
      {recoveredFindings.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-500/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-3">
            <AlertOctagon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong className="text-amber-300 font-bold block text-sm">
                Interrupted Submissions Recovered ({recoveredFindings.length})
              </strong>
              <p className="text-amber-200/80 mt-0.5 leading-relaxed">
                Findings were interrupted during a previous session. To prevent accidental duplicates, they have been preserved in state <span className="font-mono text-amber-300 font-bold">VERIFICATION_UNKNOWN</span> and will not auto-submit without manual review.
              </p>
            </div>
          </div>

          <button
            onClick={() => setFilter('RECOVERY')}
            className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shrink-0 shadow transition-colors"
          >
            Review Recovered Items
          </button>
        </div>
      )}

      {/* Batch Auto Submit Active Panel */}
      {isBatchRunning && (
        <div className="bg-slate-950 border border-amber-500/40 rounded-xl p-4 space-y-3 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <strong className="text-slate-200 text-sm">Batch Auto Submit Session Active</strong>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setBatchPaused(!batchPaused)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold flex items-center gap-1.5"
              >
                {batchPaused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
                <span>{batchPaused ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                onClick={() => setIsBatchRunning(false)}
                className="px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 font-semibold border border-rose-500/30 flex items-center gap-1.5"
              >
                <StopCircle className="w-3.5 h-3.5" />
                <span>Abort</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-slate-400 pt-1">
            <span>
              Processing finding <strong className="text-slate-200">{currentBatchIndex + 1}</strong> of <strong className="text-slate-200">{batchItems.length}</strong>
            </span>

            {pacingCountdown > 0 && (
              <span className="text-amber-400 font-mono">
                Pacing delay: next submit in {pacingCountdown}s...
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div
              className="bg-amber-500 h-full transition-all duration-300"
              style={{
                width: `${Math.round(((currentBatchIndex) / batchItems.length) * 100)}%`,
              }}
            />
          </div>

          {/* Live mini logs */}
          <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80 font-mono text-[11px] text-slate-300 max-h-24 overflow-y-auto space-y-1">
            {batchLogs.map((log, idx) => (
              <div key={idx}>{log}</div>
            ))}
          </div>
        </div>
      )}

      {batchHaltedReason && (
        <div className="bg-rose-950/40 border border-rose-500/40 rounded-xl p-4 text-xs text-rose-300 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <strong className="block font-bold text-white text-sm">Batch Auto Submit Halted</strong>
            <p className="mt-0.5 leading-relaxed">{batchHaltedReason}</p>
          </div>
        </div>
      )}

      {/* Top Banner & Action Controls */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            Investigation Queue
            <span className="text-sm font-normal text-slate-400">
              ({filteredQueue.length} of {queue.length} target sites)
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Process each investigated website independently. Inspect findings, verify wallet checksums, and submit authorized reports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Batch Auto Submit Button */}
          {settings.autoSubmitGlobalEnabled && readyFindings.length > 0 && !isBatchRunning && (
            <button
              onClick={handleStartBatch}
              id="batch-auto-submit-button"
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-500 text-white shadow transition-colors"
              title="Batch auto-submit all verified READY findings passing the 10-point gate"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Batch Auto Submit ({readyFindings.length})</span>
            </button>
          )}

          <button
            onClick={onValidateAll}
            id="validate-all-button"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            title="Re-run cryptographic checksums and duplicate checks on all findings"
          >
            <RefreshCw className="w-3.5 h-3.5 text-sky-400" />
            Validate All
          </button>

          <button
            onClick={onExportQueue}
            id="export-queue-button"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            Export JSON
          </button>

          <label className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5 text-slate-400" />
            Import JSON
            <input type="file" accept=".json" onChange={onImportQueue} className="hidden" />
          </label>

          <button
            onClick={onAddNew}
            id="queue-add-new-button"
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
          >
            + New Finding
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Status Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 no-scrollbar text-xs font-medium">
          {(['ALL', 'READY', 'NEEDS_REVIEW', 'PENDING', 'COMPLETED', 'FAILED', 'RECOVERY'] as (QueueFilterStatus | 'RECOVERY')[]).map(
            (st) => {
              const count = counts[st];
              const isActive = filter === st;

              let activeClass = 'bg-slate-800 text-slate-200 border-slate-700';
              if (st === 'READY') activeClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
              if (st === 'NEEDS_REVIEW') activeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
              if (st === 'FAILED') activeClass = 'bg-rose-500/20 text-rose-300 border-rose-500/30';
              if (st === 'COMPLETED') activeClass = 'bg-sky-500/20 text-sky-300 border-sky-500/30';
              if (st === 'RECOVERY') activeClass = 'bg-amber-600 text-slate-950 font-bold border-amber-400';

              if (st === 'RECOVERY' && count === 0) return null;

              return (
                <button
                  key={st}
                  onClick={() => setFilter(st)}
                  id={`filter-${st.toLowerCase()}`}
                  className={`px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    isActive
                      ? activeClass + ' font-semibold shadow-xs'
                      : 'bg-slate-900/40 text-slate-400 border-slate-800 hover:bg-slate-800/60'
                  }`}
                >
                  <span>{st.replace('_', ' ')}</span>
                  <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-400 font-mono">
                    {count}
                  </span>
                </button>
              );
            }
          )}
        </div>

        {/* Search input */}
        <div className="relative min-w-[240px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search domain, wallet, network..."
            id="queue-search-input"
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Queue List */}
      {filteredQueue.length === 0 ? (
        <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-xl p-12 text-center">
          <ShieldAlert className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-300">No Findings Found</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
            {searchQuery
              ? `No findings match the search query "${searchQuery}".`
              : 'The current filter has no findings queued. Add a finding or import from your Main Platform.'}
          </p>
          <button
            onClick={onAddNew}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            Create First Finding
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredQueue.map((item) => {
            const isReady = item.overallStatus === 'READY';
            const isNeedsReview = item.overallStatus === 'NEEDS_REVIEW';
            const isBlocked = item.overallStatus === 'BLOCKED';
            const isCompleted = item.queueStatus === 'COMPLETED';
            const isRecovered = item.submissionState === 'UNKNOWN' || item.recoveryState === 'VERIFICATION_UNKNOWN';

            return (
              <div
                key={item.id}
                id={`queue-card-${item.id}`}
                className={`bg-slate-900 border rounded-xl p-4 transition-all hover:border-slate-700 ${
                  isRecovered
                    ? 'border-amber-500/70 bg-amber-950/10'
                    : isReady
                    ? 'border-emerald-900/40'
                    : isNeedsReview
                    ? 'border-amber-900/40'
                    : 'border-rose-900/40'
                }`}
              >
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  {/* Left Column: Website & Provenance */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      {/* Status Badges */}
                      {isRecovered && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-slate-950">
                          <AlertOctagon className="w-3.5 h-3.5" />
                          VERIFICATION UNKNOWN (RECOVERED)
                        </span>
                      )}

                      {isReady && !isRecovered && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          <CheckCircle className="w-3.5 h-3.5" />
                          READY
                        </span>
                      )}
                      {isNeedsReview && !isRecovered && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          NEEDS REVIEW
                        </span>
                      )}
                      {isBlocked && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30">
                          <XCircle className="w-3.5 h-3.5" />
                          BLOCKED
                        </span>
                      )}

                      {isCompleted && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-500/20 text-sky-400 border border-sky-500/30">
                          Reported &amp; Confirmed
                        </span>
                      )}

                      <span className="text-xs font-mono text-slate-500">ID: {item.id}</span>
                      {item.provenance?.sourceModule && (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                          {item.provenance.sourceModule}
                        </span>
                      )}
                    </div>

                    {/* Target Site */}
                    <div className="flex items-baseline gap-2">
                      <h4
                        className="text-base font-bold text-slate-100 truncate hover:text-sky-400 transition-colors cursor-pointer"
                        onClick={() => onSelectFinding(item)}
                      >
                        {item.domain || item.siteUrl}
                      </h4>
                      <a
                        href={item.siteUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-slate-500 hover:text-slate-300 transition-colors"
                        title="Open investigated URL in new tab"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>

                    {/* Wallets summary */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-slate-400 font-medium mr-1">
                        Wallets ({item.wallets.length}):
                      </span>
                      {item.wallets.slice(0, 3).map((w, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/80"
                          title={`${w.selectedNetwork}: ${w.address}`}
                        >
                          <span className="font-bold text-sky-400">{w.selectedNetwork}</span>
                          <span className="text-slate-400">
                            {w.address.slice(0, 6)}...{w.address.slice(-4)}
                          </span>
                          {w.checksumValid === true && (
                            <span className="text-emerald-400 font-bold" title="Checksum Verified">
                              ✓
                            </span>
                          )}
                          {w.status === 'BLOCKED' && (
                            <span className="text-rose-400 font-bold" title="Validation Failed">
                              ✗
                            </span>
                          )}
                        </span>
                      ))}
                      {item.wallets.length > 3 && (
                        <span className="text-[11px] text-slate-500">
                          +{item.wallets.length - 3} more
                        </span>
                      )}
                    </div>

                    {/* Diagnostics or recovery reason */}
                    <div className="mt-2 text-xs">
                      {item.verificationNotes ? (
                        <span className="text-amber-400 font-medium block">
                          ⚠ {item.verificationNotes}
                        </span>
                      ) : (
                        item.validationDiagnostics.map((diag, i) => (
                          <span
                            key={i}
                            className={`inline-block mr-3 mb-1 ${
                              diag.status === 'BLOCKED'
                                ? 'text-rose-400 font-medium'
                                : diag.status === 'NEEDS_REVIEW'
                                ? 'text-amber-400'
                                : 'text-slate-400'
                            }`}
                          >
                            • {diag.message}
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Right Column: Actions */}
                  <div className="flex items-center gap-2 self-end md:self-center">
                    <button
                      onClick={() => onSelectFinding(item)}
                      id={`inspect-button-${item.id}`}
                      className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors flex items-center gap-1.5"
                    >
                      <span>Review Details</span>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    </button>

                    <button
                      onClick={() => onPrepareSubmission(item)}
                      id={`prepare-submit-button-${item.id}`}
                      disabled={isBlocked}
                      className={`px-3.5 py-2 rounded-lg text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 ${
                        isBlocked
                          ? 'bg-slate-800 text-slate-500 border border-slate-800 cursor-not-allowed'
                          : isNeedsReview || isRecovered
                          ? 'bg-amber-600 hover:bg-amber-500 text-white'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      }`}
                      title={
                        isBlocked
                          ? 'Resolve blocked validation diagnostics before preparing form'
                          : 'Prepare Google Form report'
                      }
                    >
                      <FileCheck className="w-3.5 h-3.5" />
                      <span>{isRecovered ? 'Inspect Recovery' : 'Prepare Form'}</span>
                    </button>

                    <button
                      onClick={() => onDeleteFinding(item.id)}
                      id={`delete-button-${item.id}`}
                      className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      title="Remove from queue"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
