import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'v10-corpus-')),dbFile=join(work,'main.sqlite');let main;
try{
 applyMigrations(dbFile);main=await startMain({dbFile,work,libraryFiles:['lib/scientific/engine.ts']});
 main.sql.exec("INSERT INTO hunter_operations(id,external_id,name,seed) VALUES ('counts','counts','Count preservation fixture','source.example')");
 const e=main.sql.prepare("INSERT INTO entities(id,entity_type,canonical_key,display_name) VALUES (?,'site',?,?)");for(let i=0;i<120;i++)e.run('s'+i,'source'+i+'.example','Source '+i);
 for(let i=0;i<12;i++)e.run('t'+i,'target'+i+'.example','Target '+i);
 const r=main.sql.prepare("INSERT INTO relationships(id,source_entity_id,target_entity_id,relationship_type,source_module,source_record_id,schema_version,observed_at) VALUES (?,?,?,'hosting_overlap','site_investigator',?,'3.0','2026-10-01')");
 const edge=main.sql.prepare("INSERT INTO operation_edges(operation_id,relationship_id,source_entity_id,target_entity_id,relationship_type,assertion_kind,category,independence_key,source_module,evidence_ids,confidence,first_seen,last_seen) VALUES ('counts',?,?,?,'hosting_overlap','observed','infrastructure_context',?,'site_investigator',?,.5,'2026-10-01','2026-10-01')");
 main.sql.exec('BEGIN');for(let i=0;i<2400;i++){const id='r'+String(i).padStart(4,'0'),s='s'+(i%97),t='t'+(i%11);r.run(id,s,t,id);edge.run(id,s,t,id,i%13?'["fixture-proof"]':'[]');}
 // Outside the bounded page and operation: these sources still contribute to corpus commonality.
 for(let i=0;i<23;i++)r.run('outside'+i,'s'+(97+i),'t'+(i%11),'outside'+i);main.sql.exec('COMMIT');
 const control="SELECT oe.*,e.canonical_key,e.entity_type,(SELECT COUNT(DISTINCT r.source_entity_id) FROM relationships r WHERE r.target_entity_id=oe.target_entity_id) corpus_sites FROM operation_edges oe JOIN entities e ON e.id=oe.target_entity_id WHERE oe.operation_id=? AND oe.evidence_ids<>'[]' ORDER BY oe.relationship_id LIMIT 2000";
 const before=main.n('SELECT COUNT(*) n FROM relationships'),expected=main.all(control,'counts');assert.equal(expected.length,2000);
 const actual=main.all(main.library['lib/scientific/engine.ts'].RELATIONAL_PAGE_SQL,'counts');assert.deepEqual(actual,expected,'every bounded edge, field, deterministic order and distinct corpus-source count matches the original query');
 await main.library['lib/scientific/engine.ts'].projectScientific('counts');assert.equal(main.n('SELECT COUNT(*) n FROM relationships'),before);
 for(const row of actual){assert.equal(main.one('SELECT corpus_sites FROM scientific_commonality WHERE artifact_key=?',row.canonical_key).corpus_sites,row.corpus_sites);}
 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/corpus-counts.json',JSON.stringify({ok:true,compared_edges:actual.length,canonical_relationships:before,checks:['exact old-query equivalence','distinct source counts include out-of-operation sources','duplicate source edges do not inflate corpus','empty proof excluded and 2000 page bound/order retained','actual scientific projection uses matching counts','canonical relationship provenance retained']},null,2));console.log('PASS corpus counts and bounded page preserved');
}finally{await main?.close();rmSync(work,{recursive:true,force:true});}
