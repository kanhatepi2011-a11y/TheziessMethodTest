import pg from "pg";

const { Pool } = pg;

const globalForDb = globalThis;

function getConnectionString() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not configured.");
  return value;
}

export function getPool() {
  if (!globalForDb.__theziessPool) {
    globalForDb.__theziessPool = new Pool({
      connectionString: getConnectionString(),
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForDb.__theziessPool;
}

let schemaPromise;

export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getPool();
      await db.query(`
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

        CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx
          ON subscriptions(user_id, status, expires_at DESC);

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
      `);
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

export async function upsertTelegramUser(telegramUser) {
  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, last_login_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       photo_url = EXCLUDED.photo_url,
       updated_at = NOW(),
       last_login_at = NOW()
     RETURNING id, telegram_id, username, first_name, last_name, photo_url, created_at`,
    [
      telegramUser.id,
      telegramUser.username || null,
      telegramUser.first_name || "Telegram user",
      telegramUser.last_name || null,
      telegramUser.photo_url || null,
    ],
  );
  return result.rows[0];
}

export async function findUserById(userId) {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT id, telegram_id, username, first_name, last_name, photo_url, created_at
     FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function findActiveSubscription(userId) {
  await ensureSchema();
  const db = getPool();
  await db.query(
    `UPDATE subscriptions
     SET status = 'expired', updated_at = NOW()
     WHERE user_id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
    [userId],
  );
  const result = await db.query(
    `SELECT id, plan_id, status, starts_at, expires_at, payment_method
     FROM subscriptions
     WHERE user_id = $1
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}
