import {
  OperationProfile,
  OperationBundle,
  Seed,
  Evidence,
  Hypothesis,
  Lead,
  ReappearanceLead,
  MonitoringProbe,
  AIAnalysisResult
} from './types';

const BASE = '/api';

export const api = {
  async getStatus() {
    const res = await fetch(`${BASE}/status`);
    if (!res.ok) throw new Error('Failed to fetch system status');
    return res.json();
  },

  async getOperations(): Promise<OperationProfile[]> {
    const res = await fetch(`${BASE}/operations`);
    if (!res.ok) throw new Error('Failed to fetch operations');
    return res.json();
  },

  async getOperation(id: string): Promise<OperationBundle> {
    const res = await fetch(`${BASE}/operations/${id}`);
    if (!res.ok) throw new Error('Failed to fetch operation bundle');
    return res.json();
  },

  async createOperation(data: { name: string; targetType: string; initialSeed: string; summary?: string }): Promise<OperationProfile> {
    const res = await fetch(`${BASE}/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to create operation');
    return res.json();
  },

  async resetDemo(): Promise<{ success: boolean; operation: OperationProfile }> {
    const res = await fetch(`${BASE}/operations/reset-demo`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to reset demo');
    return res.json();
  },

  async addSeed(operationId: string, seed: { type: string; value: string; label?: string; notes?: string }): Promise<Seed> {
    const res = await fetch(`${BASE}/operations/${operationId}/seeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seed)
    });
    if (!res.ok) throw new Error('Failed to add seed');
    return res.json();
  },

  async expandOperation(operationId: string, seedId?: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seedId })
    });
    if (!res.ok) throw new Error('Failed to expand operation');
    return res.json();
  },

  async reconstructOperation(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/reconstruct`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to reconstruct operation');
    return res.json();
  },

  async evaluateHypotheses(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/hypothesize`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to evaluate hypotheses');
    return res.json();
  },

  async createHypothesis(operationId: string, data: { title: string; description: string; category?: string; competingHypothesisIds?: string[] }): Promise<Hypothesis> {
    const res = await fetch(`${BASE}/operations/${operationId}/hypotheses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to create hypothesis');
    return res.json();
  },

  async generateLeads(operationId: string): Promise<{ success: boolean; leads: Lead[] }> {
    const res = await fetch(`${BASE}/operations/${operationId}/leads/generate`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to generate leads');
    return res.json();
  },

  async executeLead(operationId: string, leadId: string): Promise<{ success: boolean; message: string; leadId: string }> {
    const res = await fetch(`${BASE}/operations/${operationId}/leads/${leadId}/execute`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to execute lead' }));
      throw new Error(err.error || 'Failed to execute lead');
    }
    return res.json();
  },

  async invalidateEvidence(operationId: string, evidenceId: string, reason: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/evidence/${evidenceId}/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (!res.ok) throw new Error('Failed to invalidate evidence');
    return res.json();
  },

  async addEvidence(operationId: string, evidence: {
    source: string;
    type: string;
    originalObservation: string;
    rawData?: any;
    provenance?: string;
    confidence?: number;
    relatedEntityIds?: string[];
  }): Promise<Evidence> {
    const res = await fetch(`${BASE}/operations/${operationId}/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evidence)
    });
    if (!res.ok) throw new Error('Failed to add evidence');
    return res.json();
  },

  async runAiAnalysis(operationId: string, focusArea?: string): Promise<AIAnalysisResult> {
    const res = await fetch(`${BASE}/operations/${operationId}/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focusArea })
    });
    if (!res.ok) throw new Error('Failed to run AI analysis');
    return res.json();
  },

  async checkReappearance(operationId: string, candidate: {
    candidateValue: string;
    candidateType: string;
    features?: {
      domHash?: string;
      gaTag?: string;
      nameservers?: string[];
      destinationWallet?: string;
    };
  }): Promise<ReappearanceLead> {
    const res = await fetch(`${BASE}/operations/${operationId}/reappearance/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidate)
    });
    if (!res.ok) throw new Error('Failed to check candidate reappearance');
    return res.json();
  },

  async getMonitoring(operationId?: string): Promise<MonitoringProbe[]> {
    const query = operationId ? `?operationId=${operationId}` : '';
    const res = await fetch(`${BASE}/monitoring${query}`);
    if (!res.ok) throw new Error('Failed to fetch monitoring probes');
    return res.json();
  },

  async createProbe(probe: { operationId: string; targetType: string; targetValue: string; frequencyMinutes?: number; notes?: string }): Promise<MonitoringProbe> {
    const res = await fetch(`${BASE}/monitoring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(probe)
    });
    if (!res.ok) throw new Error('Failed to create probe');
    return res.json();
  },

  async runMonitoringScan(operationId?: string): Promise<{ success: boolean; message: string; detectedLead: ReappearanceLead }> {
    const res = await fetch(`${BASE}/monitoring/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId })
    });
    if (!res.ok) throw new Error('Failed to run monitoring scan');
    return res.json();
  },

  // --- V0.2 Autonomous Pursuit & Briefing API ---
  async getPursuit(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit`);
    if (!res.ok) throw new Error('Failed to fetch pursuit state');
    return res.json();
  },

  async startPursuit(operationId: string, config?: any) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    });
    if (!res.ok) throw new Error('Failed to start autonomous pursuit');
    return res.json();
  },

  async pausePursuit(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit/pause`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to pause pursuit');
    return res.json();
  },

  async resumePursuit(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit/resume`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to resume pursuit');
    return res.json();
  },

  async stopPursuit(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to stop pursuit');
    return res.json();
  },

  async stepPursuit(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/pursuit/step`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to execute pursuit step');
    return res.json();
  },

  async getBriefing(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/briefing`);
    if (!res.ok) throw new Error('Failed to fetch investigator briefing');
    return res.json();
  },

  async getClusters(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/clusters`);
    if (!res.ok) throw new Error('Failed to fetch clusters');
    return res.json();
  },

  async getStrategyStats() {
    const res = await fetch(`${BASE}/strategy-stats`);
    if (!res.ok) throw new Error('Failed to fetch strategy stats');
    return res.json();
  },

  async getGenomes(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/genome`);
    if (!res.ok) throw new Error('Failed to fetch scam-kit genomes');
    return res.json();
  },

  async analyzeGenome(operationId: string, targetUrl?: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/genome/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl })
    });
    if (!res.ok) throw new Error('Failed to analyze scam-kit genome');
    return res.json();
  },

  async getFinancial(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/financial`);
    if (!res.ok) throw new Error('Failed to fetch financial ledger analysis');
    return res.json();
  },

  async getCrossOp(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/cross-op`);
    if (!res.ok) throw new Error('Failed to fetch cross-operation similarities');
    return res.json();
  },

  async getContradictions(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/contradictions`);
    if (!res.ok) throw new Error('Failed to fetch contradiction reports');
    return res.json();
  },

  async getTemporalReconstruction(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/temporal`);
    if (!res.ok) throw new Error('Failed to fetch temporal reconstruction');
    return res.json();
  },

  async getStateAtTimeT(operationId: string, stepIndex: number) {
    const res = await fetch(`${BASE}/operations/${operationId}/temporal/at-step/${stepIndex}`);
    if (!res.ok) throw new Error('Failed to fetch state at time T');
    return res.json();
  },

  async getOperationGenomes(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/genomes`);
    if (!res.ok) throw new Error('Failed to fetch operation genomes');
    return res.json();
  },

  async getTraceabilityChain(operationId: string, itemType: string = 'hypothesis', itemId: string = 'root') {
    const res = await fetch(`${BASE}/operations/${operationId}/traceability?itemType=${encodeURIComponent(itemType)}&itemId=${encodeURIComponent(itemId)}`);
    if (!res.ok) throw new Error('Failed to fetch reasoning traceability chain');
    return res.json();
  },

  async getPredictiveRankings(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/predictive-leads`);
    if (!res.ok) throw new Error('Failed to fetch predictive lead rankings');
    return res.json();
  },

  async getLearningOutcomes(operationId: string) {
    const res = await fetch(`${BASE}/operations/${operationId}/learning-outcomes`);
    if (!res.ok) throw new Error('Failed to fetch strategy learning outcomes');
    return res.json();
  }
};
