import React from 'react';
import { Pill, day, Section, Explain, Term } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader, List, Ent } from './common';

const TIER_LABEL: Record<string, string> = {
  SUPPORTED_RELATIONSHIP: 'Supported: operator-level links',
  LIKELY_SHARED_OPERATOR: 'Likely shared operator',
  SHARED_KIT_ONLY: 'Shared kit only',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export function KitsView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  return (
    <Gate state={a} what="Loading kit intelligence">
      {() => {
        const k = a.data.kits;
        const domIds = new Map<string, string>((a.data.infrastructure.domains as any[]).map(d => [d.value, d.id]));
        const operator = (k.indicators as any[]).filter(i => i.level === 'operator');
        const vendor = (k.indicators as any[]).filter(i => i.level === 'vendor');
        const other = (k.indicators as any[]).filter(i => !operator.includes(i) && !vendor.includes(i));
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Kits & operator links" intro="Which scam kit the sites run, how it changed between versions, and — separately — the indicators that point to a single operator rather than a shared kit." />
            <div className="hx-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', marginBottom: 16 }}>
              <div className="hx-card">
                <div className="eyebrow">Attribution level</div>
                <h3 style={{ marginTop: 4 }}>{TIER_LABEL[k.tier.tier] ?? k.tier.tier}</h3>
                <p className="hx-small" style={{ margin: '4px 0 8px' }}>{k.tier.levelDescription}</p>
                <ul className="hx-small" style={{ margin: 0, paddingLeft: 18 }}>{k.tier.criteriaMet.map((c: string) => <li key={c}>{c}</li>)}</ul>
              </div>
              <div className="hx-card">
                <div className="eyebrow">Boundary</div>
                <p className="hx-small" style={{ marginTop: 6 }}>{k.attributionBoundary}</p>
                <div className="hx-small hx-muted"><b>Not claimed:</b> {k.tier.prohibitedClaims.join('; ')}.</div>
              </div>
            </div>

            <Section eyebrow="Software" title="Kit families">
              {!k.families.length && <div className="hx-card hx-muted">No page fingerprints yet. Page structure comes from urlscan scans, Main Platform site checks, or page source you add.</div>}
              {k.families.map((f: any) => (
                <div key={f.name} className="hx-card" style={{ marginBottom: 12 }}>
                  <div className="hx-row"><h3 style={{ margin: 0 }}>{f.name}</h3><Pill>{f.domains.length} site(s)</Pill><span className="hx-small"><List items={f.domains} max={6} render={d => <Ent id={domIds.get(d)} value={d} open={ctx.openEntity} />} /></span>{f.otherOperations.length > 0 && <Pill tone="violet">also in {f.otherOperations.length} other operation(s)</Pill>}</div>
                  {f.capabilities.length > 0 && <div className="hx-small" style={{ marginTop: 8 }}><b>What it does:</b> {f.capabilities.join(' · ')}</div>}
                  <table className="hx-table" style={{ marginTop: 10 }}>
                    <thead><tr><th>Version</th><th>First seen</th><th>Similarity to previous</th><th>Added capabilities</th></tr></thead>
                    <tbody>{(f.variants as any[]).map((v, i) => <tr key={i} className="clickable" onClick={() => ctx.openEntity(v.templateId)}><td className="hx-small">{v.label}</td><td className="hx-small">{day(v.firstSeen)}</td><td className="hx-small">{v.similarityToPrevious == null ? '—' : `${Math.round(v.similarityToPrevious * 100)}%`}</td><td className="hx-small">{v.addedCapabilities.join(', ') || '—'}</td></tr>)}</tbody>
                  </table>
                </div>
              ))}
            </Section>

            <div className="hx-grid cols-2" style={{ marginTop: 6 }}>
              <div className="hx-card">
                <h3>Operator-level indicators</h3>
                <p className="hx-small hx-muted" style={{ marginTop: 0 }}>Set per deployment by whoever runs the sites: analytics IDs, support handles, collection wallets. Several of these repeating is what ties sites to <Term k="operator">one operator</Term>.</p>
                <ul className="hx-list">
                  {operator.map(i => <li key={i.id}><div className="hx-row" style={{ gap: 8 }}><Ent id={i.id} value={i.value} open={ctx.openEntity} /><Pill tone="amber">{i.kind}</Pill>{i.domains.length > 0 && <span className="hx-faint hx-small">{i.domains.length} site(s)</span>}</div><div className="hx-small hx-muted">{i.reason}</div></li>)}
                  {!operator.length && <li className="hx-muted">None found yet.</li>}
                </ul>
              </div>
              <div className="hx-card">
                <h3>Kit / vendor-level indicators</h3>
                <p className="hx-small hx-muted" style={{ marginTop: 0 }}>Embedded by whoever built or sells the kit. They identify the software, and can be identical across unrelated customers.</p>
                <ul className="hx-list">
                  {vendor.map(i => <li key={i.id}><div className="hx-row" style={{ gap: 8 }}><Ent id={i.id} value={i.value} open={ctx.openEntity} /><Pill tone="violet">{i.kind}</Pill>{i.domains.length > 0 && <span className="hx-faint hx-small">{i.domains.length} site(s)</span>}</div><div className="hx-small hx-muted">{i.reason}</div></li>)}
                  {!vendor.length && <li className="hx-muted">None.</li>}
                </ul>
                {other.length > 0 && <><h3 style={{ marginTop: 14 }}>Weaker / context</h3><ul className="hx-list">{other.map(i => <li key={i.id} className="hx-small"><Ent id={i.id} value={i.value} open={ctx.openEntity} /> <Pill tone="context">{i.kind}</Pill> <span className="hx-muted">{i.reason}</span></li>)}</ul></>}
              </div>
            </div>

            <div className="hx-grid cols-2" style={{ marginTop: 14 }}>
              <div className="hx-card">
                <h3>Page templates</h3>
                <table className="hx-table">
                  <thead><tr><th>Template</th><th>Family</th><th>Sites</th></tr></thead>
                  <tbody>{(k.templates as any[]).map(t => <tr key={t.id} className="clickable" onClick={() => ctx.openEntity(t.id)}><td className="mono hx-small">{t.value}</td><td className="hx-small">{t.kitFamily ?? '—'} {t.variant && t.variant !== 'n/a' ? t.variant : ''}</td><td className="hx-small"><List items={t.domains} max={3} /></td></tr>)}</tbody>
                </table>
              </div>
              <div className="hx-card">
                <h3>Shared scripts & assets</h3>
                <ul className="hx-list">
                  {(k.resources as any[]).map(r => <li key={r.id} className={r.common ? 'hx-faint' : ''}><Ent id={r.id} value={r.label ?? r.value} open={ctx.openEntity} mono={false} max={60} /> {r.common && <Pill tone="commodity">common library</Pill>}<div className="hx-small hx-muted">{r.domains.length} site(s){r.otherOperations.length ? ` · also in ${r.otherOperations.length} other operation(s)` : ''}</div></li>)}
                  {!k.resources.length && <li className="hx-muted">No script fingerprints yet.</li>}
                </ul>
              </div>
            </div>
          </div>
        );
      }}
    </Gate>
  );
}
