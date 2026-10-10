import React, { useState, useEffect } from 'react';
import {
  X,
  ShieldAlert,
  ArrowRight,
  Database,
  Hash,
  Clock,
  Layers,
  HelpCircle,
  FileCheck2,
  Trash2,
  Shield,
  AlertTriangle,
  Flame,
  CheckCircle2,
  Sparkles,
  GitBranch
} from 'lucide-react';
import { Relationship, Entity, Evidence, Hypothesis, ReasoningTraceChain } from '../types';
import { api } from '../api';

interface LineageModalProps {
  operationId?: string;
  selectedItem: {
    type: 'relationship' | 'entity' | 'conclusion';
    data: any;
  } | null;
  onClose: () => void;
  relationships: Relationship[];
  entities: Entity[];
  evidenceList: Evidence[];
  hypotheses: Hypothesis[];
  onInvalidateEvidence: (evidenceId: string, reason: string) => Promise<void>;
}

export const LineageModal: React.FC<LineageModalProps> = ({
  operationId,
  selectedItem,
  onClose,
  relationships,
  entities,
  evidenceList,
  hypotheses,
  onInvalidateEvidence
}) => {
  const [invalidationReason, setInvalidationReason] = useState('');
  const [targetEvidenceToInvalidate, setTargetEvidenceToInvalidate] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [backendTraceChain, setBackendTraceChain] = useState<ReasoningTraceChain | null>(null);

  useEffect(() => {
    if (operationId && selectedItem) {
      const itemId = selectedItem.data?.id || (selectedItem.type === 'conclusion' ? 'conclusion-target' : 'root');
      api.getTraceabilityChain(operationId, selectedItem.type, itemId)
        .then(chain => setBackendTraceChain(chain))
        .catch(err => console.error('Failed to load traceability chain:', err));
    }
  }, [operationId, selectedItem]);

  if (!selectedItem) return null;

  // Resolve relationship context
  let primaryRel: Relationship | null = null;
  let primaryEntity: Entity | null = null;

  if (selectedItem.type === 'relationship') {
    primaryRel = selectedItem.data as Relationship;
  } else if (selectedItem.type === 'entity') {
    primaryEntity = selectedItem.data as Entity;
    primaryRel = relationships.find(r => r.sourceEntityId === primaryEntity?.id || r.targetEntityId === primaryEntity?.id) || null;
  } else if (selectedItem.type === 'conclusion') {
    primaryRel = selectedItem.data.relationship || null;
  }

  const sourceEnt = primaryRel ? entities.find(e => e.id === primaryRel?.sourceEntityId) : primaryEntity;
  const targetEnt = primaryRel ? entities.find(e => e.id === primaryRel?.targetEntityId) : null;

  // Associated evidence
  const associatedEvidence = primaryRel
    ? evidenceList.filter(e => primaryRel?.evidenceIds.includes(e.id))
    : primaryEntity
    ? evidenceList.filter(e => e.relatedEntityIds.includes(primaryEntity.id))
    : evidenceList.slice(0, 4);

  // Related hypotheses
  const relatedHypotheses = hypotheses.filter(h =>
    associatedEvidence.some(ev => h.supportingEvidenceIds.includes(ev.id) || h.contradictingEvidenceIds.includes(ev.id))
  );

  const handleInvalidate = async (eId: string) => {
    if (!invalidationReason.trim()) return;
    try {
      setIsSubmitting(true);
      await onInvalidateEvidence(eId, invalidationReason.trim());
      setTargetEvidenceToInvalidate(null);
      setInvalidationReason('');
      // Reload chain
      if (operationId) {
        const itemId = selectedItem.data?.id || 'root';
        const chain = await api.getTraceabilityChain(operationId, selectedItem.type, itemId);
        setBackendTraceChain(chain);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStateBadgeClass = (state?: string) => {
    switch (state) {
      case 'OBSERVED':
        return 'bg-emerald-950/70 border-emerald-600/50 text-emerald-400';
      case 'SUPPORTED':
        return 'bg-blue-950/70 border-blue-600/50 text-blue-300';
      case 'CORRELATED':
        return 'bg-sky-950/70 border-sky-600/50 text-sky-300';
      case 'HYPOTHESIZED':
        return 'bg-amber-950/70 border-amber-600/50 text-amber-300';
      case 'CONTRADICTED':
        return 'bg-rose-950/70 border-rose-600/50 text-rose-400';
      default:
        return 'bg-slate-900 border-slate-700 text-slate-400';
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex justify-end">
      <div className="w-full max-w-3xl bg-[#0b0f19] border-l border-[#1a2337] h-full overflow-y-auto flex flex-col p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#1a2337]">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-blue-400 font-bold bg-blue-950/60 border border-blue-800/40 px-2 py-0.5 rounded">
                Reasoning Traceability Chain
              </span>
              {primaryRel && (
                <span className={`text-[10px] font-mono uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${getStateBadgeClass(primaryRel.state)}`}>
                  {primaryRel.state}
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <span>Why does Hunter believe this?</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Strict 5-stage evidentiary lineage:
              <span className="font-mono text-blue-300 ml-1">
                Conclusion → Hypothesis → Relationships → Observations → Original Evidence
              </span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 5-STAGE PIPELINE CARDS */}
        <div className="my-5 space-y-4">
          {/* STAGE 1: CONCLUSION */}
          <div className="p-4 rounded-xl bg-[#080b11] border border-blue-500/30 space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-blue-400 font-bold uppercase tracking-wider">Stage 1: Surfaced Conclusion</span>
              <span className="text-[10px] bg-blue-950 text-blue-300 px-2 py-0.5 rounded border border-blue-800/50">
                ACTIVE FINDING
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-100">
              {backendTraceChain?.conclusion || selectedItem.data?.fact || selectedItem.data?.title || 'Identified active syndicate infrastructure node.'}
            </p>
          </div>

          <div className="flex justify-center -my-2 text-slate-600">
            <ArrowRight className="w-4 h-4 rotate-90" />
          </div>

          {/* STAGE 2: LEADING HYPOTHESIS & DEVIL'S ADVOCATE */}
          <div className="p-4 rounded-xl bg-[#0e1422] border border-[#1b253b] space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-emerald-400 font-bold uppercase tracking-wider">
                Stage 2: Leading Hypothesis & Probability
              </span>
              <span className="text-[11px] font-bold text-emerald-400">
                {Math.round((backendTraceChain?.leadingHypothesis.confidenceScore || 0.85) * 100)}% Probability
              </span>
            </div>

            <div>
              <h4 className="text-xs font-bold text-slate-200 mb-1">
                {backendTraceChain?.leadingHypothesis.title || relatedHypotheses[0]?.title || 'Syndicate Infrastructure Clustering'}
              </h4>
              <p className="text-xs text-slate-300 leading-relaxed">
                {(backendTraceChain?.leadingHypothesis as any)?.description || relatedHypotheses[0]?.description || 'Observed correlation indicates coordinated technical deployment.'}
              </p>
            </div>

            {/* Devil's Advocate / Disproval Condition */}
            <div className="p-3 rounded-lg bg-rose-950/20 border border-rose-900/40 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-rose-300 font-bold text-[11px] font-mono">
                <Flame className="w-3.5 h-3.5 text-rose-400" />
                <span>Hunter's Self-Disproval Challenge (Devil's Advocate):</span>
              </div>
              <p className="text-slate-300 text-[11px]">
                {backendTraceChain?.devilsAdvocateCondition || 'What would disprove this: Discovering independent commercial license keys or proof of independent multi-tenant VPS deployment by unrelated actors.'}
              </p>
            </div>

            {/* Competing Alternatives */}
            {backendTraceChain?.alternativeExplanations && backendTraceChain.alternativeExplanations.length > 0 && (
              <div className="pt-2 border-t border-slate-800/80">
                <span className="text-[10px] font-mono uppercase text-slate-500 font-bold block mb-1">
                  Competing Alternative Explanations Evaluated:
                </span>
                <ul className="space-y-1">
                  {backendTraceChain.alternativeExplanations.map((alt, i) => (
                    <li key={i} className="text-[11px] text-slate-400 flex items-start gap-1.5">
                      <span className="text-amber-400 font-mono">•</span>
                      <span>{alt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex justify-center -my-2 text-slate-600">
            <ArrowRight className="w-4 h-4 rotate-90" />
          </div>

          {/* STAGE 3: SUPPORTING RELATIONSHIPS */}
          <div className="p-4 rounded-xl bg-[#0e1422] border border-[#1b253b] space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-amber-400 font-bold uppercase tracking-wider">
                Stage 3: Supporting Defensible Relationships
              </span>
              <span className="text-[11px] text-slate-400">
                {(backendTraceChain?.supportingRelationships || []).length || (primaryRel ? 1 : 0)} Edges
              </span>
            </div>

            {primaryRel ? (
              <div className="p-3 rounded-lg bg-[#080b11] border border-slate-800/80 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-200 font-bold">
                    {sourceEnt?.value || 'Origin'} <span className="text-blue-400">→ [{primaryRel.type}] →</span> {targetEnt?.value || 'Target'}
                  </span>
                  <span className="text-emerald-400 font-bold">{Math.round(primaryRel.confidence * 100)}%</span>
                </div>
                <p className="text-xs text-slate-300">{primaryRel.reasoning}</p>
              </div>
            ) : (
              (backendTraceChain?.supportingRelationships || []).map(r => (
                <div key={r.id} className="p-3 rounded-lg bg-[#080b11] border border-slate-800/80 space-y-1">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-200 font-bold">Type: {r.type}</span>
                    <span className="text-emerald-400 font-bold">{Math.round(r.confidence * 100)}%</span>
                  </div>
                  <p className="text-xs text-slate-300">{r.reasoning}</p>
                </div>
              ))
            )}
          </div>

          <div className="flex justify-center -my-2 text-slate-600">
            <ArrowRight className="w-4 h-4 rotate-90" />
          </div>

          {/* STAGE 4: CONCRETE OBSERVATIONS */}
          <div className="p-4 rounded-xl bg-[#0e1422] border border-[#1b253b] space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-sky-400 font-bold uppercase tracking-wider">
                Stage 4: Verifiable Technical Observations
              </span>
              <span className="text-[11px] text-slate-400">
                {(backendTraceChain?.observations || associatedEvidence.map(e => e.originalObservation)).length} Verified Facts
              </span>
            </div>

            <div className="space-y-1.5">
              {(backendTraceChain?.observations || associatedEvidence.map(e => e.originalObservation)).map((obs, i) => {
                const obsText = typeof obs === 'string' ? obs : obs?.originalObservation || String(obs);
                return (
                  <div key={i} className="p-2.5 rounded bg-[#080b11] border border-slate-800/60 text-xs text-slate-300 flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
                    <span className="leading-relaxed">{obsText}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-center -my-2 text-slate-600">
            <ArrowRight className="w-4 h-4 rotate-90" />
          </div>

          {/* STAGE 5: ORIGINAL RAW EVIDENCE */}
          <div className="p-4 rounded-xl bg-[#0e1422] border border-[#1b253b] space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-purple-400 font-bold uppercase tracking-wider">
                Stage 5: Original Raw Evidence (Cryptographic Provenance)
              </span>
              <span className="text-[11px] text-slate-400 font-mono">
                Immutable Telemetry
              </span>
            </div>

            <div className="space-y-3">
              {associatedEvidence.map(ev => {
                const isInvalidated = ev.status === 'invalidated';
                return (
                  <div
                    key={ev.id}
                    className={`p-3.5 rounded-xl border transition-all ${
                      isInvalidated
                        ? 'bg-rose-950/20 border-rose-900/50 opacity-80'
                        : 'bg-[#080b11] border-slate-800'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <FileCheck2 className={`w-4 h-4 ${isInvalidated ? 'text-rose-400' : 'text-emerald-400'}`} />
                        <span className="text-xs font-mono font-bold text-slate-200 uppercase">
                          {ev.type}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                          {ev.source}
                        </span>
                        {isInvalidated && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-950 border border-rose-700/60 text-rose-300">
                            INVALIDATED
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(ev.timestamp).toLocaleString()}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                      {ev.originalObservation}
                    </p>

                    <div className="p-2 rounded bg-[#0b0f19] border border-slate-800/80 text-[10px] font-mono text-slate-400 space-y-1">
                      <div className="flex items-center gap-1.5 truncate">
                        <Database className="w-3 h-3 text-blue-400 shrink-0" />
                        <span className="text-slate-500">Source:</span>
                        <span className="text-slate-300 truncate">{ev.provenance}</span>
                      </div>
                      <div className="flex items-center gap-1.5 truncate">
                        <Hash className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="text-slate-500">SHA-256:</span>
                        <span className="text-slate-400 truncate">{ev.sha256Hash}</span>
                      </div>
                    </div>

                    {isInvalidated ? (
                      <div className="mt-2.5 p-2 rounded bg-rose-950/60 border border-rose-800/40 text-[11px] text-rose-300">
                        <strong>Invalidation Reason:</strong> {ev.invalidationReason}
                      </div>
                    ) : (
                      <div className="mt-2.5 flex justify-end">
                        {targetEvidenceToInvalidate === ev.id ? (
                          <div className="w-full p-3 rounded-lg bg-[#141a29] border border-rose-900/60 space-y-2">
                            <label className="text-[11px] text-rose-300 font-semibold block">
                              Specify reason for invalidating this evidence:
                            </label>
                            <input
                              type="text"
                              value={invalidationReason}
                              onChange={e => setInvalidationReason(e.target.value)}
                              placeholder="e.g. Host is a multi-tenant shared proxy, not operator dedicated"
                              className="w-full text-xs px-2.5 py-1.5 rounded bg-[#080b11] border border-slate-700 text-slate-200 focus:outline-hidden focus:border-rose-500"
                            />
                            <div className="flex justify-end gap-2 pt-1">
                              <button
                                onClick={() => {
                                  setTargetEvidenceToInvalidate(null);
                                  setInvalidationReason('');
                                }}
                                className="text-xs px-2.5 py-1 rounded text-slate-400 hover:text-slate-200"
                              >
                                Cancel
                              </button>
                              <button
                                disabled={isSubmitting || !invalidationReason.trim()}
                                onClick={() => handleInvalidate(ev.id)}
                                className="text-xs px-3 py-1 rounded bg-rose-900/80 border border-rose-700 text-rose-200 hover:bg-rose-800 disabled:opacity-50"
                              >
                                {isSubmitting ? 'Recalculating Cascade...' : 'Confirm Invalidation & Cascade'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setTargetEvidenceToInvalidate(ev.id)}
                            className="flex items-center gap-1.5 text-xs text-rose-400/80 hover:text-rose-300 px-2 py-1 rounded hover:bg-rose-950/30 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Invalidate / Challenge Evidence</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
