import { ensureSchema, getPool } from "./_db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    await ensureSchema();

    const result = await getPool().query(`
      SELECT
        NOW() AS server_time,
        to_regclass('free_trials') IS NOT NULL AS free_trials_ready,
        (
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name = 'id'
          LIMIT 1
        ) AS users_id_type,
        (
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'free_trials'
            AND column_name = 'user_id'
          LIMIT 1
        ) AS free_trials_user_id_type
    `);

    return res.status(200).json({
      ok: true,
      database: "PostgreSQL",
      serverTime: result.rows[0].server_time,
      freeTrialsReady: result.rows[0].free_trials_ready,
      usersIdType: result.rows[0].users_id_type,
      freeTrialsUserIdType: result.rows[0].free_trials_user_id_type,
      schemaVersion: "free-trials-v4-type-compatible",
    });
  } catch (error) {
    console.error("Database status error:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
    });

    return res.status(500).json({
      ok: false,
      error: error.message,
      detail: error?.detail || null,
      diagnosticCode: error?.code || "DATABASE_SCHEMA_FAILED",
    });
  }
}
