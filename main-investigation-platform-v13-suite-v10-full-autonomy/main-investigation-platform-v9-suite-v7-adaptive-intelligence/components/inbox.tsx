"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ChevronDown, Clock3, X } from "lucide-react";

type Card = { id: string; domain: string; url: string; headline: string; category: string; related_count: number; score: number };
type Working = Card & { investigation_id: string | null; state: string; decided_at: string };
type Row = Record<string, unknown>;
const SKIP_REASONS: Array<[string, string]> = [["dead_or_parked", "Dead / parked"], ["not_a_scam", "Not a scam"], ["duplicate", "Duplicate"], ["not_useful", "Just skip"]];

/**
 * The investigation inbox: NEXT SITE -> OPEN SITE -> SKIP / USEFUL -> next.
 * Only the domain and one line of "why" are shown by default. Everything else
 * (score components, evidence, discovery path, jobs) is one click away under
 * Details, and never needed to make the call.
 */
export function Inbox() {
  const [item, setItem] = useState<Card | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [note, setNote] = useState("");
  const [details, setDetails] = useState<Row | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [working, setWorking] = useState<Working[]>([]);
  const [showWorking, setShowWorking] = useState(false);
  const current = useRef<Card | null>(null);

  const loadNext = useCallback(async () => {
    setSkipOpen(false); setShowDetails(false); setDetails(null);
    try {
      const r = await fetch("/api/v1/inbox/next", { cache: "no-store" });
      if (!r.ok) throw new Error("Inbox unavailable");
      const body = await r.json() as { item: Card | null; waiting: number };
      current.current = body.item; setItem(body.item); setWaiting(body.waiting); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Inbox unavailable"); }
    finally { setLoading(false); }
  }, []);
  const loadWorking = useCallback(async () => {
    try { const r = await fetch("/api/v1/inbox", { cache: "no-store" }); if (r.ok) setWorking(((await r.json()) as { working: Working[] }).working); } catch { /* optional */ }
  }, []);

  const decide = useCallback(async (decision: "useful" | "skip", reason?: string) => {
    const target = current.current; if (!target || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/inbox/${encodeURIComponent(target.id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reason ? { decision, reason } : { decision }) });
      if (!r.ok) throw new Error("Could not save the decision");
      setNote(decision === "useful" ? `${target.domain}: site check and related-site search queued. Evidence from WalletLogger attaches automatically.` : "");
      await loadNext(); void loadWorking();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
    finally { setBusy(false); }
  }, [busy, loadNext, loadWorking]);

  const openSite = useCallback(() => {
    const target = current.current; if (!target) return;
    window.open(target.url, "_blank", "noopener,noreferrer");
    void fetch(`/api/v1/inbox/${encodeURIComponent(target.id)}/opened`, { method: "POST" });
  }, []);

  const toggleDetails = async () => {
    const next = !showDetails; setShowDetails(next);
    if (next && item && !details) { const r = await fetch(`/api/v1/inbox/${encodeURIComponent(item.id)}`, { cache: "no-store" }); if (r.ok) setDetails(await r.json()); }
  };

  useEffect(() => { const t = window.setTimeout(() => { void loadNext(); void loadWorking(); }, 0); return () => window.clearTimeout(t); }, [loadNext, loadWorking]);
  useEffect(() => { const t = window.setInterval(() => { if (!current.current) void loadNext(); void loadWorking(); }, 15000); return () => window.clearInterval(t); }, [loadNext, loadWorking]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === "o") openSite(); else if (k === "u") void decide("useful"); else if (k === "s") void decide("skip", "not_useful");
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [decide, openSite]);

  return <div className="inbox-wrap">
    <div className="inbox-top"><span>Inbox</span><span>{loading ? "…" : error ? error : `${waiting} waiting`}</span>
      <button className="inbox-link" onClick={() => setShowWorking(v => !v)}><Clock3 size={14}/>In progress ({working.length})</button></div>
    {note && <p className="inbox-note">{note}</p>}
    <section className="inbox-card" aria-live="polite">
      <p className="inbox-label">Next site</p>
      {item ? <>
        <h1 className="inbox-domain">{item.domain}</h1>
        <p className="inbox-why">{item.headline}</p>
        <div className="inbox-actions">
          <button className="inbox-open" onClick={openSite} disabled={busy}>Open site <ArrowUpRight size={16}/><kbd>O</kbd></button>
          <button className="inbox-skip" onClick={() => setSkipOpen(v => !v)} disabled={busy}><X size={16}/>Skip<kbd>S</kbd></button>
          <button className="inbox-useful" onClick={() => void decide("useful")} disabled={busy}><Check size={16}/>Useful<kbd>U</kbd></button>
        </div>
        {skipOpen && <div className="inbox-reasons">{SKIP_REASONS.map(([k, label]) => <button key={k} onClick={() => void decide("skip", k)}>{label}</button>)}</div>}
        <button className="inbox-details-toggle" onClick={() => void toggleDetails()}><ChevronDown size={14} className={showDetails ? "open" : ""}/>Details{item.related_count ? ` · ${item.related_count} related site${item.related_count > 1 ? "s" : ""} hidden` : ""}</button>
        {showDetails && <Details data={details}/>}
      </> : <>
        <h1 className="inbox-domain muted">{loading ? "Loading…" : "Nothing waiting"}</h1>
        <p className="inbox-why">Only candidates that clear the bar appear here. Site Finder keeps looking in the background; new ones show up automatically.</p>
      </>}
    </section>
    {showWorking && <section className="inbox-working">
      {working.length ? working.map(w => <div key={w.id} className="working-row"><div><strong>{w.domain}</strong><span>{w.state}</span></div>
        {w.investigation_id && <Link href={`/investigations/${encodeURIComponent(w.investigation_id)}`}>Open case</Link>}</div>)
        : <p className="inbox-why">Sites you mark useful appear here while evidence is collected.</p>}
    </section>}
  </div>;
}

function Details({ data }: { data: Row | null }) {
  if (!data) return <div className="inbox-details">Loading…</div>;
  const d = (data.details ?? {}) as Row;
  const score = (d.score ?? {}) as Row;
  const signals = (d.signals ?? []) as Array<{ name: string; group: string; strength: number; phrase: string }>;
  const fetchInfo = (d.fetch ?? {}) as Row;
  const contributions = (score.contributions ?? {}) as Record<string, number>;
  const jobs = (data.jobs ?? []) as Row[];
  return <div className="inbox-details">
    <dl>
      <div><dt>Worth-checking score</dt><dd>{Number(d.worth_checking ?? data.score).toFixed(2)}</dd></div>
      <div><dt>Found by</dt><dd>{((d.strategies ?? []) as string[]).join(", ") || "—"}</dd></div>
      <div><dt>Page</dt><dd>{String(fetchInfo.status ?? "—")} · {String(fetchInfo.title ?? "")}</dd></div>
      <div><dt>Registered</dt><dd>{d.registered_days == null ? "unknown" : `${d.registered_days} days ago`}</dd></div>
      <div><dt>Related (hidden)</dt><dd>{((data.related_domains ?? []) as string[]).join(", ") || "none"}</dd></div>
      <div><dt>Deposit addresses</dt><dd className="mono-wrap">{((data.wallets ?? []) as string[]).join(", ") || "none shown publicly"}</dd></div>
    </dl>
    <h4>Evidence</h4>
    <ul>{signals.map(s => <li key={s.name}><span>{s.phrase}</span><small>{s.group} · {s.strength}</small></li>)}</ul>
    <h4>Score components</h4>
    <ul>{Object.entries(contributions).map(([k, v]) => <li key={k}><span>{k}</span><small>{v > 0 ? "+" : ""}{v}</small></li>)}
      <li><span>learned from your decisions</span><small>{String(score.learned ?? 0)}</small></li>
      <li><span>discovery-route prior</span><small>{String(score.strategy_prior ?? 0)}</small></li>
      <li><span>cluster prior</span><small>{String(score.cluster_prior ?? 0)}</small></li></ul>
    {jobs.length > 0 && <><h4>Work</h4><ul>{jobs.map(j => <li key={String(j.id)}><span>{String(j.job_type)}</span><small>{String(j.status)}</small></li>)}</ul></>}
    <p className="inbox-caveat">{String(data.note ?? "")}</p>
    <details><summary>Raw record</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>
  </div>;
}
