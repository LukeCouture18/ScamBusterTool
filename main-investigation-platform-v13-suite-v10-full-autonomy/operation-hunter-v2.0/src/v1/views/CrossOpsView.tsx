import React from 'react';
import { Pill, Meter, Section, Explain } from '../ui';
import type { OpContext } from '../HunterApp';
import { useAnalysis, Gate, ViewHeader } from './common';

const DISTINCTION: Record<string, { label: string; tone: string; meaning: string }> = {
  COMMON_OPERATOR_HIGH_CONFIDENCE: { label: 'Likely same operator', tone: 'red', meaning: 'Operator-level indicators (analytics IDs, support handles, collection wallets) are shared.' },
  SHARED_COMMERCIAL_KIT: { label: 'Same kit, different operator', tone: 'violet', meaning: 'Both use the same scam kit. Kits are sold to many customers, so this links the software, not the people.' },
  SHARED_BULLETPROOF_HOSTING: { label: 'Same hosting', tone: 'amber', meaning: 'Both use the same abuse-tolerant hosting. Many unrelated operations rent from the same providers.' },
  COINCIDENTAL_CORRELATION: { label: 'Coincidental', tone: '', meaning: 'Only common services overlap.' },
};
const LEVEL_TONE: Record<string, string> = { operator: 'red', kit: 'violet', hosting: 'amber', context: '' };

export function CrossOpsView(ctx: OpContext) {
  const a = useAnalysis(ctx);
  return (
    <Gate state={a} what="Comparing with other operations">
      {() => {
        const links = (a.data.crossOps as any[]).slice().sort((x, y) => y.overallSimilarityScore - x.overallSimilarityScore);
        return (
          <div className="hx-page">
            <ViewHeader eyebrow="Across operations" title="Related operations" intro="Other operations in Hunter that share indicators with this one's core, and what kind of overlap it is." />
            <Explain>Overlaps are weighted by what they can mean: operator-level indicators count most; shared kits and hosting are capped because they are commonly shared by unrelated groups. Only this operation's core indicators are compared.</Explain>
            {!links.length && <div className="hx-card hx-muted">No other operation shares core indicators with this one.</div>}
            {links.map(l => {
              const d = DISTINCTION[l.analyticalDistinction] ?? { label: l.analyticalDistinction, tone: '', meaning: '' };
              return (
                <div key={l.operationBId} className="hx-card" style={{ marginBottom: 12 }}>
                  <div className="hx-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div className="hx-row" style={{ gap: 8 }}><Pill tone={d.tone}>{d.label}</Pill>{l.isDemo && <Pill tone="amber">demo</Pill>}</div>
                      <h3 style={{ margin: '6px 0 4px' }}><a href={`#/op/${l.operationBId}`}>{l.operationBCode} · {l.operationBName}</a></h3>
                      <div className="hx-small">{l.reasoning}</div>
                      <div className="hx-small hx-muted" style={{ marginTop: 4 }}>{d.meaning}</div>
                    </div>
                    <div style={{ width: 130, textAlign: 'right' }}><b>{Math.round(l.overallSimilarityScore)}</b><span className="hx-muted hx-small">/100</span><Meter value={l.overallSimilarityScore} /></div>
                  </div>
                  <Section eyebrow="" title="Shared indicators">
                    <ul className="hx-list">{(l.shared as any[]).map(s => <li key={s.value} className="hx-row" style={{ gap: 8 }}><Pill tone={LEVEL_TONE[s.level]}>{s.level}</Pill><span className="mono hx-small">{s.label || s.value}</span><span className="hx-faint hx-small">{s.type}</span></li>)}</ul>
                  </Section>
                  <div className="hx-small hx-muted"><b>Does not prove:</b> {l.whatItDoesNotProve}</div>
                </div>
              );
            })}
          </div>
        );
      }}
    </Gate>
  );
}
