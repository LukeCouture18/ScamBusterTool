// Main Platform v2 inbox, end to end through the real route handlers:
// real Site Finder v2 batches (from a simulated round) -> ingest -> inbox ->
// NEXT / OPEN / USEFUL / SKIP -> routed work -> decision feed -> supply.
// Synthetic data only; no network.
import {importFrom,localPath,runPythonJson} from './lib/portable.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
const migrations=new URL('../drizzle/',import.meta.url);
for(const name of (await readdir(migrations)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort())sql.exec(await readFile(new URL(name,migrations),'utf8'));
const db={prepare(statement){let params=[];return{bind(...v){params=v;return this;},async run(){return{meta:{changes:Number(sql.prepare(statement).run(...params).changes)}};},async first(){return sql.prepare(statement).get(...params)??null;},async all(){return{results:sql.prepare(statement).all(...params)}}};},async batch(queries){sql.exec('BEGIN');try{const result=[];for(const q of queries)result.push(await q.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
globalThis.__TEST_ENV={DB:db,MODULE_API_KEYS:JSON.stringify({site_finder:'finder-key',site_investigator:'investigator-key',crypto_wallet_logger:'logger-key'})};
const work=await mkdtemp(join(tmpdir(),'mip-v2-inbox-'));
const routes=['app/api/v1/modules/[module]/register/route.ts','app/api/v1/modules/[module]/heartbeat/route.ts','app/api/v1/ingest/[module]/route.ts','app/api/v1/modules/[module]/jobs/claim/route.ts','app/api/v1/inbox/route.ts','app/api/v1/inbox/next/route.ts','app/api/v1/inbox/[id]/route.ts','app/api/v1/inbox/[id]/decision/route.ts','app/api/v1/inbox/[id]/opened/route.ts','app/api/v1/inbox/decisions/route.ts','app/api/v1/inbox/supply/route.ts','app/api/v1/inbox/settings/route.ts','app/api/v1/compat/logger/route.ts'];
try{
await build({entryPoints:routes,bundle:true,splitting:true,format:'esm',platform:'node',outdir:work,plugins:[{name:'test-env',setup(p){p.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'test'}));p.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const env=globalThis.__TEST_ENV',loader:'js'}));}}]});
const load=(p)=>importFrom(work,p);
const register=await load('modules/[module]/register/route.js'),ingest=await load('ingest/[module]/route.js'),claim=await load('modules/[module]/jobs/claim/route.js');
const overview=await load('inbox/route.js'),next=await load('inbox/next/route.js'),detail=await load('inbox/[id]/route.js'),decision=await load('inbox/[id]/decision/route.js'),opened=await load('inbox/[id]/opened/route.js'),feed=await load('inbox/decisions/route.js'),supply=await load('inbox/supply/route.js'),settings=await load('inbox/settings/route.js'),logger=await load('compat/logger/route.js');
const req=(path,data,key,method='POST')=>new Request('http://127.0.0.1'+path,{method,headers:{'content-type':'application/json',...(key?{'x-api-key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
const one=(q,...a)=>sql.prepare(q).get(...a),all=(q,...a)=>sql.prepare(q).all(...a);
const params=(o)=>({params:Promise.resolve(o)});

for(const [module,key,caps] of [['site_finder','finder-key',['site:discover','site:relate']],['site_investigator','investigator-key',['site:investigate']],['crypto_wallet_logger','logger-key',['wallet:log']]]){
  const r=await register.POST(req(`/api/v1/modules/${module}/register`,{module_version:'2.0.0-test',schema_version:'3.0',capabilities:caps,supported_event_types:[]},key),params({module}));assert.equal(r.status,200,await r.clone().text());}

// 1. Real Site Finder v2 batches from a simulated discovery round.
const finder=runPythonJson(localPath('./finder-v2-batches.py',import.meta.url));
assert.ok(finder.batches.length>=4,'a simulated round delivers several candidates');
assert.ok(finder.gated>finder.batches.length*5,'most probed domains are filtered out before delivery');
for(const b of finder.batches){const r=await ingest.POST(req('/api/v1/ingest/site_finder',{schema_version:'3.0',batch_id:b.batch_id,sent_at:new Date().toISOString(),records:b.records},'finder-key'),params({module:'site_finder'}));const body=await r.json();assert.equal(r.status,202,JSON.stringify(body));assert.equal(body.status,'accepted',JSON.stringify(body.errors));}
assert.equal(one("SELECT COUNT(*) n FROM inbox_candidates").n,finder.batches.length,'every delivered candidate reaches the inbox');
assert.equal(one("SELECT COUNT(*) n FROM inbox_candidates WHERE status='ready'").n,finder.batches.length);
assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='INVESTIGATE_SITE'").n,0,'no background investigation before you decide');
assert.equal(one("SELECT COUNT(*) n FROM site_triage WHERE outcome='promoted' AND request_downstream=0").n,finder.batches.length,'promotion is recorded as non-routing');
assert.equal(one("SELECT COUNT(*) n FROM dead_letters").n,0,'nothing rejected');

// 2. Replay is idempotent and does not duplicate inbox rows.
{const evil=structuredClone(finder.batches[2].records);evil.sites[0].url="javascript:alert(1)";await ingest.POST(req("/api/v1/ingest/site_finder",{schema_version:"3.0",batch_id:"evil-url",sent_at:new Date().toISOString(),records:evil},"finder-key"),params({module:"site_finder"}));assert.match(one("SELECT url FROM inbox_candidates WHERE canonical_domain=?",evil.sites[0].inbox.candidate_id).url,/^https:\/\//,"only http(s) URLs reach the browser");}
const b0=finder.batches[0];await ingest.POST(req('/api/v1/ingest/site_finder',{schema_version:'3.0',batch_id:b0.batch_id,sent_at:new Date().toISOString(),records:b0.records},'finder-key'),params({module:'site_finder'}));
assert.equal(one("SELECT COUNT(*) n FROM inbox_candidates").n,finder.batches.length);

// 3. Platform-side cluster dedup: a mirror (same cluster, no new wallet) is suppressed, not shown.
const mirror=structuredClone(finder.batches[1].records);const site=mirror.sites[0];const src=site.inbox.candidate_id;const twin='mirror-of-'+src.replace(/\./g,'-')+'.top';
const swap=(o)=>JSON.parse(JSON.stringify(o).replaceAll(src,twin).replace(/(sf:[a-z]+:)([0-9a-f])([0-9a-f]{31})/g,(_,p,a,b)=>p+(a==='f'?'e':'f')+b));const m=swap(mirror);m.sites[0].inbox.cluster_key=site.inbox.cluster_key;m.sites[0].inbox.wallets=site.inbox.wallets;
let r=await ingest.POST(req('/api/v1/ingest/site_finder',{schema_version:'3.0',batch_id:'mirror-batch',sent_at:new Date().toISOString(),records:m},'finder-key'),params({module:'site_finder'}));assert.equal(r.status,202,await r.clone().text());
const mrow=one("SELECT status,suppressed_reason FROM inbox_candidates WHERE canonical_domain=?",twin);assert.equal(mrow.status,'suppressed');assert.match(mrow.suppressed_reason,/Mirror of/);
assert.ok(JSON.parse(one("SELECT related_domains FROM inbox_candidates WHERE canonical_domain=?",src).related_domains).includes(twin),'mirror is attached to its representative');

// 4. NEXT returns the highest-scoring candidate, leased.
r=await next.GET();let body=await r.json();assert.ok(body.item);const first=body.item;
const best=one("SELECT canonical_domain FROM inbox_candidates WHERE status IN ('ready','presented') ORDER BY score DESC, created_at ASC, rowid ASC LIMIT 1");assert.equal(first.domain,best.canonical_domain);
assert.deepEqual(Object.keys(first).sort(),['category','domain','headline','id','related_count','score','url'].sort(),'the card carries only what the decision needs');
assert.equal(one("SELECT status FROM inbox_candidates WHERE id=?",first.id).status,'presented');
r=await next.GET();body=await r.json();assert.notEqual(body.item.id,first.id,'a leased candidate is not shown twice');const second=body.item;
assert.equal((await opened.POST(req('/x',{}),params({id:first.id}))).status,200);

// 5. USEFUL routes site investigation through the planner and queues related-site discovery.
r=await decision.POST(req('/x',{decision:'useful'}),params({id:first.id}));body=await r.json();assert.equal(r.status,200,JSON.stringify(body));
const inv=one("SELECT investigation_id,entity_id FROM inbox_candidates WHERE id=?",first.id);
assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='INVESTIGATE_SITE' AND investigation_id=? AND target_module='site_investigator'",inv.investigation_id).n,1,JSON.stringify(body.actions));
assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='FIND_RELATED_SITES' AND target_module='site_finder' AND investigation_id=?",inv.investigation_id).n,1);
assert.equal(one("SELECT progress_state FROM inbox_candidates WHERE id=?",first.id).progress_state,'awaiting_evidence');
// deciding twice is harmless
r=await decision.POST(req('/x',{decision:'skip'}),params({id:first.id}));assert.equal((await r.json()).already,'useful');

// 6. SKIP records a non-routing dismissal and cancels nothing it shouldn't.
r=await decision.POST(req('/x',{decision:'skip',reason:'not_a_scam'}),params({id:second.id}));body=await r.json();assert.equal(body.decision,'skip');
assert.equal(one("SELECT COUNT(*) n FROM site_triage WHERE outcome='dismissed' AND source_module='platform'").n,1);
assert.equal((await decision.POST(req('/x',{decision:'maybe'}),params({id:second.id}))).status,400,'only useful/skip are accepted');

// 7. Site Finder reads the decisions (module-authenticated), in order, with a cursor.
assert.equal((await feed.GET(req('/api/v1/inbox/decisions?module=site_finder',undefined,'wrong-key','GET'))).status,401);
r=await feed.GET(req('/api/v1/inbox/decisions?module=site_finder&after=',undefined,'finder-key','GET'));body=await r.json();
assert.deepEqual(body.decisions.map(d=>[d.candidate_id,d.decision]),[[first.domain,'useful'],[second.domain,'skip']]);
r=await feed.GET(req(`/api/v1/inbox/decisions?module=site_finder&after=${body.next_cursor}`,undefined,'finder-key','GET'));assert.equal((await r.json()).decisions.length,0);

// 8. WalletLogger evidence joins the same investigation (www. variant included) and progress is visible.
r=await logger.POST(req('/api/v1/compat/logger',{id:'wl-1',type:'wallet.observed',schemaVersion:'1.0.0',occurredAt:new Date().toISOString(),source:'CryptoWalletLogger',sourceVersion:'0.8',payload:{domain:'www.'+first.domain,wallet:'TXYZsyntheticwallet000000000000001',network:'TRON',sourceUrl:`https://www.${first.domain}/deposit`,confidence:'high'}},'logger-key'),{});assert.ok([200,202].includes(r.status),await r.clone().text());
r=await overview.GET();body=await r.json();const w=body.working.find(x=>x.id===first.id);assert.ok(w,'useful candidate appears in progress');assert.match(w.state,/wallet/i);
assert.ok(body.stats.decided===2&&body.stats.useful===1);

// 9. Supply: below target depth, one DISCOVER_SITES job for Site Finder; never duplicated; claimable.
r=await settings.PATCH(req('/x',{target_depth:50},undefined,'PATCH'));assert.equal((await r.json()).target_depth,50);
assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES'").n,0,'no discovery while the inbox is at target depth');
r=await supply.POST();body=await r.json();assert.equal(body.queued,true);assert.equal(body.requested,50-body.waiting);
r=await supply.POST();body=await r.json();assert.equal(body.queued,false,'never two discovery jobs at once');
assert.equal(one("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND status='pending'").n,1);
assert.equal(JSON.parse(one("SELECT payload FROM jobs WHERE job_type='DISCOVER_SITES'").payload).automation_policy.financial_actions_allowed,false);
r=await claim.POST(req('/api/v1/modules/site_finder/jobs/claim',{},'finder-key'),params({module:'site_finder'}));const claimed=await r.json();
const types=[claimed.job?.job_type];assert.ok(types[0]==='DISCOVER_SITES'||types[0]==='FIND_RELATED_SITES',JSON.stringify(claimed));

// 10. The advanced view carries the full breakdown.
r=await detail.GET(req('/x',undefined,undefined,'GET'),params({id:first.id}));body=await r.json();
assert.ok(body.details.score&&body.details.signals.length&&body.details.strategies.length,'score components, signals and discovery strategies are available on demand');
assert.ok(body.jobs.length>=2);assert.match(body.note,/not proof/);
console.log(JSON.stringify({ok:true,synthetic:true,delivered:finder.batches.length,probed:finder.probed,gated:finder.gated,mirror_suppressed:true,useful_routes:['INVESTIGATE_SITE','FIND_RELATED_SITES'],decision_feed:true,logger_joined:true,supply:true}));
}finally{await rm(work,{recursive:true,force:true});}
