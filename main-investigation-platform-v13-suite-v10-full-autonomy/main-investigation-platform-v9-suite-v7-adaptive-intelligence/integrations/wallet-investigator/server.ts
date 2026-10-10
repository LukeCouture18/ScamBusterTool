/**
 * Wallet Investigator v1.0 - Backend Server Entrypoint
 * Express + Vite Full-Stack Architecture
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db/database';
import { runMigrations } from './server/db/migrations';
import apiRouter from './server/routes/api';
import { globalJobQueue } from './server/jobs/job_queue';
import { startPlatformWorker } from './server/integration/platform_worker';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  // Step 1: Initialize Persistent SQLite DB & Apply Versioned Migrations
  console.log('[Wallet Investigator] Initializing SQLite database...');
  await initDatabase();
  await runMigrations();
  // The queue singleton is imported before the database opens. Retry recovery
  // after migrations so interrupted RUNNING jobs are actually reclaimed.
  globalJobQueue.recoverStaleJobs();
  await startPlatformWorker();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // API Routes First
  app.use('/api', apiRouter);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', application: 'Wallet Investigator v1.0', timestamp: Date.now() });
  });

  // Step 2: Vite middleware in development or static dist in production
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Wallet Investigator] Running in development mode with Vite middleware');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('[Wallet Investigator] Running in production mode');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Wallet Investigator] Server running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Wallet Investigator] Fatal startup error:', err);
  process.exit(1);
});
