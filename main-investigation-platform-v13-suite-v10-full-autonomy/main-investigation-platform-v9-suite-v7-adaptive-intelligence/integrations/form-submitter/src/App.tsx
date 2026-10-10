import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { QueueView } from './components/QueueView';
import { NewFindingInput } from './components/NewFindingInput';
import { FormMappingView } from './components/FormMappingView';
import { PlatformHub } from './components/PlatformHub';
import { AuditHistoryView } from './components/AuditHistoryView';
import { AutomatedTestsView } from './components/AutomatedTestsView';
import { SubmissionModal } from './components/SubmissionModal';
import { FindingDetailModal } from './components/FindingDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { FormSetupWizardModal } from './components/FormSetupWizardModal';
import { ZipExportModal } from './components/ZipExportModal';
import {
  InvestigationFinding,
  UserSettings,
  FormMappingConfig,
  HistoryRecord,
} from './types';
import {
  loadSettings,
  saveSettings,
  loadFormConfig,
  saveFormConfig,
  loadQueue,
  saveQueue,
  loadHistory,
  appendHistory,
  syncWithDurableServer,
} from './utils/storage';
import { evaluateFinding } from './utils/walletValidation';

export const App: React.FC = () => {
  // Application State
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [formConfig, setFormConfig] = useState<FormMappingConfig>(loadFormConfig);
  const [queue, setQueue] = useState<InvestigationFinding[]>(loadQueue);
  const [history, setHistory] = useState<HistoryRecord[]>(loadHistory);

  // Navigation & Modals
  const [activeTab, setActiveTab] = useState<'queue' | 'new' | 'form-mapping' | 'platform' | 'history' | 'tests'>('queue');
  const [selectedFinding, setSelectedFinding] = useState<InvestigationFinding | null>(null);
  const [submittingFinding, setSubmittingFinding] = useState<InvestigationFinding | null>(null);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showFirstRunSetup, setShowFirstRunSetup] = useState<boolean>(!loadSettings().isConfigured);
  const [showFormWizard, setShowFormWizard] = useState<boolean>(false);
  const [showZipModal, setShowZipModal] = useState<boolean>(false);

  // Startup: Sync with Durable Server Database (recovers any interrupted sessions)
  useEffect(() => {
    syncWithDurableServer().then((res) => {
      if (res.findings && res.findings.length > 0) {
        setQueue(res.findings);
      }
      if (res.settings) {
        setSettings(res.settings);
      }
      if (res.formConfig) {
        setFormConfig(res.formConfig);
      }
      if (res.history && res.history.length > 0) {
        setHistory(res.history);
      }
    });
  }, []);

  // Sync state to storage whenever it changes
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveFormConfig(formConfig);
  }, [formConfig]);

  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  // Handler: Add new finding
  const handleAddFinding = (finding: InvestigationFinding) => {
    const updatedQueue = [finding, ...queue];
    setQueue(updatedQueue);
    setActiveTab('queue');
  };

  // Handler: Update finding
  const handleUpdateFinding = (updated: InvestigationFinding) => {
    const updatedQueue = queue.map((item) => (item.id === updated.id ? updated : item));
    setQueue(updatedQueue);
    if (selectedFinding?.id === updated.id) {
      setSelectedFinding(updated);
    }
  };

  // Handler: Partial update finding state (e.g. during batch auto-submit)
  const handleUpdateFindingState = (id: string, updates: Partial<InvestigationFinding>) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
    );
  };

  // Handler: Delete finding
  const handleDeleteFinding = (id: string) => {
    setQueue(queue.filter((f) => f.id !== id));
    if (selectedFinding?.id === id) setSelectedFinding(null);
    if (submittingFinding?.id === id) setSubmittingFinding(null);
  };

  // Handler: Revalidate all findings
  const handleValidateAll = () => {
    const revalidated = queue.map((item) => {
      const evalResult = evaluateFinding(item, queue);
      return {
        ...item,
        overallStatus: evalResult.overallStatus,
        wallets: evalResult.updatedWallets,
        validationDiagnostics: evalResult.diagnostics,
        updatedAt: new Date().toISOString(),
      };
    });
    setQueue(revalidated);
  };

  // Handler: Clear completed findings
  const handleClearCompleted = () => {
    setQueue(queue.filter((f) => f.queueStatus !== 'COMPLETED'));
  };

  // Handler: Export queue as JSON
  const handleExportQueue = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(queue, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `crypto_scam_queue_${Date.now()}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Handler: Import queue from JSON
  const handleImportQueue = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed)) {
          const merged = [...parsed, ...queue];
          setQueue(merged);
        }
      } catch {
        alert('Invalid JSON file format.');
      }
    };
    reader.readAsText(file);
  };

  // Handler: Confirm submission recorded
  const handleConfirmSubmitted = async (record: HistoryRecord) => {
    appendHistory(record);
    setHistory(loadHistory());

    // Mark finding as COMPLETED in queue
    const updatedQueue = queue.map((f) => {
      if (f.id === record.findingId) {
        return {
          ...f,
          queueStatus: 'COMPLETED' as const,
          submissionState: 'COMPLETED' as const,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return f;
    });
    setQueue(updatedQueue);

    // Notify backend status endpoint for Main Platform synchronization
    try {
      await fetch(`/api/platform/findings/${record.findingId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
        }),
      });
    } catch {
      // Non-blocking sync error
    }

    setSubmittingFinding(null);
  };

  // Handler: Intake candidate finding from Main Platform
  const handleImportCandidateFromPlatform = (candidate: InvestigationFinding) => {
    const evalResult = evaluateFinding(candidate, queue);
    const newFinding: InvestigationFinding = {
      ...candidate,
      id: candidate.id || `FIND-${Date.now().toString().slice(-6)}`,
      overallStatus: evalResult.overallStatus,
      queueStatus:
        evalResult.overallStatus === 'READY'
          ? 'READY'
          : evalResult.overallStatus === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : 'PENDING',
      wallets: evalResult.updatedWallets,
      validationDiagnostics: evalResult.diagnostics,
      submissionMode: settings.defaultSubmissionMode,
      submissionState: 'NOT_STARTED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setQueue((prev) => [newFinding, ...prev]);
    setActiveTab('queue');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-amber-500/30 selection:text-amber-200">
      {/* Navigation Header */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        settings={settings}
        openSettings={() => setShowSettings(true)}
        openFormWizard={() => setShowFormWizard(true)}
        openZipModal={() => setShowZipModal(true)}
        queue={queue}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {activeTab === 'queue' && (
          <QueueView
            queue={queue}
            formConfig={formConfig}
            settings={settings}
            history={history}
            onSelectFinding={(item) => setSelectedFinding(item)}
            onDeleteFinding={handleDeleteFinding}
            onValidateAll={handleValidateAll}
            onClearCompleted={handleClearCompleted}
            onExportQueue={handleExportQueue}
            onImportQueue={handleImportQueue}
            onPrepareSubmission={(item) => setSubmittingFinding(item)}
            onAddNew={() => setActiveTab('new')}
            onFindingCompleted={handleConfirmSubmitted}
            onUpdateFindingState={handleUpdateFindingState}
          />
        )}

        {activeTab === 'new' && (
          <NewFindingInput
            settings={settings}
            existingQueue={queue}
            onAddFinding={handleAddFinding}
            onCancel={() => setActiveTab('queue')}
          />
        )}

        {activeTab === 'form-mapping' && (
          <FormMappingView
            formConfig={formConfig}
            onSaveConfig={(cfg) => setFormConfig(cfg)}
            onOpenWizard={() => setShowFormWizard(true)}
            sampleFinding={queue[0]}
          />
        )}

        {activeTab === 'platform' && (
          <PlatformHub onImportCandidate={handleImportCandidateFromPlatform} />
        )}

        {activeTab === 'history' && (
          <AuditHistoryView
            history={history}
            onClearHistory={() => {
              localStorage.removeItem('crypto_scam_submitter_history_v1');
              setHistory([]);
            }}
          />
        )}

        {activeTab === 'tests' && <AutomatedTestsView />}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Crypto Scam Report Form Submitter v1.1 • Defensive Investigation Egress Node</span>
          <span>Defensive Workflow: Site Finder → Investigator → WalletLogger → Main Platform → Form Submitter</span>
        </div>
      </footer>

      {/* Pre-Submission Inspector Modal */}
      {submittingFinding && (
        <SubmissionModal
          finding={submittingFinding}
          formConfig={formConfig}
          settings={settings}
          existingQueue={queue}
          history={history}
          onClose={() => setSubmittingFinding(null)}
          onConfirmSubmitted={handleConfirmSubmitted}
          onEditFinding={(f) => {
            setSubmittingFinding(null);
            setSelectedFinding(f);
          }}
        />
      )}

      {/* Finding Detail Inspection Modal */}
      {selectedFinding && (
        <FindingDetailModal
          finding={selectedFinding}
          onClose={() => setSelectedFinding(null)}
          onPrepareSubmission={(f) => {
            setSelectedFinding(null);
            setSubmittingFinding(f);
          }}
          onUpdateFinding={handleUpdateFinding}
        />
      )}

      {/* Investigator Settings Modal */}
      {(showSettings || showFirstRunSetup) && (
        <SettingsModal
          settings={settings}
          isFirstLaunch={showFirstRunSetup}
          onSave={(updated) => {
            setSettings(updated);
            setShowFirstRunSetup(false);
          }}
          onClose={() => {
            setShowSettings(false);
            setShowFirstRunSetup(false);
          }}
          openZipModal={() => setShowZipModal(true)}
        />
      )}

      {/* Form Setup Wizard Modal */}
      {showFormWizard && (
        <FormSetupWizardModal
          currentConfig={formConfig}
          onSaveConfig={(newConfig) => {
            setFormConfig(newConfig);
          }}
          onClose={() => setShowFormWizard(false)}
        />
      )}

      {/* Codebase ZIP Export Multi-Method Modal */}
      <ZipExportModal
        isOpen={showZipModal}
        onClose={() => setShowZipModal(false)}
      />
    </div>
  );
};

export default App;
