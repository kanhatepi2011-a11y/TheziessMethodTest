CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  payment_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_id%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%free%'
  LOOP
    EXECUTE format(
      'ALTER TABLE subscriptions DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_id%'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_plan_id_check
      CHECK (plan_id IN ('free', 'pro', 'premium', 'max'));
  END IF;
END;
$$;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND NOT (
        pg_get_constraintdef(oid) ILIKE '%active%'
        AND pg_get_constraintdef(oid) ILIKE '%expired%'
        AND pg_get_constraintdef(oid) ILIKE '%cancelled%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE subscriptions DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_status_check
      CHECK (status IN ('active', 'expired', 'cancelled'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id TEXT NOT NULL,
  amount NUMERIC(10, 2),
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  transaction_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_reference TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'payments'
      AND column_name = 'amount_usd'
  ) THEN
    EXECUTE 'UPDATE payments SET amount = amount_usd WHERE amount IS NULL';
    ALTER TABLE payments ALTER COLUMN amount_usd DROP NOT NULL;
  END IF;

  UPDATE payments SET amount = 0 WHERE amount IS NULL;

  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'payments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_id%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%free%'
  LOOP
    EXECUTE format(
      'ALTER TABLE payments DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'payments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan_id%'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_plan_id_check
      CHECK (plan_id IN ('free', 'pro', 'premium', 'max'));
  END IF;
END;
$$;

DELETE FROM subscriptions duplicate
USING subscriptions original
WHERE duplicate.user_id = original.user_id
  AND duplicate.plan_id = 'free'
  AND original.plan_id = 'free'
  AND duplicate.id > original.id;

CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx
  ON subscriptions(user_id, status, expires_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_free_trial_per_user
  ON subscriptions(user_id)
  WHERE plan_id = 'free';

CREATE INDEX IF NOT EXISTS payments_user_id_idx
  ON payments(user_id);
