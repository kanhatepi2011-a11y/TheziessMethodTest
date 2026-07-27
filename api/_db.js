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

const SUBSCRIPTIONS_TABLE = "theziess_subscriptions_v5";
const FREE_TRIALS_TABLE = "theziess_free_trials_v5";
const PAYMENTS_TABLE = "theziess_payments_v5";

let schemaPromise;

/**
 * Versioned subscription tables deliberately avoid old Neon tables whose
 * columns/types may differ. PostgreSQL 42703 means an old table is missing a
 * column referenced by the application. Using new versioned tables makes the
 * migration deterministic and does not delete or alter existing data.
 */
export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`
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
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SUBSCRIPTIONS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${FREE_TRIALS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT UNIQUE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${PAYMENTS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          subscription_id TEXT,
          plan_id VARCHAR(20) NOT NULL CHECK (plan_id IN ('pro', 'premium', 'max')),
          amount_usd NUMERIC(10, 2) NOT NULL,
          payment_method VARCHAR(40) NOT NULL DEFAULT 'KHQR_DEMO',
          status VARCHAR(20) NOT NULL DEFAULT 'demo_paid',
          transaction_reference VARCHAR(120) UNIQUE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_subscriptions_v5_user_status_idx
          ON ${SUBSCRIPTIONS_TABLE}(user_key, status, expires_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_free_trials_v5_user_status_idx
          ON ${FREE_TRIALS_TABLE}(user_key, status, expires_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_payments_v5_user_key_idx
          ON ${PAYMENTS_TABLE}(user_key)
      `);
    })().catch((error) => {
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
      WHERE id::TEXT = $1::TEXT
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
      WHERE telegram_id::TEXT = $1::TEXT
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
      FROM (
        SELECT
          id::TEXT AS id,
          user_key AS user_id,
          plan_id::TEXT AS plan_id,
          status::TEXT AS status,
          payment_method::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          CASE WHEN plan_id = 'max' THEN 3 ELSE 2 END AS priority
        FROM ${SUBSCRIPTIONS_TABLE}
        WHERE user_key = $1::TEXT
          AND status = 'active'
          AND (plan_id = 'max' OR expires_at > NOW())

        UNION ALL

        SELECT
          ('trial-' || id::TEXT) AS id,
          user_key AS user_id,
          'free'::TEXT AS plan_id,
          status::TEXT AS status,
          'free-trial'::TEXT AS payment_method,
          starts_at,
          expires_at,
          created_at,
          1 AS priority
        FROM ${FREE_TRIALS_TABLE}
        WHERE user_key = $1::TEXT
          AND status = 'active'
          AND expires_at > NOW()
      ) active_access
      ORDER BY priority DESC, created_at DESC
      LIMIT 1
    `,
    [String(userId)],
  );

  return result.rows[0] || null;
}

export async function hasUsedFreeTrial(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT 1
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = $1::TEXT
      LIMIT 1
    `,
    [String(userId)],
  );

  return Boolean(result.rows[0]);
}

function toFreeTrialSubscription(trial) {
  return {
    id: `trial-${trial.id}`,
    user_id: trial.user_key,
    plan_id: "free",
    status: trial.status,
    payment_method: "free-trial",
    starts_at: trial.starts_at,
    expires_at: trial.expires_at,
    created_at: trial.created_at,
    updated_at: trial.updated_at,
  };
}

function isActiveTrialRow(trial) {
  return Boolean(
    trial &&
      trial.status === "active" &&
      trial.expires_at &&
      new Date(trial.expires_at).getTime() > Date.now(),
  );
}

function freeTrialUsedError() {
  const error = new Error(
    "The 3-day free trial has already been used for this Telegram account.",
  );
  error.code = "FREE_TRIAL_USED";
  return error;
}

async function findStoredFreeTrial(client, userId) {
  const result = await client.query(
    `
      SELECT *
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [String(userId)],
  );

  return result.rows[0] || null;
}

async function activateFreeTrial(client, userId) {
  const storedTrial = await findStoredFreeTrial(client, userId);

  if (isActiveTrialRow(storedTrial)) {
    return toFreeTrialSubscription(storedTrial);
  }

  if (storedTrial) {
    throw freeTrialUsedError();
  }

  const activePaidResult = await client.query(
    `
      SELECT 1
      FROM ${SUBSCRIPTIONS_TABLE}
      WHERE user_key = $1::TEXT
        AND status = 'active'
        AND (plan_id = 'max' OR expires_at > NOW())
      LIMIT 1
    `,
    [String(userId)],
  );

  if (activePaidResult.rows[0]) {
    const error = new Error(
      "You already have an active subscription. The free trial cannot replace it.",
    );
    error.code = "ACTIVE_SUBSCRIPTION_EXISTS";
    throw error;
  }

  await client.query("SAVEPOINT free_trial_insert");

  try {
    const result = await client.query(
      `
        INSERT INTO ${FREE_TRIALS_TABLE} (
          user_key,
          status,
          starts_at,
          expires_at,
          updated_at
        )
        VALUES (
          $1::TEXT,
          'active',
          NOW(),
          NOW() + INTERVAL '3 days',
          NOW()
        )
        RETURNING *
      `,
      [String(userId)],
    );

    await client.query("RELEASE SAVEPOINT free_trial_insert");
    return toFreeTrialSubscription(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT free_trial_insert");

    if (error?.code === "23505") {
      const concurrentTrial = await findStoredFreeTrial(client, userId);

      if (isActiveTrialRow(concurrentTrial)) {
        return toFreeTrialSubscription(concurrentTrial);
      }

      throw freeTrialUsedError();
    }

    throw error;
  }
}

async function recordPaidDemoPayment({
  userId,
  subscriptionId,
  planId,
  amount,
  paymentMethod,
}) {
  const reference = `DEMO-${Date.now()}-${subscriptionId}`;

  await pool.query(
    `
      INSERT INTO ${PAYMENTS_TABLE} (
        user_key,
        subscription_id,
        plan_id,
        amount_usd,
        payment_method,
        status,
        transaction_reference
      )
      VALUES ($1::TEXT, $2::TEXT, $3, $4, $5, 'demo_paid', $6)
    `,
    [
      String(userId),
      String(subscriptionId),
      planId,
      amount,
      paymentMethod,
      reference,
    ],
  );
}

export async function activateSubscription({
  userId,
  planId,
  paymentMethod = "khqr-demo",
}) {
  await ensureSchema();

  const plans = {
    free: { amount: 0, days: 3 },
    pro: { amount: 2, days: 30 },
    premium: { amount: 5, days: 120 },
    max: { amount: 10, days: null },
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

    const lockedUser = await client.query(
      "SELECT id FROM users WHERE id::TEXT = $1::TEXT FOR UPDATE",
      [String(userId)],
    );

    if (!lockedUser.rows[0]) {
      const error = new Error(
        "Telegram account was not found. Please log in again.",
      );
      error.code = "USER_NOT_FOUND";
      throw error;
    }

    if (planId === "free") {
      subscription = await activateFreeTrial(client, userId);
    } else {
      await client.query(
        `
          UPDATE ${SUBSCRIPTIONS_TABLE}
          SET status = 'expired', updated_at = NOW()
          WHERE user_key = $1::TEXT
            AND status = 'active'
        `,
        [String(userId)],
      );

      const subscriptionResult = await client.query(
        `
          INSERT INTO ${SUBSCRIPTIONS_TABLE} (
            user_key,
            plan_id,
            status,
            payment_method,
            starts_at,
            expires_at,
            updated_at
          )
          VALUES (
            $1::TEXT,
            $2,
            'active',
            $3,
            NOW(),
            CASE
              WHEN $4::INTEGER IS NULL THEN NULL
              ELSE NOW() + ($4::INTEGER * INTERVAL '1 day')
            END,
            NOW()
          )
          RETURNING *
        `,
        [
          String(userId),
          planId,
          paymentMethod,
          selectedPlan.days,
        ],
      );

      subscription = {
        ...subscriptionResult.rows[0],
        user_id: subscriptionResult.rows[0].user_key,
      };
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

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
