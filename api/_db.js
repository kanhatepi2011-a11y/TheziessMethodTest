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

/**
 * Keep runtime schema setup deliberately small and idempotent.
 *
 * FREE trials are stored in their own table instead of subscriptions. Older
 * databases restrict subscriptions.plan_id to PRO/PREMIUM/MAX, and changing
 * those constraints inside a serverless request was the source of the failed
 * activation. A separate table works with both the original and newer schema.
 */
export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`
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
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS free_trials (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS payments (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          amount_usd NUMERIC(10, 2) NOT NULL,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          status VARCHAR(20) NOT NULL DEFAULT 'demo_paid',
          transaction_reference VARCHAR(120) UNIQUE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx
          ON subscriptions(user_id, status, expires_at DESC);

        CREATE INDEX IF NOT EXISTS free_trials_user_status_idx
          ON free_trials(user_id, status, expires_at DESC);

        CREATE INDEX IF NOT EXISTS payments_user_id_idx
          ON payments(user_id);
      `)
      .catch((error) => {
        // Let a later request retry if Neon was briefly unavailable.
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

  // Read paid subscriptions from the original table and FREE access from the
  // dedicated free_trials table. The legacy branch also recognizes a FREE row
  // created by an earlier deployment, so existing users are not locked out.
  const result = await pool.query(
    `
      SELECT *
      FROM (
        SELECT
          id::TEXT AS id,
          user_id,
          plan_id::TEXT AS plan_id,
          status::TEXT AS status,
          payment_method::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          CASE WHEN plan_id = 'max' THEN 3 ELSE 2 END AS priority
        FROM subscriptions
        WHERE user_id = $1
          AND status = 'active'
          AND (
            plan_id = 'max'
            OR expires_at > NOW()
          )

        UNION ALL

        SELECT
          ('trial-' || id::TEXT) AS id,
          user_id,
          'free'::TEXT AS plan_id,
          status::TEXT AS status,
          'free-trial'::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          1 AS priority
        FROM free_trials
        WHERE user_id = $1
          AND status = 'active'
          AND expires_at > NOW()
      ) active_access
      ORDER BY priority DESC, created_at DESC
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
      FROM free_trials
      WHERE user_id = $1

      UNION ALL

      SELECT 1
      FROM subscriptions
      WHERE user_id = $1
        AND plan_id::TEXT = 'free'

      LIMIT 1
    `,
    [userId],
  );

  return Boolean(result.rows[0]);
}

async function activateFreeTrial(client, userId) {
  const usedTrialResult = await client.query(
    `
      SELECT 1
      FROM free_trials
      WHERE user_id = $1

      UNION ALL

      SELECT 1
      FROM subscriptions
      WHERE user_id = $1
        AND plan_id::TEXT = 'free'

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

  const activePaidResult = await client.query(
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

  if (activePaidResult.rows[0]) {
    const error = new Error(
      "You already have an active subscription. The free trial cannot replace it.",
    );
    error.code = "ACTIVE_SUBSCRIPTION_EXISTS";
    throw error;
  }

  const result = await client.query(
    `
      INSERT INTO free_trials (
        user_id,
        status,
        starts_at,
        expires_at,
        updated_at
      )
      VALUES (
        $1,
        'active',
        NOW(),
        NOW() + INTERVAL '3 days',
        NOW()
      )
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *
    `,
    [userId],
  );

  if (!result.rows[0]) {
    const error = new Error(
      "The 3-day free trial has already been used for this Telegram account.",
    );
    error.code = "FREE_TRIAL_USED";
    throw error;
  }

  const trial = result.rows[0];

  return {
    id: `trial-${trial.id}`,
    user_id: trial.user_id,
    plan_id: "free",
    status: trial.status,
    payment_method: "free-trial",
    starts_at: trial.starts_at,
    expires_at: trial.expires_at,
    created_at: trial.created_at,
    updated_at: trial.updated_at,
  };
}

async function recordPaidDemoPayment({
  userId,
  subscriptionId,
  planId,
  amount,
  paymentMethod,
}) {
  const reference = `DEMO-${Date.now()}-${subscriptionId}`;

  // Support both the original amount_usd schema and the newer amount schema.
  const columnsResult = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'payments'
    `,
  );

  const columns = new Set(columnsResult.rows.map((row) => row.column_name));

  if (columns.has("amount_usd")) {
    await pool.query(
      `
        INSERT INTO payments (
          user_id,
          subscription_id,
          plan_id,
          amount_usd,
          payment_method,
          status,
          transaction_reference
        )
        VALUES ($1, $2, $3, $4, $5, 'demo_paid', $6)
      `,
      [
        userId,
        subscriptionId,
        planId,
        amount,
        paymentMethod,
        reference,
      ],
    );
    return;
  }

  if (columns.has("amount")) {
    await pool.query(
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
        VALUES ($1, $2, $3, $4, 'USD', $5, 'completed', $6)
      `,
      [
        userId,
        subscriptionId,
        planId,
        amount,
        paymentMethod,
        reference,
      ],
    );
  }
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
  let subscription;

  try {
    await client.query("BEGIN");

    // One lock per database user prevents double-click races across Vercel
    // instances without depending on the exact numeric type of userId.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))",
      [String(userId)],
    );

    if (planId === "free") {
      subscription = await activateFreeTrial(client, userId);
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

      const subscriptionResult = await client.query(
        `
          INSERT INTO subscriptions (
            user_id,
            plan_id,
            status,
            payment_method,
            starts_at,
            expires_at,
            updated_at
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
            END,
            NOW()
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

      subscription = subscriptionResult.rows[0];
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Payment history must never roll back an already activated paid plan.
  if (planId !== "free") {
    try {
      await recordPaidDemoPayment({
        userId,
        subscriptionId: subscription.id,
        planId,
        amount: selectedPlan.amount,
        paymentMethod,
      });
    } catch (paymentError) {
      console.warn("Subscription activated but payment history was not saved:", {
        message: paymentError?.message,
        code: paymentError?.code,
      });
    }
  }

  return subscription;
}
