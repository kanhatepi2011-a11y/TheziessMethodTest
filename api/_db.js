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

let schemaPromise;

export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
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
        plan_id TEXT NOT NULL CHECK (
          plan_id IN ('pro', 'premium', 'max')
        ),
        status TEXT NOT NULL DEFAULT 'active' CHECK (
          status IN ('active', 'expired', 'cancelled')
        ),
        payment_method TEXT,
        starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
        plan_id TEXT NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        payment_method TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        transaction_reference TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS subscriptions_user_id_index
      ON subscriptions(user_id);

      CREATE INDEX IF NOT EXISTS subscriptions_status_index
      ON subscriptions(status);

      CREATE INDEX IF NOT EXISTS payments_user_id_index
      ON payments(user_id);
    `);
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

export async function activateSubscription({
  userId,
  planId,
  paymentMethod = "khqr-demo",
}) {
  await ensureSchema();

  const plans = {
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
    throw new Error("Invalid subscription plan.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
        `DEMO-${Date.now()}`,
      ],
    );

    await client.query("COMMIT");

    return subscription;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}