import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useLoad, useLive, Pill, Meter, dt, timeAgo, useAction, Spinner, Section, Explain } from '../ui';
import type { OpContext } from '../HunterApp';
import { Gate, ViewHeader } from './common';

const REAPP: Record<string, { label: string; tone: string }> = {
  CONFIRMED_ROTATION: { label: 'Likely the same operation', tone: 'red' }, OPEN: { label: 'Open', tone: 'blue' }, NEW_CLUSTER: { label: 'Similar, probably different operator', tone: 'amber' }, FALSE_ALARM: { label: 'False alarm', tone: '' },
};

export function MonitoringView(ctx: OpContext) {
  const monitors = useLoad<any[]>(() => api.monitors(ctx.operationId), [ctx.operationId]);
  const reapp = useLoad(() => api.reappearance(ctx.operationId), [ctx.operationId]);
  useLive(ctx.operationId, () => { void monitors.reload(); void reapp.reload(); }, 2000);
  const { busy, run } = useAction();
  const [cand, setCand] = useState('');
  const [check, setCheck] = useState<any>(null);
  const reload = () => { void monitors.reload(); void reapp.reload(); };
  const doCheck = async () => {
    const value = cand.trim();
    const det = await api.detect(value).catch(() => ({ type: null }));
    const type = det.type === 'wallet' || det.type === 'contract' ? 'wallet' : det.type ?? 'domain';
    const r = await run('check', () => api.checkReappearance(ctx.operationId, { candidateValue: value, candidateType: type, features: {} }));
    if (r) { setCheck(r); reload(); }
  };
  return (
    <Gate state={monitors} what="Loading monitors">
      {() => (
        <div className="hx-page">
          <ViewHeader eyebrow="Watch" title="Monitoring & reappearance" intro="Hunter re-checks the parts of the operation most likely to change — new certificates, DNS moves, new wallet activity — and compares anything new against the operation's fingerprint."
            right={<button className="hx-btn primary" disabled={busy === 'run'} onClick={() => run('run', () => api.runMonitors(ctx.operationId), (r: any) => r?.message ?? 'Done').then(reload)}>{busy === 'run' ? <Spinner /> : <RefreshCw size={15} />}Check everything now</button>} />
          <Explain>A new site is only called a likely rotation of this operation when operator-level indicators match (analytics IDs, support handles, collection wallets) — never on shared kit code or hosting alone.</Explain>

          <Section eyebrow="Reappearance" title="Possible returns">
            <div className="hx-card" style={{ marginBottom: 12 }}>
              <div className="hx-row">
                <input className="hx-input" style={{ maxWidth: 420 }} placeholder="Check a new domain or wallet against this operation…" value={cand} onChange={e => setCand(e.target.value)} onKeyDown={e => e.key === 'Enter' && cand.trim() && void doCheck()} />
                <button className="hx-btn" disabled={!cand.trim() || busy === 'check'} onClick={() => void doCheck()}>{busy === 'check' ? <Spinner /> : null}Compare</button>
                {check && <span className="hx-small"><b>{Math.round(check.lead?.overallSimilarityScore ?? check.overallSimilarityScore ?? 0)}%</b> — {check.lead?.reasoning ?? check.reasoning ?? check.message}</span>}
              </div>
            </div>
            <Gate state={reapp} what="Loading">
              {() => (
                <div className="hx-card" style={{ padding: 0 }}>
                  <table className="hx-table">
                    <thead><tr><th>Candidate</th><th>Similarity</th><th>Why</th><th>Assessment</th></tr></thead>
                    <tbody>
                      {reapp.data!.leads.map((l: any) => {
                        const s = REAPP[l.status] ?? { label: l.status, tone: '' };
                        return (
                          <tr key={l.id}>
                            <td><span className="mono">{l.candidateValue}</span><div className="hx-faint hx-small">{dt(l.detectedAt)} · {l.source ?? 'manual'}</div></td>
                            <td style={{ width: 110 }}><b>{Math.round(l.overallSimilarityScore)}%</b><Meter value={l.overallSimilarityScore} tone={l.overallSimilarityScore >= 80 ? 'amber' : undefined} /></td>
                            <td className="hx-small">{l.reasoning}<div className="hx-faint">{l.matchBreakdown.filter((m: any) => m.similarity > 0).map((m: any) => `${m.fingerprintType}: ${Math.round(m.similarity * 100)}%`).join(' · ')}</div></td>
                            <td style={{ width: 230 }}>
                              <Pill tone={s.tone}>{s.label}</Pill>
                              <select className="hx-select" style={{ marginTop: 6, width: '100%' }} value={l.status} onChange={e => run(l.id, () => api.setReappearance(ctx.operationId, l.id, e.target.value), 'Saved').then(reload)}>
                                {Object.entries(REAPP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                      {!reapp.data!.leads.length && <tr><td colSpan={4} className="hx-muted">No possible returns detected yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </Gate>
          </Section>

          <Section eyebrow="Watchers" title={`${monitors.data!.length} monitors`}>
            <div className="hx-card" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="hx-table">
                <thead><tr><th>Watching</th><th>Every</th><th>Last check</th><th>Last change</th><th>Status</th></tr></thead>
                <tbody>
                  {monitors.data!.map(m => (
                    <tr key={m.id}>
                      <td><span className="mono">{m.targetValue}</span><div className="hx-faint hx-small">{m.notes || m.pivotType}</div></td>
                      <td className="hx-small">
                        <select className="hx-select" value={m.frequencyMinutes} onChange={e => run(m.id, () => api.updateMonitor(m.id, { frequencyMinutes: Number(e.target.value) })).then(reload)}>
                          {[60, 360, 720, 1440, 4320, 10080].includes(m.frequencyMinutes) ? null : <option value={m.frequencyMinutes}>{m.frequencyMinutes} min</option>}
                          <option value={60}>hour</option><option value={360}>6 hours</option><option value={720}>12 hours</option><option value={1440}>day</option><option value={4320}>3 days</option><option value={10080}>week</option>
                        </select>
                      </td>
                      <td className="hx-small">{timeAgo(m.lastCheckedAt)}<div className="hx-faint">{m.runs ?? 0} run(s){m.nextRunAt ? ` · next ${dt(m.nextRunAt)}` : ''}</div></td>
                      <td className="hx-small">{m.lastChange ?? <span className="hx-faint">no change</span>}</td>
                      <td>
                        <button className={`hx-btn small ${m.status === 'PAUSED' ? '' : 'ghost'}`} onClick={() => run(m.id, () => api.updateMonitor(m.id, { status: m.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' })).then(reload)}>{m.status === 'PAUSED' ? 'Resume' : 'Pause'}</button>
                        {m.status === 'ALERTING' && <Pill tone="red">changed</Pill>}
                      </td>
                    </tr>
                  ))}
                  {!monitors.data!.length && <tr><td colSpan={5} className="hx-muted">Monitors are created automatically when a pursuit finishes. Press “Check everything now” to create and run them.</td></tr>}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}
    </Gate>
  );
}
