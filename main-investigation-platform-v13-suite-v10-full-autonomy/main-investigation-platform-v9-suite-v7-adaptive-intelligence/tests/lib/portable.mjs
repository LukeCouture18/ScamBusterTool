// Cross-platform helpers for the acceptance harness (Windows, macOS, Linux).
//
// Same approach the platform's own scripts already use (scripts/sites-env.mjs,
// scripts/run-framework.mjs, scripts/start-production.mjs):
//   * filesystem path  -> ESM specifier: pathToFileURL(path).href
//   * import.meta URL  -> filesystem path: fileURLToPath(url), never URL.pathname
// A raw absolute path such as C:\Users\...\x.js is not a valid ESM specifier
// (Node reads "c:" as a URL scheme), and URL.pathname yields "/C:/Users/..."
// which Python and most Windows tools cannot open.
import {spawnSync, execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const isWindows = process.platform === 'win32';
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Filesystem path of `relative`, resolved against a module URL (usually import.meta.url). */
export const localPath = (relative, base = new URL('../', import.meta.url)) => fileURLToPath(new URL(relative, base));

/** ESM specifier (file: URL string) for a filesystem path. */
export const fileHref = (path) => pathToFileURL(path).href;

/** Dynamic import of a filesystem path on any OS. */
export const importFile = (path) => import(fileHref(path));

/** Dynamic import of a file inside a directory (e.g. an esbuild outdir). */
export const importFrom = (directory, relative) => importFile(join(directory, relative));

// ---------------------------------------------------------------------------
// Python interpreter
// ---------------------------------------------------------------------------

/** Interpreter path inside a virtualenv directory, for this OS. */
export const venvPython = (venvDir) => isWindows ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python');

let resolved;

function probe(command, args) {
  // Confirms the candidate really is a Python 3 interpreter. This rejects the
  // Windows Store "python" alias, which exists on PATH but only opens the Store.
  const result = spawnSync(command, [...args, '-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8', windowsHide: true});
  return !result.error && result.status === 0 && result.stdout.trim() === '3';
}

/**
 * The Python 3 interpreter the harness runs, as {command, args, source}.
 * Order: MIP_PYTHON, the repository's .venv, an activated VIRTUAL_ENV, then
 * PATH (python/py -3 on Windows, python3/python elsewhere). A candidate that is
 * named explicitly (MIP_PYTHON) but does not work is an error, not a fallback.
 */
export function pythonCommand() {
  if (resolved) return resolved;
  const explicit = process.env.MIP_PYTHON;
  if (explicit) {
    if (!probe(explicit, [])) throw new Error(`MIP_PYTHON=${explicit} is not a working Python 3 interpreter`);
    return (resolved = {command: explicit, args: [], source: 'MIP_PYTHON'});
  }
  const candidates = [
    {command: venvPython(join(repoRoot, '.venv')), args: [], source: '.venv', file: true},
    ...(process.env.VIRTUAL_ENV ? [{command: venvPython(process.env.VIRTUAL_ENV), args: [], source: 'VIRTUAL_ENV', file: true}] : []),
    ...(isWindows
      ? [{command: 'python', args: [], source: 'PATH'}, {command: 'py', args: ['-3'], source: 'PATH'}]
      : [{command: 'python3', args: [], source: 'PATH'}, {command: 'python', args: [], source: 'PATH'}]),
  ];
  for (const candidate of candidates) {
    if (candidate.file && !existsSync(candidate.command)) continue;
    if (probe(candidate.command, candidate.args)) return (resolved = {command: candidate.command, args: candidate.args, source: candidate.source});
  }
  throw new Error(`No Python 3 interpreter found. Looked for ${venvPython(join(repoRoot, '.venv'))}, VIRTUAL_ENV and PATH; set MIP_PYTHON to choose one.`);
}

/** Environment for Python children: UTF-8 I/O regardless of the Windows code page. */
export const pythonEnv = (extra = {}) => ({...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extra});

/** Run a Python script and return its stdout (throws with stderr on a non-zero exit). */
export function runPython(script, {args = [], env = {}, ...options} = {}) {
  const {command, args: prefix} = pythonCommand();
  return execFileSync(command, [...prefix, script, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options, env: pythonEnv(env)});
}

/** Run a Python script that prints one JSON document, and parse it. */
export const runPythonJson = (script, options) => JSON.parse(runPython(script, options));

// ---------------------------------------------------------------------------
// Child processes and cleanup
// ---------------------------------------------------------------------------

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Stop a spawned child and wait until it has really exited. On Windows the
 * process must be gone before its working directory or open files (SQLite)
 * can be removed, so callers await this before deleting temp directories.
 */
export async function stopChild(child, graceMs = 5000) {
  if (!child || exited(child)) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  const grace = new Promise(resolve => { timer = setTimeout(resolve, graceMs, 'timeout'); });
  const outcome = await Promise.race([done, grace]);
  clearTimeout(timer);
  if (outcome === 'timeout' && !exited(child)) {
    child.kill('SIGKILL');
    await done;
  }
}

/** Remove a temporary directory. Errors propagate: a locked file is a real leak. */
export const removeDir = (path) => rm(path, {recursive: true, force: true});
