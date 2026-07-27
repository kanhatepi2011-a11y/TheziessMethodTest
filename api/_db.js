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

function toFreeTrialSubscription(trial) {
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
      FROM free_trials
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

async function findLegacyFreeSubscription(client, userId) {
  const result = await client.query(
    `
      SELECT *
      FROM subscriptions
      WHERE user_id = $1
        AND plan_id::TEXT = 'free'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
}

async function activateFreeTrial(client, userId) {
  // Make this endpoint idempotent. If the database activation succeeded but
  // the browser lost the response, clicking the button again must restore the
  // same active trial instead of permanently returning "already used".
  const storedTrial = await findStoredFreeTrial(client, userId);

  if (isActiveTrialRow(storedTrial)) {
    return toFreeTrialSubscription(storedTrial);
  }

  const legacyTrial = await findLegacyFreeSubscription(client, userId);

  if (isActiveTrialRow(legacyTrial)) {
    return {
      ...legacyTrial,
      plan_id: "free",
      payment_method: legacyTrial.payment_method || "free-trial",
    };
  }

  if (storedTrial || legacyTrial) {
    throw freeTrialUsedError();
  }

  const activePaidResult = await client.query(
    `
      SELECT 1
      FROM subscriptions
      WHERE user_id = $1
        AND status = 'active'
        AND (
          plan_id::TEXT = 'max'
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

  await client.query("SAVEPOINT free_trial_insert");

  try {
    // Do not depend on ON CONFLICT(user_id). Some older Neon databases have a
    // free_trials table created before the unique constraint was added. The
    // users row lock in activateSubscription serializes requests safely.
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
        RETURNING *
      `,
      [userId],
    );

    await client.query("RELEASE SAVEPOINT free_trial_insert");
    return toFreeTrialSubscription(result.rows[0]);
  } catch (error) {
    // A constraint violation aborts the current PostgreSQL statement. Restore
    // the transaction to the savepoint before attempting the recovery read.
    await client.query("ROLLBACK TO SAVEPOINT free_trial_insert");

    // A concurrent request or an older unique index may have inserted the row
    // first. Re-read it and return the active access instead of showing an
    // activation error.
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

    // Lock the existing user row so repeated clicks and multiple Vercel
    // instances cannot race. This avoids relying on advisory-lock functions
    // that may behave differently through pooled PostgreSQL connections.
    const lockedUser = await client.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );

    if (!lockedUser.rows[0]) {
      const error = new Error("Telegram account was not found. Please log in again.");
      error.code = "USER_NOT_FOUND";
      throw error;
    }

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
