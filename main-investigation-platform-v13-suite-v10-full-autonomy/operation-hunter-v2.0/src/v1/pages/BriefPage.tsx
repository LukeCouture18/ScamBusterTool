import React, { useEffect, useState } from 'react';
import { Play, Pause, FileDown, Link2, X, ChevronDown, ChevronUp, Send, Plus, MessageSquare } from 'lucide-react';
import { api, BriefPayload, Finding, NextLead } from '../api';
import { useLoad, useLive, useAction, Meter, Pill, Loading, ErrorBox, Term, Spinner, KIND_LABEL, go, timeAgo, dt, Section } from '../ui';
import type { OpContext } from '../HunterApp';

export function BriefPage({ operationId, openEntity, onChanged }: OpContext & { onChanged: () => void }) {
  const brief = useLoad<BriefPayload>(() => api.brief(operationId), [operationId]);
  const { busy, run } = useAction();
  const [showSeed, setShowSeed] = useState(false);
  const [aiOpen, setAiOpen] = useState<any>(null);
  useLive(operationId, () => void brief.reload());
  // Mark the operation viewed after the analyst has seen the Brief for a moment.
  useEffect(() => {
    const t = setTimeout(() => { void api.viewed(operationId).then(onChanged).catch(() => undefined); }, 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);
  if (brief.error && !brief.data) return <div className="hx-page"><ErrorBox error={brief.error} onRetry={() => void brief.reload()} /></div>;
  if (!brief.data) return <div className="hx-page"><Loading what="Preparing the brief" /></div>;
  const { operation: op, brief: b, pursuit, recentPivots, integration } = brief.data;
  const running = pursuit?.status === 'RUNNING';
  const done = pursuit && !running;
  const startOrPause = () => run('pursuit', () => (running ? api.pausePursuit(op.id) : api.startPursuit(op.id)), running ? 'Pursuit paused' : 'Pursuit started').then(() => brief.reload());
  return (
    <div className="hx-page">
      <div className="hx-heading">
        <div>
          <div className="eyebrow">{op.code}{op.isDemo ? ' · demo' : ''} · seed <span className="mono">{op.initialSeed}</span></div>
          <h1>{op.name}</h1>
          <p>Analysed {timeAgo(brief.data.analyzedAt)} · {b.counts.evidence ?? 0} evidence records · {b.counts.entities ?? 0} indicators</p>
        </div>
        <div className="hx-actions">
          <button className={`hx-btn ${running ? '' : 'primary'}`} disabled={busy === 'pursuit'} onClick={() => void startOrPause()}>{busy === 'pursuit' ? <Spinner /> : running ? <Pause size={15} /> : <Play size={15} />}{running ? 'Pause pursuit' : pursuit ? 'Continue hunting' : 'Start hunting'}</button>
          <button className="hx-btn" onClick={() => setShowSeed(true)}><Plus size={15} />Add seed / evidence</button>
          <a className="hx-btn" href={`/api/v1/operations/${op.id}/report`}><FileDown size={15} />Dossier</a>
          <button className="hx-btn ghost" disabled={busy === 'ai'} onClick={() => run('ai', () => api.ai(op.id)).then(r => r && setAiOpen(r))}>{busy === 'ai' ? <Spinner /> : <MessageSquare size={15} />}Second opinion</button>
        </div>
      </div>

      {running && (
        <div className="hx-pursuit">
          <span className="pulse" />
          <div className="text">
            <b>Hunting… {pursuit!.stats?.pivots ?? 0} pivots, {pursuit!.stats?.newEntities ?? 0} new indicators</b>
            <span>{recentPivots[0] ? recentPivots[0].text : 'Choosing the most promising first lookups…'}</span>
          </div>
          <div style={{ width: 160 }}><Meter value={(pursuit!.budgetUsed / Math.max(1, pursuit!.config?.budgetTotal ?? 1)) * 100} /><div className="hx-small hx-muted" style={{ marginTop: 4, textAlign: 'right' }}>{pursuit!.budgetUsed}/{pursuit!.config?.budgetTotal} budget</div></div>
        </div>
      )}
      {done && pursuit?.stopReason && <div className="hx-callout" style={{ marginBottom: 16 }}><b>Pursuit {pursuit.status.toLowerCase().replace('_', ' ')}:</b> {pursuit.stopReason}. {pursuit.status === 'SATURATED' ? 'You can still run individual leads from Pursuit & leads, or add a new seed.' : pursuit.status === 'BUDGET_EXHAUSTED' ? 'Continue hunting to spend another budget on the next-best leads.' : ''}</div>}

      <div className="hx-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px', alignItems: 'start' }}>
        <div className="hx-card">
          <div className="hx-summary"><strong>{b.headline}</strong>{b.narrative}</div>
          <div className="hx-row hx-small hx-muted" style={{ marginTop: 12 }}>
            <Pill tone={b.confidence.percentage >= 80 ? 'green' : b.confidence.percentage >= 55 ? 'blue' : 'amber'}>Confidence {b.confidence.percentage}%</Pill>
            <span>{b.confidence.assessment}</span>
          </div>
        </div>
        <DepthCard depth={b.depth} />
      </div>

      {brief.data.intel && <ModelStrip intel={brief.data.intel} operationId={op.id} />}

      {b.changesSinceLastView.count > 0 && (
        <div className="hx-card" style={{ marginTop: 14 }}>
          <h3>Since you last looked <Pill tone="blue">{b.changesSinceLastView.count}</Pill></h3>
          <ul className="hx-list hx-changes">
            {b.changesSinceLastView.items.slice(0, 5).map(c => <li key={c.id}><time>{dt(c.at)}</time><span>{c.summary}</span></li>)}
          </ul>
        </div>
      )}

      <Section eyebrow="Start here" title={b.top.length ? `The ${b.top.length} strongest things to look at` : 'Findings'}>
        {!b.top.length && <div className="hx-card hx-muted">No findings yet. {running ? 'Hunter is still collecting evidence — findings appear here as soon as there is something worth your attention.' : 'Start hunting to collect evidence.'}</div>}
        {b.top.map((f, i) => <FindingCard key={f.id} f={f} rank={i + 1} operationId={op.id} onDone={() => void brief.reload()} />)}
      </Section>

      {(brief.data.leads?.length ?? 0) > 0 && (
        <Section eyebrow="Where to look next" title="The most valuable next lookups" right={<a className="hx-btn small ghost" href={`#/op/${op.id}/pursuit`}>All leads</a>}>
          <div className="hx-grid cols-3">
            {brief.data.leads!.map(l => <LeadCard key={l.key} l={l} operationId={op.id} onDone={() => void brief.reload()} />)}
          </div>
        </Section>
      )}

      <Section eyebrow="Go deeper" title="Explore the reconstruction">
        <div className="hx-explore">
          <a href={`#/op/${op.id}/model`}><b>Living model</b><span>Site lives, waves & forecast, competing explanations, contradictions, history, hunts</span></a>
          <a href={`#/op/${op.id}/infrastructure`}><b>Infrastructure</b><span>Domains, servers, nameservers, certificates, registration waves</span></a>
          <a href={`#/op/${op.id}/kits`}><b>Kits & operator links</b><span>Which kit, which versions, what ties sites to one operator</span></a>
          <a href={`#/op/${op.id}/money`}><b>Money</b><span>Collection, splits, treasury, cash-out</span></a>
          <a href={`#/op/${op.id}/timeline`}><b>Timeline</b><span>How the operation evolved, phase by phase</span></a>
          <a href={`#/op/${op.id}/graph`}><b>Graph</b><span>Everything and how it connects</span></a>
          <a href={`#/op/${op.id}/hypotheses`}><b>Hypotheses & gaps</b><span>{brief.data.counts.hypotheses} explanations · {brief.data.counts.gaps} open gaps</span></a>
          <a href={`#/op/${op.id}/evidence`}><b>Evidence</b><span>Every observation with source and hash</span></a>
          <a href={`#/op/${op.id}/pursuit`}><b>Pursuit & leads</b><span>{brief.data.counts.leads} ranked leads · what Hunter did and why</span></a>
        </div>
      </Section>

      <Section eyebrow="Suite" title="Main Investigation Platform">
        <div className="hx-card">
          {integration?.configured ? (
            <div className="hx-row">
              <span className={`hx-dot ${integration.connected ? 'on' : 'warn'}`} />
              <span>{integration.investigationId ? <>Linked to Main investigation <span className="mono">{integration.investigationId}</span></> : 'Not linked to a Main investigation yet — findings are still shared in Main → Operations.'}</span>
              <span className="hx-spacer" />
              {integration.mainOperationUrl && <a className="hx-btn small" href={integration.mainOperationUrl} target="_blank" rel="noreferrer">Open in Main</a>}
              {integration.investigationUrl && <a className="hx-btn small" href={integration.investigationUrl} target="_blank" rel="noreferrer">Open investigation</a>}
              <LinkInvestigation operationId={op.id} onDone={() => void brief.reload()} />
            </div>
          ) : (
            <div className="hx-row"><span className="hx-dot off" /><span className="hx-muted">Hunter runs standalone. Connect the Main Platform in Settings to share operations, receive new sites from Site Finder, and send leads to the inbox.</span><span className="hx-spacer" /><a className="hx-btn small" href="#/settings">Connect</a></div>
          )}
        </div>
      </Section>

      <Section eyebrow="Activity" title="What Hunter did most recently" right={<a className="hx-btn small ghost" href={`#/op/${op.id}/pursuit`}>Full log</a>}>
        <div className="hx-card">
          {!recentPivots.length && <span className="hx-muted">Nothing yet.</span>}
          <ul className="hx-list">
            {recentPivots.map(p => <li key={p.id}><div className="hx-row" style={{ gap: 8 }}><Pill tone={p.branch === 'EXPANDED' ? 'green' : p.branch === 'FAILED' ? 'red' : p.branch === 'COMMODITY' ? 'amber' : ''}>{p.label}</Pill><span className="hx-faint hx-small">{timeAgo(p.at)}</span></div><div style={{ marginTop: 4 }}>{p.text}</div></li>)}
          </ul>
        </div>
      </Section>

      {showSeed && <AddSeedModal operationId={op.id} onClose={() => setShowSeed(false)} onDone={() => { setShowSeed(false); void brief.reload(); }} />}
      {aiOpen && <AiModal result={aiOpen} onClose={() => setAiOpen(null)} />}
      <span style={{ display: 'none' }}>{String(openEntity ? '' : '')}</span>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { active: 'green', rotating: 'amber', dormant: 'violet', dark: 'red', unknown: '' };

/** One line per question an investigator asks first: is it running, when is the next wave, which explanation leads. */
function ModelStrip({ intel, operationId }: { intel: NonNullable<BriefPayload['intel']>; operationId: string }) {
  const close = intel.explanations.filter(e => e.margin < 1.5 && e.runnerUp);
  return (
    <div className="hx-card" style={{ marginTop: 14 }}>
      <div className="hx-row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Pill tone={STATUS_TONE[intel.status]}>{intel.status}</Pill>
        <span>{intel.statusReason}</span>
        <span className="hx-spacer" />
        <a className="hx-btn small ghost" href={`#/op/${operationId}/model`}>Living model{intel.modelVersion ? ` v${intel.modelVersion}` : ''}</a>
      </div>
      <div className="hx-grid cols-3 hx-small" style={{ marginTop: 10 }}>
        <div><b>Next wave: </b>{intel.forecast.status === 'unknown' ? 'no rhythm yet' : `${intel.forecast.status.replace('_', ' ')}${intel.forecast.nextExpectedAt ? ` (≈ ${intel.forecast.nextExpectedAt.slice(0, 10)})` : ''}`}</div>
        <div><b>Explanations: </b>{intel.explanations.length ? intel.explanations.map(e => e.margin < 1.5 && e.runnerUp ? `${e.leading} vs ${e.runnerUp.toLowerCase()} (undecided)` : e.leading).join(' · ') : '—'}</div>
        <div><b>Watching: </b>{intel.hunts.summary}{intel.contradictions.open ? ` · ${intel.contradictions.open} contradiction${intel.contradictions.open === 1 ? '' : 's'} open` : ''}</div>
      </div>
      {close.length > 0 && <div className="hx-small hx-muted" style={{ marginTop: 8 }}><b>To decide:</b> {close[0].test}</div>}
    </div>
  );
}

function LeadCard({ l, operationId, onDone }: { l: NextLead; operationId: string; onDone: () => void }) {
  const { busy, run } = useAction();
  return (
    <div className="hx-card">
      <div className="hx-small hx-faint">{l.branchKind} · {l.cost} cost</div>
      <b>{l.question}</b>
      <ul className="hx-list hx-small" style={{ marginTop: 6 }}>{l.why.map(w => <li key={w}>{w}</li>)}</ul>
      {l.doesNotProve && <div className="hx-small hx-faint" style={{ marginTop: 6 }}>{l.doesNotProve}</div>}
      <div className="hx-row" style={{ marginTop: 8 }}>
        <span className="hx-small mono" title={l.targetValue}>{l.label}</span><span className="hx-spacer" />
        <button className="hx-btn small primary" disabled={busy === 'run'} onClick={() => run('run', () => api.runPivot(operationId, { pivotType: l.pivotType, entityId: l.entityId }), (r: any) => r?.result?.simpleExplanation ?? 'Done').then(onDone)}>{busy === 'run' ? <Spinner /> : <Play size={12} />}Run</button>
      </div>
    </div>
  );
}

function DepthCard({ depth }: { depth: BriefPayload['brief']['depth'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hx-card">
      <div className="hx-row"><span className="hx-stat"><span>Reconstruction depth</span><b>{depth.score}<span className="hx-muted" style={{ fontSize: 13 }}>/100</span></b></span><span className="hx-spacer" /><button className="hx-btn ghost small" onClick={() => setOpen(!open)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
      <Meter value={depth.score} tone={depth.score >= 70 ? 'green' : undefined} />
      <div className="hx-small hx-muted" style={{ marginTop: 6 }}>How much of the operation Hunter has been able to map.</div>
      {open && <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>{depth.dimensions.map(d => <div key={d.key}><div className="hx-row hx-small"><span>{d.label}</span><span className="hx-spacer" /><span className="hx-muted">{d.score}</span></div><Meter value={d.score} /><div className="hx-faint" style={{ fontSize: 11.5 }}>{d.detail}</div></div>)}</div>}
    </div>
  );
}

function FindingCard({ f, rank, operationId, onDone }: { f: Finding; rank: number; operationId: string; onDone: () => void }) {
  const { busy, run } = useAction();
  const [evidence, setEvidence] = useState<any[] | null>(null);
  const act = async () => {
    const res = await run('act', () => api.actOnFinding(operationId, f.id), r => (r?.navigate ? '' : 'Done'));
    if (res?.navigate) go(`/op/${operationId}/${res.navigate}`);
    else onDone();
  };
  const showEvidence = async () => {
    if (evidence) { setEvidence(null); return; }
    const all = await api.evidence(operationId);
    setEvidence(all.items.filter(e => f.evidenceIds.includes(e.id) || e.relatedEntityIds.some((id: string) => f.entityIds.includes(id))).slice(0, 12));
  };
  return (
    <article className={`hx-finding ${f.isNewSinceLastView || f.status === 'new' ? 'new' : ''}`}>
      <div className="kind">{rank}. {KIND_LABEL[f.kind] ?? f.kind}{(f.isNewSinceLastView) && <Pill tone="blue">new</Pill>}</div>
      <div className="conf" title="How confident Hunter is in this finding"><span>{Math.round(f.confidence * 100)}%</span><Meter value={f.confidence * 100} tone={f.confidence >= 0.8 ? 'green' : f.confidence >= 0.6 ? undefined : 'amber'} /></div>
      <h3>{f.title}</h3>
      <div className="blocks">
        <div><b>What Hunter found</b>{f.whatFound}</div>
        <div><b>Why it matters</b>{f.whyItMatters}</div>
        <div><b>What it means</b>{f.whatItMeans}</div>
      </div>
      <div className="caveats">
        <div><b>Uncertainty: </b>{f.uncertainty}</div>
        <div><b>Does not prove: </b>{f.doesNotProve}</div>
      </div>
      <div className="next">
        <span className="label">Next</span>
        <span style={{ flex: 1 }}>{f.nextStep}</span>
        {f.action && f.action.type !== 'mark_reviewed' && <button className="hx-btn small primary" disabled={busy === 'act'} onClick={() => void act()}>{busy === 'act' ? <Spinner /> : f.action.type === 'send_to_inbox' ? <Send size={13} /> : null}{f.action.label}</button>}
        <button className="hx-btn small ghost" onClick={() => void showEvidence()}>{evidence ? 'Hide evidence' : `Evidence (${f.evidenceIds.length || 'related'})`}</button>
        <button className="hx-btn small ghost" title="Not useful — hide it" disabled={busy === 'dismiss'} onClick={() => run('dismiss', () => api.setFinding(f.id, 'dismissed'), 'Hidden. Hunter learns from this.').then(onDone)}><X size={13} /></button>
      </div>
      {evidence && (
        <ul className="hx-list" style={{ marginTop: 10 }}>
          {!evidence.length && <li className="hx-muted">This finding is derived from the analysis of several records; open Evidence for all of them.</li>}
          {evidence.map(e => <li key={e.id}><div className="hx-row hx-small" style={{ gap: 8 }}><Pill>{e.source}</Pill><span className="hx-faint mono">{e.id}</span><span className="hx-faint">{dt(e.timestamp)}</span>{e.synthetic && <Pill tone="amber">synthetic</Pill>}</div><div style={{ marginTop: 3 }}>{e.originalObservation}</div></li>)}
        </ul>
      )}
    </article>
  );
}

function LinkInvestigation({ operationId, onDone }: { operationId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { run } = useAction();
  if (!open) return <button className="hx-btn small" onClick={() => setOpen(true)}><Link2 size={13} />Link investigation</button>;
  return (
    <span className="hx-row">
      <input className="hx-input" style={{ width: 220 }} placeholder="Main investigation ID" value={value} onChange={e => setValue(e.target.value)} />
      <button className="hx-btn small primary" onClick={() => run('link', () => api.linkInvestigation(operationId, value.trim()), 'Linked — evidence will flow both ways').then(() => { setOpen(false); onDone(); })}>Link</button>
    </span>
  );
}

function AddSeedModal({ operationId, onClose, onDone }: { operationId: string; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<'seed' | 'evidence'>('seed');
  const [value, setValue] = useState('');
  const [subject, setSubject] = useState('');
  const [note, setNote] = useState('');
  const [content, setContent] = useState('');
  const { busy, run } = useAction();
  return (
    <div className="hx-modal-bg" onClick={onClose}>
      <div className="hx-modal" onClick={e => e.stopPropagation()}>
        <h2>Add to this operation</h2>
        <div className="hx-tabs"><a href="#" onClick={e => { e.preventDefault(); setTab('seed'); }} className={tab === 'seed' ? 'active' : ''}>New seed</a><a href="#" onClick={e => { e.preventDefault(); setTab('evidence'); }} className={tab === 'evidence' ? 'active' : ''}>Evidence / page source</a></div>
        {tab === 'seed' ? (
          <>
            <div className="hx-field"><label>Indicator</label><input className="hx-input" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="another domain, wallet, IP, analytics ID…" /><span className="hint">It becomes a starting point; continue the pursuit to expand from it.</span></div>
            <div className="hx-row" style={{ justifyContent: 'flex-end' }}><button className="hx-btn ghost" onClick={onClose}>Cancel</button><button className="hx-btn primary" disabled={!value.trim() || busy === 'seed'} onClick={() => run('seed', () => api.addSeed(operationId, value.trim()), 'Seed added').then(r => r && onDone())}>Add seed</button></div>
          </>
        ) : (
          <>
            <div className="hx-field"><label>What is it?</label><input className="hx-input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Page source saved from the victim's browser" /></div>
            <div className="hx-field"><label>About which site/wallet? (optional)</label><input className="hx-input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="claim-refund-portal.click" /></div>
            <div className="hx-field"><label>Content (HTML, script, report text)</label><textarea className="hx-textarea" value={content} onChange={e => setContent(e.target.value)} placeholder="Paste page source or text. Hunter fingerprints HTML and extracts wallets, trackers, handles and linked domains." /><span className="hint">Stored as analyst evidence with a SHA-256 hash. Nothing is fetched from the site.</span></div>
            <div className="hx-row" style={{ justifyContent: 'flex-end' }}><button className="hx-btn ghost" onClick={onClose}>Cancel</button><button className="hx-btn primary" disabled={!note.trim() || busy === 'ev'} onClick={() => run('ev', () => api.addEvidence(operationId, { source: 'analyst', type: content.includes('<') ? 'page_source' : 'manual_import', originalObservation: note.trim(), subjectValue: subject.trim() || undefined, content: content || undefined }), 'Evidence added and analysed').then(r => r && onDone())}>Add evidence</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function AiModal({ result, onClose }: { result: any; onClose: () => void }) {
  return (
    <div className="hx-modal-bg" onClick={onClose}>
      <div className="hx-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(760px,100%)' }}>
        <h2>Second opinion</h2>
        <p className="hx-faint hx-small" style={{ marginTop: 0 }}>{result.engineUsed}</p>
        <p>{result.aiReasoning}</p>
        <h3>Challenged hypotheses</h3>
        <ul className="hx-list">{result.proposedHypotheses.map((h: any, i: number) => <li key={i}><b>{h.title}</b> <Pill>{Math.round(h.confidence * 100)}%</Pill><div className="hx-muted hx-small" style={{ marginTop: 4 }}>{h.challengePerspective}</div></li>)}</ul>
        <h3>Blind spots</h3>
        <ul className="hx-list">{result.uncoveredBlindspots.map((b: string, i: number) => <li key={i} className="hx-small">{b}</li>)}</ul>
        <div className="hx-callout" style={{ marginTop: 12 }}><b>Suggested next step:</b> {result.recommendedSafeNextStep}</div>
        <div className="hx-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="hx-btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

export { Term };
