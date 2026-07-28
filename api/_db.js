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
const COMPRESSION_EVENTS_TABLE = "theziess_compression_events_v1";

let schemaPromise;
let paidPlanMigrationPromise;

/**
 * Upgrade old paid subscriptions without making login depend on a DDL change.
 * Some hosted PostgreSQL roles can read/write tables but cannot ALTER them.
 * V12 ran ALTER TABLE during every cold start, so one permission/lock/data
 * problem prevented upsertTelegramUser() and made Telegram login fail.
 *
 * New grants already have the correct expiry. This migration is best-effort:
 * it upgrades old rows, logs a failure, and never blocks authentication.
 */
async function migratePaidPlanDurationsSafely() {
  if (!paidPlanMigrationPromise) {
    paidPlanMigrationPromise = (async () => {
      await pool.query(`
        UPDATE ${SUBSCRIPTIONS_TABLE}
        SET
          expires_at = CASE
            WHEN plan_id = 'pro' THEN starts_at + INTERVAL '30 days'
            WHEN plan_id = 'premium' THEN starts_at + INTERVAL '180 days'
            WHEN plan_id = 'max' THEN starts_at + INTERVAL '365 days'
            ELSE expires_at
          END,
          updated_at = NOW()
        WHERE
          (plan_id = 'pro' AND expires_at IS NULL)
          OR (
            plan_id = 'premium'
            AND (
              expires_at IS NULL
              OR expires_at < starts_at + INTERVAL '180 days'
            )
          )
          OR (plan_id = 'max' AND expires_at IS NULL)
      `);

      return true;
    })().catch((error) => {
      // Authentication must continue even if legacy subscription data cannot
      // be migrated during this request. Admin can re-grant the plan later.
      console.error("Paid plan duration migration skipped:", {
        code: error?.code || "UNKNOWN",
        message: error?.message || String(error),
      });
      return false;
    });
  }

  return paidPlanMigrationPromise;
}

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
        CREATE TABLE IF NOT EXISTS ${COMPRESSION_EVENTS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          user_key TEXT NOT NULL,
          input_name VARCHAR(255),
          output_name VARCHAR(255),
          input_bytes BIGINT,
          output_bytes BIGINT,
          output_mime VARCHAR(120),
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


      await pool.query(`
        CREATE INDEX IF NOT EXISTS theziess_compression_events_v1_user_created_idx
          ON ${COMPRESSION_EVENTS_TABLE}(user_key, created_at DESC)
      `);


      // Never let a legacy paid-plan migration prevent Telegram login.
      await migratePaidPlanDurationsSafely();
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
          AND expires_at > NOW()

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
        AND expires_at > NOW()
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
  recordPayment = true,
}) {
  await ensureSchema();

  const plans = {
    free: { amount: 0, days: 3 },
    pro: { amount: 2, days: 30 },
    premium: { amount: 5, days: 180 },
    max: { amount: 10, days: 365 },
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

      // A paid plan replaces any currently active free trial. This prevents
      // trial access from reappearing after a paid plan is revoked or expires.
      await client.query(
        `
          UPDATE ${FREE_TRIALS_TABLE}
          SET status = 'cancelled', updated_at = NOW()
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

  if (planId !== "free" && recordPayment) {
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


function normalizeText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeByteCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

export async function recordCompressionEvent({
  userId,
  inputName,
  outputName,
  inputBytes,
  outputBytes,
  outputMime,
}) {
  await ensureSchema();

  const result = await pool.query(
    `
      INSERT INTO ${COMPRESSION_EVENTS_TABLE} (
        user_key,
        input_name,
        output_name,
        input_bytes,
        output_bytes,
        output_mime
      )
      SELECT
        id::TEXT,
        $2,
        $3,
        $4,
        $5,
        $6
      FROM users
      WHERE id::TEXT = $1::TEXT
      RETURNING *
    `,
    [
      String(userId),
      normalizeText(inputName),
      normalizeText(outputName),
      normalizeByteCount(inputBytes),
      normalizeByteCount(outputBytes),
      normalizeText(outputMime, 120),
    ],
  );

  if (!result.rows[0]) {
    const error = new Error("Telegram account was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  return result.rows[0];
}

const ACTIVE_ACCESS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT access.*
    FROM (
      SELECT
        plan_id::TEXT AS plan_id,
        status::TEXT AS status,
        starts_at,
        expires_at,
        2 AS priority
      FROM ${SUBSCRIPTIONS_TABLE}
      WHERE user_key = u.id::TEXT
        AND status = 'active'
        AND expires_at > NOW()

      UNION ALL

      SELECT
        'free'::TEXT AS plan_id,
        status::TEXT AS status,
        starts_at,
        expires_at,
        1 AS priority
      FROM ${FREE_TRIALS_TABLE}
      WHERE user_key = u.id::TEXT
        AND status = 'active'
        AND expires_at > NOW()
    ) access
    ORDER BY priority DESC, starts_at DESC
    LIMIT 1
  ) active_access ON TRUE
`;

export async function getAdminStats() {
  await ensureSchema();

  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM users) AS total_users,
      (SELECT COUNT(*)::INTEGER FROM users WHERE last_login_at >= NOW() - INTERVAL '24 hours') AS users_last_24h,
      (SELECT COUNT(*)::INTEGER FROM ${SUBSCRIPTIONS_TABLE} WHERE status = 'active' AND expires_at > NOW()) AS active_paid,
      (SELECT COUNT(*)::INTEGER FROM ${FREE_TRIALS_TABLE} WHERE status = 'active' AND expires_at > NOW()) AS active_trials,
      (SELECT COUNT(*)::INTEGER FROM ${COMPRESSION_EVENTS_TABLE}) AS total_compressions,
      (SELECT COUNT(*)::INTEGER FROM ${COMPRESSION_EVENTS_TABLE} WHERE created_at >= NOW() - INTERVAL '24 hours') AS compressions_last_24h,
      (SELECT COUNT(*)::INTEGER FROM ${PAYMENTS_TABLE}) AS total_payments,
      (SELECT COALESCE(SUM(amount_usd), 0)::NUMERIC FROM ${PAYMENTS_TABLE} WHERE status = 'demo_paid') AS total_payment_amount
  `);

  return result.rows[0];
}

export async function listAdminUsers({ page = 1, pageSize = 8 } = {}) {
  await ensureSchema();

  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safePageSize = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 8)));
  const offset = (safePage - 1) * safePageSize;

  const [countResult, usersResult] = await Promise.all([
    pool.query("SELECT COUNT(*)::INTEGER AS total FROM users"),
    pool.query(
      `
        SELECT
          u.*,
          active_access.plan_id AS active_plan_id,
          active_access.status AS active_status,
          active_access.starts_at AS active_starts_at,
          active_access.expires_at AS active_expires_at
        FROM users u
        ${ACTIVE_ACCESS_LATERAL}
        ORDER BY u.last_login_at DESC, u.id DESC
        LIMIT $1 OFFSET $2
      `,
      [safePageSize, offset],
    ),
  ]);

  return {
    users: usersResult.rows,
    total: countResult.rows[0]?.total || 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function findAdminUser(lookup) {
  await ensureSchema();

  const normalized = String(lookup || "").trim().replace(/^@/, "");
  if (!normalized) return null;

  const result = await pool.query(
    `
      SELECT
        u.*,
        active_access.plan_id AS active_plan_id,
        active_access.status AS active_status,
        active_access.starts_at AS active_starts_at,
        active_access.expires_at AS active_expires_at
      FROM users u
      ${ACTIVE_ACCESS_LATERAL}
      WHERE u.telegram_id::TEXT = $1::TEXT
         OR u.id::TEXT = $1::TEXT
         OR LOWER(COALESCE(u.username, '')) = LOWER($1)
      ORDER BY u.last_login_at DESC
      LIMIT 1
    `,
    [normalized],
  );

  return result.rows[0] || null;
}

export async function getAdminUserCompressionStats(userId) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        COUNT(*)::INTEGER AS total_compressions,
        COALESCE(SUM(input_bytes), 0)::TEXT AS total_input_bytes,
        COALESCE(SUM(output_bytes), 0)::TEXT AS total_output_bytes,
        MAX(created_at) AS last_compression_at
      FROM ${COMPRESSION_EVENTS_TABLE}
      WHERE user_key = $1::TEXT
    `,
    [String(userId)],
  );

  return result.rows[0];
}

export async function listAdminUserCompressionEvents(userId, limit = 5) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${COMPRESSION_EVENTS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [String(userId), Math.min(10, Math.max(1, Number(limit) || 5))],
  );

  return result.rows;
}

export async function listAdminUserAccessHistory(userId, limit = 6) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM (
        SELECT
          plan_id::TEXT AS plan_id,
          status::TEXT AS status,
          starts_at,
          expires_at,
          payment_method::TEXT AS payment_method,
          created_at
        FROM ${SUBSCRIPTIONS_TABLE}
        WHERE user_key = $1::TEXT

        UNION ALL

        SELECT
          'free'::TEXT AS plan_id,
          status::TEXT AS status,
          starts_at,
          expires_at,
          'free-trial'::TEXT AS payment_method,
          created_at
        FROM ${FREE_TRIALS_TABLE}
        WHERE user_key = $1::TEXT
      ) access_history
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [String(userId), Math.min(12, Math.max(1, Number(limit) || 6))],
  );

  return result.rows;
}

export async function listAdminUserPayments(userId, limit = 5) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT *
      FROM ${PAYMENTS_TABLE}
      WHERE user_key = $1::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [String(userId), Math.min(10, Math.max(1, Number(limit) || 5))],
  );

  return result.rows;
}

export async function listAdminActiveSubscriptions(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        s.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${SUBSCRIPTIONS_TABLE} s
      LEFT JOIN users u ON u.id::TEXT = s.user_key
      WHERE s.status = 'active'
        AND s.expires_at > NOW()
      ORDER BY s.created_at DESC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}

export async function listAdminActiveTrials(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        t.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${FREE_TRIALS_TABLE} t
      LEFT JOIN users u ON u.id::TEXT = t.user_key
      WHERE t.status = 'active'
        AND t.expires_at > NOW()
      ORDER BY t.expires_at ASC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}

export async function listAdminRecentPayments(limit = 12) {
  await ensureSchema();

  const result = await pool.query(
    `
      SELECT
        p.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name
      FROM ${PAYMENTS_TABLE} p
      LEFT JOIN users u ON u.id::TEXT = p.user_key
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $1
    `,
    [Math.min(30, Math.max(1, Number(limit) || 12))],
  );

  return result.rows;
}


const ADMIN_PAID_PLANS = new Set(["pro", "premium", "max"]);

/**
 * Assign a paid plan from the Telegram admin bot. Public website requests do
 * not call this function. The caller must verify TELEGRAM_ADMIN_IDS first.
 */
export async function grantAdminSubscription({
  lookup,
  planId,
  adminTelegramId,
}) {
  const normalizedPlan = String(planId || "").trim().toLowerCase();

  if (!ADMIN_PAID_PLANS.has(normalizedPlan)) {
    const error = new Error("Plan must be PRO, PREMIUM, or MAX.");
    error.code = "INVALID_PAID_PLAN";
    throw error;
  }

  const user = await findAdminUser(lookup);

  if (!user) {
    const error = new Error("User was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  const adminId = String(adminTelegramId || "").replace(/[^0-9-]/g, "").slice(0, 20);
  const paymentMethod = adminId
    ? `telegram-admin:${adminId}`
    : "telegram-admin";

  const subscription = await activateSubscription({
    userId: user.id,
    planId: normalizedPlan,
    paymentMethod,
    recordPayment: false,
  });

  return {
    user,
    subscription,
  };
}

/** Cancel only active paid plans. Free-trial history is preserved. */
export async function revokeAdminSubscription({ lookup }) {
  await ensureSchema();
  const user = await findAdminUser(lookup);

  if (!user) {
    const error = new Error("User was not found.");
    error.code = "USER_NOT_FOUND";
    throw error;
  }

  const result = await pool.query(
    `
      UPDATE ${SUBSCRIPTIONS_TABLE}
      SET status = 'cancelled', updated_at = NOW()
      WHERE user_key = $1::TEXT
        AND status = 'active'
      RETURNING *
    `,
    [String(user.id)],
  );

  return {
    user,
    revoked: result.rows,
  };
}
