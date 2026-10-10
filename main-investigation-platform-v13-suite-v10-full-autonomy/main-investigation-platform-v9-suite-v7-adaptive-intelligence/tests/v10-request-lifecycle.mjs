import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {repoRoot,runPython} from './lib/portable.mjs';
const dir=mkdtempSync(join(tmpdir(),'v10-requests-'));try{
 await build({entryPoints:[join(repoRoot,'tests/ui/v10-request-entry.tsx')],bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(dir,'app.js'),alias:{'@':repoRoot,'next/link':join(repoRoot,'tests/ui/next-shim.tsx'),'next/navigation':join(repoRoot,'tests/ui/next-shim.tsx')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'});
 console.log(runPython('tests/v10-request-lifecycle.py',{args:[join(dir,'app.js')],timeout:30000}).trim());
}finally{rmSync(dir,{recursive:true,force:true});}
