CREATE TABLE IF NOT EXISTS theziess_users_v2 (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120),
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Versioned tables avoid conflicts with old Neon schemas that may have
-- missing columns or incompatible ID types.
CREATE TABLE IF NOT EXISTS theziess_subscriptions_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS theziess_free_trials_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS theziess_payments_v5 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  subscription_id TEXT,
  plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
  amount_usd NUMERIC(10, 2) NOT NULL,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
  status VARCHAR(20) NOT NULL DEFAULT 'demo_paid',
  transaction_reference VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS theziess_subscriptions_v5_user_status_idx
  ON theziess_subscriptions_v5(user_key, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS theziess_free_trials_v5_user_status_idx
  ON theziess_free_trials_v5(user_key, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS theziess_payments_v5_user_key_idx
  ON theziess_payments_v5(user_key);

-- Server-side activity counters for the admin Telegram bot.
-- Video files are NOT uploaded here; only names, sizes, MIME type and time.
CREATE TABLE IF NOT EXISTS theziess_compression_events_v1 (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  input_name VARCHAR(255),
  output_name VARCHAR(255),
  input_bytes BIGINT,
  output_bytes BIGINT,
  output_mime VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS theziess_compression_events_v1_user_created_idx
  ON theziess_compression_events_v1(user_key, created_at DESC);
