import type { OpData } from '../analysis/data.js';
import type { Draft } from '../analysis/findings.js';
import type { ModelVersion } from '../core/intelStore.js';
import type { LivingModel, ModelDiff } from './living.js';
import { isoDay, listPhrase, plural, round } from '../core/util.js';

/**
 * Findings that only the living model can produce: whether the operation is
 * running, dark or moving; when the next wave is due; where the evidence
 * supports more than one explanation; and what changed in the model since the
 * previous version. Like every finding they say why it matters, how sure
 * Hunter is, what it does not prove and what to do next.
 */
export function modelFindings(data: OpData, model: LivingModel, diff: ModelDiff | null, versions: ModelVersion[]): Draft[] {
  const out: Draft[] = [];
  const idsFor = (values: string[]) => data.entities.filter(e => values.includes(e.value)).map(e => e.id);

  // Operation status: rotating / dormant / dark are what an investigator needs to know first.
  if (model.status === 'rotating' || model.status === 'dark' || model.status === 'dormant') {
    const dark = model.sites.filter(s => s.state === 'dark' || s.state === 'suspended');
    const reserve = model.forecast.reserve;
    out.push({
      key: `lifecycle:${model.status}`, kind: 'lifecycle',
      title: model.status === 'rotating' ? `The operation looks mid-rotation${reserve.length ? ` — ${plural(reserve.length, 'reserve domain')} ready` : ''}` : model.status === 'dormant' ? 'The operation has gone quiet' : 'All known sites are down',
      whatFound: `${model.statusReason} Dark: ${listPhrase(dark.map(s => s.value), 4)}.${reserve.length ? ` Reserve: ${listPhrase(reserve, 4)}.` : ''}`,
      whyItMatters: model.status === 'rotating' ? 'Operations usually move rather than stop. The reserve domains are where victims will be sent next.' : 'Takedowns rarely end an operation; the same people tend to return with new domains and the same settings.',
      whatItMeans: model.status === 'rotating' ? 'Watching the reserve domains and the operation\'s nameservers now is more valuable than re-profiling dead sites.' : 'Standing hunts keep searching for the operation\'s settings on new sites.',
      uncertainty: `Site status comes from the latest DNS and registry lookups (${plural(dark.length, 'site')}); a site can be down temporarily.`,
      doesNotProve: 'Sites going dark does not prove a takedown or that the operation ended; reserve domains are not proof of future use.',
      nextStep: reserve.length ? `Check the reserve domain${reserve.length === 1 ? '' : 's'} ${listPhrase(reserve, 2)} again and run the standing hunts now.` : 'Run the standing hunts now.',
      action: { type: 'open_view', label: 'Open hunts', params: { view: 'model' } },
      confidence: model.status === 'rotating' ? 0.7 : 0.6, importance: model.status === 'rotating' ? 84 : 66, evidenceIds: [], entityIds: idsFor([...dark.map(s => s.value), ...reserve]), view: 'model',
    });
  }

  // Next wave forecast.
  const f = model.forecast;
  if ((f.status === 'due' || f.status === 'overdue' || f.status === 'soon') && f.nextExpectedAt && f.confidence >= 0.35) {
    out.push({
      key: 'forecast:next-wave', kind: 'forecast',
      title: f.status === 'soon' ? `Next wave expected around ${isoDay(f.nextExpectedAt)}` : `A new wave is ${f.status} (expected around ${isoDay(f.nextExpectedAt)})`,
      whatFound: f.basis,
      whyItMatters: 'Knowing when the operation usually redeploys tells Hunter when to look hardest for new sites — before they reach many victims.',
      whatItMeans: `Standing hunts for this operation run ${f.status === 'soon' ? 'more often' : 'at their most frequent'} until the window passes${f.window ? ` (${isoDay(f.window[0])} – ${isoDay(f.window[1])})` : ''}.`,
      uncertainty: `Forecast confidence ${Math.round(f.confidence * 100)}% — ${model.waves.length} waves is a short history.`,
      doesNotProve: 'A rhythm in past registrations does not guarantee a future wave.',
      nextStep: 'Nothing to do now — Hunter watches more closely during the window and alerts on any new site with the operation\'s settings.',
      confidence: f.confidence, importance: f.status === 'soon' ? 45 : 58, evidenceIds: [], entityIds: [], view: 'model',
    });
  }

  // Competing explanations: surface when the evidence does not clearly separate them.
  for (const q of model.hypotheses) {
    const [a, b] = q.hypotheses;
    if (!a || !b) continue;
    const close = q.margin < 1.5;
    if (!close && q.key !== 'activity') continue;
    if (!close) continue;
    out.push({
      key: `ach:${q.key}`, kind: 'competing_explanation',
      title: `${q.question} — "${a.label}" vs "${b.label}"`,
      whatFound: `The evidence does not clearly separate these explanations yet (margin ${round(q.margin, 1)}). For "${a.label}": ${q.evidence.filter(e => ['C', 'CC'].includes(e.ratings[a.key])).map(e => e.text).slice(0, 2).join('; ') || '—'}. For "${b.label}": ${q.evidence.filter(e => ['C', 'CC'].includes(e.ratings[b.key])).map(e => e.text).slice(0, 2).join('; ') || '—'}.`,
      whyItMatters: 'Acting on the wrong explanation wastes effort and risks attributing sites to the wrong people.',
      whatItMeans: `Hunter currently leans towards "${a.label}", weakly.`,
      uncertainty: q.caveat,
      doesNotProve: 'Neither explanation is established; shared kits, hosting and even shared settings can have innocent or misleading causes.',
      nextStep: q.discriminatingTest,
      action: { type: 'open_view', label: 'Compare explanations', params: { view: 'model', question: q.key } },
      confidence: 0.5, importance: 62, evidenceIds: [], entityIds: [], view: 'model',
    });
  }

  // What changed since the previous model version (only when material).
  if (diff && versions.length >= 2 && diff.significance >= 0.5) {
    const top = diff.changes.slice().sort((x, y) => y.significance - x.significance).slice(0, 3);
    out.push({
      key: `model_change:v${versions[0].version}`, kind: 'model_change',
      title: top[0].text,
      whatFound: top.map(c => c.text).join('. ') + '.',
      whyItMatters: 'These are changes in what Hunter believes about the operation, not just new data.',
      whatItMeans: `Model version ${versions[0].version} replaces version ${versions[1]?.version ?? versions[0].version - 1}. Every earlier version stays available for comparison.`,
      uncertainty: 'Changes follow the evidence; a later lookup can reverse them.',
      doesNotProve: 'A site joining or leaving the model reflects the current weight of evidence, not a final determination.',
      nextStep: 'Open the model history to see exactly what changed and why.',
      action: { type: 'open_view', label: 'Model history', params: { view: 'model' } },
      confidence: 0.7, importance: 60, evidenceIds: [], entityIds: [], view: 'model',
    });
  }
  return out;
}
