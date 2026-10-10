// Actual SQLite rows and real Main API queries; no projected performance extrapolation.
import assert from 'node:assert/strict';import {mkdtempSync,rmSync,mkdirSync,writeFileSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {performance} from 'node:perf_hooks';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'operation-stress-')),dbFile=join(work,'main.sqlite');let main;
const timings=[];const timed=async(name,fn)=>{const begin=performance.now(),r=await fn();timings.push({name,ms:Number((performance.now()-begin).toFixed(2))});return r;};
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
try {
 applyMigrations(dbFile);main=await startMain({dbFile,work});const db=main.sql;
 const memoryBefore=process.memoryUsage().rss,emptyBytes=statSync(dbFile).size;
 await timed('load_10000_entities_50100_relationships',async()=>{
  db.exec('BEGIN');
  const inv=db.prepare('INSERT INTO investigations(id,external_id,title) VALUES (?,?,?)'),entity=db.prepare('INSERT INTO entities(id,investigation_id,entity_type,canonical_key,display_name) VALUES (?,?,?,?,?)'),link=db.prepare("INSERT INTO investigation_entities(id,investigation_id,entity_id,source_module,source_record_id) VALUES (?,?,?,'site_investigator',?)"),ev=db.prepare("INSERT INTO evidence(id,investigation_id,entity_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES (?,?,?,'site_investigator',?,'public_artifact',?,'3.0','2026-09-01T00:00:00Z')");
  for(let i=0;i<300;i++)inv.run(`inv-${i}`,`inv-${i}`,`Investigation ${i}`);
  for(let i=0;i<10000;i++){const type=i%5===0?'wallet':'site',key=type==='wallet'?`ethereum:0x${i.toString(16).padStart(40,'0')}`:`node-${i}.example`;entity.run(`e-${i}`,`inv-${i%300}`,type,key,key);link.run(`ie-${i}`,`inv-${i%300}`,`e-${i}`,`entity-${i}`);if(i%2===0)ev.run(`ev-${i}`,`inv-${i%300}`,`e-${i}`,`source-${i}`,`Public source ${i}`);}
  const rel=db.prepare("INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at,assertion_kind) VALUES (?,?,?,?,'site_investigator',?,'3.0','2026-09-01T00:00:00Z','observed')"),ref=db.prepare("INSERT INTO relationship_evidence(id,relationship_id,evidence_id,source_module) VALUES (?,?,?,'site_investigator')");
  for(let i=0;i<50100;i++){const from=i%10000,cluster=Math.floor(from/400)*400,to=cluster+(from+1)%400;rel.run(`r-${i.toString().padStart(6,'0')}`,`e-${from}`,`e-${to}`,i%3===0?'deposit_observed':i%3===1?'template_overlap':'hosting_overlap',`r-${i}`);ref.run(`re-${i}`,`r-${i.toString().padStart(6,'0')}`,`ev-${from-from%2}`);}
  const op=db.prepare("INSERT INTO hunter_operations(id,external_id,name,seed) VALUES (?,?,?,?)"),member=db.prepare("INSERT INTO hunter_operation_members(operation_id,entity_type,canonical_key,role) VALUES (?,?,?,'member')");
  for(let o=0;o<25;o++){op.run(`op-${o}`,`op-${o}`,`Synthetic cluster ${o}`,`node-${o*400+1}.example`);for(let i=o*400;i<(o+1)*400;i++){const type=i%5===0?'wallet':'site',key=type==='wallet'?`ethereum:0x${i.toString(16).padStart(40,'0')}`:`node-${i}.example`;member.run(`op-${o}`,type,key);}}
  db.exec('COMMIT');
 });
 for(let i=0;i<35&&main.n('SELECT COUNT(*) n FROM operation_edges')<50100;i++)await timed('director_projection_tick',async()=>ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{})));
 assert.equal(main.n('SELECT COUNT(*) n FROM operation_edges'),50100);
 await timed('briefing_and_graph_first_page',async()=>{const b=ok(await main.call('GET','/api/v1/operations/op-0/intelligence'));assert.equal(b.edges.length,100);assert.ok(b.next_cursor);assert.equal(b.timeline.length,100);assert.ok(b.entities.length<=200);});
 await timed('paginated_graph_query',async()=>{const b=ok(await main.call('GET','/api/v1/operations/op-0/intelligence?cursor=r-000099&limit=100'));assert.ok(b.edges[0].relationship_id>'r-000099');});
 await timed('wallet_view',async()=>{const b=ok(await main.call('GET','/api/v1/operations/op-0/intelligence?view=wallet'));assert.ok(b.edges.every(e=>e.category==='wallet_observation'));});
 await timed('edge_explanation',async()=>{const b=ok(await main.call('GET','/api/v1/operations/op-0/intelligence/connections/r-000000'));assert.equal(b.evidence.length,1);});
 await timed('event_processing_10_wakeups',async()=>{const r=await main.call('POST','/api/v1/events',{source_module:'site_investigator',events:Array.from({length:10},(_,i)=>({event_id:`stress-wake-${i}`,event_type:'evidence.added',investigation_id:'inv-0',payload:{source:'public stress fixture'}}))},MODULE_KEYS.site_investigator);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.accepted,10);});
 await timed('idle_portfolio_tick',async()=>ok(await main.call('POST','/api/v1/operations/op-0/intelligence',{})));
 const rss=process.memoryUsage().rss,bytes=statSync(dbFile).size,result={ok:true,rows:{entities:main.n('SELECT COUNT(*) n FROM entities'),relationships:main.n('SELECT COUNT(*) n FROM relationships'),evidence:main.n('SELECT COUNT(*) n FROM evidence'),investigations:300,operations:25,projected_edges:50100},timings,memory:{rss_before_bytes:memoryBefore,rss_after_bytes:rss,peak_rss_kb:process.resourceUsage().maxRSS},database:{before_bytes:emptyBytes,after_bytes:bytes,growth_bytes:bytes-emptyBytes},limits:{graph_page:100,entity_page:200,timeline_page:100}};
 mkdirSync('verification/operation-v6',{recursive:true});writeFileSync('verification/operation-v6/stress.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e);process.exitCode=1;}finally{if(main)await main.close();rmSync(work,{recursive:true,force:true});}
