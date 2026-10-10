/** One local entry point. Existing paths and state remain where the supplied suite expects them. */
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,createWriteStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {pythonCommand} from '../tests/lib/portable.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),hunter=resolve(process.env.HUNTER_DIR??join(root,'..','operation-hunter-v2.0'));
const modules=['site_finder','site_investigator','crypto_wallet_logger','wallet_investigator','form_submitter','operation_hunter'];
const config=join(root,'.dev.vars');
if(!existsSync(config))writeFileSync(config,'MODULE_API_KEYS='+JSON.stringify(Object.fromEntries(modules.map(n=>[n,randomBytes(32).toString('hex')])))+'\n',{mode:0o600});
const lines=readFileSync(config,'utf8').split(/\r?\n/),keyline=lines.find(s=>s.startsWith('MODULE_API_KEYS='));
if(!keyline)throw new Error('Add MODULE_API_KEYS to .dev.vars; existing configuration was preserved.');
const keys=JSON.parse(keyline.slice('MODULE_API_KEYS='.length));
if(modules.some(n=>typeof keys[n]!=='string'||!keys[n]))throw new Error('MODULE_API_KEYS must contain all six module keys.');
const py=pythonCommand(),logdir=join(root,'logs','suite');mkdirSync(logdir,{recursive:true});
const cleanEnv={...process.env,NODE_ENV:'production',HOST:'127.0.0.1',MAIN_PLATFORM_URL:'http://127.0.0.1:8787'};
// Provider credentials are passed only to their specialist. Never forward them to Main.
for(const k of Object.keys(cleanEnv))if(/API_KEY|MODULE_KEY|TOKEN|SECRET|PASSWORD|INVITE|TEAM_CODE/.test(k))delete cleanEnv[k];
let providerKey=process.env.BLOCKSCOUT_API_KEY??'';
const walletEnv=join(root,'integrations','wallet-investigator','.env');
if(existsSync(walletEnv)){const line=readFileSync(walletEnv,'utf8').split(/\r?\n/).find(s=>/^BLOCKSCOUT_API_KEY=/.test(s));if(line)providerKey=line.slice('BLOCKSCOUT_API_KEY='.length).replace(/^['"]|['"]$/g,'');}
const services=[
 {name:'main',cwd:root,args:[join(root,'scripts','start-production.mjs')],env:{},url:'http://127.0.0.1:8787/api/v1/health'},
 {name:'wallet',cwd:join(root,'integrations','wallet-investigator'),args:['dist/server.cjs'],env:{PORT:'3001',WALLET_INVESTIGATOR_MODULE_KEY:keys.wallet_investigator,BLOCKSCOUT_API_KEY:providerKey},url:'http://127.0.0.1:3001/health'},
 {name:'form',cwd:join(root,'integrations','form-submitter'),args:['dist/server.cjs'],env:{PORT:'3002',FORM_SUBMITTER_MODULE_KEY:keys.form_submitter},url:'http://127.0.0.1:3002/api/health'},
 {name:'hunter',cwd:hunter,args:['--import',pathToFileURL(join(hunter,'node_modules','tsx','dist','loader.mjs')).href,'server.ts','--production'],env:{PORT:'3003',MAIN_PLATFORM_API_KEY:keys.operation_hunter,MAIN_PLATFORM_ENABLED:'true',HUNTER_PUBLIC_URL:'http://127.0.0.1:3003'},url:'http://127.0.0.1:3003/api/v1/health'},
 {name:'finder',cwd:join(root,'integrations','site-finder-v07'),command:py.command,args:[...py.args,'cli.py','serve'],env:{SITE_FINDER_HOST:'127.0.0.1',SITE_FINDER_PORT:'5000',SITE_FINDER_MODULE_KEY:keys.site_finder,MAIN_PLATFORM_TOKEN:keys.site_finder},url:'http://127.0.0.1:5000/'},
 {name:'site',cwd:join(root,'integrations','site-investigator-v01'),command:py.command,args:[...py.args,'run.py'],env:{SI_HOST:'127.0.0.1',SI_PORT:'8765',SITE_INVESTIGATOR_MODULE_KEY:keys.site_investigator},url:'http://127.0.0.1:8765/'},
];
const children=[],logs=[];let stopping=false,maintenanceTimer,maintenanceBusy=false;
function stop(){if(stopping)return;stopping=true;clearInterval(maintenanceTimer);for(const c of children){try{if(process.platform==='win32')spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-c.pid,'SIGTERM');}catch{}}setTimeout(()=>{for(const c of children)try{if(process.platform!=='win32')process.kill(-c.pid,'SIGKILL');}catch{}for(const l of logs)l.end();},5000).unref();}
async function maintain(){if(stopping||maintenanceBusy)return;maintenanceBusy=true;try{const r=await fetch('http://127.0.0.1:8787/api/v1/ops/maintenance',{method:'POST',signal:AbortSignal.timeout(30000)});const body=await r.json();if(!r.ok||!body.ok)throw new Error('Local maintenance HTTP '+r.status+'; failed: '+(body.failed??[]).join(', '));}finally{maintenanceBusy=false;}}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,stop);
async function ready(service,child){const deadline=Date.now()+60000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(service.name+' exited; inspect logs/suite/'+service.name+'.log');try{const r=await fetch(service.url,{signal:AbortSignal.timeout(1500)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error(service.name+' did not become ready; inspect its suite log.');}
try{
 for(const service of services){const log=createWriteStream(join(logdir,service.name+'.log'),{flags:'a'});logs.push(log);const child=spawn(service.command??process.execPath,service.args,{cwd:service.cwd,env:{...cleanEnv,...service.env},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});children.push(child);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.on('error',e=>{console.error(service.name+': '+e.message);stop();});await ready(service,child);console.log(service.name+' ready');}
 await maintain();maintenanceTimer=setInterval(()=>maintain().catch(e=>console.error('Local maintenance:',e.message)),15000);
 console.log('Local automatic maintenance enabled (15 seconds).');
 console.log('Open http://127.0.0.1:8787 — Investigate Site. Ctrl+C stops the suite.');
 console.log('Logger setup: Main URL http://127.0.0.1:8787; copy only the crypto_wallet_logger value from .dev.vars into the extension settings.');
 if(process.env.SUITE_SMOKE==='1')stop();
}catch(e){console.error(e.message);process.exitCode=1;stop();}
