/* Optional Mail.tm assistance: no site-auth submission, redirects, unlimited bodies or automatic links. */
(function(root){
 'use strict';
 const BASE='https://api.mail.tm',MAX_BYTES=1000000,TIMEOUT=8000;
 class Mail {
  constructor(vault,transport=fetch){this.vault=vault;this.transport=transport;this.queue=Promise.resolve();}
  async request(path,options={}){if(!/^\/(domains|accounts|token|messages(?:\/[a-zA-Z0-9-]{1,120})?)(?:\?page=1)?$/.test(path))throw Error('Unsupported mailbox endpoint.');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
   try{const r=await this.transport(BASE+path,{...options,redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(options.headers??{})}});if(!r.ok)throw Error('Mailbox provider request failed ('+r.status+').');if(r.url&&new URL(r.url).origin!==BASE)throw Error('Mailbox origin changed.');if(Number(r.headers.get('content-length'))>MAX_BYTES)throw Error('Mailbox response exceeds bounds.');
    if(!r.body?.getReader)throw Error('Bounded streaming mailbox response required.');const reader=r.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('Mailbox response exceeds bounds.');}chunks.push(value);}}finally{reader.releaseLock();}
    const data=new Uint8Array(size);let at=0;for(const c of chunks){data.set(c,at);at+=c.byteLength;}return JSON.parse(new TextDecoder().decode(data));
   }finally{clearTimeout(timer);}
  }
  async create(id){const task=this.queue.catch(()=>{}).then(()=>this.createLocked(id));this.queue=task.catch(()=>{});return task;}
  async createLocked(id){let a=this.vault.account(id);if(a.intent!=='legitimate_new_account')throw Error('Temporary mail is available only for a legitimate new account.');if(a.mail?.token)return {ready:true,recovered:true};
   if(!a.mail){const domains=await this.request('/domains?page=1'),domain=(domains['hydra:member']??[]).find(d=>d.isActive&&!d.isPrivate&&/^[a-z0-9.-]+$/i.test(d.domain))?.domain;if(!domain)throw Error('No supported temporary email domain is available.');
    const address=root.LoggerAccounts.password(16).replace(/[^a-zA-Z0-9]/g,'x').toLowerCase()+'@'+domain;
    await this.vault.update(id,{mail:{address,password:root.LoggerAccounts.password(),status:'prepared',token:null,polls:0,nextPoll:0,windowAt:0,code:null,links:[],messages:[]}});a=this.vault.account(id);
   }
   const credentials={address:a.mail.address,password:a.mail.password};
   if(a.mail.status==='prepared'){
    // Persist uncertainty before the remote side effect. Recovery authenticates the same identity.
    await this.vault.update(id,{mail:{...a.mail,status:'creation uncertain'}});
    try{await this.request('/accounts',{method:'POST',body:JSON.stringify(credentials)});}catch{throw Error('Mailbox creation outcome is uncertain. Retry recovery for the same identity.');}
   }
   const result=await this.request('/token',{method:'POST',body:JSON.stringify(credentials)});if(typeof result.token!=='string'||result.token.length>8192)throw Error('Mailbox token is invalid.');
   a=this.vault.account(id);await this.vault.update(id,{mail:{...a.mail,token:result.token,status:'ready'}});await this.vault.edit(id,{username:a.mail.address});return {ready:true};
  }
  async poll(id){let a=this.vault.account(id),m=a.mail;if(!m?.token)throw Error('Prepare or recover the mailbox first.');const now=Date.now(),sameWindow=now-Number(m.windowAt)<600000;
   if(now<Number(m.nextPoll)||sameWindow&&Number(m.polls)>=6)throw Error('Mailbox polling allowance reached. Wait before checking again.');
   m={...m,polls:sameWindow?Number(m.polls)+1:1,windowAt:sameWindow?m.windowAt:now,nextPoll:now+10000};await this.vault.update(id,{mail:m});
   const list=await this.request('/messages?page=1',{headers:{authorization:'Bearer '+m.token}}),messages=[];let code=null;const links=[];
   for(const item of (list['hydra:member']??[]).slice(0,10)){
    if(!/^[a-zA-Z0-9-]{1,120}$/.test(String(item.id)))continue;const message=await this.request('/messages/'+item.id,{headers:{authorization:'Bearer '+m.token}});
    const text=(String(message.text??'')+' '+(Array.isArray(message.html)?message.html.join(' '):'')).slice(0,80000),match=text.match(/(?:verification|verify|security|confirmation|one.time)[\s\S]{0,80}?\b(\d{4,8})\b/i);if(match)code=match[1];
    for(const raw of text.match(/https:\/\/[^\s<>"']{1,2000}/g)??[]){try{const u=new URL(raw);if(!u.username&&!u.password&&/(verify|confirm|activate)/i.test(u.href)&&links.length<10)links.push(u.href);}catch{}}
    messages.push({id:String(item.id),subject:String(message.subject??'').slice(0,300),text:text.slice(0,20000)});
   }
   a=this.vault.account(id);await this.vault.update(id,{mail:{...a.mail,code,links:[...new Set(links)],messages}});return {code,links:[...new Set(links)],messages};
  }
 }
 const api={Mail,BASE,MAX_BYTES,TIMEOUT};root.LoggerMail=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
