/* Sanitization precedes every capture write. Reflected credentials and unconstrained excerpts are excluded. */
(function(root){
 'use strict';
 const sensitive=/password|passwd|secret|credential|authorization|cookie|session|private.?key|seed.?phrase|username|e.?mail|verification.?code|otp|mailbox|(?:access|auth|refresh|bearer|id)[_.-]?token|token[_.-]?(?:access|auth|refresh|bearer)/i;
 const excerpts=/^(snippet|context|contextText|text|body|html|raw|qrPayload|responseUrl|pageTitle|title|section|notes|label|phrase)$/i;
 function decoded(text){let s=String(text);for(let i=0;i<3;i++){try{const next=decodeURIComponent(s);if(next===s)break;s=next;}catch{break;}}return s;}
 function scrub(text,values){let out=String(text);for(const value of values){if(!value)continue;const variants=[value,encodeURIComponent(value),encodeURIComponent(encodeURIComponent(value))];for(const v of variants)out=out.split(v).join('[PRIVATE]');if(decoded(out).includes(value))return '[PRIVATE]';}return out;}
 function url(text,values){try{const u=new URL(String(text));if(!['http:','https:'].includes(u.protocol))return '';u.username='';u.password='';u.search='';u.hash='';const clean=scrub(u.href,values);return clean.includes('[PRIVATE]')?'':clean;}catch{return '';}}
 function sanitize(value,values=[],key='',depth=0){if(depth>16)return null;if(sensitive.test(key)||(excerpts.test(key)&&!(key==='context'&&value&&typeof value==='object')))return null;
  if(key==='token'&&typeof value==='string'&&!/^(BTC|ETH|USDT|USDC|TRX|SOL|XRP|LTC|DOGE|BNB|MATIC|AVAX|DAI)$/i.test(value))return null;
  if(typeof value==='string'){if(/url|uri$/i.test(key))return url(value,values);return scrub(value.slice(0,4096),values);}
  if(Array.isArray(value))return value.slice(0,200).map(v=>sanitize(v,values,key,depth+1)).filter(v=>v!==null);
  if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value).slice(0,100)){if(sensitive.test(k)||(excerpts.test(k)&&!(k==='context'&&v&&typeof v==='object')))continue;const clean=sanitize(v,values,k,depth+1);if(clean!==null)out[k]=clean;}return out;}
  return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'?value:null;
 }
 async function capture(vault,message,sender){const values=await vault.privateValues(),clean=sanitize(message,values),safeSender={...sender,tab:sender.tab?{...sender.tab,url:url(sender.tab.url,values),title:''}:undefined};return {message:clean,sender:safeSender};}
 const api={sanitize,url,scrub,capture};root.LoggerPrivacy=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
