// Every tool's own screens carry the shared design tokens from sdk/ui/suite.css (one visual language).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {run, targets, tokens} from '../scripts/sync-ui-tokens.mjs';

test('each tool UI is in sync with the canonical tokens', () => {
  const result = run({check: true});
  assert.ok(result.length >= 5, 'Site Finder, its investigation page, Wallet Logger, Wallet Investigator and Form Submitter at least');
  for (const r of result) assert.equal(r.state, 'in sync', `${r.tool}: ${r.state} (run node scripts/sync-ui-tokens.mjs)`);
});

test('the generated blocks only restyle: every tool keeps its own markup and variables', () => {
  const t = tokens();
  assert.equal(t['--mip-bg'], '#080c16');
  for (const target of targets()) {
    const text = readFileSync(target.file, 'utf8');
    const block = text.match(/\/\* mip-theme:start[\s\S]*?mip-theme:end \*\//)[0];
    assert.ok(block.includes(`--mip-bg:${t['--mip-bg']}`), `${target.tool} carries the tokens`);
    assert.doesNotMatch(block, /display\s*:\s*none|content\s*:/, `${target.tool}: colors only, nothing hidden`);
    assert.doesNotMatch(block, /\{\{|\{%|\{#/, `${target.tool}: nothing a template engine would interpret`);
  }
});
