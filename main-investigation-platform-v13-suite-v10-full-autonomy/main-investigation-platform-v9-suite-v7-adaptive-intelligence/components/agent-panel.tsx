"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Bot, Check, ChevronDown, CircleSlash, Loader2, Play, ShieldQuestion, Sparkles, UserCheck } from "lucide-react";

/**
 * The v3 investigation view: what the AI is doing, in plain language, centred on
 * the current case. A person sees a status, a short activity stream, and any
 * human step they need to take. Everything technical — every plan, rejection,
 * budget, model call, inference and knowledge-class breakdown — lives behind
 * the Advanced expander, off by default.
 */
type Human = { id: string; kind: string; title: string; instructions: string; url: string | null };
type Activity = { step: number; capability: string | null; validation: string; text: string; outcome: string | null; at: string };
type View = {
  status: string; phase: string; headline: string; new_evidence: boolean;
  site: { domain: string; url: string } | null;
  counts: { evidence: number; wallets: number; wallets_analyzed: number; related: number } | null;
  waiting_for_human: Human[]; activity: Activity[]; open_questions: string[]; can_start: boolean;
};

const ACTIVE = ["RUNNING", "WAITING_FOR_MODULE"];
const dotClass = (s: string) => s === "WAITING_FOR_HUMAN" ? "amber" : s === "COMPLETE" ? "green" : ACTIVE.includes(s) ? "blue" : s === "FAILED" ? "red" : "grey";

export function AgentPanel({ investigationId }: { investigationId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [adv, setAdv] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try { const r = await fetch(`/api/v1/investigations/${encodeURIComponent(investigationId)}/agent`, { cache: "no-store" });
      if (r.ok) { setView(await r.json()); setErr(""); } } catch { /* transient */ }
  }, [investigationId]);
  const loadAdvanced = useCallback(async () => {
    try { const r = await fetch(`/api/v1/investigations/${encodeURIComponent(investigationId)}/agent/advanced`, { cache: "no-store" }); if (r.ok) setAdv(await r.json()); } catch { /* optional */ }
  }, [investigationId]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    const poll = () => { void load(); if (advanced) void loadAdvanced(); };
    const active = view && ACTIVE.includes(view.status);
    timer.current = window.setInterval(poll, active ? 3000 : 12000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [load, loadAdvanced, advanced, view?.status]);

  const act = useCallback(async (path: string, body?: unknown) => {
    setBusy(true);
    try { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as {error?:{message?:string}}).error?.message ?? "Action failed"); await load(); if (advanced) await loadAdvanced(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }, [load, loadAdvanced, advanced]);

  const toggleAdvanced = async () => { const next = !advanced; setAdvanced(next); if (next && !adv) await loadAdvanced(); };

  if (!view) return <section className="agent-card"><div className="agent-head"><Bot size={18} /><span>AI investigator</span></div><p className="agent-headline">Loading…</p></section>;
  const running = ACTIVE.includes(view.status);
  return <section className="agent-card">
    <div className="agent-head">
      <span className={`agent-dot ${dotClass(view.status)}`} />
      {running ? <Loader2 size={18} className="spin" /> : view.status === "WAITING_FOR_HUMAN" ? <ShieldQuestion size={18} /> : view.status === "COMPLETE" ? <Check size={18} /> : <Bot size={18} />}
      <span className="agent-phase">{view.phase}</span>
      {view.new_evidence && <span className="agent-badge"><Sparkles size={12} /> New evidence found</span>}
      <div className="agent-head-actions">
        {view.can_start && <button className="agent-btn primary" disabled={busy} onClick={() => act(`/api/v1/investigations/${encodeURIComponent(investigationId)}/agent/start`)}><Play size={14} />{view.status === "none" ? "Start AI investigation" : "Investigate again"}</button>}
        {running && <button className="agent-btn" disabled={busy} onClick={() => act(`/api/v1/investigations/${encodeURIComponent(investigationId)}/agent/stop`)}><CircleSlash size={14} />Stop</button>}
      </div>
    </div>
    <p className="agent-headline">{view.headline}</p>
    {err && <p className="agent-error">{err}</p>}
    {view.counts && <div className="agent-counts">
      <span><b>{view.counts.evidence}</b> evidence</span><span><b>{view.counts.wallets}</b> wallets</span>
      <span><b>{view.counts.wallets_analyzed}</b> analysed</span><span><b>{view.counts.related}</b> related</span>
    </div>}

    {view.waiting_for_human.map(h => <div className="agent-human" key={h.id}>
      <div className="agent-human-head"><UserCheck size={16} /><strong>{h.title}</strong></div>
      <p>{h.instructions}</p>
      <div className="agent-human-actions">
        {h.url && <a className="agent-btn primary" href={h.url} target="_blank" rel="noopener noreferrer">Open the site</a>}
        <button className="agent-btn" disabled={busy} onClick={() => act(`/api/v1/investigations/${encodeURIComponent(investigationId)}/checkpoints/${encodeURIComponent(h.id)}`, { action: "done" })}>I&apos;ve done this</button>
        <button className="agent-btn ghost" disabled={busy} onClick={() => act(`/api/v1/investigations/${encodeURIComponent(investigationId)}/checkpoints/${encodeURIComponent(h.id)}`, { action: "cancel" })}>Can&apos;t do this</button>
      </div>
    </div>)}

    {view.activity.length > 0 && <ol className="agent-stream">
      {view.activity.slice(-6).map(a => <li key={a.step} className={a.validation === "rejected" ? "rejected" : ""}>
        <Activity size={13} /><span>{a.text}</span></li>)}
    </ol>}

    <button className="agent-advanced-toggle" onClick={() => void toggleAdvanced()}><ChevronDown size={14} className={advanced ? "open" : ""} />Advanced</button>
    {advanced && <AdvancedView data={adv} />}
  </section>;
}

function bar(used: number, max: number) { return <i style={{ width: `${max ? Math.min(100, Math.round((used / max) * 100)) : 0}%` }} />; }

function AdvancedView({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return <div className="agent-advanced">Loading…</div>;
  const budgets = data.budgets as Record<string, { used: number; max: number }> | null;
  const steps = (data.steps ?? []) as Array<Record<string, unknown>>;
  const inferences = (data.inferences ?? []) as Array<Record<string, unknown>>;
  const modelCalls = (data.model_calls ?? []) as Array<Record<string, unknown>>;
  const kc = (data.knowledge_classes ?? {}) as Record<string, number>;
  const conclusions = (data.analyst_conclusions ?? []) as Array<Record<string, unknown>>;
  return <div className="agent-advanced">
    {budgets && <><h4>Budgets</h4><div className="agent-budgets">
      {Object.entries(budgets).filter(([k]) => k !== "deadline_at").map(([k, v]) => <div key={k}><span>{k.replace(/_/g, " ")}</span><div className="agent-meter">{bar(v.used, v.max)}</div><small>{v.used}/{v.max}</small></div>)}
    </div></>}
    <h4>Knowledge classes</h4>
    <ul className="agent-kv">{Object.entries(kc).map(([k, v]) => <li key={k}><span>{k.replace(/_/g, " ")}</span><small>{v}</small></li>)}</ul>
    <p className="agent-caveat">{String(data.provenance_note ?? "")}</p>
    <h4>Steps</h4>
    <ol className="agent-steps">{steps.map(s => <li key={String(s.step_no)} className={s.validation === "rejected" ? "rejected" : ""}>
      <div><strong>{String(s.capability ?? s.kind)}</strong><span className={`agent-tag ${String(s.validation)}`}>{String(s.validation)}{s.outcome ? ` · ${String(s.outcome)}` : ""}</span></div>
      <p>{String(s.rationale ?? "")}</p>
      {s.validation === "rejected" && <small className="agent-reject">{(s.rejection_reasons as string[] ?? []).join("; ")}</small>}
      {(s.provider || s.model) ? <small>{String(s.provider)} {s.model ? `· ${String(s.model)}` : ""} {s.model_class ? `(${String(s.model_class)})` : ""}</small> : null}
    </li>)}</ol>
    {inferences.length > 0 && <><h4>AI inferences (opinion, not evidence)</h4><ul className="agent-inferences">{inferences.map((i, n) => <li key={n}><span>{String(i.claim)}</span><small>cites {(i.cited_evidence as string[] ?? []).length} evidence · {String(i.status)}</small></li>)}</ul></>}
    {conclusions.length > 0 && <><h4>Analyst conclusions</h4><ul className="agent-inferences">{conclusions.map((c, n) => <li key={n}><span>{String(c.conclusion)}</span><small>{String(c.author)}</small></li>)}</ul></>}
    {modelCalls.length > 0 && <><h4>Model calls</h4><ul className="agent-kv">{modelCalls.map((m, n) => <li key={n}><span>{String(m.provider)} {String(m.model)} ({String(m.model_class)})</span><small>{String(m.status)} · {String(m.latency_ms)}ms · {Number(m.prompt_tokens) + Number(m.completion_tokens)}t</small></li>)}</ul></>}
  </div>;
}
