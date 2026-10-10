import React, { useEffect, useState } from 'react';
import { FileDown } from 'lucide-react';
import { api } from '../api';
import { useLoad, useLive, Pill, dt, useAction, Explain } from '../ui';
import type { OpContext } from '../HunterApp';
import { Gate, ViewHeader } from './common';

const ASSERTION: Record<string, { label: string; tone: string }> = {
  observed: { label: 'observed', tone: 'blue' }, blockchain_fact: { label: 'on-chain fact', tone: 'green' }, derived: { label: 'derived', tone: 'violet' }, analyst: { label: 'analyst', tone: 'amber' }, imported: { label: 'imported', tone: '' },
};

export function EvidenceView(ctx: OpContext) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const ev = useLoad(() => api.evidence(ctx.operationId, debounced, status), [ctx.operationId, debounced, status]);
  useLive(ctx.operationId, () => void ev.reload(), 2500);
  const { run } = useAction();
  return (
    <div className="hx-page">
      <ViewHeader eyebrow="Evidence" title="Evidence locker" intro="Every observation Hunter or you recorded, with its source, time, and SHA-256 hash. Conclusions elsewhere always trace back to these records."
        right={<><a className="hx-btn" href={`/api/v1/operations/${ctx.operationId}/export`}><FileDown size={15} />Export JSON</a><a className="hx-btn" href={`/api/v1/operations/${ctx.operationId}/report`}><FileDown size={15} />Dossier</a></>} />
      <Explain><b>Observed</b> records are what a public source returned; <b>on-chain facts</b> are blockchain records; <b>derived</b> records are Hunter's own computations (e.g. a page fingerprint). If a record is wrong, invalidate it — every analysis that relied on it is recomputed.</Explain>
      <div className="hx-row" style={{ marginBottom: 12 }}>
        <input className="hx-input" style={{ maxWidth: 380 }} placeholder="Search observations, sources, URLs…" value={q} onChange={e => setQ(e.target.value)} />
        <select className="hx-select" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="valid">Valid</option><option value="invalidated">Invalidated</option></select>
        <span className="hx-spacer" />
        {ev.data && <span className="hx-small hx-muted">{ev.data.total} record(s){ev.data.total > ev.data.items.length ? `, showing ${ev.data.items.length}` : ''}</span>}
      </div>
      <Gate state={ev} what="Loading evidence">
        {() => (
          <div className="hx-card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="hx-table">
              <thead><tr><th>When</th><th>Source</th><th>Observation</th><th>Kind</th><th /></tr></thead>
              <tbody>
                {ev.data!.items.map((e: any) => {
                  const as = ASSERTION[e.assertion ?? 'observed'] ?? ASSERTION.observed;
                  const expanded = open === e.id;
                  return (
                    <React.Fragment key={e.id}>
                      <tr className={`clickable ${e.status !== 'valid' ? 'dim' : ''}`} onClick={() => setOpen(expanded ? null : e.id)}>
                        <td className="hx-small" style={{ whiteSpace: 'nowrap' }}>{dt(e.timestamp)}</td>
                        <td className="hx-small">{e.source}<div className="hx-faint">{e.collector ?? ''}</div></td>
                        <td>{e.originalObservation}{e.status !== 'valid' && <div className="hx-small" style={{ color: '#ff9aa3' }}>Invalidated: {e.invalidationReason}</div>}</td>
                        <td><Pill tone={as.tone}>{as.label}</Pill>{e.synthetic && <> <Pill tone="amber">synthetic</Pill></>}</td>
                        <td style={{ whiteSpace: 'nowrap' }} onClick={x => x.stopPropagation()}>
                          {e.status === 'valid'
                            ? <button className="hx-btn small ghost" onClick={() => { const reason = window.prompt('Why is this record wrong or unreliable?'); if (reason) void run('inv', () => api.invalidate(ctx.operationId, e.id, reason), 'Invalidated — analysis recomputed').then(() => ev.reload()); }}>Invalidate</button>
                            : <button className="hx-btn small ghost" onClick={() => void run('rein', () => api.reinstate(ctx.operationId, e.id), 'Reinstated').then(() => ev.reload())}>Reinstate</button>}
                        </td>
                      </tr>
                      {expanded && (
                        <tr><td colSpan={5} style={{ background: '#0a111c' }}>
                          <dl className="hx-kv">
                            <dt>Evidence ID</dt><dd className="mono">{e.id}</dd>
                            <dt>SHA-256</dt><dd className="mono hx-small">{e.sha256Hash}</dd>
                            <dt>Provenance</dt><dd className="hx-small" style={{ wordBreak: 'break-all' }}>{e.provenance}</dd>
                            <dt>Collected</dt><dd className="hx-small">{dt(e.collectedAt ?? e.timestamp)}</dd>
                            <dt>Confidence</dt><dd className="hx-small">{Math.round(e.confidence * 100)}%</dd>
                            <dt>Indicators</dt><dd className="hx-small">{e.relatedEntityIds.map((id: string) => <a key={id} href="#" className="mono" style={{ marginRight: 8 }} onClick={x => { x.preventDefault(); ctx.openEntity(id); }}>{id}</a>)}</dd>
                          </dl>
                          <div className="hx-code" style={{ marginTop: 8 }}>{JSON.stringify(e.rawData, null, 2).slice(0, 6000)}</div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {!ev.data!.items.length && <tr><td colSpan={5} className="hx-muted">No evidence matches.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Gate>
    </div>
  );
}
