/** Frozen v9 policy on new compound world structures. No policy tuning in this test. */
import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';
import {buildWorld} from '../bench-adaptive/world.mjs';import {evaluateWorldScenario} from '../bench-adaptive/scenarios.mjs';
const seeds=[1201,1303,1409,1511,1601,1709],policies=['v6','v7','v8','v9','cheapest','random','confirmation'];
const shapes=[
 {name:'three_operation_portfolio_with_partial_site_coverage',ops:[{id:'A',kit:'K1',n:7,split:true},{id:'B',kit:'K1',n:2},{id:'C',kit:'K2',n:5,rotate:[{i:0,at:2}]}],time:3},
 {name:'simultaneous_disappearance_rotation_and_new_wave',ops:[{id:'A',kit:'K2',n:6,die:[{i:1,at:2,replace:true}],rotate:[{i:0,at:2}]},{id:'B',kit:'K1',n:4,die:[{i:1,at:3,replace:false}]}],time:4},
 {name:'two_shared_kits_with_unequal_evidence_coverage',ops:[{id:'A',kit:'K1',n:8,split:true},{id:'B',kit:'K1',n:3,split:true},{id:'C',kit:'K2',n:3}],time:2},
 {name:'four_operations_with_competing_temporal_rechecks',ops:[{id:'A',kit:'K1',n:3,rotate:[{i:0,at:1}]},{id:'B',kit:'K2',n:5,rotate:[{i:0,at:2}]},{id:'C',kit:'K1',n:2},{id:'D',kit:'K2',n:4,die:[{i:1,at:2,replace:true}]}],time:3},
 {name:'partial_provider_outage_with_public_replacement_opportunity',ops:[{id:'A',kit:'K2',n:7,die:[{i:1,at:1,replace:true}]},{id:'B',kit:'K1',n:6,split:true}],time:3,outage:[1,2,3]},
 {name:'three_branches_with_copied_kit_and_late_wallet_changes',ops:[{id:'A',kit:'K1',n:4,rotate:[{i:0,at:3}]},{id:'B',kit:'K1',n:6,die:[{i:1,at:2,replace:true}]},{id:'C',kit:'K2',n:4,split:true}],time:4},
];
const scenarios=shapes.map(shape=>({type:shape.name,build(seed){const world=buildWorld(seed,{ops:shape.ops.map(o=>({links:false,die:[],rotate:[],...o})),decoys:17,provider_outage:shape.outage??[100,101]}),ops=Object.keys(world.s.ops),log=[];
 for(const [i,op] of ops.entries()){
  const def=world.s.ops[op];world.inspect(def.seed);
  if(i%2===0){const key=def.sites[1];world.s.observed.sites[key]={key,op,found_by:'observed_public_link',found_at:0,inspected:false,status:'live',artifacts:null,deposit:[],history:[],login:false,inspected_at:null};world.inspect(key);}
 }
 world.walletPipeline();for(const op of ops)world.hunter(op);
 while(world.s.tick<shape.time)world.advance();
 for(const site of Object.values(world.s.observed.sites))if(site.inspected)site.monitor_changed=true;
 return {world,log,ops,note:'New compound structures, 2–4 competing operations; identical observed state and counterfactual continuation for every frozen policy.'};
}}));
const results=[];for(const scenario of scenarios)for(const seed of seeds)results.push(evaluateWorldScenario(scenario,seed,policies));
assert.equal(results.length,36);const summary={};for(const p of policies){const rows=results.map(r=>r.policies[p]);summary[p]={states:rows.length,optimal_choice_rate:rows.filter(r=>r.optimal).length/rows.length,near_optimal_rate:rows.filter(r=>r.near_optimal).length/rows.length,mean_regret:rows.reduce((s,r)=>s+r.regret,0)/rows.length};}
const out={ok:true,partition:'new independent compound-structure holdout',policy_frozen:true,scope:'Offline observed-state production policy with cloned-world counterfactuals; not live-provider or full database simulator certification.',seeds,shapes,summary,results};mkdirSync('verification/autonomy-v9',{recursive:true});writeFileSync('verification/autonomy-v9/independent-holdout.json',JSON.stringify(out,null,2));console.log(JSON.stringify(summary,null,2));
