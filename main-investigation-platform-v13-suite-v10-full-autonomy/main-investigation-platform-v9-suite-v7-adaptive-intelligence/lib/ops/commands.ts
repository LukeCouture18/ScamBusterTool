/**
 * Operator command interface.
 *
 * Natural-language commands compile into ONE of a closed set of typed intents.
 * Each intent has a fixed effect class:
 *
 *   read     answers from platform state; changes nothing
 *   queue    proposes a typed work item; the scheduler, Reviewer, budgets and
 *            module policies then decide whether and when it runs
 *   control  changes an operations setting within fixed bounds (pause/resume)
 *
 * There is no intent that runs a module, starts a job, raises a budget, edits
 * evidence or touches credentials. A command therefore has exactly the power
 * of the buttons in the UI and cannot bypass policy.
 *
 * Compilation is deterministic first (a small grammar). Only when the grammar
 * does not match, and a model is configured and within budget, the router's
 * fast tier may translate the text into the same schema; that translation is
 * untrusted: it is validated by COMMAND_SCHEMA, recorded as an AI decision,
 * and any queue/control intent it produces is returned for confirmation
 * rather than applied.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { routedComplete } from "../ai/router";
import { recordDecision, updateDecision } from "./decisions";
import { json, parse, setState, type Row } from "./common";

const domain = z.string().trim().max(253).regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/);
const idish = z.string().trim().min(4).max(64).regex(/^[A-Za-z0-9-]+$/);
const wallet = z.string().trim().min(20).max(120).regex(/^[A-Za-z0-9:]+$/);

export const COMMAND_SCHEMA = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("find_more_candidates"), args: z.object({ campaign: idish.optional(), like: domain.optional() }).strict() }).strict(),
  z.object({ intent: z.literal("why_investigated"), args: z.object({ domain }).strict() }).strict(),
  z.object({ intent: z.literal("missing_evidence"), args: z.object({ domain: domain.optional(), campaign: idish.optional() }).strict() }).strict(),
  z.object({ intent: z.literal("multi_site_wallets"), args: z.object({}).strict() }).strict(),
  z.object({ intent: z.literal("pause_discovery"), args: z.object({ low_priority_only: z.boolean() }).strict() }).strict(),
  z.object({ intent: z.literal("resume_discovery"), args: z.object({}).strict() }).strict(),
  z.object({ intent: z.literal("pause_operations"), args: z.object({}).strict() }).strict(),
  z.object({ intent: z.literal("resume_operations"), args: z.object({}).strict() }).strict(),
  z.object({ intent: z.literal("compare_campaigns"), args: z.object({ a: idish, b: idish }).strict() }).strict(),
  z.object({ intent: z.literal("revisit_site"), args: z.object({ domain }).strict() }).strict(),
  z.object({ intent: z.literal("analyze_wallet"), args: z.object({ address: wallet }).strict() }).strict(),
  z.object({ intent: z.literal("status"), args: z.object({}).strict() }).strict(),
  z.object({ intent: z.literal("unsupported"), args: z.object({ why: z.string().max(200) }).strict() }).strict(),
]);
export type Command = z.infer<typeof COMMAND_SCHEMA>;
export const EFFECT: Record<Command["intent"], "read" | "queue" | "control" | "none"> = {
  find_more_candidates: "queue", why_investigated: "read", missing_evidence: "read", multi_site_wallets: "read", pause_discovery: "control", resume_discovery: "control",
  pause_operations: "control", resume_operations: "control", compare_campaigns: "read", revisit_site: "queue", analyze_wallet: "queue", status: "read", unsupported: "none",
};

const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;
const ID_RE = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\b/gi;

/** Pure: the deterministic grammar. Returns null when it does not recognise the text. */
export function compileDeterministic(text: string): Command | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const d = t.match(DOMAIN_RE)?.[1];
  const ids = [...t.matchAll(ID_RE)].map(m => m[1]);
  const cand = (c: unknown) => { const r = COMMAND_SCHEMA.safeParse(c); return r.success ? r.data : null; };
  if (/^(status|what('| i)s (happening|running)|overview)\b/.test(t)) return cand({ intent: "status", args: {} });
  if (/\b(resume|restart|unpause)\b.*\bdiscovery\b/.test(t)) return cand({ intent: "resume_discovery", args: {} });
  if (/\bpause\b.*\bdiscovery\b/.test(t)) return cand({ intent: "pause_discovery", args: { low_priority_only: /\blow[- ]priority\b/.test(t) } });
  if (/\b(resume|unpause)\b.*\b(operations|everything|scheduler|all work)\b/.test(t)) return cand({ intent: "resume_operations", args: {} });
  if (/\bpause\b.*\b(operations|everything|scheduler|all work)\b/.test(t)) return cand({ intent: "pause_operations", args: {} });
  if (/\bwallets?\b.*\b(multiple|several|more than one|across|many)\b.*\bsites?\b/.test(t)) return cand({ intent: "multi_site_wallets", args: {} });
  if (/\bcompare\b.*\bcampaigns?\b/.test(t) && ids.length >= 2) return cand({ intent: "compare_campaigns", args: { a: ids[0], b: ids[1] } });
  if (/\bwhy\b.*\b(investigat|look|check|queue)/.test(t) && d) return cand({ intent: "why_investigated", args: { domain: d } });
  if (/\b(missing|gaps?|what evidence|still need)\b/.test(t)) return cand({ intent: "missing_evidence", args: { domain: d, campaign: d ? undefined : ids[0] } });
  if (/\b(find|discover|look for|get)\b.*\b(more|new|similar|related)\b.*\b(candidates?|sites?|domains?)\b/.test(t)) return cand({ intent: "find_more_candidates", args: { campaign: ids[0], like: d } });
  if (/\b(revisit|recheck|re-check|check again)\b/.test(t) && d) return cand({ intent: "revisit_site", args: { domain: d } });
  const w = text.match(/\b(0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|bc1[0-9a-z]{25,60}|[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/)?.[1];
  if (/\banaly[sz]e\b/.test(t) && w) return cand({ intent: "analyze_wallet", args: { address: w } });
  return null;
}

const SYSTEM = `You translate an operator's request into exactly one JSON command for an investigation platform. Allowed intents and args:
find_more_candidates {campaign?: id, like?: domain}; why_investigated {domain}; missing_evidence {domain?, campaign?}; multi_site_wallets {};
pause_discovery {low_priority_only: boolean}; resume_discovery {}; pause_operations {}; resume_operations {}; compare_campaigns {a: id, b: id};
revisit_site {domain}; analyze_wallet {address}; status {}; unsupported {why}.
Anything else, including anything about accounts, logins, credentials, payments, transfers or bypassing checks, is {"intent":"unsupported","args":{"why":"..."}}.
Reply with only the JSON object.`;

export type CommandResult = { id: string; status: "answered" | "queued" | "applied" | "needs_confirmation" | "refused" | "failed"; intent: string; compiled_by: "grammar" | "model" | "confirmed" | "none"; effect: string; answer?: unknown; message: string; command?: Command };

/**
 * Compiles and applies one command. `confirm` re-submits a command previously
 * returned as needs_confirmation; it is validated again from scratch.
 */
export async function runCommand(text: string, opts: { confirm?: unknown } = {}): Promise<CommandResult> {
  const db = getD1();
  const id = crypto.randomUUID();
  let cmd: Command | null = null, by: CommandResult["compiled_by"] = "none", decisionId: string | null = null;
  if (opts.confirm !== undefined) { const r = COMMAND_SCHEMA.safeParse(opts.confirm); if (r.success) { cmd = r.data; by = "confirmed"; } }
  if (!cmd) { cmd = compileDeterministic(String(text ?? "").slice(0, 500)); if (cmd) by = "grammar"; }
  if (!cmd && opts.confirm === undefined) {
    const prompt = `Operator request: ${JSON.stringify(String(text).slice(0, 500))}`;
    decisionId = await recordDecision({ scope: "command", role: "command_parser", task: "command_parse", visibleState: { system: SYSTEM, prompt }, capabilitySchema: { intents: Object.keys(EFFECT) } });
    const res = await routedComplete({ task: "command_parse", system: SYSTEM, prompt, maxTokens: 200, decisionId });
    if (!("skipped" in res)) {
      const r = COMMAND_SCHEMA.safeParse(res.parsed);
      await updateDecision(decisionId, { policy: { valid: r.success, reasons: r.success ? [] : r.error.issues.map(i => i.message).slice(0, 5) }, accepted: r.success, result: { proposal: res.parsed } });
      await db.prepare("UPDATE ai_decisions SET provider=?,model=?,proposal=? WHERE id=?").bind(res.provider, res.model, json(res.parsed), decisionId).run();
      if (r.success) { cmd = r.data; by = "model"; }
    } else await updateDecision(decisionId, { policy: { skipped: res.skipped }, accepted: false });
  }
  const log = async (out: CommandResult, policy: Row) => {
    await db.prepare("INSERT INTO operator_commands (id,text,intent,compiled,policy,status,result,decision_id) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, String(text ?? "").slice(0, 500), out.intent, json(out.command ?? {}), json(policy), out.status === "applied" ? "queued" : out.status === "needs_confirmation" ? "refused" : out.status, json({ message: out.message, answer: out.answer ?? null }), decisionId).run();
    return out;
  };
  if (!cmd) return log({ id, status: "refused", intent: "unknown", compiled_by: "none", effect: "none", message: "I couldn't map that to a supported command. Try: \"find more candidates like example.com\", \"why was example.com investigated\", \"what evidence is missing for example.com\", \"which wallets appear on multiple sites\", \"pause low-priority discovery\", or \"compare campaigns <id> <id>\"." }, { reason: "no_match" });
  const effect = EFFECT[cmd.intent];
  if (cmd.intent === "unsupported") return log({ id, status: "refused", intent: cmd.intent, compiled_by: by, effect, command: cmd, message: `Not something the command interface can do: ${cmd.args.why}` }, { reason: "unsupported_intent" });
  // Model-compiled commands that change anything are shown back to the operator first.
  if (by === "model" && effect !== "read") return log({ id, status: "needs_confirmation", intent: cmd.intent, compiled_by: by, effect, command: cmd, message: `I read this as “${describe(cmd)}”. Confirm to apply it.` }, { reason: "model_compiled_change_requires_confirmation" });
  try {
    const out = await apply(cmd);
    return log({ id, intent: cmd.intent, compiled_by: by, effect, command: cmd, ...out }, { effect, allowed: true });
  } catch (error) {
    return log({ id, status: "failed", intent: cmd.intent, compiled_by: by, effect, command: cmd, message: error instanceof Error ? error.message : String(error) }, { effect, allowed: true });
  }
}

export function describe(c: Command): string {
  const a = c.args as Row;
  switch (c.intent) {
    case "find_more_candidates": return a.campaign ? `find more candidates for campaign ${a.campaign}` : a.like ? `find more candidates related to ${a.like}` : "run a discovery cycle";
    case "why_investigated": return `explain why ${a.domain} was investigated`;
    case "missing_evidence": return `list missing evidence for ${a.domain ?? a.campaign ?? "all open investigations"}`;
    case "multi_site_wallets": return "list wallets seen on more than one site";
    case "pause_discovery": return a.low_priority_only ? "pause low-priority discovery" : "pause all discovery";
    case "resume_discovery": return "resume discovery";
    case "pause_operations": return "pause the operations scheduler";
    case "resume_operations": return "resume the operations scheduler";
    case "compare_campaigns": return `compare campaigns ${a.a} and ${a.b}`;
    case "revisit_site": return `queue a revisit of ${a.domain}`;
    case "analyze_wallet": return `queue a wallet analysis of ${a.address}`;
    case "status": return "show operations status";
    default: return String(c.intent);
  }
}

async function campaignId(prefix: string) {
  const r = await getD1().prepare("SELECT id FROM campaigns WHERE id=? OR id LIKE ? ORDER BY created_at DESC LIMIT 2").bind(prefix, `${prefix}%`).all<Row>();
  if (r.results.length !== 1) throw new Error(`No single campaign matches ${prefix}`);
  return String(r.results[0].id);
}

async function apply(c: Command): Promise<Pick<CommandResult, "status" | "message" | "answer">> {
  const db = getD1();
  const norm = c.args as Row;
  for (const k of ["domain", "like"]) if (typeof norm[k] === "string") norm[k] = String(norm[k]).toLowerCase();
  const { proposeWork } = await import("./workitems");
  switch (c.intent) {
    case "status": {
      const { healthSnapshot } = await import("./health");
      const h = await healthSnapshot();
      return { status: "answered", message: `Operations are ${h.scheduler.paused ? "paused" : h.status}. ${h.queue.queued ?? 0} queued, ${h.queue.running ?? 0} running, ${h.queue.waiting_human ?? 0} waiting for you.`, answer: { queue: h.queue, scheduler: h.scheduler } };
    }
    case "why_investigated": {
      const items = (await db.prepare("SELECT id,kind,status,reason,source,priority,factors,created_at FROM work_items WHERE target_key=? ORDER BY created_at").bind(c.args.domain).all<Row>()).results;
      const cand = await db.prepare("SELECT status,score,headline,decision,investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(c.args.domain).first<Row>();
      const runs = cand?.investigation_id ? (await db.prepare("SELECT id,status,started_by,headline,started_at FROM agent_runs WHERE investigation_id=? ORDER BY started_at").bind(cand.investigation_id).all<Row>()).results : [];
      const camp = (await db.prepare("SELECT c.id,c.title,m.reason,m.state FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=?").bind(c.args.domain).all<Row>()).results;
      if (!cand && !items.length && !camp.length) return { status: "answered", message: `${c.args.domain} is not known to the platform.`, answer: null };
      const lines = [
        cand ? `Site Finder surfaced it (score ${Number(cand.score).toFixed(2)}${cand.headline ? `: ${cand.headline}` : ""}).` : null,
        cand?.decision ? `A person marked it ${cand.decision}.` : null,
        ...camp.map(m => `Campaign “${m.title}” includes it: ${m.reason}.`),
        ...items.map(i => `Queued ${String(i.kind).replace(/_/g, " ")} (${i.source}): ${i.reason}`),
      ].filter(Boolean);
      return { status: "answered", message: lines.join(" "), answer: { candidate: cand, work_items: items.map(i => ({ ...i, factors: parse(i.factors, {}) })), runs, campaigns: camp } };
    }
    case "missing_evidence": {
      const { gapsFor } = await import("./gaps");
      let invId: string | undefined;
      if (c.args.domain) invId = String((await db.prepare("SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(c.args.domain).first<Row>())?.investigation_id ?? "") || undefined;
      const cid = c.args.campaign ? await campaignId(c.args.campaign) : undefined;
      if (c.args.domain && !invId) return { status: "answered", message: `${c.args.domain} has no investigation yet, so everything is missing: it has not been observed.`, answer: [] };
      const gaps = await gapsFor({ investigationId: invId, campaignId: cid, status: "open" });
      return { status: "answered", message: gaps.length ? `${gaps.length} open gap(s): ${gaps.slice(0, 5).map(g => String((g as Row).missing)).join("; ")}` : "No open evidence gaps.", answer: gaps };
    }
    case "multi_site_wallets": {
      const { multiSiteWallets } = await import("./intel");
      const rows = await multiSiteWallets();
      return { status: "answered", message: rows.length ? `${rows.length} wallet(s) appear on more than one site. Shared wallets are a relationship, not proof of common ownership.` : "No wallet is currently observed on more than one site.", answer: rows };
    }
    case "compare_campaigns": {
      const { compareCampaigns } = await import("./formation");
      const res = await compareCampaigns(await campaignId(c.args.a), await campaignId(c.args.b));
      return { status: "answered", message: `${res.shared_nodes.length} shared non-generic node(s), ${res.supported_links} supported site link(s); ${res.merge_supported ? "a merge is supported by graph evidence" : "no merge is supported"}. ${res.note}`, answer: res };
    }
    case "pause_discovery":
      if (c.args.low_priority_only) { await setState("discovery_min_priority", 0.35); return { status: "applied", message: "Low-priority discovery is paused: discovery work below priority 0.35 waits until you resume it." }; }
      await setState("discovery_paused", true); return { status: "applied", message: "Discovery is paused. Investigations already queued continue." };
    case "resume_discovery":
      await setState("discovery_paused", false); await setState("discovery_min_priority", 0); return { status: "applied", message: "Discovery resumed." };
    case "pause_operations":
      await setState("scheduler_paused", true); return { status: "applied", message: "Operations paused. Running module work finishes; nothing new starts until you resume." };
    case "resume_operations":
      await setState("scheduler_paused", false); return { status: "applied", message: "Operations resumed." };
    case "find_more_candidates": {
      if (c.args.campaign) {
        const cid = await campaignId(c.args.campaign);
        const r = await proposeWork({ kind: "expand_campaign", targetType: "campaign", targetKey: cid, fingerprint: `expand_campaign:${cid}:${new Date().toISOString().slice(0, 13)}`, source: "command", reason: "operator asked for more candidates for this campaign", campaignId: cid, factors: { info_gain: 0.7, campaign_relevance: 1 } });
        return { status: "queued", message: `Queued: expand campaign discovery (work item ${r.id.slice(0, 8)}). The scheduler and campaign budgets still apply.`, answer: r };
      }
      if (c.args.like) {
        const keys = parse<Row>((await db.prepare("SELECT details FROM inbox_candidates WHERE canonical_domain=?").bind(c.args.like).first<Row>())?.details, {});
        const pivots = (Array.isArray(keys.keys) ? keys.keys as unknown[] : []).filter((k): k is [string, string] => Array.isArray(k) && ["favtmpl", "san", "ns", "ip"].includes(String(k[0]))).slice(0, 3);
        const out = [];
        for (const [k, v] of pivots) out.push(await proposeWork({ kind: "inspect_infrastructure", targetType: k, targetKey: String(v), source: "command", reason: `operator asked for sites like ${c.args.like}`, factors: { info_gain: 0.6, novelty: 0.6 } }));
        if (out.length) return { status: "queued", message: `Queued ${out.length} passive pivot(s) from ${c.args.like}'s public infrastructure.`, answer: out };
      }
      const r = await proposeWork({ kind: "discovery_cycle", targetType: "discovery", targetKey: `cmd:${new Date().toISOString().slice(0, 13)}`, source: "command", reason: "operator asked for more candidates", factors: { info_gain: 0.6, novelty: 0.7 } });
      return { status: "queued", message: `Queued a discovery cycle (work item ${r.id.slice(0, 8)}).`, answer: r };
    }
    case "revisit_site": {
      const cand = await db.prepare("SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(c.args.domain).first<Row>();
      if (!cand?.investigation_id) return { status: "refused", message: `${c.args.domain} has no investigation to revisit.` };
      const r = await proposeWork({ kind: "revisit_changed_site", targetType: "domain", targetKey: c.args.domain, source: "command", reason: "operator asked for a revisit", investigationId: String(cand.investigation_id), reopen: true, factors: { info_gain: 0.5 } });
      return { status: "queued", message: `Revisit ${r.outcome} (work item ${r.id.slice(0, 8)}).`, answer: r };
    }
    case "analyze_wallet": {
      const e = await db.prepare("SELECT id FROM entities WHERE entity_type='wallet' AND lower(canonical_key)=lower(?) LIMIT 1").bind(c.args.address).first<Row>();
      if (!e) return { status: "refused", message: "That wallet has not been observed on any investigated site, so there is nothing to analyze yet." };
      const r = await proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: String(e.id), source: "command", reason: "operator asked for a wallet analysis", factors: { info_gain: 0.6 } });
      return { status: "queued", message: `Wallet analysis ${r.outcome} (work item ${r.id.slice(0, 8)}).`, answer: r };
    }
    default:
      return { status: "refused", message: "Unsupported." };
  }
}
