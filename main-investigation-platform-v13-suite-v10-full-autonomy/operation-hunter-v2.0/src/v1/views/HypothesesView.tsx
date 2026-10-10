import React, { useState } from 'react';
import { api } from '../api';
import { Pill, Meter, Section, Explain, useAction, Spinner } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader } from './common';

const STATUS: Record<string, { label: string; tone: string }> = {
  STRONGLY_SUPPORTED: { label: 'Strongly supported', tone: 'green' },
  FORMULATED: { label: 'Open', tone: 'blue' },
  WEAKENED: { label: 'Weakened', tone: 'amber' },
  CONTRADICTED: { label: 'Contradicted', tone: 'red' },
  RESOLVED: { label: 'Resolved', tone: '' },
};

export function HypothesesView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  const { busy, run } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Gate state={a} what="Loading hypotheses">
      {() => {
        const hyps = (a.data.hypotheses as any[]).slice().sort((x, y) => y.confidenceScore - x.confidenceScore);
        const contra = new Map((a.data.contradictions as any[]).map(c => [c.hypothesisId, c]));
        const gaps = a.data.gaps as any[];
        const title = (id: string) => hyps.find(h => h.id === id)?.title ?? id;
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reasoning" title="Hypotheses & gaps" intro="Competing explanations for what Hunter has observed, scored against the evidence — and the missing pieces that would change the picture most." />
            <Explain>Hypotheses are re-scored every time evidence changes. If you set a status yourself it is kept (locked) until you unlock it. Each one lists what would strengthen or weaken it, so you know what to look for.</Explain>

            <Section eyebrow="Explanations" title={`${hyps.length} hypotheses`}>
              {hyps.map(h => {
                const s = STATUS[h.status] ?? { label: h.status, tone: '' };
                const c = contra.get(h.id);
                const expanded = open === h.id;
                return (
                  <div key={h.id} className="hx-card" style={{ marginBottom: 10 }}>
                    <div className="hx-row" style={{ alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div className="hx-row" style={{ gap: 8 }}><Pill tone={s.tone}>{s.label}</Pill>{h.analystLocked && <Pill tone="violet">set by analyst</Pill>}<span className="hx-faint hx-small">{h.category.replace(/_/g, ' ').toLowerCase()}</span></div>
                        <h3 style={{ margin: '6px 0 4px' }}>{h.title}</h3>
                        <div className="hx-small hx-muted">{h.description}</div>
                      </div>
                      <div style={{ width: 140, textAlign: 'right' }}><b>{Math.round(h.confidenceScore * 100)}%</b><Meter value={h.confidenceScore * 100} tone={h.confidenceScore >= 0.75 ? 'green' : h.confidenceScore < 0.4 ? 'amber' : undefined} /></div>
                    </div>
                    <div className="hx-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="hx-btn small ghost" onClick={() => setOpen(expanded ? null : h.id)}>{expanded ? 'Less' : `Details · ${h.supportingObservations.length} for, ${h.contradictingObservations.length} against`}</button>
                      <span className="hx-spacer" />
                      {busy === h.id && <Spinner />}
                      <select className="hx-select" value={h.analystLocked ? h.status : ''} onChange={e => run(h.id, () => (e.target.value ? api.setHypothesis(ctx.operationId, h.id, { status: e.target.value }) : api.setHypothesis(ctx.operationId, h.id, { unlock: true })), 'Saved').then(() => a.reload())}>
                        <option value="">Automatic status</option>
                        {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>Set: {v.label}</option>)}
                      </select>
                    </div>
                    {expanded && (
                      <div className="hx-grid cols-2" style={{ marginTop: 12 }}>
                        <div>
                          <b className="hx-small">Supporting</b>
                          <ul className="hx-small" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>{h.supportingObservations.map((o: string, i: number) => <li key={i}>{o}</li>)}{!h.supportingObservations.length && <li className="hx-muted">None yet</li>}</ul>
                          <b className="hx-small">Against</b>
                          <ul className="hx-small" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>{h.contradictingObservations.map((o: string, i: number) => <li key={i}>{o}</li>)}{!h.contradictingObservations.length && <li className="hx-muted">Nothing observed against it yet</li>}</ul>
                          {h.competingHypothesisIds?.length > 0 && <div className="hx-small hx-muted">Competes with: {h.competingHypothesisIds.map(title).join('; ')}</div>}
                        </div>
                        <div>
                          <b className="hx-small">Would strengthen it</b>
                          <ul className="hx-small" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>{h.conditionsToStrengthen.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul>
                          <b className="hx-small">Would weaken it</b>
                          <ul className="hx-small" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>{h.conditionsToWeaken.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul>
                          {c && <div className="hx-callout hx-small"><b>Devil's advocate:</b> {c.devilAdvocateAssessment}</div>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!hyps.length && <div className="hx-card hx-muted">Hypotheses appear once there is enough evidence to compare explanations.</div>}
            </Section>

            <Section eyebrow="Missing pieces" title="Evidence gaps">
              <div className="hx-card" style={{ padding: 0 }}>
                <table className="hx-table">
                  <thead><tr><th>Gap</th><th>Impact</th><th>Fill it</th></tr></thead>
                  <tbody>{gaps.map(g => (
                    <tr key={g.id}>
                      <td><b>{g.title}</b><div className="hx-small hx-muted">{g.detail}</div></td>
                      <td style={{ width: 120 }}><Meter value={g.impact} tone={g.impact >= 70 ? 'amber' : undefined} /></td>
                      <td style={{ width: 260 }}>{g.suggestedPivot ? <button className="hx-btn small" disabled={busy === g.id} onClick={() => run(g.id, () => api.runPivot(ctx.operationId, { pivotType: g.suggestedPivot.pivotType, entityId: g.suggestedPivot.entityId }), 'Lookup finished').then(() => a.reload())}>{busy === g.id ? <Spinner /> : null}{g.suggestedPivot.label}</button> : <span className="hx-faint hx-small">Needs analyst input</span>}</td>
                    </tr>
                  ))}
                    {!gaps.length && <tr><td colSpan={3} className="hx-muted">No significant gaps.</td></tr>}</tbody>
                </table>
              </div>
            </Section>
          </div>
        );
      }}
    </Gate>
  );
}
