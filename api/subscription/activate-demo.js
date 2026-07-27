import {
  activateSubscription,
  findUserById,
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

function readJsonBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  res.setHeader("Vary", "Cookie");

  try {
    const session = getSession(req);

    if (!session?.userId) {
      return res.status(401).json({
        error: "Please log in with Telegram first.",
      });
    }

    const user = await findUserById(session.userId);

    if (!user) {
      return res.status(401).json({
        error: "Telegram account was not found. Please log in again.",
      });
    }

    const body = readJsonBody(req);
    const planId =
      typeof body.planId === "string"
        ? body.planId.trim().toLowerCase()
        : "";

    if (!ALLOWED_PLANS.has(planId)) {
      return res.status(400).json({
        error: "Invalid subscription plan.",
      });
    }

    const subscription = await activateSubscription({
      userId: user.id,
      planId,
      paymentMethod:
        planId === "free"
          ? "free-trial"
          : "khqr-demo",
    });

    const publicSubscription = {
      id: String(subscription.id),
      planId: subscription.plan_id,
      status: subscription.status,
      activatedAt: new Date(subscription.starts_at).getTime(),
      expiresAt: subscription.expires_at
        ? new Date(subscription.expires_at).getTime()
        : null,
      paymentMethod: subscription.payment_method || "",
    };

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
    console.error("Subscription activation error:", {
      message: error?.message,
      code: error?.code,
      constraint: error?.constraint,
      detail: error?.detail,
      stack: error?.stack,
    });

    if (
      error?.code === "FREE_TRIAL_USED" ||
      (error?.code === "23505" &&
        error?.constraint === "subscriptions_one_free_trial_per_user")
    ) {
      return res.status(409).json({
        error:
          "The 3-day free trial has already been used for this Telegram account.",
        code: "FREE_TRIAL_USED",
      });
    }

    if (error?.code === "ACTIVE_SUBSCRIPTION_EXISTS") {
      return res.status(409).json({
        error:
          "You already have an active subscription. The free trial cannot replace it.",
        code: "ACTIVE_SUBSCRIPTION_EXISTS",
      });
    }

    if (error?.code === "INVALID_PLAN") {
      return res.status(400).json({
        error: "Invalid subscription plan.",
        code: error.code,
      });
    }

    if (error?.code === "USER_NOT_FOUND") {
      return res.status(401).json({
        error: "Telegram account was not found. Please log in again.",
        code: error.code,
      });
    }

    const diagnosticCode =
      error?.code || "SUBSCRIPTION_ACTIVATION_FAILED";

    return res.status(500).json({
      error:
        `Unable to activate the free trial right now. Database code: ${diagnosticCode}.`,
      diagnosticCode,
      code: diagnosticCode,
    });
  }
}
