import React, { useState, useEffect } from 'react';
import {
  Server,
  Activity,
  Layers,
  ShieldCheck,
  RefreshCw,
  XCircle,
  Clock,
  CheckCircle2,
  Download,
  Archive,
} from 'lucide-react';
import { AnalysisJob, MainPlatformIntegrationStatus } from '../types';

export const SettingsView: React.FC = () => {
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [platformStatus, setPlatformStatus] = useState<MainPlatformIntegrationStatus | null>(null);
  const [providers, setProviders] = useState<Array<{ provider_name: string; is_rate_limited: boolean; total_requests: number; success_rate: number; priority: number }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [jobsRes, platformRes, providerRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/main-platform/status'),
        fetch('/api/providers/status'),
      ]);

      const jobsData = await jobsRes.json();
      const platformData = await platformRes.json();
      const providerData = await providerRes.json();

      setJobs(jobsData.jobs || []);
      setPlatformStatus(platformData);
      setProviders(providerData.providers || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(fetchData, 0);
    const timer = setInterval(fetchData, 4000);
    return () => { window.clearTimeout(initial); clearInterval(timer); };
  }, []);

  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div id="settings-view" className="space-y-6">
      
      {/* Top Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Server className="w-4 h-4 text-cyan-400" />
            <span>Platform Health, Background Jobs & Integrations</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Audit status for blockchain providers, active analysis pipelines, and Main Investigation Platform v6.
          </p>
        </div>

        <button
          onClick={fetchData}
          className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-950 border border-slate-800 rounded-lg hover:bg-slate-800"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Main Investigation Platform v6 Integration */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Main Investigation Platform v6 Gateway
            </h3>
          </div>
          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            {platformStatus?.status || 'ONLINE'}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Module ID</span>
            <span className="text-slate-200 font-semibold">{platformStatus?.module_id}</span>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Schema Version</span>
            <span className="text-slate-200 font-semibold">{platformStatus?.version}</span>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Offline Queue (Outbox)</span>
            <span className="text-amber-400 font-semibold">{platformStatus?.queued_outgoing_events_count}</span>
          </div>
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Processed Jobs</span>
            <span className="text-emerald-400 font-semibold">{platformStatus?.processed_jobs_count}</span>
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold text-slate-400 mb-2">Canonical Registered Capabilities:</div>
          <div className="flex flex-wrap gap-2">
            {(platformStatus?.capabilities || []).map((cap) => (
              <span key={cap} className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-cyan-300 font-mono text-[11px]">
                {cap}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Blockchain Provider Layer Status */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span>Blockchain Provider Layer & Failover Status</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {providers.map((p) => (
            <div key={p.provider_name} className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-100">{p.provider_name}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded font-semibold ${
                  p.is_rate_limited ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                }`}>
                  {p.is_rate_limited ? 'LIMITED' : 'HEALTHY'}
                </span>
              </div>
              <div className="flex justify-between text-slate-400 text-[11px]">
                <span>Total Calls:</span>
                <span className="text-slate-200">{p.total_requests}</span>
              </div>
              <div className="flex justify-between text-slate-400 text-[11px]">
                <span>Success Rate:</span>
                <span className="text-emerald-400 font-semibold">{Math.round(p.success_rate * 100)}%</span>
              </div>
              <div className="flex justify-between text-slate-400 text-[11px]">
                <span>Priority Tier:</span>
                <span className="text-slate-300">Tier {p.priority}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Background Jobs Engine */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" />
            <span>Persistent Background Analysis Jobs ({jobs.length})</span>
          </h3>
          <span className="text-[11px] text-slate-500 font-mono">
            Survives container restarts & tab refreshes
          </span>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900 border-b border-slate-800 text-[10px] uppercase font-semibold text-slate-400 font-mono">
              <tr>
                <th className="p-2.5">Status</th>
                <th className="p-2.5">Address</th>
                <th className="p-2.5">Network</th>
                <th className="p-2.5">Profile</th>
                <th className="p-2.5">Progress / Current Step</th>
                <th className="p-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500 font-sans">
                    No active or recent analysis jobs recorded.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-900/40">
                    <td className="p-2.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        job.status === 'COMPLETED'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                          : job.status === 'RUNNING'
                          ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/30'
                          : job.status === 'QUEUED'
                          ? 'bg-indigo-950 text-indigo-300 border border-indigo-500/30'
                          : job.status === 'PARTIAL'
                          ? 'bg-amber-950 text-amber-300 border border-amber-500/30'
                          : 'bg-slate-800 text-slate-400'
                      }`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="p-2.5 text-slate-200">
                      {job.address.slice(0, 10)}...{job.address.slice(-6)}
                    </td>
                    <td className="p-2.5 uppercase text-slate-400 text-[10px]">
                      {job.network}
                    </td>
                    <td className="p-2.5 text-cyan-300">
                      {job.profile}
                    </td>
                    <td className="p-2.5 font-sans">
                      <div className="flex items-center gap-2">
                        <div className="w-20 bg-slate-800 h-1.5 rounded-full overflow-hidden shrink-0">
                          <div
                            className="bg-cyan-400 h-full transition-all"
                            style={{ width: `${job.progress_percentage}%` }}
                          />
                        </div>
                        <span className="text-slate-400 text-[11px] truncate">
                          {job.current_step}
                        </span>
                      </div>
                    </td>
                    <td className="p-2.5 text-right font-sans">
                      {(job.status === 'RUNNING' || job.status === 'QUEUED') && (
                        <button
                          onClick={() => handleCancelJob(job.id)}
                          className="text-[11px] text-rose-400 hover:text-rose-300 underline"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Analysis Profiles Specification */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
          Configured Analysis Profiles
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
            <span className="font-bold text-cyan-400">QUICK Profile</span>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              1 page retrieval (max 25 txs), 0 hop expansion. High-speed preliminary validation and summary.
            </p>
          </div>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
            <span className="font-bold text-indigo-400">STANDARD Profile</span>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              3 page history (max 150 txs), 1 hop counterparty expansion. Standard investigation default.
            </p>
          </div>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
            <span className="font-bold text-amber-400">DEEP Profile</span>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              10 page history (max 500 txs), 2 hop graph tracing. For high-value or complex fraud tracking.
            </p>
          </div>
        </div>
      </div>

      {/* Project Source Code Export & ZIP Download */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Project Source Code Archive (.ZIP)
            </h3>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            READY FOR EXPORT
          </span>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Download the complete standalone source code for Wallet Investigator. Includes full Express backend, Vite React frontend, SQLite persistence with migrations, automated verification test suite, and deterministic crypto validation engines.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <a
            id="download-project-zip-settings-btn"
            href="/api/export-project-zip"
            download="wallet-investigator-project.zip"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            <span>Download Project ZIP Archive</span>
          </a>

          <a
            href="/project-source.zip"
            download="wallet-investigator-direct.zip"
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-950 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            <span>Direct Static Mirror</span>
          </a>
        </div>

        <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 text-[11px] text-slate-400">
          <span className="font-semibold text-slate-300 block mb-1">Google AI Studio Export Options:</span>
          You can also export this repository directly to GitHub or download a ZIP archive at any time via the upper-right <strong className="text-slate-200">Settings / Export</strong> menu in Google AI Studio.
        </div>
      </div>

    </div>
  );
};
