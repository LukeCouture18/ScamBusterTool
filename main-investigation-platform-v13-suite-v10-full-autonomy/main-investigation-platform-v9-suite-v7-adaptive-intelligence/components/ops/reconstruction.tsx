"use client";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { ago, Card, Empty, Pill, post, type Row } from "./ui";

/**
 * Operation Hunter's reconstructions inside Main. Hunter is the platform's deep
 * reconstruction and pursuit engine; Main shows its model at a glance and links
 * down to Hunter for the full evidence. Membership is inference, never proof.
 */
const STATUS_TONE: Record<string, string> = { active: "ok", rotating: "warn", dormant: "dim", dark: "bad", unknown: "dim" };
const STATUS_LABEL: Record<string, string> = { active: "Active", rotating: "Mid-rotation", dormant: "Dormant", dark: "All sites down", unknown: "Building" };

export type Reconstruction = { id: string; external_id: string; code: string; name: string; model_status: string; status_reason: string; headline: string; counts: Row; forecast: Row; top?: Row[]; discoveries?: Row[]; explanations?: Row[]; unknowns?: string[]; campaign_id: string | null; ui_url: string | null; last_change: string; members?: Row[]; proposals?: Row[]; disclaimer?: string; synced_at?: string };

export function ReconstructionList({ data }: { data: { connected: boolean; disclaimer: string; operations: Reconstruction[] } | undefined }) {
  if (!data) return null;
  return (
    <Card className="ops-span-12" title="Reconstructed operations" action={<span className="ops-sub">{data.connected ? "Operation Hunter connected" : "Operation Hunter not connected"}</span>}>
      {data.operations.length ? <ul className="ops-list">{data.operations.map(o => (
        <li key={o.id}>
          <div className="ops-li-top"><strong>{o.code} · {o.name}</strong><span className="ops-right"><Pill tone={STATUS_TONE[o.model_status]}>{STATUS_LABEL[o.model_status] ?? o.model_status}</Pill></span></div>
          <p>{o.headline}</p>
          <p className="ops-sub">{o.status_reason} {Number(o.counts.members ?? 0)} member sites · {Number(o.counts.live ?? 0)} live · {Number(o.counts.dark ?? 0)} down{Number(o.counts.reserve ?? 0) ? ` · ${Number(o.counts.reserve)} reserve` : ""}{o.forecast.status && o.forecast.status !== "unknown" ? ` · next wave ${String(o.forecast.status).replace("_", " ")}` : ""}</p>
          {(o.top ?? []).map((f, i) => <p key={i} className="ops-sub">▸ {String(f.title)}</p>)}
          <p className="ops-sub">{o.campaign_id ? <a href={`/campaigns/${o.campaign_id}`}>Campaign</a> : null}{o.campaign_id && o.ui_url ? " · " : null}{o.ui_url ? <a href={o.ui_url} target="_blank" rel="noreferrer">Open in Hunter <ExternalLink size={11} /></a> : null}{o.last_change ? ` · ${o.last_change}` : ""}</p>
        </li>))}</ul>
        : <Empty>{data.connected ? "No reconstructions yet. The scheduler asks Hunter to reconstruct campaigns and sites where a wallet was observed." : "Connect Operation Hunter (module key operation_hunter) to reconstruct the operations behind campaigns."}</Empty>}
      {data.disclaimer && <p className="ops-sub" style={{ fontSize: 11 }}>{data.disclaimer}</p>}
    </Card>
  );
}

/** Campaign workspace tab: Hunter's model of the operation behind this campaign. */
export function CampaignReconstruction({ campaignId, reconstruction, onRequested }: { campaignId: string; reconstruction: Reconstruction | null | undefined; onRequested: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function request() { setBusy(true); try { await post("/api/v1/operations/reconstruct", { campaign_id: campaignId }); setNote("Queued. The scheduler starts it within budgets; results appear here when Hunter reports back."); onRequested(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  if (!reconstruction) return <Card title="Operation behind this campaign">
    <Empty>Operation Hunter has not reconstructed this campaign yet.</Empty>
    <button className="ops-btn" onClick={request} disabled={busy}>Reconstruct with Operation Hunter</button>
    {note && <p className="ops-sub">{note}</p>}
  </Card>;
  const r = reconstruction;
  return <div className="ops-grid">
    <Card className="ops-span-12" title={`${r.code} · ${r.name}`} action={r.ui_url ? <a href={r.ui_url} target="_blank" rel="noreferrer">Full model in Hunter <ExternalLink size={11} /></a> : undefined}>
      <div className="ops-li-top"><strong>{r.headline}</strong><span className="ops-right"><Pill tone={STATUS_TONE[r.model_status]}>{STATUS_LABEL[r.model_status] ?? r.model_status}</Pill></span></div>
      <p className="ops-sub">{r.status_reason} Last synced {ago(r.synced_at)}.</p>
      {(r.explanations ?? []).map((e, i) => <p key={i}><strong>{String(e.question ?? "")}</strong> {String(e.leading ?? "")}{Number(e.margin ?? 9) < 1.5 && e.runnerUp ? ` — or ${String(e.runnerUp).toLowerCase()} (undecided). To decide: ${String(e.test ?? "")}` : ""}</p>)}
      {(r.unknowns ?? []).length > 0 && <p className="ops-sub">Still unknown: {(r.unknowns ?? []).join(" · ")}</p>}
    </Card>
    <Card className="ops-span-7" title="Strongest discoveries">
      {(r.discoveries ?? []).length ? <ul className="ops-list">{(r.discoveries ?? []).map((f, i) => <li key={i}><strong>{String(f.title)}</strong><p>{String(f.why ?? "")}</p><p className="ops-sub">Uncertainty: {String(f.uncertainty ?? "")} · Does not prove: {String(f.does_not_prove ?? "")}</p><p>Next: {String(f.next_step ?? "")}</p></li>)}</ul> : <Empty>No findings yet.</Empty>}
    </Card>
    <Card className="ops-span-5" title="Members (inferred)">
      {(r.members ?? []).length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Site / wallet</th><th>Role</th><th>State</th></tr></thead><tbody>{(r.members ?? []).map((m, i) => <tr key={i} title={String(m.why ?? "")}><td className="ops-mono">{String(m.canonical_key).slice(0, 44)}</td><td>{String(m.role)} {m.entity_type === "site" ? `${Math.round(Number(m.probability) * 100)}%` : ""}</td><td>{String(m.state)}</td></tr>)}</tbody></table></div> : <Empty>No members reported.</Empty>}
      <p className="ops-sub" style={{ fontSize: 11 }}>{r.disclaimer}</p>
    </Card>
    <Card className="ops-span-12" title="What Hunter proposed and what the platform did">
      {(r.proposals ?? []).length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Proposal</th><th>Why</th><th>Platform</th></tr></thead><tbody>{(r.proposals ?? []).map((p, i) => <tr key={i}><td>{String(p.kind).replace(/_/g, " ")}<br /><span className="ops-mono">{String(p.target_key).slice(0, 48)}</span></td><td>{String(p.reason)}</td><td><Pill>{String(p.outcome).replace(/_/g, " ")}</Pill>{p.work_status ? <> <Pill tone="dim">{String(p.work_status)}</Pill></> : null}</td></tr>)}</tbody></table></div> : <Empty>No proposals yet.</Empty>}
    </Card>
  </div>;
}
