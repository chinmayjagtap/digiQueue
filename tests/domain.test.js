import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDenominations, businessDate, maskAccount, hashPassword, checkPassword,
} from '../server/domain.js';

test('denomination calculation and exact demo limit', () => {
  assert.equal(validateDenominations([
    { denomination: 500, quantity: 4 }, { denomination: 200, quantity: 3 },
    { denomination: 100, quantity: 2 },
  ]), 2800);
  assert.equal(validateDenominations([{ denomination: 500, quantity: 400 }]), 200000);
  assert.throws(() => validateDenominations([{ denomination: 500, quantity: 401 }]),
    { code: 'AMOUNT_LIMIT' });
});

test('rejects malformed, duplicate, fractional and invalid note quantities', () => {
  for (const value of [
    null, {}, [], [null], [{ denomination: 2000, quantity: 1 }],
    [{ denomination: 500, quantity: 0 }], [{ denomination: 500, quantity: -1 }],
    [{ denomination: 500, quantity: 1.5 }], [{ denomination: 500, quantity: '2' }],
    [{ denomination: 500, quantity: 10001 }],
    [{ denomination: 10, quantity: 1 }, { denomination: 10, quantity: 2 }],
  ]) assert.throws(() => validateDenominations(value), { code: 'INVALID_DENOMINATIONS' });
});

test('tokens reset on the Indian business date rather than UTC date', () => {
  assert.equal(businessDate(new Date('2026-10-15T18:29:59Z')), '2026-10-15');
  assert.equal(businessDate(new Date('2026-10-15T18:30:00Z')), '2026-10-16');
});

test('customer account numbers expose only last four digits', () => {
  assert.equal(maskAccount('910000001001'), 'XXXXXXXX1001');
});

test('password hashes verify and use independent salts', async () => {
  const first = await hashPassword('fictional-password');
  const second = await hashPassword('fictional-password');
  assert.notEqual(first, second);
  assert.equal(await checkPassword('fictional-password', first), true);
  assert.equal(await checkPassword('incorrect', first), false);
});
