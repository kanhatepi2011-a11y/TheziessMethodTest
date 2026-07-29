import { findActiveSubscription } from "./_db.js";
import {
  escapeTelegramHtml,
  getTelegramAdminIds,
  getTelegramBotToken,
  sendTelegramMessage,
} from "./_telegram-bot.js";

function alertsEnabled() {
  const value = String(
    process.env.TELEGRAM_LOGIN_ALERTS_ENABLED ?? "true",
  )
    .trim()
    .toLowerCase();

  return !["0", "false", "off", "no"].includes(value);
}

function formatLoginTime(date = new Date()) {
  const timeZone =
    String(process.env.ADMIN_TIMEZONE || "Asia/Phnom_Penh").trim() ||
    "Asia/Phnom_Penh";

  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "medium",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function planLabel(subscription) {
  const planId = String(subscription?.plan_id || "none").toLowerCase();

  if (planId === "free") return "FREE trial";
  if (planId === "pro") return "PRO";
  if (planId === "premium") return "PREMIUM";
  if (planId === "max") return "MAX";
  return "No active subscription";
}

function displayName(user) {
  const fullName = [user?.first_name, user?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || "Telegram User";
}

export function buildTelegramLoginAlert({
  databaseUser,
  telegramUser,
  subscription,
}) {
  const username = String(
    databaseUser?.username || telegramUser?.username || "",
  ).trim();

  const telegramId = String(
    databaseUser?.telegram_id || telegramUser?.id || "Unknown",
  );

  const lines = [
    "🔔 <b>Telegram login alert</b>",
    "",
    `👤 <b>Name:</b> ${escapeTelegramHtml(displayName(databaseUser || telegramUser))}`,
    `🆔 <b>Telegram ID:</b> <code>${escapeTelegramHtml(telegramId)}</code>`,
    `🔗 <b>Username:</b> ${username ? `@${escapeTelegramHtml(username.replace(/^@/, ""))}` : "Not set"}`,
    `💎 <b>Plan:</b> ${escapeTelegramHtml(planLabel(subscription))}`,
    `🕒 <b>Login time:</b> ${escapeTelegramHtml(formatLoginTime())}`,
  ];

  if (subscription?.expires_at) {
    lines.push(
      `⏳ <b>Expires:</b> ${escapeTelegramHtml(formatLoginTime(new Date(subscription.expires_at)))}`,
    );
  }

  return lines.join("\n");
}

/**
 * Notify every configured Telegram admin after a successful Telegram login.
 * This is deliberately best-effort: bot configuration or Telegram API errors
 * are logged but never interrupt the user's authenticated session.
 */
export async function notifyAdminsOfTelegramLogin({
  databaseUser,
  telegramUser,
}) {
  if (!alertsEnabled()) {
    return { skipped: true, reason: "disabled", sent: 0 };
  }

  const botToken = getTelegramBotToken({ required: false });
  const adminIds = [...getTelegramAdminIds()];

  if (!botToken || adminIds.length === 0) {
    return {
      skipped: true,
      reason: !botToken ? "missing_bot_token" : "missing_admin_ids",
      sent: 0,
    };
  }

  let subscription = null;

  try {
    subscription = await findActiveSubscription(String(databaseUser.id));
  } catch (error) {
    console.warn("Login alert could not load subscription:", {
      code: error?.code || "UNKNOWN",
      message: error?.message || String(error),
    });
  }

  const message = buildTelegramLoginAlert({
    databaseUser,
    telegramUser,
    subscription,
  });

  const results = await Promise.allSettled(
    adminIds.map((adminId) => sendTelegramMessage(adminId, message)),
  );

  let sent = 0;

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sent += 1;
      return;
    }

    console.warn("Telegram login alert failed:", {
      adminId: adminIds[index],
      code: result.reason?.code || "UNKNOWN",
      message: result.reason?.message || String(result.reason),
    });
  });

  return {
    skipped: false,
    sent,
    failed: results.length - sent,
  };
}
