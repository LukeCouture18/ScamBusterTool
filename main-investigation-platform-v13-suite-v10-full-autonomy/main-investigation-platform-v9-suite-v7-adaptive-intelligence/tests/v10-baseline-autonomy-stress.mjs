// v7 large-state stress: the v6 scale fixture plus a large gap/test/outcome/cost history, measured through the real
// Main API on a file-backed SQLite D1 double. Actual rows, actual timings; no extrapolation.
import assert from 'node:assert/strict';import {mkdtempSync,rmSync,mkdirSync,writeFileSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {performance} from 'node:perf_hooks';
import {applyMigrations,startMain} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'adaptive-stress-')),dbFile=join(work,'main.sqlite');let main;
const timings=[];const timed=async(name,fn)=>{const begin=performance.now(),r=await fn();timings.push({name,ms:Number((performance.now()-begin).toFixed(2))});return r;};
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const FAMILIES=['RELATED_SITE_HUNT','PUBLIC_ARTIFACT_SEARCH','REPLACEMENT_SITE_HUNT','HUNTER_HYPOTHESIS_TEST','TEMPORAL_RECHECK','CORRELATION_REVIEW','PUBLIC_SITE_INSPECTION'];
const OUTCOMES=['site_discovered','validated_site','validated_wallet','independent_evidence','dead_end','duplicate','hypothesis_discrimination','report_readiness'];
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});const db=main.sql;
 const memoryBefore=process.memoryUsage().rss,emptyBytes=statSync(dbFile).size;
 await timed('load_10000_entities_50100_relationships_5000_evidence',async()=>{
  db.exec('BEGIN');
  const inv=db.prepare('INSERT INTO investigations(id,external_id,title) VALUES (?,?,?)'),entity=db.prepare('INSERT INTO entities(id,investigation_id,entity_type,canonical_key,display_name) VALUES (?,?,?,?,?)'),link=db.prepare("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES (?,?,?,'site_investigator',?)"),ev=db.prepare("INSERT INTO evidence(id,investigation_id,entity_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES (?,?,?,'site_investigator',?,'public_artifact',?,'3.0','2026-09-01T00:00:00Z')");
  for(let i=0;i<300;i++)inv.run(`inv-${i}`,`inv-${i}`,`Investigation ${i}`);
  for(let i=0;i<10000;i++){const type=i%5===0?'wallet':'site',key=type==='wallet'?`ethereum:0x${i.toString(16).padStart(40,'0')}`:`node-${i}.example`;entity.run(`e-${i}`,`inv-${i%300}`,type,key,key);link.run(`ie-${i}`,`inv-${i%300}`,`e-${i}`,`entity-${i}`);if(i%2===0)ev.run(`ev-${i}`,`inv-${i%300}`,`e-${i}`,`source-${i}`,`Public source ${i}`);}
  const rel=db.prepare("INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at,assertion_kind) VALUES (?,?,?,?,'site_investigator',?,'3.0','2026-09-01T00:00:00Z','observed')"),ref=db.prepare("INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES (?,?,?,'site_investigator')");
  for(let i=0;i<50100;i++){const from=i%10000,cluster=Math.floor(from/400)*400,to=cluster+(from+1)%400;rel.run(`r-${i.toString().padStart(6,'0')}`,`e-${from}`,`e-${to}`,i%3===0?'deposit_observed':i%3===1?'template_overlap':'hosting_overlap',`r-${i}`);ref.run(`re-${i}`,`r-${i.toString().padStart(6,'0')}`,`ev-${from-from%2}`);}
  const op=db.prepare("INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES (?,?,?,?,?)"),member=db.prepare("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES (?,?,?,'member')");
  for(let o=0;o<25;o++){op.run(`op-${o}`,`op-${o}`,`Synthetic cluster ${o}`,`node-${o*400+1}.example`,`inv-${(o*400+1)%300}`);for(let i=o*400;i<(o+1)*400;i++){const type=i%5===0?'wallet':'site',key=type==='wallet'?`ethereum:0x${i.toString(16).padStart(40,'0')}`:`node-${i}.example`;member.run(`op-${o}`,type,key);}}
  db.exec('COMMIT');
 });
 const v7Rows={};
 await timed('load_v7_history',async()=>{
  db.exec('BEGIN');
  const dec=db.prepare("INSERT INTO adaptive_decisions(id,scope_kind,scope_id,seq,state_hash,status,chosen_key,chosen_family,question,why_matters,why_selected,deferred,utility,created_at,finished_at) VALUES (?,'operation',?,?,?,'finished',?,?,?,?,?,'[]',?,?,?)");
  const comp=db.prepare("INSERT INTO adaptive_decision_components(decision_id,candidate_key,family,subject,component,value,weight,contribution,reason) VALUES (?,?,?,?,?,?,?,?,?)");
  const test=db.prepare("INSERT INTO adaptive_tests(id,decision_id,scope_kind,scope_id,family,subject,inputs_hash,generation,gap_keys,objective,safety_class,specialist,status,outcome,useful,attributed_at,budget_checked,created_at,started_at,finished_at) VALUES (?,?,'operation',?,?,?,?,0,'[]','{}','public_passive','site_finder','finished','{}',?,?,1,?,?,?)");
  const cost=db.prepare("INSERT INTO adaptive_costs(test_id,dimension,reserved,consumed,measured,source,recorded_at) VALUES (?,?,?,?,?,?,?)");
  const out=db.prepare("INSERT INTO adaptive_outcomes(outcome_kind,outcome_ref,test_id,credit,basis,family,scope_kind,scope_id,detail,at) VALUES (?,?,?,?,'provenance',?,'operation',?,'{}',?)");
  const lin=db.prepare("INSERT INTO adaptive_lineage(id,test_id,stage,ref_kind,ref_id,strength,detail,at) VALUES (?,?,?,?,?,'provenance','{}',?)");
  const gap=db.prepare("INSERT INTO adaptive_gaps(scope_kind,scope_id,gap_key,family,subject,current_knowledge,missing_knowledge,why_matters,uncertainty,status,exhaustion_condition,content_hash,first_seen,updated_at) VALUES ('operation',?,?,?,?,'known','missing','matters',.5,?,'cond',?,?,?)");
  const gh=db.prepare("INSERT INTO adaptive_gap_history(id,scope_kind,scope_id,gap_key,status,content_hash,detail,at) VALUES (?,'operation',?,?,?,?,'{}',?)");
  const comps=['uncertainty_reduction','hypothesis_discrimination','report_readiness','time_sensitivity','downstream_opportunity','evidence_independence','novelty','operation_coverage','historical_yield','saturation','duplicate_probability','cost'];
  let n={decisions:0,components:0,tests:0,costs:0,outcomes:0,lineage:0,gaps:0,gap_history:0};
  for(let i=0;i<10000;i++){const o=`op-${i%25}`,at=new Date(Date.now()-(10000-i)*60000).toISOString(),fam=FAMILIES[i%FAMILIES.length];
   dec.run(`d-${i}`,o,i,`h-${i}`,`${fam}:k${i}`,fam,'Question?','Matters.','Why.',.5,at,at);n.decisions++;
   if(i%5===0)for(let c=0;c<6;c++)for(const k of comps){comp.run(`d-${i}`,`${fam}:c${c}`,fam,`s${c}`,k,.3,.1,.03,'reason');n.components++;}
   test.run(`t-${i}`,`d-${i}`,o,fam,`scope:${o}:${i%40}`,`in${i}`,i%3===0?1:0,at,at,at,at);n.tests++;
   for(const d of ['jobs','http','dns','certificate','rdap','provider_calls','retries','worker_ms','wall_ms','bytes']){cost.run(`t-${i}`,d,10,d==='bytes'?null:5,d==='bytes'?0:1,'stress',at);n.costs++;}
   for(let k=0;k<3;k++){out.run(OUTCOMES[(i+k)%OUTCOMES.length],`ref-${i}-${k}`,`t-${i}`,k===0?1:.5,fam,o,at);n.outcomes++;}
   for(let k=0;k<2;k++){lin.run(`l-${i}-${k}`,`t-${i}`,k?'immediate_output':'decision',k?'site':'decision',`x-${i}-${k}`,at);n.lineage++;}}
  for(let i=0;i<5000;i++){const o=`op-${i%25}`,at=new Date().toISOString();gap.run(o,`G${i}`,'RELATED_SITE',`s${i}`,i%4?'exhausted':'open',`c${i}`,at,at);n.gaps++;for(let k=0;k<4;k++){gh.run(`gh-${i}-${k}`,o,`G${i}`,'open',`c${i}-${k}`,at);n.gap_history++;}}
  db.exec('COMMIT');Object.assign(v7Rows,n);
 });
 db.exec('BEGIN');for(let i=0;i<300;i++)db.prepare('INSERT OR IGNORE INTO autonomy_investigations(investigation_id,site_url) VALUES (?,?)').run(`inv-${i}`,`https://node-${i+1}.example/`);db.exec('COMMIT');
 const beforeScientificBytes=statSync(dbFile).size;
 await timed('load_scientific_history',async()=>{
  db.exec('BEGIN');
  const h=db.prepare("INSERT INTO scientific_hypotheses(operation_id,set_key,hypothesis_key,statement,role,status,uncertainty,reason,content_hash,updated_at) VALUES (?,'historical',?,'Historical explanation','unknown','VIABLE','Alternatives remain','Stress fixture',?,'2026-09-01T00:00:00Z')"),p=db.prepare("INSERT INTO scientific_predictions(id,operation_id,set_key,hypothesis_key,expectation,would_weaken,strong_contradiction,test_family,created_at) VALUES (?,?,'historical',?,'Expected public observation','Contrary observation','Deterministic contradiction','PUBLIC_ARTIFACT_SEARCH','2026-09-01T00:00:00Z')"),c=db.prepare("INSERT INTO scientific_contradictions(operation_id,fingerprint,claim,observations,independence_units,explanations,tests,importance,status,reason,content_hash,updated_at) VALUES (?,?,'Historical disagreement','[]','[]','[]','[]','material','UNRESOLVED','No resolving evidence',?,'2026-09-01T00:00:00Z')"),hist=db.prepare("INSERT INTO scientific_history(id,operation_id,record_kind,record_key,after_state,reason,content_hash,at) VALUES (?,?,'hypothesis_revision',?,'{\"status\":\"VIABLE\"}','Historical uncertainty',?,'2026-09-01T00:00:00Z')");
  for(let i=0;i<5000;i++){const op=`op-${i%25}`;h.run(op,`sh-${i}`,`hash-${i}`);p.run(`sp-${i}`,op,`sh-${i}`);c.run(op,`sc-${i}`,`ch-${i}`);}
  for(let i=0;i<30000;i++)hist.run(`history-${i}`,`op-${i%25}`,`sh-${i%5000}`,`hh-${i}`);
  db.exec('COMMIT');
 });
 const afterLoadBytes=statSync(dbFile).size;const pageUsage=()=>main.all('SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC');const pagesBefore=pageUsage();
 for(let i=0;i<40&&main.n('SELECT COUNT(*) n FROM operation_edges')<50100;i++)await timed('director_projection_tick',async()=>ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{})));
 assert.equal(main.n('SELECT COUNT(*) n FROM operation_edges'),50100);
 // Decision latency: every operation evaluated (8 per tick) with the full v7 loop and portfolio pass.
 for(let i=0;i<4;i++)await timed('adaptive_portfolio_decision_tick_8_operations',async()=>{db.exec('UPDATE operation_state SET dirty=1,lease_until=NULL');return ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{}));});
 await timed('adaptive_unchanged_parked_tick',async()=>{db.exec('UPDATE operation_state SET dirty=1,lease_until=NULL');return ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{}));});
 // Same tick with the v7 layer switched off (v6 policy) on the same state: the v7 overhead, measured.
 db.exec("UPDATE ops_state SET value='false' WHERE key='adaptive_enabled'");
 for(let i=0;i<2;i++)await timed('v6_policy_tick_8_operations_same_state',async()=>{db.exec('UPDATE operation_state SET dirty=1,lease_until=NULL');return ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{}));});
 db.exec("UPDATE ops_state SET value='true' WHERE key='adaptive_enabled'");
 await timed('adaptive_operation_view',async()=>{const v=ok(await main.call('GET','/api/v1/operations/op-0/adaptive'));assert.ok(v.gaps.length>0);});
 await timed('adaptive_operation_view_with_efficiency',async()=>ok(await main.call('GET','/api/v1/operations/op-0/adaptive?efficiency=1')));
 await timed('adaptive_portfolio_efficiency',async()=>{const e=ok(await main.call('GET','/api/v1/adaptive/efficiency'));assert.ok(e.actions.tests>=10000);});
 await timed('briefing_and_graph_first_page',async()=>{const b=ok(await main.call('GET','/api/v1/operations/op-0/intelligence'));assert.equal(b.edges.length,100);});
 await timed('scientific_cached_default_briefing',async()=>{const v=ok(await main.call('GET','/api/v1/operations/op-0/scientific'));assert.ok(v.current_understanding);});
 await timed('scientific_advanced_bounded_view',async()=>ok(await main.call('GET','/api/v1/operations/op-0/scientific?advanced=1')));
 await timed('v9_dashboard',async()=>ok(await main.call('GET','/api/v1/autonomy')));
 await timed('v9_investigation_default',async()=>ok(await main.call('GET','/api/v1/investigations/inv-1/autonomy')));
 await timed('v9_wallet_default',async()=>ok(await main.call('GET','/api/v1/suite/wallet-pipeline?investigation_id=inv-0')));
 await timed('v9_queue_classification',async()=>ok(await main.call('GET','/api/v1/autonomy/queue')));
 await timed('v9_director_tick',async()=>ok(await main.call('POST','/api/v1/investigations/inv-1/director',{})));
 await timed('v9_queue_reconciliation',async()=>ok(await main.call('POST','/api/v1/ops/tick',{})));
 const decisionsMade=main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE id NOT LIKE 'd-%'"),testsMade=main.n("SELECT COUNT(*) n FROM adaptive_tests WHERE id NOT LIKE 't-%'");
 const pagesAfter=pageUsage(),quietBefore=statSync(dbFile).size,historyBefore=main.n('SELECT COUNT(*) n FROM scientific_history');for(let i=0;i<5;i++)await timed('unchanged_scientific_read',async()=>ok(await main.call('GET','/api/v1/operations/op-0/scientific')));const quietAfter=statSync(dbFile).size,historyAfter=main.n('SELECT COUNT(*) n FROM scientific_history');assert.equal(historyAfter,historyBefore);const rss=process.memoryUsage().rss,bytes=statSync(dbFile).size;
 const result={ok:true,rows:{entities:main.n('SELECT COUNT(*) n FROM entities'),relationships:main.n('SELECT COUNT(*) n FROM relationships'),evidence:main.n('SELECT COUNT(*) n FROM evidence'),investigations:300,autonomy_states:main.n('SELECT COUNT(*) n FROM autonomy_investigations'),operations:25,projected_edges:50100,v7_history:v7Rows,
  scientific_hypotheses:main.n('SELECT COUNT(*) n FROM scientific_hypotheses'),scientific_predictions:main.n('SELECT COUNT(*) n FROM scientific_predictions'),scientific_contradictions:main.n('SELECT COUNT(*) n FROM scientific_contradictions'),scientific_history:main.n('SELECT COUNT(*) n FROM scientific_history'),new_v7_decisions_during_run:decisionsMade,new_v7_tests_during_run:testsMade},timings,
  decision_latency_ms:timings.filter(t=>t.name==='adaptive_portfolio_decision_tick_8_operations').map(t=>t.ms),v6_policy_tick_ms:timings.filter(t=>t.name==='v6_policy_tick_8_operations_same_state').map(t=>t.ms),
  memory:{rss_before_bytes:memoryBefore,rss_after_bytes:rss,peak_rss_kb:process.resourceUsage().maxRSS},database:{before_bytes:emptyBytes,before_scientific_history_bytes:beforeScientificBytes,after_fixture_and_history_bytes:afterLoadBytes,after_bytes:bytes,growth_bytes:bytes-emptyBytes,growth_during_run_bytes:bytes-afterLoadBytes,quiet_read_growth_bytes:quietAfter-quietBefore,quiet_scientific_history_growth:historyAfter-historyBefore,page_usage_before:pagesBefore,page_usage_after:pagesAfter},
  scope:'Local file-backed SQLite through the D1 double and the real Main API routes; not a remote D1 service-level measurement.'};
 mkdirSync('verification/v10/baseline',{recursive:true});writeFileSync('verification/v10/baseline/stress.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e);if(main)console.error(main.log.filter(l=>/ 5\d\d /.test(l)).slice(-3).join('\n'));process.exitCode=1;}finally{if(main)await main.close();rmSync(work,{recursive:true,force:true});}
