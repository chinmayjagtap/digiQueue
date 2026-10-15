import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { pool } from '../server/db.js';
import { BRANCH, businessDate, hashPassword } from '../server/domain.js';

test('Neon-backed customer and teller lifecycle', { skip: !process.env.RUN_DB_TESTS, timeout: 180000 }, async (t) => {
  const app = await createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const suffix = randomUUID().slice(0, 8);
  const password = `test-password-${suffix}`;
  const staffIds = [];
  const sessionIds = new Set();
  let customerId;
  let otherCustomerId;
  let accountId;
  let extraAccountId;
  let isolatedCustomerId;
  const isolatedBranch = `TEST_${suffix}`;

  function browser() {
    let cookie = '';
    let csrfToken = '';
    return async (path, body, expected = 200, csrf = true) => {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        cookie = setCookie.split(';')[0];
        const encoded = cookie.slice(cookie.indexOf('=') + 1);
        if (encoded) {
          const decoded = decodeURIComponent(encoded);
          if (decoded.startsWith('s:')) sessionIds.add(decoded.slice(2, decoded.lastIndexOf('.')));
        }
      }
      const data = await response.json();
      if (expected !== null) assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
      if (data.csrfToken) csrfToken = data.csrfToken;
      return expected === null ? { status: response.status, data } : data;
    };
  }
  const customer = browser();
  const secondCustomer = browser();
  const staff = browser();
  const rival = browser();
  const isolatedStaff = browser();
  try {
    const hash = await hashPassword(password);
    const mobile = `9${randomInt(100000000, 999999999)}`;
    const otherMobile = `8${randomInt(100000000, 999999999)}`;
    customerId = (await pool.query(`INSERT INTO customers (full_name, mobile)
      VALUES ('Integration Test Customer', $1) RETURNING id`, [mobile])).rows[0].id;
    otherCustomerId = (await pool.query(`INSERT INTO customers (full_name, mobile)
      VALUES ('Other Test Customer', $1) RETURNING id`, [otherMobile])).rows[0].id;
    accountId = (await pool.query(`INSERT INTO accounts (customer_id, account_number, branch_code)
      VALUES ($1, $2, $3) RETURNING id`, [customerId, `TEST${suffix}01`, BRANCH])).rows[0].id;
    extraAccountId = (await pool.query(`INSERT INTO accounts (customer_id, account_number, branch_code)
      VALUES ($1, $2, $3) RETURNING id`, [otherCustomerId, `TEST${suffix}02`, BRANCH])).rows[0].id;
    for (const [username, branch] of [[`test_${suffix}`, BRANCH], [`rival_${suffix}`, BRANCH], [`isolated_${suffix}`, isolatedBranch]]) {
      staffIds.push((await pool.query(`INSERT INTO bank_staff (username, password_hash, branch_code)
        VALUES ($1, $2, $3) RETURNING id`, [username, hash, branch])).rows[0].id);
    }
    await t.test('authentication, CSRF, OTP validation and account ownership', async () => {
      await customer('/bootstrap');
      assert.equal((await customer('/accounts', undefined, 401)).error, 'SESSION_EXPIRED');
      await customer('/otp/request', { mobile }, 403, false);
      await customer('/otp/request', { mobile });
      await customer('/otp/request', { mobile }, 429);
      await customer('/otp/verify', { otp: '000000' }, 400);
      await customer('/otp/verify', { otp: '123456' });
      const accounts = await customer('/accounts');
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, accountId);
      assert.ok(accounts[0].account_number.startsWith('X'));
      await customer('/deposits', {
        accountId: extraAccountId, language: 'en', idempotencyKey: randomUUID(),
        denominations: [{ denomination: 500, quantity: 1 }],
      }, 400);
      await staff('/bootstrap');
      await staff('/staff/login', { username: `test_${suffix}`, password: 'wrong' }, 401);
      await staff('/staff/login', { username: `test_${suffix}`, password });
      await rival('/bootstrap');
      await rival('/staff/login', { username: `rival_${suffix}`, password });
    });
    const payload = {
      accountId, language: 'mr', idempotencyKey: randomUUID(),
      denominations: [{ denomination: 500, quantity: 4 }, { denomination: 200, quantity: 3 }, { denomination: 100, quantity: 2 }],
    };
    let first;
    let second;
    await t.test('concurrent retries create one slip and persist denomination total', async () => {
      const [a, b] = await Promise.all([
        customer('/deposits', payload, 201), customer('/deposits', payload, 201),
      ]);
      assert.equal(a.id, b.id);
      assert.equal(a.total_amount, '2800');
      assert.equal(a.status, 'WAITING');
      assert.equal(a.events.length, 1);
      assert.equal((await customer('/bootstrap')).activeDepositId, a.id);
      first = a;
      second = await customer('/deposits', { ...payload, idempotencyKey: randomUUID() }, 201);
      assert.notEqual(second.token, first.token);
      await secondCustomer('/bootstrap');
      await secondCustomer('/otp/request', { mobile: otherMobile });
      await secondCustomer('/otp/verify', { otp: '123456' });
      await secondCustomer(`/deposits/${first.id}`, undefined, 404);
    });
    await t.test('only one teller can claim a token and only its owner can resolve it', async () => {
      await staff(`/staff/deposits/${first.id}`, undefined, 404);
      const attempts = await Promise.all([
        staff(`/staff/deposits/${first.id}/call`, {}, null),
        rival(`/staff/deposits/${first.id}/call`, {}, null),
      ]);
      assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
      const owner = attempts[0].status === 200 ? staff : rival;
      const nonOwner = attempts[0].status === 200 ? rival : staff;
      await nonOwner(`/staff/deposits/${second.id}/call`, {});
      assert.equal((await customer(`/deposits/${first.id}`)).status, 'CALLED');
      await nonOwner(`/staff/deposits/${first.id}/action`, { action: 'ACKNOWLEDGED' }, 409);
      await owner('/staff/call-next', {}, 409);
      const recalled = await owner(`/staff/deposits/${first.id}/action`, { action: 'RECALLED' });
      assert.equal(recalled.events.at(-1).event_type, 'RECALLED');
      const done = await owner(`/staff/deposits/${first.id}/action`, { action: 'ACKNOWLEDGED' });
      assert.equal(done.status, 'ACKNOWLEDGED');
      await owner(`/staff/deposits/${first.id}/action`, { action: 'ACKNOWLEDGED' }, 409);
      assert.equal((await customer(`/deposits/${first.id}`)).status, 'ACKNOWLEDGED');
      await nonOwner(`/staff/deposits/${second.id}/action`, { action: 'REJECTED', reason: 'OTHER' }, 400);
      const rejected = await nonOwner(`/staff/deposits/${second.id}/action`, {
        action: 'REJECTED', reason: 'OTHER', note: 'Fictional test rejection',
      });
      assert.equal(rejected.status, 'REJECTED');
      assert.equal((await customer(`/deposits/${second.id}`)).rejection_note, 'Fictional test rejection');
    });
    await t.test('call-next FIFO, competing claims, no-show and branch isolation', async () => {
      isolatedCustomerId = (await pool.query(`INSERT INTO customers (full_name, mobile)
        VALUES ('Isolated Test Customer', $1) RETURNING id`, [`7${randomInt(100000000, 999999999)}`])).rows[0].id;
      const isolatedAccount = (await pool.query(`INSERT INTO accounts (customer_id, account_number, branch_code)
        VALUES ($1, $2, $3) RETURNING id`, [isolatedCustomerId, `ISOLATED${suffix}`, isolatedBranch])).rows[0].id;
      const ids = [randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        await pool.query(`INSERT INTO deposit_requests (id, idempotency_key, account_id, branch_code,
          business_date, token_number, language_code) VALUES ($1, $2, $3, $4, $5, $6, 'en')`,
        [id, randomUUID(), isolatedAccount, isolatedBranch, businessDate(), index + 1]);
        await pool.query(`INSERT INTO deposit_denominations VALUES ($1, 500, 1)`, [id]);
      }
      await isolatedStaff('/bootstrap');
      await isolatedStaff('/staff/login', { username: `isolated_${suffix}`, password });
      await isolatedStaff(`/staff/deposits/${first.id}/call`, {}, 409);
      const called = await isolatedStaff('/staff/call-next', {});
      assert.equal(called.id, ids[0]);
      const noShow = await isolatedStaff(`/staff/deposits/${called.id}/action`, { action: 'NO_SHOW' });
      assert.equal(noShow.status, 'NO_SHOW');
      assert.equal((await isolatedStaff('/staff/call-next', {})).id, ids[1]);
      await isolatedStaff(`/staff/deposits/${ids[1]}/action`, { action: 'ACKNOWLEDGED' });
      await isolatedStaff('/staff/call-next', {}, 409);
    });
    await t.test('logout clears customer access', async () => {
      await customer('/logout', {});
      await customer(`/deposits/${first.id}`, undefined, 401);
    });
  } finally {
    const customerIds = [customerId, otherCustomerId, isolatedCustomerId].filter(Boolean);
    if (customerIds.length) {
      await pool.query(`DELETE FROM deposit_events WHERE deposit_id IN (
        SELECT d.id FROM deposit_requests d JOIN accounts a ON a.id = d.account_id WHERE a.customer_id = ANY($1::bigint[])
      )`, [customerIds]);
      await pool.query(`DELETE FROM deposit_denominations WHERE deposit_id IN (
        SELECT d.id FROM deposit_requests d JOIN accounts a ON a.id = d.account_id WHERE a.customer_id = ANY($1::bigint[])
      )`, [customerIds]);
      await pool.query(`DELETE FROM deposit_requests WHERE account_id IN
        (SELECT id FROM accounts WHERE customer_id = ANY($1::bigint[]))`, [customerIds]);
      await pool.query('DELETE FROM accounts WHERE customer_id = ANY($1::bigint[])', [customerIds]);
      await pool.query('DELETE FROM customers WHERE id = ANY($1::bigint[])', [customerIds]);
    }
    if (staffIds.length) await pool.query('DELETE FROM bank_staff WHERE id = ANY($1::bigint[])', [staffIds]);
    await pool.query('DELETE FROM daily_token_counters WHERE branch_code = $1', [isolatedBranch]);
    if (sessionIds.size) await pool.query('DELETE FROM sessions WHERE sid = ANY($1::text[])', [[...sessionIds]]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
