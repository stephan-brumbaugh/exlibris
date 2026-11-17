import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, ensureDirs } from './config.js';
import { openDb } from './db.js';
import { applyEnvPassword } from './auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { publicPage } from './views.js';
import { startJob } from './jobs.js';
import { scanLibrary } from './ingest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.static(path.join(root, 'public'), { maxAge: '1h', index: false }));
  app.use('/admin-js', express.static(path.join(root, 'admin'), { maxAge: '1h' }));
  app.get('/vendor/sortable.js', (req, res) => res.sendFile(path.join(root, 'node_modules/sortablejs/modular/sortable.core.esm.js'), { maxAge: '7d' }));
  app.use('/admin', adminRouter);
  app.use(publicRouter);
  app.use((req, res) => res.status(404).send(publicPage({ title: 'Not found', body: '<section class="notfound"><h1>This page is not on any shelf.</h1><p><a href="/">Back to the library</a></p></section>', data: { page: 'none' } })));
  app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong. Check the server log.'); });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureDirs();
  openDb();
  applyEnvPassword();
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`Ex Libris listening on http://${config.host}:${config.port}`);
    console.log(`Data: ${config.dataDir}  Library folders: ${config.libraryDirs.join(', ')}`);
  });
  if (config.scanOnStart) setTimeout(() => startJob('scan', 'Scan library folders (startup)', j => scanLibrary(j)), 2000);
  if (config.scanIntervalMinutes > 0) setInterval(() => startJob('scan', 'Scheduled library scan', j => scanLibrary(j)), config.scanIntervalMinutes * 60e3);
}
