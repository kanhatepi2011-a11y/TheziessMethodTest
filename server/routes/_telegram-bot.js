import crypto from "node:crypto";

function optionalEnvironment(name) {
  return String(process.env[name] || "").trim();
}

function requiredEnvironment(name, value = optionalEnvironment(name)) {
  if (!value) throw new Error(`${name} environment variable is missing.`);
  return value;
}

function looksLikeTelegramBotToken(value) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(value || "").trim());
}

/**
 * Resolve the Bot API token from the common variable names used by this
 * project. TELEGRAM_CLIENT_SECRET is accepted only when it has the exact Bot
 * API token shape, so an OAuth client secret is never sent to Telegram by
 * mistake.
 */
export function getTelegramBotToken({ required = true } = {}) {
  const direct =
    optionalEnvironment("TELEGRAM_BOT_TOKEN") ||
    optionalEnvironment("BOT_TOKEN");

  if (direct) return direct;

  const possibleLegacyToken = optionalEnvironment("TELEGRAM_CLIENT_SECRET");
  if (looksLikeTelegramBotToken(possibleLegacyToken)) {
    return possibleLegacyToken;
  }

  if (!required) return "";
  return requiredEnvironment("TELEGRAM_BOT_TOKEN");
}

/**
 * The webhook secret can be configured explicitly. When omitted, generate a
 * stable secret from the application's existing secrets. This removes an
 * unnecessary deployment step while preserving Telegram webhook validation.
 */
export function getTelegramWebhookSecret({ required = true } = {}) {
  const configured = optionalEnvironment("TELEGRAM_WEBHOOK_SECRET");
  if (configured) return configured;

  const token = getTelegramBotToken({ required: false });
  const seed = optionalEnvironment("SESSION_SECRET") || token;

  if (seed) {
    return crypto
      .createHash("sha256")
      .update(`theziess-telegram-webhook:${seed}`)
      .digest("hex");
  }

  if (!required) return "";
  throw new Error(
    "TELEGRAM_WEBHOOK_SECRET is missing and no SESSION_SECRET is available to generate it.",
  );
}

export function getTelegramSetupKey({ required = false } = {}) {
  const value = optionalEnvironment("TELEGRAM_SETUP_KEY");
  if (value || !required) return value;
  return requiredEnvironment("TELEGRAM_SETUP_KEY");
}

export function getTelegramAdminIds() {
  const configured = [
    optionalEnvironment("TELEGRAM_ADMIN_IDS"),
    optionalEnvironment("TELEGRAM_ADMIN_ID"),
    optionalEnvironment("ADMIN_TELEGRAM_ID"),
  ]
    .filter(Boolean)
    .join(",");

  return new Set(
    configured
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isTelegramAdmin(userId) {
  return getTelegramAdminIds().has(String(userId || ""));
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function getTelegramConfigStatus() {
  const token = getTelegramBotToken({ required: false });
  const webhookSecret = getTelegramWebhookSecret({ required: false });
  const adminIds = getTelegramAdminIds();

  return {
    botTokenConfigured: Boolean(token),
    webhookSecretConfigured: Boolean(webhookSecret),
    webhookSecretGenerated: Boolean(
      webhookSecret && !optionalEnvironment("TELEGRAM_WEBHOOK_SECRET"),
    ),
    adminCount: adminIds.size,
  };
}

export async function telegramApi(method, payload = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${getTelegramBotToken()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    const error = new Error(
      data?.description || `Telegram API ${method} request failed.`,
    );
    error.code = data?.error_code || response.status;
    throw error;
  }

  return data.result;
}

export async function sendTelegramMessage(chatId, text, options = {}) {
  return telegramApi("sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function answerTelegramCallback(callbackQueryId, text = "") {
  return telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}
