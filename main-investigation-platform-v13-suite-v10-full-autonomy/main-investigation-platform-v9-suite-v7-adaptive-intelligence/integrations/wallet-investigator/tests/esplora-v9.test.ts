import assert from 'node:assert/strict';import {test} from 'node:test';import {esploraProvider} from '../server/providers/esplora';
const address='1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',other='1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const tx={txid:'a'.repeat(64),vin:[{prevout:{scriptpubkey_address:other,value:1100}}],vout:[{scriptpubkey_address:address,value:1000}],status:{confirmed:true,block_time:1700000000,block_height:10},fee:100};
const overview={address,chain_stats:{funded_txo_sum:1000,spent_txo_sum:0,tx_count:1},mempool_stats:{tx_count:0}};
test('confirmed Bitcoin facts preserve UTXOs and scope, fixed GET-only endpoint',async()=>{
 const urls:string[]=[];const provider=esploraProvider(async(u,init)=>{urls.push(String(u));assert.equal(init?.method,undefined);return new Response(JSON.stringify(String(u).endsWith(address)?overview:[tx]));});
 const r=await provider.fetch_wallet_activity(address,'bitcoin',{max_pages:100});assert.equal(urls.length,2);assert.equal(r.balance_raw,'1000');assert.equal(r.transactions[0].utxo_outputs?.[0].is_target_wallet,true);assert.equal(r.transactions[0].raw_amount,'1000');assert.equal(r.completeness,'PARTIAL');assert.equal(r.request_meter?.http_requests,2);await assert.rejects(provider.fetch_wallet_activity(address,'litecoin'),/explicitly validated Bitcoin/);
});
test('finite pages and copies deduplicate, malformed sums and HTTP failure cannot become history',async()=>{
 const urls:string[]=[];const p=esploraProvider(async u=>{urls.push(String(u));return new Response(JSON.stringify(String(u).endsWith(address)?overview:Array.from({length:25},()=>tx)));});const r=await p.fetch_wallet_activity(address,'bitcoin',{max_pages:99});assert.equal(urls.length,3);assert.equal(r.transactions.length,1);assert.equal(r.completeness_details.provider_limit_hit,true);
 await assert.rejects(esploraProvider(async()=>new Response('No',{status:429})).fetch_wallet_activity(address,'bitcoin'),/429/);
 await assert.rejects(esploraProvider(async()=>new Response(JSON.stringify({...overview,chain_stats:{funded_txo_sum:Number.MAX_SAFE_INTEGER+1,spent_txo_sum:0}}))).fetch_wallet_activity(address,'bitcoin'),/Malformed/);
});
