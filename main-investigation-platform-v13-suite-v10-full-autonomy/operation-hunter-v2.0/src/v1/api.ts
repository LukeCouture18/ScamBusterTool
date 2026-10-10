/* Operation Hunter v2.0 API client. */
export interface Finding {
  id: string; key: string; kind: string; title: string; whatFound: string; whyItMatters: string; whatItMeans: string; uncertainty: string; doesNotProve: string;
  nextStep: string; action?: { type: string; label: string; params?: Record<string, any> }; confidence: number; importance: number; evidenceIds: string[]; entityIds: string[];
  status: 'new' | 'seen' | 'dismissed' | 'acted'; firstSeenAt: string; updatedAt: string; isNewSinceLastView?: boolean; view?: string;
}
export interface Brief {
  headline: string; narrative: string; top: Finding[]; depth: { score: number; dimensions: Array<{ key: string; label: string; score: number; detail: string }> };
  confidence: { percentage: number; assessment: string }; changesSinceLastView: { count: number; items: Array<{ id: string; at: string; kind: string; summary: string }>; since: string | null };
  nextStep: string; counts: Record<string, number>;
}
export interface Run { id: string; status: string; budgetUsed: number; config: any; stats: any; stopReason?: string | null; startedAt: string; updatedAt: string; finishedAt?: string | null }
export interface OperationSummary {
  id: string; code: string; name: string; status: string; isDemo: boolean; initialSeed: string; targetType: string; headline: string; depth: number; confidence: number;
  counts: Record<string, number>; newFindings: number; alerts: number; pursuit: null | { status: string; budgetUsed: number; budgetTotal: number; pivots: number; stopReason?: string | null };
  mainInvestigationId: string | null; updatedAt: string; lastViewedAt: string | null; topFinding: null | { title: string; kind: string };
}
export interface BriefPayload {
  operation: any; brief: Brief; pursuit: Run | null; recentPivots: Array<{ id: string; at: string; pivotType: string; label: string; target: string; text: string; status: string; branch: string }>;
  counts: Record<string, number>; integration: null | { connected: boolean; configured: boolean; investigationId: string | null; investigationUrl: string | null; mainOperationUrl: string | null };
  analyzedAt: string; revision: number;
  intel?: BriefIntel | null;
  leads?: NextLead[];
}
export interface BriefIntel {
  status: string; statusReason: string; counts: Record<string, number>;
  forecast: { status: string; nextExpectedAt: string | null; confidence: number; basis: string };
  explanations: Array<{ key: string; question: string; leading: string; margin: number; runnerUp: string | null; test: string }>;
  unknowns: string[]; contradictions: { open: number; top: string[] }; hunts: { active: number; nextRunAt: string | null; summary: string };
  modelVersion: number | null; lastChange: string | null;
}
export interface NextLead {
  key: string; title: string; question: string; why: string[]; expected: number; score: number; pivotType: string; label: string; entityId: string;
  targetValue: string; targetType: string; branchKind: string; cost: string; doesNotProve: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* text body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  return data as T;
}

export const api = {
  operations: () => req<OperationSummary[]>('GET', '/api/v1/operations'),
  createOperation: (body: { name?: string; initialSeed: string; additionalSeeds?: string[]; startPursuit?: boolean; config?: any }) => req<OperationSummary>('POST', '/api/v1/operations', body),
  updateOperation: (id: string, body: any) => req('PATCH', `/api/v1/operations/${id}`, body),
  deleteOperation: (id: string) => req('DELETE', `/api/v1/operations/${id}`),
  resetDemo: () => req('POST', '/api/operations/reset-demo'),
  brief: (id: string) => req<BriefPayload>('GET', `/api/v1/operations/${id}/brief`),
  analysis: (id: string) => req<any>('GET', `/api/v1/operations/${id}/analysis`),
  graph: (id: string) => req<any>('GET', `/api/v1/operations/${id}/graph`),
  entity: (id: string, entityId: string) => req<any>('GET', `/api/v1/operations/${id}/entities/${entityId}`),
  evidence: (id: string, q = '', status = '') => req<{ total: number; items: any[] }>('GET', `/api/v1/operations/${id}/evidence?limit=500&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  pivots: (id: string) => req<any[]>('GET', `/api/v1/operations/${id}/pivots?limit=400`),
  leads: (id: string) => req<any[]>('GET', `/api/v1/operations/${id}/leads`),
  runs: (id: string) => req<Run[]>('GET', `/api/v1/operations/${id}/runs`),
  changes: (id: string) => req<any[]>('GET', `/api/v1/operations/${id}/changes?limit=150`),
  viewed: (id: string) => req('POST', `/api/v1/operations/${id}/viewed`),
  runPivot: (id: string, body: { pivotType: string; entityId?: string; value?: string; refresh?: boolean }) => req('POST', `/api/v1/operations/${id}/pivots`, body),
  executeLead: (id: string, leadId: string) => req('POST', `/api/operations/${id}/leads/${leadId}/execute`),
  startPursuit: (id: string, config?: any) => req('POST', `/api/operations/${id}/pursuit/start`, { config: config ?? {} }),
  pausePursuit: (id: string) => req('POST', `/api/operations/${id}/pursuit/pause`),
  stopPursuit: (id: string) => req('POST', `/api/operations/${id}/pursuit/stop`),
  stepPursuit: (id: string) => req('POST', `/api/operations/${id}/pursuit/step`),
  addSeed: (id: string, value: string, label?: string) => req('POST', `/api/operations/${id}/seeds`, { value, label, type: 'auto' }),
  addEvidence: (id: string, body: any) => req('POST', `/api/operations/${id}/evidence`, body),
  invalidate: (id: string, evidenceId: string, reason: string) => req('POST', `/api/operations/${id}/evidence/${evidenceId}/invalidate`, { reason }),
  reinstate: (id: string, evidenceId: string) => req('POST', `/api/v1/operations/${id}/evidence/${evidenceId}/reinstate`),
  setFinding: (findingId: string, status: string) => req('POST', `/api/v1/findings/${findingId}`, { status }),
  actOnFinding: (id: string, findingId: string) => req<any>('POST', `/api/v1/operations/${id}/findings/${findingId}/act`),
  setHypothesis: (id: string, hid: string, body: any) => req('PATCH', `/api/v1/operations/${id}/hypotheses/${hid}`, body),
  addHypothesis: (id: string, body: any) => req('POST', `/api/operations/${id}/hypotheses`, body),
  monitors: (id: string) => req<any[]>('GET', `/api/monitoring?operationId=${id}`),
  runMonitors: (id: string) => req<any>('POST', '/api/monitoring/run', { operationId: id }),
  updateMonitor: (monitorId: string, body: any) => req('PATCH', `/api/monitoring/${monitorId}`, body),
  addMonitor: (body: any) => req('POST', '/api/monitoring', body),
  checkReappearance: (id: string, body: any) => req<any>('POST', `/api/operations/${id}/reappearance/check`, body),
  ai: (id: string) => req<any>('POST', `/api/operations/${id}/ai/analyze`, {}),
  settings: () => req<any>('GET', '/api/v1/settings'),
  saveSettings: (body: any) => req('PATCH', '/api/v1/settings', body),
  collectors: () => req<any[]>('GET', '/api/v1/collectors'),
  strategy: () => req<any[]>('GET', '/api/v1/strategy'),
  integrationStatus: () => req<any>('GET', '/api/v1/integration/status'),
  testIntegration: () => req<any>('POST', '/api/v1/integration/test'),
  syncNow: () => req<any>('POST', '/api/v1/integration/sync'),
  linkInvestigation: (id: string, investigationId: string) => req('POST', `/api/v1/operations/${id}/main/link`, { investigationId }),
  sendToInbox: (id: string, value: string, reason: string) => req('POST', `/api/v1/operations/${id}/main/send-inbox`, { value, reason }),
  backup: () => req<any>('POST', '/api/v1/backup'),
  detect: (value: string) => req<{ type: string | null }>('POST', '/api/v1/detect', { value }),
  glossary: () => req<Record<string, string>>('GET', '/api/v1/glossary'),
  status: () => req<any>('GET', '/api/status'),
  reappearance: (id: string) => req<{ leads: any[]; fingerprints: any[] }>('GET', `/api/v1/operations/${id}/reappearance`),
  setReappearance: (id: string, leadId: string, status: string) => req('PATCH', `/api/v1/operations/${id}/reappearance/${leadId}`, { status }),
  labels: () => req<any[]>('GET', '/api/v1/labels'),
  addLabel: (body: any) => req('POST', '/api/v1/labels', body),
  // v2.0 intelligence layer
  model: (id: string) => req<any>('GET', `/api/v1/operations/${id}/model`),
  modelVersion: (id: string, v: number) => req<any>('GET', `/api/v1/operations/${id}/model/versions/${v}`),
  membership: (id: string, type?: string) => req<any>('GET', `/api/v1/operations/${id}/membership${type ? `?type=${type}` : ''}`),
  setVerdict: (id: string, entityId: string, verdict: 'member' | 'not_member' | null, reason?: string) => req<any>('POST', `/api/v1/operations/${id}/membership/${entityId}`, { verdict, reason: reason ?? null }),
  facets: (id: string, entityId?: string) => req<any>('GET', `/api/v1/operations/${id}/facets${entityId ? `?entityId=${entityId}` : ''}`),
  branches: (id: string) => req<any>('GET', `/api/v1/operations/${id}/branches`),
  next: (id: string, limit = 5) => req<NextLead[]>('GET', `/api/v1/operations/${id}/next?limit=${limit}`),
  hunts: (id: string) => req<any[]>('GET', `/api/v1/operations/${id}/hunts`),
  runHunts: (id: string) => req<any[]>('POST', `/api/v1/operations/${id}/hunts/run`),
  setHunt: (huntId: string, body: any) => req('PATCH', `/api/v1/hunts/${huntId}`, body),
  contradictions: (id: string) => req<any[]>('GET', `/api/v1/operations/${id}/contradictions`),
  setContradiction: (id: string, cid: string, status: string, resolution?: string) => req('PATCH', `/api/v1/operations/${id}/contradictions/${cid}`, { status, resolution }),
  learner: () => req<any>('GET', '/api/v1/learner'),
  governor: () => req<any>('GET', '/api/v1/governor'),
};
