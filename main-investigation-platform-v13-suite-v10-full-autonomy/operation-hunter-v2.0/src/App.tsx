import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import {
  OperationProfile,
  OperationBundle,
  Seed,
  Entity,
  Relationship,
  Evidence,
  Hypothesis,
  Lead,
  ReappearanceFingerprint,
  ReappearanceLead,
  MonitoringProbe
} from './types';
import { Sidebar, NavTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { InboxView } from './components/views/InboxView';
import { OverviewView } from './components/views/OverviewView';
import { GraphView } from './components/views/GraphView';
import { TimelineView } from './components/views/TimelineView';
import { EvidenceView } from './components/views/EvidenceView';
import { HypothesesView } from './components/views/HypothesesView';
import { LeadsView } from './components/views/LeadsView';
import { MonitoringView } from './components/views/MonitoringView';
import { LineageModal } from './components/LineageModal';
import { SeedModal } from './components/SeedModal';
import { EvidenceImportModal } from './components/EvidenceImportModal';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [operations, setOperations] = useState<OperationProfile[]>([]);
  const [currentOperation, setCurrentOperation] = useState<OperationProfile | null>(null);
  const [bundle, setBundle] = useState<OperationBundle | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Modals state
  const [seedModalOpen, setSeedModalOpen] = useState(false);
  const [evidenceModalOpen, setEvidenceModalOpen] = useState(false);
  const [lineageTarget, setLineageTarget] = useState<{
    type: 'relationship' | 'entity' | 'conclusion';
    data: any;
  } | null>(null);

  // Load bundle for a given operation
  const loadOperationBundle = useCallback(async (opId: string) => {
    try {
      const data = await api.getOperation(opId);
      setBundle(data);
      setCurrentOperation(data.operation);
    } catch (err) {
      console.error('Failed to load operation bundle:', err);
    }
  }, []);

  // Initial load
  const loadInitialData = useCallback(async () => {
    try {
      setInitialLoading(true);
      const ops = await api.getOperations();
      setOperations(ops);
      if (ops.length > 0) {
        // v1.0: #/classic/<operationId> preselects that operation.
        const wanted = window.location.hash.replace(/^#\/?classic\/?/, '').split('/')[0];
        const defaultOp = ops.find(o => o.id === wanted) ?? ops[0];
        setCurrentOperation(defaultOp);
        await loadOperationBundle(defaultOp.id);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setInitialLoading(false);
    }
  }, [loadOperationBundle]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Handlers for core loop actions
  const handleSelectOperation = async (op: OperationProfile) => {
    setCurrentOperation(op);
    await loadOperationBundle(op.id);
  };

  const handleResetDemo = async () => {
    try {
      setIsProcessing(true);
      const res = await api.resetDemo();
      await loadInitialData();
    } catch (err) {
      console.error('Failed to reset demo:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddSeed = async (
    seedData: { type: any; value: string; label?: string; notes?: string },
    autoExpand: boolean
  ) => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      const newSeed = await api.addSeed(currentOperation.id, seedData);
      if (autoExpand) {
        await api.expandOperation(currentOperation.id, newSeed.id);
      }
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to add seed:', err);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExpandAll = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.expandOperation(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to expand pivots:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEvaluateHypotheses = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.evaluateHypotheses(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to evaluate hypotheses:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateHypothesis = async (data: {
    title: string;
    description: string;
    category?: string;
  }) => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.createHypothesis(currentOperation.id, data);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to create hypothesis:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleGenerateLeads = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.generateLeads(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to generate leads:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteLead = async (leadId: string) => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.executeLead(currentOperation.id, leadId);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to execute lead:', err);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInvalidateEvidence = async (evidenceId: string, reason: string) => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.invalidateEvidence(currentOperation.id, evidenceId, reason);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to invalidate evidence:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddEvidence = async (evidenceData: any) => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.addEvidence(currentOperation.id, evidenceData);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to import evidence:', err);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRunAiAnalysis = async (focusArea?: string) => {
    if (!currentOperation) throw new Error('No active operation');
    return await api.runAiAnalysis(currentOperation.id, focusArea);
  };

  const handleCheckCandidate = async (candidate: any) => {
    if (!currentOperation) throw new Error('No active operation');
    const result = await api.checkReappearance(currentOperation.id, candidate);
    await loadOperationBundle(currentOperation.id);
    return result;
  };

  const handleRunMonitoringSweep = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.runMonitoringScan(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to run monitoring scan:', err);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  // --- V0.2 Autonomous Pursuit Handlers ---
  const handleStartPursuit = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.startPursuit(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to start pursuit:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePausePursuit = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.pausePursuit(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to pause pursuit:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleResumePursuit = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.resumePursuit(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to resume pursuit:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStopPursuit = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.stopPursuit(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to stop pursuit:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStepPursuit = async () => {
    if (!currentOperation) return;
    try {
      setIsProcessing(true);
      await api.stepPursuit(currentOperation.id);
      await loadOperationBundle(currentOperation.id);
    } catch (err) {
      console.error('Failed to step pursuit:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInspectLineage = (type: 'relationship' | 'entity' | 'conclusion', data: any) => {
    setLineageTarget({ type, data });
  };

  if (initialLoading || !currentOperation || !bundle) {
    return (
      <div className="w-screen h-screen bg-[#080b11] flex items-center justify-center text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
            Initializing Operation Hunter Core Engine...
          </span>
        </div>
      </div>
    );
  }

  const pendingLeadsCount = bundle.leads.filter(l => l.status === 'PENDING').length;
  const reappearanceAlertsCount = bundle.reappearanceLeads.filter(r => r.status === 'CONFIRMED_ROTATION' || r.status === 'OPEN').length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#080b11] text-slate-200">
      {/* Sidebar matching canonical screenshot */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        evidenceCount={bundle.evidence.filter(e => e.status === 'valid').length}
        leadsPendingCount={pendingLeadsCount}
        hypothesesCount={bundle.hypotheses.length}
        reappearanceCount={reappearanceAlertsCount}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Top Status Bar matching screenshot */}
        <TopBar
          currentOperation={currentOperation}
          operations={operations}
          onSelectOperation={handleSelectOperation}
          onOpenSeedModal={() => setSeedModalOpen(true)}
          onResetDemo={handleResetDemo}
          isProcessing={isProcessing}
        />

        {/* View Content */}
        <main className="flex-1 overflow-y-auto p-6 bg-[#080b11]">
          {activeTab === 'inbox' && (
            <InboxView
              operations={operations}
              currentOperation={currentOperation}
              onSelectOperation={handleSelectOperation}
              seeds={bundle.seeds}
              reappearanceLeads={bundle.reappearanceLeads}
              pendingLeads={bundle.leads.filter(l => l.status === 'PENDING')}
              onOpenSeedModal={() => setSeedModalOpen(true)}
              onNavigateToTab={setActiveTab}
              onResetDemo={handleResetDemo}
              isProcessing={isProcessing}
            />
          )}

          {activeTab === 'overview' && (
            <OverviewView
              operation={currentOperation}
              briefing={bundle.briefing}
              pursuit={bundle.pursuit}
              clusters={bundle.clusters}
              bridges={bundle.bridges}
              scamKitGenomes={bundle.scamKitGenomes}
              financialAnalysis={bundle.financialAnalysis}
              crossOpSimilarities={bundle.crossOpSimilarities}
              contradictionReports={bundle.contradictionReports}
              leads={bundle.leads}
              entities={bundle.entities}
              relationships={bundle.relationships}
              evidenceList={bundle.evidence}
              hypotheses={bundle.hypotheses}
              reappearanceLeads={bundle.reappearanceLeads}
              onOpenSeedModal={() => setSeedModalOpen(true)}
              onExpandAll={handleExpandAll}
              onEvaluateHypotheses={handleEvaluateHypotheses}
              onGenerateLeads={handleGenerateLeads}
              onExecuteLead={handleExecuteLead}
              onStartPursuit={handleStartPursuit}
              onPausePursuit={handlePausePursuit}
              onResumePursuit={handleResumePursuit}
              onStopPursuit={handleStopPursuit}
              onStepPursuit={handleStepPursuit}
              onSelectLeadForInvestigation={lead => {
                setActiveTab('leads');
              }}
              onInspectLineage={handleInspectLineage}
              isProcessing={isProcessing}
            />
          )}

          {activeTab === 'graph' && (
            <GraphView
              entities={bundle.entities}
              relationships={bundle.relationships}
              evidenceList={bundle.evidence}
              hypotheses={bundle.hypotheses}
              onInspectLineage={handleInspectLineage}
            />
          )}

          {activeTab === 'timeline' && (
            <TimelineView
              operation={currentOperation}
              entities={bundle.entities}
              relationships={bundle.relationships}
              evidenceList={bundle.evidence}
              temporalSnapshots={bundle.temporalSnapshots}
              financialAnalysis={bundle.financialAnalysis}
              onInspectLineage={handleInspectLineage}
            />
          )}

          {activeTab === 'evidence' && (
            <EvidenceView
              evidenceList={bundle.evidence}
              onOpenImportModal={() => setEvidenceModalOpen(true)}
              onInvalidateEvidence={handleInvalidateEvidence}
            />
          )}

          {activeTab === 'hypotheses' && (
            <HypothesesView
              hypotheses={bundle.hypotheses}
              onEvaluateHypotheses={handleEvaluateHypotheses}
              onCreateHypothesis={handleCreateHypothesis}
              onRunAiAnalysis={handleRunAiAnalysis}
              isProcessing={isProcessing}
            />
          )}

          {activeTab === 'leads' && (
            <LeadsView
              leads={bundle.leads}
              operationId={currentOperation.id}
              onGenerateLeads={handleGenerateLeads}
              onExecuteLead={handleExecuteLead}
              isProcessing={isProcessing}
            />
          )}

          {activeTab === 'monitoring' && (
            <MonitoringView
              fingerprints={bundle.fingerprints}
              reappearanceLeads={bundle.reappearanceLeads}
              monitoringProbes={bundle.monitoringProbes}
              onCheckCandidate={handleCheckCandidate}
              onRunSweep={handleRunMonitoringSweep}
              isProcessing={isProcessing}
            />
          )}
        </main>
      </div>

      {/* Modals & Drawers */}
      <LineageModal
        operationId={currentOperation?.id}
        selectedItem={lineageTarget}
        onClose={() => setLineageTarget(null)}
        relationships={bundle.relationships}
        entities={bundle.entities}
        evidenceList={bundle.evidence}
        hypotheses={bundle.hypotheses}
        onInvalidateEvidence={handleInvalidateEvidence}
      />

      <SeedModal
        isOpen={seedModalOpen}
        onClose={() => setSeedModalOpen(false)}
        onSubmit={handleAddSeed}
      />

      <EvidenceImportModal
        isOpen={evidenceModalOpen}
        onClose={() => setEvidenceModalOpen(false)}
        onSubmit={handleAddEvidence}
      />
    </div>
  );
}
