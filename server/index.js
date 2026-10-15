import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { production } from './config.js';
import { pool } from './db.js';

const app = await createApp();
let vite;
if (production) {
  const root = fileURLToPath(new URL('../dist', import.meta.url));
  app.use(express.static(root));
  app.get('/{*path}', (_req, res) => res.sendFile(`${root}/index.html`));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`DigiQueue listening on port ${process.env.PORT || 3000}. Demo OTP only; no real banking transactions.`);
});
async function shutdown() {
  server.close(async () => {
    await vite?.close();
    await pool.end();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
