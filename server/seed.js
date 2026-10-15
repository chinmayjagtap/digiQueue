import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool, transaction } from './db.js';
import { assertConfig } from './config.js';
import { BRANCH, hashPassword } from './domain.js';

const demos = [
  ['9876500001', 'Asha Patil', ['910000001001', '910000001002']],
  ['9876500002', 'Ramesh Shinde', ['910000002001']],
  ['9876500003', 'Sunita More', ['910000003001']],
];

try {
  assertConfig();
  const username = process.env.STAFF_USERNAME || 'teller';
  const password = process.env.STAFF_PASSWORD || randomBytes(18).toString('base64url');
  if (password.length < 12) throw new Error('STAFF_PASSWORD must have at least 12 characters.');
  const passwordHash = await hashPassword(password);
  const created = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(74308102)');
    for (const [mobile, name, accounts] of demos) {
      const result = await client.query(`INSERT INTO customers (mobile, full_name)
        VALUES ($1, $2) ON CONFLICT (mobile) DO UPDATE SET mobile = EXCLUDED.mobile
        RETURNING id`, [mobile, name]);
      for (const number of accounts) {
        await client.query(`INSERT INTO accounts (customer_id, account_number, branch_code)
          VALUES ($1, $2, $3) ON CONFLICT (account_number) DO NOTHING`,
        [result.rows[0].id, number, BRANCH]);
      }
    }
    const result = await client.query(`INSERT INTO bank_staff (username, password_hash, branch_code)
      VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING RETURNING id`,
    [username, passwordHash, BRANCH]);
    return result.rowCount > 0;
  });
  if (created && !process.env.STAFF_PASSWORD) {
    await writeFile('.demo-credentials.txt',
      `DigiQueue fictional demo staff login\nUsername: ${username}\nPassword: ${password}\n`,
      { mode: 0o600, flag: 'wx' });
    console.log('Staff credentials saved privately in .demo-credentials.txt. Keep this file out of Git.');
  } else {
    console.log(created ? 'Staff account created using STAFF_PASSWORD.' : 'Existing staff account preserved.');
  }
  console.log('Fictional demo customers ready: 9876500001, 9876500002, 9876500003. Demo OTP: 123456.');
} catch (error) {
  console.error('Seed failed:', error.code || error.name,
    error.code ? 'Check database state and local credentials file permissions.' : error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
