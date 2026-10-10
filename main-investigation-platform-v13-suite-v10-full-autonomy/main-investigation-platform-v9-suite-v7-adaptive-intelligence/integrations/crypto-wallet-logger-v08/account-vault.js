/* Private operator convenience state. Entire account payload is encrypted and excluded from evidence. */
(function(root){
  'use strict';
  const KEY='privateAccountVaultV10',LEGACY_KEY='accountVaultV1',ITERATIONS=310000,TTL=15*60*1000;
  const enc=new TextEncoder(),dec=new TextDecoder(),random=n=>crypto.getRandomValues(new Uint8Array(n));
  const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  function password(length=28){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_';let s='';while(s.length<length)for(const v of random(64))if(v<256-256%alphabet.length&&s.length<length)s+=alphabet[v%alphabet.length];return s;}
  function site(input){const u=new URL(String(input));if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.'))throw Error('Use an HTTPS account URL without credentials.');u.search='';u.hash='';return {domain:u.hostname.toLowerCase(),origin:u.origin,url:u.href};}
  async function keyFor(master,salt){const material=await crypto.subtle.importKey('raw',enc.encode(master),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes(salt),iterations:ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
  async function seal(key,data){const iv=random(12);return {iv:b64(iv),ciphertext:b64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(KEY)},key,enc.encode(JSON.stringify(data))))};}
  async function open(key,data,aad=KEY){return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(data.iv),additionalData:enc.encode(aad)},key,bytes(data.ciphertext))));}
  class Vault {
    constructor(storage){this.storage=storage;this.queue=Promise.resolve();this.lock();}
    lock(){this.generation=(this.generation??0)+1;this.key=null;this.payload=null;this.until=0;}
    ready(touch=true){if(!this.key){this.payload=null;this.until=0;throw Error('Unlock the private account workspace first.');}if(Date.now()>=this.until){this.lock();throw Error('Unlock the private account workspace first.');}if(touch)this.until=Date.now()+TTL;}
    async exists(){return Boolean((await this.storage.get(KEY))[KEY]||(await this.storage.get(LEGACY_KEY))[LEGACY_KEY]);}
    async unlock(master){this.lock();const generation=this.generation;const task=this.queue.catch(()=>{}).then(()=>this.unlockGeneration(master,generation));this.queue=task.catch(()=>{});return task;}
    async unlockGeneration(master,generation){const current=()=>{if(this.generation!==generation)throw Error('Unlock was cancelled because the workspace locked.');};current();if(typeof master!=='string'||master.length<12||master.length>1024)throw Error('Master password must contain 12–1024 characters.');let record=(await this.storage.get(KEY))[KEY];const legacy=(await this.storage.get(LEGACY_KEY))[LEGACY_KEY],salt=record?.salt??legacy?.salt??b64(random(16)),key=await keyFor(master,salt);let payload;current();
      if(record){if(record.version!==10||record.iterations!==ITERATIONS)throw Error('Unsupported vault format.');try{payload=await open(key,record.blob);if(payload.marker!==KEY)throw Error();}catch{throw Error('Unable to unlock this vault.');}}
      else {payload={marker:KEY,accounts:[],requests:{}};
        if(legacy){try{
          if(legacy.version!==1||!Array.isArray(legacy.accounts)||legacy.accounts.length>1000)throw Error();
          const check=await open(key,legacy.check,'vault-check-v1');if(check.check!=='Wallet Logger vault')throw Error();
          payload.legacySnapshot=legacy;payload.legacyProviderSecrets=[];
          if(legacy.providers){const providers=await open(key,legacy.providers,'provider-keys-v1');payload.legacyProviderSecrets=Object.values(providers).filter(v=>typeof v==='string');}
          for(const a of legacy.accounts){const target=site(a.loginUrl),secret=await open(key,a.secret,a.id+'|'+a.origin);if(target.origin!==a.origin||typeof secret.password!=='string'||secret.password.length>1024)throw Error();
            const requestId='legacy-'+a.id;payload.accounts.push({id:a.id,intent:'owned_account_import',...target,loginUrl:target.url,signupUrl:target.url,alias:String(a.alias??'Saved account'),username:String(secret.username??''),password:secret.password,notes:String(a.notes??''),createdAt:a.createdAt??new Date().toISOString(),lastSuccessfulLogin:a.lastSuccessfulLogin??null,status:'imported',requestId,mail:null});payload.requests[requestId]={id:a.id,domain:target.domain,intent:'owned_account_import'};
          }
        }catch{throw Error('Unable to unlock or migrate the existing vault.');}}
        record={version:10,iterations:ITERATIONS,salt,blob:await seal(key,payload)};current();await this.storage.set({[KEY]:record});current();
      }
      // Commit the complete encrypted source first. An interruption here retains the old vault;
      // the next successful unlock finishes removal of its plaintext metadata.
      current();if(legacy&&payload.legacySnapshot)await this.storage.set({[LEGACY_KEY]:{version:10,migratedTo:KEY}});current();
      this.key=key;this.salt=salt;this.payload=payload;this.until=Date.now()+TTL;return this.list();
    }
    async list(){const initialized=await this.exists(),unlocked=Boolean(this.key&&Date.now()<this.until);if(this.key&&!unlocked)this.lock();return {initialized,unlocked,accounts:unlocked?this.payload.accounts.map(a=>({id:a.id,domain:a.domain,alias:a.alias,loginUrl:a.loginUrl,signupUrl:a.signupUrl,status:a.status,createdAt:a.createdAt,lastSuccessfulLogin:a.lastSuccessfulLogin,mailStatus:a.mail?.status??null})):[]};}
    async mutate(fn){const generation=this.generation,key=this.key,salt=this.salt,current=()=>{if(!key||this.generation!==generation||this.key!==key)throw Error('Unlock the private account workspace first.');};const task=this.queue.catch(()=>{}).then(async()=>{current();this.ready();const next=structuredClone(this.payload),result=await fn(next);current();this.ready();const blob=await seal(key,next);current();this.ready();await this.storage.set({[KEY]:{version:10,iterations:ITERATIONS,salt,blob}});current();this.ready(false);this.payload=next;return result;});this.queue=task.catch(()=>{});return task;}
    async prepare(input){const target=site(input.loginUrl??input.signupUrl),requestId=String(input.requestId??'');if(!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw Error('A persistent request identity is required.');
      if(input.intent!=='legitimate_new_account'&&input.intent!=='owned_account_import')throw Error('Explicit legitimate-new or owned-account intent is required.');
      if(input.intent==='owned_account_import'&&(!input.username||!input.password))throw Error('Owned-account username and password are required.');
      if(input.intent==='owned_account_import'&&(typeof input.username!=='string'||typeof input.password!=='string'||input.username.length>320||input.password.length>1024))throw Error('Owned-account credentials exceed the supported length.');
      return this.mutate(data=>{const old=data.requests[requestId];if(old){if(old.domain!==target.domain||old.intent!==input.intent)throw Error('Request identity belongs to another site or purpose.');return {id:old.id,recovered:true};}
        if(data.accounts.length>=1000||Object.keys(data.requests).length>=2000)throw Error('Private account workspace limit reached.');
        const id=crypto.randomUUID(),alias='investigator-'+password(12).replace(/[^a-zA-Z0-9]/g,'x');
        const a={id,intent:input.intent,...target,loginUrl:target.url,signupUrl:input.signupUrl?site(input.signupUrl).url:target.url,alias,username:input.intent==='owned_account_import'?input.username:alias,password:input.intent==='owned_account_import'?input.password:password(),notes:String(input.notes??'').slice(0,5000),createdAt:new Date().toISOString(),lastSuccessfulLogin:null,status:'prepared',requestId,mail:null};
        if(site(a.signupUrl).domain!==target.domain)throw Error('Signup and login must use the exact same hostname.');
        data.accounts.push(a);data.requests[requestId]={id,domain:target.domain,intent:input.intent};return {id,recovered:false};});
    }
    account(id){this.ready();const a=this.payload.accounts.find(a=>a.id===id);if(!a)throw Error('Select an account.');return structuredClone(a);}
    credentials(id,target){const a=this.account(id),t=site(target);if(t.domain!==a.domain||t.origin!==a.origin)throw Error('Account must match the exact HTTPS hostname and origin.');return {domain:a.domain,origin:a.origin,username:a.username,password:a.password,code:a.mail?.code??null};}
    async update(id,values){return this.mutate(data=>{const a=data.accounts.find(a=>a.id===id);if(!a)throw Error('Account not found.');for(const k of ['mail','status','lastSuccessfulLogin'])if(Object.hasOwn(values,k))a[k]=structuredClone(values[k]);return {updated:true};});}
    async edit(id,input){return this.mutate(data=>{const a=data.accounts.find(a=>a.id===id);if(!a)throw Error('Account not found.');for(const [k,max] of [['username',320],['notes',5000]])if(Object.hasOwn(input,k))a[k]=String(input[k]).slice(0,max);return {updated:true};});}
    async privateValues(){const existing=await this.exists();if(existing)this.ready(false);if(!existing)return [];const values=[...(this.payload.legacyProviderSecrets??[])];for(const a of this.payload.accounts){values.push(a.username,a.password,a.alias,a.notes);if(a.mail)values.push(a.mail.address,a.mail.password,a.mail.token,a.mail.code,...(a.mail.links??[]));}return values.filter(s=>typeof s==='string'&&s.length>0);}
  }
  const api={Vault,KEY,LEGACY_KEY,ITERATIONS,TTL,password,site};root.LoggerAccounts=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
