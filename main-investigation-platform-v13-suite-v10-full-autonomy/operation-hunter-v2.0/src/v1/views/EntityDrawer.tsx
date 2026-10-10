import React from 'react';
import { X, Bell, Send, Play, Check, Ban, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useLoad, Pill, dt, useAction, Spinner, Loading, ErrorBox } from '../ui';

export function EntityDrawer({ operationId, entityId, onClose, onOpenEntity }: { operationId: string; entityId: string; onClose: () => void; onOpenEntity: (id: string) => void }) {
  const d = useLoad<any>(() => api.entity(operationId, entityId), [operationId, entityId]);
  const { busy, run } = useAction();
  return (
    <>
      <div className="hx-modal-bg" style={{ background: 'rgba(3,7,14,.45)' }} onClick={onClose} />
      <aside className="hx-drawer">
        <div className="hx-row"><span className="hx-spacer" /><button className="hx-btn ghost small" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        {d.error && !d.data && <ErrorBox error={d.error} />}
        {!d.data && !d.error && <Loading />}
        {d.data && (() => {
          const e = d.data.entity;
          const meta = Object.entries(e.metadata ?? {}).filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !['linkRole'].includes(k));
          return (
            <>
              <div className="eyebrow">{e.type}{e.isSeed ? ' · seed' : ''}</div>
              <h2 className="mono">{e.value}</h2>
              {e.label && e.label !== e.value && <div className="hx-muted">{e.label}</div>}
              <div className="hx-row" style={{ margin: '10px 0', gap: 8, flexWrap: 'wrap' }}>
                <Pill tone={d.data.role}>{d.data.role}</Pill>
                {e.ubiquity >= 0.5 && <Pill tone="commodity">shared service ({Math.round(e.ubiquity * 100)}% ubiquity)</Pill>}
                {e.isActive === false && <Pill tone="inactive">inactive</Pill>}
                <span className="hx-faint hx-small">hop {e.depth ?? 0} · first seen {dt(e.firstSeen)}</span>
              </div>
              {d.data.linkPath && d.data.linkPath.path?.length > 1 && (
                <div className="hx-callout hx-small" style={{ marginBottom: 12 }}>
                  <b>How it connects to the seed ({Math.round(d.data.linkPath.strength * 100)}%):</b> {d.data.linkPath.path.map((p: string, i: number) => <React.Fragment key={i}>{i > 0 && <span className="hx-faint"> —{String(d.data.linkPath.via[i - 1] ?? '').toLowerCase().replace(/_/g, ' ')}→ </span>}<span className="mono">{p}</span></React.Fragment>)}
                </div>
              )}

              <div className="hx-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <button className="hx-btn small" disabled={busy === 'mon'} onClick={() => run('mon', () => api.addMonitor({ operationId, targetType: e.type, targetValue: e.value }), 'Monitor added').then(() => d.reload())}><Bell size={13} />Monitor</button>
                {(e.type === 'domain' || e.type === 'hostname') && <button className="hx-btn small" disabled={busy === 'inbox'} onClick={() => run('inbox', () => api.sendToInbox(operationId, e.value, `Linked to operation via ${d.data.role} evidence`), 'Queued for the Main Platform inbox')}><Send size={13} />Send to Main inbox</button>}
                <button className="hx-btn small ghost" onClick={() => run('seed', () => api.addSeed(operationId, e.value, 'Promoted from graph'), 'Marked as a seed').then(() => d.reload())}>Make seed</button>
              </div>

              {d.data.membership && <MembershipPanel operationId={operationId} m={d.data.membership} lifecycle={d.data.lifecycle} onDone={() => void d.reload()} />}
              {d.data.indicator && (
                <div className="hx-callout hx-small" style={{ marginBottom: 12 }}>
                  <b>As an indicator: {d.data.indicator.level}-level.</b> {d.data.indicator.reason} Used by {d.data.indicator.carriers.length} site{d.data.indicator.carriers.length === 1 ? '' : 's'}{d.data.indicator.population > d.data.indicator.carriers.length ? ` (≈${d.data.indicator.population} known in total)` : ''}.
                  {d.data.indicator.inconsistent.length > 0 && <> Appears on <span className="mono">{d.data.indicator.inconsistent.join(', ')}</span> alongside someone else's settings — possibly copied or planted.</>}
                </div>
              )}

              {meta.length > 0 && <dl className="hx-kv" style={{ marginBottom: 14 }}>{meta.slice(0, 16).map(([k, v]) => <React.Fragment key={k}><dt>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd className="hx-small">{String(v)}</dd></React.Fragment>)}</dl>}

              <h3>Lookups</h3>
              <ul className="hx-list">
                {(d.data.possiblePivots as any[]).map(p => (
                  <li key={p.pivotType}>
                    <div className="hx-row"><b className="hx-small">{p.label}</b>{p.done && <Pill tone="green">done</Pill>}<span className="hx-spacer" />
                      {p.available ? <button className="hx-btn small" disabled={busy === p.pivotType} onClick={() => run(p.pivotType, () => api.runPivot(operationId, { pivotType: p.pivotType, entityId: e.id, refresh: p.done }), (r: any) => r?.result?.simpleExplanation ?? r?.error ?? 'Done').then(() => d.reload())}>{busy === p.pivotType ? <Spinner /> : <Play size={12} />}{p.done ? 'Refresh' : 'Run'}</button> : <span className="hx-faint hx-small">{p.reason}</span>}
                    </div>
                    <div className="hx-small hx-muted">{p.explain.what}</div>
                  </li>
                ))}
                {!d.data.possiblePivots.length && <li className="hx-muted hx-small">No lookups apply to this kind of indicator.</li>}
              </ul>

              <h3 style={{ marginTop: 16 }}>Relationships ({d.data.relationships.length})</h3>
              <ul className="hx-list">
                {(d.data.relationships as any[]).slice(0, 60).map(r => (
                  <li key={r.id} className="hx-small">
                    <span className="hx-faint">{r.direction === 'out' ? '→' : '←'} {r.type.toLowerCase().replace(/_/g, ' ')}</span>{' '}
                    {r.other ? <a href="#" className="mono" onClick={x => { x.preventDefault(); onOpenEntity(r.other.id); }}>{r.other.value}</a> : '?'}{' '}
                    <Pill tone={r.state === 'SUPPORTED' ? 'green' : r.state === 'INVALIDATED' ? 'red' : ''}>{Math.round(r.confidence * 100)}%</Pill>
                  </li>
                ))}
              </ul>

              {d.data.otherOperations.length > 0 && <>
                <h3 style={{ marginTop: 16 }}>Also in</h3>
                <ul className="hx-list">{(d.data.otherOperations as any[]).map(o => <li key={o.operationId}><a href={`#/op/${o.operationId}`}>{o.code ?? o.operationId}</a></li>)}</ul>
              </>}

              {d.data.history?.length > 0 && <>
                <h3 style={{ marginTop: 16 }}>What changed over time</h3>
                <ul className="hx-list">{(d.data.history as any[]).slice(0, 20).map(c => <li key={c.id} className="hx-small"><span className="hx-faint">{dt(c.at)}</span> <Pill tone={c.kind === 'contradiction' ? 'red' : c.kind === 'disappeared' ? 'amber' : c.kind === 'resurfaced' ? 'blue' : ''}>{c.kind}</Pill> {c.label}: {c.kind === 'changed' ? `${c.from} → ${c.to}` : c.kind === 'disappeared' ? c.from : c.to} <span className="hx-faint">({c.source})</span></li>)}</ul>
              </>}

              <h3 style={{ marginTop: 16 }}>Evidence ({d.data.evidence.length})</h3>
              <ul className="hx-list">
                {(d.data.evidence as any[]).slice(0, 40).map(ev => (
                  <li key={ev.id} className={ev.status !== 'valid' ? 'hx-faint' : ''}>
                    <div className="hx-row hx-small" style={{ gap: 8 }}><Pill>{ev.source}</Pill><span className="hx-faint">{dt(ev.timestamp)}</span>{ev.synthetic && <Pill tone="amber">synthetic</Pill>}{ev.status !== 'valid' && <Pill tone="red">{ev.status}</Pill>}</div>
                    <div className="hx-small" style={{ marginTop: 3 }}>{ev.originalObservation}</div>
                  </li>
                ))}
              </ul>
            </>
          );
        })()}
      </aside>
    </>
  );
}

/** Why Hunter thinks this belongs to the operation (or not), with your verdict. */
function MembershipPanel({ operationId, m, lifecycle, onDone }: { operationId: string; m: any; lifecycle: any; onDone: () => void }) {
  const { busy, run } = useAction();
  const tone = m.status === 'member' ? 'core' : m.status === 'probable' ? 'peripheral' : m.status === 'excluded' ? 'red' : '';
  return (
    <div className="hx-card" style={{ marginBottom: 12 }}>
      <div className="hx-row" style={{ gap: 8 }}><b>Part of the operation?</b><Pill tone={tone}>{m.status} · {Math.round(m.probability * 100)}%</Pill>{m.analystVerdict && <Pill tone="blue">your verdict</Pill>}{lifecycle && <Pill>{lifecycle.state}</Pill>}</div>
      <ul className="hx-list hx-small" style={{ marginTop: 8 }}>
        {(m.factors as any[]).slice(0, 8).map((f, i) => <li key={i}><span className={f.weight >= 0 ? '' : 'hx-muted'} style={{ color: f.weight >= 0 ? 'var(--green)' : '#ff9aa3', fontWeight: 700 }}>{f.weight >= 0 ? '+' : ''}{f.weight}</span> {f.text}</li>)}
        {!m.factors.length && <li className="hx-muted">No evidence ties it to the operation's sites yet.</li>}
      </ul>
      <div className="hx-small hx-faint">Shared hosting or kit code alone never makes a site a member; operator settings, certificates and money do most of the work. Your verdict overrides the model and teaches it.</div>
      <div className="hx-row" style={{ gap: 6, marginTop: 8 }}>
        <button className="hx-btn small" disabled={!!busy} onClick={() => run('v', () => api.setVerdict(operationId, m.entityId, 'member'), 'Marked as part of the operation').then(onDone)}>{busy === 'v' ? <Spinner /> : <Check size={13} />}Belongs</button>
        <button className="hx-btn small" disabled={!!busy} onClick={() => run('n', () => api.setVerdict(operationId, m.entityId, 'not_member'), 'Marked as not part of the operation').then(onDone)}><Ban size={13} />Does not belong</button>
        {m.analystVerdict && <button className="hx-btn small ghost" disabled={!!busy} onClick={() => run('c', () => api.setVerdict(operationId, m.entityId, null), 'Verdict cleared').then(onDone)}><RotateCcw size={13} />Clear</button>}
      </div>
    </div>
  );
}
