'use strict';
import test from 'node:test';import assert from 'node:assert/strict';
import accounts from '../account-vault.js';import mailbox from '../account-mail.js';import privacy from '../account-privacy.js';
const {Vault,KEY}=accounts,{Mail}=mailbox;
function store(){const data={};return {data,async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));}};}
const master='fixture master password 2026';
test('lock during delayed encrypted commit cannot restore plaintext; next unlock waits and recovers committed identity',async()=>{
 const storage=store(),v=new Vault(storage);await v.unlock(master);const original=storage.set;
 let release,entered;const pending=new Promise(r=>entered=r);storage.set=async values=>{entered();await new Promise(r=>release=r);return original(values);};
 const input={requestId:'delayed-lock-0001',intent:'legitimate_new_account',loginUrl:'https://site.example'};
 const prepare=v.prepare(input);await pending;v.lock();release();await assert.rejects(prepare,/Unlock/);assert.equal(v.key,null);assert.equal(v.payload,null);
 storage.set=original;await v.unlock(master);const recovered=await v.prepare(input);assert.equal(recovered.recovered,true);assert.equal(v.payload.accounts.length,1);
 let signal;const enteredEdit=new Promise(r=>signal=r);storage.set=async values=>{signal();await new Promise(r=>release=r);return original(values);};
 const edit=v.edit(recovered.id,{notes:'private delayed notes'});await enteredEdit;const unlock=v.unlock(master);assert.equal((await v.list()).unlocked,false);release();await assert.rejects(edit,/Unlock/);await unlock;
 assert.equal(v.account(recovered.id).notes,'private delayed notes');assert.ok(!JSON.stringify(storage.data).includes('private delayed notes'));
});
test('existing standalone vault fails closed and migrates all metadata before removing plaintext source',async()=>{
 const storage=store(),salt=crypto.getRandomValues(new Uint8Array(16)),enc=new TextEncoder(),base=await crypto.subtle.importKey('raw',enc.encode(master),'PBKDF2',false,['deriveKey']);
 const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt']);
 const seal=async(value,aad)=>{const iv=crypto.getRandomValues(new Uint8Array(12));return {iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},key,enc.encode(JSON.stringify(value)))).toString('base64')};};
 storage.data[accounts.LEGACY_KEY]={version:1,salt:Buffer.from(salt).toString('base64'),check:await seal({check:'Wallet Logger vault'},'vault-check-v1'),providers:await seal({blockscout:'private-provider-key'},'provider-keys-v1'),accounts:[{id:'legacy-id',origin:'https://legacy.example',domain:'legacy.example',loginUrl:'https://legacy.example/login',alias:'private alias',notes:'private legacy notes',secret:await seal({username:'legacy-user',password:'legacy-password'},'legacy-id|https://legacy.example')}]};
 const v=new Vault(storage);await assert.rejects(v.privateValues(),/Unlock/);await assert.rejects(v.unlock('wrong long enough master'),/migrate/);assert.ok(storage.data[accounts.LEGACY_KEY].accounts);
 let fail=true;const set=storage.set;storage.set=async values=>{if(values[accounts.LEGACY_KEY]&&fail){fail=false;throw Error('storage interrupted after encrypted commit');}return set(values);};
 await assert.rejects(v.unlock(master),/interrupted/);assert.ok(storage.data[KEY]);assert.ok(storage.data[accounts.LEGACY_KEY].accounts);
 const restarted=new Vault(storage);await restarted.unlock(master);assert.equal(restarted.account('legacy-id').password,'legacy-password');assert.deepEqual(storage.data[accounts.LEGACY_KEY],{version:10,migratedTo:KEY});
 for(const secret of ['legacy-password','legacy-user','private legacy notes','private-provider-key'])assert.ok(!JSON.stringify(storage.data).includes(secret));assert.ok((await restarted.privateValues()).includes('private-provider-key'));
});
test('vault encrypts complete private payload, binds request identity, persists and locks on restart',async()=>{
 const storage=store(),v=new Vault(storage);await assert.rejects(v.unlock('short'));await v.unlock(master);
 const input={requestId:'private-request-0001',intent:'legitimate_new_account',loginUrl:'https://site.example/login?token=secret#private',notes:'private notes value'};
 const rs=await Promise.all(Array.from({length:10},()=>v.prepare(input)));assert.equal(new Set(rs.map(r=>r.id)).size,1);const a=v.account(rs[0].id);
 assert.ok(a.password.length>=28);assert.equal(a.loginUrl,'https://site.example/login');assert.equal(v.key.extractable,false);
 const another=await v.prepare({...input,requestId:'private-request-0002',loginUrl:'https://other.example'});assert.notEqual(v.account(another.id).password,a.password);
 const serialized=JSON.stringify(storage.data);for(const value of [a.password,a.alias,a.domain,a.notes])assert.ok(!serialized.includes(value));
 await assert.rejects(v.prepare({...input,loginUrl:'https://different.example'}),/another site/);assert.throws(()=>v.credentials(a.id,'https://site.example.evil.test'),/exact/);assert.throws(()=>v.credentials(a.id,'https://sub.site.example'),/exact/);
 const restarted=new Vault(storage);assert.equal((await restarted.list()).unlocked,false);await assert.rejects(restarted.privateValues(),/Unlock/);await assert.rejects(restarted.unlock('wrong but sufficiently long password'));
 await restarted.unlock(master);assert.equal(restarted.account(a.id).password,a.password);restarted.until=Date.now()-1;assert.throws(()=>restarted.account(a.id),/Unlock/);assert.equal(restarted.payload,null);
 assert.equal(Buffer.from(storage.data[KEY].salt,'base64').length,16);assert.equal(Buffer.from(storage.data[KEY].blob.iv,'base64').length,12);assert.equal(storage.data[KEY].iterations,310000);
});
test('explicit owned import, encrypted edit, locked capture and recursive secret hygiene',async()=>{
 const storage=store(),v=new Vault(storage);assert.deepEqual(await v.privateValues(),[]);await v.unlock(master);
 const username='private-operator@example.com',password='private PASSWORD ! encoding';await assert.rejects(v.prepare({requestId:'owned-req-001',loginUrl:'https://site.example',username,password}),/intent/);
 const result=await v.prepare({requestId:'owned-req-001',intent:'owned_account_import',loginUrl:'https://site.example',username,password});
 await assert.rejects(v.prepare({requestId:'owned-too-long',intent:'owned_account_import',loginUrl:'https://site.example',username,password:'p'.repeat(1025)}),/length/);
 assert.deepEqual(privacy.sanitize({authToken:'unregistered-token',refresh_token:'another-token',idToken:'id-secret',tokenAuth:'hidden',token:'USDT'},[]),{token:'USDT'});
 const clean=privacy.sanitize({address:'0x'+'a'.repeat(40),context:{class:'deposit',confidence:.9,snippet:password},page:{url:'https://user:pass@site.example/deposit?secret='+encodeURIComponent(password)+'#otp',title:username},nested:{password,username,mailboxToken:'mailsecret',authorization:'Bearer mailsecret',unlabelled:encodeURIComponent(encodeURIComponent(password))}},await v.privateValues());
 const text=JSON.stringify(clean);for(const value of [username,password,encodeURIComponent(password),'mailsecret'])assert.ok(!text.includes(value));assert.equal(clean.address,'0x'+'a'.repeat(40));assert.equal(clean.context.class,'deposit');assert.equal(clean.page.url,'https://site.example/deposit');assert.equal(clean.page.title,undefined);
 v.lock();await assert.rejects(privacy.capture(v,{},{tab:{url:'https://site.example'}}),/Unlock/);assert.equal(JSON.stringify(storage.data).includes(password),false);
 await v.unlock(master);await v.edit(result.id,{username:'changed@example.com',notes:'private edited note'});assert.equal(v.account(result.id).username,'changed@example.com');assert.ok(!JSON.stringify(storage.data).includes('private edited note'));
});
test('bounded mailbox identity precedes remote creation; lost commit recovers same identity without another POST',async()=>{
 const storage=store(),v=new Vault(storage);await v.unlock(master);const {id}=await v.prepare({requestId:'mail-request-0001',intent:'legitimate_new_account',loginUrl:'https://site.example'});
 let creates=0,tokenCalls=0,hasRemote=false,delayed=true;
 const fetchFixture=async(url,options)=>{assert.equal(options.redirect,'error');assert.equal(new URL(url).origin,'https://api.mail.tm');const path=new URL(url).pathname;
  if(path==='/domains')return Response.json({'hydra:member':[{domain:'mail.example',isActive:true,isPrivate:false}]});
  if(path==='/accounts'){creates++;hasRemote=true;assert.equal(v.account(id).mail.status,'creation uncertain');const locked=new Vault(storage);await locked.unlock(master);assert.equal(locked.account(id).mail.address,JSON.parse(options.body).address);throw Error('lost response after remote commit');}
  if(path==='/token'){tokenCalls++;assert.ok(hasRemote);return Response.json({token:'PRIVATE-TOKEN-V10'});}
  if(path==='/messages')return Response.json({'hydra:member':delayed?[]:[{id:'message-1'}]});
  if(path==='/messages/message-1')return Response.json({subject:'Verification',text:'Your verification code is 123456. https://site.example/verify?token=PRIVATE-LINK-V10'});
  throw Error('Unexpected provider endpoint');
 };
 const mail=new Mail(v,fetchFixture);await assert.rejects(mail.create(id),/uncertain/);assert.equal(creates,1);const sameAddress=v.account(id).mail.address;
 const restarted=new Vault(storage);await restarted.unlock(master);const recovery=new Mail(restarted,fetchFixture);await recovery.create(id);assert.equal(creates,1);assert.equal(tokenCalls,1);assert.equal(restarted.account(id).mail.address,sameAddress);
 assert.equal((await recovery.poll(id)).code,null);delayed=false;let a=restarted.account(id);await restarted.update(id,{mail:{...a.mail,nextPoll:0}});const result=await recovery.poll(id);assert.equal(result.code,'123456');assert.equal(result.links.length,1);
 for(const secret of [sameAddress,'PRIVATE-TOKEN-V10','123456','PRIVATE-LINK-V10'])assert.ok(!JSON.stringify(storage.data).includes(secret));
 await assert.rejects(recovery.poll(id),/allowance/);a=restarted.account(id);await restarted.update(id,{mail:{...a.mail,nextPoll:0,polls:6,windowAt:Date.now()}});await assert.rejects(recovery.poll(id),/allowance/);
 await assert.rejects(recovery.request('/messages/../../outside'),/Unsupported/);
 const tooLarge=new Mail(restarted,async()=>new Response(new Uint8Array(1000001)));await assert.rejects(tooLarge.request('/domains'),/bounds/);
 const redirect=new Mail(restarted,async()=>({ok:true,url:'https://evil.example',headers:new Headers(),body:new Response('{}').body}));await assert.rejects(redirect.request('/domains'),/origin/);
});
