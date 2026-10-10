export const JOB_STATUSES: string[];
export const JOB_TYPES: string[];
export const EVIDENCE_CLASSES: string[];
export function normalizeCanonicalKey(type: string, record: Record<string, unknown>): string;
export function observationKey(module: string, type: string, externalId: string): string;
export function jobDedupeKey(jobType: string, investigationId: string | null | undefined, targetEntityId: string | null | undefined, targetModule: string): string;
export function retryDelaySeconds(attempt: number, base?: number, cap?: number): number;
export function canTransitionJob(from: string, to: string): boolean;
export function schemaCompatibility(version: string | null | undefined): { compatible: boolean; supported: string };
