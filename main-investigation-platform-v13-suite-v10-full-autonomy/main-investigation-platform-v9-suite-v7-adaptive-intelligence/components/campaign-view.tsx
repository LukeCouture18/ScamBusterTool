"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleSlash, Gauge, Lightbulb, Loader2, Network, Pause, Play, ShieldQuestion, Sparkles, UserCheck } from "lucide-react";

/**
 * The v4 campaign screen. By default a person sees six things: the campaign's
 * status, what the AI is doing, why it chose that work, useful findings, what
 * needs them, and progress against budget. The relationship graph is one click
 * away; scores, role traces, hypotheses' histories, costs, experience and raw
 * jobs live under Advanced.
 */
type Task = { type: string; id: string; kind: string; domain: string; title: string; instructions: string; investigation: string };
type Finding = { kind: string; title: string; detail: string; investigation?: string | null; status?: string; confidence?: number };
type Overview = {
  id: string; title: string; status: string; status_label: string; doing: string; why: string; stop_reason: string | null;
  progress: { sites: number; investigated: number; in_progress: number; waiting_for_you: number; queued: number; set_aside: number };
  findings: Finding[]; human_tasks: Task[]; next_up: Array<{ kind: string; target: string; reason: string; waiting?: string }>;
  budget: Array<{ label: string; used: number; max: number }>;
  headline_numbers: { useful_investigations: number; new_sites: number; duplicates_avoided: number };
  can: { pause: boolean; resume: boolean; stop: boolean };
};
type GNode = { id: string; type: string; label: string; state?: string };
type GEdge = { id: string; from: string; to: string; kind: string; basis: string; provenance: string };
type Graph = { nodes: GNode[]; edges: GEdge[]; hypotheses: Array<{ id: string; statement: string; status: string; confidence: number; about: string }>; note: string };

const dot = (s: string) => s === "RUNNING" ? "blue" : s === "COMPLETE" ? "green" : s === "PAUSED" || s === "BUDGET_EXHAUSTED" ? "amber" : "grey";
const api = (id: string, path = "") => `/api/v1/campaigns/${encodeURIComponent(id)}${path}`;

export function CampaignView({ campaignId }: { campaignId: string }) {
  const [view, setView] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"overview" | "graph" | "advanced">("overview");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editBudget, setEditBudget] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try { const r = await fetch(api(campaignId), { cache: "no-store" }); if (r.ok) { setView(await r.json()); setErr(""); } } catch { /* transient */ }
  }, [campaignId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    timer.current = window.setInterval(() => void load(), view?.status === "RUNNING" ? 4000 : 15000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [load, view?.status]);

  const control = async (action: "pause" | "resume" | "stop") => {
    setBusy(true);
    try { const r = await fetch(api(campaignId, "/control"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as {error?:{message?:string}}).error?.message ?? "Action failed"); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Action failed"); } finally { setBusy(false); }
  };

  if (!view) return <section className="cmp-card"><p className="cmp-muted">Loading campaign…</p></section>;
  const p = view.progress;
  const running = view.status === "RUNNING";
  return <div className="cmp-wrap">
    <section className="cmp-card cmp-hero">
      <div className="cmp-head">
        <span className={`agent-dot ${dot(view.status)}`} />
        <div className="cmp-title"><h1>{view.title}</h1><span className={`cmp-status ${dot(view.status)}`}>{view.status_label}</span></div>
        <div className="cmp-actions">
          {view.can.pause && <button className="agent-btn" disabled={busy} onClick={() => control("pause")}><Pause size={14} />Pause</button>}
          {view.can.resume && <button className="agent-btn primary" disabled={busy} onClick={() => control("resume")}><Play size={14} />Resume</button>}
          <button className="agent-btn" disabled={busy} onClick={() => setEditBudget(v => !v)}><Gauge size={14} />Budget</button>
          {view.can.stop && <button className="agent-btn ghost" disabled={busy} onClick={() => control("stop")}><CircleSlash size={14} />Stop</button>}
        </div>
      </div>
      <div className="cmp-now">
        {running ? <Loader2 size={18} className="spin" /> : view.status === "COMPLETE" ? <Check size={18} /> : <ShieldQuestion size={18} />}
        <div><strong>{view.doing || "—"}</strong>{view.why && <p><Lightbulb size={13} /><span>{view.why}</span></p>}</div>
      </div>
      {err && <p className="agent-error">{err}</p>}
      {editBudget && <BudgetEditor campaignId={campaignId} budget={view.budget} onSaved={() => { setEditBudget(false); void load(); }} />}
      <div className="cmp-numbers">
        <div><b>{view.headline_numbers.useful_investigations}</b><span>useful investigations</span></div>
        <div><b>{view.headline_numbers.new_sites}</b><span>new sites found</span></div>
        <div><b>{view.headline_numbers.duplicates_avoided}</b><span>duplicates avoided</span></div>
        <div><b>{p.sites}</b><span>sites in campaign</span></div>
      </div>
    </section>

    {view.human_tasks.length > 0 && <section className="cmp-card cmp-tasks">
      <h2><UserCheck size={16} />Needs you <small>{view.human_tasks.length}</small></h2>
      <p className="cmp-muted">Only these sites are paused; the rest of the campaign keeps going.</p>
      {view.human_tasks.map(t => <div className="agent-human" key={t.id}>
        <div className="agent-human-head"><UserCheck size={16} /><strong>{t.title}</strong><span className="cmp-chip">{t.domain}</span></div>
        <p>{t.instructions}</p>
        <div className="agent-human-actions"><Link className="agent-btn primary" href={`/investigations/${encodeURIComponent(t.investigation)}`}>Open investigation<ArrowUpRight size={14} /></Link></div>
      </div>)}
    </section>}

    <nav className="cmp-tabs" aria-label="Campaign views">
      {(["overview", "graph", "advanced"] as const).map(k => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{k === "overview" ? "Overview" : k === "graph" ? "Relationships" : "Advanced"}</button>)}
    </nav>

    {tab === "overview" && <div className="cmp-grid">
      <section className="cmp-card">
        <h2>Progress</h2>
        <div className="cmp-progress" role="img" aria-label="Campaign progress">
          {[["done", p.investigated], ["active", p.in_progress], ["waiting", p.waiting_for_you], ["queued", p.queued], ["aside", p.set_aside]].map(([k, v]) =>
            Number(v) > 0 ? <i key={String(k)} className={String(k)} style={{ flexGrow: Number(v) }} /> : null)}
        </div>
        <ul className="cmp-legend">
          <li><i className="done" />Investigated <b>{p.investigated}</b></li><li><i className="active" />In progress <b>{p.in_progress}</b></li>
          <li><i className="waiting" />Waiting for you <b>{p.waiting_for_you}</b></li><li><i className="queued" />Queued <b>{p.queued}</b></li>
          <li><i className="aside" />Set aside as duplicate or low value <b>{p.set_aside}</b></li>
        </ul>
        <h3>Budget</h3>
        <div className="cmp-budget">{view.budget.map(b => <div key={b.label}><span>{b.label}</span><div className="agent-meter"><i style={{ width: `${b.max ? Math.min(100, Math.round(b.used / b.max * 100)) : 0}%` }} /></div><small>{b.used}/{b.max}</small></div>)}</div>
      </section>
      <section className="cmp-card">
        <h2><Sparkles size={15} />Useful findings</h2>
        {view.findings.length === 0 ? <p className="cmp-muted">Nothing confirmed yet. Findings appear here as investigations produce evidence.</p> :
          <ul className="cmp-findings">{view.findings.map((f, i) => <li key={i} className={f.kind === "hypothesis" ? `hyp ${f.status}` : "site"}>
            <div><strong>{f.title}</strong>{f.kind === "hypothesis" && <span className="cmp-chip">reasoning · {Math.round((f.confidence ?? 0) * 100)}%</span>}</div>
            <p>{f.detail}</p>
            {f.investigation && <Link href={`/investigations/${encodeURIComponent(f.investigation)}`}>Open investigation<ArrowUpRight size={12} /></Link>}
          </li>)}</ul>}
        {view.next_up.length > 0 && <><h3>Next up</h3><ol className="cmp-next">{view.next_up.map((n, i) => <li key={i}><span>{n.kind === "test_hypothesis" ? "Test" : "Investigate"}</span><p>{n.reason.replace(/^(Test|Investigate [^:]+): /, "")}{n.waiting && <em>{n.waiting}</em>}</p></li>)}</ol></>}
      </section>
    </div>}
    {tab === "graph" && <CampaignGraph campaignId={campaignId} />}
    {tab === "advanced" && <CampaignAdvanced campaignId={campaignId} />}
  </div>;
}

function BudgetEditor({ campaignId, budget, onSaved }: { campaignId: string; budget: Overview["budget"]; onSaved: () => void }) {
  const keys: Record<string, string> = { "Investigations": "max_investigations", "Discovery requests": "max_discovery_requests", "Module jobs": "max_module_jobs", "Model calls": "max_model_calls" };
  const [vals, setVals] = useState<Record<string, number>>(Object.fromEntries(budget.map(b => [keys[b.label], b.max])));
  const [err, setErr] = useState("");
  const save = async () => {
    const r = await fetch(api(campaignId, "/budget"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(vals) });
    if (r.ok) onSaved(); else setErr(((await r.json().catch(() => ({}))) as {error?:{message?:string}}).error?.message ?? "Invalid budget");
  };
  return <div className="cmp-budget-edit">
    {budget.map(b => <label key={b.label}><span>{b.label}</span><input type="number" min={b.used} value={vals[keys[b.label]] ?? b.max} onChange={e => setVals(v => ({ ...v, [keys[b.label]]: Number(e.target.value) }))} /><small>used {b.used}</small></label>)}
    <button className="agent-btn primary" onClick={() => void save()}>Save budget</button>{err && <span className="agent-error">{err}</span>}
  </div>;
}

/** Deterministic force layout: same graph, same picture. */
function layout(nodes: GNode[], edges: GEdge[], w: number, h: number) {
  const ids = nodes.map(n => n.id).sort();
  const pos = new Map(ids.map((id, i) => { const a = (i / Math.max(1, ids.length)) * Math.PI * 2; const r = nodes.find(n => n.id === id)?.type === "site" ? 0.25 : 0.42; return [id, { x: w / 2 + Math.cos(a) * w * r, y: h / 2 + Math.sin(a) * h * r }]; }));
  const k = Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.55;
  for (let it = 0; it < 220; it++) {
    const disp = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i])!, b = pos.get(ids[j])!; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (k * k) / d; dx /= d; dy /= d; disp.get(ids[i])!.x += dx * f; disp.get(ids[i])!.y += dy * f; disp.get(ids[j])!.x -= dx * f; disp.get(ids[j])!.y -= dy * f;
    }
    for (const e of edges) { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(0.01, Math.hypot(dx, dy)); const f = (d * d) / k; dx /= d; dy /= d;
      disp.get(e.from)!.x -= dx * f; disp.get(e.from)!.y -= dy * f; disp.get(e.to)!.x += dx * f; disp.get(e.to)!.y += dy * f; }
    const t = 18 * (1 - it / 220) + 0.5;
    for (const id of ids) { const p = pos.get(id)!, d = disp.get(id)!; const m = Math.max(0.01, Math.hypot(d.x, d.y));
      p.x = Math.min(w - 30, Math.max(30, p.x + (d.x / m) * Math.min(m, t) + (w / 2 - p.x) * 0.01)); p.y = Math.min(h - 24, Math.max(24, p.y + (d.y / m) * Math.min(m, t) + (h / 2 - p.y) * 0.01)); }
  }
  return pos;
}
const TYPE_LABEL: Record<string, string> = { site: "Site", wallet: "Wallet", indicator: "Infrastructure", kit: "Kit / template", investigation: "Investigation" };

function CampaignGraph({ campaignId }: { campaignId: string }) {
  const [g, setG] = useState<Graph | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { void (async () => { try { const r = await fetch(api(campaignId, "/graph"), { cache: "no-store" }); if (r.ok) setG(await r.json()); } catch { /* optional */ } })(); }, [campaignId]);
  const W = 860, H = 520;
  const shown = useMemo(() => {
    if (!g) return null;
    // By default show what connects sites: an indicator seen on one site only is detail, not a relationship.
    const degree = new Map<string, number>();
    for (const e of g.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const nodes = g.nodes.filter(n => n.type !== "investigation" && (all || n.type === "site" || (degree.get(n.id) ?? 0) >= 2)).slice(0, 160);
    const ids = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges, pos: layout(nodes, edges, W, H), hidden: g.nodes.filter(n => n.type !== "investigation").length - nodes.length, aside: nodes.filter(n => n.state === "set_aside").length };
  }, [g, all]);
  if (!g || !shown) return <section className="cmp-card"><p className="cmp-muted">Loading relationships…</p></section>;
  const node = sel ? shown.nodes.find(n => n.id === sel) : null;
  const linked = sel ? shown.edges.filter(e => e.from === sel || e.to === sel) : [];
  return <div className="cmp-graph-grid">
    <section className="cmp-card cmp-graph">
      <div className="cmp-graph-head"><h2><Network size={15} />Relationships</h2><ul className="cmp-glegend">{Object.entries(TYPE_LABEL).filter(([k]) => k !== "investigation").map(([k, v]) => <li key={k}><i className={`t-${k}`} />{v}</li>)}</ul></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Campaign relationship graph">
        {shown.edges.map(e => { const a = shown.pos.get(e.from)!, b = shown.pos.get(e.to)!; const on = sel && (e.from === sel || e.to === sel);
          return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`e-${e.kind}${on ? " on" : ""}${sel && !on ? " dim" : ""}`} />; })}
        {shown.nodes.map(n => { const p = shown.pos.get(n.id)!; const on = sel === n.id || linked.some(e => e.from === n.id || e.to === n.id);
          return <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`n t-${n.type} s-${n.state ?? ""}${sel && !on ? " dim" : ""}${sel === n.id ? " sel" : ""}`} onClick={() => setSel(sel === n.id ? null : n.id)}>
            {n.type === "site" ? <circle r={n.state === "set_aside" ? 5 : 9} /> : n.type === "wallet" ? <rect x={-7} y={-7} width={14} height={14} rx={3} /> : <polygon points="0,-8 8,6 -8,6" />}
            {((n.type === "site" && n.state !== "set_aside") || sel === n.id) && <text y={-13}>{n.label}</text>}
          </g>; })}
      </svg>
      <div className="cmp-graph-foot"><p className="cmp-caveat">{g.note}{shown.aside ? ` Small grey sites (${shown.aside}) were set aside as near-duplicates.` : ""}</p>
        {(shown.hidden > 0 || all) && <button className="cmp-link" onClick={() => setAll(v => !v)}>{all ? "Show shared links only" : `Show ${shown.hidden} single-site details`}</button>}</div>
    </section>
    <aside className="cmp-card cmp-side">
      {node ? <>
        <span className="cmp-chip">{TYPE_LABEL[node.type] ?? node.type}{node.state ? ` · ${node.state.replace("_", " ")}` : ""}</span>
        <h3 className="cmp-node-title">{node.label}</h3>
        <h4>Observed links</h4>
        <ul className="cmp-prov">{linked.map(e => <li key={e.id}><strong>{e.kind.replace(/_/g, " ")}</strong><span>{(e.from === node.id ? e.to : e.from).split("|").slice(1).join("|").slice(0, 60)}</span><small>{e.basis} · {e.provenance}</small></li>)}</ul>
      </> : <p className="cmp-muted">Select a node to see its links and where each one came from.</p>}
      <h4>Hypotheses <small>reasoning, not evidence</small></h4>
      <ul className="cmp-hyps">{g.hypotheses.slice(0, 20).map(h => <li key={h.id} className={h.status}><div><span className={`cmp-hstatus ${h.status}`}>{h.status}</span><small>{Math.round(h.confidence * 100)}%</small></div><p>{h.statement}</p><small>{h.about.slice(0, 64)}</small></li>)}</ul>
    </aside>
  </div>;
}

function CampaignSection({id,title,children,open,setOpen}:{id:string;title:string;children:ReactNode;open:string;setOpen:(id:string)=>void}) {
  return <section className="cmp-card cmp-adv"><button className="cmp-adv-toggle" onClick={()=>setOpen(open===id?'':id)}><ChevronDown size={14} className={open===id?'open':''}/>{title}</button>{open===id&&<div className="cmp-adv-body">{children}</div>}</section>;
}

function CampaignAdvanced({ campaignId }: { campaignId: string }) {
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  const [open, setOpen] = useState<string>("queue");
  useEffect(() => { void (async () => { try { const r = await fetch(api(campaignId, "/advanced"), { cache: "no-store" }); if (r.ok) setD(await r.json()); } catch { /* optional */ } })(); }, [campaignId]);
  if (!d) return <section className="cmp-card"><p className="cmp-muted">Loading…</p></section>;
  const opps = d.opportunities as Array<Record<string, unknown>>;
  const traces = d.traces as Array<Record<string, unknown>>;
  const hyps = d.hypotheses as Array<Record<string, unknown>>;
  const econ = d.economics as Record<string, unknown>;
  const exp = d.experience as Array<Record<string, unknown>>;
  const prov = d.provenance as { edges_by_basis_and_source: Array<Record<string, unknown>>; note: string };
  const jobs = d.raw_jobs as Array<Record<string, unknown>>;
  const costs = d.costs as Array<Record<string, unknown>>;
  const num = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v == null ? "—" : String(v);
  return <div className="cmp-adv-wrap">
    <CampaignSection open={open} setOpen={setOpen} id="econ" title="Economics"><ul className="agent-kv">{Object.entries(econ).filter(([, v]) => typeof v !== "object").map(([k, v]) => <li key={k}><span>{k.replace(/_/g, " ")}</span><small>{num(v)}</small></li>)}</ul>
      <h4>Costs</h4><ul className="agent-kv">{costs.map((c, i) => <li key={i}><span>{String(c.kind)} · {String(c.provider ?? "—")}</span><small>{num(c.n)} · {num(c.tokens)} tokens</small></li>)}</ul></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="queue" title={`Opportunity queue and scores (${opps.length})`}><table className="cmp-table"><thead><tr><th>Work</th><th>Status</th><th>Priority</th><th>Factors</th><th>Reason</th></tr></thead><tbody>
      {opps.slice(0, 80).map(o => <tr key={String(o.id)}><td>{String(o.kind).replace(/_/g, " ")}<br /><small>{String(o.target_key).slice(0, 48)}</small></td><td><span className={`agent-tag ${String(o.status)}`}>{String(o.status)}</span></td><td>{num(o.priority)}</td>
        <td><small>{Object.entries(o.factors as Record<string, number>).map(([k, v]) => `${k} ${num(v)}`).join(" · ")}</small></td><td><small>{String(o.reason)}</small></td></tr>)}</tbody></table></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="traces" title={`Role traces (${traces.length})`}><ol className="agent-steps">{traces.slice(0, 60).map((t, i) => <li key={i}><div><strong>tick {String(t.tick)} · {String(t.role)} · {String(t.kind)}</strong>{t.model ? <small>{String(t.model)}</small> : null}</div><pre>{JSON.stringify(t.body, null, 1).slice(0, 900)}</pre></li>)}</ol></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="hyps" title={`Hypotheses (${hyps.length})`}><ol className="agent-steps">{hyps.map(h => <li key={String(h.id)}><div><strong>{String(h.statement)}</strong><span className={`agent-tag ${String(h.status)}`}>{String(h.status)} · {num(h.confidence)}</span></div><p>Observation: {String(h.observation)} · by {String(h.proposed_by)}</p>
      <small>{(h.history as Array<Record<string, unknown>>).map(x => `${String(x.reason)} (${String(x.basis)}${x.to !== undefined ? ` → ${num(x.to)}` : ""})`).join(" · ")}</small></li>)}</ol></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="exp" title="Strategy and experience statistics"><table className="cmp-table"><thead><tr><th>Action</th><th>Context</th><th>Basis</th><th>n</th><th>Useful</th><th>Weight</th></tr></thead><tbody>
      {exp.map((e, i) => <tr key={i}><td>{String(e.action)}</td><td><small>{String(e.context)}</small></td><td>{String(e.basis)}</td><td>{num(e.n)}</td><td>{num(e.useful)}</td><td>{num(e.weight)}</td></tr>)}</tbody></table></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="prov" title="Provenance"><p className="cmp-caveat">{prov.note}</p><ul className="agent-kv">{prov.edges_by_basis_and_source.map((p, i) => <li key={i}><span>{String(p.basis)} · {String(p.source_table)}</span><small>{num(p.n)} edges</small></li>)}</ul></CampaignSection>
    <CampaignSection open={open} setOpen={setOpen} id="jobs" title={`Raw module jobs (${jobs.length})`}><table className="cmp-table"><thead><tr><th>Job</th><th>Module</th><th>Status</th><th>Created</th></tr></thead><tbody>
      {jobs.map(j => <tr key={String(j.id)}><td>{String(j.job_type)}<br /><small>{String(j.id).slice(0, 8)}</small></td><td>{String(j.target_module)}</td><td>{String(j.status)}</td><td><small>{String(j.created_at)}</small></td></tr>)}</tbody></table></CampaignSection>
  </div>;
}

/** The campaigns list with a one-field start form. */
export function CampaignList() {
  const [rows, setRows] = useState<Array<{ id: string; title: string; status: string; status_label: string; doing: string; members: number }> | null>(null);
  const [seed, setSeed] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const r = await fetch("/api/v1/campaigns", { cache: "no-store" }); if (r.ok) setRows(((await r.json()) as {campaigns:Array<{id:string;title:string;status:string;status_label:string;doing:string;members:number}>}).campaigns); } catch { /* transient */ } }, []);
  useEffect(() => { void Promise.resolve().then(load); const t = window.setInterval(() => void load(), 8000); return () => window.clearInterval(t); }, [load]);
  const start = async () => {
    setBusy(true); setErr("");
    try { const r = await fetch("/api/v1/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed_domain: seed.trim() }) });
      const body = (await r.json().catch(() => ({}))) as {error?:{message?:string};id?:string}; if (!r.ok) throw new Error(body.error?.message ?? "Could not start"); window.location.href = `/campaigns/${encodeURIComponent(body.id ?? "")}`; }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not start"); } finally { setBusy(false); }
  };
  return <div className="cmp-wrap">
    <section className="cmp-card cmp-hero">
      <div className="cmp-title"><h1>Campaigns</h1></div>
      <p className="cmp-muted">Start from any site in your inbox. The platform finds the sites, wallets and infrastructure observably linked to it, decides what is most worth investigating next, and asks you only when a person is needed.</p>
      <div className="cmp-start"><input placeholder="Seed site, e.g. example-scam.top" value={seed} onChange={e => setSeed(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && seed.trim()) void start(); }} />
        <button className="agent-btn primary" disabled={busy || !seed.trim()} onClick={() => void start()}><Play size={14} />Start campaign</button></div>
      {err && <p className="agent-error">{err}</p>}
    </section>
    <section className="cmp-card">
      {!rows ? <p className="cmp-muted">Loading…</p> : rows.length === 0 ? <p className="cmp-muted">No campaigns yet.</p> :
        <ul className="cmp-list">{rows.map(r => <li key={r.id}><Link href={`/campaigns/${encodeURIComponent(r.id)}`}>
          <span className={`agent-dot ${dot(r.status)}`} /><div><strong>{r.title}</strong><span>{r.doing}</span></div><small>{r.members} sites</small><span className={`cmp-status ${dot(r.status)}`}>{r.status_label}</span></Link></li>)}</ul>}
    </section>
  </div>;
}
