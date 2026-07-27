import {
  activateSubscription,
  findActiveSubscription,
  findUserById,
  hasUsedFreeTrial,
} from "../_db.js";

import {
  getSession,
  setSessionCookie,
} from "../_session.js";

const ALLOWED_PLANS = new Set([
  "free",
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

    if (
      planId === "free" &&
      await findActiveSubscription(user.id)
    ) {
      return res.status(409).json({
        error:
          "You already have an active subscription. The free trial cannot replace it.",
      });
    }

    if (
      planId === "free" &&
      await hasUsedFreeTrial(user.id)
    ) {
      return res.status(409).json({
        error:
          "The 3-day free trial has already been used for this Telegram account.",
      });
    }

    const subscription =
      await activateSubscription({
        userId:
          user.id,

        planId,

        paymentMethod:
          planId === "free"
            ? "free-trial"
            : "khqr-demo",
      });

    const publicSubscription = {
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
    };

    // Persist the newly activated plan in the signed HttpOnly session as well
    // as PostgreSQL. The frontend can therefore show the active subscription
    // immediately and it remains available if a database refresh is briefly
    // unavailable on the next serverless request.
    setSessionCookie(res, {
      ...session,
      subscription: publicSubscription,
      subscriptionUpdatedAt: Date.now(),
    });

    return res.status(200).json({
      ok: true,
      subscription: publicSubscription,
    });
  } catch (error) {
    console.error(
      "Subscription activation error:",
      error,
    );

    if (
      error?.code === "23505" &&
      error?.constraint === "subscriptions_one_free_trial_per_user"
    ) {
      return res.status(409).json({
        error:
          "The 3-day free trial has already been used for this Telegram account.",
      });
    }

    return res.status(500).json({
      error:
        "Unable to activate subscription.",
    });
  }
}