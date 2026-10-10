"use client";
import Link from "next/link";
import { useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { Advanced, ago, Bar, BUDGET_LABEL, Card, Empty, ErrorNote, fmt, Pill, post, Stat, useOps, type Row } from "./ui";
import { ReconstructionList, type Reconstruction } from "./reconstruction";

type Item = { id: string; label: string; target: string; status: string; reason: string; priority: number; campaign_id: string | null; investigation_id: string | null; not_before: string | null; last_error: string | null; updated_at: string };
type Overview = {
  state: string; paused: boolean; discovery_paused: boolean; headline: string; last_tick_minutes: number | null;
  running: Item[]; next: Item[]; campaigns: Row[]; discoveries: { new_24h: number; top: Row[] }; findings: { new_wallets_24h: number; recent: Row[] };
  human_tasks: number; throughput: { done_24h: number; useful_24h: number; failed_24h: number; by_kind: Array<{ label: string; n: number; useful: number }> };
  budgets: Array<{ kind: string; used: number; max: number; share: number }>; ai_activity: { decisions: Row[]; roles: Row[] }; health: { status: string; modules: Row[]; failed_work: number };
  reconstructions?: { connected: boolean; disclaimer: string; operations: Reconstruction[] };
};
const STATE_LABEL: Record<string, string> = { working: "Working", idle: "Idle", paused: "Paused", degraded: "Needs attention" };
const CHANGE: Record<string, string> = { deposit_appeared: "Deposit page appeared", wallet_changed: "Deposit wallet changed", site_returned: "Site came back", related_domain_appeared: "New related domain" };

export function Operations() {
  const { data, error, reload } = useOps<Overview>("/api/v1/ops/overview", 10000);
  const [busy, setBusy] = useState(false);
  async function control(body: Row) { setBusy(true); try { await post("/api/v1/ops/control", body); await reload(); } finally { setBusy(false); } }
  async function tick() { setBusy(true); try { await post("/api/v1/ops/tick", {}); await reload(); } finally { setBusy(false); } }
  if (!data) return <div className="ops"><h1>Operations</h1><ErrorNote error={error} />{!error && <Empty>Loading…</Empty>}</div>;
  const d = data;
  return (
    <div className="ops">
      <div className="ops-head">
        <div><h1>Operations</h1><p className="ops-sub">The platform discovers, prioritizes and investigates on its own within your budgets and safety rules. It asks for you only when a person is needed.</p></div>
        <div className="ops-row">
          <button className="ops-btn" onClick={tick} disabled={busy} title="Run one scheduling pass now"><RefreshCw size={14} />Run now</button>
          {d.paused ? <button className="ops-btn primary" onClick={() => control({ scheduler: "resume" })} disabled={busy}><Play size={14} />Resume operations</button>
            : <button className="ops-btn" onClick={() => control({ scheduler: "pause" })} disabled={busy}><Pause size={14} />Pause operations</button>}
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="ops-banner" aria-live="polite">
        <span className={`ops-state ${d.state}`} />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}><strong>{STATE_LABEL[d.state] ?? d.state} · {d.headline}</strong>
          <span className="ops-sub">{d.last_tick_minutes == null ? "The scheduler has not run yet." : `Last scheduling pass ${d.last_tick_minutes} min ago.`} {d.discovery_paused ? "Discovery is paused." : ""}</span></div>
        {d.human_tasks > 0 && <Link className="ops-btn" style={{ marginLeft: "auto" }} href="/tasks">{d.human_tasks} task{d.human_tasks === 1 ? " needs" : "s need"} you</Link>}
      </div>
      <div className="ops-stats">
        <Stat label="Useful results (24h)" value={d.throughput.useful_24h} hint={`${d.throughput.done_24h} work items finished`} />
        <Stat label="New wallets (24h)" value={d.findings.new_wallets_24h} hint="observed by modules" />
        <Stat label="New candidates (24h)" value={d.discoveries.new_24h} hint="from continuous discovery" />
        <Stat label="Active campaigns" value={d.campaigns.filter(c => c.status === "RUNNING").length} hint={`${d.campaigns.length} open`} />
        <Stat label="Human tasks" value={d.human_tasks} hint={d.human_tasks ? "waiting for you" : "none waiting"} attention={d.human_tasks > 0} />
      </div>
      <div className="ops-grid">
        <Card className="ops-span-7" title="What the platform is doing" action={<Link href="/investigations">All work</Link>}>
          {d.running.length ? <ul className="ops-list">{d.running.map(w => <WorkRow key={w.id} w={w} />)}</ul> : <Empty>Nothing is running right now.</Empty>}
          <h3>Up next</h3>
          {d.next.length ? <ul className="ops-list">{d.next.slice(0, 5).map(w => <WorkRow key={w.id} w={w} />)}</ul> : <Empty>The queue is empty.</Empty>}
        </Card>
        <Card className="ops-span-5" title="Campaigns" action={<Link href="/campaigns">View all</Link>}>
          {d.campaigns.length ? <ul className="ops-list">{d.campaigns.map(c => (
            <li key={String(c.id)}><div className="ops-li-top"><Link href={`/campaigns/${c.id}`}><strong>{String(c.title)}</strong></Link><span className="ops-right"><Pill>{String(c.status)}</Pill></span></div>
              <p>{String(c.goal || c.headline || "")}</p><p>{Number(c.sites)} sites · {Number(c.wallets)} wallet links{c.origin === "auto" ? " · formed automatically" : ""}</p></li>))}</ul>
            : <Empty>No campaigns yet. Linked sites form one automatically when the graph supports it.</Empty>}
        </Card>
        {(d.reconstructions?.connected || (d.reconstructions?.operations.length ?? 0) > 0) && <ReconstructionList data={d.reconstructions} />}
        <Card className="ops-span-4" title="Recent discoveries" action={<Link href="/discovery">Discovery</Link>}>
          {d.discoveries.top.length ? <ul className="ops-list">{d.discoveries.top.map(x => <li key={String(x.domain)}><div className="ops-li-top"><strong className="ops-mono">{String(x.domain)}</strong><span className="ops-right ops-sub">{Number(x.score).toFixed(2)}</span></div><p>{String(x.headline ?? "")}</p></li>)}</ul> : <Empty>No new candidates in the last day.</Empty>}
        </Card>
        <Card className="ops-span-4" title="Findings">
          {d.findings.recent.length ? <ul className="ops-list">{d.findings.recent.map((f, i) => <li key={i}><div className="ops-li-top"><strong className="ops-mono">{String(f.domain)}</strong><span className="ops-right ops-sub">{ago(f.detected_at)}</span></div><p>{CHANGE[String(f.change_kind)] ?? String(f.change_kind)}</p></li>)}</ul> : <Empty>No new findings this week.</Empty>}
        </Card>
        <Card className="ops-span-4" title="Budgets today">
          {d.budgets.map(b => <div key={b.kind} className="ops-budget"><span>{BUDGET_LABEL[b.kind] ?? b.kind}</span><Bar share={b.share} /><small>{fmt(b.used)} / {fmt(b.max)}</small></div>)}
          <p className="ops-sub" style={{ fontSize: 11 }}>Work that would exceed a limit waits; it is never dropped.</p>
        </Card>
        <Card className="ops-span-6" title="AI activity">
          <p className="ops-sub" style={{ fontSize: 12 }}>Models only propose. Every proposal is validated by deterministic policy before anything runs, and model output is never recorded as evidence.</p>
          {d.ai_activity.decisions.length ? <ul className="ops-list">{d.ai_activity.decisions.map(x => <li key={String(x.id)}><div className="ops-li-top"><strong>{String(x.role).replace(/_/g, " ")}</strong><span className="ops-right"><Pill tone={x.accepted ? "ok" : "dim"}>{x.accepted ? "accepted" : "not used"}</Pill></span></div><p>{String(x.task).replace(/_/g, " ")} · {String(x.provider ?? "no model")} · {ago(x.created_at)}</p></li>)}</ul>
            : <Empty>No model calls recently: deterministic planning handled everything.</Empty>}
        </Card>
        <Card className="ops-span-6" title="Throughput (24h)">
          {d.throughput.by_kind.length ? <table className="ops-table"><thead><tr><th>Work</th><th>Finished</th><th>Useful</th></tr></thead><tbody>{d.throughput.by_kind.map(k => <tr key={k.label}><td>{k.label}</td><td>{k.n}</td><td>{k.useful}</td></tr>)}</tbody></table> : <Empty>No work finished in the last day.</Empty>}
          {d.throughput.failed_24h > 0 && <p className="ops-sub">{d.throughput.failed_24h} item(s) failed after retries. They are kept; retry them from the queue.</p>}
        </Card>
      </div>
      <Telemetry />
    </div>
  );
}

function WorkRow({ w }: { w: Item }) {
  const link = w.campaign_id ? `/campaigns/${w.campaign_id}` : w.investigation_id ? `/investigations/${w.investigation_id}` : null;
  const title = <strong>{w.label}: <span className="ops-mono">{w.target.length > 48 ? w.target.slice(0, 48) + "…" : w.target}</span></strong>;
  return <li><div className="ops-li-top">{link ? <Link href={link}>{title}</Link> : title}<span className="ops-right"><Pill>{w.status}</Pill></span></div><p>{w.reason}{w.status === "deferred" && w.last_error ? ` — ${w.last_error}` : ""}</p></li>;
}

function Telemetry() {
  return <Advanced label="System telemetry"><TelemetryBody /></Advanced>;
}

function TelemetryBody() {
  const { data } = useOps<Row>("/api/v1/ops/advanced", 0);
  if (!data) return <Empty>Loading…</Empty>;
  const h = data.health as Row;
  const routing = (data.routing as Row[]) ?? [];
  return <div className="ops-grid">
    <Card className="ops-span-6" title="Health"><dl className="ops-kv"><dt>Status</dt><dd><Pill>{String(h.status)}</Pill></dd><dt>Queue</dt><dd>{JSON.stringify(h.queue)}</dd><dt>Jobs (24h)</dt><dd>{JSON.stringify(h.jobs_24h)}</dd><dt>Retries (24h)</dt><dd>{String(h.retries_24h)}</dd><dt>AI failures (24h)</dt><dd>{String(h.ai_failures_24h)}</dd><dt>Stale investigations</dt><dd>{((h.stale_investigations as Row[]) ?? []).length}</dd><dt>Stuck campaigns</dt><dd>{((h.stuck_campaigns as Row[]) ?? []).length}</dd><dt>Database</dt><dd>{JSON.stringify(h.database)}</dd></dl></Card>
    <Card className="ops-span-6" title="Model routing">{routing.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Provider / model</th><th>Task</th><th>Calls</th><th>OK</th><th>Tokens</th><th>Cost</th><th>Useful</th></tr></thead><tbody>{routing.map((r, i) => <tr key={i}><td>{String(r.provider)} / {String(r.model)} <small>({String(r.tier)})</small></td><td>{String(r.task)}</td><td>{String(r.calls)}</td><td>{String(r.ok)}</td><td>{fmt(r.tokens)}</td><td>{Number(r.cost ?? 0).toFixed(3)}</td><td>{r.useful == null ? "–" : Number(r.useful).toFixed(2)}</td></tr>)}</tbody></table></div> : <Empty>No model calls recorded.</Empty>}</Card>
    <Card className="ops-span-12" title="Scheduler, learning, experiments, simulations and decisions"><pre className="ops-mono" style={{ whiteSpace: "pre-wrap", color: "var(--ops-muted)", fontSize: 11, margin: 0, maxHeight: 420, overflow: "auto" }}>{JSON.stringify({ scheduler: data.scheduler, learning: data.learning, experiments: data.experiments, simulations: data.simulations, decisions: data.decisions, team_artifacts: data.artifacts, settings: data.settings }, null, 2)}</pre></Card>
  </div>;
}
