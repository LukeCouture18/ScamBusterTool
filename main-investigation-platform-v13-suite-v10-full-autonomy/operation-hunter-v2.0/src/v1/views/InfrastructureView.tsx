import React, { useState } from 'react';
import { Pill, Meter, day, Term, Section, Explain } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader, Ent, Stat, List } from './common';

const STATUS_LABEL: Record<string, string> = { active: 'Active', standby: 'Standby', taken_down: 'Taken down', inactive: 'Inactive', unknown: 'Unknown' };

export function InfrastructureView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  const [showAll, setShowAll] = useState(false);
  return (
    <Gate state={a} what="Loading infrastructure">
      {() => {
        const inf = a.data.infrastructure;
        const sites = (inf.domains as any[]).filter(d => !d.isResourceHost);
        const resourceHosts = (inf.domains as any[]).filter(d => d.isResourceHost);
        const visible = showAll ? sites : sites.filter(d => d.role === 'core' || d.role === 'peripheral' || d.isSeed);
        const byId = (v: string) => (inf.domains as any[]).find(d => d.value === v)?.id;
        const counts = { core: sites.filter(d => d.role === 'core').length, active: sites.filter(d => d.status === 'active').length, down: inf.takenDown.length };
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Infrastructure" intro="The sites, servers, nameservers and certificates behind the operation, and how they were deployed over time." />
            <div className="hx-grid cols-4" style={{ marginBottom: 16 }}>
              <Stat label="Core sites" value={counts.core} sub={`${sites.length} sites known in total`} />
              <Stat label="Active now" value={counts.active} sub={`${inf.standby.length} standby · ${counts.down} taken down`} />
              <Stat label="Deployment waves" value={inf.waves.length} sub={inf.naming?.pattern ? <>Naming pattern <span className="mono">{inf.naming.pattern}</span></> : 'No naming pattern'} />
              <Stat label="Hosting" value={inf.hosting.filter((h: any) => !h.commodity).length} sub={`${inf.asns.length} networks · ${inf.nameserverSets.length} nameserver set(s)`} />
            </div>
            <Explain>
              <b>How to read this:</b> a site is <Term k="core">core</Term> when evidence independent of shared services ties it to the seed; <Term k="peripheral">peripheral</Term> when only weaker links do.
              Shared hosting, registrars and CDNs are shown but never treated as proof that two sites share an owner.
            </Explain>

            <Section eyebrow="Sites" title="Domains" right={<label className="hx-row hx-small hx-muted"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show context & unrelated domains ({sites.length - visible.length} hidden)</label>}>
              <div className="hx-card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="hx-table">
                  <thead><tr><th>Domain</th><th>Role</th><th>Status</th><th>Registered</th><th>Registrar</th><th>Hosting</th><th>Kit</th><th>Link strength</th></tr></thead>
                  <tbody>
                    {visible.map(d => (
                      <tr key={d.id} className={`clickable ${d.role === 'context' ? 'dim' : ''}`} onClick={() => ctx.openEntity(d.id)}>
                        <td><span className="mono">{d.value}</span>{d.isSeed && <> <Pill tone="blue">seed</Pill></>}{d.pageTitle && <div className="hx-faint hx-small">{d.pageTitle}</div>}</td>
                        <td><Pill tone={d.role}>{d.role}</Pill></td>
                        <td><Pill tone={d.status}>{STATUS_LABEL[d.status] ?? d.status}</Pill>{d.statusReason && <div className="hx-faint hx-small">{d.statusReason}</div>}</td>
                        <td className="hx-small">{day(d.registeredAt)}</td>
                        <td className="hx-small">{d.registrar ?? '—'}</td>
                        <td className="hx-small mono">{(d.ips ?? []).slice(0, 2).join(', ') || '—'}<div className="hx-faint">{(d.asns ?? []).join(', ')}</div></td>
                        <td className="hx-small">{d.kitFamily ?? '—'}</td>
                        <td style={{ minWidth: 110 }}><Meter value={(d.linkStrength ?? 0) * 100} tone={d.linkStrength >= 0.7 ? 'green' : undefined} /><div className="hx-faint hx-small">{d.discoveredIn ? `via ${d.discoveredIn}` : ''}</div></td>
                      </tr>
                    ))}
                    {!visible.length && <tr><td colSpan={8} className="hx-muted">No sites yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              {resourceHosts.length > 0 && <p className="hx-small hx-muted">Also seen loading scripts or assets on these sites (not treated as operation sites): <List items={resourceHosts.map(r => r.value)} max={8} /></p>}
            </Section>

            <div className="hx-grid cols-2" style={{ marginTop: 18 }}>
              <div className="hx-card">
                <h3>Deployment waves</h3>
                <p className="hx-small hx-muted" style={{ marginTop: 0 }}>Domains registered close together, usually with the same registrar and nameservers — a sign of batch setup.</p>
                <ul className="hx-timeline">
                  {inf.waves.map((w: any) => (
                    <li key={w.index} className="imp-2"><time>{day(w.start)}{w.end && w.end.slice(0, 10) !== w.start.slice(0, 10) ? ` → ${day(w.end)}` : ''}</time>
                      <div><b>Wave {w.index}</b> · {w.domains.length} domain(s)</div>
                      <div className="hx-small"><List items={w.domains} render={v => <Ent id={byId(v)} value={v} open={ctx.openEntity} />} /></div>
                      <div className="hx-faint hx-small">{w.registrars.join(', ')}{w.nameservers.length ? ` · ${w.nameservers.join(', ')}` : ''}</div>
                    </li>
                  ))}
                  {!inf.waves.length && <li className="hx-muted">Registration dates not collected yet (RDAP).</li>}
                </ul>
              </div>
              <div className="hx-card">
                <h3>Rotations</h3>
                <p className="hx-small hx-muted" style={{ marginTop: 0 }}>A site going dark followed by a new site with the same fingerprint — the operation moving rather than stopping.</p>
                <ul className="hx-list">
                  {inf.rotations.map((r: any, i: number) => (
                    <li key={i}><div><Ent id={byId(r.from)} value={r.from} open={ctx.openEntity} /> <span className="hx-faint">→</span> <Ent id={byId(r.to)} value={r.to} open={ctx.openEntity} /></div>
                      <div className="hx-small hx-muted">{day(r.at)} · {r.gapDays} day gap · shared: {r.sharedFeatures.join(', ')}</div></li>
                  ))}
                  {!inf.rotations.length && <li className="hx-muted">No rotations observed.</li>}
                </ul>
                {(inf.standby.length > 0 || inf.possibleReserve.length > 0) && <>
                  <h3 style={{ marginTop: 14 }}>Held in reserve</h3>
                  {inf.standby.length > 0 && <div className="hx-small">Standby (registered, configured, not yet used): <List items={inf.standby} render={v => <Ent id={byId(v)} value={v} open={ctx.openEntity} />} /></div>}
                  {inf.possibleReserve.length > 0 && <div className="hx-small" style={{ marginTop: 6 }}>Possibly reserved (matches naming, not yet tied by evidence): <List items={inf.possibleReserve} /></div>}
                </>}
              </div>
            </div>

            <div className="hx-grid cols-2" style={{ marginTop: 14 }}>
              <div className="hx-card">
                <h3>Servers & networks</h3>
                <table className="hx-table">
                  <thead><tr><th>IP</th><th>Network</th><th>Sites</th></tr></thead>
                  <tbody>{inf.hosting.map((h: any) => <tr key={h.ip} className={h.commodity ? 'dim' : ''}><td className="mono">{h.ip}{h.commodity && <div><Pill tone="commodity">shared service</Pill></div>}</td><td className="hx-small">{h.asn}<div className="hx-faint">{h.holder} {h.country ? `· ${h.country}` : ''}</div></td><td className="hx-small"><List items={h.domains} max={4} /></td></tr>)}</tbody>
                </table>
              </div>
              <div className="hx-card">
                <h3>Nameservers & registrars</h3>
                <ul className="hx-list">
                  {inf.nameserverSets.map((n: any) => <li key={n.key}><span className="mono">{n.key}</span> {n.commodity ? <Pill tone="commodity">large provider</Pill> : <Pill tone="amber">private</Pill>}<div className="hx-small hx-muted">{n.domains.length} domain(s)</div></li>)}
                  {inf.registrars.map((r: any) => <li key={r.name}>{r.name} {r.commodity && <Pill tone="commodity">common registrar</Pill>}<div className="hx-small hx-muted">{r.domains.length} domain(s)</div></li>)}
                </ul>
                <div className="hx-small hx-muted" style={{ marginTop: 8 }}>TLDs: {Object.entries(inf.tlds).map(([t, n]) => `.${t} ×${n}`).join(', ')}</div>
              </div>
            </div>

            <Section eyebrow="Certificates" title="Certificate transparency">
              <div className="hx-card" style={{ padding: 0 }}>
                <table className="hx-table">
                  <thead><tr><th>Certificate</th><th>Issued</th><th>Names</th><th>Operation sites covered</th></tr></thead>
                  <tbody>{inf.certificates.map((c: any) => <tr key={c.id} className="clickable" onClick={() => ctx.openEntity(c.id)}><td>{c.issuer}</td><td className="hx-small">{day(c.notBefore)}</td><td className="hx-small mono"><List items={c.names} max={4} /></td><td className="hx-small"><List items={c.domainsInOperation} max={4} /></td></tr>)}
                    {!inf.certificates.length && <tr><td colSpan={4} className="hx-muted">No certificates collected yet.</td></tr>}</tbody>
                </table>
              </div>
            </Section>
          </div>
        );
      }}
    </Gate>
  );
}
