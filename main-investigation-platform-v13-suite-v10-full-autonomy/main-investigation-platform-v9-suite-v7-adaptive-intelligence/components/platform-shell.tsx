"use client";
/**
 * The suite's one front door. Five tools in the sidebar; everything Main does to coordinate them
 * (campaigns, queues, scheduler, graphs, integration) is under Advanced. The investigation
 * context (site / wallet / operation) rides along in the top bar between tools.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { Crosshair, Hexagon, Radar, ScanLine, Send, SlidersHorizontal, UserCheck, Wallet } from "lucide-react";
import { CommandBar, NotificationBell } from "@/components/ops/command-bar";
import { useOps } from "@/components/ops/ui";
import { ContextBar, SuiteContextProvider, useSuiteContext } from "@/components/suite/context";

export const TOOLS = [
  { href: "/finder", label: "Site Finder", icon: Radar, what: "Find, review and investigate new sites" },
  { href: "/wallets", label: "Wallet Investigator", icon: Wallet, what: "Follow the money behind a wallet" },
  { href: "/logger", label: "Wallet Logger", icon: ScanLine, what: "Wallets captured while you browse" },
  { href: "/reports", label: "Form Submitter", icon: Send, what: "Approve and submit reports" },
  { href: "/hunter", label: "Operation Hunter", icon: Crosshair, what: "The operation behind the sites" },
];
const ADVANCED_PREFIXES = ["/advanced", "/operations", "/campaigns", "/investigations", "/discovery", "/intelligence", "/inbox", "/overview", "/orchestration", "/integration"];

function Nav() {
  const path = usePathname() ?? "/";
  const { href } = useSuiteContext();
  const { data } = useOps<{ counts: Record<string, number> }>("/api/v1/ops/tasks", 30000);
  const tasks = data ? Object.values(data.counts ?? {}).reduce((s, n) => s + Number(n), 0) : 0;
  const active = (h: string) => path === h || path.startsWith(h + "/");
  const side = useRef<HTMLElement>(null);
  // On narrow screens the tools are a sideways strip: keep the current tool in view.
  useEffect(() => { const el = side.current?.querySelector<HTMLElement>('[aria-current="page"], a.active'); if (el && side.current && side.current.scrollWidth > side.current.clientWidth) side.current.scrollLeft = Math.max(0, el.offsetLeft - 60); }, [path]);
  return <aside className="mip-side" ref={side}>
    <Link className="mip-brand" href="/" aria-label="Main Investigation Platform home"><span className="mip-brand-mark"><Hexagon size={19} /></span><span>MAIN<small>Investigation Platform</small></span></Link>
    <nav className="mip-nav" aria-label="Tools">
      <p className="mip-nav-label">Tools</p>
      {TOOLS.map(({ href: h, label, icon: Icon }) => <Link key={h} href={href(h)} className={active(h) ? "active" : ""} aria-current={active(h) ? "page" : undefined}><Icon size={17} /><span>{label}</span></Link>)}
    </nav>
    <nav className="mip-nav mip-side-bottom" aria-label="More">
      <Link href="/tasks" className={active("/tasks") ? "active" : ""}><UserCheck size={17} /><span>Needs you</span>{tasks > 0 && <i className="mip-count" aria-label={`${tasks} waiting`}>{tasks}</i>}</Link>
      <Link href="/advanced" className={ADVANCED_PREFIXES.some(p => active(p)) ? "active" : ""}><SlidersHorizontal size={17} /><span>Advanced</span></Link>
    </nav>
  </aside>;
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return <SuiteContextProvider>
    <div className="mip mip-shell platform-shell">
      <Nav />
      <main className="mip-main main-surface">
        <header className="mip-top"><ContextBar /><div className="mip-row" style={{ gap: 14 }}><CommandBar /><NotificationBell /></div></header>
        {children}
      </main>
    </div>
  </SuiteContextProvider>;
}
