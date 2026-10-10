import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HunterApp, HUNTER_VERSION } from './server/app.js';
import { IntegrationWorker } from './server/integration/worker.js';
import { buildRouter } from './server/api/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.zip': 'application/zip' };

function staticHandler(root: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Operation Hunter UI is not built. Run "npm run build" (or start in development with "npm run dev").');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  };
}

function scheduleBackups(app: HunterApp) {
  const dir = path.join(app.store.dataDir, 'backups');
  const run = () => {
    try {
      const file = path.join(dir, `hunter-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(file)) app.store.backup(file);
      const files = fs.readdirSync(dir).filter(f => /^hunter-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 7))) fs.unlinkSync(path.join(dir, old));
    } catch (err) {
      console.warn('[backup] daily backup failed:', err instanceof Error ? err.message : err);
    }
  };
  setTimeout(run, 30000).unref();
  setInterval(run, 6 * 3600000).unref();
}

async function main() {
  loadDotEnv();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
  const app = new HunterApp();
  const integrity = app.store.integrityCheck();
  if (integrity !== 'ok') console.warn(`[store] integrity check reported: ${integrity}. A backup is in data/backups.`);
  const recovered = app.pursuit.recover();
  app.integration = new IntegrationWorker(app);
  const router = buildRouter(app);

  let uiHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void = staticHandler(path.resolve(__dirname, 'dist'));
  if (!isProd) {
    try {
      const viteModule = 'vite';
      const vite: any = await import(viteModule);
      const server = await vite.createServer({ server: { middlewareMode: true }, appType: 'spa' });
      uiHandler = (req, res) => server.middlewares(req, res, () => { res.statusCode = 404; res.end(); });
    } catch (err) {
      console.warn('[ui] Vite dev server unavailable, serving the built UI from dist/:', err instanceof Error ? err.message : err);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      uiHandler(req, res);
    } catch (err) {
      console.error('[http] unhandled', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, host, () => {
    console.log(`[Operation Hunter v${HUNTER_VERSION}] http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  data: ${app.store.file} (schema v${app.store.schemaVersion()}), network mode: ${app.runtimeSettings().networkMode}`);
    console.log(`  Main Platform: ${app.integration?.configured() ? app.integration.config().url : 'not connected (standalone)'}`);
    if (recovered.interruptedPivots || recovered.resumedRuns) console.log(`  recovered: ${recovered.interruptedPivots} interrupted pivot(s), ${recovered.resumedRuns} running pursuit(s) resumed`);
  });
  app.pursuit.startScheduler();
  app.monitor.startScheduler();
  app.hunts.startScheduler();
  app.integration.start();
  scheduleBackups(app);

  const shutdown = (signal: string) => {
    console.log(`[Operation Hunter] ${signal} received, shutting down cleanly…`);
    server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
