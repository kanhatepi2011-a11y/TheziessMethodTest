import crypto from "node:crypto";

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} environment variable is missing.`);
  return value;
}

export function getTelegramBotToken() {
  return requiredEnvironment("TELEGRAM_BOT_TOKEN");
}

export function getTelegramWebhookSecret() {
  return requiredEnvironment("TELEGRAM_WEBHOOK_SECRET");
}

export function getTelegramSetupKey() {
  return requiredEnvironment("TELEGRAM_SETUP_KEY");
}

export function getTelegramAdminIds() {
  return new Set(
    String(process.env.TELEGRAM_ADMIN_IDS || "")
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
