/**
 * v7: builds the observable decision snapshot for one operation from Main's authoritative records.
 * Read-only. Bounded queries. Nothing here writes evidence or infers ownership.
 */
import { getD1 } from '../platform';
import { parse, type Row } from '../ops/common';
import type { Snapshot, SiteFact, WalletFact, ArtifactFact, QuestionFact, ContradictionFact, HistoryFact, FamilyLearning } from './derive';
import type { TestFamily } from './ontology';

const all = async (q: string, ...a: unknown[]) => (await getD1().prepare(q).bind(...a).all<Row>()).results;
const one = async (q: string, ...a: unknown[]) => getD1().prepare(q).bind(...a).first<Row>();
const GENERIC_NS = /cloudflare|awsdns|azure-dns|googledomains|domaincontrol|cdn|registrar-servers|dnsowl|parkingcrew|public-cdn/i;
const ts = (v: unknown) => { const s = String(v ?? ''); if (!s) return 0; const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; };

function analytics(id: string) { const v = id.trim(); if (/^G-/i.test(v)) return `ga4:${v.toLowerCase()}`; if (/^UA-/i.test(v)) return `ua:${v.toLowerCase()}`; if (/^GTM-/i.test(v)) return `gtm:${v.toLowerCase()}`; return ''; }

/** Recorded public artifacts of an investigation (same extraction rules as the v5 Finder loop). */
async function artifactsOf(inv: string, domain: string) {
  const rows = await all(`SELECT evidence_type,context_text FROM evidence WHERE investigation_id=? AND source_module='site_investigator' AND evidence_type IN ('analytics_ids','socials','page_text','dns') ORDER BY captured_at DESC LIMIT 40`, inv);
  const out: Array<{ kind: ArtifactFact['kind']; value: string }> = [];
  for (const r of rows) {
    const v = parse<unknown>(r.context_text, null), type = String(r.evidence_type);
    if (type === 'analytics_ids' && Array.isArray(v)) for (const id of v) { const a = analytics(String(id)); if (a) out.push({ kind: 'analytics', value: a }); }
    else if (type === 'socials' && Array.isArray(v)) for (const u of v) { const m = String(u).match(/(?:t\.me|telegram\.me|wa\.me)\/([A-Za-z0-9_+]{4,40})/i); if (m) out.push({ kind: 'contact', value: m[1].toLowerCase() }); }
    else if (type === 'page_text' && v && typeof v === 'object') { const t = String((v as Row).title ?? '').replace(new RegExp(domain.replace(/[.]/g, '\\.'), 'ig'), '').trim().toLowerCase(); if (t.length >= 6) out.push({ kind: 'title', value: t.slice(0, 120) }); }
    else if (type === 'dns' && v && typeof v === 'object') for (const ns of ((v as Row).ns ?? (v as Row).nameservers ?? []) as unknown[]) out.push({ kind: 'ns', value: String(ns).toLowerCase().replace(/\.$/, '') });
  }
  return out;
}

/** Decayed per-family outcome statistics from attributed outcomes (exactly-once by construction). */
export async function familyLearning(): Promise<Record<string, FamilyLearning>> {
  const tests = await all(`SELECT id,family,finished_at,outcome FROM adaptive_tests WHERE status IN ('finished','failed') AND attributed_at IS NOT NULL ORDER BY finished_at DESC LIMIT 600`);
  const outcomes = tests.length ? await all(`SELECT test_id,outcome_kind,SUM(credit) credit FROM adaptive_outcomes WHERE test_id IN (SELECT id FROM adaptive_tests WHERE status IN ('finished','failed') AND attributed_at IS NOT NULL ORDER BY finished_at DESC LIMIT 600) GROUP BY test_id,outcome_kind`) : [];
  const costs = tests.length ? await all(`SELECT test_id,dimension,reserved,consumed,measured FROM adaptive_costs WHERE test_id IN (SELECT id FROM adaptive_tests WHERE status IN ('finished','failed') AND attributed_at IS NOT NULL ORDER BY finished_at DESC LIMIT 600)`) : [];
  const byTest = new Map<string, Row[]>(); for (const o of outcomes) { const k = String(o.test_id); byTest.set(k, [...(byTest.get(k) ?? []), o]); }
  const costBy = new Map<string, Row[]>(); for (const c of costs) { const k = String(c.test_id); costBy.set(k, [...(costBy.get(k) ?? []), c]); }
  const out: Record<string, FamilyLearning> = {};
  const perFamily = new Map<string, number>();
  for (const t of tests) {
    const f = String(t.family), seen = perFamily.get(f) ?? 0; if (seen >= 50) continue; perFamily.set(f, seen + 1);
    const w = Math.exp(-Math.max(0, Date.now() - ts(t.finished_at)) / (30 * 86400000));
    const l = out[f] ??= { n: 0, useful: 0, validated_site: 0, validated_wallet: 0, independent: 0, discrimination: 0, report: 0, contradiction: 0, dead: 0, duplicate: 0, generic: 0, measured_n: 0, cost_mean: null };
    l.n += w;
    const kinds = new Map((byTest.get(String(t.id)) ?? []).map(o => [String(o.outcome_kind), Math.min(1, Number(o.credit))] as const));
    const g = (k: string) => kinds.get(k) ?? 0;
    l.validated_site += w * g('validated_site'); l.validated_wallet += w * g('validated_wallet'); l.independent += w * g('independent_evidence');
    const scientificDiscrimination=Math.min(1,g('hypothesis_discrimination')+g('hypothesis_discriminated'));
    const scientificContradiction=Math.min(1,g('contradiction_discovered')+g('contradiction_resolved'));
    l.discrimination += w * scientificDiscrimination; l.report += w * g('report_readiness'); l.contradiction += w * scientificContradiction;
    l.dead += w * g('dead_end'); l.duplicate += w * g('duplicate'); l.generic += w * g('generic_evidence');
    l.useful += w * Math.min(1, g('validated_site') + g('validated_wallet') + g('independent_evidence') + scientificDiscrimination + g('report_readiness') + scientificContradiction + g('site_discovered') * .5);
    const cs = costBy.get(String(t.id)) ?? [];
    const reservedDims = cs.filter(c => Number(c.reserved) > 0 && !['wall_ms', 'worker_ms', 'bytes', 'retries'].includes(String(c.dimension)));
    if (reservedDims.length && reservedDims.every(c => Number(c.measured) === 1)) {
      const v = (d: string) => Number(cs.find(c => c.dimension === d)?.consumed ?? 0);
      const units = v('jobs') * 5 + v('http') + v('dns') * .25 + v('certificate') * 2 + v('rdap') * 2 + v('provider_calls') * 3 + v('wall_ms') / 60000;
      l.cost_mean = ((l.cost_mean ?? 0) * l.measured_n + units) / (l.measured_n + 1); l.measured_n += 1;
    }
  }
  for (const l of Object.values(out)) for (const k of Object.keys(l) as Array<keyof FamilyLearning>) if (typeof l[k] === 'number' && k !== 'measured_n') (l as Record<string, number | null>)[k] = Math.round(Number(l[k]) * 1000) / 1000;
  return out;
}

export async function scopeHistory(scopeKind: string, scopeId: string): Promise<HistoryFact[]> {
  const rows = await all(`SELECT family,subject,inputs_hash,status,useful,outcome,finished_at,gap_keys FROM adaptive_tests WHERE scope_kind=? AND scope_id=? ORDER BY created_at LIMIT 300`, scopeKind, scopeId);
  const out: HistoryFact[] = rows.map(r => { const o = parse<Row>(r.outcome, {}); return { family: String(r.family) as TestFamily, subject: String(r.subject), inputs_hash: String(r.inputs_hash), status: r.status === 'reserved' ? 'reserved' : ['running'].includes(String(r.status)) ? 'running' : 'finished', useful: r.useful == null ? null : Number(r.useful) === 1, dead: Boolean(o.dead_end), duplicate: Boolean(o.duplicate), finished_at: r.finished_at ? String(r.finished_at) : null }; });
  if (scopeKind === 'operation') {
    // v6 operation hunts without a v7 test record still count toward saturation (legacy history).
    const legacy = await all(`SELECT h.family,h.status,h.outcome,h.finished_at FROM operation_hunts h WHERE h.operation_id=? AND NOT EXISTS(SELECT 1 FROM adaptive_tests t WHERE t.hunt_id=h.id) ORDER BY h.created_at LIMIT 100`, scopeId);
    for (const h of legacy) { const o = parse<Row>(h.outcome, {}); out.push({ family: h.family === 'reconstruct_operation' ? 'HUNTER_HYPOTHESIS_TEST' : 'RELATED_SITE_HUNT', subject: h.family === 'reconstruct_operation' ? `hunter:${scopeId}` : `scope:${scopeId}`, inputs_hash: 'v6-legacy', status: h.status === 'finished' ? 'finished' : 'running', useful: h.status === 'finished' ? Boolean(o.useful) : null, dead: h.status === 'finished' && !o.useful, duplicate: false, finished_at: h.finished_at ? String(h.finished_at) : null }); }
  }
  return out;
}

/** The operation's watermark: a cheap fingerprint of every wake condition. */
export async function operationWatermark(op: string) {
  const r = await one(`SELECT
   (SELECT COUNT(*) FROM operation_entities oe JOIN entities e ON e.id=oe.entity_id WHERE oe.operation_id=?1 AND oe.association<>'excluded' AND e.entity_type='site') sites,
   (SELECT COUNT(*)||':'||COALESCE(MAX(c.updated_at),'') FROM wallet_candidates c WHERE c.investigation_id IN (SELECT ie.investigation_id FROM operation_entities oe JOIN investigation_entities ie ON ie.entity_id=oe.entity_id WHERE oe.operation_id=?1 AND oe.association<>'excluded')) wallets,
   (SELECT COUNT(DISTINCT independence_key) FROM operation_edges WHERE operation_id=?1 AND evidence_ids<>'[]') evidence_units,
   (SELECT COUNT(*) FROM operation_contradictions WHERE operation_id=?1 AND status='open') contradictions,
   (SELECT COUNT(*) FROM operation_history WHERE operation_id=?1 AND kind='possible_deployment_wave') waves,
   (SELECT revision FROM hunter_operations WHERE id=?1) hunter_revision,
   (SELECT COUNT(*) FROM director_provider_health WHERE state='healthy') provider_healthy,
   (SELECT COUNT(*) FROM human_checkpoints h WHERE h.status<>'open' AND h.investigation_id IN (SELECT ie.investigation_id FROM operation_entities oe JOIN investigation_entities ie ON ie.entity_id=oe.entity_id WHERE oe.operation_id=?1)) human_resolved,
   (SELECT st.max_hunts-st.hunts+COALESCE((SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?1),0) FROM operation_state st WHERE st.operation_id=?1) budget,
   (SELECT COUNT(*) FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=?1 AND status IN ('finished','failed')) finished_tests,
   (SELECT COUNT(*) FROM evidence WHERE investigation_id IN (SELECT ie.investigation_id FROM operation_entities oe JOIN investigation_entities ie ON ie.entity_id=oe.entity_id WHERE oe.operation_id=?1 AND oe.association<>'excluded')) evidence_rows`, op);
  return { sites: Number(r?.sites ?? 0), wallets: String(r?.wallets ?? ''), evidence_units: Number(r?.evidence_units ?? 0), contradictions: Number(r?.contradictions ?? 0), waves: Number(r?.waves ?? 0),
    hunter_revision: Number(r?.hunter_revision ?? 0), provider_healthy: Number(r?.provider_healthy ?? 0), human_resolved: Number(r?.human_resolved ?? 0), budget: Number(r?.budget ?? 0), finished_tests: Number(r?.finished_tests ?? 0), evidence_rows: Number(r?.evidence_rows ?? 0) };
}

export async function loadOperationSnapshot(op: string, learning?: Record<string, FamilyLearning>): Promise<Snapshot | null> {
  const o = await one('SELECT h.*,st.max_hunts,st.hunts FROM hunter_operations h LEFT JOIN operation_state st ON st.operation_id=h.id WHERE h.id=?', op);
  if (!o) return null;
  const siteRows = await all(`SELECT e.id,e.canonical_key,oe.association,oe.origin,
    (SELECT ie.investigation_id FROM investigation_entities ie WHERE ie.entity_id=e.id ORDER BY ie.rowid LIMIT 1) investigation_id
    FROM operation_entities oe JOIN entities e ON e.id=oe.entity_id WHERE oe.operation_id=? AND e.entity_type='site' ORDER BY e.canonical_key LIMIT 60`, op);
  const members = new Map((await all('SELECT canonical_key,role,state FROM hunter_operation_members WHERE operation_id=? AND entity_type=\'site\'', op)).map(m => [String(m.canonical_key), m] as const));
  const seed = String(o.seed ?? '');
  const sites: SiteFact[] = [];
  const invOf = new Map<string, string>();
  for (const r of siteRows) {
    const key = String(r.canonical_key), inv = r.investigation_id ? String(r.investigation_id) : null; if (inv) invOf.set(key, inv);
    const ev = await one(`SELECT COUNT(*) n,MAX(created_at) last FROM evidence WHERE entity_id=? AND source_module='site_investigator'`, r.id);
    const jobs = await one(`SELECT SUM(CASE WHEN status IN ('pending','running','retrying') THEN 1 ELSE 0 END) active,SUM(CASE WHEN status IN ('failed','needs-review') THEN 1 ELSE 0 END) failed,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) done FROM jobs WHERE target_entity_id=? AND target_module='site_investigator'`, r.id);
    const queuedWork = await one(`SELECT 1 x FROM work_items WHERE target_key=? AND status IN ('queued','running','deferred') AND kind IN ('investigate_candidate','revisit_incomplete','revisit_changed_site') LIMIT 1`, key);
    const wallets = inv ? await one(`SELECT COUNT(*) n,SUM(CASE WHEN best_context='deposit' THEN 1 ELSE 0 END) dep FROM wallet_candidates WHERE investigation_id=?`, inv) : null;
    const depositEdge = await one(`SELECT 1 x FROM relationships WHERE source_entity_id=? AND relationship_type LIKE '%deposit%' LIMIT 1`, r.id);
    const facet = await one(`SELECT value,last_seen FROM operation_facets WHERE operation_id=? AND entity_key=? AND facet='status'`, op, key);
    const member = members.get(key);
    const statusText = `${parse<string>(facet?.value, '')} ${member?.state ?? ''}`.toLowerCase();
    const returned = await one(`SELECT 1 x FROM operation_history WHERE operation_id=? AND kind='returned' AND record_key=? LIMIT 1`, op, `${key}:status`);
    const status: SiteFact['status'] = /dead|dark|suspended|disappeared/.test(parse<string>(facet?.value, '').toLowerCase()) ? 'dead' : returned || /resurfaced|returned/.test(statusText) ? 'returned' : /live/.test(statusText) ? 'live' : 'unknown';
    const changed = ev?.last ? await one(`SELECT 1 x FROM operation_history WHERE operation_id=? AND kind='changed' AND record_key LIKE ? AND record_key NOT LIKE '%:status' AND at>? LIMIT 1`, op, `${key}:%`, ev.last) : null;
    const timing = await one(`SELECT 1 x FROM operation_facets WHERE operation_id=? AND entity_key=? AND (facet LIKE '%first%' OR facet LIKE '%regist%' OR facet LIKE '%created%' OR facet LIKE '%deploy%') LIMIT 1`, op, key);
    const units = await one(`SELECT COUNT(DISTINCT CASE WHEN category IN ('infrastructure_context','template_similarity') THEN independence_key END) weak,COUNT(DISTINCT CASE WHEN category NOT IN ('infrastructure_context','template_similarity') THEN independence_key END) strong FROM operation_edges WHERE operation_id=? AND evidence_ids<>'[]' AND (source_entity_id=? OR target_entity_id=?)`, op, r.id, r.id);
    const barrier = inv ? await one(`SELECT 1 x FROM human_checkpoints WHERE investigation_id=? AND status='open' LIMIT 1`, inv) : null;
    const report = inv ? await one(`SELECT c.ready,c.warnings FROM report_contents c WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1`, inv) : null;
    const recheck = await one(`SELECT 1 x FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? AND family='LIKELY_WALLET_PAGE_INSPECTION' AND subject=? AND status IN ('finished','failed') LIMIT 1`, op, `site:${key}`);
    sites.push({ key, entity_id: String(r.id), investigation_id: inv, association: key === seed ? 'seed' : String(r.association) as SiteFact['association'],
      inspected: Number(ev?.n ?? 0) > 0 || Number(jobs?.done ?? 0) > 0, inspection_failures: Number(jobs?.failed ?? 0), inspection_running: Number(jobs?.active ?? 0) > 0 || Boolean(queuedWork),
      payment_seen: Number(wallets?.n ?? 0) > 0 || Boolean(depositEdge), deposit_seen: Number(wallets?.dep ?? 0) > 0 || Boolean(depositEdge), wallet_page_rechecked: Boolean(recheck),
      status, status_changed_at: facet?.last_seen ? String(facet.last_seen) : null, changed_since_inspection: Boolean(changed), human_barrier: Boolean(barrier),
      strong_units: Number(units?.strong ?? 0), weak_units: Number(units?.weak ?? 0), timing_known: Boolean(timing),
      report: report ? { exists: true, ready: Number(report.ready) === 1, destination: Boolean(await one('SELECT 1 x FROM module_destinations LIMIT 1')), blockers: parse<string[]>(report.warnings, []) } : null });
  }
  const invs = [...new Set([...invOf.values()])];
  const walletRows = invs.length ? await all(`SELECT c.*,(SELECT COUNT(DISTINCT c2.investigation_id) FROM wallet_candidates c2 WHERE c2.identity=c.identity AND c2.validation_status='valid' AND c2.best_context='deposit') validated_sites,
    r.status retry_status,r.next_at retry_next,h.state provider_state,h.next_probe_at provider_next
    FROM wallet_candidates c LEFT JOIN director_retries r ON r.candidate_id=c.id LEFT JOIN director_provider_health h ON h.network=c.validated_network
    WHERE c.investigation_id IN (${invs.map(() => '?').join(',')}) ORDER BY c.created_at LIMIT 80`, ...invs) : [];
  const siteByInv = new Map([...invOf.entries()].map(([k, v]) => [v, k] as const));
  const wallets: WalletFact[] = [];
  for (const c of walletRows) {
    const now = Date.now(), ready = ts(c.retry_next) <= now && (c.provider_state !== 'unavailable' || ts(c.provider_next) <= now);
    const activeJob = await one(`SELECT 1 x FROM jobs WHERE target_module='wallet_investigator' AND status IN ('pending','running','retrying') AND json_extract(payload,'$.wallet_candidate_id')=? LIMIT 1`, c.id);
    const reviewed = await one(`SELECT 1 x FROM adaptive_tests WHERE family='CORRELATION_REVIEW' AND subject=? AND status='finished' AND json_extract(outcome,'$.inputs_validated_sites')=? LIMIT 1`, `wallet:${c.identity}`, Number(c.validated_sites));
    const v5reviewed = await one(`SELECT 1 x FROM director_actions WHERE kind='correlate_wallet' AND fingerprint=? AND status='done' LIMIT 1`, `correlate:${c.identity}:${Number(c.observations)}`);
    const searched = await one(`SELECT 1 x FROM adaptive_tests WHERE family='PUBLIC_ARTIFACT_SEARCH' AND subject=? AND status IN ('finished','failed') LIMIT 1`, `artifact:wallet:${c.identity}`);
    const siteKey = siteByInv.get(String(c.investigation_id)) ?? null;
    const otherDeposits = await one(`SELECT COUNT(DISTINCT identity) n FROM wallet_candidates WHERE investigation_id=? AND validation_status='valid' AND best_context='deposit'`, c.investigation_id);
    wallets.push({ id: String(c.id), identity: String(c.identity), address: String(c.address), network: c.validated_network ? String(c.validated_network) : null, context: String(c.best_context), validation: String(c.validation_status), analysis: String(c.analysis_status),
      investigation_id: String(c.investigation_id), site_key: siteKey, validated_sites: Number(c.validated_sites ?? 0), provider: c.provider_state === 'unavailable' ? 'unavailable' : c.provider_state === 'healthy' ? 'healthy' : 'unknown', provider_ready: ready,
      owned_by_director: ['parked', 'running'].includes(String(c.retry_status)) || Boolean(activeJob) || ['pending', 'queued'].includes(String(c.validation_status)) || String(c.analysis_status) === 'queued' || (String(c.validation_status) === 'valid' && String(c.best_context) === 'deposit' && ['none', 'skipped'].includes(String(c.analysis_status))),
      reuse_reviewed: Boolean(reviewed || v5reviewed), reuse_searched: Boolean(searched), rotation_suspected: Number(otherDeposits?.n ?? 0) > 1 });
  }
  // Artifacts: recorded public identifiers per inspected site, counted across the operation's sites.
  const artifactSites = new Map<string, { kind: ArtifactFact['kind']; value: string; sites: Set<string> }>();
  for (const site of sites.filter(x => x.inspected && x.investigation_id && x.association !== 'excluded')) for (const a of await artifactsOf(String(site.investigation_id), site.key)) {
    const k = `${a.kind}:${a.value}`; const cur = artifactSites.get(k) ?? { ...a, sites: new Set<string>() }; cur.sites.add(site.key); artifactSites.set(k, cur);
  }
  const artifacts: ArtifactFact[] = [];
  for (const a of [...artifactSites.values()].slice(0, 24)) {
    const searched = await one(`SELECT 1 x FROM adaptive_tests WHERE family IN ('PUBLIC_ARTIFACT_SEARCH','REPLACEMENT_SITE_HUNT') AND (subject=? OR objective LIKE ?) AND status IN ('finished','failed') LIMIT 1`, `artifact:${a.kind}:${a.value}`, `%${a.value.replace(/[%_]/g, '')}%`);
    artifacts.push({ kind: a.kind, value: a.value, sites: a.sites.size, distinctive: a.kind === 'analytics' || a.kind === 'contact' || (a.kind === 'ns' && !GENERIC_NS.test(a.value)), searched: Boolean(searched), site_key: [...a.sites][0] ?? null });
  }
  // Site Finder requests from ANY component (Hunter proposals, the investigation loop, the v5 Director, v6/v7
  // operation hunts) on this operation's sites: an artifact already handed to Finder is not searched again, and
  // every related-site request counts toward related-site saturation.
  const siteKeys = sites.map(x => x.key);
  const finderJobs = siteKeys.length ? await all(`SELECT j.id,j.status,j.created_at,json_extract(j.payload,'$.seeds') seeds,json_extract(j.payload,'$.domain') domain,json_extract(j.payload,'$.artifacts') artifacts,json_extract(j.result,'$.new_candidates') found,
    (SELECT t.id FROM adaptive_tests t WHERE t.job_id=j.id OR t.work_item_id=json_extract(j.payload,'$.work_item_id')) test_id
    FROM jobs j WHERE j.job_type='FIND_RELATED_SITES' AND j.status IN ('pending','running','retrying','completed') ORDER BY j.created_at DESC LIMIT 80`) : [];
  const requested = new Set<string>(), sentSeeds = new Set<string>(); const external: HistoryFact[] = [];
  for (const j of finderJobs) {
    const seeds = [...parse<string[]>(j.seeds, []), String(j.domain ?? '')].filter(Boolean);
    if (!seeds.some(x => siteKeys.includes(x))) continue;
    for (const x of seeds) sentSeeds.add(x.toLowerCase());
    for (const a of parse<Array<{ kind?: string; value?: string }>>(j.artifacts, [])) if (a?.value) requested.add(String(a.value).toLowerCase());
    if (!j.test_id) external.push({ family: 'RELATED_SITE_HUNT', subject: `scope:${op}`, inputs_hash: `external:${j.id}`, status: j.status === 'completed' ? 'finished' : 'running', useful: j.status === 'completed' ? parse<unknown[]>(j.found, []).length > 0 : null, dead: j.status === 'completed' && !parse<unknown[]>(j.found, []).length, duplicate: false, finished_at: String(j.created_at) });
  }
  for (const a of artifacts) if (requested.has(a.value.toLowerCase()) || requested.has(a.value.replace(/^(ga4|ua|gtm):/, '').toLowerCase())) a.searched = true;
  for (const w of wallets) if (requested.has(w.address.toLowerCase())) w.reuse_searched = true;
  const hyps = await all('SELECT hypothesis_key,statement,status,supports,contradicts FROM operation_hypotheses WHERE operation_id=? ORDER BY hypothesis_key LIMIT 100', op);
  const qmap = new Map<string, QuestionFact>();
  for (const h of hyps) {
    const [qk, ...rest] = String(h.hypothesis_key).split(':'); const hk = rest.join(':') || qk;
    const statement = String(h.statement), label = statement.split('Possible explanation:')[1]?.trim() ?? statement, question = statement.split(' — Possible explanation:')[0];
    const q = qmap.get(qk) ?? { key: qk, question, alternatives: [], supports: 0, contradicts: 0 };
    q.alternatives.push({ key: hk, label, status: String(h.status) }); q.supports = (q.supports ?? 0) + parse<unknown[]>(h.supports, []).length; q.contradicts = (q.contradicts ?? 0) + parse<unknown[]>(h.contradicts, []).length;
    qmap.set(qk, q);
  }
  const lastHunter = await one(`SELECT MAX(at) at FROM operation_history WHERE operation_id=? AND kind IN ('hypothesis','contradiction','hunter_finding')`, op);
  const sinceHunter = Number((await one(`SELECT COUNT(DISTINCT independence_key) n FROM operation_edges WHERE operation_id=? AND evidence_ids<>'[]' AND category NOT IN ('infrastructure_context','template_similarity') AND first_seen>?`, op, String(lastHunter?.at ?? '')))?.n ?? 0);
  const contradictions: ContradictionFact[] = (await all('SELECT fingerprint,summary,status,detail FROM operation_contradictions WHERE operation_id=? ORDER BY fingerprint LIMIT 50', op))
    .map(c => ({ fingerprint: String(c.fingerprint), summary: String(c.summary), kind: String(parse<Row>(c.detail, {}).kind ?? 'unknown'), status: String(c.status), new_evidence_since_hunter: sinceHunter > 0 }));
  const unitRows = await all(`SELECT category,COUNT(DISTINCT independence_key) n FROM operation_edges oe WHERE operation_id=? AND evidence_ids<>'[]' AND NOT EXISTS(SELECT 1 FROM operation_entities ex WHERE ex.operation_id=oe.operation_id AND ex.association='excluded' AND ex.entity_id IN (oe.source_entity_id,oe.target_entity_id)) GROUP BY category`, op);
  const units: Record<string, number> = Object.fromEntries(unitRows.map(u => [String(u.category), Number(u.n)]));
  units.validated_wallet_reuse = wallets.filter(w => w.validation === 'valid' && w.context === 'deposit' && w.validated_sites >= 2).length;
  const waves = await one(`SELECT COUNT(*) n,MAX(at) newest FROM operation_history WHERE operation_id=? AND kind='possible_deployment_wave'`, op);
  const lastHunt = await one(`SELECT MAX(created_at) at FROM adaptive_tests WHERE scope_kind='operation' AND scope_id=? AND family IN ('RELATED_SITE_HUNT','REPLACEMENT_SITE_HUNT') AND json_extract(objective,'$.mode')='wave'`, op);
  const bonus = Number((await one(`SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?`, op))?.bonus ?? 0);
  return {
    scope: { kind: 'operation', id: op, label: String(o.name || o.code || o.external_id), seed: seed || null, investigation_id: o.investigation_id ? String(o.investigation_id) : null },
    now: new Date().toISOString(), sites, wallets, artifacts, questions: [...qmap.values()], contradictions, units,
    waves: { count: Number(waves?.n ?? 0), newest_unhunted: Number(waves?.n ?? 0) > 0 && ts(waves?.newest) > ts(lastHunt?.at) },
    hunter: { present: !String(o.id).startsWith('split:') && Boolean(o.external_id), evidence_since_last_analysis: sinceHunter },
    history: [...await scopeHistory('operation', op), ...external.reverse()], learning: learning ?? await familyLearning(),
    finder_sent: { seeds: [...sentSeeds].sort(), artifacts: [...requested].sort() },
    budget: { remaining: Math.max(0, Number(o.max_hunts ?? 8) + bonus - Number(o.hunts ?? 0)), max: Number(o.max_hunts ?? 8) + bonus },
  };
}
