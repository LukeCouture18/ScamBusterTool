/** Finite read-only response transport shared by live specialist adapters. */
export async function boundedJson(transport:typeof fetch,url:string,headers:Record<string,string>={}):Promise<unknown>{
 const response=await transport(url,{headers:{accept:'application/json',...headers},signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok)throw new Error(`Provider HTTP ${response.status}`);
 const reader=response.body?.getReader();if(!reader)throw new Error('Provider returned no body');
 const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024)throw new Error('Provider response limit exceeded');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const body=new Uint8Array(bytes);let at=0;for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(body));
}
