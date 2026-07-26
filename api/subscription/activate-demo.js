import crypto from "node:crypto";
import { ensureSchema, findUserById, getPool } from "../_db.js";
import { getSession } from "../_session.js";

const PLANS = {
  pro: { days: 30, amount: 2 },
  premium: { days: 120, amount: 5 },
  max: { days: null, amount: 10 },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const session = getSession(req);
    if (!session?.userId) return res.status(401).json({ error: "Telegram login required" });

    const planId = req.body?.planId;
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: "Invalid plan" });

    await ensureSchema();
    const user = await findUserById(session.userId);
    if (!user) return res.status(401).json({ error: "User account no longer exists" });

    const db = getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
         WHERE user_id = $1 AND status = 'active'`,
        [user.id],
      );

      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, expires_at, payment_method)
         VALUES ($1, $2, 'active', NOW(), CASE WHEN $3::integer IS NULL THEN NULL ELSE NOW() + ($3 * INTERVAL '1 day') END, 'KHQR_DEMO')
         RETURNING id, plan_id, starts_at, expires_at, payment_method`,
        [user.id, planId, plan.days],
      );
      const subscription = subscriptionResult.rows[0];
      const transactionReference = `KHQR-DEMO-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

      await client.query(
        `INSERT INTO payments
          (user_id, subscription_id, plan_id, amount_usd, payment_method, status, transaction_reference)
         VALUES ($1, $2, $3, $4, 'KHQR_DEMO', 'demo_paid', $5)`,
        [user.id, subscription.id, planId, plan.amount, transactionReference],
      );
      await client.query("COMMIT");

      return res.status(200).json({
        ok: true,
        subscription: {
          id: String(subscription.id),
          planId: subscription.plan_id,
          activatedAt: new Date(subscription.starts_at).getTime(),
          expiresAt: subscription.expires_at ? new Date(subscription.expires_at).getTime() : null,
          paymentMethod: subscription.payment_method,
        },
        transactionReference,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Demo activation error:", error);
    return res.status(500).json({ error: "Could not activate subscription in PostgreSQL." });
  }
}
