import {
  activateSubscription,
  findUserById,
} from "../_db.js";

import {
  getSession,
} from "../_session.js";

const ALLOWED_PLANS = new Set([
  "pro",
  "premium",
  "max",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  res.setHeader(
    "Cache-Control",
    "no-store",
  );

  try {
    const session = getSession(req);

    if (!session?.userId) {
      return res.status(401).json({
        error:
          "Please log in with Telegram first.",
      });
    }

    const user = await findUserById(
      session.userId,
    );

    if (!user) {
      return res.status(401).json({
        error:
          "Telegram account was not found.",
      });
    }

    const planId =
      typeof req.body?.planId === "string"
        ? req.body.planId.toLowerCase()
        : "";

    if (!ALLOWED_PLANS.has(planId)) {
      return res.status(400).json({
        error:
          "Invalid subscription plan.",
      });
    }

    const subscription =
      await activateSubscription({
        userId:
          user.id,

        planId,

        paymentMethod:
          "khqr-demo",
      });

    return res.status(200).json({
      ok: true,

      subscription: {
        id:
          String(subscription.id),

        planId:
          subscription.plan_id,

        status:
          subscription.status,

        activatedAt:
          new Date(
            subscription.starts_at,
          ).getTime(),

        expiresAt:
          subscription.expires_at
            ? new Date(
                subscription.expires_at,
              ).getTime()
            : null,

        paymentMethod:
          subscription.payment_method,
      },
    });
  } catch (error) {
    console.error(
      "Subscription activation error:",
      error,
    );

    return res.status(500).json({
      error:
        "Unable to activate subscription.",
    });
  }
}