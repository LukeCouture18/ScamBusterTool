"use client";
import { useState, type ReactNode } from "react";
import {useJson} from "../suite/kit";
import { ChevronDown } from "lucide-react";

export type Row = Record<string, unknown>;

/** Fetches JSON and refreshes it on an interval; pauses while the tab is hidden. */
export function useOps<T = Row>(url: string | null, intervalMs = 15000) {return useJson<T>(url,intervalMs);}

export async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((j as Row).message ?? (j as Row).error ?? r.status));
  return j as Row;
}

export function ago(v: unknown) {
  if (!v) return "";
  const s = String(v); const t = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`;
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`ops-card ${className}`}>{(title || action) && <div className="ops-card-head">{typeof title === "string" ? <h2>{title}</h2> : title}{action}</div>}{children}</section>;
}

export function Stat({ label, value, hint, attention }: { label: string; value: ReactNode; hint?: ReactNode; attention?: boolean }) {
  return <div className={`ops-stat ${attention ? "attention" : ""}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

const TONE: Record<string, string> = {
  running: "ok", working: "ok", done: "ok", resolved: "ok", RUNNING: "ok", live: "ok", COMPLETE: "info", complete: "info",
  queued: "info", idle: "info", deferred: "dim", suppressed: "dim", cancelled: "dim", dismissed: "dim", STOPPED: "dim", MERGED: "dim", INACTIVE: "dim",
  waiting_human: "warn", paused: "warn", PAUSED: "warn", BUDGET_EXHAUSTED: "warn", open: "warn", degraded: "bad", failed: "bad", dead: "bad",
};
export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  const t = tone ?? TONE[String(children)] ?? "";
  return <span className={`ops-pill ${t}`}>{typeof children === "string" ? children.replace(/_/g, " ").toLowerCase() : children}</span>;
}

export function Bar({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(1, share));
  return <div className={`ops-bar ${pct >= 1 ? "bad" : pct >= 0.85 ? "warn" : ""}`}><i style={{ width: `${Math.round(pct * 100)}%` }} /></div>;
}

export function Empty({ children }: { children: ReactNode }) { return <p className="ops-empty">{children}</p>; }

export function Advanced({ label = "Advanced", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="ops-adv"><button onClick={() => setOpen(o => !o)} aria-expanded={open}><ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : "none" }} />{label}</button>{open && <div style={{ marginTop: 12, display: "grid", gap: 12 }}>{children}</div>}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (t: T) => void }) {
  return <div className="ops-tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}{t.count != null && <em>{t.count}</em>}</button>)}</div>;
}

export function ErrorNote({ error }: { error: string | null }) { return error ? <div className="ops-callout" role="alert">Could not load: {error}</div> : null; }

export const BUDGET_LABEL: Record<string, string> = { module_jobs: "Module jobs", discovery_requests: "Discovery requests", investigations: "Investigations", model_calls: "Model calls", model_tokens: "Model tokens", model_cost_usd: "Model cost (USD)" };
export function fmt(n: unknown) { const x = Number(n); if (!Number.isFinite(x)) return "–"; if (Math.abs(x) >= 10000) return `${Math.round(x / 1000)}k`; return Number.isInteger(x) ? String(x) : x.toFixed(2); }
