import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
test('v5 migration adds triage, durable subscriptions and metrics without dropping v4 data',async()=>{
 const sql=await read('../drizzle/0004_v5_sensor_feedback.sql');
 for(const name of ['site_triage','module_event_inbox','module_metrics'])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${name}`));
 assert.doesNotMatch(sql,/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i);
});
test('routing requires explicit promotion and does not infer wallet validity from confidence',async()=>{
 const src=await read('../lib/planner.ts');
 assert.match(src,/payload\.outcome==="promoted"&&payload\.request_downstream===true/);
 assert.match(src,/payload\.request_investigation===true/);
 assert.doesNotMatch(src,/validation:"confidence_threshold"/);
 assert.match(await read('../lib/events.ts'),/EVENT_ID_CONFLICT/);
});
test('both SDKs expose event delivery and metrics',async()=>{
 const ts=await read('../sdk/typescript/src/client.ts'),py=await read('../sdk/python/main_investigation_client.py');
 for(const term of ['pendingEvents','acknowledgeEvent','submitMetrics'])assert.ok(ts.includes(term));
 for(const term of ['pending_events','acknowledge_event','submit_metrics'])assert.ok(py.includes(term));
});
