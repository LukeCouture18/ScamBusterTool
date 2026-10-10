/** v7 Adaptive Investigation Intelligence acceptance suite (real Main API over a file-backed D1 double). */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
import {portfolioOrder,creditShares,budgetAdjustment} from '../lib/adaptive/policy.ts';
import {rankDirectorActions} from '../lib/adaptive/director-rank.ts';
import {GAP_FAMILIES,TEST_FAMILIES,TESTS,GAPS} from '../lib/adaptive/ontology.ts';

const work=mkdtempSync(join(tmpdir(),'adaptive-v7-')),dbFile=join(work,'main.sqlite');
let main;const checks=[],at='2026-09-01T12:00:00Z';
const ok=r=>{assert.ok([200,201,202].includes(r.status),`${r.status}: ${JSON.stringify(r.body)}`);return r.body;};
const test=async(name,f)=>{await f();checks.push(name);console.log(`PASS ${name}`);};
const sql=(q,...a)=>main.sql.prepare(q).run(...a);
function entity(id,type,key,inv){sql("INSERT INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES (?,?,?,?,?)",id,type,key,key,inv);if(inv)sql("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES (?,?,?,'site_investigator',?)",crypto.randomUUID(),inv,id,id);}
function evidence(id,ent,inv,type='public_page',context='Publicly collected test evidence'){sql("INSERT INTO evidence(id,entity_id,investigation_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at,context_text) VALUES (?,?,?,'site_investigator',?,?,?,'3.0',?,?)",id,ent,inv,id,type,`Source ${id}`,at,context);}
function relation(id,from,to,type,ev,source='site_investigator'){sql("INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at,assertion_kind) VALUES (?,?,?,?,?,?,'3.0',?,'observed')",id,from,to,type,source,id,at);if(ev)sql('INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES (?,?,?,?)',crypto.randomUUID(),id,ev,source);}
const payload={schema_version:'2.0',operation:{external_id:'op-v7',code:'V7',name:'Adaptive fixture',seed:'alpha.example',investigation_id:'inv-a',revision:1},
 members:[{entity_type:'site',canonical_key:'alpha.example',role:'seed',state:'live',why:'Known seed'},{entity_type:'site',canonical_key:'beta.example',role:'probable',state:'live',why:'Template overlap'}],
 model:{status:'active',hypotheses:[{key:'who',question:'Are the member sites run by one operator?',caveat:'No operator attribution established.',discriminatingTest:'Trace a validated deposit wallet reused by another deployment.',
  hypotheses:[{key:'one',label:'One operator runs these sites',verdict:'favoured'},{key:'customers',label:'Several customers of the same kit vendor',verdict:'viable'}],evidence:[{text:'Same public template',ratings:{one:'C',customers:'C'},evidenceIds:['ev-a']}]}]},contradictions:[],changes:[{domain:'alpha.example',facet:'status',value:'live',at}]};
const sync=()=>main.call('POST','/api/v1/operations/sync',payload,MODULE_KEYS.operation_hunter).then(ok);
const opId=()=>main.one("SELECT id FROM hunter_operations WHERE external_id='op-v7'").id;
const evaluate=async()=>{main.sql.exec('UPDATE operation_state SET dirty=1');return ok(await main.call('POST','/api/v1/operations/op-v7/intelligence',{}));};
const finishWork=(workId,result,status='completed')=>{const jid=crypto.randomUUID();sql("INSERT INTO jobs(id,job_type,investigation_id,target_module,created_by_module,dedupe_key,payload,status,result,completed_at,attempt_count) VALUES (?,'FIND_RELATED_SITES',?,'site_finder','platform',?,?,?,?,CURRENT_TIMESTAMP,1)",jid,'inv-a',jid,JSON.stringify({work_item_id:workId,seeds:['alpha.example']}),status,JSON.stringify(result));
 sql("INSERT INTO job_events(id,job_id,source_module,event_type,message) VALUES (?,?,'site_finder','claimed','claimed'),(?,?,'site_finder','complete','done')",crypto.randomUUID(),jid,crypto.randomUUID(),jid);
 sql("UPDATE work_items SET status='done',job_id=?,finished_at=CURRENT_TIMESTAMP WHERE id=?",jid,workId);return jid;};

try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});
 for(const inv of ['inv-a','inv-b'])sql('INSERT INTO investigations(id,external_id,title) VALUES (?,?,?)',inv,inv,inv);
 entity('site-a','site','alpha.example','inv-a');entity('site-b','site','beta.example','inv-b');entity('wallet','wallet','ethereum:0x'+'1'.repeat(40),'inv-a');entity('cdn','infrastructure_indicator','ip:192.0.2.10',null);entity('kit','template','kit:quorra',null);
 evidence('ev-a','site-a','inv-a');evidence('ev-b','site-b','inv-b');evidence('ev-an','site-a','inv-a','analytics_ids','["G-ALPHA77"]');evidence('ev-so','site-a','inv-a','socials','["https://t.me/alpha_support_desk"]');
 relation('deposit-a','site-a','wallet','deposit_observed','ev-a','crypto_wallet_logger');relation('cdn-a','site-a','cdn','hosting_overlap','ev-a');relation('cdn-b','site-b','cdn','hosting_overlap','ev-b');relation('tpl-a','site-a','kit','template_match','ev-a');relation('tpl-b','site-b','kit','template_match','ev-b');
 sql("INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,best_context,validation_status,validated_network,analysis_status,entity_id,observations) VALUES ('cand-a','inv-a',?,'evm',?,?,'deposit','valid','ethereum','completed','wallet',1)",'evm:0x'+'1'.repeat(40),'0x'+'1'.repeat(40),'0x'+'1'.repeat(40));
 for(const m of ['site_finder','site_investigator','wallet_investigator'])ok(await main.call('POST',`/api/v1/modules/${m}/register`,{module_version:'test',schema_version:'3.0',capabilities:m==='site_finder'?['site:discover','site:relate']:m==='site_investigator'?['site:investigate']:['wallet:analyze'],supported_event_types:[]},MODULE_KEYS[m]));

 await test('ontology: every requested gap family and test family is defined with its required fields',async()=>{
  for(const f of ['SITE_IDENTITY','SITE_REPLACEMENT','PAYMENT_INTERFACE','DEPOSIT_WALLET','WALLET_NETWORK','WALLET_VALIDATION','BLOCKCHAIN_ACTIVITY','WALLET_REUSE','WALLET_ROTATION','PUBLIC_ARTIFACT_REUSE','CONTACT_REUSE','INFRASTRUCTURE_SPECIFICITY','TEMPLATE_SPECIFICITY','DEPLOYMENT_TIMING','OPERATION_MEMBERSHIP','HYPOTHESIS_DISCRIMINATION','CONTRADICTION_RESOLUTION','RELATED_SITE','REPLACEMENT_SITE','CAMPAIGN_WAVE','REPORT_EVIDENCE','REPORT_DESTINATION'])assert.ok(GAP_FAMILIES.includes(f),f);
  for(const t of ['PUBLIC_SITE_INSPECTION','LIKELY_WALLET_PAGE_INSPECTION','WALLET_VALIDATION','BLOCKCHAIN_REFRESH','RELATED_SITE_HUNT','PUBLIC_ARTIFACT_SEARCH','REPLACEMENT_SITE_HUNT','HUNTER_HYPOTHESIS_TEST','TEMPORAL_RECHECK','CORRELATION_REVIEW'])assert.ok(TEST_FAMILIES.includes(t),t);
  for(const t of TEST_FAMILIES){const s=TESTS[t];assert.ok(Object.keys(s.answers).length&&s.expected_outputs&&s.prerequisites&&s.success&&s.exhaustion&&s.bounds&&s.safety,t);assert.ok(['public_passive','read_only_chain','local_read','analytical'].includes(s.safety),`${t} safety`);}
  for(const g of GAP_FAMILIES)assert.ok(GAPS[g].matters&&GAPS[g].exhaustion&&Array.isArray(GAPS[g].revisit),g);
 });
 await sync();
 let firstDecision;
 await test('typed gaps persist type, subject, knowledge, missing knowledge, why, evidence, uncertainty, tests, dependencies, status, exhaustion and revisit',async()=>{
  await evaluate();const rows=main.all("SELECT * FROM adaptive_gaps WHERE scope_kind='operation'");
  const fams=new Set(rows.map(r=>r.family));for(const f of ['HYPOTHESIS_DISCRIMINATION','WALLET_REUSE','PUBLIC_ARTIFACT_REUSE','CONTACT_REUSE','INFRASTRUCTURE_SPECIFICITY','TEMPLATE_SPECIFICITY','RELATED_SITE'])assert.ok(fams.has(f),`missing ${f}: ${[...fams]}`);
  for(const r of rows){assert.ok(r.subject&&r.current_knowledge&&r.missing_knowledge&&r.why_matters&&r.exhaustion_condition,r.gap_key);assert.ok(r.uncertainty>=0&&r.uncertainty<=1);for(const k of ['supporting','contradicting','possible_tests','dependencies','revisit_condition'])assert.ok(Array.isArray(JSON.parse(r[k])),k);}
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_gap_history")>=rows.length);
 });
 await test('decision explains question, why it matters, why selected and deferred alternatives; components persisted individually',async()=>{
  firstDecision=main.one("SELECT * FROM adaptive_decisions WHERE scope_kind='operation' AND status IN ('reserved','executing') ORDER BY seq DESC LIMIT 1");
  assert.ok(firstDecision,'an external test was chosen');assert.ok(firstDecision.question&&firstDecision.why_matters&&firstDecision.why_selected);
  const deferred=JSON.parse(firstDecision.deferred);assert.ok(deferred.length>0&&deferred.every(d=>d.reason),'deferred alternatives carry reasons');
  const comps=main.all('SELECT DISTINCT component FROM adaptive_decision_components WHERE decision_id=?',firstDecision.id).map(r=>r.component);
  for(const c of ['uncertainty_reduction','hypothesis_discrimination','report_readiness','time_sensitivity','downstream_opportunity','evidence_independence','novelty','operation_coverage','historical_yield','saturation','duplicate_probability','cost'])assert.ok(comps.includes(c),c);
 });
 await test('local correlation reviews run inline, make no network request and record measured zero cost',async()=>{
  // Bounded exploration (seeded by the operation id) may legitimately start an external test first; the local
  // review then runs inline on a later evaluation.
  for(let i=0;i<4&&!main.one("SELECT 1 x FROM adaptive_tests WHERE family='CORRELATION_REVIEW'");i++)await evaluate();
  const t=main.one("SELECT * FROM adaptive_tests WHERE family='CORRELATION_REVIEW' LIMIT 1");assert.ok(t,'a local review ran');assert.equal(t.status,'finished');assert.equal(t.specialist,'main_local');
  const http=main.one("SELECT * FROM adaptive_costs WHERE test_id=? AND dimension='http'",t.id);assert.equal(http.measured,1);assert.equal(http.consumed,0);assert.equal(http.source,'main_local');
 });
 await test('discriminating wallet evidence outranks generic template similarity on the competing-explanation question',async()=>{
  const rows=main.all("SELECT candidate_key,family,value FROM adaptive_decision_components WHERE component='hypothesis_discrimination' AND decision_id IN (SELECT id FROM adaptive_decisions WHERE scope_kind='operation')");
  const wallet=Math.max(...rows.filter(r=>r.candidate_key.includes('artifact:wallet')).map(r=>r.value),0),template=Math.max(...rows.filter(r=>r.candidate_key.startsWith('RELATED_SITE_HUNT:template')).map(r=>r.value),0);
  assert.ok(wallet>=.3,`wallet reuse discrimination ${wallet}`);assert.ok(template<.05,`template discrimination ${template}`);
 });
 await test('marginal value: 110 copies of a known template unit add no independent value',async()=>{
  const before=main.one("SELECT COUNT(DISTINCT independence_key) n FROM operation_edges WHERE operation_id=? AND category='template_similarity'",opId()).n;
  const maxIndependence=()=>Math.max(0,...main.all("SELECT c.value FROM adaptive_decision_components c WHERE c.component IN ('evidence_independence','hypothesis_discrimination') AND c.candidate_key LIKE 'RELATED_SITE_HUNT:template%'").map(r=>r.value));
  const valueBefore=maxIndependence(),edgesBefore=main.n('SELECT COUNT(*) n FROM operation_edges WHERE operation_id=?',opId());
  for(let i=0;i<110;i++)relation(`tpl-copy-${i}`,'site-a','kit','template_match','ev-a');
  for(let i=0;i<4;i++)await evaluate();
  assert.ok(main.n('SELECT COUNT(*) n FROM operation_edges WHERE operation_id=?',opId())>=edgesBefore+100,'copies were projected as edges');
  assert.equal(main.one("SELECT COUNT(DISTINCT independence_key) n FROM operation_edges WHERE operation_id=? AND category='template_similarity'",opId()).n,before,'copies share one independence unit');
  assert.ok(maxIndependence()<=valueBefore+1e-9,`copies never raise a template test's independent or discriminating value (${valueBefore} -> ${maxIndependence()})`);
 });
 let finderTest;
 await test('external test handed to Site Finder as a structured, bounded objective (observations only)',async()=>{
  for(let i=0;i<4&&!main.one("SELECT 1 x FROM adaptive_tests WHERE specialist='site_finder' AND status='running'");i++)await evaluate();
  finderTest=main.one("SELECT t.*,w.result wresult,w.kind wkind,w.fingerprint wfp FROM adaptive_tests t JOIN work_items w ON w.id=t.work_item_id WHERE t.specialist='site_finder' AND t.status='running' ORDER BY t.created_at,t.rowid LIMIT 1");
  assert.ok(finderTest,'a Finder test was handed off');const r=JSON.parse(finderTest.wresult);
  assert.ok(Array.isArray(r.seeds)&&r.seeds.length);assert.ok(r.objective&&r.objective.family&&r.objective.question);assert.ok(r.budget.http<=40&&r.budget.dns<=40);assert.equal(r.source,'adaptive-intelligence');
  assert.equal(finderTest.wkind,'find_related_sites');assert.ok(finderTest.wfp.startsWith('operation:'));
  assert.equal(main.n("SELECT COUNT(*) n FROM operation_hunts WHERE id=?",finderTest.hunt_id),1);
 });
 await test('actual-cost ledger keeps reserved and consumed separate; unmeasured dimensions stay null',async()=>{
  finishWork(finderTest.work_item_id,{new_candidates:['gamma.example'],meter:{limits:{http:40,dns:40,crtsh:4,rdap:6},used:{http:5,dns:22,crtsh:4,rdap:2}}});
  await evaluate();await evaluate();
  const c=Object.fromEntries(main.all('SELECT * FROM adaptive_costs WHERE test_id=?',finderTest.id).map(r=>[r.dimension,r]));
  assert.equal(c.http.reserved,40);assert.equal(c.http.consumed,5);assert.equal(c.http.measured,1);assert.equal(c.http.source,'site_finder.round_meter');
  assert.equal(c.dns.consumed,22);assert.equal(c.certificate.consumed,4);assert.equal(c.jobs.consumed,1);assert.equal(c.bytes.consumed,null);assert.equal(c.bytes.measured,0);
  assert.equal(main.one('SELECT status FROM adaptive_tests WHERE id=?',finderTest.id).status,'finished');
 });
 await test('causal attribution: discovering test credited once; shared claims split; replay never double-credits; no lineage earns nothing',async()=>{
  const row=main.one("SELECT * FROM adaptive_outcomes WHERE outcome_kind='site_discovered' AND outcome_ref='gamma.example'");assert.ok(row,'site discovery credited');assert.equal(row.test_id,finderTest.id);assert.equal(row.credit,1);
  // A legacy (non-adaptive) Finder job that also delivered a site: shares the credit for that site.
  // Exploration order is seeded by the (random) operation id, so the next Finder test may need a few evaluations.
  const running=()=>main.one("SELECT t.* FROM adaptive_tests t WHERE t.specialist='site_finder' AND t.status='running' LIMIT 1");
  for(let i=0;i<6&&!running();i++){for(const w of main.all("SELECT t.work_item_id id FROM adaptive_tests t WHERE t.status='running' AND t.specialist<>'site_finder' AND t.work_item_id IS NOT NULL"))finishWork(w.id,{});await evaluate();}
  const t2=running();
  assert.ok(t2,'a second Finder test is running');{const legacy=crypto.randomUUID();sql("INSERT INTO jobs(id,job_type,target_module,created_by_module,dedupe_key,payload,status,result,completed_at) VALUES (?,'FIND_RELATED_SITES','site_finder','platform',?,'{}','completed',?,CURRENT_TIMESTAMP)",legacy,legacy,JSON.stringify({new_candidates:['delta.example']}));
   finishWork(t2.work_item_id,{new_candidates:['delta.example'],meter:{used:{http:3,dns:20,crtsh:4,rdap:1}}});await evaluate();await evaluate();
   const d=main.one("SELECT credit FROM adaptive_outcomes WHERE outcome_kind='site_discovered' AND outcome_ref='delta.example'");assert.ok(d);assert.equal(d.credit,.5);}
  const n=main.n('SELECT COUNT(*) n FROM adaptive_outcomes');await evaluate();await evaluate();assert.equal(main.n('SELECT COUNT(*) n FROM adaptive_outcomes'),n);
  for(const r of main.all('SELECT outcome_kind,outcome_ref,SUM(credit) s FROM adaptive_outcomes GROUP BY outcome_kind,outcome_ref'))assert.ok(r.s<=1.0001,`${r.outcome_kind}:${r.outcome_ref} credited ${r.s}`);
  const split=creditShares([{test_id:'a',strength:'temporal_only'}]);assert.equal(split.shares.length,0);
  // Downstream: the discovered site is later investigated and shows a validated deposit wallet.
  sql("INSERT INTO investigations(id,external_id,title) VALUES ('inv-g','inv-g','gamma')");entity('site-g','site','gamma.example','inv-g');evidence('ev-g','site-g','inv-g');
  sql("INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,best_context,validation_status,validated_network,analysis_status) VALUES ('cand-g','inv-g','evm:0xgg','evm','0xgg','0xgg','deposit','valid','ethereum','completed')");
  await evaluate();
  const v=main.one("SELECT * FROM adaptive_outcomes WHERE outcome_kind='validated_site' AND outcome_ref='gamma.example'");assert.ok(v,'downstream validated site credited');assert.equal(v.test_id,finderTest.id);
  assert.ok(main.one("SELECT 1 x FROM adaptive_outcomes WHERE outcome_kind='validated_wallet' AND outcome_ref='evm:0xgg:inv-g'"));
  assert.ok(main.one("SELECT 1 x FROM adaptive_lineage WHERE test_id=? AND stage='immediate_output' AND ref_id='gamma.example'",finderTest.id));
 });
 await test('outcome-specific learning is prioritization metadata and never evidence or report content',async()=>{
  const eff=ok(await main.call('GET','/api/v1/adaptive/efficiency'));const l=eff.learning;const fam=Object.keys(l).filter(k=>TESTS[k]?.specialist==='site_finder').sort((a,b)=>l[b].validated_site-l[a].validated_site)[0];
  assert.ok(fam&&l[fam].validated_site>0,`Finder family learned a validated-site outcome: ${JSON.stringify(l)}`);assert.ok('dead'in l[fam]&&'duplicate'in l[fam]&&'report'in l[fam]&&'contradiction'in l[fam]);
  assert.ok(eff.caveat.includes('not evidence'));
  assert.equal(main.n("SELECT COUNT(*) n FROM evidence WHERE source_module NOT IN ('site_investigator','crypto_wallet_logger','wallet_investigator','operation_hunter','site_finder')"),0);
  assert.equal(main.n("SELECT COUNT(*) n FROM evidence WHERE context_text LIKE '%adaptive%' OR title LIKE '%adaptive%'"),0);
 });
 await test('dynamic budgets: earned allowance is bounded, reasoned, exactly once per test, never above the ceiling',async()=>{
  const up=budgetAdjustment({max_hunts:8,hunts:3,bonus:0},[{useful:true,independent:true,duplicate:false,dead:false},{useful:true,independent:true,duplicate:false,dead:false}]);assert.equal(up.delta,1);assert.ok(up.reason);
  assert.equal(budgetAdjustment({max_hunts:12,hunts:3,bonus:4},[{useful:true,independent:true},{useful:true,independent:true}]).delta,0,'bonus cap');
  const down=budgetAdjustment({max_hunts:8,hunts:3,bonus:0},[{useful:false,duplicate:true},{useful:false,dead:true},{useful:false,dead:true}]);assert.equal(down.delta,-1);
  assert.equal(budgetAdjustment({max_hunts:3,hunts:3,bonus:0},[{useful:false,duplicate:true},{useful:false,dead:true},{useful:false,dead:true}]).delta,0,'never below hunts used');
  const n=main.n('SELECT COUNT(*) n FROM adaptive_budget_adjustments');await evaluate();await evaluate();assert.equal(main.n('SELECT COUNT(*) n FROM adaptive_budget_adjustments'),n,'replay adds no adjustment');
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_tests WHERE hunt_id IS NOT NULL AND attributed_at IS NOT NULL AND budget_checked=0")===0);
  const bonus=main.one("SELECT bonus FROM adaptive_scope_state WHERE scope_kind='operation' AND scope_id=?",opId())?.bonus??0;assert.ok(bonus<=4&&bonus>=-8);
 });
 await test('parking: low marginal value parks with explicit wake conditions; unchanged evaluations are skipped; new evidence wakes it',async()=>{
  sql("INSERT INTO investigations(id,external_id,title) VALUES ('inv-q','inv-q','quiet')");entity('site-q','site','quiet.example','inv-q');evidence('ev-q','site-q','inv-q');
  sql("INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES ('op-q','op-q','Quiet','quiet.example','inv-q')");sql("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op-q','site','quiet.example','seed')");
  const jq=crypto.randomUUID();sql("INSERT INTO jobs(id,job_type,target_module,created_by_module,dedupe_key,payload,status,result,completed_at) VALUES (?,'FIND_RELATED_SITES','site_finder','platform',?,?,'completed','{\"new_candidates\":[]}',CURRENT_TIMESTAMP)",jq,jq,JSON.stringify({seeds:['quiet.example'],artifacts:[]}));
  for(let i=0;i<3;i++){main.sql.exec("UPDATE operation_state SET dirty=1");ok(await main.call('POST','/api/v1/operations/op-q/intelligence',{}));}
  const p=main.one("SELECT * FROM adaptive_parking WHERE scope_id='op-q'");assert.ok(p,'parked');assert.ok(JSON.parse(p.wake_conditions).includes('new_site_observation'));assert.ok(p.reason);
  const decisions=main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id='op-q'");
  for(let i=0;i<5;i++){main.sql.exec("UPDATE operation_state SET dirty=1 WHERE operation_id='op-q'");ok(await main.call('POST','/api/v1/operations/op-q/intelligence',{}));}
  assert.ok(main.one("SELECT skipped_evaluations s FROM adaptive_parking WHERE scope_id='op-q'").s>=4,'unchanged parked work is not re-planned');assert.equal(main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id='op-q'"),decisions);
  entity('site-q2','site','quiet-two.example','inv-q');sql("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op-q','site','quiet-two.example','member')");
  main.sql.exec("UPDATE operation_state SET dirty=1 WHERE operation_id='op-q'");ok(await main.call('POST','/api/v1/operations/op-q/intelligence',{}));
  const w=main.one("SELECT woke_at,wake_reason FROM adaptive_parking WHERE scope_id='op-q'");assert.ok(w.woke_at||main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id='op-q'")>decisions,'new site observation wakes the operation');
 });
 await test('portfolio: utility first, starvation boost, and no operation may monopolize while others are eligible',async()=>{
  const e=(scope,utility,consecutive=0,hours=0,share=0)=>({scope,utility,time_sensitivity:0,report_closeness:0,contradiction:0,new_wave:0,provider_opportunity:0,exploration:false,hours_since_service:hours,recent_share:share,consecutive,eligible:true});
  assert.equal(portfolioOrder([e('a',.9),e('b',.4)])[0].scope,'a');
  const held=portfolioOrder([e('a',.9,3),e('b',.4)]);assert.equal(held[0].scope,'b');assert.ok(held.find(x=>x.scope==='a').fairness_hold);
  assert.equal(portfolioOrder([e('a',.5),e('b',.35,0,20)])[0].scope,'b','a long wait earns a bounded boost');
  assert.ok(main.n('SELECT COUNT(*) n FROM adaptive_portfolio')>0,'portfolio ranking persisted with reasons');
 });
 await test('saturation recorded at test, gap, branch, operation and portfolio level',async()=>{
  const levels=new Set(main.all('SELECT DISTINCT level FROM adaptive_saturation').map(r=>r.level));for(const l of ['test','gap','branch','operation','portfolio'])assert.ok(levels.has(l),l);
  const states=new Set(main.all('SELECT DISTINCT state FROM adaptive_saturation').map(r=>r.state));assert.ok([...states].every(s=>['active','temporarily_low_value','exhausted','waiting_for_evidence','waiting_for_human','waiting_for_provider'].includes(s)));
 });
 await test('wallet intelligence: a report-blocking provider retry outranks a free low-value correlation',async()=>{
  const ctx={inv:'inv-r',site:{id:'s',canonical_key:'site-r.example'},investigated:true,reportReady:false,priorActions:[],providerHealth:[{network:'ethereum',state:'healthy'}],cands:[{id:'c1',identity:'evm:0xaa',address:'0xaa',validated_network:'ethereum',best_context:'deposit',validation_status:'valid',analysis_status:'failed',validated_sites:1}]};
  const ranked=rankDirectorActions(ctx,[{kind:'correlate_wallet',target:'evm:0xaa',gap:'operation_correlation',reason:'Check where this validated deposit wallet has also been observed',value:.65,cost:.2,fingerprint:'correlate:evm:0xaa:1'},{kind:'provider_retry',target:'c1',gap:'blockchain_evidence',reason:'Retry blockchain analysis',value:.95,cost:1,fingerprint:'retry:c1:1'}],{});
  assert.equal(ranked.valued[0].action.kind,'provider_retry');
  sql("INSERT INTO investigations(id,external_id,title) VALUES ('inv-d','inv-d','director')");entity('site-d','site','director.example','inv-d');
  ok(await main.call('POST','/api/v1/investigations/inv-d/director',{}));
  const d=ok(await main.call('GET','/api/v1/investigations/inv-d/adaptive'));assert.ok(d.decisions.length>=1&&d.decisions[0].why_selected,'Director decision explained');
 });
 await test('event storm: 50 events plus replay coalesce; evaluations stay bounded and deduplicated by observable state',async()=>{
  const events=Array.from({length:50},(_,i)=>({event_id:`adaptive-storm-${i}`,event_type:'evidence.added',investigation_id:'inv-a',payload:{source:'public fixture'}}));
  ok(await main.call('POST','/api/v1/events',{source_module:'site_investigator',events},MODULE_KEYS.site_investigator));const replay=ok(await main.call('POST','/api/v1/events',{source_module:'site_investigator',events},MODULE_KEYS.site_investigator));assert.equal(replay.duplicates,50);
  const before=main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id=?",opId());
  for(let i=0;i<8;i++)await evaluate();
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_tests WHERE scope_id=? AND status IN ('reserved','running') AND specialist<>'main_local'",opId())<=1);
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id=?",opId())-before<=8,'at most one new decision per evaluation, identical states reuse their decision');
  assert.equal(main.n("SELECT COUNT(*) n FROM (SELECT state_hash FROM adaptive_decisions GROUP BY scope_kind,scope_id,state_hash HAVING COUNT(*)>1)"),0);
 });
 await test('provider outage and flapping: chain-evidence gaps wait for the provider and v7 never starts its own retry storm',async()=>{
  sql("INSERT INTO investigations(id,external_id,title) VALUES ('inv-p','inv-p','provider')");entity('site-p','site','provider.example','inv-p');evidence('ev-p','site-p','inv-p');
  sql("INSERT INTO hunter_operations(id,external_id,name,seed,investigation_id) VALUES ('op-p','op-p','Provider','provider.example','inv-p')");sql("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES ('op-p','site','provider.example','seed')");
  sql("INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,best_context,validation_status,validated_network,analysis_status,observations) VALUES ('cand-p','inv-p','evm:0xpp','evm','0xpp','0xpp','deposit','valid','ethereum','partial',1)");
  sql("INSERT INTO director_retries(candidate_id,investigation_id,status,next_at,reason) VALUES ('cand-p','inv-p','parked','2099-01-01T00:00:00Z','Provider unavailable')");
  sql("INSERT INTO director_provider_health(network,state,failures,next_probe_at) VALUES ('ethereum','unavailable',3,'2099-01-01T00:00:00Z') ON CONFLICT(network) DO UPDATE SET state='unavailable',next_probe_at='2099-01-01T00:00:00Z'");
  const jobs=main.n("SELECT COUNT(*) n FROM jobs WHERE target_module='wallet_investigator'");
  for(let i=0;i<6;i++){sql("UPDATE director_provider_health SET state=? WHERE network='ethereum'",i%2?'healthy':'unavailable');main.sql.exec("UPDATE operation_state SET dirty=1 WHERE operation_id='op-p'");ok(await main.call('POST','/api/v1/operations/op-p/intelligence',{}));}
  sql("UPDATE director_provider_health SET state='unavailable' WHERE network='ethereum'");main.sql.exec("UPDATE operation_state SET dirty=1 WHERE operation_id='op-p'");ok(await main.call('POST','/api/v1/operations/op-p/intelligence',{}));
  const g=main.one("SELECT gap_key,status FROM adaptive_gaps WHERE scope_id='op-p' AND family='BLOCKCHAIN_ACTIVITY'");assert.ok(['waiting_for_provider','in_progress'].includes(g.status),g.status);
  assert.ok(main.one("SELECT 1 x FROM adaptive_gap_history WHERE scope_id='op-p' AND gap_key=? AND status='waiting_for_provider'",g.gap_key),'the outage was recorded as waiting for the provider');
  // A provider going DOWN never wakes parked work (no churn under flapping); only recovery is a wake condition.
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_decisions WHERE scope_id='op-p'")<=7);
  assert.equal(main.n("SELECT COUNT(*) n FROM adaptive_tests WHERE scope_id='op-p' AND family='BLOCKCHAIN_REFRESH'"),0,'v7 does not retry; the v5 Director owns bounded provider recovery');
  assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE target_module='wallet_investigator'"),jobs);
 });
 await test('pause creates no adaptive tests or handoffs',async()=>{
  const n=main.n('SELECT COUNT(*) n FROM adaptive_tests'),w=main.n('SELECT COUNT(*) n FROM work_items');main.sql.exec("INSERT INTO ops_state(key,value) VALUES ('scheduler_paused','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  for(let i=0;i<3;i++)await evaluate();assert.equal(main.n('SELECT COUNT(*) n FROM adaptive_tests'),n);assert.equal(main.n('SELECT COUNT(*) n FROM work_items'),w);main.sql.exec("UPDATE ops_state SET value='false' WHERE key='scheduler_paused'");
 });
 await test('ten concurrent evaluations start at most one external test per operation',async()=>{
  main.sql.exec("UPDATE adaptive_tests SET status='finished',finished_at=COALESCE(finished_at,'2026-09-01T00:00:00Z') WHERE status IN ('reserved','running');UPDATE operation_hunts SET status='finished' WHERE status IN ('reserved','running');UPDATE operation_state SET dirty=1,max_hunts=40");
  await Promise.all(Array.from({length:10},()=>main.call('POST','/api/v1/operations/op-v7/intelligence',{})));
  assert.ok(main.n("SELECT COUNT(*) n FROM adaptive_tests WHERE scope_id=? AND status IN ('reserved','running') AND specialist<>'main_local'",opId())<=1);
  assert.ok(main.n("SELECT COUNT(*) n FROM operation_hunts WHERE operation_id=? AND status IN ('reserved','running')",opId())<=1);
 });
 await test('safety: every v7 test is public/passive, read-only chain, local or analytical, through existing work kinds only',async()=>{
  for(const t of main.all('SELECT family,safety_class,specialist FROM adaptive_tests'))assert.ok(['public_passive','read_only_chain','local_read','analytical'].includes(t.safety_class),t.family);
  for(const w of main.all("SELECT DISTINCT kind FROM work_items WHERE fingerprint LIKE 'operation:%'"))assert.ok(['find_related_sites','reconstruct_operation','revisit_incomplete','revisit_changed_site','analyze_wallet'].includes(w.kind),w.kind);
  assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type NOT IN ('FIND_RELATED_SITES','INVESTIGATE_SITE','RECHECK_SITE','HUNT_OPERATION','ANALYZE_WALLET','REFRESH_WALLET','DISCOVER_SITES')"),0);
  assert.equal(main.n("SELECT COUNT(*) n FROM relationships WHERE relationship_type IN ('owns','owned_by','common_ownership','same_operator')"),0);
 });
 await test('benchmark truth is never imported by production code',async()=>{
  const walk=d=>readdirSync(d).flatMap(n=>{const p=join(d,n);return statSync(p).isDirectory()?walk(p):[p];});
  assert.deepEqual([...walk('lib'),...walk('app')].filter(f=>/bench-adaptive|world\.mjs/.test(readFileSync(f,'utf8'))),[]);
 });
 await test('API: decision explanation and efficiency views',async()=>{
  const v=ok(await main.call('GET','/api/v1/operations/op-v7/adaptive?efficiency=1'));assert.ok(v.summary&&v.summary.question!==undefined);assert.ok(Array.isArray(v.gaps)&&v.gaps.length);assert.ok(v.details.candidates.length);assert.ok(v.efficiency.cost_ledger.length);
  assert.ok(v.caveat.includes('not evidence'));assert.equal((await main.call('GET','/api/v1/operations/missing/adaptive')).status,404);assert.equal((await main.call('GET','/api/v1/adaptive/efficiency?scope_kind=nope&scope_id=x')).status,400);
 });
 await test('0018 is additive and replayable on a populated v6 database; rollback leaves prior data intact',async()=>{
  const path=join(work,'migration.sqlite');applyMigrations(path,n=>n<'0018');const db=new DatabaseSync(path);db.prepare("INSERT INTO investigations(id,external_id,title) VALUES ('kept','kept','Populated v6')").run();
  const m=readFileSync(new URL('../drizzle/0018_adaptive_intelligence.sql',import.meta.url),'utf8');db.exec('BEGIN');db.exec(m);db.exec(m);assert.equal(db.prepare('SELECT title FROM investigations').get().title,'Populated v6');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='adaptive_tests'").get().n,1);db.exec('ROLLBACK');assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='adaptive_tests'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='operation_state'").get().n,1);db.close();
 });
 const result={ok:true,checks:checks.length,passed:checks};mkdirSync('verification/adaptive-v7',{recursive:true});writeFileSync('verification/adaptive-v7/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(e){console.error(e);if(main)console.error(main.log.filter(l=>/ 5\d\d /.test(l)).slice(-5).join('\n'));process.exitCode=1;} finally {if(main)await main.close();rmSync(work,{recursive:true,force:true});}
