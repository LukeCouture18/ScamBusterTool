/* Self-contained isolated-world function. Never clicks, submits, or enters a different origin/frame. */
function loggerFillAccount(expectedOrigin,credentials,mode) {
  'use strict';
  if(window.top!==window||location.origin!==expectedOrigin||!['signup','login','code'].includes(mode))return {filled:0,reason:'Origin or frame mismatch.'};
  const visible=el=>el.isConnected&&!el.disabled&&!el.readOnly&&el.type!=='hidden'&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
  const fields=[...document.querySelectorAll('input')].filter(visible);
  const name=el=>[el.name,el.id,el.type,el.autocomplete,el.getAttribute('aria-label'),el.placeholder].join(' ').toLowerCase();
  const password=fields.filter(el=>el.type==='password'&&(mode==='signup'||el.autocomplete!=='new-password'));
  const username=fields.filter(el=>el.type!=='password'&&/email|username|user-name|login|account/.test(name(el))&&!/code|otp|token|search/.test(name(el)));
  const codes=fields.filter(el=>el.type!=='password'&&/one-time-code|verification|otp|code/.test(name(el))&&!/password|backup|recovery|promo|invite|referral/.test(name(el)));
  const groups=new Set((mode==='code'?codes:[...password,...username]).map(el=>el.form??el.closest('[role="dialog"]')??document.body));
  if(groups.size!==1)return {filled:0,reason:'Ambiguous or missing form.'};
  let targets;
  if(mode==='code'){if(codes.length!==1||!credentials.code)return {filled:0,reason:'One visible verification field and a code are required.'};targets=[[codes[0],credentials.code]];}
  else {if(password.length!==(mode==='signup'?Math.min(password.length,2):1)||!password.length||username.length!==1)return {filled:0,reason:'Ambiguous login/signup fields.'};
    if(mode==='signup'&&password.length===2&&!/confirm|repeat|new-password/.test(name(password[1])))return {filled:0,reason:'Ambiguous password fields.'};
    targets=[[username[0],credentials.username],...password.map(el=>[el,credentials.password])];}
  if(targets.some(([,value])=>typeof value!=='string'||!value))return {filled:0,reason:'Selected credentials are incomplete.'};
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)return {filled:0,reason:'Native input setter unavailable.'};
  for(const [el,value] of targets){setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  return {filled:targets.length,reason:'Filled explicitly. Submit and complete any verification yourself.'};
}
globalThis.loggerFillAccount=loggerFillAccount;
if(typeof module!=='undefined')module.exports={loggerFillAccount};
