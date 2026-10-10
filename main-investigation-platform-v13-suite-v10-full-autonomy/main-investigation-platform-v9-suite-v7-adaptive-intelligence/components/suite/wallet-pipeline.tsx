"use client";
/** v4 wallet pipeline: what Wallet Logger saw on this site, what Wallet Investigator made of it, and the report it builds. */
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { ago, Card, Empty, ErrorNote, Pill, short, Stat, useJson, Why } from "./kit";

type Where = { page_url: string; page_title: string | null; method: string; context: string; first_seen: string; seen: number; after_interaction: boolean };
type PWallet = { id: string; address: string; family: string; network: string | null; context: string; context_confidence: number;
  why: { cues: string[]; negative: string[]; section: string | null; snippet: string | null } | null; where: Where[];
  validation: { status: string; network: string | null; checksum: string | null; reasons: string[] }; analysis: string; in_report: boolean };
type DepositEvidence = { evidence_id: string; sha256: string | null; page_url: string; observed_at: string; method: string; section: string | null; cues: string[]; snippet: string | null };
export type ReportSummary = { site?: { domain: string; url: string } | null; wallets?: Array<{ identity: string; address: string; network: string; token: string | null; validation_status: string; checksum: string | null;
  deposit_evidence: DepositEvidence[]; observations: number; analysis_status: string; blockchain_evidence: Array<{ evidence_id: string; sha256: string | null; title: string }>; also_seen_on: string[] }>;
  destination?: { kind: string; form_id: string; form_url: string; version_hash: string; title: string } | null; note?: string };
export type PReport = { candidate_id?: string; status?: string; state: string; ready?: boolean; content_sha256?: string; summary?: ReportSummary; warnings?: string[]; verification?: string;
  submission?: { job_status: string | null; message: string | null } | null };
type Pipeline = { investigation_id: string; site: string | null; watching: { logger_last_seen: string | null };
  counts: { observations: number; wallets: number; validated: number; rejected: number; ambiguous: number; pending: number; confirmed_deposit: number };
  wallets: PWallet[]; likely_pages: Array<{ url: string; score: number; why: string }>; report: PReport };

const VALIDATION: Record<string, string> = { valid: "valid", invalid: "rejected: invalid", unsupported: "rejected: unsupported chain", network_ambiguous: "network unclear",
  unable_to_validate: "could not validate", pending: "waiting", queued: "validating" };
const REPORT_STATE: Record<string, string> = { waiting: "Waiting for a confirmed deposit wallet", building: "Report building", ready_to_report: "Ready to report",
  approved: "Approved, Form Submitter is filing it", submitted: "Submitted", stale: "Approval withdrawn: the report changed", superseded: "Replaced by a newer draft", blocked: "Rejected" };

/** Approve & Submit binds the approval to the exact contents the person is looking at (content_sha256). */
export async function decideWalletReport(investigationId: string, candidateId: string, contentSha256: string | undefined, action: "approve" | "reject"): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`/api/v1/investigations/${encodeURIComponent(investigationId)}/report`, { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidate_id: candidateId, action, reason: action === "approve" ? "Approved the exact report shown in Main" : "Rejected in Main", ...(contentSha256 ? { content_sha256: contentSha256 } : {}) }) });
  if (res.ok) return { ok: true, message: action === "approve" ? "Approved. Form Submitter will file this exact report and stop for you if the form asks for a login or verification." : "Rejected." };
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
  return { ok: false, message: body.error?.message ?? `Main refused the decision (${res.status}).` };
}

/** The "Ready to report" summary: site, wallets, networks, deposit evidence, blockchain evidence, destination and warnings. */
export function ReadyToReport({ investigationId, report, onDone }: { investigationId: string; report: PReport; onDone: (result: { ok: boolean; message: string }) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const s = report.summary ?? {}, wallets = s.wallets ?? [], warnings = report.warnings ?? [];
  const networks = [...new Set(wallets.map(w => w.network))];
  const decide = async (action: "approve" | "reject") => {
    if (!report.candidate_id) return;
    setBusy(true); const result = await decideWalletReport(investigationId, report.candidate_id, report.content_sha256, action); setNote(result); setBusy(false); onDone(result);
  };
  return <div className="mip-stack" data-report={report.candidate_id}>
    <div className="mip-stats">
      <Stat label="Site" value={s.site?.domain ?? "missing"} attention={!s.site} />
      <Stat label="Confirmed wallets" value={wallets.length} />
      <Stat label="Networks" value={networks.join(", ") || "none"} />
      <Stat label="Destination" value={s.destination?.title || s.destination?.form_id || "not set"} attention={!s.destination} />
    </div>
    {wallets.length > 0 && <ul className="mip-list">{wallets.map(w => <li key={w.identity} className="mip-item">
      <div className="mip-spread"><code style={{ wordBreak: "break-all" }}>{w.address}</code><span className="mip-row"><Pill>{w.network}</Pill>{w.token && <Pill>{w.token}</Pill>}<Pill tone="ok">{w.validation_status}</Pill></span></div>
      <span className="mip-meta">Deposit evidence: {w.deposit_evidence.length} sighting{w.deposit_evidence.length === 1 ? "" : "s"} ({[...new Set(w.deposit_evidence.map(e => e.method))].join(", ")}) · blockchain evidence: {w.blockchain_evidence.length ? `${w.blockchain_evidence.length} item${w.blockchain_evidence.length === 1 ? "" : "s"}` : "none yet"} · analysis {w.analysis_status}</span>
      {w.also_seen_on.length > 0 && <span className="mip-meta">Also seen on {w.also_seen_on.join(", ")} (a link worth checking, not proof of common ownership)</span>}
      <Why label="Deposit evidence">{w.deposit_evidence.map(e => <p key={e.evidence_id} className="mip-meta" style={{ margin: "4px 0" }}>
        <a href={e.page_url} target="_blank" rel="noopener noreferrer nofollow">{e.page_url}</a> · {e.method} · {ago(e.observed_at)}{e.section ? ` · “${e.section}”` : ""}{e.cues.length ? ` · ${e.cues.slice(0, 3).join(", ")}` : ""}<br /><span>evidence {short(e.evidence_id, 6)}{e.sha256 ? ` · sha256 ${short(e.sha256, 6)}` : ""}</span></p>)}</Why>
    </li>)}</ul>}
    {warnings.length > 0 && <div className="mip-note" role="status"><b>Warnings</b><ul className="mip-list" style={{ marginTop: 6 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    {report.state === "ready_to_report" && report.candidate_id && <div className="mip-row">
      <button className="mip-btn primary" disabled={busy || !report.ready} onClick={() => decide("approve")}>Approve &amp; Submit</button>
      <button className="mip-btn ghost" disabled={busy} onClick={() => decide("reject")}>Reject</button>
    </div>}
    {note && <div className={`mip-note${note.ok ? "" : " error"}`} role="status">{note.message}</div>}
    <span className="mip-meta">Nothing is filed until you approve. The approval covers exactly this report and destination{report.content_sha256 ? ` (contents ${short(report.content_sha256, 6)})` : ""}; if either changes, you are asked again.</span>
  </div>;
}

export function WalletPipelineCard({ domain }: { domain: string }) {
  const { data, error, reload } = useJson<Pipeline | null>(domain ? `/api/v1/suite/wallet-pipeline?domain=${encodeURIComponent(domain)}` : null, 10000);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  if (error && /No investigation for this site/.test(error)) return <Card title="Wallet pipeline"><Empty>Not watching yet. Browse this site with Wallet Logger switched on (log in yourself if the site needs it) and wallets it shows will appear here.</Empty></Card>;
  if (error) return <Card title="Wallet pipeline"><ErrorNote error={error} /></Card>;
  if (!data) return null;
  const c = data.counts, r = data.report;
  const watching = data.watching.logger_last_seen ? `Watching for wallets · Wallet Logger last synced ${ago(data.watching.logger_last_seen)}` : "Waiting for Wallet Logger: browse this site with the extension switched on";
  return <Card title="Wallet pipeline" action={<span className="mip-meta">{watching}</span>}>
    <div className="mip-stack" data-wallet-pipeline={data.investigation_id}>
      <div className="mip-stats">
        <Stat label="Observations" value={c.observations} />
        <Stat label="Validated" value={c.validated} />
        <Stat label="Rejected" value={c.rejected} />
        <Stat label="Confirmed deposit contexts" value={c.confirmed_deposit} />
        <Stat label="Report" value={REPORT_STATE[r.state] ?? r.state} attention={r.state === "ready_to_report" || r.state === "stale"} />
      </div>
      {c.pending > 0 && <p className="mip-meta" style={{ margin: 0 }}>{c.pending} wallet{c.pending === 1 ? " is" : "s are"} being validated by Wallet Investigator.</p>}
      {data.likely_pages.length > 0 && <div><h3>Likely wallet pages</h3><ul className="mip-list" style={{ marginTop: 8 }}>{data.likely_pages.map(p => <li key={p.url} className="mip-spread">
        <span className="mip-meta">Likely wallet page: <code>{short(p.url, 24)}</code> · {p.why}</span>
        <a className="mip-btn small" href={p.url} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={13} />Open</a></li>)}</ul>
        <p className="mip-meta">Opening a page is up to you. Wallet Logger only records what your browser shows while you browse.</p></div>}
      {data.wallets.length ? <div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Wallet</th><th>Where found</th><th>Context</th><th>Validated</th><th>In report</th></tr></thead><tbody>
        {data.wallets.map(w => <tr key={w.id} onClick={() => setOpen(open === w.id ? null : w.id)} style={{ cursor: "pointer" }} data-wallet={w.address}>
          <td><code>{short(w.address, 8)}</code><br /><span className="mip-meta">{w.network ?? w.family}</span></td>
          <td className="mip-meta">{w.where.length} sighting{w.where.length === 1 ? "" : "s"} · {[...new Set(w.where.map(x => x.method))].join(", ")}</td>
          <td><Pill tone={w.context === "deposit" ? "ok" : ""}>{w.context}</Pill></td>
          <td><Pill tone={w.validation.status === "valid" ? "ok" : ["invalid", "unsupported"].includes(w.validation.status) ? "bad" : "warn"}>{VALIDATION[w.validation.status] ?? w.validation.status}</Pill></td>
          <td>{w.in_report ? <Pill tone="ok">yes</Pill> : <span className="mip-meta">no</span>}</td>
        </tr>)}</tbody></table></div> : <Empty>No wallet seen yet. Browse the site’s deposit pages normally (log in yourself if needed); Wallet Logger picks up what the page shows.</Empty>}
      {open && (() => { const w = data.wallets.find(x => x.id === open); if (!w) return null; return <div className="mip-note" data-wallet-detail={w.address}>
        <p style={{ margin: 0 }}><b>What wallet:</b> <code style={{ wordBreak: "break-all" }}>{w.address}</code> ({w.family}{w.network ? `, ${w.network}` : ""})</p>
        <p style={{ margin: "6px 0 0" }}><b>Where found:</b></p><ul className="mip-list">{w.where.map((x, i) => <li key={i} className="mip-meta">{x.page_url} · {x.method}{x.after_interaction ? " after you interacted" : ""} · read as {x.context} · {ago(x.first_seen)}{x.seen > 1 ? ` · seen ${x.seen}×` : ""}</li>)}</ul>
        <p style={{ margin: "6px 0 0" }}><b>Why {w.context}:</b> {w.why ? [w.why.section ? `section “${w.why.section}”` : "", w.why.cues.join(", "), w.why.negative.length ? `against: ${w.why.negative.join(", ")}` : ""].filter(Boolean).join(" · ") : "no context recorded"}</p>
        {w.why?.snippet && <p className="mip-meta" style={{ margin: "4px 0 0" }}>“{w.why.snippet.slice(0, 240)}”</p>}
        <p style={{ margin: "6px 0 0" }}><b>Validated?</b> {VALIDATION[w.validation.status] ?? w.validation.status}{w.validation.checksum ? ` (${w.validation.checksum.replace(/_/g, " ")})` : ""}. {w.validation.reasons.join(" ")}</p>
        <p style={{ margin: "6px 0 0" }}><b>Analysis:</b> {w.analysis} · <b>In report:</b> {w.in_report ? "yes" : "no"}</p>
      </div>; })()}
      {(r.state === "ready_to_report" || r.state === "building" || r.state === "stale") && r.summary && <div><h3>{REPORT_STATE[r.state]}</h3><div style={{ marginTop: 8 }}><ReadyToReport investigationId={data.investigation_id} report={r} onDone={result => { setNotice(result); reload(); }} /></div></div>}
      {notice && r.state !== "ready_to_report" && <div className={`mip-note${notice.ok ? "" : " error"}`} role="status">{notice.message}</div>}
      {r.state === "approved" && <p className="mip-meta" style={{ margin: 0 }}>Approved. Form Submitter: {r.submission?.message ?? r.submission?.job_status ?? "queued"}.</p>}
      {r.state === "submitted" && <p className="mip-meta" style={{ margin: 0 }}>Submitted · confirmation {r.verification}.</p>}
    </div>
  </Card>;
}
