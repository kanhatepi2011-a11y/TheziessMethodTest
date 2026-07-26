import crypto from "node:crypto";
import { upsertTelegramUser } from "../_db.js";
import { setSessionCookie } from "../_session.js";

const MAX_AUTH_AGE_SECONDS = 15 * 60;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(500).send("TELEGRAM_BOT_TOKEN is not configured.");

    const data = {};
    for (const [key, rawValue] of Object.entries(req.query || {})) {
      if (key !== "hash" && rawValue !== undefined && rawValue !== "") data[key] = String(first(rawValue));
    }
    const receivedHash = String(first(req.query?.hash) || "");
    if (!receivedHash) return res.status(400).send("Missing Telegram hash.");

    const checkString = Object.keys(data)
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join("\n");
    const secretKey = crypto.createHash("sha256").update(botToken).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

    const received = Buffer.from(receivedHash, "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return res.status(401).send("Telegram verification failed.");
    }

    const authDate = Number(data.auth_date);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || now - authDate > MAX_AUTH_AGE_SECONDS || authDate > now + 60) {
      return res.status(401).send("Telegram login has expired. Please try again.");
    }

    const telegramUser = {
      id: data.id,
      first_name: data.first_name || "Telegram user",
      last_name: data.last_name || "",
      username: data.username || "",
      photo_url: data.photo_url || "",
    };
    const dbUser = await upsertTelegramUser(telegramUser);

    setSessionCookie(res, {
      userId: String(dbUser.id),
      telegramId: String(dbUser.telegram_id),
      issuedAt: Date.now(),
    });
    return res.redirect(302, "/?telegram_login=success");
  } catch (error) {
    console.error("Telegram login error:", error);
    return res.status(500).send("Could not save Telegram user. Check DATABASE_URL and database access.");
  }
}
