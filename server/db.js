import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = globalThis.WebSocket;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  statement_timeout: 15000,
});

pool.on('error', (error) => {
  console.error('Database pool error:', error.code || error.name);
});

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
