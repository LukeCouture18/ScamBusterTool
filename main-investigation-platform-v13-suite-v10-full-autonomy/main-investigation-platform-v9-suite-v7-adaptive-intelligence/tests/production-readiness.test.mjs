import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('../scripts/start-production.mjs', import.meta.url));
for (const mode of ['ready', 'pending-once', 'permanently-pending', 'missing-table', 'migration-error', 'invalid-response']) {
  test(`production schema readiness: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'mip-schema-readiness-'));
    try {
      for (const dir of ['scripts', 'drizzle', 'dist/server', 'node_modules/wrangler/bin']) mkdirSync(join(root, dir), {recursive:true});
      copyFileSync(source, join(root, 'scripts/start-production.mjs'));
      writeFileSync(join(root, 'scripts/sites-env.mjs'), '');
      writeFileSync(join(root, 'drizzle/0021_one_click_investigation.sql'), '-- fixture');
      writeFileSync(join(root, 'drizzle/0022_autonomous_missions.sql'), '-- fixture');
      writeFileSync(join(root, 'dist/server/wrangler.json'), '{}');
      writeFileSync(join(root, '.dev.vars'), '');
      const marker = join(root, 'calls.json');
      writeFileSync(marker, '[]');
      writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `
const fs=require('node:fs');const args=process.argv.slice(2),marker=${JSON.stringify(marker)},mode=${JSON.stringify(mode)};
const calls=JSON.parse(fs.readFileSync(marker));calls.push(args);fs.writeFileSync(marker,JSON.stringify(calls));
if(args[0]==='dev')process.exit(0);
if(args[1]==='migrations')process.exit(mode==='migration-error'?7:0);
if(mode==='invalid-response'){process.stdout.write('invalid');process.exit(0);}
const checks=calls.filter(c=>c[1]==='execute').length;
const missing=mode==='permanently-pending'||(mode==='pending-once'&&checks===1);
const tables=['autonomy_searches','autonomy_candidate_claims','inbox_supply_lock','autonomous_missions','mission_resources','mission_reservations','mission_opportunities','mission_history'];
console.log(JSON.stringify([{success:true,results:(missing?[]:['0021_one_click_investigation.sql','0022_autonomous_missions.sql']).map(name=>({name}))},{success:true,results:(missing||mode==='missing-table'?[]:tables).map(name=>({name}))}]));
`);
      const result = spawnSync(process.execPath, [join(root,'scripts/start-production.mjs')], {cwd:root, encoding:'utf8', timeout:10000});
      const calls = JSON.parse(readFileSync(marker));
      const success = mode === 'ready' || mode === 'pending-once';
      assert.equal(result.status, success ? 0 : mode === 'migration-error' ? 7 : 1, result.stderr);
      assert.equal(calls.filter(c => c[0] === 'dev').length, success ? 1 : 0);
      assert.equal(calls.filter(c => c[1] === 'migrations').length, ['pending-once','permanently-pending'].includes(mode) ? 2 : 1);
      assert.ok(calls.every(c => !c.includes('delete') && !c.includes('reset')));
      if (!success && mode !== 'migration-error') assert.match(result.stderr, /readiness|incomplete/);
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
}
