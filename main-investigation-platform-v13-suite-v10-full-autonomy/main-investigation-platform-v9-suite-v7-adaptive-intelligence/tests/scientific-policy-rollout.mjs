/** Equal request ceilings and shared candidate generation; no policy reads fixture truth. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {buildWorld} from '../bench-adaptive/world.mjs';
import {run,v6Policy,v7Policy,randomPolicy} from '../bench-adaptive/sim.mjs';
import {v8ScientificChoice} from '../lib/scientific/model.ts';
import {choose,costUnits} from '../lib/adaptive/value.ts';
const baseline=mode=>(s,g,c,o)=>{const result=choose(s,g,c,{...o,exploration:false}),eligible=result.ranked.filter(x=>x.eligible);eligible.sort(mode==='cheapest'?(a,b)=>costUnits(a.bounds)-costUnits(b.bounds)||a.key.localeCompare(b.key):(a,b)=>(b.family==='RELATED_SITE_HUNT'?2:b.family==='PUBLIC_ARTIFACT_SEARCH'?1:0)-(a.family==='RELATED_SITE_HUNT'?2:a.family==='PUBLIC_ARTIFACT_SEARCH'?1:0)||a.key.localeCompare(b.key));return {...result,chosen:eligible[0]??null};};
const policies=[()=>v6Policy(),()=>v7Policy(),()=>v7Policy({name:'v8 scientific',choose:v8ScientificChoice,exploration:false}),()=>randomPolicy(11),()=>v7Policy({name:'cheapest safe',choose:baseline('cheapest'),exploration:false}),()=>v7Policy({name:'confirmation biased',choose:baseline('confirmation'),exploration:false})];
const results=[];
for(const [partition,seeds] of [['design',[1,2,3,4,5]],['held_out',[101,203,307,409,503,607,709,811]]])for(const seed of seeds)for(const budget of [600,900])for(const make of policies){
 const result=run(buildWorld(seed),make(),{ticks:24,counterfactuals:false,requestBudget:budget});
 results.push({partition,seed,request_ceiling:budget,...result});
}
assert.equal(results.length,156);
const summary=[];const mean=(rows,k)=>+(rows.reduce((s,r)=>s+Number(r[k]??0),0)/rows.length).toFixed(3);
for(const partition of ['design','held_out'])for(const budget of [600,900])for(const make of policies){const name=make().name,rows=results.filter(r=>r.partition===partition&&r.request_ceiling===budget&&r.policy===name);summary.push({partition,request_ceiling:budget,policy:name,runs:rows.length,...Object.fromEntries(['hidden_sites_discovered','validated_true_wallets','linkage_discriminated','contradictions_resolved','replacements_found','false_relationships','requests','jobs','requests_per_hidden_site','useful_rate','wasted_actions','runaway_max_repeat'].map(k=>[k,mean(rows,k)]))});}
const curves=Object.fromEntries(policies.map(make=>{const name=make().name,rows=results.filter(r=>r.partition==='held_out'&&r.request_ceiling===900&&r.policy===name);return [name,Object.fromEntries([300,500,700,900].map(spend=>[spend,Object.fromEntries(['sites','wallets','reports'].map(k=>[k,+(rows.reduce((sum,r)=>sum+([...r.curve].reverse().find(x=>x.requests<=spend)?.[k]??0),0)/rows.length).toFixed(3)]))]))]}));
const out={ok:true,held_out_completed_tick_curve_at_equal_spend:curves,method:'Unchanged v7 hard world, same production candidate generator, 24 ticks and identical 600/900 request start ceilings. A final bounded action may cross the ceiling; actual consumption is reported. Pure simulation, not full specialist or scientific database certification.',summary,results};mkdirSync('verification/scientific-v8',{recursive:true});writeFileSync('verification/scientific-v8/policy-rollout.json',JSON.stringify(out,null,2));console.log(JSON.stringify(summary,null,1));
