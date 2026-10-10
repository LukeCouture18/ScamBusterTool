import assert from 'node:assert/strict';import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {applyMigrations,startMain,MODULE_KEYS} from './lib/main-harness.mjs';
const work=mkdtempSync(join(tmpdir(),'v10-missions-')),dbFile=join(work,'main.sqlite');let main;
const ok=r=>{assert.ok([200,201,202].includes(r.status),JSON.stringify(r.body));return r.body;};
try{
 applyMigrations(dbFile);main=await startMain({dbFile,work,libraryFiles:['lib/missions.ts','lib/jobs.ts','tests/lib/v10-guard-entry.ts','lib/autonomy.ts']});const mission=()=>main.library['lib/missions.ts'];
 ok(await main.call('POST','/api/v1/modules/site_investigator/register',{module_version:'fixture',schema_version:'3.0',capabilities:['site:investigate'],supported_event_types:[]},MODULE_KEYS.site_investigator));
 main.sql.prepare("INSERT OR REPLACE INTO ops_state(key,value) VALUES('module_limit:site_investigator','4')").run();
 const parent=ok(await main.call('POST','/api/v1/autonomy',{site:'parent.example'})),inv=parent.investigation_id,root=main.one('SELECT root_id FROM autonomous_missions WHERE investigation_id=?',inv).root_id;
 const add=(id,domain,related,groups=['promise','wallet'])=>main.sql.prepare("INSERT INTO inbox_candidates(id,canonical_domain,url,status,score,related_domains,details) VALUES (?,?,?,'ready',.9,?,?)").run(id,domain,'https://'+domain,JSON.stringify(related),JSON.stringify({signals:groups.map(group=>({name:group,group,strength:1,origin_url:'https://'+domain}))}));
 add('generic-decoy','generic.example',['parent.example'],['cdn','template']);for(let i=0;i<6;i++)add('child-'+i,'child'+i+'.example',['parent.example']);
 await Promise.all(Array.from({length:6},()=>mission().missionTick(1)));
 assert.equal(main.n('SELECT COUNT(*) n FROM mission_opportunities WHERE root_id=?',root),1,'root lease limits each concurrent tick to one child');
 for(let i=0;i<5;i++)await mission().missionTick(1);
 if(process.env.MISSION_TRACE)console.log(JSON.stringify({missions:main.all('SELECT * FROM autonomous_missions'),resources:main.all('SELECT * FROM mission_resources'),opportunities:main.all('SELECT * FROM mission_opportunities'),reservations:main.all('SELECT * FROM mission_reservations'),director_resources:main.all('SELECT * FROM director_resources'),jobs:main.all('SELECT job_type,status,investigation_id,target_module,trigger_reason FROM jobs')}));
 assert.equal(main.n('SELECT COUNT(*) n FROM autonomous_missions WHERE root_id=?',root),4);assert.equal(main.one('SELECT sites FROM mission_resources WHERE root_id=?',root).sites,4);
 assert.equal(main.n("SELECT COUNT(*) n FROM autonomous_missions WHERE target='generic.example'"),0);assert.equal(main.n('SELECT COUNT(*) n FROM inbox_decisions'),0);
 const children=main.all('SELECT * FROM autonomous_missions WHERE root_id=? AND parent_id IS NOT NULL',root);assert.ok(children.every(c=>c.depth===1&&c.parent_id==='mission:'+inv));
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE target_module='site_investigator' AND status='pending'"),4);assert.equal(main.one('SELECT requests FROM mission_resources WHERE root_id=?',root).requests,200);
 for(const c of children)assert.equal(main.n('SELECT COUNT(*) n FROM evidence WHERE investigation_id=?',c.investigation_id),0,'parent evidence is not copied into child');
 let view=ok(await main.call('GET',`/api/v1/investigations/${inv}/mission`));assert.equal(view.snapshot.budget.max_sites,4);assert.ok(view.snapshot.evidence_lineage.length===4);assert.equal(view.stage,'Investigating');
 const before=main.n('SELECT COUNT(*) n FROM mission_history');for(let i=0;i<5;i++)await mission().projectMission(inv);assert.equal(main.n('SELECT COUNT(*) n FROM mission_history'),before,'unchanged snapshots do not append history');
 main.sql.prepare('UPDATE mission_resources SET max_requests=requests,max_jobs=jobs+4 WHERE root_id=?').run(root);
 await assert.rejects(main.library['lib/jobs.ts'].enqueueJob({job_type:'RECHECK_SITE',investigation_id:children[0].investigation_id,target_module:'site_investigator',created_by_module:'platform',payload:{canonical_key:children[0].target},budget_dimension:'job'}),/BUDGET_EXHAUSTED/);
 assert.equal(main.n("SELECT COUNT(*) n FROM jobs WHERE job_type='RECHECK_SITE'"),0);assert.equal(main.one('SELECT requests FROM mission_resources WHERE root_id=?',root).requests,200);
 const guarded=main.library['tests/lib/v10-guard-entry.ts'];await assert.rejects(guarded.withoutExecution('fixture replay',()=>guarded.investigateSite('replay.example')),/EXECUTION_BLOCKED/);assert.equal(main.n("SELECT COUNT(*) n FROM autonomous_missions WHERE target='replay.example'"),0);
 await main.close();main=await startMain({dbFile,work,libraryFiles:['lib/missions.ts'],label:'mission-restart'});await mission().missionTick(1);assert.equal(main.n('SELECT COUNT(*) n FROM autonomous_missions WHERE root_id=?',root),4);
 // A reserved child is attached after restart without reserving another slot.
 main.sql.exec("UPDATE module_registry SET last_heartbeat_at='2000-01-01'");
 const p2=ok(await main.call('POST','/api/v1/autonomy',{site:'recovery-parent.example'})),r2='mission:'+p2.investigation_id;add('recover-child','recovered-child.example',['recovery-parent.example']);
 main.sql.prepare("INSERT INTO mission_opportunities(id,root_id,parent_id,candidate_id,domain,url,depth,assessment,reason) VALUES (?,?,?,?,?,?,1,'{}','fixture durable selection')").run('recovery-edge',r2,r2,'recover-child','recovered-child.example','https://recovered-child.example');main.sql.prepare('UPDATE mission_resources SET sites=sites+1 WHERE root_id=?').run(r2);
 await mission().missionTick(20);assert.equal(main.one("SELECT status FROM mission_opportunities WHERE id='recovery-edge'").status,'attached');assert.equal(main.one('SELECT sites FROM mission_resources WHERE root_id=?',r2).sites,2);
 add('depth-two','depth-two.example',['recovered-child.example']);await mission().missionTick(20);
 const depthTwo=main.one("SELECT * FROM autonomous_missions WHERE target='depth-two.example'");assert.equal(depthTwo.depth,2);assert.equal(depthTwo.root_id,r2);
 add('depth-three','depth-three.example',['depth-two.example']);for(let i=0;i<3;i++)await mission().missionTick(20);assert.equal(main.n("SELECT COUNT(*) n FROM autonomous_missions WHERE target='depth-three.example'"),0,'depth boundary survives spare site allowance');
 mkdirSync('verification/v10',{recursive:true});writeFileSync('verification/v10/missions.json',JSON.stringify({ok:true,checks:['root lease','bounded four-site saturation','generic-correlation rejection','no analyst votes','lineage','separate per-site evidence','atomic shared budget and no orphan charge','stable history','replay guard','graceful restart','reserved-child recovery'],scope:'Actual Main source/routes over SQLite fixture; real process termination and full golden workflows still pending.'},null,2));console.log('PASS bounded missions and recovery');
}finally{await main?.close();rmSync(work,{recursive:true,force:true});}
