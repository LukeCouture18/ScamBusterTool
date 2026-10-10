"use client";
import { useEffect, useRef, useState } from "react";
import { Bell, Command, X } from "lucide-react";
import { ago, post, useOps, type Row } from "./ui";

type Result = { status: string; intent: string; compiled_by: string; effect: string; message: string; answer?: unknown; command?: unknown };
const EXAMPLES = ["Find more candidates like example.com", "Why was example.com investigated?", "What evidence is missing for example.com?", "Which wallets appear across multiple sites?", "Pause low-priority discovery", "Compare campaigns <id> <id>"];

/**
 * The command bar. Commands compile into typed intents with a fixed effect
 * (read, queue work, pause/resume) and never bypass policy; a command the
 * model had to interpret is shown back for confirmation before it changes anything.
 */
export function CommandBar() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); setOpen(true); } if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);
  async function run(confirm?: unknown) {
    if (!text.trim()) return;
    setBusy(true);
    try { setRes(await post("/api/v1/ops/commands", confirm ? { text, confirm } : { text }) as unknown as Result); }
    catch (e) { setRes({ status: "failed", intent: "", compiled_by: "none", effect: "none", message: e instanceof Error ? e.message : "Failed" }); }
    finally { setBusy(false); setOpen(true); }
  }
  const tone = res?.status === "refused" || res?.status === "failed" ? "bad" : res?.status === "needs_confirmation" ? "warn" : "ok";
  return (
    <div className="ops-cmd">
      <form onSubmit={e => { e.preventDefault(); run(); }} onFocus={() => setOpen(true)}>
        <Command size={14} />
        <input ref={input} value={text} onChange={e => setText(e.target.value)} placeholder="Ask or command: “find more candidates like …”" aria-label="Command" />
        {busy ? <span className="ops-pill dim">working</span> : <kbd>⌘K</kbd>}
      </form>
      {open && (res || !text) && (
        <div className="ops-pop" role="dialog" aria-label="Command result">
          <div className="ops-row" style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 12, color: "var(--ops-muted)" }}>{res ? `Intent: ${res.intent.replace(/_/g, " ")} · ${res.effect}` : "Try"}</strong>
            <button className="ops-btn ghost" style={{ height: 24, padding: "0 6px" }} onClick={() => { setOpen(false); setRes(null); }} aria-label="Close"><X size={13} /></button>
          </div>
          {res ? <>
            <p><span className={`ops-pill ${tone}`}>{res.status.replace(/_/g, " ")}</span> {res.message}</p>
            {res.status === "needs_confirmation" && <div className="ops-row"><button className="ops-btn primary" onClick={() => run(res.command)}>Confirm</button><button className="ops-btn ghost" onClick={() => setRes(null)}>Cancel</button></div>}
            {res.answer != null && <pre>{JSON.stringify(res.answer, null, 2).slice(0, 4000)}</pre>}
            <p className="ops-sub" style={{ fontSize: 11 }}>Commands use the same typed actions, reviewer, budgets and safety policy as everything else.</p>
          </> : <ul className="ops-list">{EXAMPLES.map(x => <li key={x}><button className="ops-link" style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer", padding: 0 }} onClick={() => { setText(x); input.current?.focus(); }}>{x}</button></li>)}</ul>}
        </div>
      )}
    </div>
  );
}

export function NotificationBell() {
  const { data, reload } = useOps<{ notifications: Row[] }>("/api/v1/ops/notifications", 30000);
  const [open, setOpen] = useState(false);
  const items = data?.notifications ?? [];
  async function mark(id: string, status: "read" | "dismissed") { await post("/api/v1/ops/notifications", { id, status }).catch(() => null); reload(); }
  return (
    <div className="ops-bell">
      <button onClick={() => setOpen(o => !o)} aria-label={`Notifications (${items.length})`}><Bell size={15} />{items.length > 0 && <b>{items.length}</b>}</button>
      {open && <div className="ops-pop right" role="dialog" aria-label="Notifications">
        <strong style={{ fontSize: 13 }}>Notifications</strong>
        {items.length ? <ul className="ops-notes">{items.map(n => (
          <li key={String(n.id)}><i className={String(n.severity)} /><a href={String(n.link ?? "#")} onClick={() => mark(String(n.id), "read")}><strong>{String(n.title)}{Number(n.count) > 1 ? ` (${n.count})` : ""}</strong><p>{String(n.body ?? "")}</p><p>{ago(n.last_at)}</p></a><button onClick={() => mark(String(n.id), "dismissed")} aria-label="Dismiss">Dismiss</button></li>
        ))}</ul> : <p className="ops-sub">Nothing needs your attention. Routine background work never notifies.</p>}
      </div>}
    </div>
  );
}
