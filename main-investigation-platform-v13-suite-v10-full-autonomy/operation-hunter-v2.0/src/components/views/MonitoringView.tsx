import React, { useState } from 'react';
import {
  ReappearanceFingerprint,
  ReappearanceLead,
  MonitoringProbe
} from '../../types';
import {
  Radio,
  Search,
  ShieldCheck,
  AlertTriangle,
  Play,
  RotateCw,
  Plus,
  ArrowRight,
  Database,
  Hash,
  Clock,
  Sparkles
} from 'lucide-react';

interface MonitoringViewProps {
  fingerprints: ReappearanceFingerprint[];
  reappearanceLeads: ReappearanceLead[];
  monitoringProbes: MonitoringProbe[];
  onCheckCandidate: (candidate: {
    candidateValue: string;
    candidateType: string;
    features?: {
      domHash?: string;
      gaTag?: string;
      nameservers?: string[];
      destinationWallet?: string;
    };
  }) => Promise<ReappearanceLead>;
  onRunSweep: () => Promise<void>;
  isProcessing: boolean;
}

export const MonitoringView: React.FC<MonitoringViewProps> = ({
  fingerprints,
  reappearanceLeads,
  monitoringProbes,
  onCheckCandidate,
  onRunSweep,
  isProcessing
}) => {
  const [candidateVal, setCandidateVal] = useState('claim-refund-portal.click');
  const [candidateType, setCandidateType] = useState('domain');
  const [domHash, setDomHash] = useState('e79a9f24a1b02948');
  const [gaTag, setGaTag] = useState('G-99X4K21Z');
  const [nameservers, setNameservers] = useState('ns1.offshore-dns.is');
  const [destWallet, setDestWallet] = useState('0x71c8282929d0092e02e82110c49281a94b810b82');

  const [activeLeadResult, setActiveLeadResult] = useState<ReappearanceLead | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [sweepMessage, setSweepMessage] = useState<string | null>(null);

  const handleInspectCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!candidateVal.trim()) return;
    try {
      setIsChecking(true);
      const res = await onCheckCandidate({
        candidateValue: candidateVal.trim(),
        candidateType,
        features: {
          domHash: domHash.trim() || undefined,
          gaTag: gaTag.trim() || undefined,
          nameservers: nameservers.trim() ? nameservers.split(',').map(s => s.trim()) : undefined,
          destinationWallet: destWallet.trim() || undefined
        }
      });
      setActiveLeadResult(res);
    } finally {
      setIsChecking(false);
    }
  };

  const handleSweep = async () => {
    try {
      await onRunSweep();
      setSweepMessage('Monitoring sweep completed. Evaluated live sensor telemetry against preserved fingerprints.');
    } catch (err: any) {
      setSweepMessage(`Error running sweep: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header & Controls */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Radio className="w-4 h-4 text-blue-400" />
            <span>Preserved Fingerprints & Reappearance Detection</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Detect when new observations resemble previous domains, templates, infrastructure, or wallets. Generates reappearance leads without premature attribution.
          </p>
        </div>

        <button
          onClick={handleSweep}
          disabled={isProcessing}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-all disabled:opacity-50"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
          <span>Run Monitoring Sweep</span>
        </button>
      </div>

      {sweepMessage && (
        <div className="p-3.5 rounded-xl bg-blue-950/50 border border-blue-700/50 text-blue-300 text-xs flex items-center justify-between shadow-lg">
          <span>{sweepMessage}</span>
          <button onClick={() => setSweepMessage(null)} className="text-xs text-slate-400 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      {/* Interactive Live Reappearance Inspector */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-slate-100">Live Reappearance Inspector</h3>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            Probe any newly surfaced candidate against 4 historical vectors
          </span>
        </div>

        <form onSubmit={handleInspectCandidate} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Candidate Indicator (Domain / IP / Wallet)
              </label>
              <input
                type="text"
                value={candidateVal}
                onChange={e => setCandidateVal(e.target.value)}
                placeholder="e.g. claim-refund-portal.click"
                className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Type
              </label>
              <select
                value={candidateType}
                onChange={e => setCandidateType(e.target.value)}
                className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-200"
              >
                <option value="domain">domain</option>
                <option value="wallet">wallet</option>
                <option value="ip">ip</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-400 block mb-1">DOM Hash</label>
              <input
                type="text"
                value={domHash}
                onChange={e => setDomHash(e.target.value)}
                placeholder="e79a9f24a1b02948"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-300"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-400 block mb-1">Analytics ID / Tag</label>
              <input
                type="text"
                value={gaTag}
                onChange={e => setGaTag(e.target.value)}
                placeholder="G-99X4K21Z"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-300"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-400 block mb-1">Nameservers</label>
              <input
                type="text"
                value={nameservers}
                onChange={e => setNameservers(e.target.value)}
                placeholder="ns1.offshore-dns.is"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-300"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-400 block mb-1">Destination Wallet</label>
              <input
                type="text"
                value={destWallet}
                onChange={e => setDestWallet(e.target.value)}
                placeholder="0x71c8282929d0092e02e82110c49281a94b810b82"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg bg-[#080b11] border border-[#1b253b] text-slate-300"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={isChecking}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md transition-all disabled:opacity-50"
            >
              <Search className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Probing Match Matrix...' : 'Evaluate Reappearance Similarity'}</span>
            </button>
          </div>
        </form>

        {/* Live Inspection Result Card */}
        {activeLeadResult && (
          <div className="mt-4 p-4 rounded-xl bg-[#0e1422] border border-[#1d273f] space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-slate-100">{activeLeadResult.candidateValue}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 border border-emerald-600/50 text-emerald-300 font-bold uppercase">
                  {activeLeadResult.status}
                </span>
              </div>
              <div className="text-xs font-mono">
                Overall Similarity: <strong className="text-emerald-400 text-sm font-bold">{activeLeadResult.overallSimilarityScore}%</strong>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              {activeLeadResult.reasoning}
            </p>

            {/* Match Breakdown Matrix */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">
                Fingerprint Vector Comparison Breakdown
              </span>
              <div className="grid grid-cols-2 gap-2">
                {activeLeadResult.matchBreakdown.map((m, i) => (
                  <div key={i} className="p-2.5 rounded-lg bg-[#080b11] border border-slate-800/80 text-[11px] font-mono space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 font-bold uppercase">{m.fingerprintType}</span>
                      <span className="text-emerald-400 font-bold">{Math.round(m.similarity * 100)}% Match</span>
                    </div>
                    <div className="text-slate-500 truncate">Expected: <span className="text-slate-300">{m.expected}</span></div>
                    <div className="text-slate-500 truncate">Observed: <span className="text-slate-200">{m.observed}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Preserved Fingerprints Catalog */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Hash className="w-4 h-4 text-purple-400" />
            <span>Preserved Infrastructure & Operational Fingerprints ({fingerprints.length})</span>
          </h3>
          <span className="text-[11px] font-mono text-slate-500">
            Immutable signifiers retained across infrastructure rotations
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {fingerprints.map(fp => (
            <div key={fp.id} className="p-3.5 rounded-xl bg-[#0e1422] border border-[#1b253b] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase font-bold text-blue-400 bg-blue-950/60 border border-blue-800/40 px-2 py-0.5 rounded">
                  {fp.signatureType}
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  Weight: <strong className="text-slate-200">{fp.confidenceWeight}</strong>
                </span>
              </div>
              <div className="text-xs font-mono font-bold text-slate-200 break-all">
                {fp.signatureValue}
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                {fp.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Active Monitoring Probes */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Clock className="w-4 h-4 text-sky-400" />
          <span>Active Monitoring Probes ({monitoringProbes.length})</span>
        </h3>

        <div className="space-y-2">
          {monitoringProbes.map(probe => (
            <div key={probe.id} className="p-3 rounded-lg bg-[#0e1422] border border-[#1b253b] flex items-center justify-between text-xs">
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm" />
                <span className="font-mono font-bold text-slate-200">{probe.targetValue}</span>
                <span className="text-[11px] font-mono text-slate-500">Every {probe.frequencyMinutes}m</span>
              </div>
              <div className="flex items-center gap-4 text-[11px] font-mono text-slate-400">
                <span>Last Checked: {new Date(probe.lastCheckedAt).toLocaleTimeString()}</span>
                <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 font-bold border border-emerald-800/40">
                  {probe.matchesFound} Hits
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
