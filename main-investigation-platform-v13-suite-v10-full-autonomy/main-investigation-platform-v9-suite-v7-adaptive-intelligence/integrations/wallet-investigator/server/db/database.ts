/**
 * Persistent SQLite Database Engine
 * Powered by sql.js with durable disk persistence and parameterized query execution.
 */

import initSqlJs, { Database, SqlValue } from 'sql.js';
import fs from 'fs';
import path from 'path';

let dbInstance: Database | null = null;
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE_PATH = path.join(DATA_DIR, 'wallet_investigator.sqlite');

/**
 * Ensures data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Initializes or loads database from disk
 */
export async function initDatabase(): Promise<Database> {
  if (dbInstance) return dbInstance;

  ensureDataDir();
  // Partial saves left by a process that was killed mid-write (see saveDatabaseToDisk). They are
  // never the database itself, which is only ever replaced by a completed rename.
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (/^wallet_investigator\.sqlite\.\d+\.tmp$/.test(name)) {
      try { fs.rmSync(path.join(DATA_DIR, name), { force: true }); } catch { /* still in use by a live writer */ }
    }
  }
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_FILE_PATH);
      const candidate = new SQL.Database(fileBuffer);
      // sql.js opens lazily: a truncated or damaged file only fails on its first query.
      const check = candidate.exec('PRAGMA quick_check;')[0]?.values?.[0]?.[0];
      if (check !== 'ok') { candidate.close(); throw new Error(`integrity check: ${String(check)}`); }
      dbInstance = candidate;
      console.log(`[Database] Loaded persistent database from ${DB_FILE_PATH} (${fileBuffer.length} bytes)`);
    } catch (err) {
      // Never overwrite the user's data: keep the unreadable file next to the new one.
      const preserved = `${DB_FILE_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(DB_FILE_PATH, preserved);
      console.error(`[Database] Could not open ${DB_FILE_PATH}; kept it as ${preserved} and started a new database:`, err);
      dbInstance = new SQL.Database();
      saveDatabaseToDisk();
    }
  } else {
    dbInstance = new SQL.Database();
    console.log(`[Database] Initialized new database at ${DB_FILE_PATH}`);
    saveDatabaseToDisk();
  }

  // Enforce foreign keys
  dbInstance.run('PRAGMA foreign_keys = ON;');
  return dbInstance;
}

/**
 * Renames `from` over `to`. On Windows a scanner or indexer can hold the target open for a moment
 * (EPERM/EBUSY/EACCES), so retry briefly, then fall back to an in-place write.
 */
function replaceFile(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 10 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      fs.writeFileSync(to, fs.readFileSync(from));
      fs.rmSync(from, { force: true });
      return;
    }
  }
}

/**
 * Persists the SQLite database buffer to disk
 */
export function saveDatabaseToDisk(): void {
  if (!dbInstance) return;
  try {
    ensureDataDir();
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    // Write a sibling file and rename it over the database, so an interrupted save (crash, kill,
    // power loss) leaves the previous complete file instead of a truncated one.
    const temp = `${DB_FILE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temp, buffer);
    replaceFile(temp, DB_FILE_PATH);
  } catch (err) {
    console.error('[Database] Failed saving database to disk:', err);
  }
}

/**
 * Helper to get active db instance
 */
export function getDb(): Database {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

/**
 * Executes a parameterized statement (INSERT, UPDATE, DELETE)
 */
export function runStatement(sql: string, params: SqlValue[] = []): void {
  const db = getDb();
  db.run(sql, params);
  saveDatabaseToDisk();
}

/**
 * Executes a query returning an array of objects
 */
export function queryAll<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as T;
    rows.push(row);
  }
  stmt.free();
  return rows;
}

/**
 * Executes a query returning a single object or null
 */
export function queryFirst<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null {
  const rows = queryAll<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Resets database for testing clean migration workflows
 */
export async function resetDatabaseForTesting(): Promise<void> {
  if (fs.existsSync(DB_FILE_PATH)) {
    fs.unlinkSync(DB_FILE_PATH);
  }
  const SQL = await initSqlJs();
  dbInstance = new SQL.Database();
  saveDatabaseToDisk();
}
