import React, { useState, useEffect } from 'react';
import {
  Entity,
  Relationship,
  Evidence,
  OperationProfile,
  TemporalSnapshot,
  FinancialAnalysis,
  FinancialTimelineEvent,
  AddressRotationRecord
} from '../../types';
import {
  Clock,
  RotateCw,
  Globe,
  Coins,
  Shield,
  Layers,
  ArrowRight,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Server,
  Key,
  ExternalLink,
  GitBranch,
  Split,
  Workflow
} from 'lucide-react';
import { api } from '../../api';

interface TimelineViewProps {
  operation: OperationProfile;
  entities: Entity[];
  relationships: Relationship[];
  evidenceList: Evidence[];
  onInspectLineage: (type: 'relationship' | 'entity' | 'conclusion', data: any) => void;
  temporalSnapshots?: TemporalSnapshot[];
  financialAnalysis?: FinancialAnalysis;
}

interface TimelineEvent {
  id: string;
  timestamp: string;
  type: 'SEED_INTAKE' | 'DNS_ROTATION' | 'CERT_ISSUANCE' | 'TEMPLATE_SIGHTING' | 'DRAIN_FLOW' | 'REAPPEARANCE';
  title: string;
  description: string;
  confidence: number;
  evidenceId?: string;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  operation,
  entities,
  relationships,
  evidenceList,
  onInspectLineage,
  temporalSnapshots: initialSnapshots,
  financialAnalysis: initialFinancial
}) => {
  const [filter, setFilter] = useState<string>('all');
  const [selectedStepIndex, setSelectedStepIndex] = useState<number>(4);
  const [snapshots, setSnapshots] = useState<TemporalSnapshot[]>(initialSnapshots || []);
  const [financial, setFinancial] = useState<FinancialAnalysis | undefined>(initialFinancial);
  const [activeSubTab, setActiveSubTab] = useState<'chronological' | 'timeT' | 'financial'>('timeT');
  const [loadingTimeT, setLoadingTimeT] = useState(false);

  useEffect(() => {
    if (!snapshots || snapshots.length === 0) {
      api.getTemporalReconstruction(operation.id)
        .then(res => {
          if (res.snapshots && res.snapshots.length > 0) {
            setSnapshots(res.snapshots);
            setSelectedStepIndex(res.snapshots.length - 1);
          }
        })
        .catch(err => console.error('Failed to load temporal reconstruction:', err));
    }
    if (!financial) {
      api.getFinancial(operation.id)
        .then(res => setFinancial(res))
        .catch(err => console.error('Failed to load financial analysis:', err));
    }
  }, [operation.id]);

  // Current active snapshot for "State at Time T"
  const currentSnapshot = snapshots.find(s => s.stepIndex === selectedStepIndex) || snapshots[snapshots.length - 1] || null;

  // Synthesize chronological temporal events from evidence
  const events: TimelineEvent[] = [];
  evidenceList.forEach(ev => {
    let evtType: TimelineEvent['type'] = 'TEMPLATE_SIGHTING';
    if (ev.type.includes('dns')) evtType = 'DNS_ROTATION';
    if (ev.type.includes('ssl') || ev.type.includes('cert')) evtType = 'CERT_ISSUANCE';
    if (ev.type.includes('tx') || ev.type.includes('flow') || ev.type.includes('blockchain') || ev.type.includes('financial')) evtType = 'DRAIN_FLOW';
    if (ev.type.includes('rotation')) evtType = 'DNS_ROTATION';

    events.push({
      id: ev.id,
      timestamp: ev.timestamp,
      type: evtType,
      title: `${ev.source.toUpperCase().replace(/_/g, ' ')}: ${ev.type}`,
      description: ev.originalObservation,
      confidence: ev.confidence,
      evidenceId: ev.id
    });
  });

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const filteredEvents = filter === 'all'
    ? events
    : events.filter(e => e.type.toLowerCase().includes(filter.toLowerCase()));

  const getEventBadge = (type: TimelineEvent['type']) => {
    switch (type) {
      case 'DNS_ROTATION':
        return { label: 'Infrastructure Rotation', color: 'text-sky-400 bg-sky-950/60 border-sky-800/40' };
      case 'CERT_ISSUANCE':
        return { label: 'SSL Transparency', color: 'text-emerald-400 bg-emerald-950/60 border-emerald-800/40' };
      case 'DRAIN_FLOW':
        return { label: 'Financial Movement', color: 'text-rose-400 bg-rose-950/60 border-rose-800/40' };
      case 'TEMPLATE_SIGHTING':
        return { label: 'Scam-Kit Fingerprint', color: 'text-purple-400 bg-purple-950/60 border-purple-800/40' };
      default:
        return { label: 'Operational Event', color: 'text-slate-400 bg-slate-900 border-slate-700' };
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* View Header with Sub-tabs */}
      <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-400" />
            <span>Temporal Reconstruction & State Evolution Engine</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Reconstructs how the observable syndicate morphs over time:
            <span className="font-mono text-slate-300 ml-1">
              sites appear/disappear → DNS/hosting migrates → smart contracts split → funds bridge cross-chain.
            </span>
          </p>
        </div>

        {/* Sub-tab selection */}
        <div className="flex items-center gap-1.5 bg-[#080b11] p-1 rounded-lg border border-[#1b253b] shrink-0">
          <button
            onClick={() => setActiveSubTab('timeT')}
            className={`text-xs px-3 py-1.5 rounded font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeSubTab === 'timeT'
                ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>State at Time T</span>
          </button>
          <button
            onClick={() => setActiveSubTab('financial')}
            className={`text-xs px-3 py-1.5 rounded font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeSubTab === 'financial'
                ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Coins className="w-3.5 h-3.5" />
            <span>Financial Timeline</span>
          </button>
          <button
            onClick={() => setActiveSubTab('chronological')}
            className={`text-xs px-3 py-1.5 rounded font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeSubTab === 'chronological'
                ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Chronological Stream</span>
          </button>
        </div>
      </div>

      {/* --- SUBTAB 1: STATE AT TIME T (TEMPORAL RECONSTRUCTION) --- */}
      {activeSubTab === 'timeT' && (
        <div className="space-y-6">
          {/* Step Selector Slider / Timeline Bar */}
          <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase font-bold text-slate-400 tracking-wider">
                Select Temporal Snapshot (T0 - T4)
              </span>
              <span className="text-xs font-mono text-blue-400 bg-blue-950/50 px-2 py-0.5 rounded border border-blue-800/40">
                {currentSnapshot?.stepLabel || `Step T${selectedStepIndex}`}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {snapshots.map((snap) => {
                const isSelected = snap.stepIndex === selectedStepIndex;
                return (
                  <button
                    key={snap.id}
                    onClick={() => setSelectedStepIndex(snap.stepIndex)}
                    className={`p-3 rounded-lg border text-left transition-all flex flex-col justify-between ${
                      isSelected
                        ? 'bg-blue-950/60 border-blue-500/60 text-blue-200 shadow-md ring-1 ring-blue-500/30'
                        : 'bg-[#080b11] border-[#182238] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-blue-400">
                      T{snap.stepIndex}
                    </span>
                    <span className="text-xs font-semibold mt-1 truncate">
                      {snap.stepLabel.split(':')[1]?.trim() || snap.stepLabel}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 mt-1">
                      {new Date(snap.timestamp).toLocaleDateString()}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Current Snapshot Inspector */}
          {currentSnapshot && (
            <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-5">
              <div className="border-b border-slate-800/80 pb-4">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-emerald-400" />
                    <span>{currentSnapshot.stepLabel}</span>
                  </h3>
                  <span className="text-xs font-mono text-slate-400">
                    Observed: {new Date(currentSnapshot.timestamp).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {currentSnapshot.summary}
                </p>
              </div>

              {/* Active Infrastructure Matrix at Time T */}
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider font-bold text-slate-400 block mb-3">
                  Observable Operational State at this Timestamp
                </span>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Active Domains */}
                  <div className="p-3.5 rounded-lg bg-[#080b11] border border-[#182238]">
                    <div className="flex items-center gap-2 text-xs font-bold text-sky-400 mb-2">
                      <Globe className="w-3.5 h-3.5" />
                      <span>Active Domains ({currentSnapshot.activeDomains.length})</span>
                    </div>
                    {currentSnapshot.activeDomains.length === 0 ? (
                      <span className="text-xs text-slate-500 font-mono">None deployed</span>
                    ) : (
                      <ul className="space-y-1">
                        {currentSnapshot.activeDomains.map((dom, i) => (
                          <li key={i} className="text-xs font-mono text-slate-300 flex items-center justify-between">
                            <span>{dom}</span>
                            <span className="text-[10px] px-1.5 py-0.2 bg-sky-950/60 text-sky-400 border border-sky-800/40 rounded">
                              ACTIVE
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Active Bulletproof IPs */}
                  <div className="p-3.5 rounded-lg bg-[#080b11] border border-[#182238]">
                    <div className="flex items-center gap-2 text-xs font-bold text-indigo-400 mb-2">
                      <Server className="w-3.5 h-3.5" />
                      <span>Bulletproof Offshore IPs ({currentSnapshot.activeIps.length})</span>
                    </div>
                    {currentSnapshot.activeIps.length === 0 ? (
                      <span className="text-xs text-slate-500 font-mono">None resolved</span>
                    ) : (
                      <ul className="space-y-1">
                        {currentSnapshot.activeIps.map((ip, i) => (
                          <li key={i} className="text-xs font-mono text-slate-300 flex items-center justify-between">
                            <span>{ip}</span>
                            <span className="text-[10px] px-1.5 py-0.2 bg-indigo-950/60 text-indigo-400 border border-indigo-800/40 rounded">
                              AS209588 (FlyHosting)
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Active Receiving Wallets */}
                  <div className="p-3.5 rounded-lg bg-[#080b11] border border-[#182238]">
                    <div className="flex items-center gap-2 text-xs font-bold text-rose-400 mb-2">
                      <Coins className="w-3.5 h-3.5" />
                      <span>Receiving & Treasury Wallets ({currentSnapshot.activeWallets.length})</span>
                    </div>
                    {currentSnapshot.activeWallets.length === 0 ? (
                      <span className="text-xs text-slate-500 font-mono">No wallet activity observed yet</span>
                    ) : (
                      <ul className="space-y-1">
                        {currentSnapshot.activeWallets.map((w, i) => (
                          <li key={i} className="text-xs font-mono text-slate-300 flex items-center justify-between truncate">
                            <span className="truncate mr-2">{w}</span>
                            <span className="text-[10px] px-1.5 py-0.2 bg-rose-950/60 text-rose-400 border border-rose-800/40 rounded shrink-0">
                              ON-CHAIN
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Active SSL Certificates & Nameservers */}
                  <div className="p-3.5 rounded-lg bg-[#080b11] border border-[#182238]">
                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 mb-2">
                      <Shield className="w-3.5 h-3.5" />
                      <span>Certificates & Authoritative NS</span>
                    </div>
                    <div className="space-y-2">
                      {currentSnapshot.activeCertificates.map((cert, i) => (
                        <div key={i} className="text-xs font-mono text-slate-300 truncate">
                          <span className="text-slate-500 mr-1">SSL:</span> {cert}
                        </div>
                      ))}
                      {currentSnapshot.activeNameservers.map((ns, i) => (
                        <div key={i} className="text-xs font-mono text-slate-300 truncate">
                          <span className="text-slate-500 mr-1">NS:</span> {ns}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Diffs & Mutations Since Previous Step */}
              <div className="pt-4 border-t border-slate-800/80">
                <span className="text-[11px] font-mono uppercase tracking-wider font-bold text-slate-400 block mb-2">
                  Deltas & Structural Rotations in this Step
                </span>

                <div className="space-y-2">
                  {currentSnapshot.addedSincePrevious.map((item, i) => (
                    <div key={`add-${i}`} className="p-2.5 rounded bg-emerald-950/20 border border-emerald-800/30 text-xs font-mono text-emerald-300 flex items-center gap-2">
                      <span className="font-bold text-emerald-400">[+ ADDED]</span>
                      <span className="uppercase text-[10px] bg-emerald-900/50 px-1 py-0.5 rounded">{item.entityType}</span>
                      <span className="font-semibold text-slate-200">{item.value}</span>
                      <span className="text-slate-400 text-[11px] ml-auto">({item.reason})</span>
                    </div>
                  ))}

                  {currentSnapshot.removedOrDecommissioned.map((item, i) => (
                    <div key={`rem-${i}`} className="p-2.5 rounded bg-rose-950/20 border border-rose-800/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                      <span className="font-bold text-rose-400">[- DECOMMISSIONED]</span>
                      <span className="uppercase text-[10px] bg-rose-900/50 px-1 py-0.5 rounded">{item.entityType}</span>
                      <span className="font-semibold text-slate-200">{item.value}</span>
                      <span className="text-slate-400 text-[11px] ml-auto">({item.reason})</span>
                    </div>
                  ))}

                  {currentSnapshot.mutations.map((mut, i) => (
                    <div key={`mut-${i}`} className="p-2.5 rounded bg-purple-950/20 border border-purple-800/30 text-xs font-mono text-purple-300 flex items-center gap-2">
                      <span className="font-bold text-purple-400">[~ CODEBASE MUTATION]</span>
                      <span className="text-slate-200">{mut}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- SUBTAB 2: FINANCIAL TIMELINE & FLOWS --- */}
      {activeSubTab === 'financial' && (
        <div className="space-y-6">
          {/* Financial Timeline Overview Banner */}
          <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 text-rose-400" />
                <h3 className="text-sm font-bold text-slate-100">Public Blockchain Fund-Flow Timeline</h3>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                <span>Total Volume Observed:</span>
                <span className="text-emerald-400 font-bold font-mono">48.65 ETH ($170,275 USD)</span>
              </div>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Traces public on-chain token transit across Ethereum, Arbitrum L2, and Tron networks.
              <span className="text-amber-400 ml-1 font-semibold">
                LEGAL NOTICE: On-chain transit establishes verifiable fund movement but does not constitute legal proof of recipient identity.
              </span>
            </p>
          </div>

          {/* Chronological Financial Events */}
          <div className="space-y-4">
            {(financial?.timeline || []).map((fte) => (
              <div key={fte.id} className="p-4 rounded-xl bg-[#0b0f19] border border-[#162035] hover:border-blue-500/40 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border text-rose-400 bg-rose-950/60 border-rose-800/40">
                      {fte.eventType.replace('_', ' ')}
                    </span>
                    <span className="text-xs font-bold text-slate-100">{fte.title}</span>
                    <span className="text-[10px] font-mono text-blue-400 bg-blue-950/50 px-1.5 py-0.5 rounded border border-blue-800/40 uppercase">
                      {fte.network}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-slate-400">
                    {new Date(fte.timestamp).toLocaleString()}
                  </span>
                </div>

                <p className="text-xs text-slate-300 mb-3">{fte.description}</p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-2.5 rounded bg-[#080b11] border border-[#182238] text-[11px] font-mono">
                  <div>
                    <span className="text-slate-500 block">From:</span>
                    <span className="text-slate-300 truncate block">{fte.fromAddress}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">To:</span>
                    <span className="text-slate-300 truncate block">{fte.toAddress}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Observed Amount:</span>
                    <span className="text-emerald-400 font-bold block">{fte.amount}</span>
                  </div>
                </div>

                {fte.txHash && (
                  <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-slate-500">
                    <span className="truncate mr-2">Tx: {fte.txHash}</span>
                    <button
                      onClick={() => onInspectLineage('conclusion', { fact: fte.description })}
                      className="text-blue-400 hover:text-blue-300 flex items-center gap-1 shrink-0"
                    >
                      <span>Inspect Evidence Lineage</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Address Rotations Record */}
          {financial?.addressRotations && financial.addressRotations.length > 0 && (
            <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
              <h3 className="text-xs font-bold text-slate-200 font-mono uppercase tracking-wider flex items-center gap-2">
                <RotateCw className="w-4 h-4 text-purple-400" />
                <span>Detected Address & Contract Rotations</span>
              </h3>

              <div className="space-y-2">
                {financial.addressRotations.map((ar, i) => (
                  <div key={i} className="p-3 rounded-lg bg-[#080b11] border border-[#182238] text-xs font-mono">
                    <div className="flex items-center gap-2 text-slate-300 mb-1">
                      <span className="text-rose-400 font-bold">{ar.originalAddress.slice(0, 12)}...</span>
                      <ArrowRight className="w-3 h-3 text-slate-500" />
                      <span className="text-emerald-400 font-bold">{ar.rotatedAddress.slice(0, 12)}...</span>
                      <span className="text-[10px] text-purple-400 bg-purple-950/60 px-1.5 py-0.5 rounded border border-purple-800/40 uppercase ml-auto">
                        {ar.network}
                      </span>
                    </div>
                    <span className="text-slate-400 text-[11px]">{ar.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- SUBTAB 3: CHRONOLOGICAL STREAM --- */}
      {activeSubTab === 'chronological' && (
        <div className="space-y-6">
          {/* Filter Bar */}
          <div className="flex items-center gap-1.5 bg-[#0b0f19] p-2 rounded-xl border border-[#162035]">
            <Filter className="w-3.5 h-3.5 text-slate-400 ml-2 mr-1" />
            <span className="text-xs font-mono text-slate-400 mr-2">Filter:</span>
            {['all', 'dns', 'cert', 'flow', 'template'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-2.5 py-1 rounded font-mono uppercase font-semibold transition-colors ${
                  filter === f
                    ? 'bg-blue-950/80 text-blue-300 border border-blue-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Timeline Stream */}
          <div className="relative pl-8 space-y-6 before:content-[''] before:absolute before:left-3.5 before:top-2 before:bottom-2 before:w-[2px] before:bg-slate-800">
            {filteredEvents.map((evt) => {
              const badge = getEventBadge(evt.type);
              return (
                <div key={evt.id} className="relative group">
                  <div className="absolute -left-8 top-3 w-4 h-4 rounded-full bg-[#0b0f19] border-2 border-blue-500 flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                  </div>

                  <div className="p-4 rounded-xl bg-[#0b0f19] border border-[#162035] group-hover:border-blue-500/40 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${badge.color}`}>
                          {badge.label}
                        </span>
                        <span className="text-xs font-semibold text-slate-200">{evt.title}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                        <Clock className="w-3 h-3 text-slate-500" />
                        <span>{new Date(evt.timestamp).toLocaleString()}</span>
                      </div>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed mb-3">
                      {evt.description}
                    </p>

                    <div className="pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs">
                      <span className="text-[11px] font-mono text-slate-500">
                        Confidence: <strong className="text-blue-400">{Math.round(evt.confidence * 100)}%</strong>
                      </span>
                      {evt.evidenceId && (
                        <button
                          onClick={() => onInspectLineage('conclusion', { fact: evt.description })}
                          className="text-[11px] font-mono text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        >
                          <span>Trace Original Evidence</span>
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
