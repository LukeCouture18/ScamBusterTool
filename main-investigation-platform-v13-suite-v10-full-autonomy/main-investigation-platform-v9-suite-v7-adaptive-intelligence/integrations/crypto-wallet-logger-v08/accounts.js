'use strict';
const el=id=>document.getElementById(id);let accounts=[],epoch=0,busy=false;
const message=text=>{el('status').textContent=String(text);};
const clearSecrets=()=>{for(const id of ['master','ownedUsername','ownedPassword','privateUsername','privatePassword','code'])el(id).value='';el('privatePassword').type='password';el('messages').replaceChildren();el('verificationLinks').replaceChildren();};
async function send(action,input={}){const r=await chrome.runtime.sendMessage({type:'PRIVATE_ACCOUNT',action,input});if(r?.error)throw Error(r.error);if(!r)throw Error('Account worker unavailable.');return r;}
function selected(){const id=el('saved').value;if(!id)throw Error('Select an account first.');return id;}
async function refresh(preserveMessage=false){const r=await send('list');el('workspace').hidden=!r.unlocked;el('unlockForm').hidden=r.unlocked;el('lock').disabled=!r.unlocked;if(!r.unlocked){epoch++;clearSecrets();accounts=[];if(!preserveMessage)message(r.initialized?'Vault locked. New evidence capture is paused until unlock.':'Initialize your private vault.');return;}
 accounts=r.accounts;const old=el('saved').value;el('saved').replaceChildren(new Option('Select an account…',''),...accounts.map(a=>new Option(a.domain+' · '+a.alias+' · '+a.status,a.id)));if(accounts.some(a=>a.id===old))el('saved').value=old;
}
async function tabs(){const id=selected(),items=await send('tabs',{id});el('targetTab').replaceChildren(new Option('Select a matching open site tab…',''),...items.tabs.map(t=>new Option(t.domain+' · tab '+t.id,String(t.id))));}
async function fill(mode){const tabId=Number(el('targetTab').value);if(!tabId)throw Error('Select an exact-domain site tab.');const r=await send('fill',{id:selected(),mode,tabId});message(r.reason);}
async function action(fn){if(busy)return;busy=true;let failed=false;const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){failed=true;message(e.message);}finally{busy=false;buttons.forEach(b=>b.disabled=false);await refresh(failed).catch(e=>message(e.message));}}
el('unlockForm').addEventListener('submit',e=>{e.preventDefault();const master=el('master').value;el('master').value='';void action(async()=>{await send('unlock',{master});message('Vault unlocked.');});});
el('lock').addEventListener('click',()=>{epoch++;clearSecrets();el('workspace').hidden=true;void action(async()=>{await send('lock');message('Vault locked.');});});
el('intent').addEventListener('change',()=>{el('owned').hidden=el('intent').value!=='owned_account_import';el('ownedPassword').value='';});
el('prepareForm').addEventListener('submit',e=>{e.preventDefault();void action(async()=>{const loginUrl=el('loginUrl').value,intent=el('intent').value;if(!intent)throw Error('Choose your account purpose explicitly.');
 const key='private-account-request:'+new URL(loginUrl).hostname+':'+intent,requestId=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,requestId);
 const input={requestId,intent,loginUrl,signupUrl:el('signupUrl').value||undefined,username:el('ownedUsername').value,password:el('ownedPassword').value,notes:el('notes').value};
 el('ownedPassword').value='';const r=await send('prepare',input);await refresh();el('saved').value=r.id;await tabs();message(r.recovered?'Recovered the same prepared account.':'Account prepared and encrypted.');});});
el('saved').addEventListener('change',()=>{epoch++;clearSecrets();const a=accounts.find(a=>a.id===el('saved').value);el('accountStatus').textContent=a?`${a.status} · Created ${a.createdAt} · Inbox ${a.mailStatus??'not created'}`:'';void action(tabs);});
el('refreshTabs').addEventListener('click',()=>void action(tabs));
el('openSite').addEventListener('click',()=>void action(async()=>{const a=accounts.find(a=>a.id===selected());if(!a)throw Error('Account not found.');await chrome.tabs.create({url:a.loginUrl});}));
for(const [id,mode] of [['fillSignup','signup'],['fillLogin','login'],['fillCode','code']])el(id).addEventListener('click',()=>void action(()=>fill(mode)));
el('loginCompleted').addEventListener('click',()=>void action(async()=>{await send('login_completed',{id:selected()});message('Login confirmation saved privately. Browse the deposit page normally.');}));
el('reveal').addEventListener('click',()=>void action(async()=>{const at=epoch,a=await send('details',{id:selected()});if(at!==epoch)return;el('privateUsername').value=a.username;el('privatePassword').value=a.password;el('privatePassword').type='text';message('Selected credentials are revealed for explicit copying.');}));
for(const [id,field] of [['copyUsername','privateUsername'],['copyPassword','privatePassword'],['copyCode','code']])el(id).addEventListener('click',()=>void action(async()=>{await send('details',{id:selected()});const value=el(field).value;if(!value)throw Error('Reveal or retrieve the selected value first.');await navigator.clipboard.writeText(value);message('Copied explicitly.');}));
el('createMail').addEventListener('click',()=>void action(async()=>{await send('mail_create',{id:selected()});message('Mailbox ready. Reveal username to use its address.');}));
el('pollMail').addEventListener('click',()=>void action(async()=>{const at=epoch,r=await send('mail_poll',{id:selected()});if(at!==epoch)return;el('code').value=r.code??'';el('messages').replaceChildren();el('verificationLinks').replaceChildren();
 for(const m of r.messages){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Open Message · '+m.subject;pre.textContent=m.text;details.append(summary,pre);el('messages').append(details);}
 for(const href of r.links){const link=document.createElement('a');link.href=href;link.textContent='Open Verification Link · '+new URL(href).hostname;link.target='_blank';link.rel='noopener noreferrer';el('verificationLinks').append(link,document.createElement('br'));}message('Messages checked. You open links and submit verification yourself.');}));
void refresh().catch(e=>message(e.message));setInterval(()=>{if(!busy)void refresh().catch(()=>{});},10000);
window.addEventListener('pagehide',clearSecrets);
