import React, { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useLoad, useLive, Pill, Section } from '../ui';
import type { OpContext } from '../HunterApp';
import { Gate, ViewHeader } from './common';

const TYPE_COLOR: Record<string, string> = {
  domain: '#4d8dff', hostname: '#6aa0ff', ip: '#8b9bb4', asn: '#6d7f99', nameserver: '#a78bfa', certificate: '#38bdf8', registrar: '#64748b', email: '#f472b6',
  wallet: '#2aa37a', contract: '#34d399', transaction: '#1f7a5c', template: '#d9a53a', resource: '#c08a2b', identifier: '#f59e0b', tracker: '#f59e0b', organization: '#94a3b8',
};
const color = (t: string) => TYPE_COLOR[t] ?? '#7d8ba3';

interface N { id: string; type: string; value: string; label?: string; role: string; isSeed: boolean; strength: number; x: number; y: number; vx: number; vy: number }

function layout(nodes: any[], edges: any[], W: number, H: number): N[] {
  // Deterministic force-directed layout (seeded by index) so the picture is stable between reloads.
  const ns: N[] = nodes.map((n, i) => {
    const angle = i * 2.399963; const r = 40 + 9 * Math.sqrt(i);
    return { ...n, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle), vx: 0, vy: 0 };
  });
  const idx = new Map(ns.map((n, i) => [n.id, i]));
  const es = edges.map(e => [idx.get(e.source), idx.get(e.target)]).filter(([a, b]) => a != null && b != null) as Array<[number, number]>;
  const k = Math.sqrt((W * H) / Math.max(1, ns.length)) * 0.55;
  for (let it = 0; it < 260; it++) {
    const t = 1 - it / 260;
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = 0.1 * (i - j); dy = 0.1; d2 = dx * dx + dy * dy; }
        if (d2 > 90000) continue;
        const f = (k * k) / d2;
        a.vx += dx * f * 0.02; a.vy += dy * f * 0.02; b.vx -= dx * f * 0.02; b.vy -= dy * f * 0.02;
      }
    }
    for (const [ai, bi] of es) {
      const a = ns[ai], b = ns[bi];
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - k) / d) * 0.06;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of ns) {
      n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy); const max = 18 * t + 1;
      if (sp > max) { n.vx = (n.vx / sp) * max; n.vy = (n.vy / sp) * max; }
      n.x += n.vx; n.y += n.vy; n.vx *= 0.55; n.vy *= 0.55;
    }
  }
  return ns;
}

export function GraphView(ctx: OpContext) {
  const g = useLoad<any>(() => api.graph(ctx.operationId), [ctx.operationId]);
  useLive(ctx.operationId, () => void g.reload(), 3000);
  const [scope, setScope] = useState<'core' | 'linked' | 'all'>('linked');
  const [hiddenTypes, setHidden] = useState<Set<string>>(new Set(['transaction']));
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const W = 1100, H = 640;

  const computed = useMemo(() => {
    if (!g.data) return null;
    const keepRole = (r: string) => (scope === 'all' ? true : scope === 'core' ? r === 'core' : r === 'core' || r === 'peripheral');
    let nodes = (g.data.nodes as any[]).filter(n => (n.isSeed || keepRole(n.role)) && !hiddenTypes.has(n.type));
    if (nodes.length > 450) nodes = nodes.sort((a, b) => b.strength - a.strength).slice(0, 450);
    const ids = new Set(nodes.map(n => n.id));
    const edges = (g.data.edges as any[]).filter(e => ids.has(e.source) && ids.has(e.target) && e.state !== 'INVALIDATED');
    return { nodes: layout(nodes, edges, W, H), edges, total: g.data.nodes.length };
  }, [g.data, scope, hiddenTypes]);

  const types = useMemo(() => [...new Set((g.data?.nodes ?? []).map((n: any) => n.type))] as string[], [g.data]);
  const neighbours = useMemo(() => {
    if (!hover || !computed) return null;
    const s = new Set([hover]);
    for (const e of computed.edges) { if (e.source === hover) s.add(e.target); if (e.target === hover) s.add(e.source); }
    return s;
  }, [hover, computed]);

  return (
    <Gate state={g} what="Laying out the graph">
      {() => {
        const pos = new Map(computed!.nodes.map(n => [n.id, n]));
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Graph" intro="Every indicator Hunter has collected and the evidence-backed relationships between them. Click a node for its evidence and possible next lookups." />
            <div className="hx-row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <div className="hx-tabs" style={{ margin: 0 }}>
                {(['core', 'linked', 'all'] as const).map(s => <a key={s} href="#" className={scope === s ? 'active' : ''} onClick={e => { e.preventDefault(); setScope(s); }}>{s === 'core' ? 'Core only' : s === 'linked' ? 'Core + peripheral' : 'Everything'}</a>)}
              </div>
              <span className="hx-spacer" />
              <span className="hx-small hx-muted">{computed!.nodes.length} of {computed!.total} shown · scroll to zoom, drag to pan</span>
              <button className="hx-btn small ghost" onClick={() => setView({ x: 0, y: 0, s: 1 })}>Reset view</button>
            </div>
            <div className="hx-legend" style={{ marginBottom: 10 }}>
              {types.map(t => <label key={t} style={{ cursor: 'pointer', opacity: hiddenTypes.has(t) ? 0.4 : 1 }}><input type="checkbox" style={{ display: 'none' }} checked={!hiddenTypes.has(t)} onChange={() => { const n = new Set(hiddenTypes); n.has(t) ? n.delete(t) : n.add(t); setHidden(n); }} /><i style={{ background: color(t) }} />{t}</label>)}
            </div>
            <svg className="hx-graph" viewBox={`${-view.x} ${-view.y} ${W / view.s} ${H / view.s}`}
              onWheel={e => { const s = Math.min(4, Math.max(0.4, view.s * (e.deltaY < 0 ? 1.12 : 0.89))); setView(v => ({ ...v, s })); }}
              onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY }; }}
              onMouseMove={e => { if (!drag.current) return; const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y; drag.current = { x: e.clientX, y: e.clientY }; setView(v => ({ ...v, x: v.x + dx / v.s, y: v.y + dy / v.s })); }}
              onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
              {computed!.edges.map(e => {
                const a = pos.get(e.source)!, b = pos.get(e.target)!;
                const lit = neighbours ? neighbours.has(e.source) && neighbours.has(e.target) : false;
                return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? '#9cc4ff' : e.state === 'SUPPORTED' ? '#3a5680' : '#23324a'} strokeOpacity={neighbours && !lit ? 0.15 : 0.8} strokeWidth={lit ? 1.6 : 0.8 + e.confidence} strokeDasharray={e.state === 'SUPPORTED' ? undefined : '3 3'}><title>{e.type} · {Math.round(e.confidence * 100)}% · {e.evidence} evidence</title></line>;
              })}
              {computed!.nodes.map(n => {
                const r = n.isSeed ? 9 : n.role === 'core' ? 6.5 : 4.5;
                const dim = neighbours && !neighbours.has(n.id);
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }} opacity={dim ? 0.25 : n.role === 'context' || n.role === 'commodity' ? 0.6 : 1}
                    onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => ctx.openEntity(n.id)}>
                    <circle r={r} fill={color(n.type)} stroke={n.isSeed ? '#fff' : n.role === 'core' ? '#0a111d' : 'none'} strokeWidth={n.isSeed ? 2 : 1} />
                    {(n.isSeed || n.role === 'core' || hover === n.id || (neighbours?.has(n.id) ?? false)) && <text x={r + 3} y={3}>{(n.label && n.type !== 'domain' ? n.label : n.value).slice(0, 34)}</text>}
                    <title>{`${n.type}: ${n.value} (${n.role})`}</title>
                  </g>
                );
              })}
            </svg>

            <Section eyebrow="Structure" title="Clusters & bridges">
              <div className="hx-grid cols-2">
                <div className="hx-card">
                  <h3>Clusters</h3>
                  <ul className="hx-list">{(g.data.clusters as any[]).map(c => <li key={c.id}><b>{c.name}</b> <Pill>{c.category.replace(/_/g, ' ').toLowerCase()}</Pill><div className="hx-small hx-muted">{c.reasoning}</div></li>)}</ul>
                </div>
                <div className="hx-card">
                  <h3>Bridges</h3>
                  <p className="hx-small hx-muted" style={{ marginTop: 0 }}>Indicators that connect otherwise separate clusters — worth checking independently because a lot depends on them.</p>
                  <ul className="hx-list">{(g.data.bridges as any[]).map(b => <li key={b.id}><a href="#" onClick={e => { e.preventDefault(); ctx.openEntity(b.entityId); }} className="mono">{b.entityValue}</a><div className="hx-small hx-muted">{b.bridgeSignificance}</div></li>)}
                    {!g.data.bridges.length && <li className="hx-muted">None.</li>}</ul>
                </div>
              </div>
            </Section>
          </div>
        );
      }}
    </Gate>
  );
}
