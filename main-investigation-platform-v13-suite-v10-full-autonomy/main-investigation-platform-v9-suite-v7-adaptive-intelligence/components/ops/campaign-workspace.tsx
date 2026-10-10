"use client";
import { useState } from "react";
import { CampaignView } from "@/components/campaign-view";
import { ago, Card, Empty, ErrorNote, Pill, Tabs, useOps, type Row } from "./ui";
import { CampaignReconstruction, type Reconstruction } from "./reconstruction";

type Gap = { id: string; kind: string; subject: string; status: string; missing: string; known: string[]; safe_actions: Array<{ action: string; how: string } | string>; resolution: string | null; attempts: number };
type Work = { id: string; label: string; target: string; status: string; reason: string; priority: number; result: Row; finished_at: string | null };
type Workspace = { id: string; title: string; status: string; goal: string; goal_revision: number; origin: string; merged_into: string | null; split_from: string | null;
  gaps: Gap[]; queue: Work[]; timeline: Array<{ at: string; kind: string; title: string; detail: Row }>; contradictions: Row[]; activity: Array<{ role: string; kind: string; body: Row; created_at: string }>; members: number; reconstruction?: Reconstruction | null };
type Tab = "summary" | "operation" | "gaps" | "queue" | "timeline" | "activity";

/**
 * v5 Campaign Workspace: the v4 campaign view (status, findings, entities and
 * hypotheses, relationships, budget, human tasks) plus the v5 layers: goal,
 * evidence gaps, the campaign's queue, a timeline of lineage and changes, and
 * the AI team's activity.
 */
export function CampaignWorkspace({ campaignId }: { campaignId: string }) {
  const { data, error, reload } = useOps<Workspace>(`/api/v1/ops/campaigns/${campaignId}`, 15000);
  const [tab, setTab] = useState<Tab>("summary");
  const open = data?.gaps.filter(g => g.status === "open").length ?? 0;
  return (
    <div className="ops">
      {data && <div className="ops-banner">
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <span className="ops-sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>Campaign goal{data.goal_revision > 1 ? ` · revised ${data.goal_revision - 1}×` : ""}</span>
          <strong>{data.goal || "The planner sets a goal on its first pass."}</strong>
          <span className="ops-sub">{data.members} sites · {open} open evidence gap{open === 1 ? "" : "s"}{data.origin === "auto" ? " · formed automatically from graph evidence" : ""}{data.split_from ? " · split from another campaign" : ""}{data.merged_into ? " · merged into another campaign" : ""}</span>
        </div>
      </div>}
      <ErrorNote error={error} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "summary", label: "Summary" }, { id: "operation", label: data?.reconstruction ? `Operation · ${data.reconstruction.code}` : "Operation" }, { id: "gaps", label: "Evidence gaps", count: open }, { id: "queue", label: "Queue", count: data?.queue.filter(q => q.status === "queued" || q.status === "running").length }, { id: "timeline", label: "Timeline" }, { id: "activity", label: "Activity" }]} />
      {tab === "summary" && <CampaignView campaignId={campaignId} />}
      {tab === "operation" && <CampaignReconstruction campaignId={campaignId} reconstruction={data?.reconstruction} onRequested={() => void reload()} />}
      {tab === "gaps" && <Card title="Evidence gaps" action={<span className="ops-sub">Gaps drive what runs next; a resolved gap stops its work.</span>}>
        {data?.gaps.length ? <ul className="ops-list">{data.gaps.map(g => <li key={g.id}>
          <div className="ops-li-top"><strong>{g.missing}</strong><span className="ops-right"><Pill>{g.status}</Pill></span></div>
          <p><span className="ops-mono">{g.subject}</span> · {g.kind.replace(/_/g, " ")}{g.attempts ? ` · ${g.attempts} attempt(s)` : ""}</p>
          {g.known.length > 0 && <p>Known: {g.known.join("; ")}</p>}
          {g.status === "open" && g.safe_actions.length > 0 && <p>Next safe step: {g.safe_actions.map(a => (typeof a === "string" ? a : a.how)).join("; ")}</p>}
          {g.resolution && <p>Outcome: {g.resolution}</p>}
        </li>)}</ul> : <Empty>No evidence gaps recorded for this campaign.</Empty>}
      </Card>}
      {tab === "queue" && <Card title="Campaign queue">
        {data?.queue.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Work</th><th>Status</th><th>Priority</th><th>Why</th></tr></thead><tbody>{data.queue.map(w => <tr key={w.id}><td><strong>{w.label}</strong><br /><span className="ops-mono">{w.target.slice(0, 60)}</span></td><td><Pill>{w.status}</Pill></td><td>{w.priority.toFixed(2)}</td><td>{w.reason}</td></tr>)}</tbody></table></div> : <Empty>No platform work items for this campaign; its own steps run from the Summary view.</Empty>}
      </Card>}
      {tab === "timeline" && <Card title="Timeline" action={<span className="ops-sub">Lineage, observed changes and finished work</span>}>
        {data?.timeline.length ? <ul className="ops-timeline">{data.timeline.map((t, i) => <li key={i} className={t.kind}><strong>{t.title}</strong><small>{ago(t.at)} · {t.kind}</small>{t.kind === "change" && <span className="ops-sub" style={{ fontSize: 12 }}>{JSON.stringify(t.detail.from)} → {JSON.stringify(t.detail.to)}</span>}</li>)}</ul> : <Empty>Nothing has happened yet.</Empty>}
        {data && data.contradictions.length > 0 && <><h3>Contradictions</h3><ul className="ops-list">{data.contradictions.map(c => <li key={String(c.id)}><div className="ops-li-top"><strong>{String(c.detail)}</strong><span className="ops-right"><Pill>{String(c.status)}</Pill></span></div></li>)}</ul></>}
      </Card>}
      {tab === "activity" && <Card title="AI team activity" action={<span className="ops-sub">Typed artifacts; no role can execute anything</span>}>
        {data?.activity.length ? <ul className="ops-list">{data.activity.map((a, i) => <li key={i}><div className="ops-li-top"><strong>{a.role.replace(/_/g, " ")} · {a.kind.replace(/_/g, " ")}</strong><span className="ops-right ops-sub">{ago(a.created_at)}</span></div><p className="ops-mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(a.body).slice(0, 300)}</p></li>)}</ul> : <Empty>No activity recorded yet.</Empty>}
      </Card>}
    </div>
  );
}
