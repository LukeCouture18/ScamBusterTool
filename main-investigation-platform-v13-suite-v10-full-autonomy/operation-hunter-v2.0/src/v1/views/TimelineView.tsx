import React, { useState } from 'react';
import { Pill, Section, day, dt } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader, Stat, List } from './common';

const KIND_TEXT: Record<string, string> = { registration: 'Registration', certificate: 'Certificate', site_seen: 'Site seen', went_dark: 'Went dark', victim_funds: 'Victim funds', exit: 'Cash-out', deployment: 'Contract deployed', rotation: 'Rotation', kit_variant: 'Kit version', reappearance: 'Reappearance' };

export function TimelineView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  const [kind, setKind] = useState('');
  const [step, setStep] = useState<number | null>(null);
  return (
    <Gate state={a} what="Loading timeline">
      {() => {
        const t = a.data.temporal;
        const kinds = [...new Set((t.events as any[]).map(e => e.kind))];
        const events = (t.events as any[]).filter(e => !kind || e.kind === kind);
        const maxAct = Math.max(1, ...(t.activity as any[]).map(d => d.infrastructure + d.money));
        const snap = step == null ? t.snapshots[t.snapshots.length - 1] : t.snapshots[step];
        const diff = snap ? t.diffs.find((d: any) => d.toStep === snap.stepLabel) : null;
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Timeline" intro="How the operation was built, used, disrupted and rebuilt, phase by phase." />
            <div className="hx-grid cols-3" style={{ marginBottom: 16 }}>
              <Stat label="Observed span" value={t.span?.days != null ? `${Math.round(t.span.days)} days` : '—'} sub={t.span ? `${day(t.span.start)} → ${day(t.span.end)}` : ''} />
              <Stat label="Phases" value={t.phases.length} sub={t.phases.map((p: any) => p.label).join(' → ')} />
              <Stat label="Last activity" value={day(t.lastActivity)} sub={`${t.events.length} dated events`} />
            </div>
            <div className="hx-card">
              <div className="hx-row"><h3 style={{ margin: 0 }}>Activity</h3><span className="hx-spacer" /><span className="hx-legend"><span><i style={{ background: '#23406a' }} />infrastructure</span><span><i style={{ background: '#2aa37a' }} />money</span></span></div>
              <div className="hx-bars" style={{ marginTop: 10, height: 80 }}>
                {(t.activity as any[]).map(d => (
                  <div key={d.day} title={`${d.day}: ${d.infrastructure} infrastructure, ${d.money} money events`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: 1 }}>
                    {d.money > 0 && <span className="money" style={{ height: `${(d.money / maxAct) * 100}%`, display: 'block' }} />}
                    {d.infrastructure > 0 && <span style={{ height: `${(d.infrastructure / maxAct) * 100}%`, display: 'block' }} />}
                  </div>
                ))}
              </div>
              <div className="hx-row hx-faint hx-small" style={{ justifyContent: 'space-between', marginTop: 4 }}><span>{t.activity[0]?.day}</span><span>{t.activity[t.activity.length - 1]?.day}</span></div>
            </div>

            <Section eyebrow="Phases" title="How it unfolded">
              <div className="hx-grid cols-3">
                {(t.phases as any[]).map((p, i) => (
                  <button key={p.index} className={`hx-card ${step === i ? 'selected' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', borderColor: (step ?? t.snapshots.length - 1) === i ? 'var(--blue)' : undefined }} onClick={() => setStep(i)}>
                    <div className="eyebrow">Phase {i + 1} · {day(p.start)} → {day(p.end)}</div>
                    <h3 style={{ margin: '4px 0' }}>{p.label}</h3>
                    <div className="hx-small hx-muted">{p.summary}</div>
                  </button>
                ))}
              </div>
              {snap && (
                <div className="hx-card" style={{ marginTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>State at {snap.stepLabel}</h3>
                  <p className="hx-small" style={{ marginTop: 0 }}>{snap.summary}</p>
                  <dl className="hx-kv">
                    <dt>Active domains</dt><dd className="hx-small"><List items={snap.activeDomains} max={8} /></dd>
                    <dt>Servers</dt><dd className="hx-small"><List items={snap.activeIps} max={8} /></dd>
                    <dt>Operational wallets</dt><dd className="hx-small"><List items={snap.activeWallets} max={6} /></dd>
                    <dt>Nameservers</dt><dd className="hx-small"><List items={snap.activeNameservers} /></dd>
                  </dl>
                  {diff && <><h3>Changes from the previous phase</h3><ul className="hx-small" style={{ margin: 0, paddingLeft: 18 }}>{diff.structuralChanges.slice(0, 20).map((c: string, i: number) => <li key={i} className={c.startsWith('-') ? 'hx-muted' : ''}>{c}</li>)}</ul></>}
                </div>
              )}
            </Section>

            <Section eyebrow="Events" title="Dated events" right={<select className="hx-select" value={kind} onChange={e => setKind(e.target.value)}><option value="">All events</option>{kinds.map(k => <option key={k} value={k}>{KIND_TEXT[k] ?? k}</option>)}</select>}>
              <div className="hx-card">
                <ul className="hx-timeline">
                  {events.map((e, i) => <li key={i} className={`imp-${e.importance}`}><time>{dt(e.at)}</time> <Pill>{KIND_TEXT[e.kind] ?? e.kind}</Pill><div><b>{e.title}</b></div>{e.detail && <div className="hx-small hx-muted">{e.detail}</div>}</li>)}
                  {!events.length && <li className="hx-muted">No dated events yet.</li>}
                </ul>
              </div>
            </Section>
          </div>
        );
      }}
    </Gate>
  );
}
