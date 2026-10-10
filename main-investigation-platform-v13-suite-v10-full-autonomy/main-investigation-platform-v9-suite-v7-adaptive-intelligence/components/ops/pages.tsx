"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Globe, KeyRound, Pause, Play, ShieldAlert, Stamp } from "lucide-react";
import { Advanced, ago, Card, Empty, ErrorNote, Pill, post, Stat, Tabs, useOps, type Row } from "./ui";

/* ------------------------------------------------------------------ Investigations */
export function Investigations() {
  const { data, error } = useOps<{ investigations: Row[] }>("/api/v1/ops/investigations", 20000);
  const { data: q } = useOps<{ items: Row[]; counts: Record<string, number> }>("/api/v1/ops/queue?limit=40", 15000);
  const [tab, setTab] = useState<"investigations" | "queue">("investigations");
  const retry = async (id: string) => { await post("/api/v1/ops/queue", { id, action: "retry" }).catch(() => null); };
  return <div className="ops">
    <div className="ops-head"><div><h1>Investigations</h1><p className="ops-sub">Every investigation the platform ran or is running, with what it found, what is still missing and what changed since.</p></div></div>
    <ErrorNote error={error} />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: "investigations", label: "Investigations", count: data?.investigations.length }, { id: "queue", label: "Work queue", count: q ? (q.counts.queued ?? 0) + (q.counts.running ?? 0) : undefined }]} />
    {tab === "investigations" && <Card>
      {data?.investigations.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Site</th><th>Status</th><th>Wallets</th><th>Evidence</th><th>Open gaps</th><th>Site now</th><th>Last change</th></tr></thead><tbody>
        {data.investigations.map(i => <tr key={String(i.id)}><td><Link href={`/investigations/${i.id}`}><strong className="ops-mono">{String(i.domain ?? i.title)}</strong></Link><br /><span className="ops-sub" style={{ fontSize: 12 }}>{String(i.run_headline ?? "")}</span></td>
          <td><Pill>{String(i.run_status ?? i.status)}</Pill></td><td>{String(i.wallets)}</td><td>{String(i.evidence)}</td><td>{Number(i.open_gaps) ? <Pill tone="warn">{String(i.open_gaps)}</Pill> : "0"}</td><td>{i.site_status ? <Pill>{String(i.site_status)}</Pill> : "–"}</td><td>{i.last_change ? ago(i.last_change) : "–"}</td></tr>)}
      </tbody></table></div> : <Empty>No investigations yet.</Empty>}
    </Card>}
    {tab === "queue" && <Card title="Global opportunity queue" action={q && <span className="ops-sub">{Object.entries(q.counts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</span>}>
      {q?.items.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Work</th><th>Status</th><th>Priority</th><th>Why</th><th /></tr></thead><tbody>
        {q.items.map(w => <tr key={String(w.id)}><td><strong>{String(w.label)}</strong><br /><span className="ops-mono">{String(w.target).slice(0, 56)}</span></td><td><Pill>{String(w.status)}</Pill></td><td>{Number(w.priority).toFixed(2)}</td><td>{String(w.reason)}{w.last_error ? <><br /><span className="ops-sub" style={{ fontSize: 12 }}>{String(w.last_error)}</span></> : null}</td>
          <td>{(w.status === "failed" || w.status === "cancelled") && <button className="ops-btn" onClick={() => retry(String(w.id))}>Retry</button>}</td></tr>)}
      </tbody></table></div> : <Empty>The queue is empty.</Empty>}
    </Card>}
  </div>;
}

/* ------------------------------------------------------------------ Discovery */
export function Discovery({ inbox }: { inbox?: React.ReactNode }) {
  const { data, error, reload } = useOps<Row>("/api/v1/ops/discovery", 20000);
  const control = async (discovery: string) => { await post("/api/v1/ops/control", { discovery }).catch(() => null); reload(); };
  const totals = (data?.totals ?? {}) as Record<string, number>;
  const byDay = (data?.by_day as Row[]) ?? [];
  const max = Math.max(1, ...byDay.map(d => Number(d.n)));
  return <div className="ops">
    <div className="ops-head"><div><h1>Discovery</h1><p className="ops-sub">Site Finder runs continuously: it rotates public sources, learns which ones pay off, pivots on shared infrastructure, avoids ecosystems it has already covered and re-checks sites for changes.</p></div>
      <div className="ops-row">{data?.paused ? <button className="ops-btn primary" onClick={() => control("resume")}><Play size={14} />Resume discovery</button> : <><button className="ops-btn" onClick={() => control("pause_low_priority")}>Pause low-priority</button><button className="ops-btn" onClick={() => control("pause")}><Pause size={14} />Pause discovery</button></>}</div></div>
    <ErrorNote error={error} />
    <div className="ops-stats"><Stat label="Candidates known" value={totals.candidates ?? "–"} /><Stat label="Waiting for review" value={totals.waiting ?? "–"} /><Stat label="Investigated" value={totals.investigated ?? "–"} /><Stat label="Set aside (duplicates, mirrors)" value={totals.suppressed ?? "–"} />
      {Number(data?.min_priority ?? 0) > 0 && <Stat label="Low-priority discovery" value="Paused" attention />}</div>
    <div className="ops-grid">
      <Card className="ops-span-5" title="New candidates, last 14 days">{byDay.length ? <><div className="ops-spark" aria-label="Candidates per day">{byDay.map(d => <i key={String(d.day)} title={`${d.day}: ${d.n}`} style={{ height: `${Math.round((Number(d.n) / max) * 100)}%` }} />)}</div><p className="ops-sub" style={{ fontSize: 11 }}>{byDay[0]?.day as string} → {byDay[byDay.length - 1]?.day as string}</p></> : <Empty>No candidates yet.</Empty>}</Card>
      <Card className="ops-span-7" title="Discovery work">{((data?.work as Row[]) ?? []).length ? <ul className="ops-list">{(data!.work as Row[]).slice(0, 8).map(w => <li key={String(w.id)}><div className="ops-li-top"><strong>{String(w.label)}: <span className="ops-mono">{String(w.target).slice(0, 44)}</span></strong><span className="ops-right"><Pill>{String(w.status)}</Pill></span></div><p>{String(w.reason)}</p></li>)}</ul> : <Empty>No discovery work yet.</Empty>}</Card>
    </div>
    <Advanced label="Discovery cycles and learned yield"><pre className="ops-mono" style={{ whiteSpace: "pre-wrap", color: "var(--ops-muted)", fontSize: 11, margin: 0 }}>{JSON.stringify({ cycles: data?.cycles, learned: data?.learned }, null, 2)}</pre></Advanced>
    {inbox && <Card title="Candidate inbox" action={<span className="ops-sub">Optional: mark sites useful or skip; your decisions train discovery.</span>}>{inbox}</Card>}
  </div>;
}

/* ------------------------------------------------------------------ Human Tasks */
type Task = { content_sha256?:string; summary?:unknown; warnings?:string[]; id: string; type: string; group: "access" | "review" | "approval"; title: string; need: string; detail: string; url: string | null; investigation_id: string | null; subject: string; since: string; resumes: string; actions: Array<{ id: string; label: string }> };
const ICON = { access: KeyRound, review: ShieldAlert, approval: Stamp };
const TYPE_LABEL: Record<string, string> = { login: "Login", captcha: "CAPTCHA", mfa: "MFA", email_verification: "Email verification", analyst_review: "Analyst review", contradiction: "Contradiction", report_approval: "Report approval" };

export function HumanTasks() {
  const { data, error, reload } = useOps<{ tasks: Task[]; counts: Record<string, number> }>("/api/v1/ops/tasks", 15000);
  const [filter, setFilter] = useState<"all" | "access" | "review" | "approval">("all");
  const tasks = useMemo(() => (data?.tasks ?? []).filter(t => filter === "all" || t.group === filter), [data, filter]);
  return <div className="ops">
    <div className="ops-head"><div><h1>Needs You</h1><p className="ops-sub">Only what genuinely needs a person. The platform never logs in, solves CAPTCHAs, completes MFA or verifies email on your behalf; when you finish a step, the work resumes on its own.</p></div></div>
    <ErrorNote error={error} />
    <Tabs value={filter} onChange={setFilter} tabs={[{ id: "all", label: "All", count: data?.tasks.length }, { id: "access", label: "Login / Verification", count: data?.counts.access }, { id: "review", label: "Decision required", count: data?.counts.review }, { id: "approval", label: "Ready to report", count: data?.counts.approval }]} />
    {data && !tasks.length && <Card><Empty>Nothing needs you right now.</Empty></Card>}
    <div style={{ display: "grid", gap: 10 }}>{tasks.map(t => <TaskCard key={`${t.type}:${t.id}`} t={t} done={reload} />)}</div>
  </div>;
}

function TaskCard({ t, done }: { t: Task; done: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const Icon = ICON[t.group] ?? Globe;
  const needsNote = t.type === "contradiction" || t.type === "report_approval";
  async function act(a: string) {
    setBusy(true); setErr(null);
    try {
      if (t.type === "contradiction") await post(`/api/v1/ops/contradictions/${t.id}`, { resolution: a, note });
      else if (t.type === "report_approval") { const r = await fetch(`/api/v1/investigations/${t.investigation_id}/report`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: t.id, action: a, reason: note, ...(t.content_sha256?{content_sha256:t.content_sha256}:{}) }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({})) as Row).message as string ?? "Failed"); }
      else await post(`/api/v1/investigations/${t.investigation_id}/checkpoints/${t.id}`, { action: a });
      done();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  }
  return <article className="ops-task">
    <div className={`ops-task-icon ${t.group}`}><Icon size={16} /></div>
    <div className="ops-task-body">
      <div className="ops-row"><Pill tone={t.group === "access" ? "warn" : t.group === "review" ? "info" : "accent"}>{TYPE_LABEL[t.type] ?? t.type}</Pill><span className="ops-sub" style={{ fontSize: 12 }}>{ago(t.since)}</span></div>
      <h3>{t.title}</h3>
      <p className="ops-sub"><strong style={{ color: "var(--ops-text-2)" }}>What is needed: </strong>{t.need}</p>
      {t.detail && t.detail !== t.need && <p className="ops-sub" style={{ fontSize: 12 }}>{t.detail}</p>}
      <p className="ops-sub" style={{ fontSize: 12 }}>{t.resumes}</p>
      {t.url && <a className="ops-link" href={t.url} target="_blank" rel="noreferrer noopener">Open the site yourself ↗</a>}
      {t.investigation_id && <Link className="ops-link" href={`/investigations/${t.investigation_id}`}>Open investigation</Link>}
      {t.type === "report_approval" && t.summary!=null && <details><summary>Review exact report contents</summary><pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(t.summary,null,2)}</pre>{t.warnings?.map((w,i)=><p key={i}>{w}</p>)}</details>}
      {needsNote && <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Short note for the record (required)" aria-label="Note" />}
      {err && <p className="ops-sub" style={{ color: "var(--ops-bad)" }}>{err}</p>}
    </div>
    <div className="ops-task-actions">{t.actions.map((a, i) => <button key={a.id} className={`ops-btn ${i === 0 ? "primary" : ""}`} disabled={busy || (needsNote && note.trim().length < 3)} onClick={() => act(a.id)}>{a.label}</button>)}</div>
  </article>;
}
