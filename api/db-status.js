import { ensureSchema, getPool } from "./_db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    await ensureSchema();
    const result = await getPool().query("SELECT NOW() AS server_time");
    return res.status(200).json({ ok: true, database: "PostgreSQL", serverTime: result.rows[0].server_time });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
