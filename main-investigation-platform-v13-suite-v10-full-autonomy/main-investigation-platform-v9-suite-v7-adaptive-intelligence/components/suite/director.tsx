"use client";
import { Card,Empty,ErrorNote,Pill,useJson,ago } from './kit';
type Brief={doing:string;why:string;next:string|null;state:string;stop_reason:string|null;findings:Array<{id:string;title:string;evidence_class:string}>;wallets:Array<{id:string;address:string;validated_network:string;validation_status:string;best_context:string}>;needs_you:Array<{id:string;title:string;instructions:string;url:string}>;objectives:Array<{objective:string;status:string;reason:string}>;timeline:Array<{title:string;reason:string;created_at:string}>;report:{lifecycle:string;missing:string[]};advanced:unknown};
export function InvestigationBriefing({investigationId}:{investigationId:string}){
 const {data,error}=useJson<Brief>(`/api/v1/investigations/${encodeURIComponent(investigationId)}/director`,10000);
 if(error)return <Card title="Investigation briefing"><ErrorNote error={error}/></Card>;
 if(!data)return null;
 return <Card title="Investigation briefing"><div className="mip-stack" style={{minWidth:0,overflowWrap:"anywhere"}} data-director={investigationId}>
  <div className="mip-spread" style={{flexWrap:"wrap",gap:8}}><strong>What Main is doing now</strong><Pill>{data.state.replaceAll('_',' ').toLowerCase()}</Pill></div>
  <p>{data.doing}</p><p className="mip-meta">Why: {data.why}</p>
  <p className="mip-meta">What’s next: {data.next?`Automatic reevaluation ${data.next}`:data.stop_reason?data.stop_reason.replaceAll('_',' ').toLowerCase():'Main will evaluate the next module result automatically.'}</p>
  <div><h3>Important findings</h3>{data.findings.length?<ul className="mip-list">{data.findings.map(f=><li key={f.id}>{f.title}<span className="mip-meta"> · {f.evidence_class==='blockchain_fact'?'on-chain record':f.evidence_class==='observed_website'?'seen on the site':'analysis / recorded evidence'}</span></li>)}</ul>:<Empty>No evidence has arrived yet.</Empty>}</div>
  <div><h3>Wallets</h3>{data.wallets.filter(w=>w.best_context==='deposit').map(w=><p key={w.id}><code style={{wordBreak:'break-all'}}>{w.address}</code> · {w.validated_network||'network unresolved'} · {w.validation_status}</p>)}</div>
  <div><h3>What needs me</h3>{data.needs_you.length?data.needs_you.map(t=><p key={t.id}>{t.title} — {t.instructions} {t.url&&<a href={t.url} target="_blank" rel="noopener noreferrer nofollow">Open site</a>}</p>):<p className="mip-meta">{data.report.lifecycle==='AWAITING_APPROVAL'?'Review the ready report below and approve its exact contents.':'No human action is required.'}</p>}</div>
  <div><h3>Report status</h3><p>{data.report.lifecycle.replaceAll('_',' ').toLowerCase()}</p>{data.report.missing.length>0&&<ul className="mip-list">{data.report.missing.map((s,i)=><li key={i} className="mip-meta">{s}</li>)}</ul>}</div>
  <details><summary>Activity timeline</summary><ul className="mip-list">{data.timeline.map((t,i)=><li key={i}>{t.title}<span className="mip-meta"> · {ago(t.created_at)}</span></li>)}</ul></details>
  <details><summary>Details / Evidence / Advanced</summary><ul className="mip-list">{data.objectives.map(o=><li key={o.objective}>{o.objective.replaceAll('_',' ')} · {o.status} — {o.reason}</li>)}</ul><pre style={{whiteSpace:'pre-wrap',fontSize:11,overflowWrap:'anywhere',maxWidth:'100%'}}>{JSON.stringify(data.advanced,null,2)}</pre></details>
 </div></Card>;
}
