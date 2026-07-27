import { getRequestOrigin } from "../_telegram.js";
import {
  getTelegramAdminIds,
  getTelegramSetupKey,
  getTelegramWebhookSecret,
  safeEqual,
  telegramApi,
} from "../_telegram-bot.js";

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

const ADMIN_COMMANDS = [
  { command: "admin", description: "Open the admin dashboard" },
  { command: "stats", description: "Show platform statistics" },
  { command: "users", description: "List registered users" },
  { command: "user", description: "Show one user's full information" },
  { command: "subscriptions", description: "Show active paid plans" },
  { command: "trials", description: "Show active free trials" },
  { command: "payments", description: "Show recent payments" },
  { command: "id", description: "Show your Telegram ID" },
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const body = readBody(req);
    if (!safeEqual(body.setupKey, getTelegramSetupKey())) {
      return res.status(401).json({ error: "Invalid setup key" });
    }

    const webhookSecret = getTelegramWebhookSecret();
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
      return res.status(500).json({
        error:
          "TELEGRAM_WEBHOOK_SECRET must contain only letters, numbers, _ or -.",
      });
    }

    const origin = getRequestOrigin(req);
    const webhookUrl = `${origin}/api/telegram/webhook`;

    const bot = await telegramApi("getMe");
    await telegramApi("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });

    await telegramApi("setMyCommands", {
      commands: [
        { command: "id", description: "Show your Telegram ID" },
        { command: "help", description: "Open bot help" },
      ],
    });

    const commandSetup = [];
    for (const adminId of getTelegramAdminIds()) {
      try {
        await telegramApi("setMyCommands", {
          commands: ADMIN_COMMANDS,
          scope: { type: "chat", chat_id: adminId },
        });
        commandSetup.push({ adminId, ok: true });
      } catch (error) {
        commandSetup.push({
          adminId,
          ok: false,
          error: error.message,
        });
      }
    }

    const webhookInfo = await telegramApi("getWebhookInfo");

    return res.status(200).json({
      ok: true,
      bot: {
        id: String(bot.id),
        username: bot.username || null,
      },
      webhookUrl,
      pendingUpdates: webhookInfo.pending_update_count || 0,
      adminCommandSetup: commandSetup,
    });
  } catch (error) {
    console.error("Telegram setup error:", {
      message: error?.message,
      code: error?.code,
    });

    return res.status(500).json({
      ok: false,
      error: error.message,
      code: error?.code || "TELEGRAM_SETUP_FAILED",
    });
  }
}
