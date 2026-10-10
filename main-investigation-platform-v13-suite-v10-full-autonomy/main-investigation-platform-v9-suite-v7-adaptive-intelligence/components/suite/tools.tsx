"use client";
/** Wallet Investigator, Wallet Logger, Form Submitter and Operation Hunter inside Main. */
import Link from "next/link";
import { useState } from "react";
import { Crosshair, ExternalLink, ScanLine, Send, Wallet } from "lucide-react";
import { useSuiteContext } from "./context";
import { ReadyToReport, type ReportSummary } from "./wallet-pipeline";
import { ActionButton, ago, Basis, Card, Empty, ErrorNote, EvidenceList, Loading, Pill, short, Stat, Tabs, ToolHead, useJson, Why, type Row } from "./kit";

type Mod = Array<{ module: string; state: string; seen: string | null }>;

// ------------------------------------------------------------------------------ Wallet Investigator

type WalletRow = { id: string; key: string; address: string; network: string; investigations: number; analysis: string; seen_by: string[]; updated_at: string };
type WalletDetail = { id: string; key: string; address: string; network: string; explain: string[]; sites: Array<{ domain: string; source: string; observed: boolean }>;
  counterparties: Array<{ key: string; type: string; confidence: number }>; transactions: Array<{ hash: string; direction: string; amount: string; asset: string; at: unknown }>;
  evidence: Row[]; findings: Array<{ type: string; title: string; body: string; source: string }>; analysis: { status: string; at: string } | null; operations: Row[]; note: string };

export function WalletsTool() {
  const { data, error } = useJson<{ wallets: WalletRow[]; modules: Mod }>("/api/v1/suite/wallets", 20000);
  const { ctx, set, href } = useSuiteContext();
  const [tab, setTab] = useState<"summary" | "flow" | "connections" | "evidence">("summary");
  const sel = ctx.wallet ?? "";
  const { data: w, error: werr, reload } = useJson<WalletDetail>(sel ? `/api/v1/suite/wallet?id=${encodeURIComponent(sel)}` : null, 20000);
  return <div className="mip-page">
    <ToolHead icon={<Wallet size={26} />} title="Wallet Investigator" modules={data?.modules}
      sub="Follows a wallet on public blockchain records: what it received, where the money went and which sites show it. Read-only: nothing is ever sent to a wallet." />
    <ErrorNote error={error} />
    <div className="mip-grid list-detail">
      <Card title="Wallets">{!data ? <Loading /> : data.wallets.length ? <ul className="mip-list">{data.wallets.map(x => <li key={x.id} className={`mip-item${sel === x.key ? " selected" : ""}`}>
        <button className="mip-btn ghost small" style={{ justifyContent: "space-between", width: "100%" }} onClick={() => set({ wallet: x.key })}><code>{short(x.address, 10)}</code><Pill>{x.analysis}</Pill></button>
        <span className="mip-meta">{x.network} · {x.investigations} investigation{x.investigations === 1 ? "" : "s"} · seen by {x.seen_by.join(", ") || "Main"}</span>
      </li>)}</ul> : <Empty>No wallets yet. Wallets arrive from site investigations and from Wallet Logger.</Empty>}</Card>
      <div className="mip-stack">
        {!sel ? <Empty>Pick a wallet to see its money flow.</Empty> : !w ? (werr ? <ErrorNote error={werr} /> : <Loading lines={5} />) : <>
          <Card title={<div style={{ display: "grid", gap: 4 }}><code style={{ fontSize: 14 }}>{w.address}</code><span className="mip-meta">{w.network}{w.analysis ? ` · analysis ${w.analysis.status} ${ago(w.analysis.at)}` : " · not analysed yet"}</span></div>}
            action={<ActionButton primary body={{ action: "analyze_wallet", wallet: w.key }} onDone={reload}>{w.analysis ? "Analyse again" : "Analyse wallet"}</ActionButton>}>
            <Tabs tabs={[{ id: "summary", label: "Summary" }, { id: "flow", label: "Flow", count: w.transactions.length }, { id: "connections", label: "Connections", count: w.sites.length + w.counterparties.length }, { id: "evidence", label: "Evidence", count: w.evidence.length }]} value={tab} onChange={setTab} />
            {tab === "summary" && <div className="mip-stack">
              <ul className="mip-list">{w.explain.map((e, i) => <li key={i}>{e}</li>)}</ul>
              {w.findings.length > 0 && <div><h3>What the analysis flagged</h3><ul className="mip-list" style={{ marginTop: 8 }}>{w.findings.map((f, i) => <li key={i} className="mip-item"><div className="mip-spread"><b>{f.title}</b><Basis basis="analysis" /></div><span className="mip-meta">{f.body}</span></li>)}</ul></div>}
              <p className="mip-meta">{w.note}</p>
            </div>}
            {tab === "flow" && (w.transactions.length ? <div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Direction</th><th>Amount</th><th>Transaction</th><th>When</th></tr></thead><tbody>
              {w.transactions.map((t, i) => <tr key={i}><td><Pill tone={t.direction.startsWith("in") ? "ok" : "warn"}>{t.direction || "?"}</Pill></td><td>{t.amount} {t.asset}</td><td><code>{short(t.hash, 8)}</code></td><td>{t.at ? String(t.at).slice(0, 16) : ""}</td></tr>)}
            </tbody></table></div> : <Empty>No transactions recorded yet. Analyse the wallet to read its public history.</Empty>)}
            {tab === "connections" && <div className="mip-stack">
              <div><h3>Sites showing this wallet</h3>{w.sites.length ? <ul className="mip-list" style={{ marginTop: 8 }}>{w.sites.map(s => <li key={s.domain} className="mip-spread">
                <Link href={href("/finder", { site: s.domain })} onClick={() => set({ site: s.domain })}>{s.domain}</Link><span className="mip-row"><span className="mip-meta">{s.source}</span><Basis basis={s.observed ? "observed" : "analysis"} /></span></li>)}</ul> : <Empty>No site recorded.</Empty>}</div>
              <div><h3>Counterparties</h3>{w.counterparties.length ? <ul className="mip-list" style={{ marginTop: 8 }}>{w.counterparties.map(c => <li key={c.key} className="mip-spread"><code>{short(c.key, 14)}</code><span className="mip-meta">{c.type.replace(/_/g, " ")}</span></li>)}</ul> : <Empty>None recorded.</Empty>}
                <p className="mip-meta">A counterparty is an address this wallet transacted with. It is an on-chain link, not an identity.</p></div>
              {w.operations.length > 0 && <div><h3>Operation Hunter</h3>{w.operations.map((o, i) => <p key={i} className="mip-meta"><Link href={href("/hunter", { op: String(o.external_id) })}>{String(o.name)}</Link>: {String(o.role).toLowerCase()} wallet (analysis).</p>)}</div>}
            </div>}
            {tab === "evidence" && <EvidenceList items={w.evidence} />}
          </Card>
        </>}
      </div>
    </div>
  </div>;
}

// ------------------------------------------------------------------------------ Wallet Logger

type Logger = { captures: Array<{ id: string; wallet: string; network: string; site: string; page: string; confidence: number; at: string }>; sites: Array<{ domain: string; wallets: number; last: string }>;
  sync: { last_capture: string | null; last_sync: string | null; records: number }; note: string };

export function LoggerTool() {
  const { data, error } = useJson<Logger>("/api/v1/suite/logger", 15000);
  const { set, href } = useSuiteContext();
  const [tab, setTab] = useState<"recent" | "sites" | "wallets">("recent");
  const wallets = new Map<string, { wallet: string; network: string; sites: Set<string>; last: string }>();
  for (const c of data?.captures ?? []) { const w = wallets.get(c.wallet) ?? { wallet: c.wallet, network: c.network, sites: new Set<string>(), last: c.at }; if (c.site) w.sites.add(c.site); wallets.set(c.wallet, w); }
  return <div className="mip-page">
    <ToolHead icon={<ScanLine size={26} />} title="Wallet Logger" sub="The browser extension records wallet addresses shown on pages you visit yourself and sends them to Main. It is passive: it never navigates, clicks or submits anything."
      modules={data ? [{ module: "crypto_wallet_logger", state: data.sync.last_sync ? "online" : "not_connected", seen: data.sync.last_sync }] : undefined} />
    <ErrorNote error={error} />
    {!data ? <Loading /> : <>
      <div className="mip-stats" style={{ marginBottom: 14 }}><Stat label="Captures shown" value={data.captures.length} /><Stat label="Sites" value={data.sites.length} /><Stat label="Last capture" value={data.sync.last_capture ? ago(data.sync.last_capture) : "none"} /><Stat label="Records received" value={data.sync.records} /></div>
      <Tabs tabs={[{ id: "recent", label: "Recent captures", count: data.captures.length }, { id: "sites", label: "Sites", count: data.sites.length }, { id: "wallets", label: "Wallets", count: wallets.size }]} value={tab} onChange={setTab} />
      {tab === "recent" && (data.captures.length ? <Card><div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Wallet</th><th>Network</th><th>Site</th><th>Captured</th><th /></tr></thead><tbody>
        {data.captures.map(c => <tr key={c.id}><td><code>{short(c.wallet, 10)}</code></td><td>{c.network}</td><td>{c.site ? <Link href={href("/finder", { site: c.site })} onClick={() => set({ site: c.site })}>{c.site}</Link> : "—"}</td><td>{ago(c.at)}</td>
          <td><Link className="mip-btn small" href={href("/wallets", { wallet: `${c.network}:${c.wallet}` })} onClick={() => set({ wallet: `${c.network}:${c.wallet}` })}>Follow</Link></td></tr>)}
      </tbody></table></div></Card> : <Empty>No captures yet. Install the extension, set Main’s address in its settings, and browse a site you are investigating.</Empty>)}
      {tab === "sites" && (data.sites.length ? <Card><ul className="mip-list">{data.sites.map(s => <li key={s.domain} className="mip-spread"><Link href={href("/finder", { site: s.domain })} onClick={() => set({ site: s.domain })}>{s.domain}</Link><span className="mip-meta">{s.wallets} wallet{s.wallets > 1 ? "s" : ""} · {ago(s.last)}</span></li>)}</ul></Card> : <Empty>No sites yet.</Empty>)}
      {tab === "wallets" && (wallets.size ? <Card><ul className="mip-list">{[...wallets.values()].map(w => <li key={w.wallet} className="mip-spread"><code>{short(w.wallet, 12)}</code><span className="mip-meta">{w.network} · {w.sites.size} site{w.sites.size === 1 ? "" : "s"}</span></li>)}</ul></Card> : <Empty>No wallets yet.</Empty>)}
      <p className="mip-meta" style={{ marginTop: 14 }}>{data.note}</p>
    </>}
  </div>;
}

// ------------------------------------------------------------------------------ Form Submitter

type Report = { id: string; investigation_id: string; title: string; site: string | null; status: string; stage: string; verification: string; approval: string | null; evidence: number; wallets: number;
  checks: Array<{ label: string; ok: boolean }>; ready_to_approve: boolean; updated_at: string; kind?: string; content_sha256?: string; summary?: ReportSummary | null; warnings?: string[] };

async function decideReport(r: Report, action: "approve" | "reject") {
  // The approval names the exact contents reviewed; Main refuses it if the report changed in the meantime.
  const res = await fetch(`/api/v1/investigations/${encodeURIComponent(r.investigation_id)}/report`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: r.id, action, reason: action === "approve" ? "Approved in Form Submitter" : "Rejected in Form Submitter", ...(r.content_sha256 ? { content_sha256: r.content_sha256 } : {}) }) });
  return res.ok;
}

export function ReportsTool() {
  const { data, error, reload } = useJson<{ reports: Report[]; could_prepare: Array<{ investigation_id: string; title: string; evidence: number }>; modules: Mod; note: string }>("/api/v1/suite/reports", 15000);
  const [chosenTab, setTab] = useState<"ready" | "review" | "status" | null>(null);
  const { set, href } = useSuiteContext();
  const review = data?.reports.filter(r => r.status === "needs_review") ?? [];
  const moving = data?.reports.filter(r => r.status !== "needs_review") ?? [];
  const tab=chosenTab??(data&&!review.length?"status":"review");
  return <div className="mip-page">
    <ToolHead icon={<Send size={26} />} title="Form Submitter" modules={data?.modules} sub="Turns an investigation into a report: you check and approve a frozen copy of the evidence, then Form Submitter fills in the reporting form and records the confirmation." />
    <ErrorNote error={error} />
    <Tabs tabs={[{ id: "ready", label: "Ready to prepare", count: data?.could_prepare.length }, { id: "review", label: "Review", count: review.length }, { id: "status", label: "Status", count: moving.length }]} value={tab} onChange={setTab} />
    {!data ? <Loading /> : <>
      {tab === "ready" && (data.could_prepare.length ? <Card title="Investigations with enough evidence"><ul className="mip-list">{data.could_prepare.map(p => <li key={p.investigation_id} className="mip-item">
        <div className="mip-spread"><span className="mip-item-title">{p.title}</span><span className="mip-meta">{p.evidence} evidence items</span></div>
        <div className="mip-row"><ActionButton small primary body={{ action: "prepare_report", investigation_id: p.investigation_id }} onDone={reload}>Prepare report</ActionButton></div></li>)}</ul></Card>
        : <Empty>No investigation has enough evidence for a report yet (at least two captured evidence items).</Empty>)}
      {tab === "review" && (review.length ? <div className="mip-stack">{review.map(r => r.kind === "wallet-report-v4" ? <Card key={r.id} title={r.title} action={<Pill>{r.ready_to_approve ? "ready to report" : "building"}</Pill>}>
        <ReadyToReport investigationId={r.investigation_id} report={{ candidate_id: r.id, state: r.ready_to_approve ? "ready_to_report" : "building", ready: r.ready_to_approve, content_sha256: r.content_sha256, summary: r.summary ?? undefined, warnings: r.warnings }} onDone={() => reload()} />
      </Card> : <Card key={r.id} title={r.title} action={<Pill>{r.status}</Pill>}>
        <div className="mip-grid two">
          <div><h3>Readiness</h3><ul className="mip-list" style={{ marginTop: 8 }}>{r.checks.map(c => <li key={c.label} className="mip-row"><Pill tone={c.ok ? "ok" : "warn"}>{c.ok ? "yes" : "no"}</Pill>{c.label}</li>)}</ul></div>
          <div className="mip-stack">
            <p className="mip-meta" style={{ margin: 0 }}>{r.evidence} evidence items · {r.wallets} wallet{r.wallets === 1 ? "" : "s"}{r.site ? ` · ${r.site}` : ""}</p>
            {r.site && <Link className="mip-btn small" href={href("/finder", { site: r.site })} onClick={() => set({ site: r.site! })}>Check the evidence in Site Finder</Link>}
            <div className="mip-row">
              <button className="mip-btn primary" disabled={!r.ready_to_approve} title={r.ready_to_approve ? "" : "Some readiness checks are not met yet"} onClick={async () => { await decideReport(r, "approve"); reload(); }}>Approve and submit</button>
              <button className="mip-btn ghost" onClick={async () => { await decideReport(r, "reject"); reload(); }}>Reject</button>
            </div>
            <span className="mip-meta">Nothing is filed before you approve. Approving freezes this exact evidence set.</span>
          </div>
        </div>
      </Card>)}</div> : <Empty>No report is waiting for your approval.</Empty>)}
      {tab === "status" && (moving.length ? <Card><div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Report</th><th>Where it is</th><th>Confirmation</th><th>Updated</th></tr></thead><tbody>
        {moving.map(r => <tr key={r.id}><td>{r.title}</td><td>{r.stage}</td><td><Pill>{r.verification}</Pill></td><td>{ago(r.updated_at)}</td></tr>)}</tbody></table></div></Card> : <Empty>No report has been approved yet.</Empty>)}
      <p className="mip-meta" style={{ marginTop: 14 }}>{data.note}</p>
    </>}
  </div>;
}

// ------------------------------------------------------------------------------ Operation Hunter

type Op = Row & { external_id: string; name: string; code: string; model_status: string; status_reason: string; headline: string; counts: Row; forecast: Row; explanations: Row[]; discoveries: Row[]; leads: Row[]; unknowns: string[]; ui_url: string | null; disclaimer: string; members?: Row[]; proposals?: Row[] };
const STATUS: Record<string, string> = { active: "Active", rotating: "Mid-rotation", dormant: "Dormant", dark: "All sites down", unknown: "Still building" };

export function HunterTool() {
  const { ctx, set, href } = useSuiteContext();
  const { data, error } = useJson<{ connected: boolean; disclaimer: string; operations: Op[]; focus: Op | null; modules: Mod }>(`/api/v1/suite/hunter${ctx.op ? `?op=${encodeURIComponent(ctx.op)}` : ""}`, 20000);
  const [tab, setTab] = useState<"briefing" | "leads" | "model" | "evidence">("briefing");
  const op = data?.focus ?? null;
  return <div className="mip-page">
    <ToolHead icon={<Crosshair size={26} />} title="Operation Hunter" modules={data?.modules}
      sub="Reconstructs the operation behind a site: which other sites, wallets and infrastructure belong to it, how it has changed, and what it may do next. Membership is analysis, never proof of who runs it."
      actions={op?.ui_url ? <a className="mip-btn" href={String(op.ui_url)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Full living model</a> : undefined} />
    <ErrorNote error={error} />
    {!data ? <Loading /> : !data.operations.length ? <Empty>No operation reconstructed yet. From a site in Site Finder, choose “Reconstruct the operation”.</Empty> : <div className="mip-grid list-wide">
      <Card title="Operations"><ul className="mip-list">{data.operations.map(o => <li key={o.external_id} className={`mip-item${op?.external_id === o.external_id ? " selected" : ""}`}>
        <button className="mip-btn ghost small" style={{ justifyContent: "space-between", width: "100%" }} onClick={() => set({ op: o.external_id })}><b>{o.name || o.code}</b><Pill tone={o.model_status === "rotating" ? "warn" : o.model_status === "active" ? "ok" : "dim"}>{STATUS[o.model_status] ?? o.model_status}</Pill></button>
        <span className="mip-meta">{String(o.counts?.members ?? 0)} sites · {String(o.counts?.wallets ?? 0)} wallets{o.is_demo ? " · demo" : ""}</span></li>)}</ul></Card>
      {op && <Card title={<div style={{ display: "grid", gap: 4 }}><h2 style={{ fontSize: 18 }}>{op.name || op.code}</h2><span className="mip-meta">{STATUS[op.model_status] ?? op.model_status}: {op.status_reason}</span></div>}>
        <Tabs tabs={[{ id: "briefing", label: "Briefing" }, { id: "leads", label: "Best leads", count: op.leads.length }, { id: "model", label: "Living model" }, { id: "evidence", label: "Evidence", count: (op.members ?? []).length }]} value={tab} onChange={setTab} />
        {tab === "briefing" && <div className="mip-stack">
          <p style={{ margin: 0 }}>{op.headline}</p>
          <Link className="mip-btn" style={{whiteSpace:'normal',maxWidth:'100%'}} href={`/operations/${encodeURIComponent(op.external_id)}`}>Open operation intelligence</Link>
          {op.discoveries.slice(0, 5).map((d, i) => <div key={i} className="mip-item"><b>{String(d.title ?? "")}</b><span className="mip-meta">{String(d.why ?? d.what ?? "")}</span>{d.does_not_prove ? <Why label="What this does not prove"><span>{String(d.does_not_prove)}</span></Why> : null}</div>)}
          {op.forecast?.status && op.forecast.status !== "unknown" ? <div className="mip-note">Next wave: {String(op.forecast.status)}{op.forecast.window ? ` (${String((op.forecast.window as Row).from ?? "").slice(0, 10)} to ${String((op.forecast.window as Row).to ?? "").slice(0, 10)})` : ""}. This is a rhythm-based estimate.</div> : null}
        </div>}
        {tab === "leads" && (op.leads.length ? <ul className="mip-list">{op.leads.map((l, i) => <li key={i} className="mip-item"><b>{String(l.title ?? l.label ?? "")}</b><span className="mip-meta">{String(l.why ?? l.reason ?? "")}</span></li>)}</ul> : <Empty>No open leads.</Empty>)}
        {tab === "model" && <div className="mip-stack">
          <div className="mip-stats">{["members", "probable", "wallets", "live", "dark"].map(k => <Stat key={k} label={k} value={String(op.counts?.[k] ?? 0)} />)}</div>
          {op.explanations.map((e, i) => <div key={i} className="mip-item"><b>{String(e.question ?? e.title ?? "")}</b><span className="mip-meta">{String(e.leading ?? e.summary ?? "")}</span></div>)}
          {op.unknowns.length > 0 && <div><h3>Still unknown</h3><ul className="mip-list" style={{ marginTop: 8 }}>{op.unknowns.map((u, i) => <li key={i} className="mip-meta">• {u}</li>)}</ul></div>}
        </div>}
        {tab === "evidence" && ((op.members ?? []).length ? <div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Member</th><th>Role</th><th>Probability</th><th>Why</th></tr></thead><tbody>
          {(op.members ?? []).map((m, i) => <tr key={i}><td>{String(m.entity_type) === "site" ? <Link href={href("/finder", { site: String(m.canonical_key) })} onClick={() => set({ site: String(m.canonical_key) })}>{String(m.canonical_key)}</Link> : <code>{short(m.canonical_key, 10)}</code>}</td>
            <td>{String(m.role)}</td><td>{Math.round(Number(m.probability ?? 0) * 100)}%</td><td className="mip-meta">{String(m.why ?? "").slice(0, 160)}</td></tr>)}</tbody></table></div> : <Empty>No members synced yet.</Empty>)}
        <p className="mip-meta" style={{ marginTop: 12 }}>{op.disclaimer || data.disclaimer}</p>
      </Card>}
    </div>}
  </div>;
}
