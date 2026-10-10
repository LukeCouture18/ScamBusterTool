"use client";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { Card, ToolHead } from "./kit";

/** Main's own coordination views: still here, just not competing with the five tools. */
const GROUPS: Array<{ title: string; items: Array<[string, string, string]> }> = [
  { title: "Coordination", items: [
    ["/operations", "Operations console", "What the scheduler is doing, its queue, budgets and throughput."],
    ["/campaigns", "Campaigns", "Groups of related sites Main is investigating together."],
    ["/investigations", "Investigations", "Every investigation record and its full evidence timeline."],
    ["/tasks", "Needs you", "Logins, reviews, conflicts and report approvals waiting for a person."],
  ] },
  { title: "Intelligence", items: [
    ["/discovery", "Discovery", "Continuous discovery settings and what Site Finder has been asked for."],
    ["/intelligence", "Intelligence graph", "The shared graph of sites, wallets and infrastructure, with provenance."],
    ["/inbox", "Classic candidate inbox", "The original one-site-at-a-time review screen."],
  ] },
  { title: "System", items: [
    ["/integration/status", "Integration status", "Which tools are connected, their queues and delivery health."],
    ["/overview", "Hub overview", "Module activity and records received."],
    ["/orchestration", "Orchestrator", "Pipelines, jobs, approvals and review gates."],
    ["/integration", "Integration API", "Module contract and API reference."],
  ] },
];

export function AdvancedHub() {
  return <div className="mip-page">
    <ToolHead icon={<SlidersHorizontal size={26} />} title="Advanced" sub="Main coordinates the five tools underneath: routing, budgets, approvals, deduplication and durable state. These are its own views, for when you want to see the machinery." />
    <div className="mip-grid">{GROUPS.map(g => <Card key={g.title} title={g.title}><ul className="mip-list">{g.items.map(([href, label, what]) => <li key={href} className="mip-item">
      <Link href={href} className="mip-item-title">{label}</Link><span className="mip-meta">{what}</span></li>)}</ul></Card>)}</div>
  </div>;
}
