import { getPublicAppOrigin } from "../_telegram.js";
import {
  getTelegramConfigStatus,
  telegramApi,
} from "../_telegram-bot.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const configuration = getTelegramConfigStatus();
  const expectedOrigin = (() => {
    try {
      return getPublicAppOrigin(req);
    } catch {
      return null;
    }
  })();

  if (!configuration.botTokenConfigured) {
    return res.status(503).json({
      ok: false,
      status: "missing_bot_token",
      message:
        "Add TELEGRAM_BOT_TOKEN to Vercel Environment Variables and redeploy.",
      configuration,
      expectedOrigin,
    });
  }

  try {
    const [bot, webhook] = await Promise.all([
      telegramApi("getMe"),
      telegramApi("getWebhookInfo"),
    ]);

    return res.status(200).json({
      ok: Boolean(webhook.url),
      status: webhook.url ? "connected" : "webhook_not_set",
      bot: {
        id: String(bot.id),
        username: bot.username || null,
      },
      webhook: {
        url: webhook.url || null,
        pendingUpdateCount: webhook.pending_update_count || 0,
        lastErrorDate: webhook.last_error_date || null,
        lastErrorMessage: webhook.last_error_message || null,
      },
      configuration,
      expectedOrigin,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      status: "telegram_api_error",
      message: error.message,
      code: error?.code || null,
      configuration,
      expectedOrigin,
    });
  }
}
