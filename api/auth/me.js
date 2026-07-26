import { findActiveSubscription, findUserById } from "../_db.js";
import { clearSessionCookie, getSession } from "../_session.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");

  try {
    const session = getSession(req);
    if (!session?.userId) {
      return res.status(200).json({ authenticated: false, user: null, subscription: null });
    }

    const user = await findUserById(session.userId);
    if (!user) {
      clearSessionCookie(res);
      return res.status(200).json({ authenticated: false, user: null, subscription: null });
    }

    const subscription = await findActiveSubscription(user.id);
    return res.status(200).json({
      authenticated: true,
      user: {
        id: String(user.telegram_id),
        databaseId: String(user.id),
        first_name: user.first_name,
        last_name: user.last_name || "",
        username: user.username || "",
        photo_url: user.photo_url || "",
      },
      subscription: subscription
        ? {
            id: String(subscription.id),
            planId: subscription.plan_id,
            status: subscription.status,
            activatedAt: new Date(subscription.starts_at).getTime(),
            expiresAt: subscription.expires_at ? new Date(subscription.expires_at).getTime() : null,
            paymentMethod: subscription.payment_method,
          }
        : null,
    });
  } catch (error) {
    console.error("Session lookup error:", error);
    return res.status(500).json({ error: "Database connection failed." });
  }
}
