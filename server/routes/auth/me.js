import {
  findActiveSubscription,
  findUserById,
} from "../_db.js";

import {
  clearSessionCookie,
  getSession,
  publicSession,
} from "../_session.js";

function toPublicUser(user) {
  if (!user) return null;

  return {
    id: String(user.telegram_id ?? user.id ?? ""),
    databaseId: String(user.databaseId ?? user.database_id ?? user.id ?? ""),
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.username || "",
    photo_url: user.photo_url || "",
  };
}

function toPublicSubscription(subscription) {
  if (!subscription) return null;

  return {
    id: String(subscription.id),
    planId: subscription.plan_id,
    status: subscription.status,
    activatedAt: new Date(subscription.starts_at).getTime(),
    expiresAt: subscription.expires_at
      ? new Date(subscription.expires_at).getTime()
      : null,
    paymentMethod: subscription.payment_method || "",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");

  try {
    const session = getSession(req);

    if (!session?.userId || !session?.user) {
      return res.status(200).json({
        authenticated: false,
        user: null,
        subscription: null,
      });
    }

    // The signed session cookie already contains the verified Telegram user.
    // Use it immediately so a temporary database failure cannot make a
    // successfully logged-in user appear logged out on the frontend.
    let publicUser = toPublicUser(session.user);
    let publicSubscription = publicSession(session).subscription;

    try {
      const databaseUser = await findUserById(session.userId);

      if (databaseUser) {
        publicUser = toPublicUser(databaseUser);
        const subscription = await findActiveSubscription(databaseUser.id);
        publicSubscription = toPublicSubscription(subscription);
      }
    } catch (databaseError) {
      console.warn(
        "Database refresh failed; using signed Telegram session:",
        databaseError,
      );
    }

    return res.status(200).json({
      authenticated: true,
      user: publicUser,
      subscription: publicSubscription,
    });
  } catch (error) {
    console.error("Session lookup error:", error);
    clearSessionCookie(res);

    return res.status(200).json({
      authenticated: false,
      user: null,
      subscription: null,
    });
  }
}
