"use client";
/**
 * Shared building blocks for the five tools. Every screen uses these so the suite reads as one
 * application: same cards, pills, evidence labels, "Why?" disclosures, empty and loading states.
 * Styling lives in sdk/ui/suite.css (the canonical token file the tools' own screens share).
 */
import Link from "next/link";
import {operatorStatus} from "@/sdk/ui/status";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Row = Record<string, unknown>;

export function useJson<T = Row>(url: string | null, intervalMs = 15000) {
  const [snapshot,setSnapshot]=useState<{url:string|null;data:T|null;error:string|null}>({url:null,data:null,error:null});
  const active=useRef<{url:string|null;mounted:boolean;sequence:number;controller:AbortController|null}>({url:null,mounted:false,sequence:0,controller:null});
  const load=useCallback(async(force=false)=>{
    if(!url||active.current.controller&&!force)return;
    active.current.controller?.abort();const controller=new AbortController(),sequence=++active.current.sequence;active.current.controller=controller;
    try{const r=await fetch(url,{cache:'no-store',signal:controller.signal}),j=await r.json().catch(()=>({}));
      if(!active.current.mounted||active.current.url!==url||active.current.sequence!==sequence)return;
      if(r.ok)setSnapshot({url,data:j as T,error:null});
      else setSnapshot(previous=>({url,data:previous.url===url?previous.data:null,error:String((j as Row)?.message??(j as {error?:Row})?.error?.message??r.status)}));
    }catch(e){if(active.current.mounted&&active.current.url===url&&active.current.sequence===sequence&&!controller.signal.aborted)setSnapshot(previous=>({url,data:previous.url===url?previous.data:null,error:e instanceof Error?e.message:'Unavailable'}));}
    finally{if(active.current.sequence===sequence)active.current.controller=null;}
  },[url]);
  useEffect(()=>{
    active.current.url=url;active.current.mounted=true;active.current.controller=null;void Promise.resolve().then(()=>load());
    const timer=intervalMs?setInterval(()=>{if(document.visibilityState!=='hidden')void load();},intervalMs):null;
    return()=>{active.current.mounted=false;active.current.sequence++;active.current.controller?.abort();if(timer)clearInterval(timer);};
  },[url,load,intervalMs]);
  const reload=useCallback(()=>load(true),[load]);
  return {data:snapshot.url===url?snapshot.data:null,error:snapshot.url===url?snapshot.error:null,reload};
}

export async function runAction(body: Row): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch("/api/v1/suite/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Row;
    const msg = String(j.message ?? (j.error as Row | undefined)?.message ?? (r.ok ? "Done." : `Failed (${r.status})`));
    return { ok: r.ok && j.ok !== false, message: msg };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Failed" }; }
}

/** A button that runs one suite action and reports what Main will do, in plain words. */
export function ActionButton({ body, children, primary, small, onDone, title }: { body: Row; children: ReactNode; primary?: boolean; small?: boolean; onDone?: () => void; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);
  return <>
    <button className={`mip-btn${primary ? " primary" : ""}${small ? " small" : ""}`} disabled={busy} title={title}
      onClick={async () => { setBusy(true); const r = await runAction(body); setBusy(false); setNote(r); if (r.ok) onDone?.(); }}>{busy ? "Working…" : children}</button>
    {note && <div className={`mip-toast${note.ok ? "" : " error"}`} role="status">{note.message}</div>}
  </>;
}

export function ago(v: unknown) {
  if (!v) return "";
  const s = String(v); const t = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)} min ago`; if (d < 86400) return `${Math.floor(d / 3600)} h ago`; return `${Math.floor(d / 86400)} d ago`;
}

export function short(v: unknown, n = 10) { const s = String(v ?? ""); return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s; }

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`mip-card ${className}`}>{(title || action) && <div className="mip-card-head">{typeof title === "string" ? <h2>{title}</h2> : title}{action}</div>}{children}</section>;
}

export function Stat({ label, value, attention }: { label: string; value: ReactNode; attention?: boolean }) {
  return <div className={`mip-stat${attention ? " attention" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

const TONE: Record<string, string> = { completed: "ok", done: "ok", useful: "ok", online: "ok", approved: "ok", verified: "ok", live: "ok",
  running: "info", pending: "info", queued: "info", ready: "info", presented: "info", prefilling: "info", submitting: "info", verifying: "info",
  needs_review: "warn", offline: "warn", retrying: "warn", rotating: "warn", skipped: "dim", not_started: "dim", not_connected: "dim",
  failed: "bad", blocked: "bad", dead: "bad", rejected: "bad" };
export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  const t = tone ?? TONE[String(children)] ?? "";
  return <span className={`mip-pill ${t}`}>{typeof children === "string" ? operatorStatus(children) : children}</span>;
}

/** Observed fact vs software analysis vs a person's conclusion — shown on every piece of evidence. */
export function Basis({ basis, label }: { basis: string; label?: string }) {
  const text = label ?? (basis === "observed" ? "Observed" : basis === "person" ? "Analyst" : "Analysis");
  return <span className={`mip-basis ${basis}`} title={basis === "observed" ? "Seen directly on a page or on-chain" : basis === "person" ? "A person's note or conclusion" : "Derived by software from what was observed"}>{text}</span>;
}

export function Why({ label = "Why?", children }: { label?: string; children: ReactNode }) {
  return <details className="mip-why"><summary>{label}</summary><div>{children}</div></details>;
}

export function Empty({ children }: { children: ReactNode }) { return <p className="mip-empty">{children}</p>; }
export function Loading({ lines = 3 }: { lines?: number }) { return <div className="mip-stack" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <div key={i} className="mip-skeleton" style={{ width: `${90 - i * 15}%` }} />)}</div>; }
export function ErrorNote({ error }: { error: string | null }) { return error ? <div className="mip-note error" role="alert">Could not load this: {error}. Main keeps working; this view retries on its own.</div> : null; }

export function ModuleStatus({ modules }: { modules?: Array<{ module: string; state: string; seen: string | null }> }) {
  if (!modules?.length) return null;
  const NAME: Record<string, string> = { site_finder: "discovery", site_investigator: "investigation", wallet_investigator: "Wallet Investigator", crypto_wallet_logger: "extension", form_submitter: "Form Submitter", operation_hunter: "Hunter" };
  return <div className="mip-row" style={{ gap: 12 }}>{modules.map(m => <span key={m.module} className="mip-row mip-meta" style={{ gap: 6 }} title={m.seen ? `Last heard from ${ago(m.seen)}` : "Never connected"}>
    <i className={`mip-dot ${m.state}`} />{NAME[m.module] ?? m.module} {m.state === "online" ? "online" : m.state === "offline" ? `offline${m.seen ? ` · ${ago(m.seen)}` : ""}` : "not connected"}</span>)}</div>;
}

export function ToolHead({ icon, title, sub, modules, actions }: { icon: ReactNode; title: string; sub: string; modules?: Array<{ module: string; state: string; seen: string | null }>; actions?: ReactNode }) {
  return <div className="mip-head">
    <div style={{ display: "grid", gap: 6 }}><h1>{icon}{title}</h1><p className="mip-sub">{sub}</p><ModuleStatus modules={modules} /></div>
    {actions && <div className="mip-row">{actions}</div>}
  </div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (t: T) => void }) {
  return <div className="mip-tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}{t.count != null && <em>{t.count}</em>}</button>)}</div>;
}

/** Evidence with its basis label, source tool and time; raw details only behind "Details". */
export function EvidenceList({ items, empty = "No evidence yet.", show = 6 }: { items: Array<Row>; empty?: string; show?: number }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  const item = (e: Row, i: number) => {
    const b = (e.basis ?? {}) as { label?: string; basis?: string };
    return <li key={String(e.id ?? i)} className="mip-item">
      <div className="mip-spread"><span className="mip-item-title">{String(e.title ?? "")}</span><Basis basis={String(b.basis ?? "analysis")} label={b.label} /></div>
      {e.text ? <span className="mip-meta">{String(e.text)}</span> : null}
      <span className="mip-meta">{String(e.source ?? "")}{e.at ? ` · ${ago(e.at)}` : ""}{e.scope === "authenticated" ? " · seen after a login you did" : ""}</span>
    </li>;
  };
  const rest = items.slice(show);
  return <div className="mip-stack">
    <ul className="mip-list">{items.slice(0, show).map(item)}</ul>
    {rest.length > 0 && <Why label={`Show ${rest.length} more`}><ul className="mip-list">{rest.map((e, i) => item(e, i + show))}</ul></Why>}
  </div>;
}

export function Steps({ steps, at }: { steps: string[]; at: number }) {
  return <div className="mip-steps" aria-label="Workflow">{steps.map((s, i) => <span key={s} className={i < at ? "done" : i === at ? "now" : ""}>{s}</span>)}</div>;
}

export function ToolLink({ href, children }: { href: string; children: ReactNode }) { return <Link className="mip-btn small ghost" href={href}>{children}</Link>; }
