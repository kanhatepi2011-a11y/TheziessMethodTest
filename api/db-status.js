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
        to_regclass('theziess_users_v2') IS NOT NULL AS users_ready,
        to_regclass('theziess_free_trials_v5') IS NOT NULL AS free_trials_ready,
        to_regclass('theziess_subscriptions_v5') IS NOT NULL AS subscriptions_ready,
        to_regclass('theziess_payments_v5') IS NOT NULL AS payments_ready,
        to_regclass('theziess_compression_events_v1') IS NOT NULL AS compression_events_ready,
        to_regclass('theziess_tiktok_connections_v1') IS NOT NULL AS tiktok_connections_ready,
        to_regclass('theziess_tiktok_uploads_v1') IS NOT NULL AS tiktok_uploads_ready
    `);

    return res.status(200).json({
      ok: true,
      database: "PostgreSQL",
      serverTime: result.rows[0].server_time,
      usersReady: result.rows[0].users_ready,
      freeTrialsReady: result.rows[0].free_trials_ready,
      subscriptionsReady: result.rows[0].subscriptions_ready,
      paymentsReady: result.rows[0].payments_ready,
      compressionEventsReady: result.rows[0].compression_events_ready,
      tiktokConnectionsReady: result.rows[0].tiktok_connections_ready,
      tiktokUploadsReady: result.rows[0].tiktok_uploads_ready,
      schemaVersion: "official-tiktok-integration-v20",
    });
  } catch (error) {
    console.error("Database status error:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      table: error?.table,
      column: error?.column,
    });

    return res.status(500).json({
      ok: false,
      error: error.message,
      detail: error?.detail || null,
      table: error?.table || null,
      column: error?.column || null,
      diagnosticCode: error?.code || "DATABASE_SCHEMA_FAILED",
    });
  }
}
