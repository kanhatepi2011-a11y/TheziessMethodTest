CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120),
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('free', 'pro', 'premium', 'max')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscriptions_plan_id_check'
      AND conrelid = 'subscriptions'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%free%'
  ) THEN
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_id_check;
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_plan_id_check
      CHECK (plan_id IN ('free', 'pro', 'premium', 'max'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx
  ON subscriptions(user_id, status, expires_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_free_trial_per_user
  ON subscriptions(user_id)
  WHERE plan_id = 'free';

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('free', 'pro', 'premium', 'max')),
  amount NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  transaction_reference VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USD';

DO $$
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
  ALTER TABLE payments ALTER COLUMN amount SET NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_plan_id_check'
      AND conrelid = 'payments'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%free%'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT payments_plan_id_check;
    ALTER TABLE payments
      ADD CONSTRAINT payments_plan_id_check
      CHECK (plan_id IN ('free', 'pro', 'premium', 'max'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS payments_user_id_idx
  ON payments(user_id);
