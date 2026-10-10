/**
 * The evidence gap engine: what exactly is missing, and what safe action could
 * fill it.
 *
 * Gaps are derived deterministically from the investigation state, never from
 * a model saying it "needs more information". Each gap names what is known,
 * what is missing and the safe next actions; it becomes a work item; and it
 * ends in one of four ways:
 *
 *   resolved      the missing thing was observed
 *   unresolved    the safe actions were tried and did not produce it
 *   inaccessible  it cannot be obtained without a person (or the site is gone)
 *   irrelevant    the question no longer matters (skipped, duplicate, campaign stopped)
 *
 * When a gap closes, the work it created is cancelled: resolved gaps stop
 * unnecessary work. An investigation with no open gaps is done.
 */
import { getD1 } from "../platform";
import { buildDigest } from "../agent/state";
import { proposeWork, cancelWork } from "./workitems";
import { json, parse, hoursSince, type Row } from "./common";

export const GAP_KINDS = ["no_site_observation", "no_deposit_destination", "wallet_not_analyzed", "infrastructure_unknown", "stale_observation"] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export const MAX_RECHECKS = 2, STALE_DAYS = 30;
type Status = "open" | "resolved" | "unresolved" | "inaccessible" | "irrelevant";

async function upsertGap(g: { investigationId: string; campaignId: string | null; subjectType: string; subjectKey: string; kind: GapKind; known: string[]; missing: string; actions: Array<{ action: string; how: string }> }) {
  const db = getD1();
  const cur = await db.prepare("SELECT * FROM evidence_gaps WHERE subject_type=? AND subject_key=? AND gap_kind=?").bind(g.subjectType, g.subjectKey, g.kind).first<Row>();
  if (!cur) {
    const id = crypto.randomUUID();
    await db.prepare("INSERT OR IGNORE INTO evidence_gaps (id,investigation_id,campaign_id,subject_type,subject_key,gap_kind,known,missing,safe_actions,history) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, g.investigationId, g.campaignId, g.subjectType, g.subjectKey, g.kind, json(g.known), g.missing, json(g.actions), json([{ at: new Date().toISOString(), to: "open" }])).run();
    return { id, created: true, status: "open" as Status };
  }
  if (cur.status !== "open" && cur.status !== "unresolved") {
    // A gap that closed can reopen when the facts regress (e.g. the wallet disappeared).
    await transition(cur, "open", "the missing evidence is missing again");
  } else {
    await db.prepare("UPDATE evidence_gaps SET known=?,missing=?,safe_actions=?,campaign_id=COALESCE(?,campaign_id),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json(g.known), g.missing, json(g.actions), g.campaignId, cur.id).run();
  }
  return { id: String(cur.id), created: false, status: (cur.status === "unresolved" ? "unresolved" : "open") as Status };
}

async function transition(g: Row, to: Status, why: string, by?: string) {
  const hist = parse<Row[]>(g.history, []); hist.push({ at: new Date().toISOString(), from: g.status, to, why: why.slice(0, 200) });
  await getD1().prepare("UPDATE evidence_gaps SET status=?,resolution=?,resolved_by=COALESCE(?,resolved_by),history=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(to, why.slice(0, 300), by ?? null, json(hist.slice(-20)), g.id).run();
  if (to !== "open") await cancelWork({ gapId: String(g.id) }, `gap ${to}: ${why}`);
}

async function close(subjectType: string, subjectKey: string, kind: GapKind, to: Exclude<Status, "open">, why: string, by?: string) {
  const g = await getD1().prepare("SELECT * FROM evidence_gaps WHERE subject_type=? AND subject_key=? AND gap_kind=? AND status IN ('open','unresolved')").bind(subjectType, subjectKey, kind).first<Row>();
  if (g && g.status !== to) await transition(g, to, why, by);
  return Boolean(g);
}

/** Re-derives the gaps of one investigation and proposes the work that could close them. */
export async function evaluateGaps(investigationId: string) {
  const db = getD1();
  const d = await buildDigest(investigationId);
  if (!d || !d.site) return { open: 0 };
  const domain = d.site.domain;
  const cand = await db.prepare("SELECT id,decision,decision_reason,score,status,headline,details FROM inbox_candidates WHERE investigation_id=?").bind(investigationId).first<Row>();
  const member = await db.prepare("SELECT m.campaign_id,c.status FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=? ORDER BY CASE c.status WHEN 'RUNNING' THEN 0 ELSE 1 END LIMIT 1").bind(domain).first<Row>();
  const campaignId = member ? String(member.campaign_id) : null;
  const campaignRunning = member?.status === "RUNNING";
  const known = [cand?.headline ? `Site Finder: ${String(cand.headline).slice(0, 120)}` : `Site Finder surfaced ${domain}`];

  // Irrelevant: a person skipped the site, or it was set aside as a duplicate.
  if (cand?.decision === "skip") {
    for (const k of GAP_KINDS) await close("domain", domain, k, "irrelevant", `a person skipped the site (${cand.decision_reason ?? "no reason"})`, "human");
    for (const w of d.wallets) await close("wallet", w.key, "wallet_not_analyzed", "irrelevant", "the site was skipped", "human");
    return { open: 0 };
  }
  // Set aside by a campaign as a near-duplicate of a site it already covers (and not active elsewhere).
  const memberships = (await db.prepare("SELECT m.state,m.reason FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=? AND c.status NOT IN ('STOPPED','MERGED')").bind(domain).all<Row>()).results;
  if (!d.progress.site_investigated && memberships.length && memberships.every(m => m.state === "suppressed")) {
    for (const k of ["no_site_observation", "no_deposit_destination", "infrastructure_unknown"] as GapKind[]) await close("domain", domain, k, "irrelevant", `set aside by its campaign: ${String(memberships[0].reason ?? "near-duplicate of a covered site").slice(0, 160)}`, "deterministic");
    return { open: 0 };
  }
  // 1. The site itself has not been observed by a module.
  if (d.dead.dead) {
    await close("domain", domain, "no_site_observation", "inaccessible", d.dead.reason, "observed");
    await close("domain", domain, "no_deposit_destination", "inaccessible", "the site is gone", "observed");
  } else if (!d.progress.site_investigated) {
    const g = await upsertGap({ investigationId, campaignId, subjectType: "domain", subjectKey: domain, kind: "no_site_observation", known,
      missing: "No module has looked at the site's pages yet.", actions: [{ action: "site.investigate", how: "Site Investigator examines the public pages (read-only)" }] });
    // A running campaign owns its members' investigations; otherwise the global queue does, but only
    // for candidates that clear the auto-investigate floor or that a person marked useful: a gap is a
    // reason to act, not a way around the operator's threshold.
    const { getBool, getNum } = await import("./common");
    const eligible = cand?.decision === "useful" || ((await getBool("auto_investigate", true)) && Number(cand?.score ?? 0) >= (await getNum("auto_investigate_min_score", 0.5)));
    if (!campaignRunning && !d.in_flight.length && eligible) await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: domain, source: "gap", gapId: g.id, investigationId,
      reason: `${domain}: no module has observed the site yet`, factors: { info_gain: 0.6, novelty: 0.6, evidence_strength: Number(cand?.score ?? 0.5), open_gaps: 1, freshness: 1, cost: 0.3 } });
  } else {
    await close("domain", domain, "no_site_observation", "resolved", "Site Investigator observed the site", "observed");
  }
  // 2. No deposit destination observed.
  if (d.progress.site_investigated && !d.dead.dead) {
    const typedDeposit=!d.wallets.length&&Boolean(await db.prepare("SELECT 1 FROM wallet_candidates WHERE investigation_id=? AND best_context='deposit' LIMIT 1").bind(investigationId).first());
    if (d.wallets.length||typedDeposit) {
      await close("domain", domain, "no_deposit_destination", "resolved", typedDeposit?"Deposit presentation observed; network and checksum validation remain separate":`${d.wallets.length} wallet(s) observed`, "observed");
    } else {
      const barrier = d.barriers[0];
      const g = await upsertGap({ investigationId, campaignId, subjectType: "domain", subjectKey: domain, kind: "no_deposit_destination",
        known: [...known, "Site Investigator loaded the public pages"], missing: "No deposit destination (wallet address) has been observed.",
        actions: barrier ? [{ action: "human.checkpoint", how: `You sign in or complete the ${barrier.kind.replace("_", " ")} step normally; CryptoWalletLogger records what the page shows` }]
          : [{ action: "site.recheck", how: "Site Investigator rechecks the public pages later (deposit pages often appear after launch)" }] });
      const row = await db.prepare("SELECT * FROM evidence_gaps WHERE id=?").bind(g.id).first<Row>();
      const cancelled = d.checkpoints.some(c => c.status === "cancelled");
      if (barrier && cancelled) await transition(row!, "inaccessible", "the human step was declined; the deposit page is behind a login", "human");
      else if (!barrier && Number(row?.attempts ?? 0) >= MAX_RECHECKS) { if (row?.status === "open") await transition(row!, "unresolved", `${MAX_RECHECKS} rechecks found no deposit destination`, "observed"); }
      else if (!barrier && row?.status === "open" && !d.in_flight.length) {
        await proposeWork({ kind: "revisit_incomplete", targetType: "domain", targetKey: domain, source: "gap", gapId: g.id, investigationId, campaignId, reopen: true,
          notBefore: new Date(Date.now() + 6 * 3600000).toISOString(),
          reason: `${domain}: no deposit destination observed yet; recheck later`, factors: { info_gain: 0.45, evidence_strength: Number(cand?.score ?? 0.5), open_gaps: 1, campaign_relevance: campaignId ? 0.5 : 0, cost: 0.3 } });
      }
    }
  }
  // 3. Wallets observed but not analysed.
  for (const w of d.wallets) {
    if (w.analyzed) { await close("wallet", w.key, "wallet_not_analyzed", "resolved", "Wallet Investigator analysed it", "observed"); continue; }
    // v4: wallets from the wallet pipeline are validated and (when they are valid deposit wallets) analysed by it; the
    // scheduler must not queue a second, older-style analysis for them.
    if (await db.prepare("SELECT 1 FROM wallet_candidates WHERE entity_id=? LIMIT 1").bind(w.entity_id).first()) continue;
    // WI-created counterparties/validation projections are not upstream page observations.
    // The legacy worker requires an SI/Logger version and must not retry its own output.
    if (!await db.prepare("SELECT 1 FROM observation_versions WHERE entity_id=? AND source_module IN ('site_investigator','crypto_wallet_logger') LIMIT 1").bind(w.entity_id).first()) {
      await close("wallet", w.key, "wallet_not_analyzed", "irrelevant", "No eligible upstream page observation for legacy wallet analysis", "observed");
      continue;
    }
    const g = await upsertGap({ investigationId, campaignId, subjectType: "wallet", subjectKey: w.key, kind: "wallet_not_analyzed", known: [`Observed on ${domain} by ${w.sources.join(", ")}`],
      missing: "No blockchain analysis of this wallet yet.", actions: [{ action: "wallet.analyze", how: "Wallet Investigator reads public chain data (no transactions, no keys)" }] });
    const running = ["pending", "running", "retrying"].includes(w.analysis);
    const runActive = await db.prepare("SELECT 1 FROM agent_runs WHERE investigation_id=? AND status IN ('RUNNING','WAITING_FOR_MODULE')").bind(investigationId).first();
    if (!running && !runActive) await proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: w.entity_id, source: "gap", gapId: g.id, investigationId, campaignId,
      reason: `Wallet seen on ${domain} has not been analysed`, factors: { info_gain: 0.7, evidence_strength: 0.8, open_gaps: 1, campaign_relevance: campaignId ? 0.6 : 0.1, cost: 0.25 } });
  }
  // 4. Infrastructure unknown (no passive hosting observation at all).
  // Site Finder's passive keys count as soon as they arrive (the facet may be written a moment later in the same ingestion).
  const finderKeys = (parse<Row>(cand?.details, {}).keys as unknown[] | undefined ?? []).some(k => Array.isArray(k) && ["ip", "ns"].includes(String(k[0])));
  const infra = finderKeys || await db.prepare("SELECT 1 FROM entity_facets WHERE subject_type='domain' AND subject_key=? AND facet IN ('ip','nameservers')").bind(domain).first();
  if (infra) await close("domain", domain, "infrastructure_unknown", "resolved", "hosting observed", "observed");
  else await upsertGap({ investigationId, campaignId, subjectType: "domain", subjectKey: domain, kind: "infrastructure_unknown", known, missing: "No passive hosting observation (IP / name servers).",
    actions: [{ action: "discovery.observe", how: "Site Finder resolves DNS passively on its next cycle" }] });
  // 5. Stale: a useful live site not observed by a module for a long time.
  const lastObs = await db.prepare("SELECT MAX(last_seen_at) t FROM entity_facets WHERE subject_type='domain' AND subject_key=? AND source_table IN ('evidence','investigation_entities')").bind(domain).first<Row>();
  if (lastObs?.t && d.wallets.length && hoursSince(lastObs.t) > STALE_DAYS * 24) {
    const g = await upsertGap({ investigationId, campaignId, subjectType: "domain", subjectKey: domain, kind: "stale_observation", known, missing: `No module observation for over ${STALE_DAYS} days.`,
      actions: [{ action: "site.recheck", how: "Site Investigator rechecks the public pages" }] });
    await proposeWork({ kind: "revisit_incomplete", targetType: "domain", targetKey: domain, source: "gap", gapId: g.id, investigationId, campaignId, reopen: true,
      reason: `${domain}: last observed over ${STALE_DAYS} days ago`, factors: { info_gain: 0.35, open_gaps: 1, freshness: 0.2, cost: 0.3 } });
  } else if (lastObs?.t) await close("domain", domain, "stale_observation", "resolved", "observed recently", "observed");

  const open = Number((await db.prepare("SELECT COUNT(*) n FROM evidence_gaps WHERE investigation_id=? AND status='open'").bind(investigationId).first<Row>())?.n ?? 0);
  return { open };
}

/** A recheck ran for a gap without resolving it: count the attempt. */
export async function noteGapAttempt(gapId: string) {
  await getD1().prepare("UPDATE evidence_gaps SET attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(gapId).run();
}

export async function gapsFor(scope: { investigationId?: string; campaignId?: string; status?: string }) {
  const where = ["1=1"], binds: unknown[] = [];
  if (scope.investigationId) { where.push("investigation_id=?"); binds.push(scope.investigationId); }
  if (scope.campaignId) { where.push("campaign_id=?"); binds.push(scope.campaignId); }
  if (scope.status) { where.push("status=?"); binds.push(scope.status); }
  return (await getD1().prepare(`SELECT * FROM evidence_gaps WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC LIMIT 200`).bind(...binds).all<Row>()).results
    .map(g => ({ ...g, known: parse(g.known, []), safe_actions: parse(g.safe_actions, []), history: parse(g.history, []) }));
}
