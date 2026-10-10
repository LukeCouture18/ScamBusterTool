// Migration 0013: doubled network prefixes on wallet keys are corrected where safe, never merged or deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {applyMigrations} from './lib/main-harness.mjs';

test('0013 renames doubled wallet keys only when no correctly keyed twin exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mip-0013-'));
  const file = join(dir, 'db.sqlite');
  try {
    applyMigrations(file, n => n < '0013');
    const sql = new DatabaseSync(file);
    const add = (id, key) => sql.prepare("INSERT INTO entities (id,entity_type,canonical_key,display_name) VALUES (?,'wallet',?,?)").run(id, key, key);
    add('a', 'tron:tron:tkokvbrjduz5zuxbjnzx2k1oypkmbefxgm');          // alone: renamed
    add('b', 'tron:tron:tqmdzvmmdvwysd2xakfvzqz5dqjrqzthz3');          // has a twin: left as is
    add('c', 'tron:tqmdzvmmdvwysd2xakfvzqz5dqjrqzthz3');
    add('d', 'ethereum:0x71c841094df8cf7fa128565551f337f74c7dbb94');   // normal: untouched
    sql.close();
    assert.deepEqual(applyMigrations(file, n => n >= '0013' && n < '0014'), ['0013_wallet_key_prefix.sql']);
    const db = new DatabaseSync(file);
    const key = id => db.prepare('SELECT canonical_key k FROM entities WHERE id=?').get(id).k;
    assert.equal(key('a'), 'tron:tkokvbrjduz5zuxbjnzx2k1oypkmbefxgm');
    assert.equal(key('b'), 'tron:tron:tqmdzvmmdvwysd2xakfvzqz5dqjrqzthz3');
    assert.equal(key('c'), 'tron:tqmdzvmmdvwysd2xakfvzqz5dqjrqzthz3');
    assert.equal(key('d'), 'ethereum:0x71c841094df8cf7fa128565551f337f74c7dbb94');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, 4, 'nothing deleted');
    db.exec(require_sql());
    assert.equal(key('a'), 'tron:tkokvbrjduz5zuxbjnzx2k1oypkmbefxgm', 'running it again changes nothing');
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
function require_sql() { return readFileSync(new URL('../drizzle/0013_wallet_key_prefix.sql', import.meta.url), 'utf8'); }
