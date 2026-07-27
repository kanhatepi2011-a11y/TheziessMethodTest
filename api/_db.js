import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing.");
}

const globalDatabase = globalThis;

export const pool =
  globalDatabase.__theziessPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalDatabase.__theziessPool = pool;
}

export function getPool() {
  return pool;
}

let schemaPromise;

export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`
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
          payment_method TEXT,
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE subscriptions
          ADD COLUMN IF NOT EXISTS payment_method TEXT;

        ALTER TABLE subscriptions
          ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE subscriptions
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

        ALTER TABLE subscriptions
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE subscriptions
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        -- Older deployments only allowed PRO, PREMIUM and MAX. Constraint
        -- names can differ after manual imports, so find and replace every
        -- plan_id check constraint that does not yet allow FREE.
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

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS payment_method TEXT;

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS transaction_reference TEXT;

        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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
            ALTER TABLE payments
              ALTER COLUMN amount_usd DROP NOT NULL;
          END IF;

          UPDATE payments
          SET amount = 0
          WHERE amount IS NULL;

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

        CREATE INDEX IF NOT EXISTS subscriptions_user_id_index
        ON subscriptions(user_id);

        CREATE INDEX IF NOT EXISTS subscriptions_status_index
        ON subscriptions(status);

        -- A failed older deployment may have inserted duplicates manually.
        -- Keep the earliest FREE record so the one-time rule can be enforced.
        DELETE FROM subscriptions duplicate
        USING subscriptions original
        WHERE duplicate.user_id = original.user_id
          AND duplicate.plan_id = 'free'
          AND original.plan_id = 'free'
          AND duplicate.id > original.id;

        CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_free_trial_per_user
        ON subscriptions(user_id)
        WHERE plan_id = 'free';

        CREATE INDEX IF NOT EXISTS payments_user_id_index
        ON payments(user_id);
      `)
      .catch((error) => {
        // Do not permanently cache a failed migration in a warm serverless
        // process. A later request can retry after the database is available.
        schemaPromise = null;
        throw error;
      });
  }

  return schemaPromise;
}

export async function upsertTelegramUser(telegramUser) {
  await ensureSchema();

  const result = await pool.query(
    `
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        last_name,
        photo_url,
        last_login_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())

      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        photo_url = EXCLUDED.photo_url,
        last_login_at = NOW(),
        updated_at = NOW()

      RETURNING *
    `,
    [
      String(telegramUser.id),
      telegramUser.username || null,
      telegramUser.first_name || "Telegram User",
      telegramUser.last_name || null,
      telegramUser.photo_url || null,
    ],
  );

  return result.rows[0];
}

export async function findUserById(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

export async function findUserByTelegramId(telegramId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
    `,
    [String(telegramId)],
  );

  return result.rows[0] || null;
}

export async function findActiveSubscription(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM subscriptions
      WHERE user_id = $1
        AND status = 'active'
        AND (
          plan_id = 'max'
          OR expires_at > NOW()
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

export async function hasUsedFreeTrial(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT 1
      FROM subscriptions
      WHERE user_id = $1
        AND plan_id = 'free'
      LIMIT 1
    `,
    [userId],
  );

  return Boolean(result.rows[0]);
}

export async function activateSubscription({
  userId,
  planId,
  paymentMethod = "khqr-demo",
}) {
  await ensureSchema();

  const plans = {
    free: {
      amount: 0,
      days: 3,
    },
    pro: {
      amount: 2,
      days: 30,
    },
    premium: {
      amount: 5,
      days: 120,
    },
    max: {
      amount: 10,
      days: null,
    },
  };

  const selectedPlan = plans[planId];

  if (!selectedPlan) {
    const error = new Error("Invalid subscription plan.");
    error.code = "INVALID_PLAN";
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize subscription changes for one user. This prevents two quick
    // clicks or two serverless requests from activating the one-time trial
    // at the same time.
    await client.query(
      "SELECT pg_advisory_xact_lock($1::BIGINT)",
      [userId],
    );

    if (planId === "free") {
      const usedTrialResult = await client.query(
        `
          SELECT 1
          FROM subscriptions
          WHERE user_id = $1
            AND plan_id = 'free'
          LIMIT 1
        `,
        [userId],
      );

      if (usedTrialResult.rows[0]) {
        const error = new Error(
          "The 3-day free trial has already been used for this Telegram account.",
        );
        error.code = "FREE_TRIAL_USED";
        throw error;
      }

      const activeResult = await client.query(
        `
          SELECT 1
          FROM subscriptions
          WHERE user_id = $1
            AND status = 'active'
            AND (
              plan_id = 'max'
              OR expires_at > NOW()
            )
          LIMIT 1
        `,
        [userId],
      );

      if (activeResult.rows[0]) {
        const error = new Error(
          "You already have an active subscription. The free trial cannot replace it.",
        );
        error.code = "ACTIVE_SUBSCRIPTION_EXISTS";
        throw error;
      }
    } else {
      await client.query(
        `
          UPDATE subscriptions
          SET
            status = 'expired',
            updated_at = NOW()
          WHERE user_id = $1
            AND status = 'active'
        `,
        [userId],
      );
    }

    const subscriptionResult = await client.query(
      `
        INSERT INTO subscriptions (
          user_id,
          plan_id,
          status,
          payment_method,
          starts_at,
          expires_at
        )
        VALUES (
          $1,
          $2,
          'active',
          $3,
          NOW(),
          CASE
            WHEN $4::INTEGER IS NULL THEN NULL
            ELSE NOW() + ($4 * INTERVAL '1 day')
          END
        )
        RETURNING *
      `,
      [
        userId,
        planId,
        paymentMethod,
        selectedPlan.days,
      ],
    );

    const subscription = subscriptionResult.rows[0];

    // A FREE trial does not need a payment row. Older databases still contain
    // the original paid-only payments schema, and requiring a fake $0 payment
    // caused the whole transaction to roll back with “Unable to activate”.
    if (planId !== "free") {
      await client.query(
        `
          INSERT INTO payments (
            user_id,
            subscription_id,
            plan_id,
            amount,
            currency,
            payment_method,
            status,
            transaction_reference
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'USD',
            $5,
            'completed',
            $6
          )
        `,
        [
          userId,
          subscription.id,
          planId,
          selectedPlan.amount,
          paymentMethod,
          `DEMO-${Date.now()}-${subscription.id}`,
        ],
      );
    }

    await client.query("COMMIT");

    return subscription;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
