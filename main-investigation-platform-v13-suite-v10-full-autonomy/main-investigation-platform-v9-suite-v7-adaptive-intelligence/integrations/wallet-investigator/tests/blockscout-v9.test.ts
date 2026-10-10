import assert from 'node:assert/strict';
import {test} from 'node:test';
import {blockscoutProvider} from '../server/providers/blockscout';
const address='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40);
const tx={hash:'0x'+'3'.repeat(64),transaction_hash:'0x'+'4'.repeat(64),from:{hash:other},to:{hash:address},timestamp:'2026-10-01T12:00:00Z',status:'ok',value:'100',block_number:100,total:{value:'200'},token:{type:'ERC-20',address_hash:'0x'+'5'.repeat(40),decimals:'6',symbol:'USDC'},log_index:2};
test('bounded explicit-chain native and ERC-20 records, cursor, no global completeness or key leakage',async()=>{
 const urls:string[]=[],headers:string[]= [];
 const provider=blockscoutProvider('fixture-secret',async(url,init)=>{urls.push(String(url));headers.push(String((init?.headers as Record<string,string>).authorization));return new Response(JSON.stringify(String(url).endsWith(address)?{coin_balance:'500'}:{items:[tx],next_page_params:{block_number:99,index:1,items_count:50}}));});
 const result=await provider.fetch_wallet_activity(address,'base',{max_pages:100,include_tokens:true});
 assert.equal(urls.length,5);assert.ok(urls.every(u=>u.startsWith('https://api.blockscout.com/8453/')));assert.ok(urls.some(u=>u.includes('block_number=99')));assert.ok(headers.every(h=>h==='fixture-secret'));assert.equal(result.transactions.length,2);assert.equal(result.completeness,'PARTIAL');assert.equal(result.request_meter?.http_requests,5);assert.equal(result.completeness_details.provider_limit_hit,true);assert.equal(result.transactions[1].token_decimals,6);assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
 await assert.rejects(provider.fetch_wallet_activity(address,'evm_uncertain'),/explicit supported network/);
});
test('unavailable endpoint is failure, partial endpoint failure preserves observed records',async()=>{
 const bad=blockscoutProvider('fixture',async()=>new Response('rate limited',{status:429}));await assert.rejects(bad.fetch_wallet_activity(address,'ethereum'),/429/);
 const partial=blockscoutProvider('fixture',async(url)=>String(url).includes('token-transfers')?new Response('no',{status:503}):new Response(JSON.stringify(String(url).endsWith(address)?{coin_balance:'0'}:{items:[tx],next_page_params:null})));
 const result=await partial.fetch_wallet_activity(address,'ethereum');assert.equal(result.transactions.length,1);assert.equal(result.completeness,'PARTIAL');assert.match(result.completeness_details.warning_message??'',/503/);
});
test('copied pages deduplicate; malformed, unrelated and NFT rows cannot become deposits',async()=>{
 const p=blockscoutProvider('fixture',async(url)=>new Response(JSON.stringify(String(url).endsWith(address)?{}:{items:[tx,{...tx,token:{...tx.token,type:'ERC-721'}},{...tx,from:{hash:other},to:{hash:other}}, {bad:true}],next_page_params:{apikey:'injected'}})));
 const result=await p.fetch_wallet_activity(address,'ethereum');assert.equal(result.completeness,'PARTIAL');assert.ok(result.transactions.length<=3);assert.equal(result.balance_asset,'UNKNOWN');assert.match(result.completeness_details.warning_message??'',/unsafe cursor/);
});
