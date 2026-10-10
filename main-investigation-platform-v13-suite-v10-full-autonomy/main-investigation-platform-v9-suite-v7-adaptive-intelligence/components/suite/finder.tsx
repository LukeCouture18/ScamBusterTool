"use client";
import Link from "next/link";
import { useState } from "react";
import { ExternalLink, Radar } from "lucide-react";
import { useSuiteContext } from "./context";
import { InvestigationBriefing } from "./director";
import { WalletPipelineCard } from "./wallet-pipeline";
import { ActionButton, ago, Basis, Card, Empty, ErrorNote, EvidenceList, Loading, Pill, runAction, Stat, Steps, Tabs, ToolHead, useJson, Why, type Row } from "./kit";

type Cand = { assessment?:Row; discovery_quality?:Row; id: string; domain: string; url: string; status: string; headline: string; category: string; worth_checking: number; found_by: string; decision: string | null;
  investigation_id: string | null; wallets: string[]; why: string[]; route: { route: string; depth: number; from: string | null } | null; related: string[]; note: string; stage?: string; created_at?: string;
  because?: { because: string; steps: string[]; hops: number; hunt: string; uncertainty: string; caveat: string } | null; value?: number | null; new_family?: boolean; returned_from?: string | null };
type Hunt = { id: string; kind: string; title: string; state: string; operation: string | null; found: number; useful: number; searches: number; open_pivots: number; followed_pivots: number; stop_reason: string; reported_at: string };
type Finder = { queue: Cand[]; working: Cand[]; skipped_7d: number; hunts: Hunt[]; discovery: { open_requests: number; last: { status: string; at: string } | null; routes: Array<{ route: string; count: number }> };
  modules: Array<{ module: string; state: string; seen: string | null }> };
type Site = { domain: string; url: string; candidate: Cand | null; summary: string[]; next: string[]; investigations: Row[]; evidence: Row[]; wallets: Row[]; related: Row[];
  jobs: Row[]; reports: Row[]; operations: Row[]; campaigns: Row[]; note: string };

const ROUTE: Record<string, string> = {
  page_asset: "a public page scan of the same build file", page_title: "a public page scan with the same page title", page_favicon: "a public page scan with the same icon",
  page_ip: "a public page scan on the same server", ct_domain: "certificate logs", ct_stem: "certificate logs for the name pattern", pdns_ip: "passive DNS for the server address",
  pdns_ns: "passive DNS for a private name server", local_join: "an indicator shared with sites already seen", name_pattern: "a variant of the site's name",
  page_host: "a public page scan of sites using the same API or chat host", page_term: "recent public page scans with scam vocabulary in the title",
  linked_site: "a domain named in the site's own code",
};
const ROUTE_LABEL: Record<string, string> = {
  ct_terms: "Certificate searches", ct_learned: "Names learned from useful sites", ct_frontier: "New name patterns", cert_siblings: "Shared certificates", pattern_siblings: "Name variants",
  brand_typos: "Brand look-alikes", feeds: "Public scam reports", mentions: "Named on review sites", recheck: "Parked sites that changed", investigation_pivot: "Investigation paths",
  "pivot:page_asset": "Same build file (page scans)", "pivot:page_title": "Same page title (page scans)", "pivot:page_favicon": "Same icon (page scans)", "pivot:pdns_ns": "Private name server",
  "pivot:pdns_ip": "Same server address", "pivot:ct_domain": "Certificate names", "pivot:ct_stem": "Name pattern (certificates)", "pivot:name_pattern": "Name variants", "pivot:local_join": "Shared indicator",
  "pivot:pu": "Hunts", "pivot:page_host": "Same API or chat host (page scans)", "pivot:page_term": "Exploring new scan titles", "pivot:linked_site": "Named in a site's own code",
};
const SKIPS = [["not_a_scam", "Not a scam"], ["dead_or_parked", "Dead or parked"], ["duplicate", "Duplicate"], ["not_crypto", "Not crypto"], ["not_useful", "Not useful"]] as const;

function CandidateCard({ c, onInvestigate, onDecided }: { c: Cand; onInvestigate: (d: string) => void; onDecided: () => void }) {
  const [skip, setSkip] = useState<string>("not_a_scam");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function decide(decision: "useful" | "skip") {
    setBusy(true);
    const r = await runAction({ action: "review", domain: c.domain, decision, ...(decision === "skip" ? { reason: skip } : {}) });
    setBusy(false); setNote(r.message); if (r.ok) onDecided();
  }
  return <li className="mip-item" data-domain={c.domain}>
    <div className="mip-spread">
      <span className="mip-item-title">{c.domain}</span>
      <span className="mip-row" style={{ gap: 6 }}><Pill tone="info">{c.found_by}</Pill>{c.route && c.route.depth >= 2 ? <Pill tone="ok">{c.route.depth} pivots away</Pill> : null}{c.wallets.length ? <Pill>{c.wallets.length} wallet{c.wallets.length > 1 ? "s" : ""}</Pill> : null}</span>
    </div>
    <span>{c.headline || "No headline"}</span>
    {Boolean(c.discovery_quality?.category)&&<span className="mip-meta">{String(c.discovery_quality?.category)} · {c.discovery_quality?.new?'New to known deployments':'Already known'}. {String(c.discovery_quality?.next??'Main evaluates useful public follow-up.')}</span>}
    {c.assessment&&<dl className="mip-grid two" aria-label="Candidate confidence">
      <div><dt>Investigation priority</dt><dd>{String((c.assessment.investigation_priority as Row)?.label)}</dd></div>
      <div><dt>Relationship confidence</dt><dd>{String(c.assessment.relationship_confidence)}</dd></div>
      <div><dt>Evidence quality</dt><dd>{String((c.assessment.evidence_quality as Row)?.label)}</dd></div>
      <div><dt>Evidence independence</dt><dd>{String((c.assessment.evidence_independence as Row)?.known_origins)} known origins · {String((c.assessment.evidence_independence as Row)?.unknown_origin_units)} unknown unit</dd></div>
      <div><dt>Novelty</dt><dd>{Number(c.assessment.novelty)>=.8?'New or returning deployment':'Some prior context'}</dd></div>
      <div><dt>Expected investigation value</dt><dd>{Number(c.assessment.expected_investigation_value)>=.5?'Worth bounded collection':'Low'}</dd></div>
    </dl>}
    {c.assessment&&<Why label="Evidence meaning / uncertainty"><p>{String(c.assessment.meaning)}</p>
      {(c.assessment.important_uncertainty as string[]??[]).map(t=><p key={t}>{t}</p>)}
      {(c.assessment.does_not_prove as string[]??[]).map(t=><p key={t}>Does not prove: {t}</p>)}
      <p>Next: {String(c.assessment.recommended_next_action)}</p></Why>}
    {c.because ? <span className="mip-meta" data-because>{c.because.because}</span> : null}
    {c.why.slice(0, 2).map((w, i) => <span key={i} className="mip-meta">• {w}</span>)}
    {c.because && c.because.steps.length > 0 && <Why label="How was it found?">
      <ol className="mip-list" style={{ paddingLeft: 18, listStyle: "decimal" }}>{c.because.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
      <span className="mip-meta">{c.because.hunt ? `Part of the hunt “${c.because.hunt}”. ` : ""}{c.because.uncertainty}</span>
      <span className="mip-meta">{c.because.caveat}</span>
    </Why>}
    <Why>
      {c.route && <p style={{ margin: 0 }}>Reached through {ROUTE[c.route.route.split("+")[0]] ?? c.route.route}{c.route.from ? ` starting from ${c.route.from}` : ""}.</p>}
      {c.why.slice(2).map((w, i) => <span key={i}>• {w}</span>)}
      <span className="mip-meta">Score {Math.round(c.worth_checking * 100)}/100 (software estimate of how likely it is worth your time){c.value != null ? `; expected investigation value ${Math.round(c.value * 100)}/100 (new family, return or depth raise it)` : ""}.</span>
      <span className="mip-meta">{c.note}</span>
    </Why>
    <div className="mip-row">
      <a className="mip-btn small" href={c.url} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={13} />Open site</a>
      <button className="mip-btn small" onClick={() => onInvestigate(c.domain)}>Investigate</button>
      <button className="mip-btn small good" disabled={busy} onClick={() => decide("useful")}>Useful</button>
      <select className="mip-input" style={{ height: 28 }} aria-label="Skip reason" value={skip} onChange={e => setSkip(e.target.value)}>{SKIPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button className="mip-btn small ghost" disabled={busy} onClick={() => decide("skip")}>Skip</button>
    </div>
    {note && <span className="mip-meta" role="status">{note}</span>}
  </li>;
}

export function SiteInvestigation({ domain }: { domain: string }) {
  const { data, error, reload } = useJson<Site>(domain ? `/api/v1/suite/site?domain=${encodeURIComponent(domain)}` : null, 15000);
  const { href, set } = useSuiteContext();
  if (!domain) return <Empty>Pick a site from Find sites (or type one in the search above) to see everything the tools know about it.</Empty>;
  if (!data) return error ? <ErrorNote error={error} /> : <Loading lines={5} />;
  const invJobs = data.jobs.filter(j => ["INVESTIGATE_SITE", "RECHECK_SITE"].includes(String(j.type)));
  const stage = data.reports.length ? 5 : data.operations.length ? 4 : data.wallets.length ? 3 : invJobs.some(j => j.status === "completed") ? 2 : data.candidate?.decision ? 1 : 0;
  const inv = data.investigations[0];
  return <div className="mip-stack" data-site={data.domain}>
    <Card title={<div style={{ display: "grid", gap: 6 }}><h2 style={{ fontSize: 20 }}>{data.domain}</h2>
      <Steps steps={["Found", "Reviewed", "Investigated", "Wallets", "Operation", "Report"]} at={stage} /></div>}
      action={<a className="mip-btn small" href={data.url} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={13} />Open site</a>}>
      <div className="mip-grid two">
        <div className="mip-stack">
          <div><h3>What we know</h3><ul className="mip-list" style={{ marginTop: 8 }}>{data.summary.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          {data.next.length > 0 && <div><h3>What you could do next</h3><ul className="mip-list" style={{ marginTop: 8 }}>{data.next.map((s, i) => <li key={i} className="mip-meta">→ {s}</li>)}</ul></div>}
        </div>
        <details><summary>Advanced investigation controls</summary><div className="mip-stack">
          <ActionButton primary={stage < 2} body={{ action: "investigate_site", domain: data.domain }} onDone={reload}>{stage < 2 ? "Investigate site" : "Investigate again"}</ActionButton>
          <ActionButton body={{ action: "find_related", domain: data.domain }} onDone={reload}>Find related sites</ActionButton>
          <ActionButton body={{ action: "reconstruct_operation", domain: data.domain }} onDone={reload}>Reconstruct the operation</ActionButton>
          {inv && data.evidence.length >= 2 && !data.reports.length && <ActionButton body={{ action: "prepare_report", investigation_id: String(inv.id) }} onDone={reload}>Prepare a report</ActionButton>}
        </div></details>
      </div>
    </Card>
    {inv && <InvestigationBriefing investigationId={String(inv.id)} />}
    <WalletPipelineCard domain={data.domain} />
    <div className="mip-grid two">
      <Card title={`Evidence (${data.evidence.length})`}><EvidenceList items={data.evidence} empty="No evidence yet. Investigate the site to collect page evidence." /></Card>
      <div className="mip-stack">
        <Card title={`Wallets (${data.wallets.length})`}>{data.wallets.length ? <ul className="mip-list">{data.wallets.map(w => <li key={String(w.key)} className="mip-item">
          <div className="mip-spread"><code>{String(w.address)}</code><Pill>{String(w.network)}</Pill></div>
          <span className="mip-meta">Seen by {(w.seen_by as string[]).join(", ")}</span>
          <div className="mip-row"><Link className="mip-btn small" href={href("/wallets", { wallet: String(w.key) })} onClick={() => set({ wallet: String(w.key) })}>Follow the money</Link></div>
        </li>)}</ul> : <Empty>No wallet collected yet.</Empty>}</Card>
        <Card title="Operation">{data.operations.length ? <ul className="mip-list">{(data.operations as Row[]).map(o => <li key={String(o.external_id)} className="mip-item">
          <span className="mip-item-title">{String(o.name ?? o.code)}</span><span className="mip-meta">{String(o.headline ?? "")}</span>
          <Link className="mip-btn small" href={href("/hunter", { op: String(o.external_id) })}>Open in Operation Hunter</Link></li>)}</ul>
          : <Empty>Not part of a reconstructed operation yet.</Empty>}</Card>
        <Card title="Connections">{data.related.length ? <ul className="mip-list">{data.related.slice(0, 12).map((r, i) => <li key={i} className="mip-spread">
          <span className="mip-meta">{String(r.type).replace(/_/g, " ")} → <code>{String(r.key)}</code></span><Basis basis={String(r.kind) === "observed" ? "observed" : "analysis"} /></li>)}</ul>
          : <Empty>No connections recorded.</Empty>}<p className="mip-meta" style={{ marginTop: 8 }}>{data.note}</p></Card>
      </div>
    </div>
    <Why label="Details: jobs and investigations">
      {data.jobs.length ? <div className="mip-table-wrap"><table className="mip-table"><thead><tr><th>Work</th><th>Tool</th><th>Status</th><th>Updated</th></tr></thead><tbody>
        {data.jobs.map(j => <tr key={String(j.id)}><td>{String(j.type).replace(/_/g, " ").toLowerCase()}</td><td>{String(j.tool)}</td><td><Pill>{String(j.status)}</Pill></td><td>{ago(j.at)}</td></tr>)}</tbody></table></div> : <span>No module work yet.</span>}
      {data.investigations.map(i => <Link key={String(i.id)} href={`/investigations/${String(i.id)}`}>Open the full investigation record ({String(i.title)})</Link>)}
    </Why>
  </div>;
}

const HUNT_STATE: Record<string, [string, "ok" | "warn" | "dim" | "info"]> = { active: ["Hunting", "ok"], parked: ["Paused", "warn"], exhausted: ["Finished", "dim"], done: ["Finished", "dim"] };

function HuntsView({ hunts, routes, open, last }: { hunts: Hunt[]; routes: Array<{ route: string; count: number }>; open: number; last: { status: string; at: string } | null }) {
  const active = hunts.filter(h => h.state === "active"), rest = hunts.filter(h => h.state !== "active");
  const row = (h: Hunt) => <li key={h.id} className="mip-item" data-hunt={h.kind}>
    <div className="mip-spread"><span className="mip-item-title">{h.title}</span><Pill tone={HUNT_STATE[h.state]?.[1] ?? "dim"}>{HUNT_STATE[h.state]?.[0] ?? h.state}</Pill></div>
    <span className="mip-meta">{h.found ? `Found ${h.found} site${h.found > 1 ? "s" : ""} worth a look${h.useful ? `, ${h.useful} confirmed useful` : ""}` : "Nothing new yet"} · {h.followed_pivots} lead{h.followed_pivots === 1 ? "" : "s"} followed{h.open_pivots ? `, ${h.open_pivots} still to follow` : ""}</span>
    {h.stop_reason ? <span className="mip-meta">{h.stop_reason}</span> : null}
  </li>;
  return <div className="mip-grid two">
    <div className="mip-stack">
      <Card title="Hunting now" action={<span className="mip-meta">Site Finder pursues each clue until it finds something new or knows to stop</span>}>
        {active.length ? <ul className="mip-list">{active.slice(0, 20).map(row)}</ul> : <Empty>No hunt running. Hunts start when you mark a site useful, when Operation Hunter or an investigation asks for more sites, or when a known site goes dark.</Empty>}
      </Card>
      {rest.length > 0 && <Why label={`Paused and finished hunts (${rest.length})`}><ul className="mip-list">{rest.slice(0, 40).map(row)}</ul></Why>}
    </div>
    <div className="mip-stack">
      <Card title="How hunts work">
        <ul className="mip-list">
          <li>One clue becomes a small tree of searches: from a site to what its pages expose (build files, support chat, API host, analytics account, page title) and on to the sites that reuse them.</li>
          <li>Promising branches get more searches; branches that keep returning nothing, copies, or ordinary websites are stopped. A hunt pauses when it stops finding anything new.</li>
          <li>Part of the effort always goes to exploring for kinds of scam site nobody has reviewed yet.</li>
          <li>A shared kit, host or chat service is a reason to look, never proof that the same people run both sites.</li>
        </ul>
      </Card>
      <Why label="Details: where new sites came from this week">
        {routes.length ? <ul className="mip-list">{routes.map(r => <li key={r.route} className="mip-spread"><span>{ROUTE_LABEL[r.route] ?? r.route.replace(/_/g, " ")}</span><b>{r.count}</b></li>)}</ul> : <span>No discoveries yet this week.</span>}
        <span className="mip-meta">{open} discovery request{open === 1 ? "" : "s"} open{last ? ` · last activity ${ago(last.at)}` : ""}.</span>
      </Why>
    </div>
  </div>;
}

export function FinderTool() {
  const { data, error, reload } = useJson<Finder>("/api/v1/suite/finder", 12000);
  const { ctx, set } = useSuiteContext();
  const [chosenTab, setTab] = useState<"find" | "investigate" | "hunts" | null>(null);
  const tab=chosenTab??(ctx.site?"investigate":"find");
  const [lookup, setLookup] = useState("");
  const investigate = (d: string) => { set({ site: d }); setTab("investigate"); };
  return <div className="mip-page">
    <ToolHead icon={<Radar size={26} />} title="Site Finder" modules={data?.modules}
      sub="Finds new scam sites you would not find yourself, explains why each is worth a look, and investigates the ones you pick: page evidence, wallets and related sites."
      actions={<form className="mip-row" onSubmit={e => { e.preventDefault(); if (lookup.trim()) investigate(lookup.trim().toLowerCase()); }}>
        <input className="mip-input" placeholder="Look up a site…" value={lookup} onChange={e => setLookup(e.target.value)} aria-label="Look up a site" /><button className="mip-btn">Open</button></form>} />
    <ErrorNote error={error} />
    <Tabs tabs={[{ id: "find", label: "Find sites", count: data?.queue.length }, { id: "investigate", label: "Investigate", count: data?.working.length }, { id: "hunts", label: "Hunts", count: data?.hunts.filter(h => h.state === "active").length }]} value={tab} onChange={setTab} />
    {tab === "find" && (!data ? <Loading /> : <div className="mip-grid two">
      <Card title="Worth a look now" action={<span className="mip-meta">Best first · you decide</span>}>
        {data.queue.length ? <ul className="mip-list">{data.queue.map(c => <CandidateCard key={c.id} c={c} onInvestigate={investigate} onDecided={reload} />)}</ul>
          : <Empty>Nothing waiting. Site Finder keeps searching in the background and only brings you sites that are new to the investigation.</Empty>}
      </Card>
      <div className="mip-stack">
        <Card title="Your reviews"><div className="mip-stats"><Stat label="Waiting" value={data.queue.length} attention={data.queue.length > 0} /><Stat label="Useful, in progress" value={data.working.length} /><Stat label="Skipped this week" value={data.skipped_7d} /></div></Card>
        <Card title="Why these sites"><p className="mip-meta" style={{ margin: 0 }}>Site Finder skips sites Main or Operation Hunter already hold, mirrors of sites you have seen, and parked or dead pages. What reaches you is new to the investigation. Every reason shown is an observation or a software estimate, never a conclusion that a site is a scam.</p></Card>
      </div>
    </div>)}
    {tab === "investigate" && (ctx.site ? <SiteInvestigation domain={ctx.site} /> : !data ? <Loading /> : <Card title="Sites you marked useful">
      {data.working.length ? <ul className="mip-list">{data.working.map(c => <li key={c.id} className="mip-item"><div className="mip-spread"><span className="mip-item-title">{c.domain}</span><Pill tone="info">{c.stage ?? ""}</Pill></div>
        <div className="mip-row"><button className="mip-btn small" onClick={() => investigate(c.domain)}>Open</button></div></li>)}</ul> : <Empty>Nothing in progress. Mark a site useful, or look one up above, to investigate it.</Empty>}
    </Card>)}
    {tab === "hunts" && (!data ? <Loading /> : <HuntsView hunts={data.hunts} routes={data.discovery.routes} open={data.discovery.open_requests} last={data.discovery.last} />)}
  </div>;
}
