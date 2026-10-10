/** Public Bitcoin confirmed history, at most an overview and two 25-record pages. */
import type {BlockchainProvider,RawProviderTx} from './types';
import {boundedJson} from './bounded-json';
type Row=Record<string,unknown>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const amount=(v:unknown):string|undefined=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):undefined;
const hash=(v:unknown):string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)?v:'';
const addressOf=(v:unknown):string=>typeof v==='string'&&/^[a-zA-Z0-9]{14,100}$/.test(v)?v:'';
export function esploraProvider(transport:typeof fetch=fetch,onRequest?:(address:string,network:string)=>void):BlockchainProvider{
 return {name:'BlockstreamEsplora',supported_networks:['bitcoin'],priority:50,is_healthy:async()=>true,
  async fetch_wallet_activity(address,network,options={}){
   if(network!=='bitcoin'||!addressOf(address))throw new Error('Esplora requires an explicitly validated Bitcoin address');
   const base='https://blockstream.info/api/address/'+address;let requests=0,pages=0,limitHit=false,skipped=0,cursor='';const warnings:string[]=[],transactions:RawProviderTx[]=[],seen=new Set<string>();
   const get=async(url:string)=>{requests++;onRequest?.(address,network);return boundedJson(transport,url);};
   const overview=row(await get(base)),chain=row(overview.chain_stats),pool=row(overview.mempool_stats),funded=amount(chain.funded_txo_sum),spent=amount(chain.spent_txo_sum);
   if(overview.address!==address||funded===undefined||spent===undefined||BigInt(spent)>BigInt(funded))throw new Error('Malformed Esplora address statistics');
   const maxPages=Math.max(1,Math.min(2,Math.floor(options.max_pages||1)));
   for(let page=0;page<maxPages;page++){
    let data:unknown;try{data=await get(base+'/txs/chain'+(cursor?'/'+cursor:''));}catch(e){if(!pages)throw e;warnings.push(e instanceof Error?e.message:'History unavailable');break;}
    if(!Array.isArray(data))throw new Error('Malformed Esplora history');pages++;if(data.length>25)limitHit=true;
    for(const raw of data.slice(0,25)){
     const t=row(raw),tx=hash(t.txid),status=row(t.status),at=typeof status.block_time==='number'?status.block_time*1000:NaN;
     if(!tx||seen.has(tx))continue;seen.add(tx);
     if(!Array.isArray(t.vin)||!Array.isArray(t.vout)||t.vin.length>100||t.vout.length>100||status.confirmed!==true||!Number.isFinite(at)){skipped++;continue;}
     const inputs=t.vin.map((v,index)=>{const input=row(v),prev=row(input.prevout);return {index,address:addressOf(prev.scriptpubkey_address),raw_amount:amount(prev.value),is_target_wallet:prev.scriptpubkey_address===address};});
     const outputs=t.vout.map((v,index)=>{const o=row(v);return {index,address:addressOf(o.scriptpubkey_address),raw_amount:amount(o.value),is_target_wallet:o.scriptpubkey_address===address};});
     if(inputs.some(i=>i.raw_amount===undefined&&i.address)||outputs.some(o=>o.raw_amount===undefined)||!inputs.some(i=>i.is_target_wallet)&&!outputs.some(o=>o.is_target_wallet)){skipped++;continue;}
     if(options.from_timestamp!==undefined&&at<options.from_timestamp||options.to_timestamp!==undefined&&at>options.to_timestamp)continue;
     const spentFrom=inputs.filter(i=>i.is_target_wallet).reduce((s,i)=>s+BigInt(i.raw_amount??'0'),0n),received=outputs.filter(o=>o.is_target_wallet).reduce((s,o)=>s+BigInt(o.raw_amount!),0n);
     transactions.push({tx_hash:tx,timestamp:at,block_number:typeof status.block_height==='number'?status.block_height:undefined,from_address:inputs.find(i=>i.address)?.address??'',to_address:outputs.find(o=>o.address)?.address??'',asset:'BTC',is_token:false,raw_amount:String(spentFrom||received),fee_raw:amount(t.fee),status:'confirmed',utxo_inputs:inputs.filter(i=>i.raw_amount!==undefined).map(i=>({...i,raw_amount:i.raw_amount!})),utxo_outputs:outputs.map(o=>({...o,raw_amount:o.raw_amount!})),raw_metadata:{provider:'BlockstreamEsplora',native_confirmed_only:true}});
    }
    if(data.length<25)break;
    const next=hash(row(data.at(-1)).txid);if(!next||next===cursor){limitHit=true;break;}cursor=next;if(page===maxPages-1)limitHit=true;
   }
   transactions.sort((a,b)=>a.timestamp-b.timestamp);
   return {provider_name:'BlockstreamEsplora',network,address,transactions,balance_raw:String(BigInt(funded)-BigInt(spent)),balance_asset:'BTC',completeness:'PARTIAL',completeness_details:{status:'PARTIAL',pages_retrieved:pages,records_retrieved:transactions.length,provider_limit_hit:limitHit,pagination_completed:!limitHit&&!warnings.length,missing_native_history:limitHit||skipped>0||Number(pool.tx_count??0)>0,missing_token_history:true,earliest_retrieved_activity:transactions[0]?.timestamp,latest_retrieved_activity:transactions.at(-1)?.timestamp,warning_message:`Bounded confirmed Bitcoin native history and confirmed balance. Unconfirmed activity and token/inscription protocols are outside scope. ${skipped?`${skipped} malformed, unrelated or oversized transactions omitted. `:''}${warnings.join('; ')}`},request_meter:{http_requests:requests}};
  }};
}
