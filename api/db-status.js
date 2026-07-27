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
        to_regclass('free_trials') IS NOT NULL AS free_trials_ready
    `);

    return res.status(200).json({
      ok: true,
      database: "PostgreSQL",
      serverTime: result.rows[0].server_time,
      freeTrialsReady: result.rows[0].free_trials_ready,
      schemaVersion: "free-trials-v3-idempotent",
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
      diagnosticCode: error?.code || "DATABASE_SCHEMA_FAILED",
    });
  }
}
