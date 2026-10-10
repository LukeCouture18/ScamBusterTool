import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync,readdirSync} from 'node:fs';
const dir=new URL('../drizzle/',import.meta.url),names=readdirSync(dir).filter(n=>/^\d{4}.*sql$/.test(n)).sort(),v5=readFileSync(new URL('0016_investigation_director.sql',dir),'utf8');
test('populated v4 migration and rollback retain candidates, observations, evidence and approval hashes',()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 try{
  for(const n of names.filter(n=>n<'0016'))db.exec(readFileSync(new URL(n,dir),'utf8'));
  db.exec("INSERT INTO investigations(id,external_id,title) VALUES ('historic','historic','Existing v4 case');INSERT INTO wallet_candidates(id,investigation_id,identity,family,address,address_normalized,validation_status,validated_network,best_context,analysis_status) VALUES ('wallet','historic','evm:abc','evm','abc','abc','valid','ethereum','deposit','partial');INSERT INTO wallet_observations(id,candidate_id,investigation_id,address,context_class,content_sha256) VALUES ('obs','wallet','historic','abc','deposit','original-content-hash');INSERT INTO approval_gates(id,investigation_id,action,scope,requested_reason,status) VALUES ('gate','historic','PREPARE_REPORT','{}','review','approved');INSERT INTO report_candidates(id,investigation_id,evidence_snapshot,evidence_sha256,approval_id) VALUES ('report','historic','original-snapshot','original-approval-hash','gate');");
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();const data=new Map(tables.map(t=>[t.name,JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all())]));
  db.exec(v5);db.exec(v5);
  for(const t of tables){assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(t.name).sql,t.sql);assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all()),data.get(t.name));}
  db.exec("INSERT INTO director_investigations(investigation_id) VALUES ('historic');INSERT INTO director_retries(candidate_id,investigation_id,next_at,reason) VALUES ('wallet','historic','2099-01-01','Provider outage')");
  db.exec('BEGIN');assert.throws(()=>db.exec('DROP TABLE director_retries;INVALID SQL;'));db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) n FROM director_retries').get().n,1);
  for(const table of ['director_reservations','director_resources','director_provider_health','director_retries','director_actions','director_objectives','director_investigations'])db.exec(`DROP TABLE ${table}`);
  for(const t of tables)assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all()),data.get(t.name));
 }finally{db.close();}
});
