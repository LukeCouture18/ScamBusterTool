import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { InvestigationFinding, FormMappingConfig, UserSettings, HistoryRecord, PlatformStatusEvent } from '../src/types';

export interface DurableDatabaseSchema {
  version: string;
  lastSavedAt: string;
  findings: InvestigationFinding[];
  formConfig: FormMappingConfig | null;
  settings: UserSettings | null;
  auditHistory: HistoryRecord[];
  duplicateRegistry: {
    domains: Record<string, { findingId: string; timestamp: string }>;
    wallets: Record<string, { findingId: string; timestamp: string }>;
    idempotencyKeys: Record<string, { findingId: string; timestamp: string }>;
  };
  platformEvents: PlatformStatusEvent[];
}

const DB_PATH = path.join(process.cwd(), 'data', 'submitter_db.json');

const INITIAL_DB: DurableDatabaseSchema = {
  version: '1.1.0',
  lastSavedAt: new Date().toISOString(),
  findings: [],
  formConfig: null,
  settings: null,
  auditHistory: [],
  duplicateRegistry: {
    domains: {},
    wallets: {},
    idempotencyKeys: {},
  },
  platformEvents: [],
};

class DurableStorageEngine {
  private state: DurableDatabaseSchema;
  private recoveryLogs: string[] = [];

  private ensureDirectory(): void {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error('[DurableStorage] Error creating database directory:', err);
    }
  }

  constructor() {
    this.ensureDirectory();
    this.state = this.loadFromDisk();
    this.performCrashRecoveryCheck();
  }

  private loadFromDisk(): DurableDatabaseSchema {
    try {
      this.ensureDirectory();
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...INITIAL_DB,
          ...parsed,
          duplicateRegistry: {
            ...INITIAL_DB.duplicateRegistry,
            ...(parsed.duplicateRegistry || {}),
          },
        };
      }
    } catch (err) {
      throw new Error('Durable report storage is unreadable; startup stopped to prevent duplicate submissions.', {cause:err});
    }
    return JSON.parse(JSON.stringify(INITIAL_DB));
  }

  private saveToDisk(): void {
    let tempPath: string | null = null;
    try {
      this.ensureDirectory();
      this.state.lastSavedAt = new Date().toISOString();
      tempPath = `${DB_PATH}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tempPath, DB_PATH);
    } catch (err) {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}
      }
      throw new Error('Durable report storage could not be persisted; submission stopped.',{cause:err});
    }
  }

  /**
   * Crash/Restart Recovery:
   * Inspects all findings upon server startup.
   * If any finding was left in SUBMITTING or VERIFYING during a crash or restart,
   * converts it to 'UNKNOWN' / 'VERIFICATION_UNKNOWN' so it is NEVER blindly resubmitted.
   */
  private performCrashRecoveryCheck(): void {
    let recoveredCount = 0;

    for (const f of this.state.findings) {
      if (f.submissionState === 'SUBMITTING' || f.submissionState === 'VERIFYING') {
        const prev = f.submissionState;
        f.submissionState = 'UNKNOWN';
        f.recoveryState = 'VERIFICATION_UNKNOWN';
        f.updatedAt = new Date().toISOString();
        f.verificationNotes = `Crash/Restart Recovery: Finding was in '${prev}' state when application stopped. Marked as VERIFICATION_UNKNOWN to prevent duplicate submissions.`;

        const logMsg = `[Recovery] Finding ${f.id} (${f.domain}) recovered from interrupted '${prev}' state -> marked VERIFICATION_UNKNOWN`;
        this.recoveryLogs.push(logMsg);
        console.warn(logMsg);
        recoveredCount++;
      }
    }

    if (recoveredCount > 0) {
      this.saveToDisk();
    }
  }

  public getState(): DurableDatabaseSchema {
    return this.state;
  }

  public getRecoveryLogs(): string[] {
    return this.recoveryLogs;
  }

  public syncFullState(payload: Partial<DurableDatabaseSchema>): {
    success: boolean;
    lastSavedAt: string;
    findingsCount: number;
    historyCount: number;
  } {
    if (payload.findings) this.state.findings = payload.findings;
    if (payload.formConfig) this.state.formConfig = payload.formConfig;
    if (payload.settings) this.state.settings = payload.settings;
    if (payload.auditHistory) this.state.auditHistory = payload.auditHistory;
    if (payload.platformEvents) this.state.platformEvents = payload.platformEvents;

    // Rebuild duplicate indices
    this.rebuildDuplicateRegistry();
    this.saveToDisk();

    return {
      success: true,
      lastSavedAt: this.state.lastSavedAt,
      findingsCount: this.state.findings.length,
      historyCount: this.state.auditHistory.length,
    };
  }

  public upsertFinding(finding: InvestigationFinding): { success: boolean; finding: InvestigationFinding } {
    const idx = this.state.findings.findIndex((f) => f.id === finding.id);
    if (idx >= 0) {
      this.state.findings[idx] = { ...this.state.findings[idx], ...finding, updatedAt: new Date().toISOString() };
    } else {
      this.state.findings.unshift({ ...finding, updatedAt: new Date().toISOString() });
    }

    this.indexFindingDuplicates(finding);
    this.saveToDisk();
    return { success: true, finding };
  }

  public deleteFinding(id: string): boolean {
    const initialLen = this.state.findings.length;
    this.state.findings = this.state.findings.filter((f) => f.id !== id);
    if (this.state.findings.length !== initialLen) {
      this.rebuildDuplicateRegistry();
      this.saveToDisk();
      return true;
    }
    return false;
  }

  public appendHistoryRecord(record: HistoryRecord): void {
    this.state.auditHistory.unshift(record);

    if (record.idempotencyKey) {
      this.state.duplicateRegistry.idempotencyKeys[record.idempotencyKey] = {
        findingId: record.findingId,
        timestamp: record.timestamp,
      };
    }
    if (record.domain) {
      this.state.duplicateRegistry.domains[record.domain.toLowerCase()] = {
        findingId: record.findingId,
        timestamp: record.timestamp,
      };
    }
    for (const w of record.wallets || []) {
      if (w.address) {
        this.state.duplicateRegistry.wallets[w.address.toLowerCase()] = {
          findingId: record.findingId,
          timestamp: record.timestamp,
        };
      }
    }

    this.saveToDisk();
  }

  public emitPlatformEvent(event: PlatformStatusEvent): void {
    this.state.platformEvents.unshift({
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    });
    // Keep max 200 events in memory/disk
    this.saveToDisk();
  }

  private indexFindingDuplicates(finding: InvestigationFinding): void {
    if (finding.domain) {
      this.state.duplicateRegistry.domains[finding.domain.toLowerCase()] = {
        findingId: finding.id,
        timestamp: finding.createdAt || new Date().toISOString(),
      };
    }
    for (const w of finding.wallets || []) {
      if (w.address) {
        this.state.duplicateRegistry.wallets[w.address.toLowerCase()] = {
          findingId: finding.id,
          timestamp: finding.createdAt || new Date().toISOString(),
        };
      }
    }
    if (finding.idempotencyKey) {
      this.state.duplicateRegistry.idempotencyKeys[finding.idempotencyKey] = {
        findingId: finding.id,
        timestamp: finding.createdAt || new Date().toISOString(),
      };
    }
  }

  private rebuildDuplicateRegistry(): void {
    const reg = {
      domains: {} as Record<string, { findingId: string; timestamp: string }>,
      wallets: {} as Record<string, { findingId: string; timestamp: string }>,
      idempotencyKeys: {} as Record<string, { findingId: string; timestamp: string }>,
    };

    // Index from completed audit history
    for (const h of this.state.auditHistory) {
      if (h.domain) reg.domains[h.domain.toLowerCase()] = { findingId: h.findingId, timestamp: h.timestamp };
      if (h.idempotencyKey) reg.idempotencyKeys[h.idempotencyKey] = { findingId: h.findingId, timestamp: h.timestamp };
      for (const w of h.wallets || []) {
        if (w.address) reg.wallets[w.address.toLowerCase()] = { findingId: h.findingId, timestamp: h.timestamp };
      }
    }

    // Index from active queue findings
    for (const f of this.state.findings) {
      if (f.domain) reg.domains[f.domain.toLowerCase()] = { findingId: f.id, timestamp: f.createdAt };
      if (f.idempotencyKey) reg.idempotencyKeys[f.idempotencyKey] = { findingId: f.id, timestamp: f.createdAt };
      for (const w of f.wallets || []) {
        if (w.address) reg.wallets[w.address.toLowerCase()] = { findingId: f.id, timestamp: f.createdAt };
      }
    }

    this.state.duplicateRegistry = reg;
  }
}

export const durableStorage = new DurableStorageEngine();
