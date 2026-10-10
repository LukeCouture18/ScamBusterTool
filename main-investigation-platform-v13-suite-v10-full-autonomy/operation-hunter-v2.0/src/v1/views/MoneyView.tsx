import React, { useMemo } from 'react';
import { Pill, Section, Explain, amounts, dt, short, WALLET_ROLE_LABEL, WALLET_ROLE_TONE } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader, Stat, Ent } from './common';

const COLUMNS: Array<{ title: string; roles: string[] }> = [
  { title: 'Victims', roles: ['VICTIM'] },
  { title: 'Collection', roles: ['COLLECTION', 'DEPLOYER'] },
  { title: 'Splitting', roles: ['SPLITTER', 'INTERMEDIARY', 'UNKNOWN'] },
  { title: 'Destinations', roles: ['TREASURY', 'FEE_RECIPIENT'] },
  { title: 'Cash-out', roles: ['CEX_DEPOSIT', 'EXCHANGE', 'MIXER', 'BRIDGE', 'DEX', 'SERVICE'] },
];
const usd = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${Math.round(n)}`);

function FlowDiagram({ wallets, flows, open }: { wallets: any[]; flows: any[]; open: (id: string) => void }) {
  const layout = useMemo(() => {
    const colOf = (role: string) => Math.max(0, COLUMNS.findIndex(c => c.roles.includes(role)));
    const byAddr = new Map<string, any>(wallets.map(w => [w.address.toLowerCase(), w]));
    const victims = wallets.filter(w => w.role === 'VICTIM');
    const nodes: Array<{ key: string; col: number; label: string; sub: string; role: string; id?: string; x: number; y: number }> = [];
    const keyOf = (addr: string) => { const w = byAddr.get(addr.toLowerCase()); return w?.role === 'VICTIM' ? 'victims' : addr.toLowerCase(); };
    const perCol: any[][] = COLUMNS.map(() => []);
    if (victims.length) perCol[0].push({ key: 'victims', label: `${victims.length} victim wallet(s)`, sub: usd(victims.reduce((s, v) => s + (v.outboundUsd ?? 0), 0)), role: 'VICTIM' });
    const flowAddrs = new Set(flows.flatMap(f => [f.from.toLowerCase(), f.to.toLowerCase()]));
    for (const w of wallets) {
      if (w.role === 'VICTIM' || !flowAddrs.has(w.address.toLowerCase())) continue;
      perCol[colOf(w.role)].push({ key: w.address.toLowerCase(), label: w.label && w.label !== w.address ? short(w.label, 22) : short(w.address, 16), sub: `${WALLET_ROLE_LABEL[w.role] ?? w.role} · ${usd(Math.max(w.inboundUsd ?? 0, w.outboundUsd ?? 0))}`, role: w.role, id: w.id });
    }
    const W = 1040, colW = W / COLUMNS.length, rowH = 54;
    const maxRows = Math.max(1, ...perCol.map(c => c.length));
    perCol.forEach((col, ci) => col.slice(0, 14).forEach((n, ri) => nodes.push({ ...n, col: ci, x: ci * colW + 8, y: 34 + ri * rowH + ((Math.min(maxRows, 14) - Math.min(col.length, 14)) * rowH) / 2 })));
    const pos = new Map(nodes.map(n => [n.key, n]));
    const agg = new Map<string, { from: string; to: string; usd: number; label: string }>();
    for (const f of flows) {
      const a = keyOf(f.from), b = keyOf(f.to);
      if (!pos.has(a) || !pos.has(b) || a === b) continue;
      const k = `${a}>${b}`;
      const cur = agg.get(k) ?? { from: a, to: b, usd: 0, label: '' };
      cur.usd += f.usd ?? 0; cur.label = `${f.total} ${f.symbol}`;
      agg.set(k, cur);
    }
    const maxUsd = Math.max(1, ...[...agg.values()].map(e => e.usd));
    return { nodes, edges: [...agg.values()], pos, W, H: 34 + Math.min(maxRows, 14) * rowH + 10, colW, maxUsd };
  }, [wallets, flows]);
  const nodeW = layout.colW - 30;
  return (
    <div className="hx-flow">
      <svg width={layout.W} height={layout.H} style={{ display: 'block', minWidth: layout.W }}>
        {COLUMNS.map((c, i) => <text key={c.title} x={i * layout.colW + 8} y={16} fill="#7d8ba3" fontSize={11} fontWeight={800} letterSpacing=".07em">{c.title.toUpperCase()}</text>)}
        {layout.edges.map((e, i) => {
          const a = layout.pos.get(e.from)!, b = layout.pos.get(e.to)!;
          const x1 = a.x + nodeW, y1 = a.y + 20, x2 = b.x, y2 = b.y + 20;
          const back = x2 <= x1;
          const d = back ? `M${a.x + nodeW / 2},${a.y + 40} C${a.x + nodeW / 2},${a.y + 80} ${b.x + nodeW / 2},${b.y + 80} ${b.x + nodeW / 2},${b.y + 40}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
          return <path key={i} d={d} fill="none" stroke="#2aa37a" strokeOpacity={0.55} strokeWidth={1.5 + 7 * (e.usd / layout.maxUsd)}><title>{`${usd(e.usd)} (${e.label})`}</title></path>;
        })}
        {layout.nodes.map(n => (
          <g key={n.key} style={{ cursor: n.id ? 'pointer' : 'default' }} onClick={() => n.id && open(n.id)}>
            <rect x={n.x} y={n.y} width={nodeW} height={40} rx={8} fill="#0f1a2a" stroke={n.role === 'TREASURY' || n.role === 'DEPLOYER' ? '#e05a67' : n.role === 'COLLECTION' || n.role === 'SPLITTER' ? '#d9a53a' : n.role === 'VICTIM' ? '#2aa37a' : '#2b4163'} />
            <text x={n.x + 9} y={n.y + 17} fill="#dbe6f5" fontSize={11.5} fontFamily="Consolas,monospace">{n.label}</text>
            <text x={n.x + 9} y={n.y + 32} fill="#7d8ba3" fontSize={10.5}>{n.sub}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function MoneyView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  return (
    <Gate state={a} what="Loading money flows">
      {() => {
        const f = a.data.financial;
        if (!f.hasData) return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Money" intro="Where victims' funds went." />
            <div className="hx-card hx-muted">No wallet activity yet. Hunter collects on-chain transfers once it finds wallet addresses on the operation's sites (or you add one as a seed).</div>
          </div>
        );
        const wallets = (f.wallets as any[]);
        const ops = wallets.filter(w => w.role !== 'VICTIM');
        const idOf = (addr: string) => wallets.find(w => w.address.toLowerCase() === addr.toLowerCase())?.id;
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Reconstruction" title="Money" intro="How victim funds were collected, split, stored and cashed out — reconstructed from public blockchain records." />
            <div className="hx-grid cols-4" style={{ marginBottom: 16 }}>
              <Stat label="Taken from victims" value={usd(f.stolen.usd)} sub={`${amounts(f.stolen.bySymbol)} · ${f.stolen.victims} victim wallet(s)`} />
              <Stat label="Operational wallets" value={ops.length} sub={`on ${f.networks.join(', ')}`} />
              <Stat label="Sweep speed" value={f.sweepTiming?.medianSeconds != null ? `${Math.round(f.sweepTiming.medianSeconds / 60)} min` : '—'} sub={f.sweepTiming?.automated ? 'automated (bot)' : f.sweepTiming?.samples ? 'manual' : 'not enough data'} />
              <Stat label="Cash-out points" value={f.exits.length} sub={f.exits.map((e: any) => e.kind).filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i).join(', ') || '—'} />
            </div>
            <Explain><b>Boundary:</b> transfers show that funds moved between addresses. They do not show who controls an address. Exchange deposit addresses are the most useful point for a legal request to the exchange.</Explain>
            <Section eyebrow="Pipeline" title="Where the money went">
              <div className="hx-card"><FlowDiagram wallets={wallets} flows={f.flows} open={ctx.openEntity} /></div>
            </Section>

            <div className="hx-grid cols-2" style={{ marginTop: 6 }}>
              <div className="hx-card">
                <h3>Cash-out</h3>
                <ul className="hx-list">
                  {(f.exits as any[]).map(e => <li key={e.address}><div className="hx-row" style={{ gap: 8 }}><Ent id={idOf(e.address)} value={e.label ?? e.address} open={ctx.openEntity} mono={false} /><Pill tone={e.kind === 'mixer' ? 'violet' : 'blue'}>{e.kind}</Pill><b>{usd(e.usd)}</b></div><div className="hx-small hx-muted">{amounts(e.bySymbol)} via {e.via.map((v: string) => short(v, 14)).join(', ')}</div></li>)}
                  {!f.exits.length && <li className="hx-muted">No exits identified yet.</li>}
                </ul>
              </div>
              <div className="hx-card">
                <h3>Behaviour</h3>
                <ul className="hx-list hx-small">
                  {f.sweepTiming?.description && <li>{f.sweepTiming.description}</li>}
                  {(f.splits as any[]).map(s => <li key={s.splitter}>Splitter <Ent id={idOf(s.splitter)} value={s.splitter} open={ctx.openEntity} max={16} /> divides funds: {s.recipients.map((r: any) => `${Math.round(r.share * 100)}% → ${short(r.address, 12)}${r.role && r.role !== 'UNKNOWN' ? ` (${WALLET_ROLE_LABEL[r.role] ?? r.role})` : ''}`).join(', ')}</li>)}
                  {(f.rotations as any[]).map((r, i) => <li key={i}>Wallet rotation on {r.network}: <Ent id={idOf(r.originalAddress)} value={r.originalAddress} open={ctx.openEntity} max={14} /> → <Ent id={idOf(r.rotatedAddress)} value={r.rotatedAddress} open={ctx.openEntity} max={14} /> ({dt(r.rotationTimestamp)}). {r.reason}</li>)}
                  {(f.deployers as any[]).map(d => <li key={d.deployer}>Deployer <Ent id={idOf(d.deployer)} value={d.deployer} open={ctx.openEntity} max={16} /> created {d.contracts.length} collection contract(s).</li>)}
                  {(f.crossChain as any[]).filter(c => c.bridgedVolumeUsd > 0).map((c, i) => <li key={i}>Bridged {usd(c.bridgedVolumeUsd)} from {c.network} via {c.bridgeProtocol}.</li>)}
                </ul>
              </div>
            </div>

            <Section eyebrow="Addresses" title="Operational wallets">
              <div className="hx-card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="hx-table">
                  <thead><tr><th>Address</th><th>Role</th><th>Network</th><th>In</th><th>Out</th><th>Counterparties</th><th>Active</th></tr></thead>
                  <tbody>{ops.map(w => (
                    <tr key={w.id} className="clickable" onClick={() => ctx.openEntity(w.id)}>
                      <td><span className="mono">{short(w.address, 20)}</span>{w.label && w.label.toLowerCase() !== w.address && <div className="hx-faint hx-small">{w.label}</div>}{w.otherOperations.length > 0 && <Pill tone="violet">in other ops</Pill>}</td>
                      <td><Pill tone={WALLET_ROLE_TONE[w.role]}>{WALLET_ROLE_LABEL[w.role] ?? w.role}</Pill><div className="hx-faint hx-small">{w.roleReason}</div></td>
                      <td className="hx-small">{w.network.join(', ')}</td>
                      <td className="hx-small">{amounts(w.inbound)}</td>
                      <td className="hx-small">{amounts(w.outbound)}</td>
                      <td className="hx-small">{w.senders} in · {w.receivers} out</td>
                      <td className="hx-small">{dt(w.firstActivity)}<div className="hx-faint">{dt(w.lastActivity)}</div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Section>
          </div>
        );
      }}
    </Gate>
  );
}
