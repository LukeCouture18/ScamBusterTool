import {importFrom} from './lib/portable.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
const root=new URL('../drizzle/',import.meta.url);
const names=(await readdir(root)).filter(n=>/^[0-9]{4}_.*\.sql$/.test(n)).sort();
const scripts=await Promise.all(names.map(name=>readFile(new URL(name,root),'utf8')));
const work=await mkdtemp(join(tmpdir(),'mip-migrations-'));
await build({entryPoints:['lib/schema-ready.ts'],bundle:true,format:'esm',platform:'node',outfile:join(work,'gate.mjs')});
const {assertSchemaReady}=await importFrom(work,'gate.mjs');
function adapter(sql){return{prepare(query){let args=[];return{bind(...values){args=values;return this;},async all(){return{results:sql.prepare(query).all(...args)}}};}};}
function seed(sql){sql.prepare("INSERT INTO investigations(id,external_id,title) VALUES ('case-1','historic-case','Historic case')").run();sql.prepare("INSERT INTO evidence(id,investigation_id,source_module,source_record_id,evidence_type,title,schema_version,captured_at) VALUES ('e1','case-1','site_finder','old','capture','Existing screenshot','1.1',CURRENT_TIMESTAMP)").run();}
for(const [label,count] of [['fresh',0],['v5',5],['v6',8],['v6.1 checkpoint',8]]){
 test(`${label} upgrade preserves evidence and passes startup schema gate`,async()=>{const sql=new DatabaseSync(':memory:');try{for(let i=0;i<count;i++)sql.exec(scripts[i]);if(count)seed(sql);for(let i=count;i<scripts.length;i++){sql.exec('BEGIN');try{sql.exec(scripts[i]);sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}}await assertSchemaReady(adapter(sql));if(count){assert.equal(sql.prepare("SELECT title FROM evidence WHERE id='e1'").get().title,'Existing screenshot');assert.equal(sql.prepare("SELECT title FROM investigations WHERE id='case-1'").get().title,'Historic case');}}finally{sql.close();}});
}
for(const [label,point] of [['before migration',0],['between migrations',1],['during schema modification',2],['after schema before bookkeeping',3],['during data migration',4],['restart after partial migration',5]]){
 test(`${label}: rollback or refuse startup`,async()=>{const sql=new DatabaseSync(':memory:');try{for(let i=0;i<5;i++)sql.exec(scripts[i]);seed(sql);if(point===1)sql.exec(scripts[5]);if(point>=2&&point<=4){sql.exec('BEGIN');try{if(point===2)sql.exec('ALTER TABLE evidence ADD COLUMN injected TEXT; INVALID MIGRATION;');else if(point===3){sql.exec(scripts[5]);throw Error('crash before bookkeeping');}else {sql.exec('UPDATE evidence SET title=\'changed\'; INVALID DATA MIGRATION;');}}catch{sql.exec('ROLLBACK');}}if(point===5){sql.exec(scripts[5]);sql.exec(scripts[6]);}
 await assert.rejects(assertSchemaReady(adapter(sql)),/SCHEMA_UPGRADE_INCOMPLETE/);assert.equal(sql.prepare("SELECT title FROM evidence WHERE id='e1'").get().title,'Existing screenshot');if(point===2)assert.equal(sql.prepare('PRAGMA table_info(evidence)').all().some(c=>c.name==='injected'),false);
 }finally{sql.close();}});
}
await rm(work,{recursive:true,force:true});
