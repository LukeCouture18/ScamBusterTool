import React, { useEffect, useState } from 'react';
import { Plus, Crosshair, RotateCcw, AlertTriangle } from 'lucide-react';
import { api, OperationSummary } from '../api';
import { Meter, Pill, Empty, Loading, ErrorBox, useAction, go, timeAgo, Spinner } from '../ui';

type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> };

export function OperationsPage({ ops }: { ops: Loaded<OperationSummary[]> }) {
  const [showNew, setShowNew] = useState(false);
  const { busy, run } = useAction();
  const list = ops.data ?? [];
  const real = list.filter(o => !o.isDemo);
  const demo = list.filter(o => o.isDemo);
  return (
    <div className="hx-page">
      <div className="hx-heading">
        <div>
          <div className="eyebrow">Operation Hunter</div>
          <h1>Operations</h1>
          <p>Give Hunter one thing you found — a site, a wallet, an IP — and it reconstructs the wider operation behind it: the infrastructure, the scam kit, where the money goes and how it changes over time.</p>
        </div>
        <div className="hx-actions">
          <button className="hx-btn primary" onClick={() => setShowNew(true)}><Plus size={16} />New operation</button>
        </div>
      </div>
      {ops.error && <ErrorBox error={ops.error} onRetry={() => void ops.reload()} />}
      {ops.loading && !ops.data && <Loading what="Loading operations" />}
      {ops.data && !real.length && (
        <div className="hx-card" style={{ marginBottom: 18 }}>
          <div className="hx-row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <Crosshair size={28} color="#5f9cf6" />
            <div style={{ flex: 1 }}>
              <h2 style={{ marginBottom: 4 }}>Start your first operation</h2>
              <p className="hx-muted" style={{ margin: '0 0 12px' }}>Paste the scam site or wallet you are looking at. Hunter searches public sources (DNS, certificate logs, registration records, block explorers, scan archives) and keeps going until it stops finding new things. You will see the 3–5 strongest findings first.</p>
              <QuickStart />
            </div>
          </div>
        </div>
      )}
      {real.map(o => <OperationCard key={o.id} op={o} />)}
      {demo.length > 0 && (
        <>
          <div className="hx-section-title"><div><div className="eyebrow">Practice</div><h2>Demo operations (synthetic data)</h2></div>
            <button className="hx-btn small" disabled={busy === 'reset'} onClick={() => run('reset', () => api.resetDemo(), 'Demo rebuilt').then(() => ops.reload())}>{busy === 'reset' ? <Spinner /> : <RotateCcw size={14} />}Rebuild demo</button>
          </div>
          <p className="hx-muted hx-small" style={{ marginTop: -6 }}>A fictional world used to show what Hunter does. Nothing in it is real. Real operations never mix with demo data.</p>
          {demo.map(o => <OperationCard key={o.id} op={o} />)}
        </>
      )}
      {showNew && <NewOperationModal onClose={() => setShowNew(false)} onCreated={id => { setShowNew(false); void ops.reload(); go(`/op/${id}`); }} />}
    </div>
  );
}

function OperationCard({ op }: { op: OperationSummary }) {
  const running = op.pursuit?.status === 'RUNNING';
  return (
    <div className="hx-op-card" onClick={() => go(`/op/${op.id}`)} role="link">
      <div>
        <div className="hx-row" style={{ gap: 8 }}>
          <span className="code">{op.code}</span>
          {op.isDemo && <Pill tone="amber">demo</Pill>}
          {op.alerts > 0 && <Pill tone="red"><AlertTriangle size={11} />{op.alerts} alert{op.alerts > 1 ? 's' : ''}</Pill>}
          {op.newFindings > 0 && <Pill tone="blue">{op.newFindings} new</Pill>}
          {op.mainInvestigationId && <Pill>linked to Main</Pill>}
        </div>
        <h3>{op.name}</h3>
        <p>{op.headline}</p>
      </div>
      <div className="side">
        <span className="hx-small hx-muted">Reconstruction depth</span>
        <div style={{ width: 150 }}><Meter value={op.depth} tone={op.depth >= 70 ? 'green' : undefined} /></div>
        <span className="hx-small">{running ? <span className="hx-row" style={{ gap: 6 }}><Spinner /> hunting · {op.pursuit?.pivots} pivots</span> : op.pursuit ? `${op.pursuit.status.toLowerCase().replace('_', ' ')} · ${timeAgo(op.updatedAt)}` : 'not started'}</span>
      </div>
    </div>
  );
}

function QuickStart() {
  const [value, setValue] = useState('');
  const { busy, run } = useAction();
  const start = async () => {
    const created = await run('create', () => api.createOperation({ initialSeed: value.trim(), startPursuit: true }));
    if (created) go(`/op/${created.id}`);
  };
  return (
    <div className="hx-seedbox">
      <input className="hx-input" placeholder="e.g. claim-refund-portal.click or 0x71c8…" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && value.trim()) void start(); }} />
      <button className="hx-btn primary" disabled={!value.trim() || busy === 'create'} onClick={() => void start()}>{busy === 'create' ? <Spinner /> : <Crosshair size={16} />}Start hunting</button>
    </div>
  );
}

export function NewOperationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [seed, setSeed] = useState('');
  const [name, setName] = useState('');
  const [extra, setExtra] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [budget, setBudget] = useState(40);
  const [hops, setHops] = useState(4);
  const { busy, run } = useAction();
  useEffect(() => {
    const v = seed.trim();
    if (!v) { setType(null); return; }
    const t = setTimeout(() => { api.detect(v).then(r => setType(r.type)).catch(() => setType(null)); }, 250);
    return () => clearTimeout(t);
  }, [seed]);
  const create = async () => {
    const res = await run('create', () => api.createOperation({ initialSeed: seed.trim(), name: name.trim() || undefined, additionalSeeds: extra.split(/[\s,]+/).filter(Boolean), startPursuit: true, config: { budgetTotal: budget, maxHops: hops } }), 'Operation created — Hunter is on it');
    if (res) onCreated(res.id);
  };
  return (
    <div className="hx-modal-bg" onClick={onClose}>
      <div className="hx-modal" onClick={e => e.stopPropagation()}>
        <h2>New operation</h2>
        <p className="hx-muted" style={{ marginTop: 0 }}>Start from what you have. Hunter will find the rest.</p>
        <div className="hx-field">
          <label>Seed — the site, wallet, IP, analytics ID or handle you found</label>
          <input className="hx-input" autoFocus value={seed} onChange={e => setSeed(e.target.value)} placeholder="claim-refund-portal.click" />
          <span className="hint">{type ? <>Detected: <b>{type}</b></> : seed ? 'Unrecognised format — it will be treated as a domain' : 'Domains, URLs, EVM/TRON/BTC addresses, IPs, G-/UA- analytics IDs, @telegram handles'}</span>
        </div>
        <div className="hx-field">
          <label>Name (optional)</label>
          <input className="hx-input" value={name} onChange={e => setName(e.target.value)} placeholder={seed ? `Operation ${seed.slice(0, 30)}` : 'Operation …'} />
        </div>
        <div className="hx-field">
          <label>More seeds (optional)</label>
          <input className="hx-input" value={extra} onChange={e => setExtra(e.target.value)} placeholder="other domains or wallets you already know, separated by spaces" />
        </div>
        <details style={{ marginBottom: 14 }}>
          <summary className="hx-muted hx-small" style={{ cursor: 'pointer' }}>Pursuit limits</summary>
          <div className="hx-grid cols-2" style={{ marginTop: 10 }}>
            <div className="hx-field"><label>Pivot budget</label><input className="hx-input" type="number" min={5} max={500} value={budget} onChange={e => setBudget(Number(e.target.value))} /><span className="hint">How many lookups Hunter may make.</span></div>
            <div className="hx-field"><label>Max hops from the seed</label><input className="hx-input" type="number" min={1} max={8} value={hops} onChange={e => setHops(Number(e.target.value))} /><span className="hint">How far Hunter may wander from what you gave it.</span></div>
          </div>
        </details>
        <div className="hx-row" style={{ justifyContent: 'flex-end' }}>
          <button className="hx-btn ghost" onClick={onClose}>Cancel</button>
          <button className="hx-btn primary" disabled={!seed.trim() || busy === 'create'} onClick={() => void create()}>{busy === 'create' ? <Spinner /> : <Crosshair size={16} />}Create & start hunting</button>
        </div>
      </div>
    </div>
  );
}
