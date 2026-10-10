import type { Entity, Relationship } from '../types.js';
import type { OpData } from '../analysis/data.js';
import type { MembershipFactor, MembershipRow, MembershipStatus } from '../core/intelStore.js';
import { relevant } from '../analysis/data.js';
import { isCommodity } from '../engine/noise.js';
import { registrableDomain } from '../core/canonical.js';
import { nowIso, round } from '../core/util.js';

/**
 * Probabilistic, explainable membership inference.
 *
 * Starting from the seeds (and anything the analyst confirmed), Hunter asks for
 * every other site: how much evidence ties it to the sites already accepted as
 * part of the operation, and how much evidence says it belongs to someone else?
 *
 * Evidence is grouped into families whose members are not independent
 * (operator settings, certificates, hosting, kit, timing/naming). Within a
 * family signals are combined with diminishing returns; families add in
 * log-odds. Negative evidence is first-class: a different analytics account
 * or support handle, a different kit, an analyst's "not a scam", or a
 * long-established legitimate history.
 *
 * Indicators are classified before they are trusted: an identifier or file
 * that appears on sites belonging to *different* operator groups is a
 * kit/vendor-level indicator and links the software, not the people; a site
 * whose other settings disagree with everyone else carrying an indicator is
 * an inconsistent carrier (a planted or copied indicator) and gains almost
 * nothing from it.
 */

export interface MembershipWeights {
  prior: number;
  operatorId: number; walletRef: number; operatorResource: number; vendorIndicator: number; inconsistentCarrier: number;
  certificate: number; privateNs: number; ip: number; template: number; kitResource: number; redirect: number;
  registrationWave: number; naming: number; succession: number;
  conflictId: number; differentKit: number; analystNo: number; legitHistory: number; conflictCap: number;
  memberThreshold: number; probableThreshold: number; candidateThreshold: number; keepThreshold: number;
}

export const DEFAULT_WEIGHTS: MembershipWeights = {
  prior: -1.6,
  operatorId: 3.4, walletRef: 3.2, operatorResource: 2.4, vendorIndicator: 0.35, inconsistentCarrier: 0.4,
  certificate: 3.0, privateNs: 2.6, ip: 1.0, template: 0.7, kitResource: 0.6, redirect: 2.6,
  registrationWave: 1.0, naming: 0.5, succession: 0.8,
  conflictId: -3.2, differentKit: -1.8, analystNo: -9, legitHistory: -1.6, conflictCap: -7,
  memberThreshold: 0.8, probableThreshold: 0.6, candidateThreshold: 0.35, keepThreshold: 0.7,
};

export type IndicatorLevel = 'operator' | 'vendor' | 'service' | 'infrastructure' | 'commodity' | 'unknown';

export interface IndicatorInfo {
  entityId: string; value: string; type: string; kind: string; level: IndicatorLevel; reason: string;
  carriers: string[]; inconsistent: string[]; population: number; specificity: number;
}

export interface MemberAssessment {
  entityId: string; type: string; value: string; status: MembershipStatus; probability: number; logit: number;
  factors: MembershipFactor[]; previous?: MembershipStatus; analystVerdict?: string | null;
}

export interface OperatorGroup { key: string; domains: string[]; indicators: string[]; overlapWithOperation: string[] }

export interface MembershipAnalysis {
  members: MemberAssessment[];
  byId: Record<string, MemberAssessment>;
  indicators: Record<string, IndicatorInfo>;
  otherGroups: OperatorGroup[];
  iterations: number;
  weights: MembershipWeights;
}

const LINK_TYPES = new Set(['USES_IDENTIFIER', 'REFERENCES_WALLET', 'DELEGATED_TO', 'RESOLVES_TO', 'COVERS', 'CERTIFIED_BY', 'EXECUTES_TEMPLATE', 'SHARES_RESOURCE', 'REDIRECTS_TO']);
const SERVICE_ROLES = new Set(['FEE_RECIPIENT', 'EXCHANGE', 'MIXER', 'BRIDGE', 'DEX', 'SERVICE', 'CEX_DEPOSIT', 'VICTIM']);

export function identifierKind(e: Entity): string {
  const v = e.value;
  if (e.type === 'email') return 'email';
  if (e.type === 'wallet' || e.type === 'contract') return 'wallet';
  if (e.type !== 'identifier') return e.type;
  if (/^wc:/i.test(v)) return 'walletconnect';
  if (/^(G-|UA-|GTM-|AW-)/i.test(v)) return 'analytics';
  if (/^@/.test(v)) return 'telegram';
  if (/verification/i.test(v) || /=/.test(v)) return 'verification';
  return 'identifier';
}

/** Kinds where a site normally carries one value; two different values mean two different owners. */
const EXCLUSIVE_KINDS = new Set(['analytics', 'telegram']);

export function inferMembership(
  data: OpData,
  walletRoles: Map<string, string>,
  opts: { previous?: Map<string, MembershipRow>; weights?: Partial<MembershipWeights>; maxIterations?: number } = {},
): MembershipAnalysis {
  const W: MembershipWeights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const previous = opts.previous ?? new Map<string, MembershipRow>();
  const domains = data.entities.filter(e => e.type === 'domain' && !e.metadata?.unsupported && !isResourceHost(e));
  const domainIds = new Set(domains.map(d => d.id));

  // ---------------------------------------------------------------- 1. which linking nodes touch which sites
  const carriersOf = new Map<string, Set<string>>();     // node id -> domain ids
  const nodesOf = new Map<string, Array<{ node: Entity; rel: Relationship }>>(); // domain id -> nodes
  const addLink = (domainId: string, node: Entity, rel: Relationship) => {
    if (!domainIds.has(domainId) || node.id === domainId) return;
    (carriersOf.get(node.id) ?? carriersOf.set(node.id, new Set()).get(node.id)!).add(domainId);
    (nodesOf.get(domainId) ?? nodesOf.set(domainId, []).get(domainId)!).push({ node, rel });
  };
  for (const r of data.relationships) {
    if (!LINK_TYPES.has(r.type)) continue;
    const a = data.byId.get(r.sourceEntityId), b = data.byId.get(r.targetEntityId);
    if (!a || !b) continue;
    if (a.type === 'domain' && b.type === 'domain') {
      if (r.type === 'REDIRECTS_TO') { addLink(a.id, b, r); addLink(b.id, a, r); }
      continue;
    }
    if (a.type === 'domain') addLink(a.id, b, r);
    else if (b.type === 'domain') addLink(b.id, a, r);
  }

  // ---------------------------------------------------------------- 2. classify indicators
  const exclusiveOf = (domainId: string, kind: string) => (nodesOf.get(domainId) ?? []).filter(x => identifierKind(x.node) === kind).map(x => x.node.id);
  const indicators: Record<string, IndicatorInfo> = {};
  for (const [nodeId, carriers] of carriersOf) {
    const node = data.byId.get(nodeId)!;
    const kind = identifierKind(node);
    const population = populationOf(node, carriers.size);
    const specificity = round(1 / Math.log2(1 + Math.max(1, population)), 3);
    let level: IndicatorLevel = 'unknown';
    let reason = '';
    const inconsistent: string[] = [];
    const role = walletRoles.get(node.value.toLowerCase());
    if (!relevant(node) || isCommodity(node.ubiquity)) { level = 'commodity'; reason = 'Shared by very many unrelated sites (commodity service).'; }
    else if (kind === 'walletconnect') { level = 'vendor'; reason = 'WalletConnect project IDs are usually baked into the kit by whoever built it.'; }
    else if ((node.type === 'wallet' || node.type === 'contract') && role && SERVICE_ROLES.has(role)) { level = 'service'; reason = `The wallet acts as a ${role.toLowerCase().replace('_', ' ')} — many unrelated parties interact with it.`; }
    else if (node.metadata?.commonLibrary) { level = 'commodity'; reason = 'Common public library.'; }
    else if (['ip', 'nameserver', 'certificate'].includes(node.type)) { level = 'infrastructure'; reason = `${node.type === 'certificate' ? 'Certificates are requested by whoever controls the domains' : 'Hosting is shared with other customers'} (${population} known site${population === 1 ? '' : 's'}).`; }
    else {
      // Group carriers by their exclusive operator settings (analytics account, support handle).
      const groups = new Map<string, string[]>();
      for (const d of carriers) {
        for (const k of EXCLUSIVE_KINDS) {
          if (k === kind) continue;
          for (const other of exclusiveOf(d, k)) (groups.get(`${k}:${other}`) ?? groups.set(`${k}:${other}`, []).get(`${k}:${other}`)!).push(d);
        }
      }
      const byKind = new Map<string, Array<[string, string[]]>>();
      for (const [key, ds] of groups) { const k = key.split(':')[0]; (byKind.get(k) ?? byKind.set(k, []).get(k)!).push([key, ds]); }
      let crossOperator = false;
      for (const [, list] of byKind) {
        const sorted = list.sort((a, b) => b[1].length - a[1].length);
        if (sorted.length >= 2 && sorted[1][1].length >= 2) crossOperator = true; // two real groups share this indicator
        // A file (unlike an account or handle) is not planted: the same file under two operators' settings is shared tooling.
        else if (sorted.length >= 2 && node.type === 'artifact') crossOperator = true;
        else if (sorted.length >= 2) {
          // one dominant group; carriers whose setting differs from it are inconsistent carriers
          const dominant = new Set(sorted[0][1]);
          for (const [, ds] of sorted.slice(1)) for (const d of ds) if (!dominant.has(d)) inconsistent.push(d);
        }
      }
      const inOtherOps = data.crossIndex.get(node.canonical ?? node.value);
      const otherOpCount = inOtherOps ? [...inOtherOps].filter(id => id !== data.op.id).length : 0;
      if (crossOperator || (node.type === 'template' && carriers.size > 1) || (node.type === 'artifact' && otherOpCount > 0 && !inconsistent.length)) {
        level = 'vendor';
        reason = crossOperator ? 'Appears on sites run with different analytics accounts / support handles — it identifies the kit or a shared supplier, not one operator.' : node.type === 'template' ? 'Page structure identifies the kit; many customers can deploy the same kit.' : 'The same file appears in other operations.';
      } else if (node.type === 'template') { level = 'vendor'; reason = 'Page structure identifies the kit; many customers can deploy the same kit.'; }
      else { level = 'operator'; reason = node.type === 'artifact' ? 'A file seen only on sites that share the same operator settings — likely a per-deployment configuration.' : 'Set per deployment by whoever runs the site.'; }
    }
    indicators[nodeId] = { entityId: nodeId, value: node.value, type: node.type, kind, level, reason, carriers: [...carriers], inconsistent: [...new Set(inconsistent)], population, specificity };
  }

  // ---------------------------------------------------------------- 3. iterate membership outwards from the anchors
  const verdict = new Map<string, string>();
  for (const [id, row] of previous) if (row.analystVerdict) verdict.set(id, row.analystVerdict);
  for (const d of domains) if (d.metadata?.analystVerdict === 'not_a_scam') verdict.set(d.id, 'not_member');
  const members = new Set<string>(domains.filter(d => d.isSeed || verdict.get(d.id) === 'member').map(d => d.id));
  const earliestMemberReg = () => [...members].map(id => data.byId.get(id)?.metadata?.registeredAt).filter(Boolean).sort()[0] as string | undefined;
  const memberTokens = () => tokenFrequency([...members].map(id => data.byId.get(id)!.value));
  let assessments = new Map<string, MemberAssessment>();
  let iterations = 0;
  const maxIt = opts.maxIterations ?? 10;
  // Sites that are probably members (on infrastructure/certificate evidence) may corroborate each other's
  // operator settings at reduced weight — needed when the anchor itself shows no content (e.g. a seed
  // that was never archived), otherwise operator evidence between its siblings could never count.
  let provisional = new Set<string>();
  // Which sites support each site's membership through non-kit evidence (operator settings, hosting,
  // certificates, redirects, money). Used to require an unbroken chain back to the anchors.
  const support = new Map<string, Set<string>>();
  const PIPELINE_ANCHOR = '__pipeline__';
  while (iterations++ < maxIt) {
    const tokens = memberTokens();
    const earliest = earliestMemberReg();
    const memberExclusive = new Map<string, Set<string>>(); // kind -> node ids used by members
    for (const m of members) for (const k of EXCLUSIVE_KINDS) for (const n of exclusiveOf(m, k)) (memberExclusive.get(k) ?? memberExclusive.set(k, new Set()).get(k)!).add(n);
    const memberKits = new Set<string>();
    for (const m of members) for (const x of nodesOf.get(m) ?? []) if (x.node.type === 'template' && x.node.metadata?.kitFamily) memberKits.add(String(x.node.metadata.kitFamily));
    const memberRegs = [...members].map(id => ({ reg: data.byId.get(id)?.metadata?.registeredAt as string | undefined, registrar: data.byId.get(id)?.metadata?.registrar as string | undefined })).filter(x => x.reg);
    const next = new Map<string, MemberAssessment>();
    let added = 0;
    for (const d of domains) {
      const a = assess(d);
      next.set(d.id, a);
      if (!members.has(d.id) && a.status === 'member') { members.add(d.id); added++; }
    }
    assessments = next;
    if (!added) {
      const prov = new Set([...next.values()].filter(a => a.status === 'probable' && a.probability >= 0.65).map(a => a.entityId));
      if ([...prov].every(id => provisional.has(id))) break;
      provisional = new Set([...provisional, ...prov]);
    }

    function assess(d: Entity): MemberAssessment {
      const prev = previous.get(d.id);
      const fixed = verdict.get(d.id);
      if (d.isSeed || fixed === 'member') {
        return { entityId: d.id, type: d.type, value: d.value, status: 'member', probability: 1, logit: 9, factors: [{ key: 'anchor', family: 'anchor', weight: 9, text: d.isSeed ? 'Seed you started from' : 'Confirmed by you' }], previous: prev?.status, analystVerdict: fixed ?? null };
      }
      const factors: MembershipFactor[] = [];
      const sup = new Set<string>();
      support.set(d.id, sup);
      const fam = new Map<string, number[]>();
      const push = (family: string, key: string, weight: number, text: string, evidenceIds: string[] = []) => {
        factors.push({ key, family, weight: round(weight, 2), text, evidenceIds: evidenceIds.slice(0, 4) });
        (fam.get(family) ?? fam.set(family, []).get(family)!).push(weight);
      };
      const links = nodesOf.get(d.id) ?? [];
      const seenNodes = new Set<string>();
      const seenNs = new Set<string>();
      for (const { node, rel } of links) {
        if (seenNodes.has(node.id)) continue;
        seenNodes.add(node.id);
        const info = indicators[node.id];
        if (node.type === 'domain') {
          if (members.has(node.id)) { push('redirect', `redirect:${node.id}`, W.redirect, `Redirects to/from ${node.value}, a member site`, rel.evidenceIds); sup.add(node.id); }
          continue;
        }
        if (!info || info.level === 'commodity') continue;
        // Carriers whose other settings contradict the indicator cannot vouch for anyone through it.
        const withMembers = info.carriers.filter(c => c !== d.id && members.has(c) && !info.inconsistent.includes(c));
        // Wallets can also tie in through the money pipeline rather than a shared site.
        const pipeline = (node.type === 'wallet' || node.type === 'contract') && !withMembers.length && walletInPipeline(node, members);
        const withProvisional = !withMembers.length && !pipeline && info.level === 'operator' && ['identifier', 'email', 'wallet', 'contract', 'artifact'].includes(node.type)
          ? info.carriers.filter(c => c !== d.id && provisional.has(c)) : [];
        if (withProvisional.length && !info.inconsistent.includes(d.id)) {
          const pn = withProvisional.slice(0, 3).map(id => data.byId.get(id)?.value).join(', ');
          const wt = node.type === 'artifact' ? W.operatorResource : node.type === 'wallet' || node.type === 'contract' ? W.walletRef : W.operatorId;
          push('operator', `prov:${node.id}`, wt * 0.6, `Shares ${short(node.value)} with ${pn}, which ${withProvisional.length === 1 ? 'is' : 'are'} probably part of the operation too`, rel.evidenceIds);
          withProvisional.forEach(id => sup.add(id));
          continue;
        }
        if (!withMembers.length && !pipeline) continue;
        const names = withMembers.slice(0, 3).map(id => data.byId.get(id)?.value).join(', ');
        const inconsistent = info.inconsistent.includes(d.id);
        const before = factors.length;
        switch (node.type) {
          case 'identifier': case 'email': {
            if (info.level === 'vendor') { push('kit', `vendor:${node.id}`, W.vendorIndicator, `Shares kit-level identifier ${short(node.value)} with ${names} (identifies the kit, not the operator)`, rel.evidenceIds); break; }
            if (inconsistent) { push('operator', `inconsistent:${node.id}`, W.inconsistentCarrier, `Shows ${short(node.value)} like ${names}, but its other settings belong to someone else (copied or planted?)`, rel.evidenceIds); break; }
            push('operator', `id:${node.id}`, W.operatorId, `Uses the same ${info.kind === 'analytics' ? 'analytics account' : info.kind === 'telegram' ? 'support handle' : info.kind === 'verification' ? 'account verification token' : 'identifier'} ${short(node.value)} as ${names}`, rel.evidenceIds);
            break;
          }
          case 'wallet': case 'contract':
            if (info.level === 'service') { push('money', `svc:${node.id}`, 0.2, `Interacts with shared service wallet ${short(node.value)}`, rel.evidenceIds); break; }
            push('operator', `wallet:${node.id}`, W.walletRef, pipeline ? `Displays wallet ${short(node.value)}, which sends funds into the operation's pipeline` : `Displays the same receiving wallet ${short(node.value)} as ${names}`, rel.evidenceIds);
            break;
          case 'artifact':
            if (info.level === 'operator') push('operator', `res:${node.id}`, W.operatorResource, `Loads the same per-deployment file ${node.label || short(node.value)} as ${names}`, rel.evidenceIds);
            else push('kit', `kitres:${node.id}`, W.kitResource, `Loads kit file ${node.label || short(node.value)} also used by ${names}`, rel.evidenceIds);
            break;
          case 'template':
            push('kit', `tpl:${node.id}`, W.template, `Same page structure as ${names} (same kit)`, rel.evidenceIds);
            break;
          case 'certificate': {
            const sans = Array.isArray(node.metadata?.san) ? node.metadata.san.length : 2;
            push('certificate', `cert:${node.id}`, W.certificate * Math.min(1, 6 / Math.max(2, sans)), `Covered by the same TLS certificate as ${names}`, rel.evidenceIds);
            break;
          }
          case 'nameserver':
            // ns1./ns2. of the same provider are one fact
            if (seenNs.has(registrableDomain(node.value))) break;
            seenNs.add(registrableDomain(node.value));
            if ((node.ubiquity ?? 0) <= 0.15) push('hosting', `ns:${node.id}`, W.privateNs * Math.min(1, Math.sqrt(50 / Math.max(1, info.population))), `Uses the same private nameserver ${node.value} as ${names} (${info.population} known domain${info.population === 1 ? '' : 's'} on it)`, rel.evidenceIds);
            break;
          case 'ip':
            push('hosting', `ip:${node.id}`, W.ip * Math.min(1, Math.sqrt(4 / Math.max(1, info.population))), `Hosted on ${node.value} like ${names} (${info.population} known site${info.population === 1 ? '' : 's'} on this server)`, rel.evidenceIds);
            break;
          default: break;
        }
        const added = factors.length > before ? factors[factors.length - 1] : null;
        if (added && ['operator', 'hosting', 'certificate'].includes(added.family) && added.weight >= 0.5 && !added.key.startsWith('inconsistent')) {
          withMembers.forEach(id => sup.add(id));
          if (pipeline) sup.add(PIPELINE_ANCHOR);
        }
      }
      // Timing and naming (weak, only as support)
      const reg = d.metadata?.registeredAt as string | undefined;
      if (reg && memberRegs.length) {
        const close = memberRegs.filter(m => Math.abs(Date.parse(m.reg!) - Date.parse(reg)) <= 3 * 86400000);
        if (close.length && close.some(c => c.registrar && c.registrar === d.metadata?.registrar)) push('timing', 'wave', W.registrationWave, `Registered within 3 days of ${close.length} member site${close.length === 1 ? '' : 's'} through the same registrar`);
      }
      const nameScore = namingScore(d.value, tokens);
      if (nameScore >= 0.5 && (!reg || !earliest || Date.parse(reg) >= Date.parse(earliest) - 30 * 86400000)) push('timing', 'naming', W.naming * nameScore, 'Name follows the operation\'s naming pattern');
      // Negative evidence
      for (const k of EXCLUSIVE_KINDS) {
        const mine = exclusiveOf(d.id, k);
        const theirs = memberExclusive.get(k);
        if (!mine.length || !theirs?.size) continue;
        const foreign = mine.filter(n => !theirs.has(n));
        const shared = mine.filter(n => theirs.has(n));
        for (const n of foreign) {
          const nv = data.byId.get(n)?.value ?? n;
          const carriedByNonMembers = (indicators[n]?.carriers ?? []).some(c => c !== d.id && !members.has(c));
          // A new value that nobody else uses is weak evidence (operations rotate accounts); one used by another group is strong.
          const w = shared.length && !carriedByNonMembers ? W.conflictId * 0.25 : carriedByNonMembers ? W.conflictId : W.conflictId * 0.6;
          push('negative', `conflict:${n}`, w, `Uses a different ${k === 'analytics' ? 'analytics account' : 'support handle'} (${short(nv)}) than the operation${carriedByNonMembers ? ', shared with sites outside it' : ''}`);
        }
      }
      const myKits = links.filter(x => x.node.type === 'template' && x.node.metadata?.kitFamily).map(x => String(x.node.metadata.kitFamily));
      if (myKits.length && memberKits.size && !myKits.some(k => memberKits.has(k))) push('negative', 'kit', W.differentKit, `Runs a different kit (${myKits[0]}) from the operation's sites`);
      if (fixed === 'not_member') push('negative', 'analyst', W.analystNo, 'You marked it as not part of this operation');
      if (reg && earliest && Date.parse(reg) < Date.parse(earliest) - 180 * 86400000 && !links.some(x => x.node.type === 'template' || x.node.type === 'identifier')) push('negative', 'history', W.legitHistory, `Registered ${String(reg).slice(0, 10)}, long before the operation began, with no scam-kit evidence`);

      const logit = W.prior + familyScore(fam, W);
      const probability = round(1 / (1 + Math.exp(-logit)), 3);
      const wasMember = prev?.status === 'member' || members.has(d.id);
      let status: MembershipStatus = probability >= W.memberThreshold || (wasMember && probability >= W.keepThreshold) ? 'member'
        : probability >= W.probableThreshold ? 'probable' : probability >= W.candidateThreshold ? 'candidate' : 'unknown';
      if (fixed === 'not_member') status = 'excluded';
      else if (status === 'unknown' && factors.some(f => f.family === 'negative') && logit < -3) status = 'excluded';
      return { entityId: d.id, type: d.type, value: d.value, status, probability, logit: round(logit, 2), factors: factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)), previous: prev?.status, analystVerdict: fixed ?? null };
    }
  }

  // ---------------------------------------------------------------- 3b. anchoring
  // A group of sites can corroborate each other perfectly (another customer of the same kit shares its
  // own analytics account, handle and wallet across its own sites). Membership therefore needs an
  // unbroken chain of non-kit evidence back to the anchors (seed / your confirmations / money pipeline).
  const anchored = new Set<string>([PIPELINE_ANCHOR, ...domains.filter(d => d.isSeed || verdict.get(d.id) === 'member').map(d => d.id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, sup] of support) {
      if (anchored.has(id)) continue;
      const a = assessments.get(id);
      if (!a || (a.status !== 'member' && a.status !== 'probable')) continue;
      if ([...sup].some(s => anchored.has(s))) { anchored.add(id); grew = true; }
    }
  }
  for (const a of assessments.values()) {
    if (a.type !== 'domain' || (a.status !== 'member' && a.status !== 'probable') || anchored.has(a.entityId) || a.analystVerdict) continue;
    a.status = 'candidate';
    a.probability = Math.min(a.probability, 0.5);
    a.factors.push({ key: 'unanchored', family: 'negative', weight: 0, text: 'Its links run only through sites that are not themselves tied to the operation — possibly a separate group using the same tools' });
  }

  // ---------------------------------------------------------------- 4. non-domain entities follow the sites
  const memberIds = new Set([...assessments.values()].filter(a => a.status === 'member').map(a => a.entityId));
  // Money pipeline: from wallets displayed by member sites, follow outgoing funds through the operation's own
  // wallets (collection → splitter → treasury → deposit). Shared services (exchanges, mixers, bridges, fee
  // wallets) are exits: reached, recorded, never walked through. Contract deployers of pipeline contracts join.
  const pipeline = new Map<string, string>(); // wallet id -> reason
  const exits = new Set<string>();
  const queue: string[] = [];
  for (const m of memberIds) for (const x of nodesOf.get(m) ?? []) if ((x.node.type === 'wallet' || x.node.type === 'contract') && !SERVICE_ROLES.has(walletRoles.get(x.node.value.toLowerCase()) ?? '')) { if (!pipeline.has(x.node.id)) { pipeline.set(x.node.id, `Displayed by member site ${data.byId.get(m)?.value}`); queue.push(x.node.id); } }
  for (const e of data.entities) if (e.isSeed && (e.type === 'wallet' || e.type === 'contract') && !pipeline.has(e.id)) { pipeline.set(e.id, 'Seed wallet'); queue.push(e.id); }
  while (queue.length) {
    const cur = queue.shift()!;
    const curVal = data.byId.get(cur)?.value ?? cur;
    for (const r of data.out.get(cur) ?? []) {
      if (r.type !== 'FUNDS_TRANSFER') continue;
      const nxt = data.byId.get(r.targetEntityId);
      if (!nxt || pipeline.has(nxt.id)) continue;
      const role = walletRoles.get(nxt.value.toLowerCase()) ?? '';
      if (SERVICE_ROLES.has(role) || nxt.metadata?.labelKind) { exits.add(nxt.id); continue; }
      pipeline.set(nxt.id, `Receives funds from operation wallet ${short(curVal)}`);
      queue.push(nxt.id);
    }
    for (const r of data.out.get(cur) ?? []) {
      if (r.type !== 'CREATED_BY') continue;
      const deployer = data.byId.get(r.targetEntityId);
      if (deployer && !pipeline.has(deployer.id)) pipeline.set(deployer.id, `Deployed operation contract ${short(curVal)}`);
    }
  }
  for (const e of data.entities) {
    if (e.type === 'domain' && !isResourceHost(e)) continue;
    if (e.isSeed) { assessments.set(e.id, { entityId: e.id, type: e.type, value: e.value, status: 'member', probability: 1, logit: 9, factors: [{ key: 'anchor', family: 'anchor', weight: 9, text: 'Seed you started from' }] }); continue; }
    const info = indicators[e.id];
    const carriers = info?.carriers.filter(c => memberIds.has(c)) ?? [];
    const role = walletRoles.get(e.value.toLowerCase());
    let status: MembershipStatus = 'unknown';
    let probability = 0;
    const factors: MembershipFactor[] = [];
    if ((e.type === 'wallet' || e.type === 'contract') && pipeline.has(e.id) && role !== 'VICTIM') {
      status = 'member'; probability = 0.9; factors.push({ key: 'pipeline', family: 'money', weight: 3, text: `${pipeline.get(e.id)}${role ? ` (${role.toLowerCase().replace('_', ' ')})` : ''}` });
    } else if ((e.type === 'wallet' || e.type === 'contract') && exits.has(e.id)) {
      status = 'candidate'; probability = 0.5; factors.push({ key: 'exit', family: 'money', weight: 1, text: `Where operation money leaves (${(role || String(e.metadata?.labelKind ?? 'service')).toLowerCase().replace('_', ' ')}) — a shared service, not the operator` });
    } else if (info && carriers.length && (info.level === 'operator')) {
      status = 'member'; probability = 0.9; factors.push({ key: 'operator-indicator', family: 'operator', weight: 3, text: `Operator-level indicator used by ${carriers.length} member site${carriers.length === 1 ? '' : 's'}` });
    } else if (info && carriers.length) {
      status = 'candidate'; probability = 0.4; factors.push({ key: 'shared', family: info.level, weight: 0.5, text: `${info.level === 'vendor' ? 'Kit/vendor-level' : info.level === 'infrastructure' ? 'Infrastructure' : 'Shared'} indicator on ${carriers.length} member site${carriers.length === 1 ? '' : 's'}` });
    }
    assessments.set(e.id, { entityId: e.id, type: e.type, value: e.value, status, probability, logit: 0, factors, previous: previous.get(e.id)?.status });
  }

  // ---------------------------------------------------------------- 5. other operator groups among the excluded sites
  const otherGroups = discoverGroups(data, assessments, nodesOf, indicators);
  const list = [...assessments.values()].sort((a, b) => b.probability - a.probability);
  return { members: list, byId: Object.fromEntries(list.map(a => [a.entityId, a])), indicators, otherGroups, iterations, weights: W };

  function walletInPipeline(node: Entity, memberSet: Set<string>): boolean {
    // money arriving from, or leaving to, a wallet displayed by a member site
    const memberWallets = new Set<string>();
    for (const m of memberSet) for (const x of nodesOf.get(m) ?? []) if (x.node.type === 'wallet' || x.node.type === 'contract') memberWallets.add(x.node.id);
    for (const r of [...(data.out.get(node.id) ?? []), ...(data.in.get(node.id) ?? [])]) {
      if (r.type !== 'FUNDS_TRANSFER') continue;
      const other = r.sourceEntityId === node.id ? r.targetEntityId : r.sourceEntityId;
      if (memberWallets.has(other)) return true;
    }
    return false;
  }
}

function familyScore(fam: Map<string, number[]>, W: MembershipWeights): number {
  let total = 0;
  for (const [family, ws] of fam) {
    const pos = ws.filter(w => w > 0).sort((a, b) => b - a);
    const neg = ws.filter(w => w < 0).sort((a, b) => a - b);
    if (family === 'negative') { total += Math.max(W.conflictCap, neg.reduce((s, w) => s + w, 0)); continue; }
    if (family === 'operator') total += pos.reduce((s, w, i) => s + w * [1, 0.6, 0.4, 0.25][Math.min(i, 3)], 0);
    else if (family === 'hosting' || family === 'certificate' || family === 'redirect') total += pos.length ? pos[0] + pos.slice(1).reduce((s, w) => s + w * 0.3, 0) : 0;
    else if (family === 'kit') total += pos.length ? pos[0] + pos.slice(1).reduce((s, w) => s + w * 0.2, 0) : 0;
    else if (family === 'timing') total += Math.min(1.2, pos.reduce((s, w) => s + w, 0));
    else total += pos.reduce((s, w) => s + w, 0);
    total += neg.reduce((s, w) => s + w, 0);
  }
  return total;
}

function populationOf(node: Entity, inOperation: number): number {
  const volume = Number(node.metadata?.resultVolume ?? 0);
  return Math.max(inOperation, Number.isFinite(volume) ? volume : 0, 1);
}

export function isResourceHost(e: Entity) {
  return e.metadata?.role === 'script/resource host' && !e.isSeed;
}

function short(v: string) {
  return v.length > 22 ? `${v.slice(0, 12)}…${v.slice(-6)}` : v;
}

function nameTokens(domain: string): string[] {
  return registrableDomain(domain).split('.')[0].split(/[-_]|(?<=\D)(?=\d)/).filter(t => t.length >= 3);
}

function tokenFrequency(domains: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of domains) for (const t of new Set(nameTokens(d))) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function namingScore(domain: string, tokens: Map<string, number>): number {
  const mine = nameTokens(domain);
  if (!mine.length || tokens.size === 0) return 0;
  const shared = mine.filter(t => (tokens.get(t) ?? 0) >= 2).length;
  return shared / mine.length;
}

function discoverGroups(data: OpData, assessments: Map<string, MemberAssessment>, nodesOf: Map<string, Array<{ node: Entity; rel: Relationship }>>, indicators: Record<string, IndicatorInfo>): OperatorGroup[] {
  // Sites outside the operation that share operator-level settings with each other form another operator's group.
  const outsiders = [...assessments.values()].filter(a => a.type === 'domain' && (a.status === 'excluded' || a.status === 'unknown' || a.status === 'candidate')).map(a => a.entityId);
  const byIndicator = new Map<string, string[]>();
  for (const d of outsiders) for (const x of nodesOf.get(d) ?? []) {
    const k = identifierKind(x.node);
    if (!EXCLUSIVE_KINDS.has(k) && !(x.node.type === 'wallet' && indicators[x.node.id]?.level === 'operator')) continue;
    (byIndicator.get(x.node.id) ?? byIndicator.set(x.node.id, []).get(x.node.id)!).push(d);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
  for (const d of outsiders) parent.set(d, d);
  for (const ds of byIndicator.values()) for (let i = 1; i < ds.length; i++) parent.set(find(ds[i]), find(ds[0]));
  const groups = new Map<string, string[]>();
  for (const d of outsiders) (groups.get(find(d)) ?? groups.set(find(d), []).get(find(d))!).push(d);
  const out: OperatorGroup[] = [];
  for (const ds of groups.values()) {
    if (ds.length < 2) continue;
    const inds = [...byIndicator.entries()].filter(([, v]) => v.some(d => ds.includes(d))).map(([k]) => data.byId.get(k)?.value ?? k);
    const overlap = new Set<string>();
    for (const d of ds) for (const x of nodesOf.get(d) ?? []) if (indicators[x.node.id]?.level === 'vendor') overlap.add(x.node.value);
    out.push({ key: ds.slice().sort()[0], domains: ds.map(id => data.byId.get(id)!.value), indicators: inds.slice(0, 6), overlapWithOperation: [...overlap].slice(0, 6) });
  }
  return out;
}

/** Convert assessments into rows for persistence. */
export function toRows(operationId: string, analysis: MembershipAnalysis): MembershipRow[] {
  const now = nowIso();
  return analysis.members.filter(m => m.status !== 'unknown' || m.previous).map(m => ({
    operationId, entityId: m.entityId, status: m.status, probability: m.probability, factors: m.factors.slice(0, 12), since: now, updatedAt: now, analystVerdict: m.analystVerdict ?? null,
  }));
}
