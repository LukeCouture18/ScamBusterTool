import {importFrom} from './lib/portable.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';

const generated=JSON.parse(readFileSync('dist/server/wrangler.json','utf8'));
assert.ok(generated.triggers?.crons?.length,'built production entry needs automatic cron configuration');
const sql=new DatabaseSync(':memory:');
const migrations=new URL('../drizzle/',import.meta.url);
for(const filename of (await readdir(migrations)).filter(n=>/^[0-9]{4}_.*\.sql$/.test(n)).sort())sql.exec(await readFile(new URL(filename,migrations),'utf8'));
const db={prepare(statement){let params=[];return{bind(...v){params=v;return this;},async run(){return{meta:{changes:Number(sql.prepare(statement).run(...params).changes)}};},async first(){return sql.prepare(statement).get(...params)??null;},async all(){return{results:sql.prepare(statement).all(...params)}}};},async batch(queries){sql.exec('BEGIN');try{const result=[];for(const query of queries)result.push(await query.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
globalThis.__TEST_ENV={DB:db};
const work=await mkdtemp(join(tmpdir(),'mip-scheduled-'));
try{
  await build({entryPoints:['worker.ts'],bundle:true,format:'esm',platform:'node',outfile:join(work,'worker.mjs'),plugins:[{name:'worker-env',setup(plugin){plugin.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'test'}));plugin.onLoad({filter:/^env$/,namespace:'test'},()=>({contents:'export const env=globalThis.__TEST_ENV',loader:'js'}));plugin.onResolve({filter:/^vinext\/server\/fetch-handler$/},()=>({path:'handler',namespace:'test'}));plugin.onLoad({filter:/handler/,namespace:'test'},()=>({contents:'export default {fetch:()=>new Response("ok")}',loader:'js'}));}}]});
  const eventId=crypto.randomUUID();
  sql.prepare("INSERT INTO event_store(id,event_id,event_type,schema_version,correlation_id,source_module,payload,provenance,content_hash,hop_count,occurred_at,status) VALUES (?,?,?,?,?,'platform','{}','{}','synthetic',0,CURRENT_TIMESTAMP,'pending')").run(crypto.randomUUID(),eventId,'investigation.updated','3.0',eventId);
  const worker=(await importFrom(work,'worker.mjs')).default;
  const incomplete=new DatabaseSync(':memory:');
  for(const filename of (await readdir(migrations)).filter(n=>/^000[0-4]_.*\.sql$/.test(n)).sort())incomplete.exec(await readFile(new URL(filename,migrations),'utf8'));
  const blocked=await worker.fetch(new Request('http://localhost/'),{DB:{prepare(statement){return{all(){return{results:incomplete.prepare(statement).all()}}};}}},{});
  assert.equal(blocked.status,503,'request handler must refuse an incomplete schema');
  assert.equal((await blocked.json()).error,'SCHEMA_UPGRADE_INCOMPLETE');
  incomplete.close();
  const workItems=[];
  await worker.scheduled({cron:generated.triggers.crons[0]},globalThis.__TEST_ENV,{waitUntil(task){workItems.push(task);}});
  await Promise.all(workItems);
  assert.equal(sql.prepare('SELECT status FROM event_store WHERE event_id=?').get(eventId).status,'processed','real scheduled entry must drain persisted events without UI/endpoint request');
  console.log(JSON.stringify({ok:true,scheduled:true,cron:generated.triggers.crons[0],event_processed:true}));
}finally{await rm(work,{recursive:true,force:true});sql.close();}
