// `node --import ./tests/lib/sqljs-fallback.mjs ...`: when the real `sql.js` package is not installed
// (for example in a sandbox without npm access), resolve it to the node:sqlite stand-in instead.
//
// When sql.js IS installed this file does nothing at all: no module hook is registered, so the
// normal TypeScript loader (tsx) handles every import exactly as it would without this file.
// (A resolve hook registered next to tsx's hooks is not neutral on every Node/tsx combination:
// on Windows + Node 24 it left the imported Wallet worker with an empty module namespace.)
//
// Whether a hook was registered is recorded on globalThis.__MIP_SQLJS_STANDIN__ (true/false) so
// tests/sqljs-fallback.test.mjs can prove the installed case stays untouched.
import {createRequire, register} from 'node:module';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const walletRoot = join(repoRoot, 'integrations', 'wallet-investigator');

/** Where a real sql.js resolves from (the Wallet Investigator, the repository or the working directory), or null. */
export function installedSqlJs() {
  for (const dir of [walletRoot, repoRoot, process.cwd(), join(process.cwd(), 'integrations', 'wallet-investigator')]) {
    try { return createRequire(join(dir, 'package.json')).resolve('sql.js'); } catch { /* not installed here */ }
  }
  return null;
}

const installed = installedSqlJs();
globalThis.__MIP_SQLJS_STANDIN__ = !installed;

if (!installed) {
  const standin = pathToFileURL(join(import.meta.dirname, 'sqljs-standin', 'index.mjs')).href;
  const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === 'sql.js') {
    try { return await next(specifier, context); }
    catch { return {url: ${JSON.stringify(standin)}, shortCircuit: true}; }
  }
  return next(specifier, context);
}`;
  register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);
  if (!process.env.MIP_QUIET_STANDIN) console.error('[test] sql.js is not installed; the Wallet Investigator runs on the node:sqlite stand-in (tests/lib/sqljs-standin).');
}
