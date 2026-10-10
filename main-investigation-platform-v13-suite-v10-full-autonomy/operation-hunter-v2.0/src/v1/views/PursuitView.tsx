import React, { useState } from 'react';
import { Play, Pause, Square, StepForward } from 'lucide-react';
import { api, Run } from '../api';
import { useLoad, useLive, Pill, Meter, dt, timeAgo, useAction, Spinner, Section, Explain } from '../ui';
import type { OpContext } from '../HunterApp';
import { Gate, ViewHeader, Stat } from './common';

const BRANCH_TONE: Record<string, string> = { EXPANDED: 'green', SATURATED: '', ABANDONED_DEAD_END: '', COMMODITY: 'amber', FAILED: 'red', PENDING_EXTERNAL: 'violet', CYCLE_DETECTED: '' };
const BRANCH_TEXT: Record<string, string> = { EXPANDED: 'found new', SATURATED: 'nothing new', ABANDONED_DEAD_END: 'dead end', COMMODITY: 'shared service — not followed', FAILED: 'failed', PENDING_EXTERNAL: 'waiting on Main', CYCLE_DETECTED: 'already known' };

export function PursuitView(ctx: OpContext) {
  const runs = useLoad<Run[]>(() => api.runs(ctx.operationId), [ctx.operationId]);
  const leads = useLoad<any[]>(() => api.leads(ctx.operationId), [ctx.operationId]);
  const pivots = useLoad<any[]>(() => api.pivots(ctx.operationId), [ctx.operationId]);
  useLive(ctx.operationId, () => { void runs.reload(); void leads.reload(); void pivots.reload(); }, 1500);
  const { busy, run } = useAction();
  const [budget, setBudget] = useState(60);
  const [hops, setHops] = useState(4);
  const [delegate, setDelegate] = useState(true);
  const [openLead, setOpenLead] = useState<string | null>(null);
  const reloadAll = () => { void runs.reload(); void leads.reload(); void pivots.reload(); };
  return (
    <Gate state={runs} what="Loading pursuit">
      {() => {
        const current = runs.data![0];
        const running = current?.status === 'RUNNING';
        const paused = current?.status === 'PAUSED';
        const pending = (leads.data ?? []).filter(l => l.status === 'PENDING');
        const done = (pivots.data ?? []).filter(p => p.status === 'done');
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Autonomy" title="Pursuit & leads" intro="What Hunter chose to look up, why, and what it found. Leads are ranked by expected new information, how well each kind of lookup has worked before, novelty and cost."
              right={<>
                {running ? <button className="hx-btn" disabled={!!busy} onClick={() => run('p', () => api.pausePursuit(ctx.operationId), 'Paused').then(reloadAll)}><Pause size={15} />Pause</button>
                  : <button className="hx-btn primary" disabled={!!busy} onClick={() => run('p', () => api.startPursuit(ctx.operationId, { budgetTotal: budget, maxHops: hops, allowDelegation: delegate }), paused ? 'Resumed' : 'Pursuit started').then(reloadAll)}><Play size={15} />{paused ? 'Resume' : 'Start pursuit'}</button>}
                <button className="hx-btn" disabled={!!busy || running} onClick={() => run('s', () => api.stepPursuit(ctx.operationId), 'Ran the top lead').then(reloadAll)}>{busy === 's' ? <Spinner /> : <StepForward size={15} />}One step</button>
                {(running || paused) && <button className="hx-btn ghost" disabled={!!busy} onClick={() => run('x', () => api.stopPursuit(ctx.operationId), 'Stopped').then(reloadAll)}><Square size={14} />Stop</button>}
              </>} />

            <div className="hx-grid cols-4" style={{ marginBottom: 14 }}>
              <Stat label="Status" value={current ? current.status.replace('_', ' ').toLowerCase() : 'not started'} sub={current?.stopReason ?? (current ? `updated ${timeAgo(current.updatedAt)}` : '')} />
              <Stat label="Budget used" value={current ? `${current.budgetUsed}/${current.config?.budgetTotal}` : '—'} sub={current ? <Meter value={(current.budgetUsed / Math.max(1, current.config?.budgetTotal)) * 100} /> : null} />
              <Stat label="Lookups done" value={done.length} sub={`${(pivots.data ?? []).filter(p => p.status === 'failed').length} failed · ${current?.stats?.commoditySkipped ?? 0} shared services skipped`} />
              <Stat label="Open leads" value={pending.length} sub={`deepest hop reached: ${current?.stats?.maxDepthReached ?? 0}`} />
            </div>

            {!running && (
              <div className="hx-card" style={{ marginBottom: 14 }}>
                <div className="hx-row" style={{ flexWrap: 'wrap', gap: 16 }}>
                  <b className="hx-small">Next pursuit:</b>
                  <label className="hx-small hx-row">Budget <input className="hx-input" type="number" min={5} max={500} value={budget} onChange={e => setBudget(Number(e.target.value))} style={{ width: 80 }} /></label>
                  <label className="hx-small hx-row">Max hops from seed <input className="hx-input" type="number" min={1} max={8} value={hops} onChange={e => setHops(Number(e.target.value))} style={{ width: 70 }} /></label>
                  <label className="hx-small hx-row"><input type="checkbox" checked={delegate} onChange={e => setDelegate(e.target.checked)} />Ask Main Platform modules for site checks</label>
                  <span className="hx-faint hx-small">Budget ≈ lookups. Hunter stops early when new lookups stop producing new relevant information.</span>
                </div>
              </div>
            )}

            <Explain>Only passive, public sources are queried (DNS, certificate logs, registration data, routing data, existing public scans, blockchain explorers). Hunter never logs in, submits forms, or interacts with scam sites; site visits are delegated to the Main Platform's own tools when connected.</Explain>

            <Section eyebrow="Queue" title="Ranked leads">
              <div className="hx-card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="hx-table">
                  <thead><tr><th>Score</th><th>Lead</th><th>Cost</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {(leads.data ?? []).slice(0, 80).map(l => (
                      <React.Fragment key={l.id}>
                        <tr className={l.status !== 'PENDING' ? 'dim' : ''}>
                          <td style={{ width: 90 }}><b>{Math.round(l.priorityScore)}</b><Meter value={l.priorityScore} /></td>
                          <td><a href="#" onClick={e => { e.preventDefault(); setOpenLead(openLead === l.id ? null : l.id); }}><b>{l.title}</b></a><div className="hx-small hx-muted">{l.plain?.why ?? l.reasoning}</div>{l.blockedReason && <div className="hx-small" style={{ color: 'var(--amber)' }}>Blocked: {l.blockedReason}</div>}</td>
                          <td><Pill tone={l.costEstimate === 'high' ? 'amber' : ''}>{l.costEstimate}</Pill></td>
                          <td className="hx-small">{l.status.toLowerCase()}{l.lastError && <div className="hx-faint">{l.lastError}</div>}</td>
                          <td>{l.status === 'PENDING' && !l.blockedReason && <button className="hx-btn small" disabled={busy === l.id || running} onClick={() => run(l.id, () => api.executeLead(ctx.operationId, l.id), (r: any) => r?.message ?? 'Done').then(reloadAll)}>{busy === l.id ? <Spinner /> : null}Run</button>}</td>
                        </tr>
                        {openLead === l.id && (
                          <tr><td colSpan={5} style={{ background: '#0a111c' }}>
                            {l.plain && <div className="hx-small" style={{ marginBottom: 8 }}><b>What it does:</b> {l.plain.what}<br /><b>Does not prove:</b> {l.plain.doesNotProve}</div>}
                            {l.entityId && <a href="#" className="hx-small" onClick={e => { e.preventDefault(); ctx.openEntity(l.entityId); }}>Open {l.targetValue}</a>}
                            {l.scoreBreakdown && <div className="hx-grid cols-4 hx-small" style={{ marginTop: 8 }}>{Object.entries(l.scoreBreakdown).map(([k, v]) => <div key={k}><span className="hx-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><div><b>{typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}</b></div></div>)}</div>}
                          </td></tr>
                        )}
                      </React.Fragment>
                    ))}
                    {!leads.data?.length && <tr><td colSpan={5} className="hx-muted">No leads. Add a seed or wait for analysis.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section eyebrow="Log" title="Lookups performed">
              <div className="hx-card">
                <ul className="hx-timeline">
                  {(pivots.data ?? []).slice(0, 150).map(p => (
                    <li key={p.id} className={p.result?.branchStatus === 'EXPANDED' ? 'imp-2' : ''}>
                      <time>{dt(p.finishedAt ?? p.createdAt)}</time> <Pill>{p.label}</Pill> <span className="mono hx-small">{p.targetValue}</span> <span className="hx-faint hx-small">hop {p.depth} · {p.collector}</span>
                      {p.status === 'done' && p.result ? (
                        <div className="hx-small" style={{ marginTop: 3 }}><Pill tone={BRANCH_TONE[p.result.branchStatus]}>{BRANCH_TEXT[p.result.branchStatus] ?? p.result.branchStatus}</Pill> {p.result.simpleExplanation}</div>
                      ) : <div className="hx-small" style={{ marginTop: 3, color: p.status === 'failed' ? '#ff9aa3' : undefined }}>{p.status}{p.error ? `: ${p.error}` : ''}</div>}
                    </li>
                  ))}
                  {!pivots.data?.length && <li className="hx-muted">No lookups yet.</li>}
                </ul>
              </div>
            </Section>

            {runs.data!.length > 1 && (
              <Section eyebrow="History" title="Previous pursuits">
                <div className="hx-card" style={{ padding: 0 }}>
                  <table className="hx-table"><thead><tr><th>Started</th><th>Status</th><th>Lookups</th><th>New indicators</th><th>Why it stopped</th></tr></thead>
                    <tbody>{runs.data!.map(r => <tr key={r.id}><td className="hx-small">{dt(r.startedAt)}</td><td className="hx-small">{r.status.toLowerCase()}</td><td>{r.stats?.pivots}</td><td>{r.stats?.newEntities}</td><td className="hx-small hx-muted">{r.stopReason ?? '—'}</td></tr>)}</tbody></table>
                </div>
              </Section>
            )}
          </div>
        );
      }}
    </Gate>
  );
}
