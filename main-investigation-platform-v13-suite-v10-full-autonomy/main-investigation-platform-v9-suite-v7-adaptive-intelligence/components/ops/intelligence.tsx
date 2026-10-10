"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ago, Card, Empty, ErrorNote, Pill, useOps, type Row } from "./ui";

type GNode = { id: string; type: string; key: string; label: string; degree: number };
type GEdge = { id: string; from: string; to: string; kind: string; basis: string; strength: number; active: boolean; provenance: string };
type Graph = { nodes: GNode[]; edges: GEdge[]; reasoning: Row[]; truncated: boolean; note: string };

const TYPES: Array<[string, string, string]> = [["domain", "Sites", "#8b95ff"], ["wallet", "Wallets", "#3fb68b"], ["ip", "Hosting IPs", "#d7a444"], ["nameserver", "Name servers", "#c98a5a"], ["certificate", "Certificates", "#6aa7e8"], ["template", "Templates / kits", "#c07ad6"], ["favicon", "Favicons", "#9a8f7a"], ["identifier", "Public identifiers", "#5fb3b3"], ["campaign", "Campaigns", "#e0626d"]];
const COLOR = Object.fromEntries(TYPES.map(([t, , c]) => [t, c]));
const KINDS = ["hosted_on", "uses_nameserver", "presents_certificate", "uses_template", "shows_favicon", "displays_wallet", "uses_service", "related_site", "member_of", "supports"];

/** Deterministic force layout (seeded, fixed iterations) so the same graph always looks the same. */
function layout(nodes: GNode[], edges: GEdge[], w: number, h: number) {
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  nodes.forEach((n, i) => { const a = (i / Math.max(1, nodes.length)) * Math.PI * 2, r = 0.35 + 0.1 * ((i * 7) % 5) / 5; pos.set(n.id, { x: w / 2 + Math.cos(a) * r * w * 0.8, y: h / 2 + Math.sin(a) * r * h * 0.8, vx: 0, vy: 0 }); });
  const k = Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.5;
  for (let it = 0; it < 220; it++) {
    const t = 1 - it / 220;
    for (const a of nodes) { const pa = pos.get(a.id)!; for (const b of nodes) { if (a === b) continue; const pb = pos.get(b.id)!; const dx = pa.x - pb.x, dy = pa.y - pb.y; const d2 = Math.max(dx * dx + dy * dy, 25); const f = (k * k) / d2; pa.vx += dx * f * 0.01; pa.vy += dy * f * 0.01; } }
    for (const e of edges) { const pa = pos.get(e.from), pb = pos.get(e.to); if (!pa || !pb) continue; const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = ((d - k) / d) * 0.06; pa.vx += dx * f; pa.vy += dy * f; pb.vx -= dx * f; pb.vy -= dy * f; }
    for (const n of nodes) { const p = pos.get(n.id)!; p.vx += (w / 2 - p.x) * 0.012; p.vy += (h / 2 - p.y) * 0.012; p.x = Math.max(24, Math.min(w - 24, p.x + Math.max(-20, Math.min(20, p.vx)) * t)); p.y = Math.max(20, Math.min(h - 20, p.y + Math.max(-20, Math.min(20, p.vy)) * t)); p.vx *= 0.5; p.vy *= 0.5; }
  }
  return pos;
}

export function Intelligence() {
  const [types, setTypes] = useState<string[]>(["domain", "wallet", "ip", "nameserver", "certificate", "template"]);
  const [kind, setKind] = useState("");
  const [minStrength, setMinStrength] = useState(0);
  const [since, setSince] = useState("");
  const [campaign, setCampaign] = useState("");
  const [focus, setFocus] = useState("");
  const [focusInput, setFocusInput] = useState("");
  const [selection, changeSelection] = useState<{url:string;id:string|null}|null>(null);
  const url = useMemo(() => { const p = new URLSearchParams({ types: types.join(","), limit: "90" }); if (kind) p.set("kinds", kind); if (minStrength) p.set("min_strength", String(minStrength)); if (since) p.set("since_days", since); if (campaign) p.set("campaign", campaign); if (focus) p.set("focus", focus); return `/api/v1/ops/intel/graph?${p}`; }, [types, kind, minStrength, since, campaign, focus]);
  const sel=selection?.url===url?selection.id:null;
  const setSel=(id:string|null)=>changeSelection({url,id});
  const { data, error } = useOps<Graph>(url, 0);
  const { data: camps } = useOps<{ campaigns: Row[] }>("/api/v1/campaigns", 0);
  const { data: wallets } = useOps<{ wallets: Array<{ wallet: string; sites: number; domains: string[] }>; note: string }>("/api/v1/ops/intel/wallets", 0);
  const W = 900, H = 560;
  const pos = useMemo(() => (data ? layout(data.nodes, data.edges, W, H) : new Map()), [data]);
  const neighbors = useMemo(() => { const s = new Set<string>(); if (sel && data) { s.add(sel); for (const e of data.edges) { if (e.from === sel) s.add(e.to); if (e.to === sel) s.add(e.from); } } return s; }, [sel, data]);
  return <div className="ops">
    <div className="ops-head"><div><h1>Intelligence</h1><p className="ops-sub">One graph across every investigation and campaign. Every link cites the observation it came from. Shared hosting, certificates, templates or wallets are reasons to look together, never proof of common ownership.</p></div></div>
    <Card>
      <div className="ops-chipset" role="group" aria-label="Entity types">{TYPES.map(([t, label, c]) => <button key={t} className={`ops-chip ${types.includes(t) ? "on" : ""}`} onClick={() => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])} aria-pressed={types.includes(t)}><i style={{ background: c }} />{label}</button>)}</div>
      <div className="ops-filters">
        <label>Relationship <select value={kind} onChange={e => setKind(e.target.value)}><option value="">Any</option>{KINDS.map(k => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</select></label>
        <label>Min. strength <select value={minStrength} onChange={e => setMinStrength(Number(e.target.value))}><option value={0}>Any</option><option value={0.4}>0.4+</option><option value={0.6}>0.6+</option><option value={0.8}>0.8+</option></select></label>
        <label>Seen within <select value={since} onChange={e => setSince(e.target.value)}><option value="">Any time</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select></label>
        <label>Campaign <select value={campaign} onChange={e => setCampaign(e.target.value)}><option value="">All</option>{(camps?.campaigns ?? []).map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.title).slice(0, 40)}</option>)}</select></label>
        <form onSubmit={e => { e.preventDefault(); setFocus(focusInput.trim() ? (focusInput.includes(":") ? focusInput.trim() : `domain:${focusInput.trim().toLowerCase()}`) : ""); }} className="ops-row"><input className="ops-input" value={focusInput} onChange={e => setFocusInput(e.target.value)} placeholder="Focus on a site or wallet:0x…" aria-label="Focus" /><button className="ops-btn">Focus</button>{focus && <button type="button" className="ops-btn ghost" onClick={() => { setFocus(""); setFocusInput(""); }}>Clear</button>}</form>
      </div>
    </Card>
    <ErrorNote error={error} />
    <div className="ops-grid">
      <div className="ops-span-8">
        <div className="ops-graph">
          {data && data.nodes.length ? <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Intelligence graph">
            {data.edges.map(e => { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null; const dim = sel && !(neighbors.has(e.from) && neighbors.has(e.to)); return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`edge ${e.strength >= 0.7 ? "strong" : ""} ${e.active ? "" : "inactive"}`} opacity={dim ? 0.12 : 1}><title>{`${e.kind.replace(/_/g, " ")} · ${e.basis} · strength ${e.strength.toFixed(2)} · ${e.provenance}`}</title></line>; })}
            {data.nodes.map(n => { const p = pos.get(n.id); if (!p) return null; const r = n.type === "domain" ? 7 : 5 + Math.min(4, n.degree / 3); const showLabel = n.type === "domain" || neighbors.has(n.id) || n.degree >= 3; return <g key={n.id} className={`node ${sel === n.id ? "sel" : ""} ${sel && !neighbors.has(n.id) ? "dim" : ""}`} transform={`translate(${p.x},${p.y})`} onClick={() => setSel(n.id === sel ? null : n.id)} onKeyDown={e => { if (e.key === "Enter") setSel(n.id); }}>
              <circle tabIndex={0} role="button" aria-label={`${n.type} ${n.key}`} r={r} fill={COLOR[n.type] ?? "#80889a"} />{showLabel && <text x={r + 4} y={4} pointerEvents="none">{n.label.length > 28 ? n.label.slice(0, 26) + "…" : n.label}</text>}<title>{`${n.type}: ${n.key}`}</title></g>; })}
          </svg> : <div style={{ padding: 40 }}><Empty>{data ? "No relationships match these filters." : "Loading…"}</Empty></div>}
          <div className="ops-graph-foot"><span>{data ? `${data.nodes.length} nodes · ${data.edges.length} links${data.truncated ? " · showing the most connected part; focus to see more" : ""}` : ""}</span><span>Generic hosting shared by many unrelated sites is hidden. Dashed = no longer observed.</span></div>
        </div>
      </div>
      <div className="ops-span-4" style={{ display: "grid", gap: 16, alignContent: "start" }}>
        {sel ? <NodePanel id={sel} onFocus={k => { setFocusInput(k); setFocus(k); }} /> : <Card title="Select a node"><p className="ops-sub">Click any site, wallet or piece of infrastructure to see its evidence, history and every link with its source.</p></Card>}
        <Card title="Wallets on more than one site">
          {wallets?.wallets.length ? <ul className="ops-list">{wallets.wallets.slice(0, 8).map(w => <li key={w.wallet}><div className="ops-li-top"><button className="ops-link ops-mono" style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => { setFocusInput(`wallet:${w.wallet}`); setFocus(`wallet:${w.wallet}`); }}>{w.wallet.slice(0, 10)}…{w.wallet.slice(-6)}</button><span className="ops-right"><Pill tone="accent">{w.sites} sites</Pill></span></div><p className="ops-mono">{w.domains.slice(0, 4).join(", ")}</p></li>)}</ul> : <Empty>No wallet seen on more than one site yet.</Empty>}
          {wallets && <p className="ops-sub" style={{ fontSize: 11 }}>{wallets.note}</p>}
        </Card>
      </div>
    </div>
  </div>;
}

function NodePanel({ id, onFocus }: { id: string; onFocus: (k: string) => void }) {
  const { data } = useOps<Row>(`/api/v1/ops/intel/node/${id}`, 0);
  if (!data) return <Card title="Loading…"><Empty>Loading…</Empty></Card>;
  const n = data.node as Row; const links = (data.links as Row[]) ?? []; const h = data.history as { facets: Row[]; changes: Row[] } | undefined;
  const evidence = (data.evidence as Row[]) ?? []; const campaigns = (data.campaigns as Row[]) ?? []; const reasoning = (data.reasoning as Row[]) ?? []; const cand = data.candidate as Row | null;
  return <Card title={<div style={{ display: "grid", gap: 4, minWidth: 0 }}><span className="ops-sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>{String(n.node_type)}</span><h2 className="ops-mono" style={{ wordBreak: "break-all" }}>{String(n.node_key)}</h2></div>} action={<button className="ops-btn" onClick={() => onFocus(`${n.node_type}:${n.node_key}`)}>Focus</button>}>
    {cand && <p className="ops-sub">{String(cand.headline ?? "")} {cand.investigation_id ? <Link className="ops-link" href={`/investigations/${cand.investigation_id}`}>Open investigation</Link> : null}</p>}
    {campaigns.length > 0 && <div className="ops-row">{campaigns.map(c => <Link key={String(c.id)} href={`/campaigns/${c.id}`}><Pill tone="accent">{String(c.title).slice(0, 30)}</Pill></Link>)}</div>}
    <h3>Links ({links.length})</h3>
    <ul className="ops-list">{links.slice(0, 12).map((l, i) => <li key={i}><div className="ops-li-top"><strong>{String(l.kind).replace(/_/g, " ")}</strong><span className="ops-right"><Pill tone={l.active ? "" : "dim"}>{l.active ? `${Number(l.strength).toFixed(2)}` : "ended"}</Pill></span></div><p className="ops-mono">{String(l.other)}</p><p style={{ fontSize: 11 }}>{String(l.basis)} · source {String(l.provenance)}</p></li>)}</ul>
    {evidence.length > 0 && <><h3>Evidence</h3><ul className="ops-list">{evidence.slice(0, 6).map(e => <li key={String(e.id)}><div className="ops-li-top"><strong>{String(e.title)}</strong></div><p>{String(e.source_module)} · {ago(e.captured_at)}</p></li>)}</ul></>}
    {h && h.changes.length > 0 && <><h3>History</h3><ul className="ops-timeline">{h.changes.slice(0, 8).map(c => <li key={String(c.id)} className="change"><strong>{String(c.change_kind).replace(/_/g, " ")}</strong><small>{ago(c.detected_at)}</small></li>)}</ul></>}
    {reasoning.length > 0 && <><h3>Hypotheses (reasoning, not evidence)</h3><ul className="ops-list">{reasoning.map(r => <li key={String(r.id)}><p>{String(r.statement)}</p><Pill>{String(r.status)}</Pill></li>)}</ul></>}
  </Card>;
}
