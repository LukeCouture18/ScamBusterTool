import type { HunterApp } from '../app.js';
import type { OpData } from '../analysis/data.js';
import type { MembershipAnalysis } from '../reasoning/membership.js';
import type { Entity } from '../types.js';
import { registrableDomain, canonicalize } from '../core/canonical.js';
import { newId, nowIso } from '../core/util.js';

/**
 * Hypothesis-driven search. From what is already known about the operation,
 * Hunter derives searches that could surface sites no link points to yet:
 *   - naming patterns: pairs of words that recur in the member domains
 *     (certificate transparency is searched for newly certified names that
 *     contain them);
 *   - page titles that several member sites share (a kit's default title).
 * Each search is an entity of type `pattern`; the pursuit decides whether it
 * is worth running, and every hit must be verified independently before it
 * can become a member.
 */
const GENERIC = new Set(['www', 'app', 'com', 'net', 'org', 'the', 'and', 'official', 'online', 'site', 'web', 'www2', 'io']);

export function namingPairs(domains: string[], minSupport = 2): Array<{ pair: [string, string]; support: number }> {
  const counts = new Map<string, number>();
  for (const d of domains) {
    const toks = [...new Set(registrableDomain(d).split('.')[0].split(/[-_]|(?<=\D)(?=\d)/).map(t => t.toLowerCase()).filter(t => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t)))];
    for (let i = 0; i < toks.length; i++) for (let k = i + 1; k < toks.length; k++) {
      const key = [toks[i], toks[k]].sort().join('+');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= minSupport).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ pair: k.split('+') as [string, string], support: n }));
}

export function ensureSearchPatterns(app: HunterApp, data: OpData, membership: MembershipAnalysis): Entity[] {
  if (data.op.isDemo) return [];
  const memberDomains = membership.members.filter(m => m.type === 'domain' && m.status === 'member').map(m => data.byId.get(m.entityId)!).filter(Boolean);
  if (!memberDomains.length) return [];
  const created: Entity[] = [];
  const earliest = memberDomains.map(d => d.metadata?.registeredAt ?? d.firstSeen).filter(Boolean).sort()[0];
  const since = new Date(Date.parse(earliest ?? nowIso()) - 45 * 86400000).toISOString();
  const exclude = memberDomains.map(d => registrableDomain(d.value));
  const want: Array<{ value: string; label: string; metadata: Record<string, any> }> = [];
  // With a single known site (usually the seed), its own name and title are the only hypothesis available:
  // search them too, at lower support — hits still have to be verified independently.
  const single = memberDomains.length === 1;
  for (const { pair, support } of namingPairs(memberDomains.map(d => d.value), single ? 1 : 2).slice(0, single ? 2 : 3)) {
    want.push({ value: `name:${pair.join('+')}`, label: single ? `Naming pattern: ${pair.join(' + ')} (from ${memberDomains[0].value})` : `Naming pattern: ${pair.join(' + ')} (in ${support} member names)`, metadata: { since, exclude, support, kind: 'naming' } });
  }
  const titles = new Map<string, number>();
  for (const d of memberDomains) { const t = String(d.metadata?.pageTitle ?? '').trim(); if (t.length >= 12) titles.set(t, (titles.get(t) ?? 0) + 1); }
  for (const [t, n] of titles) if (n >= (single ? 1 : 2)) want.push({ value: `title:${t}`, label: `Shared page title "${t.slice(0, 40)}" (${n} member sites)`, metadata: { support: n, kind: 'title', exclude } });
  app.store.tx(() => {
    for (const w of want) {
      const existing = app.store.findEntity(data.op.id, 'pattern', w.value);
      if (existing) {
        if (JSON.stringify(existing.metadata?.exclude ?? []) !== JSON.stringify(w.metadata.exclude)) app.store.updateEntity({ ...existing, metadata: { ...existing.metadata, ...w.metadata } });
        continue;
      }
      const e: Entity = { id: newId('ent', 10), operationId: data.op.id, type: 'pattern', value: w.value, canonical: canonicalize('pattern', w.value), label: w.label, metadata: w.metadata, firstSeen: nowIso(), lastSeen: nowIso(), isActive: true, isSeed: false, depth: 1, ubiquity: 0, tags: ['search'] };
      app.store.insertEntity(e);
      created.push(e);
    }
  });
  if (created.length) app.store.addChange(data.op.id, 'search_planned', `Planned ${created.length} search${created.length === 1 ? '' : 'es'} for sites no link points to yet: ${created.map(c => c.label).join('; ')}`);
  return created;
}
