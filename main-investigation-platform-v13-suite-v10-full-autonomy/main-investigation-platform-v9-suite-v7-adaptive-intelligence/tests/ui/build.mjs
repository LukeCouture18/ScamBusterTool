// Bundles the suite's real client components (shell + five tools + Advanced) into one browser
// script for the acceptance test, without a Next build: next/link and next/navigation are swapped
// for tests/ui/next-shim.tsx, and lucide-react icons for plain SVG stand-ins generated from the
// names the components import. CSS is the suite stylesheet plus globals.css without its Tailwind
// imports (the tools' own classes come from sdk/ui/suite.css).
import {execSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {build} from 'esbuild';
import {repoRoot} from '../lib/portable.mjs';

function globalModules() {
  const found = [];
  for (const dir of [join(repoRoot, 'node_modules'), process.env.NODE_PATH, (() => { try { return execSync('npm root -g', {encoding: 'utf8'}).trim(); } catch { return ''; } })()])
    if (dir && existsSync(join(dir, 'react')) && existsSync(join(dir, 'react-dom'))) found.push(dir);
  return found;
}

function lucideNames() {
  const names = new Set();
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) {
    for (const m of readFileSync(p, 'utf8').matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide-react["']/g))
      for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''); if (/^[A-Z]\w*$/.test(name)) names.add(name); }
  } } };
  walk(join(repoRoot, 'components'));
  return [...names].sort();
}

export async function buildSuiteUi(outDir) {
  const nodePaths = globalModules();
  if (!nodePaths.length) return {skipped: 'react and react-dom are not installed (npm install in the Main folder)'};
  const icons = lucideNames();
  const lucide = `const make=(name)=>function Icon({size=16,...rest}){return React.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,'data-icon':name,'aria-hidden':'true',...rest},React.createElement('rect',{x:4,y:4,width:16,height:16,rx:4}));};
import * as React from 'react';
${icons.map(n => `export const ${n}=make(${JSON.stringify(n)});`).join('\n')}`;
  await build({
    entryPoints: [join(repoRoot, 'tests', 'ui', 'entry.tsx')], bundle: true, format: 'iife', platform: 'browser', outfile: join(outDir, 'suite.js'),
    jsx: 'automatic', loader: {'.tsx': 'tsx', '.ts': 'ts'}, nodePaths, logLevel: 'error', define: {'process.env.NODE_ENV': '"production"'},
    alias: {'@': repoRoot},
    plugins: [{name: 'suite-shims', setup(p) {
      p.onResolve({filter: /^next\/(link|navigation)$/}, () => ({path: join(repoRoot, 'tests', 'ui', 'next-shim.tsx')}));
      p.onResolve({filter: /^lucide-react$/}, () => ({path: 'lucide', namespace: 'shim'}));
      p.onLoad({filter: /.*/, namespace: 'shim'}, () => ({contents: lucide, loader: 'js', resolveDir: repoRoot}));
      p.onResolve({filter: /^@\//}, a => ({path: require_ts(join(repoRoot, a.path.slice(2)))}));
    }}],
  });
  const globals = readFileSync(join(repoRoot, 'app', 'globals.css'), 'utf8').split('\n').filter(l => !/^@import|^@theme/.test(l.trim())).join('\n');
  writeFileSync(join(outDir, 'suite.css'), readFileSync(join(repoRoot, 'sdk', 'ui', 'suite.css'), 'utf8') + '\n' + globals);
  writeFileSync(join(outDir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Main Investigation Platform</title><link rel="stylesheet" href="/__ui/suite.css"></head><body><div id="root"></div><script src="/__ui/suite.js"></script></body></html>');
  return {dir: outDir, icons: icons.length};
}

function require_ts(base) {
  for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  return base;
}

/** A handler for main-harness's `extra` hook: the UI's files, and index.html for every page path. */
export function serveSuiteUi(dir) {
  return async (req, res, url) => {
    if (url.pathname.startsWith('/__ui/')) {
      const file = join(dir, url.pathname.slice(6));
      if (!existsSync(file)) return false;
      res.writeHead(200, {'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript'}); res.end(readFileSync(file)); return true;
    }
    if (req.method === 'GET' && !url.pathname.includes('.')) { res.writeHead(200, {'content-type': 'text/html'}); res.end(readFileSync(join(dir, 'index.html'))); return true; }
    return false;
  };
}
