import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10];
export const REASONS = [
  'DENOMINATION_MISMATCH', 'AMOUNT_MISMATCH', 'UNSUITABLE_NOTES',
  'ACCOUNT_ISSUE', 'CUSTOMER_WITHDREW', 'OTHER',
];
export const BRANCH = 'DEMO001';
export const MAX_AMOUNT = 200000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function validateDenominations(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > DENOMINATIONS.length) {
    throw new ApiError(400, 'INVALID_DENOMINATIONS');
  }
  const seen = new Set();
  let total = 0;
  for (const row of value) {
    if (!row || !DENOMINATIONS.includes(row.denomination) ||
        !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 10000 ||
        seen.has(row.denomination)) {
      throw new ApiError(400, 'INVALID_DENOMINATIONS');
    }
    seen.add(row.denomination);
    total += row.denomination * row.quantity;
  }
  if (total > MAX_AMOUNT) throw new ApiError(400, 'AMOUNT_LIMIT');
  return total;
}

export function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function maskAccount(number) {
  return `${'X'.repeat(Math.max(0, number.length - 4))}${number.slice(-4)}`;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  const [salt, encoded] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(encoded, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
