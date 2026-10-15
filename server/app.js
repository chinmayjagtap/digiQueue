import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { pool, transaction } from './db.js';
import { production, sessionSecret, assertConfig } from './config.js';
import {
  ApiError, BRANCH, REASONS, UUID, businessDate, checkPassword,
  hashPassword, maskAccount, validateDenominations,
} from './domain.js';

const PgSession = connectPgSimple(session);
const token = () => randomBytes(32).toString('hex');
const regenerate = (req) => new Promise((resolve, reject) =>
  req.session.regenerate((error) => error ? reject(error) : resolve()));
const save = (req) => new Promise((resolve, reject) =>
  req.session.save((error) => error ? reject(error) : resolve()));
const totalSql = `(SELECT SUM(n.denomination::bigint * n.quantity)
  FROM deposit_denominations n WHERE n.deposit_id = d.id)`;

function requireCustomer(req, _res, next) {
  if (!req.session.customerId) throw new ApiError(401, 'SESSION_EXPIRED');
  next();
}

async function requireStaff(req, _res, next) {
  if (!req.session.staffId) throw new ApiError(401, 'STAFF_LOGIN_REQUIRED');
  const result = await pool.query(
    'SELECT id, username, branch_code FROM bank_staff WHERE id = $1 AND is_active',
    [req.session.staffId],
  );
  if (!result.rowCount) throw new ApiError(401, 'STAFF_LOGIN_REQUIRED');
  req.staff = result.rows[0];
  next();
}

function requireId(req, _res, next) {
  if (!UUID.test(req.params.id)) throw new ApiError(400, 'INVALID_REQUEST');
  next();
}

async function receipt(id, customerId, staff) {
  const result = await pool.query(`SELECT d.*, a.account_number, c.full_name,
    ${totalSql} AS total_amount,
    (SELECT COUNT(*)::integer FROM deposit_requests q
      WHERE q.branch_code = d.branch_code AND q.status = 'WAITING'
      AND (q.business_date, q.token_number) < (d.business_date, d.token_number)
    ) AS ahead
    FROM deposit_requests d JOIN accounts a ON a.id = d.account_id
    JOIN customers c ON c.id = a.customer_id
    WHERE d.id = $1 AND (
      ($2::bigint IS NOT NULL AND a.customer_id = $2) OR
      ($3::bigint IS NOT NULL AND d.called_by = $3 AND d.branch_code = $4)
    )`, [id, customerId || null, staff?.id || null, staff?.branch_code || null]);
  if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND');
  const data = result.rows[0];
  const [notes, events] = await Promise.all([
    pool.query(`SELECT denomination, quantity FROM deposit_denominations
      WHERE deposit_id = $1 ORDER BY denomination DESC`, [id]),
    pool.query(`SELECT event_type, note, created_at FROM deposit_events
      WHERE deposit_id = $1 ORDER BY id`, [id]),
  ]);
  return {
    ...data,
    account_number: staff ? data.account_number : maskAccount(data.account_number),
    denominations: notes.rows,
    events: events.rows,
    token: `C-${String(data.token_number).padStart(3, '0')}`,
  };
}

export async function createApp() {
  assertConfig();
  const app = express();
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: production ? undefined : false,
    strictTransportSecurity: production ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', session({
    store: new PgSession({ pool, tableName: 'sessions', createTableIfMissing: false }),
    secret: sessionSecret(),
    name: 'dq.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true, sameSite: 'lax', secure: production,
      maxAge: 30 * 60 * 1000,
    },
  }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.session.csrfToken || req.get('X-CSRF-Token') !== req.session.csrfToken) {
        throw new ApiError(403, 'INVALID_SESSION');
      }
      if (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) {
        throw new ApiError(403, 'INVALID_SESSION');
      }
    }
    next();
  });

  app.get('/api/bootstrap', async (req, res) => {
    req.session.csrfToken ||= token();
    let staff = null;
    if (req.session.staffId) {
      const result = await pool.query(`SELECT username, branch_code FROM bank_staff
        WHERE id = $1 AND is_active`, [req.session.staffId]);
      staff = result.rows[0] || null;
    }
    let customer = null;
    if (req.session.customerId) {
      const result = await pool.query('SELECT full_name FROM customers WHERE id = $1', [req.session.customerId]);
      customer = result.rows[0] || null;
    }
    res.json({
      csrfToken: req.session.csrfToken, staff, customer, otpMode: 'demo',
      activeDepositId: customer ? req.session.lastDepositId || null : null,
    });
  });

  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'TOO_MANY_ATTEMPTS' },
  });
  const submitLimit = rateLimit({
    windowMs: 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'TOO_MANY_ATTEMPTS' },
  });

  app.post('/api/otp/request', authLimit, async (req, res) => {
    const mobile = req.body.mobile;
    if (typeof mobile !== 'string' || !/^[6-9][0-9]{9}$/.test(mobile)) {
      throw new ApiError(400, 'INVALID_MOBILE');
    }
    if (req.session.otp && Date.now() - req.session.otp.sentAt < 30000) {
      throw new ApiError(429, 'RESEND_WAIT');
    }
    delete req.session.customerId;
    req.session.otp = { mobile, sentAt: Date.now(), attempts: 0 };
    res.json({ demo: true, expiresIn: 300, resendIn: 30 });
  });

  app.post('/api/otp/verify', authLimit, async (req, res) => {
    const challenge = req.session.otp;
    if (!challenge || Date.now() - challenge.sentAt > 300000) {
      throw new ApiError(400, 'OTP_EXPIRED');
    }
    challenge.attempts += 1;
    if (challenge.attempts > 5) {
      delete req.session.otp;
      throw new ApiError(429, 'OTP_LOCKED');
    }
    if (req.body.otp !== '123456') throw new ApiError(400, 'INVALID_OTP');
    const result = await pool.query('SELECT id FROM customers WHERE mobile = $1', [challenge.mobile]);
    if (!result.rowCount) throw new ApiError(404, 'NO_ACCOUNT');
    await regenerate(req);
    req.session.customerId = result.rows[0].id;
    req.session.csrfToken = token();
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.get('/api/accounts', requireCustomer, async (req, res) => {
    const result = await pool.query(`SELECT a.id, a.account_number, a.branch_code, c.full_name
      FROM accounts a JOIN customers c ON c.id = a.customer_id
      WHERE a.customer_id = $1 AND a.is_active AND a.branch_code = $2 ORDER BY a.id`,
    [req.session.customerId, BRANCH]);
    res.json(result.rows.map((row) => ({ ...row, account_number: maskAccount(row.account_number) })));
  });

  app.post('/api/deposits', requireCustomer, submitLimit, async (req, res) => {
    const { accountId, denominations, language, idempotencyKey } = req.body;
    if (typeof accountId !== 'string' || !/^\d{1,18}$/.test(accountId) ||
        !['en', 'mr', 'hi'].includes(language) ||
        typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) {
      throw new ApiError(400, 'INVALID_REQUEST');
    }
    validateDenominations(denominations);
    const id = await transaction(async (client) => {
      // Serialize retries before allocating a token, including simultaneous double taps.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const existing = await client.query(`SELECT d.id, a.customer_id FROM deposit_requests d
        JOIN accounts a ON a.id = d.account_id WHERE d.idempotency_key = $1`, [idempotencyKey]);
      if (existing.rowCount) {
        if (existing.rows[0].customer_id !== req.session.customerId) throw new ApiError(409, 'INVALID_REQUEST');
        return existing.rows[0].id;
      }
      const account = await client.query(`SELECT id FROM accounts
        WHERE id = $1 AND customer_id = $2 AND is_active AND branch_code = $3 FOR SHARE`,
      [accountId, req.session.customerId, BRANCH]);
      if (!account.rowCount) throw new ApiError(400, 'NO_ACCOUNT');
      const date = businessDate();
      const counter = await client.query(`INSERT INTO daily_token_counters
        (branch_code, business_date, last_number) VALUES ($1, $2, 1)
        ON CONFLICT (branch_code, business_date)
        DO UPDATE SET last_number = daily_token_counters.last_number + 1 RETURNING last_number`,
      [BRANCH, date]);
      const newId = randomUUID();
      await client.query(`INSERT INTO deposit_requests (
        id, idempotency_key, account_id, branch_code, business_date, token_number, language_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId, idempotencyKey, accountId, BRANCH, date, counter.rows[0].last_number, language]);
      for (const row of denominations) {
        await client.query(`INSERT INTO deposit_denominations (deposit_id, denomination, quantity)
          VALUES ($1, $2, $3)`, [newId, row.denomination, row.quantity]);
      }
      await client.query(`INSERT INTO deposit_events (deposit_id, event_type) VALUES ($1, 'SUBMITTED')`, [newId]);
      return newId;
    });
    req.session.lastDepositId = id;
    res.status(201).json(await receipt(id, req.session.customerId));
  });

  app.get('/api/deposits/:id', requireId, requireCustomer, async (req, res) => {
    res.json(await receipt(req.params.id, req.session.customerId));
  });

  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  app.post('/api/staff/login', authLimit, async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' ||
        username.length > 100 || password.length > 256) throw new ApiError(400, 'INVALID_LOGIN');
    const result = await pool.query(`SELECT id, password_hash FROM bank_staff
      WHERE username = $1 AND is_active`, [username]);
    const valid = await checkPassword(password, result.rows[0]?.password_hash || dummyHash);
    if (!result.rowCount || !valid) throw new ApiError(401, 'INVALID_LOGIN');
    await regenerate(req);
    req.session.staffId = result.rows[0].id;
    req.session.csrfToken = token();
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.post('/api/logout', async (req, res) => {
    await new Promise((resolve, reject) =>
      req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie('dq.sid', { httpOnly: true, sameSite: 'lax', secure: production });
    res.json({ ok: true });
  });

  app.get('/api/staff/queue', requireStaff, async (req, res) => {
    const [queue, summary, active] = await Promise.all([
      pool.query(`SELECT d.id, d.token_number, d.business_date, d.status, d.created_at,
        d.called_by, ${totalSql} AS total_amount
        FROM deposit_requests d WHERE d.branch_code = $1
        AND d.status IN ('WAITING', 'CALLED')
        ORDER BY d.business_date, d.token_number LIMIT 100`, [req.staff.branch_code]),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status = 'WAITING')::integer AS waiting,
        COUNT(*) FILTER (WHERE status = 'CALLED')::integer AS called,
        COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED' AND business_date = $2)::integer AS acknowledged,
        COUNT(*) FILTER (WHERE status = 'REJECTED' AND business_date = $2)::integer AS rejected
        FROM deposit_requests WHERE branch_code = $1`, [req.staff.branch_code, businessDate()]),
      pool.query(`SELECT id FROM deposit_requests WHERE called_by = $1 AND status = 'CALLED'`, [req.staff.id]),
    ]);
    res.json({
      queue: queue.rows.map((row) => ({ ...row, mine: row.called_by === req.staff.id })),
      summary: summary.rows[0],
      activeId: active.rows[0]?.id || null,
      staff: { username: req.staff.username, branch_code: req.staff.branch_code },
      updatedAt: new Date().toISOString(),
    });
  });

  async function callToken(req, res) {
    const id = await transaction(async (client) => {
      await client.query('SELECT id FROM bank_staff WHERE id = $1 FOR UPDATE', [req.staff.id]);
      const active = await client.query(`SELECT id FROM deposit_requests
        WHERE called_by = $1 AND status = 'CALLED'`, [req.staff.id]);
      if (active.rowCount) throw new ApiError(409, 'RESOLVE_ACTIVE');
      const requestedId = req.params.id;
      if (requestedId && !UUID.test(requestedId)) throw new ApiError(400, 'INVALID_REQUEST');
      const next = await client.query(`SELECT id FROM deposit_requests
        WHERE branch_code = $1 AND status = 'WAITING'
        ${requestedId ? 'AND id = $2' : ''}
        ORDER BY business_date, token_number FOR UPDATE SKIP LOCKED LIMIT 1`,
      requestedId ? [req.staff.branch_code, requestedId] : [req.staff.branch_code]);
      if (!next.rowCount) throw new ApiError(409, requestedId ? 'TOKEN_UNAVAILABLE' : 'QUEUE_EMPTY');
      const requestId = next.rows[0].id;
      await client.query(`UPDATE deposit_requests SET status = 'CALLED',
        called_by = $2, called_at = now(), updated_at = now() WHERE id = $1`,
      [requestId, req.staff.id]);
      await client.query(`INSERT INTO deposit_events (deposit_id, actor_staff_id, event_type)
        VALUES ($1, $2, 'CALLED')`, [requestId, req.staff.id]);
      return requestId;
    });
    res.json(await receipt(id, null, req.staff));
  }
  app.post('/api/staff/call-next', requireStaff, callToken);
  app.post('/api/staff/deposits/:id/call', requireStaff, callToken);
  app.get('/api/staff/deposits/:id', requireId, requireStaff, async (req, res) => {
    res.json(await receipt(req.params.id, null, req.staff));
  });
  app.post('/api/staff/deposits/:id/action', requireId, requireStaff, async (req, res) => {
    const { action, reason, note } = req.body;
    if (!['ACKNOWLEDGED', 'REJECTED', 'NO_SHOW', 'RECALLED'].includes(action)) {
      throw new ApiError(400, 'INVALID_REQUEST');
    }
    if (action === 'REJECTED' && (!REASONS.includes(reason) ||
        (reason === 'OTHER' && (typeof note !== 'string' || !note.trim())))) {
      throw new ApiError(400, 'REASON_REQUIRED');
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
      throw new ApiError(400, 'INVALID_REQUEST');
    }
    await transaction(async (client) => {
      const result = await client.query(`SELECT status, called_by FROM deposit_requests
        WHERE id = $1 AND branch_code = $2 FOR UPDATE`, [req.params.id, req.staff.branch_code]);
      if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND');
      if (result.rows[0].status !== 'CALLED' || result.rows[0].called_by !== req.staff.id) {
        throw new ApiError(409, 'TOKEN_UNAVAILABLE');
      }
      if (action !== 'RECALLED') {
        await client.query(`UPDATE deposit_requests SET status = $2, resolved_by = $3,
          resolved_at = now(), updated_at = now(), rejection_code = $4, rejection_note = $5
          WHERE id = $1`,
        [req.params.id, action, req.staff.id,
          action === 'REJECTED' ? reason : null, action === 'REJECTED' ? note?.trim() || null : null]);
      }
      await client.query(`INSERT INTO deposit_events (deposit_id, actor_staff_id, event_type, note)
        VALUES ($1, $2, $3, $4)`, [req.params.id, req.staff.id, action,
        action === 'REJECTED' ? note?.trim() || null : null]);
    });
    res.json(await receipt(req.params.id, null, req.staff));
  });

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND')));
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api/')) return next(error);
    if (error instanceof ApiError) {
      // Persist OTP attempt counters before returning a validation error.
      return save(req).then(() => res.status(error.status).json({ error: error.code })).catch(next);
    }
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_REQUEST' });
    console.error('API failure:', req.method, req.route?.path || 'unknown', error.code || error.name);
    res.status(500).json({ error: 'SERVER_ERROR' });
  });
  return app;
}
