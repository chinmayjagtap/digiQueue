import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const production = process.env.NODE_ENV === 'production';

export function sessionSecret() {
  if (process.env.SESSION_SECRET?.length >= 32) return process.env.SESSION_SECRET;
  if (production) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  try {
    return readFileSync('.session-secret', 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = randomBytes(48).toString('hex');
    writeFileSync('.session-secret', secret, { mode: 0o600, flag: 'wx' });
    return secret;
  }
}

export function assertConfig() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing from the environment.');
  if ((process.env.OTP_MODE || 'demo') !== 'demo') {
    throw new Error('Only OTP_MODE=demo is implemented. Real SMS requires a provider integration.');
  }
}
