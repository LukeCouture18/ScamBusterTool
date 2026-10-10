import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------------ routing (hash based so Main can deep-link: /#/op/<id>)
export function parseHash(): string[] {
  return (window.location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [parts, setParts] = useState(parseHash());
  useEffect(() => {
    const on = () => setParts(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`;
}

// ------------------------------------------------------------------ data loading
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await loader();
      if (mine === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { setLoading(true); void reload(); }, [reload]);
  return { data, error, loading, reload };
}

/** Server-sent change events; calls onChange (debounced) when the operation changes. */
export function useLive(operationId: string | null, onChange: () => void, delayMs = 900) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const src = new EventSource(`/api/v1/events${operationId ? `?operationId=${encodeURIComponent(operationId)}` : ''}`);
    let t: ReturnType<typeof setTimeout> | null = null;
    const fire = () => { if (t) return; t = setTimeout(() => { t = null; cb.current(); }, delayMs); };
    src.addEventListener('change', fire);
    src.addEventListener('analysis', fire);
    return () => { if (t) clearTimeout(t); src.close(); };
  }, [operationId, delayMs]);
}

// ------------------------------------------------------------------ toasts
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => undefined);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const show = useCallback((msg: string, error?: boolean) => {
    setToast({ msg, error });
    setTimeout(() => setToast(t => (t?.msg === msg ? null : t)), error ? 7000 : 4000);
  }, []);
  return <ToastCtx.Provider value={show}>{children}{toast && <div className={`hx-toast ${toast.error ? 'error' : ''}`}>{toast.msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Wraps an async action with busy state and error toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      if (success) toast(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}

// ------------------------------------------------------------------ glossary
const GlossaryCtx = createContext<Record<string, string>>({});
export const GlossaryProvider = GlossaryCtx.Provider;
export function Term({ k, children }: { k: string; children?: React.ReactNode }) {
  const g = useContext(GlossaryCtx);
  const def = g[k];
  if (!def) return <>{children ?? k}</>;
  return <span className="hx-tip"><span className="hx-term">{children ?? k}</span><span className="tip"><b>{k}</b><br />{def}</span></span>;
}

// ------------------------------------------------------------------ small components
export function Meter({ value, tone }: { value: number; tone?: 'green' | 'amber' }) {
  return <div className={`hx-meter ${tone ?? ''}`}><i style={{ width: `${Math.max(2, Math.min(100, value))}%` }} /></div>;
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`hx-pill ${tone ?? ''}`}>{children}</span>;
}

export function Spinner() {
  return <span className="hx-spin" aria-label="Loading" />;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="hx-empty"><h3>{title}</h3>{children}</div>;
}

export function Section({ title, eyebrow, right, children }: { title: string; eyebrow?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="hx-section-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>{right}</div>
      {children}
    </section>
  );
}

export function Explain({ children }: { children: React.ReactNode }) {
  return <div className="hx-callout" style={{ marginBottom: 16 }}>{children}</div>;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="hx-empty"><Spinner /> <span style={{ marginLeft: 8 }}>{what}…</span></div>;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="hx-callout danger">{error} {onRetry && <button className="hx-btn small" style={{ marginLeft: 10 }} onClick={onRetry}>Retry</button>}</div>;
}

// ------------------------------------------------------------------ formatting
export function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '—';
  const abs = Math.abs(s);
  const f = abs < 60 ? `${Math.round(abs)}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return s >= 0 ? `${f} ago` : `in ${f}`;
}
export const day = (iso?: string | null) => (iso ? String(iso).slice(0, 10) : '—');
export const dt = (iso?: string | null) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');
export const short = (v: string, n = 14) => (v && v.length > n ? `${v.slice(0, Math.ceil(n / 2) + 1)}…${v.slice(-Math.floor(n / 2) + 1)}` : v);
export const pct = (v: number) => `${Math.round((v ?? 0) * 100)}%`;
export const amounts = (rec: Record<string, number>) => Object.entries(rec ?? {}).map(([s, v]) => `${v >= 1000 ? Math.round(v).toLocaleString() : v} ${s}`).join(' + ') || '—';

export const KIND_LABEL: Record<string, string> = {
  infrastructure_cluster: 'Infrastructure', shared_certificate: 'Certificates', kit_family: 'Scam kit', operator_indicator: 'Operator link', cash_out: 'Cash-out',
  convergence_wallet: 'Money', money_flow: 'Money', rotation: 'Rotation', reappearance: 'Reappearance', cross_operation: 'Other operations', contradiction: 'Reality check',
  critical_gap: 'Evidence gap', bridge_entity: 'Choke point', standby_domains: 'Reserve domains', registration_burst: 'Timeline', naming_pattern: 'Naming pattern', deployer: 'Operator link', fresh_activity: 'New activity', forecast: 'Next wave', lifecycle: 'Status', competing_explanation: 'Competing explanations', model_change: 'What changed',
};

export const ROLE_TONE: Record<string, string> = { core: 'core', peripheral: 'peripheral', orphan: 'orphan', context: 'context', commodity: 'commodity' };
export const WALLET_ROLE_TONE: Record<string, string> = { COLLECTION: 'amber', SPLITTER: 'amber', TREASURY: 'red', FEE_RECIPIENT: 'violet', CEX_DEPOSIT: 'blue', EXCHANGE: 'blue', MIXER: 'violet', BRIDGE: 'blue', DEPLOYER: 'red', VICTIM: 'green', INTERMEDIARY: '', UNKNOWN: '' };
export const WALLET_ROLE_LABEL: Record<string, string> = { COLLECTION: 'Collection', SPLITTER: 'Splitter contract', TREASURY: 'Treasury', FEE_RECIPIENT: 'Fee wallet (vendor)', CEX_DEPOSIT: 'Exchange deposit', EXCHANGE: 'Exchange', MIXER: 'Mixer', BRIDGE: 'Bridge', DEPLOYER: 'Deployer', VICTIM: 'Victim', INTERMEDIARY: 'Intermediary', UNKNOWN: 'Unknown', DEX: 'DEX', SERVICE: 'Service' };
