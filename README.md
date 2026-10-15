# DigiQueue

A single-branch cash-deposit queue demonstration with English, Marathi and Hindi customer and teller screens. Fictional accounts and demo OTP only: no SMS is sent and no bank account is credited.

## Local setup

Node.js 22 or newer is required (Node.js 24 recommended).

1. Create a free Neon PostgreSQL project and copy its pooled connection URL.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`. Never commit this file.
3. Run:

```sh
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. Customer and staff screens share the same application. The small staff-login link is at the bottom of the mobile-entry card; <http://localhost:3000/#staff> also opens it.

The backend uses Neon's PostgreSQL-compatible WebSocket driver over TLS/port 443, including interactive transactions. It does not require a direct outbound TCP/5432 connection. Only the backend has database credentials.

### Demo customers and OTP

| Mobile | Customer | Accounts ending in |
| --- | --- | --- |
| 9876500001 | Asha Patil | 1001, 1002 |
| 9876500002 | Ramesh Shinde | 2001 |
| 9876500003 | Sunita More | 3001 |

The OTP is **123456** for every fictional customer. It expires after five minutes; resending has a 30-second cooldown and verification is limited to five attempts. This deliberately simulated verification must not be used with real customer data.

The initial staff username is **teller**. Unless `STAFF_PASSWORD` is set before seeding, a random password is saved locally in `.demo-credentials.txt` with owner-only permissions. Open that private file to retrieve it. Do not commit or publicly share it. Seeding preserves existing staff passwords and customer records.

A random local session secret is persisted in `.session-secret`. Production requires an explicit `SESSION_SECRET` of at least 32 characters. Sessions persist in PostgreSQL; both secret files and `.env` are excluded from Git.

### Demonstrating both screens

Use two browsers or a normal browser window plus a private window. Same-origin tabs share the authentication cookie; signing in as staff in the same browser replaces the customer session.

1. In the customer window, choose a language and demo mobile.
2. Enter `123456`, choose an account, enter note counts, review and submit.
3. In the separate staff window, sign in and call the token.
4. Compare the customer slip: it updates within about three seconds while visible.
5. Recall or announce the token, then acknowledge cash received, reject with a reason, or mark no-show.
6. Use **Finish / Next customer** to clear the kiosk session.

There is a three-minute inactivity reset on customer steps after the mobile screen. Staff sessions expire after 30 minutes without requests; the live dashboard polls while visible, keeping an active teller session alive. Account numbers are masked on customer screens and revealed only to the teller handling the slip.

## Database

The versioned schema is `db/001_initial.sql`. `npm run db:migrate` applies pending migrations transactionally under an advisory lock and tracks them in `schema_migrations`; running it again is safe. Do not separately paste this SQL into Neon after running the migration.

Tables: `customers`, `accounts`, `bank_staff`, `daily_token_counters`, `deposit_requests`, `deposit_denominations`, `deposit_events`, `sessions`, and `schema_migrations`.

Token numbering is per branch and Indian business date. Open tokens carry over to the next day and are called oldest-first. Amounts are computed from denomination rows, not trusted from a browser total. Positive integer note counts only; the **PoC-specific** maximum is ₹2,00,000 per slip. Coins and ₹2,000 notes are not included.

Submissions have idempotency keys. Token allocation, slip creation, note counts and initial history are committed together. Teller claims and outcomes use row locks, enforce one active token per teller, and restrict outcomes to the teller that claimed the token. Staff cannot edit the customer's submitted denomination counts.

```text
WAITING -> CALLED -> ACKNOWLEDGED / REJECTED / NO_SHOW
```

Acknowledgement records the teller's confirmation of cash receipt, not a core-banking credit. Rejected slips remain immutable; a customer can start again to create a corrected request.

## Validation

```sh
npm run check
npm test
npm run build
```

For integration tests against the configured Neon database, apply the migration first, then:

```sh
npm run test:integration
```

These create uniquely named fictional test customers/staff and clean up their records and sessions. Tests consume token sequence numbers in the demo branch, so gaps are expected. They do not delete or reset existing demo requests. Use a separate Neon development branch for repeated testing when demonstrating with others.

## Deploy to Render

1. Push this project to your own GitHub repository, excluding all private files.
2. In Render, create a **Blueprint** from that repository using `render.yaml`, or create one Node web service manually.
3. Set `DATABASE_URL` to the Neon pooled URL. The Blueprint generates `SESSION_SECRET` automatically and sets `NODE_ENV=production`, `OTP_MODE=demo` and Node.js 24.
4. Build command: `npm ci --include=dev && npm run build`.
5. Start command: `npm run db:migrate && npm start`.
6. Health-check path: `/api/health`.

The build must include development dependencies even with `NODE_ENV=production`: TypeScript, Vite and React type declarations are required during compilation. For a manually created Render service, update its Build Command in the dashboard; changing `render.yaml` only configures Blueprint-managed services.

Seed once locally against the same Neon database before demonstrating; Render does not automatically recreate or reset staff credentials. The existing local seed therefore works on the deployment as well. On a new database, run the seed separately with a secure `STAFF_PASSWORD`, or use the local generated credentials file.

The free Render service can sleep after 15 minutes of inactivity and needs time to wake. Open it ahead of a presentation. Neon also has free-plan quotas; frequent dashboard polling consumes database compute. No production banking reliability, compliance or real OTP is claimed.

### Before any real-bank pilot

Replace demo authentication with a bank-authorized account lookup and a properly secured SMS integration; add production identity, branch authorization policy, rate limiting backed by shared storage, audit/retention controls, encrypted sensitive fields, monitoring and bank-approved operational procedures. Have translations reviewed by native-speaking bank staff. Browser speech is optional and depends on installed voices; always be prepared to announce tokens manually.
