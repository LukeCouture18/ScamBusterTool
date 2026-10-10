import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const contract=JSON.parse(await readFile(new URL('../sdk/contracts/v6.json',import.meta.url),'utf8'));
test('the server, SDK and machine readable event catalog agree',async()=>{const ts=await readFile(new URL('../sdk/typescript/src/contracts.ts',import.meta.url),'utf8');const js=(await transform(ts,{loader:'ts',format:'esm'})).code;const value=await import(`data:text/javascript,${encodeURIComponent(js)}`);assert.equal(value.CONTRACT_VERSION,contract.contract_version);assert.deepEqual([...value.EVENT_TYPES],contract.event_types);});
test('v6 contract includes all orchestration and evidence endpoints',()=>{for(const name of ['events','register','heartbeat','subscribe','metrics','jobs','context','plan','graph','resolved','monitoring','reports'])assert.ok(contract.api[name]);assert.ok(contract.investigation_states.includes('NEEDS_REVIEW'));assert.ok(contract.jobs.includes('PREPARE_REPORT'));});
