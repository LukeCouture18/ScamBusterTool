import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('.',import.meta.url)).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>fileURLToPath(new URL(n,import.meta.url)));
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exitCode=r.status??1;
