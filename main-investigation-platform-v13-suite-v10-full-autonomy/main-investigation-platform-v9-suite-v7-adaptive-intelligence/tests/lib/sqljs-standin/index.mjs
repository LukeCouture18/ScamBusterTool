// Test-only stand-in for the `sql.js` package, backed by node:sqlite. It is used ONLY when the real
// package is not installed (see ../sqljs-fallback.mjs), so the joined tests can still run the real
// Wallet Investigator worker on a machine without its npm dependencies. It implements the part of
// the sql.js API the Wallet Investigator uses: new Database(buffer?), run, prepare/bind/step/
// getAsObject/free, exec and export.
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const value = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const params = p => (Array.isArray(p) ? p.map(value) : p && typeof p === 'object' ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, value(v)])) : []);
const plain = row => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));

class Statement {
  constructor(db, sql) { this.stmt = db.prepare(sql); this.rows = null; this.i = -1; this.args = []; }
  bind(p) { this.args = params(p); this.rows = null; this.i = -1; return true; }
  step() {
    if (!this.rows) this.rows = Array.isArray(this.args) ? this.stmt.all(...this.args) : this.stmt.all(this.args);
    this.i += 1;
    return this.i < this.rows.length;
  }
  getAsObject() { return plain(this.rows?.[this.i]) ?? {}; }
  get() { return Object.values(this.getAsObject()); }
  run(p) { this.bind(p); Array.isArray(this.args) ? this.stmt.run(...this.args) : this.stmt.run(this.args); }
  reset() { this.rows = null; this.i = -1; }
  free() { this.rows = null; return true; }
}

class Database {
  constructor(buffer) {
    this.dir = mkdtempSync(join(tmpdir(), 'sqljs-standin-'));
    this.file = join(this.dir, 'db.sqlite');
    if (buffer && buffer.length) writeFileSync(this.file, Buffer.from(buffer));
    this.db = new DatabaseSync(this.file);
  }
  run(sql, p) {
    const args = params(p);
    if ((Array.isArray(args) && args.length) || (!Array.isArray(args) && Object.keys(args).length)) new Statement(this.db, sql).run(args);
    else this.db.exec(sql);
    return this;
  }
  exec(sql) {
    // sql.js returns [{columns, values}] for the last result-producing statement; the callers here only execute.
    this.db.exec(sql);
    return [];
  }
  prepare(sql, p) { const s = new Statement(this.db, sql); if (p) s.bind(p); return s; }
  getRowsModified() { return Number(this.db.prepare('SELECT changes() n').get().n); }
  export() {
    const out = join(this.dir, `export-${process.hrtime.bigint()}.sqlite`);
    this.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    const data = readFileSync(out); rmSync(out, {force: true});
    return new Uint8Array(data);
  }
  close() { try { this.db.close(); } finally { rmSync(this.dir, {recursive: true, force: true}); } }
}

export default async function initSqlJs() { return {Database}; }
export {Database, Statement};
