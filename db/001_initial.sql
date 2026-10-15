CREATE TABLE customers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name TEXT NOT NULL,
    mobile VARCHAR(10) NOT NULL UNIQUE CHECK (mobile ~ '^[6-9][0-9]{9}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    account_number VARCHAR(34) NOT NULL UNIQUE,
    branch_code VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE bank_staff (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    branch_code VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE daily_token_counters (
    branch_code VARCHAR(20) NOT NULL,
    business_date DATE NOT NULL,
    last_number INTEGER NOT NULL CHECK (last_number > 0),
    PRIMARY KEY (branch_code, business_date)
);

CREATE TABLE deposit_requests (
    id UUID PRIMARY KEY,
    idempotency_key UUID NOT NULL UNIQUE,
    account_id BIGINT NOT NULL REFERENCES accounts(id),
    branch_code VARCHAR(20) NOT NULL,
    business_date DATE NOT NULL,
    token_number INTEGER NOT NULL CHECK (token_number > 0),
    language_code VARCHAR(2) NOT NULL CHECK (language_code IN ('en', 'mr', 'hi')),
    status TEXT NOT NULL DEFAULT 'WAITING'
      CHECK (status IN ('WAITING', 'CALLED', 'ACKNOWLEDGED', 'REJECTED', 'NO_SHOW')),
    called_by BIGINT REFERENCES bank_staff(id),
    called_at TIMESTAMPTZ,
    resolved_by BIGINT REFERENCES bank_staff(id),
    resolved_at TIMESTAMPTZ,
    rejection_code TEXT CHECK (rejection_code IN (
      'DENOMINATION_MISMATCH', 'AMOUNT_MISMATCH', 'UNSUITABLE_NOTES',
      'ACCOUNT_ISSUE', 'CUSTOMER_WITHDREW', 'OTHER'
    )),
    rejection_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (branch_code, business_date, token_number),
    CHECK (status <> 'REJECTED' OR rejection_code IS NOT NULL),
    CHECK (rejection_code IS DISTINCT FROM 'OTHER'
      OR NULLIF(BTRIM(rejection_note), '') IS NOT NULL),
    CHECK (status = 'WAITING' OR (called_by IS NOT NULL AND called_at IS NOT NULL)),
    CHECK (status IN ('WAITING', 'CALLED')
      OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX one_called_token_per_staff
    ON deposit_requests (called_by) WHERE status = 'CALLED';

CREATE INDEX deposit_queue_idx
    ON deposit_requests (branch_code, business_date, status, token_number);

CREATE TABLE deposit_denominations (
    deposit_id UUID NOT NULL REFERENCES deposit_requests(id),
    denomination INTEGER NOT NULL CHECK (denomination IN (10, 20, 50, 100, 200, 500)),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    PRIMARY KEY (deposit_id, denomination)
);

CREATE TABLE deposit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deposit_id UUID NOT NULL REFERENCES deposit_requests(id),
    actor_staff_id BIGINT REFERENCES bank_staff(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'SUBMITTED', 'CALLED', 'RECALLED', 'ACKNOWLEDGED', 'REJECTED', 'NO_SHOW'
    )),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX deposit_events_request_idx ON deposit_events (deposit_id, created_at);

CREATE TABLE sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions (expire);
