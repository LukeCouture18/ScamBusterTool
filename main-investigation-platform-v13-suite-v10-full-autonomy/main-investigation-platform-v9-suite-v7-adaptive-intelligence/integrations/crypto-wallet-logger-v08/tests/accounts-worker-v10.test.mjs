'use strict';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {fileURLToPath} from 'node:url';import core from '../wallet-core.js';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..'),master='test private master phrase';
function worker(data={}){
 let listener;const storage={async get(keys){const list=Array.isArray(keys)?keys:[keys];return Object.fromEntries(list.filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));},async set(values){Object.assign(data,structuredClone(values));},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete data[k];},async setAccessLevel(){}};
 const chrome={runtime:{id:'test-extension',getURL:p=>'chrome-extension://test-extension/'+p,onMessage:{addListener:fn=>{listener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},storage:{local:storage,session:storage},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>[],get:async()=>({id:1,url:'https://other.example'})},scripting:{executeScript:async()=>{throw Error('Must not execute on wrong domain');}}};
 const context=vm.createContext({console,chrome,crypto:globalThis.crypto,TextEncoder,TextDecoder,btoa,atob,URL,structuredClone,setTimeout,clearTimeout,fetch,Response,Headers,AbortController});
 context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file}));vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
 const trusted={id:chrome.runtime.id,url:chrome.runtime.getURL('accounts.html')};
 const send=(message,sender=trusted)=>new Promise(resolve=>{const result=listener(message,sender,resolve);if(result===false)resolve(undefined);});
 const account=(action,input={},sender)=>send({type:'PRIVATE_ACCOUNT',action,input},sender);
 return {data,context,send,account,trusted};
}
test('worker protects private APIs and pauses all new capture while locked or restarted',async()=>{
 const w=worker();const bad=await w.account('unlock',{master},{id:'test-extension',url:'https://site.example',tab:{url:'https://site.example'}});assert.match(bad.error,/trusted extension/);assert.equal(Object.keys(w.data).length,0);
 assert.equal((await w.account('unlock',{master})).unlocked,true);
 const privatePassword='PRIVATE-password-credentials',username='private-user@example.com';const prepared=await w.account('prepare',{requestId:'worker-private-0001',intent:'owned_account_import',loginUrl:'https://site.example',username,password:privatePassword});assert.ok(prepared.id);
 const wrong=await w.account('fill',{id:prepared.id,mode:'login',tabId:1});assert.match(wrong.error,/exact HTTPS/);
 const sender={id:'test-extension',url:'https://site.example',frameId:0,tab:{url:'https://site.example/deposit?otp=123456#secret',title:username}};
 const scan={type:'REPORT_SCAN',page:{url:sender.tab.url,title:username,snippet:privatePassword}};
 assert.equal((await w.send(scan,sender)).recorded,true);
 const publicData={...w.data};delete publicData.privateAccountVaultV10;const text=JSON.stringify(publicData);for(const secret of [username,privatePassword,'123456'])assert.ok(!text.includes(secret));assert.ok(text.includes('https://site.example/deposit'));
 await w.account('lock');const before=JSON.stringify(w.data);assert.match((await w.send(scan,sender)).error,/Unlock/);assert.equal(JSON.stringify(w.data),before);
 const restarted=worker(w.data);assert.equal((await restarted.account('list')).unlocked,false);assert.match((await restarted.send(scan,sender)).error,/Unlock/);
 assert.equal((await restarted.account('unlock',{master})).unlocked,true);assert.equal((await restarted.send(scan,sender)).recorded,true);
});
test('structured private fields are excluded before wallet discovery while deposit fields survive',()=>{
 const address='0xbca55675025082730C7b1DfA310c5251099897d1';
 const value={password:address,username:address,privateEmail:address,nested:{accessToken:address,verificationCode:address},deposit:{network:'ethereum',depositAddress:address}};
 const hits=core.scanJson(value);assert.equal(hits.length,1);assert.equal(hits[0].keyPath,'deposit.depositAddress');
 assert.deepEqual(core.scanScriptText('const privateConfig={password:"'+address+'"};'),[]);
});
