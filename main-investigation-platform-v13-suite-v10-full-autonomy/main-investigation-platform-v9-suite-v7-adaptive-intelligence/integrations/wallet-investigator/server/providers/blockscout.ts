/** Read-only, explicitly selected EVM chain. Keys stay in the specialist process. */
import type {BlockchainNetwork} from '../../src/types';
import {boundedJson} from './bounded-json';
import type {BlockchainProvider, ProviderFetchOptions, ProviderFetchResult, RawProviderTx} from './types';

const chains: Partial<Record<BlockchainNetwork, {id:number; asset:string}>> = {
  ethereum:{id:1,asset:'ETH'}, optimism:{id:10,asset:'ETH'}, base:{id:8453,asset:'ETH'},
  arbitrum:{id:42161,asset:'ETH'}, polygon:{id:137,asset:'POL'}, bsc:{id:56,asset:'BNB'},
};
type Row={coin_balance?:unknown;items?:unknown;next_page_params?:unknown};
type ProviderItem={from?:{hash?:unknown};to?:{hash?:unknown};token?:{type?:unknown;address_hash?:unknown;decimals?:unknown;symbol?:unknown};total?:{value?:unknown};hash?:unknown;transaction_hash?:unknown;timestamp?:unknown;value?:unknown;status?:unknown;block_number?:unknown;log_index?:unknown};
const integer = (v:unknown):string|undefined => typeof v === 'string' && /^\d+$/.test(v) ? v : undefined;
const hash = (v:unknown):string => typeof v==='string' && /^0x[0-9a-f]{40}$/i.test(v) ? v : '';
const txHash = (v:unknown):string => typeof v==='string' && /^0x[0-9a-f]{64}$/i.test(v) ? v : '';
const timestamp = (v:unknown):number => typeof v==='string' ? Date.parse(v) : NaN;

export function blockscoutProvider(key:string, transport:typeof fetch=fetch, onRequest?: (address:string,network:string)=>void):BlockchainProvider {
  return {
    name:'BlockscoutPro', supported_networks:Object.keys(chains) as BlockchainNetwork[], priority:60,
    is_healthy:async()=>Boolean(key),
    async fetch_wallet_activity(address,network,options:ProviderFetchOptions={}):Promise<ProviderFetchResult> {
      const chain=chains[network];
      if(!chain || !hash(address)) throw new Error('Blockscout requires a validated address and an explicit supported network');
      const maxPages=Math.max(1,Math.min(2,Math.floor(options.max_pages || 1)));
      const base=`https://api.blockscout.com/${chain.id}/api/v2/addresses/${address}`;
      let requests=0,pages=0,limitHit=false,skipped=0;
      const errors:string[]=[], transactions:RawProviderTx[]=[],seen=new Set<string>();
      async function get(url:string):Promise<Row> {
        requests++;onRequest?.(address,network);
        const data=await boundedJson(transport,url,{authorization:key});if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('Blockscout malformed response');return data as Row;
      }
      let balance: string|undefined;
      try{balance=integer((await get(base)).coin_balance);}catch(e){errors.push(e instanceof Error?e.message:'Balance unavailable');}
      async function collect(kind:'transactions'|'token-transfers') {
        let cursor:Record<string,string|number>|null=null;
        const cursors=new Set<string>();
        for(let page=0;page<maxPages;page++){
          const url=new URL(base+'/'+kind);
          for(const [k,v] of Object.entries(cursor??{}))url.searchParams.set(k,String(v));
          let data:Row;try{data=await get(url.href);}catch(e){errors.push(e instanceof Error?e.message:'History unavailable');return false;}
          if(!Array.isArray(data.items)){errors.push('Blockscout malformed history');return false;}pages++;
          if(data.items.length>50)limitHit=true;
          for(const rawItem of data.items.slice(0,50)){
            const item=rawItem as ProviderItem;
            if(!item || typeof item!=='object'){skipped++;continue;}
            const token=kind==='token-transfers';
            if(token && item.token?.type!=='ERC-20'){skipped++;continue;}
            const amount=integer(token?item.total?.value:item.value),tx=txHash(token?item.transaction_hash:item.hash);
            const from=hash(item.from?.hash),to=hash(item.to?.hash),at=timestamp(item.timestamp),contract=token?hash(item.token?.address_hash):undefined;
            const decimals=token?Number(item.token?.decimals):18;
            if(!amount || !tx || !from || !to || !Number.isFinite(at) || (token&&(!contract||!Number.isInteger(decimals)||decimals<0||decimals>255)) || (from.toLowerCase()!==address.toLowerCase() && to.toLowerCase()!==address.toLowerCase())){skipped++;continue;}
            if(options.from_timestamp!==undefined&&at<options.from_timestamp)continue;
            if(options.to_timestamp!==undefined&&at>options.to_timestamp)continue;
            const identity=[tx,contract??'native',item.log_index??'',from,to,amount].join(':');if(seen.has(identity))continue;seen.add(identity);
            transactions.push({tx_hash:tx,block_number:typeof item.block_number==='number'&&Number.isSafeInteger(item.block_number)?item.block_number:undefined,timestamp:at,from_address:from,to_address:to,asset:token?String(item.token?.symbol??contract).slice(0,80):chain!.asset,is_token:token,token_contract:contract,token_decimals:token?decimals:undefined,raw_amount:amount,status:token?'confirmed':item.status==='ok'?'confirmed':item.status==='error'?'failed':'pending',raw_metadata:{provider:'BlockscoutPro',chain_id:chain!.id,log_index:item.log_index??null}});
          }
          if(!data.next_page_params)return true;
          if(typeof data.next_page_params!=='object'||Array.isArray(data.next_page_params)||Object.keys(data.next_page_params).length>12){errors.push('Blockscout malformed cursor');return false;}
          cursor={};for(const [k,v] of Object.entries(data.next_page_params)){if(!/^[a-z_]{1,40}$/.test(k)||!['string','number'].includes(typeof v)||String(v).length>160||['apikey','authorization'].includes(k)){errors.push('Blockscout unsafe cursor');return false;}cursor[k]=v as string|number;}
          const cursorKey=JSON.stringify(cursor);if(cursors.has(cursorKey)){limitHit=true;return false;}cursors.add(cursorKey);
        }
        limitHit=true;return false;
      }
      const nativeComplete=await collect('transactions');
      const tokenComplete=options.include_tokens===false?false:await collect('token-transfers');
      if(!pages)throw new Error(errors.join('; ')||'Blockscout history unavailable');
      transactions.sort((a,b)=>a.timestamp-b.timestamp);
      // Internal transfers and NFT coverage are deliberately not fetched. Never claim global history completeness.
      return {provider_name:'BlockscoutPro',network,address,transactions,balance_raw:balance??'0',balance_asset:balance===undefined?'UNKNOWN':chain.asset,completeness:'PARTIAL',completeness_details:{status:'PARTIAL',pages_retrieved:pages,records_retrieved:transactions.length,provider_limit_hit:limitHit,pagination_completed:nativeComplete&&tokenComplete,missing_native_history:true,missing_token_history:true,earliest_retrieved_activity:transactions[0]?.timestamp,latest_retrieved_activity:transactions.at(-1)?.timestamp,warning_message:`Bounded public native/ERC-20 history; internal transfers and NFTs are not covered. ${balance===undefined?'Balance unavailable. ':''}${skipped?`${skipped} unsupported or malformed records omitted. `:''}${errors.join('; ')}`},request_meter:{http_requests:requests}};
    },
  };
}
