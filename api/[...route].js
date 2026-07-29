import activityCompression from "../server/api/activity/compression.js";
import authLogout from "../server/api/auth/logout.js";
import authMe from "../server/api/auth/me.js";
import authTelegram from "../server/api/auth/telegram.js";
import authTelegramCallback from "../server/api/auth/telegram/callback.js";
import authTikTok from "../server/api/auth/tiktok.js";
import authTikTokCallback from "../server/api/auth/tiktok/callback.js";
import dbStatus from "../server/api/db-status.js";
import subscriptionActivateDemo from "../server/api/subscription/activate-demo.js";
import telegramHealth from "../server/api/telegram/health.js";
import telegramSetup from "../server/api/telegram/setup.js";
import telegramWebhook from "../server/api/telegram/webhook.js";
import tiktokAccount from "../server/api/tiktok/account.js";
import tiktokCheck from "../server/api/tiktok/check.js";
import tiktokDisconnect from "../server/api/tiktok/disconnect.js";
import tiktokUploadCancel from "../server/api/tiktok/upload/cancel.js";
import tiktokUploadInit from "../server/api/tiktok/upload/init.js";
import tiktokUploadStatus from "../server/api/tiktok/upload/status.js";

const ROUTES = new Map([
  ["activity/compression", activityCompression],
  ["auth/logout", authLogout],
  ["auth/me", authMe],
  ["auth/telegram", authTelegram],
  ["auth/telegram/callback", authTelegramCallback],
  ["auth/tiktok", authTikTok],
  ["auth/tiktok/callback", authTikTokCallback],
  ["db-status", dbStatus],
  ["subscription/activate-demo", subscriptionActivateDemo],
  ["telegram/health", telegramHealth],
  ["telegram/setup", telegramSetup],
  ["telegram/webhook", telegramWebhook],
  ["tiktok/account", tiktokAccount],
  ["tiktok/check", tiktokCheck],
  ["tiktok/disconnect", tiktokDisconnect],
  ["tiktok/upload/cancel", tiktokUploadCancel],
  ["tiktok/upload/init", tiktokUploadInit],
  ["tiktok/upload/status", tiktokUploadStatus],
]);

function normalizeRoute(req) {
  const catchAll = req.query?.route;

  if (Array.isArray(catchAll)) {
    return catchAll.map((part) => String(part)).join("/");
  }

  if (typeof catchAll === "string" && catchAll.trim()) {
    return catchAll.replace(/^\/+|\/+$/g, "");
  }

  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    return pathname.replace(/^\/api\/?/, "").replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  const route = normalizeRoute(req);
  const routeHandler = ROUTES.get(route);

  if (!routeHandler) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(404).json({
      ok: false,
      code: "API_ROUTE_NOT_FOUND",
      error: "API route not found.",
    });
  }

  return routeHandler(req, res);
}
