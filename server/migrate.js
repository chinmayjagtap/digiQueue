import { readFile } from 'node:fs/promises';
import { pool, transaction } from './db.js';
import { assertConfig } from './config.js';

try {
  assertConfig();
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(74308101)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const exists = await client.query('SELECT version FROM schema_migrations WHERE version = $1', ['001_initial']);
    if (!exists.rowCount) {
      const sql = await readFile(new URL('../db/001_initial.sql', import.meta.url), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial']);
      console.log('Applied migration 001_initial.');
    } else {
      console.log('Database schema is already up to date.');
    }
  });
} catch (error) {
  console.error('Migration failed:', error.code || error.name,
    error.code ? 'Check database connectivity and schema permissions.' : error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
