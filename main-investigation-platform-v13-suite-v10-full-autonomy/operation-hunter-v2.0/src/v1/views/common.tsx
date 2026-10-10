import React from 'react';
import { api } from '../api';
import { useLoad, useLive, Loading, ErrorBox, short } from '../ui';
import type { OpContext } from '../HunterApp';

/** Loads the cached analysis for an operation and refreshes it when the operation changes. */
export function useAnalysis(ctx: OpContext) {
  const a = useLoad<any>(() => api.analysis(ctx.operationId), [ctx.operationId]);
  useLive(ctx.operationId, () => void a.reload(), 1500);
  return a;
}

export function Gate({ state, what, children }: { state: { data: any; error: string | null; reload: () => Promise<void> }; what: string; children: () => React.ReactNode }) {
  if (state.error && !state.data) return <div className="hx-page"><ErrorBox error={state.error} onRetry={() => void state.reload()} /></div>;
  if (!state.data) return <div className="hx-page"><Loading what={what} /></div>;
  return <>{children()}</>;
}

export function ViewHeader({ eyebrow, title, intro, right }: { eyebrow: string; title: string; intro: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="hx-heading">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{intro}</p></div>
      {right && <div className="hx-actions">{right}</div>}
    </div>
  );
}

/** A clickable indicator value that opens the entity drawer when the id is known. */
export function Ent({ id, value, open, max = 40, mono = true }: { id?: string | null; value: string; open: (id: string) => void; max?: number; mono?: boolean }) {
  const text = value.length > max ? short(value, max) : value;
  if (!id) return <span className={mono ? 'mono' : ''} title={value}>{text}</span>;
  return <a href="#" className={mono ? 'mono' : ''} title={value} onClick={e => { e.preventDefault(); open(id); }}>{text}</a>;
}

/** Map entity value → id using the graph payload nodes (loaded lazily by views that need it). */
export function useEntityIndex(operationId: string) {
  const g = useLoad<any>(() => api.graph(operationId), [operationId]);
  const index = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const n of g.data?.nodes ?? []) m.set(String(n.value).toLowerCase(), n.id);
    return m;
  }, [g.data]);
  return (value?: string | null) => (value ? index.get(value.toLowerCase()) ?? null : null);
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="hx-card"><div className="hx-stat"><span>{label}</span><b>{value}</b></div>{sub && <div className="hx-small hx-muted" style={{ marginTop: 4 }}>{sub}</div>}</div>;
}

export function List({ items, max = 6, render }: { items: string[]; max?: number; render?: (v: string) => React.ReactNode }) {
  if (!items?.length) return <span className="hx-faint">—</span>;
  const shown = items.slice(0, max);
  return <>{shown.map((v, i) => <React.Fragment key={v + i}>{i > 0 && ', '}{render ? render(v) : <span className="mono">{v}</span>}</React.Fragment>)}{items.length > max && <span className="hx-faint"> +{items.length - max} more</span>}</>;
}
