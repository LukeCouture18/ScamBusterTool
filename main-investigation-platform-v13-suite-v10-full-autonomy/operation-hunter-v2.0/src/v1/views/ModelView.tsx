import React, { useState } from 'react';
import { Play, Check, X, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api';
import { useLoad, useLive, useAction, Pill, Section, Spinner, day, dt, timeAgo, pct } from '../ui';
import { Gate, ViewHeader, Stat } from './common';
import type { OpContext } from '../HunterApp';

/**
 * The living model: what Hunter currently believes about the operation, how
 * sure it is, what changed, which explanations compete, what contradicts, and
 * what is being watched. Everything links down to the underlying entities.
 */
const STATE_TONE: Record<string, string> = { live: 'green', resurfaced: 'blue', dark: 'red', suspended: 'red', pending: 'standby', unknown: 'unknown' };
const STATUS_TONE: Record<string, string> = { active: 'green', rotating: 'amber', dormant: 'violet', dark: 'red', unknown: '' };
const RATING: Record<string, { label: string; tone: string }> = { CC: { label: '++', tone: 'green' }, C: { label: '+', tone: 'green' }, N: { label: '·', tone: '' }, I: { label: '−', tone: 'red' }, II: { label: '−−', tone: 'red' } };

export function ModelView(ctx: OpContext) {
  const m = useLoad<any>(() => api.model(ctx.operationId), [ctx.operationId]);
  useLive(ctx.operationId, () => void m.reload(), 1500);
  const { busy, run } = useAction();
  return (
    <Gate state={m} what="Building the model">
      {() => {
        const { model, versions, contradictions, hunts, branches } = m.data;
        const openC = (contradictions as any[]).filter(c => c.status === 'open');
        return (
          <div className="hx-page">
            <ViewHeader eyebrow={`Living model · version ${m.data.version ?? '—'}`} title="What Hunter believes about this operation"
              intro="Rebuilt from the evidence after every change. Each part says how sure Hunter is; nothing here is proof of who runs the operation."
              right={<button className="hx-btn" disabled={busy === 'hunts'} onClick={() => run('hunts', () => api.runHunts(ctx.operationId), (r: any[]) => `${r.length} hunts run · ${r.reduce((s, x) => s + x.newDomains.length, 0)} new domains`).then(() => m.reload())}>{busy === 'hunts' ? <Spinner /> : <Play size={14} />}Run standing hunts now</button>} />

            <div className="hx-card" style={{ marginBottom: 14 }}>
              <div className="hx-row" style={{ gap: 10 }}><Pill tone={STATUS_TONE[model.status]}>{model.status}</Pill><span>{model.statusReason}</span></div>
            </div>
            <div className="hx-grid cols-4">
              <Stat label="Member sites" value={model.counts.members} sub={`${model.counts.probable} probable · ${model.counts.candidates} to check`} />
              <Stat label="Live / dark" value={`${model.counts.live} / ${model.counts.dark}`} sub={`${model.counts.reserve} reserve domain${model.counts.reserve === 1 ? '' : 's'}`} />
              <Stat label="Operator settings" value={model.counts.operatorIndicators} sub="shared only by this operation's sites" />
              <Stat label="Next wave" value={model.forecast.status.replace('_', ' ')} sub={model.forecast.nextExpectedAt ? `around ${day(model.forecast.nextExpectedAt)} · ${pct(model.forecast.confidence)} confidence` : 'no rhythm yet'} />
            </div>

            <Section eyebrow="Explanations" title="Competing explanations">
              {!model.hypotheses.length && <div className="hx-card hx-muted">Not enough evidence to weigh explanations yet.</div>}
              {model.hypotheses.map((q: any) => <AchCard key={q.key} q={q} />)}
            </Section>

            <Section eyebrow="Sites" title="Sites and their lives">
              <div className="hx-card" style={{ overflowX: 'auto' }}>
                <table className="hx-table">
                  <thead><tr><th>Site</th><th>Belongs</th><th>State</th><th>Registered</th><th>Went dark</th><th>Hosting history</th><th>Kit</th></tr></thead>
                  <tbody>
                    {model.sites.map((s: any) => (
                      <tr key={s.entityId}>
                        <td><a href="#" className="mono" onClick={e => { e.preventDefault(); ctx.openEntity(s.entityId); }}>{s.value}</a></td>
                        <td><Pill tone={s.membership === 'member' ? 'core' : 'peripheral'}>{s.membership} {pct(s.probability)}</Pill></td>
                        <td><Pill tone={STATE_TONE[s.state]}>{s.state}</Pill>{s.stateSince && <div className="hx-faint hx-small">since {day(s.stateSince)}</div>}</td>
                        <td className="hx-small">{day(s.registeredAt)}{s.lifetimeDays !== null && <div className="hx-faint">{s.lifetimeDays} days of life</div>}</td>
                        <td className="hx-small">{s.wentDarkAt ? day(s.wentDarkAt) : '—'}{s.resurfacedAt && <div className="hx-faint">back {day(s.resurfacedAt)}</div>}</td>
                        <td className="hx-small mono">{s.hosting.length ? s.hosting.slice(-3).map((h: any) => `${h.value}${h.to ? ` (until ${day(h.to)})` : ''}`).join(' → ') : '—'}</td>
                        <td className="hx-small">{s.kit ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!model.sites.length && <div className="hx-muted">No sites assessed as part of the operation yet.</div>}
              </div>
            </Section>

            <div className="hx-grid cols-2" style={{ marginTop: 6 }}>
              <div className="hx-card">
                <h3>Deployment waves & forecast</h3>
                <ul className="hx-list">{model.waves.map((w: any) => <li key={w.index} className="hx-small"><b>Wave {w.index}</b> · {day(w.start)}{w.end !== w.start ? ` – ${day(w.end)}` : ''} · {w.sites.join(', ')}</li>)}</ul>
                <p className="hx-small hx-muted">{model.forecast.basis}</p>
                {model.forecast.reserve.length > 0 && <p className="hx-small"><b>Reserve:</b> <span className="mono">{model.forecast.reserve.join(', ')}</span></p>}
              </div>
              <div className="hx-card">
                <h3>Still unknown</h3>
                <ul className="hx-list">{model.unknowns.map((u: string) => <li key={u} className="hx-small">{u}</li>)}</ul>
                {!model.unknowns.length && <span className="hx-muted">Nothing major.</span>}
              </div>
            </div>

            <Section eyebrow="Contradictions" title={`Things that do not fit (${openC.length} open)`}>
              <div className="hx-card">
                {!contradictions.length && <span className="hx-muted">No contradictions detected.</span>}
                <ul className="hx-list">
                  {(contradictions as any[]).map(c => (
                    <li key={c.id} className={c.status !== 'open' ? 'hx-faint' : ''}>
                      <div className="hx-row" style={{ gap: 8 }}><Pill tone={c.severity >= 0.6 ? 'red' : 'amber'}>{c.kind.replace(/_/g, ' ')}</Pill><span className="hx-faint hx-small">{timeAgo(c.detectedAt)}</span>{c.status !== 'open' && <Pill>{c.status}</Pill>}<span className="hx-spacer" />
                        {c.status === 'open' ? <>
                          <button className="hx-btn small ghost" title="Explained / resolved" onClick={() => run('c' + c.id, () => api.setContradiction(ctx.operationId, c.id, 'resolved', 'Reviewed by analyst'), 'Marked resolved').then(() => m.reload())}><Check size={13} /></button>
                          <button className="hx-btn small ghost" title="Not relevant" onClick={() => run('c' + c.id, () => api.setContradiction(ctx.operationId, c.id, 'dismissed'), 'Dismissed').then(() => m.reload())}><X size={13} /></button>
                        </> : <button className="hx-btn small ghost" title="Reopen" onClick={() => run('c' + c.id, () => api.setContradiction(ctx.operationId, c.id, 'open'), 'Reopened').then(() => m.reload())}><RotateCcw size={13} /></button>}
                      </div>
                      <div style={{ marginTop: 4 }}>{c.summary}</div>
                      {c.resolution && <div className="hx-small hx-faint">{c.resolution}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            </Section>

            <Section eyebrow="History" title="How the model changed">
              <div className="hx-card">
                <ul className="hx-list hx-changes">
                  {(versions as any[]).map(v => <li key={v.version}><time>v{v.version} · {dt(v.createdAt)}</time><span>{v.changes.length ? v.changes.map((c: any) => c.text).join(' · ') : v.summary}</span></li>)}
                </ul>
              </div>
            </Section>

            <div className="hx-grid cols-2" style={{ marginTop: 6 }}>
              <div className="hx-card">
                <h3>Standing hunts</h3>
                <p className="hx-small hx-muted">Searches Hunter re-runs on its own to catch the operation returning. Anything new is verified and judged on operator-level evidence before it is called a return.</p>
                <table className="hx-table">
                  <thead><tr><th>Hunt</th><th>Cadence</th><th>Runs / hits</th><th></th></tr></thead>
                  <tbody>{(hunts as any[]).map(h => (
                    <tr key={h.id} className={h.status !== 'active' ? 'hx-faint' : ''}>
                      <td className="hx-small"><b>{h.label}</b><div className="hx-faint">{h.why}</div></td>
                      <td className="hx-small">{h.cadence}<div className="hx-faint">next {timeAgo(h.nextRunAt)}</div></td>
                      <td className="hx-small">{h.runs} / {h.hits}</td>
                      <td><button className="hx-btn small ghost" onClick={() => run('h' + h.id, () => api.setHunt(h.id, { status: h.status === 'active' ? 'paused' : 'active' }), h.status === 'active' ? 'Paused' : 'Resumed').then(() => m.reload())}>{h.status === 'active' ? 'Pause' : 'Resume'}</button></td>
                    </tr>
                  ))}</tbody>
                </table>
                {!hunts.length && <span className="hx-muted hx-small">Hunts are set up once the operation has confirmed sites with distinctive settings.</span>}
              </div>
              <div className="hx-card">
                <h3>Lines of inquiry</h3>
                <p className="hx-small hx-muted">Each lookup belongs to a line of inquiry. Lines that stop paying off are parked and revisited later — more data is not the same as progress.</p>
                <table className="hx-table">
                  <thead><tr><th>Line</th><th>Open</th><th>Parked</th><th>Done</th><th>Progress / lookups</th></tr></thead>
                  <tbody>{Object.entries(branches as Record<string, any>).map(([k, b]) => (
                    <tr key={k}><td className="hx-small">{k}</td><td>{b.active + b.revisit}</td><td>{b.saturated + b.blocked}</td><td>{b.exhausted}</td><td className="hx-small">{b.progress} / {b.lookups}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </div>

            {model.otherGroups.length > 0 && (
              <Section eyebrow="Kept apart" title="Other operators seen alongside this one">
                <div className="hx-card">
                  <p className="hx-small hx-muted">These sites share kit or infrastructure with the operation but carry someone else's settings. Shared tooling is not shared ownership.</p>
                  <ul className="hx-list">{model.otherGroups.map((g: any, i: number) => <li key={i} className="hx-small"><span className="mono">{g.domains.join(', ')}</span> — settings <span className="mono">{g.indicators.join(', ')}</span></li>)}</ul>
                </div>
              </Section>
            )}
          </div>
        );
      }}
    </Gate>
  );
}

function AchCard({ q }: { q: any }) {
  const [open, setOpen] = useState(false);
  const top = q.hypotheses[0];
  return (
    <div className="hx-card" style={{ marginBottom: 10 }}>
      <div className="hx-row"><b>{q.question}</b><span className="hx-spacer" /><button className="hx-btn ghost small" onClick={() => setOpen(!open)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Evidence matrix</button></div>
      <div className="hx-row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {q.hypotheses.map((h: any) => <Pill key={h.key} tone={h.verdict === 'favoured' ? 'green' : h.verdict === 'unlikely' ? 'red' : 'amber'}>{h.label} · {h.verdict}</Pill>)}
      </div>
      <div className="hx-small" style={{ marginTop: 8 }}>{top.verdict === 'favoured' ? <>Leaning towards <b>{top.label}</b> (margin {q.margin}).</> : <>No explanation clearly ahead (margin {q.margin}).</>} <b>Test that would separate them:</b> {q.discriminatingTest}</div>
      <div className="hx-small hx-faint" style={{ marginTop: 4 }}>{q.caveat}</div>
      {open && (
        <table className="hx-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Evidence</th>{q.hypotheses.map((h: any) => <th key={h.key} title={h.label}>{h.label.split(' ').slice(0, 3).join(' ')}…</th>)}</tr></thead>
          <tbody>{q.evidence.map((e: any, i: number) => (
            <tr key={i}><td className="hx-small">{e.text}</td>{q.hypotheses.map((h: any) => { const r = RATING[e.ratings[h.key] ?? 'N']; return <td key={h.key}><Pill tone={r.tone}>{r.label}</Pill></td>; })}</tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
