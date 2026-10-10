import type { HunterApp } from '../app.js';
import { describeOperationForAi } from './compat.js';

export interface AIAnalysisResult {
  aiReasoning: string;
  proposedHypotheses: Array<{ title: string; description: string; category: string; confidence: number; challengePerspective: string }>;
  uncoveredBlindspots: string[];
  recommendedSafeNextStep: string;
  isAiGenerated: true;
  engineUsed: string;
}

/**
 * Optional LLM second opinion (Gemini, when GEMINI_API_KEY is set). The model
 * only sees Hunter's own summaries and is asked to challenge them; without a
 * key a deterministic reviewer produces the same structure from the analysis.
 */
export class AiAssistant {
  constructor(private app: HunterApp) {}

  private hasKey() {
    return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  }

  async analyze(operationId: string, focusArea?: string): Promise<AIAnalysisResult> {
    const a = this.app.analyzer.get(operationId);
    if (!a) throw new Error('Operation not found');
    if (this.hasKey()) {
      try {
        const mod: any = await import('@google/genai' as string);
        const client = new mod.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const prompt = `You review a cryptocurrency-scam infrastructure reconstruction produced by Operation Hunter v1.0.
Rules: never claim shared infrastructure, kit code or transactions prove common ownership; separate observed facts from inferences; suggest only passive, lawful next steps (no logging into sites, no transactions, no bypassing access controls).
Focus: ${focusArea || 'overall state'}.

${describeOperationForAi(this.app, a)}

Return strict JSON: {"aiReasoning": string, "proposedHypotheses": [{"title","description","category","confidence" (0-1),"challengePerspective"}], "uncoveredBlindspots": [string], "recommendedSafeNextStep": string}`;
        const response = await client.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json' } });
        const text = typeof response.text === 'function' ? response.text() : response.text;
        const parsed = JSON.parse(String(text ?? '{}'));
        return { aiReasoning: String(parsed.aiReasoning ?? ''), proposedHypotheses: Array.isArray(parsed.proposedHypotheses) ? parsed.proposedHypotheses.slice(0, 5) : [], uncoveredBlindspots: Array.isArray(parsed.uncoveredBlindspots) ? parsed.uncoveredBlindspots.slice(0, 8) : [], recommendedSafeNextStep: String(parsed.recommendedSafeNextStep ?? a.brief.nextStep), isAiGenerated: true, engineUsed: `gemini (${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})` };
      } catch (err) {
        console.warn('[ai] Gemini unavailable, using deterministic reviewer:', err instanceof Error ? err.message : err);
      }
    }
    const weakest = [...a.hypotheses].filter(h => h.confidenceScore >= 0.35 && h.confidenceScore < 0.8).sort((x, y) => x.confidenceScore - y.confidenceScore);
    return {
      aiReasoning: `${a.brief.headline} ${a.brief.narrative} Strongest supported conclusion: ${a.hypotheses.slice().sort((x, y) => y.confidenceScore - x.confidenceScore)[0]?.title ?? 'none yet'}. The reviewer below challenges the open hypotheses and lists what has not been checked.`,
      proposedHypotheses: [...weakest, ...a.hypotheses.filter(h => h.confidenceScore >= 0.8)].slice(0, 4).map(h => ({
        title: h.title, description: h.description, category: h.category, confidence: h.confidenceScore,
        challengePerspective: a.contradictions.find(c => c.hypothesisId === h.id)?.devilAdvocateAssessment ?? `Would be weakened by: ${h.conditionsToWeaken[0] ?? 'contradicting operator-level evidence'}`,
      })),
      uncoveredBlindspots: a.gaps.slice(0, 6).map(g => `${g.title} — ${g.detail}`),
      recommendedSafeNextStep: a.brief.nextStep,
      isAiGenerated: true,
      engineUsed: 'Hunter deterministic reviewer (set GEMINI_API_KEY for an LLM second opinion)',
    };
  }
}
