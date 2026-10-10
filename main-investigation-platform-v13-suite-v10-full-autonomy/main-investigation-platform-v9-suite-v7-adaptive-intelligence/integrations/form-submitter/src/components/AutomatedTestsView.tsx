import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  CheckCircle,
  Activity,
} from 'lucide-react';
import { runAutomatedTestSuite, TestResult } from '../utils/testSuite';

export const AutomatedTestsView: React.FC = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ total: number; passed: number; failed: number }>({
    total: 0,
    passed: 0,
    failed: 0,
  });

  const handleRunTests = () => {
    setRunning(true);
    setTimeout(() => {
      const outcome = runAutomatedTestSuite();
      setResults(outcome.results);
      setSummary({
        total: outcome.total,
        passed: outcome.passed,
        failed: outcome.failed,
      });
      setRunning(false);
    }, 50);
  };

  useEffect(() => {
    const initial = window.setTimeout(handleRunTests, 0);
    return () => window.clearTimeout(initial);
  }, []);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <CheckCircle className="w-6 h-6 text-teal-400" />
            Automated Cryptographic &amp; Validation Test Suite
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Verification suite testing Bitcoin Base58Check, EVM EIP-55, Bech32, TRON 0x41 prefix, Solana Ed25519, ambiguity detection, and Google Form prefill URL generation.
          </p>
        </div>

        <button
          onClick={handleRunTests}
          disabled={running}
          id="run-tests-button"
          className="px-4 py-2 text-xs font-bold rounded-lg bg-teal-600 hover:bg-teal-500 text-white shadow-md flex items-center gap-2 transition-colors disabled:opacity-50"
        >
          <RotateCcw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
          <span>Re-run All Tests</span>
        </button>
      </div>

      {/* Summary Scorecard */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-500/20 text-teal-400 flex items-center justify-center font-bold text-base">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xl font-bold text-white">{summary.total}</div>
            <div className="text-xs text-slate-400">Total Test Cases</div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-base">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xl font-bold text-emerald-400">{summary.passed}</div>
            <div className="text-xs text-slate-400">Passed Successfully</div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-base ${
            summary.failed > 0 ? 'bg-rose-500/20 text-rose-400' : 'bg-slate-800 text-slate-500'
          }`}>
            <XCircle className="w-5 h-5" />
          </div>
          <div>
            <div className={`text-xl font-bold ${summary.failed > 0 ? 'text-rose-400' : 'text-slate-400'}`}>
              {summary.failed}
            </div>
            <div className="text-xs text-slate-400">Failed Assertions</div>
          </div>
        </div>
      </div>

      {/* Test List */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 bg-slate-850 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
            Test Case Execution Log
          </span>
          <span className="text-[11px] font-mono text-slate-400">
            Engine: Pure TypeScript Deterministic Checksums
          </span>
        </div>

        <div className="divide-y divide-slate-800">
          {results.map((t, idx) => (
            <div key={idx} className="p-4 flex items-start justify-between gap-4 hover:bg-slate-850/50 transition-colors">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  {t.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  )}
                  <span className="font-semibold text-xs text-slate-200">{t.name}</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                    {t.category}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 pl-6 space-y-0.5">
                  <div>
                    <span className="text-slate-500">Expected:</span> <code className="text-slate-300 font-mono">{t.expected}</code> • <span className="text-slate-500">Actual:</span> <code className="text-slate-300 font-mono">{t.actual}</code>
                  </div>
                  {t.error && <div className="text-rose-400 font-mono text-[10px]">{t.error}</div>}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded ${
                    t.passed
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}
                >
                  {t.passed ? 'PASSED' : 'FAILED'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
