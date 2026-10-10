"use client";
import Link from "next/link";
import {AutonomyHome} from "./autonomy";
import { ArrowRight } from "lucide-react";
import { TOOLS } from "@/components/platform-shell";
import { useSuiteContext } from "./context";
import { ago, Card, Empty, ErrorNote, Loading, ModuleStatus, useJson, type Row } from "./kit";

type Home = {
  tools: Record<"finder" | "wallets" | "logger" | "reports" | "hunter", Row & { modules?: Array<{ module: string; state: string; seen: string | null }> }>;
  needs_you: number; needs_you_counts: Record<string, number>;
  happened: Array<{ title: string; detail: string; tool: string; at: string }>;
};

const LINES: Record<string, (t: Row) => Array<[string, unknown]>> = {
  finder: t => [["Waiting for your review", t.to_review], ["Found in the last day", t.found_24h], ["Being investigated", t.investigating]],
  wallets: t => [["Wallets known", t.known], ["Analysed", t.analysed], ["Being analysed", t.analysing]],
  logger: t => [["Captured in the last day", t.captures_24h], ["Captured in total", t.captures_total], ["Last capture", t.last_capture ? ago(t.last_capture) : "none yet"]],
  reports: t => [["Waiting for your approval", t.needs_review], ["In progress", t.ready], ["Submitted", t.submitted]],
  hunter: t => [["Operations reconstructed", t.operations], ["Active or rotating", t.rotating], ["Suggestions sent to Main", t.open_proposals]],
};
const KEY = ["finder", "wallets", "logger", "reports", "hunter"] as const;

function ToolsHome() {
  const { data, error } = useJson<Home>("/api/v1/suite/home", 15000);
  const { href } = useSuiteContext();
  return <div className="mip-page">
    <div className="mip-head"><div style={{ display: "grid", gap: 6 }}>
      <p className="mip-eyebrow">Investigation suite</p>
      <h1>What is happening</h1>
      <p className="mip-sub">Five tools, one investigation. Site Finder brings you new sites, the others follow the evidence. Main coordinates them in the background within your budgets, and asks for you only when a person is needed.</p>
    </div>{data && data.needs_you > 0 && <Link className="mip-btn primary" href="/tasks">{data.needs_you} thing{data.needs_you > 1 ? "s" : ""} need you <ArrowRight size={14} /></Link>}</div>
    <ErrorNote error={error} />
    <div className="mip-tools">
      {TOOLS.map(({ href: h, label, icon: Icon, what }, i) => {
        const t = data?.tools[KEY[i]];
        return <Link key={h} href={href(h)} className="mip-tool" data-tool={KEY[i]}>
          <span className="mip-tool-icon"><Icon size={19} /></span>
          <div><h2>{label}</h2><p>{what}</p></div>
          {t ? LINES[KEY[i]](t).map(([k, v]) => <div key={k} className="mip-tool-line"><span>{k}</span><b>{String(v ?? 0)}</b></div>) : <Loading lines={2} />}
          <ModuleStatus modules={t?.modules} />
        </Link>;
      })}
    </div>
    <div className="mip-grid two" style={{ marginTop: 18 }}>
      <Card title="What happened recently">
        {!data ? <Loading /> : data.happened.length ? <ul className="mip-list">{data.happened.map((h, i) => <li key={i} className="mip-item">
          <div className="mip-spread"><span className="mip-item-title">{h.title}</span><span className="mip-meta">{h.tool} · {ago(h.at)}</span></div>
          {h.detail && <span className="mip-meta">{h.detail}</span>}
        </li>)}</ul> : <Empty>Nothing has happened yet. Start in Site Finder, or connect the tools under Advanced → Integration status.</Empty>}
      </Card>
      <Card title="How the tools fit together">
        <ol className="mip-list" style={{ paddingLeft: 18, listStyle: "decimal" }}>
          <li><b>Site Finder</b> discovers new sites and explains why each is worth a look. Open one and <b>Investigate</b> it to collect page evidence and wallets.</li>
          <li><b>Operation Hunter</b> reconstructs the wider operation behind a site: its other sites, its money flow and what it may do next.</li>
          <li><b>Wallet Logger</b> records wallet addresses on pages you visit yourself; <b>Wallet Investigator</b> follows those wallets on-chain.</li>
          <li><b>Form Submitter</b> files the report once you approve a frozen copy of the evidence.</li>
        </ol>
        <p className="mip-meta" style={{ marginTop: 10 }}>The site, wallet or operation you pick stays selected in the top bar as you move between tools.</p>
      </Card>
    </div>
  </div>;
}

export function SuiteHome(){return <><AutonomyHome/><details className="mip-page"><summary>Tools / Advanced</summary><ToolsHome/></details></>;}
